package controller

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stripe/stripe-go/v81"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
)

// Called only after the existing Stripe signature verification. Application
// orders have a separate namespace and must never fall through to TopUp.
func dispatchStripeAppPayment(c *gin.Context, event stripe.Event) bool {
	id := event.GetObjectValue("client_reference_id")
	if !strings.HasPrefix(id, "ap_") {
		return false
	}
	order, err := model.GetAppPaymentOrder(id)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return true
	}
	if event.Type != stripe.EventTypeCheckoutSessionCompleted && event.Type != stripe.EventTypeCheckoutSessionAsyncPaymentSucceeded && event.Type != stripe.EventTypeCheckoutSessionExpired && event.Type != stripe.EventTypeCheckoutSessionAsyncPaymentFailed {
		c.Status(http.StatusOK)
		return true
	}
	var checkout stripe.CheckoutSession
	if common.Unmarshal(event.Data.Raw, &checkout) != nil {
		c.Status(http.StatusBadRequest)
		return true
	}
	if service.ValidateAppPaymentMerchant(c.Request.Context(), order) != nil {
		c.Status(http.StatusServiceUnavailable)
		return true
	}
	if event.Account != "" && event.Account != order.ProviderMerchantID {
		c.Status(http.StatusBadRequest)
		return true
	}
	result, err := service.ValidateStripeAppPayment(order, &checkout)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return true
	}
	if result.Status == "paid" {
		_, _, err = model.CompleteAppPaymentProvider(id, "stripe", result.ProviderTradeNo, result.Amount, result.Currency)
		if err != nil {
			c.Status(http.StatusServiceUnavailable)
			return true
		}
	} else if result.Status == "expired" {
		if model.MarkAppPaymentProviderExpired(id, "stripe") != nil {
			c.Status(http.StatusServiceUnavailable)
			return true
		}
	}
	c.Status(http.StatusOK)
	return true
}

func appWeChatWebhookEnabled() bool {
	for _, method := range service.AppPaymentMethods("CNY") {
		if method.ID == "wechatpay" {
			return true
		}
	}
	return false
}

func dispatchWeChatAppPayment(c *gin.Context, transaction *payments.Transaction) bool {
	if transaction == nil || transaction.OutTradeNo == nil || !strings.HasPrefix(*transaction.OutTradeNo, "ap_") {
		return false
	}
	order, err := model.GetAppPaymentOrder(*transaction.OutTradeNo)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "FAIL", "message": "订单不匹配"})
		return true
	}
	result, err := service.ValidateWeChatAppPayment(order, transaction)
	if err != nil || result.Status != "paid" {
		c.JSON(http.StatusBadRequest, gin.H{"code": "FAIL", "message": "交易不匹配"})
		return true
	}
	_, _, err = model.CompleteAppPaymentProvider(order.ID, "wechatpay", result.ProviderTradeNo, result.Amount, result.Currency)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": "FAIL", "message": "处理失败"})
		return true
	}
	c.Status(http.StatusNoContent)
	return true
}

func dispatchEpayAppPayment(c *gin.Context, params map[string]string) bool {
	id := params["out_trade_no"]
	if !strings.HasPrefix(id, "ap_") {
		return false
	}
	order, err := model.GetAppPaymentOrder(id)
	if err != nil {
		c.String(http.StatusOK, "fail")
		return true
	}
	result, err := service.ValidateEpayAppPayment(order, params)
	if err != nil {
		c.String(http.StatusOK, "fail")
		return true
	}
	_, _, err = model.CompleteAppPaymentProvider(id, "epay", result.ProviderTradeNo, result.Amount, result.Currency)
	if err != nil {
		c.String(http.StatusOK, "fail")
		return true
	}
	c.String(http.StatusOK, "success")
	return true
}
