package service

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthRelayBillingUsesExistingWalletAndAccounting(t *testing.T) {
	principal := setupOAuthRelayTicketTest(t, []string{"relay:invoke"}, []string{OAuthResourceRelay})
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.OAuthRelayBinding{}))
	previousLogDB := model.LOG_DB
	t.Setenv("LOG_SQL_DSN", "")
	require.NoError(t, model.InitLogDB())
	previousBatch := common.BatchUpdateEnabled
	common.BatchUpdateEnabled = false
	t.Cleanup(func() { model.LOG_DB = previousLogDB; common.BatchUpdateEnabled = previousBatch })
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", principal.UserID).Update("quota", 1000).Error)
	token, err := model.GetOrCreateOAuthRelayToken(principal.GrantID, principal.UserID, principal.GrantVersion)
	require.NoError(t, err)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	info := &relaycommon.RelayInfo{
		UserId: principal.UserID, TokenId: token.Id, TokenKey: token.Key, TokenUnlimited: token.UnlimitedQuota,
		ForcePreConsume: true, UserSetting: dto.UserSetting{BillingPreference: "wallet_only"},
	}
	session, apiErr := NewBillingSession(ctx, info, 400)
	require.Nil(t, apiErr)
	require.NotNil(t, session)
	wallet, err := model.GetUserQuota(principal.UserID, false)
	require.NoError(t, err)
	assert.Equal(t, 600, wallet)
	reserved, err := model.GetTokenById(token.Id)
	require.NoError(t, err)
	assert.Equal(t, 400, reserved.UsedQuota)
	// A response uses less than its reservation: ordinary settlement refunds
	// both wallet and token counters, even if the application was revoked.
	revoked, err := model.RevokeOAuthGrantForUser(principal.GrantID, principal.UserID)
	require.NoError(t, err)
	require.True(t, revoked)
	require.NoError(t, session.Settle(125))
	require.NoError(t, session.Settle(125), "settlement is idempotent")
	wallet, err = model.GetUserQuota(principal.UserID, false)
	require.NoError(t, err)
	assert.Equal(t, 875, wallet)
	settled, err := model.GetTokenById(token.Id)
	require.NoError(t, err)
	assert.Equal(t, 125, settled.UsedQuota)
	assert.Equal(t, -125, settled.RemainQuota)
	// Unlimited accounting-token quota never makes the user's wallet unlimited.
	failed, apiErr := NewBillingSession(ctx, info, 900)
	require.NotNil(t, apiErr)
	assert.Nil(t, failed)
	wallet, err = model.GetUserQuota(principal.UserID, false)
	require.NoError(t, err)
	assert.Equal(t, 875, wallet)
	settled, err = model.GetTokenById(token.Id)
	require.NoError(t, err)
	assert.Equal(t, 125, settled.UsedQuota)
}
