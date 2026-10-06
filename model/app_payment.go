package model

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	AppPaymentPending             = "pending"
	AppPaymentProcessing          = "processing"
	AppPaymentPaid                = "paid"
	AppPaymentCanceled            = "canceled"
	AppPaymentExpired             = "expired"
	AppPaymentRefundPending       = "refunding"
	AppPaymentRefunded            = "refunded"
	AppPaymentMaxAmount     int64 = 100_000_000
)

var (
	ErrAppPaymentInvalid        = errors.New("invalid application payment")
	ErrAppPaymentConflict       = errors.New("application payment conflicts with existing order")
	ErrAppPaymentState          = errors.New("application payment state does not allow this operation")
	ErrAppPaymentDisabled       = errors.New("application payments are disabled")
	ErrAppPaymentInsufficient   = errors.New("wallet balance is insufficient")
	ErrAppPaymentBalancePending = errors.New("wallet payment reconciliation is pending")
)

type PaymentApplication struct {
	ID            int    `json:"id" gorm:"primaryKey"`
	ClientID      string `json:"client_id" gorm:"type:varchar(64);not null;unique"`
	Enabled       bool   `json:"enabled" gorm:"not null"`
	WebhookURL    string `json:"webhook_url" gorm:"type:text"`
	WebhookSecret string `json:"-" gorm:"type:text"`
	Methods       string `json:"-" gorm:"type:text;not null"`
	CreatedAt     int64  `json:"created_at" gorm:"type:bigint;not null"`
	UpdatedAt     int64  `json:"updated_at" gorm:"type:bigint;not null"`
}

type PaymentOrder struct {
	ID                 string  `json:"id" gorm:"type:varchar(32);primaryKey"`
	ClientID           string  `json:"client_id" gorm:"type:varchar(64);not null;uniqueIndex:uk_app_payment_trade,priority:1;index"`
	OutTradeNo         string  `json:"out_trade_no" gorm:"type:varchar(128);not null;uniqueIndex:uk_app_payment_trade,priority:2"`
	Amount             int64   `json:"amount" gorm:"type:bigint;not null"`
	Currency           string  `json:"currency" gorm:"type:varchar(3);not null"`
	Title              string  `json:"title" gorm:"type:varchar(256);not null"`
	ReturnURL          string  `json:"return_url" gorm:"type:text"`
	ExpiresIn          int     `json:"expires_in" gorm:"not null"`
	ExpiresAt          int64   `json:"expires_at" gorm:"type:bigint;not null;index"`
	PayerUserID        int     `json:"payer_user_id" gorm:"index"`
	Status             string  `json:"status" gorm:"type:varchar(24);not null;index"`
	PaymentMethod      string  `json:"payment_method" gorm:"type:varchar(32)"`
	Provider           string  `json:"provider" gorm:"type:varchar(32)"`
	ProviderTradeNo    string  `json:"-" gorm:"type:varchar(128)"`
	ProviderMerchantID string  `json:"-" gorm:"type:varchar(512)"`
	ProviderTradeHash  *string `json:"-" gorm:"type:varchar(64);unique"`
	PaymentData        string  `json:"-" gorm:"type:text"`
	NextCheckAt        int64   `json:"-" gorm:"type:bigint;not null;index"`
	ProviderExpiresAt  int64   `json:"-" gorm:"type:bigint"`
	BalanceQuota       int     `json:"balance_quota" gorm:"type:bigint"`
	ExchangeRate       string  `json:"exchange_rate" gorm:"type:varchar(64)"`
	BalanceState       string  `json:"balance_state" gorm:"type:varchar(32)"`
	RefundID           string  `json:"refund_id" gorm:"type:varchar(32)"`
	ProviderRefundNo   string  `json:"-" gorm:"type:varchar(128)"`
	PaidAt             int64   `json:"paid_at" gorm:"type:bigint"`
	RefundedAt         int64   `json:"refunded_at" gorm:"type:bigint"`
	CreatedAt          int64   `json:"created_at" gorm:"type:bigint;not null;index"`
	UpdatedAt          int64   `json:"updated_at" gorm:"type:bigint;not null"`
}

type PaymentWebhookEvent struct {
	ID              int64  `json:"-" gorm:"primaryKey"`
	EventID         string `json:"id" gorm:"type:varchar(64);not null;unique"`
	ClientID        string `json:"client_id" gorm:"type:varchar(64);not null;index"`
	OrderID         string `json:"order_id" gorm:"type:varchar(32);not null"`
	EventType       string `json:"type" gorm:"type:varchar(32);not null"`
	Payload         string `json:"-" gorm:"type:text;not null"`
	WebhookURL      string `json:"-" gorm:"type:text;not null"`
	SecretEncrypted string `json:"-" gorm:"type:text;not null"`
	Attempts        int    `json:"attempts" gorm:"not null"`
	NextAttemptAt   int64  `json:"next_attempt_at" gorm:"type:bigint;not null;index"`
	LeaseToken      string `json:"-" gorm:"type:varchar(64)"`
	LeaseUntil      int64  `json:"-" gorm:"type:bigint;not null"`
	DeliveredAt     int64  `json:"delivered_at" gorm:"type:bigint;not null"`
	LastError       string `json:"last_error" gorm:"type:varchar(512)"`
	CreatedAt       int64  `json:"created_at" gorm:"type:bigint;not null"`
}

// Public explicitly excludes processor credentials and private checkout data.
func (o *PaymentOrder) Public() map[string]any {
	return map[string]any{"id": o.ID, "client_id": o.ClientID, "out_trade_no": o.OutTradeNo, "amount": o.Amount, "currency": o.Currency, "title": o.Title, "return_url": o.ReturnURL, "expires_at": o.ExpiresAt, "payer_user_id": o.PayerUserID, "status": o.Status, "payment_method": o.PaymentMethod, "created_at": o.CreatedAt, "updated_at": o.UpdatedAt, "paid_at": o.PaidAt, "refunded_at": o.RefundedAt}
}

func EncryptAppPaymentWebhookSecret(clientID, plaintext string) (string, error) {
	return common.EncryptSecret(plaintext, "app_payment_webhook:"+clientID)
}
func DecryptAppPaymentWebhookSecret(clientID, ciphertext string) (string, error) {
	return common.DecryptSecret(ciphertext, "app_payment_webhook:"+clientID)
}
func appPaymentRandomID(prefix string) (string, error) {
	var data [14]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(data[:]), nil
}
func (a *PaymentApplication) PaymentMethods() []string {
	var methods []string
	_ = common.Unmarshal([]byte(a.Methods), &methods)
	return methods
}
func (a *PaymentApplication) AllowsMethod(method string) bool {
	for _, allowed := range a.PaymentMethods() {
		if method == allowed {
			return true
		}
	}
	return false
}
func GetPaymentApplication(clientID string) (*PaymentApplication, error) {
	var app PaymentApplication
	err := DB.Where("client_id = ?", clientID).First(&app).Error
	return &app, err
}
func ListPaymentApplications() ([]PaymentApplication, error) {
	var apps []PaymentApplication
	err := DB.Order("id DESC").Find(&apps).Error
	return apps, err
}
func SavePaymentApplication(app *PaymentApplication) error {
	if app == nil || app.ClientID == "" {
		return ErrAppPaymentInvalid
	}
	client, err := GetOauthClientByClientId(app.ClientID)
	if err != nil {
		return err
	}
	if client.IsPublic || !client.Enabled {
		return ErrAppPaymentDisabled
	}
	methods := app.PaymentMethods()
	if len(methods) == 0 || len(methods) > 8 {
		return ErrAppPaymentInvalid
	}
	seen := map[string]bool{}
	for _, m := range methods {
		switch m {
		case "balance", "stripe", "wechatpay":
		default:
			if !strings.HasPrefix(m, "epay_") || len(m) > 32 || len(m) < 6 || strings.ContainsAny(m, " /\\\t\r\n") {
				return ErrAppPaymentInvalid
			}
		}
		if seen[m] {
			return ErrAppPaymentInvalid
		}
		seen[m] = true
	}
	if app.WebhookURL != "" {
		u, e := url.Parse(app.WebhookURL)
		if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || len(app.WebhookURL) > 2048 {
			return ErrAppPaymentInvalid
		}
		if app.WebhookSecret == "" {
			return ErrAppPaymentInvalid
		}
	}
	now := time.Now().Unix()
	app.UpdatedAt = now
	return DB.Transaction(func(tx *gorm.DB) error {
		var existing PaymentApplication
		err := lockForUpdate(tx).Where("client_id = ?", app.ClientID).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			app.CreatedAt = now
			return tx.Create(app).Error
		}
		if err != nil {
			return err
		}
		app.ID, app.CreatedAt = existing.ID, existing.CreatedAt
		app.WebhookSecret = existing.WebhookSecret
		return tx.Model(&existing).Updates(map[string]any{"enabled": app.Enabled, "webhook_url": app.WebhookURL, "webhook_secret": app.WebhookSecret, "methods": app.Methods, "updated_at": now}).Error
	})
}
func GetAppPaymentOrder(id string) (*PaymentOrder, error) {
	var order PaymentOrder
	err := DB.Where("id = ?", id).First(&order).Error
	return &order, err
}
func GetAppPaymentOrderByTradeNo(clientID, outTradeNo string) (*PaymentOrder, error) {
	var order PaymentOrder
	err := DB.Where("client_id = ? AND out_trade_no = ?", clientID, outTradeNo).First(&order).Error
	return &order, err
}
func ListAppPaymentOrders(clientID string, page, pageSize int) ([]PaymentOrder, int64, error) {
	page = max(page, 1)
	pageSize = min(max(pageSize, 1), 100)
	query := DB.Model(&PaymentOrder{})
	if clientID != "" {
		query = query.Where("client_id = ?", clientID)
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	var rows []PaymentOrder
	err := query.Order("created_at DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&rows).Error
	return rows, count, err
}
func CreateAppPaymentOrder(input *PaymentOrder) (*PaymentOrder, bool, error) {
	if input == nil || input.Amount <= 0 || input.Amount > AppPaymentMaxAmount || input.ClientID == "" || len(input.OutTradeNo) == 0 || len(input.OutTradeNo) > 128 || len(input.Title) == 0 || len(input.Title) > 256 || (input.Currency != "CNY" && input.Currency != "USD") {
		return nil, false, ErrAppPaymentInvalid
	}
	existing, err := GetAppPaymentOrderByTradeNo(input.ClientID, input.OutTradeNo)
	if err == nil {
		if existing.Amount != input.Amount || existing.Currency != input.Currency || existing.Title != input.Title || existing.ReturnURL != input.ReturnURL || existing.ExpiresIn != input.ExpiresIn {
			return nil, false, ErrAppPaymentConflict
		}
		return existing, true, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}
	app, err := GetPaymentApplication(input.ClientID)
	if err != nil {
		return nil, false, err
	}
	if !app.Enabled {
		return nil, false, ErrAppPaymentDisabled
	}
	client, err := GetOauthClientByClientId(input.ClientID)
	if err != nil {
		return nil, false, err
	}
	if !client.Enabled || client.IsPublic {
		return nil, false, ErrAppPaymentDisabled
	}
	if input.ReturnURL != "" && !client.HasRedirectURI(input.ReturnURL) {
		return nil, false, ErrAppPaymentInvalid
	}
	now := time.Now().Unix()
	if input.ExpiresIn <= 0 {
		input.ExpiresIn = int(input.ExpiresAt - now)
	}
	if input.ExpiresIn < 60 || input.ExpiresIn > 24*3600 {
		return nil, false, ErrAppPaymentInvalid
	}
	input.ExpiresAt = now + int64(input.ExpiresIn)
	id, err := appPaymentRandomID("ap_")
	if err != nil {
		return nil, false, err
	}
	order := &PaymentOrder{ID: id, ClientID: input.ClientID, OutTradeNo: input.OutTradeNo, Amount: input.Amount, Currency: input.Currency, Title: input.Title, ReturnURL: input.ReturnURL, ExpiresIn: input.ExpiresIn, ExpiresAt: input.ExpiresAt, Status: AppPaymentPending, CreatedAt: now, UpdatedAt: now}
	result := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(order)
	if result.Error != nil {
		return nil, false, result.Error
	}
	if result.RowsAffected == 0 {
		return CreateAppPaymentOrder(input)
	}
	return order, false, nil
}
func CancelAppPaymentOrder(clientID, id string) (*PaymentOrder, error) {
	var order PaymentOrder
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND client_id = ?", id, clientID).First(&order).Error; err != nil {
			return err
		}
		if order.Status == AppPaymentCanceled {
			return nil
		}
		if order.Status != AppPaymentPending {
			return ErrAppPaymentState
		}
		order.Status = AppPaymentCanceled
		order.UpdatedAt = time.Now().Unix()
		return tx.Model(&order).Updates(map[string]any{"status": order.Status, "updated_at": order.UpdatedAt}).Error
	})
	return &order, err
}
func BeginAppPaymentProvider(id string, payerUserID int, method, provider string) (*PaymentOrder, bool, error) {
	var order PaymentOrder
	existing := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", id).First(&order).Error; err != nil {
			return err
		}
		var client OauthClient
		if err := tx.Where("client_id = ?", order.ClientID).First(&client).Error; err != nil {
			return err
		}
		if !client.Enabled || client.IsPublic {
			return ErrAppPaymentDisabled
		}
		if order.PayerUserID != 0 && order.PayerUserID != payerUserID {
			return ErrAppPaymentConflict
		}
		if order.Status == AppPaymentProcessing && order.PaymentMethod == method && order.Provider == provider && order.PayerUserID == payerUserID {
			existing = true
			return nil
		}
		if order.Status != AppPaymentPending || order.ExpiresAt <= time.Now().Unix() {
			return ErrAppPaymentState
		}
		if payerUserID <= 0 || method == "balance" || provider == "" {
			return ErrAppPaymentInvalid
		}
		var app PaymentApplication
		if err := tx.Where("client_id = ?", order.ClientID).First(&app).Error; err != nil {
			return err
		}
		if !app.Enabled || !app.AllowsMethod(method) {
			return ErrAppPaymentDisabled
		}
		var user User
		if err := tx.Select("id", "status").First(&user, payerUserID).Error; err != nil {
			return err
		}
		if user.Status != common.UserStatusEnabled {
			return ErrAppPaymentDisabled
		}
		order.Status, order.PaymentMethod, order.Provider, order.PayerUserID, order.UpdatedAt = AppPaymentProcessing, method, provider, payerUserID, time.Now().Unix()
		return tx.Model(&order).Updates(map[string]any{"status": order.Status, "payment_method": method, "provider": provider, "payer_user_id": payerUserID, "updated_at": order.UpdatedAt}).Error
	})
	return &order, existing, err
}
func SetAppPaymentProviderMerchant(id, provider, merchantID string) error {
	if merchantID == "" || len(merchantID) > 512 {
		return ErrAppPaymentInvalid
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var order PaymentOrder
		if err := lockForUpdate(tx).Where("id = ? AND provider = ?", id, provider).First(&order).Error; err != nil {
			return err
		}
		if order.ProviderMerchantID == merchantID {
			return nil
		}
		if order.ProviderMerchantID != "" || order.Status != AppPaymentProcessing {
			return ErrAppPaymentConflict
		}
		return tx.Model(&order).Update("provider_merchant_id", merchantID).Error
	})
}
func SaveAppPaymentProviderData(id, provider, data string) error {
	if len(data) > 16384 {
		return ErrAppPaymentInvalid
	}
	var parsed any
	if common.Unmarshal([]byte(data), &parsed) != nil {
		return ErrAppPaymentInvalid
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var order PaymentOrder
		if err := lockForUpdate(tx).Where("id = ? AND provider = ?", id, provider).First(&order).Error; err != nil {
			return err
		}
		if order.PaymentData == data {
			return nil
		}
		if order.PaymentData != "" || order.Status != AppPaymentProcessing {
			return ErrAppPaymentConflict
		}
		return tx.Model(&order).Updates(map[string]any{"payment_data": data, "updated_at": time.Now().Unix()}).Error
	})
}
func CompleteAppPaymentProvider(id, provider, tradeNo string, amount int64, currency string) (*PaymentOrder, bool, error) {
	var order PaymentOrder
	already := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", id).First(&order).Error; err != nil {
			return err
		}
		if provider == "balance" || tradeNo == "" || len(tradeNo) > 128 || order.Provider != provider || order.Amount != amount || order.Currency != currency || order.ProviderMerchantID == "" {
			return ErrAppPaymentConflict
		}
		if order.Status == AppPaymentPaid || order.Status == AppPaymentRefundPending || order.Status == AppPaymentRefunded {
			if order.ProviderTradeNo != tradeNo {
				return ErrAppPaymentConflict
			}
			already = true
			return nil
		}
		if order.Status != AppPaymentProcessing {
			return ErrAppPaymentState
		}
		hash := sha256.Sum256([]byte(provider + "\x00" + order.ProviderMerchantID + "\x00" + tradeNo))
		digest := hex.EncodeToString(hash[:])
		order.Status, order.ProviderTradeNo, order.ProviderTradeHash, order.PaidAt = AppPaymentPaid, tradeNo, &digest, time.Now().Unix()
		order.UpdatedAt = order.PaidAt
		if err := tx.Model(&order).Updates(map[string]any{"status": order.Status, "provider_trade_no": tradeNo, "provider_trade_hash": digest, "paid_at": order.PaidAt, "updated_at": order.UpdatedAt}).Error; err != nil {
			return err
		}
		return insertAppPaymentWebhook(tx, &order, "payment.paid")
	})
	return &order, already, err
}
func BeginAppPaymentRefund(clientID, id string) (*PaymentOrder, bool, error) {
	var order PaymentOrder
	already := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND client_id = ?", id, clientID).First(&order).Error; err != nil {
			return err
		}
		if order.Status == AppPaymentRefundPending || order.Status == AppPaymentRefunded {
			already = true
			return nil
		}
		if order.Status != AppPaymentPaid {
			return ErrAppPaymentState
		}
		order.RefundID = "ar_" + strings.TrimPrefix(order.ID, "ap_")
		order.Status = AppPaymentRefundPending
		order.UpdatedAt = time.Now().Unix()
		return tx.Model(&order).Updates(map[string]any{"status": order.Status, "refund_id": order.RefundID, "updated_at": order.UpdatedAt}).Error
	})
	return &order, already, err
}
func CompleteAppPaymentRefund(id, provider, refundNo string) (*PaymentOrder, bool, error) {
	var order PaymentOrder
	already := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", id).First(&order).Error; err != nil {
			return err
		}
		if provider == "balance" || order.Provider != provider || refundNo == "" || len(refundNo) > 128 {
			return ErrAppPaymentConflict
		}
		if order.Status == AppPaymentRefunded {
			if order.ProviderRefundNo != refundNo {
				return ErrAppPaymentConflict
			}
			already = true
			return nil
		}
		if order.ProviderRefundNo != "" && order.ProviderRefundNo != refundNo {
			return ErrAppPaymentConflict
		}
		if order.Status != AppPaymentRefundPending {
			return ErrAppPaymentState
		}
		order.Status, order.ProviderRefundNo, order.RefundedAt = AppPaymentRefunded, refundNo, time.Now().Unix()
		order.UpdatedAt = order.RefundedAt
		if err := tx.Model(&order).Updates(map[string]any{"status": order.Status, "provider_refund_no": refundNo, "refunded_at": order.RefundedAt, "updated_at": order.UpdatedAt}).Error; err != nil {
			return err
		}
		return insertAppPaymentWebhook(tx, &order, "payment.refunded")
	})
	return &order, already, err
}
func insertAppPaymentWebhook(tx *gorm.DB, order *PaymentOrder, eventType string) error {
	var app PaymentApplication
	if err := tx.Where("client_id = ?", order.ClientID).First(&app).Error; err != nil {
		return err
	}
	if app.WebhookURL == "" {
		return nil
	}
	id, err := appPaymentRandomID("ape_")
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	payload, err := common.Marshal(map[string]any{"id": id, "type": eventType, "created_at": now, "data": order.Public()})
	if err != nil {
		return err
	}
	return tx.Create(&PaymentWebhookEvent{EventID: id, ClientID: order.ClientID, OrderID: order.ID, EventType: eventType, Payload: string(payload), WebhookURL: app.WebhookURL, SecretEncrypted: app.WebhookSecret, NextAttemptAt: now, CreatedAt: now}).Error
}

func ValidateAppPaymentOrderID(id string) bool {
	if len(id) != 31 || !strings.HasPrefix(id, "ap_") {
		return false
	}
	_, err := hex.DecodeString(id[3:])
	return err == nil
}

func (o PaymentOrder) String() string { return fmt.Sprintf("payment order %s (%s)", o.ID, o.Status) }

func GetAppPaymentApplication(clientID string) (*PaymentApplication, error) {
	return GetPaymentApplication(clientID)
}
func SaveAppPaymentApplication(app *PaymentApplication) error   { return SavePaymentApplication(app) }
func ListAppPaymentApplications() ([]PaymentApplication, error) { return ListPaymentApplications() }
func RotateAppPaymentWebhookSecret(clientID, encrypted string) error {
	if encrypted == "" {
		return ErrAppPaymentInvalid
	}
	result := DB.Model(&PaymentApplication{}).Where("client_id = ?", clientID).Updates(map[string]any{"webhook_secret": encrypted, "updated_at": time.Now().Unix()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
func ListAppPaymentUserOrders(userID, page, pageSize int) ([]PaymentOrder, int64, error) {
	if userID <= 0 {
		return nil, 0, ErrAppPaymentInvalid
	}
	page = max(page, 1)
	pageSize = min(max(pageSize, 1), 100)
	query := DB.Model(&PaymentOrder{}).Where("payer_user_id = ?", userID)
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	var rows []PaymentOrder
	err := query.Order("created_at DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&rows).Error
	return rows, count, err
}
func SaveAppPaymentRefundProviderData(id, provider, refundNo string) error {
	if refundNo == "" || len(refundNo) > 128 {
		return ErrAppPaymentInvalid
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var order PaymentOrder
		if err := lockForUpdate(tx).Where("id = ? AND provider = ?", id, provider).First(&order).Error; err != nil {
			return err
		}
		if order.ProviderRefundNo == refundNo {
			return nil
		}
		if order.Status != AppPaymentRefundPending || order.ProviderRefundNo != "" {
			return ErrAppPaymentConflict
		}
		return tx.Model(&order).Updates(map[string]any{"provider_refund_no": refundNo, "updated_at": time.Now().Unix()}).Error
	})
}
func ClaimAppPaymentProviderPoll(now time.Time, limit int) ([]PaymentOrder, error) {
	var rows []PaymentOrder
	if err := DB.Where("status IN ? AND provider IN ? AND next_check_at <= ?", []string{AppPaymentProcessing, AppPaymentRefundPending}, []string{"stripe", "wechatpay"}, now.Unix()).Order("next_check_at ASC").Limit(min(max(limit, 1), 100)).Find(&rows).Error; err != nil {
		return nil, err
	}
	claimed := make([]PaymentOrder, 0, len(rows))
	for _, order := range rows {
		res := DB.Model(&PaymentOrder{}).Where("id = ? AND status = ? AND next_check_at = ?", order.ID, order.Status, order.NextCheckAt).Update("next_check_at", now.Unix()+60)
		if res.Error != nil {
			return claimed, res.Error
		}
		if res.RowsAffected == 1 {
			order.NextCheckAt = now.Unix() + 60
			claimed = append(claimed, order)
		}
	}
	return claimed, nil
}

func PrepareAppPaymentCheckoutExpiry(id, provider string, minExpiry int64) (*PaymentOrder, error) {
	var order PaymentOrder
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND provider = ?", id, provider).First(&order).Error; err != nil {
			return err
		}
		if order.ProviderExpiresAt > 0 {
			return nil
		}
		if order.Status != AppPaymentProcessing || minExpiry <= time.Now().Unix() || minExpiry > time.Now().Unix()+24*3600 {
			return ErrAppPaymentState
		}
		order.ProviderExpiresAt = max(order.ExpiresAt, minExpiry)
		order.ExpiresAt = order.ProviderExpiresAt
		return tx.Model(&order).Updates(map[string]any{"provider_expires_at": order.ProviderExpiresAt, "expires_at": order.ExpiresAt, "updated_at": time.Now().Unix()}).Error
	})
	return &order, err
}
func MarkAppPaymentProviderExpired(id, provider string) error {
	if provider != "stripe" && provider != "wechatpay" {
		return ErrAppPaymentInvalid
	}
	return DB.Model(&PaymentOrder{}).Where("id = ? AND provider = ? AND status = ? AND paid_at = 0", id, provider, AppPaymentProcessing).Updates(map[string]any{"status": AppPaymentExpired, "updated_at": time.Now().Unix()}).Error
}
