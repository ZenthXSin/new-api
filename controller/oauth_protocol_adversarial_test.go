package controller

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const oauthProtocolVerifier = "protocol-verifier-0123456789abcdef0123456789abcdef"
const oauthProtocolCallback = "https://rp.example.com/cb"

func issueOAuthProtocolCode(t *testing.T, userID int, client *model.OauthClient, scope string) string {
	t.Helper()
	recorder := approveOidcTestConsent(t, userID, oidcConsentRequest{
		ClientId: client.ClientId, RedirectUri: oauthProtocolCallback, Scope: scope,
		State: "test-transaction-state", Nonce: "test-transaction-nonce",
		CodeChallenge: oidcS256Challenge(oauthProtocolVerifier), CodeChallengeMethod: "S256", Approve: true,
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var response struct {
		Success  bool   `json:"success"`
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success, recorder.Body.String())
	redirect, err := url.Parse(response.Redirect)
	require.NoError(t, err)
	require.Equal(t, oauthProtocolCallback, redirect.Scheme+"://"+redirect.Host+redirect.Path)
	require.Equal(t, "test-transaction-state", redirect.Query().Get("state"))
	code := redirect.Query().Get("code")
	require.NotEmpty(t, code)
	return code
}

func oauthProtocolTokenForm(client *model.OauthClient, code string) url.Values {
	return url.Values{
		"grant_type": {"authorization_code"}, "client_id": {client.ClientId}, "code": {code},
		"redirect_uri": {oauthProtocolCallback}, "code_verifier": {oauthProtocolVerifier},
	}
}

func performOAuthProtocolTokenRequest(t *testing.T, target, contentType, body string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	ctx.Request.Header = headers.Clone()
	if ctx.Request.Header == nil {
		ctx.Request.Header = make(http.Header)
	}
	ctx.Request.Header.Set("Content-Type", contentType)
	OidcToken(ctx)
	return recorder
}

func oauthProtocolTokenResponse(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var response map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.NotEmpty(t, response["access_token"])
	assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	return response
}

func TestOAuthProtocolRejectsAmbiguousTokenRequests(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.Model(user).Update("role", common.RoleCommonUser).Error)
	client, secret := createOidcTestClient(t, false)
	validBasic := "Basic " + basicAuth(client.ClientId, secret)
	cases := []struct {
		name   string
		mutate func(url.Values) (string, string, string, http.Header)
	}{
		{"duplicate_code", func(form url.Values) (string, string, string, http.Header) {
			form.Add("code", "another-code")
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), nil
		}},
		{"duplicate_grant_type", func(form url.Values) (string, string, string, http.Header) {
			form.Add("grant_type", "refresh_token")
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), nil
		}},
		{"duplicate_unknown_parameter", func(form url.Values) (string, string, string, http.Header) {
			form["extension"] = []string{"first", "second"}
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), nil
		}},
		{"basic_and_body_credentials", func(form url.Values) (string, string, string, http.Header) {
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), http.Header{"Authorization": {validBasic}}
		}},
		{"malformed_basic_no_body_fallback", func(form url.Values) (string, string, string, http.Header) {
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), http.Header{"Authorization": {"Basic !!!"}}
		}},
		{"non_basic_no_body_fallback", func(form url.Values) (string, string, string, http.Header) {
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), http.Header{"Authorization": {"Bearer unrelated-token"}}
		}},
		{"duplicate_authorization_headers", func(form url.Values) (string, string, string, http.Header) {
			form.Del("client_id")
			form.Del("client_secret")
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), http.Header{"Authorization": {validBasic, "Basic !!!"}}
		}},
		{"invalid_percent_basic_username", func(form url.Values) (string, string, string, http.Header) {
			form.Del("client_id")
			form.Del("client_secret")
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), http.Header{"Authorization": {"Basic " + basicAuth("%ZZ", secret)}}
		}},
		{"query_parameter_injection", func(form url.Values) (string, string, string, http.Header) {
			return oidcTestIssuer + "/token?client_id=attacker", "application/x-www-form-urlencoded", form.Encode(), nil
		}},
		{"json_body", func(form url.Values) (string, string, string, http.Header) {
			payload := make(map[string]string)
			for key := range form {
				payload[key] = form.Get(key)
			}
			encoded, err := common.Marshal(payload)
			require.NoError(t, err)
			return oidcTestIssuer + "/token", "application/json", string(encoded), nil
		}},
		{"unsupported_form_content_type", func(form url.Values) (string, string, string, http.Header) {
			return oidcTestIssuer + "/token", "text/plain", form.Encode(), nil
		}},
		{"oversized_form_body", func(form url.Values) (string, string, string, http.Header) {
			form.Set("extension", strings.Repeat("x", 65537))
			return oidcTestIssuer + "/token", "application/x-www-form-urlencoded", form.Encode(), nil
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			code := issueOAuthProtocolCode(t, user.Id, client, "openid")
			form := oauthProtocolTokenForm(client, code)
			form.Set("client_secret", secret)
			target, contentType, body, headers := test.mutate(form)
			rejected := performOAuthProtocolTokenRequest(t, target, contentType, body, headers)
			assert.GreaterOrEqual(t, rejected.Code, 400, rejected.Body.String())
			assert.NotContains(t, rejected.Body.String(), `"access_token"`)
			// An ambiguous request must not consume the legitimate client's code.
			valid := oauthProtocolTokenForm(client, code)
			valid.Set("client_secret", secret)
			oauthProtocolTokenResponse(t, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", valid.Encode(), nil))
		})
	}
}

func TestOAuthProtocolPKCEReplayRevokesOnlyAfterValidProof(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.Model(user).Update("role", common.RoleCommonUser).Error)
	client, _ := createOidcTestClient(t, true)
	code := issueOAuthProtocolCode(t, user.Id, client, "openid profile")
	form := oauthProtocolTokenForm(client, code)
	form.Set("code_verifier", strings.Repeat("z", 43))
	wrong := performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil)
	require.Equal(t, http.StatusBadRequest, wrong.Code)
	assert.Contains(t, wrong.Body.String(), `"invalid_grant"`)
	form.Set("code_verifier", oauthProtocolVerifier)
	response := oauthProtocolTokenResponse(t, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil))
	accessToken, ok := response["access_token"].(string)
	require.True(t, ok)
	userinfoHeaders := map[string]string{"Authorization": "Bearer " + accessToken}
	require.Equal(t, http.StatusOK, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, userinfoHeaders).Code)
	// A code observer without the verifier cannot revoke a completed grant.
	form.Set("code_verifier", strings.Repeat("z", 43))
	require.Equal(t, http.StatusBadRequest, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil).Code)
	require.Equal(t, http.StatusOK, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, userinfoHeaders).Code)
	// A second valid redemption revokes the token family issued by the code.
	form.Set("code_verifier", oauthProtocolVerifier)
	require.Equal(t, http.StatusBadRequest, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil).Code)
	require.Equal(t, http.StatusUnauthorized, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, userinfoHeaders).Code)
}

func TestOAuthProtocolCodeBoundToClientAndExactRedirect(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.Model(user).Update("role", common.RoleCommonUser).Error)
	client, _ := createOidcTestClient(t, true)
	other := *client
	other.Id, other.ClientId = 0, "other-protocol-client"
	require.NoError(t, model.CreateOauthClient(&other))
	for _, target := range []string{"other_client", "callback_query", "callback_trailing_slash", "callback_host_case"} {
		t.Run(target, func(t *testing.T) {
			code := issueOAuthProtocolCode(t, user.Id, client, "openid")
			form := oauthProtocolTokenForm(client, code)
			switch target {
			case "other_client":
				form.Set("client_id", other.ClientId)
			case "callback_query":
				form.Set("redirect_uri", oauthProtocolCallback+"?extra=1")
			case "callback_trailing_slash":
				form.Set("redirect_uri", oauthProtocolCallback+"/")
			case "callback_host_case":
				form.Set("redirect_uri", "https://RP.example.com/cb")
			}
			rejected := performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil)
			require.Equal(t, http.StatusBadRequest, rejected.Code, rejected.Body.String())
			valid := oauthProtocolTokenForm(client, code)
			oauthProtocolTokenResponse(t, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", valid.Encode(), nil))
		})
	}
}

func TestOAuthProtocolRechecksStateBeforeIssuingTokens(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*gorm.DB, *model.User, *model.OauthClient) error
	}{
		{"client_disabled", func(db *gorm.DB, _ *model.User, client *model.OauthClient) error {
			return db.Model(client).Update("enabled", false).Error
		}},
		{"client_scope_removed", func(db *gorm.DB, _ *model.User, client *model.OauthClient) error {
			return db.Model(client).Update("scopes", "openid").Error
		}},
		{"client_redirect_removed", func(db *gorm.DB, _ *model.User, client *model.OauthClient) error {
			return db.Model(client).Update("redirect_uris", `["https://rp.example.com/replaced"]`).Error
		}},
		{"client_type_changed", func(db *gorm.DB, _ *model.User, client *model.OauthClient) error {
			return db.Model(client).Update("is_public", false).Error
		}},
		{"user_disabled", func(db *gorm.DB, user *model.User, _ *model.OauthClient) error {
			return db.Model(user).Update("status", common.UserStatusDisabled).Error
		}},
		{"user_authentication_changed", func(db *gorm.DB, user *model.User, _ *model.OauthClient) error {
			return db.Model(user).Update("auth_version", gorm.Expr("auth_version + 1")).Error
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			db, user := setupOidcProviderTest(t)
			require.NoError(t, db.Model(user).Update("role", common.RoleCommonUser).Error)
			client, _ := createOidcTestClient(t, true)
			code := issueOAuthProtocolCode(t, user.Id, client, "openid profile")
			require.NoError(t, test.mutate(db, user, client))
			form := oauthProtocolTokenForm(client, code)
			recorder := performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil)
			assert.GreaterOrEqual(t, recorder.Code, 400, recorder.Body.String())
			assert.NotContains(t, recorder.Body.String(), `"access_token"`)
		})
	}
}

func TestOAuthProtocolAuthorizeRejectsPKCEDowngradeAndAmbiguousScopes(t *testing.T) {
	setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, false)
	cases := []struct {
		name   string
		mutate func(url.Values)
	}{
		{"missing_challenge_on_confidential_client", func(query url.Values) { query.Del("code_challenge") }},
		{"missing_challenge_method", func(query url.Values) { query.Del("code_challenge_method") }},
		{"plain_downgrade", func(query url.Values) { query.Set("code_challenge_method", "plain") }},
		{"malformed_s256", func(query url.Values) { query.Set("code_challenge", strings.Repeat("%", 43)) }},
		{"duplicate_scope", func(query url.Values) { query.Add("scope", "email") }},
		{"unknown_resource", func(query url.Values) { query.Set("resource", "https://attacker.example/resource") }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			query := url.Values{
				"response_type": {"code"}, "client_id": {client.ClientId}, "redirect_uri": {oauthProtocolCallback},
				"scope": {"openid"}, "code_challenge": {oidcS256Challenge(oauthProtocolVerifier)}, "code_challenge_method": {"S256"},
			}
			test.mutate(query)
			recorder := performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/authorize?"+query.Encode(), nil, nil)
			redirect := followOidcRedirect(t, recorder)
			assert.Empty(t, redirect.Host, "invalid requests stay on the authorization server")
			assert.NotEmpty(t, redirect.Query().Get("error"))
			assert.Empty(t, redirect.Query().Get("code"))
		})
	}
}

func TestOAuthProtocolUserInfoSeparatesTokensAndTransport(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.Model(user).Update("role", common.RoleCommonUser).Error)
	client, _ := createOidcTestClient(t, true)
	code := issueOAuthProtocolCode(t, user.Id, client, "openid profile")
	form := oauthProtocolTokenForm(client, code)
	response := oauthProtocolTokenResponse(t, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil))
	accessToken, ok := response["access_token"].(string)
	require.True(t, ok)
	idToken, ok := response["id_token"].(string)
	require.True(t, ok)
	require.NotEmpty(t, idToken)
	assert.Equal(t, http.StatusOK, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{"Authorization": "bearer " + accessToken}).Code)
	assert.Equal(t, http.StatusUnauthorized, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{"Authorization": "Bearer " + idToken}).Code)
	assert.Equal(t, http.StatusUnauthorized, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo?access_token="+url.QueryEscape(accessToken), nil, nil).Code)
	body := url.Values{"access_token": {accessToken}}
	assert.Equal(t, http.StatusOK, performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/userinfo", &body, nil).Code)
	assert.Equal(t, http.StatusUnauthorized, performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/userinfo", &body, map[string]string{"Authorization": "Bearer " + accessToken}).Code)
	body.Add("access_token", "another-token")
	assert.Equal(t, http.StatusUnauthorized, performOidcRequest(t, http.MethodPost, oidcTestIssuer+"/userinfo", &body, nil).Code)
}

func TestOAuthProtocolUserInfoEnforcesResourceAudience(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.Model(user).Update("role", common.RoleCommonUser).Error)
	client, _ := createOidcTestClient(t, true)
	recorder := approveOidcTestConsent(t, user.Id, oidcConsentRequest{
		ClientId: client.ClientId, RedirectUri: oauthProtocolCallback, Scope: "openid profile",
		CodeChallenge: oidcS256Challenge(oauthProtocolVerifier), CodeChallengeMethod: "S256", Approve: true,
		Resources: []string{model.OAuthResourceRelay},
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var approval struct {
		Success  bool   `json:"success"`
		Redirect string `json:"redirect"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &approval))
	require.True(t, approval.Success, recorder.Body.String())
	redirect, err := url.Parse(approval.Redirect)
	require.NoError(t, err)
	form := oauthProtocolTokenForm(client, redirect.Query().Get("code"))
	response := oauthProtocolTokenResponse(t, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil))
	accessToken, ok := response["access_token"].(string)
	require.True(t, ok)
	assert.Equal(t, http.StatusForbidden, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{"Authorization": "Bearer " + accessToken}).Code,
		"a token explicitly restricted to the relay resource must not reveal dashboard identity claims")
}

func TestOAuthProtocolRevocationCannotCrossClient(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.Model(user).Update("role", common.RoleCommonUser).Error)
	client, _ := createOidcTestClient(t, true)
	other := *client
	other.Id, other.ClientId = 0, "other-revocation-client"
	require.NoError(t, model.CreateOauthClient(&other))
	code := issueOAuthProtocolCode(t, user.Id, client, "openid")
	form := oauthProtocolTokenForm(client, code)
	response := oauthProtocolTokenResponse(t, performOAuthProtocolTokenRequest(t, oidcTestIssuer+"/token", "application/x-www-form-urlencoded", form.Encode(), nil))
	accessToken, ok := response["access_token"].(string)
	require.True(t, ok)
	for _, test := range []struct {
		name       string
		clientID   string
		wantStatus int
	}{
		{"other_client", other.ClientId, http.StatusOK},
		{"missing_client", "", http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := url.Values{"client_id": {test.clientID}, "token": {accessToken}}
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, oidcTestIssuer+"/revoke", strings.NewReader(body.Encode()))
			ctx.Request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			OidcRevoke(ctx)
			assert.Equal(t, test.wantStatus, recorder.Code, recorder.Body.String())
			assert.NotContains(t, recorder.Body.String(), accessToken)
			assert.Equal(t, http.StatusOK, performOidcRequest(t, http.MethodGet, oidcTestIssuer+"/userinfo", nil, map[string]string{"Authorization": "Bearer " + accessToken}).Code,
				"revocation requires the token's own OAuth client identity")
		})
	}
}
