package service

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupOAuthRelayTicketTest(t *testing.T, scopes, resources []string) *OAuthPrincipal {
	t.Helper()
	previousDB, previousRedis := model.DB, common.RedisEnabled
	previousDatabaseType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	settings := system_setting.GetOauthProviderSettings()
	previousSettings := *settings
	previousSecret := common.SessionSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.OauthClient{}, &model.OAuthGrant{}, &model.OAuthAccessToken{}, &model.OAuthRefreshToken{}, &model.AuthFlow{}))
	model.DB, common.RedisEnabled = db, false
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.SessionSecret = "oauth-relay-ticket-test-secret"
	settings.Enabled = true
	settings.Issuer = "https://oauth-ticket.example.test/oidc"
	t.Cleanup(func() {
		model.DB, common.RedisEnabled = previousDB, previousRedis
		common.SetDatabaseTypes(previousDatabaseType, previousLogType)
		common.SessionSecret = previousSecret
		*settings = previousSettings
		_ = sqlDB.Close()
	})
	user := &model.User{Username: "ticket-user", Password: "test-password-hash", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1}
	require.NoError(t, db.Create(user).Error)
	client := &model.OauthClient{ClientId: "ticket-client", Name: "Realtime test client", IsPublic: true, Enabled: true, Scopes: strings.Join(scopes, " ")}
	require.NoError(t, client.SetRedirectUris([]string{"https://client.example.test/callback"}))
	require.NoError(t, db.Create(client).Error)
	response, err := IssueOAuthTokens(client, user, scopes, resources, "")
	require.NoError(t, err)
	principal, recognized, err := AuthenticateOAuthAccessToken(response.AccessToken)
	require.NoError(t, err)
	require.True(t, recognized)
	require.NotNil(t, principal)
	return principal
}

func TestOAuthRelayTicketIsBoundAndConsumedOnce(t *testing.T) {
	principal := setupOAuthRelayTicketTest(t, []string{"relay:invoke"}, []string{OAuthResourceRelay})
	ticket, err := CreateOAuthRelayTicket(principal)
	require.NoError(t, err)
	for _, invalid := range []struct{ method, path string }{
		{http.MethodPost, "/v1/realtime"},
		{http.MethodGet, "/v1/chat/completions"},
		{http.MethodGet, "/v1/realtime/"},
	} {
		got, recognized, err := AuthenticateOAuthRelayTicket(ticket, invalid.method, invalid.path)
		assert.True(t, recognized)
		assert.ErrorIs(t, err, ErrOAuthRelayTicketInvalid)
		assert.Nil(t, got)
	}
	flow, err := model.GetAuthFlow(strings.TrimPrefix(ticket, OAuthRelayTicketPrefix), model.AuthFlowMatch{Purpose: oauthRelayTicketPurpose})
	require.NoError(t, err)
	assert.NotContains(t, flow.Payload, ticket)
	assert.NotEqual(t, ticket, flow.TokenHash)
	assert.WithinDuration(t, time.Now().Add(time.Minute), flow.ExpiresAt, time.Second)

	got, recognized, err := AuthenticateOAuthRelayTicket(ticket, http.MethodGet, "/v1/realtime")
	require.NoError(t, err)
	require.True(t, recognized)
	require.NotNil(t, got)
	assert.Equal(t, principal.GrantID, got.GrantID)
	assert.Equal(t, principal.UserID, got.UserID)
	assert.Equal(t, principal.Scopes, got.Scopes)
	got, recognized, err = AuthenticateOAuthRelayTicket(ticket, http.MethodGet, "/v1/realtime")
	assert.True(t, recognized)
	assert.ErrorIs(t, err, ErrOAuthRelayTicketInvalid)
	assert.Nil(t, got)
}

func TestOAuthRelayTicketRejectsExpiredOrInvalidatedAuthorization(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*testing.T, *OAuthPrincipal)
	}{
		{"expired ticket", func(t *testing.T, _ *OAuthPrincipal) {
			require.NoError(t, model.DB.Model(&model.AuthFlow{}).Where("purpose = ?", oauthRelayTicketPurpose).Update("expires_at", time.Now().Add(-time.Second)).Error)
		}},
		{"revoked grant", func(t *testing.T, p *OAuthPrincipal) {
			require.NoError(t, RevokeOAuthGrant(p.UserID, p.GrantID))
		}},
		{"narrowed grant", func(t *testing.T, p *OAuthPrincipal) {
			require.NoError(t, NarrowOAuthGrant(p.UserID, p.GrantID, []string{"relay:read"}))
		}},
		{"disabled client", func(t *testing.T, p *OAuthPrincipal) {
			require.NoError(t, model.DB.Model(&model.OauthClient{}).Where("client_id = ?", p.ClientID).Update("enabled", false).Error)
		}},
		{"changed user authentication", func(t *testing.T, p *OAuthPrincipal) {
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", p.UserID).Update("auth_version", p.AuthVersion+1).Error)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			principal := setupOAuthRelayTicketTest(t, []string{"relay:invoke", "relay:read"}, []string{OAuthResourceRelay})
			ticket, err := CreateOAuthRelayTicket(principal)
			require.NoError(t, err)
			test.mutate(t, principal)
			got, recognized, err := AuthenticateOAuthRelayTicket(ticket, http.MethodGet, "/v1/realtime")
			assert.True(t, recognized)
			assert.ErrorIs(t, err, ErrOAuthRelayTicketInvalid)
			assert.Nil(t, got)
		})
	}
}

func TestOAuthRelayTicketRequiresCurrentRelayAuthority(t *testing.T) {
	for _, test := range []struct {
		name      string
		scopes    []string
		resources []string
	}{
		{"missing invoke scope", []string{"relay:read"}, []string{OAuthResourceRelay}},
		{"wrong resource", []string{"relay:invoke"}, []string{OAuthResourceDashboard}},
	} {
		t.Run(test.name, func(t *testing.T) {
			principal := setupOAuthRelayTicketTest(t, test.scopes, test.resources)
			ticket, err := CreateOAuthRelayTicket(principal)
			assert.ErrorIs(t, err, ErrOAuthScopeForbidden)
			assert.Empty(t, ticket)
		})
	}
	t.Run("stale principal", func(t *testing.T) {
		principal := setupOAuthRelayTicketTest(t, []string{"relay:invoke"}, []string{OAuthResourceRelay})
		require.NoError(t, RevokeOAuthGrant(principal.UserID, principal.GrantID))
		ticket, err := CreateOAuthRelayTicket(principal)
		assert.ErrorIs(t, err, ErrOAuthRelayTicketInvalid)
		assert.Empty(t, ticket)
	})
}

func TestOAuthRelayTicketCannotBecomeAnAccessToken(t *testing.T) {
	principal := setupOAuthRelayTicketTest(t, []string{"relay:invoke"}, []string{OAuthResourceRelay})
	ticket, err := CreateOAuthRelayTicket(principal)
	require.NoError(t, err)
	got, recognized, err := AuthenticateOAuthAccessToken(ticket)
	assert.True(t, recognized)
	assert.ErrorIs(t, err, ErrOidcTokenInvalid)
	assert.Nil(t, got)
	got, recognized, err = AuthenticateOAuthRelayTicket("sk-legacy-key", http.MethodGet, "/v1/realtime")
	assert.False(t, recognized)
	assert.NoError(t, err)
	assert.Nil(t, got)
}
