package middleware

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func CodexToolsAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, user, err := service.ValidateCodexToolsToken(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		if err != nil || c.GetHeader("Origin") != "" || c.GetHeader("Sec-Fetch-Site") != "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "code": "codex_tools_unauthorized", "message": "Codex tool authorization expired; submit a new message to authorize again"})
			return
		}
		setDashboardAuthContext(c, user, claims.Identity, false)
	}
}
