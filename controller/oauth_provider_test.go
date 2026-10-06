package controller

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const oidcTestIssuer = "https://idp.example.com/oidc"
const oidcTestVerifier = "test-verifier-0123456789abcdef0123456789abcdef"

func setupOidcProviderTest(t *testing.T) (*gorm.DB, *model.User) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRedisEnabled := common.RedisEnabled
	previousMainDatabaseType, previousLogDatabaseType := common.MainDatabaseType(), common.LogDatabaseType()
	common.RedisEnabled = false
	// External DSNs must refer to isolated, disposable test databases.
	dialect := common.DatabaseType(os.Getenv("TEST_OAUTH_DIALECT"))
	var driver gorm.Dialector
	switch dialect {
	case "", common.DatabaseTypeSQLite:
		dialect = common.DatabaseTypeSQLite
		dsn := "file:" + strings.ReplaceAll(t.Name(), "/", "_") + "?mode=memory&cache=shared"
		driver = sqlite.Open(dsn)
	case common.DatabaseTypeMySQL:
		dsn := os.Getenv("TEST_OAUTH_MYSQL_DSN")
		require.NotEmpty(t, dsn, "configure an isolated disposable MySQL database")
		driver = mysql.Open(dsn)
	case common.DatabaseTypePostgreSQL:
		dsn := os.Getenv("TEST_OAUTH_POSTGRES_DSN")
		require.NotEmpty(t, dsn, "configure an isolated disposable PostgreSQL database")
		driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
	default:
		t.Fatalf("unsupported OAuth controller test dialect %q", dialect)
	}
	common.SetDatabaseTypes(dialect, dialect)
	db, err := gorm.Open(driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	if dialect == common.DatabaseTypeSQLite {
		sqlDB.SetMaxOpenConns(1)
	} else {
		sqlDB.SetMaxOpenConns(4)
	}
	model.DB, model.LOG_DB = db, db
	fixtureModels := []interface{}{
		&model.User{}, &model.UserSession{}, &model.AuthFlow{}, &model.OauthClient{}, &model.OauthConsent{}, &model.OauthSigningKey{},
		&model.OAuthGrant{}, &model.OAuthAccessToken{}, &model.OAuthRefreshToken{}, &model.OAuthAction{}, &model.OAuthRelayBinding{}, &model.Token{}, &model.Log{},
	}
	require.NoError(t, db.AutoMigrate(fixtureModels...))
	if dialect != common.DatabaseTypeSQLite {
		for _, table := range fixtureModels {
			require.NoError(t, db.Unscoped().Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(table).Error)
		}
	}
	t.Logf("OAuth controller database: %s", dialect)

	settings := system_setting.GetOauthProviderSettings()
	previousSettings := *settings
	settings.Enabled = true
	settings.Issuer = oidcTestIssuer
	settings.AccessTokenTTLMinutes = 480
	t.Cleanup(func() {
		*settings = previousSettings
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.RedisEnabled = previousRedisEnabled
		common.SetDatabaseTypes(previousMainDatabaseType, previousLogDatabaseType)
		sqlDB, dbErr := db.DB()
		if dbErr == nil {
			_ = sqlDB.Close()
		}
	})

	user := &model.User{
		Username:    "oidc-user",
		Password:    "password",
		Group:       "default",
		Email:       "oidc-user@example.com",
		DisplayName: "OIDC User",
		Status:      common.UserStatusEnabled,
		Role:        common.RoleCommonUser,
		AuthVersion: 1,
		Quota:       500000,
		UsedQuota:   100,
	}
	require.NoError(t, db.Create(user).Error)
	return db, user
}

func createOidcTestClient(t *testing.T, isPublic bool) (*model.OauthClient, string) {
	t.Helper()
	client := &model.OauthClient{
		Name:     "Test RP",
		ClientId: "test-rp-client",
		Scopes:   "openid profile email",
		Enabled:  true,
		IsPublic: isPublic,
	}
	require.NoError(t, client.SetRedirectUris([]string{"https://rp.example.com/cb"}))
	secret := ""
	if !isPublic {
		generated, err := client.GenerateOauthClientSecret()
		require.NoError(t, err)
		secret = generated
	}
	require.NoError(t, model.CreateOauthClient(client))
	return client, secret
}

func performOidcRequest(t *testing.T, method string, target string, body *url.Values, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body != nil {
		reader = strings.NewReader(body.Encode())
	} else {
		reader = strings.NewReader("")
	}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(method, target, reader)
	if body != nil {
		ctx.Request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	for key, value := range headers {
		ctx.Request.Header.Set(key, value)
	}
	parsedTarget, err := url.Parse(target)
	require.NoError(t, err)
	switch {
	case strings.HasSuffix(parsedTarget.Path, "/.well-known/openid-configuration"):
		GetOidcDiscovery(ctx)
	case strings.HasSuffix(parsedTarget.Path, "/jwks.json"):
		GetOidcJWKS(ctx)
	case strings.HasSuffix(parsedTarget.Path, "/authorize"):
		OidcAuthorize(ctx)
	case strings.HasSuffix(parsedTarget.Path, "/token"):
		OidcToken(ctx)
	case strings.HasSuffix(parsedTarget.Path, "/userinfo"):
		OidcUserInfo(ctx)
	case strings.HasSuffix(parsedTarget.Path, "/revoke"):
		OidcRevoke(ctx)
	default:
		t.Fatalf("unhandled oidc target: %s", target)
	}
	return recorder
}

func followOidcRedirect(t *testing.T, recorder *httptest.ResponseRecorder) *url.URL {
	t.Helper()
	require.Equal(t, http.StatusFound, recorder.Code, "expected a redirect, got %d: %s", recorder.Code, recorder.Body.String())
	location := recorder.Header().Get("Location")
	require.NotEmpty(t, location)
	parsed, err := url.Parse(location)
	require.NoError(t, err)
	return parsed
}

func TestOidcDiscoveryAndJWKS(t *testing.T) {
	setupOidcProviderTest(t)
	_, kid, err := model.GetOrCreateOauthSigningKey()
	require.NoError(t, err)

	recorder := performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/.well-known/openid-configuration", nil, nil)
	require.Equal(t, http.StatusOK, recorder.Code)
	var discovery map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &discovery))
	assert.Equal(t, oidcTestIssuer, discovery["issuer"])
	assert.Equal(t, oidcTestIssuer+"/token", discovery["token_endpoint"])
	assert.Equal(t, oidcTestIssuer+"/userinfo", discovery["userinfo_endpoint"])
	assert.Equal(t, oidcTestIssuer+"/.well-known/jwks.json", discovery["jwks_uri"])

	jwksRecorder := performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/.well-known/jwks.json", nil, nil)
	require.Equal(t, http.StatusOK, jwksRecorder.Code)
	var jwks struct {
		Keys []map[string]any `json:"keys"`
	}
	require.NoError(t, common.Unmarshal(jwksRecorder.Body.Bytes(), &jwks))
	require.Len(t, jwks.Keys, 1)
	assert.Equal(t, kid, jwks.Keys[0]["kid"])
	assert.Equal(t, "RSA", jwks.Keys[0]["kty"])
}

func TestOidcAuthorizeValidations(t *testing.T) {
	setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, false)

	// Unregistered redirect_uri must never be used as a redirect target.
	recorder := performOidcRequest(t, http.MethodGet,
		oidcTestIssuer+"/authorize?response_type=code&client_id="+client.ClientId+"&redirect_uri=https://evil.example.com/cb&scope=openid", nil, nil)
	target := followOidcRedirect(t, recorder)
	assert.Equal(t, "/authorize", target.Path)
	assert.Equal(t, "invalid_request", target.Query().Get("error"))

	// Unknown client.
	recorder = performOidcRequest(t, http.MethodGet,
		oidcTestIssuer+"/authorize?response_type=code&client_id=missing&redirect_uri=https://rp.example.com/cb&scope=openid", nil, nil)
	target = followOidcRedirect(t, recorder)
	assert.Equal(t, "invalid_client", target.Query().Get("error"))

	// Unsupported response_type.
	recorder = performOidcRequest(t, http.MethodGet,
		oidcTestIssuer+"/authorize?response_type=token&client_id="+client.ClientId+"&redirect_uri=https://rp.example.com/cb", nil, nil)
	target = followOidcRedirect(t, recorder)
	assert.Equal(t, "unsupported_response_type", target.Query().Get("error"))

	// Valid request forwards to the consent page with normalized parameters.
	recorder = performOidcRequest(t, http.MethodGet,
		oidcTestIssuer+"/authorize?response_type=code&client_id="+client.ClientId+"&redirect_uri=https://rp.example.com/cb&scope=openid+profile+openid&state=xyz123&nonce=n0nce&code_challenge_method=S256&code_challenge="+oidcS256Challenge(oidcTestVerifier), nil, nil)
	target = followOidcRedirect(t, recorder)
	assert.Equal(t, "/authorize", target.Path)
	query := target.Query()
	assert.Equal(t, client.ClientId, query.Get("client_id"))
	assert.Equal(t, "https://rp.example.com/cb", query.Get("redirect_uri"))
	assert.Equal(t, "openid profile", query.Get("scope"), "duplicate scopes must be dropped")
	assert.Equal(t, "xyz123", query.Get("state"))
	assert.Equal(t, "n0nce", query.Get("nonce"))
}

func oidcConsentRequestContext(t *testing.T, method string, userID int, body any) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	if body != nil {
		payload, err := common.Marshal(body)
		require.NoError(t, err)
		ctx.Request = httptest.NewRequest(method, "/api/oauth2/consent", strings.NewReader(string(payload)))
		ctx.Request.Header.Set("Content-Type", "application/json")
	} else {
		ctx.Request = httptest.NewRequest(method, "/api/oauth2/consent", nil)
	}
	ctx.Set("id", userID)
	ctx.Set("session_id", "oauth-test-session")
	ctx.Set("auth_version", int64(1))
	ctx.Set("session_version", int64(1))
	return ctx, recorder
}

func oidcTestConsentQuery(request oidcConsentRequest) string {
	query := url.Values{
		"client_id": {request.ClientId}, "redirect_uri": {request.RedirectUri},
		"scope": {request.Scope}, "state": {request.State}, "nonce": {request.Nonce},
		"code_challenge": {request.CodeChallenge}, "code_challenge_method": {request.CodeChallengeMethod},
	}
	for _, resource := range request.Resources {
		query.Add("resource", resource)
	}
	return query.Encode()
}

// approveOidcTestConsent follows the same preview -> explicit decision contract
// as the browser, including a real-session-bound one-time consent token.
func approveOidcTestConsent(t *testing.T, userID int, request oidcConsentRequest) *httptest.ResponseRecorder {
	t.Helper()
	ctx, recorder := oidcConsentRequestContext(t, http.MethodGet, userID, nil)
	ctx.Request.URL.RawQuery = oidcTestConsentQuery(request)
	GetOidcConsent(ctx)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var preview struct {
		Success        bool   `json:"success"`
		RequireConsent bool   `json:"require_consent"`
		ConsentToken   string `json:"consent_token"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &preview))
	require.True(t, preview.Success, recorder.Body.String())
	require.True(t, preview.RequireConsent)
	require.NotEmpty(t, preview.ConsentToken)
	request.ConsentToken = preview.ConsentToken
	ctx, recorder = oidcConsentRequestContext(t, http.MethodPost, userID, request)
	PostOidcConsent(ctx)
	return recorder
}

func TestOidcConsentAndTokenFlow(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	client, secret := createOidcTestClient(t, false)

	authorizeParams := oidcConsentRequest{
		ClientId: client.ClientId, RedirectUri: "https://rp.example.com/cb",
		Scope: "openid profile email", State: "st4te", Nonce: "n0nce", Approve: true,
		CodeChallenge: oidcS256Challenge(oidcTestVerifier), CodeChallengeMethod: "S256",
	}

	// Preview requires consent and never creates an authorization code, even
	// if a legacy remembered consent exists.
	require.NoError(t, model.SaveOauthConsent(user.Id, client.Id, strings.Fields(authorizeParams.Scope)))
	ctx, recorder := oidcConsentRequestContext(t, http.MethodGet, user.Id, nil)
	ctx.Request.URL.RawQuery = oidcTestConsentQuery(authorizeParams)
	GetOidcConsent(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var consentState struct {
		Success        bool   `json:"success"`
		RequireConsent bool   `json:"require_consent"`
		Redirect       string `json:"redirect"`
		ConsentToken   string `json:"consent_token"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &consentState))
	require.True(t, consentState.Success, recorder.Body.String())
	assert.True(t, consentState.RequireConsent)
	assert.Empty(t, consentState.Redirect)
	var codeCount int64
	require.NoError(t, db.Model(&model.AuthFlow{}).Where("purpose = ?", "oidc_code").Count(&codeCount).Error)
	assert.Zero(t, codeCount)

	authorizeParams.ConsentToken = consentState.ConsentToken
	ctx, recorder = oidcConsentRequestContext(t, http.MethodPost, user.Id, authorizeParams)
	PostOidcConsent(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var approval struct {
		Success  bool   `json:"success"`
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &approval))
	require.True(t, approval.Success, recorder.Body.String())
	redirect, err := url.Parse(approval.Redirect)
	require.NoError(t, err)
	assert.Equal(t, "https://rp.example.com/cb", redirect.Scheme+"://"+redirect.Host+redirect.Path)
	code := redirect.Query().Get("code")
	require.NotEmpty(t, code)
	assert.Equal(t, "st4te", redirect.Query().Get("state"))
	assert.Equal(t, oidcTestIssuer, redirect.Query().Get("iss"))

	// Exchange uses PKCE and Basic client authentication, including on a
	// confidential client. OIDC claims remain compatible with login clients.
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {"https://rp.example.com/cb"}, "code_verifier": {oidcTestVerifier},
	}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, map[string]string{
		"Authorization": "Basic " + basicAuth(client.ClientId, secret),
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	assert.Equal(t, "no-cache", recorder.Header().Get("Pragma"))
	var tokenResponse struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
		IDToken      string `json:"id_token"`
		Scope        string `json:"scope"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &tokenResponse))
	assert.Equal(t, "Bearer", tokenResponse.TokenType)
	assert.ElementsMatch(t, []string{"openid", "profile", "email"}, strings.Fields(tokenResponse.Scope))
	assert.NotEmpty(t, tokenResponse.AccessToken)
	assert.NotEmpty(t, tokenResponse.IDToken)
	assert.Empty(t, tokenResponse.RefreshToken, "offline_access was not granted")
	assert.LessOrEqual(t, tokenResponse.ExpiresIn, int64(900))

	userID, scopes, err := service.ParseOidcAccessToken(tokenResponse.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, user.Id, userID)
	assert.ElementsMatch(t, []string{"openid", "profile", "email"}, scopes)

	privateKey, err := model.LoadActiveOidcSigningKey()
	require.NoError(t, err)
	idClaims := jwt.MapClaims{}
	parsed, parseErr := jwt.NewParser(jwt.WithValidMethods([]string{"RS256"})).ParseWithClaims(tokenResponse.IDToken, idClaims, func(*jwt.Token) (interface{}, error) {
		return &privateKey.PublicKey, nil
	})
	require.NoError(t, parseErr)
	assert.True(t, parsed.Valid)
	assert.Equal(t, strconv.Itoa(user.Id), idClaims["sub"])
	assert.Equal(t, oidcTestIssuer, idClaims["iss"])
	assert.Equal(t, "n0nce", idClaims["nonce"])
	audiences, err := idClaims.GetAudience()
	require.NoError(t, err)
	assert.Contains(t, audiences, client.ClientId)

	recorder = performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{
		"Authorization": "Bearer " + tokenResponse.AccessToken,
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var userinfo map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &userinfo))
	assert.Equal(t, strconv.Itoa(user.Id), userinfo["sub"])
	assert.Equal(t, "oidc-user@example.com", userinfo["email"])
	assert.EqualValues(t, 500000, userinfo["quota"])
	assert.EqualValues(t, 100, userinfo["used_quota"])
	assert.EqualValues(t, 500000, userinfo["quota_per_unit"])

	form2 := url.Values{"grant_type": {"authorization_code"}, "code": {"x"}, "redirect_uri": {"https://rp.example.com/cb"}}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form2, map[string]string{
		"Authorization": "Basic " + basicAuth(client.ClientId, "wrong-secret"),
	})
	assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "invalid_client")
	assert.Contains(t, recorder.Header().Get("WWW-Authenticate"), "Basic")
}

func TestOidcRefreshAndRevokeFlow(t *testing.T) {
	_, user := setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "openid profile offline_access"
	require.NoError(t, model.UpdateOauthClient(client))
	recorder := approveOidcTestConsent(t, user.Id, oidcConsentRequest{
		ClientId: client.ClientId, RedirectUri: "https://rp.example.com/cb", Scope: client.Scopes,
		CodeChallenge: oidcS256Challenge(oidcTestVerifier), CodeChallengeMethod: "S256", Approve: true,
	})
	var approval struct {
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &approval))
	redirect, err := url.Parse(approval.Redirect)
	require.NoError(t, err)
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {redirect.Query().Get("code")},
		"redirect_uri": {"https://rp.example.com/cb"}, "code_verifier": {oidcTestVerifier}, "client_id": {client.ClientId},
	}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var original service.OAuthTokenResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &original))
	require.NotEmpty(t, original.RefreshToken)

	refresh := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {original.RefreshToken}, "client_id": {client.ClientId}}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &refresh, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var rotated service.OAuthTokenResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &rotated))
	assert.NotEqual(t, original.RefreshToken, rotated.RefreshToken)
	assert.NotEqual(t, original.AccessToken, rotated.AccessToken)

	revoke := url.Values{"client_id": {client.ClientId}, "token": {rotated.RefreshToken}}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/revoke", &revoke, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	for _, token := range []string{original.AccessToken, rotated.AccessToken} {
		recorder = performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{"Authorization": "Bearer " + token})
		assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	}
	refresh.Set("refresh_token", rotated.RefreshToken)
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &refresh, nil)
	assert.Equal(t, http.StatusBadRequest, recorder.Code)
	revoke.Set("token", "unknown-token")
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/revoke", &revoke, nil)
	assert.Equal(t, http.StatusOK, recorder.Code, "unknown credentials have identical revocation responses")
}

func TestOidcConsentDenyReturnsAccessDenied(t *testing.T) {
	_, user := setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, false)

	recorder := approveOidcTestConsent(t, user.Id, oidcConsentRequest{
		ClientId: client.ClientId, RedirectUri: "https://rp.example.com/cb", Scope: "openid",
		State: "s1", Approve: false,
		CodeChallenge: oidcS256Challenge(oidcTestVerifier), CodeChallengeMethod: "S256",
	})
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Contains(t, response.Redirect, "error=access_denied")
	assert.Contains(t, response.Redirect, "state=s1")
}

func TestOidcUserInfoRejectsBadTokens(t *testing.T) {
	setupOidcProviderTest(t)
	recorder := performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, nil)
	assert.Equal(t, http.StatusUnauthorized, recorder.Code)

	recorder = performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{
		"Authorization": "Bearer not-a-token",
	})
	assert.Equal(t, http.StatusUnauthorized, recorder.Code)
}

func basicAuth(username, password string) string {
	return base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
}

func oidcS256Challenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func TestOidcConsentScopeSelectionAndSessionBoundary(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "openid profile email profile:read"
	require.NoError(t, model.UpdateOauthClient(client))
	request := oidcConsentRequest{
		ClientId: client.ClientId, RedirectUri: "https://rp.example.com/cb", Scope: "full",
		State: "consent-state", CodeChallenge: oidcS256Challenge(oidcTestVerifier), CodeChallengeMethod: "S256", Approve: true,
	}
	ctx, recorder := oidcConsentRequestContext(t, http.MethodGet, user.Id, nil)
	ctx.Request.URL.RawQuery = oidcTestConsentQuery(request)
	GetOidcConsent(ctx)
	var preview struct {
		Success      bool                    `json:"success"`
		ConsentToken string                  `json:"consent_token"`
		Scopes       []string                `json:"scopes"`
		Capabilities []model.OAuthCapability `json:"capabilities"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &preview))
	require.True(t, preview.Success, recorder.Body.String())
	assert.ElementsMatch(t, strings.Fields(client.Scopes), preview.Scopes)
	assert.NotContains(t, preview.Scopes, "full")
	require.Len(t, preview.Capabilities, len(preview.Scopes))
	request.ConsentToken = preview.ConsentToken
	request.SelectedScopes = []string{"openid", "profile:read"}

	// Copying a consent challenge into a different browser session is denied,
	// and does not consume the legitimate session's pending decision.
	ctx, recorder = oidcConsentRequestContext(t, http.MethodPost, user.Id, request)
	ctx.Set("session_id", "different-browser-session")
	PostOidcConsent(ctx)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	ctx, recorder = oidcConsentRequestContext(t, http.MethodPost, user.Id, request)
	PostOidcConsent(ctx)
	var approval struct {
		Success  bool   `json:"success"`
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &approval))
	require.True(t, approval.Success, recorder.Body.String())
	redirect, err := url.Parse(approval.Redirect)
	require.NoError(t, err)
	form := url.Values{
		"grant_type": {"authorization_code"}, "client_id": {client.ClientId},
		"code": {redirect.Query().Get("code")}, "redirect_uri": {request.RedirectUri}, "code_verifier": {oidcTestVerifier},
	}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var token service.OAuthTokenResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &token))
	assert.ElementsMatch(t, request.SelectedScopes, strings.Fields(token.Scope))

	// Reusing the same approval cannot create another grant.
	ctx, recorder = oidcConsentRequestContext(t, http.MethodPost, user.Id, request)
	PostOidcConsent(ctx)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	var grants int64
	require.NoError(t, db.Model(&model.OAuthGrant{}).Count(&grants).Error)
	assert.EqualValues(t, 1, grants)

	// A delegated identity/PAT without a live browser session never approves
	// itself or retrieves a browser consent challenge.
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		ctx, recorder = oidcConsentRequestContext(t, method, user.Id, request)
		ctx.Set("session_id", "")
		if method == http.MethodGet {
			GetOidcConsent(ctx)
		} else {
			PostOidcConsent(ctx)
		}
		assert.Equal(t, http.StatusForbidden, recorder.Code)
	}
}

func TestOAuthGrantManagementOwnsScopesAndInvalidatesTokens(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, true)
	request := oidcConsentRequest{
		ClientId: client.ClientId, RedirectUri: "https://rp.example.com/cb", Scope: "openid profile",
		CodeChallenge: oidcS256Challenge(oidcTestVerifier), CodeChallengeMethod: "S256", Approve: true,
	}
	recorder := approveOidcTestConsent(t, user.Id, request)
	var approval struct {
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &approval))
	redirect, err := url.Parse(approval.Redirect)
	require.NoError(t, err)
	form := url.Values{
		"grant_type": {"authorization_code"}, "client_id": {client.ClientId},
		"code": {redirect.Query().Get("code")}, "redirect_uri": {request.RedirectUri}, "code_verifier": {oidcTestVerifier},
	}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var token service.OAuthTokenResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &token))
	var grant model.OAuthGrant
	require.NoError(t, db.First(&grant).Error)

	ctx, recorder := oidcConsentRequestContext(t, http.MethodGet, user.Id, nil)
	GetOAuthGrants(ctx)
	var list struct {
		Data []service.OAuthGrantView `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &list))
	require.Len(t, list.Data, 1)
	assert.Equal(t, client.Name, list.Data[0].ClientName)
	assert.True(t, list.Data[0].Active)
	assert.NotContains(t, recorder.Body.String(), token.AccessToken)

	ctx, recorder = oidcConsentRequestContext(t, http.MethodGet, user.Id+1, nil)
	GetOAuthGrants(ctx)
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &list))
	assert.Empty(t, list.Data)

	// Cross-account access and self-expansion cannot mutate the authorization.
	for _, test := range []struct {
		userID   int
		scopes   []string
		expected int
	}{
		{user.Id + 1, []string{"openid"}, http.StatusNotFound},
		{user.Id, []string{"openid", "email"}, http.StatusBadRequest},
		{user.Id, []string{"openid"}, http.StatusOK},
	} {
		ctx, recorder = oidcConsentRequestContext(t, http.MethodPatch, test.userID, gin.H{"scopes": test.scopes})
		ctx.Params = gin.Params{{Key: "id", Value: strconv.Itoa(grant.ID)}}
		PatchOAuthGrant(ctx)
		assert.Equal(t, test.expected, recorder.Code, recorder.Body.String())
	}
	recorder = performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{"Authorization": "Bearer " + token.AccessToken})
	assert.Equal(t, http.StatusUnauthorized, recorder.Code, "scope narrowing invalidates all previously issued tokens")
	ctx, recorder = oidcConsentRequestContext(t, http.MethodDelete, user.Id+1, nil)
	ctx.Params = gin.Params{{Key: "id", Value: strconv.Itoa(grant.ID)}}
	DeleteOAuthGrant(ctx)
	assert.Equal(t, http.StatusNotFound, recorder.Code)
	ctx, recorder = oidcConsentRequestContext(t, http.MethodDelete, user.Id, nil)
	ctx.Params = gin.Params{{Key: "id", Value: strconv.Itoa(grant.ID)}}
	DeleteOAuthGrant(ctx)
	assert.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.NoError(t, db.First(&grant, grant.ID).Error)
	assert.NotZero(t, grant.RevokedAt)
}
