package controller

import (
	"regexp"
	"testing"

	"github.com/QuantumNous/new-api/setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
)

func TestValidateWeChatPayTransaction(t *testing.T) {
	previousAppID := setting.WeChatPayAppID
	previousMerchantID := setting.WeChatPayMerchantID
	t.Cleanup(func() {
		setting.WeChatPayAppID = previousAppID
		setting.WeChatPayMerchantID = previousMerchantID
	})
	setting.WeChatPayAppID = "app-id"
	setting.WeChatPayMerchantID = "merchant-id"

	stringPointer := func(value string) *string { return &value }
	int64Pointer := func(value int64) *int64 { return &value }
	validTransaction := func() *payments.Transaction {
		return &payments.Transaction{
			Appid:         stringPointer("app-id"),
			Mchid:         stringPointer("merchant-id"),
			OutTradeNo:    stringPointer("WXorder"),
			TradeType:     stringPointer("NATIVE"),
			TradeState:    stringPointer("SUCCESS"),
			TransactionId: stringPointer("wx-transaction"),
			Amount: &payments.TransactionAmount{
				Total:    int64Pointer(500),
				Currency: stringPointer("CNY"),
			},
		}
	}

	testCases := []struct {
		name   string
		mutate func(*payments.Transaction)
	}{
		{name: "valid", mutate: func(*payments.Transaction) {}},
		{name: "wrong app ID", mutate: func(transaction *payments.Transaction) { transaction.Appid = stringPointer("other") }},
		{name: "wrong merchant ID", mutate: func(transaction *payments.Transaction) { transaction.Mchid = stringPointer("other") }},
		{name: "wrong order number", mutate: func(transaction *payments.Transaction) { transaction.OutTradeNo = stringPointer("other") }},
		{name: "wrong trade type", mutate: func(transaction *payments.Transaction) { transaction.TradeType = stringPointer("JSAPI") }},
		{name: "not successful", mutate: func(transaction *payments.Transaction) { transaction.TradeState = stringPointer("NOTPAY") }},
		{name: "wrong currency", mutate: func(transaction *payments.Transaction) { transaction.Amount.Currency = stringPointer("USD") }},
		{name: "missing amount", mutate: func(transaction *payments.Transaction) { transaction.Amount = nil }},
		{name: "missing transaction ID", mutate: func(transaction *payments.Transaction) { transaction.TransactionId = nil }},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			transaction := validTransaction()
			testCase.mutate(transaction)
			err := validateWeChatPayTransaction(transaction, "WXorder")
			if testCase.name == "valid" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
		})
	}
}

func TestNewWeChatPayTradeNo(t *testing.T) {
	tradeNos := make(map[string]struct{}, 100)
	validTradeNo := regexp.MustCompile(`^[A-Za-z0-9]+$`)

	for range 100 {
		tradeNo := newWeChatPayTradeNo()
		require.LessOrEqual(t, len(tradeNo), 32)
		assert.True(t, validTradeNo.MatchString(tradeNo))
		_, exists := tradeNos[tradeNo]
		assert.False(t, exists)
		tradeNos[tradeNo] = struct{}{}
	}
}
