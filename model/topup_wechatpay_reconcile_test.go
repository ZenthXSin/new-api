package model

import (
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetPendingWeChatPayTopUpsForReconcile(t *testing.T) {
	truncateTables(t)

	now := common.GetTimestamp()
	insertTopUpWithProviderAndStatusForReconcileTest(t, "rc-wx-pending", 701, PaymentProviderWeChatPay, common.TopUpStatusPending, now-3600)
	insertTopUpWithProviderAndStatusForReconcileTest(t, "rc-wx-old", 701, PaymentProviderWeChatPay, common.TopUpStatusPending, now-25*3600)
	insertTopUpWithProviderAndStatusForReconcileTest(t, "rc-wx-success", 701, PaymentProviderWeChatPay, common.TopUpStatusSuccess, now-3600)
	insertTopUpWithProviderAndStatusForReconcileTest(t, "rc-wx-expired", 701, PaymentProviderWeChatPay, common.TopUpStatusExpired, now-3600)
	insertTopUpWithProviderAndStatusForReconcileTest(t, "rc-epay-pending", 701, PaymentProviderEpay, common.TopUpStatusPending, now-3600)

	topups, err := GetPendingWeChatPayTopUpsForReconcile(now-24*3600, 100)
	require.NoError(t, err)
	require.Len(t, topups, 1)
	assert.Equal(t, "rc-wx-pending", topups[0].TradeNo, "只返回窗口内、pending 状态的微信订单")

	topups, err = GetPendingWeChatPayTopUpsForReconcile(now-60, 100)
	require.NoError(t, err)
	assert.Empty(t, topups, "窗口之外的订单不返回")

	for i := 0; i < 3; i++ {
		insertTopUpWithProviderAndStatusForReconcileTest(t, "rc-wx-batch-"+fmt.Sprint(i), 701+i, PaymentProviderWeChatPay, common.TopUpStatusPending, now-3600)
	}
	topups, err = GetPendingWeChatPayTopUpsForReconcile(now-24*3600, 2)
	require.NoError(t, err)
	assert.Len(t, topups, 2, "limit 生效")
}

func insertTopUpWithProviderAndStatusForReconcileTest(t *testing.T, tradeNo string, userID int, provider string, status string, createTime int64) {
	t.Helper()
	topUp := &TopUp{
		UserId:          userID,
		Amount:          1,
		Money:           5.00,
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentMethodWeChatPay,
		PaymentProvider: provider,
		CreateTime:      createTime,
		Status:          status,
	}
	require.NoError(t, DB.Create(topUp).Error)
}
