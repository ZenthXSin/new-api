package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type codexGitHubTransport func(*http.Request) (*http.Response, error)

func (transport codexGitHubTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func newCodexGitHubFixture(t *testing.T) AuthIdentity {
	t.Helper()
	previousDB, previousSecret, previousCrypto, previousRedis := model.DB, common.SessionSecret, common.CryptoSecret, common.RedisEnabled
	previousClient, previousType := codexGitHubClient, common.MainDatabaseType()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.AuthFlow{}, &model.CodexGitHubConnection{}, &model.CodexUserConfig{}, &model.SubscriptionPlan{}, &model.UserSubscription{}))
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB, common.SessionSecret, common.CryptoSecret, common.RedisEnabled = db, "github-flow-test-secret", "github-credential-test-secret", false
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		model.DB, common.SessionSecret, common.CryptoSecret, common.RedisEnabled = previousDB, previousSecret, previousCrypto, previousRedis
		codexGitHubClient = previousClient
		common.SetMainDatabaseType(previousType)
		_ = sqlDB.Close()
	})
	t.Setenv("CODEX_GITHUB_CLIENT_ID", "github-test-client")
	t.Setenv("CODEX_GITHUB_CLIENT_SECRET", "github-test-client-secret-value")
	t.Setenv("CODEX_GITHUB_CLIENT_SECRET_FILE", "")
	t.Setenv("CODEX_GITHUB_REDIRECT_URI", "https://new-api.example/codex?github_oauth=1")
	user := model.User{Username: "github-admin", Password: "unused", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, AuthVersion: 1, Group: "default"}
	require.NoError(t, db.Create(&user).Error)
	session := model.UserSession{SID: "github-browser-session", UserID: user.Id, Version: 1, UserAuthVersion: 1, Status: model.UserSessionStatusActive, RefreshHash: "test-refresh-hash", LoginMethod: "password", CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	require.NoError(t, model.CreateUserSession(&session))
	return AuthIdentity{UserID: user.Id, SessionID: session.SID, UserAuthVersion: 1, SessionVersion: 1}
}

func TestCodexGitHubConfigUsesSiteAppWhenDedicatedAppIsAbsent(t *testing.T) {
	previousID, previousSecret := common.GitHubClientId, common.GitHubClientSecret
	t.Cleanup(func() {
		common.GitHubClientId, common.GitHubClientSecret = previousID, previousSecret
	})
	common.GitHubClientId, common.GitHubClientSecret = "site-github-client", "site-github-client-secret-value"
	t.Setenv("CODEX_GITHUB_CLIENT_ID", "")
	t.Setenv("CODEX_GITHUB_CLIENT_SECRET", "")
	t.Setenv("CODEX_GITHUB_CLIENT_SECRET_FILE", "")
	t.Setenv("CODEX_GITHUB_REDIRECT_URI", "https://new-api.example/codex?github_oauth=1")

	config, err := LoadCodexGitHubConfig()
	require.NoError(t, err)
	assert.Equal(t, "site-github-client", config.ClientID)
	assert.Equal(t, "site-github-client-secret-value", config.ClientSecret)

	t.Setenv("CODEX_GITHUB_CLIENT_ID", "dedicated-github-client")
	t.Setenv("CODEX_GITHUB_CLIENT_SECRET", "dedicated-github-client-secret-value")
	config, err = LoadCodexGitHubConfig()
	require.NoError(t, err)
	assert.Equal(t, "dedicated-github-client", config.ClientID)
	assert.Equal(t, "dedicated-github-client-secret-value", config.ClientSecret)
}

func TestCodexGitHubAuthorizationBindsSessionAndPKCEAndEncryptsCredential(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	authorizeURL, err := BeginCodexGitHubAuthorization(identity)
	require.NoError(t, err)
	parsed, err := url.Parse(authorizeURL)
	require.NoError(t, err)
	assert.Equal(t, "github.com", parsed.Host)
	assert.Equal(t, "S256", parsed.Query().Get("code_challenge_method"))
	assert.Equal(t, "repo read:org workflow", parsed.Query().Get("scope"))
	state := parsed.Query().Get("state")
	require.Len(t, state, 43)
	token := "gho_offline_test_secret_do_not_expose"
	calls := 0
	codexGitHubClient = &http.Client{Transport: codexGitHubTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		var response string
		switch request.URL.Path {
		case "/login/oauth/access_token":
			var body map[string]string
			require.NoError(t, common.DecodeJson(request.Body, &body))
			assert.Equal(t, "test-code", body["code"])
			digest := sha256.Sum256([]byte(body["code_verifier"]))
			assert.Equal(t, parsed.Query().Get("code_challenge"), base64.RawURLEncoding.EncodeToString(digest[:]))
			assert.Equal(t, "https://new-api.example/codex?github_oauth=1", body["redirect_uri"])
			response = fmt.Sprintf(`{"access_token":%q,"token_type":"bearer","scope":"repo,read:org,workflow"}`, token)
		case "/user":
			assert.Equal(t, "Bearer "+token, request.Header.Get("Authorization"))
			response = `{"id":1234,"login":"fixture-user","avatar_url":"https://evil.invalid/track"}`
		default:
			t.Fatalf("unexpected GitHub operation %s", request.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(response))}, nil
	})}
	wrong := identity
	wrong.SessionID = "another-browser"
	require.ErrorIs(t, FinishCodexGitHubAuthorization(context.Background(), wrong, "test-code", state), model.ErrAuthFlowInvalid)
	assert.Zero(t, calls, "a flow copied into another browser cannot reach GitHub")
	require.NoError(t, FinishCodexGitHubAuthorization(context.Background(), identity, "test-code", state))
	assert.Equal(t, 2, calls)
	require.ErrorIs(t, FinishCodexGitHubAuthorization(context.Background(), identity, "test-code", state), model.ErrAuthFlowConsumed)
	assert.Equal(t, 2, calls)
	connection, err := model.GetCodexGitHubConnection(identity.UserID)
	require.NoError(t, err)
	assert.NotContains(t, connection.TokenCiphertext, token)
	assert.Equal(t, int64(1), connection.Generation)
	credential, err := GetCodexGitHubCredential(identity.UserID)
	require.NoError(t, err)
	assert.Equal(t, token, credential.Token)
	other, err := GetCodexGitHubCredential(identity.UserID + 1)
	require.NoError(t, err)
	assert.Empty(t, other.Token)
	status, err := GetCodexGitHubStatus(identity.UserID)
	require.NoError(t, err)
	assert.True(t, status.Connected)
	assert.Equal(t, "https://avatars.githubusercontent.com/u/1234?v=4", status.AvatarURL)
	encoded, err := common.Marshal(status)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), token)
	_, err = BeginCodexGitHubAuthorization(identity)
	assert.ErrorIs(t, err, ErrCodexGitHubAlreadyConnected)
}

func TestCodexGitHubDisconnectTombstoneBlocksStaleAuthorizationAndSupportsRetry(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	token := "gho_revocation_fixture"
	connection := &model.CodexGitHubConnection{UserID: identity.UserID, ClientID: "github-test-client", Login: "fixture-user", Scopes: "repo"}
	require.NoError(t, model.SaveCodexGitHubConnection(connection, token, 0, identity.UserAuthVersion))
	revoked, err := model.DisconnectCodexGitHubConnection(identity.UserID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), revoked.Generation)
	credential, err := GetCodexGitHubCredential(identity.UserID)
	require.NoError(t, err)
	assert.Empty(t, credential.Token)
	assert.Equal(t, int64(2), credential.Generation)
	status, err := GetCodexGitHubStatus(identity.UserID)
	require.NoError(t, err)
	assert.True(t, status.RevocationPending)
	assert.False(t, status.Connected)
	_, err = BeginCodexGitHubAuthorization(identity)
	assert.ErrorIs(t, err, ErrCodexGitHubAlreadyConnected)
	stale := &model.CodexGitHubConnection{UserID: identity.UserID, ClientID: "github-test-client", Login: "other-user"}
	assert.ErrorIs(t, model.SaveCodexGitHubConnection(stale, "stale-token", 1, identity.UserAuthVersion), model.ErrCodexGitHubChanged)
	calls := 0
	codexGitHubClient = &http.Client{Transport: codexGitHubTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		assert.Equal(t, http.MethodDelete, request.Method)
		assert.Equal(t, "/applications/github-test-client/token", request.URL.Path)
		clientID, secret, ok := request.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "github-test-client", clientID)
		assert.Equal(t, "github-test-client-secret-value", secret)
		var body map[string]string
		require.NoError(t, common.DecodeJson(request.Body, &body))
		assert.Equal(t, token, body["access_token"])
		status := 503
		if calls == 2 {
			status = 204
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	assert.ErrorIs(t, RevokeCodexGitHubToken(context.Background(), token), ErrCodexGitHubProvider)
	persisted, err := model.GetCodexGitHubConnection(identity.UserID)
	require.NoError(t, err)
	retained, err := persisted.Token()
	require.NoError(t, err)
	assert.Equal(t, token, retained)
	require.NoError(t, RevokeCodexGitHubToken(context.Background(), token))
	require.NoError(t, model.CompleteCodexGitHubRevocation(identity.UserID, revoked.Generation))
	persisted, err = model.GetCodexGitHubConnection(identity.UserID)
	require.NoError(t, err)
	assert.Empty(t, persisted.TokenCiphertext)
	assert.Equal(t, int64(2), persisted.Generation)
	_, err = BeginCodexGitHubAuthorization(identity)
	require.NoError(t, err)
}

func TestCodexGitHubPrivateRepositoryListingRemainsOwnerScoped(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	connection := &model.CodexGitHubConnection{UserID: identity.UserID, ClientID: "github-test-client", Login: "fixture-user", Scopes: "repo"}
	require.NoError(t, model.SaveCodexGitHubConnection(connection, "gho_fixture", 0, identity.UserAuthVersion))
	codexGitHubClient = &http.Client{Transport: codexGitHubTransport(func(request *http.Request) (*http.Response, error) {
		assert.Equal(t, "Bearer gho_fixture", request.Header.Get("Authorization"))
		assert.Equal(t, "/user/repos", request.URL.Path)
		assert.Equal(t, "2", request.URL.Query().Get("page"))
		assert.Equal(t, "50", request.URL.Query().Get("per_page"))
		return &http.Response{StatusCode: 200, Header: http.Header{"Link": {`<https://api.github.com/user/repos?page=3>; rel="next"`}}, Body: io.NopCloser(strings.NewReader(`[{"id":1,"name":"private","full_name":"fixture-user/private","private":true,"clone_url":"https://github.com/fixture-user/private.git","default_branch":"main"},{"id":2,"name":"bad","clone_url":"https://token@evil.invalid/bad.git"}]`))}, nil
	})}
	repositories, more, err := ListCodexGitHubRepositories(context.Background(), identity.UserID, 2, 50)
	require.NoError(t, err)
	require.Len(t, repositories, 1)
	assert.True(t, more)
	assert.True(t, repositories[0].Private)
	assert.Equal(t, "fixture-user/private", repositories[0].FullName)
	_, _, err = ListCodexGitHubRepositories(context.Background(), identity.UserID+1, 1, 50)
	assert.ErrorIs(t, err, ErrCodexGitHubNotConnected)
	t.Setenv("CODEX_GITHUB_CLIENT_ID", "replacement-app")
	_, err = GetCodexGitHubCredential(identity.UserID)
	assert.ErrorIs(t, err, ErrCodexGitHubUnconfigured)
}

func TestCodexGitHubCredentialCiphertextCannotMoveBetweenUsers(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	connection := &model.CodexGitHubConnection{UserID: identity.UserID, ClientID: "github-test-client"}
	require.NoError(t, model.SaveCodexGitHubConnection(connection, "gho_owner_secret", 0, identity.UserAuthVersion))
	connection.UserID++
	_, err := connection.Token()
	assert.Error(t, err)
}

func TestCodexGitHubAppAuthorizationAcceptsUserTokensWithoutOAuthScopes(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	t.Setenv("CODEX_GITHUB_CLIENT_ID", "Iv23test-github-app")
	authorizeURL, err := BeginCodexGitHubAuthorization(identity)
	require.NoError(t, err)
	parsed, err := url.Parse(authorizeURL)
	require.NoError(t, err)
	assert.Empty(t, parsed.Query().Get("scope"), "GitHub Apps use installation permissions, not OAuth repo scopes")
	codexGitHubClient = &http.Client{Transport: codexGitHubTransport(func(request *http.Request) (*http.Response, error) {
		var response string
		switch request.URL.Path {
		case "/login/oauth/access_token":
			response = `{"access_token":"ghu_app_user_fixture","token_type":"bearer","scope":""}`
		case "/user":
			response = `{"id":1234,"login":"fixture-user"}`
		default:
			t.Fatalf("unexpected operation %s: successful GitHub App authorization must not be revoked", request.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(response))}, nil
	})}
	require.NoError(t, FinishCodexGitHubAuthorization(context.Background(), identity, "test-code", parsed.Query().Get("state")))
	credential, err := GetCodexGitHubCredential(identity.UserID)
	require.NoError(t, err)
	assert.Equal(t, "ghu_app_user_fixture", credential.Token)
	status, err := GetCodexGitHubStatus(identity.UserID)
	require.NoError(t, err)
	assert.True(t, status.Connected)
	assert.Empty(t, status.Scopes, "installation permissions must not be fabricated as OAuth scopes")
	assert.NotContains(t, status.Capabilities, "workflows")
}

func TestCodexGitHubExpiredProviderCodeRequiresFreshAuthorization(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	authorizeURL, err := BeginCodexGitHubAuthorization(identity)
	require.NoError(t, err)
	parsed, err := url.Parse(authorizeURL)
	require.NoError(t, err)
	codexGitHubClient = &http.Client{Transport: codexGitHubTransport(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"error":"bad_verification_code","error_description":"provider-sensitive-details"}`))}, nil
	})}
	err = FinishCodexGitHubAuthorization(context.Background(), identity, "expired-code", parsed.Query().Get("state"))
	require.ErrorIs(t, err, model.ErrAuthFlowInvalid)
	assert.NotContains(t, err.Error(), "provider-sensitive-details")
}

func TestCodexOAuthAppCannotBypassRepositoryScopeUsingAnAppTokenPrefix(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	authorizeURL, err := BeginCodexGitHubAuthorization(identity)
	require.NoError(t, err)
	parsed, err := url.Parse(authorizeURL)
	require.NoError(t, err)
	revoked := false
	codexGitHubClient = &http.Client{Transport: codexGitHubTransport(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodDelete {
			revoked = true
			return &http.Response{StatusCode: 204, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		require.Equal(t, "/login/oauth/access_token", request.URL.Path)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"access_token":"ghu_prefix_does_not_grant_permissions","scope":"","token_type":"bearer"}`))}, nil
	})}
	err = FinishCodexGitHubAuthorization(context.Background(), identity, "test-code", parsed.Query().Get("state"))
	require.ErrorIs(t, err, ErrCodexGitHubRepositoryScope)
	assert.True(t, revoked)
	connection, err := GetCodexGitHubStatus(identity.UserID)
	require.NoError(t, err)
	assert.False(t, connection.Connected)
}
