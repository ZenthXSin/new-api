package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func codexToolFixture(t *testing.T) (codexProxyFixture, string) {
	fixture := newCodexProxyFixture(t)
	tools := fixture.engine.Group("/api/codex/tools", middleware.CodexToolsAuth())
	tools.GET("/catalog", CodexToolsCatalog)
	tools.POST("/call", CodexToolsCall)
	token, err := service.IssueCodexToolsToken(service.AuthIdentity{UserID: fixture.adminID, SessionID: fixture.adminSID, UserAuthVersion: 1, SessionVersion: 1})
	require.NoError(t, err)
	return fixture, token
}

func callCodexTool(t *testing.T, fixture codexProxyFixture, token, body string) (int, map[string]interface{}) {
	t.Helper()
	request := httptest.NewRequest("POST", "/api/codex/tools/call", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	fixture.engine.ServeHTTP(response, request)
	var result map[string]interface{}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
	return response.Code, result
}

func TestCodexToolsKeepProfileSecretsAndOtherPreferences(t *testing.T) {
	fixture, token := codexToolFixture(t)
	user, err := model.GetUserById(fixture.adminID, false)
	require.NoError(t, err)
	settings := user.GetSetting()
	settings.Language = "fr"
	settings.BillingPreference = "wallet_only"
	settings.SidebarModules = `{"chat":true}`
	settings.NotifyType = "webhook"
	settings.QuotaWarningThreshold = 200
	settings.WebhookUrl = "https://example.com/notify"
	settings.WebhookSecret = "private-webhook-value"
	settings.GotifyToken = "private-gotify-value"
	require.NoError(t, model.UpdateUserSetting(user.Id, settings))
	status, result := callCodexTool(t, fixture, token, `{"name":"profile.get","arguments":{}}`)
	require.Equal(t, 200, status)
	require.Equal(t, true, result["success"])
	raw, err := common.Marshal(result)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "private-webhook-value")
	assert.NotContains(t, string(raw), "private-gotify-value")
	assert.NotContains(t, string(raw), fixture.adminPAT)
	status, result = callCodexTool(t, fixture, token, `{"name":"preferences.update","arguments":{"record_ip_log":true},"confirmed":true}`)
	require.Equal(t, 200, status)
	require.Equal(t, true, result["success"])
	user, err = model.GetUserById(user.Id, false)
	require.NoError(t, err)
	updated := user.GetSetting()
	assert.True(t, updated.RecordIpLog)
	assert.Equal(t, "fr", updated.Language)
	assert.Equal(t, "wallet_only", updated.BillingPreference)
	assert.Equal(t, settings.SidebarModules, updated.SidebarModules)
	assert.Equal(t, settings.WebhookSecret, updated.WebhookSecret)
	assert.Equal(t, settings.GotifyToken, updated.GotifyToken)
}

func TestCodexToolsEnforceOwnerArgumentsAndSelectedApproval(t *testing.T) {
	fixture, token := codexToolFixture(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}))
	foreign := model.Token{UserId: fixture.adminID + 1, Key: "foreign-private-key", Name: "Other user's token", Status: common.TokenStatusEnabled, ExpiredTime: -1}
	require.NoError(t, model.DB.Create(&foreign).Error)
	status, result := callCodexTool(t, fixture, token, `{"name":"tokens.delete","arguments":{"id":1},"confirmed":true}`)
	require.Equal(t, 200, status)
	assert.Equal(t, false, result["success"])
	var remaining model.Token
	require.NoError(t, model.DB.First(&remaining, foreign.Id).Error)
	for _, body := range []string{`{"name":"profile.update","arguments":{"role":100},"confirmed":true}`, `{"name":"tokens.get","arguments":{"id":-1}}`, `{"name":"tokens.list","arguments":{"page_size":100}}`, `{"name":"preferences.update","arguments":{"webhook_secret":"secret"},"confirmed":true}`} {
		status, _ = callCodexTool(t, fixture, token, body)
		assert.Equal(t, 400, status)
	}
	status, _ = callCodexTool(t, fixture, token, `{"name":"profile.update","arguments":{"display_name":"Changed"}}`)
	assert.Equal(t, 409, status)
	status, result = callCodexTool(t, fixture, token, `{"name":"security.password","arguments":{}}`)
	require.Equal(t, 200, status)
	assert.Equal(t, true, result["data"].(map[string]interface{})["interaction_required"])
}

func TestCodexToolsCredentialCannotBeReplacedAndRevokesWithSession(t *testing.T) {
	fixture, token := codexToolFixture(t)
	for _, invalid := range []string{fixture.adminToken, fixture.adminPAT, token + "tampered"} {
		status, _ := callCodexTool(t, fixture, invalid, `{"name":"profile.get","arguments":{}}`)
		assert.Equal(t, http.StatusUnauthorized, status)
	}
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", fixture.adminSID).Update("revoked_at", time.Now().Unix()).Error)
	status, _ := callCodexTool(t, fixture, token, `{"name":"profile.get","arguments":{}}`)
	assert.Equal(t, http.StatusUnauthorized, status)
}

func TestCodexHostPolicyRequiresLiveAdministratorRole(t *testing.T) {
	fixture, token := codexToolFixture(t)
	policy, err := model.GetEffectiveCodexUserPolicy(fixture.adminID)
	require.NoError(t, err)
	assert.True(t, policy.AllowHost)
	require.NoError(t, model.SaveCodexUserConfig(&model.CodexUserConfig{UserID: fixture.adminID + 1, Enabled: common.GetPointer(true), AllowDocker: common.GetPointer(true), AllowSSH: common.GetPointer(true)}))
	policy, err = model.GetEffectiveCodexUserPolicy(fixture.adminID + 1)
	require.NoError(t, err)
	assert.True(t, policy.Enabled)
	assert.False(t, policy.AllowHost)
	require.NoError(t, model.SaveCodexUserConfig(&model.CodexUserConfig{UserID: fixture.adminID, Enabled: common.GetPointer(true)}))
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", fixture.adminID).Update("role", common.RoleCommonUser).Error)
	request := httptest.NewRequest("GET", "/api/codex/tools/catalog", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	fixture.engine.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code)
	var result struct {
		Data struct {
			AllowHost bool `json:"allowHost"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
	assert.False(t, result.Data.AllowHost)
}

func TestCodexHostProxyRejectsOrdinaryUsersBeforeContactingRunner(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	require.NoError(t, model.SaveCodexUserConfig(&model.CodexUserConfig{UserID: fixture.adminID + 1, Enabled: common.GetPointer(true)}))
	calls := 0
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
	}))
	t.Cleanup(runner.Close)
	t.Setenv("CODEX_RUNNER_URL", runner.URL)
	request, response := fixture.request("POST", "/api/codex/workspaces", fixture.commonToken, strings.NewReader(`{"name":"Host app","host":{"path":"/root"},"allowHost":true}`))
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, 403, response.Code)
	assert.Zero(t, calls)
	request, response = fixture.request("POST", "/api/codex/workspaces", fixture.adminToken, strings.NewReader(`{"name":"Host app","host":{"path":"/root"}}`))
	fixture.engine.ServeHTTP(response, request)
	assert.Equal(t, 200, response.Code)
	assert.Equal(t, 1, calls)
}

func TestCodexLoggingPreferenceDoesNotEnableUnconfiguredNotifications(t *testing.T) {
	fixture, token := codexToolFixture(t)
	status, result := callCodexTool(t, fixture, token, `{"name":"preferences.update","arguments":{"record_ip_log":true},"confirmed":true}`)
	require.Equal(t, 200, status)
	require.Equal(t, true, result["success"])
	user, err := model.GetUserById(fixture.adminID, false)
	require.NoError(t, err)
	settings := user.GetSetting()
	assert.True(t, settings.RecordIpLog)
	assert.Empty(t, settings.NotifyType)
	assert.Zero(t, settings.QuotaWarningThreshold)
}
