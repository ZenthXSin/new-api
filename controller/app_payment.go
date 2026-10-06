package controller

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

func appPaymentFail(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"success": false, "code": code, "message": message})
}
func appPaymentOK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}
func appPaymentError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		appPaymentFail(c, 404, "PAYMENT_NOT_FOUND", "payment resource not found")
	case errors.Is(err, model.ErrAppPaymentInvalid):
		appPaymentFail(c, 400, "PAYMENT_INVALID_REQUEST", "invalid payment request")
	case errors.Is(err, model.ErrAppPaymentConflict):
		appPaymentFail(c, 409, "PAYMENT_IDEMPOTENCY_CONFLICT", "payment request conflicts with the existing order")
	case errors.Is(err, model.ErrAppPaymentState):
		appPaymentFail(c, 409, "PAYMENT_STATE_CONFLICT", "order state does not allow this operation")
	case errors.Is(err, model.ErrAppPaymentDisabled):
		appPaymentFail(c, 403, "PAYMENT_APP_DISABLED", "application payments are disabled")
	case errors.Is(err, model.ErrAppPaymentInsufficient):
		appPaymentFail(c, 409, "PAYMENT_INSUFFICIENT_BALANCE", "wallet balance is insufficient")
	case errors.Is(err, service.ErrAppPaymentProviderUnsupported):
		appPaymentFail(c, 409, "PAYMENT_METHOD_UNAVAILABLE", "payment method does not support this operation")
	default:
		appPaymentFail(c, 503, "PAYMENT_UNAVAILABLE", "payment service is temporarily unavailable")
	}
}
func appPaymentBody(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
	if common.DecodeJsonObjectStrict(c.Request.Body, target) != nil {
		appPaymentFail(c, 400, "PAYMENT_INVALID_REQUEST", "invalid payment request body")
		return false
	}
	return true
}
func appPaymentPage(c *gin.Context) (int, int) {
	p, _ := strconv.Atoi(c.Query("page"))
	s, _ := strconv.Atoi(c.Query("page_size"))
	if p < 1 {
		p = 1
	}
	if p > 1000000 {
		p = 1000000
	}
	if s < 1 {
		s = 20
	}
	if s > 100 {
		s = 100
	}
	return p, s
}
func appPaymentURL(id string) string {
	return strings.TrimRight(service.GetCallbackAddress(), "/") + "/payments/checkout/" + url.PathEscape(id)
}
func appPaymentPublic(order *model.PaymentOrder) map[string]any {
	result := order.Public()
	delete(result, "balance_state")
	delete(result, "refund_id")
	if order.Status == model.AppPaymentRefundPending {
		result["status"] = "refunding"
	}
	if order.Status == model.AppPaymentPending && order.ExpiresAt <= time.Now().Unix() {
		result["status"] = model.AppPaymentExpired
	}
	result["checkout_url"] = appPaymentURL(order.ID)
	return result
}
func appPaymentList(c *gin.Context, orders []model.PaymentOrder, total int64, page, size int) {
	items := make([]map[string]any, 0, len(orders))
	for i := range orders {
		items = append(items, appPaymentPublic(&orders[i]))
	}
	appPaymentOK(c, gin.H{"items": items, "total": total, "page": page, "page_size": size})
}
func appPaymentOwned(c *gin.Context) (*model.PaymentOrder, bool) {
	client, ok := middleware.AppPaymentClient(c)
	if !ok {
		appPaymentFail(c, 401, "PAYMENT_APP_AUTH_REQUIRED", "application credentials are required")
		return nil, false
	}
	order, err := model.GetAppPaymentOrder(c.Param("id"))
	if err != nil {
		appPaymentError(c, err)
		return nil, false
	}
	if order.ClientID != client.ClientId {
		appPaymentError(c, gorm.ErrRecordNotFound)
		return nil, false
	}
	return order, true
}
func CreateAppPaymentOrder(c *gin.Context) {
	client, ok := middleware.AppPaymentClient(c)
	if !ok {
		appPaymentFail(c, 401, "PAYMENT_APP_AUTH_REQUIRED", "application credentials are required")
		return
	}
	var in struct {
		OutTradeNo string `json:"out_trade_no"`
		Title      string `json:"title"`
		Amount     int64  `json:"amount"`
		Currency   string `json:"currency"`
		ReturnURL  string `json:"return_url"`
		ExpiresIn  *int64 `json:"expires_in"`
	}
	if !appPaymentBody(c, &in) {
		return
	}
	ttl := int64(1800)
	if in.ExpiresIn != nil {
		ttl = *in.ExpiresIn
	}
	if ttl < 60 || ttl > 86400 || strings.TrimSpace(in.OutTradeNo) == "" || strings.TrimSpace(in.Title) == "" || strings.ContainsAny(in.OutTradeNo, "\x00\r\n") || in.ReturnURL == "" || !client.HasRedirectURI(in.ReturnURL) {
		appPaymentError(c, model.ErrAppPaymentInvalid)
		return
	}
	order, already, err := model.CreateAppPaymentOrder(&model.PaymentOrder{ClientID: client.ClientId, OutTradeNo: in.OutTradeNo, Title: in.Title, Amount: in.Amount, Currency: in.Currency, ReturnURL: in.ReturnURL, ExpiresAt: time.Now().Unix() + ttl, ExpiresIn: int(ttl)})
	if err != nil {
		appPaymentError(c, err)
		return
	}
	status := 201
	if already {
		status = 200
	}
	c.JSON(status, gin.H{"success": true, "data": appPaymentPublic(order)})
}
func ListAppPaymentOrders(c *gin.Context) {
	client, ok := middleware.AppPaymentClient(c)
	if !ok {
		appPaymentFail(c, 401, "PAYMENT_APP_AUTH_REQUIRED", "application credentials are required")
		return
	}
	p, s := appPaymentPage(c)
	orders, total, err := model.ListAppPaymentOrders(client.ClientId, p, s)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentList(c, orders, total, p, s)
}
func GetAppPaymentOrder(c *gin.Context) {
	order, ok := appPaymentOwned(c)
	if !ok {
		return
	}
	appPaymentOK(c, appPaymentPublic(order))
}
func CancelAppPaymentOrder(c *gin.Context) {
	if !appPaymentEmptyBody(c) {
		return
	}
	order, ok := appPaymentOwned(c)
	if !ok {
		return
	}
	order, err := model.CancelAppPaymentOrder(order.ClientID, order.ID)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentOK(c, appPaymentPublic(order))
}
func RefundAppPaymentOrder(c *gin.Context) {
	if !appPaymentEmptyBody(c) {
		return
	}
	order, ok := appPaymentOwned(c)
	if !ok {
		return
	}
	if !service.SupportsAppPaymentRefund(order.PaymentMethod) {
		appPaymentError(c, service.ErrAppPaymentProviderUnsupported)
		return
	}
	order, _, err := model.BeginAppPaymentRefund(order.ClientID, order.ID)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	if order.Status == model.AppPaymentRefunded {
		appPaymentOK(c, appPaymentPublic(order))
		return
	}
	if order.PaymentMethod == "balance" {
		order, _, err = model.RefundAppPaymentBalance(order.ID)
		if errors.Is(err, model.ErrAppPaymentBalancePending) {
			updated, loadErr := model.GetAppPaymentOrder(c.Param("id"))
			if loadErr != nil || updated == nil {
				appPaymentError(c, model.ErrAppPaymentBalancePending)
				return
			}
			order = updated
			err = nil
		}
	} else {
		order, err = advanceAppPaymentRefund(c, order)
	}
	if err != nil {
		if errors.Is(err, service.ErrAppPaymentProviderUnsupported) {
			appPaymentError(c, err)
		} else {
			appPaymentFail(c, 502, "PAYMENT_PROVIDER_FAILED", "refund is pending; query the order before retrying")
		}
		return
	}
	appPaymentOK(c, appPaymentPublic(order))
}
func advanceAppPaymentRefund(c *gin.Context, order *model.PaymentOrder) (*model.PaymentOrder, error) {
	var result *service.AppPaymentRefundResult
	var err error
	if order.ProviderRefundNo != "" {
		result, err = service.QueryAppPaymentRefund(c.Request.Context(), order)
	} else {
		result, err = service.RefundAppPayment(c.Request.Context(), order)
	}
	if err != nil {
		return order, err
	}
	if result == nil {
		return order, model.ErrAppPaymentState
	}
	if result.ProviderRefundNo != "" {
		if err = model.SaveAppPaymentRefundProviderData(order.ID, order.Provider, result.ProviderRefundNo); err != nil {
			return order, err
		}
	}
	if result.Status == "refunded" {
		updated, _, e := model.CompleteAppPaymentRefund(order.ID, order.Provider, result.ProviderRefundNo)
		return updated, e
	}
	return model.GetAppPaymentOrder(order.ID)
}

func appPaymentCheckoutOrder(c *gin.Context) (*model.PaymentOrder, service.AuthIdentity, bool) {
	identity, ok := middleware.RecheckPaymentSession(c, common.RoleCommonUser)
	if !ok {
		return nil, identity, false
	}
	order, err := model.GetAppPaymentOrder(c.Param("id"))
	if err != nil {
		appPaymentError(c, err)
		return nil, identity, false
	}
	if order.PayerUserID != 0 && order.PayerUserID != identity.UserID && c.GetInt("role") < common.RoleRootUser {
		appPaymentError(c, gorm.ErrRecordNotFound)
		return nil, identity, false
	}
	return order, identity, true
}
func appPaymentMethods(app *model.PaymentApplication, currency string, quote service.AppPaymentQuote) []service.AppPaymentMethod {
	result := []service.AppPaymentMethod{}
	if !app.Enabled {
		return result
	}
	if app.AllowsMethod("balance") && quote.Quota > 0 {
		result = append(result, service.AppPaymentMethod{ID: "balance", Label: "Balance", Currency: currency, RefundSupported: true})
	}
	for _, method := range service.AppPaymentMethods(currency) {
		if method.ID != "balance" && app.AllowsMethod(method.ID) {
			result = append(result, method)
		}
	}
	return result
}
func appPaymentSavedCheckout(order *model.PaymentOrder) *service.AppPaymentCheckout {
	if order.Status != model.AppPaymentProcessing || order.PaymentData == "" {
		return nil
	}
	var payment service.AppPaymentCheckout
	if common.Unmarshal([]byte(order.PaymentData), &payment) != nil || payment.Method != order.PaymentMethod || payment.Provider != order.Provider {
		return nil
	}
	return &payment
}
func GetAppPaymentCheckout(c *gin.Context) {
	order, identity, ok := appPaymentCheckoutOrder(c)
	if !ok {
		return
	}
	app, err := model.GetPaymentApplication(order.ClientID)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	client, err := model.GetOauthClientByClientId(order.ClientID)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	quote, _ := service.QuoteAppPaymentBalance(order)
	// An in-progress debit must retain the exact quote approved on its first
	// attempt, including while the durable wallet reconciliation is pending.
	if order.Status == model.AppPaymentProcessing && order.PaymentMethod == "balance" {
		quote = service.AppPaymentQuote{Quota: order.BalanceQuota, ExchangeRate: order.ExchangeRate}
	}
	available, err := model.GetUserQuota(identity.UserID, false)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	methods := appPaymentMethods(app, order.Currency, quote)
	if !client.Enabled || client.IsPublic {
		methods = []service.AppPaymentMethod{}
	}
	display := func(quota int) string {
		if common.QuotaPerUnit <= 0 || math.IsNaN(common.QuotaPerUnit) || math.IsInf(common.QuotaPerUnit, 0) {
			return "0.00 USD"
		}
		return decimal.NewFromInt(int64(quota)).Div(decimal.NewFromFloat(common.QuotaPerUnit)).StringFixed(6) + " USD"
	}
	data := gin.H{"order": appPaymentPublic(order), "application": gin.H{"client_id": client.ClientId, "name": client.Name}, "methods": methods, "balance": gin.H{"available_quota": available, "required_quota": quote.Quota, "available_display": display(available), "required_display": display(quote.Quota), "sufficient": quote.Quota > 0 && available >= quote.Quota}}
	if payment := appPaymentSavedCheckout(order); payment != nil {
		data["payment"] = payment
	}
	if (order.Status == model.AppPaymentPending || order.Status == model.AppPaymentProcessing) && order.ExpiresAt > time.Now().Unix() && app.Enabled && client.Enabled && !client.IsPublic && order.PayerUserID != 0 && order.PayerUserID != identity.UserID {
		methods = []service.AppPaymentMethod{}
		data["methods"] = methods
	}
	if (order.Status == model.AppPaymentPending || order.Status == model.AppPaymentProcessing) && order.ExpiresAt > time.Now().Unix() && len(methods) > 0 && (order.PayerUserID == 0 || order.PayerUserID == identity.UserID) {
		nonce, expires, e := service.IssueAppPaymentConfirmation(order, identity, quote, c.GetString("app_payment_session_token_hash"), time.Now())
		if e == nil {
			data["confirmation_nonce"] = nonce
			data["confirmation_expires_at"] = expires
		}
	}
	appPaymentOK(c, data)
}
func ConfirmAppPaymentCheckout(c *gin.Context) {
	order, identity, ok := appPaymentCheckoutOrder(c)
	if !ok {
		return
	}
	if !middleware.RequireAppPaymentOrigin(c) {
		return
	}
	if order.PayerUserID != 0 && order.PayerUserID != identity.UserID {
		appPaymentFail(c, 403, "PAYMENT_FORBIDDEN", "only the payer may confirm this order")
		return
	}
	var in struct {
		Method string `json:"method"`
		Nonce  string `json:"confirmation_nonce"`
	}
	if !appPaymentBody(c, &in) {
		return
	}
	quote, err := service.VerifyAppPaymentConfirmation(in.Nonce, order, identity, c.GetString("app_payment_session_token_hash"), time.Now())
	if err != nil {
		appPaymentFail(c, 400, "PAYMENT_NONCE_INVALID", "payment confirmation is invalid or expired")
		return
	}
	app, err := model.GetPaymentApplication(order.ClientID)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	client, err := model.GetOauthClientByClientId(order.ClientID)
	if err != nil || !client.Enabled || client.IsPublic || !app.Enabled {
		appPaymentError(c, model.ErrAppPaymentDisabled)
		return
	}
	available := false
	for _, method := range appPaymentMethods(app, order.Currency, quote) {
		if method.ID == in.Method {
			available = true
			break
		}
	}
	if !available {
		appPaymentError(c, service.ErrAppPaymentProviderUnsupported)
		return
	}
	if order.Status != model.AppPaymentPending && order.PaymentMethod != in.Method {
		appPaymentError(c, model.ErrAppPaymentState)
		return
	}
	if in.Method == "balance" {
		order, _, err = model.PayAppPaymentBalance(order.ID, identity.UserID, quote.Quota, quote.ExchangeRate)
		if errors.Is(err, model.ErrAppPaymentBalancePending) {
			order, _ = model.GetAppPaymentOrder(c.Param("id"))
			if order == nil || order.Status == model.AppPaymentPending {
				appPaymentError(c, model.ErrAppPaymentBalancePending)
				return
			}
			err = nil
		}
		if err != nil {
			appPaymentError(c, err)
			return
		}
		if order == nil {
			appPaymentError(c, model.ErrAppPaymentState)
			return
		}
		appPaymentOK(c, gin.H{"order": appPaymentPublic(order)})
		return
	}
	provider := in.Method
	if strings.HasPrefix(in.Method, "epay_") {
		provider = "epay"
	}
	order, _, err = model.BeginAppPaymentProvider(order.ID, identity.UserID, in.Method, provider)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	payment, err := service.CreateAppPaymentCheckout(c.Request.Context(), order, in.Method)
	if err != nil {
		appPaymentFail(c, 502, "PAYMENT_PROVIDER_FAILED", "payment channel could not be opened; retry this method or query order status")
		return
	}
	if updated, loadErr := model.GetAppPaymentOrder(order.ID); loadErr == nil {
		order = updated
	}
	appPaymentOK(c, gin.H{"order": appPaymentPublic(order), "payment": payment})
}
func GetAppPaymentCheckoutStatus(c *gin.Context) {
	order, _, ok := appPaymentCheckoutOrder(c)
	if !ok {
		return
	}
	appPaymentOK(c, gin.H{"order": appPaymentPublic(order)})
}
func ListSelfAppPaymentOrders(c *gin.Context) {
	p, s := appPaymentPage(c)
	orders, total, err := model.ListAppPaymentUserOrders(c.GetInt("id"), p, s)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentList(c, orders, total, p, s)
}
func appPaymentRoot(c *gin.Context) bool {
	if c.GetInt("role") < common.RoleRootUser {
		appPaymentFail(c, 403, "PAYMENT_FORBIDDEN", "root access is required")
		return false
	}
	return true
}
func appPaymentRootWrite(c *gin.Context) bool {
	_, ok := middleware.RecheckPaymentSession(c, common.RoleRootUser)
	return ok && middleware.RequireAppPaymentOrigin(c)
}
func appPaymentApplicationPublic(app *model.PaymentApplication, client *model.OauthClient) gin.H {
	available := []service.AppPaymentMethod{{ID: "balance", Label: "Balance", Currency: "", RefundSupported: true}}
	for _, method := range service.AppPaymentMethods("") {
		if method.ID != "balance" {
			available = append(available, method)
		}
	}
	return gin.H{"client_id": app.ClientID, "client_name": client.Name, "enabled": app.Enabled, "webhook_url": app.WebhookURL, "methods": app.PaymentMethods(), "has_webhook_secret": app.WebhookSecret != "", "available_methods": available}
}
func appPaymentConfigClient(c *gin.Context) (*model.OauthClient, bool) {
	client, err := model.GetOauthClientByClientId(c.Param("client_id"))
	if err != nil {
		appPaymentError(c, err)
		return nil, false
	}
	if client.IsPublic {
		appPaymentError(c, model.ErrAppPaymentInvalid)
		return nil, false
	}
	return client, true
}
func ListAppPaymentApplications(c *gin.Context) {
	if !appPaymentRoot(c) {
		return
	}
	apps, err := model.ListPaymentApplications()
	if err != nil {
		appPaymentError(c, err)
		return
	}
	items := []gin.H{}
	for i := range apps {
		client, e := model.GetOauthClientByClientId(apps[i].ClientID)
		if e == nil {
			items = append(items, appPaymentApplicationPublic(&apps[i], client))
		}
	}
	appPaymentOK(c, gin.H{"items": items})
}
func GetAppPaymentApplication(c *gin.Context) {
	if !appPaymentRoot(c) {
		return
	}
	client, ok := appPaymentConfigClient(c)
	if !ok {
		return
	}
	app, err := model.GetPaymentApplication(client.ClientId)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		app = &model.PaymentApplication{ClientID: client.ClientId, Methods: "[\"balance\"]"}
	} else if err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentOK(c, appPaymentApplicationPublic(app, client))
}
func newAppPaymentWebhookSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "pwh_" + hex.EncodeToString(b[:]), nil
}
func SaveAppPaymentApplication(c *gin.Context) {
	if !appPaymentRootWrite(c) {
		return
	}
	client, ok := appPaymentConfigClient(c)
	if !ok {
		return
	}
	var in struct {
		Enabled    *bool    `json:"enabled"`
		WebhookURL string   `json:"webhook_url"`
		Methods    []string `json:"methods"`
	}
	if !appPaymentBody(c, &in) {
		return
	}
	if in.Enabled == nil || service.ValidateAppPaymentWebhookURL(in.WebhookURL) != nil {
		appPaymentError(c, model.ErrAppPaymentInvalid)
		return
	}
	app, err := model.GetPaymentApplication(client.ClientId)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		app = &model.PaymentApplication{ClientID: client.ClientId}
	} else if err != nil {
		appPaymentError(c, err)
		return
	}
	secret := ""
	if app.WebhookSecret == "" {
		secret, err = newAppPaymentWebhookSecret()
		if err == nil {
			app.WebhookSecret, err = model.EncryptAppPaymentWebhookSecret(client.ClientId, secret)
		}
		if err != nil {
			appPaymentError(c, err)
			return
		}
	}
	encoded, err := common.Marshal(in.Methods)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	app.Enabled, app.WebhookURL, app.Methods = *in.Enabled, in.WebhookURL, string(encoded)
	createdSecretCipher := app.WebhookSecret
	if err = model.SavePaymentApplication(app); err != nil {
		appPaymentError(c, err)
		return
	}
	result := appPaymentApplicationPublic(app, client)
	if secret != "" && app.WebhookSecret == createdSecretCipher {
		result["webhook_secret"] = secret
	}
	appPaymentOK(c, result)
}
func RotateAppPaymentWebhookSecret(c *gin.Context) {
	if !appPaymentEmptyBody(c) {
		return
	}
	if !appPaymentRootWrite(c) {
		return
	}
	client, ok := appPaymentConfigClient(c)
	if !ok {
		return
	}
	app, err := model.GetPaymentApplication(client.ClientId)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	secret, err := newAppPaymentWebhookSecret()
	if err == nil {
		app.WebhookSecret, err = model.EncryptAppPaymentWebhookSecret(client.ClientId, secret)
	}
	if err == nil {
		err = model.RotateAppPaymentWebhookSecret(client.ClientId, app.WebhookSecret)
	}
	if err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentOK(c, gin.H{"webhook_secret": secret})
}
func ListManagedAppPaymentOrders(c *gin.Context) {
	if !appPaymentRoot(c) {
		return
	}
	client, ok := appPaymentConfigClient(c)
	if !ok {
		return
	}
	p, s := appPaymentPage(c)
	orders, total, err := model.ListAppPaymentOrders(client.ClientId, p, s)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentList(c, orders, total, p, s)
}
func ListAppPaymentWebhookEvents(c *gin.Context) {
	if !appPaymentRoot(c) {
		return
	}
	client, ok := appPaymentConfigClient(c)
	if !ok {
		return
	}
	p, s := appPaymentPage(c)
	items, total, err := model.ListAppPaymentWebhookEvents(client.ClientId, p, s)
	if err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentOK(c, gin.H{"items": items, "total": total, "page": p, "page_size": s})
}
func RetryAppPaymentWebhookEvent(c *gin.Context) {
	if !appPaymentEmptyBody(c) {
		return
	}
	if !appPaymentRootWrite(c) {
		return
	}
	client, ok := appPaymentConfigClient(c)
	if !ok {
		return
	}
	if err := model.RetryAppPaymentWebhookEvent(client.ClientId, c.Param("event_id"), time.Now().Unix()); err != nil {
		appPaymentError(c, err)
		return
	}
	appPaymentOK(c, gin.H{"retried": true})
}

func appPaymentEmptyBody(c *gin.Context) bool {
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10))
	if err == nil && len(bytes.TrimSpace(body)) == 0 {
		return true
	}
	if err != nil || common.DecodeJsonObjectStrict(bytes.NewReader(body), &struct{}{}) != nil {
		appPaymentFail(c, 400, "PAYMENT_INVALID_REQUEST", "this operation accepts no payment amount or additional fields")
		return false
	}
	return true
}
