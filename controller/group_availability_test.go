package controller

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	groupavailability "github.com/QuantumNous/new-api/pkg/group_availability"
	awsadapter "github.com/QuantumNous/new-api/relay/channel/aws"
	"github.com/QuantumNous/new-api/relay/channel/claude"
	"github.com/QuantumNous/new-api/relay/channel/gemini"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	awsconfig "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream"
	"github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream/eventstreamapi"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// These DSNs must identify disposable databases. The fixture covers both a
// fresh schema and adding the collector alongside existing users/perf history.
func TestGroupAvailabilityDatabaseMatrix(t *testing.T) {
	for _, dialect := range []struct{ name, env string }{
		{"sqlite", ""}, {"mysql", "TEST_GROUP_AVAILABILITY_MYSQL_DSN"}, {"postgres", "TEST_GROUP_AVAILABILITY_POSTGRES_DSN"},
	} {
		t.Run(dialect.name, func(t *testing.T) {
			dsn := os.Getenv(dialect.env)
			if dialect.env != "" && dsn == "" {
				t.Skip("isolated database is not configured")
			}
			t.Setenv("SQL_DSN", dsn)
			oldDB, oldCollector := model.DB, groupavailability.Default
			oldType, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
			oldMaster, oldRedis, oldPath := common.IsMasterNode, common.RedisEnabled, common.SQLitePath
			common.IsMasterNode, common.RedisEnabled, common.SQLitePath = false, false, filepath.Join(t.TempDir(), "availability.db")
			t.Cleanup(func() {
				model.DB, groupavailability.Default = oldDB, oldCollector
				common.SetDatabaseTypes(oldType, oldLogType)
				common.IsMasterNode, common.RedisEnabled, common.SQLitePath = oldMaster, oldRedis, oldPath
			})
			require.NoError(t, model.InitDB())
			db := model.DB
			sqlDB, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
			versionSQL := "SELECT VERSION()"
			if dialect.name == "sqlite" {
				versionSQL = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionSQL).Scan(&version).Error)
			t.Logf("database=%s version=%s", dialect.name, version)
			require.NoError(t, db.Migrator().DropTable(&model.GroupAvailabilityBucket{}, &model.PerfMetric{}, &model.User{}, &model.Option{}))
			// Fresh install and repeated startup preserve both cache counters and
			// the unique snapshot key before exercising the upgrade path below.
			require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}))
			fresh := model.GroupAvailabilityBucket{Group: "fresh-cache", BucketTs: 1, SourceID: "fresh-cache", RequestCount: 1, SuccessCount: 1, CacheInputTokens: 100, CacheReadTokens: 40}
			require.NoError(t, model.SaveGroupAvailabilityBuckets([]model.GroupAvailabilityBucket{fresh}))
			fresh.CacheReadTokens = 50
			require.NoError(t, model.SaveGroupAvailabilityBuckets([]model.GroupAvailabilityBucket{fresh}))
			require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}))
			var freshRows []model.GroupAvailabilityBucket
			require.NoError(t, db.Find(&freshRows).Error)
			require.Len(t, freshRows, 1)
			assert.EqualValues(t, 100, freshRows[0].CacheInputTokens)
			assert.EqualValues(t, 50, freshRows[0].CacheReadTokens)
			require.NoError(t, db.Migrator().DropTable(&model.GroupAvailabilityBucket{}))
			// Existing released tables and data must survive adding the new table.
			require.NoError(t, db.AutoMigrate(&model.PerfMetric{}, &model.User{}, &model.Option{}))
			legacy := model.PerfMetric{ModelName: "legacy", Group: "a", BucketTs: 1, RequestCount: 9999}
			require.NoError(t, db.Create(&legacy).Error)
			// Upgrade a schema generated from the previous release's table,
			// including a pre-feature row. Missing cache facts must remain unknown.
			require.NoError(t, db.Table("group_availability_buckets").AutoMigrate(&groupAvailabilityBeforeCache{}))
			require.NoError(t, db.Table("group_availability_buckets").Create(&groupAvailabilityBeforeCache{Group: "before-cache", BucketTs: 1, SourceID: "legacy-monitor", RequestCount: 1, SuccessCount: 1}).Error)
			// A release upgrade starts a new process/connection pool. The old
			// process's prepared SELECT * plans cannot survive a schema downgrade.
			require.NoError(t, sqlDB.Close())
			require.NoError(t, model.InitDB())
			db = model.DB
			sqlDB, err = db.DB()
			require.NoError(t, err)
			require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}))
			var oldMonitor model.GroupAvailabilityBucket
			require.NoError(t, db.Where("source_id = ?", "legacy-monitor").First(&oldMonitor).Error)
			assert.Zero(t, oldMonitor.CacheInputTokens)
			assert.Zero(t, oldMonitor.CacheReadTokens)
			now := time.Date(2026, 10, 2, 12, 30, 15, 0, time.UTC)
			collector, err := groupavailability.NewCollector(func() time.Time { return now })
			require.NoError(t, err)
			groupavailability.Default = collector
			started := now.Unix()
			initial, err := collector.Query(context.Background(), "90m", map[string]string{"a": "A", "unused": "Unused"}, true)
			require.NoError(t, err)
			require.Len(t, initial.Groups, 2)
			assert.Equal(t, "unknown", initial.Groups[0].Status)
			assert.Nil(t, initial.Groups[0].SuccessRate)
			assert.False(t, initial.CoverageComplete)
			assert.Nil(t, initial.DataThrough)
			assert.Equal(t, started, initial.CollectionStartedAt)
			assert.Len(t, initial.Groups[0].Buckets, 90)

			// Different channels/models and retries contribute to a single actual
			// group. Business rejection and client cancellation contribute nothing.
			info := &relaycommon.RelayInfo{OriginModelName: "first-model", UsingGroup: "a", StartTime: time.Now()}
			groupavailability.RecordRelayResult(context.Background(), info, types.InitOpenAIError("context_length_exceeded", 400))
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			groupavailability.RecordRelayResult(ctx, info, nil)
			info.ChannelMeta = &relaycommon.ChannelMeta{ChannelId: 101}
			groupavailability.RecordRelayResult(context.Background(), info, nil)
			info.OriginModelName, info.RetryIndex, info.ChannelId = "second-model", 3, 202
			groupavailability.RecordRelayResult(context.Background(), info, nil)
			// A separate instance shares a database but has its own idempotency key.
			second, err := groupavailability.NewCollector(func() time.Time { return now })
			require.NoError(t, err)
			var wg sync.WaitGroup
			for i := range 48 {
				wg.Go(func() {
					second.Record(groupavailability.Sample{Group: "a", Success: i < 38, LatencyMs: 1000, HasTtft: true, TtftMs: 100})
				})
			}
			wg.Wait()
			require.NoError(t, collector.Flush())
			require.NoError(t, second.Flush())
			require.NoError(t, collector.Flush())
			require.NoError(t, second.Flush())
			result, err := collector.Query(context.Background(), "90m", map[string]string{"a": "A"}, true)
			require.NoError(t, err)
			require.Len(t, result.Groups, 1)
			assert.EqualValues(t, 50, *result.Groups[0].RequestCount)
			assert.EqualValues(t, 40, *result.Groups[0].SuccessCount)
			assert.Equal(t, 80.0, *result.Groups[0].SuccessRate)
			assert.Equal(t, "critical", result.Groups[0].Status)
			assert.Equal(t, "sufficient", result.Groups[0].SampleState)
			assert.EqualValues(t, 100, *result.Groups[0].AvgTtftMs)
			assert.Equal(t, started, *result.Groups[0].LastRequestAt)

			// A failed write retains the full snapshot; retrying replaces rather
			// than adds it, including snapshots already persisted by earlier flushes.
			second.Record(groupavailability.Sample{Group: "a", Success: true, LatencyMs: 1000})
			require.NoError(t, db.Callback().Create().Before("gorm:create").Register("availability_write_failure", func(tx *gorm.DB) {
				if tx.Statement.Table == "group_availability_buckets" {
					tx.AddError(errors.New("controlled write failure"))
				}
			}))
			assert.Error(t, second.Flush())
			require.NoError(t, db.Callback().Create().Remove("availability_write_failure"))
			now = now.Add(time.Minute)
			require.NoError(t, second.Flush())
			require.NoError(t, second.Flush())
			require.NoError(t, collector.Flush())
			result, err = collector.Query(context.Background(), "90m", map[string]string{"a": "A"}, true)
			require.NoError(t, err)
			assert.EqualValues(t, 51, *result.Groups[0].RequestCount)
			assert.Equal(t, "warning", result.Groups[0].Status)

			// Re-running migration and process initialization preserves data and
			// the original collection start (no reset on rolling deployments).
			require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}))
			require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}))
			restarted, err := groupavailability.NewCollector(func() time.Time { return now })
			require.NoError(t, err)
			restartedResult, err := restarted.Query(context.Background(), "90m", map[string]string{"a": "A"}, true)
			require.NoError(t, err)
			assert.Equal(t, result.Groups, restartedResult.Groups)
			assert.Equal(t, started, restartedResult.CollectionStartedAt)
			var saved model.PerfMetric
			require.NoError(t, db.First(&saved, legacy.Id).Error)
			assert.EqualValues(t, 9999, saved.RequestCount)

			// One sparse bucket cannot outweigh a busy one; the shared grouping
			// also applies before SQL aggregation, including an empty grant set.
			rows := []model.GroupAvailabilityBucket{
				{Group: "weighted", BucketTs: now.Unix() - 60, SourceID: "fixture1", RequestCount: 100, SuccessCount: 100, TotalLatencyMs: 100000},
				{Group: "weighted", BucketTs: now.Unix() - 120, SourceID: "fixture2", RequestCount: 1, TotalLatencyMs: 2000},
				{Group: "private", BucketTs: now.Unix() - 60, SourceID: "fixture3", RequestCount: 1000, SuccessCount: 1},
				{Group: "sparse", BucketTs: now.Unix() - 60, SourceID: "fixture4", RequestCount: 49, SuccessCount: 49},
			}
			for i := range rows {
				rows[i].BucketTs -= rows[i].BucketTs % 60
			}
			require.NoError(t, model.SaveGroupAvailabilityBuckets(rows))
			weighted, err := collector.Query(context.Background(), "24h", map[string]string{"weighted": "Weighted", "sparse": "Sparse"}, true)
			require.NoError(t, err)
			require.Len(t, weighted.Groups, 2)
			assert.Equal(t, "healthy", weighted.Groups[0].Status)
			assert.Equal(t, "sufficient", weighted.Groups[0].SampleState)
			assert.Equal(t, 99.01, *weighted.Groups[1].SuccessRate)
			assert.EqualValues(t, 1009, *weighted.Groups[1].AvgDurationMs)
			assert.Equal(t, "healthy", weighted.Groups[1].Status)
			assert.Nil(t, weighted.Groups[1].AvgTtftMs)
			empty, err := collector.Query(context.Background(), "24h", nil, true)
			require.NoError(t, err)
			assert.Empty(t, empty.Groups)
			assert.Nil(t, empty.DataThrough)
			for _, window := range []struct {
				name    string
				count   int
				seconds int64
			}{{"90m", 90, 60}, {"24h", 48, 1800}, {"7d", 42, 14400}, {"30d", 60, 43200}} {
				windowResult, err := collector.Query(context.Background(), window.name, map[string]string{"a": "A"}, false)
				require.NoError(t, err)
				assert.Len(t, windowResult.Groups[0].Buckets, window.count)
				assert.Equal(t, window.seconds, windowResult.BucketSeconds)
				assert.Nil(t, windowResult.Groups[0].RequestCount)
				assert.Nil(t, windowResult.Groups[0].Buckets[len(windowResult.Groups[0].Buckets)-1].RequestCount)
			}
			// A clock rollback can revisit an already flushed/evicted minute.
			// Its new snapshot must add a sample, not overwrite the saved total.
			now = now.Add(-time.Minute)
			second.Record(groupavailability.Sample{Group: "a", Success: true})
			require.NoError(t, second.Flush())
			now = now.Add(time.Minute)
			rollback, err := collector.Query(context.Background(), "90m", map[string]string{"a": "A"}, true)
			require.NoError(t, err)
			assert.EqualValues(t, 52, *rollback.Groups[0].RequestCount)
			canceled, cancel := context.WithCancel(context.Background())
			cancel()
			_, err = collector.Query(canceled, "30d", map[string]string{"a": "A"}, false)
			assert.Error(t, err)

			// Auto order uses unredacted aggregate totals and the selected window.
			rankedRows := []model.GroupAvailabilityBucket{
				{Group: "rank-z-busy", BucketTs: now.Unix() - 60, SourceID: "rank", RequestCount: 200, SuccessCount: 100},
				{Group: "rank-b-better", BucketTs: now.Unix() - 60, SourceID: "rank", RequestCount: 100, SuccessCount: 99},
				{Group: "rank-a-lower", BucketTs: now.Unix() - 60, SourceID: "rank", RequestCount: 100, SuccessCount: 90},
				{Group: "rank-c-tie", BucketTs: now.Unix() - 60, SourceID: "rank", RequestCount: 100, SuccessCount: 99},
				{Group: "rank-single-ok", BucketTs: now.Unix() - 60, SourceID: "rank", RequestCount: 1, SuccessCount: 1},
				{Group: "rank-single-fail", BucketTs: now.Unix() - 60, SourceID: "rank", RequestCount: 1},
			}
			require.NoError(t, model.SaveGroupAvailabilityBuckets(rankedRows))
			rankAllowed := map[string]string{"rank-z-busy": "", "rank-b-better": "", "rank-a-lower": "", "rank-c-tie": "", "rank-empty": "", "rank-single-ok": "", "rank-single-fail": ""}
			for _, showCounts := range []bool{true, false} {
				ranked, err := collector.QuerySorted(context.Background(), "90m", rankAllowed, showCounts, true)
				require.NoError(t, err)
				assert.EqualValues(t, 1, ranked.MinSamples)
				names := make([]string, 0, len(ranked.Groups))
				for _, group := range ranked.Groups {
					names = append(names, group.Group)
					switch group.Group {
					case "rank-single-ok":
						assert.Equal(t, "healthy", group.Status)
						assert.Equal(t, "sufficient", group.SampleState)
					case "rank-single-fail":
						assert.Equal(t, "critical", group.Status)
						assert.Equal(t, "sufficient", group.SampleState)
					case "rank-empty":
						assert.Equal(t, "unknown", group.Status)
						assert.Nil(t, group.SuccessRate)
					}

					if !showCounts {
						assert.Nil(t, group.RequestCount)
					}
				}
				assert.Equal(t, []string{"rank-z-busy", "rank-b-better", "rank-c-tie", "rank-a-lower", "rank-single-ok", "rank-single-fail", "rank-empty"}, names)
			}
			assertGroupAvailabilityCacheUsage(t, collector)
			assertGroupAvailabilityAccess(t, collector)
			// Retention deletes only expired group-monitor facts, not legacy perf.
			now = now.Add(36 * 24 * time.Hour)
			require.NoError(t, collector.Flush())
			var count int64
			require.NoError(t, db.Model(&model.GroupAvailabilityBucket{}).Count(&count).Error)
			assert.Zero(t, count)
			require.NoError(t, db.First(&saved, legacy.Id).Error)
		})
	}
}

func assertGroupAvailabilityAccess(t *testing.T, collector *groupavailability.Collector) {
	t.Helper()
	oldRatios, oldUsable := ratio_setting.GroupRatio2JSONString(), setting.UserUsableGroups2JSONString()
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldRatios))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldUsable))
	})
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"a":1,"private":1,"auto":1,"unused":1}`))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"a":"A","auto":"Auto","unused":"Unused"}`))
	user := model.User{Username: "availability-user", Group: "a", Role: common.RoleCommonUser, Status: common.UserStatusEnabled}
	require.NoError(t, model.DB.Create(&user).Error)
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.GET("/api/group-availability", middleware.DisableCache(), func(c *gin.Context) { c.Set("id", user.Id) }, GetGroupAvailability)
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/group-availability?range=90m&group=private", nil))
	require.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	var body struct {
		Success bool
		Data    groupavailability.Result
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.Success)
	require.Len(t, body.Data.Groups, 2)
	assert.Equal(t, "a", body.Data.Groups[0].Group)
	assert.Equal(t, "unused", body.Data.Groups[1].Group)
	assert.Nil(t, body.Data.Groups[0].RequestCount)
	for _, secret := range []string{"channel_id", "channel_name", "source_id", "model_name", "username", "token", "private"} {
		assert.NotContains(t, response.Body.String(), secret)
	}
	unauthenticated := gin.New()
	unauthenticated.GET("/api/group-availability", GetGroupAvailability)
	response = httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/group-availability", nil))
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/group-availability?range=999d", nil))
	assert.Equal(t, http.StatusBadRequest, response.Code)
	// Empty membership must not fall back to global usable groups.
	require.NoError(t, model.DB.Model(&user).Update("group", "").Error)
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/group-availability", nil))
	require.Equal(t, http.StatusOK, response.Code)
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
	assert.Empty(t, body.Data.Groups)
	// Failure to load a current user is fail-closed, with no internal DB error.
	require.NoError(t, model.DB.Unscoped().Delete(&user).Error)
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/group-availability", nil))
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.NotContains(t, response.Body.String(), "SELECT")
}

func TestGroupAvailabilityReleaseStreamObservation(t *testing.T) {
	previousDB, previousCollector := model.DB, groupavailability.Default
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 10
	db := setupModelListControllerTestDB(t)
	t.Cleanup(func() {
		model.DB, groupavailability.Default = previousDB, previousCollector
		constant.StreamingTimeout = oldTimeout
	})
	require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}, &model.Option{}))
	now := time.Date(2026, 10, 2, 13, 0, 0, 0, time.UTC)
	collector, err := groupavailability.NewCollector(func() time.Time { return now })
	require.NoError(t, err)
	groupavailability.Default = collector
	for _, tc := range []struct {
		name   string
		events []string
		want   string
	}{
		{"chat_done", []string{`{"choices":[{"delta":{"content":"ok"}}]}`, "[DONE]"}, "success"},
		{"chat_finished", []string{`{"choices":[{"finish_reason":"stop"}]}`}, "success"},
		{"truncated_chat", []string{`{"choices":[{"delta":{"content":"partial"}}]}`}, "failure"},
		{"claude", []string{`{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`, `{"type":"message_stop"}`}, "success"},
		{"claude_refusal", []string{`{"type":"message_delta","delta":{"stop_reason":"refusal"}}`, `{"type":"message_stop"}`}, "ignored"},
		{"gemini", []string{`{"candidates":[{"finishReason":"STOP"}]}`}, "success"},
		{"gemini_safety", []string{`{"candidates":[{"finishReason":"SAFETY"}]}`}, "ignored"},
		{"gemini_prompt_block", []string{`{"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}`}, "ignored"},
		{"responses", []string{`{"type":"response.completed","response":{"status":"completed"}}`}, "success"},
		{"responses_legacy_done", []string{`{"type":"response.done","response":{"status":"completed"}}`}, "success"},
		{"responses_status_failure", []string{`{"type":"response.done","response":{"status":"failed"}}`}, "failure"},
		{"responses_error_alias", []string{`{"type":"response.error"}`}, "failure"},
		{"responses_failure", []string{`{"type":"response.failed","response":{"error":{"code":"server_error"}}}`}, "failure"},
		{"responses_business", []string{`{"type":"response.failed","response":{"error":{"code":"context_length_exceeded"}}}`}, "ignored"},
		{"responses_token_limit", []string{`{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}`}, "success"},
		{"responses_cancel", []string{`{"type":"response.cancelled"}`}, "ignored"},
		{"error_after_done", []string{`{"type":"response.completed"}`, `{"type":"error","error":{"type":"overloaded_error"}}`}, "failure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			info := &relaycommon.RelayInfo{UsingGroup: tc.name, IsStream: true, StartTime: time.Now(), ChannelMeta: &relaycommon.ChannelMeta{}}
			var body strings.Builder
			for _, event := range tc.events {
				body.WriteString("data: " + event + "\n\n")
			}
			observed := []string{}
			helper.StreamScannerHandler(c, &http.Response{Body: io.NopCloser(strings.NewReader(body.String()))}, info, func(data string, sr *helper.StreamResult) {
				observed = append(observed, data)
			})
			wantData := make([]string, 0, len(tc.events))
			for _, event := range tc.events {
				if event != "[DONE]" {
					wantData = append(wantData, event)
				}
			}
			assert.Equal(t, wantData, observed, "observer must leave forwarded upstream data intact")
			groupavailability.RecordRelayResultWithContext(c, info, nil)
			require.NoError(t, collector.Flush())
			result, err := collector.Query(context.Background(), "90m", map[string]string{tc.name: tc.name}, true)
			require.NoError(t, err)
			require.Len(t, result.Groups, 1)
			group := result.Groups[0]
			if tc.want == "ignored" {
				assert.Zero(t, *group.RequestCount)
				assert.Nil(t, group.SuccessRate)
			} else {
				assert.EqualValues(t, 1, *group.RequestCount)
				assert.EqualValues(t, map[string]int64{"success": 1, "failure": 0}[tc.want], *group.SuccessCount)
			}
		})
	}
	// A failed attempt does not enter the collector. Resetting observation for
	// the final successful attempt and changing actual group yields only one row.
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	info := &relaycommon.RelayInfo{UsingGroup: "initial_group", IsStream: true, StartTime: time.Now(), ChannelMeta: &relaycommon.ChannelMeta{}}
	groupavailability.BeginStream(c)
	groupavailability.ObserveStream(c, `{"type":"error","error":{"type":"server_error"}}`)
	info.UsingGroup = "final_group"
	groupavailability.BeginStream(c)
	groupavailability.ObserveStream(c, `{"type":"message_stop"}`)
	groupavailability.RecordRelayResultWithContext(c, info, nil)
	require.NoError(t, collector.Flush())
	result, err := collector.Query(context.Background(), "90m", map[string]string{"initial_group": "Initial", "final_group": "Final"}, true)
	require.NoError(t, err)
	assert.EqualValues(t, 1, *result.Groups[0].SuccessCount)
	assert.Zero(t, *result.Groups[1].RequestCount)
	for _, tc := range []struct {
		group       string
		n           int
		events      []string
		wantSuccess int64
	}{
		{"multi_incomplete", 2, []string{`{"choices":[{"index":0,"finish_reason":"stop"}]}`}, 0},
		{"multi_finished", 2, []string{`{"choices":[{"index":0,"finish_reason":"stop"},{"index":1,"finish_reason":"length"}]}`}, 1},
		{"observed_unfinished", 1, []string{`{"choices":[{"index":0,"finish_reason":"stop"},{"index":1,"delta":{"content":"partial"}}]}`}, 0},
	} {
		info.UsingGroup, info.Request = tc.group, &dto.GeneralOpenAIRequest{N: &tc.n}
		groupavailability.BeginStream(c)
		for _, event := range tc.events {
			groupavailability.ObserveStream(c, event)
		}
		groupavailability.RecordRelayResultWithContext(c, info, nil)
		require.NoError(t, collector.Flush())
		result, err = collector.Query(context.Background(), "90m", map[string]string{tc.group: tc.group}, true)
		require.NoError(t, err)
		assert.Equal(t, tc.wantSuccess, *result.Groups[0].SuccessCount, tc.group)
	}
	jsonContext, _ := gin.CreateTestContext(httptest.NewRecorder())
	jsonContext.Request = httptest.NewRequest(http.MethodPost, "/v1/images/generations", nil)
	info = &relaycommon.RelayInfo{UsingGroup: "json_as_stream", IsStream: true, StartTime: time.Now()}
	groupavailability.RecordRelayResultWithContext(jsonContext, info, nil)
	require.NoError(t, collector.Flush())
	result, err = collector.Query(context.Background(), "90m", map[string]string{"json_as_stream": "JSON"}, true)
	require.NoError(t, err)
	assert.EqualValues(t, 1, *result.Groups[0].SuccessCount)
}

// Previous release schema, used only to prove a real additive migration.
type groupAvailabilityBeforeCache struct {
	ID             int    `gorm:"primaryKey"`
	Group          string `gorm:"column:group;size:64;uniqueIndex:idx_group_availability_bucket,priority:1"`
	BucketTs       int64  `gorm:"uniqueIndex:idx_group_availability_bucket,priority:2;index:idx_group_availability_time"`
	SourceID       string `gorm:"size:32;uniqueIndex:idx_group_availability_bucket,priority:3"`
	RequestCount   int64
	SuccessCount   int64
	TotalLatencyMs int64
	TtftSumMs      int64
	TtftCount      int64
	LastRequestAt  int64
}

func assertGroupAvailabilityCacheUsage(t *testing.T, collector *groupavailability.Collector) {
	t.Helper()
	for _, tc := range []struct {
		name   string
		frames []string
		want   *float64
	}{
		{"openai", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":40}}}`}, common.GetPointer(40.0)},
		{"responses", []string{`{"type":"response.completed","response":{"usage":{"input_tokens":200,"input_tokens_details":{"cached_tokens":50}}}}`}, common.GetPointer(25.0)},
		{"all_cached", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":100}}}`}, common.GetPointer(100.0)},
		{"null_cache", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":null}}}`}, nil},
		{"malformed_usage", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":40},}}`}, nil},
		{"claude_late_cache", []string{`{"type":"message_start","message":{"usage":{"input_tokens":20}}}`, `{"type":"message_delta","usage":{"cache_read_input_tokens":0,"output_tokens":40}}`}, common.GetPointer(0.0)},
		{"claude_creation_not_double", []string{`{"usage":{"input_tokens":20,"cache_creation_input_tokens":30,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":20},"cache_read_input_tokens":50}}`}, common.GetPointer(50.0)},
		{"explicit_zero", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":0}}}`}, common.GetPointer(0.0)},
		{"no_cache_field", []string{`{"usage":{"prompt_tokens":100}}`}, nil},
		{"no_usage", []string{`{"choices":[{"finish_reason":"stop"}]}`}, nil},
		{"claude", []string{`{"type":"message_start","message":{"usage":{"input_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":50}}}`, `{"type":"message_delta","usage":{"output_tokens":40}}`}, common.GetPointer(50.0)},
		{"claude_split", []string{`{"usage":{"input_tokens":20,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":20},"cache_read_input_tokens":50}}`}, common.GetPointer(50.0)},
		{"gemini", []string{`{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":40}}`}, common.GetPointer(40.0)},
		{"gemini_tool_input", []string{`{"usageMetadata":{"promptTokenCount":100,"toolUsePromptTokenCount":100,"cachedContentTokenCount":40}}`}, common.GetPointer(20.0)},
		{"gemini_tool_invalid", []string{`{"usageMetadata":{"promptTokenCount":100,"toolUsePromptTokenCount":-1,"cachedContentTokenCount":40}}`}, nil},
		{"cumulative", []string{`{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20}}`, `{"usageMetadata":{"promptTokenCount":200,"cachedContentTokenCount":100}}`}, common.GetPointer(50.0)},
		{"fractional", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":1.5}}}`}, nil},
		{"negative", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":-1}}}`}, nil},
		{"overflow", []string{`{"usage":{"prompt_tokens":9223372036854775808,"prompt_tokens_details":{"cached_tokens":1}}}`}, nil},
		{"over_input", []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":101}}}`}, nil},
		{"zero_input", []string{`{"usage":{"prompt_tokens":0,"prompt_tokens_details":{"cached_tokens":0}}}`}, nil},
	} {
		t.Run("cache_"+tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			groupavailability.ResetCacheUsage(c)
			for _, frame := range tc.frames {
				groupavailability.ObserveCacheUsageString(c, frame)
			}
			info := &relaycommon.RelayInfo{UsingGroup: "cache-" + tc.name, StartTime: time.Now()}
			groupavailability.RecordRelayResultWithContext(c, info, nil)
			require.NoError(t, collector.Flush())
			result, err := collector.Query(context.Background(), "90m", map[string]string{info.UsingGroup: "Cache"}, false)
			require.NoError(t, err)
			require.Len(t, result.Groups, 1)
			assert.Equal(t, tc.want, result.Groups[0].CacheHitRate)
			encoded, err := common.Marshal(result)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), "cache_input_tokens")
			assert.NotContains(t, string(encoded), "cache_read_tokens")
		})
	}
	// Weight raw upstream input totals, never average request percentages (90%, 0%).
	for _, frame := range []string{`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":90}}}`, `{"usage":{"prompt_tokens":900,"prompt_tokens_details":{"cached_tokens":0}}}`} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		groupavailability.ObserveCacheUsage(c, []byte(frame))
		groupavailability.RecordRelayResultWithContext(c, &relaycommon.RelayInfo{UsingGroup: "cache-weighted", StartTime: time.Now()}, nil)
	}
	// A failed or canceled request's cache facts do not enter successful usage.
	for _, canceled := range []bool{false, true} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		groupavailability.ObserveCacheUsage(c, []byte(`{"usage":{"prompt_tokens":9000,"prompt_tokens_details":{"cached_tokens":9000}}}`))
		apiErr := types.InitOpenAIError("server_error", 500)
		if canceled {
			ctx, cancel := context.WithCancel(c.Request.Context())
			cancel()
			c.Request = c.Request.WithContext(ctx)
			apiErr = nil
		}
		groupavailability.RecordRelayResultWithContext(c, &relaycommon.RelayInfo{UsingGroup: "cache-weighted", StartTime: time.Now()}, apiErr)
	}
	require.NoError(t, collector.Flush())
	require.NoError(t, collector.Flush())
	result, err := collector.Query(context.Background(), "90m", map[string]string{"cache-weighted": "Weighted"}, false)
	require.NoError(t, err)
	require.NotNil(t, result.Groups[0].CacheHitRate)
	assert.Equal(t, 9.0, *result.Groups[0].CacheHitRate)
	// A retry with no cache usage cannot inherit the previous attempt's facts.
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	groupavailability.ObserveCacheUsage(c, []byte(`{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":100}}}`))
	groupavailability.ResetCacheUsage(c)
	groupavailability.RecordRelayResultWithContext(c, &relaycommon.RelayInfo{UsingGroup: "cache-retry", StartTime: time.Now()}, nil)
	require.NoError(t, collector.Flush())
	result, err = collector.Query(context.Background(), "90m", map[string]string{"cache-retry": "Retry"}, false)
	require.NoError(t, err)
	assert.Nil(t, result.Groups[0].CacheHitRate)
}

func TestGroupAvailabilityCacheProviderHooks(t *testing.T) {
	previousDB, previousLogDB, previousCollector := model.DB, model.LOG_DB, groupavailability.Default
	previousType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis, previousTimeout := common.RedisEnabled, constant.StreamingTimeout
	t.Cleanup(func() {
		model.DB, model.LOG_DB, groupavailability.Default = previousDB, previousLogDB, previousCollector
		common.SetDatabaseTypes(previousType, previousLogType)
		common.RedisEnabled, constant.StreamingTimeout = previousRedis, previousTimeout
	})
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.GroupAvailabilityBucket{}, &model.Option{}))
	constant.StreamingTimeout = 10
	now := time.Date(2026, 10, 2, 14, 0, 0, 0, time.UTC)
	collector, err := groupavailability.NewCollector(func() time.Time { return now })
	require.NoError(t, err)
	groupavailability.Default = collector
	for _, tc := range []struct {
		name, provider, body   string
		format                 types.RelayFormat
		stream                 bool
		wantRate               *float64
		wantPrompt, wantCached int
	}{
		{"chat_json", "openai", `{"model":"test","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102,"prompt_tokens_details":{"cached_tokens":40}}}`, types.RelayFormatOpenAI, false, common.GetPointer(40.0), 100, 40},
		{"chat_zero", "openai", `{"model":"test","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102,"prompt_tokens_details":{"cached_tokens":0}}}`, types.RelayFormatOpenAI, false, common.GetPointer(0.0), 100, 0},
		{"chat_missing", "openai", `{"model":"test","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102}}`, types.RelayFormatOpenAI, false, nil, 100, 0},
		{"chat_estimated", "openai", `{"model":"test","choices":[],"usage":{"completion_tokens":2}}`, types.RelayFormatOpenAI, false, nil, 55, 0},
		{"claude_json", "claude", `{"id":"test","type":"message","role":"assistant","model":"test","content":[],"stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":2,"cache_creation_input_tokens":30,"cache_read_input_tokens":50}}`, types.RelayFormatClaude, false, common.GetPointer(50.0), 20, 50},
		{"gemini_json", "gemini", `{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":2,"totalTokenCount":102,"cachedContentTokenCount":40}}`, types.RelayFormatGemini, false, common.GetPointer(40.0), 100, 40},
		{"gemini_tool_json", "gemini", `{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":2,"totalTokenCount":202,"toolUsePromptTokenCount":100,"cachedContentTokenCount":40}}`, types.RelayFormatGemini, false, common.GetPointer(20.0), 200, 40},
		{"responses_json", "responses", `{"id":"test","object":"response","model":"test","status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":2,"total_tokens":102,"input_tokens_details":{"cached_tokens":40}}}`, types.RelayFormatOpenAIResponses, false, common.GetPointer(40.0), 100, 40},
		{"image_json", "image", `{"data":[{"b64_json":"fixture"}],"usage":{"input_tokens":100,"output_tokens":2,"total_tokens":102,"input_tokens_details":{"cached_tokens":40}}}`, types.RelayFormatOpenAI, false, common.GetPointer(40.0), 100, 40},
		{"image_json_as_sse", "image", `{"data":[{"b64_json":"fixture"}],"usage":{"input_tokens":100,"output_tokens":2,"total_tokens":102,"input_tokens_details":{"cached_tokens":40}}}`, types.RelayFormatOpenAI, true, common.GetPointer(40.0), 100, 40},
		{"chat_sse", "openai", "data: {\"model\":\"test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":2,\"total_tokens\":102,\"prompt_tokens_details\":{\"cached_tokens\":40}}}\n\ndata: [DONE]\n\n", types.RelayFormatOpenAI, true, common.GetPointer(40.0), 100, 40},
		{"claude_sse", "claude", "data: {\"type\":\"message_start\",\"message\":{\"id\":\"test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"test\",\"content\":[],\"usage\":{\"input_tokens\":20,\"output_tokens\":0,\"cache_creation_input_tokens\":30,\"cache_read_input_tokens\":50}}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\ndata: {\"type\":\"message_stop\"}\n\n", types.RelayFormatClaude, true, common.GetPointer(50.0), 20, 50},
		{"gemini_sse", "gemini", "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":100,\"candidatesTokenCount\":2,\"totalTokenCount\":102,\"cachedContentTokenCount\":40}}\n\n", types.RelayFormatGemini, true, common.GetPointer(40.0), 100, 40},
		{"responses_sse", "responses", "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"test\",\"model\":\"test\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":100,\"output_tokens\":2,\"total_tokens\":102,\"input_tokens_details\":{\"cached_tokens\":40}}}}\n\n", types.RelayFormatOpenAIResponses, true, common.GetPointer(40.0), 100, 40},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			info := &relaycommon.RelayInfo{UsingGroup: tc.name, IsStream: tc.stream, RelayFormat: tc.format, StartTime: time.Now(), ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "test"}}
			info.SetEstimatePromptTokens(55)
			resp := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(tc.body))}
			resp.Header.Set("Content-Type", "application/json")
			if strings.HasPrefix(tc.body, "data:") {
				resp.Header.Set("Content-Type", "text/event-stream")
			}
			var usage *dto.Usage
			var apiErr *types.NewAPIError
			switch tc.provider {
			case "openai":
				if tc.stream {
					usage, apiErr = openai.OaiStreamHandler(c, info, resp)
				} else {
					usage, apiErr = openai.OpenaiHandler(c, info, resp)
				}
			case "image":
				if tc.stream {
					usage, apiErr = openai.OpenaiImageStreamHandler(c, info, resp)
				} else {
					usage, apiErr = openai.OpenaiImageHandler(c, info, resp)
				}
			case "claude":
				if tc.stream {
					usage, apiErr = claude.ClaudeStreamHandler(c, resp, info)
				} else {
					usage, apiErr = claude.ClaudeHandler(c, resp, info)
				}
			case "gemini":
				if tc.stream {
					usage, apiErr = gemini.GeminiTextGenerationStreamHandler(c, info, resp)
				} else {
					usage, apiErr = gemini.GeminiTextGenerationHandler(c, info, resp)
				}
			case "responses":
				if tc.stream {
					usage, apiErr = openai.OaiResponsesStreamHandler(c, info, resp)
				} else {
					usage, apiErr = openai.OaiResponsesHandler(c, info, resp)
				}
			}
			require.Nil(t, apiErr)
			require.NotNil(t, usage)
			assert.Equal(t, tc.wantPrompt, usage.PromptTokens, "observation must not modify billing usage")
			assert.Equal(t, tc.wantCached, usage.PromptTokensDetails.CachedTokens)
			groupavailability.RecordRelayResultWithContext(c, info, apiErr)
			require.NoError(t, collector.Flush())
			result, err := collector.Query(context.Background(), "90m", map[string]string{tc.name: tc.name}, false)
			require.NoError(t, err)
			require.Len(t, result.Groups, 1)
			assert.Equal(t, tc.wantRate, result.Groups[0].CacheHitRate)
			require.NotNil(t, result.Groups[0].SuccessRate)
			assert.Equal(t, 100.0, *result.Groups[0].SuccessRate)
			assert.Nil(t, result.Groups[0].RequestCount)
		})
	}
	t.Run("bedrock_sdk_stream", func(t *testing.T) {
		var body bytes.Buffer
		for _, data := range []string{
			`{"type":"message_start","message":{"id":"test","type":"message","role":"assistant","model":"test","content":[],"usage":{"input_tokens":20,"output_tokens":0,"cache_creation_input_tokens":30,"cache_read_input_tokens":50}}}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
			`{"type":"message_stop"}`,
		} {
			payload, err := common.Marshal(struct {
				Bytes []byte `json:"bytes"`
			}{Bytes: []byte(data)})
			require.NoError(t, err)
			require.NoError(t, eventstream.NewEncoder().Encode(&body, eventstream.Message{
				Headers: eventstream.Headers{
					{Name: eventstreamapi.MessageTypeHeader, Value: eventstream.StringValue(eventstreamapi.EventMessageType)},
					{Name: eventstreamapi.EventTypeHeader, Value: eventstream.StringValue("chunk")},
					{Name: eventstreamapi.ContentTypeHeader, Value: eventstream.StringValue("application/json")},
				}, Payload: payload,
			}))
		}
		client := bedrockruntime.New(bedrockruntime.Options{
			Region: "us-east-1", BaseEndpoint: awsconfig.String("https://bedrock.test"),
			Credentials: awsconfig.NewCredentialsCache(credentials.NewStaticCredentialsProvider("test", "test", "")),
			HTTPClient: groupAvailabilityHTTPFixture(func(request *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Status: "200 OK", Request: request,
					Header: http.Header{"Content-Type": {"application/vnd.amazon.eventstream"}, "X-Amzn-Bedrock-Content-Type": {"application/json"}},
					Body:   io.NopCloser(bytes.NewReader(body.Bytes()))}, nil
			}), Retryer: awsconfig.NopRetryer{},
		})
		adaptor := &awsadapter.Adaptor{AwsClient: client, AwsReq: &bedrockruntime.InvokeModelWithResponseStreamInput{
			ModelId: awsconfig.String("anthropic.claude-3-5-sonnet-20240620-v1:0"), Body: []byte(`{}`), Accept: awsconfig.String("application/json"), ContentType: awsconfig.String("application/json"),
		}}
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
		info := &relaycommon.RelayInfo{UsingGroup: "bedrock", IsStream: true, RelayFormat: types.RelayFormatClaude, StartTime: time.Now(), ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "test"}}
		value, apiErr := adaptor.DoResponse(c, nil, info)
		require.Nil(t, apiErr)
		usage, ok := value.(*dto.Usage)
		require.True(t, ok)
		require.NotNil(t, usage)
		assert.Equal(t, 20, usage.PromptTokens)
		assert.Equal(t, 50, usage.PromptTokensDetails.CachedTokens)
		groupavailability.RecordRelayResultWithContext(c, info, nil)
		require.NoError(t, collector.Flush())
		result, err := collector.Query(context.Background(), "90m", map[string]string{"bedrock": "Bedrock"}, false)
		require.NoError(t, err)
		require.NotNil(t, result.Groups[0].CacheHitRate)
		assert.Equal(t, 50.0, *result.Groups[0].CacheHitRate)
	})
}

type groupAvailabilityHTTPFixture func(*http.Request) (*http.Response, error)

func (f groupAvailabilityHTTPFixture) Do(request *http.Request) (*http.Response, error) {
	return f(request)
}
