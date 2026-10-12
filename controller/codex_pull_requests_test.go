package controller

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodexPullRequestProxyPreservesOwnerScopeAndExplicitActions(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	operations := []struct{ method, path, body string }{
		{http.MethodGet, "/github/pulls?repository=fixture%2Frepo&state=open&search=fix&page=2&limit=30", ""},
		{http.MethodGet, "/github/pulls/fixture/repo/7", ""},
		{http.MethodGet, "/github/pulls/fixture/repo/7/context?instruction=Check%20tests", ""},
		{http.MethodPost, "/github/pulls/fixture/repo/7/comments", `{"body":"Please add a test.","confirmed":true}`},
		{http.MethodPost, "/github/pulls/fixture/repo/7/reviews", `{"body":"The test now passes.","event":"APPROVE","commitId":"0123456789012345678901234567890123456789","confirmed":true}`},
	}
	var observed []string
	var bodies []string
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed = append(observed, r.Method+" "+r.URL.RequestURI())
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		bodies = append(bodies, string(body))
		assert.Equal(t, fmt.Sprint(fixture.adminID), r.Header.Get("X-Codex-Admin-Id"))
		assert.Equal(t, codexTestRunnerKey, r.Header.Get("X-Codex-Runner-Key"))
		assert.Equal(t, "0", r.Header.Get("X-Codex-GitHub-Generation"))
		assert.Empty(t, r.Header.Get("X-Codex-GitHub-Token"))
		assert.Empty(t, r.Header.Get("X-Codex-Model-Config"))
		assert.Empty(t, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	var expected, expectedBodies []string
	for _, operation := range operations {
		for _, token := range []string{"", fixture.adminPAT, fixture.commonToken} {
			request, response := fixture.request(operation.method, "/api/codex"+operation.path, token, strings.NewReader(operation.body))
			fixture.engine.ServeHTTP(response, request)
			assert.Contains(t, []int{http.StatusUnauthorized, http.StatusForbidden}, response.Code)
		}
		request, response := fixture.request(operation.method, "/api/codex"+operation.path, fixture.adminToken, strings.NewReader(operation.body))
		request.Header.Set("X-Codex-Admin-Id", "99999")
		request.Header.Set("X-Codex-GitHub-Token", "browser-secret")
		request.Header.Set("X-Codex-GitHub-Generation", "99999")
		fixture.engine.ServeHTTP(response, request)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		expected = append(expected, operation.method+" "+operation.path)
		expectedBodies = append(expectedBodies, operation.body)
	}
	assert.Equal(t, expected, observed)
	assert.Equal(t, expectedBodies, bodies)
}

func TestCodexPullRequestProxyRequiresExplicitSubmissionConfirmation(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	var calls atomic.Int32
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	for _, action := range []string{"comments", "reviews"} {
		for _, body := range []string{"", `{}`, `{"body":"review"}`, `{"confirmed":false}`, `{"confirmed":null}`, `{"confirmed":"true"}`} {
			request, response := fixture.request(http.MethodPost, "/api/codex/github/pulls/fixture/repo/7/"+action, fixture.adminToken, strings.NewReader(body))
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusBadRequest, response.Code, body)
			assert.Contains(t, response.Body.String(), "github_confirmation_required")
		}
	}
	assert.Zero(t, calls.Load(), "unconfirmed comments and reviews must never contact the runner")
}
