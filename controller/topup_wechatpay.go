package controller

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
)

type weChatPayRequest struct {
	Amount int64 `json:"amount" binding:"required"`
}

func newWeChatPayTradeNo() string {
	return "WX" + common.GetUUID()[:30]
}

func validateWeChatPayTransaction(transaction *payments.Transaction, expectedTradeNo string) error {
	if transaction == nil ||
		transaction.TradeState == nil || *transaction.TradeState != "SUCCESS" ||
		transaction.Appid == nil || strings.TrimSpace(*transaction.Appid) != strings.TrimSpace(setting.WeChatPayAppID) ||
		transaction.Mchid == nil || strings.TrimSpace(*transaction.Mchid) != strings.TrimSpace(setting.WeChatPayMerchantID) ||
		transaction.TradeType == nil || *transaction.TradeType != "NATIVE" ||
		transaction.Amount == nil || transaction.Amount.Total == nil || transaction.Amount.Currency == nil || *transaction.Amount.Currency != "CNY" ||
		transaction.OutTradeNo == nil || strings.TrimSpace(*transaction.OutTradeNo) == "" ||
		transaction.TransactionId == nil || strings.TrimSpace(*transaction.TransactionId) == "" {
		return errors.New("微信支付交易字段不匹配")
	}
	if expectedTradeNo != "" && strings.TrimSpace(*transaction.OutTradeNo) != expectedTradeNo {
		return errors.New("微信支付商户订单号不匹配")
	}
	return nil
}

func WeChatPayPay(c *gin.Context) {
	if !isWeChatPayTopUpEnabled() {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "微信支付未启用或配置不完整"})
		return
	}

	var req weChatPayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "参数错误"})
		return
	}
	if req.Amount < int64(setting.WeChatPayMinTopUp) || req.Amount < getMinTopup() {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": fmt.Sprintf("充值数量不能小于 %d", max(int64(setting.WeChatPayMinTopUp), getMinTopup()))})
		return
	}
	if req.Amount > 10000 {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "充值数量不能大于 10000"})
		return
	}

	userID := c.GetInt("id")
	group, err := model.GetUserGroup(userID, true)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "获取用户分组失败"})
		return
	}

	payMoney := getPayMoney(req.Amount, group)
	amountCents := decimal.NewFromFloat(payMoney).Mul(decimal.NewFromInt(100)).Round(0).IntPart()
	if amountCents <= 0 {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "充值金额过低"})
		return
	}
	payMoney = decimal.NewFromInt(amountCents).Div(decimal.NewFromInt(100)).InexactFloat64()

	amount := req.Amount
	if operation_setting.GetQuotaDisplayType() == operation_setting.QuotaDisplayTypeTokens {
		amount = decimal.NewFromInt(req.Amount).Div(decimal.NewFromFloat(common.QuotaPerUnit)).IntPart()
	}
	if amount <= 0 {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "充值额度无效"})
		return
	}

	tradeNo := newWeChatPayTradeNo()
	topUp := &model.TopUp{
		UserId:          userID,
		Amount:          amount,
		Money:           payMoney,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodWeChatPay,
		PaymentProvider: model.PaymentProviderWeChatPay,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}
	if err := topUp.Insert(); err != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付创建本地订单失败 user_id=%d trade_no=%s error=%q", userID, tradeNo, err.Error()))
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "创建订单失败"})
		return
	}

	weChatPayService, err := service.NewWeChatPayService()
	if err != nil {
		_ = model.UpdatePendingTopUpStatus(tradeNo, model.PaymentProviderWeChatPay, common.TopUpStatusFailed)
		logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付客户端初始化失败 user_id=%d trade_no=%s error=%q", userID, tradeNo, err.Error()))
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "支付配置错误"})
		return
	}

	expireAt := time.Now().Add(time.Duration(setting.WeChatPayOrderExpireMinutes) * time.Minute)
	codeURL, err := weChatPayService.CreateNativeTransaction(c.Request.Context(), amountCents, tradeNo, strings.TrimSpace(setting.WeChatPayNotifyURL), expireAt)
	if err != nil {
		_ = model.UpdatePendingTopUpStatus(tradeNo, model.PaymentProviderWeChatPay, common.TopUpStatusFailed)
		logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付创建 Native 订单失败 user_id=%d trade_no=%s error=%q", userID, tradeNo, err.Error()))
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "拉起支付失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"code_url":  codeURL,
			"order_id":  tradeNo,
			"expire_at": expireAt.Unix(),
		},
	})
}

func WeChatPayWebhook(c *gin.Context) {
	if !isWeChatPayWebhookEnabled() {
		c.AbortWithStatus(http.StatusForbidden)
		return
	}

	weChatPayService, err := service.NewWeChatPayService()
	if err != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付回调客户端初始化失败 error=%q", err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"code": "FAIL", "message": "支付配置错误"})
		return
	}

	transaction, eventType, err := weChatPayService.ParseNotification(c.Request.Context(), c.Request)
	if err != nil {
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("微信支付回调验签或解密失败 client_ip=%s error=%q", c.ClientIP(), err.Error()))
		c.JSON(http.StatusBadRequest, gin.H{"code": "FAIL", "message": "无效的回调"})
		return
	}
	if eventType != "TRANSACTION.SUCCESS" {
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("微信支付回调事件类型无效 client_ip=%s event_type=%q", c.ClientIP(), eventType))
		c.JSON(http.StatusBadRequest, gin.H{"code": "FAIL", "message": "回调内容不匹配"})
		return
	}
	if err := validateWeChatPayTransaction(transaction, ""); err != nil {
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("微信支付回调业务字段无效 client_ip=%s event_type=%q error=%q", c.ClientIP(), eventType, err.Error()))
		c.JSON(http.StatusBadRequest, gin.H{"code": "FAIL", "message": "回调内容不匹配"})
		return
	}

	err = model.RechargeWeChatPay(*transaction.OutTradeNo, *transaction.Amount.Total, *transaction.TransactionId, c.ClientIP())
	if err != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付回调入账失败 trade_no=%s error=%q", *transaction.OutTradeNo, err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"code": "FAIL", "message": "入账失败"})
		return
	}
	c.Status(http.StatusNoContent)
}

func GetWeChatPayOrder(c *gin.Context) {
	tradeNo := strings.TrimSpace(c.Param("trade_no"))
	topUp := model.GetTopUpByTradeNo(tradeNo)
	if topUp == nil || topUp.UserId != c.GetInt("id") || topUp.PaymentProvider != model.PaymentProviderWeChatPay {
		c.JSON(http.StatusNotFound, gin.H{"message": "error", "data": "订单不存在"})
		return
	}

	verificationError := false
	if topUp.Status == common.TopUpStatusPending {
		weChatPayService, err := service.NewWeChatPayService()
		if err != nil {
			verificationError = true
			logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付查单客户端初始化失败 trade_no=%s error=%q", tradeNo, err.Error()))
		} else {
			transaction, queryErr := weChatPayService.QueryOrderByOutTradeNo(c.Request.Context(), tradeNo)
			if queryErr != nil {
				verificationError = true
				logger.LogWarn(c.Request.Context(), fmt.Sprintf("微信支付主动查单失败 trade_no=%s error=%q", tradeNo, queryErr.Error()))
			} else if transaction.TradeState != nil && *transaction.TradeState == "SUCCESS" {
				if validationErr := validateWeChatPayTransaction(transaction, tradeNo); validationErr != nil {
					verificationError = true
					logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付主动查单交易字段无效 trade_no=%s error=%q", tradeNo, validationErr.Error()))
				} else if settlementErr := model.RechargeWeChatPay(tradeNo, *transaction.Amount.Total, *transaction.TransactionId, c.ClientIP()); settlementErr != nil {
					verificationError = true
					logger.LogError(c.Request.Context(), fmt.Sprintf("微信支付主动查单入账失败 trade_no=%s error=%q", tradeNo, settlementErr.Error()))
				} else if current := model.GetTopUpByTradeNo(tradeNo); current != nil {
					topUp = current
				}
			}
		}
	}

	if topUp.Status == common.TopUpStatusPending && common.GetTimestamp() >= topUp.CreateTime+int64(setting.WeChatPayOrderExpireMinutes*60) {
		err := model.UpdatePendingTopUpStatus(tradeNo, model.PaymentProviderWeChatPay, common.TopUpStatusExpired)
		if err == nil {
			topUp.Status = common.TopUpStatusExpired
		} else if !errors.Is(err, model.ErrTopUpStatusInvalid) {
			c.JSON(http.StatusInternalServerError, gin.H{"message": "error", "data": "查询订单失败"})
			return
		} else if current := model.GetTopUpByTradeNo(tradeNo); current != nil {
			topUp.Status = current.Status
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"order_id":           tradeNo,
			"status":             topUp.Status,
			"verification_error": verificationError,
		},
	})
}
