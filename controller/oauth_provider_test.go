package controller

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	"gorm.io/gorm"
)

const oidcTestIssuer = "https://idp.example.com/oidc"

func setupOidcProviderTest(t *testing.T) (*gorm.DB, *model.User) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRedisEnabled := common.RedisEnabled
	previousMainDatabaseType, previousLogDatabaseType := common.MainDatabaseType(), common.LogDatabaseType()
	common.RedisEnabled = false
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)

	dsn := "file:" + strings.ReplaceAll(t.Name(), "/", "_") + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	model.DB, model.LOG_DB = db, db
	require.NoError(t, db.AutoMigrate(
		&model.User{}, &model.AuthFlow{}, &model.OauthClient{}, &model.OauthConsent{}, &model.OauthSigningKey{},
	))

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
		oidcTestIssuer+"/authorize?response_type=code&client_id="+client.ClientId+"&redirect_uri=https://rp.example.com/cb&scope=openid+profile+openid&state=xyz123&nonce=n0nce", nil, nil)
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
	return ctx, recorder
}

func TestOidcConsentAndTokenFlow(t *testing.T) {
	setupOidcProviderTest(t)
	client, secret := createOidcTestClient(t, false)

	authorizeParams := oidcConsentRequest{
		ClientId:    client.ClientId,
		RedirectUri: "https://rp.example.com/cb",
		Scope:       "openid profile email",
		State:       "st4te",
		Nonce:       "n0nce",
		Approve:     true,
	}

	// First GET reports that consent is required.
	ctx, recorder := oidcConsentRequestContext(t, http.MethodGet, 1, nil)
	ctx.Request.URL.RawQuery = "client_id=" + client.ClientId + "&redirect_uri=https://rp.example.com/cb&scope=openid+profile+email"
	GetOidcConsent(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var consentState struct {
		Success        bool   `json:"success"`
		RequireConsent bool   `json:"require_consent"`
		Redirect       string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &consentState))
	assert.True(t, consentState.RequireConsent)

	// Approval persists the grant and returns a redirect with a code.
	ctx, recorder = oidcConsentRequestContext(t, http.MethodPost, 1, authorizeParams)
	PostOidcConsent(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var approval struct {
		Success  bool   `json:"success"`
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &approval))
	require.True(t, approval.Success)
	redirect, err := url.Parse(approval.Redirect)
	require.NoError(t, err)
	assert.Equal(t, "https://rp.example.com/cb", redirect.Scheme+"://"+redirect.Host+redirect.Path)
	code := redirect.Query().Get("code")
	require.NotEmpty(t, code)
	assert.Equal(t, "st4te", redirect.Query().Get("state"))

	// A remembered grant skips the consent screen on the next login.
	ctx, recorder = oidcConsentRequestContext(t, http.MethodGet, 1, nil)
	ctx.Request.URL.RawQuery = "client_id=" + client.ClientId + "&redirect_uri=https://rp.example.com/cb&scope=openid+profile+email"
	GetOidcConsent(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var silent struct {
		RequireConsent bool   `json:"require_consent"`
		Redirect       string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &silent))
	assert.False(t, silent.RequireConsent)
	assert.Contains(t, silent.Redirect, "code=")

	// Exchange the code at the token endpoint using Basic auth.
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"https://rp.example.com/cb"},
		"code_verifier": {""},
	}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, map[string]string{
		"Authorization": "Basic " + basicAuth(client.ClientId, secret),
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var tokenResponse struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int64  `json:"expires_in"`
		IDToken     string `json:"id_token"`
		Scope       string `json:"scope"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &tokenResponse))
	assert.Equal(t, "Bearer", tokenResponse.TokenType)
	assert.Equal(t, "openid profile email", tokenResponse.Scope)
	assert.NotEmpty(t, tokenResponse.AccessToken)
	assert.NotEmpty(t, tokenResponse.IDToken)

	// The access token resolves back to the user with granted scopes.
	userId, scopes, err := service.ParseOidcAccessToken(tokenResponse.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, 1, userId)
	assert.ElementsMatch(t, []string{"openid", "profile", "email"}, scopes)

	// The id_token carries the nonce and standard claims, signed RS256.
	privateKey, err := model.LoadActiveOidcSigningKey()
	require.NoError(t, err)
	idClaims := &jwt.RegisteredClaims{}
	parsed, parseErr := jwt.NewParser(jwt.WithValidMethods([]string{"RS256"})).ParseWithClaims(tokenResponse.IDToken, idClaims, func(*jwt.Token) (interface{}, error) {
		return &privateKey.PublicKey, nil
	})
	require.NoError(t, parseErr)
	assert.True(t, parsed.Valid)
	assert.Equal(t, "1", idClaims.Subject)
	assert.Equal(t, oidcTestIssuer, idClaims.Issuer)
	assert.Contains(t, idClaims.Audience, client.ClientId)

	// The userinfo endpoint accepts the bearer token.
	recorder = performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{
		"Authorization": "Bearer " + tokenResponse.AccessToken,
	})
	require.Equal(t, http.StatusOK, recorder.Code)
	var userinfo map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &userinfo))
	assert.Equal(t, "1", userinfo["sub"])
	assert.Equal(t, "oidc-user@example.com", userinfo["email"])

	// Authorization codes are single use.
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, map[string]string{
		"Authorization": "Basic " + basicAuth(client.ClientId, secret),
	})
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"invalid_grant"`)

	// Wrong client secret is rejected.
	form2 := url.Values{"grant_type": {"authorization_code"}, "code": {"x"}, "redirect_uri": {"https://rp.example.com/cb"}}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form2, map[string]string{
		"Authorization": "Basic " + basicAuth(client.ClientId, "wrong-secret"),
	})
	assert.Equal(t, http.StatusBadRequest, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "invalid_client")
}

func TestOidcTokenPublicClientRequiresPKCE(t *testing.T) {
	setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, true)

	challenge := oidcS256Challenge("test-verifier-0123456789abcdef0123456789abcdef")
	ctx, recorder := oidcConsentRequestContext(t, http.MethodPost, 1, oidcConsentRequest{
		ClientId:            client.ClientId,
		RedirectUri:         "https://rp.example.com/cb",
		Scope:               "openid",
		CodeChallenge:       challenge,
		CodeChallengeMethod: "S256",
		Approve:             true,
	})
	PostOidcConsent(ctx)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var approval struct {
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &approval))
	redirect, err := url.Parse(approval.Redirect)
	require.NoError(t, err)
	code := redirect.Query().Get("code")
	require.NotEmpty(t, code)

	// Missing verifier fails PKCE verification.
	form := url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {code},
		"redirect_uri": {"https://rp.example.com/cb"},
		"client_id":    {client.ClientId},
	}
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, nil)
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "invalid_grant")

	// Codes are consumed even when PKCE fails, so a leaked code is useless.
	form.Set("code_verifier", "wrong-verifier-wrong-verifier-wrong-verifier-wrong")
	recorder = performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/token", &form, nil)
	assert.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestOidcConsentDenyReturnsAccessDenied(t *testing.T) {
	setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, false)

	ctx, recorder := oidcConsentRequestContext(t, http.MethodPost, 1, oidcConsentRequest{
		ClientId:    client.ClientId,
		RedirectUri: "https://rp.example.com/cb",
		Scope:       "openid",
		State:       "s1",
		Approve:     false,
	})
	PostOidcConsent(ctx)
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
