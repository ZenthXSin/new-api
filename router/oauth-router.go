package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

// SetOAuthRouter registers delegated capability and grant management APIs.
// Grant administration also requires a genuine dashboard session in the
// controller; delegated callers use the hosted operation workflow.
func SetOAuthRouter(router *gin.Engine) {
	oauth := router.Group("/api/oauth2")
	oauth.Use(middleware.RouteTag("oauth"), middleware.UserAuth(), middleware.DisableCache())
	oauth.POST("/relay-ticket", controller.CreateOAuthRelayTicket)
	oauth.GET("/operations", controller.GetOAuthActionOperations)
	oauth.POST("/actions", middleware.CriticalRateLimit(), controller.CreateOAuthAction)
	oauth.POST("/actions/:id/claim", middleware.CriticalRateLimit(), controller.ClaimOAuthActionResult)
	oauth.GET("/actions/:id/approval", controller.GetOAuthActionApproval)
	oauth.POST("/actions/:id/approve", middleware.CriticalRateLimit(), controller.ApproveOAuthAction)
	oauth.POST("/actions/:id/reject", middleware.CriticalRateLimit(), controller.RejectOAuthAction)
	oauth.POST("/actions/:id/steps/:step", middleware.CriticalRateLimit(), controller.ExecuteOAuthActionStep)
	oauth.GET("/capabilities", controller.GetOAuthCapabilities)
	oauth.GET("/routes", controller.GetOAuthRoutes)
	oauth.GET("/grants", controller.GetOAuthGrants)
	oauth.PATCH("/grants/:id", controller.PatchOAuthGrant)
	oauth.DELETE("/grants/:id", controller.DeleteOAuthGrant)
	router.GET("/api/oauth2/actions/:id", middleware.RouteTag("oauth"), middleware.DisableCache(), controller.GetOAuthAction)
}
