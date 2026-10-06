package controller

import (
	"net/http"
	"slices"

	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// GetOAuthCapabilities is the role-filtered consent catalog. Existing grants
// are returned separately so callers can distinguish grantable from granted.
func GetOAuthCapabilities(c *gin.Context) {
	capabilities := service.OAuthScopesForUser(c.GetInt("id"), c.GetInt("role"))
	var granted []string
	if principal, ok := middleware.GetOAuthPrincipal(c); ok {
		granted = slices.Clone(principal.Scopes)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"catalog_version": service.OAuthCatalogVersion,
		"capabilities":    capabilities,
		"granted_scopes":  granted,
		"resources":       []string{service.OAuthResourceDashboard, service.OAuthResourceRelay},
	}})
}

// GetOAuthRoutes returns only capabilities available to the current account.
// The source catalog and exported OpenAPI retain the complete reviewed route
// inventory, including protocol and preexisting compatibility endpoints.
func GetOAuthRoutes(c *gin.Context) {
	allowed := make(map[string]bool)
	for _, capability := range service.OAuthScopesForUser(c.GetInt("id"), c.GetInt("role")) {
		allowed[capability.Scope] = true
	}
	routes := make([]service.OAuthRouteCapability, 0)
	for _, route := range service.OAuthRouteCatalog() {
		if route.MinRole > c.GetInt("role") || (route.Scope != "" && !allowed[route.Scope]) {
			continue
		}
		routes = append(routes, route)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"catalog_version": service.OAuthCatalogVersion, "routes": routes}})
}
