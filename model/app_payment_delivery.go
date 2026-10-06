package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

const AppPaymentWebhookMaxAttempts = 20

// ClaimAppPaymentWebhookEvents leases each event with a compare-and-swap.
// Multiple processes may scan the same rows; only one may deliver a lease.
func ClaimAppPaymentWebhookEvents(now time.Time, limit int) ([]PaymentWebhookEvent, error) {
	if limit < 1 || limit > 20 {
		limit = 4
	}
	var candidates []PaymentWebhookEvent
	err := DB.Where("delivered_at = 0 AND attempts < ? AND next_attempt_at <= ? AND lease_until <= ?", AppPaymentWebhookMaxAttempts, now.Unix(), now.Unix()).
		Order("next_attempt_at ASC").Order("id ASC").Limit(limit).Find(&candidates).Error
	if err != nil {
		return nil, err
	}
	claimed := make([]PaymentWebhookEvent, 0, len(candidates))
	for _, event := range candidates {
		token := uuid.NewString()
		result := DB.Model(&PaymentWebhookEvent{}).
			Where("id = ? AND delivered_at = 0 AND attempts < ? AND next_attempt_at <= ? AND lease_until <= ?", event.ID, AppPaymentWebhookMaxAttempts, now.Unix(), now.Unix()).
			Updates(map[string]interface{}{"lease_token": token, "lease_until": now.Add(2 * time.Minute).Unix(), "attempts": gorm.Expr("attempts + 1")})
		if result.Error != nil {
			return claimed, result.Error
		}
		if result.RowsAffected == 1 {
			event.LeaseToken = token
			event.LeaseUntil = now.Add(2 * time.Minute).Unix()
			event.Attempts++
			claimed = append(claimed, event)
		}
	}
	return claimed, nil
}

// FinishAppPaymentWebhookEvent only acknowledges the caller's current lease.
// A late response from a crashed worker cannot overwrite a newer attempt.
func FinishAppPaymentWebhookEvent(event PaymentWebhookEvent, delivered bool, resultCode string, now time.Time) error {
	updates := map[string]interface{}{"lease_token": "", "lease_until": 0}
	if delivered {
		updates["delivered_at"] = now.Unix()
		updates["last_error"] = ""
	} else {
		// Use only fixed result codes, never response bodies, URLs or secrets.
		if len(resultCode) > 64 {
			resultCode = "delivery_failed"
		}
		updates["last_error"] = resultCode
		shift := event.Attempts - 1
		if shift < 0 {
			shift = 0
		}
		if shift > 10 {
			shift = 10
		}
		delay := 30 * time.Second * time.Duration(1<<shift)
		if delay > 6*time.Hour {
			delay = 6 * time.Hour
		}
		updates["next_attempt_at"] = now.Add(delay).Unix()
	}
	return DB.Model(&PaymentWebhookEvent{}).Where("id = ? AND lease_token = ? AND delivered_at = 0", event.ID, event.LeaseToken).Updates(updates).Error
}

type AppPaymentWebhookDelivery struct {
	EventID       string `json:"id"`
	OrderID       string `json:"order_id"`
	EventType     string `json:"type"`
	Attempts      int    `json:"attempts"`
	NextAttemptAt int64  `json:"next_attempt_at"`
	DeliveredAt   int64  `json:"delivered_at"`
	LastError     string `json:"last_error"`
	CreatedAt     int64  `json:"created_at"`
}

func ListAppPaymentWebhookEvents(clientID string, page, pageSize int) ([]AppPaymentWebhookDelivery, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	q := DB.Model(&PaymentWebhookEvent{}).Where("client_id = ?", clientID)
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var events []PaymentWebhookEvent
	if err := q.Select("event_id", "order_id", "event_type", "attempts", "next_attempt_at", "delivered_at", "last_error", "created_at").
		Order("id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&events).Error; err != nil {
		return nil, 0, err
	}
	items := make([]AppPaymentWebhookDelivery, 0, len(events))
	for _, event := range events {
		items = append(items, AppPaymentWebhookDelivery{event.EventID, event.OrderID, event.EventType, event.Attempts, event.NextAttemptAt, event.DeliveredAt, event.LastError, event.CreatedAt})
	}
	return items, total, nil
}

func RetryAppPaymentWebhookEvent(clientID, eventID string, now int64) error {
	if clientID == "" || eventID == "" {
		return gorm.ErrRecordNotFound
	}
	result := DB.Model(&PaymentWebhookEvent{}).
		Where("client_id = ? AND event_id = ? AND delivered_at = 0 AND lease_until <= ?", clientID, eventID, now).
		Updates(map[string]interface{}{"attempts": 0, "next_attempt_at": now, "lease_until": 0, "lease_token": "", "last_error": ""})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrAppPaymentState
	}
	return nil
}
