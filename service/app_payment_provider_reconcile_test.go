package service

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestAppPaymentStripeRecoveryRetainsExpiryAndStopsAtTerminalState(t *testing.T) {
	oldDB, oldLogDB, oldClient := model.DB, model.LOG_DB, appPaymentHTTPClient
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	oldKey, oldWebhook, oldCallback := setting.StripeApiSecret, setting.StripeWebhookSecret, operation_setting.CustomCallbackAddress
	oldCompliance := *operation_setting.GetPaymentSetting()
	t.Cleanup(func() {
		model.DB, model.LOG_DB, appPaymentHTTPClient = oldDB, oldLogDB, oldClient
		common.SetDatabaseTypes(oldMain, oldLog)
		setting.StripeApiSecret, setting.StripeWebhookSecret, operation_setting.CustomCallbackAddress = oldKey, oldWebhook, oldCallback
		*operation_setting.GetPaymentSetting() = oldCompliance
		appPaymentStripeAccounts.Clear()
	})
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	model.DB, model.LOG_DB = db, db
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	require.NoError(t, db.AutoMigrate(&model.PaymentApplication{}, &model.PaymentOrder{}, &model.PaymentWebhookEvent{}))
	app := &model.PaymentApplication{ClientID: "recover-client", Enabled: true, Methods: `["stripe"]`}
	require.NoError(t, db.Create(app).Error)
	setting.StripeApiSecret, setting.StripeWebhookSecret = "sk_test_recovery", "whsec_recovery"
	operation_setting.CustomCallbackAddress = "https://pay.example.test"
	operation_setting.GetPaymentSetting().ComplianceConfirmed = true
	operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
	initialExpiry := time.Now().Add(5 * time.Minute).Unix()
	order := &model.PaymentOrder{ID: "ap_0123456789abcdef0123456789ab", ClientID: app.ClientID, OutTradeNo: "external-1", Amount: 101, Currency: "USD", Title: "Recovery fixture", Provider: "stripe", PaymentMethod: "stripe", ProviderMerchantID: "acct_recovery", ExpiresAt: initialExpiry, Status: model.AppPaymentProcessing}
	require.NoError(t, db.Create(order).Error)
	var requestForms []string
	paymentStatus, refundStatus := "unpaid", "pending"
	queryCount, refundPosts := 0, 0
	appPaymentHTTPClient = &http.Client{Transport: appPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		body := ""
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/account":
			body = `{"id":"acct_recovery"}`
		case "POST /v1/checkout/sessions":
			raw, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			requestForms = append(requestForms, string(raw))
			assert.Equal(t, "app-payment-create-"+order.ID, r.Header.Get("Idempotency-Key"))
			var current model.PaymentOrder
			require.NoError(t, db.First(&current, "id = ?", order.ID).Error)
			assert.GreaterOrEqual(t, current.ProviderExpiresAt, time.Now().Add(30*time.Minute).Unix())
			assert.Greater(t, current.ExpiresAt, initialExpiry)
			body = `{"id":"cs_recovery","url":"https://checkout.stripe.com/c/pay/recovery","client_reference_id":"` + order.ID + `","amount_total":101,"currency":"usd","expires_at":` + strconv.FormatInt(current.ProviderExpiresAt, 10) + `}`
		case "GET /v1/checkout/sessions/cs_recovery":
			queryCount++
			status := "open"
			if paymentStatus == "paid" {
				status = "complete"
			}
			if paymentStatus == "expired" {
				status = "expired"
			}
			body = `{"id":"cs_recovery","mode":"payment","status":"` + status + `","payment_status":"` + paymentStatus + `","client_reference_id":"` + order.ID + `","metadata":{"app_payment_order":"` + order.ID + `","app_payment_client":"recover-client"},"amount_total":101,"currency":"usd","payment_intent":"pi_recovery"}`
		case "GET /v1/refunds":
			body = `{"object":"list","data":[],"has_more":false}`
		case "POST /v1/refunds", "GET /v1/refunds/re_recovery":
			if r.Method == http.MethodPost {
				refundPosts++
			}
			body = `{"id":"re_recovery","amount":101,"currency":"usd","status":"` + refundStatus + `","payment_intent":"pi_recovery","metadata":{"app_payment_order":"` + order.ID + `","app_payment_client":"recover-client","app_payment_refund":"ar_0123456789abcdef0123456789ab"}}`
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			body = `{}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	_, err = CreateAppPaymentCheckout(context.Background(), order, "stripe")
	require.NoError(t, err)
	stableExpiry := order.ExpiresAt
	// Model a successful processor create whose checkout response was lost before
	// storage. The worker must recover with the identical request parameters.
	require.NoError(t, db.Model(order).Update("payment_data", "").Error)
	require.NoError(t, RunAppPaymentProviderReconciliation(context.Background(), 4))
	require.Len(t, requestForms, 2)
	assert.Equal(t, requestForms[0], requestForms[1])
	current, err := model.GetAppPaymentOrder(order.ID)
	require.NoError(t, err)
	assert.Equal(t, stableExpiry, current.ExpiresAt)
	assert.NotEmpty(t, current.PaymentData)
	assert.Equal(t, 1, queryCount)
	require.NoError(t, RunAppPaymentProviderReconciliation(context.Background(), 4))
	assert.Equal(t, 1, queryCount, "lease blocks immediate repeat")
	paymentStatus = "paid"
	require.NoError(t, db.Model(order).Update("next_check_at", 0).Error)
	require.NoError(t, RunAppPaymentProviderReconciliation(context.Background(), 4))
	current, err = model.GetAppPaymentOrder(order.ID)
	require.NoError(t, err)
	assert.Equal(t, model.AppPaymentPaid, current.Status)
	_, _, err = model.BeginAppPaymentRefund(app.ClientID, order.ID)
	require.NoError(t, err)
	require.NoError(t, db.Model(order).Update("next_check_at", 0).Error)
	require.NoError(t, RunAppPaymentProviderReconciliation(context.Background(), 4))
	current, err = model.GetAppPaymentOrder(order.ID)
	require.NoError(t, err)
	assert.Equal(t, "re_recovery", current.ProviderRefundNo)
	refundStatus = "succeeded"
	require.NoError(t, db.Model(order).Update("next_check_at", 0).Error)
	require.NoError(t, RunAppPaymentProviderReconciliation(context.Background(), 4))
	current, err = model.GetAppPaymentOrder(order.ID)
	require.NoError(t, err)
	assert.Equal(t, model.AppPaymentRefunded, current.Status)
	assert.Equal(t, 1, refundPosts, "pending recovery only queries the original refund")
	// A processor-confirmed expiry becomes terminal instead of polling forever.
	paymentStatus = "expired"
	require.NoError(t, db.Model(order).Updates(map[string]any{"status": model.AppPaymentProcessing, "paid_at": 0, "next_check_at": 0}).Error)
	require.NoError(t, RunAppPaymentProviderReconciliation(context.Background(), 4))
	current, err = model.GetAppPaymentOrder(order.ID)
	require.NoError(t, err)
	assert.Equal(t, model.AppPaymentExpired, current.Status)
	finalQueries := queryCount
	require.NoError(t, RunAppPaymentProviderReconciliation(context.Background(), 4))
	assert.Equal(t, finalQueries, queryCount)
}
