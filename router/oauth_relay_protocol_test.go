package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthRelayModelListPreservesProviderFormats(t *testing.T) {
	setupRelayRouterTestDB(t)
	require.NoError(t, model.DB.AutoMigrate(&model.OauthClient{}, &model.OAuthGrant{}, &model.OAuthAccessToken{}, &model.OAuthRefreshToken{}, &model.OAuthRelayBinding{}))
	settings := system_setting.GetOauthProviderSettings()
	oldSettings := *settings
	settings.Enabled = true
	settings.Issuer = "https://relay-protocol.example.test"
	t.Cleanup(func() { *settings = oldSettings })
	user := &model.User{Username: "oauth-models-user", Password: "fixture", Status: common.UserStatusEnabled, Role: common.RoleCommonUser, Group: "default", Quota: 100, AuthVersion: 1}
	require.NoError(t, model.DB.Create(user).Error)
	client := &model.OauthClient{ClientId: "oauth-models-client", Name: "protocol test", Enabled: true, IsPublic: true, Scopes: "relay:read", RedirectUris: `["https://client.example.test/callback"]`}
	require.NoError(t, model.DB.Create(client).Error)
	response, err := service.IssueOAuthTokens(client, user, []string{"relay:read"}, []string{service.OAuthResourceRelay}, "")
	require.NoError(t, err)
	engine := gin.New()
	SetRelayRouter(engine)
	for _, test := range []struct {
		name, header, field string
		anthropic           bool
	}{
		{"OpenAI", "Authorization", "data", false},
		{"Anthropic", "x-api-key", "has_more", true},
		{"Gemini", "x-goog-api-key", "models", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
			value := response.AccessToken
			if test.header == "Authorization" {
				value = "Bearer " + value
			}
			request.Header.Set(test.header, value)
			if test.anthropic {
				request.Header.Set("anthropic-version", "2023-06-01")
			}
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			var payload map[string]any
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
			assert.Contains(t, payload, test.field)
			assert.NotContains(t, recorder.Body.String(), response.AccessToken)
		})
	}
}
