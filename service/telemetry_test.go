package service

import (
	"bytes"
	"strconv"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupTelemetryTestDB(t *testing.T) *model.TelemetryApp {
	t.Helper()

	previousDB := model.DB
	previousCryptoSecret := common.CryptoSecret
	previousRedisEnabled := common.RedisEnabled
	previousRDB := common.RDB

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(
		&model.TelemetryProject{},
		&model.TelemetryApp{},
		&model.TelemetryWriteKey{},
		&model.TelemetryNonce{},
		&model.TelemetryBucket{},
		&model.TelemetryReceiverMetric{},
	))

	model.DB = db
	common.CryptoSecret = "telemetry-test-secret"
	common.RedisEnabled = false
	common.RDB = nil
	telemetryRateMu.Lock()
	telemetryRateWindows = map[string]telemetryRateWindow{}
	telemetryRateMu.Unlock()
	t.Cleanup(func() {
		model.DB = previousDB
		common.CryptoSecret = previousCryptoSecret
		common.RedisEnabled = previousRedisEnabled
		common.RDB = previousRDB
		telemetryRateMu.Lock()
		telemetryRateWindows = map[string]telemetryRateWindow{}
		telemetryRateMu.Unlock()
		_ = sqlDB.Close()
	})

	project, err := model.CreateTelemetryProject("test-project")
	require.NoError(t, err)
	app, err := model.CreateTelemetryApp(project.ID, "test-app")
	require.NoError(t, err)
	return app
}

func TestTelemetryRequestVerificationPreventsReplay(t *testing.T) {
	app := setupTelemetryTestDB(t)
	key, secret, err := CreateTelemetryWriteKey(app.ID, "test-key")
	require.NoError(t, err)

	body := []byte(`{"schema_version":1,"events":[]}`)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := "request-nonce-1"
	signature := TelemetryRequestSignature("POST", "/api/telemetry/ingest", timestamp, nonce, secret, body)

	verifiedKey, err := VerifyTelemetryRequest("POST", "/api/telemetry/ingest", "127.0.0.1", key.KeyID, timestamp, nonce, signature, body)
	require.NoError(t, err)
	assert.Equal(t, key.ID, verifiedKey.ID)

	_, err = VerifyTelemetryRequest("POST", "/api/telemetry/ingest", "127.0.0.1", key.KeyID, timestamp, nonce, signature, body)
	require.Error(t, err)
	assert.Equal(t, "遥测请求已处理", err.Error())
}

func TestTelemetryRequestVerificationRejectsInvalidSignatureAndTimestamp(t *testing.T) {
	app := setupTelemetryTestDB(t)
	key, secret, err := CreateTelemetryWriteKey(app.ID, "test-key")
	require.NoError(t, err)

	body := []byte(`{"schema_version":1,"events":[]}`)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	signature := TelemetryRequestSignature("POST", "/api/telemetry/ingest", timestamp, "valid-nonce", secret, body)

	_, err = VerifyTelemetryRequest("POST", "/api/telemetry/ingest", "127.0.0.1", key.KeyID, timestamp, "valid-nonce", "00"+signature[2:], body)
	require.Error(t, err)
	assert.Equal(t, "遥测认证无效", err.Error())

	expiredTimestamp := strconv.FormatInt(time.Now().Add(-2*time.Hour).Unix(), 10)
	expiredSignature := TelemetryRequestSignature("POST", "/api/telemetry/ingest", expiredTimestamp, "expired-nonce", secret, body)
	_, err = VerifyTelemetryRequest("POST", "/api/telemetry/ingest", "127.0.0.1", key.KeyID, expiredTimestamp, "expired-nonce", expiredSignature, body)
	require.Error(t, err)
	assert.Equal(t, "遥测时间戳无效", err.Error())
}

func TestIngestTelemetryAggregatesValidatedEvents(t *testing.T) {
	app := setupTelemetryTestDB(t)
	key, _, err := CreateTelemetryWriteKey(app.ID, "test-key")
	require.NoError(t, err)

	now := time.Now().Unix()
	event := TelemetryEvent{
		EventID:         "event-1",
		OccurredAt:      now,
		InstallationID:  "installation-1",
		InstanceVersion: "v1.2.3",
		EventType:       "request_summary",
		Payload: TelemetryPayload{
			Dimension:  "chat-completions",
			Status:     "success",
			Count:      2,
			Successes:  2,
			DurationMs: 500,
			Value:      9,
		},
	}
	envelope := &TelemetryEnvelope{SchemaVersion: telemetrySchemaVersion, Events: []TelemetryEvent{event}}

	accepted, err := IngestTelemetry(key, envelope)
	require.NoError(t, err)
	assert.Equal(t, 1, accepted)
	accepted, err = IngestTelemetry(key, envelope)
	require.NoError(t, err)
	assert.Equal(t, 1, accepted)

	var bucket model.TelemetryBucket
	require.NoError(t, model.DB.First(&bucket).Error)
	assert.Equal(t, int64(4), bucket.EventCount)
	assert.Equal(t, int64(4), bucket.SuccessCount)
	assert.Equal(t, int64(1000), bucket.TotalDurationMs)
	assert.Equal(t, int64(18), bucket.TotalValue)
	assert.NotEqual(t, event.InstallationID, bucket.InstallationHash)

	var metric model.TelemetryReceiverMetric
	require.NoError(t, model.DB.First(&metric).Error)
	assert.Equal(t, int64(2), metric.AcceptedCount)
}

func TestIngestTelemetryRejectsInvalidEventWithoutPersistence(t *testing.T) {
	app := setupTelemetryTestDB(t)
	key, _, err := CreateTelemetryWriteKey(app.ID, "test-key")
	require.NoError(t, err)

	accepted, err := IngestTelemetry(key, &TelemetryEnvelope{
		SchemaVersion: telemetrySchemaVersion,
		Events: []TelemetryEvent{
			{
				EventID:         "event-1",
				OccurredAt:      time.Now().Unix(),
				InstallationID:  "installation-1",
				InstanceVersion: "v1",
				EventType:       "startup",
				Payload: TelemetryPayload{
					Dimension: "summary",
					Status:    "success",
					Count:     1,
				},
			},
			{
				EventID:         "event-2",
				OccurredAt:      time.Now().Unix(),
				InstallationID:  "installation-1",
				InstanceVersion: "v1",
				EventType:       "unknown-event",
				Payload: TelemetryPayload{
					Dimension: "summary",
					Status:    "success",
					Count:     1,
				},
			},
		},
	})
	require.Error(t, err)
	assert.Equal(t, 0, accepted)

	var count int64
	require.NoError(t, model.DB.Model(&model.TelemetryBucket{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestTelemetryStrictDecoderRejectsUnknownAndTrailingFields(t *testing.T) {
	var envelope TelemetryEnvelope
	err := common.DecodeJsonStrict(bytes.NewBufferString(`{"schema_version":1,"events":[],"payload":"unexpected"}`), &envelope)
	require.Error(t, err)

	err = common.DecodeJsonStrict(bytes.NewBufferString(`{"schema_version":1,"events":[]} {}`), &envelope)
	require.Error(t, err)
}

func TestTakeTelemetryRateLimitUsesConfiguredLimit(t *testing.T) {
	setupTelemetryTestDB(t)

	assert.True(t, takeTelemetryRateLimit("test-limit", 2))
	assert.True(t, takeTelemetryRateLimit("test-limit", 2))
	assert.False(t, takeTelemetryRateLimit("test-limit", 2))
}

func TestQueryTelemetryTimeSeriesKeepsHourlyBucketsAndFiltersApp(t *testing.T) {
	app := setupTelemetryTestDB(t)
	otherProject, err := model.CreateTelemetryProject("other-project")
	require.NoError(t, err)
	otherApp, err := model.CreateTelemetryApp(otherProject.ID, "other-app")
	require.NoError(t, err)

	nowBucket := time.Now().Unix() / 3600 * 3600
	buckets := []model.TelemetryBucket{
		{AppID: app.ID, InstallationHash: "install-a", AppVersion: "v1", EventType: "startup", Dimension: "summary", Status: "success", BucketTs: nowBucket - 3600, EventCount: 2, SuccessCount: 2, TotalDurationMs: 100, TotalValue: 3},
		{AppID: app.ID, InstallationHash: "install-b", AppVersion: "v1", EventType: "startup", Dimension: "summary", Status: "success", BucketTs: nowBucket - 3600, EventCount: 3, SuccessCount: 2, TotalDurationMs: 200, TotalValue: 4},
		{AppID: app.ID, InstallationHash: "install-a", AppVersion: "v1", EventType: "startup", Dimension: "summary", Status: "success", BucketTs: nowBucket, EventCount: 5, SuccessCount: 5, TotalDurationMs: 300, TotalValue: 5},
		{AppID: otherApp.ID, InstallationHash: "install-c", AppVersion: "v2", EventType: "startup", Dimension: "summary", Status: "success", BucketTs: nowBucket, EventCount: 9, SuccessCount: 9},
		{AppID: app.ID, InstallationHash: "install-old", AppVersion: "v1", EventType: "startup", Dimension: "summary", Status: "success", BucketTs: nowBucket - 7200, EventCount: 11, SuccessCount: 11},
	}
	for i := range buckets {
		require.NoError(t, model.DB.Create(&buckets[i]).Error)
	}

	rows, err := model.QueryTelemetryTimeSeries(app.ID, nowBucket-3600)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, nowBucket-3600, rows[0].BucketTs)
	assert.Equal(t, int64(5), rows[0].EventCount)
	assert.Equal(t, int64(4), rows[0].SuccessCount)
	assert.Equal(t, int64(300), rows[0].TotalDurationMs)
	assert.Equal(t, int64(7), rows[0].TotalValue)
	assert.Equal(t, nowBucket, rows[1].BucketTs)
	assert.Equal(t, int64(5), rows[1].EventCount)
}
