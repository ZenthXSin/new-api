package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthClientOriginRequiresExactRegisteredWebOrigin(t *testing.T) {
	client := &model.OauthClient{}
	require.NoError(t, client.SetRedirectUris([]string{"https://client.example/callback", "http://127.0.0.1:9876/callback"}))
	for _, origin := range []string{"https://client.example", "http://127.0.0.1:9876"} {
		assert.True(t, OAuthClientAllowsOrigin(client, origin), origin)
	}
	for _, origin := range []string{"null", "https://client.example.evil", "https://client.example:8443", "http://client.example", "https://client.example/path", "https://user@client.example", "com.example.app:", "https://client.example?query=yes"} {
		assert.False(t, OAuthClientAllowsOrigin(client, origin), origin)
	}
}

func TestOAuthCORSPreflightSupportsScopedBearerWithoutCookies(t *testing.T) {
	setupDashboardAuthMiddlewareTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.OauthClient{}))
	client := &model.OauthClient{ClientId: "cors-test", Name: "cors-test", Enabled: true}
	require.NoError(t, client.SetRedirectUris([]string{"https://client.example/callback"}))
	require.NoError(t, model.DB.Create(client).Error)
	router := gin.New()
	router.Use(OAuthCORS())
	router.PATCH("/api/resource", CORS(), func(c *gin.Context) { c.Status(http.StatusOK) })
	request := httptest.NewRequest(http.MethodOptions, "/api/resource", nil)
	request.Header.Set("Origin", "https://client.example")
	request.Header.Set("Access-Control-Request-Method", "PATCH")
	request.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type, x-api-key, anthropic-version, x-stainless-runtime")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assert.Equal(t, http.StatusNoContent, response.Code)
	assert.Equal(t, "https://client.example", response.Header().Get("Access-Control-Allow-Origin"))
	assert.Empty(t, response.Header().Get("Access-Control-Allow-Credentials"))
	assert.Contains(t, response.Header().Get("Access-Control-Allow-Methods"), "PATCH")
	assert.Contains(t, response.Header().Get("Access-Control-Allow-Headers"), "anthropic-version")
	assert.Contains(t, response.Header().Get("Access-Control-Allow-Headers"), "x-stainless-runtime")
	actual := httptest.NewRequest(http.MethodPatch, "/api/resource", nil)
	actual.Header.Set("Origin", "https://client.example")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, actual)
	assert.Equal(t, "https://client.example", response.Header().Get("Access-Control-Allow-Origin"), "legacy relay CORS must not overwrite registered OAuth origins")
	assert.Empty(t, response.Header().Get("Access-Control-Allow-Credentials"))
	require.NoError(t, model.DB.Model(client).Update("enabled", false).Error)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assert.Empty(t, response.Header().Get("Access-Control-Allow-Origin"), "disabled client must immediately lose origin allowance")
}
