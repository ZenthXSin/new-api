package controller

import (
	"context"
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
	"gorm.io/gorm"
)

// wechatPayReconcileQuerier 的测试替身
type fakeWeChatPayReconcileQuerier struct {
	txns  map[string]*payments.Transaction
	errs  map[string]error
	calls int
}

func (f *fakeWeChatPayReconcileQuerier) QueryOrderByOutTradeNo(ctx context.Context, outTradeNo string) (*payments.Transaction, error) {
	f.calls++
	if err, ok := f.errs[outTradeNo]; ok {
		return nil, err
	}
	txn, ok := f.txns[outTradeNo]
	if !ok {
		return nil, assert.AnError
	}
	return txn, nil
}

func strPtr(s string) *string { return &s }

func int64Ptr(v int64) *int64 { return &v }

// weChatPaySuccessTxnForTest 构造一个能通过 validateWeChatPayTransaction 的 SUCCESS 交易
func weChatPaySuccessTxnForTest(tradeNo string, totalCents int64) *payments.Transaction {
	appid := setting.WeChatPayAppID
	mchid := setting.WeChatPayMerchantID
	currency := "CNY"
	tradeType := "NATIVE"
	return &payments.Transaction{
		Appid:         strPtr(appid),
		Mchid:         strPtr(mchid),
		TradeState:    strPtr("SUCCESS"),
		TradeType:     strPtr(tradeType),
		OutTradeNo:    strPtr(tradeNo),
		TransactionId: strPtr("wx-txn-" + tradeNo),
		Amount: &payments.TransactionAmount{
			Total:    int64Ptr(totalCents),
			Currency: strPtr(currency),
		},
	}
}

func setupWeChatPayReconcileTestDB(t *testing.T) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.TopUp{}, &model.PaymentTransaction{}, &model.Log{}))
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)

	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldRedisEnabled := common.RedisEnabled
	model.DB, model.LOG_DB = db, db
	common.RedisEnabled = false
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.RedisEnabled = oldRedisEnabled
		_ = sqlDB.Close()
	})

	require.NoError(t, model.DB.Create(&model.User{
		Id:       71,
		Username: "wx_reconcile_user",
		Quota:    0,
		Status:   common.UserStatusEnabled,
	}).Error)
}

func insertPendingWeChatPayOrderForTest(t *testing.T, tradeNo string, createTime int64, money float64) {
	t.Helper()
	topUp := &model.TopUp{
		UserId:          71,
		Amount:          1,
		Money:           money,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodWeChatPay,
		PaymentProvider: model.PaymentProviderWeChatPay,
		CreateTime:      createTime,
		Status:          common.TopUpStatusPending,
	}
	require.NoError(t, model.DB.Create(topUp).Error)
}

func setWeChatPaySettingForTest(t *testing.T) {
	t.Helper()
	oldAppID, oldMchID, oldExpire := setting.WeChatPayAppID, setting.WeChatPayMerchantID, setting.WeChatPayOrderExpireMinutes
	setting.WeChatPayAppID = "wx-test-app"
	setting.WeChatPayMerchantID = "1900000000"
	setting.WeChatPayOrderExpireMinutes = 15
	t.Cleanup(func() {
		setting.WeChatPayAppID, setting.WeChatPayMerchantID, setting.WeChatPayOrderExpireMinutes = oldAppID, oldMchID, oldExpire
	})
}

func getTopUpStatusForReconcileTest(t *testing.T, tradeNo string) string {
	t.Helper()
	topUp := model.GetTopUpByTradeNo(tradeNo)
	require.NotNil(t, topUp)
	return topUp.Status
}

func TestReconcileWeChatPayOrders_CreditsPaidOrder(t *testing.T) {
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-credit", common.GetTimestamp()-60, 5.00)

	querier := &fakeWeChatPayReconcileQuerier{
		txns: map[string]*payments.Transaction{
			"rc-credit": weChatPaySuccessTxnForTest("rc-credit", 500),
		},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 1, summary.Checked)
	assert.Equal(t, 1, summary.Credited)
	assert.Equal(t, 0, summary.QueryErrors)
	assert.Equal(t, common.TopUpStatusSuccess, getTopUpStatusForReconcileTest(t, "rc-credit"))
	assert.Equal(t, int(common.QuotaPerUnit), getUserQuotaForReconcileTest(t, 71))
}

func TestReconcileWeChatPayOrders_LeavesUnpaidOrderWithinValidity(t *testing.T) {
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-notpay", common.GetTimestamp()-60, 5.00)

	querier := &fakeWeChatPayReconcileQuerier{
		txns: map[string]*payments.Transaction{
			"rc-notpay": {TradeState: strPtr("NOTPAY"), OutTradeNo: strPtr("rc-notpay")},
		},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 1, summary.StillPending)
	assert.Equal(t, 0, summary.Expired)
	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForReconcileTest(t, "rc-notpay"))
}

func TestReconcileWeChatPayOrders_KeepsUnpaidOrderBeforeLocalExpiry(t *testing.T) {
	// CLOSED 但尚未超过本地有效期（管理员可能提前关单）：不关单，继续等
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-closed-early", common.GetTimestamp()-60, 5.00)

	querier := &fakeWeChatPayReconcileQuerier{
		txns: map[string]*payments.Transaction{
			"rc-closed-early": {TradeState: strPtr("CLOSED"), OutTradeNo: strPtr("rc-closed-early")},
		},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 1, summary.StillPending)
	assert.Equal(t, 0, summary.Expired)
	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForReconcileTest(t, "rc-closed-early"))
}

func TestReconcileWeChatPayOrders_ExpiresConfirmedUnpaidOrderAfterValidity(t *testing.T) {
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-expire", common.GetTimestamp()-2*3600, 5.00)

	querier := &fakeWeChatPayReconcileQuerier{
		txns: map[string]*payments.Transaction{
			"rc-expire": {TradeState: strPtr("NOTPAY"), OutTradeNo: strPtr("rc-expire")},
		},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 1, summary.Expired)
	assert.Equal(t, common.TopUpStatusExpired, getTopUpStatusForReconcileTest(t, "rc-expire"))
	assert.Zero(t, getUserQuotaForReconcileTest(t, 71))
}

func TestReconcileWeChatPayOrders_KeepsRefundedOrderForAdmin(t *testing.T) {
	// 过期后查到 REFUND：状态非 SUCCESS/CLOSED 系，留给人工处理
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-refund", common.GetTimestamp()-2*3600, 5.00)

	querier := &fakeWeChatPayReconcileQuerier{
		txns: map[string]*payments.Transaction{
			"rc-refund": {TradeState: strPtr("REFUND"), OutTradeNo: strPtr("rc-refund")},
		},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 1, summary.StillPending)
	assert.Equal(t, 0, summary.Expired)
	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForReconcileTest(t, "rc-refund"))
}

func TestReconcileWeChatPayOrders_ToleratesQueryErrors(t *testing.T) {
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-qerr", common.GetTimestamp()-60, 5.00)
	insertPendingWeChatPayOrderForTest(t, "rc-ok", common.GetTimestamp()-60, 5.00)

	querier := &fakeWeChatPayReconcileQuerier{
		errs: map[string]error{
			"rc-qerr": assert.AnError,
		},
		txns: map[string]*payments.Transaction{
			"rc-ok": weChatPaySuccessTxnForTest("rc-ok", 500),
		},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 2, summary.Checked)
	assert.Equal(t, 1, summary.QueryErrors)
	assert.Equal(t, 1, summary.Credited)
	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForReconcileTest(t, "rc-qerr"))
	assert.Equal(t, common.TopUpStatusSuccess, getTopUpStatusForReconcileTest(t, "rc-ok"))
}

func TestReconcileWeChatPayOrders_LeavesInvalidTransactionPending(t *testing.T) {
	// SUCCESS 但 appid 不匹配（如配置漂移）：不入账、不关单，留给人工
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-invalid", common.GetTimestamp()-60, 5.00)

	txn := weChatPaySuccessTxnForTest("rc-invalid", 500)
	*txn.Appid = "wx-other-app"
	querier := &fakeWeChatPayReconcileQuerier{
		txns: map[string]*payments.Transaction{"rc-invalid": txn},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 1, summary.Invalid)
	assert.Equal(t, 0, summary.Credited)
	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForReconcileTest(t, "rc-invalid"))
	assert.Zero(t, getUserQuotaForReconcileTest(t, 71))
}

func TestReconcileWeChatPayOrders_CreditAmountMismatchKeepsPending(t *testing.T) {
	// SUCCESS 但实付金额与订单不符：入账被拒，订单保持 pending 等人工
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	insertPendingWeChatPayOrderForTest(t, "rc-mismatch", common.GetTimestamp()-60, 5.00)

	querier := &fakeWeChatPayReconcileQuerier{
		txns: map[string]*payments.Transaction{
			"rc-mismatch": weChatPaySuccessTxnForTest("rc-mismatch", 999),
		},
	}
	summary := reconcilePendingWeChatPayOrders(context.Background(), querier)

	assert.Equal(t, 1, summary.CreditErrors)
	assert.Equal(t, 0, summary.Credited)
	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForReconcileTest(t, "rc-mismatch"))
	assert.Zero(t, getUserQuotaForReconcileTest(t, 71))
}

func TestReconcileWeChatPayOrders_HonorsContextCancellation(t *testing.T) {
	setWeChatPaySettingForTest(t)
	setupWeChatPayReconcileTestDB(t)
	for i := 0; i < 5; i++ {
		insertPendingWeChatPayOrderForTest(t, fmt.Sprintf("rc-ctx-%d", i), common.GetTimestamp()-60, 5.00)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	querier := &fakeWeChatPayReconcileQuerier{}
	summary := reconcilePendingWeChatPayOrders(ctx, querier)

	assert.Zero(t, querier.calls)
	assert.Zero(t, summary.Checked)
}

func getUserQuotaForReconcileTest(t *testing.T, userId int) int {
	t.Helper()
	var user model.User
	require.NoError(t, model.DB.Select("quota").First(&user, "id = ?", userId).Error)
	return user.Quota
}
