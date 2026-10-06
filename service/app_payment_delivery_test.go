package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type appPaymentDeliveryTestTransport func(*http.Request) (*http.Response, error)

func (f appPaymentDeliveryTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestAppPaymentWebhookExactBodySignatureAndRetryIdentity(t *testing.T) {
	previous := common.CryptoSecret
	common.CryptoSecret = "isolated-app-payment-delivery-test-key"
	t.Cleanup(func() { common.CryptoSecret = previous })
	secret := strings.Repeat("s", 32)
	encrypted, err := model.EncryptAppPaymentWebhookSecret("app", secret)
	require.NoError(t, err)
	event := model.PaymentWebhookEvent{EventID: "evt_1", ClientID: "app", Payload: "{\"id\":\"evt_1\",\"type\":\"payment.paid\",\"data\":{\"title\":\"会员\"}}\n", WebhookURL: "https://merchant.example/events", SecretEncrypted: encrypted}
	var signatures []string
	client := &http.Client{Transport: appPaymentDeliveryTestTransport(func(req *http.Request) (*http.Response, error) {
		assert.Equal(t, http.MethodPost, req.Method)
		assert.Equal(t, "application/json", req.Header.Get("Content-Type"))
		assert.Equal(t, event.EventID, req.Header.Get("NewAPI-Webhook-Id"))
		body, err := io.ReadAll(req.Body)
		require.NoError(t, err)
		assert.Equal(t, event.Payload, string(body))
		timestamp := req.Header.Get("NewAPI-Webhook-Timestamp")
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(timestamp + "." + event.Payload))
		signature := req.Header.Get("NewAPI-Webhook-Signature")
		assert.Equal(t, "v1="+hex.EncodeToString(mac.Sum(nil)), signature)
		signatures = append(signatures, signature)
		assert.Empty(t, req.Header.Get("Authorization"))
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	assert.Empty(t, deliverAppPaymentWebhook(context.Background(), client, event, time.Unix(1800000000, 0)))
	assert.Empty(t, deliverAppPaymentWebhook(context.Background(), client, event, time.Unix(1800000030, 0)))
	require.Len(t, signatures, 2)
	assert.NotEqual(t, signatures[0], signatures[1])
}

func TestAppPaymentWebhookErrorsNeverExposeDestinationOrResponse(t *testing.T) {
	previous := common.CryptoSecret
	common.CryptoSecret = "isolated-app-payment-delivery-test-key"
	t.Cleanup(func() { common.CryptoSecret = previous })
	encrypted, err := model.EncryptAppPaymentWebhookSecret("app", strings.Repeat("s", 32))
	require.NoError(t, err)
	event := model.PaymentWebhookEvent{EventID: "evt_1", ClientID: "app", Payload: `{"id":"evt_1"}`, WebhookURL: "https://merchant.example/events?credential=sensitive", SecretEncrypted: encrypted}
	client := &http.Client{Transport: appPaymentDeliveryTestTransport(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("sensitive upstream details")
	})}
	assert.Equal(t, "network_error", deliverAppPaymentWebhook(context.Background(), client, event, time.Now()))
	client.Transport = appPaymentDeliveryTestTransport(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://other.example"}}, Body: io.NopCloser(strings.NewReader("sensitive response"))}, nil
	})
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	assert.Equal(t, "http_302", deliverAppPaymentWebhook(context.Background(), client, event, time.Now()))

	event.EventID = "tampered"
	client.Transport = appPaymentDeliveryTestTransport(func(req *http.Request) (*http.Response, error) {
		t.Fatal("malformed event must not be sent")
		return nil, nil
	})
	assert.Equal(t, "invalid_event", deliverAppPaymentWebhook(context.Background(), client, event, time.Now()))
}
