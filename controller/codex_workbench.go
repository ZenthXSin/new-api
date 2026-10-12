package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/service"
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
// CodexWorkbenchAuth validates the current user/session and explicit grant.
// This second guard accepts only its trusted owner policy. API tokens and delegated OAuth tokens must never start host workloads.
func CodexWorkbenchProxy(c *gin.Context) {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	policy, permitted := middleware.GetCodexWorkbenchPolicy(c)
	if !ok || !permitted {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "codex_session_required", "message": "请使用已开通 Codex 的账号登录后访问工作台"})
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
	if !codexWorkbenchPathMatches(c.FullPath(), c.Request.URL.Path) {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	// Read a bounded body before contacting the runner so a chunked oversized
	// upload cannot leave a partially accepted operation behind.
	limit := int64(8 << 20)
	if c.FullPath() == "/api/codex/workspaces/:id/import" {
		limit = 26 << 20
	}
	if c.FullPath() == "/api/codex/workspaces/:id/upload" {
		limit = 25 << 20
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
	if (c.Request.Method == http.MethodPost || c.Request.Method == http.MethodPut || c.Request.Method == http.MethodPatch) &&
		c.FullPath() != "/api/codex/workspaces/:id/import" && c.FullPath() != "/api/codex/workspaces/:id/upload" && len(body) > 0 {
		var object map[string]interface{}
		if err := common.DecodeJsonObjectStrict(bytes.NewReader(body), &object); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "code": "codex_invalid_body", "message": "请求内容必须为有效的 JSON 对象"})
			return
		}
	}
	if c.Request.Method == http.MethodPost && c.FullPath() == "/api/codex/workspaces" && !policy.AllowHost {
		var input map[string]interface{}
		_ = common.Unmarshal(body, &input)
		if _, requested := input["host"]; requested {
			c.JSON(http.StatusForbidden, gin.H{"success": false, "code": "host_admin_required", "message": "只有管理员可以使用主机执行模式"})
			return
		}
	}
	if c.Request.Method == http.MethodPost && (c.FullPath() == "/api/codex/github/pulls/:owner/:repo/:number/comments" ||
		c.FullPath() == "/api/codex/github/pulls/:owner/:repo/:number/reviews") {
		var input struct {
			Confirmed bool `json:"confirmed"`
		}
		if common.Unmarshal(body, &input) != nil || !input.Confirmed {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "code": "github_confirmation_required", "message": "请确认后再向 GitHub 提交评论或评审"})
			return
		}
	}
	target.Path = strings.TrimPrefix(c.Request.URL.Path, "/api/codex")
	target.RawPath = ""
	target.RawQuery = c.Request.URL.RawQuery
	requestContext := c.Request.Context()
	if c.Request.Method == http.MethodPost {
		switch c.FullPath() {
		case "/api/codex/workspaces/:id/turns", "/api/codex/environments/:id/tasks", "/api/codex/github/pulls/:owner/:repo/:number/task":
			// A complete, authenticated submission belongs to the server. Closing
			// the browser must not cancel startup; explicit interrupt stays separate.
			requestContext = context.WithoutCancel(requestContext)
		}
	}
	responseLimit := int64(128 << 20)
	timeout := 150 * time.Second
	if c.FullPath() == "/api/codex/workspaces/:id/download" {
		responseLimit = 1 << 30
		timeout = 310 * time.Second
	}
	ctx, cancel := context.WithTimeout(requestContext, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, c.Request.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "code": "codex_unavailable", "message": "Codex 工作台暂时不可用"})
		return
	}
	request.Header.Set("X-Codex-Runner-Key", key)
	request.Header.Set("X-Codex-Admin-Id", strconv.Itoa(identity.UserID))
	policyJSON, err := common.Marshal(policy)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "codex_policy_unavailable", "message": "无法读取 Codex 使用权限，请稍后重试"})
		return
	}
	request.Header.Set("X-Codex-User-Policy", base64.RawURLEncoding.EncodeToString(policyJSON))
	toolsToken, err := service.IssueCodexToolsToken(identity)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "code": "codex_session_required", "message": "请重新登录后使用 Codex"})
		return
	}
	request.Header.Set("X-Codex-Tools-Token", toolsToken)
	request.Header.Set("Content-Type", c.GetHeader("Content-Type"))
	request.Header.Set("Accept", "application/json, application/zip")
	if err := codexAttachModelCredential(request, identity, body); err != nil {
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("Codex request rejected owner=%d route=%s status=400 stage=model_authorization code=codex_model_unavailable", identity.UserID, c.FullPath()))
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "code": "codex_model_unavailable", "message": "当前账号无法使用所选分组或模型，请刷新模型列表后重试"})
		return
	}
	if err := codexAttachGitHubCredential(request, identity.UserID); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "github_credentials_unavailable", "message": "无法读取 GitHub 授权，请重新连接后重试"})
		return
	}
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
	if response.ContentLength > responseLimit {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "code": "codex_response_too_large", "message": "Codex 工作台响应超过大小限制"})
		return
	}
	var responseBody io.Reader = response.Body
	if response.StatusCode >= 400 {
		// Keep diagnostics bounded and omit upstream messages, prompts, paths,
		// query strings and credentials. Unknown codes may contain private text.
		prefix, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		responseBody = io.MultiReader(bytes.NewReader(prefix), response.Body)
		var failure struct {
			Code string `json:"code"`
		}
		_ = common.Unmarshal(prefix, &failure)
		code := "unknown"
		switch failure.Code {
		case "invalid_prompt", "invalid_request_id", "invalid_model", "invalid_effort", "invalid_mode", "invalid_turn", "invalid_busy_action", "invalid_queue", "invalid_model_credentials",
			"environment_workspace_in_use", "workspace_busy", "workspace_archived", "conversation_archived", "not_found", "conversation_not_found", "idempotency_conflict",
			"environment_busy", "environment_setup_failed", "environment_publish_failed", "runtime_start_failed", "runtime_stopped", "runtime_timeout", "internal_error", "active_limit", "task_start_failed", "history_limit", "storage_unavailable", "workspace_storage_limit", "disk_space_low":
			code = failure.Code
		}
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("Codex request rejected owner=%d route=%s status=%d stage=runner code=%s", identity.UserID, c.FullPath(), response.StatusCode, code))
	}
	for _, name := range []string{"Content-Type", "Content-Disposition", "Content-Length"} {
		if value := response.Header.Get(name); value != "" {
			c.Header(name, value)
		}
	}
	c.Status(response.StatusCode)
	// The runner enforces project/export limits; retain a second response bound.
	_, _ = io.Copy(c.Writer, io.LimitReader(responseBody, responseLimit))
}

// A registered parameter must remain one literal path segment. In particular,
// decoding an escaped slash or dot segment must never select another private
// runner endpoint while carrying the trusted service credential.
func codexWorkbenchPathMatches(pattern, path string) bool {
	if !strings.HasPrefix(pattern, "/api/codex/") || !strings.HasPrefix(path, "/api/codex/") {
		return false
	}
	registered, actual := strings.Split(pattern, "/"), strings.Split(path, "/")
	if len(registered) != len(actual) {
		return false
	}
	for index, segment := range actual {
		if strings.HasPrefix(registered[index], ":") {
			if segment == "" || segment == "." || segment == ".." || len(segment) > 512 || strings.ContainsAny(segment, "\\%") {
				return false
			}
			for _, character := range segment {
				if character < 32 || character == 127 {
					return false
				}
			}
		} else if registered[index] != segment {
			return false
		}
	}
	return true
}
