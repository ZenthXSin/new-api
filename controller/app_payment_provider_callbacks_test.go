package controller

import (
	"bytes"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
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
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/stripe/stripe-go/v81/webhook"
	"gorm.io/gorm"
)

func TestAppPaymentEpayWebhookVerifiesBeforeIndependentSettlement(t *testing.T) {
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldSecret := common.SessionSecret
	oldAddress, oldID, oldKey := operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.SessionSecret = oldSecret
		operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey = oldAddress, oldID, oldKey
	})
	confirmPaymentComplianceForTest(t)
	common.SessionSecret = "test-session-secret-for-app-payment"
	operation_setting.PayAddress = "https://epay.example.test"
	operation_setting.EpayId = "merchant"
	operation_setting.EpayKey = "fake-key"
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.PaymentApplication{}, &model.PaymentOrder{}, &model.PaymentWebhookEvent{}, &model.TopUp{}))
	app := &model.PaymentApplication{ClientID: "callback-client", Enabled: true, WebhookURL: "https://app.example.test/paid", WebhookSecret: "encrypted-fixture", Methods: `["epay_alipay"]`}
	require.NoError(t, db.Create(app).Error)
	user := &model.User{Username: "payer", Quota: 777, Status: common.UserStatusEnabled}
	require.NoError(t, db.Create(user).Error)
	order := &model.PaymentOrder{ID: "ap_0123456789abcdef0123456789ab", ClientID: app.ClientID, OutTradeNo: "app-1", Amount: 101, Currency: "CNY", Title: "Fixture", Status: model.AppPaymentProcessing, PaymentMethod: "epay_alipay", Provider: "epay", ProviderMerchantID: "https://epay.example.test:merchant", PayerUserID: user.Id, ExpiresAt: time.Now().Add(time.Hour).Unix()}
	require.NoError(t, db.Create(order).Error)
	params := map[string]string{"pid": "merchant", "out_trade_no": order.ID, "trade_no": "epay_trade", "type": "alipay", "trade_status": "TRADE_SUCCESS", "money": "1.01"}
	for _, tc := range []struct {
		name   string
		tamper bool
		money  string
		want   string
	}{
		{"bad signature", true, "1.01", "fail"},
		{"signed wrong amount", false, "1.02", "fail"},
		{"valid callback", false, "1.01", "success"},
		{"duplicate callback", false, "1.01", "success"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			params["money"] = tc.money
			epay.GenerateParams(params, "fake-key")
			if tc.tamper {
				params["sign"] = "invalid"
			}
			form := url.Values{}
			for k, v := range params {
				form.Set(k, v)
			}
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/user/epay/notify", bytes.NewBufferString(form.Encode()))
			ctx.Request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			EpayNotify(ctx)
			assert.Equal(t, tc.want, strings.TrimSpace(rec.Body.String()))
			var current model.PaymentOrder
			require.NoError(t, db.First(&current, "id = ?", order.ID).Error)
			if tc.want == "success" {
				assert.Equal(t, model.AppPaymentPaid, current.Status)
				assert.Equal(t, "epay_trade", current.ProviderTradeNo)
			} else {
				assert.Equal(t, model.AppPaymentProcessing, current.Status)
			}
		})
	}
	var currentUser model.User
	require.NoError(t, db.First(&currentUser, user.Id).Error)
	assert.Equal(t, 777, currentUser.Quota)
	var topups, events int64
	require.NoError(t, db.Model(&model.TopUp{}).Count(&topups).Error)
	require.NoError(t, db.Model(&model.PaymentWebhookEvent{}).Count(&events).Error)
	assert.Zero(t, topups)
	assert.Equal(t, int64(1), events)
}

type appPaymentCallbackTransport func(*http.Request) (*http.Response, error)

func (f appPaymentCallbackTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func setupAppPaymentCallbackOrder(t *testing.T, provider, merchant string) (*gorm.DB, *model.PaymentOrder) {
	t.Helper()
	oldDB, oldLogDB, oldSecret := model.DB, model.LOG_DB, common.SessionSecret
	t.Cleanup(func() { model.DB, model.LOG_DB, common.SessionSecret = oldDB, oldLogDB, oldSecret })
	confirmPaymentComplianceForTest(t)
	common.SessionSecret = "callback-fixture-session-secret"
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.PaymentApplication{}, &model.PaymentOrder{}, &model.PaymentWebhookEvent{}, &model.TopUp{}))
	app := &model.PaymentApplication{ClientID: "callback-client", Enabled: true, WebhookURL: "https://app.example.test/paid", WebhookSecret: "encrypted-fixture", Methods: `["stripe","wechatpay"]`}
	require.NoError(t, db.Create(app).Error)
	user := &model.User{Username: "callback-payer", Quota: 777, Status: common.UserStatusEnabled}
	require.NoError(t, db.Create(user).Error)
	order := &model.PaymentOrder{ID: "ap_0123456789abcdef0123456789ab", ClientID: app.ClientID, OutTradeNo: "app-1", Amount: 101, Currency: "CNY", Title: "Fixture", Status: model.AppPaymentProcessing, PaymentMethod: provider, Provider: provider, ProviderMerchantID: merchant, PayerUserID: user.Id, ExpiresAt: time.Now().Add(time.Hour).Unix()}
	require.NoError(t, db.Create(order).Error)
	return db, order
}

func assertAppPaymentCallbackIndependent(t *testing.T, db *gorm.DB, order *model.PaymentOrder) {
	t.Helper()
	var user model.User
	require.NoError(t, db.First(&user, order.PayerUserID).Error)
	assert.Equal(t, 777, user.Quota)
	var topups, events int64
	require.NoError(t, db.Model(&model.TopUp{}).Count(&topups).Error)
	require.NoError(t, db.Model(&model.PaymentWebhookEvent{}).Count(&events).Error)
	assert.Zero(t, topups)
	assert.Equal(t, int64(1), events)
}

func TestAppPaymentStripeWebhookSignatureAndIndependentSettlement(t *testing.T) {
	db, order := setupAppPaymentCallbackOrder(t, "stripe", "acct_callback")
	oldKey, oldWebhook, oldPrice, oldTransport := setting.StripeApiSecret, setting.StripeWebhookSecret, setting.StripePriceId, http.DefaultTransport
	t.Cleanup(func() {
		setting.StripeApiSecret, setting.StripeWebhookSecret, setting.StripePriceId, http.DefaultTransport = oldKey, oldWebhook, oldPrice, oldTransport
	})
	setting.StripeApiSecret, setting.StripeWebhookSecret, setting.StripePriceId = "sk_test_callback_fixture", "whsec_fixture", ""
	http.DefaultTransport = appPaymentCallbackTransport(func(r *http.Request) (*http.Response, error) {
		assert.Equal(t, "https://api.stripe.com/v1/account", r.URL.String())
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"acct_callback"}`))}, nil
	})
	for _, tc := range []struct {
		name    string
		amount  int64
		tamper  bool
		account string
		want    int
	}{
		{"bad signature", 101, true, "", 400}, {"signed wrong amount", 102, false, "", 400}, {"wrong connected account", 101, false, "acct_other", 400}, {"valid app-only callback", 101, false, "", 200}, {"duplicate callback", 101, false, "", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checkout := map[string]any{"id": "cs_callback", "mode": "payment", "status": "complete", "payment_status": "paid", "client_reference_id": order.ID, "metadata": map[string]string{"app_payment_order": order.ID, "app_payment_client": order.ClientID}, "amount_total": tc.amount, "currency": "cny", "payment_intent": "pi_callback"}
			payload, err := common.Marshal(map[string]any{"id": "evt_fixture", "object": "event", "type": "checkout.session.completed", "account": tc.account, "data": map[string]any{"object": checkout}})
			require.NoError(t, err)
			signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: payload, Secret: setting.StripeWebhookSecret})
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/stripe/webhook", bytes.NewReader(payload))
			ctx.Request.Header.Set("Stripe-Signature", signed.Header)
			if tc.tamper {
				ctx.Request.Header.Set("Stripe-Signature", "invalid")
			}
			StripeWebhook(ctx)
			ctx.Writer.WriteHeaderNow()
			assert.Equal(t, tc.want, rec.Code)
			current, err := model.GetAppPaymentOrder(order.ID)
			require.NoError(t, err)
			if tc.want == 200 {
				assert.Equal(t, model.AppPaymentPaid, current.Status)
			} else {
				assert.Equal(t, model.AppPaymentProcessing, current.Status)
			}
		})
	}
	assertAppPaymentCallbackIndependent(t, db, order)
}

func TestAppPaymentWeChatWebhookRSAAndAEADBeforeIndependentSettlement(t *testing.T) {
	db, order := setupAppPaymentCallbackOrder(t, "wechatpay", "app-fixture:merchant-fixture")
	oldApp, oldMerchant, oldSerial, oldKey, oldCert, oldCertSerial, oldV3, oldNotify := setting.WeChatPayAppID, setting.WeChatPayMerchantID, setting.WeChatPayMerchantSerialNumber, setting.WeChatPayPrivateKey, setting.WeChatPayPlatformCertificate, setting.WeChatPayPlatformCertificateSerialNumber, setting.WeChatPayAPIV3Key, setting.WeChatPayNotifyURL
	oldEnabled, oldMin, oldExpire := setting.WeChatPayEnabled, setting.WeChatPayMinTopUp, setting.WeChatPayOrderExpireMinutes
	t.Cleanup(func() {
		setting.WeChatPayAppID, setting.WeChatPayMerchantID, setting.WeChatPayMerchantSerialNumber, setting.WeChatPayPrivateKey, setting.WeChatPayPlatformCertificate, setting.WeChatPayPlatformCertificateSerialNumber, setting.WeChatPayAPIV3Key, setting.WeChatPayNotifyURL = oldApp, oldMerchant, oldSerial, oldKey, oldCert, oldCertSerial, oldV3, oldNotify
		setting.WeChatPayEnabled, setting.WeChatPayMinTopUp, setting.WeChatPayOrderExpireMinutes = oldEnabled, oldMin, oldExpire
	})
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	cert := &x509.Certificate{SerialNumber: big.NewInt(0xABCDEF), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	require.NoError(t, err)
	setting.WeChatPayEnabled = true
	setting.WeChatPayAppID, setting.WeChatPayMerchantID = "app-fixture", "merchant-fixture"
	setting.WeChatPayMerchantSerialNumber, setting.WeChatPayPlatformCertificateSerialNumber = "merchant-serial", "ABCDEF"
	setting.WeChatPayPrivateKey = string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	setting.WeChatPayPlatformCertificate = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	setting.WeChatPayAPIV3Key = "12345678901234567890123456789012"
	setting.WeChatPayNotifyURL = "https://pay.example.test/api/wechatpay/webhook"
	setting.WeChatPayMinTopUp, setting.WeChatPayOrderExpireMinutes = 0, 0 // App payments do not depend on top-up limits.
	block, err := aes.NewCipher([]byte(setting.WeChatPayAPIV3Key))
	require.NoError(t, err)
	aead, err := cipher.NewGCM(block)
	require.NoError(t, err)
	for _, tc := range []struct {
		name   string
		amount int64
		tamper bool
		want   int
	}{
		{"bad signature", 101, true, 400}, {"signed wrong amount", 102, false, 400}, {"valid app-only callback", 101, false, 204}, {"duplicate callback", 101, false, 204},
	} {
		t.Run(tc.name, func(t *testing.T) {
			transaction, err := common.Marshal(map[string]any{"appid": setting.WeChatPayAppID, "mchid": setting.WeChatPayMerchantID, "out_trade_no": order.ID, "transaction_id": "wx_callback", "trade_state": "SUCCESS", "trade_type": "NATIVE", "amount": map[string]any{"total": tc.amount, "currency": "CNY"}})
			require.NoError(t, err)
			nonce := []byte("123456789012")
			ciphertext := aead.Seal(nil, nonce, transaction, []byte("transaction"))
			payload, err := common.Marshal(map[string]any{"id": "wx-event", "event_type": "TRANSACTION.SUCCESS", "resource_type": "encrypt-resource", "resource": map[string]any{"algorithm": "AEAD_AES_256_GCM", "original_type": "transaction", "associated_data": "transaction", "nonce": string(nonce), "ciphertext": base64.StdEncoding.EncodeToString(ciphertext)}})
			require.NoError(t, err)
			timestamp := strconv.FormatInt(time.Now().Unix(), 10)
			digest := sha256.Sum256([]byte(timestamp + "\nnotify-nonce\n" + string(payload) + "\n"))
			signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			require.NoError(t, err)
			rec := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(rec)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/wechatpay/webhook", bytes.NewReader(payload))
			ctx.Request.Header.Set("Wechatpay-Timestamp", timestamp)
			ctx.Request.Header.Set("Wechatpay-Nonce", "notify-nonce")
			ctx.Request.Header.Set("Wechatpay-Serial", "ABCDEF")
			ctx.Request.Header.Set("Wechatpay-Signature", base64.StdEncoding.EncodeToString(signature))
			if tc.tamper {
				ctx.Request.Header.Set("Wechatpay-Signature", "invalid")
			}
			WeChatPayWebhook(ctx)
			ctx.Writer.WriteHeaderNow()
			assert.Equal(t, tc.want, rec.Code)
			current, err := model.GetAppPaymentOrder(order.ID)
			require.NoError(t, err)
			if tc.want == 204 {
				assert.Equal(t, model.AppPaymentPaid, current.Status)
			} else {
				assert.Equal(t, model.AppPaymentProcessing, current.Status)
			}
		})
	}
	assertAppPaymentCallbackIndependent(t, db, order)
}
