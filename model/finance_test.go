package model

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// External DSNs must name isolated test databases; log DSNs may name a separate
// database to exercise deployments that keep consumption logs outside the main DB.
func TestFinanceTrendDatabaseMatrix(t *testing.T) {
	for _, dialect := range []struct {
		name   common.DatabaseType
		env    string
		logEnv string
	}{
		{common.DatabaseTypeSQLite, "", ""},
		{common.DatabaseTypeMySQL, "TEST_FINANCE_MYSQL_DSN", "TEST_FINANCE_MYSQL_LOG_DSN"},
		{common.DatabaseTypePostgreSQL, "TEST_FINANCE_POSTGRES_DSN", "TEST_FINANCE_POSTGRES_LOG_DSN"},
	} {
		t.Run(string(dialect.name), func(t *testing.T) {
			if dialect.env != "" && os.Getenv(dialect.env) == "" {
				t.Skip(dialect.env + " is not configured")
			}
			openDB := func(dsn string) *gorm.DB {
				var driver gorm.Dialector = sqlite.Open(":memory:")
				switch dialect.name {
				case common.DatabaseTypeMySQL:
					driver = mysql.Open(dsn)
				case common.DatabaseTypePostgreSQL:
					driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
				}
				db, err := gorm.Open(driver, &gorm.Config{})
				require.NoError(t, err)
				sqlDB, err := db.DB()
				require.NoError(t, err)
				sqlDB.SetMaxOpenConns(1)
				t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
				versionQuery := "SELECT version()"
				if dialect.name == common.DatabaseTypeSQLite {
					versionQuery = "SELECT sqlite_version()"
				}
				var version string
				require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
				t.Logf("database: %s", version)
				return db
			}
			db := openDB(os.Getenv(dialect.env))
			logDB := db
			if logDSN := os.Getenv(dialect.logEnv); logDSN != "" || dialect.name == common.DatabaseTypeSQLite {
				logDB = openDB(logDSN)
			}
			previousDB, previousLogDB := DB, LOG_DB
			previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
			DB, LOG_DB = db, logDB
			common.SetDatabaseTypes(dialect.name, dialect.name)
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMainType, previousLogType)
			})
			require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &FinanceEntry{}))
			require.NoError(t, logDB.AutoMigrate(&Log{}))

			start := time.Date(2026, time.June, 1, 0, 0, 0, 0, time.Local)
			day1, day2 := start.Unix(), start.AddDate(0, 0, 1).Unix()
			end := start.AddDate(0, 0, 3).Unix() - 1
			logs := []Log{
				{CreatedAt: day1, Type: LogTypeConsume, Quota: 100, CostQuota: 30},
				{CreatedAt: day1, Type: LogTypeConsume, Quota: 50, CostQuota: 10},
				{CreatedAt: day1, Type: LogTypeRefund, Quota: 40, CostQuota: 5},
				{CreatedAt: day1, Type: LogTypeConsume, Quota: 999, ExcludeProfitStat: true},
				{CreatedAt: day2, Type: LogTypeConsume, Quota: 200, CostQuota: 60},
				{CreatedAt: end + 1, Type: LogTypeConsume, Quota: 999},
			}
			require.NoError(t, logDB.Create(&logs).Error)
			t.Cleanup(func() { require.NoError(t, logDB.Delete(&logs).Error) })
			users := []User{
				{Username: "finance-matrix-user-1", AffCode: "finance-matrix-1", CreatedAt: day1},
				{Username: "finance-matrix-user-2", AffCode: "finance-matrix-2", CreatedAt: day1},
				{Username: "finance-matrix-user-3", AffCode: "finance-matrix-3", CreatedAt: day2},
			}
			require.NoError(t, db.Create(&users).Error)
			t.Cleanup(func() { require.NoError(t, db.Unscoped().Delete(&users).Error) })
			topups := []TopUp{
				{UserId: users[0].Id, TradeNo: "finance-matrix-paid-1", Money: 15, Status: common.TopUpStatusSuccess, CompleteTime: day1},
				{UserId: users[0].Id, TradeNo: "finance-matrix-paid-2", Money: 5, Status: common.TopUpStatusSuccess, CompleteTime: day1},
				{UserId: users[1].Id, TradeNo: "finance-matrix-paid-3", Money: 25, Status: common.TopUpStatusSuccess, CompleteTime: day2},
				{UserId: users[2].Id, TradeNo: "finance-matrix-pending", Money: 99, Status: common.TopUpStatusPending, CompleteTime: day2},
			}
			require.NoError(t, db.Create(&topups).Error)
			t.Cleanup(func() { require.NoError(t, db.Delete(&topups).Error) })
			entries := []FinanceEntry{{EntryType: "income", Amount: 2}, {EntryType: "expense", Amount: 1}}
			for i := range entries {
				insertFinanceEntryAt(t, &entries[i], day1)
			}
			t.Cleanup(func() { require.NoError(t, db.Delete(&entries).Error) })

			cost, err := GetCostTrendByDay(day1, end)
			require.NoError(t, err)
			assert.Equal(t, []CostDayStat{
				{Date: "2026-06-01", RevenueQuota: 110, CostQuota: 45, GrossProfitQuota: 65, RequestCount: 2},
				{Date: "2026-06-02", RevenueQuota: 200, CostQuota: 60, GrossProfitQuota: 140, RequestCount: 1},
				{Date: "2026-06-03"},
			}, cost)
			growth, err := GetUserGrowthByDay(day1, end)
			require.NoError(t, err)
			assert.Equal(t, []UserDayStat{
				{Date: "2026-06-01", NewUsers: 2, PaidUsers: 1, PaidMoney: 20},
				{Date: "2026-06-02", NewUsers: 1, PaidUsers: 1, PaidMoney: 25},
				{Date: "2026-06-03"},
			}, growth)
			manual, err := GetManualAdjustmentByDay(day1, end)
			require.NoError(t, err)
			assert.Equal(t, map[string]ManualDayAdjust{
				"2026-06-01": {IncomeMoney: 2, ExpenseMoney: 1, IncomeQuota: int64(2 * common.QuotaPerUnit), ExpenseQuota: int64(common.QuotaPerUnit)},
			}, manual)
		})
	}
}

func insertFinanceLog(t *testing.T, ts int64, logType int, quota int, costQuota int, exclude bool) {
	t.Helper()
	require.NoError(t, DB.Create(&Log{CreatedAt: ts, Type: logType, Quota: quota, CostQuota: costQuota, ExcludeProfitStat: exclude}).Error)
}

func insertFinanceTopUp(t *testing.T, userID int, completeTime int64, status string) {
	t.Helper()
	insertFinanceTopUpWithMoney(t, userID, completeTime, status, 1)
}

func insertFinanceTopUpWithMoney(t *testing.T, userID int, completeTime int64, status string, money float64) {
	t.Helper()
	require.NoError(t, DB.Create(&TopUp{UserId: userID, TradeNo: fmt.Sprintf("%d-%d-%f", userID, completeTime, money), Amount: 1, Money: money, Status: status, CreateTime: completeTime, CompleteTime: completeTime}).Error)
}

func TestGetCostTrendByDayAggregatesAndFillsGaps(t *testing.T) {
	truncateTables(t)
	now := time.Now()
	day1Start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	day1 := day1Start.Add(-24 * time.Hour).Unix()
	day2 := day1Start.Unix()

	insertFinanceLog(t, day1, LogTypeConsume, 100, 30, false)
	insertFinanceLog(t, day1, LogTypeConsume, 50, 10, false)
	insertFinanceLog(t, day1, LogTypeRefund, 40, 5, false)
	insertFinanceLog(t, day1, LogTypeConsume, 999, 99, true)
	insertFinanceLog(t, day2, LogTypeConsume, 200, 60, false)

	windowStart := day1Start.Add(-48 * time.Hour).Unix()
	windowEnd := day1Start.Add(24 * time.Hour).Unix()
	trend, err := GetCostTrendByDay(windowStart, windowEnd)
	require.NoError(t, err)
	require.Len(t, trend, 4)

	assert.Equal(t, day1Start.Add(-48*time.Hour).Format("2006-01-02"), trend[0].Date)
	assert.Zero(t, trend[0].RevenueQuota)
	assert.Zero(t, trend[0].CostQuota)

	assert.Equal(t, day1Start.Add(-24*time.Hour).Format("2006-01-02"), trend[1].Date)
	assert.Equal(t, int64(100+50-40), trend[1].RevenueQuota)
	assert.Equal(t, int64(30+10+5), trend[1].CostQuota)
	assert.Equal(t, int64(110-45), trend[1].GrossProfitQuota)
	assert.Equal(t, int64(2), trend[1].RequestCount)

	assert.Equal(t, day1Start.Format("2006-01-02"), trend[2].Date)
	assert.Equal(t, int64(200), trend[2].RevenueQuota)
	assert.Equal(t, int64(60), trend[2].CostQuota)

	empty := trend[3]
	assert.Equal(t, day1Start.Add(24*time.Hour).Format("2006-01-02"), empty.Date)
	assert.Zero(t, empty.RevenueQuota)
	assert.Zero(t, empty.CostQuota)
	assert.Zero(t, empty.RequestCount)
}

func TestGetCostTrendByDayHonorsWindowBoundaries(t *testing.T) {
	truncateTables(t)
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	insertFinanceLog(t, dayStart.Unix(), LogTypeConsume, 100, 10, false)
	insertFinanceLog(t, dayStart.Add(24*time.Hour).Unix(), LogTypeConsume, 100, 10, false)

	trend, err := GetCostTrendByDay(dayStart.Unix(), dayStart.Add(24*time.Hour).Unix()-1)
	require.NoError(t, err)
	require.Len(t, trend, 1)
	assert.Equal(t, int64(100), trend[0].RevenueQuota)
}

func TestGetPaidUserStatsDistinctAndWindow(t *testing.T) {
	truncateTables(t)
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	insertFinanceTopUpWithMoney(t, 1, dayStart.Add(-48*time.Hour).Unix(), common.TopUpStatusSuccess, 10)
	insertFinanceTopUpWithMoney(t, 1, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusSuccess, 5.5)
	insertFinanceTopUpWithMoney(t, 2, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusSuccess, 20)
	insertFinanceTopUpWithMoney(t, 3, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusPending, 30)
	insertFinanceTopUpWithMoney(t, 4, dayStart.Add(24*time.Hour).Unix()+1, common.TopUpStatusSuccess, 40)

	windowStart := dayStart.Add(-48 * time.Hour).Unix()
	windowEnd := dayStart.Add(24 * time.Hour).Unix()
	total, period, moneyTotal, moneyPeriod, err := GetPaidUserStats(windowStart, windowEnd)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	assert.Equal(t, int64(2), period)
	assert.InDelta(t, 75.5, moneyTotal, 0.0001)
	assert.InDelta(t, 35.5, moneyPeriod, 0.0001)
}

func TestGetUserGrowthByDayMergesNewAndPaidUsers(t *testing.T) {
	truncateTables(t)
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	require.NoError(t, DB.Create(&User{Username: "u1", AffCode: "aff-u1", CreatedAt: dayStart.Add(-24 * time.Hour).Unix()}).Error)
	require.NoError(t, DB.Create(&User{Username: "u2", AffCode: "aff-u2", CreatedAt: dayStart.Add(-24 * time.Hour).Unix()}).Error)
	require.NoError(t, DB.Create(&User{Username: "u3", AffCode: "aff-u3", CreatedAt: dayStart.Unix()}).Error)
	insertFinanceTopUpWithMoney(t, 2, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusSuccess, 15)
	insertFinanceTopUpWithMoney(t, 2, dayStart.Unix(), common.TopUpStatusSuccess, 25)

	windowStart := dayStart.Add(-48 * time.Hour).Unix()
	windowEnd := dayStart.Add(24 * time.Hour).Unix()
	users, err := GetUserGrowthByDay(windowStart, windowEnd)
	require.NoError(t, err)
	require.Len(t, users, 4)
	assert.Equal(t, dayStart.Add(-48*time.Hour).Format("2006-01-02"), users[0].Date)
	assert.Zero(t, users[0].NewUsers)
	assert.Zero(t, users[0].PaidUsers)
	assert.Zero(t, users[0].PaidMoney)
	assert.Equal(t, dayStart.Add(-24*time.Hour).Format("2006-01-02"), users[1].Date)
	assert.Equal(t, int64(2), users[1].NewUsers)
	assert.Equal(t, int64(1), users[1].PaidUsers)
	assert.InDelta(t, 15, users[1].PaidMoney, 0.0001)
	assert.Equal(t, dayStart.Format("2006-01-02"), users[2].Date)
	assert.Equal(t, int64(1), users[2].NewUsers)
	assert.Equal(t, int64(1), users[2].PaidUsers)
	assert.InDelta(t, 25, users[2].PaidMoney, 0.0001)
}

// ---------------------------------------------------------------------------
// 手动收支条目 / 合并账单 / 资金日志(独立内存 SQLite,临时接管 DB/LOG_DB)
// ---------------------------------------------------------------------------

// financeTestDB 为账单/资金日志/收支条目测试创建独立的内存 SQLite 并迁移所需表,
// 临时接管 model.DB/LOG_DB,测试结束后恢复。
func financeTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB, previousLogDB := DB, LOG_DB
	previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &SubscriptionOrder{}, &Log{}, &FinanceEntry{}))
	DB, LOG_DB = db, db
	t.Cleanup(func() {
		DB, LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMainType, previousLogType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
	return db
}

// insertFinanceEntryAt 创建手动收支条目并把 created_at 固定为指定时间(BeforeCreate 强制为 now)。
func insertFinanceEntryAt(t *testing.T, entry *FinanceEntry, createdAt int64) {
	t.Helper()
	require.NoError(t, CreateFinanceEntry(entry))
	require.NoError(t, DB.Model(&FinanceEntry{}).Where("id = ?", entry.Id).Update("created_at", createdAt).Error)
}

func TestFinanceEntryCRUD(t *testing.T) {
	financeTestDB(t)
	before := time.Now().Unix()

	income := &FinanceEntry{EntryType: "income", Category: "赞助", Amount: 100.5, Note: "赞助收入", CreatedBy: 1}
	require.NoError(t, CreateFinanceEntry(income))
	require.Positive(t, income.Id)
	require.GreaterOrEqual(t, income.CreatedAt, before)
	assert.Equal(t, income.CreatedAt, income.UpdatedAt)
	incomeID := income.Id

	expense := &FinanceEntry{EntryType: "expense", Category: "服务器", Amount: 30.25, Note: "服务器费用", CreatedBy: 2}
	require.NoError(t, CreateFinanceEntry(expense))
	require.Positive(t, expense.Id)
	// 错开 created_at 以便验证排序与时间过滤
	require.NoError(t, DB.Model(&FinanceEntry{}).Where("id = ?", expense.Id).Update("created_at", income.CreatedAt-100).Error)

	// 列表:created_at 倒序(income 更新)
	entries, total, err := ListFinanceEntries(1, 10, "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Len(t, entries, 2)
	assert.Equal(t, income.Id, entries[0].Id)
	assert.Equal(t, expense.Id, entries[1].Id)

	// 类型筛选
	entries, total, err = ListFinanceEntries(1, 10, "income", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	require.Len(t, entries, 1)
	assert.Equal(t, income.Id, entries[0].Id)

	// 分页
	entries, total, err = ListFinanceEntries(1, 1, "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Len(t, entries, 1)
	assert.Equal(t, income.Id, entries[0].Id)
	entries, total, err = ListFinanceEntries(2, 1, "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Len(t, entries, 1)
	assert.Equal(t, expense.Id, entries[0].Id)

	// 时间范围(闭区间)
	entries, total, err = ListFinanceEntries(1, 10, "", income.CreatedAt-100, income.CreatedAt-100)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	require.Len(t, entries, 1)
	assert.Equal(t, expense.Id, entries[0].Id)

	// 更新:金额/备注生效,updated_at 刷新
	income.Amount = 200
	income.Note = "赞助收入(更新)"
	require.NoError(t, UpdateFinanceEntry(income.Id, income))
	var reloaded FinanceEntry
	require.NoError(t, DB.First(&reloaded, income.Id).Error)
	assert.Equal(t, 200.0, reloaded.Amount)
	assert.Equal(t, "赞助收入(更新)", reloaded.Note)
	assert.GreaterOrEqual(t, reloaded.UpdatedAt, reloaded.CreatedAt)

	// 更新不存在的 id / 非法 id(UpdateFinanceEntry 会把 entry.Id 置为目标 id,
	// 因此用 incomeID 继续后续断言)
	require.ErrorIs(t, UpdateFinanceEntry(999999, income), ErrFinanceEntryNotFound)
	require.ErrorIs(t, UpdateFinanceEntry(0, income), ErrInvalidFinanceEntryId)

	// 删除
	require.NoError(t, DeleteFinanceEntry(expense.Id))
	entries, total, err = ListFinanceEntries(1, 10, "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	require.Len(t, entries, 1)
	assert.Equal(t, incomeID, entries[0].Id)
	// 重复删除 / 非法 id
	require.ErrorIs(t, DeleteFinanceEntry(expense.Id), ErrFinanceEntryNotFound)
	require.ErrorIs(t, DeleteFinanceEntry(0), ErrInvalidFinanceEntryId)
}

func TestGetManualAdjustmentSumsAndConverts(t *testing.T) {
	financeTestDB(t)
	base := time.Date(2026, 8, 25, 12, 0, 0, 0, time.Local).Unix()

	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "income", Amount: 100.5, Note: "窗口内收入"}, base-2*86400)
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "expense", Amount: 50.25, Note: "窗口内支出"}, base-2*86400)
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "income", Amount: 200, Note: "窗口内收入2"}, base-86400)
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "expense", Amount: 30, Note: "窗口外(早)"}, base-3*86400)
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "income", Amount: 500, Note: "窗口外(晚)"}, base)

	// 窗口 [base-2d, base-1d]:收入 300.5、支出 50.25
	incomeMoney, expenseMoney, incomeQuota, expenseQuota, err := GetManualAdjustment(base-2*86400, base-86400)
	require.NoError(t, err)
	assert.InDelta(t, 300.5, incomeMoney, 0.0001)
	assert.InDelta(t, 50.25, expenseMoney, 0.0001)
	assert.Equal(t, int64(150250000), incomeQuota)
	assert.Equal(t, int64(25125000), expenseQuota)

	// 全量:收入 800.5、支出 80.25
	incomeMoney, expenseMoney, incomeQuota, expenseQuota, err = GetManualAdjustment(0, 0)
	require.NoError(t, err)
	assert.InDelta(t, 800.5, incomeMoney, 0.0001)
	assert.InDelta(t, 80.25, expenseMoney, 0.0001)
	assert.Equal(t, int64(400250000), incomeQuota)
	assert.Equal(t, int64(40125000), expenseQuota)
}

func TestGetManualAdjustmentByDayBucketsLocalDates(t *testing.T) {
	financeTestDB(t)
	base := time.Date(2026, 8, 25, 12, 0, 0, 0, time.Local).Unix()

	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "income", Amount: 100.5, Note: "d-2"}, base-2*86400)
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "expense", Amount: 50.25, Note: "d-1"}, base-86400)
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "income", Amount: 200, Note: "d-1"}, base-86400)

	byDay, err := GetManualAdjustmentByDay(base-2*86400, base)
	require.NoError(t, err)
	require.Len(t, byDay, 2)

	dayMinus2 := time.Unix(base-2*86400, 0).In(time.Local).Format("2006-01-02")
	adj := byDay[dayMinus2]
	assert.InDelta(t, 100.5, adj.IncomeMoney, 0.0001)
	assert.Zero(t, adj.ExpenseMoney)
	assert.Equal(t, int64(50250000), adj.IncomeQuota)
	assert.Zero(t, adj.ExpenseQuota)

	dayMinus1 := time.Unix(base-86400, 0).In(time.Local).Format("2006-01-02")
	adj = byDay[dayMinus1]
	assert.InDelta(t, 200, adj.IncomeMoney, 0.0001)
	assert.InDelta(t, 50.25, adj.ExpenseMoney, 0.0001)
	assert.Equal(t, int64(100000000), adj.IncomeQuota)
	assert.Equal(t, int64(25125000), adj.ExpenseQuota)
}

func TestGetFinanceBillsMergesAllSources(t *testing.T) {
	financeTestDB(t)
	base := time.Date(2026, 8, 25, 12, 0, 0, 0, time.Local).Unix()

	u1 := &User{Username: "bill-u1", AffCode: "bill-aff-u1"}
	require.NoError(t, DB.Create(u1).Error)
	u2 := &User{Username: "bill-u2", AffCode: "bill-aff-u2"}
	require.NoError(t, DB.Create(u2).Error)

	// a. 充值:成功(payment_method 作为 note)+ 未成功(pending 不计入)
	require.NoError(t, DB.Create(&TopUp{UserId: u1.Id, Money: 10.5, TradeNo: "bill-topup-1", PaymentMethod: "stripe", Status: common.TopUpStatusSuccess, CreateTime: base - 5000, CompleteTime: base - 5000}).Error)
	require.NoError(t, DB.Create(&TopUp{UserId: u2.Id, Money: 99, TradeNo: "bill-topup-pending", PaymentMethod: "epay", Status: common.TopUpStatusPending, CreateTime: base - 4000, CompleteTime: base - 4000}).Error)

	// b. 退款日志:quota 500000 → -1.00
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 4000, Type: LogTypeRefund, Username: "bill-u1", Quota: 500000, Content: "退款 1 元"}).Error)

	// c. 订阅购买
	require.NoError(t, DB.Create(&SubscriptionOrder{UserId: u2.Id, PlanId: 1, Money: 20, TradeNo: "bill-sub-1", Status: common.TopUpStatusSuccess, CreateTime: base - 3000, CompleteTime: base - 3000}).Error)

	// d. 邀请分红(含"分红")与普通充值日志(不含"分红",不计入账单)
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 2000, Type: LogTypeTopup, Username: "bill-u1", Quota: 250000, Content: "邀请的用户(ID:2)充值 50,按倍率 0.1 获得分红 25"}).Error)
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 1000, Type: LogTypeTopup, Username: "bill-u2", Quota: 100000, Content: "充值成功获得额度"}).Error)

	// e. 手动条目:income @ base-1500,expense @ base-500
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "income", Category: "赞助", Amount: 100, Note: "赞助收入", CreatedBy: 1}, base-1500)
	insertFinanceEntryAt(t, &FinanceEntry{EntryType: "expense", Category: "服务器", Amount: 30.5, Note: "服务器费用", CreatedBy: 1}, base-500)

	// 全部:按时间倒序 expense(-30.5) → income(+100) → affiliate(+0.5) → subscription(+20) → refund(-1) → topup(+10.5)
	bills, total, err := GetFinanceBills(1, 10, "", "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(6), total)
	require.Len(t, bills, 6)

	assert.Equal(t, "expense", bills[0].Type)
	assert.Equal(t, "manual", bills[0].Source)
	assert.InDelta(t, -30.5, bills[0].AmountMoney, 0.0001)
	assert.Equal(t, "服务器费用", bills[0].Note)

	assert.Equal(t, "income", bills[1].Type)
	assert.InDelta(t, 100, bills[1].AmountMoney, 0.0001)

	assert.Equal(t, "affiliate", bills[2].Type)
	assert.Equal(t, "bill-u1", bills[2].Username)
	assert.InDelta(t, 0.5, bills[2].AmountMoney, 0.0001)
	assert.Contains(t, bills[2].Note, "分红")

	assert.Equal(t, "subscription", bills[3].Type)
	assert.Equal(t, "bill-u2", bills[3].Username)
	assert.InDelta(t, 20, bills[3].AmountMoney, 0.0001)

	assert.Equal(t, "refund", bills[4].Type)
	assert.Equal(t, "bill-u1", bills[4].Username)
	assert.InDelta(t, -1.0, bills[4].AmountMoney, 0.0001)

	assert.Equal(t, "topup", bills[5].Type)
	assert.Equal(t, "bill-u1", bills[5].Username)
	assert.InDelta(t, 10.5, bills[5].AmountMoney, 0.0001)
	assert.Equal(t, "stripe", bills[5].Note)

	// 类型筛选
	bills, total, err = GetFinanceBills(1, 10, "topup", "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	assert.Equal(t, "topup", bills[0].Type)
	bills, total, err = GetFinanceBills(1, 10, "affiliate", "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	assert.Equal(t, "affiliate", bills[0].Type)

	// 用户名筛选(充值与订阅走 users 关联,退款/分红走 logs.username,手动条目无用户名)
	bills, total, err = GetFinanceBills(1, 10, "", "bill-u1", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(3), total)
	assert.Equal(t, "affiliate", bills[0].Type)
	assert.Equal(t, "refund", bills[1].Type)
	assert.Equal(t, "topup", bills[2].Type)
	bills, total, err = GetFinanceBills(1, 10, "", "bill-u2", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	assert.Equal(t, "subscription", bills[0].Type)

	// 分页
	bills, total, err = GetFinanceBills(1, 2, "", "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(6), total)
	require.Len(t, bills, 2)
	assert.Equal(t, "expense", bills[0].Type)
	assert.Equal(t, "income", bills[1].Type)
	bills, total, err = GetFinanceBills(2, 2, "", "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(6), total)
	require.Len(t, bills, 2)
	assert.Equal(t, "affiliate", bills[0].Type)
	assert.Equal(t, "subscription", bills[1].Type)
	bills, total, err = GetFinanceBills(4, 2, "", "", 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(6), total)
	require.Empty(t, bills)

	// 时间范围(闭区间)
	bills, total, err = GetFinanceBills(1, 10, "", "", base-4000, base-3000)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	assert.Equal(t, "subscription", bills[0].Type)
	assert.Equal(t, "refund", bills[1].Type)
}

func TestGetFundsLogDeltasAndFilters(t *testing.T) {
	financeTestDB(t)
	base := time.Date(2026, 8, 25, 12, 0, 0, 0, time.Local).Unix()

	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 5000, Type: LogTypeTopup, Username: "fund-u1", Quota: 500000, Content: "充值 100 元"}).Error)
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 4000, Type: LogTypeConsume, Username: "fund-u1", Quota: 3000, ModelName: "gpt-4o", Content: "消耗额度 3000"}).Error)
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 3000, Type: LogTypeRefund, Username: "fund-u2", Quota: 2000, Content: "退款 2000"}).Error)
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 2000, Type: LogTypeConsume, Username: "fund-u2", Quota: 5000, Content: "消耗额度 5000"}).Error)
	// 非资金类型:登录/管理日志不计入
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 1000, Type: LogTypeLogin, Username: "fund-u1", Quota: 1, Content: "登录"}).Error)
	require.NoError(t, LOG_DB.Create(&Log{CreatedAt: base - 500, Type: LogTypeManage, Username: "fund-u1", Quota: 1, Content: "管理操作"}).Error)

	items, total, err := GetFundsLog(1, 10, "", 0, 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(4), total)
	require.Len(t, items, 4)
	// 倒序:consume(u2,-5000) → refund(u2,+2000) → consume(u1,-3000,描述取 model_name) → topup(u1,+500000)
	assert.Equal(t, "consume", items[0].Type)
	assert.Equal(t, int64(-5000), items[0].QuotaDelta)
	assert.Equal(t, "消耗额度 5000", items[0].Description)
	assert.Equal(t, "refund", items[1].Type)
	assert.Equal(t, int64(2000), items[1].QuotaDelta)
	assert.Equal(t, "consume", items[2].Type)
	assert.Equal(t, int64(-3000), items[2].QuotaDelta)
	assert.Equal(t, "gpt-4o", items[2].Description)
	assert.Equal(t, "topup", items[3].Type)
	assert.Equal(t, int64(500000), items[3].QuotaDelta)
	assert.Equal(t, "充值 100 元", items[3].Description)

	// 用户名筛选
	items, total, err = GetFundsLog(1, 10, "fund-u1", 0, 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	assert.Equal(t, "fund-u1", items[0].Username)
	assert.Equal(t, "fund-u1", items[1].Username)

	// 类型筛选
	items, total, err = GetFundsLog(1, 10, "", LogTypeConsume, 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	items, total, err = GetFundsLog(1, 10, "", LogTypeRefund, 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	assert.Equal(t, "refund", items[0].Type)

	// 时间范围
	items, total, err = GetFundsLog(1, 10, "", 0, base-4000, base-3000)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	assert.Equal(t, "refund", items[0].Type)
	assert.Equal(t, "consume", items[1].Type)

	// 分页
	items, total, err = GetFundsLog(2, 3, "", 0, 0, 0)
	require.NoError(t, err)
	require.Equal(t, int64(4), total)
	require.Len(t, items, 1)
	assert.Equal(t, "topup", items[0].Type)
}
