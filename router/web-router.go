package router

import (
	"embed"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-contrib/gzip"
	"github.com/gin-contrib/static"
	"github.com/gin-gonic/gin"
)

// WebAssets holds the embedded dashboard frontend assets.
type WebAssets struct {
	BuildFS   embed.FS
	IndexPage []byte
}

func SetWebRouter(router *gin.Engine, assets WebAssets) {
	frontendFS := common.EmbedFolder(assets.BuildFS, "web/dist")

	router.Use(gzip.Gzip(gzip.DefaultCompression))
	router.Use(middleware.GlobalWebRateLimit())
	router.Use(middleware.Cache())
	router.Use(static.Serve("/", frontendFS))
	router.NoRoute(func(c *gin.Context) {
		c.Set(middleware.RouteTagKey, "web")
		if strings.HasPrefix(c.Request.RequestURI, "/v1") || strings.HasPrefix(c.Request.RequestURI, "/api") || strings.HasPrefix(c.Request.RequestURI, "/assets") {
			controller.RelayNotFound(c)
			return
		}
		c.Header("Cache-Control", "no-cache")
		setOAuthPageSecurityHeaders(c)
		c.Data(http.StatusOK, "text/html; charset=utf-8", assets.IndexPage)
	})
}

// Consent and hosted confirmations must remain top-level, uncached documents.
// Headers on their JSON endpoints alone do not protect the browser page.
func setOAuthPageSecurityHeaders(c *gin.Context) {
	path := c.Request.URL.Path
	if path != "/authorize" && path != "/authorize/" && !strings.HasPrefix(path, "/oauth/actions/") && !strings.HasPrefix(path, "/payments/checkout/") {
		return
	}
	c.Header("X-Frame-Options", "DENY")
	c.Header("Content-Security-Policy", "frame-ancestors 'none'")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Cache-Control", "no-store")
}
