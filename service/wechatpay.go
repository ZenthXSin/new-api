package service

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/setting"
	"github.com/wechatpay-apiv3/wechatpay-go/core"
	"github.com/wechatpay-apiv3/wechatpay-go/core/auth/verifiers"
	"github.com/wechatpay-apiv3/wechatpay-go/core/notify"
	"github.com/wechatpay-apiv3/wechatpay-go/core/option"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments/native"
)

type weChatPayNativeAPI interface {
	Prepay(context.Context, native.PrepayRequest) (*native.PrepayResponse, *core.APIResult, error)
	QueryOrderByOutTradeNo(context.Context, native.QueryOrderByOutTradeNoRequest) (*payments.Transaction, *core.APIResult, error)
}

type WeChatPayService struct {
	nativeAPI     weChatPayNativeAPI
	notifyHandler *notify.Handler
}

func NewWeChatPayService() (*WeChatPayService, error) {
	privateKey, err := parseWeChatPayPrivateKey(setting.WeChatPayPrivateKey)
	if err != nil {
		return nil, err
	}
	platformCertificate, err := parseWeChatPayCertificate(setting.WeChatPayPlatformCertificate)
	if err != nil {
		return nil, err
	}
	configuredCertificateSerial := normalizeCertificateSerial(setting.WeChatPayPlatformCertificateSerialNumber)
	actualCertificateSerial := normalizeCertificateSerial(platformCertificate.SerialNumber.Text(16))
	if configuredCertificateSerial == "" || configuredCertificateSerial != actualCertificateSerial {
		return nil, errors.New("微信支付平台证书序列号不匹配")
	}
	if len(setting.WeChatPayAPIV3Key) != 32 {
		return nil, errors.New("微信支付 API v3 密钥必须为 32 字节")
	}

	client, err := core.NewClient(context.Background(),
		option.WithMerchantCredential(
			strings.TrimSpace(setting.WeChatPayMerchantID),
			strings.TrimSpace(setting.WeChatPayMerchantSerialNumber),
			privateKey,
		),
		option.WithWechatPayCertificate([]*x509.Certificate{platformCertificate}),
	)
	if err != nil {
		return nil, fmt.Errorf("初始化微信支付客户端: %w", err)
	}

	verifier := verifiers.NewSHA256WithRSAVerifier(core.NewCertificateMapWithList([]*x509.Certificate{platformCertificate}))
	handler, err := notify.NewRSANotifyHandler(setting.WeChatPayAPIV3Key, verifier)
	if err != nil {
		return nil, fmt.Errorf("初始化微信支付回调处理器: %w", err)
	}

	return &WeChatPayService{
		nativeAPI:     &native.NativeApiService{Client: client},
		notifyHandler: handler,
	}, nil
}

func (s *WeChatPayService) CreateNativeTransaction(ctx context.Context, amountCents int64, outTradeNo, notifyURL string, expireAt time.Time) (string, error) {
	appID := strings.TrimSpace(setting.WeChatPayAppID)
	merchantID := strings.TrimSpace(setting.WeChatPayMerchantID)
	description := "Account top-up"
	currency := "CNY"

	response, _, err := s.nativeAPI.Prepay(ctx, native.PrepayRequest{
		Appid:       &appID,
		Mchid:       &merchantID,
		Description: &description,
		OutTradeNo:  &outTradeNo,
		TimeExpire:  &expireAt,
		NotifyUrl:   &notifyURL,
		Amount: &native.Amount{
			Total:    &amountCents,
			Currency: &currency,
		},
	})
	if err != nil {
		return "", fmt.Errorf("创建微信支付订单: %w", err)
	}
	if response == nil || response.CodeUrl == nil || strings.TrimSpace(*response.CodeUrl) == "" {
		return "", errors.New("微信支付未返回二维码地址")
	}
	return *response.CodeUrl, nil
}

func (s *WeChatPayService) ParseNotification(ctx context.Context, request *http.Request) (*payments.Transaction, string, error) {
	transaction := &payments.Transaction{}
	notification, err := s.notifyHandler.ParseNotifyRequest(ctx, request, transaction)
	if err != nil {
		return nil, "", err
	}
	return transaction, notification.EventType, nil
}

func (s *WeChatPayService) QueryOrderByOutTradeNo(ctx context.Context, outTradeNo string) (*payments.Transaction, error) {
	merchantID := strings.TrimSpace(setting.WeChatPayMerchantID)
	transaction, _, err := s.nativeAPI.QueryOrderByOutTradeNo(ctx, native.QueryOrderByOutTradeNoRequest{
		OutTradeNo: &outTradeNo,
		Mchid:      &merchantID,
	})
	if err != nil {
		return nil, fmt.Errorf("查询微信支付订单: %w", err)
	}
	if transaction == nil {
		return nil, errors.New("微信支付查单未返回交易信息")
	}
	return transaction, nil
}

func normalizeCertificateSerial(serial string) string {
	return strings.ToUpper(strings.TrimSpace(serial))
}

func parseWeChatPayPrivateKey(raw string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(strings.TrimSpace(raw)))
	if block == nil {
		return nil, errors.New("无效的微信支付商户私钥 PEM")
	}
	if privateKey, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return privateKey, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析微信支付商户私钥: %w", err)
	}
	privateKey, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("微信支付商户私钥不是 RSA 私钥")
	}
	return privateKey, nil
}

func parseWeChatPayCertificate(raw string) (*x509.Certificate, error) {
	block, _ := pem.Decode([]byte(strings.TrimSpace(raw)))
	if block == nil {
		return nil, errors.New("无效的微信支付平台证书 PEM")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析微信支付平台证书: %w", err)
	}
	return certificate, nil
}
