package service

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// Claim at most four immediately executable requests, so each 25-second
// attempt completes within the database's 60-second lease across workers.
func RunAppPaymentProviderReconciliation(ctx context.Context, limit int) error {
	orders, err := model.ClaimAppPaymentProviderPoll(time.Now(), min(max(limit, 1), 4))
	if err != nil {
		return err
	}
	var failed atomic.Bool
	var workers sync.WaitGroup
	for i := range orders {
		workers.Add(1)
		go func(order *model.PaymentOrder) {
			defer workers.Done()
			requestCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
			defer cancel()
			if reconcileAppPaymentProvider(requestCtx, order) != nil {
				failed.Store(true)
			}
		}(&orders[i])
	}
	workers.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// Provider errors can contain URLs or response text: callers log only this.
	if failed.Load() {
		return errors.New("one or more application payment checks failed")
	}
	return nil
}

func reconcileAppPaymentProvider(ctx context.Context, order *model.PaymentOrder) error {
	if order.Status == model.AppPaymentProcessing {
		if order.Provider == "stripe" && order.PaymentData == "" {
			// Recover a session accepted before the checkout response was persisted.
			// This uses the original fixed parameters and idempotency key even if the
			// locally displayed expiry has elapsed in the meantime.
			if order.ProviderExpiresAt == 0 {
				if order.ExpiresAt <= time.Now().Unix() {
					return model.MarkAppPaymentProviderExpired(order.ID, order.Provider)
				}
				if _, err := CreateAppPaymentCheckout(ctx, order, order.PaymentMethod); err != nil {
					return err
				}
			} else {
				if err := ValidateAppPaymentMerchant(ctx, order); err != nil {
					return err
				}
				checkout, err := createStripeAppPayment(ctx, order)
				if err != nil {
					return err
				}
				data, err := common.Marshal(checkout)
				if err != nil {
					return err
				}
				if err := model.SaveAppPaymentProviderData(order.ID, order.Provider, string(data)); err != nil {
					return err
				}
				order.PaymentData = string(data)
			}
		}
		result, err := QueryAppPayment(ctx, order)
		if err != nil {
			return err
		}
		switch result.Status {
		case "paid":
			_, _, err = model.CompleteAppPaymentProvider(order.ID, order.Provider, result.ProviderTradeNo, result.Amount, result.Currency)
		case "expired":
			err = model.MarkAppPaymentProviderExpired(order.ID, order.Provider)
		}
		return err
	}
	if order.Status == model.AppPaymentRefundPending {
		var result *AppPaymentRefundResult
		var err error
		if order.ProviderRefundNo != "" {
			result, err = QueryAppPaymentRefund(ctx, order)
		} else {
			result, err = RefundAppPayment(ctx, order)
		}
		if err != nil {
			return err
		}
		if result.Status == "refunded" {
			_, _, err = model.CompleteAppPaymentRefund(order.ID, order.Provider, result.ProviderRefundNo)
		} else if result.ProviderRefundNo != "" {
			err = model.SaveAppPaymentRefundProviderData(order.ID, order.Provider, result.ProviderRefundNo)
		}
		return err
	}
	return nil
}
