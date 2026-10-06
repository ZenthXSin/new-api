package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func setCodexWorkbenchRouter(api *gin.RouterGroup) {
	group := api.Group("/codex", middleware.AdminAuth(), middleware.DisableCache())
	group.GET("/status", controller.CodexWorkbenchProxy)
	group.GET("/environment", controller.CodexWorkbenchProxy)
	group.POST("/environment/start", controller.CodexWorkbenchProxy)
	group.POST("/environment/stop", controller.CodexWorkbenchProxy)
	group.GET("/workspaces", controller.CodexWorkbenchProxy)
	group.POST("/workspaces", controller.CodexWorkbenchProxy)
	group.GET("/workspaces/:id", controller.CodexWorkbenchProxy)
	group.PATCH("/workspaces/:id", controller.CodexWorkbenchProxy)
	group.DELETE("/workspaces/:id", controller.CodexWorkbenchProxy)
	group.POST("/workspaces/:id/turns", controller.CodexWorkbenchProxy)
	group.POST("/workspaces/:id/interrupt", controller.CodexWorkbenchProxy)
	group.POST("/workspaces/:id/approvals/:requestId", controller.CodexWorkbenchProxy)
	group.GET("/workspaces/:id/events", controller.CodexWorkbenchProxy)
	group.GET("/workspaces/:id/files", controller.CodexWorkbenchProxy)
	group.GET("/workspaces/:id/file", controller.CodexWorkbenchProxy)
	group.PUT("/workspaces/:id/file", controller.CodexWorkbenchProxy)
	group.GET("/workspaces/:id/diff", controller.CodexWorkbenchProxy)
	group.POST("/workspaces/:id/import", controller.CodexWorkbenchProxy)
	group.GET("/workspaces/:id/export", controller.CodexWorkbenchProxy)
}
