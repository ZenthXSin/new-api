package controller

import (
	"bytes"
	"encoding/base64"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type appPaymentHTTPFixture struct {
	r                                                 *gin.Engine
	user                                              *model.User
	client                                            *model.OauthClient
	secret, browser, otherBrowser, rootBrowser, oauth string
	other                                             *model.User
}

func newAppPaymentHTTPFixture(t *testing.T) *appPaymentHTTPFixture {
	t.Helper()
	db, user := setupOidcProviderTest(t)
	require.NoError(t, db.AutoMigrate(&model.PaymentApplication{}, &model.PaymentOrder{}, &model.PaymentWebhookEvent{}, &model.PaymentWalletOperation{}, &model.PaymentWalletGuard{}, &model.PaymentWalletCacheWitness{}, &model.PaymentWalletMutation{}))
	oldSecret, oldBatch, oldAddress, oldCallback, oldQuota, oldRate := common.SessionSecret, common.BatchUpdateEnabled, system_setting.ServerAddress, operation_setting.CustomCallbackAddress, common.QuotaPerUnit, operation_setting.USDExchangeRate
	common.SessionSecret = "payment-isolated-test-secret"
	common.BatchUpdateEnabled = false
	require.NoError(t, model.InitializeAppPaymentWalletCache())
	t.Cleanup(model.ResetAppPaymentWalletCacheForTesting)
	system_setting.ServerAddress = "http://example.com"
	operation_setting.CustomCallbackAddress = ""
	common.QuotaPerUnit = 500000
	operation_setting.USDExchangeRate = 7
	t.Cleanup(func() {
		common.SessionSecret = oldSecret
		common.BatchUpdateEnabled = oldBatch
		system_setting.ServerAddress = oldAddress
		operation_setting.CustomCallbackAddress = oldCallback
		common.QuotaPerUnit = oldQuota
		operation_setting.USDExchangeRate = oldRate
	})
	client, secret := createOidcTestClient(t, false)
	client.Scopes = "wallet:read billing:read billing:write"
	require.NoError(t, db.Model(client).Update("scopes", client.Scopes).Error)
	encrypted, err := model.EncryptAppPaymentWebhookSecret(client.ClientId, "fixture-webhook-secret")
	require.NoError(t, err)
	require.NoError(t, model.SavePaymentApplication(&model.PaymentApplication{ClientID: client.ClientId, Enabled: true, WebhookURL: "https://merchant.example/webhook", WebhookSecret: encrypted, Methods: `["balance"]`}))
	other := &model.User{Username: "other-payer", AffCode: "payoth", Status: common.UserStatusEnabled, Role: common.RoleCommonUser, AuthVersion: 1, Quota: 500000, Group: "default"}
	require.NoError(t, db.Create(other).Error)
	root := &model.User{Username: "payment-root", AffCode: "payroot", Status: common.UserStatusEnabled, Role: common.RoleRootUser, AuthVersion: 1, Quota: 500000, Group: "default"}
	require.NoError(t, db.Create(root).Error)
	login := func(userID int) string {
		bundle, err := service.CreateLoginSession(userID, "password", "127.0.0.1", "payment-fixture")
		require.NoError(t, err)
		return bundle.AccessToken
	}
	oauth, err := service.IssueOAuthTokens(client, user, []string{"wallet:read"}, []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	f := &appPaymentHTTPFixture{user: user, other: other, client: client, secret: secret, browser: login(user.Id), otherBrowser: login(other.Id), rootBrowser: login(root.Id), oauth: oauth.AccessToken, r: gin.New()}
	api := f.r.Group("/api/payments", middleware.DisableCache())
	orders := api.Group("/orders", middleware.AppPaymentAuth())
	orders.POST("", CreateAppPaymentOrder)
	orders.GET("", ListAppPaymentOrders)
	orders.GET("/:id", GetAppPaymentOrder)
	orders.POST("/:id/cancel", CancelAppPaymentOrder)
	orders.POST("/:id/refund", RefundAppPaymentOrder)
	checkout := api.Group("/checkout", middleware.PaymentSessionAuth(common.RoleCommonUser))
	checkout.GET("/:id", GetAppPaymentCheckout)
	checkout.GET("/:id/status", GetAppPaymentCheckoutStatus)
	checkout.POST("/:id/confirm", middleware.AppPaymentOriginGuard(), ConfirmAppPaymentCheckout)
	api.GET("/self/orders", middleware.UserAuth(), ListSelfAppPaymentOrders)
	apps := api.Group("/applications")
	apps.GET("", middleware.RootAuth(), ListAppPaymentApplications)
	apps.GET("/:client_id", middleware.RootAuth(), GetAppPaymentApplication)
	apps.GET("/:client_id/orders", middleware.RootAuth(), ListManagedAppPaymentOrders)
	apps.GET("/:client_id/events", middleware.RootAuth(), ListAppPaymentWebhookEvents)
	writes := apps.Group("", middleware.PaymentSessionAuth(common.RoleRootUser), middleware.AppPaymentOriginGuard())
	writes.PUT("/:client_id", SaveAppPaymentApplication)
	writes.POST("/:client_id/rotate-secret", RotateAppPaymentWebhookSecret)
	writes.POST("/:client_id/events/:event_id/retry", RetryAppPaymentWebhookEvent)
	return f
}
func (f *appPaymentHTTPFixture) request(t *testing.T, method, path, auth, origin string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var raw []byte
	var err error
	switch value := body.(type) {
	case string:
		raw = []byte(value)
	case nil:
	default:
		raw, err = common.Marshal(body)
		require.NoError(t, err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	recorder := httptest.NewRecorder()
	f.r.ServeHTTP(recorder, req)
	var result map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &result), recorder.Body.String())
	return recorder, result
}
func (f *appPaymentHTTPFixture) basic() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(f.client.ClientId+":"+f.secret))
}
func (f *appPaymentHTTPFixture) create(t *testing.T, trade string) string {
	t.Helper()
	r, data := f.request(t, "POST", "/api/payments/orders", f.basic(), "", map[string]any{"out_trade_no": trade, "title": "测试订单", "amount": 50, "currency": "USD", "return_url": "https://rp.example.com/cb", "expires_in": 1800})
	require.Equal(t, 201, r.Code, r.Body.String())
	return data["data"].(map[string]any)["id"].(string)
}
func (f *appPaymentHTTPFixture) nonce(t *testing.T, id, browser string) string {
	t.Helper()
	r, data := f.request(t, "GET", "/api/payments/checkout/"+id, "Bearer "+browser, "", nil)
	require.Equal(t, 200, r.Code, r.Body.String())
	d := data["data"].(map[string]any)
	balance := d["balance"].(map[string]any)
	assert.IsType(t, "", balance["available_display"])
	assert.IsType(t, "", balance["required_display"])
	return d["confirmation_nonce"].(string)
}

func TestAppPaymentHTTPBasicAuthAndIdempotency(t *testing.T) {
	f := newAppPaymentHTTPFixture(t)
	id := f.create(t, "idem")
	body := map[string]any{"out_trade_no": "idem", "title": "测试订单", "amount": 50, "currency": "USD", "return_url": "https://rp.example.com/cb", "expires_in": 1800}
	// Idempotency compares the requested lifetime, never a recomputed timestamp.
	require.NoError(t, model.DB.Model(&model.PaymentOrder{}).Where("id = ?", id).Update("expires_at", time.Now().Add(20*time.Minute).Unix()).Error)
	r, data := f.request(t, "POST", "/api/payments/orders", f.basic(), "", body)
	require.Equal(t, 200, r.Code, r.Body.String())
	assert.Equal(t, id, data["data"].(map[string]any)["id"])
	second := &model.OauthClient{ClientId: "second-payment-client", Name: "Second app", Enabled: true, Scopes: "wallet:read"}
	require.NoError(t, second.SetRedirectUris([]string{"https://second.example/callback"}))
	secondSecret, err := second.GenerateOauthClientSecret()
	require.NoError(t, err)
	require.NoError(t, model.CreateOauthClient(second))
	require.NoError(t, model.SavePaymentApplication(&model.PaymentApplication{ClientID: second.ClientId, Enabled: true, Methods: `["balance"]`}))
	secondAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte(second.ClientId+":"+secondSecret))
	for _, suffix := range []string{"", "/cancel", "/refund"} {
		method := "POST"
		if suffix == "" {
			method = "GET"
		}
		r, _ = f.request(t, method, "/api/payments/orders/"+id+suffix, secondAuth, "", nil)
		assert.Equal(t, 404, r.Code)
	}

	body["amount"] = 51
	r, _ = f.request(t, "POST", "/api/payments/orders", f.basic(), "", body)
	assert.Equal(t, 409, r.Code)
	for _, auth := range []string{"", "Bearer " + f.browser, "Bearer " + f.oauth, "Basic " + base64.StdEncoding.EncodeToString([]byte(f.client.ClientId+":wrong"))} {
		r, _ = f.request(t, "GET", "/api/payments/orders", auth, "", nil)
		assert.Equal(t, 401, r.Code)
	}
	require.NoError(t, model.DB.Model(f.client).Update("enabled", false).Error)
	r, _ = f.request(t, "GET", "/api/payments/orders", f.basic(), "", nil)
	assert.Equal(t, 403, r.Code)
	require.NoError(t, model.DB.Model(f.client).Updates(map[string]any{"enabled": true, "is_public": true}).Error)
	r, _ = f.request(t, "GET", "/api/payments/orders", f.basic(), "", nil)
	assert.Equal(t, 401, r.Code)
	require.NoError(t, model.DB.Model(f.client).Update("is_public", false).Error)
	for _, raw := range []string{`{"out_trade_no":"x","title":"x","amount":1,"amount":2,"currency":"USD","return_url":"https://rp.example.com/cb"}`, `{"out_trade_no":"x","title":"x","amount":1.5,"currency":"USD","return_url":"https://rp.example.com/cb"}`, `{"out_trade_no":"x","title":"x","amount":9223372036854775808,"currency":"USD","return_url":"https://rp.example.com/cb"}`, `{"out_trade_no":"x","title":"x","amount":1,"currency":"USD","return_url":"https://rp.example.com/cb","webhook_url":"https://evil.example"}`, `{} {}`, `null`, strings.Repeat(" ", 17000) + `{}`} {
		r, _ = f.request(t, "POST", "/api/payments/orders", f.basic(), "", raw)
		assert.Equal(t, 400, r.Code, raw[:min(len(raw), 180)])
	}
	body["out_trade_no"] = "bad-redirect"
	body["return_url"] = "https://rp.example.com/cb?evil=1"
	r, _ = f.request(t, "POST", "/api/payments/orders", f.basic(), "", body)
	assert.Equal(t, 400, r.Code)
}
func TestAppPaymentHTTPBalanceNonceOwnershipAndRefund(t *testing.T) {
	f := newAppPaymentHTTPFixture(t)
	id := f.create(t, "balance")
	otherID := f.create(t, "other-order")
	nonce := f.nonce(t, id, f.browser)
	confirm := map[string]any{"method": "balance", "confirmation_nonce": nonce}
	r, _ := f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", "Bearer "+f.browser, "https://evil.example", confirm)
	assert.Equal(t, 403, r.Code)
	r, _ = f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", "Bearer "+f.otherBrowser, "http://example.com", confirm)
	assert.Equal(t, 400, r.Code)
	r, _ = f.request(t, "POST", "/api/payments/checkout/"+otherID+"/confirm", "Bearer "+f.browser, "http://example.com", confirm)
	assert.Equal(t, 400, r.Code)
	identity, err := service.ParseAccessToken(f.browser)
	require.NoError(t, err)
	replacement, _, err := service.IssueAccessToken(identity)
	require.NoError(t, err)
	r, _ = f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", "Bearer "+replacement, "http://example.com", confirm)
	assert.Equal(t, 400, r.Code, "another access-token JTI in the same session must obtain a fresh confirmation")

	for _, auth := range []string{"Bearer " + f.oauth, f.basic()} {
		r, _ = f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", auth, "http://example.com", confirm)
		assert.Equal(t, 401, r.Code)
	}
	f.user.SetAccessToken("0123456789abcdef0123456789abcdef")
	require.NoError(t, model.DB.Model(f.user).Update("access_token", f.user.GetAccessToken()).Error)
	r, _ = f.request(t, "GET", "/api/payments/checkout/"+id, "Bearer "+f.user.GetAccessToken(), "", nil)
	assert.Equal(t, 401, r.Code)
	for i := 0; i < 2; i++ {
		r, data := f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", "Bearer "+f.browser, "http://example.com", confirm)
		require.Equal(t, 200, r.Code, r.Body.String())
		order := data["data"].(map[string]any)["order"].(map[string]any)
		assert.Equal(t, "paid", order["status"])
		assert.NotContains(t, order, "balance_state")
		assert.NotContains(t, order, "payment_data")
		assert.NotContains(t, order, "refund_id")
	}
	quota, err := model.GetUserQuota(f.user.Id, true)
	require.NoError(t, err)
	assert.Equal(t, 250000, quota)
	var events int64
	require.NoError(t, model.DB.Model(&model.PaymentWebhookEvent{}).Where("order_id = ?", id).Count(&events).Error)
	assert.EqualValues(t, 1, events)
	r, _ = f.request(t, "GET", "/api/payments/checkout/"+id, "Bearer "+f.otherBrowser, "", nil)
	assert.Equal(t, 404, r.Code)
	r, _ = f.request(t, "POST", "/api/payments/orders/"+id+"/cancel", f.basic(), "", nil)
	assert.Equal(t, 409, r.Code)
	r, _ = f.request(t, "POST", "/api/payments/orders/"+id+"/refund", f.basic(), "", map[string]any{"amount": 1})
	assert.Equal(t, 400, r.Code)
	for i := 0; i < 2; i++ {
		r, data := f.request(t, "POST", "/api/payments/orders/"+id+"/refund", f.basic(), "", nil)
		require.Equal(t, 200, r.Code, r.Body.String())
		assert.Equal(t, "refunded", data["data"].(map[string]any)["status"])
	}
	quota, err = model.GetUserQuota(f.user.Id, true)
	require.NoError(t, err)
	assert.Equal(t, 500000, quota)
	require.NoError(t, model.DB.Model(&model.PaymentWebhookEvent{}).Where("order_id = ?", id).Count(&events).Error)
	assert.EqualValues(t, 2, events)
	r, data := f.request(t, "GET", "/api/payments/self/orders", "Bearer "+f.oauth, "", nil)
	require.Equal(t, 200, r.Code, r.Body.String())
	assert.EqualValues(t, 1, data["data"].(map[string]any)["total"])
	r, data = f.request(t, "GET", "/api/payments/self/orders", "Bearer "+f.otherBrowser, "", nil)
	require.Equal(t, 200, r.Code, r.Body.String())
	assert.EqualValues(t, 0, data["data"].(map[string]any)["total"])
}
func TestAppPaymentHTTPDisabledSessionExpiredAndConflictingMethod(t *testing.T) {
	f := newAppPaymentHTTPFixture(t)
	id := f.create(t, "disabled")
	nonce := f.nonce(t, id, f.browser)
	body := map[string]any{"method": "balance", "confirmation_nonce": nonce}
	require.NoError(t, model.DB.Model(f.user).Update("status", common.UserStatusDisabled).Error)
	r, _ := f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", "Bearer "+f.browser, "http://example.com", body)
	assert.NotEqual(t, 200, r.Code)
	require.NoError(t, model.DB.Model(f.user).Update("status", common.UserStatusEnabled).Error)
	require.NoError(t, model.DB.Model(&model.PaymentOrder{}).Where("id = ?", id).Update("expires_at", time.Now().Add(-time.Second).Unix()).Error)
	r, _ = f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", "Bearer "+f.browser, "http://example.com", body)
	assert.Equal(t, 400, r.Code)
	id = f.create(t, "locked-method")
	nonce = f.nonce(t, id, f.browser)
	body["confirmation_nonce"] = nonce
	require.NoError(t, model.DB.Model(&model.PaymentOrder{}).Where("id = ?", id).Updates(map[string]any{"status": model.AppPaymentProcessing, "payment_method": "stripe", "provider": "stripe", "payer_user_id": f.user.Id}).Error)
	r, _ = f.request(t, "POST", "/api/payments/checkout/"+id+"/confirm", "Bearer "+f.browser, "http://example.com", body)
	assert.Equal(t, 409, r.Code)
	quota, err := model.GetUserQuota(f.user.Id, true)
	require.NoError(t, err)
	assert.Equal(t, 500000, quota)
}
func TestAppPaymentHTTPRootSettingsSecretAndReadScopes(t *testing.T) {
	f := newAppPaymentHTTPFixture(t)
	path := "/api/payments/applications/" + f.client.ClientId
	r, _ := f.request(t, "GET", path, "Bearer "+f.browser, "", nil)
	assert.Equal(t, 403, r.Code)
	r, data := f.request(t, "GET", path, "Bearer "+f.rootBrowser, "", nil)
	require.Equal(t, 200, r.Code, r.Body.String())
	assert.NotContains(t, data["data"], "webhook_secret")
	body := map[string]any{"enabled": true, "webhook_url": "https://merchant.example/next", "methods": []string{"balance"}}
	r, _ = f.request(t, "PUT", path, "Bearer "+f.rootBrowser, "http://evil.example", body)
	assert.Equal(t, 403, r.Code)
	r, _ = f.request(t, "PUT", path, "Bearer "+f.oauth, "http://example.com", body)
	assert.Equal(t, 401, r.Code)
	body["webhook_url"] = "http://127.0.0.1/hook"
	r, _ = f.request(t, "PUT", path, "Bearer "+f.rootBrowser, "http://example.com", body)
	assert.Equal(t, 400, r.Code)
	body["webhook_url"] = "https://merchant.example/next"
	r, data = f.request(t, "PUT", path, "Bearer "+f.rootBrowser, "http://example.com", body)
	require.Equal(t, 200, r.Code, r.Body.String())
	assert.NotContains(t, data["data"], "webhook_secret")
	r, data = f.request(t, "POST", path+"/rotate-secret", "Bearer "+f.rootBrowser, "http://example.com", nil)
	require.Equal(t, 200, r.Code, r.Body.String())
	secret := data["data"].(map[string]any)["webhook_secret"].(string)
	assert.True(t, strings.HasPrefix(secret, "pwh_"))
	app, err := model.GetPaymentApplication(f.client.ClientId)
	require.NoError(t, err)
	decoded, err := model.DecryptAppPaymentWebhookSecret(f.client.ClientId, app.WebhookSecret)
	require.NoError(t, err)
	assert.Equal(t, secret, decoded)
	assert.NotEqual(t, secret, app.WebhookSecret)
	r, data = f.request(t, "GET", path, "Bearer "+f.rootBrowser, "", nil)
	require.Equal(t, 200, r.Code)
	assert.NotContains(t, r.Body.String(), secret)
	assert.NotContains(t, data["data"], "webhook_secret")
}

func TestAppPaymentHTTPHostedRootConfigurationAndSecretReceipt(t *testing.T) {
	f := newAppPaymentHTTPFixture(t)
	require.NoError(t, model.DB.AutoMigrate(&model.TwoFA{}, &model.PasskeyCredential{}))
	var root model.User
	require.NoError(t, model.DB.Where("username = ?", "payment-root").First(&root).Error)
	password, err := common.Password2Hash("PaymentRootPassword123")
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&root).Update("password", password).Error)
	tokens, err := service.IssueOAuthTokens(f.client, &root, []string{"billing:read", "billing:write"}, []string{service.OAuthResourceDashboard}, "")
	require.NoError(t, err)
	routes := f.r.Group("/api/oauth2", middleware.UserAuth())
	routes.POST("/actions", CreateOAuthAction)
	routes.GET("/actions/:id/approval", GetOAuthActionApproval)
	routes.POST("/actions/:id/approve", ApproveOAuthAction)
	routes.POST("/actions/:id/steps/:step", ExecuteOAuthActionStep)
	routes.POST("/actions/:id/claim", ClaimOAuthActionResult)
	f.r.GET("/api/oauth2/actions/:id", GetOAuthAction)
	r, data := f.request(t, "GET", "/api/payments/applications/"+f.client.ClientId, "Bearer "+tokens.AccessToken, "", nil)
	require.Equal(t, 200, r.Code, r.Body.String())
	assert.NotContains(t, data["data"], "webhook_secret")
	for _, operation := range []string{"app_payment.configure", "app_payment.rotate_secret"} {
		params := map[string]any{"client_id": f.client.ClientId}
		if operation == "app_payment.configure" {
			params["enabled"] = true
			params["webhook_url"] = "https://merchant.example/hosted"
			params["methods"] = []string{"balance"}
		}
		r, data = f.request(t, "POST", "/api/oauth2/actions", "Bearer "+tokens.AccessToken, "", map[string]any{"operation": operation, "parameters": params, "share_result": false})
		require.Equal(t, 201, r.Code, r.Body.String())
		action := data["data"].(map[string]any)
		base := "/api/oauth2/actions/" + action["action_id"].(string)
		receipt := action["receipt_token"].(string)
		r, data = f.request(t, "GET", base+"/approval", "Bearer "+f.rootBrowser, "http://example.com", nil)
		require.Equal(t, 200, r.Code, r.Body.String())
		nonce := data["data"].(map[string]any)["approval_nonce"].(string)
		r, _ = f.request(t, "POST", base+"/approve", "Bearer "+f.rootBrowser, "http://example.com", map[string]any{"approval_nonce": nonce, "verification_password": "PaymentRootPassword123"})
		require.Equal(t, 200, r.Code, r.Body.String())
		r, data = f.request(t, "POST", base+"/steps/execute", "Bearer "+f.rootBrowser, "http://example.com", map[string]any{"approval_nonce": nonce})
		require.Equal(t, 200, r.Code, r.Body.String())
		assert.Equal(t, "completed", data["action_status"])
		secret := ""
		if operation == "app_payment.rotate_secret" {
			secret = data["data"].(map[string]any)["webhook_secret"].(string)
			require.NotEmpty(t, secret)
		}
		var stored model.OAuthAction
		require.NoError(t, model.DB.Where("id = ?", action["action_id"]).First(&stored).Error)
		assert.Empty(t, stored.ResultCiphertext)
		r, _ = f.request(t, "GET", base, "Bearer "+receipt, "", nil)
		require.Equal(t, 200, r.Code, r.Body.String())
		assert.NotContains(t, r.Body.String(), "webhook_secret")
		if secret != "" {
			assert.NotContains(t, r.Body.String(), secret)
		}
		r, _ = f.request(t, "POST", base+"/claim", "Bearer "+tokens.AccessToken, "", map[string]any{"receipt_token": receipt})
		assert.Equal(t, 403, r.Code)
	}
}
