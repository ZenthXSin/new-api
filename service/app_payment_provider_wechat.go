package service

import (
	"context"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
	"github.com/wechatpay-apiv3/wechatpay-go/services/refunddomestic"
)

func createWeChatAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentCheckout, error) {
	if order.Currency != "CNY" {
		return nil, ErrAppPaymentProviderUnsupported
	}
	client, err := newWeChatPayServiceWithHTTPClient(appPaymentHTTPClient)
	if err != nil {
		return nil, err
	}
	codeURL, err := client.createNativeTransaction(ctx, order.Amount, order.ID, setting.WeChatPayNotifyURL, time.Unix(order.ExpiresAt, 0), "Application payment")
	if err != nil {
		return nil, err
	}
	return &AppPaymentCheckout{Method: order.PaymentMethod, Provider: "wechatpay", CodeURL: codeURL, ProviderID: order.ID}, nil
}

func ValidateWeChatAppPayment(order *model.PaymentOrder, transaction *payments.Transaction) (*AppPaymentProviderResult, error) {
	if !validAppPaymentOrder(order) || order.Provider != "wechatpay" || order.ProviderMerchantID != setting.WeChatPayAppID+":"+setting.WeChatPayMerchantID || transaction == nil || transaction.Appid == nil || *transaction.Appid != setting.WeChatPayAppID || transaction.Mchid == nil || *transaction.Mchid != setting.WeChatPayMerchantID || transaction.OutTradeNo == nil || *transaction.OutTradeNo != order.ID || transaction.Amount == nil || transaction.Amount.Total == nil || *transaction.Amount.Total != order.Amount || transaction.Amount.Currency == nil || *transaction.Amount.Currency != order.Currency || transaction.TradeState == nil {
		return nil, ErrAppPaymentProviderMismatch
	}
	result := &AppPaymentProviderResult{Status: "processing", Amount: order.Amount, Currency: order.Currency}
	switch *transaction.TradeState {
	case "SUCCESS":
		if transaction.TransactionId == nil || strings.TrimSpace(*transaction.TransactionId) == "" || transaction.TradeType == nil || *transaction.TradeType != "NATIVE" {
			return nil, ErrAppPaymentProviderMismatch
		}
		result.Status = "paid"
		result.ProviderTradeNo = *transaction.TransactionId
	case "CLOSED", "REVOKED":
		result.Status = "expired"
	case "PAYERROR":
		result.Status = "failed"
	}
	return result, nil
}

func queryWeChatAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentProviderResult, error) {
	client, err := newWeChatPayServiceWithHTTPClient(appPaymentHTTPClient)
	if err != nil {
		return nil, err
	}
	transaction, err := client.QueryOrderByOutTradeNo(ctx, order.ID)
	if err != nil {
		return nil, err
	}
	return ValidateWeChatAppPayment(order, transaction)
}

func refundWeChatAppPayment(ctx context.Context, order *model.PaymentOrder) (*AppPaymentRefundResult, error) {
	client, err := newWeChatPayServiceWithHTTPClient(appPaymentHTTPClient)
	if err != nil {
		return nil, err
	}
	var result *refunddomestic.Refund
	if order.ProviderRefundNo != "" {
		result, _, err = client.refundAPI.QueryByOutRefundNo(ctx, refunddomestic.QueryByOutRefundNoRequest{OutRefundNo: &order.RefundID})
	} else {
		result, _, err = client.refundAPI.Create(ctx, refunddomestic.CreateRequest{TransactionId: &order.ProviderTradeNo, OutRefundNo: &order.RefundID, Amount: &refunddomestic.AmountReq{Refund: &order.Amount, Total: &order.Amount, Currency: &order.Currency}})
	}
	if err != nil {
		return nil, err
	}
	return validateWeChatAppPaymentRefund(order, result)
}

func queryWeChatAppPaymentRefund(ctx context.Context, order *model.PaymentOrder) (*AppPaymentRefundResult, error) {
	client, err := newWeChatPayServiceWithHTTPClient(appPaymentHTTPClient)
	if err != nil {
		return nil, err
	}
	result, _, err := client.refundAPI.QueryByOutRefundNo(ctx, refunddomestic.QueryByOutRefundNoRequest{OutRefundNo: &order.RefundID})
	if err != nil {
		return nil, err
	}
	return validateWeChatAppPaymentRefund(order, result)
}

func validateWeChatAppPaymentRefund(order *model.PaymentOrder, result *refunddomestic.Refund) (*AppPaymentRefundResult, error) {
	if result == nil || result.RefundId == nil || *result.RefundId == "" || result.OutRefundNo == nil || *result.OutRefundNo != order.RefundID || result.OutTradeNo == nil || *result.OutTradeNo != order.ID || result.TransactionId == nil || *result.TransactionId != order.ProviderTradeNo || result.Amount == nil || result.Amount.Total == nil || *result.Amount.Total != order.Amount || result.Amount.Refund == nil || *result.Amount.Refund != order.Amount || result.Amount.Currency == nil || *result.Amount.Currency != order.Currency || result.Status == nil {
		return nil, ErrAppPaymentProviderMismatch
	}
	status := "refunding"
	if *result.Status == refunddomestic.STATUS_SUCCESS {
		status = "refunded"
	}
	if *result.Status == refunddomestic.STATUS_CLOSED || *result.Status == refunddomestic.STATUS_ABNORMAL {
		status = "failed"
	}
	return &AppPaymentRefundResult{Status: status, ProviderRefundNo: *result.RefundId}, nil
}
