package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodexCloudAndGitRoutesRequireAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	require.NotPanics(t, func() { setCodexWorkbenchRouter(engine.Group("/api")) })
	for _, operation := range []struct{ method, path string }{
		{http.MethodGet, "/github/pulls"},
		{http.MethodGet, "/github/pulls/fixture/repository/7"},
		{http.MethodGet, "/github/pulls/fixture/repository/7/context"},
		{http.MethodPost, "/github/pulls/fixture/repository/7/comments"},
		{http.MethodPost, "/github/pulls/fixture/repository/7/reviews"},
		{http.MethodGet, "/environments"},
		{http.MethodPost, "/environments"},
		{http.MethodGet, "/environments/fixture"},
		{http.MethodPatch, "/environments/fixture"},
		{http.MethodDelete, "/environments/fixture"},
		{http.MethodPost, "/environments/fixture/setup"},
		{http.MethodPost, "/environments/fixture/publish"},
		{http.MethodPost, "/environments/fixture/tasks"},
		{http.MethodGet, "/workspaces/fixture/git/status"},
		{http.MethodPost, "/workspaces/fixture/git/commit"},
		{http.MethodPost, "/workspaces/fixture/git/push"},
		{http.MethodPost, "/workspaces/fixture/git/pull-request"},
	} {
		t.Run(operation.method+operation.path, func(t *testing.T) {
			request := httptest.NewRequest(operation.method, "/api/codex"+operation.path, strings.NewReader(`{}`))
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusUnauthorized, response.Code)
		})
	}
	for _, operation := range []struct{ method, path string }{
		{http.MethodPut, "/github/pulls/fixture/repository/7"},
		{http.MethodPost, "/github/pulls/fixture/repository/7/merge"},
		{http.MethodGet, "/github/pulls/fixture/repository/7/reviews"},
		{http.MethodPost, "/environments/fixture/shell"},
		{http.MethodGet, "/environments/fixture/secrets"},
		{http.MethodDelete, "/integrations/github"},
		{http.MethodPost, "/workspaces/fixture/git/exec"},
		{http.MethodGet, "/workspaces/fixture/git/push"},
	} {
		request := httptest.NewRequest(operation.method, "/api/codex"+operation.path, nil)
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		assert.Equal(t, http.StatusNotFound, response.Code, operation.path)
	}
}
