package controller

import (
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func CodexCatalog(c *gin.Context) {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	_, permitted := middleware.GetCodexWorkbenchPolicy(c)
	if !ok || !permitted {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "message": "请使用已开通 Codex 的账号登录"})
		return
	}
	c.Header("Cache-Control", "no-store")
	catalog, err := service.GetCodexCatalog(identity.UserID)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "无法读取可用模型，请稍后重试"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": catalog})
}

func codexAttachModelCredential(request *http.Request, identity service.AuthIdentity, body []byte) error {
	path := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
	isTurn := len(path) == 3 && path[0] == "workspaces" && path[2] == "turns"
	isCloudTask := len(path) == 3 && path[0] == "environments" && path[2] == "tasks"
	isPRTask := len(path) == 6 && path[0] == "github" && path[1] == "pulls" && path[5] == "task"
	if request.Method != http.MethodPost || (!isTurn && !isCloudTask && !isPRTask) {
		return nil
	}
	var input struct {
		Group  string `json:"group"`
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
	}
	if err := common.Unmarshal(body, &input); err != nil {
		return err
	}
	// Creating a task workspace without a prompt does not invoke a model. The
	// first turn will obtain its own session-bound, billed relay credential.
	if isCloudTask && strings.TrimSpace(input.Prompt) == "" {
		return nil
	}
	if input.Group == "" {
		catalog, err := service.GetCodexCatalog(identity.UserID)
		if err != nil {
			return err
		}
		input.Group = catalog.DefaultGroup
		if input.Model == "" {
			input.Model = catalog.DefaultModel
		}
	}
	token, err := service.IssueCodexRelayToken(identity, input.Group, input.Model)
	if err != nil {
		return err
	}
	config, err := common.Marshal(map[string]string{"token": token, "group": input.Group, "model": input.Model})
	if err != nil {
		return err
	}
	request.Header.Set("X-Codex-Model-Config", base64.StdEncoding.EncodeToString(config))
	return nil
}
