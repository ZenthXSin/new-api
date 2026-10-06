package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestOAuthRelayAccountingIdentitySurvivesRevocation(t *testing.T) {
	oldDB, oldRedis := DB, common.RedisEnabled
	oldType := common.MainDatabaseType()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&OAuthGrant{}, &OAuthRelayBinding{}, &Token{}))
	DB, common.RedisEnabled = db, false
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	initCol()
	t.Cleanup(func() { DB, common.RedisEnabled = oldDB, oldRedis; common.SetMainDatabaseType(oldType); initCol() })
	grant := OAuthGrant{UserID: 1, OAuthClientID: 1, Scopes: "relay:invoke", Resources: `["urn:new-api:relay"]`, UserAuthVersion: 1, UserAuthFingerprint: "fixture-user", ClientAuthVersion: "fixture-client", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	require.NoError(t, CreateOAuthGrant(&grant))
	token, err := GetOrCreateOAuthRelayToken(grant.ID, grant.UserID, grant.Version)
	require.NoError(t, err)
	again, err := GetOrCreateOAuthRelayToken(grant.ID, grant.UserID, grant.Version)
	require.NoError(t, err)
	assert.Equal(t, token.Id, again.Id)
	assert.Equal(t, token.Key, again.Key)
	assert.True(t, token.OAuthInternal)
	assert.True(t, token.UnlimitedQuota)
	assert.Zero(t, token.RemainQuota, "an accounting identity never adds spendable wallet quota")
	assert.Empty(t, token.GetFullKey())
	tokens, err := GetAllUserTokens(grant.UserID, 0, 20)
	require.NoError(t, err)
	assert.Empty(t, tokens)
	_, err = GetTokenByIds(token.Id, grant.UserID)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	keys, err := GetTokenKeysByIds([]int{token.Id}, grant.UserID)
	require.NoError(t, err)
	assert.Empty(t, keys)
	count, err := BatchDeleteTokens([]int{token.Id}, grant.UserID)
	require.NoError(t, err)
	assert.Zero(t, count)
	revoked, err := RevokeOAuthGrantForUser(grant.ID, grant.UserID)
	require.NoError(t, err)
	require.True(t, revoked)
	_, err = GetOrCreateOAuthRelayToken(grant.ID, grant.UserID, grant.Version)
	assert.Error(t, err)
	// A task accepted before revocation still settles against the same row.
	require.NoError(t, DecreaseTokenQuota(token.Id, token.Key, 90))
	require.NoError(t, IncreaseTokenQuota(token.Id, token.Key, 35))
	settled, err := GetTokenById(token.Id)
	require.NoError(t, err)
	assert.Equal(t, 55, settled.UsedQuota)
	assert.Equal(t, -55, settled.RemainQuota, "unlimited token counters retain ordinary accounting behavior")
	assert.Equal(t, token.Key, settled.Key)
}
