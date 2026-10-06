package model

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/alicebob/miniredis/v2"
	"github.com/glebarez/sqlite"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type appPaymentFixture struct {
	user   User
	client OauthClient
	mini   *miniredis.Miniredis
}

// The same transaction suite runs against isolated real MySQL/Postgres when
// explicitly configured. Never infer a DSN from production configuration.
func setupAppPaymentModelTest(t *testing.T, useRedis bool) appPaymentFixture {
	t.Helper()
	var dialector gorm.Dialector
	dialect := os.Getenv("TEST_APP_PAYMENT_DIALECT")
	switch dialect {
	case "mysql":
		dsn := os.Getenv("TEST_APP_PAYMENT_MYSQL_DSN")
		require.NotEmpty(t, dsn)
		dialector = mysql.Open(dsn)
	case "postgresql", "postgres":
		dsn := os.Getenv("TEST_APP_PAYMENT_POSTGRES_DSN")
		require.NotEmpty(t, dsn)
		dialector = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
	default:
		dialect = "sqlite"
		dialector = sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_")))
	}
	db, err := gorm.Open(dialector, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	if dialect != "sqlite" {
		sqlDB.SetMaxOpenConns(4)
	}
	oldDB, oldType, oldRDB, oldRedis, oldBatch := DB, common.MainDatabaseType(), common.RDB, common.RedisEnabled, common.BatchUpdateEnabled
	oldGuardsReady := appPaymentWalletGuardsReady.Load()
	oldOwner, oldReady, oldEpoch := appPaymentWalletSchemaDB.Load(), appPaymentWalletCacheReady.Load(), appPaymentWalletEpochValue()
	DB = db
	common.RedisEnabled = useRedis
	common.BatchUpdateEnabled = false
	switch dialect {
	case "mysql":
		common.SetMainDatabaseType(common.DatabaseTypeMySQL)
	case "postgresql", "postgres":
		common.SetMainDatabaseType(common.DatabaseTypePostgreSQL)
	default:
		common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	}
	initCol()
	tables := []any{&PaymentWebhookEvent{}, &PaymentWalletMutation{}, &PaymentWalletOperation{}, &PaymentWalletGuard{}, &PaymentWalletCacheWitness{}, &PaymentOrder{}, &PaymentApplication{}, &OauthClient{}, &Option{}, &User{}}
	require.NoError(t, db.AutoMigrate(tables...))
	for _, table := range tables {
		require.NoError(t, db.Unscoped().Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(table).Error)
	}
	f := appPaymentFixture{}
	if useRedis {
		addr := os.Getenv("TEST_APP_PAYMENT_REDIS_ADDR")
		if addr == "" {
			f.mini = miniredis.RunT(t)
			addr = f.mini.Addr()
		}
		common.RDB = redis.NewClient(&redis.Options{Addr: addr, Password: os.Getenv("TEST_APP_PAYMENT_REDIS_PASSWORD"), DB: 14, MaxRetries: -1})
		require.NoError(t, common.RDB.FlushDB(context.Background()).Err())
	}
	for i := range batchUpdateStores {
		batchUpdateStores[i] = make(map[int]int)
	}
	require.NoError(t, InitializeAppPaymentWalletCache())
	f.user = User{Username: "payment-payer", Password: "unused", Status: common.UserStatusEnabled, Role: common.RoleCommonUser, Quota: 1000, AuthVersion: 1, Group: "default"}
	require.NoError(t, db.Create(&f.user).Error)
	f.client = OauthClient{ClientId: "payment-test-client", ClientSecret: "unused", Name: "商户", Enabled: true, RedirectUris: `["https://merchant.example/return"]`}
	require.NoError(t, db.Create(&f.client).Error)
	require.NoError(t, SavePaymentApplication(&PaymentApplication{ClientID: f.client.ClientId, Enabled: true, Methods: `["balance","stripe","wechatpay","epay_alipay"]`, WebhookURL: "https://merchant.example/events", WebhookSecret: "encrypted-test-secret"}))
	t.Cleanup(func() {
		if useRedis {
			require.NoError(t, common.RDB.Close())
		}
		for i := range batchUpdateStores {
			batchUpdateStores[i] = make(map[int]int)
		}
		DB = oldDB
		common.SetMainDatabaseType(oldType)
		initCol()
		common.RDB = oldRDB
		common.RedisEnabled = oldRedis
		common.BatchUpdateEnabled = oldBatch
		appPaymentWalletGuardsReady.Store(oldGuardsReady)
		appPaymentWalletSchemaDB.Store(oldOwner)
		appPaymentWalletCacheReady.Store(oldReady)
		appPaymentWalletEpoch.Store(oldEpoch)
		require.NoError(t, sqlDB.Close())
	})
	return f
}
func (f appPaymentFixture) order(t *testing.T, trade string) *PaymentOrder {
	t.Helper()
	order, exists, err := CreateAppPaymentOrder(&PaymentOrder{ClientID: f.client.ClientId, OutTradeNo: trade, Amount: 100, Currency: "CNY", Title: "测试订单", ExpiresIn: 600, ReturnURL: "https://merchant.example/return"})
	require.NoError(t, err)
	require.False(t, exists)
	return order
}
func paymentQuota(t *testing.T, id int) int {
	t.Helper()
	var user User
	require.NoError(t, DB.Select("quota").First(&user, id).Error)
	return user.Quota
}
func paymentMirror(t *testing.T, id int) int {
	t.Helper()
	v, err := common.RDB.Get(context.Background(), appPaymentWalletMirrorKey(id)).Int()
	require.NoError(t, err)
	return v
}

func TestAppPaymentOrderIdempotencyProviderAndOutbox(t *testing.T) {
	f := setupAppPaymentModelTest(t, false)
	order := f.order(t, "same-request")
	assert.True(t, ValidateAppPaymentOrderID(order.ID))
	retry := *order
	retry.ExpiresAt += 99
	got, existing, err := CreateAppPaymentOrder(&retry)
	require.NoError(t, err)
	assert.True(t, existing)
	assert.Equal(t, order.ID, got.ID)
	retry.Amount++
	_, _, err = CreateAppPaymentOrder(&retry)
	assert.ErrorIs(t, err, ErrAppPaymentConflict)
	_, _, err = BeginAppPaymentProvider(order.ID, f.user.Id, "stripe", "stripe")
	require.NoError(t, err)
	_, _, err = BeginAppPaymentProvider(order.ID, f.user.Id+1, "stripe", "stripe")
	assert.ErrorIs(t, err, ErrAppPaymentConflict)
	require.NoError(t, SetAppPaymentProviderMerchant(order.ID, "stripe", "account"))
	require.NoError(t, SetAppPaymentProviderMerchant(order.ID, "stripe", "account"))
	require.NoError(t, SaveAppPaymentProviderData(order.ID, "stripe", `{"id":"checkout"}`))
	require.Error(t, SaveAppPaymentProviderData(order.ID, "stripe", `{"id":"other"}`))
	expiry, err := PrepareAppPaymentCheckoutExpiry(order.ID, "stripe", time.Now().Add(31*time.Minute).Unix())
	require.NoError(t, err)
	again, err := PrepareAppPaymentCheckoutExpiry(order.ID, "stripe", time.Now().Add(time.Hour).Unix())
	require.NoError(t, err)
	assert.Equal(t, expiry.ExpiresAt, again.ExpiresAt)
	_, _, err = CompleteAppPaymentProvider(order.ID, "stripe", "trade-1", 99, "CNY")
	require.Error(t, err)
	paid, existing, err := CompleteAppPaymentProvider(order.ID, "stripe", "trade-1", 100, "CNY")
	require.NoError(t, err)
	assert.False(t, existing)
	assert.Equal(t, AppPaymentPaid, paid.Status)
	_, existing, err = CompleteAppPaymentProvider(order.ID, "stripe", "trade-1", 100, "CNY")
	require.NoError(t, err)
	assert.True(t, existing)
	second := f.order(t, "duplicate-trade")
	_, _, err = BeginAppPaymentProvider(second.ID, f.user.Id, "stripe", "stripe")
	require.NoError(t, err)
	require.NoError(t, SetAppPaymentProviderMerchant(second.ID, "stripe", "account"))
	_, _, err = CompleteAppPaymentProvider(second.ID, "stripe", "trade-1", 100, "CNY")
	require.Error(t, err)
	_, _, err = BeginAppPaymentRefund(f.client.ClientId, order.ID)
	require.NoError(t, err)
	require.NoError(t, SaveAppPaymentRefundProviderData(order.ID, "stripe", "refund-1"))
	require.Error(t, SaveAppPaymentRefundProviderData(order.ID, "stripe", "refund-2"))
	_, _, err = CompleteAppPaymentRefund(order.ID, "stripe", "refund-2")
	require.Error(t, err)
	refunded, _, err := CompleteAppPaymentRefund(order.ID, "stripe", "refund-1")
	require.NoError(t, err)
	assert.Equal(t, AppPaymentRefunded, refunded.Status)
	var events []PaymentWebhookEvent
	require.NoError(t, DB.Order("id").Find(&events).Error)
	require.Len(t, events, 2)
	assert.Equal(t, "payment.paid", events[0].EventType)
	assert.Equal(t, "payment.refunded", events[1].EventType)
	assert.Contains(t, events[0].Payload, `"status":"paid"`)
	assert.NotContains(t, events[0].Payload, "provider_trade")
	assert.NotContains(t, events[0].Payload, "balance_state")
	assert.Equal(t, 1000, paymentQuota(t, f.user.Id), "direct payment never credits a NewAPI wallet")
	require.NoError(t, DB.AutoMigrate(&PaymentApplication{}, &PaymentOrder{}, &PaymentWalletGuard{}, &PaymentWalletOperation{}, &PaymentWalletCacheWitness{}, &PaymentWalletMutation{}, &PaymentWebhookEvent{}))
}

func TestAppPaymentBalanceDatabaseIdempotencyAndRollback(t *testing.T) {
	f := setupAppPaymentModelTest(t, false)
	order := f.order(t, "database")
	paid, _, err := PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	require.NoError(t, err)
	assert.Equal(t, AppPaymentPaid, paid.Status)
	assert.Equal(t, 900, paymentQuota(t, f.user.Id))
	_, existing, err := PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	require.NoError(t, err)
	assert.True(t, existing)
	_, _, err = BeginAppPaymentRefund(f.client.ClientId, order.ID)
	require.NoError(t, err)
	_, _, err = RefundAppPaymentBalance(order.ID)
	require.NoError(t, err)
	_, existing, err = RefundAppPaymentBalance(order.ID)
	require.NoError(t, err)
	assert.True(t, existing)
	assert.Equal(t, 1000, paymentQuota(t, f.user.Id))
	var count int64
	require.NoError(t, DB.Model(&PaymentWebhookEvent{}).Count(&count).Error)
	assert.EqualValues(t, 2, count)
	broken := f.order(t, "rollback")
	require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("payment_fail_outbox", func(tx *gorm.DB) {
		if tx.Statement.Table == "payment_webhook_events" {
			tx.AddError(errors.New("injected outbox persistence failure"))
		}
	}))
	_, _, err = PayAppPaymentBalance(broken.ID, f.user.Id, 100, "1")
	require.Error(t, err)
	assert.Equal(t, 1000, paymentQuota(t, f.user.Id))
	require.NoError(t, DB.Callback().Create().Remove("payment_fail_outbox"))
	recovered, err := ReconcileAppPaymentWalletOperations(10)
	require.NoError(t, err)
	assert.Equal(t, 1, recovered)
	assert.Equal(t, 900, paymentQuota(t, f.user.Id))
}

func TestAppPaymentBalanceBatchSurvivesCacheExpiry(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	common.BatchUpdateEnabled = true
	// Upgrade case: an already warm user hash has no permanent mirror yet.
	require.NoError(t, populateUserCache(f.user))
	require.NoError(t, requireAppPaymentWalletCache(f.user.Id))
	assert.Equal(t, 1000, paymentMirror(t, f.user.Id))
	ok, err := TryReserveUserQuota(f.user.Id, 800)
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, 1000, paymentQuota(t, f.user.Id))
	assert.Equal(t, 200, paymentMirror(t, f.user.Id))
	require.NoError(t, invalidateUserCache(f.user.Id))
	cached, err := GetUserCache(f.user.Id)
	require.NoError(t, err)
	assert.Equal(t, 200, cached.Quota)
	tooLarge := f.order(t, "not-enough")
	_, _, err = PayAppPaymentBalance(tooLarge.ID, f.user.Id, 201, "1")
	assert.ErrorIs(t, err, ErrAppPaymentInsufficient)
	exact := f.order(t, "remaining")
	_, _, err = PayAppPaymentBalance(exact.ID, f.user.Id, 200, "1")
	require.NoError(t, err)
	assert.Zero(t, paymentMirror(t, f.user.Id))
	assert.Equal(t, 800, paymentQuota(t, f.user.Id))
	batchUpdate()
	assert.Zero(t, paymentQuota(t, f.user.Id))
	ok, err = TryReserveUserQuota(f.user.Id, 1)
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestAppPaymentWalletRecoveryGuardsAndUnknownRedisResult(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	common.BatchUpdateEnabled = true
	order := f.order(t, "interrupted")
	require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("payment_interrupt", func(tx *gorm.DB) {
		if tx.Statement.Table == "payment_webhook_events" {
			tx.AddError(errors.New("injected crash boundary"))
		}
	}))
	_, _, err := PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	require.Error(t, err)
	assert.Equal(t, 900, paymentMirror(t, f.user.Id))
	assert.Equal(t, 1000, paymentQuota(t, f.user.Id))
	ok, err := TryReserveUserQuota(f.user.Id, 1)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	assert.False(t, ok)
	// Disabling Redis cannot bypass the durable guard via a database fallback.
	common.RedisEnabled = false
	ok, err = TryReserveUserQuota(f.user.Id, 1)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	assert.False(t, ok)
	common.RedisEnabled = true
	require.NoError(t, DB.Callback().Create().Remove("payment_interrupt"))
	done, err := ReconcileAppPaymentWalletOperations(10)
	require.NoError(t, err)
	assert.Equal(t, 1, done)
	assert.Equal(t, 900, paymentQuota(t, f.user.Id))
	assert.Equal(t, 900, paymentMirror(t, f.user.Id))
	_, _, err = BeginAppPaymentRefund(f.client.ClientId, order.ID)
	require.NoError(t, err)
	require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("payment_interrupt_refund", func(tx *gorm.DB) {
		if tx.Statement.Table == "payment_webhook_events" {
			tx.AddError(errors.New("injected refund crash"))
		}
	}))
	_, _, err = RefundAppPaymentBalance(order.ID)
	require.Error(t, err)
	assert.Equal(t, 1000, paymentMirror(t, f.user.Id))
	assert.Equal(t, 900, paymentQuota(t, f.user.Id))
	ok, err = TryReserveUserQuota(f.user.Id, 950)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	assert.False(t, ok)
	require.NoError(t, DB.Callback().Create().Remove("payment_interrupt_refund"))
	done, err = ReconcileAppPaymentWalletOperations(10)
	require.NoError(t, err)
	assert.Equal(t, 1, done)
	assert.Equal(t, 1000, paymentQuota(t, f.user.Id))
	unknown := f.order(t, "unknown")
	require.NoError(t, requireAppPaymentWalletCache(f.user.Id))
	_, op, _, err := prepareAppPaymentWallet(unknown.ID, f.user.Id, 100, "1", "debit")
	require.NoError(t, err)
	require.NoError(t, DB.Model(op).Update("state", "cache_pending").Error)
	done, err = ReconcileAppPaymentWalletOperations(10)
	require.NoError(t, err)
	assert.Zero(t, done)
	assert.Equal(t, 1000, paymentMirror(t, f.user.Id))
	assert.Equal(t, 1000, paymentQuota(t, f.user.Id))
	var guards int64
	require.NoError(t, DB.Model(&PaymentWalletGuard{}).Where("user_id = ?", f.user.Id).Count(&guards).Error)
	assert.EqualValues(t, 1, guards)
}

func TestAppPaymentWalletMutationAndLostTrust(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	common.BatchUpdateEnabled = true
	order := f.order(t, "mutation")
	finish, err := BeginAppPaymentQuotaMutation(f.user.Id)
	require.NoError(t, err)
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	// Simulate a subscription DB/cache gap while a relay debit is still queued.
	ok, err := TryReserveUserQuota(f.user.Id, 600)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", f.user.Id).Update("quota", gorm.Expr("quota - ?", 300)).Error)
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 400, "1")
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	require.NoError(t, cacheDecrUserQuota(f.user.Id, 300))
	finish()
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 101, "1")
	assert.ErrorIs(t, err, ErrAppPaymentInsufficient)
	require.NoError(t, invalidateUserCache(f.user.Id))
	require.NoError(t, IncreaseUserQuota(f.user.Id, 50, true))
	assert.Equal(t, 150, paymentMirror(t, f.user.Id))
	cached, err := GetUserCache(f.user.Id)
	require.NoError(t, err)
	assert.Equal(t, 150, cached.Quota)
	// A failed DB credit must never manufacture cache money.
	require.NoError(t, DB.Callback().Update().Before("gorm:update").Register("payment_fail_credit", func(tx *gorm.DB) {
		if tx.Statement.Table == "users" {
			tx.AddError(errors.New("injected credit failure"))
		}
	}))
	err = IncreaseUserQuota(f.user.Id, 500, true)
	require.Error(t, err)
	assert.Equal(t, 150, paymentMirror(t, f.user.Id))
	require.NoError(t, DB.Callback().Update().Remove("payment_fail_credit"))
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
}

func TestAppPaymentWalletLostMirrorAndEpochFailClosed(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	common.BatchUpdateEnabled = true
	require.NoError(t, requireAppPaymentWalletCache(f.user.Id))
	ok, err := TryReserveUserQuota(f.user.Id, 800)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, common.RDB.Del(context.Background(), appPaymentWalletMirrorKey(f.user.Id)).Err())
	order := f.order(t, "lost-mirror")
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 500, "1")
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	require.NoError(t, common.RDB.Del(context.Background(), appPaymentWalletEpochKey).Err())
	require.Error(t, InitializeAppPaymentWalletCache())
	guard := PaymentWalletGuard{UserID: f.user.Id, OperationID: "lost-epoch-guard", CreatedAt: time.Now().Unix()}
	require.NoError(t, DB.Create(&guard).Error)
	require.NoError(t, invalidateUserCache(f.user.Id))
	_, err = GetUserCache(f.user.Id)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 1, "1")
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
}

func TestAppPaymentConcurrentOrdersCannotOverspend(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	common.BatchUpdateEnabled = true
	require.NoError(t, requireAppPaymentWalletCache(f.user.Id))
	first, second := f.order(t, "parallel-a"), f.order(t, "parallel-b")
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, order := range []*PaymentOrder{first, second} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			<-start
			_, _, err := PayAppPaymentBalance(id, f.user.Id, 700, "1")
			results <- err
		}(order.ID)
	}
	close(start)
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			assert.True(t, errors.Is(err, ErrAppPaymentBalancePending) || errors.Is(err, ErrAppPaymentInsufficient), fmt.Sprint(err))
		}
	}
	assert.Equal(t, 1, successes)
	assert.Equal(t, 300, paymentMirror(t, f.user.Id))
	assert.Equal(t, 300, paymentQuota(t, f.user.Id))
	var events int64
	require.NoError(t, DB.Model(&PaymentWebhookEvent{}).Where("event_type = ?", "payment.paid").Count(&events).Error)
	assert.EqualValues(t, 1, events)
	assert.False(t, strings.Contains(first.ID, "payment-test-client"))
}

func TestAppPaymentUnsafeWitnessFailureRetainsDurableFence(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	finish, err := BeginAppPaymentQuotaMutation(f.user.Id)
	require.NoError(t, err)
	require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("payment_fail_witness", func(tx *gorm.DB) {
		if tx.Statement.Table == "payment_wallet_cache_witnesses" {
			tx.AddError(errors.New("injected trust persistence failure"))
		}
	}))
	MarkAppPaymentWalletUnsafe(f.user.Id)
	require.NoError(t, DB.Callback().Create().Remove("payment_fail_witness"))
	finish()
	var count int64
	require.NoError(t, DB.Model(&PaymentWalletMutation{}).Where("user_id = ?", f.user.Id).Count(&count).Error)
	assert.EqualValues(t, 1, count)
	// A fresh process may have no local failure flag; the Redis unsafe marker
	// and the durable DB mutation still prevent spending the stale mirror.
	appPaymentWalletUnpersistedUnsafe.Clear()
	require.NoError(t, InitializeAppPaymentWalletCache())
	order := f.order(t, "unsafe-after-restart")
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	require.NoError(t, common.RDB.Del(context.Background(), appPaymentWalletUnsafeKey(f.user.Id)).Err())
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending, "durable mutation protects even after marker loss")
}

func TestAppPaymentPreparedGuardAndCommittedRecovery(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	order := f.order(t, "prepared")
	require.NoError(t, requireAppPaymentWalletCache(f.user.Id))
	_, op, _, err := prepareAppPaymentWallet(order.ID, f.user.Id, 100, "1", "debit")
	require.NoError(t, err)
	// No cache debit exists yet; the durable prepare protects the Redis-down
	// fallback. Recovery is allowed one first attempt from the prepared state.
	common.RedisEnabled = false
	ok, err := TryReserveUserQuota(f.user.Id, 900)
	assert.False(t, ok)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	common.RedisEnabled = true
	require.NoError(t, DB.Callback().Delete().Before("gorm:delete").Register("payment_interrupt_finish", func(tx *gorm.DB) {
		if tx.Statement.Table == "payment_wallet_guards" {
			tx.AddError(errors.New("injected after durable commit"))
		}
	}))
	require.Error(t, executeAppPaymentWallet(op))
	assert.Equal(t, 900, paymentQuota(t, f.user.Id))
	assert.Equal(t, 900, paymentMirror(t, f.user.Id))
	require.NoError(t, DB.Callback().Delete().Remove("payment_interrupt_finish"))
	require.NoError(t, common.RDB.Del(context.Background(), appPaymentWalletEpochKey).Err())
	require.Error(t, InitializeAppPaymentWalletCache())
	ok, err = TryReserveUserQuota(f.user.Id, 1)
	assert.False(t, ok)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending, "initialization failure still republishes this user's durable guard")
	done, err := ReconcileAppPaymentWalletOperations(10)
	require.NoError(t, err)
	assert.Equal(t, 1, done)
	assert.Equal(t, 900, paymentQuota(t, f.user.Id))
	assert.Equal(t, 900, paymentMirror(t, f.user.Id))
}

func TestAppPaymentConcurrentDatabasePaymentsSerializeUserBalance(t *testing.T) {
	f := setupAppPaymentModelTest(t, false)
	first, second := f.order(t, "db-parallel-a"), f.order(t, "db-parallel-b")
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, order := range []*PaymentOrder{first, second} {
		go func(id string) { <-start; _, _, err := PayAppPaymentBalance(id, f.user.Id, 700, "1"); results <- err }(order.ID)
	}
	close(start)
	successes := 0
	for range 2 {
		err := <-results
		if err == nil {
			successes++
		} else {
			assert.True(t, errors.Is(err, ErrAppPaymentBalancePending) || errors.Is(err, ErrAppPaymentInsufficient), fmt.Sprint(err))
		}
	}
	assert.Equal(t, 1, successes)
	assert.Equal(t, 300, paymentQuota(t, f.user.Id))
}

func TestAppPaymentReplayedOrphanGuardRecoversWithoutUnlockingPayment(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	require.NoError(t, requireAppPaymentWalletCache(f.user.Id))
	require.NoError(t, common.RDB.Set(context.Background(), appPaymentWalletGuardKey(f.user.Id), "old-finished-operation", 0).Err())
	ok, err := TryReserveUserQuota(f.user.Id, 1)
	require.NoError(t, err)
	assert.True(t, ok)
	order := f.order(t, "real-guard")
	_, _, _, err = prepareAppPaymentWallet(order.ID, f.user.Id, 100, "1", "debit")
	require.NoError(t, err)
	require.NoError(t, common.RDB.Set(context.Background(), appPaymentWalletGuardKey(f.user.Id), order.ID+":debit", 0).Err())
	ok, err = TryReserveUserQuota(f.user.Id, 1)
	assert.False(t, ok)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
}

func TestAppPaymentConcurrentFirstMirrorOnlyTemporarilyPending(t *testing.T) {
	f := setupAppPaymentModelTest(t, true)
	common.BatchUpdateEnabled = true
	require.NoError(t, populateUserCache(f.user))
	reached, release := make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	require.NoError(t, DB.Callback().Query().Before("gorm:query").Register("payment_pause_first_mirror", func(tx *gorm.DB) {
		if tx.Statement.Table == "users" && first.CompareAndSwap(false, true) {
			close(reached)
			<-release
		}
	}))
	result := make(chan error, 1)
	go func() { result <- ensureAppPaymentWalletMirror(f.user.Id, 0) }()
	<-reached
	// The first creator committed its witness, but has not yet initialized the
	// cache. A second caller must not poison the permanent trust witness.
	sqlDB, err := DB.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(2)
	ok, err := TryReserveUserQuota(f.user.Id, 100)
	assert.False(t, ok)
	assert.ErrorIs(t, err, ErrAppPaymentBalancePending)
	close(release)
	require.NoError(t, <-result)
	require.NoError(t, DB.Callback().Query().Remove("payment_pause_first_mirror"))
	var witness PaymentWalletCacheWitness
	require.NoError(t, DB.First(&witness, f.user.Id).Error)
	assert.False(t, witness.Unsafe)
	order := f.order(t, "first-mirror-retry")
	_, _, err = PayAppPaymentBalance(order.ID, f.user.Id, 100, "1")
	require.NoError(t, err)
	assert.Equal(t, 900, paymentMirror(t, f.user.Id))
	assert.Equal(t, 900, paymentQuota(t, f.user.Id))
}
