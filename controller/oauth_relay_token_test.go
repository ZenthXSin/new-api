package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupOAuthRelayTokenControllerTest(t *testing.T) *service.OAuthPrincipal {
	t.Helper()
	oldDB, oldLogDB, oldRedis := model.DB, model.LOG_DB, common.RedisEnabled
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	model.DB, common.RedisEnabled = db, false
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	t.Setenv("LOG_SQL_DSN", "")
	require.NoError(t, model.InitLogDB())
	require.NoError(t, db.AutoMigrate(&model.Token{}))
	t.Cleanup(func() {
		model.DB, model.LOG_DB, common.RedisEnabled = oldDB, oldLogDB, oldRedis
		common.SetDatabaseTypes(oldMain, oldLog)
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
	})
	return &service.OAuthPrincipal{
		UserID: 7, GrantID: 11, GrantVersion: 2, ClientID: "test-app", ExpiresAt: time.Now().Add(time.Hour).Unix(),
		Scopes:    []string{"api_key:read", "api_key:write", "api_key:reveal", "relay:invoke"},
		Resources: []string{service.OAuthResourceRelay, service.OAuthResourceDashboard},
		User:      &model.User{Id: 7, Username: "owner", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default"},
	}
}

func TestOAuthRelayTokenCreationBindsGrantWithoutAddingQuota(t *testing.T) {
	principal := setupOAuthRelayTokenControllerTest(t)
	ctx, recorder := newAuthenticatedContext(t, http.MethodPost, "/api/token/", json.RawMessage(`{"name":"application key","expired_time":-1,"remain_quota":1234,"model_limits_enabled":true,"model_limits":"gpt-4o","group":"default","allow_ips":"127.0.0.1"}`), principal.UserID)
	middleware.SetOAuthPrincipal(ctx, principal)
	AddToken(ctx)
	require.True(t, decodeAPIResponse(t, recorder).Success, recorder.Body.String())
	var token model.Token
	require.NoError(t, model.DB.First(&token).Error)
	assert.Equal(t, principal.UserID, token.UserId)
	assert.Equal(t, principal.GrantID, token.OAuthGrantID)
	assert.Equal(t, principal.GrantVersion, token.OAuthGrantVersion)
	assert.Equal(t, principal.ExpiresAt, token.ExpiredTime)
	assert.True(t, strings.HasPrefix(token.Key, "naok_"))
	assert.False(t, token.OAuthInternal)
	assert.Equal(t, 1234, token.RemainQuota)
	assert.False(t, token.UnlimitedQuota)
	assert.True(t, token.ModelLimitsEnabled)
	assert.Equal(t, "gpt-4o", token.ModelLimits)
	assert.Equal(t, []string{"127.0.0.1"}, token.GetIpLimits())
	assert.NotContains(t, recorder.Body.String(), token.Key)

	principal.Scopes = []string{"api_key:write"}
	ctx, recorder = newAuthenticatedContext(t, http.MethodPost, "/api/token/", json.RawMessage(`{"name":"unapproved","expired_time":-1,"unlimited_quota":true}`), principal.UserID)
	middleware.SetOAuthPrincipal(ctx, principal)
	AddToken(ctx)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
	var count int64
	require.NoError(t, model.DB.Model(&model.Token{}).Count(&count).Error)
	assert.EqualValues(t, 1, count)
}

func TestOAuthRelayTokenExportOnlyReturnsSameGrantChildren(t *testing.T) {
	principal := setupOAuthRelayTokenControllerTest(t)
	own := model.Token{UserId: principal.UserID, Key: "naok_own-child-secret", OAuthGrantID: principal.GrantID, OAuthGrantVersion: principal.GrantVersion}
	legacy := model.Token{UserId: principal.UserID, Key: "legacy-owner-secret"}
	otherGrant := model.Token{UserId: principal.UserID, Key: "naok_other-app-secret", OAuthGrantID: 99, OAuthGrantVersion: 1}
	otherUser := model.Token{UserId: 99, Key: "other-user-secret"}
	internal := model.Token{UserId: principal.UserID, Key: "naoi_internal-secret", OAuthGrantID: principal.GrantID, OAuthGrantVersion: principal.GrantVersion, OAuthInternal: true}
	for _, token := range []*model.Token{&own, &legacy, &otherGrant, &otherUser, &internal} {
		require.NoError(t, model.DB.Create(token).Error)
	}
	for _, test := range []struct {
		token   model.Token
		allowed bool
	}{{own, true}, {legacy, false}, {otherGrant, false}, {otherUser, false}, {internal, false}} {
		t.Run(test.token.Key, func(t *testing.T) {
			ctx, recorder := newAuthenticatedContext(t, http.MethodPost, "/api/token/key", nil, principal.UserID)
			ctx.Params = append(ctx.Params, struct {
				Key   string
				Value string
			}{Key: "id", Value: fmt.Sprint(test.token.Id)})
			middleware.SetOAuthPrincipal(ctx, principal)
			GetTokenKey(ctx)
			if test.allowed {
				assert.Contains(t, recorder.Body.String(), test.token.Key)
			} else {
				assert.NotContains(t, recorder.Body.String(), test.token.Key)
			}
		})
	}
	ctx, recorder := newAuthenticatedContext(t, http.MethodPost, "/api/token/batch/keys", json.RawMessage(fmt.Sprintf(`{"ids":[%d,%d]}`, own.Id, legacy.Id)), principal.UserID)
	middleware.SetOAuthPrincipal(ctx, principal)
	GetTokenKeysBatch(ctx)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
	assert.NotContains(t, recorder.Body.String(), own.Key)
	assert.NotContains(t, recorder.Body.String(), legacy.Key)
}

func TestOAuthRelayTokenUsageUsesAuthenticatedIdentity(t *testing.T) {
	principal := setupOAuthRelayTokenControllerTest(t)
	token := model.Token{UserId: principal.UserID, Key: "naoi_accounting_secret", OAuthGrantID: principal.GrantID, OAuthGrantVersion: principal.GrantVersion, OAuthInternal: true, RemainQuota: 700, UsedQuota: 300, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(&token).Error)
	ctx, recorder := newAuthenticatedContext(t, http.MethodGet, "/api/usage/token/", nil, principal.UserID)
	ctx.Set("token_id", token.Id)
	middleware.SetOAuthPrincipal(ctx, principal)
	GetTokenUsage(ctx)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"total_used":300`)
	assert.Contains(t, recorder.Body.String(), `"total_available":700`)
	assert.NotContains(t, recorder.Body.String(), token.Key)
}
