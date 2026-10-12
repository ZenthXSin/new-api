package middleware

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func tryCodexRelayAuth(c *gin.Context) bool {
	fields := strings.Fields(c.GetHeader("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || !strings.HasPrefix(fields[1], service.CodexRelayTokenPrefix) {
		return false
	}
	if c.Request.Method != http.MethodPost || c.Request.URL.Path != "/v1/responses" && c.Request.URL.Path != "/v1/responses/compact" {
		abortWithOpenAiMessage(c, http.StatusForbidden, "Codex credential only permits Responses requests")
		return true
	}
	claims, user, err := service.ValidateCodexRelayToken(fields[1])
	if err != nil {
		abortWithOpenAiMessage(c, http.StatusUnauthorized, "Codex session is invalid or expired")
		return true
	}
	var input struct {
		Model string `json:"model"`
	}
	if common.UnmarshalBodyReusable(c, &input) != nil || input.Model != claims.Model {
		abortWithOpenAiMessage(c, http.StatusForbidden, "Codex credential does not permit this model")
		return true
	}
	allowed, err := service.CodexAllowedChannels(user, claims.Group, claims.Model, c.Request.URL.Path)
	if err != nil {
		abortWithOpenAiMessage(c, http.StatusForbidden, "Codex model or group is no longer available")
		return true
	}
	user.WriteContext(c)
	common.SetContextKey(c, constant.ContextKeyUsingGroup, claims.Group)
	// A dashboard task is billed to its user, without creating an API-key quota.
	if SetupContextForToken(c, &model.Token{UserId: user.Id, Name: "Codex workbench", UnlimitedQuota: true, Group: claims.Group}) != nil {
		return true
	}
	c.Set(service.CodexRelayContextKey, true)
	c.Set(service.CodexRelayAllowedChannelsKey, allowed)
	c.Request.Header.Del("Authorization")
	c.Request.Header.Del("Cookie")
	c.Request.Header.Del("x-api-key")
	c.Request.Header.Del("x-goog-api-key")
	c.Header("Cache-Control", "private, no-store")
	c.Next()
	return true
}

func codexChannelAllowed(c *gin.Context, id int) bool {
	raw, ok := c.Get(service.CodexRelayAllowedChannelsKey)
	if !ok {
		return true
	}
	allowed, valid := raw.(map[int]bool)
	return valid && allowed[id]
}
