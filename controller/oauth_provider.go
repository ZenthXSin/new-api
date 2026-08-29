package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/gin-gonic/gin"
)

const oidcAuthorizeFrontendPath = "/authorize"

// buildOidcRedirectURL appends OAuth parameters to the registered redirect URI.
func buildOidcRedirectURL(redirectUri string, params map[string]string) string {
	parsed, err := url.Parse(redirectUri)
	if err != nil {
		return redirectUri
	}
	query := parsed.Query()
	for key, value := range params {
		if value == "" {
			continue
		}
		query.Set(key, value)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// oidcAuthorizeErrorParams builds the parameters for an error redirect.
func oidcAuthorizeErrorParams(code string, description string, state string) map[string]string {
	return map[string]string{
		"error":             code,
		"error_description": description,
		"state":             state,
	}
}

// GetOidcDiscovery serves the OIDC discovery document.
func GetOidcDiscovery(c *gin.Context) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled || settings.GetIssuer() == "" {
		common.ApiError(c, service.ErrOidcProviderDisabled)
		return
	}
	// Make sure clients fetching JWKS right after setup see a published key.
	if _, _, err := model.GetOrCreateOauthSigningKey(); err != nil {
		common.SysError(fmt.Sprintf("failed to ensure oidc signing key: %v", err))
	}
	c.JSON(http.StatusOK, service.BuildOidcDiscovery())
}

// GetOidcJWKS serves the public signing keys.
func GetOidcJWKS(c *gin.Context) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled {
		common.ApiError(c, service.ErrOidcProviderDisabled)
		return
	}
	if _, _, err := model.GetOrCreateOauthSigningKey(); err != nil {
		common.ApiError(c, err)
		return
	}
	keys, err := model.GetOauthJWKS()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"keys": keys})
}

// OidcAuthorize validates the authorization request and forwards the browser
// to the SPA consent page, which completes login/consent via the API.
func OidcAuthorize(c *gin.Context) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled || settings.GetIssuer() == "" {
		redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("server_error", "OIDC provider is disabled", ""))
		return
	}
	if c.Query("response_type") != "code" {
		redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("unsupported_response_type", "response_type must be code", c.Query("state")))
		return
	}
	client, err := model.GetOauthClientByClientId(c.Query("client_id"))
	if err != nil || !client.Enabled {
		redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("invalid_client", "unknown or disabled client", ""))
		return
	}
	redirectUri := strings.TrimSpace(c.Query("redirect_uri"))
	if !client.HasRedirectURI(redirectUri) {
		// Never redirect to an unregistered URI; surface the error on our own page.
		redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("invalid_request", "redirect_uri is not registered", ""))
		return
	}
	state := c.Query("state")
	scopes, err := service.NormalizeOidcScopes(c.Query("scope"), client)
	if err != nil {
		redirectToOidcConsentPage(c, client, oidcAuthorizeErrorParams("invalid_scope", err.Error(), state))
		return
	}
	codeChallenge := strings.TrimSpace(c.Query("code_challenge"))
	codeChallengeMethod := strings.TrimSpace(c.Query("code_challenge_method"))
	if client.IsPublic && codeChallenge == "" {
		redirectToOidcConsentPage(c, client, oidcAuthorizeErrorParams("invalid_request", "PKCE code_challenge is required for public clients", state))
		return
	}
	if codeChallenge != "" && codeChallengeMethod != "" && codeChallengeMethod != "S256" {
		redirectToOidcConsentPage(c, client, oidcAuthorizeErrorParams("invalid_request", "only S256 code_challenge_method is supported", state))
		return
	}
	if codeChallenge != "" && codeChallengeMethod == "" {
		codeChallengeMethod = "S256"
	}

	query := url.Values{}
	query.Set("client_id", client.ClientId)
	query.Set("redirect_uri", redirectUri)
	query.Set("scope", strings.Join(scopes, " "))
	if state != "" {
		query.Set("state", state)
	}
	if nonce := c.Query("nonce"); nonce != "" {
		query.Set("nonce", nonce)
	}
	if codeChallenge != "" {
		query.Set("code_challenge", codeChallenge)
		query.Set("code_challenge_method", codeChallengeMethod)
	}
	c.Redirect(http.StatusFound, oidcAuthorizeFrontendPath+"?"+query.Encode())
}

func redirectToOidcConsentPage(c *gin.Context, client *model.OauthClient, params map[string]string) {
	target := oidcAuthorizeFrontendPath
	values := url.Values{}
	for key, value := range params {
		if value != "" {
			values.Set(key, value)
		}
	}
	if client != nil {
		values.Set("client_id", client.ClientId)
	}
	if encoded := values.Encode(); encoded != "" {
		target += "?" + encoded
	}
	c.Redirect(http.StatusFound, target)
}

type oidcConsentRequest struct {
	ClientId            string `json:"client_id"`
	RedirectUri         string `json:"redirect_uri"`
	Scope               string `json:"scope"`
	State               string `json:"state"`
	Nonce               string `json:"nonce"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
	Approve             bool   `json:"approve"`
}

func parseOidcConsentParams(c *gin.Context) (*oidcConsentRequest, error) {
	request := &oidcConsentRequest{}
	if c.Request.Method == http.MethodPost {
		if err := common.DecodeJson(c.Request.Body, request); err != nil {
			return nil, err
		}
	} else {
		request.ClientId = c.Query("client_id")
		request.RedirectUri = c.Query("redirect_uri")
		request.Scope = c.Query("scope")
		request.State = c.Query("state")
		request.Nonce = c.Query("nonce")
		request.CodeChallenge = c.Query("code_challenge")
		request.CodeChallengeMethod = c.Query("code_challenge_method")
	}
	return request, nil
}

// validateOidcConsentRequest checks the request against the client record and
// returns the normalized scopes plus the client.
func validateOidcConsentRequest(request *oidcConsentRequest) (*model.OauthClient, []string, error) {
	if request == nil || strings.TrimSpace(request.ClientId) == "" {
		return nil, nil, service.ErrOidcRequestInvalid
	}
	client, err := model.GetOauthClientByClientId(request.ClientId)
	if err != nil || !client.Enabled {
		return nil, nil, model.ErrOauthClientNotFound
	}
	redirectUri := strings.TrimSpace(request.RedirectUri)
	if !client.HasRedirectURI(redirectUri) {
		return nil, nil, model.ErrOauthRedirectUnknown
	}
	scopes, err := service.NormalizeOidcScopes(request.Scope, client)
	if err != nil {
		return nil, nil, err
	}
	if client.IsPublic && strings.TrimSpace(request.CodeChallenge) == "" {
		return nil, nil, service.ErrOidcRequestInvalid
	}
	return client, scopes, nil
}

// GetOidcConsent returns the consent state for a logged-in user.
func GetOidcConsent(c *gin.Context) {
	request, err := parseOidcConsentParams(c)
	if err != nil {
		common.ApiError(c, service.ErrOidcRequestInvalid)
		return
	}
	client, scopes, err := validateOidcConsentRequest(request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	userId := c.GetInt("id")
	consent, err := model.GetOauthConsent(userId, client.Id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if consent != nil && consent.CoversScopes(scopes) {
		redirect, err := approveOidcConsent(c, client, userId, scopes, request)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"success":         true,
			"require_consent": false,
			"redirect":        redirect,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success":         true,
		"require_consent": true,
		"client": gin.H{
			"name":        client.Name,
			"description": client.Description,
		},
		"scopes": scopes,
	})
}

// PostOidcConsent records the user's decision and returns the redirect target.
func PostOidcConsent(c *gin.Context) {
	request, err := parseOidcConsentParams(c)
	if err != nil {
		common.ApiError(c, service.ErrOidcRequestInvalid)
		return
	}
	client, scopes, err := validateOidcConsentRequest(request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	userId := c.GetInt("id")
	if !request.Approve {
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"redirect": buildOidcRedirectURL(request.RedirectUri,
				oidcAuthorizeErrorParams(service.OidcErrorAccessDenied, "the user denied the authorization request", request.State)),
		})
		return
	}
	if err := model.SaveOauthConsent(userId, client.Id, scopes); err != nil {
		common.ApiError(c, err)
		return
	}
	redirect, err := approveOidcConsent(c, client, userId, scopes, request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success":  true,
		"redirect": redirect,
	})
}

func approveOidcConsent(c *gin.Context, client *model.OauthClient, userId int, scopes []string, request *oidcConsentRequest) (string, error) {
	code, err := service.CreateOidcAuthorizationCode(service.OidcAuthorizeInput{
		Client:              client,
		UserId:              userId,
		Scopes:              scopes,
		RedirectUri:         request.RedirectUri,
		State:               request.State,
		Nonce:               request.Nonce,
		CodeChallenge:       request.CodeChallenge,
		CodeChallengeMethod: request.CodeChallengeMethod,
	})
	if err != nil {
		return "", err
	}
	model.TouchOauthClientUsageById(client.Id)
	return buildOidcRedirectURL(request.RedirectUri, map[string]string{
		"code":  code,
		"state": request.State,
	}), nil
}

// oidcTokenError writes an RFC 6749 error response.
func oidcTokenError(c *gin.Context, errorCode string, description string) {
	c.JSON(http.StatusBadRequest, gin.H{
		"error":             errorCode,
		"error_description": description,
	})
}

// OidcToken implements the authorization_code grant.
func OidcToken(c *gin.Context) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled {
		oidcTokenError(c, "server_error", "OIDC provider is disabled")
		return
	}
	params, err := parseOidcTokenRequest(c)
	if err != nil {
		oidcTokenError(c, "invalid_request", err.Error())
		return
	}
	if params.GrantType != "authorization_code" {
		oidcTokenError(c, "unsupported_grant_type", "only authorization_code is supported")
		return
	}
	client, err := model.GetOauthClientByClientId(params.ClientId)
	if err != nil || !client.Enabled {
		oidcTokenError(c, "invalid_client", "unknown or disabled client")
		return
	}
	if !client.IsPublic {
		if !client.CheckSecret(params.ClientSecret) {
			oidcTokenError(c, "invalid_client", "client authentication failed")
			return
		}
	} else if strings.TrimSpace(params.ClientSecret) != "" {
		oidcTokenError(c, "invalid_client", "public clients must not send a secret")
		return
	}
	if strings.TrimSpace(params.Code) == "" || strings.TrimSpace(params.RedirectUri) == "" {
		oidcTokenError(c, "invalid_request", "code and redirect_uri are required")
		return
	}
	payload, userId, err := service.ConsumeOidcAuthorizationCode(params.Code, client, strings.TrimSpace(params.RedirectUri))
	if err != nil {
		if errors.Is(err, model.ErrAuthFlowConsumed) {
			oidcTokenError(c, "invalid_grant", "authorization code was already used")
			return
		}
		oidcTokenError(c, "invalid_grant", "authorization code is invalid or expired")
		return
	}
	if err := service.ValidateOidcPKCE(payload.CodeChallenge, payload.CodeChallengeMethod, params.CodeVerifier); err != nil {
		oidcTokenError(c, "invalid_grant", err.Error())
		return
	}
	user, err := model.GetUserById(userId, false)
	if err != nil || user.Status != common.UserStatusEnabled {
		oidcTokenError(c, "invalid_grant", "user is not active")
		return
	}
	scopes := strings.Fields(payload.Scope)
	accessToken, idToken, expiresIn, err := service.IssueOidcTokens(client, user, scopes, payload.Nonce)
	if err != nil {
		oidcTokenError(c, "server_error", err.Error())
		return
	}
	model.TouchOauthClientUsageById(client.Id)
	response := gin.H{
		"access_token": accessToken,
		"token_type":   "Bearer",
		"expires_in":   expiresIn,
		"scope":        payload.Scope,
	}
	if idToken != "" {
		response["id_token"] = idToken
	}
	c.JSON(http.StatusOK, response)
}

type oidcTokenParams struct {
	GrantType    string
	ClientId     string
	ClientSecret string
	Code         string
	RedirectUri  string
	CodeVerifier string
}

// parseOidcTokenRequest reads form-encoded (RFC 6749) or JSON token requests
// and applies HTTP Basic client authentication when present.
func parseOidcTokenRequest(c *gin.Context) (*oidcTokenParams, error) {
	params := &oidcTokenParams{}
	contentType := c.ContentType()
	if strings.HasPrefix(contentType, "application/json") {
		var body map[string]string
		if err := common.DecodeJson(c.Request.Body, &body); err != nil {
			return nil, errors.New("malformed JSON body")
		}
		params.GrantType = body["grant_type"]
		params.ClientId = body["client_id"]
		params.ClientSecret = body["client_secret"]
		params.Code = body["code"]
		params.RedirectUri = body["redirect_uri"]
		params.CodeVerifier = body["code_verifier"]
	} else {
		if err := c.Request.ParseForm(); err != nil {
			return nil, errors.New("malformed form body")
		}
		params.GrantType = c.Request.PostFormValue("grant_type")
		params.ClientId = c.Request.PostFormValue("client_id")
		params.ClientSecret = c.Request.PostFormValue("client_secret")
		params.Code = c.Request.PostFormValue("code")
		params.RedirectUri = c.Request.PostFormValue("redirect_uri")
		params.CodeVerifier = c.Request.PostFormValue("code_verifier")
	}
	if clientId, clientSecret, ok := c.Request.BasicAuth(); ok {
		if parsedId, err := url.QueryUnescape(clientId); err == nil {
			params.ClientId = parsedId
		}
		if parsedSecret, err := url.QueryUnescape(clientSecret); err == nil {
			params.ClientSecret = parsedSecret
		}
	}
	return params, nil
}

// OidcUserInfo returns claims for a granted access token.
func OidcUserInfo(c *gin.Context) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled {
		oidcUserInfoError(c, http.StatusServiceUnavailable, "OIDC provider is disabled")
		return
	}
	raw := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
	if raw == "" {
		raw = strings.TrimSpace(c.Request.PostFormValue("access_token"))
	}
	if raw == "" {
		oidcUserInfoError(c, http.StatusUnauthorized, "missing access token")
		return
	}
	userId, scopes, err := service.ParseOidcAccessToken(raw)
	if err != nil {
		oidcUserInfoError(c, http.StatusUnauthorized, "invalid access token")
		return
	}
	user, err := model.GetUserById(userId, false)
	if err != nil || user.Status != common.UserStatusEnabled {
		oidcUserInfoError(c, http.StatusUnauthorized, "user is not active")
		return
	}
	c.JSON(http.StatusOK, service.BuildOidcUserInfo(user, scopes))
}

func oidcUserInfoError(c *gin.Context, status int, message string) {
	c.Header("WWW-Authenticate", fmt.Sprintf("Bearer error=\"invalid_token\", error_description=\"%s\"", message))
	c.JSON(status, gin.H{
		"error":             "invalid_token",
		"error_description": message,
	})
}

// OidcRevoke accepts revocation requests (RFC 7009). Access tokens are
// stateless and short-lived, so revocation is acknowledged without a
// server-side registry; clients should discard the token.
func OidcRevoke(c *gin.Context) {
	c.Status(http.StatusOK)
}
