package service

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/stripe/stripe-go/v81"
)

type appPaymentTestTransport func(*http.Request) (*http.Response, error)

func (f appPaymentTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAppPaymentStripeCheckoutQueryRefundContract(t *testing.T) {
	oldClient, oldKey, oldCallback := appPaymentHTTPClient, setting.StripeApiSecret, operation_setting.CustomCallbackAddress
	t.Cleanup(func() {
		appPaymentHTTPClient = oldClient
		setting.StripeApiSecret = oldKey
		operation_setting.CustomCallbackAddress = oldCallback
		appPaymentStripeAccounts.Clear()
	})
	setting.StripeApiSecret = "sk_test_app_contract"
	operation_setting.CustomCallbackAddress = "https://pay.example.test"
	order := &model.PaymentOrder{ID: "ap_0123456789abcdef0123456789ab", ClientID: "client-test", Amount: 12345, Currency: "USD", Title: "App service", Provider: "stripe", PaymentMethod: "stripe", ProviderMerchantID: "acct_test", ProviderExpiresAt: time.Now().Add(time.Hour).Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix(), RefundID: "ar_0123456789abcdef0123456789ab"}
	var paths []string
	appPaymentHTTPClient = &http.Client{Transport: appPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		assert.Equal(t, "api.stripe.com", r.URL.Host)
		response := ""
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/account":
			response = `{"id":"acct_test","object":"account"}`
		case "POST /v1/checkout/sessions":
			require.NoError(t, r.ParseForm())
			assert.Equal(t, "12345", r.PostForm.Get("line_items[0][price_data][unit_amount]"))
			assert.Equal(t, strconv.FormatInt(order.ProviderExpiresAt, 10), r.PostForm.Get("expires_at"))
			assert.Equal(t, "usd", r.PostForm.Get("line_items[0][price_data][currency]"))
			assert.Equal(t, "1", r.PostForm.Get("line_items[0][quantity]"))
			assert.Equal(t, order.ID, r.PostForm.Get("client_reference_id"))
			assert.Equal(t, "app-payment-create-"+order.ID, r.Header.Get("Idempotency-Key"))
			assert.Equal(t, order.ClientID, r.PostForm.Get("metadata[app_payment_client]"))
			assert.Equal(t, "https://pay.example.test/payments/checkout/"+order.ID, r.PostForm.Get("success_url"))
			response = `{"id":"cs_test","url":"https://checkout.stripe.com/c/pay/test","client_reference_id":"` + order.ID + `","amount_total":12345,"currency":"usd","expires_at":` + strconv.FormatInt(order.ProviderExpiresAt, 10) + `}`
		case "GET /v1/checkout/sessions/cs_test":
			response = `{"id":"cs_test","mode":"payment","status":"complete","payment_status":"paid","client_reference_id":"` + order.ID + `","metadata":{"app_payment_order":"` + order.ID + `","app_payment_client":"client-test"},"amount_total":12345,"currency":"usd","payment_intent":"pi_test"}`
		case "GET /v1/refunds":
			assert.Equal(t, "pi_test", r.URL.Query().Get("payment_intent"))
			response = `{"object":"list","data":[],"has_more":false}`
		case "POST /v1/refunds":
			require.NoError(t, r.ParseForm())
			assert.Equal(t, "12345", r.PostForm.Get("amount"))
			assert.Equal(t, "pi_test", r.PostForm.Get("payment_intent"))
			assert.Equal(t, "app-payment-refund-"+order.RefundID, r.Header.Get("Idempotency-Key"))
			response = `{"id":"re_test","amount":12345,"currency":"usd","status":"pending","payment_intent":"pi_test","metadata":{"app_payment_order":"` + order.ID + `","app_payment_refund":"` + order.RefundID + `","app_payment_client":"client-test"}}`
		case "GET /v1/refunds/re_test":
			response = `{"id":"re_test","amount":12345,"currency":"usd","status":"succeeded","payment_intent":"pi_test","metadata":{"app_payment_order":"` + order.ID + `","app_payment_refund":"` + order.RefundID + `","app_payment_client":"client-test"}}`
		default:
			t.Fatalf("unexpected provider request %s %s", r.Method, r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(response))}, nil
	})}
	checkout, err := createStripeAppPayment(context.Background(), order)
	require.NoError(t, err)
	assert.Equal(t, "cs_test", checkout.ProviderID)
	data, err := common.Marshal(checkout)
	require.NoError(t, err)
	order.PaymentData = string(data)
	paid, err := QueryAppPayment(context.Background(), order)
	require.NoError(t, err)
	assert.Equal(t, "paid", paid.Status)
	assert.Equal(t, int64(12345), paid.Amount)
	order.ProviderTradeNo = paid.ProviderTradeNo
	result, err := RefundAppPayment(context.Background(), order)
	require.NoError(t, err)
	assert.Equal(t, "refunding", result.Status)
	order.ProviderRefundNo = result.ProviderRefundNo
	result, err = QueryAppPaymentRefund(context.Background(), order)
	require.NoError(t, err)
	assert.Equal(t, "refunded", result.Status)
	setting.StripeApiSecret = "sk_test_rotated_same_account"
	_, err = QueryAppPayment(context.Background(), order)
	require.NoError(t, err, "rotation to same merchant must preserve existing order")
	assert.Equal(t, 1, countAppPaymentRequests(paths, "POST /v1/refunds"))
}

func countAppPaymentRequests(paths []string, want string) int {
	count := 0
	for _, p := range paths {
		if p == want {
			count++
		}
	}
	return count
}

func TestAppPaymentStripeRejectsMismatchedSignedFields(t *testing.T) {
	order := &model.PaymentOrder{ID: "ap_test", ClientID: "client", Amount: 101, Currency: "CNY", Provider: "stripe"}
	for _, field := range []string{"amount", "currency", "client", "order", "intent"} {
		t.Run(field, func(t *testing.T) {
			s := &stripe.CheckoutSession{ID: "cs_test", Mode: "payment", Status: "complete", PaymentStatus: "paid", ClientReferenceID: order.ID, AmountTotal: 101, Currency: "cny", Metadata: map[string]string{"app_payment_order": order.ID, "app_payment_client": "client"}, PaymentIntent: &stripe.PaymentIntent{ID: "pi_test"}}
			switch field {
			case "amount":
				s.AmountTotal++
			case "currency":
				s.Currency = "usd"
			case "client":
				s.Metadata["app_payment_client"] = "other"
			case "order":
				s.ClientReferenceID = "other"
			case "intent":
				s.PaymentIntent = nil
			}
			_, err := ValidateStripeAppPayment(order, s)
			require.ErrorIs(t, err, ErrAppPaymentProviderMismatch)
		})
	}
}

func TestAppPaymentWeChatSignedHTTPContract(t *testing.T) {
	merchantKey := generateRSAPrivateKey(t)
	platformKey := generateRSAPrivateKey(t)
	certificate := generatePlatformCertificate(t, platformKey, 0xABCDEF)
	oldClient := appPaymentHTTPClient
	oldApp, oldMerchant, oldSerial, oldKey, oldCert, oldCertSerial, oldV3, oldNotify := setting.WeChatPayAppID, setting.WeChatPayMerchantID, setting.WeChatPayMerchantSerialNumber, setting.WeChatPayPrivateKey, setting.WeChatPayPlatformCertificate, setting.WeChatPayPlatformCertificateSerialNumber, setting.WeChatPayAPIV3Key, setting.WeChatPayNotifyURL
	t.Cleanup(func() {
		appPaymentHTTPClient = oldClient
		setting.WeChatPayAppID, setting.WeChatPayMerchantID, setting.WeChatPayMerchantSerialNumber, setting.WeChatPayPrivateKey, setting.WeChatPayPlatformCertificate, setting.WeChatPayPlatformCertificateSerialNumber, setting.WeChatPayAPIV3Key, setting.WeChatPayNotifyURL = oldApp, oldMerchant, oldSerial, oldKey, oldCert, oldCertSerial, oldV3, oldNotify
	})
	setting.WeChatPayAppID = "app-test"
	setting.WeChatPayMerchantID = "merchant-test"
	setting.WeChatPayMerchantSerialNumber = "merchant-serial"
	setting.WeChatPayPrivateKey = encodePEM("RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(merchantKey))
	setting.WeChatPayPlatformCertificate = encodePEM("CERTIFICATE", certificate.Raw)
	setting.WeChatPayPlatformCertificateSerialNumber = "ABCDEF"
	setting.WeChatPayAPIV3Key = "12345678901234567890123456789012"
	setting.WeChatPayNotifyURL = "https://pay.example.test/api/wechatpay/webhook"
	order := &model.PaymentOrder{ID: "ap_0123456789abcdef0123456789ab", ClientID: "client", Amount: 123, Currency: "CNY", Provider: "wechatpay", PaymentMethod: "wechatpay", ProviderMerchantID: "app-test:merchant-test", ExpiresAt: time.Now().Add(time.Hour).Unix(), RefundID: "ar_0123456789abcdef0123456789ab"}
	appPaymentHTTPClient = &http.Client{Transport: appPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		assert.Equal(t, "api.mch.weixin.qq.com", r.URL.Host)
		assert.Contains(t, r.Header.Get("Authorization"), "WECHATPAY2-SHA256-RSA2048")
		response := ""
		switch {
		case r.Method == "POST" && r.URL.Path == "/v3/pay/transactions/native":
			b, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			var payload map[string]any
			require.NoError(t, common.Unmarshal(b, &payload))
			assert.Equal(t, order.ID, payload["out_trade_no"])
			assert.Equal(t, setting.WeChatPayNotifyURL, payload["notify_url"])
			assert.Equal(t, float64(123), payload["amount"].(map[string]any)["total"])
			response = `{"code_url":"weixin://wxpay/bizpayurl?pr=test"}`
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v3/pay/transactions/out-trade-no/"):
			response = `{"appid":"app-test","mchid":"merchant-test","out_trade_no":"` + order.ID + `","transaction_id":"wx_transaction","trade_state":"SUCCESS","trade_type":"NATIVE","amount":{"total":123,"currency":"CNY"}}`
		case r.Method == "POST" && r.URL.Path == "/v3/refund/domestic/refunds":
			b, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			var payload map[string]any
			require.NoError(t, common.Unmarshal(b, &payload))
			assert.Equal(t, order.RefundID, payload["out_refund_no"])
			assert.Equal(t, float64(123), payload["amount"].(map[string]any)["refund"])
			response = `{"refund_id":"wx_refund","out_refund_no":"` + order.RefundID + `","out_trade_no":"` + order.ID + `","transaction_id":"wx_transaction","status":"PROCESSING","amount":{"total":123,"refund":123,"currency":"CNY"}}`
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v3/refund/domestic/refunds/"):
			response = `{"refund_id":"wx_refund","out_refund_no":"` + order.RefundID + `","out_trade_no":"` + order.ID + `","transaction_id":"wx_transaction","status":"SUCCESS","amount":{"total":123,"refund":123,"currency":"CNY"}}`
		default:
			t.Fatalf("unexpected WeChat request %s %s", r.Method, r.URL.Path)
		}
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		nonce := "test-nonce"
		digest := sha256.Sum256([]byte(timestamp + "\n" + nonce + "\n" + response + "\n"))
		signature, err := rsa.SignPKCS1v15(rand.Reader, platformKey, crypto.SHA256, digest[:])
		require.NoError(t, err)
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}, "Wechatpay-Timestamp": []string{timestamp}, "Wechatpay-Nonce": []string{nonce}, "Wechatpay-Serial": []string{"ABCDEF"}, "Wechatpay-Signature": []string{base64.StdEncoding.EncodeToString(signature)}}, Body: io.NopCloser(strings.NewReader(response))}, nil
	})}
	checkout, err := createWeChatAppPayment(context.Background(), order)
	require.NoError(t, err)
	assert.Contains(t, checkout.CodeURL, "weixin://")
	paid, err := QueryAppPayment(context.Background(), order)
	require.NoError(t, err)
	assert.Equal(t, "paid", paid.Status)
	order.ProviderTradeNo = paid.ProviderTradeNo
	refunded, err := RefundAppPayment(context.Background(), order)
	require.NoError(t, err)
	assert.Equal(t, "refunding", refunded.Status)
	order.ProviderRefundNo = refunded.ProviderRefundNo
	refunded, err = QueryAppPaymentRefund(context.Background(), order)
	require.NoError(t, err)
	assert.Equal(t, "refunded", refunded.Status)
}

func TestAppPaymentEpaySignedAmountContract(t *testing.T) {
	oldAddress, oldID, oldKey, oldCallback := operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey, operation_setting.CustomCallbackAddress
	t.Cleanup(func() {
		operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey, operation_setting.CustomCallbackAddress = oldAddress, oldID, oldKey, oldCallback
	})
	operation_setting.PayAddress = "https://epay.example.test"
	operation_setting.EpayId = "merchant"
	operation_setting.EpayKey = "fake-key"
	operation_setting.CustomCallbackAddress = "https://pay.example.test"
	order := &model.PaymentOrder{ID: "ap_test", ClientID: "client", Amount: 101, Currency: "CNY", Title: "Test", Provider: "epay", PaymentMethod: "epay_alipay", ProviderMerchantID: "https://epay.example.test:merchant"}
	checkout, err := createEpayAppPayment(order)
	require.NoError(t, err)
	u, err := url.Parse(checkout.CheckoutURL)
	require.NoError(t, err)
	assert.Equal(t, "1.01", u.Query().Get("money"))
	assert.Equal(t, "/submit.php", u.Path)
	params := map[string]string{"pid": "merchant", "out_trade_no": order.ID, "trade_no": "epay_trade", "type": "alipay", "trade_status": "TRADE_SUCCESS", "money": "1.01"}
	client, err := epay.NewClient(&epay.Config{PartnerID: "merchant", Key: "fake-key"}, operation_setting.PayAddress)
	require.NoError(t, err)
	verified, err := client.Verify(epay.GenerateParams(params, "fake-key"))
	require.NoError(t, err)
	require.True(t, verified.VerifyStatus)
	paid, err := ValidateEpayAppPayment(order, params)
	require.NoError(t, err)
	assert.Equal(t, int64(101), paid.Amount)
	for _, amount := range []string{"1.001", "1.02", "1e0", "-1.01", "999999999999999999999.99"} {
		params["money"] = amount
		_, err = ValidateEpayAppPayment(order, params)
		require.ErrorIs(t, err, ErrAppPaymentProviderMismatch)
	}
	assert.False(t, SupportsAppPaymentRefund("epay_alipay"))
}
