package controller

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type codexTestTransport func(*http.Request) (*http.Response, error)

func (transport codexTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestCodexTaskSubmissionSurvivesBrowserDisconnect(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}))
	previousRatios := ratio_setting.GetGroupRatioCopy()
	t.Cleanup(func() {
		data, err := common.Marshal(previousRatios)
		require.NoError(t, err)
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(string(data)))
	})
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
	require.NoError(t, model.DB.Create(&model.Channel{Id: 991, Type: constant.ChannelTypeOpenAI, Name: "Offline task model", Status: common.ChannelStatusEnabled}).Error)
	require.NoError(t, model.DB.Create(&model.Ability{Group: "default", Model: "fixture-coding-model", ChannelId: 991, Enabled: true}).Error)
	t.Setenv("CODEX_RUNNER_URL", "http://offline-runner.invalid")
	previousClient := codexWorkbenchClient
	t.Cleanup(func() { codexWorkbenchClient = previousClient })
	for _, path := range []string{"/workspaces/fixture/turns", "/environments/fixture/tasks", "/github/pulls/example/repo/1/task"} {
		t.Run(path, func(t *testing.T) {
			parent, cancel := context.WithCancel(context.WithValue(context.Background(), common.RequestIdKey, "offline-task-request"))
			defer cancel()
			codexWorkbenchClient = &http.Client{Transport: codexTestTransport(func(upstream *http.Request) (*http.Response, error) {
				assert.Equal(t, "offline-task-request", upstream.Context().Value(common.RequestIdKey))
				deadline, bounded := upstream.Context().Deadline()
				assert.True(t, bounded, "starting a task must remain bounded")
				assert.LessOrEqual(t, time.Until(deadline), 150*time.Second)
				assert.NotEmpty(t, upstream.Header.Get("X-Codex-Model-Config"))
				body, err := io.ReadAll(upstream.Body)
				require.NoError(t, err)
				assert.Contains(t, string(body), `"prompt":"Continue offline"`)
				cancel() // The browser disconnects after the complete, authorized body is received.
				if err := upstream.Context().Err(); err != nil {
					return nil, err
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"success":true,"data":{"accepted":true}}`))}, nil
			})}
			request, response := fixture.request(http.MethodPost, "/api/codex"+path, fixture.adminToken,
				strings.NewReader(`{"prompt":"Continue offline","model":"fixture-coding-model","group":"default","requestId":"offline-task"}`))
			fixture.engine.ServeHTTP(response, request.WithContext(parent))
			assert.Equal(t, http.StatusOK, response.Code)
			assert.Contains(t, response.Body.String(), `"accepted":true`, "disconnecting must not cancel task acceptance")
		})
	}
	t.Run("reads still follow browser cancellation", func(t *testing.T) {
		parent, cancel := context.WithCancel(context.Background())
		defer cancel()
		codexWorkbenchClient = &http.Client{Transport: codexTestTransport(func(upstream *http.Request) (*http.Response, error) {
			cancel()
			assert.ErrorIs(t, upstream.Context().Err(), context.Canceled)
			return nil, upstream.Context().Err()
		})}
		request, response := fixture.request(http.MethodGet, "/api/codex/environment", fixture.adminToken, nil)
		fixture.engine.ServeHTTP(response, request.WithContext(parent))
		assert.Empty(t, response.Body.String())
	})
}

func TestCodexRunnerErrorsPreserveResponseAndLogOnlySafeDiagnostics(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	previousClient := codexWorkbenchClient
	common.LogWriterMu.Lock()
	previousWriter := gin.DefaultErrorWriter
	common.LogWriterMu.Unlock()
	t.Cleanup(func() {
		codexWorkbenchClient = previousClient
		common.LogWriterMu.Lock()
		gin.DefaultErrorWriter = previousWriter
		common.LogWriterMu.Unlock()
	})
	t.Setenv("CODEX_RUNNER_URL", "http://offline-runner.invalid")
	for _, test := range []struct{ code, logged string }{
		{"invalid_effort", "invalid_effort"},
		{"environment_workspace_in_use", "environment_workspace_in_use"},
		{"private-upstream-secret", "unknown"},
	} {
		t.Run(test.code, func(t *testing.T) {
			var logs bytes.Buffer
			common.LogWriterMu.Lock()
			gin.DefaultErrorWriter = &logs
			common.LogWriterMu.Unlock()
			wire, err := common.Marshal(map[string]any{"success": false, "code": test.code, "message": "private-prompt-and-token"})
			require.NoError(t, err)
			codexWorkbenchClient = &http.Client{Transport: codexTestTransport(func(request *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusBadRequest, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(wire))}, nil
			})}
			request, response := fixture.request(http.MethodGet, "/api/codex/workspaces/private-project/events?private-query=secret", fixture.adminToken, nil)
			fixture.engine.ServeHTTP(response, request)
			assert.Equal(t, http.StatusBadRequest, response.Code)
			assert.Equal(t, string(wire), response.Body.String())
			assert.Contains(t, logs.String(), "route=/api/codex/workspaces/:id/events")
			assert.Contains(t, logs.String(), "status=400")
			assert.Contains(t, logs.String(), "code="+test.logged)
			assert.NotContains(t, logs.String(), "private-")
			assert.NotContains(t, logs.String(), fixture.adminToken)
			assert.NotContains(t, logs.String(), codexTestRunnerKey)
		})
	}
}
