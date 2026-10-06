package model

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// The witness survives Redis loss; a lost mirror is never rebuilt from a
// database balance which can still contain unflushed relay consumption.
type PaymentWalletCacheWitness struct {
	UserID    int   `gorm:"primaryKey;autoIncrement:false"`
	Unsafe    bool  `gorm:"not null"`
	CreatedAt int64 `gorm:"type:bigint;not null"`
}

// Independent database credits/debits hold this durable fence through their
// cache synchronization. A crash requires reconciliation, never TTL unlock.
type PaymentWalletMutation struct {
	ID        string `gorm:"type:varchar(64);primaryKey"`
	UserID    int    `gorm:"not null;index"`
	CreatedAt int64  `gorm:"type:bigint;not null"`
}

var appPaymentWalletCacheReady atomic.Bool
var appPaymentWalletGuardsReady atomic.Bool
var appPaymentWalletEpoch atomic.Value
var appPaymentWalletSchemaDB atomic.Pointer[gorm.DB]
var appPaymentWalletUnpersistedUnsafe sync.Map

var errAppPaymentWalletMirrorPending = errors.New("wallet mirror initialization pending")

const appPaymentWalletEpochKey = "payment:wallet:epoch"

func appPaymentWalletMirrorKey(userID int) string {
	return fmt.Sprintf("payment:wallet:balance:%d", userID)
}
func appPaymentWalletUnsafeKey(userID int) string {
	return fmt.Sprintf("payment:wallet:unsafe:%d", userID)
}
func appPaymentWalletSchemaEnabled() bool { return DB != nil && appPaymentWalletSchemaDB.Load() == DB }

// Call after DB migration and Redis initialization, before serving requests.
// Schema readiness remains enabled even when the Redis epoch is unavailable.
func InitializeAppPaymentWalletCache() error {
	appPaymentWalletSchemaDB.Store(DB)
	appPaymentWalletCacheReady.Store(false)
	appPaymentWalletGuardsReady.Store(false)
	appPaymentWalletEpoch.Store("")
	if !common.RedisEnabled {
		appPaymentWalletGuardsReady.Store(true)
		appPaymentWalletCacheReady.Store(true)
		return nil
	}
	var guards []PaymentWalletGuard
	if err := DB.Find(&guards).Error; err != nil {
		return err
	}
	for _, guard := range guards {
		if err := common.RDB.Set(context.Background(), appPaymentWalletGuardKey(guard.UserID), guard.OperationID, 0).Err(); err != nil {
			return err
		}
	}
	appPaymentWalletGuardsReady.Store(true)
	id, err := appPaymentRandomID("wallet_")
	if err != nil {
		return err
	}
	option := Option{Key: appPaymentWalletEpochKey, Value: id}
	res := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&option)
	if res.Error != nil {
		return res.Error
	}
	created := res.RowsAffected == 1
	if err := DB.Where(commonKeyCol+" = ?", appPaymentWalletEpochKey).First(&option).Error; err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if created {
		if err := common.RDB.SetNX(ctx, appPaymentWalletEpochKey, option.Value, 0).Err(); err != nil {
			return err
		}
	}
	value, err := common.RDB.Get(ctx, appPaymentWalletEpochKey).Result()
	if err != nil || value != option.Value {
		return ErrAppPaymentBalancePending
	}
	appPaymentWalletEpoch.Store(option.Value)
	appPaymentWalletCacheReady.Store(true)
	return nil
}
func appPaymentWalletEpochValue() string {
	value := appPaymentWalletEpoch.Load()
	if value == nil {
		return ""
	}
	return value.(string)
}

func ensureAppPaymentWalletMirror(userID int, _ int) error {
	if !common.RedisEnabled || !appPaymentWalletSchemaEnabled() {
		return nil
	}
	if !appPaymentWalletCacheReady.Load() {
		return ErrAppPaymentBalancePending
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if exists, err := common.RDB.Exists(ctx, appPaymentWalletMirrorKey(userID)).Result(); err != nil {
		return err
	} else if exists != 0 {
		return nil
	}
	witness := PaymentWalletCacheWitness{UserID: userID, CreatedAt: time.Now().Unix()}
	witnessResult := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&witness)
	if witnessResult.Error != nil {
		return witnessResult.Error
	}
	allow := "0"
	if witnessResult.RowsAffected == 1 {
		allow = "1"
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).Select("id", "quota").First(&user, userID).Error; err != nil {
			return err
		}
		var guards int64
		if err := tx.Model(&PaymentWalletGuard{}).Where("user_id = ?", userID).Count(&guards).Error; err != nil {
			return err
		}
		if guards != 0 {
			return ErrAppPaymentBalancePending
		}
		const script = `
if redis.call('GET',KEYS[4]) ~= ARGV[4] then return -1 end
if redis.call('EXISTS',KEYS[3]) ~= 0 then return -1 end
if redis.call('EXISTS',KEYS[2]) ~= 0 then return 1 end
if ARGV[1] ~= '1' then return -2 end
local balance = redis.call('HGET',KEYS[1],'Quota')
if tonumber(redis.call('HGET',KEYS[1],'Id') or '0') ~= tonumber(ARGV[3]) then balance = nil end
redis.call('SET',KEYS[2],balance or ARGV[2])
return 1`
		result, err := common.RDB.Eval(ctx, script, []string{getUserCacheKey(userID), appPaymentWalletMirrorKey(userID), appPaymentWalletGuardKey(userID), appPaymentWalletEpochKey}, allow, user.Quota, userID, appPaymentWalletEpochValue()).Int()
		if err != nil {
			return err
		}
		if result == -2 {
			return errAppPaymentWalletMirrorPending
		}
		if result != 1 {
			return ErrAppPaymentBalancePending
		}
		return nil
	})
}

func requireAppPaymentWalletCache(userID int) error {
	if !appPaymentWalletSchemaEnabled() || !appPaymentWalletCacheReady.Load() {
		return ErrAppPaymentBalancePending
	}
	if !common.RedisEnabled {
		if common.BatchUpdateEnabled {
			return ErrAppPaymentBalancePending
		}
		return nil
	}
	if err := ensureAppPaymentWalletMirror(userID, 0); err != nil {
		return ErrAppPaymentBalancePending
	}
	if _, err := GetUserCache(userID); err != nil {
		return ErrAppPaymentBalancePending
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	values, err := common.RDB.MGet(ctx, appPaymentWalletEpochKey, appPaymentWalletMirrorKey(userID), appPaymentWalletUnsafeKey(userID)).Result()
	if err != nil || len(values) != 3 || values[0] != appPaymentWalletEpochValue() || values[1] == nil || values[2] != nil {
		return ErrAppPaymentBalancePending
	}
	return nil
}

// BeginAppPaymentQuotaMutation must run BEFORE any independent database quota
// write, and its returned cleanup must run AFTER synchronous cache adjustment.
// Payments and these mutations serialize on the user row. Relay Lua updates do
// not use this fence and retain their existing one-round-trip hot path.
func BeginAppPaymentQuotaMutation(userID int) (func(), error) {
	noop := func() {}
	if !appPaymentWalletSchemaEnabled() {
		return noop, nil
	}
	if common.RedisEnabled {
		if err := ensureAppPaymentWalletMirror(userID, 0); err != nil {
			if errors.Is(err, errAppPaymentWalletMirrorPending) {
				return noop, ErrAppPaymentBalancePending
			}
			markAppPaymentWalletUnsafe(userID)
			return noop, ErrAppPaymentBalancePending
		}
	}
	id, err := appPaymentRandomID("mutation_")
	if err != nil {
		return noop, err
	}
	mutation := PaymentWalletMutation{ID: id, UserID: userID, CreatedAt: time.Now().Unix()}
	err = DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).Select("id").First(&user, userID).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&PaymentWalletGuard{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			return ErrAppPaymentBalancePending
		}
		return tx.Create(&mutation).Error
	})
	if err != nil {
		return noop, err
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			if _, pending := appPaymentWalletUnpersistedUnsafe.Load(userID); pending {
				return
			}
			if err := DB.Where("id = ?", id).Delete(&PaymentWalletMutation{}).Error; err != nil {
				common.SysLog("wallet quota mutation reconciliation pending")
			}
		})
	}, nil
}

func markAppPaymentWalletUnsafe(userID int) {
	if !appPaymentWalletSchemaEnabled() {
		return
	}
	// Publish both persistent witnesses. Either store alone fences every other
	// instance, and a failed durable write preserves any existing mutation row.
	appPaymentWalletUnpersistedUnsafe.Store(userID, true)
	if common.RedisEnabled && common.RDB != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = common.RDB.Set(ctx, appPaymentWalletUnsafeKey(userID), "1", 0).Err()
		cancel()
	}
	witness := PaymentWalletCacheWitness{UserID: userID, Unsafe: true, CreatedAt: time.Now().Unix()}
	if err := DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}}, DoUpdates: clause.Assignments(map[string]any{"unsafe": true})}).Create(&witness).Error; err != nil {
		appPaymentWalletCacheReady.Store(false)
		common.SysLog("wallet cache trust update pending")
		return
	}
	appPaymentWalletUnpersistedUnsafe.Delete(userID)
}

func checkAppPaymentWalletGuard(userID int) error {
	if !appPaymentWalletSchemaEnabled() {
		return nil
	}
	pending, err := appPaymentWalletGuardPending(userID)
	if err != nil {
		return err
	}
	if pending {
		return ErrAppPaymentBalancePending
	}
	return nil
}

// ResetAppPaymentWalletCacheForTesting isolates fixtures that replace model.DB.
// Production must initialize once after migration and never reset these guards.
func ResetAppPaymentWalletCacheForTesting() {
	appPaymentWalletSchemaDB.Store(nil)
	appPaymentWalletUnpersistedUnsafe.Clear()
	appPaymentWalletCacheReady.Store(false)
	appPaymentWalletEpoch.Store("")
}

// MarkAppPaymentWalletUnsafe fences merchant spending after an ambiguous quota write.
func MarkAppPaymentWalletUnsafe(userID int) { markAppPaymentWalletUnsafe(userID) }

// Stale replay can race another instance completing a payment. Only a guarded
// request takes this slow path; removing an orphan requires the observed value
// and the absence of the durable guard to agree.
func clearOrphanAppPaymentWalletGuard(userID int) error {
	value, err := common.RDB.Get(context.Background(), appPaymentWalletGuardKey(userID)).Result()
	if err != nil {
		return ErrAppPaymentBalancePending
	}
	pending, err := appPaymentWalletGuardPending(userID)
	if err != nil {
		return err
	}
	if pending {
		return ErrAppPaymentBalancePending
	}
	const script = `if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('DEL',KEYS[1]) end return 1`
	return common.RDB.Eval(context.Background(), script, []string{appPaymentWalletGuardKey(userID)}, value).Err()
}
