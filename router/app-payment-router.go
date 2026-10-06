package router

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func SetAppPaymentRouter(r *gin.Engine) {
	api := r.Group("/api/payments", middleware.RouteTag("api"), middleware.DisableCache(), middleware.GlobalAPIRateLimit())
	orders := api.Group("/orders", middleware.AppPaymentAuth())
	orders.POST("", middleware.CriticalRateLimit(), controller.CreateAppPaymentOrder)
	orders.GET("", controller.ListAppPaymentOrders)
	orders.GET("/:id", controller.GetAppPaymentOrder)
	orders.POST("/:id/cancel", middleware.CriticalRateLimit(), controller.CancelAppPaymentOrder)
	orders.POST("/:id/refund", middleware.CriticalRateLimit(), controller.RefundAppPaymentOrder)
	checkout := api.Group("/checkout", middleware.PaymentSessionAuth(common.RoleCommonUser))
	checkout.GET("/:id", controller.GetAppPaymentCheckout)
	checkout.GET("/:id/status", controller.GetAppPaymentCheckoutStatus)
	checkout.POST("/:id/confirm", middleware.CriticalRateLimit(), middleware.AppPaymentOriginGuard(), controller.ConfirmAppPaymentCheckout)
	api.GET("/self/orders", middleware.UserAuth(), controller.ListSelfAppPaymentOrders)
	applications := api.Group("/applications")
	applications.GET("", middleware.RootAuth(), controller.ListAppPaymentApplications)
	applications.GET("/:client_id", middleware.RootAuth(), controller.GetAppPaymentApplication)
	applications.GET("/:client_id/orders", middleware.RootAuth(), controller.ListManagedAppPaymentOrders)
	applications.GET("/:client_id/events", middleware.RootAuth(), controller.ListAppPaymentWebhookEvents)
	writes := applications.Group("", middleware.PaymentSessionAuth(common.RoleRootUser), middleware.AppPaymentOriginGuard(), middleware.CriticalRateLimit())
	writes.PUT("/:client_id", controller.SaveAppPaymentApplication)
	writes.POST("/:client_id/rotate-secret", controller.RotateAppPaymentWebhookSecret)
	writes.POST("/:client_id/events/:event_id/retry", controller.RetryAppPaymentWebhookEvent)
}
