package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func oauthActionHTTPFixture(t *testing.T) (*gin.Engine, *service.OAuthPrincipal, string, string, *model.Token) {
	t.Helper()
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.AutoMigrate(&model.OAuthAction{}, &model.UserSession{}, &model.TwoFA{}, &model.PasskeyCredential{}, &model.Token{}, &model.Log{}))
	previousSecret := common.SessionSecret
	common.SessionSecret = "oauth-action-http-test-secret"
	t.Cleanup(func() { common.SessionSecret = previousSecret })
	password, err := common.Password2Hash("OriginalPass123")
	require.NoError(t, err)
	user.Password = password
	require.NoError(t, db.Model(user).Update("password", password).Error)
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "api_key:reveal account_security:write account_security:read offline_access"
	require.NoError(t, db.Model(client).Update("scopes", client.Scopes).Error)
	tokens, err := service.IssueOAuthTokens(client, user, strings.Fields(client.Scopes), []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	principal, recognized, err := service.AuthenticateOAuthAccessToken(tokens.AccessToken)
	require.NoError(t, err)
	require.True(t, recognized)
	session, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "test-browser")
	require.NoError(t, err)
	token := &model.Token{Id: 1000001, UserId: user.Id, Key: "sentinel-full-user-api-key", Name: "owned", Status: 1, ExpiredTime: -1}
	require.NoError(t, db.Create(token).Error)
	router := gin.New()
	route := router.Group("/api/oauth2", middleware.UserAuth())
	route.POST("/actions", CreateOAuthAction)
	route.GET("/actions/:id/approval", GetOAuthActionApproval)
	route.POST("/actions/:id/approve", ApproveOAuthAction)
	route.POST("/actions/:id/reject", RejectOAuthAction)
	route.POST("/actions/:id/steps/:step", ExecuteOAuthActionStep)
	route.POST("/actions/:id/claim", ClaimOAuthActionResult)
	router.GET("/api/oauth2/actions/:id", GetOAuthAction)
	return router, principal, tokens.AccessToken, session.AccessToken, token
}
func oauthActionHTTPRequest(t *testing.T, router *gin.Engine, method, path, bearer string, body any, origin string, extraHeaders ...map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = common.Marshal(body)
		require.NoError(t, err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("Content-Type", "application/json")
	for _, headers := range extraHeaders {
		for name, value := range headers {
			request.Header.Set(name, value)
		}
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	var response map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response), recorder.Body.String())
	return recorder, response
}
func TestOAuthActionHTTPBindsBrowserIntentAndSharesExactlyOnce(t *testing.T) {
	router, _, access, browser, token := oauthActionHTTPFixture(t)
	r, response := oauthActionHTTPRequest(t, router, "POST", "/api/oauth2/actions", access, map[string]any{"operation": "apikey.reveal", "parameters": map[string]any{"id": token.Id}, "share_result": true, "return_uri": "https://rp.example.com/cb", "state": "callback-state"}, "")
	require.Equal(t, http.StatusCreated, r.Code, r.Body.String())
	data := response["data"].(map[string]any)
	id := data["action_id"].(string)
	receipt := data["receipt_token"].(string)
	base := "/api/oauth2/actions/" + id
	r, _ = oauthActionHTTPRequest(t, router, "GET", base+"/approval", access, nil, "")
	assert.Equal(t, http.StatusForbidden, r.Code, "a delegated bearer cannot become a browser session")
	r, _ = oauthActionHTTPRequest(t, router, "GET", base+"/approval", browser, nil, "https://evil.example")
	assert.Equal(t, http.StatusForbidden, r.Code)
	r, response = oauthActionHTTPRequest(t, router, "GET", base+"/approval", browser, nil, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	approval := response["data"].(map[string]any)
	nonce := approval["approval_nonce"].(string)
	assert.Equal(t, true, approval["share_result"])
	r, _ = oauthActionHTTPRequest(t, router, "POST", base+"/approve", browser, map[string]any{"approval_nonce": nonce}, "")
	assert.Equal(t, http.StatusForbidden, r.Code)
	r, _ = oauthActionHTTPRequest(t, router, "POST", base+"/approve", browser, map[string]any{"approval_nonce": nonce, "verification_password": "OriginalPass123"}, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	r, _ = oauthActionHTTPRequest(t, router, "POST", base+"/steps/execute", browser, map[string]any{"approval_nonce": nonce, "input": map[string]any{"id": 2}}, "")
	assert.Equal(t, http.StatusBadRequest, r.Code, "approved parameters cannot be replaced by browser input")
	r, response = oauthActionHTTPRequest(t, router, "POST", base+"/steps/execute", browser, map[string]any{"approval_nonce": nonce}, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	assert.Equal(t, "completed", response["action_status"])
	assert.Equal(t, token.Key, response["data"].(map[string]any)["key"])
	assert.Contains(t, response["return_uri"], "state=callback-state")
	r, _ = oauthActionHTTPRequest(t, router, "POST", base+"/steps/execute", browser, map[string]any{"approval_nonce": nonce}, "")
	assert.Equal(t, http.StatusConflict, r.Code)
	r, _ = oauthActionHTTPRequest(t, router, "GET", base, receipt, nil, "")
	assert.Equal(t, http.StatusOK, r.Code)
	assert.NotContains(t, r.Body.String(), token.Key)
	assert.NotContains(t, r.Body.String(), "access_token")
	r, response = oauthActionHTTPRequest(t, router, "POST", base+"/claim", access, map[string]any{"receipt_token": receipt}, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	assert.Equal(t, token.Key, response["data"].(map[string]any)["key"])
	r, _ = oauthActionHTTPRequest(t, router, "POST", base+"/claim", access, map[string]any{"receipt_token": receipt}, "")
	assert.Equal(t, http.StatusForbidden, r.Code)
}
func TestOAuthActionHTTPPasswordChangeKeepsCompletionReceiptAfterRevocation(t *testing.T) {
	router, principal, access, browser, _ := oauthActionHTTPFixture(t)
	action, receipt, err := service.CreateOAuthHostedAction(principal, "password.change", nil, false, "", "")
	require.NoError(t, err)
	base := "/api/oauth2/actions/" + action.ID
	r, response := oauthActionHTTPRequest(t, router, "GET", base+"/approval", browser, nil, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	nonce := response["data"].(map[string]any)["approval_nonce"].(string)
	r, _ = oauthActionHTTPRequest(t, router, "POST", base+"/approve", browser, map[string]any{"approval_nonce": nonce, "verification_password": "OriginalPass123"}, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	r, response = oauthActionHTTPRequest(t, router, "POST", base+"/steps/execute", browser, map[string]any{"approval_nonce": nonce, "input": map[string]any{"original_password": "OriginalPass123", "password": "ChangedPass456"}}, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	assert.Equal(t, "completed", response["action_status"])
	assert.NotEmpty(t, response["data"].(map[string]any)["access_token"], "rotation reaches only the original site's browser")
	_, recognized, err := service.AuthenticateOAuthAccessToken(access)
	assert.True(t, recognized)
	assert.Error(t, err, "password change invalidates old delegated authorization")
	r, _ = oauthActionHTTPRequest(t, router, "GET", base, receipt, nil, "")
	require.Equal(t, http.StatusOK, r.Code)
	assert.Contains(t, r.Body.String(), "completed")
	assert.NotContains(t, r.Body.String(), "access_token")
	assert.NotContains(t, r.Body.String(), "ChangedPass456")
	var persisted model.OAuthAction
	require.NoError(t, model.DB.First(&persisted, "id = ?", action.ID).Error)
	assert.Empty(t, persisted.ResultCiphertext)
	require.NoError(t, model.DB.Model(&model.OAuthAction{}).Where("id = ?", action.ID).Update("expires_at", time.Now().Add(-time.Second).Unix()).Error)
	r, _ = oauthActionHTTPRequest(t, router, "GET", base, receipt, nil, "")
	assert.Equal(t, http.StatusUnauthorized, r.Code)
}

func TestOAuthActionBindingRequiresSuccessOfItsOwnCallback(t *testing.T) {
	router, principal, _, browser, _ := oauthActionHTTPFixture(t)
	action, _, err := service.CreateOAuthHostedAction(principal, "identity.oauth_bind", map[string]any{"provider": "github"}, false, "", "")
	require.NoError(t, err)
	identity, err := service.ParseAccessToken(browser)
	require.NoError(t, err)
	nonce, err := service.BindOAuthActionSession(action, identity)
	require.NoError(t, err)
	require.NoError(t, service.ApproveOAuthHostedAction(action))
	flowToken, _, err := model.CreateAuthFlow(model.AuthFlowCreate{Purpose: model.AuthFlowPurposeOAuth, Provider: "github", Intent: model.AuthFlowIntentBind, UserId: principal.UserID, SessionId: identity.SessionID, ExpiresAt: time.Now().Add(time.Minute)})
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(action).Updates(map[string]any{"step_index": 1, "flow_hash": service.OAuthActionHash(flowToken), "binding_before_hash": service.OAuthActionHash("")}).Error)
	_, err = model.ConsumeAuthFlow(flowToken, model.AuthFlowMatch{Purpose: model.AuthFlowPurposeOAuth, Provider: "github", Intent: model.AuthFlowIntentBind, UserId: principal.UserID, SessionId: identity.SessionID})
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", principal.UserID).Update("github_id", "bound-provider-identity").Error)
	base := "/api/oauth2/actions/" + action.ID
	request := map[string]any{"approval_nonce": nonce, "input": map[string]any{"flow_token": flowToken}}
	r, _ := oauthActionHTTPRequest(t, router, "POST", base+"/steps/complete", browser, request, "")
	assert.Equal(t, http.StatusConflict, r.Code, "a consumed failed callback plus an unrelated binding is insufficient")
	require.NoError(t, service.RecordOAuthHostedBindingSuccess(flowToken, principal.UserID, identity.SessionID, "github", "bound-provider-identity"))
	r, response := oauthActionHTTPRequest(t, router, "POST", base+"/steps/complete", browser, request, "")
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	assert.Equal(t, "completed", response["action_status"])
}

func TestOAuthActionBootstrapOnlyAllowsFirstFactorFromFreshOAuthSession(t *testing.T) {
	_, principal, _, _, _ := oauthActionHTTPFixture(t)
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", principal.UserID).Update("password", "").Error)
	session, err := service.CreateLoginSession(principal.UserID, "oauth:github", "127.0.0.1", "bootstrap-browser")
	require.NoError(t, err)
	identity, err := service.ParseAccessToken(session.AccessToken)
	require.NoError(t, err)
	action := &model.OAuthAction{UserID: principal.UserID, AuthVersion: identity.UserAuthVersion, Operation: "mfa.setup"}
	assert.True(t, service.OAuthActionBootstrapAllowed(action, identity))
	for _, operation := range []string{"apikey.reveal", "account.delete", "credential.legacy_generate", "mfa.disable"} {
		action.Operation = operation
		assert.False(t, service.OAuthActionBootstrapAllowed(action, identity), operation)
	}
	action.Operation = "passkey.register"
	assert.True(t, service.OAuthActionBootstrapAllowed(action, identity))
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("created_at", time.Now().Add(-6*time.Minute).Unix()).Error)
	assert.False(t, service.OAuthActionBootstrapAllowed(action, identity), "refreshing an old session must not refresh authentication time")
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Updates(map[string]any{"created_at": time.Now().Unix(), "login_method": "unknown"}).Error)
	assert.False(t, service.OAuthActionBootstrapAllowed(action, identity), "unknown or password sessions never bootstrap external identity")
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("login_method", "oauth:github").Error)
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", principal.UserID).Update("password", "existing-password-hash").Error)
	assert.False(t, service.OAuthActionBootstrapAllowed(action, identity), "an existing password must still be verified")
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", principal.UserID).Update("password", "").Error)
	require.NoError(t, model.DB.Create(&model.TwoFA{UserId: principal.UserID, Secret: "sentinel", IsEnabled: true}).Error)
	assert.False(t, service.OAuthActionBootstrapAllowed(action, identity), "an existing MFA factor cannot be replaced by a fresh external session")
	require.NoError(t, model.DB.Where("user_id = ?", principal.UserID).Delete(&model.TwoFA{}).Error)
	require.NoError(t, model.DB.Create(&model.PasskeyCredential{UserID: principal.UserID}).Error)
	assert.False(t, service.OAuthActionBootstrapAllowed(action, identity), "an existing passkey cannot be replaced by a fresh external session")
}

func TestOAuthActionSharedCreationResultsNeverExportIndependentCredentials(t *testing.T) {
	for _, test := range []struct{ operation, field string }{{"app.create", "app"}, {"oauth_client.create", "client"}} {
		t.Run(test.operation, func(t *testing.T) {
			public := map[string]any{"id": float64(7), "name": "created object"}
			result, err := service.OAuthActionSharedResult(test.operation, map[string]any{test.field: public, "token": "must-stay-on-site", "client_secret": "must-also-stay-on-site", "access_token": "browser-only"})
			require.NoError(t, err)
			assert.Equal(t, map[string]any{test.field: public}, result)
		})
	}
	_, err := service.OAuthActionSharedResult("credential.legacy_generate", "global-pat")
	require.Error(t, err)
	_, err = service.OAuthActionSharedResult("mfa.backup_codes", map[string]any{"backup_codes": []string{"secret"}})
	require.Error(t, err)
}

func TestOAuthActionBindingCallbackRejectsRevokedAuthorizationBeforeEffect(t *testing.T) {
	_, principal, _, browser, _ := oauthActionHTTPFixture(t)
	identity, err := service.ParseAccessToken(browser)
	require.NoError(t, err)
	action, _, err := service.CreateOAuthHostedAction(principal, "identity.telegram_bind", nil, false, "", "")
	require.NoError(t, err)
	_, err = service.BindOAuthActionSession(action, identity)
	require.NoError(t, err)
	require.NoError(t, service.ApproveOAuthHostedAction(action))
	raw := "test-hosted-binding-flow"
	require.NoError(t, model.DB.Model(action).Updates(map[string]any{"step_index": 1, "flow_hash": service.OAuthActionHash(raw)}).Error)
	require.NoError(t, service.ValidateOAuthHostedBindingCallback(raw, principal.UserID, identity.SessionID))
	require.NoError(t, service.RevokeOAuthGrant(principal.UserID, principal.GrantID))
	require.Error(t, service.ValidateOAuthHostedBindingCallback(raw, principal.UserID, identity.SessionID))
	require.NoError(t, service.ValidateOAuthHostedBindingCallback("unrelated-native-flow", principal.UserID, identity.SessionID), "native account bindings retain their own existing session authorization")
}

func TestOAuthActionClampsUnderlyingBindingFlowExpiry(t *testing.T) {
	_, principal, _, browser, _ := oauthActionHTTPFixture(t)
	identity, err := service.ParseAccessToken(browser)
	require.NoError(t, err)
	action, _, err := service.CreateOAuthHostedAction(principal, "identity.telegram_bind", nil, false, "", "")
	require.NoError(t, err)
	_, err = service.BindOAuthActionSession(action, identity)
	require.NoError(t, err)
	require.NoError(t, service.ApproveOAuthHostedAction(action))
	flowToken, _, err := model.CreateAuthFlow(model.AuthFlowCreate{Purpose: model.AuthFlowPurposeTelegramBind, UserId: principal.UserID, SessionId: identity.SessionID, ExpiresAt: time.Now().Add(10 * time.Minute)})
	require.NoError(t, err)
	require.NoError(t, service.ClaimOAuthActionStep(action, 0))
	require.NoError(t, service.FinishOAuthActionStep(action, true, 2, nil, flowToken))
	flow, err := model.GetAuthFlow(flowToken, model.AuthFlowMatch{Purpose: model.AuthFlowPurposeTelegramBind})
	require.NoError(t, err)
	assert.Equal(t, action.ExpiresAt, flow.ExpiresAt.Unix(), "deleting an expired action cannot leave a usable native callback")
}

func TestOAuthActionChannelConfigurationRequiresRootScopeProofAndSharesOnlyConfiguration(t *testing.T) {
	router, ordinary, _, browser, _ := oauthActionHTTPFixture(t)
	_, _, err := service.CreateOAuthHostedAction(ordinary, "channel.config.reveal", map[string]any{"id": float64(1)}, true, "", "")
	require.Error(t, err)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}))
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", ordinary.UserID).Update("role", common.RoleRootUser).Error)
	user, err := model.GetUserById(ordinary.UserID, true)
	require.NoError(t, err)
	client, err := model.GetOauthClientByClientId(ordinary.ClientID)
	require.NoError(t, err)
	client.Scopes = "channel:secret_view"
	require.NoError(t, model.DB.Model(client).Update("scopes", client.Scopes).Error)
	tokens, err := service.IssueOAuthTokens(client, user, []string{"channel:secret_view"}, []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	principal, _, err := service.AuthenticateOAuthAccessToken(tokens.AccessToken)
	require.NoError(t, err)
	header := `{"Authorization":"Bearer config-only-sentinel"}`
	baseURL := "https://user:password@upstream.example/v1"
	channel := &model.Channel{Key: "separate-key-must-not-leak", Name: "configuration fixture", Models: "gpt-test", Group: "default", HeaderOverride: &header, BaseURL: &baseURL, OtherInfo: `{"provider_secret":"other-secret"}`}
	require.NoError(t, model.DB.Create(channel).Error)
	action, receipt, err := service.CreateOAuthHostedAction(principal, "channel.config.reveal", map[string]any{"id": float64(channel.Id)}, true, "", "")
	require.NoError(t, err)
	identity, err := service.ParseAccessToken(browser)
	require.NoError(t, err)
	nonce, err := service.BindOAuthActionSession(action, identity)
	require.NoError(t, err)
	require.NoError(t, service.ApproveOAuthHostedAction(action))
	path := "/api/oauth2/actions/" + action.ID + "/steps/execute"
	request := map[string]any{"approval_nonce": nonce}
	response, _ := oauthActionHTTPRequest(t, router, http.MethodPost, path, browser, request, "")
	assert.Equal(t, http.StatusForbidden, response.Code, "configuration reveal must enforce the existing channel key verification scope")
	proof, _, err := service.IssueSecurityProof(identity, "passkey", []string{"channel.key.read"})
	require.NoError(t, err)
	response, result := oauthActionHTTPRequest(t, router, http.MethodPost, path, browser, request, "", map[string]string{"X-Security-Proof": proof})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, "completed", result["action_status"])
	action, err = service.GetOAuthHostedAction(action.ID)
	require.NoError(t, err)
	shared, err := service.ClaimOAuthActionResult(action, principal, receipt)
	require.NoError(t, err)
	config := shared.(map[string]any)
	assert.Equal(t, header, config["header_override"])
	assert.Equal(t, baseURL, config["base_url"])
	assert.Equal(t, channel.OtherInfo, config["other_info"])
	assert.NotContains(t, config, "key")
	sanitized, err := service.OAuthActionSharedResult("channel.config.reveal", map[string]any{"id": float64(1), "header_override": header, "key": "unexpected-key", "access_token": "unexpected-token", "unexpected": "unapproved-response-field"})
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"id": float64(1), "header_override": header}, sanitized)
}
