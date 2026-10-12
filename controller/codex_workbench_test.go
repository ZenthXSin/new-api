package controller

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const codexTestRunnerKey = "offline-codex-runner-service-key-32-characters"

type codexProxyFixture struct {
	engine      *gin.Engine
	adminToken  string
	commonToken string
	adminPAT    string
	adminID     int
	adminSID    string
}

func newCodexProxyFixture(t *testing.T) codexProxyFixture {
	t.Helper()
	previousDB, previousRedis, previousSecret := model.DB, common.RedisEnabled, common.SessionSecret
	previousType := common.MainDatabaseType()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.CodexGitHubConnection{}, &model.CodexUserConfig{}, &model.SubscriptionPlan{}, &model.UserSubscription{}))
	model.DB, common.RedisEnabled, common.SessionSecret = db, false, "codex-proxy-isolated-session-secret"
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		model.DB, common.RedisEnabled, common.SessionSecret = previousDB, previousRedis, previousSecret
		common.SetMainDatabaseType(previousType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
	t.Setenv("CODEX_RUNNER_URL", "")
	t.Setenv("CODEX_RUNNER_KEY", codexTestRunnerKey)
	t.Setenv("CODEX_RUNNER_KEY_FILE", "")
	fixture := codexProxyFixture{adminPAT: "codex-isolated-administrator-pat"}
	for _, role := range []int{common.RoleAdminUser, common.RoleCommonUser} {
		user := &model.User{Username: fmt.Sprintf("codex-proxy-%d", role), Password: "unused", Role: role,
			Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: fmt.Sprintf("codex-aff-%d", role)}
		if role == common.RoleAdminUser {
			user.AccessToken = &fixture.adminPAT
		}
		require.NoError(t, db.Create(user).Error)
		sid := fmt.Sprintf("codex-proxy-session-%d", role)
		now := time.Now().Unix()
		session := &model.UserSession{SID: sid, UserID: user.Id, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "unused-" + sid, LoginMethod: "password",
			CreatedAt: now, LastActiveAt: now, ExpiresAt: now + 3600}
		require.NoError(t, model.CreateUserSession(session))
		token, _, err := service.IssueAccessToken(service.AuthIdentity{UserID: user.Id, SessionID: sid, UserAuthVersion: 1, SessionVersion: 1})
		require.NoError(t, err)
		if role == common.RoleAdminUser {
			fixture.adminToken, fixture.adminSID, fixture.adminID = token, sid, user.Id
		} else {
			fixture.commonToken = token
		}
	}
	gin.SetMode(gin.TestMode)
	fixture.engine = gin.New()
	group := fixture.engine.Group("/api/codex", middleware.CodexWorkbenchAuth(), func(c *gin.Context) {
		// Isolate proxy/auth assertions from the unrelated asynchronous audit sink.
		c.Set(string(constant.ContextKeyAuditLogged), true)
		c.Next()
	})
	group.GET("/github/pulls", CodexWorkbenchProxy)
	group.GET("/github/pulls/:owner/:repo/:number", CodexWorkbenchProxy)
	group.GET("/github/pulls/:owner/:repo/:number/context", CodexWorkbenchProxy)
	group.POST("/github/pulls/:owner/:repo/:number/task", CodexWorkbenchProxy)
	group.POST("/github/pulls/:owner/:repo/:number/comments", CodexWorkbenchProxy)
	group.POST("/github/pulls/:owner/:repo/:number/reviews", CodexWorkbenchProxy)
	group.GET("/status", CodexWorkbenchProxy)
	group.GET("/tasks", CodexWorkbenchProxy)
	group.GET("/environment", CodexWorkbenchProxy)
	group.POST("/environment/start", CodexWorkbenchProxy)
	group.POST("/environment/stop", CodexWorkbenchProxy)
	group.GET("/environments", CodexWorkbenchProxy)
	group.POST("/environments", CodexWorkbenchProxy)
	group.GET("/environments/:id", CodexWorkbenchProxy)
	group.PATCH("/environments/:id", CodexWorkbenchProxy)
	group.DELETE("/environments/:id", CodexWorkbenchProxy)
	group.POST("/environments/:id/setup", CodexWorkbenchProxy)
	group.POST("/environments/:id/publish", CodexWorkbenchProxy)
	group.POST("/environments/:id/tasks", CodexWorkbenchProxy)
	group.GET("/workspaces", CodexWorkbenchProxy)
	group.POST("/workspaces", CodexWorkbenchProxy)
	group.GET("/workspaces/:id/file", CodexWorkbenchProxy)
	group.GET("/workspaces/:id/download", CodexWorkbenchProxy)
	group.PUT("/workspaces/:id/file", CodexWorkbenchProxy)
	group.GET("/workspaces/:id/events", CodexWorkbenchProxy)
	group.GET("/workspaces/:id/export", CodexWorkbenchProxy)
	group.POST("/workspaces/:id/import", CodexWorkbenchProxy)
	group.POST("/workspaces/:id/upload", CodexWorkbenchProxy)
	group.GET("/workspaces/:id/repository", CodexWorkbenchProxy)
	group.POST("/workspaces/:id/repository/checkout", CodexWorkbenchProxy)
	group.POST("/workspaces/:id/turns", CodexWorkbenchProxy)
	group.GET("/workspaces/:id/git/status", CodexWorkbenchProxy)
	group.POST("/workspaces/:id/git/commit", CodexWorkbenchProxy)
	group.POST("/workspaces/:id/git/push", CodexWorkbenchProxy)
	group.POST("/workspaces/:id/git/pull-request", CodexWorkbenchProxy)
	return fixture
}

func TestCodexTaskAndRepositoryProxyPreservesSessionScopeAndInputs(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var paths, bodies []string
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, fmt.Sprint(fixture.adminID), r.Header.Get("X-Codex-Admin-Id"))
		assert.Equal(t, codexTestRunnerKey, r.Header.Get("X-Codex-Runner-Key"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		paths = append(paths, r.URL.RequestURI())
		bodies = append(bodies, string(body))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	operations := []struct{ method, path, body string }{
		{http.MethodGet, "/api/codex/tasks?query=project&archived=false&limit=20&offset=2", ""},
		{http.MethodGet, "/api/codex/workspaces/fixture/repository", ""},
		{http.MethodPost, "/api/codex/workspaces/fixture/repository/checkout", `{"branch":"feature/review","remote":"origin"}`},
	}
	for _, operation := range operations {
		for _, token := range []string{"", fixture.adminPAT, fixture.commonToken} {
			request, response := fixture.request(operation.method, operation.path, token, strings.NewReader(operation.body))
			fixture.engine.ServeHTTP(response, request)
			assert.Contains(t, []int{http.StatusUnauthorized, http.StatusForbidden}, response.Code)
		}
		request, response := fixture.request(operation.method, operation.path, fixture.adminToken, strings.NewReader(operation.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Codex-Admin-Id", "999999")
		fixture.engine.ServeHTTP(response, request)
		assert.Equal(t, http.StatusOK, response.Code)
	}
	assert.Equal(t, []string{"/tasks?query=project&archived=false&limit=20&offset=2", "/workspaces/fixture/repository", "/workspaces/fixture/repository/checkout"}, paths)
	assert.Equal(t, []string{"", "", `{"branch":"feature/review","remote":"origin"}`}, bodies)
}

func (fixture codexProxyFixture) request(method, target, token string, body io.Reader) (*http.Request, *httptest.ResponseRecorder) {
	request := httptest.NewRequest(method, target, body)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request, httptest.NewRecorder()
}

func TestCodexWorkbenchRequiresCurrentAdministratorBrowserSession(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var calls atomic.Int32
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"success":true,"data":{"available":true}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	for _, test := range []struct {
		name, token string
		status      int
	}{
		{"anonymous", "", http.StatusUnauthorized},
		{"ordinary user session", fixture.commonToken, http.StatusForbidden},
		{"administrator PAT", fixture.adminPAT, http.StatusForbidden},
		{"invalid delegated OAuth credential", "nao_invalid-local-fixture", http.StatusUnauthorized},
		{"administrator browser session", fixture.adminToken, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, response := fixture.request(http.MethodGet, "/api/codex/status", test.token, nil)
			request.Header.Set("X-Codex-Admin-Id", "999")
			request.Header.Set("X-Codex-Runner-Key", codexTestRunnerKey)
			request.Header.Set("X-Auth-Session", fixture.adminSID)
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, test.status, response.Code, response.Body.String())
		})
	}
	assert.Equal(t, int32(1), calls.Load(), "rejected identities must never reach the runtime")
	revoked, err := model.RevokeUserSession(fixture.adminID, fixture.adminSID, "offline-test")
	require.NoError(t, err)
	require.True(t, revoked)
	request, response := fixture.request(http.MethodGet, "/api/codex/workspaces", fixture.adminToken, nil)
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	assert.Equal(t, int32(1), calls.Load(), "a revoked session cannot continue using the workbench")
}

func TestCodexUserEnvironmentOperationsRequireAdministratorSession(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var calls atomic.Int32
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		assert.Equal(t, fmt.Sprint(fixture.adminID), r.Header.Get("X-Codex-Admin-Id"))
		assert.Equal(t, codexTestRunnerKey, r.Header.Get("X-Codex-Runner-Key"))
		assert.Empty(t, r.Header.Get("Authorization"))
		assert.Contains(t, []string{"/environment", "/environment/start", "/environment/stop"}, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"environment":{"status":"stopped"}}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	for _, operation := range []struct{ method, path string }{
		{http.MethodGet, "/environment"}, {http.MethodPost, "/environment/start"}, {http.MethodPost, "/environment/stop"},
	} {
		t.Run(operation.path, func(t *testing.T) {
			for _, identity := range []struct {
				token  string
				status int
			}{
				{"", http.StatusUnauthorized}, {fixture.commonToken, http.StatusForbidden},
				{fixture.adminPAT, http.StatusForbidden}, {fixture.adminToken, http.StatusOK},
			} {
				request, response := fixture.request(operation.method, "/api/codex"+operation.path, identity.token, strings.NewReader(`{}`))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("X-Codex-Admin-Id", "999")
				fixture.engine.ServeHTTP(response, request)
				assert.Equal(t, identity.status, response.Code, response.Body.String())
				if identity.status == http.StatusOK {
					assert.Contains(t, response.Body.String(), `"status":"stopped"`)
				}
			}
		})
	}
	assert.Equal(t, int32(3), calls.Load(), "only the administrator session may reach the personal environment")
}

func TestCodexWorkbenchProxyUsesTrustedOwnerAndServiceCredential(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	type capturedRequest struct {
		method, target, body string
		headers              http.Header
	}
	captured := make(chan capturedRequest, 1)
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		captured <- capturedRequest{r.Method, r.URL.RequestURI(), string(body), r.Header.Clone()}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "runner-secret=must-not-leak")
		w.Header().Set("Authorization", "must-not-leak")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"success":false,"code":"file_conflict"}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	body := `{"path":"src/index.ts","content":"你好","expectedHash":"hash"}`
	request, response := fixture.request(http.MethodPut, "/api/codex/workspaces/fixture/file?path=src%2Findex.ts&after=12", fixture.adminToken, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("Cookie", "new_api_refresh=must-not-forward")
	request.Header.Set("X-Codex-Admin-Id", "999")
	request.Header.Set("X-Codex-Runner-Key", "attacker-provided-key")
	request.Header.Set("Origin", "https://dashboard.example")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	request.Header.Set("X-Forwarded-For", "untrusted-address")
	fixture.engine.ServeHTTP(response, request)
	require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	assert.JSONEq(t, `{"success":false,"code":"file_conflict"}`, response.Body.String())
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	assert.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
	assert.Empty(t, response.Header().Get("Set-Cookie"))
	assert.Empty(t, response.Header().Get("Authorization"))
	observed := <-captured
	assert.Equal(t, http.MethodPut, observed.method)
	assert.Equal(t, "/workspaces/fixture/file?path=src%2Findex.ts&after=12", observed.target)
	assert.Equal(t, body, observed.body)
	assert.Equal(t, fmt.Sprint(fixture.adminID), observed.headers.Get("X-Codex-Admin-Id"))
	assert.Equal(t, codexTestRunnerKey, observed.headers.Get("X-Codex-Runner-Key"))
	assert.Equal(t, "application/json; charset=utf-8", observed.headers.Get("Content-Type"))
	for _, name := range []string{"Authorization", "Cookie", "Origin", "Sec-Fetch-Site", "X-Forwarded-For"} {
		assert.Empty(t, observed.headers.Get(name), "untrusted or browser header forwarded: %s", name)
	}
}

func TestCodexWorkbenchDoesNotFollowRuntimeRedirects(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(target.Close)
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	request, response := fixture.request(http.MethodGet, "/api/codex/status", fixture.adminToken, nil)
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusBadGateway, response.Code)
	assert.Contains(t, response.Body.String(), "codex_invalid_response")
	assert.Empty(t, response.Header().Get("Location"))
	assert.Equal(t, int32(0), redirected.Load(), "service credentials must not follow a redirect")
}

func TestCodexWorkbenchRejectsOversizedBodiesBeforeRuntimeContact(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var calls atomic.Int32
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	for _, test := range []struct {
		name, target string
		size         int
		chunked      bool
	}{
		{"JSON declared length", "/api/codex/workspaces", (8 << 20) + 1, false},
		{"JSON chunked body", "/api/codex/workspaces", (8 << 20) + 1, true},
		{"ZIP declared length", "/api/codex/workspaces/fixture/import", (26 << 20) + 1, false},
		{"File declared length", "/api/codex/workspaces/fixture/upload?path=photo.png", (25 << 20) + 1, false},
		{"File chunked body", "/api/codex/workspaces/fixture/upload?path=photo.png", (25 << 20) + 1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, response := fixture.request(http.MethodPost, test.target, fixture.adminToken, bytes.NewReader(make([]byte, test.size)))
			if test.chunked {
				request.ContentLength = -1
			}
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusRequestEntityTooLarge, response.Code)
		})
	}
	assert.Equal(t, int32(0), calls.Load())
	// A ZIP larger than the ordinary JSON bound remains valid for the upload route.
	request, response := fixture.request(http.MethodPost, "/api/codex/workspaces/fixture/import", fixture.adminToken, bytes.NewReader(make([]byte, (8<<20)+1)))
	request.Header.Set("Content-Type", "application/zip")
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, int32(1), calls.Load())
}

func TestCodexWorkbenchUploadsBinaryFilesWithoutJSONTransformation(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	payload := bytes.Repeat([]byte{0, 255, 128, 0x89}, (9<<20)/4)
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "application/octet-stream", r.Header.Get("Content-Type"))
		assert.Equal(t, "assets/照片.png", r.URL.Query().Get("path"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		assert.Equal(t, payload, body)
		_, _ = w.Write([]byte(`{"success":true,"data":{"path":"assets/照片.png"}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	request, response := fixture.request(http.MethodPost, "/api/codex/workspaces/fixture/upload?path=assets%2F%E7%85%A7%E7%89%87.png", fixture.adminToken, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/octet-stream")
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
}

type codexFailingReader struct{}

func (codexFailingReader) Read([]byte) (int, error) {
	return 0, errors.New("private read failure detail")
}

func TestCodexWorkbenchBodyReadFailureIsSafe(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	t.Setenv("CODEX_RUNNER_URL", "http://127.0.0.1:1")
	request, response := fixture.request(http.MethodPost, "/api/codex/workspaces", fixture.adminToken, codexFailingReader{})
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusBadRequest, response.Code)
	assert.Contains(t, response.Body.String(), "codex_invalid_body")
	assert.NotContains(t, response.Body.String(), "private read failure")
}

func TestCodexWorkbenchUnconfiguredStatusAndProtectedOperations(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	for _, endpoint := range []string{"", "file:///tmp/runner", "http://user:password@127.0.0.1", "http://127.0.0.1/prefix", "http://127.0.0.1?key=secret"} {
		t.Run(endpoint, func(t *testing.T) {
			t.Setenv("CODEX_RUNNER_URL", endpoint)
			request, response := fixture.request(http.MethodGet, "/api/codex/status", fixture.adminToken, nil)
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusOK, response.Code)
			var body struct {
				Success bool `json:"success"`
				Data    struct {
					Available, Configured bool
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
			assert.True(t, body.Success)
			assert.False(t, body.Data.Available)
			assert.False(t, body.Data.Configured)
			request, response = fixture.request(http.MethodPost, "/api/codex/workspaces", fixture.adminToken, strings.NewReader(`{"name":"test"}`))
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusServiceUnavailable, response.Code)
			assert.NotContains(t, response.Body.String(), endpoint+"password")
		})
	}
}

func TestCodexWorkbenchKeyFileAndDownloadHeaders(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	keyPath := filepath.Join(t.TempDir(), "runner-key")
	fileKey := "offline-file-specific-runner-key-over-32-characters"
	require.NoError(t, os.WriteFile(keyPath, []byte(fileKey+"\n"), 0600))
	t.Setenv("CODEX_RUNNER_KEY_FILE", keyPath)
	var keySeen string
	archive := []byte{'P', 'K', 3, 4, 0, 1, 2, 3}
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keySeen = r.Header.Get("X-Codex-Runner-Key")
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="codex-project.zip"`)
		_, _ = w.Write(archive)
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	request, response := fixture.request(http.MethodGet, "/api/codex/workspaces/fixture/export", fixture.adminToken, nil)
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, archive, response.Body.Bytes())
	assert.Equal(t, fileKey, keySeen)
	assert.Equal(t, "application/zip", response.Header().Get("Content-Type"))
	assert.Equal(t, `attachment; filename="codex-project.zip"`, response.Header().Get("Content-Disposition"))
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.NoError(t, os.Remove(keyPath))
	request, response = fixture.request(http.MethodGet, "/api/codex/workspaces", fixture.adminToken, nil)
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code, "a missing configured secret file must fail closed")
}

func TestCodexWorkbenchRejectsOversizedRuntimeDownload(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="large.zip"`)
		w.Header().Set("Content-Length", fmt.Sprint((128<<20)+1))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("PK"))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	request, response := fixture.request(http.MethodGet, "/api/codex/workspaces/fixture/export", fixture.adminToken, nil)
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusBadGateway, response.Code)
	assert.Equal(t, "application/json; charset=utf-8", response.Header().Get("Content-Type"))
	assert.Empty(t, response.Header().Get("Content-Disposition"))
}

func TestCodexWorkbenchDownloadsArtifactBytesAndPreservesHeaders(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	artifact := bytes.Repeat([]byte{'P', 'K', 0, 255}, 4<<20)
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/workspaces/fixture/download", r.URL.Path)
		assert.Equal(t, "dist/Phira.ipa", r.URL.Query().Get("path"))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprint(len(artifact)))
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''Phira.ipa")
		_, _ = w.Write(artifact)
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	request, response := fixture.request(http.MethodGet, "/api/codex/workspaces/fixture/download?path=dist%2FPhira.ipa", fixture.adminToken, nil)
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, artifact, response.Body.Bytes())
	assert.Equal(t, fmt.Sprint(len(artifact)), response.Header().Get("Content-Length"))
	assert.Equal(t, "application/octet-stream", response.Header().Get("Content-Type"))
	assert.Contains(t, response.Header().Get("Content-Disposition"), "Phira.ipa")
}

func TestCodexWorkbenchKeepsDownloadLimitSeparateFromExportLimit(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	for _, route := range []string{"download", "export"} {
		t.Run(route, func(t *testing.T) {
			runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", fmt.Sprint((1<<30)+1))
				w.Header().Set("Content-Type", "application/octet-stream")
				_, _ = w.Write([]byte("PK"))
			}))
			t.Cleanup(runner.Close)
			t.Setenv("CODEX_RUNNER_URL", runner.URL)
			request, response := fixture.request(http.MethodGet, "/api/codex/workspaces/fixture/"+route, fixture.adminToken, nil)
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusBadGateway, response.Code)
			assert.Empty(t, response.Header().Get("Content-Disposition"))
		})
	}
}
