package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestOAuthPagesRejectFramingAndCaching(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, path := range []string{"/authorize?client_id=test&state=private", "/authorize/", "/oauth/actions/approval-id", "/payments/checkout/ap_00112233445566778899aabbccdd"} {
		t.Run(path, func(t *testing.T) {
			router := gin.New()
			router.NoRoute(func(c *gin.Context) {
				c.Header("Cache-Control", "max-age=604800")
				setOAuthPageSecurityHeaders(c)
				c.Data(http.StatusOK, "text/html; charset=utf-8", []byte("<!doctype html>"))
			})
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
			assert.Equal(t, http.StatusOK, recorder.Code)
			assert.Equal(t, "DENY", recorder.Header().Get("X-Frame-Options"))
			assert.Equal(t, "frame-ancestors 'none'", recorder.Header().Get("Content-Security-Policy"))
			assert.Equal(t, "no-referrer", recorder.Header().Get("Referrer-Policy"))
			assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
		})
	}
}
