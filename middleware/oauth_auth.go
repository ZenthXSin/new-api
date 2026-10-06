package middleware

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/gin-gonic/gin"
)

const oauthPrincipalContextKey = "oauth_principal"

// GetOAuthPrincipal returns only the verified delegated principal installed by
// the resource authentication middleware. It never creates a browser session.
func GetOAuthPrincipal(c *gin.Context) (*service.OAuthPrincipal, bool) {
	value, exists := c.Get(oauthPrincipalContextKey)
	principal, ok := value.(*service.OAuthPrincipal)
	return principal, exists && ok && principal != nil
}

func SetOAuthPrincipal(c *gin.Context, principal *service.OAuthPrincipal) {
	c.Set(oauthPrincipalContextKey, principal)
	c.Set("oauth_client_id", principal.ClientID)
	c.Set("oauth_grant_id", principal.GrantID)
	c.Set("auth_method", "oauth")
}

// tryOAuthDashboardAuth handles every recognized OAuth credential, including
// invalid ones, so a revoked or malformed OAuth token cannot fall back to PAT
// authentication. Existing session and PAT requests return false untouched.
func tryOAuthDashboardAuth(c *gin.Context, minRole int) bool {
	raw, candidate, headerErr := oauthDashboardBearer(c)
	if !candidate {
		return false
	}
	var principal *service.OAuthPrincipal
	var recognized bool
	err := headerErr
	if err == nil {
		principal, recognized, err = service.AuthenticateOAuthAccessToken(raw)
	} else {
		recognized = true
	}
	if !recognized {
		return false
	}
	if err != nil || principal == nil || principal.User == nil {
		c.Header("WWW-Authenticate", `Bearer error="invalid_token"`)
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "error": "invalid_token", "code": "OAUTH_INVALID_TOKEN", "message": "OAuth access token is invalid or has expired."})
		return true
	}
	SetOAuthPrincipal(c, principal)
	route, listed := service.OAuthRouteFor(c.Request.Method, c.FullPath())
	if !listed {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "error": "access_denied", "code": "OAUTH_ROUTE_UNDECLARED", "message": "This route has no delegated authorization policy."})
		return true
	}
	user := principal.User
	if user.Status != common.UserStatusEnabled || !validUserInfo(user.Username, user.Role) || user.Role < minRole || user.Role < route.MinRole {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "error": "access_denied", "code": "OAUTH_INSUFFICIENT_PRIVILEGE", "message": "Your account no longer has permission for this operation."})
		return true
	}
	if !slices.Contains(principal.Resources, route.Resource) && route.Resource != "" {
		c.Header("WWW-Authenticate", `Bearer error="invalid_token"`)
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "error": "invalid_token", "code": "OAUTH_INVALID_RESOURCE", "message": "The access token is not valid for this resource."})
		return true
	}
	if !service.OAuthScopeAllowed(principal, route.Scope) {
		c.Header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="`+route.Scope+`"`)
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "error": "insufficient_scope", "code": "OAUTH_INSUFFICIENT_SCOPE", "required_scope": route.Scope, "message": "The application has not been authorized for this operation."})
		return true
	}
	if route.Mode == service.OAuthRouteHosted {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "error": "interaction_required", "code": "OAUTH_HOSTED_ACTION_REQUIRED", "required_scope": route.Scope, "action_endpoint": "/api/oauth2/actions", "message": "Complete this operation through the site's secure confirmation flow."})
		return true
	}
	if route.Mode != service.OAuthRouteDirect && route.Mode != service.OAuthRoutePublic && route.Mode != service.OAuthRouteCompatibility {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "error": "access_denied", "code": "OAUTH_PROTOCOL_AUTH_REQUIRED", "message": "This endpoint requires its own authorization protocol."})
		return true
	}
	if route.Resource == service.OAuthResourceRelay && strings.HasPrefix(c.FullPath(), "/pg/") {
		OAuthRelayPrincipalAuth(c, principal)
		return true
	}
	identity := service.AuthIdentity{UserID: user.Id, UserAuthVersion: user.AuthVersion}
	setDashboardAuthContext(c, user.ToBaseUser(), identity, true)
	var auditWriter *auditResponseWriter
	if minRole >= common.RoleAdminUser {
		auditWriter = beginAdminAudit(c)
	}
	c.Next()
	finishAdminAudit(c, auditWriter)
	return true
}

// OAuthPermissionAllowed intersects a conditional business permission with
// the application's concrete consent. Session/PAT behavior remains governed
// by the same existing Casbin policy.
func OAuthPermissionAllowed(c *gin.Context, permission authz.Permission) bool {
	if !authz.Can(c.GetInt("id"), c.GetInt("role"), permission) {
		return false
	}
	principal, delegated := GetOAuthPrincipal(c)
	return !delegated || service.OAuthScopeAllowed(principal, permission.Resource+":"+permission.Action)
}

// oauthDashboardBearer refuses ambiguous Authorization fields before choosing
// an identity. A malformed delegated credential cannot be shadowed by a PAT
// in another header value or accepted as a non-Bearer authorization scheme.
func oauthDashboardBearer(c *gin.Context) (string, bool, error) {
	values := c.Request.Header.Values("Authorization")
	candidate := false
	for _, value := range values {
		for _, field := range strings.Fields(value) {
			if strings.HasPrefix(field, "nao_") {
				candidate = true
			}
		}
	}
	if !candidate {
		return "", false, nil
	}
	if len(values) != 1 {
		return "", true, errors.New("ambiguous oauth authorization header")
	}
	fields := strings.Fields(values[0])
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || !strings.HasPrefix(fields[1], "nao_") {
		return "", true, errors.New("invalid oauth bearer header")
	}
	return fields[1], true, nil
}
