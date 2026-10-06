package model

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PaymentWalletGuard is durable. A cache restart must never silently unlock an
// ambiguous payment or authorize a fallback against an unflushed relay balance.
type PaymentWalletGuard struct {
	UserID      int    `gorm:"primaryKey;autoIncrement:false"`
	OperationID string `gorm:"type:varchar(64);not null;unique"`
	CreatedAt   int64  `gorm:"type:bigint;not null"`
}

type PaymentWalletOperation struct {
	ID        string `gorm:"type:varchar(64);primaryKey"`
	OrderID   string `gorm:"type:varchar(32);not null;index"`
	UserID    int    `gorm:"not null;index"`
	Quota     int    `gorm:"type:bigint;not null"`
	Direction string `gorm:"type:varchar(16);not null"`
	State     string `gorm:"type:varchar(24);not null;index"`
	UsesRedis bool   `gorm:"not null"`
	LastError string `gorm:"type:varchar(128)"`
	CreatedAt int64  `gorm:"type:bigint;not null"`
	UpdatedAt int64  `gorm:"type:bigint;not null"`
}

func appPaymentWalletGuardKey(userID int) string {
	return fmt.Sprintf("payment:wallet:guard:%d", userID)
}
func appPaymentWalletMarkerKey(id string) string { return "payment:wallet:operation:" + id }

// Called only on an existing cache miss/failure. Normal relay requests remain
// one Redis Lua operation and never add a database lookup for this guard.
func appPaymentWalletGuardPending(userID int) (bool, error) {
	var count int64
	err := DB.Model(&PaymentWalletGuard{}).Where("user_id = ?", userID).Count(&count).Error
	return count > 0, err
}

const appPaymentWalletScript = `
if redis.call('EXISTS', KEYS[6]) ~= 0 then return -3 end
if redis.call('GET', KEYS[5]) ~= ARGV[8] then return -3 end
local marker = redis.call('GET', KEYS[3])
if marker then
  if marker ~= ARGV[3] then return -4 end
  local existing = redis.call('GET', KEYS[2])
  if existing and existing ~= ARGV[2] then return -2 end
  redis.call('SET', KEYS[2], ARGV[2])
  return 1
end
if ARGV[4] ~= '1' then
  local existing = redis.call('GET', KEYS[2])
  if not existing or existing == ARGV[2] then redis.call('SET', KEYS[2], ARGV[2]) end
  return -3
end
local guard = redis.call('GET', KEYS[2])
if guard and guard ~= ARGV[2] then return -2 end
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[5])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[6])
  or redis.call('HEXISTS', KEYS[1], 'Quota') == 0 then return -1 end
if redis.call('GET', KEYS[5]) ~= ARGV[8] then return -3 end
local balance = tonumber(redis.call('GET', KEYS[4]))
if balance == nil then return -3 end
local delta = tonumber(ARGV[1])
if not balance or (delta < 0 and balance < -delta) then return 0 end
if balance + delta >= tonumber(ARGV[7]) then return -5 end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('INCRBY', KEYS[4], ARGV[1])
redis.call('HSET', KEYS[1], 'Quota', balance + delta)
redis.call('SET', KEYS[3], ARGV[3])
return 1`

func PayAppPaymentBalance(id string, userID, quota int, exchangeRate string) (*PaymentOrder, bool, error) {
	if userID <= 0 || quota <= 0 || quota >= common.MaxQuota || exchangeRate == "" || len(exchangeRate) > 64 {
		return nil, false, ErrAppPaymentInvalid
	}
	if existing, err := GetAppPaymentOrder(id); err == nil && (existing.Status == AppPaymentPaid || existing.Status == AppPaymentRefundPending || existing.Status == AppPaymentRefunded) {
		if existing.PaymentMethod != "balance" || existing.PayerUserID != userID || existing.BalanceQuota != quota || existing.ExchangeRate != exchangeRate {
			return nil, false, ErrAppPaymentConflict
		}
		return existing, true, nil
	}
	if err := requireAppPaymentWalletCache(userID); err != nil {
		return nil, false, err
	}
	order, operation, already, err := prepareAppPaymentWallet(id, userID, quota, exchangeRate, "debit")
	if err != nil || already {
		return order, already, err
	}
	if err = executeAppPaymentWallet(operation); err != nil {
		return order, false, err
	}
	order, err = GetAppPaymentOrder(id)
	return order, false, err
}

func RefundAppPaymentBalance(id string) (*PaymentOrder, bool, error) {
	order, err := GetAppPaymentOrder(id)
	if err != nil {
		return nil, false, err
	}
	if order.Status == AppPaymentRefunded {
		return order, true, nil
	}
	if order.PaymentMethod != "balance" || order.Status != AppPaymentRefundPending {
		return nil, false, ErrAppPaymentState
	}
	if err := requireAppPaymentWalletCache(order.PayerUserID); err != nil {
		return order, false, err
	}
	order, operation, already, err := prepareAppPaymentWallet(id, order.PayerUserID, order.BalanceQuota, order.ExchangeRate, "credit")
	if err != nil || already {
		return order, already, err
	}
	if err = executeAppPaymentWallet(operation); err != nil {
		return order, false, err
	}
	order, err = GetAppPaymentOrder(id)
	return order, false, err
}

func prepareAppPaymentWallet(id string, userID, quota int, rate, direction string) (*PaymentOrder, *PaymentWalletOperation, bool, error) {
	var order PaymentOrder
	var operation PaymentWalletOperation
	already := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", id).First(&order).Error; err != nil {
			return err
		}
		if direction == "debit" && (order.Status == AppPaymentPaid || order.Status == AppPaymentRefundPending || order.Status == AppPaymentRefunded) {
			if order.PaymentMethod != "balance" || order.PayerUserID != userID || order.BalanceQuota != quota || order.ExchangeRate != rate {
				return ErrAppPaymentConflict
			}
			already = true
			return nil
		}
		if direction == "credit" && order.Status == AppPaymentRefunded {
			already = true
			return nil
		}
		operationID := id + ":" + direction
		err := tx.Where("id = ?", operationID).First(&operation).Error
		if err == nil {
			if operation.UserID != userID || operation.Quota != quota || order.ExchangeRate != rate {
				return ErrAppPaymentConflict
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var user User
		if err := lockForUpdate(tx).Select("id", "status").First(&user, userID).Error; err != nil {
			return err
		}
		var mutations []PaymentWalletMutation
		if err := lockForUpdate(tx).Where("user_id = ?", userID).Limit(1).Find(&mutations).Error; err != nil {
			return err
		}
		if len(mutations) != 0 {
			return ErrAppPaymentBalancePending
		}
		if common.RedisEnabled {
			var unsafe []PaymentWalletCacheWitness
			if err := lockForUpdate(tx).Where("user_id = ? AND unsafe = ?", userID, true).Limit(1).Find(&unsafe).Error; err != nil {
				return err
			}
			if len(unsafe) != 0 {
				return ErrAppPaymentBalancePending
			}
		}
		if direction == "debit" {
			if order.PayerUserID != 0 && order.PayerUserID != userID {
				return ErrAppPaymentConflict
			}
			if order.Status != AppPaymentPending || order.ExpiresAt <= time.Now().Unix() {
				return ErrAppPaymentState
			}
			if user.Status != common.UserStatusEnabled {
				return ErrAppPaymentDisabled
			}
			var app PaymentApplication
			if err := tx.Where("client_id = ?", order.ClientID).First(&app).Error; err != nil {
				return err
			}
			if !app.Enabled || !app.AllowsMethod("balance") {
				return ErrAppPaymentDisabled
			}
			var client OauthClient
			if err := tx.Where("client_id = ?", order.ClientID).First(&client).Error; err != nil {
				return err
			}
			if !client.Enabled || client.IsPublic {
				return ErrAppPaymentDisabled
			}
			order.Status, order.PaymentMethod, order.Provider, order.PayerUserID = AppPaymentProcessing, "balance", "balance", userID
			order.BalanceQuota, order.ExchangeRate = quota, rate
		} else if order.Status != AppPaymentRefundPending || order.PaymentMethod != "balance" {
			return ErrAppPaymentState
		}
		now := time.Now().Unix()
		operation = PaymentWalletOperation{ID: operationID, OrderID: id, UserID: userID, Quota: quota, Direction: direction, State: "prepared", UsesRedis: common.RedisEnabled, CreatedAt: now, UpdatedAt: now}
		guard := PaymentWalletGuard{UserID: userID, OperationID: operationID, CreatedAt: now}
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&guard)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return ErrAppPaymentBalancePending
		}
		if err := tx.Create(&operation).Error; err != nil {
			return err
		}
		order.BalanceState = "prepared"
		order.UpdatedAt = now
		return tx.Model(&order).Updates(map[string]any{"status": order.Status, "payment_method": order.PaymentMethod, "provider": order.Provider, "payer_user_id": order.PayerUserID, "balance_quota": order.BalanceQuota, "exchange_rate": order.ExchangeRate, "balance_state": order.BalanceState, "updated_at": now}).Error
	})
	return &order, &operation, already, err
}

func executeAppPaymentWallet(operation *PaymentWalletOperation) error {
	if operation.State == "done" {
		return nil
	}
	if operation.State == "committed" {
		return finishAppPaymentWallet(operation)
	}
	fresh := false
	if operation.State == "prepared" {
		res := DB.Model(&PaymentWalletOperation{}).Where("id = ? AND state = ?", operation.ID, "prepared").Updates(map[string]any{"state": "cache_pending", "updated_at": time.Now().Unix()})
		if res.Error != nil {
			return res.Error
		}
		fresh = res.RowsAffected == 1
		operation.State = "cache_pending"
	}
	if operation.UsesRedis {
		if !common.RedisEnabled || common.RDB == nil {
			return ErrAppPaymentBalancePending
		}
		delta := operation.Quota
		if operation.Direction == "debit" {
			delta = -delta
		}
		allow := "0"
		if fresh {
			allow = "1"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result, err := common.RDB.Eval(ctx, appPaymentWalletScript, []string{getUserCacheKey(operation.UserID), appPaymentWalletGuardKey(operation.UserID), appPaymentWalletMarkerKey(operation.ID), appPaymentWalletMirrorKey(operation.UserID), appPaymentWalletEpochKey, appPaymentWalletUnsafeKey(operation.UserID)}, delta, operation.ID, fmt.Sprintf("%s:%d", operation.Direction, operation.Quota), allow, operation.UserID, userCacheSchemaVersion, common.MaxQuota, appPaymentWalletEpochValue()).Int()
		if err != nil {
			return ErrAppPaymentBalancePending
		}
		if result != 1 {
			if fresh && (result == 0 || result == -1 || result == -5) {
				if err := abortUnappliedAppPaymentWallet(operation); err != nil {
					return err
				}
				if result == 0 {
					return ErrAppPaymentInsufficient
				}
			}
			return ErrAppPaymentBalancePending
		}
	}
	if err := commitAppPaymentWallet(operation); err != nil {
		return err
	}
	return finishAppPaymentWallet(operation)
}

func commitAppPaymentWallet(operation *PaymentWalletOperation) error {
	err := DB.Transaction(func(tx *gorm.DB) error {
		var current PaymentWalletOperation
		if err := lockForUpdate(tx).Where("id = ?", operation.ID).First(&current).Error; err != nil {
			return err
		}
		if current.State == "committed" || current.State == "done" {
			*operation = current
			return nil
		}
		if current.State != "cache_pending" {
			return ErrAppPaymentState
		}
		if current.UsesRedis {
			var unsafe []PaymentWalletCacheWitness
			if err := lockForUpdate(tx).Where("user_id = ? AND unsafe = ?", current.UserID, true).Limit(1).Find(&unsafe).Error; err != nil {
				return err
			}
			if len(unsafe) != 0 {
				return ErrAppPaymentBalancePending
			}
		}
		var order PaymentOrder
		if err := lockForUpdate(tx).Where("id = ?", current.OrderID).First(&order).Error; err != nil {
			return err
		}
		delta := current.Quota
		eventType := "payment.refunded"
		query := tx.Model(&User{}).Where("id = ?", current.UserID)
		if current.Direction == "debit" {
			if order.Status != AppPaymentProcessing || order.PaymentMethod != "balance" {
				return ErrAppPaymentState
			}
			delta = -delta
			eventType = "payment.paid"
			query = query.Where("quota >= ?", current.Quota)
			order.Status = AppPaymentPaid
			order.PaidAt = time.Now().Unix()
		} else {
			if order.Status != AppPaymentRefundPending {
				return ErrAppPaymentState
			}
			query = query.Where("quota < ?", common.MaxQuota-current.Quota)
			order.Status = AppPaymentRefunded
			order.RefundedAt = time.Now().Unix()
		}
		res := query.Update("quota", gorm.Expr("quota + ?", delta))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			if !current.UsesRedis {
				return ErrAppPaymentInsufficient
			}
			return ErrAppPaymentBalancePending
		}
		order.BalanceState = "committed"
		order.UpdatedAt = time.Now().Unix()
		if err := tx.Model(&order).Updates(map[string]any{"status": order.Status, "paid_at": order.PaidAt, "refunded_at": order.RefundedAt, "balance_state": order.BalanceState, "updated_at": order.UpdatedAt}).Error; err != nil {
			return err
		}
		if err := insertAppPaymentWebhook(tx, &order, eventType); err != nil {
			return err
		}
		if err := tx.Model(&current).Updates(map[string]any{"state": "committed", "updated_at": order.UpdatedAt}).Error; err != nil {
			return err
		}
		operation.State = "committed"
		return nil
	})
	if errors.Is(err, ErrAppPaymentInsufficient) && !operation.UsesRedis {
		_ = abortUnappliedAppPaymentWallet(operation)
	}
	return err
}

func finishAppPaymentWallet(operation *PaymentWalletOperation) error {
	if operation.UsesRedis {
		if !common.RedisEnabled || common.RDB == nil {
			return ErrAppPaymentBalancePending
		}
		const script = `if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('DEL',KEYS[1]) end return 1`
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := common.RDB.Eval(ctx, script, []string{appPaymentWalletGuardKey(operation.UserID)}, operation.ID).Err(); err != nil {
			return ErrAppPaymentBalancePending
		}
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND operation_id = ?", operation.UserID, operation.ID).Delete(&PaymentWalletGuard{}).Error; err != nil {
			return err
		}
		if err := tx.Model(&PaymentWalletOperation{}).Where("id = ? AND state = ?", operation.ID, "committed").Updates(map[string]any{"state": "done", "updated_at": time.Now().Unix()}).Error; err != nil {
			return err
		}
		return tx.Model(&PaymentOrder{}).Where("id = ? AND balance_state = ?", operation.OrderID, "committed").Update("balance_state", "done").Error
	})
}

func abortUnappliedAppPaymentWallet(operation *PaymentWalletOperation) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var current PaymentWalletOperation
		if err := lockForUpdate(tx).Where("id = ?", operation.ID).First(&current).Error; err != nil {
			return err
		}
		if current.State != "cache_pending" {
			return ErrAppPaymentState
		}
		updates := map[string]any{"balance_state": "", "updated_at": time.Now().Unix()}
		if current.Direction == "debit" {
			updates["status"] = AppPaymentPending
			updates["payment_method"] = ""
			updates["provider"] = ""
			updates["payer_user_id"] = 0
			updates["balance_quota"] = 0
			updates["exchange_rate"] = ""
		}
		if err := tx.Model(&PaymentOrder{}).Where("id = ?", current.OrderID).Updates(updates).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ? AND operation_id = ?", current.UserID, current.ID).Delete(&PaymentWalletGuard{}).Error; err != nil {
			return err
		}
		return tx.Delete(&current).Error
	})
}

// ReconcileAppPaymentWalletOperations can be called periodically after startup.
// Only a durable commit or an existing Redis marker permits automatic recovery.
func ReconcileAppPaymentWalletOperations(limit int) (int, error) {
	var operations []PaymentWalletOperation
	if err := DB.Where("state <> ?", "done").Order("created_at ASC").Limit(min(max(limit, 1), 100)).Find(&operations).Error; err != nil {
		return 0, err
	}
	done := 0
	for i := range operations {
		if err := executeAppPaymentWallet(&operations[i]); err != nil {
			_ = DB.Model(&PaymentWalletOperation{}).Where("id = ?", operations[i].ID).Updates(map[string]any{"last_error": "reconciliation_pending", "updated_at": time.Now().Unix()}).Error
			continue
		}
		done++
	}
	return done, nil
}
