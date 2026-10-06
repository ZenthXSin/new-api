package service

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stripe/stripe-go/v81"
)

var ErrAppPaymentProviderUnsupported = errors.New("payment provider operation not supported")
var ErrAppPaymentProviderMismatch = errors.New("payment provider transaction does not match order")

type AppPaymentMethod struct {
	ID              string `json:"id"`
	Label           string `json:"label"`
	Currency        string `json:"currency"`
	RefundSupported bool   `json:"refund_supported"`
}

type AppPaymentCheckout struct {
	Method      string `json:"method"`
	Provider    string `json:"provider"`
	CheckoutURL string `json:"checkout_url,omitempty"`
	CodeURL     string `json:"code_url,omitempty"`
	ProviderID  string `json:"provider_id,omitempty"`
}

type AppPaymentProviderResult struct {
	Status          string
	ProviderTradeNo string
	Amount          int64
	Currency        string
}

type AppPaymentRefundResult struct {
	Status           string
	ProviderRefundNo string
}

// The transport is private so requests cannot choose a payment endpoint or
// credential. Tests replace only this transport with a local provider fixture.
var appPaymentHTTPClient = &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func AppPaymentMethods(currency string) []AppPaymentMethod {
	methods := []AppPaymentMethod{}
	if !operation_setting.IsPaymentComplianceConfirmed() {
		return methods
	}
	if (currency == "CNY" || currency == "USD" || currency == "") && strings.TrimSpace(setting.StripeApiSecret) != "" && strings.TrimSpace(setting.StripeWebhookSecret) != "" {
		methods = append(methods, AppPaymentMethod{ID: "stripe", Label: "Stripe", Currency: currency, RefundSupported: true})
	}
	if currency != "CNY" && currency != "" {
		return methods
	}
	if appPaymentWeChatConfigured() {
		methods = append(methods, AppPaymentMethod{ID: "wechatpay", Label: "WeChat Pay", Currency: "CNY", RefundSupported: true})
	}
	if appPaymentEpayConfigured() {
		for _, method := range operation_setting.PayMethods {
			if method["type"] != "" {
				methods = append(methods, AppPaymentMethod{ID: "epay_" + method["type"], Label: method["name"], Currency: "CNY"})
			}
		}
	}
	return methods
}

func SupportsAppPaymentRefund(method string) bool {
	return method == "balance" || method == "stripe" || method == "wechatpay"
}

func appPaymentWeChatConfigured() bool {
	u, err := url.Parse(setting.WeChatPayNotifyURL)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == constant.WeChatPayWebhookPath && u.RawQuery == "" && u.Fragment == "" && setting.WeChatPayEnabled && setting.WeChatPayAppID != "" && setting.WeChatPayMerchantID != "" && setting.WeChatPayMerchantSerialNumber != "" && setting.WeChatPayPrivateKey != "" && len(setting.WeChatPayAPIV3Key) == 32 && setting.WeChatPayPlatformCertificate != "" && setting.WeChatPayPlatformCertificateSerialNumber != ""
}

func appPaymentEpayConfigured() bool {
	u, err := url.Parse(operation_setting.PayAddress)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && operation_setting.EpayId != "" && operation_setting.EpayKey != ""
}

var appPaymentStripeAccounts sync.Map

func appPaymentMerchant(ctx context.Context, provider string) (string, error) {
	switch provider {
	case "stripe":
		key := setting.StripeApiSecret
		if id, ok := appPaymentStripeAccounts.Load(key); ok {
			return id.(string), nil
		}
		var result stripe.Account
		params := &stripe.AccountParams{}
		params.Context = ctx
		err := stripe.NewBackends(appPaymentHTTPClient).API.Call(http.MethodGet, "/v1/account", key, params, &result)
		if err != nil {
			return "", err
		}
		if result.ID == "" {
			return "", ErrAppPaymentProviderMismatch
		}
		appPaymentStripeAccounts.Store(key, result.ID)
		return result.ID, nil
	case "wechatpay":
		return setting.WeChatPayAppID + ":" + setting.WeChatPayMerchantID, nil
	case "epay":
		return strings.TrimRight(operation_setting.PayAddress, "/") + ":" + operation_setting.EpayId, nil
	}
	return "", ErrAppPaymentProviderUnsupported
}

func ValidateAppPaymentMerchant(ctx context.Context, order *model.PaymentOrder) error {
	if !validAppPaymentOrder(order) || order.ProviderMerchantID == "" {
		return ErrAppPaymentProviderMismatch
	}
	merchant, err := appPaymentMerchant(ctx, order.Provider)
	if err != nil {
		return err
	}
	if order.ProviderMerchantID != merchant {
		return ErrAppPaymentProviderMismatch
	}
	return nil
}

func validAppPaymentOrder(order *model.PaymentOrder) bool {
	return order != nil && order.ID != "" && order.ClientID != "" && order.Amount > 0 && order.Amount <= model.AppPaymentMaxAmount && (order.Currency == "USD" || order.Currency == "CNY")
}

func CreateAppPaymentCheckout(ctx context.Context, order *model.PaymentOrder, method string) (*AppPaymentCheckout, error) {
	if !validAppPaymentOrder(order) || order.PaymentMethod != method || order.ExpiresAt <= time.Now().Unix() {
		return nil, ErrAppPaymentProviderMismatch
	}
	enabled := false
	for _, item := range AppPaymentMethods(order.Currency) {
		enabled = enabled || item.ID == method
	}
	if !enabled || method == "balance" {
		return nil, ErrAppPaymentProviderUnsupported
	}
	provider := method
	if strings.HasPrefix(method, "epay_") {
		provider = "epay"
	}
	if order.Provider != provider {
		return nil, ErrAppPaymentProviderMismatch
	}
	merchant, err := appPaymentMerchant(ctx, provider)
	if err != nil {
		return nil, err
	}
	if order.ProviderMerchantID != "" && order.ProviderMerchantID != merchant {
		return nil, ErrAppPaymentProviderMismatch
	}
	if err := model.SetAppPaymentProviderMerchant(order.ID, provider, merchant); err != nil {
		return nil, err
	}
	order.ProviderMerchantID = merchant
	if order.PaymentData != "" {
		var checkout AppPaymentCheckout
		if common.UnmarshalJsonStr(order.PaymentData, &checkout) != nil || checkout.Method != method || checkout.Provider != provider {
			return nil, ErrAppPaymentProviderMismatch
		}
		return &checkout, nil
	}
	var checkout *AppPaymentCheckout
	switch provider {
	case "stripe":
		prepared, prepareErr := model.PrepareAppPaymentCheckoutExpiry(order.ID, provider, time.Now().Add(31*time.Minute).Unix())
		if prepareErr != nil {
			return nil, prepareErr
		}
		order.ProviderExpiresAt, order.ExpiresAt = prepared.ProviderExpiresAt, prepared.ExpiresAt
		checkout, err = createStripeAppPayment(ctx, order)
	case "wechatpay":
		checkout, err = createWeChatAppPayment(ctx, order)
	case "epay":
		checkout, err = createEpayAppPayment(order)
	default:
		return nil, ErrAppPaymentProviderUnsupported
	}
	if err != nil {
		return nil, err
	}
	data, err := common.Marshal(checkout)
	if err != nil {
		return nil, err
	}
	if err = model.SaveAppPaymentProviderData(order.ID, provider, string(data)); err != nil {
		return nil, err
	}
	order.PaymentData = string(data)
	return checkout, nil
}

func QueryAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentProviderResult, error) {
	if err := ValidateAppPaymentMerchant(ctx, order); err != nil {
		return nil, err
	}
	switch order.Provider {
	case "stripe":
		return queryStripeAppPayment(ctx, order)
	case "wechatpay":
		return queryWeChatAppPayment(ctx, order)
	default:
		return nil, ErrAppPaymentProviderUnsupported
	}
}

func RefundAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentRefundResult, error) {
	if !validAppPaymentOrder(order) || order.RefundID == "" || order.ProviderTradeNo == "" {
		return nil, ErrAppPaymentProviderMismatch
	}
	if err := ValidateAppPaymentMerchant(ctx, order); err != nil {
		return nil, err
	}
	switch order.Provider {
	case "stripe":
		return refundStripeAppPayment(ctx, order)
	case "wechatpay":
		return refundWeChatAppPayment(ctx, order)
	default:
		return nil, ErrAppPaymentProviderUnsupported
	}
}

func QueryAppPaymentRefund(ctx context.Context, order *model.PaymentOrder) (*AppPaymentRefundResult, error) {
	if err := ValidateAppPaymentMerchant(ctx, order); err != nil {
		return nil, err
	}
	if order.RefundID == "" {
		return nil, ErrAppPaymentProviderMismatch
	}
	switch order.Provider {
	case "stripe":
		if order.ProviderRefundNo == "" {
			return nil, ErrAppPaymentProviderMismatch
		}
		return refundStripeAppPayment(ctx, order)
	case "wechatpay":
		return queryWeChatAppPaymentRefund(ctx, order)
	default:
		return nil, ErrAppPaymentProviderUnsupported
	}
}

func appPaymentReturnURL(order *model.PaymentOrder) (string, error) {
	u, err := url.Parse(strings.TrimRight(GetCallbackAddress(), "/"))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("payment callback address is not configured")
	}
	u.Path = "/payments/checkout/" + url.PathEscape(order.ID)
	return u.String(), nil
}
