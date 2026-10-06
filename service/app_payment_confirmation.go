package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/shopspring/decimal"
)

var ErrAppPaymentConfirmation = errors.New("payment confirmation is invalid or expired")

type AppPaymentQuote struct {
	Quota        int    `json:"quota"`
	ExchangeRate string `json:"exchange_rate"`
}

type appPaymentConfirmation struct {
	OrderID        string          `json:"order"`
	ClientID       string          `json:"client"`
	UserID         int             `json:"user"`
	SessionID      string          `json:"sid"`
	TokenHash      string          `json:"token"`
	AuthVersion    int64           `json:"uv"`
	SessionVersion int64           `json:"sv"`
	Amount         int64           `json:"amount"`
	Currency       string          `json:"currency"`
	ExpiresAt      int64           `json:"exp"`
	Quote          AppPaymentQuote `json:"quote"`
}

func QuoteAppPaymentBalance(order *model.PaymentOrder) (AppPaymentQuote, error) {
	if order == nil || order.Amount <= 0 || order.Amount > model.AppPaymentMaxAmount || math.IsNaN(common.QuotaPerUnit) || math.IsInf(common.QuotaPerUnit, 0) || common.QuotaPerUnit <= 0 {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	rate := decimal.NewFromInt(1)
	if order.Currency == "CNY" {
		if math.IsNaN(operation_setting.USDExchangeRate) || math.IsInf(operation_setting.USDExchangeRate, 0) || operation_setting.USDExchangeRate <= 0 {
			return AppPaymentQuote{}, ErrAppPaymentConfirmation
		}
		rate = decimal.NewFromFloat(operation_setting.USDExchangeRate)
	} else if order.Currency != "USD" {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	// QuoRem performs exact decimal division; a fixed-precision intermediate
	// could round a tiny positive remainder down and undercharge by one quota.
	numerator := decimal.NewFromInt(order.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit))
	quota, remainder := numerator.QuoRem(decimal.NewFromInt(100).Mul(rate), 0)
	if remainder.IsPositive() {
		quota = quota.Add(decimal.NewFromInt(1))
	}
	// This release stores per-operation quota in int32 SQL fields. Reject the
	// order instead of saturating or silently charging less than its full price.
	if quota.LessThanOrEqual(decimal.Zero) || quota.GreaterThanOrEqual(decimal.NewFromInt(math.MaxInt32)) {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	return AppPaymentQuote{Quota: common.QuotaFromDecimal(quota), ExchangeRate: rate.String()}, nil
}

func appPaymentConfirmationMAC(payload string) []byte {
	mac := hmac.New(sha256.New, []byte(common.SessionSecret))
	_, _ = mac.Write([]byte("new-api/app-payment-confirm/v1\x00" + payload))
	return mac.Sum(nil)
}

func IssueAppPaymentConfirmation(order *model.PaymentOrder, identity AuthIdentity, quote AppPaymentQuote, tokenHash string, now time.Time) (string, int64, error) {
	if len(tokenHash) != 64 || order == nil || identity.UserID <= 0 || identity.SessionID == "" || identity.UserAuthVersion <= 0 || identity.SessionVersion <= 0 || order.ExpiresAt <= now.Unix() {
		return "", 0, ErrAppPaymentConfirmation
	}
	expires := min(order.ExpiresAt, now.Add(5*time.Minute).Unix())
	claims := appPaymentConfirmation{OrderID: order.ID, ClientID: order.ClientID, UserID: identity.UserID, SessionID: identity.SessionID, TokenHash: tokenHash, AuthVersion: identity.UserAuthVersion, SessionVersion: identity.SessionVersion, Amount: order.Amount, Currency: order.Currency, ExpiresAt: expires, Quote: quote}
	encoded, err := common.Marshal(claims)
	if err != nil {
		return "", 0, err
	}
	payload := base64.RawURLEncoding.EncodeToString(encoded)
	return payload + "." + base64.RawURLEncoding.EncodeToString(appPaymentConfirmationMAC(payload)), expires, nil
}

func VerifyAppPaymentConfirmation(raw string, order *model.PaymentOrder, identity AuthIdentity, tokenHash string, now time.Time) (AppPaymentQuote, error) {
	if len(tokenHash) != 64 || len(raw) > 4096 || order == nil {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || subtle.ConstantTimeCompare(signature, appPaymentConfirmationMAC(parts[0])) != 1 {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	var claims appPaymentConfirmation
	if common.Unmarshal(payload, &claims) != nil || claims.OrderID != order.ID || claims.ClientID != order.ClientID || claims.UserID != identity.UserID || claims.SessionID != identity.SessionID || claims.TokenHash != tokenHash || claims.AuthVersion != identity.UserAuthVersion || claims.SessionVersion != identity.SessionVersion || claims.Amount != order.Amount || claims.Currency != order.Currency || claims.ExpiresAt <= now.Unix() || claims.ExpiresAt > order.ExpiresAt {
		return AppPaymentQuote{}, ErrAppPaymentConfirmation
	}
	return claims.Quote, nil
}
