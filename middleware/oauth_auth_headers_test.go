package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestOAuthDashboardRejectsAmbiguousCredentialHeaders(t *testing.T) {
	for _, test := range []struct {
		name   string
		values []string
	}{
		{"oauth before PAT", []string{"Bearer nao_at_malformed", "Bearer legacy-pat"}},
		{"oauth after PAT", []string{"Bearer legacy-pat", "Bearer nao_at_malformed"}},
		{"two OAuth tokens", []string{"Bearer nao_at_first", "Bearer nao_at_second"}},
		{"combined values", []string{"Bearer nao_at_first, Bearer nao_at_second"}},
		{"wrong scheme", []string{"Basic nao_at_malformed"}},
		{"missing scheme", []string{"nao_at_malformed"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.GET("/api/user/self", UserAuth(), func(c *gin.Context) { t.Error("ambiguous credential reached handler") })
			request := httptest.NewRequest(http.MethodGet, "/api/user/self", nil)
			request.Header["Authorization"] = test.values
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assert.Equal(t, http.StatusUnauthorized, response.Code)
			assert.Contains(t, response.Body.String(), "OAUTH_INVALID_TOKEN")
		})
	}
}
