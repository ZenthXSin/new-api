package service

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"math"
	"strings"
	"testing"
	"time"
)

func TestAppPaymentQuoteRejectsOverflowAndRoundsFullCharge(t *testing.T) {
	oldQuota, oldRate := common.QuotaPerUnit, operation_setting.USDExchangeRate
	t.Cleanup(func() { common.QuotaPerUnit = oldQuota; operation_setting.USDExchangeRate = oldRate })
	common.QuotaPerUnit = 500000
	operation_setting.USDExchangeRate = 7
	quote, err := QuoteAppPaymentBalance(&model.PaymentOrder{Amount: 1, Currency: "CNY"})
	require.NoError(t, err)
	assert.Equal(t, 715, quote.Quota)
	assert.Equal(t, "7", quote.ExchangeRate)
	operation_setting.USDExchangeRate = 0.3333333333333333
	quote, err = QuoteAppPaymentBalance(&model.PaymentOrder{Amount: 1, Currency: "CNY"})
	require.NoError(t, err)
	assert.Equal(t, 15001, quote.Quota, "preserve positive division remainder even below 16 decimal places")

	for _, amount := range []int64{0, -1, 100000001, 100000000} {
		_, err = QuoteAppPaymentBalance(&model.PaymentOrder{Amount: amount, Currency: "USD"})
		assert.Error(t, err)
	}
	for _, rate := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		operation_setting.USDExchangeRate = rate
		_, err = QuoteAppPaymentBalance(&model.PaymentOrder{Amount: 1, Currency: "CNY"})
		assert.Error(t, err)
	}
	common.QuotaPerUnit = math.Inf(1)
	_, err = QuoteAppPaymentBalance(&model.PaymentOrder{Amount: 1, Currency: "USD"})
	assert.Error(t, err)
}
func TestAppPaymentNonceBindsSessionTokenQuoteAndExpires(t *testing.T) {
	old := common.SessionSecret
	common.SessionSecret = "isolated-payment-nonce-secret"
	t.Cleanup(func() { common.SessionSecret = old })
	now := time.Now()
	order := &model.PaymentOrder{ID: "order", ClientID: "client", Amount: 100, Currency: "USD", ExpiresAt: now.Add(3 * time.Minute).Unix()}
	identity := AuthIdentity{UserID: 1, SessionID: "session", UserAuthVersion: 1, SessionVersion: 2}
	hash := strings.Repeat("a", 64)
	quote := AppPaymentQuote{Quota: 500000, ExchangeRate: "1"}
	nonce, expires, err := IssueAppPaymentConfirmation(order, identity, quote, hash, now)
	require.NoError(t, err)
	assert.Equal(t, order.ExpiresAt, expires)
	got, err := VerifyAppPaymentConfirmation(nonce, order, identity, hash, now)
	require.NoError(t, err)
	assert.Equal(t, quote, got)
	for _, field := range []string{"order", "client", "amount", "currency", "user", "session", "auth_version", "session_version", "token", "expired", "tamper"} {
		t.Run(field, func(t *testing.T) {
			o := *order
			i := identity
			h, n, at := hash, nonce, now
			switch field {
			case "order":
				o.ID = "another"
			case "client":
				o.ClientID = "another"
			case "amount":
				o.Amount++
			case "currency":
				o.Currency = "CNY"
			case "user":
				i.UserID++
			case "session":
				i.SessionID = "new"
			case "auth_version":
				i.UserAuthVersion++
			case "session_version":
				i.SessionVersion++
			case "token":
				h = strings.Repeat("b", 64)
			case "expired":
				at = now.Add(3 * time.Minute)
			case "tamper":
				n = "x" + n
			}
			_, e := VerifyAppPaymentConfirmation(n, &o, i, h, at)
			assert.ErrorIs(t, e, ErrAppPaymentConfirmation)
		})
	}
}
