package service

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/QuantumNous/new-api/common"
)

var errAppPaymentWebhookURL = errors.New("payment webhook must be a public HTTPS URL without credentials or fragments")

// ValidateAppPaymentWebhookURL performs syntax checks without contacting the
// destination. DNS and IP restrictions are enforced again at the actual dial.
func ValidateAppPaymentWebhookURL(raw string) error {
	if len(raw) == 0 || len(raw) > 2048 || strings.ContainsAny(raw, "\\#") || strings.IndexFunc(raw, unicode.IsSpace) >= 0 || strings.IndexFunc(raw, unicode.IsControl) >= 0 {
		return errAppPaymentWebhookURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || strings.HasSuffix(u.Host, ":") {
		return errAppPaymentWebhookURL
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil || strings.IndexFunc(decoded, unicode.IsControl) >= 0 {
		return errAppPaymentWebhookURL
	}
	if err := appPaymentWebhookProtection().ValidateURL(raw); err != nil {
		return errAppPaymentWebhookURL
	}
	return nil
}

func appPaymentWebhookProtection() *common.SSRFProtection {
	return &common.SSRFProtection{
		AllowPrivateIp: false, DomainFilterMode: false, IpFilterMode: false,
		// Validation must not resolve DNS. The protected dialer enables this
		// flag on its independent policy immediately before connecting.
		ApplyIPFilterForDomain: false,
	}
}

func newAppPaymentWebhookHTTPClient(resolver ssrfResolver, dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	if dial == nil {
		dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
		dial = dialer.DialContext
	}
	guard := &protectedFetchDialer{
		resolver: resolver, dialContext: dial,
		getProtection: func() (*common.SSRFProtection, bool, error) {
			policy := appPaymentWebhookProtection()
			policy.ApplyIPFilterForDomain = true
			return policy, true, nil
		},
	}
	return &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			// No environment proxy or site-wide insecure TLS setting: these
			// would bypass the destination checks or expose payment events.
			Proxy: nil, DialContext: guard.DialContext,
			TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second,
			MaxIdleConns: 20, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second,
			ForceAttemptHTTP2: true, MaxResponseHeaderBytes: 32 * 1024,
		},
	}
}
