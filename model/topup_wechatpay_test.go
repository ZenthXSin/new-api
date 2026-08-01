package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func insertWeChatPayTopUp(t *testing.T, tradeNo string, userID int, amount int64, money float64) {
	t.Helper()
	topUp := &TopUp{
		UserId:          userID,
		Amount:          amount,
		Money:           money,
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentMethodWeChatPay,
		PaymentProvider: PaymentProviderWeChatPay,
		Status:          common.TopUpStatusPending,
		CreateTime:      time.Now().Unix(),
	}
	require.NoError(t, topUp.Insert())
}

func countPaymentTransactions(t *testing.T) int64 {
	t.Helper()
	var count int64
	require.NoError(t, DB.Model(&PaymentTransaction{}).Count(&count).Error)
	return count
}

func TestRechargeWeChatPay_CreditsQuotaAndCompletesOrder(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 501, 100)
	insertWeChatPayTopUp(t, "wechat-success", 501, 2, 9.99)

	require.NoError(t, RechargeWeChatPay("wechat-success", 999, "wx-transaction-1", "127.0.0.1"))

	topUp := GetTopUpByTradeNo("wechat-success")
	require.NotNil(t, topUp)
	assert.Equal(t, common.TopUpStatusSuccess, topUp.Status)
	assert.Equal(t, "wx-transaction-1", topUp.ProviderTradeNo)
	assert.NotZero(t, topUp.CompleteTime)
	assert.Equal(t, 100+2*int(common.QuotaPerUnit), getUserQuotaForPaymentGuardTest(t, 501))
	assert.EqualValues(t, 1, countPaymentTransactions(t))
}

func TestRechargeWeChatPay_IsIdempotentForSameTransaction(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 502, 0)
	insertWeChatPayTopUp(t, "wechat-idempotent", 502, 3, 12.34)

	require.NoError(t, RechargeWeChatPay("wechat-idempotent", 1234, "wx-transaction-2", "127.0.0.1"))
	require.NoError(t, RechargeWeChatPay("wechat-idempotent", 1234, "wx-transaction-2", "127.0.0.1"))

	assert.Equal(t, 3*int(common.QuotaPerUnit), getUserQuotaForPaymentGuardTest(t, 502))
	assert.EqualValues(t, 1, countPaymentTransactions(t))
}

func TestRechargeWeChatPay_RejectsAmountMismatch(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 503, 0)
	insertWeChatPayTopUp(t, "wechat-amount-mismatch", 503, 2, 9.99)

	err := RechargeWeChatPay("wechat-amount-mismatch", 998, "wx-transaction-3", "127.0.0.1")
	require.Error(t, err)

	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForPaymentGuardTest(t, "wechat-amount-mismatch"))
	assert.Zero(t, getUserQuotaForPaymentGuardTest(t, 503))
	assert.Zero(t, countPaymentTransactions(t))
}

func TestRechargeWeChatPay_RejectsMismatchedProvider(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 504, 0)
	insertTopUpForPaymentGuardTest(t, "wechat-provider-mismatch", 504, PaymentProviderStripe)

	err := RechargeWeChatPay("wechat-provider-mismatch", 999, "wx-transaction-4", "127.0.0.1")
	require.ErrorIs(t, err, ErrPaymentMethodMismatch)

	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForPaymentGuardTest(t, "wechat-provider-mismatch"))
	assert.Zero(t, getUserQuotaForPaymentGuardTest(t, 504))
	assert.Zero(t, countPaymentTransactions(t))
}

func TestRechargeWeChatPay_RejectsDifferentTransactionForCompletedOrder(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 505, 0)
	insertWeChatPayTopUp(t, "wechat-completed", 505, 1, 5.00)
	require.NoError(t, RechargeWeChatPay("wechat-completed", 500, "wx-transaction-5", "127.0.0.1"))

	err := RechargeWeChatPay("wechat-completed", 500, "wx-transaction-other", "127.0.0.1")
	require.Error(t, err)

	assert.Equal(t, int(common.QuotaPerUnit), getUserQuotaForPaymentGuardTest(t, 505))
	assert.EqualValues(t, 1, countPaymentTransactions(t))
}

func TestRechargeWeChatPay_RejectsTransactionUsedByAnotherOrder(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 506, 0)
	insertWeChatPayTopUp(t, "wechat-first", 506, 1, 5.00)
	insertWeChatPayTopUp(t, "wechat-second", 506, 1, 5.00)
	require.NoError(t, RechargeWeChatPay("wechat-first", 500, "wx-transaction-6", "127.0.0.1"))

	err := RechargeWeChatPay("wechat-second", 500, "wx-transaction-6", "127.0.0.1")
	require.Error(t, err)

	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForPaymentGuardTest(t, "wechat-second"))
	assert.Equal(t, int(common.QuotaPerUnit), getUserQuotaForPaymentGuardTest(t, 506))
	assert.EqualValues(t, 1, countPaymentTransactions(t))
}

func TestRechargeWeChatPay_AcceptsConfirmedPaymentAfterLocalExpiry(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 507, 0)
	insertWeChatPayTopUp(t, "wechat-expired", 507, 1, 5.00)
	require.NoError(t, UpdatePendingTopUpStatus("wechat-expired", PaymentProviderWeChatPay, common.TopUpStatusExpired))

	require.NoError(t, RechargeWeChatPay("wechat-expired", 500, "wx-transaction-8", "127.0.0.1"))

	assert.Equal(t, common.TopUpStatusSuccess, getTopUpStatusForPaymentGuardTest(t, "wechat-expired"))
	assert.Equal(t, int(common.QuotaPerUnit), getUserQuotaForPaymentGuardTest(t, 507))
	assert.EqualValues(t, 1, countPaymentTransactions(t))
}

func TestRechargeWeChatPay_RollsBackWhenUserDoesNotExist(t *testing.T) {
	truncateTables(t)
	insertWeChatPayTopUp(t, "wechat-missing-user", 9999, 1, 5.00)

	err := RechargeWeChatPay("wechat-missing-user", 500, "wx-transaction-7", "127.0.0.1")
	require.Error(t, err)

	topUp := GetTopUpByTradeNo("wechat-missing-user")
	require.NotNil(t, topUp)
	assert.Equal(t, common.TopUpStatusPending, topUp.Status)
	assert.Empty(t, topUp.ProviderTradeNo)
	assert.Zero(t, topUp.CompleteTime)
	assert.Zero(t, countPaymentTransactions(t))
}
