package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupAppPaymentDeliveryTest(t *testing.T) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previousDB, previousDialect := DB, common.MainDatabaseType()
	DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		DB = previousDB
		common.SetMainDatabaseType(previousDialect)
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&PaymentWebhookEvent{}))
}

func TestAppPaymentWebhookLeasesRetriesAndStaleAcknowledgments(t *testing.T) {
	setupAppPaymentDeliveryTest(t)
	now := time.Unix(1800000000, 0)
	event := PaymentWebhookEvent{EventID: "evt-paid", ClientID: "app", OrderID: "order", EventType: "payment.paid", Payload: `{"id":"evt-paid"}`, WebhookURL: "https://merchant.example/events", SecretEncrypted: "encrypted", CreatedAt: now.Unix()}
	require.NoError(t, DB.Create(&event).Error)
	first, err := ClaimAppPaymentWebhookEvents(now, 4)
	require.NoError(t, err)
	require.Len(t, first, 1)
	assert.Equal(t, 1, first[0].Attempts)
	second, err := ClaimAppPaymentWebhookEvents(now, 4)
	require.NoError(t, err)
	assert.Empty(t, second)
	require.Error(t, RetryAppPaymentWebhookEvent("app", "evt-paid", now.Unix()), "active delivery cannot be reset")

	// A process may die after sending but before acknowledgment. The next
	// process reuses the event ID/body with a fresh exclusive lease.
	now = now.Add(3 * time.Minute)
	second, err = ClaimAppPaymentWebhookEvents(now, 4)
	require.NoError(t, err)
	require.Len(t, second, 1)
	assert.Equal(t, first[0].EventID, second[0].EventID)
	assert.Equal(t, first[0].Payload, second[0].Payload)
	assert.NotEqual(t, first[0].LeaseToken, second[0].LeaseToken)
	require.NoError(t, FinishAppPaymentWebhookEvent(first[0], true, "", now))
	var current PaymentWebhookEvent
	require.NoError(t, DB.First(&current, event.ID).Error)
	assert.Zero(t, current.DeliveredAt, "old worker cannot acknowledge the new lease")
	require.NoError(t, FinishAppPaymentWebhookEvent(second[0], false, "http_503", now))
	require.NoError(t, DB.First(&current, event.ID).Error)
	assert.Equal(t, now.Add(time.Minute).Unix(), current.NextAttemptAt)
	assert.Equal(t, "http_503", current.LastError)

	third, err := ClaimAppPaymentWebhookEvents(now.Add(59*time.Second), 4)
	require.NoError(t, err)
	assert.Empty(t, third)
	third, err = ClaimAppPaymentWebhookEvents(now.Add(time.Minute), 4)
	require.NoError(t, err)
	require.Len(t, third, 1)
	require.NoError(t, FinishAppPaymentWebhookEvent(third[0], true, "", now.Add(time.Minute)))
	fourth, err := ClaimAppPaymentWebhookEvents(now.Add(time.Hour), 4)
	require.NoError(t, err)
	assert.Empty(t, fourth)
	require.Error(t, RetryAppPaymentWebhookEvent("app", "evt-paid", now.Add(time.Hour).Unix()), "delivered event is immutable")
}

func TestAppPaymentWebhookExhaustionAndApplicationIsolation(t *testing.T) {
	setupAppPaymentDeliveryTest(t)
	now := time.Unix(1800000000, 0)
	event := PaymentWebhookEvent{EventID: "evt-refund", ClientID: "app", OrderID: "order", EventType: "payment.refunded", Payload: `{"id":"evt-refund"}`, WebhookURL: "https://merchant.example/events", SecretEncrypted: "encrypted", Attempts: AppPaymentWebhookMaxAttempts, CreatedAt: now.Unix()}
	require.NoError(t, DB.Create(&event).Error)
	claimed, err := ClaimAppPaymentWebhookEvents(now, 4)
	require.NoError(t, err)
	assert.Empty(t, claimed)
	require.Error(t, RetryAppPaymentWebhookEvent("another-app", "evt-refund", now.Unix()))
	items, total, err := ListAppPaymentWebhookEvents("another-app", 1, 20)
	require.NoError(t, err)
	assert.Empty(t, items)
	assert.Zero(t, total)

	items, total, err = ListAppPaymentWebhookEvents("app", 1, 20)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.EqualValues(t, 1, total)
	data, err := common.Marshal(items)
	require.NoError(t, err)
	assert.NotContains(t, string(data), "encrypted")
	assert.NotContains(t, string(data), "merchant.example")
	assert.NotContains(t, string(data), "payload")
	require.NoError(t, RetryAppPaymentWebhookEvent("app", "evt-refund", now.Unix()))
	claimed, err = ClaimAppPaymentWebhookEvents(now, 4)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, "evt-refund", claimed[0].EventID)
	assert.Equal(t, 1, claimed[0].Attempts)
}
