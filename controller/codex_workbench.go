package controller

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

// The runner is an operator-configured private service. Never inherit proxy
// environment variables or follow redirects with the service credential.
var codexWorkbenchClient = &http.Client{
	Transport: &http.Transport{
		DialContext:  (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns: 32, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 145 * time.Second,
		DisableCompression: true,
	},
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

// CodexWorkbenchProxy exposes only explicitly registered workbench operations.
// AdminAuth validates the current user/session before this second, session-only
// guard. API tokens and delegated OAuth tokens must never start host workloads.
func CodexWorkbenchProxy(c *gin.Context) {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	if !ok || c.GetInt("role") < common.RoleAdminUser {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "codex_session_required", "message": "请使用管理员账号登录后访问 Codex 工作台"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	runnerURL := strings.TrimSpace(os.Getenv("CODEX_RUNNER_URL"))
	key := strings.TrimSpace(os.Getenv("CODEX_RUNNER_KEY"))
	if keyFile := strings.TrimSpace(os.Getenv("CODEX_RUNNER_KEY_FILE")); keyFile != "" {
		data, err := os.ReadFile(keyFile)
		if err != nil || len(data) > 4096 {
			key = ""
		} else {
			key = strings.TrimSpace(string(data))
		}
	}
	target, err := url.Parse(runnerURL)
	configured := err == nil && target != nil && (target.Scheme == "http" || target.Scheme == "https") && target.Hostname() != "" && target.User == nil && target.RawQuery == "" && target.Fragment == "" && (target.Path == "" || target.Path == "/") && len(key) >= 32 && len(key) <= 4096 && !strings.ContainsAny(key, "\r\n")
	if !configured {
		if c.Request.Method == http.MethodGet && c.FullPath() == "/api/codex/status" {
			c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"available": false, "configured": false, "version": "", "reason": "Codex 工作台服务尚未配置", "models": []string{}, "efforts": []string{}, "defaultModel": "", "defaultEffort": "", "limits": gin.H{}, "capabilities": gin.H{}}})
		} else {
			c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "codex_unconfigured", "message": "Codex 工作台服务尚未配置"})
		}
		return
	}
	if !strings.HasPrefix(c.FullPath(), "/api/codex/") || !strings.HasPrefix(c.Request.URL.Path, "/api/codex/") {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	// Read a bounded body before contacting the runner so a chunked oversized
	// upload cannot leave a partially accepted operation behind.
	limit := int64(8 << 20)
	if c.FullPath() == "/api/codex/workspaces/:id/import" {
		limit = 26 << 20
	}
	if c.Request.ContentLength > limit {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"success": false, "code": "codex_body_too_large", "message": "请求文件过大"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		status := http.StatusBadRequest
		if int64(len(body)) > limit {
			status = http.StatusRequestEntityTooLarge
		}
		c.JSON(status, gin.H{"success": false, "code": "codex_invalid_body", "message": "无法读取请求或请求内容过大"})
		return
	}
	target.Path = strings.TrimPrefix(c.Request.URL.Path, "/api/codex")
	target.RawPath = ""
	target.RawQuery = c.Request.URL.RawQuery
	ctx, cancel := context.WithTimeout(c.Request.Context(), 150*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, c.Request.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "code": "codex_unavailable", "message": "Codex 工作台暂时不可用"})
		return
	}
	request.Header.Set("X-Codex-Runner-Key", key)
	request.Header.Set("X-Codex-Admin-Id", strconv.Itoa(identity.UserID))
	request.Header.Set("Content-Type", c.GetHeader("Content-Type"))
	request.Header.Set("Accept", "application/json, application/zip")
	response, err := codexWorkbenchClient.Do(request)
	if err != nil {
		if c.Request.Context().Err() != nil {
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "code": "codex_unavailable", "message": "Codex 工作台暂时不可用，请稍后重试"})
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "code": "codex_invalid_response", "message": "Codex 工作台返回了无效响应"})
		return
	}
	if response.ContentLength > 128<<20 {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "code": "codex_response_too_large", "message": "Codex 工作台响应超过大小限制"})
		return
	}
	for _, name := range []string{"Content-Type", "Content-Disposition"} {
		if value := response.Header.Get(name); value != "" {
			c.Header(name, value)
		}
	}
	c.Status(response.StatusCode)
	// The runner enforces project/export limits; retain a second response bound.
	_, _ = io.Copy(c.Writer, io.LimitReader(response.Body, 128<<20))
}
