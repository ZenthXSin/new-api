package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

const paymentClientContextKey = "app_payment_client"

// AppPaymentAuth authenticates an application server, never a delegated user.
func AppPaymentAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		clientID, secret, ok := c.Request.BasicAuth()
		if !ok || len(clientID) > 64 || len(secret) > 256 || clientID == "" || secret == "" || strings.TrimSpace(clientID) != clientID || strings.TrimSpace(secret) != secret {
			c.Header("WWW-Authenticate", `Basic realm="application-payments", charset="UTF-8"`)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "code": "PAYMENT_APP_AUTH_REQUIRED", "message": "application credentials are required"})
			return
		}
		client, err := model.GetOauthClientByClientId(clientID)
		if err != nil || client == nil || client.IsPublic || !client.CheckSecret(secret) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "code": "PAYMENT_APP_AUTH_REQUIRED", "message": "application credentials are invalid"})
			return
		}
		app, err := model.GetPaymentApplication(clientID)
		if !client.Enabled || err != nil || app == nil || !app.Enabled {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "PAYMENT_APP_DISABLED", "message": "application payments are disabled"})
			return
		}
		c.Set(paymentClientContextKey, client)
		c.Set("auth_method", "payment_application")
		c.Set("oauth_client_id", clientID)
		c.Next()
	}
}

func AppPaymentClient(c *gin.Context) (*model.OauthClient, bool) {
	value, ok := c.Get(paymentClientContextKey)
	client, typed := value.(*model.OauthClient)
	return client, ok && typed && client != nil
}

// PaymentSessionAuth accepts only a live first-party dashboard access token.
// The UserAuth path would also accept OAuth/PAT, which cannot approve payments.
func PaymentSessionAuth(minRole int) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, identity, kind, err := classifyDashboardCredential(c)
		if err != nil || kind != dashboardCredentialInternal || user == nil || identity.SessionID == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "code": "PAYMENT_SESSION_REQUIRED", "message": "a dashboard login session is required"})
			return
		}
		if user.Status != common.UserStatusEnabled || user.Role < minRole {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "PAYMENT_FORBIDDEN", "message": "payment access is not allowed"})
			return
		}
		setDashboardAuthContext(c, user, identity, false)
		raw, _ := authorizationToken(c.GetHeader("Authorization"))
		digest := sha256.Sum256([]byte(raw))
		c.Set("app_payment_session_token_hash", hex.EncodeToString(digest[:]))
		var audit *auditResponseWriter
		if minRole >= common.RoleAdminUser {
			audit = beginAdminAudit(c)
		}
		c.Next()
		finishAdminAudit(c, audit)
	}
}

// AppPaymentOriginGuard is enforced even on HTTP development sessions. Origin
// is checked against the request or explicitly configured trusted site origins.
func AppPaymentOriginGuard() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !RequireAppPaymentOrigin(c) {
			return
		}
		c.Next()
	}
}

// RecheckPaymentSession protects controller calls made by the hosted action
// dispatcher as well as regular routed calls.
func RecheckPaymentSession(c *gin.Context, minRole int) (service.AuthIdentity, bool) {
	identity, ok := GetSessionAuthIdentity(c)
	if !ok {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "code": "PAYMENT_SESSION_REQUIRED", "message": "a dashboard login session is required"})
		return service.AuthIdentity{}, false
	}
	_, user, err := service.ValidateLoginSession(identity)
	if err != nil || user == nil || user.Role < minRole || user.Status != common.UserStatusEnabled {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "PAYMENT_FORBIDDEN", "message": "payment access is not allowed"})
		return service.AuthIdentity{}, false
	}
	return identity, true
}

func RequireAppPaymentOrigin(c *gin.Context) bool {
	origin, ok := requestBrowserOrigin(c.Request)
	if !ok || !isAllowedSessionOrigin(c.Request, origin) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "PAYMENT_CSRF", "message": "request origin is not allowed"})
		return false
	}
	return true
}
