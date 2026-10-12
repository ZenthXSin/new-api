package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	groupavailability "github.com/QuantumNous/new-api/pkg/group_availability"
	"github.com/QuantumNous/new-api/relay/channel/gemini"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Reuse the existing in-memory controller DB fixture, including initialization
// of model column names. Restore every global it changes before the next test.
func setupInvalidRequestAvailability(t *testing.T) (*groupavailability.Collector, *time.Time) {
	t.Helper()
	oldDB, oldLogDB, oldCollector := model.DB, model.LOG_DB, groupavailability.Default
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	oldRedis, oldTimeout, oldMode := common.RedisEnabled, constant.StreamingTimeout, gin.Mode()
	t.Cleanup(func() {
		model.DB, model.LOG_DB, groupavailability.Default = oldDB, oldLogDB, oldCollector
		common.SetDatabaseTypes(oldMain, oldLog)
		common.RedisEnabled, constant.StreamingTimeout = oldRedis, oldTimeout
		gin.SetMode(oldMode)
	})
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}, &model.Option{}))
	constant.StreamingTimeout = 10
	now := time.Date(2026, 10, 3, 12, 0, 17, 0, time.UTC)
	collector, err := groupavailability.NewCollector(func() time.Time { return now })
	require.NoError(t, err)
	groupavailability.Default = collector
	return collector, &now
}

func TestGroupAvailabilityInvalidRequestsPreserveMetricDenominators(t *testing.T) {
	collector, now := setupInvalidRequestAvailability(t)
	for _, sample := range []struct {
		ttft int64
		err  *types.NewAPIError
	}{{100, nil}, {300, types.InitOpenAIError("server_error", http.StatusServiceUnavailable)}} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		start := time.Now().Add(-time.Second)
		info := &relaycommon.RelayInfo{UsingGroup: "mixed", IsStream: true, StartTime: start, FirstResponseTime: start.Add(time.Duration(sample.ttft) * time.Millisecond)}
		info.SetEstimatePromptTokens(20000)
		groupavailability.BeginStream(c)
		groupavailability.ObserveStream(c, `{"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":20000,"prompt_tokens_details":{"cached_tokens":5000}}}`)
		groupavailability.RecordRelayResultWithContext(c, info, sample.err)
	}
	require.NoError(t, collector.Flush())
	before, err := model.GetGroupAvailabilityBuckets(context.Background(), []string{"mixed"}, now.Unix()-60, now.Unix()+1)
	require.NoError(t, err)
	require.Len(t, before, 1)
	assert.EqualValues(t, 2, before[0].RequestCount)
	assert.EqualValues(t, 1, before[0].SuccessCount)
	assert.EqualValues(t, 2, before[0].TtftCount)
	assert.EqualValues(t, 400, before[0].TtftSumMs)
	assert.EqualValues(t, 20000, before[0].CacheInputTokens)
	assert.EqualValues(t, 5000, before[0].CacheReadTokens)

	// Rejected requests arrive later and carry conspicuous timing/cache facts.
	// They must not update any metric or make the last observation look newer.
	*now = now.Add(time.Minute)
	for _, rejected := range []struct {
		name, event string
		err         *types.NewAPIError
	}{
		{"local_token_validation", "", types.NewError(errors.New("invalid token input"), types.ErrorCodeCountTokenFailed)},
		{"generic_http_400", "", types.NewOpenAIError(errors.New("invalid body"), types.ErrorCodeBadResponseStatusCode, 400)},
		{"generic_http_422", "", types.NewOpenAIError(errors.New("unprocessable body"), types.ErrorCodeBadResponseStatusCode, 422)},
		{"gemini_numeric_argument", `{"error":{"code":400,"status":"INVALID_ARGUMENT"}}`, nil},
		{"responses_top_level_parameter", `{"type":"error","code":"invalid_parameter","message":"invalid fixture parameter"}`, nil},
		{"nested_validation_status", `{"error":{"status_code":422}}`, nil},
	} {
		t.Run(rejected.name, func(t *testing.T) {
			for _, group := range []string{"mixed", "only-invalid"} {
				c, _ := gin.CreateTestContext(httptest.NewRecorder())
				c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
				start := time.Now().Add(-time.Minute)
				info := &relaycommon.RelayInfo{UsingGroup: group, IsStream: true, StartTime: start, FirstResponseTime: start.Add(45 * time.Second)}
				info.SetEstimatePromptTokens(20000)
				groupavailability.BeginStream(c)
				groupavailability.ObserveStream(c, `{"usage":{"prompt_tokens":1800000,"prompt_tokens_details":{"cached_tokens":1800000}}}`)
				if rejected.event != "" {
					groupavailability.ObserveStream(c, rejected.event)
				}
				groupavailability.RecordRelayResultWithContext(c, info, rejected.err)
			}
		})
	}
	require.NoError(t, collector.Flush())
	after, err := model.GetGroupAvailabilityBuckets(context.Background(), []string{"mixed", "only-invalid"}, now.Unix()-120, now.Unix()+1)
	require.NoError(t, err)
	assert.Equal(t, before, after, "ignored requests cannot persist latency, TTFT, cache counters, a new bucket, or last_request_at")
	result, err := collector.Query(context.Background(), "90m", map[string]string{"mixed": "Mixed", "only-invalid": "Only invalid"}, true)
	require.NoError(t, err)
	require.Len(t, result.Groups, 2)
	mixed, empty := result.Groups[0], result.Groups[1]
	assert.Equal(t, common.GetPointer(int64(2)), mixed.RequestCount)
	assert.Equal(t, common.GetPointer(int64(1)), mixed.ErrorCount)
	assert.Equal(t, common.GetPointer(50.0), mixed.SuccessRate)
	assert.Equal(t, common.GetPointer(int64(200)), mixed.AvgTtftMs)
	assert.Equal(t, common.GetPointer(25.0), mixed.CacheHitRate)
	assert.Equal(t, common.GetPointer(before[0].LastRequestAt), mixed.LastRequestAt)
	assert.Equal(t, "unknown", empty.Status)
	assert.Equal(t, "none", empty.SampleState)
	assert.Equal(t, common.GetPointer(int64(0)), empty.RequestCount)
	assert.Nil(t, empty.SuccessRate)
	assert.Nil(t, empty.AvgDurationMs)
	assert.Nil(t, empty.AvgTtftMs)
	assert.Nil(t, empty.CacheHitRate)
	assert.Nil(t, empty.LastRequestAt)
	for _, bucket := range empty.Buckets {
		assert.Equal(t, "none", bucket.SampleState)
		assert.Equal(t, common.GetPointer(int64(0)), bucket.RequestCount)
	}
}

func TestGroupAvailabilityInvalidRequestStreamFailuresRemainVisible(t *testing.T) {
	collector, _ := setupInvalidRequestAvailability(t)
	for _, tc := range []struct {
		name   string
		events []string
		err    *types.NewAPIError
	}{
		{"generic_type_authentication", []string{`{"error":{"code":"invalid_request_error","type":"authentication_error"}}`}, nil},
		{"numeric_rate_limit", []string{`{"error":{"code":429,"type":"invalid_request_error"}}`}, nil},
		{"gemini_exhausted", []string{`{"error":{"code":400,"status":"RESOURCE_EXHAUSTED"}}`}, nil},
		{"fault_after_rejection", []string{`{"type":"error","code":"invalid_parameter"}`, `{"type":"error","error":{"type":"server_error"}}`}, nil},
		{"local_pricing_configuration", nil, types.NewError(errors.New("pricing configuration missing"), types.ErrorCodeModelPriceError)},
		{"unknown_upstream_404", nil, types.NewOpenAIError(errors.New("unknown upstream path"), types.ErrorCodeBadResponseStatusCode, 404)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			info := &relaycommon.RelayInfo{UsingGroup: tc.name, IsStream: len(tc.events) > 0, StartTime: time.Now(), ChannelMeta: &relaycommon.ChannelMeta{}}
			info.SetEstimatePromptTokens(20000)
			if len(tc.events) > 0 {
				var body strings.Builder
				for _, event := range tc.events {
					body.WriteString("data: " + event + "\n\n")
				}
				var forwarded []string
				helper.StreamScannerHandler(c, &http.Response{Body: io.NopCloser(strings.NewReader(body.String()))}, info, func(data string, _ *helper.StreamResult) { forwarded = append(forwarded, data) })
				assert.Equal(t, tc.events, forwarded, "classification cannot modify forwarded SSE data")
			}
			groupavailability.RecordRelayResultWithContext(c, info, tc.err)
			require.NoError(t, collector.Flush())
			result, err := collector.Query(context.Background(), "90m", map[string]string{tc.name: tc.name}, true)
			require.NoError(t, err)
			require.Len(t, result.Groups, 1)
			group := result.Groups[0]
			assert.Equal(t, common.GetPointer(int64(1)), group.RequestCount)
			assert.Equal(t, common.GetPointer(int64(1)), group.ErrorCount)
			assert.Equal(t, common.GetPointer(0.0), group.SuccessRate)
			assert.Equal(t, "critical", group.Status)
			assert.Equal(t, "sufficient", group.SampleState)
			assert.Nil(t, group.CacheHitRate)
		})
	}
}

func TestGroupAvailabilityInvalidRequestJSONProviderSignals(t *testing.T) {
	collector, _ := setupInvalidRequestAvailability(t)
	for _, tc := range []struct {
		name, provider, body, marker string
		wantStatus                   int
		wantRequests                 int64
	}{
		{"openai_filtered", "openai", `{"model":"test","choices":[{"index":0,"message":{"role":"assistant","content":""},"finish_reason":"content_filter"}],"usage":{"prompt_tokens":20000,"completion_tokens":2,"total_tokens":102,"prompt_tokens_details":{"cached_tokens":8000}}}`, "openai_finish_reason=content_filter", 200, 0},
		{"gemini_blocked", "gemini", `{"candidates":[],"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":20000,"candidatesTokenCount":2,"totalTokenCount":102,"cachedContentTokenCount":8000}}`, "gemini_block_reason=SAFETY", 200, 0},
		{"gemini_empty", "gemini_chat", `{"candidates":[],"usageMetadata":{"promptTokenCount":20000,"candidatesTokenCount":2,"totalTokenCount":102,"cachedContentTokenCount":8000}}`, "gemini_empty_candidates", 500, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			info := &relaycommon.RelayInfo{UsingGroup: tc.name, RelayFormat: types.RelayFormatOpenAI, StartTime: time.Now(), ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "test"}}
			info.SetEstimatePromptTokens(20000)
			response := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(tc.body))}
			var usage *dto.Usage
			var apiErr *types.NewAPIError
			switch tc.provider {
			case "openai":
				usage, apiErr = openai.OpenaiHandler(c, info, response)
			case "gemini":
				info.RelayFormat = types.RelayFormatGemini
				usage, apiErr = gemini.GeminiTextGenerationHandler(c, info, response)
			case "gemini_chat":
				usage, apiErr = gemini.GeminiChatHandler(c, info, response)
			}
			require.Nil(t, apiErr, "these adapters signal through request context after handling the response")
			require.NotNil(t, usage)
			assert.Equal(t, 20000, usage.PromptTokens)
			assert.Equal(t, 8000, usage.PromptTokensDetails.CachedTokens)
			assert.Equal(t, tc.wantStatus, recorder.Code)
			assert.Equal(t, tc.marker, common.GetContextKeyString(c, constant.ContextKeyAdminRejectReason))
			groupavailability.RecordRelayResultWithContext(c, info, apiErr)
			require.NoError(t, collector.Flush())
			result, err := collector.Query(context.Background(), "90m", map[string]string{tc.name: tc.name}, true)
			require.NoError(t, err)
			require.Len(t, result.Groups, 1)
			assert.Equal(t, common.GetPointer(tc.wantRequests), result.Groups[0].RequestCount)
			assert.Equal(t, common.GetPointer(tc.wantRequests), result.Groups[0].ErrorCount)
			assert.Nil(t, result.Groups[0].CacheHitRate)
			if tc.wantRequests == 0 {
				assert.Equal(t, "none", result.Groups[0].SampleState)
				assert.Nil(t, result.Groups[0].SuccessRate)
				assert.Nil(t, result.Groups[0].LastRequestAt)
			}

			// A new upstream attempt must not inherit a previous refusal/empty
			// marker. The real handler and billed usage above stay untouched.
			info.UsingGroup = tc.name + "-retry"
			groupavailability.BeginAttempt(c, info)
			groupavailability.ObserveCacheUsageString(c, `{"usage":{"prompt_tokens":20000,"prompt_tokens_details":{"cached_tokens":4000}}}`)
			groupavailability.RecordRelayResultWithContext(c, info, nil)
			require.NoError(t, collector.Flush())
			retried, err := collector.Query(context.Background(), "90m", map[string]string{info.UsingGroup: info.UsingGroup}, true)
			require.NoError(t, err)
			assert.Equal(t, common.GetPointer(int64(1)), retried.Groups[0].SuccessCount)
			assert.Equal(t, common.GetPointer(100.0), retried.Groups[0].SuccessRate)
			assert.Equal(t, common.GetPointer(20.0), retried.Groups[0].CacheHitRate)
		})
	}
}
