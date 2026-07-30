package controller

import (
	"fmt"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func WeChatPayPay(c *gin.Context) {
	userID := common.GetUserIDFromContext(c.Request.Context())
	if userID == 0 {
		c.JSON(http.StatusUnauthorized, common.Response{Errno: 401, ErrMsg: "未登录"})
		return
	}

	var req struct {
		Amount    int64  `json:"amount" binding:"required,min=100"`
		OpenID    string `json:"openid"`
		PaymentID string `json:"payment_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, common.Response{Errno: 400, ErrMsg: err.Error()})
		return
	}

	// Get settings
	s := setting.GetWeChatPaySetting()
	if s.AppID == "" || s.MerchantID == "" || s.PrivateKey == "" || s.APIv3Key == "" {
		c.JSON(http.StatusBadRequest, common.Response{Errno: 400, ErrMsg: "微信支付未配置"})
		return
	}

	svc, err := service.NewWeChatPayService(s)
	if err != nil {
		c.JSON(http.StatusInternalServerError, common.Response{Errno: 500, ErrMsg: err.Error()})
		return
	}

	// Create pending order
	tradeNo := fmt.Sprintf("wx_%d_%d", userID, time.Now().UnixNano())
	order := &model.TopUp{
		UserId:          userID,
		Amount:          req.Amount,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodWeChatPay,
		PaymentProvider: model.PaymentProviderWeChatPay,
		Status:          common.TopUpStatusPending,
		CreateTime:      time.Now().Unix(),
	}
	if err := order.Insert(); err != nil {
		c.JSON(http.StatusInternalServerError, common.Response{Errno: 500, ErrMsg: err.Error()})
		return
	}

	// Create Native Payment
	params, err := svc.CreateNativeTransaction(c.Request.Context(), req.Amount, tradeNo, req.OpenID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, common.Response{Errno: 500, ErrMsg: err.Error()})
		return
	}

	c.JSON(http.StatusOK, common.Response{
		Data: common.ResponseData{
			"code_url":  params["code_url"],
			"prepay_id": params["prepay_id"],
			"appid":     params["appid"],
			"partnerid": params["partnerid"],
			"order_id":  tradeNo,
		},
	})
}

func WeChatPayWebhook(c *gin.Context) {
	body, _ := c.GetRawData()
	signature := c.GetHeader("Wechatpay-Signature")
	timestamp := c.GetHeader("Wechatpay-Timestamp")

	s := setting.GetWeChatPaySetting()
	if s.AppID == "" {
		c.JSON(http.StatusOK, map[string]string{"return_code": "FAIL"})
		return
	}

	svc, err := service.NewWeChatPayService(s)
	if err != nil {
		c.JSON(http.StatusOK, map[string]string{"return_code": "FAIL"})
		return
	}

	notify, err := svc.VerifyAndDecryptCallback(body, signature, timestamp)
	if err != nil {
		c.JSON(http.StatusOK, map[string]string{"return_code": "FAIL"})
		return
	}

	// Process callback
	order := model.GetTopUpByTradeNo(notify.OutTradeNo)
	if order == nil || order.PaymentProvider != model.PaymentProviderWeChatPay {
		c.JSON(http.StatusOK, map[string]string{"return_code": "FAIL"})
		return
	}

	if order.Status != common.TopUpStatusPending {
		c.JSON(http.StatusOK, map[string]string{"return_code": "SUCCESS"})
		return
	}

	// Lock and update
	DB.Transaction(func(tx *gorm.DB) error {
		order.Status = common.TopUpStatusSuccess
		order.CompleteTime = time.Now().Unix()
		tx.Save(order)
		// Increase quota
		common.IncreaseUserQuota(order.UserId, int64(order.Amount*500*1000))
		return nil
	})

	c.JSON(http.StatusOK, map[string]string{"return_code": "SUCCESS"})
}
