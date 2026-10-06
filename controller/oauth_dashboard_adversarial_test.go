package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthDashboardCannotForgeBrowserSessionFromHeaders(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "profile:read"
	require.NoError(t, db.Model(client).Update("scopes", client.Scopes).Error)
	token, err := service.IssueOAuthTokens(client, user, []string{"profile:read"}, []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	router := gin.New()
	router.GET("/api/user/self", middleware.UserAuth(), func(c *gin.Context) {
		_, realSession := middleware.GetSessionAuthIdentity(c)
		principal, delegated := middleware.GetOAuthPrincipal(c)
		c.JSON(http.StatusOK, gin.H{"id": c.GetInt("id"), "session_id": c.GetString("session_id"), "session_version": c.GetInt64("session_version"), "real_session": realSession, "delegated": delegated, "client_id": principal.ClientID})
	})
	req := httptest.NewRequest(http.MethodGet, "/api/user/self", nil)
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("New-Api-User", "99999")
	req.Header.Set("X-Session-Id", "forged-session")
	req.Header.Set("X-Session-Version", "999")
	req.Header.Set("Auth-Version", "999")
	req.Header.Set("Cookie", "new_api_has_session=1; session_id=forged-session")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		ID             int    `json:"id"`
		SessionID      string `json:"session_id"`
		SessionVersion int64  `json:"session_version"`
		RealSession    bool   `json:"real_session"`
		Delegated      bool   `json:"delegated"`
		ClientID       string `json:"client_id"`
	}
	require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, user.Id, body.ID)
	assert.Empty(t, body.SessionID)
	assert.Zero(t, body.SessionVersion)
	assert.False(t, body.RealSession)
	assert.True(t, body.Delegated)
	assert.Equal(t, client.ClientId, body.ClientID)
}

func TestOAuthRecognizedInvalidCredentialNeverFallsBackToMatchingLegacyPAT(t *testing.T) {
	for _, raw := range []string{"nao_at_invalid", "nao_rt_" + strings.Repeat("a", 43), "nao_ws_" + strings.Repeat("b", 43), "nao_unknown_purpose"} {
		t.Run(raw[:min(18, len(raw))], func(t *testing.T) {
			db, user := setupOidcProviderTest(t)
			require.NoError(t, db.Model(&model.User{}).Where("id = ?", user.Id).Update("access_token", raw).Error)
			router := gin.New()
			reached := false
			router.GET("/api/user/self", middleware.UserAuth(), func(c *gin.Context) { reached = true; c.Status(http.StatusNoContent) })
			req := httptest.NewRequest(http.MethodGet, "/api/user/self", nil)
			req.Header.Set("Authorization", "Bearer "+raw)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.False(t, reached)
			assert.Contains(t, rec.Body.String(), "OAUTH_INVALID_TOKEN")
		})
	}
}

func TestOAuthNewUndeclaredRouteRejectsDelegationWhileExistingPATStillWorks(t *testing.T) {
	db, user := setupOidcProviderTest(t)
	client, _ := createOidcTestClient(t, true)
	client.Scopes = "profile:read"
	require.NoError(t, db.Model(client).Update("scopes", client.Scopes).Error)
	token, err := service.IssueOAuthTokens(client, user, []string{"profile:read"}, []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	pat := "legacy-pat-with-dots.example"
	require.NoError(t, db.Model(&model.User{}).Where("id = ?", user.Id).Update("access_token", pat).Error)
	router := gin.New()
	router.GET("/api/future-unreviewed-operation", middleware.UserAuth(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	for _, tc := range []struct {
		name, raw string
		status    int
	}{{"delegated", token.AccessToken, http.StatusForbidden}, {"legacy PAT", pat, http.StatusNoContent}} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/future-unreviewed-operation", nil)
			req.Header.Set("Authorization", "Bearer "+tc.raw)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			assert.Equal(t, tc.status, rec.Code, rec.Body.String())
			if tc.name == "delegated" {
				assert.Contains(t, rec.Body.String(), "OAUTH_ROUTE_UNDECLARED")
			}
		})
	}
}
