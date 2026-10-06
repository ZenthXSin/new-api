package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/gin-gonic/gin"
)

const oidcAuthorizeFrontendPath = "/authorize"

var errOidcClientAuthentication = errors.New("client authentication failed")

func oidcNoStore(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
}

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
	oidcNoStore(c)
	queryParameters, err := url.ParseQuery(c.Request.URL.RawQuery)
	if err != nil {
		redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("invalid_request", "malformed authorization query", ""))
		return
	}
	for key, values := range queryParameters {
		if key != "resource" && len(values) != 1 {
			redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("invalid_request", "duplicate authorization parameter", ""))
			return
		}
	}
	if c.Query("prompt") == "none" {
		redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("interaction_required", "explicit user consent is required", ""))
		return
	}
	resources, err := service.OAuthNormalizeResources(c.Request.URL.Query()["resource"])
	if err != nil {
		redirectToOidcConsentPage(c, nil, oidcAuthorizeErrorParams("invalid_target", "unknown resource", ""))
		return
	}
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
	if err := service.ValidateOidcPKCEChallenge(codeChallenge, codeChallengeMethod); err != nil {
		redirectToOidcConsentPage(c, client, oidcAuthorizeErrorParams("invalid_request", "a valid S256 PKCE challenge is required", state))
		return
	}

	query := url.Values{}
	query.Set("client_id", client.ClientId)
	query.Set("redirect_uri", redirectUri)
	query.Set("scope", strings.Join(scopes, " "))
	for _, resource := range resources {
		query.Add("resource", resource)
	}
	if state != "" {
		query.Set("state", state)
	}
	if nonce := c.Query("nonce"); nonce != "" {
		query.Set("nonce", nonce)
	}
	if prompt := c.Query("prompt"); prompt != "" {
		if prompt != "consent" {
			redirectToOidcConsentPage(c, client, oidcAuthorizeErrorParams("invalid_request", "unsupported prompt value", state))
			return
		}
		query.Set("prompt", prompt)
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
	ClientId            string   `json:"client_id"`
	RedirectUri         string   `json:"redirect_uri"`
	Scope               string   `json:"scope"`
	State               string   `json:"state"`
	Nonce               string   `json:"nonce"`
	CodeChallenge       string   `json:"code_challenge"`
	CodeChallengeMethod string   `json:"code_challenge_method"`
	Approve             bool     `json:"approve"`
	SelectedScopes      []string `json:"selected_scopes"`
	Resources           []string `json:"resources"`
	ConsentToken        string   `json:"consent_token"`
	Prompt              string   `json:"prompt"`
}

type oidcConsentSnapshot struct {
	ClientID            string
	ClientName          string
	ClientDescription   string
	RedirectURI         string
	Scopes              []string
	State               string
	Nonce               string
	CodeChallenge       string
	CodeChallengeMethod string
	Resources           []string
	Prompt              string
}

func (request *oidcConsentRequest) snapshot(client *model.OauthClient, scopes []string) oidcConsentSnapshot {
	return oidcConsentSnapshot{
		ClientID: request.ClientId, ClientName: client.Name, ClientDescription: client.Description,
		RedirectURI: request.RedirectUri, Scopes: scopes,
		State: request.State, Nonce: request.Nonce, CodeChallenge: request.CodeChallenge,
		CodeChallengeMethod: request.CodeChallengeMethod, Resources: request.Resources, Prompt: request.Prompt,
	}
}

func parseOidcConsentParams(c *gin.Context) (*oidcConsentRequest, error) {
	request := &oidcConsentRequest{}
	if c.Request.Method == http.MethodPost {
		if err := common.DecodeJsonStrict(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10), request); err != nil {
			return nil, err
		}
	} else {
		queryParameters, err := url.ParseQuery(c.Request.URL.RawQuery)
		if err != nil {
			return nil, service.ErrOidcRequestInvalid
		}
		for key, values := range queryParameters {
			if key != "resource" && len(values) != 1 {
				return nil, service.ErrOidcRequestInvalid
			}
		}
		request.ClientId = c.Query("client_id")
		request.RedirectUri = c.Query("redirect_uri")
		request.Scope = c.Query("scope")
		request.State = c.Query("state")
		request.Nonce = c.Query("nonce")
		request.CodeChallenge = c.Query("code_challenge")
		request.CodeChallengeMethod = c.Query("code_challenge_method")
		request.Resources = c.Request.URL.Query()["resource"]
		request.Prompt = c.Query("prompt")
	}
	if request.Prompt != "" && request.Prompt != "consent" {
		return nil, service.ErrOidcRequestInvalid
	}
	resources, err := service.OAuthNormalizeResources(request.Resources)
	if err != nil {
		return nil, err
	}
	request.Resources = resources
	return request, nil
}

// validateOidcConsentRequest checks the request against the client record and
// returns the normalized scopes plus the client.
func validateOidcConsentRequest(request *oidcConsentRequest) (*model.OauthClient, []string, error) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled || settings.GetIssuer() == "" {
		return nil, nil, service.ErrOidcProviderDisabled
	}
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
	if err := service.ValidateOidcPKCEChallenge(request.CodeChallenge, request.CodeChallengeMethod); err != nil {
		return nil, nil, service.ErrOidcRequestInvalid
	}
	request.RedirectUri = redirectUri
	return client, scopes, nil
}

// GetOidcConsent returns the consent state for a logged-in user.
func GetOidcConsent(c *gin.Context) {
	oidcNoStore(c)
	identity, ok := requireBrowserSession(c)
	if !ok {
		return
	}
	request, err := parseOidcConsentParams(c)
	if err != nil {
		common.ApiError(c, service.ErrOidcRequestInvalid)
		return
	}
	client, requestedScopes, err := validateOidcConsentRequest(request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	scopes, err := service.OAuthScopesForConsent(identity.UserID, client, requestedScopes)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	consentToken, err := service.CreateOAuthConsentChallenge(identity.UserID, identity.SessionID, request.snapshot(client, scopes))
	if err != nil {
		common.ApiError(c, errors.New("unable to start authorization"))
		return
	}
	// Preview must never mint a code or widen an authorization. Every client
	// completes explicit POST consent, including previously approved clients.
	c.JSON(http.StatusOK, gin.H{
		"success":         true,
		"require_consent": true,
		"client": gin.H{
			"name":        client.Name,
			"description": client.Description,
		},
		"scopes":        scopes,
		"capabilities":  service.OAuthConsentCapabilities(scopes),
		"consent_token": consentToken,
		"resources":     request.Resources,
	})
}

// PostOidcConsent records the user's decision and returns the redirect target.
func PostOidcConsent(c *gin.Context) {
	oidcNoStore(c)
	identity, ok := requireBrowserSession(c)
	if !ok {
		return
	}
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
	userId := identity.UserID
	scopes, err = service.OAuthScopesForConsent(userId, client, scopes)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := service.ConsumeOAuthConsentChallenge(request.ConsentToken, identity.UserID, identity.SessionID, request.snapshot(client, scopes)); err != nil {
		common.ApiError(c, errors.New("authorization preview expired or changed; reload and try again"))
		return
	}
	if !request.Approve {
		params := oidcAuthorizeErrorParams(service.OidcErrorAccessDenied, "the user denied the authorization request", request.State)
		params["iss"] = system_setting.GetOauthProviderSettings().GetIssuer()
		c.JSON(http.StatusOK, gin.H{
			"success":  true,
			"redirect": buildOidcRedirectURL(request.RedirectUri, params),
		})
		return
	}
	if request.SelectedScopes != nil {
		selected := make([]string, 0, len(request.SelectedScopes))
		for _, scope := range request.SelectedScopes {
			if !slices.Contains(scopes, scope) || slices.Contains(selected, scope) {
				common.ApiError(c, service.ErrOidcScopeNotRequested)
				return
			}
			selected = append(selected, scope)
		}
		if len(selected) == 0 {
			common.ApiError(c, service.ErrOidcRequestInvalid)
			return
		}
		scopes = selected
	}
	redirect, err := approveOidcConsent(client, userId, scopes, request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success":  true,
		"redirect": redirect,
	})
}

func approveOidcConsent(client *model.OauthClient, userId int, scopes []string, request *oidcConsentRequest) (string, error) {
	code, err := service.CreateOidcAuthorizationCode(service.OidcAuthorizeInput{
		Client:              client,
		UserId:              userId,
		Scopes:              scopes,
		RedirectUri:         request.RedirectUri,
		State:               request.State,
		Nonce:               request.Nonce,
		CodeChallenge:       request.CodeChallenge,
		CodeChallengeMethod: request.CodeChallengeMethod,
		Resources:           request.Resources,
	})
	if err != nil {
		return "", err
	}
	model.TouchOauthClientUsageById(client.Id)
	return buildOidcRedirectURL(request.RedirectUri, map[string]string{
		"code":  code,
		"state": request.State,
		"iss":   system_setting.GetOauthProviderSettings().GetIssuer(),
	}), nil
}

// oidcTokenError writes an RFC 6749 error response without internal details.
func oidcTokenError(c *gin.Context, errorCode string, description string) {
	oidcNoStore(c)
	status := http.StatusBadRequest
	if errorCode == "invalid_client" {
		status = http.StatusUnauthorized
		c.Header("WWW-Authenticate", `Basic realm="oidc"`)
	}
	c.JSON(status, gin.H{
		"error":             errorCode,
		"error_description": description,
	})
}

// OidcToken exchanges one PKCE-bound authorization code or rotates a refresh
// token. Service transactions bind validation and token issuance atomically.
func OidcToken(c *gin.Context) {
	oidcNoStore(c)
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled || settings.GetIssuer() == "" {
		oidcTokenError(c, "server_error", "OIDC provider is disabled")
		return
	}
	params, err := parseOidcTokenRequest(c)
	if err != nil {
		if errors.Is(err, errOidcClientAuthentication) {
			oidcTokenError(c, "invalid_client", "client authentication failed")
		} else {
			oidcTokenError(c, "invalid_request", "invalid token request")
		}
		return
	}
	client, err := authenticateOidcClient(params)
	if err != nil {
		oidcTokenError(c, "invalid_client", "client authentication failed")
		return
	}
	var response *service.OAuthTokenResponse
	switch params.GrantType {
	case "authorization_code":
		if params.Code == "" || params.RedirectUri == "" || params.RefreshToken != "" || params.Scope != "" {
			oidcTokenError(c, "invalid_request", "code and redirect_uri are required")
			return
		}
		response, err = service.ExchangeOAuthAuthorizationCode(params.Code, client, params.RedirectUri, params.CodeVerifier, params.Resources...)
	case "refresh_token":
		if params.RefreshToken == "" || params.Code != "" || params.RedirectUri != "" || params.CodeVerifier != "" {
			oidcTokenError(c, "invalid_request", "refresh_token is required")
			return
		}
		response, err = service.RefreshOAuthTokens(params.RefreshToken, client, params.Scope, params.Resources...)
	default:
		oidcTokenError(c, "unsupported_grant_type", "unsupported grant type")
		return
	}
	if err != nil {
		if errors.Is(err, service.ErrOidcScopeNotRequested) || errors.Is(err, model.ErrOAuthScopeExpansion) || errors.Is(err, service.ErrOAuthScopeInvalid) || errors.Is(err, service.ErrOAuthScopeForbidden) {
			oidcTokenError(c, "invalid_scope", "requested scope exceeds the authorization")
		} else {
			oidcTokenError(c, "invalid_grant", "authorization is invalid or expired")
		}
		return
	}
	model.TouchOauthClientUsageById(client.Id)
	c.JSON(http.StatusOK, response)
}

type oidcTokenParams struct {
	GrantType    string
	ClientId     string
	ClientSecret string
	Code         string
	RedirectUri  string
	CodeVerifier string
	RefreshToken string
	Scope        string
	Token        string
	BasicAuth    bool
	SecretInBody bool
	Resources    []string
}

// parseOidcTokenRequest accepts the RFC 6749 form body and exactly one client
// authentication method. URL credentials, duplicate parameters and ambiguous
// Basic/body authentication are rejected before any authorization is consumed.
func parseOidcTokenRequest(c *gin.Context) (*oidcTokenParams, error) {
	if c.ContentType() != "application/x-www-form-urlencoded" || c.Request.URL.RawQuery != "" {
		return nil, service.ErrOidcRequestInvalid
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
	if err := c.Request.ParseForm(); err != nil {
		return nil, service.ErrOidcRequestInvalid
	}
	body := c.Request.PostForm
	for key, values := range body {
		if key != "resource" && len(values) != 1 {
			return nil, service.ErrOidcRequestInvalid
		}
	}
	resources, err := service.OAuthNormalizeResources(body["resource"])
	if err != nil {
		return nil, err
	}
	// An omitted resource keeps the authorization's existing resource set.
	if len(body["resource"]) == 0 {
		resources = nil
	}
	_, secretInBody := body["client_secret"]
	params := &oidcTokenParams{
		GrantType: body.Get("grant_type"), ClientId: body.Get("client_id"),
		ClientSecret: body.Get("client_secret"), Code: body.Get("code"),
		RedirectUri: body.Get("redirect_uri"), CodeVerifier: body.Get("code_verifier"),
		RefreshToken: body.Get("refresh_token"), Scope: body.Get("scope"), Token: body.Get("token"),
		Resources: resources, SecretInBody: secretInBody,
	}
	authorization := c.Request.Header.Values("Authorization")
	if len(authorization) > 1 {
		return nil, service.ErrOidcRequestInvalid
	}
	if len(authorization) == 1 {
		if _, ok := body["client_id"]; ok {
			return nil, service.ErrOidcRequestInvalid
		}
		if _, ok := body["client_secret"]; ok {
			return nil, service.ErrOidcRequestInvalid
		}
		clientID, clientSecret, ok := c.Request.BasicAuth()
		if !ok {
			return nil, errOidcClientAuthentication
		}
		var err error
		params.ClientId, err = url.QueryUnescape(clientID)
		if err != nil {
			return nil, errOidcClientAuthentication
		}
		params.ClientSecret, err = url.QueryUnescape(clientSecret)
		if err != nil {
			return nil, errOidcClientAuthentication
		}
		params.BasicAuth = true
	}
	return params, nil
}

func authenticateOidcClient(params *oidcTokenParams) (*model.OauthClient, error) {
	if params.ClientId == "" {
		return nil, errOidcClientAuthentication
	}
	client, err := model.GetOauthClientByClientId(params.ClientId)
	if err != nil || !client.Enabled {
		return nil, errOidcClientAuthentication
	}
	if client.IsPublic {
		if params.BasicAuth || params.SecretInBody {
			return nil, errOidcClientAuthentication
		}
	} else if !client.CheckSecret(params.ClientSecret) {
		return nil, errOidcClientAuthentication
	}
	return client, nil
}

// OidcUserInfo returns claims for a granted access token.
func OidcUserInfo(c *gin.Context) {
	oidcNoStore(c)
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled {
		oidcUserInfoError(c, http.StatusServiceUnavailable, "OIDC provider is disabled")
		return
	}
	if c.Request.URL.RawQuery != "" || len(c.Request.Header.Values("Authorization")) > 1 {
		oidcUserInfoError(c, http.StatusUnauthorized, "invalid access token")
		return
	}
	raw := ""
	authorization := c.GetHeader("Authorization")
	if authorization != "" {
		parts := strings.Fields(authorization)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			oidcUserInfoError(c, http.StatusUnauthorized, "invalid access token")
			return
		}
		raw = parts[1]
	}
	if c.Request.Method == http.MethodPost {
		if c.ContentType() == "application/x-www-form-urlencoded" {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
			if err := c.Request.ParseForm(); err != nil {
				oidcUserInfoError(c, http.StatusUnauthorized, "invalid access token")
				return
			}
			values, ok := c.Request.PostForm["access_token"]
			if ok {
				if raw != "" || len(values) != 1 {
					oidcUserInfoError(c, http.StatusUnauthorized, "invalid access token")
					return
				}
				raw = values[0]
			}
		} else if c.Request.ContentLength != 0 {
			oidcUserInfoError(c, http.StatusUnauthorized, "invalid access token")
			return
		}
	}
	if raw == "" {
		oidcUserInfoError(c, http.StatusUnauthorized, "missing access token")
		return
	}
	principal, recognized, err := service.AuthenticateOAuthAccessToken(raw)
	if err != nil || !recognized || principal == nil {
		oidcUserInfoError(c, http.StatusUnauthorized, "invalid access token")
		return
	}
	if !slices.Contains(principal.Scopes, "openid") || !slices.Contains(principal.Resources, model.OAuthResourceDashboard) {
		c.Header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="openid"`)
		c.JSON(http.StatusForbidden, gin.H{"error": "insufficient_scope", "error_description": "openid scope and dashboard resource are required"})
		return
	}
	c.JSON(http.StatusOK, service.BuildOidcUserInfo(principal.User, principal.Scopes))
}

func oidcUserInfoError(c *gin.Context, status int, message string) {
	c.Header("WWW-Authenticate", fmt.Sprintf("Bearer error=\"invalid_token\", error_description=\"%s\"", message))
	c.JSON(status, gin.H{
		"error":             "invalid_token",
		"error_description": message,
	})
}

// OidcRevoke invalidates a grant and every associated credential. An unknown
// token is deliberately indistinguishable from an already revoked token.
func OidcRevoke(c *gin.Context) {
	oidcNoStore(c)
	params, err := parseOidcTokenRequest(c)
	if err != nil {
		if errors.Is(err, errOidcClientAuthentication) {
			oidcTokenError(c, "invalid_client", "client authentication failed")
		} else {
			oidcTokenError(c, "invalid_request", "invalid revocation request")
		}
		return
	}
	client, err := authenticateOidcClient(params)
	if err != nil {
		oidcTokenError(c, "invalid_client", "client authentication failed")
		return
	}
	if params.Token == "" {
		oidcTokenError(c, "invalid_request", "token is required")
		return
	}
	if err := service.RevokeOAuthToken(params.Token, client); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "temporarily_unavailable"})
		return
	}
	c.Status(http.StatusOK)
}
