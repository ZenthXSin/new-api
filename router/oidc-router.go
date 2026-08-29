package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"

	"github.com/gin-gonic/gin"
)

// SetOidcRouter registers the root-level OIDC provider endpoints. These must
// live outside /api so the issuer URL reads like a standard identity provider
// (e.g. https://host/oidc/.well-known/openid-configuration).
func SetOidcRouter(router *gin.Engine) {
	oidcRouter := router.Group("/oidc")
	oidcRouter.Use(middleware.RouteTag("oidc"))
	{
		wellKnown := oidcRouter.Group("/.well-known")
		{
			wellKnown.GET("/openid-configuration", controller.GetOidcDiscovery)
			wellKnown.GET("/jwks.json", controller.GetOidcJWKS)
		}
		oidcRouter.GET("/authorize", controller.OidcAuthorize)
		oidcRouter.POST("/token", middleware.CriticalRateLimit(), controller.OidcToken)
		oidcRouter.GET("/userinfo", controller.OidcUserInfo)
		oidcRouter.POST("/userinfo", controller.OidcUserInfo)
		oidcRouter.POST("/revoke", middleware.CriticalRateLimit(), controller.OidcRevoke)
	}
}
