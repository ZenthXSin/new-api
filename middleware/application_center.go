package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

// AppCenterAdmin allows application-center operations for administrator users.
// Authenticated non-admin users intentionally receive the generic 500 contract.
func AppCenterAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetInt("role") < common.RoleAdminUser {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"success": false, "message": "应用中心操作失败"})
			return
		}
		c.Next()
	}
}

// AppCenterAuthScope marks the request before the shared UserAuth middleware
// runs, so authentication failures use the app-center HTTP contract.
func AppCenterAuthScope() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set("app_center_auth", true)
		c.Next()
	}
}
