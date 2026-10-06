package model

import (
	"context"
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

type cacheQuotaResult int

const (
	cacheQuotaInsufficient cacheQuotaResult = iota
	cacheQuotaOK
	cacheQuotaMiss
	cacheQuotaGuarded
	cacheQuotaMirrorMissing
	cacheQuotaPending
)

const userQuotaReserveScript = `
if redis.call('EXISTS', KEYS[2]) ~= 0 then return -2 end
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[3])
  or redis.call('HEXISTS', KEYS[1], 'Quota') == 0 then
  return -1
end
local mirror = redis.call('GET', KEYS[3])
if not mirror and ARGV[4] == '1' then return -3 end
local quota = tonumber(mirror or redis.call('HGET', KEYS[1], 'Quota'))
if quota == nil or quota < tonumber(ARGV[1]) then
  return 0
end
local updated = quota - tonumber(ARGV[1])
redis.call('HSET', KEYS[1], 'Quota', updated)
if mirror then redis.call('SET', KEYS[3], updated) end
return 1`

const userQuotaDeltaScript = `
local mirror = redis.call('GET', KEYS[2])
if not mirror and ARGV[4] == '1' then return -3 end
local updated = nil
if mirror then updated = redis.call('INCRBY', KEYS[2], ARGV[1]) end
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[3])
  or redis.call('HEXISTS', KEYS[1], 'Quota') == 0 then
  return -1
end
if updated then redis.call('HSET', KEYS[1], 'Quota', updated)
else redis.call('HINCRBY', KEYS[1], 'Quota', tonumber(ARGV[1])) end
return 1`

const tokenQuotaReserveScript = `
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or redis.call('HEXISTS', KEYS[1], 'RemainQuota') == 0
  or redis.call('HEXISTS', KEYS[1], 'UsedQuota') == 0 then
  return -1
end
local remain = tonumber(redis.call('HGET', KEYS[1], 'RemainQuota'))
if remain == nil or remain < tonumber(ARGV[1]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'RemainQuota', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'UsedQuota', tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'AccessedTime', ARGV[3])
return 1`

const tokenQuotaDeltaScript = `
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or redis.call('HEXISTS', KEYS[1], 'RemainQuota') == 0
  or redis.call('HEXISTS', KEYS[1], 'UsedQuota') == 0 then
  return -1
end
redis.call('HINCRBY', KEYS[1], 'RemainQuota', tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'UsedQuota', -tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'AccessedTime', ARGV[3])
return 1`

func quotaResultFromLua(result int, err error) (cacheQuotaResult, error) {
	if err != nil {
		return cacheQuotaMiss, err
	}
	switch result {
	case 1:
		return cacheQuotaOK, nil
	case 0:
		return cacheQuotaInsufficient, nil
	case -2:
		return cacheQuotaGuarded, nil
	case -3:
		return cacheQuotaMirrorMissing, nil
	default:
		return cacheQuotaMiss, nil
	}
}

func cacheTryReserveUserQuota(userID int, amount int64) (cacheQuotaResult, error) {
	enabled := "0"
	if appPaymentWalletSchemaEnabled() && appPaymentWalletCacheReady.Load() {
		enabled = "1"
	}
	keys := []string{getUserCacheKey(userID), appPaymentWalletGuardKey(userID), appPaymentWalletMirrorKey(userID)}
	result, err := common.RDB.Eval(context.Background(), userQuotaReserveScript, keys, amount, userID, userCacheSchemaVersion, enabled).Int()
	if err == nil && result == -3 {
		if mirrorErr := ensureAppPaymentWalletMirror(userID, 0); mirrorErr != nil {
			if errors.Is(mirrorErr, errAppPaymentWalletMirrorPending) {
				return cacheQuotaPending, ErrAppPaymentBalancePending
			}
			markAppPaymentWalletUnsafe(userID)
		}
		result, err = common.RDB.Eval(context.Background(), userQuotaReserveScript, keys, amount, userID, userCacheSchemaVersion, "0").Int()
	}
	if err != nil {
		markAppPaymentWalletUnsafe(userID)
	}
	return quotaResultFromLua(result, err)
}

func cacheApplyUserQuotaDelta(userID int, delta int64) (cacheQuotaResult, error) {
	enabled := "0"
	if appPaymentWalletSchemaEnabled() && appPaymentWalletCacheReady.Load() {
		enabled = "1"
	}
	keys := []string{getUserCacheKey(userID), appPaymentWalletMirrorKey(userID)}
	result, err := common.RDB.Eval(context.Background(), userQuotaDeltaScript, keys, delta, userID, userCacheSchemaVersion, enabled).Int()
	if err == nil && result == -3 {
		if mirrorErr := ensureAppPaymentWalletMirror(userID, 0); mirrorErr != nil {
			markAppPaymentWalletUnsafe(userID)
		}
		result, err = common.RDB.Eval(context.Background(), userQuotaDeltaScript, keys, delta, userID, userCacheSchemaVersion, "0").Int()
	}
	if err != nil {
		markAppPaymentWalletUnsafe(userID)
	}
	return quotaResultFromLua(result, err)
}

func cacheTryReserveTokenQuota(id int, key string, amount int64) (cacheQuotaResult, error) {
	result, err := common.RDB.Eval(context.Background(), tokenQuotaReserveScript,
		[]string{getTokenCacheKey(key)}, amount, id, common.GetTimestamp()).Int()
	return quotaResultFromLua(result, err)
}

func cacheApplyTokenQuotaDelta(id int, key string, delta int64) (cacheQuotaResult, error) {
	result, err := common.RDB.Eval(context.Background(), tokenQuotaDeltaScript,
		[]string{getTokenCacheKey(key)}, delta, id, common.GetTimestamp()).Int()
	return quotaResultFromLua(result, err)
}

// persistUserQuotaDelta 把已在缓存侧预扣成功的增量落库；批量模式下入队，
// 直写模式下要求行存在（用户已删除时报错，交由调用方补偿缓存）。
func persistUserQuotaDelta(id int, delta int) error {
	if common.BatchUpdateEnabled {
		addNewRecord(BatchUpdateTypeUserQuota, id, delta)
		return nil
	}
	result := DB.Model(&User{}).Where("id = ?", id).Update("quota", gorm.Expr("quota + ?", delta))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func persistTokenQuotaDelta(id int, delta int) error {
	if common.BatchUpdateEnabled {
		addNewRecord(BatchUpdateTypeTokenQuota, id, delta)
		return nil
	}
	result := DB.Model(&Token{}).Where("id = ?", id).Updates(
		map[string]interface{}{
			"remain_quota":  gorm.Expr("remain_quota + ?", delta),
			"used_quota":    gorm.Expr("used_quota - ?", delta),
			"accessed_time": common.GetTimestamp(),
		},
	)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func reserveUserQuotaDB(id int, quota int) (bool, error) {
	result := DB.Model(&User{}).
		Where("id = ? AND quota >= ?", id, quota).
		Update("quota", gorm.Expr("quota - ?", quota))
	return result.RowsAffected == 1, result.Error
}

func reserveTokenQuotaDB(id int, quota int) (bool, error) {
	result := DB.Model(&Token{}).
		Where("id = ? AND remain_quota >= ?", id, quota).
		Updates(map[string]interface{}{
			"remain_quota":  gorm.Expr("remain_quota - ?", quota),
			"used_quota":    gorm.Expr("used_quota + ?", quota),
			"accessed_time": common.GetTimestamp(),
		})
	return result.RowsAffected == 1, result.Error
}

// TryReserveUserQuota atomically checks and deducts a user's wallet quota.
// 缓存命中时以缓存余额为准（避免批量模式下过期的数据库余额放大并发超扣）；
// Redis 异常或水合失败时降级为数据库条件更新，保证服务可用。
func TryReserveUserQuota(id int, quota int) (bool, error) {
	if quota < 0 {
		return false, errors.New("quota 不能为负数！")
	}
	if quota == 0 {
		return true, nil
	}
	if !common.RedisEnabled {
		if err := checkAppPaymentWalletGuard(id); err != nil {
			return false, err
		}
		return reserveUserQuotaDB(id, quota)
	}

	if appPaymentWalletSchemaEnabled() && !appPaymentWalletGuardsReady.Load() {
		if err := checkAppPaymentWalletGuard(id); err != nil {
			return false, err
		}
	}
	result, err := cacheTryReserveUserQuota(id, int64(quota))
	if result == cacheQuotaPending {
		return false, ErrAppPaymentBalancePending
	}
	if result == cacheQuotaGuarded {
		if err := clearOrphanAppPaymentWalletGuard(id); err != nil {
			return false, err
		}
		result, err = cacheTryReserveUserQuota(id, int64(quota))
	}
	if err == nil && result == cacheQuotaMiss {
		if _, hydrateErr := GetUserCache(id); hydrateErr == nil {
			result, err = cacheTryReserveUserQuota(id, int64(quota))
		} else if errors.Is(hydrateErr, errAppPaymentWalletMirrorPending) {
			return false, ErrAppPaymentBalancePending
		}

	}
	if result == cacheQuotaGuarded || result == cacheQuotaPending {
		return false, ErrAppPaymentBalancePending
	}
	if err != nil || result == cacheQuotaMiss {
		if guardErr := checkAppPaymentWalletGuard(id); guardErr != nil {
			return false, guardErr
		}
		if err != nil {
			common.SysLog("user quota cache reserve unavailable, falling back to database: " + err.Error())
		}
		markAppPaymentWalletUnsafe(id)
		return reserveUserQuotaDB(id, quota)
	}
	if result == cacheQuotaInsufficient {
		return false, nil
	}
	if err = persistUserQuotaDelta(id, -quota); err != nil {
		markAppPaymentWalletUnsafe(id)
		compensated, compensateErr := cacheApplyUserQuotaDelta(id, int64(quota))
		if compensateErr != nil || compensated != cacheQuotaOK {
			common.SysError(fmt.Sprintf("failed to compensate reserved user quota: result=%d error=%v", compensated, compensateErr))
		}
		return false, err
	}
	return true, nil
}

// TryReserveTokenQuota atomically checks and deducts a token quota. Unlimited
// tokens skip the balance check but still update remain/used accounting.
func TryReserveTokenQuota(id int, key string, quota int, unlimited bool) (bool, error) {
	if quota < 0 {
		return false, errors.New("quota 不能为负数！")
	}
	if quota == 0 {
		return true, nil
	}
	if unlimited {
		return true, DecreaseTokenQuota(id, key, quota)
	}
	if !common.RedisEnabled {
		return reserveTokenQuotaDB(id, quota)
	}

	result, err := cacheTryReserveTokenQuota(id, key, int64(quota))
	if err == nil && result == cacheQuotaMiss {
		if _, hydrateErr := GetTokenByKey(key, true); hydrateErr == nil {
			result, err = cacheTryReserveTokenQuota(id, key, int64(quota))
		}
	}
	if err != nil || result == cacheQuotaMiss {
		if err != nil {
			common.SysLog("token quota cache reserve unavailable, falling back to database: " + err.Error())
		}
		return reserveTokenQuotaDB(id, quota)
	}
	if result == cacheQuotaInsufficient {
		return false, nil
	}
	if err = persistTokenQuotaDelta(id, -quota); err != nil {
		compensated, compensateErr := cacheApplyTokenQuotaDelta(id, key, int64(quota))
		if compensateErr != nil || compensated != cacheQuotaOK {
			common.SysError(fmt.Sprintf("failed to compensate reserved token quota: result=%d error=%v", compensated, compensateErr))
		}
		return false, err
	}
	return true, nil
}
