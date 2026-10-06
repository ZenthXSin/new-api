package controller

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// These cases deliberately use a root resource owner. The owner can perform
// the mutation, but that must never substitute for the application's consent.
func TestOAuthChannelWriteCannotInheritOwnersSensitivePermission(t *testing.T) {
	for _, test := range []struct {
		name, field string
		value       any
	}{
		{"upstream key", "key", "replacement-upstream-key"},
		{"upstream address", "base_url", "https://changed.example"},
		{"header override", "header_override", `{"Authorization":"replacement"}`},
		{"parameter override", "param_override", `{"model":"changed"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			previousDB, previousLogDB := model.DB, model.LOG_DB
			previousMain, previousLog, previousRedis := common.MainDatabaseType(), common.LogDatabaseType(), common.RedisEnabled
			t.Cleanup(func() {
				model.DB, model.LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled = previousRedis
			})
			db := setupModelListControllerTestDB(t)
			require.NoError(t, db.AutoMigrate(&model.Log{}))
			baseURL := "https://original.example"
			original := &model.Channel{Type: constant.ChannelTypeOpenAI, Name: "delegated route", Key: "original-upstream-key", Models: "gpt-test", Group: "default", BaseURL: &baseURL, CostMultiplier: 1}
			require.NoError(t, db.Create(original).Error)
			request := map[string]any{"id": original.Id, "type": original.Type, "name": original.Name, "models": original.Models, "group": original.Group, test.field: test.value}
			body, err := common.Marshal(request)
			require.NoError(t, err)
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodPut, "/api/channel/", bytes.NewReader(body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			user := &model.User{Id: 9021, Username: "root-delegator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, AuthVersion: 1}
			ctx.Set("id", user.Id)
			ctx.Set("role", user.Role)
			middleware.SetOAuthPrincipal(ctx, &service.OAuthPrincipal{UserID: user.Id, User: user, ClientID: "limited-routing-client", GrantID: 77, Scopes: []string{"channel:write"}, Resources: []string{service.OAuthResourceDashboard}})
			require.True(t, authz.Can(user.Id, user.Role, authz.ChannelSensitiveWrite))
			UpdateChannel(ctx)
			var response struct {
				Success bool `json:"success"`
			}
			require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &response))
			assert.False(t, response.Success, "narrow OAuth consent must reject a mutation the owner could do alone")
			var after model.Channel
			require.NoError(t, db.First(&after, original.Id).Error)
			assert.Equal(t, original.Key, after.Key)
			assert.Equal(t, original.BaseURL, after.BaseURL)
			assert.Equal(t, original.HeaderOverride, after.HeaderOverride)
			assert.Equal(t, original.ParamOverride, after.ParamOverride)
		})
	}
}

func setupOAuthChannelOperationTestDB(t *testing.T) (*gorm.DB, *model.User) {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis, previousMemory := common.RedisEnabled, common.MemoryCacheEnabled
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled, common.MemoryCacheEnabled = previousRedis, previousMemory
	})
	db := setupModelListControllerTestDB(t)
	common.MemoryCacheEnabled = false
	user := &model.User{Username: "operator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, Group: "default", Quota: 1000000, AuthVersion: 1}
	require.NoError(t, db.Create(user).Error)
	return db, user
}

func oauthChannelOperationResponse(t *testing.T, handler gin.HandlerFunc, user *model.User, channelID int, delegated bool) (map[string]any, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/channel/test/1", nil)
	ctx.Params = gin.Params{{Key: "id", Value: fmt.Sprint(channelID)}}
	ctx.Set("id", user.Id)
	ctx.Set("role", user.Role)
	if delegated {
		middleware.SetOAuthPrincipal(ctx, &service.OAuthPrincipal{UserID: user.Id, User: user, ClientID: "operate-client", GrantID: 77, Scopes: []string{"channel:operate"}, Resources: []string{service.OAuthResourceDashboard}})
	}
	handler(ctx)
	require.Equal(t, http.StatusOK, rec.Code)
	var response map[string]any
	require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &response))
	return response, rec.Body.String()
}

func TestOAuthChannelBalanceDoesNotDiscloseDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		transport  bool
		balance    bool
	}{
		{name: "transport URL", transport: true},
		{name: "raw balance response", body: `{"upstream_key":"echo-SENTINEL","nested":{"Authorization":"Bearer SENTINEL"}}`},
		{name: "standard balance", body: `{"object":"credit_summary","total_available":12.5,"upstream_key":"echo-SENTINEL"}`, balance: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, user := setupOAuthChannelOperationTestDB(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			channel := &model.Channel{Type: constant.ChannelTypeAdvancedCustom, BaseURL: common.GetPointer(server.URL), Key: "fake-SENTINEL", Models: "gpt-4o-mini", Group: "default"}
			channel.SetOtherSettings(dto.ChannelOtherSettings{AdvancedCustom: &dto.AdvancedCustomConfig{Routes: []dto.AdvancedCustomRoute{{IncomingPath: dto.AdvancedCustomBalancePath, UpstreamPath: "/balance", Converter: "none"}}}})
			if tc.transport {
				channel.Type = constant.ChannelTypeOpenAI
				channel.BaseURL = common.GetPointer(server.URL + "/URL-SENTINEL")
				server.Close()
			}
			require.NoError(t, db.Create(channel).Error)
			for _, delegated := range []bool{false, true} {
				response, raw := oauthChannelOperationResponse(t, UpdateChannelBalance, user, channel.Id, delegated)
				if tc.balance {
					assert.Equal(t, true, response["success"])
					assert.Equal(t, 12.5, response["balance"])
					assert.NotContains(t, raw, "SENTINEL")
				} else if delegated {
					assert.Equal(t, false, response["success"])
					assert.NotContains(t, raw, "SENTINEL", "operational access does not consent to credential disclosure")
					assert.NotContains(t, response, "raw_response")
				} else {
					assert.Contains(t, raw, "SENTINEL", "existing site diagnostics must remain available")
				}
			}
		})
	}
}

func TestOAuthChannelTestDoesNotDiscloseUpstreamOrOverrideErrors(t *testing.T) {
	previousRatios := ratio_setting.ModelRatio2JSONString()
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"gpt-4o-mini":1}`))
	t.Cleanup(func() { require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(previousRatios)) })
	for _, override := range []bool{false, true} {
		t.Run(fmt.Sprintf("override=%t", override), func(t *testing.T) {
			db, user := setupOAuthChannelOperationTestDB(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":{"message":"upstream-SENTINEL","code":"code-SENTINEL","type":"invalid_request_error"}}`))
			}))
			defer server.Close()
			channel := &model.Channel{Type: constant.ChannelTypeOpenAI, BaseURL: common.GetPointer(server.URL), Key: "fake-key", Models: "gpt-4o-mini", Group: "default", Status: common.ChannelStatusEnabled}
			if override {
				channel.ParamOverride = common.GetPointer(`{"operations":[{"mode":"return_error","value":{"message":"override-SENTINEL","code":"code-SENTINEL","status_code":400}}]}`)
			}
			require.NoError(t, db.Create(channel).Error)
			for _, delegated := range []bool{false, true} {
				response, raw := oauthChannelOperationResponse(t, TestChannel, user, channel.Id, delegated)
				assert.Equal(t, false, response["success"])
				if delegated {
					assert.NotContains(t, raw, "SENTINEL")
					assert.Equal(t, "channel_operation_failed", response["error_code"])
				} else {
					assert.Contains(t, raw, "SENTINEL")
				}
			}
		})
	}
}

func TestOAuthCodexOperationsReturnOnlyStructuredUsage(t *testing.T) {
	for _, operation := range []struct {
		name    string
		handler gin.HandlerFunc
		reset   bool
	}{
		{"usage", GetCodexChannelUsage, false},
		{"reset credits", GetCodexChannelRateLimitResetCredits, false},
		{"reset", ResetCodexChannelUsage, true},
	} {
		for _, tc := range []struct {
			name, body string
			status     int
			structured bool
		}{
			{name: "structured usage", status: http.StatusOK, structured: true, body: `{"plan_type":"pro","access_token":"top-SENTINEL","email":"SENTINEL","rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":0,"reset_after_seconds":900,"limit_window_seconds":18000,"token":"nested-SENTINEL"}},"available_count":2,"credits":[{"status":"available","granted_at":"2026-10-02T00:00:00Z","expires_at":"date-SENTINEL","description":"description-SENTINEL","id":"id-SENTINEL"}],"additional_rate_limits":[{"limit_name":"label-SENTINEL","rate_limit":{"primary_window":{"used_percent":35}}}]}`},
			{name: "invalid known fields", status: http.StatusOK, body: `{"plan_type":"plan-SENTINEL","rate_limit":{"primary_window":{"used_percent":"number-SENTINEL"}}}`},
			{name: "non JSON", status: http.StatusOK, body: `non-json-SENTINEL`},
			{name: "upstream failure", status: http.StatusUnauthorized, body: `{"plan_type":"pro","access_token":"error-SENTINEL","available_count":2}`},
			{name: "empty success", status: http.StatusNoContent},
		} {
			t.Run(operation.name+"/"+tc.name, func(t *testing.T) {
				db, user := setupOAuthChannelOperationTestDB(t)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(tc.body))
				}))
				defer server.Close()
				channel := &model.Channel{Type: constant.ChannelTypeCodex, BaseURL: common.GetPointer(server.URL), Key: `{"access_token":"fake-access","account_id":"fake-account"}`}
				require.NoError(t, db.Create(channel).Error)
				for _, delegated := range []bool{false, true} {
					response, raw := oauthChannelOperationResponse(t, operation.handler, user, channel.Id, delegated)
					if !delegated {
						assert.Equal(t, strings.Contains(tc.body, "SENTINEL"), strings.Contains(raw, "SENTINEL"))
						assert.Equal(t, tc.status >= 200 && tc.status < 300, response["success"])
						continue
					}
					assert.NotContains(t, raw, "SENTINEL")
					assert.Equal(t, float64(tc.status), response["upstream_status"])
					if tc.structured {
						assert.Equal(t, true, response["success"])
						data, ok := response["data"].(map[string]any)
						require.True(t, ok)
						assert.Equal(t, "pro", data["plan_type"])
						assert.Equal(t, float64(2), data["available_count"])
						rate, ok := data["rate_limit"].(map[string]any)
						require.True(t, ok)
						assert.Equal(t, false, rate["limit_reached"])
						window, ok := rate["primary_window"].(map[string]any)
						require.True(t, ok)
						assert.Equal(t, float64(0), window["used_percent"])
						assert.Equal(t, float64(900), window["reset_after_seconds"])
					} else {
						assert.Equal(t, operation.reset && tc.status >= 200 && tc.status < 300, response["success"], "a completed reset must not be presented as a retryable failure")
						assert.Empty(t, response["data"])
					}
				}
			})
		}
	}
}

func TestOAuthChannelTagWriteCannotInheritOwnersSensitivePermission(t *testing.T) {
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog, previousRedis := common.MainDatabaseType(), common.LogDatabaseType(), common.RedisEnabled
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled = previousRedis
	})
	db := setupModelListControllerTestDB(t)
	tag := "delegated-tag"
	original := &model.Channel{Name: "tag member", Key: "original", Tag: &tag, Models: "gpt-test", Group: "default", CostMultiplier: 1}
	require.NoError(t, db.Create(original).Error)
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	ctx.Request = httptest.NewRequest(http.MethodPut, "/api/channel/tag", bytes.NewBufferString(`{"tag":"delegated-tag","header_override":"{\"Authorization\":\"changed\"}"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	user := &model.User{Id: 9021, Username: "root-delegator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, AuthVersion: 1}
	ctx.Set("id", user.Id)
	ctx.Set("role", user.Role)
	middleware.SetOAuthPrincipal(ctx, &service.OAuthPrincipal{UserID: user.Id, User: user, ClientID: "limited-routing-client", GrantID: 77, Scopes: []string{"channel:write"}, Resources: []string{service.OAuthResourceDashboard}})
	EditTagChannels(ctx)
	var response struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &response))
	assert.False(t, response.Success)
	var after model.Channel
	require.NoError(t, db.First(&after, original.Id).Error)
	assert.Nil(t, after.HeaderOverride)
}

func TestOAuthChannelOperateCannotDeleteOwnersUpstreamKey(t *testing.T) {
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog, previousRedis := common.MainDatabaseType(), common.LogDatabaseType(), common.RedisEnabled
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled = previousRedis
	})
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.Log{}))
	original := &model.Channel{Name: "multi key route", Key: "key-one\nkey-two", Models: "gpt-test", Group: "default", CostMultiplier: 1}
	original.ChannelInfo.IsMultiKey = true
	original.ChannelInfo.MultiKeySize = 2
	require.NoError(t, db.Create(original).Error)
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/channel/multi_key/manage", bytes.NewBufferString(fmt.Sprintf(`{"channel_id":%d,"action":"delete_key","key_index":0}`, original.Id)))
	ctx.Request.Header.Set("Content-Type", "application/json")
	user := &model.User{Id: 9021, Username: "root-delegator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, AuthVersion: 1}
	ctx.Set("id", user.Id)
	ctx.Set("role", user.Role)
	middleware.SetOAuthPrincipal(ctx, &service.OAuthPrincipal{UserID: user.Id, User: user, ClientID: "limited-operator-client", GrantID: 77, Scopes: []string{"channel:operate"}, Resources: []string{service.OAuthResourceDashboard}})
	ManageMultiKeys(ctx)
	var response struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &response))
	assert.False(t, response.Success)
	var after model.Channel
	require.NoError(t, db.First(&after, original.Id).Error)
	assert.Equal(t, original.Key, after.Key)
	assert.Equal(t, 2, after.ChannelInfo.MultiKeySize)
}

func TestOAuthChannelReadDoesNotRevealCredentialsStoredOutsideKey(t *testing.T) {
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog, previousRedis := common.MainDatabaseType(), common.LogDatabaseType(), common.RedisEnabled
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled = previousRedis
	})
	db := setupModelListControllerTestDB(t)
	baseURL := "https://proxy-user:proxy-SENTINEL@example.test/v1?key=query-SENTINEL#fragment-SENTINEL"
	headerOverride := `{"Authorization":"Bearer header-SENTINEL"}`
	paramOverride := `{"api_key":"param-SENTINEL"}`
	setting := `{"proxy":"https://proxy:setting-SENTINEL@proxy.example.test"}`
	original := &model.Channel{Type: constant.ChannelTypeOpenAI, Name: "visible-routing-name", Models: "gpt-test", Group: "default", Status: common.ChannelStatusEnabled, Key: "key-SENTINEL", BaseURL: &baseURL, HeaderOverride: &headerOverride, ParamOverride: &paramOverride, Setting: &setting, Other: "other-SENTINEL", OtherInfo: `{"raw":"other-info-SENTINEL"}`, OtherSettings: `{"credential":"other-settings-SENTINEL"}`, CostMultiplier: 1}
	require.NoError(t, db.Create(original).Error)
	for _, tc := range []struct {
		name, path string
		handler    gin.HandlerFunc
	}{
		{"get", "/api/channel/1", GetChannel},
		{"list", "/api/channel/", GetAllChannels},
		{"search", "/api/channel/search?keyword=visible-routing-name", SearchChannels},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodGet, tc.path, nil)
			ctx.Params = gin.Params{{Key: "id", Value: fmt.Sprint(original.Id)}}
			user := &model.User{Id: 9021, Username: "root-delegator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, AuthVersion: 1}
			ctx.Set("id", user.Id)
			ctx.Set("role", user.Role)
			middleware.SetOAuthPrincipal(ctx, &service.OAuthPrincipal{UserID: user.Id, User: user, ClientID: "read-client", GrantID: 77, Scopes: []string{"channel:read"}, Resources: []string{service.OAuthResourceDashboard}})
			tc.handler(ctx)
			assert.Equal(t, http.StatusOK, rec.Code)
			assert.Contains(t, rec.Body.String(), "visible-routing-name", "normal routing metadata remains available")
			assert.NotContains(t, rec.Body.String(), "SENTINEL", "secret-looking channel configuration must require the explicit hosted disclosure workflow")
		})
	}
	var persisted model.Channel
	require.NoError(t, db.First(&persisted, original.Id).Error)
	assert.Equal(t, original.HeaderOverride, persisted.HeaderOverride, "response redaction must not mutate stored configuration")
	assert.Equal(t, original.BaseURL, persisted.BaseURL)
}
