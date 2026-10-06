package model

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"

	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

type TopUp struct {
	Id              int     `json:"id"`
	UserId          int     `json:"user_id" gorm:"index"`
	Amount          int64   `json:"amount"`
	Money           float64 `json:"money"`
	TradeNo         string  `json:"trade_no" gorm:"unique;type:varchar(255);index"`
	PaymentMethod   string  `json:"payment_method" gorm:"type:varchar(50)"`
	PaymentProvider string  `json:"payment_provider" gorm:"type:varchar(50);default:''"`
	ProviderTradeNo string  `json:"provider_trade_no" gorm:"type:varchar(255);index"`
	CreateTime      int64   `json:"create_time"`
	CompleteTime    int64   `json:"complete_time"`
	Status          string  `json:"status"`
}

type PaymentTransaction struct {
	Id              int    `json:"id"`
	PaymentProvider string `json:"payment_provider" gorm:"type:varchar(50);not null;uniqueIndex:idx_payment_provider_trade_no"`
	ProviderTradeNo string `json:"provider_trade_no" gorm:"type:varchar(255);not null;uniqueIndex:idx_payment_provider_trade_no"`
	TradeNo         string `json:"trade_no" gorm:"type:varchar(255);not null;uniqueIndex"`
	CreateTime      int64  `json:"create_time"`
}

// GrantTopUpAffiliateReward 按充值分红倍率给被邀请人的邀请人发放分红:
// 被邀请人单次充值成功所得额度 × common.TopUpAffiliateRatio,分红计入
// 邀请人推荐计划余额(aff_quota)与累计收益(aff_history),不直接进主余额,
// 邀请人可在钱包页「推荐计划」转入主余额。必须在充值成功事务内调用
// (幂等:每个订单只在 pending→success 状态切换时执行一次),返回
// (邀请人ID, 分红额度),调用方应在事务提交后调用 recordTopUpAffiliateLog
// 记录审计日志。分红失败不阻断充值本身,仅记 SysError 审计;倍率为 0、
// 被邀请人无邀请人或分红额度为 0 时返回 (0, 0)。
func GrantTopUpAffiliateReward(tx *gorm.DB, userId int, quotaToAdd int) (int, int) {
	if common.TopUpAffiliateRatio <= 0 {
		return 0, 0
	}
	if tx == nil {
		tx = DB
	}
	var payer User
	if err := tx.Select("inviter_id").First(&payer, "id = ?", userId).Error; err != nil || payer.InviterId <= 0 {
		return 0, 0
	}
	reward, clamp := common.QuotaFromFloatChecked(float64(quotaToAdd) * common.TopUpAffiliateRatio)
	if clamp != nil {
		common.SysError(fmt.Sprintf("grantTopUpAffiliateReward: 分红额度达到上限 user_id=%d inviter_id=%d quota_to_add=%d ratio=%v clamp=%v", userId, payer.InviterId, quotaToAdd, common.TopUpAffiliateRatio, clamp))
	}
	if reward <= 0 {
		return 0, 0
	}
	// 分红计入邀请体系(推荐计划余额与累计收益),不直接进主余额;
	// 邀请人可在钱包页「推荐计划」将 aff_quota 转入主余额。
	result := tx.Model(&User{}).Where("id = ?", payer.InviterId).
		Updates(map[string]any{
			"aff_quota":   gorm.Expr("aff_quota + ?", reward),
			"aff_history": gorm.Expr("aff_history + ?", reward),
		})
	if result.Error != nil || result.RowsAffected != 1 {
		common.SysError(fmt.Sprintf("grantTopUpAffiliateReward: 邀请人分红入账失败 inviter_id=%d error=%v rows_affected=%d", payer.InviterId, result.Error, result.RowsAffected))
		return 0, 0
	}
	return payer.InviterId, reward
}

// recordTopUpAffiliateLog 记录充值分红审计日志(必须在事务提交后调用,
// 避免在事务内持有数据库连接时再次取连接造成死锁)。
func recordTopUpAffiliateLog(inviterId int, userId int, quotaToAdd int, reward int) {
	if inviterId <= 0 || reward <= 0 {
		return
	}
	RecordLog(inviterId, LogTypeTopup, fmt.Sprintf("邀请的用户(ID:%d)充值 %s,按倍率 %v 获得分红 %s", userId, logger.LogQuota(quotaToAdd), common.TopUpAffiliateRatio, logger.LogQuota(reward)))
}

const (
	PaymentMethodStripe       = "stripe"
	PaymentMethodCreem        = "creem"
	PaymentMethodWaffo        = "waffo"
	PaymentMethodWaffoPancake = "waffo_pancake"
	PaymentMethodBalance      = "balance"
	PaymentMethodWeChatPay    = "wxpay"
)

const (
	PaymentProviderEpay         = "epay"
	PaymentProviderStripe       = "stripe"
	PaymentProviderCreem        = "creem"
	PaymentProviderWaffo        = "waffo"
	PaymentProviderWaffoPancake = "waffo_pancake"
	PaymentProviderBalance      = "balance"
	PaymentProviderWeChatPay    = "wechatpay"
)

var (
	ErrPaymentMethodMismatch   = errors.New("payment method mismatch")
	ErrTopUpNotFound           = errors.New("topup not found")
	ErrTopUpStatusInvalid      = errors.New("topup status invalid")
	ErrInvalidTopUpQuota       = errors.New("invalid top-up quota")
	ErrTopUpQuotaLimitExceeded = errors.New("top-up quota limit exceeded")
)

func (topUp *TopUp) Insert() error {
	var err error
	err = DB.Create(topUp).Error
	return err
}

func topUpQuotaMaxCurrent(creditedQuota int) (int, error) {
	if creditedQuota <= 0 || creditedQuota >= common.MaxQuota {
		return 0, ErrInvalidTopUpQuota
	}
	return common.MaxQuota - 1 - creditedQuota, nil
}

// ValidateTopUpQuotaCapacity performs the user-facing pre-payment check. The
// settlement path repeats the same invariant with an atomic conditional
// update, because the wallet balance can change after checkout creation.
func ValidateTopUpQuotaCapacity(userId int, creditedQuota int) error {
	maxCurrentQuota, err := topUpQuotaMaxCurrent(creditedQuota)
	if err != nil {
		return err
	}

	var user User
	if err := DB.Select("quota").Where("id = ?", userId).First(&user).Error; err != nil {
		return err
	}
	if user.Quota > maxCurrentQuota {
		return ErrTopUpQuotaLimitExceeded
	}
	return nil
}

// creditTopUpQuota atomically enforces the int32 wallet ceiling while adding
// quota. Keeping the predicate and increment in one UPDATE prevents two
// concurrent callbacks from both passing a separate read/check.
func creditTopUpQuota(tx *gorm.DB, userId int, creditedQuota int, updates map[string]interface{}) error {
	maxCurrentQuota, err := topUpQuotaMaxCurrent(creditedQuota)
	if err != nil {
		return err
	}

	updateFields := make(map[string]interface{}, len(updates)+1)
	for key, value := range updates {
		updateFields[key] = value
	}
	updateFields["quota"] = gorm.Expr("quota + ?", creditedQuota)

	result := tx.Model(&User{}).
		Where("id = ? AND quota <= ?", userId, maxCurrentQuota).
		Updates(updateFields)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 1 {
		return nil
	}

	var count int64
	if err := tx.Model(&User{}).Where("id = ?", userId).Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		return gorm.ErrRecordNotFound
	}
	return ErrTopUpQuotaLimitExceeded
}

// Resolve the immutable top-up owner before opening the settlement transaction.
// The mutation guard spans its durable credit and synchronous cache update.
func beginTopUpQuotaMutation(tradeNo string) (func(), error) {
	var topUp TopUp
	if err := DB.Select("user_id").Where("trade_no = ?", tradeNo).First(&topUp).Error; err != nil {
		return nil, ErrTopUpNotFound
	}
	return BeginAppPaymentQuotaMutation(topUp.UserId)
}

func (topUp *TopUp) Update() error {
	var err error
	err = DB.Save(topUp).Error
	return err
}

func GetTopUpById(id int) *TopUp {
	var topUp *TopUp
	var err error
	err = DB.Where("id = ?", id).First(&topUp).Error
	if err != nil {
		return nil
	}
	return topUp
}

func GetTopUpByTradeNo(tradeNo string) *TopUp {
	var topUp *TopUp
	var err error
	err = DB.Where("trade_no = ?", tradeNo).First(&topUp).Error
	if err != nil {
		return nil
	}
	return topUp
}

// GetPendingWeChatPayTopUpsForReconcile 返回仍处于待支付状态、创建时间不早于
// minCreateTime 的微信支付订单，供后台对账任务主动查单兜底（回调丢失场景）。
// minCreateTime 限制回看窗口，避免对久远滞留单反复查单；limit 控制单轮批量。
func GetPendingWeChatPayTopUpsForReconcile(minCreateTime int64, limit int) ([]*TopUp, error) {
	if limit <= 0 {
		limit = 100
	}
	var topups []*TopUp
	err := DB.
		Where("payment_provider = ? AND status = ? AND create_time >= ?",
			PaymentProviderWeChatPay, common.TopUpStatusPending, minCreateTime).
		Order("id asc").Limit(limit).Find(&topups).Error
	return topups, err
}

func UpdatePendingTopUpStatus(tradeNo string, expectedPaymentProvider string, targetStatus string) error {
	if tradeNo == "" {
		return errors.New("未提供支付单号")
	}

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	return DB.Transaction(func(tx *gorm.DB) error {
		topUp := &TopUp{}
		if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(topUp).Error; err != nil {
			return ErrTopUpNotFound
		}
		if expectedPaymentProvider != "" && topUp.PaymentProvider != expectedPaymentProvider {
			return ErrPaymentMethodMismatch
		}
		if topUp.Status != common.TopUpStatusPending {
			return ErrTopUpStatusInvalid
		}

		topUp.Status = targetStatus
		return tx.Save(topUp).Error
	})
}

// RechargeEpay 原子完成易支付订单：订单行锁、状态校验、成功更新与用户额度增加
// 在同一个事务内完成，因此同一订单的并发/重复回调（包括多实例部署下）最多充值一次。
// alreadyDone=true 表示订单此前已完成，本次为幂等重复回调。
// 进程内的 LockOrder 只是优化，正确性由本函数的数据库行锁保证。
func RechargeEpay(tradeNo string, actualPaymentMethod string, callerIp string) (alreadyDone bool, err error) {
	if tradeNo == "" {
		return false, errors.New("未提供支付单号")
	}
	finish, err := beginTopUpQuotaMutation(tradeNo)
	if err != nil {
		return false, err
	}
	defer finish()
	quotaWriteAttempted := false
	var quotaOwner int

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	var quotaToAdd int
	topUp := &TopUp{}
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(topUp).Error; err != nil {
			return ErrTopUpNotFound
		}
		if topUp.PaymentProvider != PaymentProviderEpay {
			return ErrPaymentMethodMismatch
		}
		if topUp.Status == common.TopUpStatusSuccess {
			alreadyDone = true
			return nil
		}
		if topUp.Status != common.TopUpStatusPending {
			return ErrTopUpStatusInvalid
		}
		if actualPaymentMethod != "" && topUp.PaymentMethod != actualPaymentMethod {
			topUp.PaymentMethod = actualPaymentMethod
		}
		var quotaErr error
		quotaToAdd, quotaErr = common.QuotaFromDecimalStrict(
			decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
		)
		if quotaErr != nil || quotaToAdd <= 0 {
			return ErrInvalidTopUpQuota
		}
		topUp.CompleteTime = common.GetTimestamp()
		topUp.Status = common.TopUpStatusSuccess
		if err := tx.Save(topUp).Error; err != nil {
			return err
		}
		quotaWriteAttempted = true
		quotaOwner = topUp.UserId
		return creditTopUpQuota(tx, topUp.UserId, quotaToAdd, nil)
	})
	if err != nil && quotaWriteAttempted {
		MarkAppPaymentWalletUnsafe(quotaOwner)
	}
	if err != nil {
		if !errors.Is(err, ErrTopUpNotFound) && !errors.Is(err, ErrPaymentMethodMismatch) && !errors.Is(err, ErrTopUpStatusInvalid) {
			common.SysError("epay topup failed: " + err.Error())
		}
		return false, err
	}
	if alreadyDone {
		return true, nil
	}
	syncCreditUserQuotaCache(topUp.UserId, quotaToAdd, "epay topup")

	common.SysLog(fmt.Sprintf("易支付充值成功 trade_no=%s user_id=%d quota_to_add=%d money=%.2f", topUp.TradeNo, topUp.UserId, quotaToAdd, topUp.Money))
	RecordTopupLog(topUp.UserId, fmt.Sprintf("使用在线充值成功，充值金额: %v，支付金额：%f", logger.LogQuota(quotaToAdd), topUp.Money), callerIp, topUp.PaymentMethod, PaymentProviderEpay)
	return false, nil
}

// RechargeWeChatPay 原子完成微信支付订单:订单行锁、状态校验、支付交易号去重、
// 金额匹配、成功更新与用户额度增加在同一个事务内完成,因此同一订单的并发/重复
// 回调(包括多实例部署下)最多充值一次。额度增加复用 creditTopUpQuota 的
// int32 上限保护,避免并发充值静默溢出。
func RechargeWeChatPay(tradeNo string, paidAmountCents int64, providerTradeNo string, callerIp string) error {
	if tradeNo == "" || providerTradeNo == "" || paidAmountCents <= 0 {
		return errors.New("无效的微信支付回调")
	}
	finish, err := beginTopUpQuotaMutation(tradeNo)
	if err != nil {
		return err
	}
	defer finish()
	quotaWriteAttempted := false
	var quotaOwner int

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	var topUp TopUp
	var quotaToAdd int
	var affInviterID, affReward int
	credited := false
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(&topUp).Error; err != nil {
			return ErrTopUpNotFound
		}
		if topUp.PaymentProvider != PaymentProviderWeChatPay {
			return ErrPaymentMethodMismatch
		}
		if topUp.Status == common.TopUpStatusSuccess {
			if topUp.ProviderTradeNo != providerTradeNo {
				return errors.New("微信支付交易号不匹配")
			}
			return nil
		}
		if topUp.Status != common.TopUpStatusPending && topUp.Status != common.TopUpStatusExpired {
			return ErrTopUpStatusInvalid
		}

		expectedAmountCents := decimal.NewFromFloat(topUp.Money).Mul(decimal.NewFromInt(100)).Round(0).IntPart()
		if expectedAmountCents != paidAmountCents {
			return errors.New("微信支付金额不匹配")
		}

		paymentTransaction := &PaymentTransaction{
			PaymentProvider: PaymentProviderWeChatPay,
			ProviderTradeNo: providerTradeNo,
			TradeNo:         topUp.TradeNo,
			CreateTime:      common.GetTimestamp(),
		}
		if err := tx.Create(paymentTransaction).Error; err != nil {
			return errors.New("微信支付交易号已处理")
		}

		quotaToAdd = common.QuotaFromDecimal(decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit)))
		if quotaToAdd <= 0 {
			return errors.New("无效的充值额度")
		}

		topUp.ProviderTradeNo = providerTradeNo
		topUp.CompleteTime = common.GetTimestamp()
		topUp.Status = common.TopUpStatusSuccess
		if err := tx.Save(&topUp).Error; err != nil {
			return err
		}

		quotaWriteAttempted = true
		quotaOwner = topUp.UserId
		if err := creditTopUpQuota(tx, topUp.UserId, quotaToAdd, nil); err != nil {
			return err
		}
		affInviterID, affReward = GrantTopUpAffiliateReward(tx, topUp.UserId, quotaToAdd)
		credited = true
		return nil
	})
	if err != nil && quotaWriteAttempted {
		MarkAppPaymentWalletUnsafe(quotaOwner)
	}
	if err != nil {
		return err
	}
	if !credited {
		return nil
	}
	syncCreditUserQuotaCache(topUp.UserId, quotaToAdd, "wechatpay topup")
	recordTopUpAffiliateLog(affInviterID, topUp.UserId, quotaToAdd, affReward)

	RecordTopupLog(topUp.UserId, fmt.Sprintf("微信支付充值成功，充值额度: %v，支付金额: %.2f", logger.FormatQuota(quotaToAdd), topUp.Money), callerIp, topUp.PaymentMethod, PaymentMethodWeChatPay)
	return nil
}

func Recharge(referenceId string, customerId string, callerIp string) (err error) {
	if referenceId == "" {
		return errors.New("未提供支付单号")
	}
	finish, err := beginTopUpQuotaMutation(referenceId)
	if err != nil {
		return err
	}
	defer finish()
	quotaWriteAttempted := false
	var quotaOwner int

	var quota int
	var affInviterID, affReward int
	topUp := &TopUp{}

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	err = DB.Transaction(func(tx *gorm.DB) error {
		err := lockForUpdate(tx).Where(refCol+" = ?", referenceId).First(topUp).Error
		if err != nil {
			return errors.New("充值订单不存在")
		}

		if topUp.PaymentProvider != PaymentProviderStripe {
			return ErrPaymentMethodMismatch
		}

		if topUp.Status != common.TopUpStatusPending {
			return errors.New("充值订单状态错误")
		}

		topUp.CompleteTime = common.GetTimestamp()
		topUp.Status = common.TopUpStatusSuccess
		err = tx.Save(topUp).Error
		if err != nil {
			return err
		}

		quota, err = common.QuotaFromDecimalStrict(
			decimal.NewFromFloat(topUp.Money).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
		)
		if err != nil || quota <= 0 {
			return ErrInvalidTopUpQuota
		}
		quotaWriteAttempted = true
		quotaOwner = topUp.UserId
		if err := creditTopUpQuota(tx, topUp.UserId, quota, map[string]interface{}{
			"stripe_customer": customerId,
		}); err != nil {
			return err
		}
		affInviterID, affReward = GrantTopUpAffiliateReward(tx, topUp.UserId, quota)
		return nil
	})
	if err != nil && quotaWriteAttempted {
		MarkAppPaymentWalletUnsafe(quotaOwner)
	}

	if err != nil {
		common.SysError("topup failed: " + err.Error())
		return errors.New("充值失败，请稍后重试")
	}
	syncCreditUserQuotaCache(topUp.UserId, quota, "stripe topup")
	recordTopUpAffiliateLog(affInviterID, topUp.UserId, quota, affReward)

	RecordTopupLog(topUp.UserId, fmt.Sprintf("使用在线充值成功，充值金额: %v，支付金额：%d", logger.FormatQuota(quota), topUp.Amount), callerIp, topUp.PaymentMethod, PaymentMethodStripe)

	return nil
}

// topUpQueryWindowSeconds 限制充值记录查询的时间窗口（秒）。
const topUpQueryWindowSeconds int64 = 30 * 24 * 60 * 60

// topUpQueryCutoff 返回允许查询的最早 create_time（秒级 Unix 时间戳）。
func topUpQueryCutoff() int64 {
	return common.GetTimestamp() - topUpQueryWindowSeconds
}

func GetUserTopUps(userId int, pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	// Start transaction
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	cutoff := topUpQueryCutoff()

	// Get total count within transaction
	err = tx.Model(&TopUp{}).Where("user_id = ? AND create_time >= ?", userId, cutoff).Count(&total).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// Get paginated topups within same transaction
	err = tx.Where("user_id = ? AND create_time >= ?", userId, cutoff).Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// Commit transaction
	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	return topups, total, nil
}

// GetAllTopUps 获取全平台的充值记录（管理员使用，不限制时间窗口）
func GetAllTopUps(pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	if err = tx.Model(&TopUp{}).Count(&total).Error; err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	if err = tx.Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error; err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	return topups, total, nil
}

// searchTopUpCountHardLimit 搜索充值记录时 COUNT 的安全上限，
// 防止对超大表执行无界 COUNT 触发 DoS。
const searchTopUpCountHardLimit = 10000

// SearchUserTopUps 按订单号搜索某用户的充值记录
func SearchUserTopUps(userId int, keyword string, pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	query := tx.Model(&TopUp{}).Where("user_id = ? AND create_time >= ?", userId, topUpQueryCutoff())
	if keyword != "" {
		pattern, perr := sanitizeLikePattern(keyword)
		if perr != nil {
			tx.Rollback()
			return nil, 0, perr
		}
		query = query.Where("trade_no LIKE ? ESCAPE '!'", pattern)
	}

	if err = query.Limit(searchTopUpCountHardLimit).Count(&total).Error; err != nil {
		tx.Rollback()
		common.SysError("failed to count search topups: " + err.Error())
		return nil, 0, errors.New("搜索充值记录失败")
	}

	if err = query.Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error; err != nil {
		tx.Rollback()
		common.SysError("failed to search topups: " + err.Error())
		return nil, 0, errors.New("搜索充值记录失败")
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}
	return topups, total, nil
}

// SearchAllTopUps 按订单号搜索全平台充值记录（管理员使用，不限制时间窗口）
func SearchAllTopUps(keyword string, pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	query := tx.Model(&TopUp{})
	if keyword != "" {
		pattern, perr := sanitizeLikePattern(keyword)
		if perr != nil {
			tx.Rollback()
			return nil, 0, perr
		}
		query = query.Where("trade_no LIKE ? ESCAPE '!'", pattern)
	}

	if err = query.Limit(searchTopUpCountHardLimit).Count(&total).Error; err != nil {
		tx.Rollback()
		common.SysError("failed to count search topups: " + err.Error())
		return nil, 0, errors.New("搜索充值记录失败")
	}

	if err = query.Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error; err != nil {
		tx.Rollback()
		common.SysError("failed to search topups: " + err.Error())
		return nil, 0, errors.New("搜索充值记录失败")
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}
	return topups, total, nil
}

// ManualCompleteTopUp 管理员手动完成订单并给用户充值
func ManualCompleteTopUp(tradeNo string, callerIp string) error {
	if tradeNo == "" {
		return errors.New("未提供订单号")
	}
	finish, err := beginTopUpQuotaMutation(tradeNo)
	if err != nil {
		return err
	}
	defer finish()
	quotaWriteAttempted := false
	var quotaOwner int

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	var userId int
	var quotaToAdd int
	var payMoney float64
	var paymentMethod string
	var affInviterID, affReward int

	err = DB.Transaction(func(tx *gorm.DB) error {
		topUp := &TopUp{}
		// 行级锁，避免并发补单
		if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(topUp).Error; err != nil {
			return errors.New("充值订单不存在")
		}

		// 幂等处理：已成功直接返回
		if topUp.Status == common.TopUpStatusSuccess {
			return nil
		}

		if topUp.Status != common.TopUpStatusPending {
			return errors.New("订单状态不是待支付，无法补单")
		}

		// 计算应充值额度：
		// - Stripe 订单：Money 代表经分组倍率换算后的美元数量，直接 * QuotaPerUnit
		// - 其他订单（如易支付）：Amount 为美元数量，* QuotaPerUnit
		var quotaErr error
		if topUp.PaymentProvider == PaymentProviderStripe {
			quotaToAdd, quotaErr = common.QuotaFromDecimalStrict(
				decimal.NewFromFloat(topUp.Money).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
			)
		} else {
			quotaToAdd, quotaErr = common.QuotaFromDecimalStrict(
				decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
			)
		}
		if quotaErr != nil || quotaToAdd <= 0 {
			return ErrInvalidTopUpQuota
		}

		// 标记完成
		topUp.CompleteTime = common.GetTimestamp()
		topUp.Status = common.TopUpStatusSuccess
		if err := tx.Save(topUp).Error; err != nil {
			return err
		}

		// 增加用户额度（立即写库，保持一致性）
		quotaWriteAttempted = true
		quotaOwner = topUp.UserId
		if err := creditTopUpQuota(tx, topUp.UserId, quotaToAdd, nil); err != nil {
			return err
		}
		affInviterID, affReward = GrantTopUpAffiliateReward(tx, topUp.UserId, quotaToAdd)

		userId = topUp.UserId
		payMoney = topUp.Money
		paymentMethod = topUp.PaymentMethod
		return nil
	})
	if err != nil && quotaWriteAttempted {
		MarkAppPaymentWalletUnsafe(quotaOwner)
	}

	if err != nil {
		return err
	}

	// 事务外记录日志，避免阻塞
	syncCreditUserQuotaCache(userId, quotaToAdd, "manual topup")
	recordTopUpAffiliateLog(affInviterID, userId, quotaToAdd, affReward)
	RecordTopupLog(userId, fmt.Sprintf("管理员补单成功，充值金额: %v，支付金额：%f", logger.FormatQuota(quotaToAdd), payMoney), callerIp, paymentMethod, "admin")
	return nil
}
func RechargeCreem(referenceId string, customerEmail string, customerName string, callerIp string) (err error) {
	if referenceId == "" {
		return errors.New("未提供支付单号")
	}
	finish, err := beginTopUpQuotaMutation(referenceId)
	if err != nil {
		return err
	}
	defer finish()
	quotaWriteAttempted := false
	var quotaOwner int

	var quota int
	var affInviterID, affReward int
	topUp := &TopUp{}

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	err = DB.Transaction(func(tx *gorm.DB) error {
		err := lockForUpdate(tx).Where(refCol+" = ?", referenceId).First(topUp).Error
		if err != nil {
			return errors.New("充值订单不存在")
		}

		if topUp.PaymentProvider != PaymentProviderCreem {
			return ErrPaymentMethodMismatch
		}

		if topUp.Status != common.TopUpStatusPending {
			return errors.New("充值订单状态错误")
		}

		topUp.CompleteTime = common.GetTimestamp()
		topUp.Status = common.TopUpStatusSuccess
		err = tx.Save(topUp).Error
		if err != nil {
			return err
		}

		// Creem 直接使用 Amount 作为充值额度（整数）
		quota, err = common.QuotaFromDecimalStrict(decimal.NewFromInt(topUp.Amount))
		if err != nil || quota <= 0 {
			return ErrInvalidTopUpQuota
		}

		// 构建更新字段，优先使用邮箱，如果邮箱为空则使用用户名
		updateFields := map[string]interface{}{}

		// 如果有客户邮箱，尝试更新用户邮箱（仅当用户邮箱为空时）
		if customerEmail != "" {
			// 先检查用户当前邮箱是否为空
			var user User
			err = tx.Where("id = ?", topUp.UserId).First(&user).Error
			if err != nil {
				return err
			}

			// 如果用户邮箱为空，则更新为支付时使用的邮箱
			if user.Email == "" {
				updateFields["email"] = customerEmail
			}
		}

		quotaWriteAttempted = true
		quotaOwner = topUp.UserId
		if err := creditTopUpQuota(tx, topUp.UserId, quota, updateFields); err != nil {
			return err
		}
		affInviterID, affReward = GrantTopUpAffiliateReward(tx, topUp.UserId, quota)
		return nil
	})
	if err != nil && quotaWriteAttempted {
		MarkAppPaymentWalletUnsafe(quotaOwner)
	}

	if err != nil {
		common.SysError("creem topup failed: " + err.Error())
		return errors.New("充值失败，请稍后重试")
	}
	syncCreditUserQuotaCache(topUp.UserId, quota, "creem topup")
	recordTopUpAffiliateLog(affInviterID, topUp.UserId, quota, affReward)

	RecordTopupLog(topUp.UserId, fmt.Sprintf("使用Creem充值成功，充值额度: %v，支付金额：%.2f", quota, topUp.Money), callerIp, topUp.PaymentMethod, PaymentMethodCreem)

	return nil
}

func RechargeWaffo(tradeNo string, callerIp string) (err error) {
	if tradeNo == "" {
		return errors.New("未提供支付单号")
	}
	finish, err := beginTopUpQuotaMutation(tradeNo)
	if err != nil {
		return err
	}
	defer finish()
	quotaWriteAttempted := false
	var quotaOwner int

	var quotaToAdd int
	var affInviterID, affReward int
	topUp := &TopUp{}

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	err = DB.Transaction(func(tx *gorm.DB) error {
		err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(topUp).Error
		if err != nil {
			return errors.New("充值订单不存在")
		}

		if topUp.PaymentProvider != PaymentProviderWaffo {
			return ErrPaymentMethodMismatch
		}

		if topUp.Status == common.TopUpStatusSuccess {
			return nil // 幂等：已成功直接返回
		}

		if topUp.Status != common.TopUpStatusPending {
			return errors.New("充值订单状态错误")
		}

		quotaToAdd, err = common.QuotaFromDecimalStrict(
			decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
		)
		if err != nil || quotaToAdd <= 0 {
			return ErrInvalidTopUpQuota
		}

		topUp.CompleteTime = common.GetTimestamp()
		topUp.Status = common.TopUpStatusSuccess
		if err := tx.Save(topUp).Error; err != nil {
			return err
		}

		quotaWriteAttempted = true
		quotaOwner = topUp.UserId
		if err := creditTopUpQuota(tx, topUp.UserId, quotaToAdd, nil); err != nil {
			return err
		}
		affInviterID, affReward = GrantTopUpAffiliateReward(tx, topUp.UserId, quotaToAdd)
		return nil
	})
	if err != nil && quotaWriteAttempted {
		MarkAppPaymentWalletUnsafe(quotaOwner)
	}

	if err != nil {
		common.SysError("waffo topup failed: " + err.Error())
		return errors.New("充值失败，请稍后重试")
	}
	syncCreditUserQuotaCache(topUp.UserId, quotaToAdd, "waffo topup")
	recordTopUpAffiliateLog(affInviterID, topUp.UserId, quotaToAdd, affReward)

	if quotaToAdd > 0 {
		RecordTopupLog(topUp.UserId, fmt.Sprintf("Waffo充值成功，充值额度: %v，支付金额: %.2f", logger.FormatQuota(quotaToAdd), topUp.Money), callerIp, topUp.PaymentMethod, PaymentMethodWaffo)
	}

	return nil
}

func RechargeWaffoPancake(tradeNo string) (err error) {
	if tradeNo == "" {
		return errors.New("未提供支付单号")
	}
	finish, err := beginTopUpQuotaMutation(tradeNo)
	if err != nil {
		return err
	}
	defer finish()
	quotaWriteAttempted := false
	var quotaOwner int

	var quotaToAdd int
	var affInviterID, affReward int
	topUp := &TopUp{}

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	err = DB.Transaction(func(tx *gorm.DB) error {
		err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(topUp).Error
		if err != nil {
			return errors.New("充值订单不存在")
		}

		if topUp.PaymentProvider != PaymentProviderWaffoPancake {
			return ErrPaymentMethodMismatch
		}

		if topUp.Status == common.TopUpStatusSuccess {
			return nil
		}

		if topUp.Status != common.TopUpStatusPending {
			return errors.New("充值订单状态错误")
		}

		quotaToAdd, err = common.QuotaFromDecimalStrict(
			decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
		)
		if err != nil || quotaToAdd <= 0 {
			return ErrInvalidTopUpQuota
		}

		topUp.CompleteTime = common.GetTimestamp()
		topUp.Status = common.TopUpStatusSuccess
		if err := tx.Save(topUp).Error; err != nil {
			return err
		}

		quotaWriteAttempted = true
		quotaOwner = topUp.UserId
		if err := creditTopUpQuota(tx, topUp.UserId, quotaToAdd, nil); err != nil {
			return err
		}
		affInviterID, affReward = GrantTopUpAffiliateReward(tx, topUp.UserId, quotaToAdd)
		return nil
	})
	if err != nil && quotaWriteAttempted {
		MarkAppPaymentWalletUnsafe(quotaOwner)
	}

	if err != nil {
		common.SysError("waffo pancake topup failed: " + err.Error())
		return errors.New("充值失败，请稍后重试")
	}
	syncCreditUserQuotaCache(topUp.UserId, quotaToAdd, "waffo pancake topup")
	recordTopUpAffiliateLog(affInviterID, topUp.UserId, quotaToAdd, affReward)

	if quotaToAdd > 0 {
		RecordLog(topUp.UserId, LogTypeTopup, fmt.Sprintf("Waffo Pancake充值成功，充值额度: %v，支付金额: %.2f", logger.FormatQuota(quotaToAdd), topUp.Money))
	}

	return nil
}
