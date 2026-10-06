package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthDashboardPermissionAndResourceBoundaries(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "profile:read profile:write account_security:read user:read relay:invoke"
	require.NoError(t, model.UpdateOauthClient(client))
	issue := func(scopes, resources []string) string {
		tokens, err := service.IssueOAuthTokens(client, user, scopes, resources, "")
		require.NoError(t, err)
		return tokens.AccessToken
	}
	read := issue([]string{"profile:read"}, []string{service.OAuthResourceDashboard})
	write := issue([]string{"profile:write"}, []string{service.OAuthResourceDashboard})
	wrongResource := issue([]string{"profile:read"}, []string{service.OAuthResourceRelay})
	security := issue([]string{"account_security:read"}, []string{service.OAuthResourceDashboard})
	router := gin.New()
	handler := func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"id": c.GetInt("id"), "group": c.GetString("group")})
	}
	router.GET("/api/user/self", middleware.UserAuth(), handler)
	router.PUT("/api/user/self", middleware.UserAuth(), handler)
	router.GET("/api/user/sessions", middleware.UserAuth(), handler)
	router.GET("/api/user/", middleware.AdminAuth(), handler)
	for _, test := range []struct {
		name, method, path, token string
		status                    int
		code                      string
	}{
		{"read own profile", http.MethodGet, "/api/user/self", read, http.StatusOK, ""},
		{"read cannot write", http.MethodPut, "/api/user/self", read, http.StatusForbidden, "OAUTH_INSUFFICIENT_SCOPE"},
		{"write is not implicit read", http.MethodGet, "/api/user/self", write, http.StatusForbidden, "OAUTH_INSUFFICIENT_SCOPE"},
		{"profile update direct", http.MethodPut, "/api/user/self", write, http.StatusOK, ""},
		{"relay audience cannot read dashboard", http.MethodGet, "/api/user/self", wrongResource, http.StatusUnauthorized, "OAUTH_INVALID_RESOURCE"},
		{"sessions require hosted flow", http.MethodGet, "/api/user/sessions", security, http.StatusForbidden, "OAUTH_HOSTED_ACTION_REQUIRED"},
		{"user role cannot enter admin", http.MethodGet, "/api/user/", read, http.StatusForbidden, "OAUTH_INSUFFICIENT_PRIVILEGE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, nil)
			request.Header.Set("Authorization", "Bearer "+test.token)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assert.Equal(t, test.status, response.Code, response.Body.String())
			var body struct {
				ID    int    `json:"id"`
				Group string `json:"group"`
				Code  string `json:"code"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
			assert.Equal(t, test.code, body.Code)
			if test.status == http.StatusOK {
				assert.Equal(t, user.Id, body.ID)
				assert.Equal(t, "default", body.Group)
			}
		})
	}
	// Authentication itself reloads current state; a changed group cannot keep
	// using the earlier grant to choose a previously accessible relay group.
	require.NoError(t, db.Model(user).Update("group", "restricted").Error)
	request := httptest.NewRequest(http.MethodGet, "/api/user/self", nil)
	request.Header.Set("Authorization", "Bearer "+read)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	assert.Contains(t, response.Body.String(), "OAUTH_INVALID_TOKEN")
}
