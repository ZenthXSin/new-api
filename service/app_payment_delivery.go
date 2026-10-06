package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// SignAppPaymentWebhook signs the exact transmitted bytes. Each retry gets a
// fresh timestamp while the event ID and body remain stable for deduplication.
func SignAppPaymentWebhook(secret, timestamp string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(payload)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

func deliverAppPaymentWebhook(ctx context.Context, client *http.Client, event model.PaymentWebhookEvent, now time.Time) string {
	if ValidateAppPaymentWebhookURL(event.WebhookURL) != nil {
		return "invalid_destination"
	}
	secret, err := model.DecryptAppPaymentWebhookSecret(event.ClientID, event.SecretEncrypted)
	if err != nil || len(secret) < 32 {
		return "signing_key_unavailable"
	}
	if len(event.Payload) == 0 || len(event.Payload) > 64*1024 {
		return "invalid_event"
	}
	var envelope struct {
		ID string `json:"id"`
	}
	if common.UnmarshalJsonStr(event.Payload, &envelope) != nil || envelope.ID != event.EventID || event.EventID == "" {
		return "invalid_event"
	}
	payload := []byte(event.Payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, event.WebhookURL, bytes.NewReader(payload))
	if err != nil {
		return "invalid_destination"
	}
	timestamp := strconv.FormatInt(now.Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "New-API-Payments/1")
	req.Header.Set("NewAPI-Webhook-Id", event.EventID)
	req.Header.Set("NewAPI-Webhook-Timestamp", timestamp)
	req.Header.Set("NewAPI-Webhook-Signature", SignAppPaymentWebhook(secret, timestamp, payload))
	response, err := client.Do(req)
	if err != nil {
		// net/http errors can contain a destination's query credentials.
		return "network_error"
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return ""
	}
	return "http_" + strconv.Itoa(response.StatusCode)
}

// RunAppPaymentWebhookDeliveryOnce is bounded to four simultaneous deliveries.
// Database leases let every server run it without duplicating an active attempt.
func RunAppPaymentWebhookDeliveryOnce(ctx context.Context, client *http.Client) error {
	events, err := model.ClaimAppPaymentWebhookEvents(time.Now(), 4)
	var workers sync.WaitGroup
	for _, event := range events {
		workers.Add(1)
		go func(event model.PaymentWebhookEvent) {
			defer workers.Done()
			code := deliverAppPaymentWebhook(ctx, client, event, time.Now())
			if finishErr := model.FinishAppPaymentWebhookEvent(event, code == "", code, time.Now()); finishErr != nil {
				common.SysError("payment webhook acknowledgment could not be persisted")
			}
		}(event)
	}
	workers.Wait()
	return err
}

func StartAppPaymentWorkers(ctx context.Context) func() {
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		client := newAppPaymentWebhookHTTPClient(nil, nil)
		defer client.CloseIdleConnections()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := RunAppPaymentWebhookDeliveryOnce(ctx, client); err != nil {
					common.SysError("payment webhook queue could not be read")
				}
			}
		}
	}()
	go func() {
		defer workers.Done()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := model.ReconcileAppPaymentWalletOperations(20); err != nil {
					common.SysError("payment wallet recovery queue could not be read")
				}
				if err := RunAppPaymentProviderReconciliation(ctx, 4); err != nil {
					common.SysError("payment provider recovery queue could not be read")
				}
			}
		}
	}()
	return workers.Wait
}
