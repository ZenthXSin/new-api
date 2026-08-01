package service

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/wechatpay-apiv3/wechatpay-go/core"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments/native"
)

func generateRSAPrivateKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return privateKey
}

func encodePEM(blockType string, der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}))
}

func generatePlatformCertificate(t *testing.T, privateKey *rsa.PrivateKey, serial int64) *x509.Certificate {
	t.Helper()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: "WeChat Pay Test Platform"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	require.NoError(t, err)
	certificate, err := x509.ParseCertificate(der)
	require.NoError(t, err)
	return certificate
}

type fakeWeChatPayNativeAPI struct {
	transaction *payments.Transaction
	err         error
	request     native.QueryOrderByOutTradeNoRequest
}

func (f *fakeWeChatPayNativeAPI) Prepay(context.Context, native.PrepayRequest) (*native.PrepayResponse, *core.APIResult, error) {
	return nil, nil, errors.New("unexpected prepay call")
}

func (f *fakeWeChatPayNativeAPI) QueryOrderByOutTradeNo(_ context.Context, request native.QueryOrderByOutTradeNoRequest) (*payments.Transaction, *core.APIResult, error) {
	f.request = request
	return f.transaction, nil, f.err
}

func TestWeChatPayService_QueryOrderByOutTradeNo(t *testing.T) {
	previousMerchantID := setting.WeChatPayMerchantID
	t.Cleanup(func() { setting.WeChatPayMerchantID = previousMerchantID })
	setting.WeChatPayMerchantID = " merchant-id "
	tradeState := "SUCCESS"
	fakeAPI := &fakeWeChatPayNativeAPI{transaction: &payments.Transaction{TradeState: &tradeState}}
	weChatPayService := &WeChatPayService{nativeAPI: fakeAPI}

	transaction, err := weChatPayService.QueryOrderByOutTradeNo(context.Background(), "WXorder")
	require.NoError(t, err)
	assert.Same(t, fakeAPI.transaction, transaction)
	require.NotNil(t, fakeAPI.request.OutTradeNo)
	assert.Equal(t, "WXorder", *fakeAPI.request.OutTradeNo)
	require.NotNil(t, fakeAPI.request.Mchid)
	assert.Equal(t, "merchant-id", *fakeAPI.request.Mchid)
}

func TestWeChatPayService_QueryOrderByOutTradeNoPreservesProviderError(t *testing.T) {
	providerError := errors.New("provider unavailable")
	weChatPayService := &WeChatPayService{nativeAPI: &fakeWeChatPayNativeAPI{err: providerError}}

	_, err := weChatPayService.QueryOrderByOutTradeNo(context.Background(), "WXorder")
	require.ErrorIs(t, err, providerError)
}

func TestWeChatPayService_QueryOrderByOutTradeNoRejectsEmptyResponse(t *testing.T) {
	weChatPayService := &WeChatPayService{nativeAPI: &fakeWeChatPayNativeAPI{}}

	_, err := weChatPayService.QueryOrderByOutTradeNo(context.Background(), "WXorder")
	require.Error(t, err)
}

func TestParseWeChatPayPrivateKey_AcceptsPKCS1AndPKCS8(t *testing.T) {
	privateKey := generateRSAPrivateKey(t)
	pkcs8, err := x509.MarshalPKCS8PrivateKey(privateKey)
	require.NoError(t, err)

	testCases := []struct {
		name string
		pem  string
	}{
		{name: "PKCS1", pem: encodePEM("RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(privateKey))},
		{name: "PKCS8", pem: encodePEM("PRIVATE KEY", pkcs8)},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := parseWeChatPayPrivateKey(testCase.pem)
			require.NoError(t, err)
			assert.Equal(t, privateKey.N, parsed.N)
		})
	}
}

func TestParseWeChatPayPrivateKey_RejectsInvalidAndNonRSAKeys(t *testing.T) {
	_, err := parseWeChatPayPrivateKey("not pem")
	require.Error(t, err)

	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	pkcs8, err := x509.MarshalPKCS8PrivateKey(ecdsaKey)
	require.NoError(t, err)

	_, err = parseWeChatPayPrivateKey(encodePEM("PRIVATE KEY", pkcs8))
	require.Error(t, err)
}

func TestParseWeChatPayCertificate(t *testing.T) {
	privateKey := generateRSAPrivateKey(t)
	certificate := generatePlatformCertificate(t, privateKey, 0xABCDEF)

	parsed, err := parseWeChatPayCertificate(encodePEM("CERTIFICATE", certificate.Raw))
	require.NoError(t, err)
	assert.Equal(t, certificate.SerialNumber, parsed.SerialNumber)

	_, err = parseWeChatPayCertificate("not pem")
	require.Error(t, err)
}

func TestNewWeChatPayService_ValidatesCertificateSerialAndAPIV3Key(t *testing.T) {
	privateKey := generateRSAPrivateKey(t)
	certificate := generatePlatformCertificate(t, privateKey, 0xABCDEF)
	previousPrivateKey := setting.WeChatPayPrivateKey
	previousCertificate := setting.WeChatPayPlatformCertificate
	previousCertificateSerial := setting.WeChatPayPlatformCertificateSerialNumber
	previousAPIV3Key := setting.WeChatPayAPIV3Key
	previousMerchantID := setting.WeChatPayMerchantID
	previousMerchantSerial := setting.WeChatPayMerchantSerialNumber
	t.Cleanup(func() {
		setting.WeChatPayPrivateKey = previousPrivateKey
		setting.WeChatPayPlatformCertificate = previousCertificate
		setting.WeChatPayPlatformCertificateSerialNumber = previousCertificateSerial
		setting.WeChatPayAPIV3Key = previousAPIV3Key
		setting.WeChatPayMerchantID = previousMerchantID
		setting.WeChatPayMerchantSerialNumber = previousMerchantSerial
	})

	setting.WeChatPayPrivateKey = encodePEM("RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(privateKey))
	setting.WeChatPayPlatformCertificate = encodePEM("CERTIFICATE", certificate.Raw)
	setting.WeChatPayMerchantID = "merchant"
	setting.WeChatPayMerchantSerialNumber = "merchant-serial"
	setting.WeChatPayAPIV3Key = "12345678901234567890123456789012"

	setting.WeChatPayPlatformCertificateSerialNumber = "wrong"
	_, err := NewWeChatPayService()
	require.Error(t, err)

	setting.WeChatPayPlatformCertificateSerialNumber = "abcdef"
	setting.WeChatPayAPIV3Key = "too-short"
	_, err = NewWeChatPayService()
	require.Error(t, err)

	setting.WeChatPayAPIV3Key = "12345678901234567890123456789012"
	service, err := NewWeChatPayService()
	require.NoError(t, err)
	assert.NotNil(t, service)
}
