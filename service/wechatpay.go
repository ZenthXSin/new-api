package service

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting"
	"github.com/wechatpay-apiv3/wechatpay-go/v3"
	"github.com/wechatpay-apiv3/wechatpay-go/v3/auth/verifiers"
	"github.com/wechatpay-apiv3/wechatpay-go/v3/callback"
	"github.com/wechatpay-apiv3/wechatpay-go/v3/core"
	"github.com/wechatpay-apiv3/wechatpay-go/v3/payload"
	"github.com/wechatpay-apiv3/wechatpay-go/v3/utils"
)

type WeChatPayService struct {
	*wechatpay.Client
}

func NewWeChatPayService(setting *setting.WeChatPaySetting) (*WeChatPayService, error) {
	block, _ := pem.Decode([]byte(setting.PrivateKey))
	if block == nil {
		return nil, fmt.Errorf("invalid private key PEM")
	}
	privKey, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}

	certBlock, _ := pem.Decode([]byte(setting.APIv3Key))
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, err
	}

	c, err := wechatpay.NewClient(wechatpay.WithPrivateKey(privKey), wechatpay.WithPlatformCertificate(cert))
	if err != nil {
		return nil, err
	}
	c.SetVerifyType(wechatpay.VerifyTypePlatform)

	return &WeChatPayService{Client: c}, nil
}

func (s *WeChatPayService) CreateNativeTransaction(ctx context.Context, amount int64, outTradeNo string, openid string) (map[string]interface{}, error) {
	// Native Payment (JSAPI/Native) - return prepay_id and code_url for QR
	prepay, err := s.Client.Prepay(ctx, wechatpay.Native{
		TradeNo:      outTradeNo,
		Description:  "Top-up",
		Amount:       amount,
		NotifyURL:    constant.WeChatPayCallbackURL,
		OpenID:       openid,
	})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"prepay_id": prepay.PrepayID,
		"code_url":  prepay.CodeURL,
		"appid":     prepay.AppID,
		"partnerid": prepay.MchID,
	}, nil
}

func (s *WeChatPayService) VerifyAndDecryptCallback(body []byte, signature string, timestamp string) (*types.WeChatPayNotification, error) {
	notification, err := callback.DecryptAndVerify(s.Client, body, signature, timestamp)
	if err != nil {
		return nil, err
	}
	var notify types.WeChatPayNotification
	err = common.Unmarshal([]byte(notification.Resource), &notify)
	if err != nil {
		return nil, err
	}
	return &notify, nil
}
