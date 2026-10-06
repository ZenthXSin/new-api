package service

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAppPaymentWebhookURLRestrictions(t *testing.T) {
	for _, raw := range []string{
		"http://shop.example/paid", "https://user:pass@shop.example/paid", "https://shop.example/paid#secret",
		"https://127.0.0.1/paid", "https://169.254.169.254/latest", "https://[::1]/paid",
		"https://100.64.0.1/paid", "https://192.0.2.1/paid", "https://224.0.0.1/paid",
		"https://shop.example:65536/paid", "https://shop.example:/paid", "https://shop.example/%0d%0aheader",
		"https://shop.example\\@127.0.0.1/paid", "https://shop.example/paid\n",
	} {
		t.Run(raw, func(t *testing.T) { require.Error(t, ValidateAppPaymentWebhookURL(raw)) })
	}
	// No DNS is needed when saving a registration; unresolvable and private
	// DNS destinations will be rejected at delivery without making a request.
	require.NoError(t, ValidateAppPaymentWebhookURL("https://shop.example/payments/events"))
	require.NoError(t, ValidateAppPaymentWebhookURL("https://shop.example:8443/payments/events?version=1"))
}

func TestAppPaymentWebhookDialRejectsDNSRebinding(t *testing.T) {
	for _, addresses := range [][]net.IPAddr{
		{{IP: net.ParseIP("127.0.0.1")}},
		{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("10.0.0.1")}},
		{{IP: net.ParseIP("::ffff:169.254.169.254")}},
	} {
		dialed := false
		client := newAppPaymentWebhookHTTPClient(staticSSRFResolver{"shop.example": addresses}, func(context.Context, string, string) (net.Conn, error) {
			dialed = true
			return nil, errors.New("unexpected dial")
		})
		_, err := client.Get("https://shop.example/events")
		require.Error(t, err)
		assert.False(t, dialed, "mixed or private DNS results must be rejected before any connection")
	}
}

func TestAppPaymentWebhookDialPinsPublicIPAndIgnoresProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
	var actualAddress string
	client := newAppPaymentWebhookHTTPClient(staticSSRFResolver{"shop.example": {{IP: net.ParseIP("8.8.8.8")}}}, func(_ context.Context, _, address string) (net.Conn, error) {
		actualAddress = address
		return nil, errors.New("test connection stopped")
	})
	_, err := client.Get("https://shop.example/events")
	require.Error(t, err)
	assert.Equal(t, "8.8.8.8:443", actualAddress)
	assert.ErrorIs(t, client.CheckRedirect(&http.Request{}, nil), http.ErrUseLastResponse)
}
