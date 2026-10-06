package service

import (
	"context"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/checkout/session"
	"github.com/stripe/stripe-go/v81/refund"
)

func appPaymentStripeSessionClient() session.Client {
	return session.Client{B: stripe.NewBackends(appPaymentHTTPClient).API, Key: setting.StripeApiSecret}
}

func createStripeAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentCheckout, error) {
	if order.ProviderExpiresAt <= 0 {
		return nil, ErrAppPaymentProviderMismatch
	}
	returnURL, err := appPaymentReturnURL(order)
	if err != nil {
		return nil, err
	}
	params := &stripe.CheckoutSessionParams{
		ClientReferenceID: stripe.String(order.ID), SuccessURL: stripe.String(returnURL), CancelURL: stripe.String(returnURL),
		Mode:              stripe.String("payment"),
		LineItems:         []*stripe.CheckoutSessionLineItemParams{{Quantity: stripe.Int64(1), PriceData: &stripe.CheckoutSessionLineItemPriceDataParams{Currency: stripe.String(strings.ToLower(order.Currency)), UnitAmount: stripe.Int64(order.Amount), ProductData: &stripe.CheckoutSessionLineItemPriceDataProductDataParams{Name: stripe.String(order.Title)}}}},
		PaymentIntentData: &stripe.CheckoutSessionPaymentIntentDataParams{Metadata: map[string]string{"app_payment_order": order.ID, "app_payment_client": order.ClientID}},
	}
	params.Context = ctx
	params.SetIdempotencyKey("app-payment-create-" + order.ID)
	params.Metadata = map[string]string{"app_payment_order": order.ID, "app_payment_client": order.ClientID}
	// Persisted before the first request: every retry must use identical
	// parameters with the same idempotency key, including the expiry.
	params.ExpiresAt = stripe.Int64(order.ProviderExpiresAt)
	result, err := appPaymentStripeSessionClient().New(params)
	if err != nil {
		return nil, err
	}
	if result == nil || result.ID == "" || result.URL == "" || result.ClientReferenceID != order.ID || result.AmountTotal != order.Amount || result.ExpiresAt != order.ProviderExpiresAt || !strings.EqualFold(string(result.Currency), order.Currency) {
		return nil, ErrAppPaymentProviderMismatch
	}
	return &AppPaymentCheckout{Method: order.PaymentMethod, Provider: "stripe", CheckoutURL: result.URL, ProviderID: result.ID}, nil
}

func ValidateStripeAppPayment(order *model.PaymentOrder, session *stripe.CheckoutSession) (*AppPaymentProviderResult, error) {
	if !validAppPaymentOrder(order) || session == nil || order.Provider != "stripe" || session.ID == "" || session.Mode != stripe.CheckoutSessionModePayment || session.ClientReferenceID != order.ID || session.Metadata["app_payment_order"] != order.ID || session.Metadata["app_payment_client"] != order.ClientID || session.AmountTotal != order.Amount || !strings.EqualFold(string(session.Currency), order.Currency) {
		return nil, ErrAppPaymentProviderMismatch
	}
	if order.PaymentData != "" {
		var checkout AppPaymentCheckout
		if common.UnmarshalJsonStr(order.PaymentData, &checkout) != nil || checkout.ProviderID != session.ID {
			return nil, ErrAppPaymentProviderMismatch
		}
	}
	result := &AppPaymentProviderResult{Status: "processing", Amount: session.AmountTotal, Currency: strings.ToUpper(string(session.Currency))}
	if session.Status == stripe.CheckoutSessionStatusExpired {
		result.Status = "expired"
		return result, nil
	}
	if session.PaymentStatus == stripe.CheckoutSessionPaymentStatusPaid {
		if session.Status != stripe.CheckoutSessionStatusComplete || session.PaymentIntent == nil || session.PaymentIntent.ID == "" {
			return nil, ErrAppPaymentProviderMismatch
		}
		result.Status = "paid"
		result.ProviderTradeNo = session.PaymentIntent.ID
	}
	return result, nil
}

func queryStripeAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentProviderResult, error) {
	var checkout AppPaymentCheckout
	if common.UnmarshalJsonStr(order.PaymentData, &checkout) != nil || checkout.ProviderID == "" {
		return nil, ErrAppPaymentProviderMismatch
	}
	params := &stripe.CheckoutSessionParams{}
	params.Context = ctx
	result, err := appPaymentStripeSessionClient().Get(checkout.ProviderID, params)
	if err != nil {
		return nil, err
	}
	return ValidateStripeAppPayment(order, result)
}

func refundStripeAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentRefundResult, error) {
	params := &stripe.RefundParams{PaymentIntent: stripe.String(order.ProviderTradeNo), Amount: stripe.Int64(order.Amount)}
	params.Context = ctx
	params.SetIdempotencyKey("app-payment-refund-" + order.RefundID)
	params.Metadata = map[string]string{"app_payment_order": order.ID, "app_payment_client": order.ClientID, "app_payment_refund": order.RefundID}
	client := refund.Client{B: stripe.NewBackends(appPaymentHTTPClient).API, Key: setting.StripeApiSecret}
	var result *stripe.Refund
	var err error
	if order.ProviderRefundNo != "" {
		p := &stripe.RefundParams{}
		p.Context = ctx
		result, err = client.Get(order.ProviderRefundNo, p)
	} else {
		// Recover a refund accepted before a network/database failure, even after
		// Stripe's idempotency-key retention period has elapsed.
		list := &stripe.RefundListParams{PaymentIntent: stripe.String(order.ProviderTradeNo)}
		list.Context = ctx
		list.Limit = stripe.Int64(100)
		iterator := client.List(list)
		for iterator.Next() {
			candidate := iterator.Refund()
			if candidate.Metadata["app_payment_refund"] == order.RefundID {
				result = candidate
				break
			}
		}
		if err = iterator.Err(); err != nil {
			return nil, err
		}
		if result == nil {
			result, err = client.New(params)
		}
	}
	if err != nil {
		return nil, err
	}
	if result == nil || result.ID == "" || result.Amount != order.Amount || !strings.EqualFold(string(result.Currency), order.Currency) || result.PaymentIntent == nil || result.PaymentIntent.ID != order.ProviderTradeNo || result.Metadata["app_payment_order"] != order.ID || result.Metadata["app_payment_client"] != order.ClientID || result.Metadata["app_payment_refund"] != order.RefundID {
		return nil, ErrAppPaymentProviderMismatch
	}
	status := "refunding"
	if result.Status == stripe.RefundStatusSucceeded {
		status = "refunded"
	}
	if result.Status == stripe.RefundStatusFailed || result.Status == stripe.RefundStatusCanceled {
		status = "failed"
	}
	return &AppPaymentRefundResult{Status: status, ProviderRefundNo: result.ID}, nil
}
