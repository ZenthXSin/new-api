package controller

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createOAuthActionAdversarialFixture(t *testing.T) (*model.OAuthAction, *service.OAuthPrincipal, string) {
	t.Helper()
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.AutoMigrate(&model.OAuthAction{}))
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "api_key:reveal offline_access"
	require.NoError(t, db.Model(client).Update("scopes", client.Scopes).Error)
	tokens, err := service.IssueOAuthTokens(client, user, []string{"api_key:reveal", "offline_access"}, []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	principal, recognized, err := service.AuthenticateOAuthAccessToken(tokens.AccessToken)
	require.NoError(t, err)
	require.True(t, recognized)
	action, receipt, err := service.CreateOAuthHostedAction(principal, "apikey.reveal", map[string]any{"id": float64(19)}, true, "https://rp.example.com/cb", "fixture-state")
	require.NoError(t, err)
	require.NoError(t, service.ApproveOAuthHostedAction(action))
	require.NoError(t, service.ClaimOAuthActionStep(action, 0))
	require.NoError(t, service.FinishOAuthActionStep(action, true, 1, map[string]any{"key": "SENTINEL_LOCAL_ONLY_UPSTREAM_KEY"}, ""))
	action, err = service.GetOAuthHostedAction(action.ID)
	require.NoError(t, err)
	return action, principal, receipt
}

func TestOAuthActionResultIsEncryptedOneUseAndBoundToOriginalGrant(t *testing.T) {
	action, principal, receipt := createOAuthActionAdversarialFixture(t)
	require.NotEmpty(t, action.ResultCiphertext)
	assert.NotContains(t, action.ResultCiphertext, "SENTINEL_LOCAL_ONLY_UPSTREAM_KEY")
	other := *principal
	other.GrantID++
	_, err := service.ClaimOAuthActionResult(action, &other, receipt)
	require.Error(t, err)
	other = *principal
	other.ClientID = "other-client"
	_, err = service.ClaimOAuthActionResult(action, &other, receipt)
	require.Error(t, err)
	other = *principal
	other.UserID++
	_, err = service.ClaimOAuthActionResult(action, &other, receipt)
	require.Error(t, err)
	_, err = service.ClaimOAuthActionResult(action, principal, "nao_ar_wrong-receipt")
	require.Error(t, err)
	result, err := service.ClaimOAuthActionResult(action, principal, receipt)
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"key": "SENTINEL_LOCAL_ONLY_UPSTREAM_KEY"}, result)
	_, err = service.ClaimOAuthActionResult(action, principal, receipt)
	require.Error(t, err, "even an in-memory copy must not redeem a claimed result")
	persisted, err := service.GetOAuthHostedAction(action.ID)
	require.NoError(t, err)
	assert.Empty(t, persisted.ResultCiphertext)
	assert.Positive(t, persisted.ResultClaimedAt)
}

func TestOAuthActionResultRejectsRevokedNarrowedExpiredOrTamperedAuthority(t *testing.T) {
	for _, name := range []string{"revoked", "narrowed", "expired", "parameters tampered", "ciphertext tampered", "no sharing"} {
		t.Run(name, func(t *testing.T) {
			action, principal, receipt := createOAuthActionAdversarialFixture(t)
			switch name {
			case "revoked":
				require.NoError(t, service.RevokeOAuthGrant(principal.UserID, principal.GrantID))
			case "narrowed":
				require.NoError(t, service.NarrowOAuthGrant(principal.UserID, principal.GrantID, []string{"api_key:reveal"}))
			case "expired":
				action.ExpiresAt = time.Now().Add(-time.Second).Unix()
				require.NoError(t, model.DB.Model(&model.OAuthAction{}).Where("id = ?", action.ID).Update("expires_at", action.ExpiresAt).Error)
			case "parameters tampered":
				action.Parameters = `{"id":20}`
			case "ciphertext tampered":
				action.ResultCiphertext = "corrupted"
			case "no sharing":
				action.ShareResult = false
			}
			_, err := service.ClaimOAuthActionResult(action, principal, receipt)
			require.Error(t, err)
			var persisted model.OAuthAction
			require.NoError(t, model.DB.First(&persisted, "id = ?", action.ID).Error)
			assert.Zero(t, persisted.ResultClaimedAt, "invalid attempts must not consume another application's result")
		})
	}
}

func TestOAuthHostedActionRejectsArbitraryCallbackAndParameters(t *testing.T) {
	_, principal, _ := createOAuthActionAdversarialFixture(t)
	for _, test := range []struct {
		name, operation, callback string
		parameters                map[string]any
	}{
		{"callback prefix", "apikey.reveal", "https://rp.example.com/cb/evil", map[string]any{"id": float64(1)}},
		{"callback fragment", "apikey.reveal", "https://rp.example.com/cb#evil", map[string]any{"id": float64(1)}},
		{"callback javascript", "apikey.reveal", "javascript:alert(1)", map[string]any{"id": float64(1)}},
		{"unregistered operation", "arbitrary.route", "", map[string]any{}},
		{"target type", "apikey.reveal", "", map[string]any{"id": "1"}},
		{"target substitution field", "apikey.reveal", "", map[string]any{"id": float64(1), "path": "/api/channel/1/key"}},
		{"credential in intent", "apikey.reveal", "", map[string]any{"id": float64(1), "password": "secret"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := service.CreateOAuthHostedAction(principal, test.operation, test.parameters, true, test.callback, "")
			require.Error(t, err)
		})
	}
}

func TestOAuthActionSessionCannotSwapUserSessionOrNonce(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.AutoMigrate(&model.OAuthAction{}))
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "api_key:reveal"
	require.NoError(t, db.Model(client).Update("scopes", client.Scopes).Error)
	tokens, err := service.IssueOAuthTokens(client, user, []string{"api_key:reveal"}, []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	principal, _, err := service.AuthenticateOAuthAccessToken(tokens.AccessToken)
	require.NoError(t, err)
	action, _, err := service.CreateOAuthHostedAction(principal, "apikey.reveal", map[string]any{"id": float64(5)}, false, "", "")
	require.NoError(t, err)
	identity := service.AuthIdentity{UserID: user.Id, SessionID: "owner-real-session", UserAuthVersion: 1, SessionVersion: 1}
	wrong := identity
	wrong.UserID++
	_, err = service.BindOAuthActionSession(action, wrong)
	require.Error(t, err)
	nonce, err := service.BindOAuthActionSession(action, identity)
	require.NoError(t, err)
	assert.True(t, service.OAuthActionSessionMatches(action, identity, nonce))
	wrong = identity
	wrong.SessionID = "other-session"
	_, err = service.BindOAuthActionSession(action, wrong)
	require.Error(t, err)
	assert.False(t, service.OAuthActionSessionMatches(action, wrong, nonce))
	assert.False(t, service.OAuthActionSessionMatches(action, identity, "wrong"))
	wrong = identity
	wrong.SessionVersion++
	assert.False(t, service.OAuthActionSessionMatches(action, wrong, nonce))
	wrong = identity
	wrong.UserAuthVersion++
	assert.False(t, service.OAuthActionSessionMatches(action, wrong, nonce))
	assert.Equal(t, common.UserStatusEnabled, user.Status)
}
