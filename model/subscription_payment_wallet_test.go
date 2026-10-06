package model

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupSubscriptionPaymentWalletTest(t *testing.T) (*User, *SubscriptionPlan, *PaymentOrder) {
	t.Helper()
	previousDB, previousLog := DB, LOG_DB
	oldQuotaPerUnit := common.QuotaPerUnit
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), SkipDefaultTransaction: true})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	DB, LOG_DB = db, db
	common.QuotaPerUnit = 1
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		ResetAppPaymentWalletCacheForTesting()
		DB, LOG_DB = previousDB, previousLog
		common.QuotaPerUnit = oldQuotaPerUnit
		common.SetDatabaseTypes(oldMain, oldLog)
		_ = sqlDB.Close()
	})
	resetBatchUpdateTestState(t)
	useUserCacheMiniRedis(t)
	require.NoError(t, db.AutoMigrate(&User{}, &OauthClient{}, &PaymentApplication{}, &PaymentOrder{}, &PaymentWebhookEvent{}, &PaymentWalletOperation{}, &PaymentWalletGuard{}, &PaymentWalletMutation{}, &PaymentWalletCacheWitness{}, &Option{}, &SubscriptionPlan{}, &SubscriptionOrder{}, &UserSubscription{}, &Log{}))
	require.NoError(t, InitializeAppPaymentWalletCache())
	user := createReserveTestUser(t, 100)
	client := &OauthClient{ClientId: "subscription-app", Enabled: true, IsPublic: false}
	require.NoError(t, DB.Create(client).Error)
	app := &PaymentApplication{ClientID: client.ClientId, Enabled: true, Methods: `["balance"]`}
	require.NoError(t, DB.Create(app).Error)
	order, _, err := CreateAppPaymentOrder(&PaymentOrder{ClientID: app.ClientID, OutTradeNo: "subscription-overlap", Amount: 1, Currency: "CNY", Title: "Concurrent app payment", ExpiresIn: 3600})
	require.NoError(t, err)
	plan := &SubscriptionPlan{Title: "Balance fixture", DurationUnit: SubscriptionDurationMonth, DurationValue: 1, TotalAmount: 100, PriceAmount: 30, Enabled: true}
	require.NoError(t, DB.Create(plan).Error)
	InvalidateSubscriptionPlanCache(plan.Id)
	_, err = GetUserCache(user.Id)
	require.NoError(t, err)
	return &user, plan, order
}

func TestSubscriptionBalanceUsesLiveQuotaAndHoldsMerchantFence(t *testing.T) {
	user, plan, order := setupSubscriptionPaymentWalletTest(t)
	common.BatchUpdateEnabled = true
	ok, err := TryReserveUserQuota(user.Id, 60)
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, 100, getUserQuotaFromDB(t, user.Id))
	// At cleanup entry the subscription transaction and cache adjustment have
	// finished, but the durable mutation still exists. A commerce payment must
	// refuse this window rather than race the independent balance operation.
	observed := false
	callback := "test:subscription-before-mutation-release"
	require.NoError(t, DB.Callback().Delete().Before("gorm:delete").Register(callback, func(tx *gorm.DB) {
		if tx.Statement.Table != "payment_wallet_mutations" || observed {
			return
		}
		observed = true
		current, err := GetUserCache(user.Id)
		require.NoError(t, err)
		assert.Equal(t, 10, current.Quota)
		assert.Equal(t, 70, getUserQuotaFromDB(t, user.Id))
		_, _, err = PayAppPaymentBalance(order.ID, user.Id, 10, "1")
		assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	}))
	t.Cleanup(func() { _ = DB.Callback().Delete().Remove(callback) })
	require.NoError(t, PurchaseSubscriptionWithBalance(user.Id, plan.Id))
	assert.True(t, observed)
	require.NoError(t, DB.Callback().Delete().Remove(callback))
	paid, already, err := PayAppPaymentBalance(order.ID, user.Id, 10, "1")
	require.NoError(t, err)
	assert.False(t, already)
	assert.Equal(t, AppPaymentPaid, paid.Status)
	batchUpdate()
	assert.Zero(t, getUserQuotaFromDB(t, user.Id))
	current, err := GetUserCache(user.Id)
	require.NoError(t, err)
	assert.Zero(t, current.Quota)
}

func TestSubscriptionBalanceRejectsStaleDatabaseAndRestoresFailedReservation(t *testing.T) {
	for _, tc := range []struct {
		name          string
		price         float64
		injectFailure bool
	}{
		{"insufficient live mirror", 60, false}, {"database write failure", 30, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			user, plan, order := setupSubscriptionPaymentWalletTest(t)
			common.BatchUpdateEnabled = true
			ok, err := TryReserveUserQuota(user.Id, 60)
			require.NoError(t, err)
			require.True(t, ok)
			require.NoError(t, DB.Model(plan).Update("price_amount", tc.price).Error)
			InvalidateSubscriptionPlanCache(plan.Id)
			if tc.injectFailure {
				callback := "test:subscription-quota-failure"
				require.NoError(t, DB.Callback().Update().Before("gorm:update").Register(callback, func(tx *gorm.DB) {
					if tx.Statement.Table == "users" {
						tx.AddError(errors.New("injected subscription quota persistence failure"))
					}
				}))
				t.Cleanup(func() { _ = DB.Callback().Update().Remove(callback) })
			}
			err = PurchaseSubscriptionWithBalance(user.Id, plan.Id)
			require.Error(t, err)
			if tc.injectFailure {
				require.NoError(t, DB.Callback().Update().Remove("test:subscription-quota-failure"))
			}
			if !tc.injectFailure {
				assert.ErrorIs(t, err, ErrAppPaymentInsufficient)
			}
			assert.Equal(t, 100, getUserQuotaFromDB(t, user.Id))
			current, err := GetUserCache(user.Id)
			require.NoError(t, err)
			assert.Equal(t, 40, current.Quota)
			var purchases int64
			require.NoError(t, DB.Model(&SubscriptionOrder{}).Count(&purchases).Error)
			assert.Zero(t, purchases)
			if tc.injectFailure {
				_, _, err = PayAppPaymentBalance(order.ID, user.Id, 10, "1")
				assert.ErrorIs(t, err, ErrAppPaymentBalancePending, "uncertain DB outcome stays fenced after compensation")
			}
		})
	}
}

type subscriptionPaymentRedisHook struct{ fail bool }

func (h *subscriptionPaymentRedisHook) BeforeProcess(ctx context.Context, cmd redis.Cmder) (context.Context, error) {
	if h.fail && cmd.Name() == "eval" && len(cmd.Args()) > 1 && fmt.Sprint(cmd.Args()[1]) == userQuotaReserveScript {
		return ctx, errors.New("injected reserve connection loss")
	}
	return ctx, nil
}
func (*subscriptionPaymentRedisHook) AfterProcess(context.Context, redis.Cmder) error { return nil }
func (*subscriptionPaymentRedisHook) BeforeProcessPipeline(ctx context.Context, _ []redis.Cmder) (context.Context, error) {
	return ctx, nil
}
func (*subscriptionPaymentRedisHook) AfterProcessPipeline(context.Context, []redis.Cmder) error {
	return nil
}

func TestSubscriptionBalanceCacheFailureDoesNotFallBackOrDeadlock(t *testing.T) {
	user, plan, _ := setupSubscriptionPaymentWalletTest(t)
	hook := &subscriptionPaymentRedisHook{fail: true}
	common.RDB.AddHook(hook)
	finished := make(chan error, 1)
	go func() { finished <- PurchaseSubscriptionWithBalance(user.Id, plan.Id) }()
	select {
	case err := <-finished:
		assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	case <-time.After(3 * time.Second):
		t.Fatal("cache failure attempted a nested database operation while holding the subscription transaction")
	}
	hook.fail = false
	assert.Equal(t, 100, getUserQuotaFromDB(t, user.Id))
	var witness PaymentWalletCacheWitness
	require.NoError(t, DB.First(&witness, user.Id).Error)
	assert.True(t, witness.Unsafe)
	var mutations int64
	require.NoError(t, DB.Model(&PaymentWalletMutation{}).Count(&mutations).Error)
	assert.Zero(t, mutations)
}
