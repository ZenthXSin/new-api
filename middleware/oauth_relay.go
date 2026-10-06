package middleware

import (
	"fmt"
	"net"
	"net/http"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

func isOAuthRelayCredential(raw string) bool {
	return strings.HasPrefix(raw, "nao_")
}

// tryOAuthRelayAuth runs before the legacy protocol aliases rewrite headers.
// A recognized OAuth credential never falls through to a different API key.
func tryOAuthRelayAuth(c *gin.Context) bool {
	credential, _, headerErr := oauthDashboardBearer(c)
	invalid := headerErr != nil
	for _, header := range []string{"x-api-key", "x-goog-api-key", "mj-api-secret"} {
		values := c.Request.Header.Values(header)
		for _, value := range values {
			raw := strings.TrimSpace(value)
			if parsed, ok := authorizationToken(raw); ok {
				raw = parsed
			}
			if !isOAuthRelayCredential(raw) {
				continue
			}
			if len(values) != 1 || (credential != "" && credential != raw) {
				invalid = true
			}
			credential = raw
		}
	}
	for _, name := range []string{"key", "access_token"} {
		for _, raw := range c.Request.URL.Query()[name] {
			if isOAuthRelayCredential(raw) {
				invalid = true
			}
		}
	}
	var ticket string
	for _, protocol := range strings.Split(c.GetHeader("Sec-WebSocket-Protocol"), ",") {
		protocol = strings.TrimSpace(protocol)
		raw := strings.TrimPrefix(protocol, "openai-insecure-api-key.")
		if strings.HasPrefix(raw, "nao_ws_") {
			if ticket != "" || credential != "" || raw == protocol {
				invalid = true
			}
			ticket = raw
		} else if isOAuthRelayCredential(raw) {
			invalid = true
		}
	}
	if invalid {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "OAuth credential transport is invalid")
		return true
	}
	if credential == "" && ticket == "" {
		return false
	}
	var principal *service.OAuthPrincipal
	var err error
	if ticket != "" {
		principal, _, err = service.AuthenticateOAuthRelayTicket(ticket, c.Request.Method, c.Request.URL.Path)
	} else {
		principal, _, err = service.AuthenticateOAuthAccessToken(credential)
	}
	if err != nil || principal == nil {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "OAuth access token is invalid or expired")
		return true
	}
	if !oauthRelayScopeAllowed(c, principal) {
		return true
	}
	token, err := model.GetOrCreateOAuthRelayToken(principal.GrantID, principal.UserID, principal.GrantVersion)
	if err != nil {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "OAuth relay authorization is unavailable")
		return true
	}
	completeOAuthRelayAuth(c, principal, token)
	return true
}

// OAuthRelayPrincipalAuth is used by dashboard-authenticated relay routes such
// as the playground, before channel distribution and normal billing begin.
func OAuthRelayPrincipalAuth(c *gin.Context, principal *service.OAuthPrincipal) {
	if !oauthRelayScopeAllowed(c, principal) {
		return
	}
	token, err := model.GetOrCreateOAuthRelayToken(principal.GrantID, principal.UserID, principal.GrantVersion)
	if err != nil {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "OAuth relay authorization is unavailable")
		return
	}
	completeOAuthRelayAuth(c, principal, token)
}

func oauthRelayScopeAllowed(c *gin.Context, principal *service.OAuthPrincipal) bool {
	scope, known := service.OAuthRequiredRelayScope(c.Request.Method, c.FullPath())
	if !known || principal == nil || !slices.Contains(principal.Resources, service.OAuthResourceRelay) || !service.OAuthScopeAllowed(principal, scope) {
		abortWithOpenAiMessage(c, http.StatusForbidden, "OAuth permission does not allow this operation")
		return false
	}
	return true
}

// authorizeOAuthDerivedToken is always called after legacy key validation.
// Only server-created prefixed keys can carry delegation metadata, so normal
// API-key requests preserve their existing cache and latency behavior.
func authorizeOAuthDerivedToken(c *gin.Context, token *model.Token) bool {
	if !strings.HasPrefix(token.Key, "naok_") && !strings.HasPrefix(token.Key, "naoi_") {
		return true
	}
	metadata, err := model.GetOAuthRelayTokenMetadata(token.Id)
	if err != nil || metadata.OAuthInternal || metadata.OAuthGrantID <= 0 {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "OAuth relay credential is invalid")
		return false
	}
	principal, err := service.AuthenticateOAuthGrant(metadata.OAuthGrantID)
	if err != nil || principal == nil || principal.UserID != token.UserId || principal.GrantVersion != metadata.OAuthGrantVersion {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "OAuth relay authorization is invalid or expired")
		return false
	}
	if !oauthRelayScopeAllowed(c, principal) {
		return false
	}
	SetOAuthPrincipal(c, principal)
	stripOAuthRelayCredentials(c)
	c.Header("Cache-Control", "private, no-store")
	return true
}

// completeOAuthRelayAuth preserves TokenAuth's token/IP/group/context checks.
// It never changes user balances, funding source, pre-consumption or refunds.
func completeOAuthRelayAuth(c *gin.Context, principal *service.OAuthPrincipal, token *model.Token) {
	if token.Status != common.TokenStatusEnabled || principal.User == nil || principal.User.Status != common.UserStatusEnabled {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "OAuth relay authorization is unavailable")
		return
	}
	if limits := token.GetIpLimits(); len(limits) > 0 {
		ip := net.ParseIP(c.ClientIP())
		if ip == nil || !common.IsIpInCIDRList(ip, limits) {
			abortWithOpenAiMessage(c, http.StatusForbidden, "IP address is not allowed")
			return
		}
	}
	user := principal.User.ToBaseUser()
	user.WriteContext(c)
	group := user.Group
	if token.Group != "" {
		if !service.GroupInUserUsableGroupsByGroups(user.GetGroups(), token.Group) || (token.Group != "auto" && !ratio_setting.ContainsGroupRatio(token.Group)) {
			abortWithOpenAiMessage(c, http.StatusForbidden, fmt.Sprintf("无权访问 %s 分组", token.Group))
			return
		}
		group = token.Group
	}
	common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
	if err := SetupContextForToken(c, token); err != nil {
		return
	}
	c.Set("use_access_token", true)
	SetOAuthPrincipal(c, principal)
	stripOAuthRelayCredentials(c)
	c.Header("Cache-Control", "private, no-store")
	c.Next()
}

// Channel overrides can copy caller headers into upstream requests. Never let
// an application access token, browser cookie or one-use ticket reach them.
func stripOAuthRelayCredentials(c *gin.Context) {
	if c.GetHeader("x-api-key") != "" {
		c.Set("oauth_anthropic_protocol", true)
	}
	if c.GetHeader("x-goog-api-key") != "" {
		c.Set("oauth_gemini_protocol", true)
	}
	for _, header := range []string{"Authorization", "x-api-key", "x-goog-api-key", "mj-api-secret", "Cookie"} {
		c.Request.Header.Del(header)
	}
	protocols := make([]string, 0)
	for _, protocol := range strings.Split(c.GetHeader("Sec-WebSocket-Protocol"), ",") {
		protocol = strings.TrimSpace(protocol)
		if protocol != "" && !strings.HasPrefix(protocol, "openai-insecure-api-key.") {
			protocols = append(protocols, protocol)
		}
	}
	if len(protocols) == 0 {
		c.Request.Header.Del("Sec-WebSocket-Protocol")
	} else {
		c.Request.Header.Set("Sec-WebSocket-Protocol", strings.Join(protocols, ", "))
	}
}
