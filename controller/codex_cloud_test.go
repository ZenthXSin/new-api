package controller

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodexCloudAndGitOperationsKeepTrustedSessionScope(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var observed []string
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed = append(observed, r.Method+" "+r.URL.RequestURI())
		assert.Equal(t, fmt.Sprint(fixture.adminID), r.Header.Get("X-Codex-Admin-Id"))
		assert.Equal(t, codexTestRunnerKey, r.Header.Get("X-Codex-Runner-Key"))
		assert.Empty(t, r.Header.Get("Authorization"))
		assert.Empty(t, r.Header.Get("Cookie"))
		assert.Empty(t, r.Header.Get("X-Codex-Model-Config"), "environment lifecycle and empty task creation cannot call a model")
		assert.Empty(t, r.Header.Get("X-Codex-GitHub-Token"), "browser credentials cannot override a disconnected owner")
		if r.Method == http.MethodPost || strings.HasSuffix(r.URL.Path, "/git/status") {
			assert.Equal(t, "0", r.Header.Get("X-Codex-GitHub-Generation"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":"fixture"}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	operations := []struct{ method, path, body string }{
		{http.MethodGet, "/environments", ""},
		{http.MethodPost, "/environments", `{"name":"Cloud draft","config":{"repos":[]}}`},
		{http.MethodGet, "/environments/fixture", ""},
		{http.MethodPatch, "/environments/fixture", `{"description":"Updated draft"}`},
		{http.MethodDelete, "/environments/fixture", ""},
		{http.MethodPost, "/environments/fixture/setup", `{}`},
		{http.MethodPost, "/environments/fixture/publish", `{}`},
		{http.MethodPost, "/environments/fixture/tasks", `{"name":"Fresh snapshot","requestId":"fixture-request"}`},
		{http.MethodGet, "/workspaces/fixture/git/status", ""},
		{http.MethodPost, "/workspaces/fixture/git/commit", `{"message":"Fix issue","all":true}`},
		{http.MethodPost, "/workspaces/fixture/git/push", `{"remote":"origin"}`},
		{http.MethodPost, "/workspaces/fixture/git/pull-request", `{"title":"Fix issue","base":"main","draft":true}`},
	}
	var expected []string
	for _, operation := range operations {
		t.Run(operation.method+operation.path, func(t *testing.T) {
			for _, token := range []string{"", fixture.commonToken, fixture.adminPAT} {
				request, response := fixture.request(operation.method, "/api/codex"+operation.path, token, strings.NewReader(operation.body))
				fixture.engine.ServeHTTP(response, request)
				assert.Contains(t, []int{http.StatusUnauthorized, http.StatusForbidden}, response.Code)
			}
			request, response := fixture.request(operation.method, "/api/codex"+operation.path, fixture.adminToken, strings.NewReader(operation.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Codex-Admin-Id", "999999")
			request.Header.Set("X-Codex-Runner-Key", "untrusted-key")
			request.Header.Set("X-Codex-GitHub-Token", "untrusted-github-secret")
			request.Header.Set("X-Codex-GitHub-Generation", "999999")
			request.Header.Set("X-Codex-Model-Config", "untrusted-model-config")
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
			assert.NotContains(t, response.Body.String(), codexTestRunnerKey)
		})
		expected = append(expected, operation.method+" "+operation.path)
	}
	assert.Equal(t, expected, observed)
}

func TestCodexCloudTaskModelCredentialIsSessionAndModelBound(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}))
	previousRatios := ratio_setting.GetGroupRatioCopy()
	t.Cleanup(func() {
		data, err := common.Marshal(previousRatios)
		require.NoError(t, err)
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(string(data)))
	})
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
	require.NoError(t, model.DB.Create(&model.Channel{Id: 991, Type: constant.ChannelTypeOpenAI, Name: "Codex cloud model", Status: common.ChannelStatusEnabled}).Error)
	require.NoError(t, model.DB.Create(&model.Ability{Group: "default", Model: "fixture-coding-model", ChannelId: 991, Enabled: true}).Error)
	var token string
	var calls atomic.Int32
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		decoded, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Codex-Model-Config"))
		require.NoError(t, err)
		var config struct{ Token, Group, Model string }
		require.NoError(t, common.Unmarshal(decoded, &config))
		assert.Equal(t, "default", config.Group)
		assert.Equal(t, "fixture-coding-model", config.Model)
		token = config.Token
		claims, owner, err := service.ValidateCodexRelayToken(token)
		require.NoError(t, err)
		assert.Equal(t, fixture.adminID, owner.Id)
		assert.Equal(t, fixture.adminSID, claims.Identity.SessionID)
		assert.Equal(t, config.Group, claims.Group)
		assert.Equal(t, config.Model, claims.Model)
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		assert.Contains(t, string(body), `"prompt":"Fix the failing test"`)
		_, _ = w.Write([]byte(`{"success":true,"data":{"workspace":{"id":"fixture"}}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	for _, path := range []string{"/environments/fixture/tasks", "/workspaces/fixture/turns"} {
		request, response := fixture.request(http.MethodPost, "/api/codex"+path, fixture.adminToken,
			strings.NewReader(`{"prompt":"Fix the failing test","model":"fixture-coding-model","group":"default","requestId":"fixture-request"}`))
		fixture.engine.ServeHTTP(response, request)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		assert.NotContains(t, response.Body.String(), token)
	}
	for _, selection := range []string{`"model":"forbidden-model","group":"default"`, `"model":"fixture-coding-model","group":"forbidden-group"`} {
		request, response := fixture.request(http.MethodPost, "/api/codex/environments/fixture/tasks", fixture.adminToken,
			strings.NewReader(`{"prompt":"Fix issue",`+selection+`}`))
		fixture.engine.ServeHTTP(response, request)
		assert.Equal(t, http.StatusBadRequest, response.Code)
		assert.Contains(t, response.Body.String(), "codex_model_unavailable")
	}
	assert.Equal(t, int32(2), calls.Load(), "invalid selections must fail before creating a cloud task")
	revoked, err := model.RevokeUserSession(fixture.adminID, fixture.adminSID, "cloud-test")
	require.NoError(t, err)
	require.True(t, revoked)
	_, _, err = service.ValidateCodexRelayToken(token)
	require.Error(t, err, "revoking a browser session revokes its background task credential")
}

func TestCodexCloudGitHubCredentialsUseOwnerAndRevocationGeneration(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	previousCrypto := common.CryptoSecret
	common.CryptoSecret = "codex-cloud-github-fixture-secret"
	t.Cleanup(func() { common.CryptoSecret = previousCrypto })
	t.Setenv("CODEX_GITHUB_CLIENT_ID", "codex-cloud-fixture-app")
	t.Setenv("CODEX_GITHUB_CLIENT_SECRET", "codex-cloud-fixture-app-secret")
	t.Setenv("CODEX_GITHUB_CLIENT_SECRET_FILE", "")
	t.Setenv("CODEX_GITHUB_REDIRECT_URI", "https://fixture.example/codex?github_oauth=1")
	for _, ownerID := range []int{fixture.adminID, 999999} {
		connection := &model.CodexGitHubConnection{UserID: ownerID, ClientID: "codex-cloud-fixture-app", Login: fmt.Sprintf("owner-%d", ownerID), Generation: 8}
		var err error
		connection.TokenCiphertext, err = common.EncryptSecret(fmt.Sprintf("github-secret-for-%d", ownerID), fmt.Sprintf("codex-github:%d", ownerID))
		require.NoError(t, err)
		require.NoError(t, model.DB.Create(connection).Error)
	}
	var observed []http.Header
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed = append(observed, r.Header.Clone())
		_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	for _, path := range []string{"/environments/fixture/setup", "/workspaces/fixture/git/push"} {
		request, response := fixture.request(http.MethodPost, "/api/codex"+path, fixture.adminToken, strings.NewReader(`{}`))
		request.Header.Set("X-Codex-Admin-Id", "999999")
		fixture.engine.ServeHTTP(response, request)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		assert.NotContains(t, response.Body.String(), "github-secret")
	}
	require.NoError(t, model.DB.Model(&model.CodexGitHubConnection{}).Where("user_id = ?", fixture.adminID).
		Updates(map[string]interface{}{"revoked_at": time.Now().Unix(), "generation": 9}).Error)
	request, response := fixture.request(http.MethodGet, "/api/codex/workspaces/fixture/git/status", fixture.adminToken, nil)
	fixture.engine.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Len(t, observed, 3)
	for _, headers := range observed[:2] {
		assert.Equal(t, fmt.Sprintf("github-secret-for-%d", fixture.adminID), headers.Get("X-Codex-GitHub-Token"))
		assert.Equal(t, fmt.Sprintf("owner-%d", fixture.adminID), headers.Get("X-Codex-GitHub-Login"))
		assert.Equal(t, "8", headers.Get("X-Codex-GitHub-Generation"))
	}
	assert.Empty(t, observed[2].Get("X-Codex-GitHub-Token"))
	assert.Empty(t, observed[2].Get("X-Codex-GitHub-Login"))
	assert.Equal(t, "9", observed[2].Get("X-Codex-GitHub-Generation"))
}

func TestCodexCloudRejectsAmbiguousBodiesAndTraversalBeforeRunner(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var calls atomic.Int32
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	for _, body := range []string{`null`, `[]`, `"draft"`, `{} {}`, `{"model":"a","model":"b"}`, `{"model":"a","Model":"b"}`, `{"config":{"name":"a","name":"b"}}`, `{`} {
		request, response := fixture.request(http.MethodPost, "/api/codex/environments", fixture.adminToken, strings.NewReader(body))
		fixture.engine.ServeHTTP(response, request)
		assert.Equal(t, http.StatusBadRequest, response.Code, body)
		assert.Contains(t, response.Body.String(), "codex_invalid_body")
	}
	for _, id := range []string{"..", ".", "%2e%2e", "%252e%252e", "name%5cother", "name%00other", "%2e%2e%2fintegrations"} {
		request, response := fixture.request(http.MethodPost, "/api/codex/environments/"+id+"/setup", fixture.adminToken, strings.NewReader(`{}`))
		fixture.engine.ServeHTTP(response, request)
		assert.Equal(t, http.StatusNotFound, response.Code, id)
	}
	assert.Zero(t, calls.Load(), "invalid requests must not reach private runner operations")
}
