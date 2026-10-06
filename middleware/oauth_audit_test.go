package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthAuditAttributesOnlyVerifiedApplicationIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	newContext := func() *gin.Context {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/api/channel/", nil)
		c.Request.Header.Set("Authorization", "Bearer credential-must-not-enter-audit")
		c.Request.Header.Set("X-OAuth-Client-Id", "forged-client")
		c.Set("id", 42)
		return c
	}

	t.Run("unverified values cannot forge attribution", func(t *testing.T) {
		c := newContext()
		c.Set("oauth_client_id", "forged-client")
		c.Set("oauth_grant_id", 123)
		c.Set("auth_method", "oauth")
		assert.Nil(t, OAuthAuditMetadata(c))
		assert.Equal(t, "session", auditAuthMethod(c))
	})

	t.Run("delegation overrides generic access token label", func(t *testing.T) {
		c := newContext()
		c.Set("use_access_token", true)
		SetOAuthPrincipal(c, &service.OAuthPrincipal{UserID: 42, ClientID: "approved-client", GrantID: 17})
		assert.Equal(t, map[string]interface{}{"auth_method": "oauth", "oauth_client_id": "approved-client", "oauth_grant_id": 17}, OAuthAuditMetadata(c))
		assert.Equal(t, "oauth", auditAuthMethod(c))
	})

	t.Run("hosted session preserves action attribution", func(t *testing.T) {
		c := newContext()
		c.Set("oauth_hosted_principal", &service.OAuthPrincipal{UserID: 42, ClientID: "approved-client", GrantID: 17})
		c.Set("oauth_hosted_action_id", "approved-action")
		metadata := OAuthAuditMetadata(c)
		require.NotNil(t, metadata)
		assert.Equal(t, map[string]interface{}{"auth_method": "oauth_hosted", "oauth_client_id": "approved-client", "oauth_grant_id": 17, "oauth_action_id": "approved-action"}, metadata)
		_, delegated := GetOAuthPrincipal(c)
		assert.False(t, delegated, "hosted audit context must not change browser authentication")
	})

	t.Run("different session user cannot inherit attribution", func(t *testing.T) {
		c := newContext()
		c.Set("oauth_hosted_principal", &service.OAuthPrincipal{UserID: 99, ClientID: "approved-client", GrantID: 17})
		assert.Nil(t, OAuthAuditMetadata(c))
		assert.Equal(t, "session", auditAuthMethod(c))
	})
}
