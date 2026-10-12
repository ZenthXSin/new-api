package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const codexWorkbenchPolicyKey = "codex_workbench_user_policy"

// Codex workloads require a browser session and a current per-user grant.
// Administrators keep their default access; ordinary users require an explicit
// administrator-configured grant. API and delegated OAuth tokens do not qualify.
func CodexWorkbenchAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, identity, useAccessToken, err := authenticateDashboardRequest(c)
		if err != nil {
			writeDashboardAuthError(c, err)
			return
		}
		if user.Status != common.UserStatusEnabled || !validUserInfo(user.Username, user.Role) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "code": "codex_session_required", "message": "请使用有效账号登录后访问 Codex"})
			return
		}
		if useAccessToken || identity.SessionID == "" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "codex_session_required", "message": "请使用浏览器登录后访问 Codex"})
			return
		}
		policy, err := model.GetEffectiveCodexUserPolicy(user.Id)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "codex_policy_unavailable", "message": "无法读取 Codex 使用权限，请稍后重试"})
			return
		}
		if !policy.Enabled {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "codex_access_denied", "message": "当前账号未启用在线 Codex，请联系管理员"})
			return
		}
		setDashboardAuthContext(c, user, identity, false)
		c.Set(codexWorkbenchPolicyKey, policy)
		// Retain the existing audit trail for workload-changing operations,
		// including explicitly enabled non-administrator sessions.
		writer := beginAdminAudit(c)
		c.Next()
		finishAdminAudit(c, writer)
	}
}

// GetCodexWorkbenchPolicy only accepts policy established by the authenticated
// middleware. A body or header cannot supply a policy or choose another owner.
func GetCodexWorkbenchPolicy(c *gin.Context) (*model.CodexUserPolicy, bool) {
	identity, ok := GetSessionAuthIdentity(c)
	if !ok {
		return nil, false
	}
	value, exists := c.Get(codexWorkbenchPolicyKey)
	policy, valid := value.(*model.CodexUserPolicy)
	if !exists || !valid || policy == nil || !policy.Enabled || policy.UserID != identity.UserID {
		return nil, false
	}
	return policy, true
}
