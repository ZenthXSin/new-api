package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func codexGitHubIdentity(c *gin.Context) (service.AuthIdentity, bool) {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	_, permitted := middleware.GetCodexWorkbenchPolicy(c)
	if !ok || !permitted {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "codex_session_required", "message": "请使用已开通 Codex 的账号登录后连接 GitHub"})
		return service.AuthIdentity{}, false
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	return identity, true
}

func codexGitHubError(c *gin.Context, err error) {
	status, code, message := http.StatusBadGateway, "github_unavailable", "GitHub 暂时不可用，请稍后重试"
	switch {
	case errors.Is(err, service.ErrCodexGitHubUnconfigured):
		status, code, message = http.StatusServiceUnavailable, "github_unconfigured", "尚未配置 GitHub 开发授权，请管理员配置 GitHub OAuth App"
	case errors.Is(err, service.ErrCodexGitHubRepositoryScope):
		status, code, message = http.StatusForbidden, "github_repository_permission_required", "GitHub 未授予仓库访问权限，请重新连接并允许仓库权限"
	case errors.Is(err, service.ErrCodexGitHubNotConnected):
		status, code, message = http.StatusConflict, "github_not_connected", "请先连接 GitHub 账号"
	case errors.Is(err, service.ErrCodexGitHubAlreadyConnected):
		status, code, message = http.StatusConflict, "github_already_connected", "请先解除当前 GitHub 授权，再连接其他账号"
	case errors.Is(err, model.ErrAuthFlowInvalid), errors.Is(err, model.ErrAuthFlowExpired), errors.Is(err, model.ErrAuthFlowConsumed), errors.Is(err, model.ErrCodexGitHubChanged):
		status, code, message = http.StatusBadRequest, "github_authorization_expired", "GitHub 授权已失效，请从当前浏览器重新连接"
	}
	var provider *service.CodexGitHubProviderError
	if errors.As(err, &provider) {
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("Codex GitHub failure stage=%s reason=%s upstream_status=%d", provider.Stage, provider.Reason, provider.Status))
	}
	// Provider bodies, OAuth codes, credentials and DB errors never reach UI.
	c.JSON(status, gin.H{"success": false, "code": code, "message": message})
}

func CodexGitHubStatus(c *gin.Context) {
	identity, ok := codexGitHubIdentity(c)
	if !ok {
		return
	}
	status, err := service.GetCodexGitHubStatus(identity.UserID)
	if err != nil {
		codexGitHubError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": status})
}

func CodexGitHubAuthorize(c *gin.Context) {
	identity, ok := codexGitHubIdentity(c)
	if !ok {
		return
	}
	authorizationURL, err := service.BeginCodexGitHubAuthorization(identity)
	if err != nil {
		codexGitHubError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"url": authorizationURL}})
}

func CodexGitHubCallback(c *gin.Context) {
	identity, ok := codexGitHubIdentity(c)
	if !ok {
		return
	}
	var input struct {
		Code  string `json:"code"`
		State string `json:"state"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	if err := common.DecodeJson(c.Request.Body, &input); err != nil {
		codexGitHubError(c, model.ErrAuthFlowInvalid)
		return
	}
	if err := service.FinishCodexGitHubAuthorization(c.Request.Context(), identity, input.Code, input.State); err != nil {
		codexGitHubError(c, err)
		return
	}
	status, err := service.GetCodexGitHubStatus(identity.UserID)
	if err != nil {
		codexGitHubError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": status})
}

func CodexGitHubRepositories(c *gin.Context) {
	identity, ok := codexGitHubIdentity(c)
	if !ok {
		return
	}
	page, pageErr := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, limitErr := strconv.Atoi(c.DefaultQuery("limit", "50"))
	if pageErr != nil || limitErr != nil || page < 1 || page > 1000 || limit < 1 || limit > 100 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "code": "github_invalid_page", "message": "仓库分页参数无效"})
		return
	}
	repositories, hasMore, err := service.ListCodexGitHubRepositories(c.Request.Context(), identity.UserID, page, limit)
	if err != nil {
		codexGitHubError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"repositories": repositories, "hasMore": hasMore}})
}

func CodexGitHubDisconnect(c *gin.Context) {
	identity, ok := codexGitHubIdentity(c)
	if !ok {
		return
	}
	connection, err := model.DisconnectCodexGitHubConnection(identity.UserID)
	if err != nil {
		codexGitHubError(c, err)
		return
	}
	token, tokenErr := connection.Token()
	// Continue revocation even when the browser disconnects midway through it.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	runnerErr := codexDisconnectGitHubRunner(ctx, identity.UserID, connection.Generation)
	revokeErr := tokenErr
	if tokenErr == nil {
		config, configErr := service.LoadCodexGitHubConfig()
		if token != "" && (configErr != nil || config.ClientID != connection.ClientID) {
			revokeErr = service.ErrCodexGitHubUnconfigured
		} else {
			revokeErr = service.RevokeCodexGitHubToken(ctx, token)
		}
	}
	if revokeErr == nil && runnerErr == nil {
		revokeErr = model.CompleteCodexGitHubRevocation(identity.UserID, connection.Generation)
	}
	if runnerErr != nil || revokeErr != nil {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "code": "github_revocation_pending", "message": "已停止向新任务提供 GitHub 凭据，清理尚未完成，请重试解除授权", "data": gin.H{"connected": false, "revocationPending": true, "runnerStopped": runnerErr == nil, "providerRevoked": revokeErr == nil}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"connected": false, "revocationPending": false}})
}

// The caller supplies a new server-side request; browser-controlled credential
// headers are never copied. Even disconnected users send a generation tombstone.
func codexAttachGitHubCredential(request *http.Request, userID int) error {
	path := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
	isGitOperation := len(path) == 4 && path[0] == "workspaces" && path[2] == "git" &&
		(request.Method == http.MethodGet && path[3] == "status" || request.Method == http.MethodPost && (path[3] == "commit" || path[3] == "push" || path[3] == "pull-request"))
	isPullRequestOperation := len(path) >= 2 && path[0] == "github" && path[1] == "pulls" &&
		(request.Method == http.MethodGet && (len(path) == 2 || len(path) == 5 || len(path) == 6 && path[5] == "context") ||
			request.Method == http.MethodPost && len(path) == 6 && (path[5] == "comments" || path[5] == "reviews" || path[5] == "task"))
	if request.Method != http.MethodPost && !isGitOperation && !isPullRequestOperation {
		return nil
	}
	needsCredential := request.URL.Path == "/workspaces" || request.URL.Path == "/environment/start" || request.URL.Path == "/environments"
	if len(path) == 3 {
		needsCredential = needsCredential || path[0] == "workspaces" && path[2] == "turns" ||
			path[0] == "environments" && (path[2] == "setup" || path[2] == "publish" || path[2] == "tasks")
	}
	needsCredential = needsCredential || isGitOperation || isPullRequestOperation
	if !needsCredential {
		return nil
	}
	credential, err := service.GetCodexGitHubCredential(userID)
	if err != nil {
		return err
	}
	request.Header.Set("X-Codex-GitHub-Token", credential.Token)
	request.Header.Set("X-Codex-GitHub-Login", credential.Login)
	request.Header.Set("X-Codex-GitHub-Generation", strconv.FormatInt(credential.Generation, 10))
	return nil
}

func codexDisconnectGitHubRunner(ctx context.Context, userID int, generation int64) error {
	key := strings.TrimSpace(os.Getenv("CODEX_RUNNER_KEY"))
	if file := strings.TrimSpace(os.Getenv("CODEX_RUNNER_KEY_FILE")); file != "" {
		data, err := os.ReadFile(file)
		if err != nil || len(data) > 4096 {
			return errors.New("runner not configured")
		}
		key = strings.TrimSpace(string(data))
	}
	target, err := url.Parse(strings.TrimSpace(os.Getenv("CODEX_RUNNER_URL")))
	if err != nil || target == nil || target.Hostname() == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" || target.Path != "" && target.Path != "/" || target.Scheme != "http" && target.Scheme != "https" || len(key) < 32 || len(key) > 4096 || strings.ContainsAny(key, "\r\n") {
		return errors.New("runner not configured")
	}
	target.Path = "/integrations/github"
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, target.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("X-Codex-Runner-Key", key)
	request.Header.Set("X-Codex-Admin-Id", strconv.Itoa(userID))
	request.Header.Set("X-Codex-GitHub-Generation", strconv.FormatInt(generation, 10))
	request.Header.Set("X-Codex-GitHub-Token", "")
	request.Header.Set("X-Codex-GitHub-Login", "")
	response, err := codexWorkbenchClient.Do(request)
	if err != nil {
		return errors.New("runner disconnect failed")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 16384))
	var result struct {
		Success bool `json:"success"`
	}
	if err != nil || response.StatusCode != http.StatusOK || common.Unmarshal(data, &result) != nil || !result.Success {
		return errors.New("runner disconnect failed")
	}
	return nil
}
