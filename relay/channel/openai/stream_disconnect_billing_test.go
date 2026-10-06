package openai

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	hosttypes "github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// The body delivers a known prefix, then cancels the client while the scanner
// is waiting for the next event. Close must unblock Read, just like an HTTP body.
type disconnectStreamBody struct {
	reader    *strings.Reader
	forwarded <-chan struct{}
	closed    chan struct{}
	cancel    context.CancelFunc
}

func (b *disconnectStreamBody) Read(p []byte) (int, error) {
	if b.reader.Len() > 0 {
		return b.reader.Read(p)
	}
	select {
	case <-b.forwarded:
		b.cancel()
	case <-b.closed:
		return 0, io.EOF
	}
	<-b.closed
	return 0, io.EOF
}

func (b *disconnectStreamBody) Close() error {
	select {
	case <-b.closed:
	default:
		close(b.closed)
	}
	return nil
}

type observedStreamWriter struct {
	*httptest.ResponseRecorder
	marker    string
	forwarded chan struct{}
	cancel    context.CancelFunc
}

func (w *observedStreamWriter) Flush() {
	w.ResponseRecorder.Flush()
	if strings.Contains(w.Body.String(), w.marker) {
		select {
		case <-w.forwarded:
		default:
			if w.cancel != nil {
				w.cancel()
			}
			close(w.forwarded)
		}
	}
}

func TestStreamDisconnectPreservesBillableUsage(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 5
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	const output = "Partial generated output before the client disconnected."
	for _, tc := range []struct {
		name          string
		body          string
		marker        string
		handler       func(*gin.Context, *relaycommon.RelayInfo, *http.Response) (*dto.Usage, *types.NewAPIError)
		format        types.RelayFormat
		cancelOnFlush bool
	}{
		{
			name: "Responses reasoning before terminal usage",
			body: `data: {"type":"response.created","response":{"status":"in_progress"}}` + "\n\n" +
				`data: {"type":"response.reasoning_summary_text.delta","delta":"` + output + `"}` + "\n\n",
			marker: output, handler: OaiResponsesStreamHandler, format: types.RelayFormatOpenAIResponses,
		},
		{
			name:   "Responses tool arguments before terminal usage",
			body:   `data: {"type":"response.function_call_arguments.delta","delta":"` + output + `"}` + "\n\n",
			marker: output, handler: OaiResponsesStreamHandler, format: types.RelayFormatOpenAIResponses,
		},
		{
			name:   "Responses text before terminal usage",
			body:   `data: {"type":"response.output_text.delta","delta":"` + output + `"}` + "\n\n",
			marker: output, handler: OaiResponsesStreamHandler, format: types.RelayFormatOpenAIResponses,
		},
		{
			name: "converted Responses stream with disconnected downstream",
			body: `data: {"type":"response.created","response":{"id":"resp_disconnect","status":"in_progress"}}` + "\n\n" +
				`data: {"type":"response.output_text.delta","delta":"` + output + `"}` + "\n\n",
			marker: output, handler: OaiResponsesToChatStreamHandler, format: types.RelayFormatOpenAI,
		},
		{
			name:   "converted Responses downstream disconnect during write",
			body:   `data: {"type":"response.output_text.delta","delta":"` + output + `"}` + "\n\n",
			marker: output, handler: OaiResponsesToChatStreamHandler, format: types.RelayFormatOpenAI,
			cancelOnFlush: true,
		},
		{
			name: "converted Chat Completions stream with disconnected downstream",
			body: `data: {"id":"chat_disconnect","choices":[{"index":0,"delta":{"content":"` + output + `"}}]}` + "\n\n" +
				`data: {"id":"chat_disconnect","choices":[{"index":0,"delta":{"content":""}}]}` + "\n\n",
			marker: output, handler: OaiChatToResponsesStreamHandler, format: types.RelayFormatOpenAIResponses,
		},
		{
			name: "ordinary Chat Completions before terminal usage",
			body: `data: {"id":"chat_disconnect","choices":[{"index":0,"delta":{"content":"` + output + `"}}]}` + "\n\n" +
				`data: {"id":"chat_disconnect","choices":[{"index":0,"delta":{"content":""}}]}` + "\n\n",
			marker: output, handler: OaiStreamHandler, format: types.RelayFormatOpenAI,
		},
		{
			name:          "ordinary Chat Completions disconnect on first flush",
			body:          `data: {"id":"chat_disconnect","choices":[{"index":0,"delta":{"content":"` + output + `"}}]}` + "\n\n",
			marker:        output,
			handler:       OaiStreamHandler,
			format:        types.RelayFormatOpenAI,
			cancelOnFlush: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			writer := &observedStreamWriter{ResponseRecorder: httptest.NewRecorder(), marker: tc.marker, forwarded: make(chan struct{})}
			if tc.cancelOnFlush {
				writer.cancel = cancel
			}
			c, _ := gin.CreateTestContext(writer)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil).WithContext(ctx)
			c.Set(common.RequestIdKey, "stream-disconnect-regression")
			body := &disconnectStreamBody{reader: strings.NewReader(tc.body), forwarded: writer.forwarded, closed: make(chan struct{}), cancel: cancel}
			info := &relaycommon.RelayInfo{
				ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "billing-test-model"},
				RelayFormat: tc.format, RelayMode: relayconstant.RelayModeChatCompletions,
				OriginModelName: "billing-test-model", IsStream: true, DisablePing: true,
				ShouldIncludeUsage: true, StartTime: time.Now(),
			}
			info.SetEstimatePromptTokens(100)
			resp := &http.Response{StatusCode: http.StatusOK, Body: body, Header: http.Header{"Content-Type": {"text/event-stream"}}}
			usage, apiErr := tc.handler(c, info, resp)
			require.ErrorIs(t, ctx.Err(), context.Canceled)
			require.Nil(t, apiErr, "client disconnect must not enter the request-failure refund path")
			require.NotNil(t, usage)
			assert.Equal(t, 100, usage.PromptTokens)
			assert.Positive(t, usage.CompletionTokens)
			assert.Equal(t, usage.PromptTokens+usage.CompletionTokens, usage.TotalTokens)
			assert.Contains(t, writer.Body.String(), output)
			assert.Equal(t, service.CountTextToken(output, "billing-test-model"), usage.CompletionTokens)
		})
	}
}

func TestResponsesDisconnectRetainsCompletedImageUsage(t *testing.T) {
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 5
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	writer := &observedStreamWriter{ResponseRecorder: httptest.NewRecorder(), marker: "completed-image-result", forwarded: make(chan struct{})}
	c, _ := gin.CreateTestContext(writer)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil).WithContext(ctx)
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "billing-test-model"}, DisablePing: true}
	info.SetEstimatePromptTokens(100)
	body := &disconnectStreamBody{
		reader:    strings.NewReader(`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"image_generation_call","id":"img_disconnect","status":"completed","result":"completed-image-result"}}` + "\n\n"),
		forwarded: writer.forwarded, closed: make(chan struct{}), cancel: cancel,
	}
	usage, apiErr := OaiResponsesStreamHandler(c, info, &http.Response{StatusCode: http.StatusOK, Body: body, Header: http.Header{"Content-Type": {"text/event-stream"}}})
	require.ErrorIs(t, ctx.Err(), context.Canceled)
	require.Nil(t, apiErr)
	require.NotNil(t, usage)
	assert.Equal(t, 100, usage.PromptTokens)
	require.NotNil(t, info.ResponsesUsageInfo)
	imageUsage := info.ResponsesUsageInfo.BuiltInTools[dto.BuildInToolImageGeneration]
	require.NotNil(t, imageUsage)
	assert.Equal(t, 1, imageUsage.CallCount, "a delivered completed image remains billable when the final response event is missing")
}

func TestResponsesConvertedUpstreamFailureRemainsRefundable(t *testing.T) {
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 5
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	c, _, resp, info := newResponsesChatTestContext(t, `data: {"type":"response.failed","response":{"status":"failed","error":{"type":"server_error","message":"upstream unavailable"}}}`+"\n\n", true)
	usage, apiErr := OaiResponsesToChatStreamHandler(c, info, resp)
	assert.Nil(t, usage)
	require.NotNil(t, apiErr, "an upstream failure must not be reclassified as a client disconnect")
}

func TestResponsesMissingUsageDoesNotOverrideReportedUsageOrChargeEmptyFailures(t *testing.T) {
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 5
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	const output = "Generated output"
	for _, tc := range []struct {
		name       string
		events     []string
		prompt     int
		completion int
		cache      int
	}{
		{name: "no upstream events"},
		{name: "invalid event", events: []string{`not-json`}},
		{name: "started stream missing usage", events: []string{`{"type":"response.created","response":{"status":"in_progress"}}`}, prompt: 100},
		{name: "explicit upstream failure", events: []string{`{"type":"response.created"}`, `{"type":"response.failed","response":{"status":"failed"}}`}},
		{name: "flat upstream error", events: []string{`{"type":"response.created"}`, `{"type":"error","code":"server_error"}`}},
		{name: "incomplete still has reported usage", events: []string{`{"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":80,"output_tokens":15,"input_tokens_details":{"cached_tokens":60}}}}`}, prompt: 80, completion: 15, cache: 60},
		{name: "completed reported usage takes precedence", events: []string{`{"type":"response.output_text.delta","delta":"` + output + `"}`, `{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":80,"output_tokens":3,"input_tokens_details":{"cached_tokens":60}}}}`}, prompt: 80, completion: 3, cache: 60},
		{name: "zero usage fields do not hide observed output", events: []string{`{"type":"response.output_text.delta","delta":"` + output + `"}`, `{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":0,"output_tokens":0}}}`}, prompt: 100, completion: service.CountTextToken(output, "billing-test-model")},
		{name: "terminal text without usage", events: []string{`{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"` + output + `"}]}]}}`}, prompt: 100, completion: service.CountTextToken(output, "billing-test-model")},
		{name: "refusal delta is generated output", events: []string{`{"type":"response.refusal.delta","delta":"` + output + `"}`}, prompt: 100, completion: service.CountTextToken(output, "billing-test-model")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body strings.Builder
			for _, event := range tc.events {
				body.WriteString("data: " + event + "\n\n")
			}
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
			info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "billing-test-model"}, DisablePing: true}
			info.SetEstimatePromptTokens(100)
			resp := &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body.String())), Header: http.Header{"Content-Type": {"text/event-stream"}}}
			usage, apiErr := OaiResponsesStreamHandler(c, info, resp)
			require.Nil(t, apiErr)
			require.NotNil(t, usage)
			assert.Equal(t, tc.prompt, usage.PromptTokens)
			assert.Equal(t, tc.completion, usage.CompletionTokens)
			assert.Equal(t, tc.cache, usage.PromptTokensDetails.CachedTokens)
			assert.Equal(t, tc.prompt+tc.completion, usage.TotalTokens)
		})
	}
}

func TestDisconnectedStreamSettlesWalletAndTokenWithoutFullRefund(t *testing.T) {
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldMainType, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
	oldRedis, oldBatch, oldLogs := common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled
	oldTimeout := constant.StreamingTimeout
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = false, false, true
	constant.StreamingTimeout = 5
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.SetDatabaseTypes(oldMainType, oldLogType)
		common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = oldRedis, oldBatch, oldLogs
		constant.StreamingTimeout = oldTimeout
	})
	for _, tc := range []struct {
		name    string
		trusted bool
	}{
		{name: "wallet with pre-consume"},
		{name: "trusted wallet without pre-consume", trusted: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			t.Cleanup(func() { assert.NoError(t, sqlDB.Close()) })
			model.DB, model.LOG_DB = db, db
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Channel{}, &model.Log{}))
			const startingQuota = 100000000
			const reservedQuota = 1000
			user := model.User{Id: 981, Username: "disconnect-test", Status: common.UserStatusEnabled, Quota: startingQuota}
			token := model.Token{Id: 982, UserId: user.Id, Key: "disconnect-test-token", Name: "disconnect-test", Status: common.TokenStatusEnabled, RemainQuota: startingQuota}
			channel := model.Channel{Id: 983, Name: "disconnect-test", Key: "test-only", Status: common.ChannelStatusEnabled}
			require.NoError(t, db.Create(&user).Error)
			require.NoError(t, db.Create(&token).Error)
			require.NoError(t, db.Create(&channel).Error)
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			const output = "Generated reasoning before disconnection."
			writer := &observedStreamWriter{ResponseRecorder: httptest.NewRecorder(), marker: output, forwarded: make(chan struct{})}
			c, _ := gin.CreateTestContext(writer)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil).WithContext(ctx)
			c.Set(common.RequestIdKey, "disconnect-settlement-test")
			c.Set("token_quota", startingQuota)
			info := &relaycommon.RelayInfo{
				ChannelMeta: &relaycommon.ChannelMeta{ChannelId: channel.Id, UpstreamModelName: "billing-test-model"},
				UserId:      user.Id, TokenId: token.Id, TokenKey: token.Key, TokenUnlimited: tc.trusted,
				UserSetting: dto.UserSetting{BillingPreference: "wallet_only"}, ForcePreConsume: !tc.trusted,
				OriginModelName: "billing-test-model", IsStream: true, DisablePing: true, StartTime: time.Now(),
				PriceData: hosttypes.PriceData{ModelRatio: 1, CompletionRatio: 2, CacheRatio: 0.1, GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 1}},
			}
			info.SetEstimatePromptTokens(100)
			require.Nil(t, service.PreConsumeBilling(c, reservedQuota, info))
			wantReserved := reservedQuota
			if tc.trusted {
				wantReserved = 0
			}
			assert.Equal(t, wantReserved, info.Billing.GetPreConsumedQuota())
			body := &disconnectStreamBody{reader: strings.NewReader(`data: {"type":"response.reasoning_summary_text.delta","delta":"` + output + `"}` + "\n\n"), forwarded: writer.forwarded, closed: make(chan struct{}), cancel: cancel}
			resp := &http.Response{StatusCode: http.StatusOK, Body: body, Header: http.Header{"Content-Type": {"text/event-stream"}}}
			usage, apiErr := OaiResponsesStreamHandler(c, info, resp)
			require.Nil(t, apiErr)
			require.NotNil(t, usage)
			require.ErrorIs(t, ctx.Err(), context.Canceled)
			service.PostTextConsumeQuota(c, info, usage, nil)
			wantCharge := 100 + 2*service.CountTextToken(output, "billing-test-model")
			require.NoError(t, db.First(&user, user.Id).Error)
			require.NoError(t, db.First(&token, token.Id).Error)
			assert.Equal(t, startingQuota-wantCharge, user.Quota)
			assert.Equal(t, wantCharge, user.UsedQuota)
			assert.Equal(t, startingQuota-wantCharge, token.RemainQuota)
			assert.Equal(t, wantCharge, token.UsedQuota)
			assert.False(t, info.Billing.NeedsRefund())
			info.Billing.Refund(c)
			require.NoError(t, info.Billing.Settle(wantCharge))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, startingQuota-wantCharge, user.Quota, "repeat settle/refund must not change the charge")
			var logs []model.Log
			require.NoError(t, db.Where("user_id = ? AND type = ?", user.Id, model.LogTypeConsume).Find(&logs).Error)
			require.Len(t, logs, 1)
			assert.Equal(t, wantCharge, logs[0].Quota)
			assert.Equal(t, usage.CompletionTokens, logs[0].CompletionTokens)
		})
	}
}
