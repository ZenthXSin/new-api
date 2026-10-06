package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm/logger"
)

func setupOAuthRelayCoverageTest(t *testing.T) *model.User {
	t.Helper()
	setupDashboardAuthMiddlewareTest(t)
	previousLogDB, previousLogType := model.LOG_DB, common.LogDatabaseType()
	t.Setenv("LOG_SQL_DSN", "")
	require.NoError(t, model.InitLogDB(), "initialize dialect-specific column quoting with the isolated test database")
	t.Cleanup(func() {
		model.LOG_DB = previousLogDB
		common.SetLogDatabaseType(previousLogType)
	})
	model.DB.Logger = logger.Default.LogMode(logger.Silent)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	sqlDB, err := model.DB.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.OauthClient{}, &model.OAuthGrant{}, &model.OAuthAccessToken{}, &model.OAuthRefreshToken{}, &model.OAuthRelayBinding{}))
	settings := system_setting.GetOauthProviderSettings()
	previousSettings := *settings
	settings.Enabled = true
	settings.Issuer = "https://oauth-relay.example.test"
	t.Cleanup(func() { *settings = previousSettings })
	return createMiddlewarePATUser(t, "oauth-relay-owner", "unrelated-dashboard-pat")
}

func issueOAuthRelayCoverageToken(t *testing.T, user *model.User, scopes, resources []string) (*model.OauthClient, *service.OAuthTokenResponse, *service.OAuthPrincipal) {
	t.Helper()
	client := &model.OauthClient{
		ClientId: "relay-client-" + strings.ReplaceAll(t.Name(), "/", "-"), Name: "Relay coverage client", Enabled: true, IsPublic: true,
		Scopes: strings.Join(scopes, " "), RedirectUris: `["https://client.example.test/callback"]`,
	}
	// This fixture skips HTTP client registration and authorization-code consent;
	// those flows have independent protocol tests. Issuance itself is real.
	require.NoError(t, model.DB.Create(client).Error)
	response, err := service.IssueOAuthTokens(client, user, scopes, resources, "")
	require.NoError(t, err)
	principal, recognized, err := service.AuthenticateOAuthAccessToken(response.AccessToken)
	require.NoError(t, err)
	require.True(t, recognized)
	require.NotNil(t, principal)
	return client, response, principal
}

func insertOAuthRelayCoverageKey(t *testing.T, userID int, key string) {
	t.Helper()
	require.NoError(t, model.DB.Create(&model.Token{
		UserId: userID, Key: key, Name: "relay coverage fixture", Status: common.TokenStatusEnabled,
		ExpiredTime: -1, UnlimitedQuota: true,
	}).Error)
}

// A credential recognized as OAuth must never become a legacy API key when
// OAuth verification fails, even if a legacy key happens to have that value.
func TestOAuthRelayCredentialPrefixCannotFallBackToAPIKey(t *testing.T) {
	user := setupOAuthRelayCoverageTest(t)
	const legacyKey = "ordinary_relay_key"
	const invalidAccess = "nao_at_collision_with_legacy_key"
	const invalidRefresh = "nao_rt_collision_with_legacy_key"
	for _, key := range []string{legacyKey, invalidAccess, invalidRefresh} {
		insertOAuthRelayCoverageKey(t, user.Id, key)
	}
	for _, authentication := range []struct {
		name string
		path string
		auth gin.HandlerFunc
	}{
		{"relay", "/v1/models", TokenAuth()},
		{"read only usage", "/api/usage/token/", TokenAuthReadOnly()},
		{"video content", "/v1/videos/task_fixture/content", TokenOrUserAuth()},
	} {
		t.Run(authentication.name, func(t *testing.T) {
			router := gin.New()
			calls := 0
			router.GET(authentication.path, authentication.auth, func(c *gin.Context) {
				calls++
				assert.Equal(t, user.Id, c.GetInt("id"))
				assert.Positive(t, c.GetInt("token_id"))
				c.Status(http.StatusNoContent)
			})
			for _, credential := range []struct {
				name string
				key  string
				code int
			}{
				{"existing API key remains valid", legacyKey, http.StatusNoContent},
				{"invalid OAuth access token", invalidAccess, http.StatusUnauthorized},
				{"OAuth refresh token is not API authentication", invalidRefresh, http.StatusUnauthorized},
			} {
				t.Run(credential.name, func(t *testing.T) {
					before := calls
					request := httptest.NewRequest(http.MethodGet, authentication.path, nil)
					request.Header.Set("Authorization", "Bearer "+credential.key)
					response := httptest.NewRecorder()
					router.ServeHTTP(response, request)
					assert.Equal(t, credential.code, response.Code, response.Body.String())
					if credential.code == http.StatusUnauthorized {
						assert.Equal(t, before, calls, "invalid OAuth credentials must not reach business handlers")
						assert.NotContains(t, response.Body.String(), credential.key, "error responses must not echo credentials")
					}
				})
			}
		})
	}
}

func TestOAuthRelayCredentialTransportAndAmbiguity(t *testing.T) {
	user := setupOAuthRelayCoverageTest(t)
	const legacyKey = "ordinary_relay_transport_key"
	const invalidAccess = "nao_at_transport_collision"
	insertOAuthRelayCoverageKey(t, user.Id, legacyKey)
	insertOAuthRelayCoverageKey(t, user.Id, invalidAccess)

	for _, test := range []struct {
		name    string
		path    string
		headers map[string]string
	}{
		{"Anthropic OAuth header", "/v1/messages", map[string]string{"x-api-key": invalidAccess}},
		{"Gemini OAuth header", "/v1beta/models", map[string]string{"x-goog-api-key": invalidAccess}},
		{"OAuth in Gemini URL is forbidden", "/v1beta/models?key=" + invalidAccess, nil},
		{"OAuth in WebSocket protocol is forbidden", "/v1/realtime", map[string]string{"Sec-WebSocket-Protocol": "realtime, openai-insecure-api-key." + invalidAccess}},
		{"invalid bearer cannot be replaced by Anthropic key", "/v1/messages", map[string]string{"Authorization": "Bearer " + invalidAccess, "x-api-key": legacyKey}},
		{"invalid bearer cannot be replaced by Gemini key", "/v1beta/models", map[string]string{"Authorization": "Bearer " + invalidAccess, "x-goog-api-key": legacyKey}},
		{"invalid bearer cannot be replaced by query key", "/v1beta/models?key=" + legacyKey, map[string]string{"Authorization": "Bearer " + invalidAccess}},
		{"invalid bearer cannot be replaced by WebSocket key", "/v1/realtime", map[string]string{"Authorization": "Bearer " + invalidAccess, "Sec-WebSocket-Protocol": "realtime, openai-insecure-api-key." + legacyKey}},
		{"legacy bearer cannot override recognized invalid OAuth header", "/v1/messages", map[string]string{"Authorization": "Bearer " + legacyKey, "x-api-key": invalidAccess}},
		{"duplicate bearer headers cannot hide OAuth", "/v1/models", map[string]string{"Authorization": "Bearer " + legacyKey, "X-Test-Duplicate-Authorization": "Bearer " + invalidAccess}},
		{"duplicate Gemini headers cannot hide OAuth", "/v1/models", map[string]string{"x-goog-api-key": legacyKey, "X-Test-Duplicate-Gemini": invalidAccess}},
		{"duplicate query values cannot hide OAuth", "/v1/models?key=" + legacyKey + "&key=" + invalidAccess, nil},
		{"unknown OAuth token purpose cannot fall back", "/v1/models", map[string]string{"Authorization": "Bearer nao_unknown_future_purpose", "x-goog-api-key": legacyKey}},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			for name, value := range test.headers {
				if name != "X-Test-Duplicate-Authorization" && name != "X-Test-Duplicate-Gemini" {
					request.Header.Set(name, value)
				}
			}
			if value := test.headers["X-Test-Duplicate-Authorization"]; value != "" {
				request.Header.Add("Authorization", value)
			}
			if value := test.headers["X-Test-Duplicate-Gemini"]; value != "" {
				request.Header.Add("x-goog-api-key", value)
			}
			response := httptest.NewRecorder()
			router := gin.New()
			reached := false
			router.GET(request.URL.Path, TokenAuth(), func(c *gin.Context) {
				reached = true
				c.Status(http.StatusNoContent)
			})
			router.ServeHTTP(response, request)
			assert.Equal(t, http.StatusUnauthorized, response.Code, response.Body.String())
			assert.False(t, reached)
			assert.NotContains(t, response.Body.String(), invalidAccess)
			assert.NotContains(t, response.Body.String(), legacyKey)
		})
	}
}

func TestOAuthRelayAcceptedTransportsShareAccountingAndStripCredentials(t *testing.T) {
	user := setupOAuthRelayCoverageTest(t)
	_, tokenResponse, principal := issueOAuthRelayCoverageToken(t, user, []string{"relay:read", "relay:invoke"}, []string{service.OAuthResourceRelay})
	var accountingID int
	for _, test := range []struct {
		name   string
		method string
		path   string
		header string
	}{
		{"OpenAI bearer", http.MethodGet, "/v1/models", "Authorization"},
		{"Anthropic header", http.MethodPost, "/v1/messages", "x-api-key"},
		{"Gemini header", http.MethodGet, "/v1beta/models", "x-goog-api-key"},
	} {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.Handle(test.method, test.path, TokenAuth(), func(c *gin.Context) {
				assert.Equal(t, user.Id, c.GetInt("id"))
				assert.Positive(t, c.GetInt("token_id"))
				if accountingID == 0 {
					accountingID = c.GetInt("token_id")
				} else {
					assert.Equal(t, accountingID, c.GetInt("token_id"), "protocol aliases must use the same grant accounting identity")
				}
				current, exists := GetOAuthPrincipal(c)
				require.True(t, exists)
				assert.Equal(t, principal.GrantID, current.GrantID)
				for _, header := range []string{"Authorization", "x-api-key", "x-goog-api-key", "mj-api-secret", "Cookie"} {
					assert.Empty(t, c.GetHeader(header), "raw credentials must not be available to upstream header copying")
				}
				assert.Equal(t, "preserved", c.GetHeader("X-Request-Metadata"))
				_, browserSession := GetSessionAuthIdentity(c)
				assert.False(t, browserSession, "delegated OAuth must never fabricate a browser session")
				c.Status(http.StatusNoContent)
			})
			request := httptest.NewRequest(test.method, test.path, nil)
			credential := tokenResponse.AccessToken
			if test.header == "Authorization" {
				credential = "Bearer " + credential
			}
			request.Header.Set(test.header, credential)
			request.Header.Set("Cookie", "browser_auth=must_not_reach_upstream")
			request.Header.Set("X-Request-Metadata", "preserved")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assert.Equal(t, http.StatusNoContent, response.Code, response.Body.String())
			assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
		})
	}
	stored, err := model.GetTokenById(accountingID)
	require.NoError(t, err)
	assert.True(t, stored.OAuthInternal)
	assert.Equal(t, principal.GrantID, stored.OAuthGrantID)
	assert.Empty(t, stored.GetFullKey(), "internal accounting key is never exportable")
}

func TestOAuthRelayGrantStateEnforcedForAccessAndDerivedKeys(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*testing.T, *model.User, *model.OauthClient, *service.OAuthPrincipal)
	}{
		{"revoked grant", func(t *testing.T, user *model.User, _ *model.OauthClient, principal *service.OAuthPrincipal) {
			require.NoError(t, service.RevokeOAuthGrant(user.Id, principal.GrantID))
		}},
		{"disabled client", func(t *testing.T, _ *model.User, client *model.OauthClient, _ *service.OAuthPrincipal) {
			require.NoError(t, model.DB.Model(client).Update("enabled", false).Error)
		}},
		{"disabled user", func(t *testing.T, user *model.User, _ *model.OauthClient, _ *service.OAuthPrincipal) {
			require.NoError(t, model.DB.Model(user).Update("status", common.UserStatusDisabled).Error)
		}},
		{"expired grant", func(t *testing.T, _ *model.User, _ *model.OauthClient, principal *service.OAuthPrincipal) {
			require.NoError(t, model.DB.Model(&model.OAuthGrant{}).Where("id = ?", principal.GrantID).Update("expires_at", time.Now().Unix()-1).Error)
		}},
		{"changed user authentication", func(t *testing.T, user *model.User, _ *model.OauthClient, _ *service.OAuthPrincipal) {
			require.NoError(t, model.DB.Model(user).Update("auth_version", user.AuthVersion+1).Error)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			user := setupOAuthRelayCoverageTest(t)
			client, tokenResponse, principal := issueOAuthRelayCoverageToken(t, user, []string{"relay:read"}, []string{service.OAuthResourceRelay})
			internal, err := model.GetOrCreateOAuthRelayToken(principal.GrantID, user.Id, principal.GrantVersion)
			require.NoError(t, err)
			derived := &model.Token{UserId: user.Id, Key: "naok_fixture_derived_key", Name: "Derived fixture", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true, OAuthGrantID: principal.GrantID, OAuthGrantVersion: principal.GrantVersion}
			require.NoError(t, model.DB.Create(derived).Error)
			for _, auth := range []struct {
				path string
				auth gin.HandlerFunc
			}{
				{"/v1/models", TokenAuth()},
				{"/api/usage/token/", TokenAuthReadOnly()},
			} {
				router := gin.New()
				router.GET(auth.path, auth.auth, func(c *gin.Context) { c.Status(http.StatusNoContent) })
				for _, credential := range []string{tokenResponse.AccessToken, "sk-" + derived.Key} {
					request := httptest.NewRequest(http.MethodGet, auth.path, nil)
					request.Header.Set("Authorization", "Bearer "+credential)
					response := httptest.NewRecorder()
					router.ServeHTTP(response, request)
					require.Equal(t, http.StatusNoContent, response.Code, response.Body.String())
				}
			}
			test.mutate(t, user, client, principal)
			for _, auth := range []struct {
				path string
				auth gin.HandlerFunc
			}{
				{"/v1/models", TokenAuth()},
				{"/api/usage/token/", TokenAuthReadOnly()},
			} {
				router := gin.New()
				reached := false
				router.GET(auth.path, auth.auth, func(c *gin.Context) { reached = true; c.Status(http.StatusNoContent) })
				for _, credential := range []string{tokenResponse.AccessToken, "sk-" + derived.Key, "sk-" + internal.Key} {
					request := httptest.NewRequest(http.MethodGet, auth.path, nil)
					request.Header.Set("Authorization", "Bearer "+credential)
					response := httptest.NewRecorder()
					router.ServeHTTP(response, request)
					assert.Equal(t, http.StatusUnauthorized, response.Code, response.Body.String())
					assert.False(t, reached)
				}
			}
			retained, err := model.GetTokenById(internal.Id)
			require.NoError(t, err, "grant invalidation retains accounting identity for accepted asynchronous tasks")
			assert.Equal(t, internal.Id, retained.Id)
		})
	}
}

func TestOAuthRelayRequiresDeclaredScopeAndResource(t *testing.T) {
	for _, test := range []struct {
		name      string
		scopes    []string
		resources []string
		path      string
	}{
		{"read cannot invoke", []string{"relay:read"}, []string{service.OAuthResourceRelay}, "/v1/chat/completions"},
		{"dashboard audience cannot invoke", []string{"relay:invoke"}, []string{service.OAuthResourceDashboard}, "/v1/chat/completions"},
		{"future route must declare scope", []string{"relay:invoke"}, []string{service.OAuthResourceRelay}, "/v1/future-endpoint"},
	} {
		t.Run(test.name, func(t *testing.T) {
			user := setupOAuthRelayCoverageTest(t)
			_, tokenResponse, _ := issueOAuthRelayCoverageToken(t, user, test.scopes, test.resources)
			router := gin.New()
			reached := false
			router.POST(test.path, TokenAuth(), func(c *gin.Context) { reached = true; c.Status(http.StatusNoContent) })
			request := httptest.NewRequest(http.MethodPost, test.path, nil)
			request.Header.Set("Authorization", "Bearer "+tokenResponse.AccessToken)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assert.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
			assert.False(t, reached)
		})
	}
}

func TestOAuthRelayTasksUseAuthenticatedUserOwnership(t *testing.T) {
	user := setupOAuthRelayCoverageTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Task{}, &model.Midjourney{}))
	_, tokenResponse, principal := issueOAuthRelayCoverageToken(t, user, []string{"relay:tasks"}, []string{service.OAuthResourceRelay})
	internal, err := model.GetOrCreateOAuthRelayToken(principal.GrantID, user.Id, principal.GrantVersion)
	require.NoError(t, err)
	other := createMiddlewarePATUser(t, "oauth-relay-other", "other-dashboard-pat")
	for _, owner := range []*model.User{user, other} {
		task := &model.Task{TaskID: fmt.Sprintf("task_%d", owner.Id), UserId: owner.Id, Platform: constant.TaskPlatformSuno, Status: model.TaskStatusSuccess, Progress: "100%", PrivateData: model.TaskPrivateData{TokenId: internal.Id + 100, Key: "private_upstream_key_must_stay_private"}}
		require.NoError(t, model.DB.Create(task).Error)
		require.NoError(t, model.DB.Create(&model.Midjourney{UserId: owner.Id, MjId: fmt.Sprintf("mj_%d", owner.Id), Prompt: fmt.Sprintf("owner_%d_prompt", owner.Id), Status: "SUCCESS", TokenId: internal.Id + 100}).Error)
	}
	router := gin.New()
	router.GET("/suno/fetch/:id", TokenAuth(), func(c *gin.Context) {
		if failure := relay.RelayTaskFetch(c, relayconstant.RelayModeSunoFetchByID); failure != nil {
			c.JSON(failure.StatusCode, gin.H{"error": failure.Code})
		}
	})
	router.GET("/mj/task/:id/fetch", TokenAuth(), func(c *gin.Context) {
		if failure := relay.RelayMidjourneyTask(c, relayconstant.RelayModeMidjourneyTaskFetch); failure != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": failure.Description})
		}
	})
	for _, test := range []struct {
		path string
		code int
	}{
		{fmt.Sprintf("/suno/fetch/task_%d", user.Id), http.StatusOK},
		{fmt.Sprintf("/suno/fetch/task_%d", other.Id), http.StatusBadRequest},
		{fmt.Sprintf("/mj/task/mj_%d/fetch", user.Id), http.StatusOK},
		{fmt.Sprintf("/mj/task/mj_%d/fetch", other.Id), http.StatusBadRequest},
	} {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			request.Header.Set("Authorization", "Bearer "+tokenResponse.AccessToken)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assert.Equal(t, test.code, response.Code, response.Body.String())
			if test.code == http.StatusOK && strings.HasPrefix(test.path, "/suno/") {
				var payload struct {
					Data struct {
						TaskID string `json:"task_id"`
						UserID int    `json:"user_id"`
					} `json:"data"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
				assert.Equal(t, fmt.Sprintf("task_%d", user.Id), payload.Data.TaskID)
				assert.Equal(t, user.Id, payload.Data.UserID)
			} else if test.code == http.StatusOK {
				var payload struct {
					Prompt string `json:"prompt"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
				assert.Equal(t, fmt.Sprintf("owner_%d_prompt", user.Id), payload.Prompt)
			}
			assert.NotContains(t, response.Body.String(), "private_upstream_key_must_stay_private")
			assert.NotContains(t, response.Body.String(), fmt.Sprintf("owner_%d_prompt", other.Id))
		})
	}
}

func TestOAuthRelayWebSocketTicketIsSingleUseAndNeverForwarded(t *testing.T) {
	user := setupOAuthRelayCoverageTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.AuthFlow{}))
	_, tokenResponse, principal := issueOAuthRelayCoverageToken(t, user, []string{"relay:invoke"}, []string{service.OAuthResourceRelay})
	ticket, err := service.CreateOAuthRelayTicket(principal)
	require.NoError(t, err)
	router := gin.New()
	handshakes := 0
	router.GET("/v1/realtime", TokenAuth(), func(c *gin.Context) {
		handshakes++
		assert.Equal(t, user.Id, c.GetInt("id"))
		assert.Positive(t, c.GetInt("token_id"))
		assert.Equal(t, "realtime", c.GetHeader("Sec-WebSocket-Protocol"))
		assert.Empty(t, c.GetHeader("Authorization"))
		assert.Empty(t, c.GetHeader("Cookie"))
		c.Status(http.StatusNoContent)
	})
	for _, expected := range []int{http.StatusNoContent, http.StatusUnauthorized} {
		request := httptest.NewRequest(http.MethodGet, "/v1/realtime?model=example-realtime", nil)
		request.Header.Set("Sec-WebSocket-Protocol", "realtime, openai-insecure-api-key."+ticket)
		request.Header.Set("Cookie", "browser_auth=must_not_reach_upstream")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		assert.Equal(t, expected, response.Code, response.Body.String())
		assert.NotContains(t, response.Body.String(), ticket)
		assert.NotContains(t, response.Body.String(), tokenResponse.AccessToken)
	}
	assert.Equal(t, 1, handshakes, "replaying a consumed handshake ticket cannot establish another connection")
}
