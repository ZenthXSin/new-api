package controller

import (
	"bytes"
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"net/http"
	"testing"
)

func TestCodexAdminAPIRestrictsRolesAndValidatesPagination(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	fixture.engine.Use(func(c *gin.Context) { c.Set(string(constant.ContextKeyAuditLogged), true); c.Next() })
	admin := fixture.engine.Group("/api/codex-admin", middleware.AdminAuth())
	admin.GET("/users", ListCodexAdminUsers)
	admin.PUT("/users/:id", UpdateUserCodexConfig)
	admin.GET("/users/:id", GetUserCodexConfig)
	for _, tc := range []struct {
		path, token string
		status      int
	}{
		{"/api/codex-admin/users", "", 401},
		{"/api/codex-admin/users", fixture.commonToken, 403},
		{"/api/codex-admin/users?pageSize=101", fixture.adminToken, 400},
		{"/api/codex-admin/users?page=-1", fixture.adminToken, 400},
		{fmt.Sprintf("/api/codex-admin/users/%d", fixture.adminID), fixture.adminToken, 403},
		{"/api/codex-admin/users", fixture.adminToken, 200},
	} {
		req, res := fixture.request(http.MethodGet, tc.path, tc.token, nil)
		fixture.engine.ServeHTTP(res, req)
		assert.Equal(t, tc.status, res.Code, tc.path)
		if tc.status == 200 {
			var envelope struct {
				Success bool
				Data    struct {
					Items []model.CodexAdminUser
					Total int
				}
			}
			require.NoError(t, common.Unmarshal(res.Body.Bytes(), &envelope))
			assert.True(t, envelope.Success)
			assert.Equal(t, 1, envelope.Data.Total)
			require.Len(t, envelope.Data.Items, 1)
			assert.Equal(t, common.RoleCommonUser, envelope.Data.Items[0].Role)
			assert.False(t, envelope.Data.Items[0].Effective.Enabled)
		}
	}
}

func TestSubscriptionCodexAdminCreateUpdateAndLegacyCompatibility(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	fixture.engine.Use(func(c *gin.Context) { c.Set(string(constant.ContextKeyAuditLogged), true); c.Next() })
	settings := operation_setting.GetPaymentSetting()
	old := *settings
	settings.ComplianceConfirmed = true
	settings.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
	t.Cleanup(func() { *settings = old })
	admin := fixture.engine.Group("/plans", middleware.AdminAuth())
	admin.POST("", AdminCreateSubscriptionPlan)
	admin.PUT("/:id", AdminUpdateSubscriptionPlan)
	create := model.SubscriptionPlan{Title: "Codex trial", Enabled: true, Codex: &model.CodexPlanConfig{Enabled: true, AllowDocker: true, MemoryMB: 2048, DefaultEffort: "ultra"}}
	body, err := common.Marshal(AdminUpsertSubscriptionPlanRequest{Plan: create})
	require.NoError(t, err)
	req, res := fixture.request("POST", "/plans", fixture.adminToken, bytes.NewReader(body))
	fixture.engine.ServeHTTP(res, req)
	var envelope struct {
		Success bool
		Data    model.SubscriptionPlan
	}
	require.NoError(t, common.Unmarshal(res.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, res.Body.String())
	id := envelope.Data.Id
	require.Positive(t, id)
	for _, tc := range []struct {
		name             string
		config           *model.CodexPlanConfig
		success, enabled bool
		memory           int64
	}{
		{"legacy update keeps grant", nil, true, true, 2048},
		{"invalid resources rejected", &model.CodexPlanConfig{Enabled: true, MemoryMB: 1}, false, true, 2048},
		{"explicit false and zero persist", &model.CodexPlanConfig{Enabled: false, AllowDocker: false, MemoryMB: 0}, true, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			create.Codex = tc.config
			body, err := common.Marshal(AdminUpsertSubscriptionPlanRequest{Plan: create})
			require.NoError(t, err)
			req, res := fixture.request("PUT", fmt.Sprintf("/plans/%d", id), fixture.adminToken, bytes.NewReader(body))
			fixture.engine.ServeHTTP(res, req)
			var result struct{ Success bool }
			require.NoError(t, common.Unmarshal(res.Body.Bytes(), &result))
			assert.Equal(t, tc.success, result.Success, res.Body.String())
			var stored model.SubscriptionPlan
			require.NoError(t, model.DB.First(&stored, id).Error)
			require.NotNil(t, stored.Codex)
			assert.Equal(t, tc.enabled, stored.Codex.Enabled)
			assert.Equal(t, tc.memory, stored.Codex.MemoryMB)
		})
	}
}

func TestCodexSubscriptionAuthorizesExistingBrowserSessionUntilExpiry(t *testing.T) {
	fixture := newCodexProxyFixture(t)
	fixture.engine.GET("/subscription-access", middleware.CodexWorkbenchAuth(), func(c *gin.Context) {
		policy, ok := middleware.GetCodexWorkbenchPolicy(c)
		require.True(t, ok)
		c.JSON(200, policy)
	})
	var user model.User
	require.NoError(t, model.DB.Where("role = ?", common.RoleCommonUser).First(&user).Error)
	now := common.GetTimestamp()
	plan := model.SubscriptionPlan{Title: "Browser trial", Codex: &model.CodexPlanConfig{Enabled: true, AllowDocker: true, MemoryMB: 1024}}
	require.NoError(t, model.DB.Create(&plan).Error)
	subscription := model.UserSubscription{UserId: user.Id, PlanId: plan.Id, Status: "active", StartTime: now - 10, EndTime: now + 1000}
	require.NoError(t, model.DB.Create(&subscription).Error)
	req, res := fixture.request("GET", "/subscription-access", fixture.commonToken, nil)
	fixture.engine.ServeHTTP(res, req)
	assert.Equal(t, 200, res.Code)
	var policy model.CodexUserPolicy
	require.NoError(t, common.Unmarshal(res.Body.Bytes(), &policy))
	assert.Equal(t, user.Id, policy.UserID)
	assert.Equal(t, int64(1024), policy.MemoryMB)
	require.NoError(t, model.DB.Model(&subscription).Update("end_time", now-1).Error)
	req, res = fixture.request("GET", "/subscription-access", fixture.commonToken, nil)
	fixture.engine.ServeHTTP(res, req)
	assert.Equal(t, 403, res.Code)
	assert.Contains(t, res.Body.String(), "codex_access_denied")
}
