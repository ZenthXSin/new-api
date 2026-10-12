package controller

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	groupavailability "github.com/QuantumNous/new-api/pkg/group_availability"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGroupAvailabilityInputThresholdFiltersEveryMetric(t *testing.T) {
	collector, now := setupInvalidRequestAvailability(t)
	for _, tc := range []struct {
		name, body string
		failure    bool
		want       int64
	}{
		{"probe_success", `{"usage":{"prompt_tokens":9999,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":9999}}}`, false, 0},
		{"exact_threshold", `{"usage":{"prompt_tokens":10000,"completion_tokens":300}}`, false, 0},
		{"reported_zero", `{"usage":{"prompt_tokens":0,"completion_tokens":300}}`, false, 0},
		{"probe_failure", `{"usage":{"prompt_tokens":50}}`, true, 0},
		{"long_without_cache", `{"usage":{"prompt_tokens":10001,"completion_tokens":300}}`, false, 1},
		{"long_failure", `{"usage":{"prompt_tokens":10001}}`, true, 1},
		{"claude_cached_input", `{"message":{"usage":{"input_tokens":1,"cache_read_input_tokens":10000}}}`, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			start := time.Now().Add(-time.Second)
			info := &relaycommon.RelayInfo{UsingGroup: tc.name, StartTime: start, IsStream: true, FirstResponseTime: start.Add(100 * time.Millisecond)}
			info.SetEstimatePromptTokens(20000)
			groupavailability.BeginStream(c)
			groupavailability.ObserveStream(c, tc.body)
			groupavailability.ObserveStream(c, `{"type":"message_stop"}`)
			var apiErr *types.NewAPIError
			if tc.failure {
				apiErr = types.InitOpenAIError("server_error", 503)
			}
			groupavailability.RecordRelayResultWithContext(c, info, apiErr)
			require.NoError(t, collector.Flush())
			result, err := collector.Query(context.Background(), "90m", map[string]string{tc.name: tc.name}, true)
			require.NoError(t, err)
			group := result.Groups[0]
			assert.Equal(t, common.GetPointer(tc.want), group.RequestCount)
			if tc.want == 0 {
				assert.Nil(t, group.SuccessRate)
				assert.Nil(t, group.AvgDurationMs)
				assert.Nil(t, group.AvgTtftMs)
				assert.Nil(t, group.CacheHitRate)
				assert.Nil(t, group.AvgOutputTPS)
				assert.Nil(t, group.LastRequestAt)
				assert.Nil(t, result.DataThrough)
				assert.Equal(t, "none", group.SampleState)
			} else {
				assert.Equal(t, common.GetPointer(now.Unix()), group.LastRequestAt)
			}
		})
	}
}

func TestGroupAvailabilityOutputSpeedUsesSuccessfulGenerationTotals(t *testing.T) {
	collector, now := setupInvalidRequestAvailability(t)
	// An old aggregate has no per-request input size. It must not contribute
	// health, timestamps, cache facts or throughput under the new policy.
	require.NoError(t, model.SaveGroupAvailabilityBuckets([]model.GroupAvailabilityBucket{{
		Group: "mixed", BucketTs: now.Unix() - 60, SourceID: "legacy",
		RequestCount: 999, SuccessCount: 999, OutputTokens: 99999, GenerationMs: 1,
		CacheInputTokens: 100, CacheReadTokens: 100, LastRequestAt: now.Unix(),
	}}))
	for _, sample := range []groupavailability.Sample{
		{Group: "mixed", InputTokens: 10001, Success: true, OutputTokens: 100, GenerationMs: 1000},
		{Group: "mixed", InputTokens: 20000, Success: true, OutputTokens: 100, GenerationMs: 3000},
		{Group: "mixed", InputTokens: 20000, OutputTokens: 100000, GenerationMs: 1000},
		{Group: "mixed", InputTokens: 10000, Success: true, OutputTokens: 100000, GenerationMs: 1},
		{Group: "unknown-speed", InputTokens: 10001, Success: true, OutputTokens: 10},
	} {
		collector.Record(sample)
		*now = now.Add(time.Minute)
	}
	require.NoError(t, collector.Flush())
	require.NoError(t, collector.Flush()) // repeated snapshots are idempotent
	for _, counts := range []bool{true, false} {
		result, err := collector.Query(context.Background(), "90m", map[string]string{"mixed": "Mixed", "unknown-speed": "Unknown"}, counts)
		require.NoError(t, err)
		assert.EqualValues(t, 10000, result.MinInputTokens)
		group := result.Groups[0]
		assert.Equal(t, common.GetPointer(50.0), group.AvgOutputTPS)
		assert.Equal(t, common.GetPointer(66.67), group.SuccessRate)
		assert.Nil(t, group.CacheHitRate)
		assert.Nil(t, result.Groups[1].AvgOutputTPS)
		if counts {
			assert.Equal(t, common.GetPointer(int64(3)), group.RequestCount)
		} else {
			assert.Nil(t, group.RequestCount)
		}
	}
}

func TestGroupAvailabilityRetryResetsUsageAndPreservesLargeFailures(t *testing.T) {
	collector, _ := setupInvalidRequestAvailability(t)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	info := &relaycommon.RelayInfo{UsingGroup: "retry", StartTime: time.Now()}
	groupavailability.BeginAttempt(c, info)
	groupavailability.ObserveRelayUsage(c, &dto.Usage{PromptTokens: 20000, CompletionTokens: 100})
	groupavailability.ObserveCacheUsageString(c, `{"usage":{"prompt_tokens":20000,"prompt_tokens_details":{"cached_tokens":20000}}}`)
	groupavailability.BeginAttempt(c, info)
	info.SetEstimatePromptTokens(100)
	groupavailability.RecordRelayResultWithContext(c, info, nil)
	info.SetEstimatePromptTokens(10001)
	groupavailability.RecordRelayResultWithContext(c, info, types.InitOpenAIError("server_error", 503))
	require.NoError(t, collector.Flush())
	result, err := collector.Query(context.Background(), "90m", map[string]string{"retry": "Retry"}, true)
	require.NoError(t, err)
	group := result.Groups[0]
	assert.Equal(t, common.GetPointer(int64(1)), group.RequestCount)
	assert.Equal(t, common.GetPointer(int64(1)), group.ErrorCount)
	assert.Nil(t, group.CacheHitRate)
	assert.Nil(t, group.AvgOutputTPS)
}
