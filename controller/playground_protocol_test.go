package controller

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

// This fixture crosses UserAuth, Distribute, Playground and the real relay;
// only the provider itself is a local HTTP server.
func TestPlaygroundSearchAttachmentsAndAccounting(t *testing.T) {
	for _, identity := range []string{"oauth", "session"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", identity, stream), func(t *testing.T) {
				user, tokens, principal := setupOAuthRelayIntegration(t)
				bearer := tokens.AccessToken
				if identity == "session" {
					require.NoError(t, model.DB.AutoMigrate(&model.UserSession{}))
					session, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "test-browser")
					require.NoError(t, err)
					bearer = session.AccessToken
				}
				// Stable nonzero tool fee proves a declaration isn't mistaken for
				// a call and duplicate terminal observations aren't double-billed.
				operation_setting.SetToolPriceForTest("web_search:oauth-test-model", 1)
				t.Cleanup(func() { operation_setting.DeleteToolPriceForTest("web_search:oauth-test-model") })
				var calls atomic.Int32
				observed := make(chan []byte, 1)
				const terminal = `{"id":"resp_fixture","model":"oauth-test-model","status":"completed","output":[{"id":"ws_fixture","type":"web_search_call","status":"completed"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Answer","annotations":[{"type":"url_citation","url":"https://source.example/article","title":"Fixture source"}]}]}],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":2}}}`
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					body, _ := io.ReadAll(r.Body)
					observed <- body
					if r.URL.Path != "/v1/responses" {
						http.Error(w, "expected Responses endpoint", 400)
						return
					}
					if stream {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Answer\"}\n\n")
						w.(http.Flusher).Flush()
						fmt.Fprint(w, "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"ws_fixture\",\"type\":\"web_search_call\",\"status\":\"completed\"}}\n\n")
						fmt.Fprintf(w, "data: {\"type\":\"response.completed\",\"response\":%s}\n\n", terminal)
						return
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, terminal)
				}))
				defer upstream.Close()
				baseURL := upstream.URL
				channel := &model.Channel{Name: "local search fixture", Type: constant.ChannelTypeOpenAI, Key: "fixture", BaseURL: &baseURL, Models: "oauth-test-model", Group: "vip", Status: common.ChannelStatusEnabled}
				require.NoError(t, channel.Insert())
				router := gin.New()
				router.Use(middleware.BodyStorageCleanup(), middleware.RelayTiming())
				router.POST("/pg/chat/completions", middleware.UserAuth(), middleware.Distribute(), Playground)
				payload := fmt.Sprintf(`{"model":"oauth-test-model","group":"vip","max_tokens":8,"stream":%t,"stream_options":{"include_usage":true},"web_search_options":{"search_context_size":"medium"},"messages":[{"role":"user","content":[{"type":"text","text":"Read attached report"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII="}},{"type":"file","file":{"filename":"report.pdf","file_data":"data:application/pdf;base64,JVBERi0="}}]}]}`, stream)
				request := httptest.NewRequest(http.MethodPost, "/pg/chat/completions", strings.NewReader(payload))
				request.Header.Set("Authorization", "Bearer "+bearer)
				request.Header.Set("Content-Type", "application/json")
				writer := httptest.NewRecorder()
				router.ServeHTTP(writer, request)
				require.Equal(t, http.StatusOK, writer.Code, writer.Body.String())
				require.EqualValues(t, 1, calls.Load())
				wire := <-observed
				assert.Equal(t, "web_search", gjson.GetBytes(wire, "tools.0.type").String())
				assert.Equal(t, "input_image", gjson.GetBytes(wire, "input.0.content.1.type").String())
				assert.Equal(t, "report.pdf", gjson.GetBytes(wire, "input.0.content.2.filename").String())
				assert.Equal(t, "data:application/pdf;base64,JVBERi0=", gjson.GetBytes(wire, "input.0.content.2.file_data").String())
				assert.Contains(t, writer.Body.String(), `"url_citation":{"url":"https://source.example/article","title":"Fixture source"}`)
				assert.Contains(t, writer.Body.String(), `"cached_tokens":2`)
				assert.Contains(t, writer.Body.String(), `"prompt_tokens":10`)
				if stream {
					assert.Contains(t, writer.Body.String(), "[DONE]")
				}
				var logs []model.Log
				require.NoError(t, model.DB.Where("user_id = ? AND type = ?", user.Id, model.LogTypeConsume).Find(&logs).Error)
				require.Len(t, logs, 1)
				assert.Equal(t, "vip", logs[0].Group)
				assert.Equal(t, 10, logs[0].PromptTokens)
				assert.Equal(t, 5, logs[0].CompletionTokens)
				assert.Equal(t, "web_search", gjson.Get(logs[0].Other, "tool_surcharges.0.name").String())
				assert.EqualValues(t, 1, gjson.Get(logs[0].Other, "tool_surcharges.0.count").Int())
				assert.Greater(t, logs[0].Quota, 100)
				wallet, err := model.GetUserQuota(user.Id, false)
				require.NoError(t, err)
				assert.Equal(t, 10000-logs[0].Quota, wallet)
				if identity == "oauth" {
					accounting, err := model.GetTokenById(logs[0].TokenId)
					require.NoError(t, err)
					assert.Equal(t, principal.GrantID, accounting.OAuthGrantID)
					assert.Equal(t, logs[0].Quota, accounting.UsedQuota)
				}
			})
		}
	}
}

func TestPlaygroundUnsupportedSearchDoesNotCallOrCharge(t *testing.T) {
	user, tokens, principal := setupOAuthRelayIntegration(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer upstream.Close()
	baseURL := upstream.URL
	channel := &model.Channel{Name: "unsupported local search fixture", Type: constant.ChannelTypeDeepSeek, Key: "fixture", BaseURL: &baseURL, Models: "oauth-test-model", Group: "vip", Status: common.ChannelStatusEnabled}
	require.NoError(t, channel.Insert())
	router := gin.New()
	router.Use(middleware.BodyStorageCleanup(), middleware.RelayTiming())
	router.POST("/pg/chat/completions", middleware.UserAuth(), middleware.Distribute(), Playground)
	request := httptest.NewRequest(http.MethodPost, "/pg/chat/completions", strings.NewReader(`{"model":"oauth-test-model","group":"vip","max_tokens":8,"web_search_options":{},"messages":[{"role":"user","content":"hello"}]}`))
	request.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	request.Header.Set("Content-Type", "application/json")
	writer := httptest.NewRecorder()
	router.ServeHTTP(writer, request)
	assert.Equal(t, http.StatusBadRequest, writer.Code, writer.Body.String())
	assert.Contains(t, writer.Body.String(), "不支持操练场联网搜索")
	assert.Zero(t, calls.Load())
	// Normal relay refunds run asynchronously. Keep the fixture alive until
	// both funding and the persisted OAuth accounting token are refunded.
	require.Eventually(t, func() bool {
		wallet, err := model.GetUserQuota(user.Id, false)
		if err != nil || wallet != 10000 {
			return false
		}
		var token model.Token
		return model.DB.Where("oauth_grant_id = ?", principal.GrantID).First(&token).Error == nil && token.UsedQuota == 0
	}, time.Second, time.Millisecond)
}
