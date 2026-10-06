package service

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

func createEpayAppPayment(order *model.PaymentOrder) (*AppPaymentCheckout, error) {
	if order.Currency != "CNY" || !strings.HasPrefix(order.PaymentMethod, "epay_") {
		return nil, ErrAppPaymentProviderUnsupported
	}
	returnURL, err := appPaymentReturnURL(order)
	if err != nil {
		return nil, err
	}
	returnURI, _ := url.Parse(returnURL)
	notifyURI := *returnURI
	notifyURI.Path = "/api/user/epay/notify"
	client, err := epay.NewClient(&epay.Config{PartnerID: operation_setting.EpayId, Key: operation_setting.EpayKey}, operation_setting.PayAddress)
	if err != nil {
		return nil, err
	}
	money := strconv.FormatInt(order.Amount/100, 10) + "." + leftPadCents(order.Amount%100)
	address, params, err := client.Purchase(&epay.PurchaseArgs{Type: strings.TrimPrefix(order.PaymentMethod, "epay_"), ServiceTradeNo: order.ID, Name: order.Title, Money: money, Device: epay.PC, NotifyUrl: &notifyURI, ReturnUrl: returnURI})
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(address)
	if err != nil {
		return nil, err
	}
	query := u.Query()
	for key, value := range params {
		query.Set(key, value)
	}
	u.RawQuery = query.Encode()
	return &AppPaymentCheckout{Method: order.PaymentMethod, Provider: "epay", CheckoutURL: u.String(), ProviderID: order.ID}, nil
}

func leftPadCents(cents int64) string {
	if cents < 10 {
		return "0" + strconv.FormatInt(cents, 10)
	}
	return strconv.FormatInt(cents, 10)
}

func ValidateEpayAppPayment(order *model.PaymentOrder, params map[string]string) (*AppPaymentProviderResult, error) {
	if !validAppPaymentOrder(order) || order.Provider != "epay" || order.ProviderMerchantID != strings.TrimRight(operation_setting.PayAddress, "/")+":"+operation_setting.EpayId || order.Currency != "CNY" || params["pid"] != operation_setting.EpayId || params["out_trade_no"] != order.ID || params["type"] != strings.TrimPrefix(order.PaymentMethod, "epay_") || params["trade_status"] != epay.StatusTradeSuccess || strings.TrimSpace(params["trade_no"]) == "" {
		return nil, ErrAppPaymentProviderMismatch
	}
	// Parse the signed decimal amount exactly. No floating point or rounding.
	whole, fraction, hasDot := strings.Cut(params["money"], ".")
	if whole == "" || len(whole) > 10 || len(fraction) > 2 || (hasDot && fraction == "") {
		return nil, ErrAppPaymentProviderMismatch
	}
	for _, digit := range whole + fraction {
		if digit < '0' || digit > '9' {
			return nil, ErrAppPaymentProviderMismatch
		}
	}
	if len(fraction) == 0 {
		fraction = "00"
	} else if len(fraction) == 1 {
		fraction += "0"
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return nil, ErrAppPaymentProviderMismatch
	}
	f, err := strconv.ParseInt(fraction, 10, 64)
	if err != nil || w*100+f != order.Amount {
		return nil, ErrAppPaymentProviderMismatch
	}
	return &AppPaymentProviderResult{Status: "paid", ProviderTradeNo: params["trade_no"], Amount: order.Amount, Currency: "CNY"}, nil
}
