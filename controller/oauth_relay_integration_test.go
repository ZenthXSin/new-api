package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// The first token must reach the downstream before the upstream is permitted
// to send its usage and terminal events. This is a synchronization assertion,
// not a wall-clock latency benchmark or a sleep-based streaming check.
type oauthRelayFirstTokenWriter struct {
	*httptest.ResponseRecorder
	firstToken chan struct{}
	once       sync.Once
}

func (w *oauthRelayFirstTokenWriter) Flush() {
	w.ResponseRecorder.Flush()
	if strings.Contains(w.Body.String(), "首字") {
		w.once.Do(func() { close(w.firstToken) })
	}
}

func setupOAuthRelayIntegration(t *testing.T) (*model.User, *service.OAuthTokenResponse, *service.OAuthPrincipal) {
	t.Helper()
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldMainType, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
	oldRedis, oldBatch, oldMemory := common.RedisEnabled, common.BatchUpdateEnabled, common.MemoryCacheEnabled
	oldConsumeLog, oldDataExport := common.LogConsumeEnabled, common.DataExportEnabled
	oldCount, oldSensitive := constant.CountToken, setting.CheckSensitiveEnabled
	oldStreamingTimeout := constant.StreamingTimeout
	oldPreConsume, oldWarning := common.PreConsumedQuota, common.QuotaRemindThreshold
	oldProvider := *system_setting.GetOauthProviderSettings()
	oldGroups, oldGroupRatios := setting.UserUsableGroups2JSONString(), ratio_setting.GroupRatio2JSONString()
	oldModelRatios, oldCompletionRatios, oldModelPrices := ratio_setting.ModelRatio2JSONString(), ratio_setting.CompletionRatio2JSONString(), ratio_setting.ModelPrice2JSONString()
	oldGinMode := gin.Mode()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled, common.BatchUpdateEnabled, common.MemoryCacheEnabled = false, false, false
	common.LogConsumeEnabled, common.DataExportEnabled = true, false
	constant.CountToken, setting.CheckSensitiveEnabled = false, false
	constant.StreamingTimeout = 30
	common.PreConsumedQuota, common.QuotaRemindThreshold = 100, -1
	gin.SetMode(gin.TestMode)
	t.Setenv("LOG_SQL_DSN", "")
	require.NoError(t, model.InitLogDB())
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.SetDatabaseTypes(oldMainType, oldLogType)
		common.RedisEnabled, common.BatchUpdateEnabled, common.MemoryCacheEnabled = oldRedis, oldBatch, oldMemory
		common.LogConsumeEnabled, common.DataExportEnabled = oldConsumeLog, oldDataExport
		constant.CountToken, setting.CheckSensitiveEnabled = oldCount, oldSensitive
		constant.StreamingTimeout = oldStreamingTimeout
		common.PreConsumedQuota, common.QuotaRemindThreshold = oldPreConsume, oldWarning
		*system_setting.GetOauthProviderSettings() = oldProvider
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldGroupRatios))
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(oldModelRatios))
		require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(oldCompletionRatios))
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(oldModelPrices))
		gin.SetMode(oldGinMode)
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.OauthClient{}, &model.OAuthGrant{}, &model.OAuthAccessToken{}, &model.OAuthRefreshToken{}, &model.OAuthRelayBinding{}, &model.Channel{}, &model.Ability{}, &model.Log{}))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"vip":"vip"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"vip":2}`))
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"oauth-test-model":2}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"oauth-test-model":3}`))
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{}`))
	provider := system_setting.GetOauthProviderSettings()
	provider.Enabled, provider.Issuer = true, "https://oauth-integration.example.test/oidc"
	user := &model.User{Username: "oauth-integration-owner", Password: "integration-password-hash", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "vip", AuthVersion: 1, Quota: 10000, Setting: `{"billing_preference":"wallet_only"}`}
	require.NoError(t, db.Create(user).Error)
	client := &model.OauthClient{ClientId: "oauth-integration-client", Name: "Integration client", IsPublic: true, Enabled: true, RedirectUris: `["https://client.example.test/callback"]`, Scopes: "relay:invoke"}
	require.NoError(t, db.Create(client).Error)
	response, err := service.IssueOAuthTokens(client, user, []string{"relay:invoke"}, []string{service.OAuthResourceRelay}, "")
	require.NoError(t, err)
	principal, recognized, err := service.AuthenticateOAuthAccessToken(response.AccessToken)
	require.NoError(t, err)
	require.True(t, recognized)
	return user, response, principal
}

func TestOAuthRelayIntegrationChatAndPlaygroundBilling(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/pg/chat/completions"} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", path, streaming), func(t *testing.T) {
				user, tokenResponse, principal := setupOAuthRelayIntegration(t)
				type upstreamObservation struct {
					path, authorization, cookie, model string
					stream                             bool
					reservedWallet                     int
				}
				observed := make(chan upstreamObservation, 1)
				tail := make(chan struct{})
				var releaseOnce sync.Once
				releaseTail := func() { releaseOnce.Do(func() { close(tail) }) }
				var upstreamCalls atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					upstreamCalls.Add(1)
					var body struct {
						Model  string `json:"model"`
						Stream bool   `json:"stream"`
					}
					if err := common.DecodeJson(r.Body, &body); err != nil {
						http.Error(w, "invalid fixture request", http.StatusBadRequest)
						return
					}
					quota, _ := model.GetUserQuota(user.Id, false)
					observed <- upstreamObservation{r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Cookie"), body.Model, body.Stream, quota}
					if !body.Stream {
						w.Header().Set("Content-Type", "application/json")
						_, _ = fmt.Fprint(w, `{"id":"chat_fixture","object":"chat.completion","model":"oauth-test-model","choices":[{"index":0,"message":{"role":"assistant","content":"首字"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprint(w, "data: {\"id\":\"chat_fixture\",\"object\":\"chat.completion.chunk\",\"model\":\"oauth-test-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"首字\"},\"finish_reason\":null}]}\n\n")
					w.(http.Flusher).Flush()
					select {
					case <-tail:
					case <-r.Context().Done():
						return
					}
					_, _ = fmt.Fprint(w, "data: {\"id\":\"chat_fixture\",\"object\":\"chat.completion.chunk\",\"model\":\"oauth-test-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"id\":\"chat_fixture\",\"object\":\"chat.completion.chunk\",\"model\":\"oauth-test-model\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\ndata: [DONE]\n\n")
					w.(http.Flusher).Flush()
				}))
				defer upstream.Close()
				defer releaseTail()
				baseURL := upstream.URL
				channel := &model.Channel{Name: "Local OAuth fixture upstream", Type: constant.ChannelTypeOpenAI, Key: "upstream_fixture_secret", BaseURL: &baseURL, Models: "oauth-test-model", Group: "vip", Status: common.ChannelStatusEnabled}
				require.NoError(t, channel.Insert())
				router := gin.New()
				router.Use(middleware.BodyStorageCleanup(), middleware.RelayTiming())
				if path == "/pg/chat/completions" {
					router.POST(path, middleware.UserAuth(), middleware.Distribute(), Playground)
				} else {
					router.POST(path, middleware.TokenAuth(), middleware.Distribute(), func(c *gin.Context) { Relay(c, types.RelayFormatOpenAI) })
				}
				body := fmt.Sprintf(`{"model":"oauth-test-model","group":"vip","max_tokens":8,"stream":%t,"messages":[{"role":"user","content":"hello"}],"stream_options":{"include_usage":true}}`, streaming)
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
				request.Header.Set("Authorization", "Bearer "+tokenResponse.AccessToken)
				request.Header.Set("Cookie", "browser_auth=should_not_escape")
				request.Header.Set("Content-Type", "application/json")
				writer := &oauthRelayFirstTokenWriter{ResponseRecorder: httptest.NewRecorder(), firstToken: make(chan struct{})}
				finished := make(chan struct{})
				go func() {
					defer close(finished)
					router.ServeHTTP(writer, request)
				}()
				if streaming {
					select {
					case <-writer.firstToken:
						select {
						case <-finished:
							t.Error("stream completed before upstream tail was released")
						default:
						}
					case <-finished:
						t.Fatalf("stream finished without forwarding first token: %s", writer.Body.String())
					case <-time.After(5 * time.Second):
						releaseTail()
						<-finished
						t.Fatal("first token was buffered while upstream waited for terminal-event permission")
					}
					releaseTail()
				}
				select {
				case <-finished:
				case <-time.After(5 * time.Second):
					t.Fatal("local relay fixture did not complete")
				}
				require.Equal(t, http.StatusOK, writer.Code, writer.Body.String())
				assert.Contains(t, writer.Body.String(), "首字")
				if streaming {
					assert.Contains(t, writer.Body.String(), "[DONE]")
				}
				assert.EqualValues(t, 1, upstreamCalls.Load())
				upstreamRequest := <-observed
				assert.Equal(t, "/v1/chat/completions", upstreamRequest.path)
				assert.Equal(t, "Bearer upstream_fixture_secret", upstreamRequest.authorization)
				assert.Empty(t, upstreamRequest.cookie)
				assert.Equal(t, "oauth-test-model", upstreamRequest.model)
				assert.Equal(t, streaming, upstreamRequest.stream)
				assert.Equal(t, 10000-(100+8)*2*2, upstreamRequest.reservedWallet, "wallet reservation must precede upstream submission")
				var logs []model.Log
				require.NoError(t, model.DB.Where("user_id = ? AND type = ?", user.Id, model.LogTypeConsume).Find(&logs).Error)
				require.Len(t, logs, 1)
				log := logs[0]
				assert.Positive(t, log.TokenId, "OAuth playground must retain a persisted accounting token")
				assert.Equal(t, (10+5*3)*2*2, log.Quota)
				assert.Equal(t, "vip", log.Group)
				assert.Equal(t, channel.Id, log.ChannelId)
				assert.Equal(t, streaming, log.IsStream)
				assert.Equal(t, 10, log.PromptTokens)
				assert.Equal(t, 5, log.CompletionTokens)
				accounting, err := model.GetTokenById(log.TokenId)
				require.NoError(t, err)
				assert.True(t, accounting.OAuthInternal)
				assert.Equal(t, principal.GrantID, accounting.OAuthGrantID)
				assert.Equal(t, log.Quota, accounting.UsedQuota)
				wallet, err := model.GetUserQuota(user.Id, false)
				require.NoError(t, err)
				assert.Equal(t, 10000-log.Quota, wallet)
				require.NoError(t, service.RevokeOAuthGrant(user.Id, principal.GrantID))
				retry := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
				retry.Header.Set("Authorization", "Bearer "+tokenResponse.AccessToken)
				retry.Header.Set("Content-Type", "application/json")
				rejected := httptest.NewRecorder()
				router.ServeHTTP(rejected, retry)
				assert.Equal(t, http.StatusUnauthorized, rejected.Code)
				assert.EqualValues(t, 1, upstreamCalls.Load(), "revocation rejects new requests before contacting the upstream")
				remaining, err := model.GetUserQuota(user.Id, false)
				require.NoError(t, err)
				assert.Equal(t, wallet, remaining)
			})
		}
	}
}
