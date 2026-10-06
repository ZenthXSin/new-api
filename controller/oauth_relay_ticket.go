package controller

import (
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// CreateOAuthRelayTicket accepts an OAuth identity only; a dashboard session
// cannot mint an unbound credential for an external application.
func CreateOAuthRelayTicket(c *gin.Context) {
	oidcNoStore(c)
	principal, ok := middleware.GetOAuthPrincipal(c)
	if !ok {
		c.Header("WWW-Authenticate", `Bearer error="invalid_token"`)
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "invalid_token", "message": "OAuth authentication is required."})
		return
	}
	if !service.OAuthScopeAllowed(principal, "relay:invoke") || !slices.Contains(principal.Resources, service.OAuthResourceRelay) {
		c.Header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="relay:invoke"`)
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "insufficient_scope", "message": "Relay permission is required."})
		return
	}
	ticket, err := service.CreateOAuthRelayTicket(principal)
	if errors.Is(err, service.ErrOAuthRelayTicketInvalid) {
		c.Header("WWW-Authenticate", `Bearer error="invalid_token"`)
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "invalid_token", "message": "OAuth authorization is no longer valid."})
		return
	}
	if errors.Is(err, service.ErrOAuthScopeForbidden) {
		c.Header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="relay:invoke"`)
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "insufficient_scope", "message": "Relay permission is required."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "server_error", "message": "Unable to issue a relay ticket."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"ticket": ticket, "expires_in": int64(service.OAuthRelayTicketTTL / time.Second),
		"protocol": "openai-insecure-api-key." + ticket,
	}})
}
