package controller

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/console_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProbeApiNodes(t *testing.T) {
	previousApiInfo := console_setting.GetConsoleSetting().ApiInfo
	t.Cleanup(func() { console_setting.GetConsoleSetting().ApiInfo = previousApiInfo })

	// 可达节点:本地 HEAD 服务
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	// 不可达节点:先占用端口再关闭,保证连接被拒绝
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	deadPort := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	unreachableURL := fmt.Sprintf("http://127.0.0.1:%d", deadPort)

	// 不可达节点在前,可达节点在后,用于验证响应顺序与配置一致
	console_setting.GetConsoleSetting().ApiInfo = fmt.Sprintf(
		`[{"url": %q, "route": "dead", "description": "unreachable", "color": "blue"}, {"url": %q, "route": "local", "description": "local head", "color": "green"}]`,
		unreachableURL, server.URL,
	)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/api-nodes/probe", ProbeApiNodes)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/api-nodes/probe", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	var response struct {
		Success bool `json:"success"`
		Data    []struct {
			URL       string `json:"url"`
			LatencyMs int64  `json:"latency_ms"`
			Error     string `json:"error"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &response))
	assert.True(t, response.Success)
	require.Len(t, response.Data, 2)

	// 顺序与 api_info 配置一致
	assert.Equal(t, unreachableURL, response.Data[0].URL)
	assert.Equal(t, server.URL, response.Data[1].URL)

	// 不可达节点:error 非空,latency_ms 为 0
	assert.NotEqual(t, "", response.Data[0].Error)
	assert.Equal(t, int64(0), response.Data[0].LatencyMs)

	// 可达节点:latency_ms > 0,error 为空
	assert.Equal(t, "", response.Data[1].Error)
	assert.Greater(t, response.Data[1].LatencyMs, int64(0))
}
