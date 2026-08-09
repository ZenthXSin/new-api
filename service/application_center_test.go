package service

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAppCenterServiceTest(t *testing.T) (*model.AppCenterApp, string) {
	t.Helper()
	previousDB, previousSecret := model.DB, common.CryptoSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.AppCenterSchemaState{}, &model.AppCenterApp{}, &model.AppCenterRelease{}, &model.AppCenterAsset{}, &model.AppCenterAnnouncement{}, &model.AppCenterUsageSession{}, &model.AppCenterUsageBucket{}, &model.AppCenterCustomEventBucket{}, &model.AppCenterEventReceipt{}, &model.AppCenterEventIPReceipt{}))
	model.DB, common.CryptoSecret = db, "app-center-test-secret"
	t.Cleanup(func() { model.DB, common.CryptoSecret = previousDB, previousSecret; _ = sqlDB.Close() })
	app, token, err := CreateAppCenterApp("Test", "test-app", "", true, true)
	require.NoError(t, err)
	return app, token
}

func TestAppCenterKeyRotationAndTelemetryOnlyBearer(t *testing.T) {
	app, token := setupAppCenterServiceTest(t)
	require.NoError(t, model.DB.First(app, app.ID).Error)
	verified, err := VerifyAppCenterBearer("127.0.0.1", "Bearer "+token)
	require.NoError(t, err)
	assert.Equal(t, app.ID, verified.ID)
	rotated, err := RotateAppCenterKey(app.ID)
	require.NoError(t, err)
	assert.NotEqual(t, token, rotated)
	_, err = VerifyAppCenterBearer("127.0.0.1", "Bearer "+token)
	assert.Error(t, err)
	_, err = VerifyAppCenterBearer("127.0.0.1", "Bearer "+rotated)
	require.NoError(t, err)
	_, err = VerifyAppCenterBearer("127.0.0.1", "Bearer "+rotated+".extra")
	assert.Error(t, err)
}

func TestAppCenterUsageIdempotencyAndOnlineSeconds(t *testing.T) {
	app, _ := setupAppCenterServiceTest(t)
	base := AppCenterUsageInput{Type: "start", SessionID: "session-1", InstallationID: "install-1", Sequence: 1, Version: "1.0.0", Platform: "linux", Architecture: "amd64"}
	_, err := RecordAppCenterUsage(app, base)
	require.NoError(t, err)
	_, err = RecordAppCenterUsage(app, base)
	require.NoError(t, err)
	var session model.AppCenterUsageSession
	require.NoError(t, model.DB.First(&session).Error)
	session.LastSeenAt = time.Now().Add(-10 * time.Second)
	require.NoError(t, model.DB.Save(&session).Error)
	heartbeat := base
	heartbeat.Type, heartbeat.Sequence = "heartbeat", 2
	elapsed, err := RecordAppCenterUsage(app, heartbeat)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, elapsed, int64(9))
	stop := heartbeat
	stop.Type, stop.Sequence = "stop", 3
	_, err = RecordAppCenterUsage(app, stop)
	require.NoError(t, err)
	lateHeartbeat := stop
	lateHeartbeat.Type, lateHeartbeat.Sequence = "heartbeat", 4
	assert.ErrorIs(t, func() error { _, err := RecordAppCenterUsage(app, lateHeartbeat); return err }(), ErrAppCenterInvalid)
	lateStart := stop
	lateStart.Type, lateStart.Sequence = "start", 5
	assert.ErrorIs(t, func() error { _, err := RecordAppCenterUsage(app, lateStart); return err }(), ErrAppCenterInvalid)
	require.NoError(t, model.DB.First(&session, session.ID).Error)
	assert.NotNil(t, session.ClosedAt)
	var bucket model.AppCenterUsageBucket
	require.NoError(t, model.DB.First(&bucket).Error)
	assert.Equal(t, int64(1), bucket.StartCount)
	assert.GreaterOrEqual(t, bucket.OnlineSeconds, int64(9))
}

func TestAppCenterUsageRecordsSourceIP(t *testing.T) {
	app, _ := setupAppCenterServiceTest(t)
	in := AppCenterUsageInput{Type: "start", SessionID: "session-ip", InstallationID: "install-ip", Sequence: 1, Version: "1.0.0", Platform: "linux", Architecture: "amd64"}
	_, err := RecordAppCenterUsage(app, in, "203.0.113.10")
	require.NoError(t, err)
	var session model.AppCenterUsageSession
	require.NoError(t, model.DB.First(&session).Error)
	assert.Equal(t, "203.0.113.10", session.SourceIP)
}

func TestAppCenterEventsDeduplicateAndBoundDimensions(t *testing.T) {
	app, _ := setupAppCenterServiceTest(t)
	event := AppCenterEvent{EventID: "evt-1", Name: "opened", OccurredAt: time.Now().Unix(), Count: 2, Dimensions: map[string]string{"platform": "linux"}}
	accepted, err := RecordAppCenterEvents(app, []AppCenterEvent{event, event})
	require.NoError(t, err)
	assert.Equal(t, 1, accepted)
	var bucket model.AppCenterCustomEventBucket
	require.NoError(t, model.DB.First(&bucket).Error)
	assert.Equal(t, int64(2), bucket.Count)
	tooMany := event
	tooMany.EventID = "evt-2"
	tooMany.Dimensions = map[string]string{"a": "1", "b": "2", "c": "3", "d": "4", "e": "5", "f": "6", "g": "7", "h": "8", "i": "9"}
	_, err = RecordAppCenterEvents(app, []AppCenterEvent{tooMany})
	assert.ErrorIs(t, err, ErrAppCenterInvalid)
}

func TestAppCenterEventsRecordSourceIPAndUniqueUsers(t *testing.T) {
	app, _ := setupAppCenterServiceTest(t)
	event := AppCenterEvent{EventID: "evt-ip-1", Name: "opened", OccurredAt: time.Now().Unix(), Count: 1}
	accepted, err := RecordAppCenterEvents(app, []AppCenterEvent{event}, "203.0.113.9")
	require.NoError(t, err)
	assert.Equal(t, 1, accepted)
	var receipt model.AppCenterEventIPReceipt
	require.NoError(t, model.DB.First(&receipt).Error)
	assert.Equal(t, "203.0.113.9", receipt.SourceIP)
	var bucket model.AppCenterCustomEventBucket
	require.NoError(t, model.DB.First(&bucket).Error)
	assert.Equal(t, int64(1), bucket.UniqueUsers)

	event.EventID = "evt-ip-2"
	accepted, err = RecordAppCenterEvents(app, []AppCenterEvent{event}, "203.0.113.9")
	require.NoError(t, err)
	assert.Equal(t, 1, accepted)
	require.NoError(t, model.DB.First(&bucket).Error)
	assert.Equal(t, int64(1), bucket.UniqueUsers)
}

func TestAppCenterEventsCleanupExpiredReceipts(t *testing.T) {
	app, _ := setupAppCenterServiceTest(t)
	expiredAt := time.Now().UTC().Add(-time.Hour)
	require.NoError(t, model.DB.Create(&model.AppCenterEventReceipt{AppID: app.ID, EventID: "expired", ExpiresAt: expiredAt}).Error)
	require.NoError(t, model.DB.Create(&model.AppCenterEventIPReceipt{AppID: app.ID, BucketTs: time.Now().Add(-48*time.Hour).Unix() / 3600 * 3600, Name: "old", DimensionsHash: "old", SourceIP: "203.0.113.8", ExpiresAt: expiredAt}).Error)
	event := AppCenterEvent{EventID: "current", Name: "opened", OccurredAt: time.Now().Unix(), Count: 1}
	_, err := RecordAppCenterEvents(app, []AppCenterEvent{event}, "203.0.113.9")
	require.NoError(t, err)
	var eventReceipts int64
	var ipReceipts int64
	require.NoError(t, model.DB.Model(&model.AppCenterEventReceipt{}).Where("event_id = ?", "expired").Count(&eventReceipts).Error)
	require.NoError(t, model.DB.Model(&model.AppCenterEventIPReceipt{}).Where("name = ?", "old").Count(&ipReceipts).Error)
	assert.Zero(t, eventReceipts)
	assert.Zero(t, ipReceipts)
}

func TestAppCenterRejectsOrphanPublicationRows(t *testing.T) {
	setupAppCenterServiceTest(t)
	_, err := CreateAppCenterRelease(999, AppCenterReleaseInput{Version: "1.0.0", Channel: "stable"})
	assert.ErrorIs(t, err, ErrAppCenterNotFound)
	_, err = CreateAppCenterAnnouncement(999, AppCenterAnnouncementInput{Title: "notice"})
	assert.ErrorIs(t, err, ErrAppCenterNotFound)
}
