package model

import (
	"math"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestChannelCostMultiplierNormalization(t *testing.T) {
	assert.Equal(t, DefaultChannelCostMultiplier, NormalizeChannelCostMultiplier(0))
	assert.Equal(t, 2.5, NormalizeChannelCostMultiplier(2.5))
	assert.Zero(t, NormalizeChannelCostMultiplier(-1))
	assert.Zero(t, NormalizeChannelCostMultiplier(MaxChannelCostMultiplier+1))
	assert.Zero(t, NormalizeChannelCostMultiplier(math.Inf(1)))
	assert.Zero(t, NormalizeChannelCostMultiplier(math.NaN()))
	assert.Equal(t, DefaultChannelCostMultiplier, (&Channel{}).GetCostMultiplier())
}

func TestLogCostFieldsAreNotSerialized(t *testing.T) {
	data, err := common.Marshal(Log{Quota: 100, BaseCostQuota: 50, CostQuota: 60, CostMultiplierSnapshot: 1.2})
	require.NoError(t, err)
	var serialized map[string]any
	require.NoError(t, common.Unmarshal(data, &serialized))
	assert.Equal(t, float64(100), serialized["quota"])
	assert.NotContains(t, serialized, "base_cost_quota")
	assert.NotContains(t, serialized, "cost_quota")
	assert.NotContains(t, serialized, "cost_multiplier_snapshot")
}

func TestFormatUserLogsStripsCostAdminInfo(t *testing.T) {
	logs := []*Log{{Other: common.MapToJsonStr(map[string]interface{}{
		"admin_info": map[string]interface{}{
			"base_cost_quota":          50,
			"cost_quota":               60,
			"cost_multiplier_snapshot": 1.2,
			"gross_profit_quota":       40,
		},
	})}}
	formatUserLogs(logs, 0)
	parsed, err := common.StrToMap(logs[0].Other)
	require.NoError(t, err)
	assert.NotContains(t, parsed, "admin_info")
}

func TestAggregateCostFiltersAndFormula(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Log{}))
	previous := LOG_DB
	previousGroupCol := logGroupCol
	LOG_DB, logGroupCol = db, "`group`"
	t.Cleanup(func() { LOG_DB, logGroupCol = previous, previousGroupCol })
	require.NoError(t, db.Create(&Log{Type: LogTypeConsume, CreatedAt: 10, ChannelId: 1, Username: "alice", TokenName: "primary", ModelName: "a", Group: "g", Quota: 100, CostQuota: 40, CostMultiplierSnapshot: 1}).Error)
	require.NoError(t, db.Create(&Log{Type: LogTypeRefund, CreatedAt: 11, ChannelId: 1, Username: "alice", TokenName: "primary", ModelName: "a", Group: "g", Quota: 20, CostQuota: -8, CostMultiplierSnapshot: 1}).Error)
	require.NoError(t, db.Create(&Log{Type: LogTypeConsume, CreatedAt: 12, ChannelId: 1, Username: "bob", TokenName: "secondary", ModelName: "a", Group: "g", Quota: 30, CostQuota: 10, CostMultiplierSnapshot: 1}).Error)
	require.NoError(t, db.Create(&Log{Type: LogTypeConsume, CreatedAt: 20, ChannelId: 2, ModelName: "b", Group: "g", Quota: 90, CostQuota: 0}).Error)
	report, err := AggregateCost(0, 15, 1, "a", "", "", "g")
	require.NoError(t, err)
	assert.Equal(t, int64(110), report.RevenueQuota)
	assert.Equal(t, int64(42), report.CostQuota)
	assert.Equal(t, int64(68), report.GrossProfitQuota)
	assert.Equal(t, int64(2), report.RequestCount)
	assert.Equal(t, 1.0, report.CostCoverage)

	filtered, err := AggregateCost(0, 15, 1, "a", "alice", "primary", "g")
	require.NoError(t, err)
	assert.Equal(t, int64(80), filtered.RevenueQuota)
	assert.Equal(t, int64(32), filtered.CostQuota)
	assert.Equal(t, int64(1), filtered.RequestCount)
}

func TestAggregateCostExcludesProfitStatRows(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Log{}))
	previous := LOG_DB
	previousGroupCol := logGroupCol
	LOG_DB, logGroupCol = db, "`group`"
	t.Cleanup(func() { LOG_DB, logGroupCol = previous, previousGroupCol })

	// 被排除令牌的消费与退款成对写入（消费排除则退款也排除）
	require.NoError(t, db.Create(&Log{Type: LogTypeConsume, CreatedAt: 10, ChannelId: 1, Username: "excluded", ModelName: "m", Quota: 500, CostQuota: 200, CostMultiplierSnapshot: 1, ExcludeProfitStat: true}).Error)
	require.NoError(t, db.Create(&Log{Type: LogTypeRefund, CreatedAt: 11, ChannelId: 1, Username: "excluded", ModelName: "m", Quota: 100, CostQuota: -40, CostMultiplierSnapshot: 1, ExcludeProfitStat: true}).Error)
	// 正常令牌的消费与退款（应计入）
	require.NoError(t, db.Create(&Log{Type: LogTypeConsume, CreatedAt: 12, ChannelId: 1, Username: "regular", ModelName: "m", Quota: 300, CostQuota: 120, CostMultiplierSnapshot: 1}).Error)
	require.NoError(t, db.Create(&Log{Type: LogTypeRefund, CreatedAt: 13, ChannelId: 1, Username: "regular", ModelName: "m", Quota: 50, CostQuota: -20, CostMultiplierSnapshot: 1}).Error)

	report, err := AggregateCost(0, 100, 0, "", "", "", "")
	require.NoError(t, err)
	// 仅统计普通令牌：revenue = 300 - 50，cost = 120 - 20，请求数仅计消费
	assert.Equal(t, int64(250), report.RevenueQuota)
	assert.Equal(t, int64(100), report.CostQuota)
	assert.Equal(t, int64(150), report.GrossProfitQuota)
	assert.Equal(t, int64(1), report.RequestCount)

	// 日志明细查询不受排除标记影响，被排除的记录仍完整可见
	logs, total, err := GetAllLogs(LogTypeUnknown, 0, 100, "", "", "", 0, 100, 0, "", "", "")
	require.NoError(t, err)
	assert.Equal(t, int64(4), total)
	assert.Len(t, logs, 4)
}

func TestLogCostColumnsMigrateOnSQLite(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Log{}))
	assert.True(t, db.Migrator().HasColumn(&Log{}, "base_cost_quota"))
	assert.True(t, db.Migrator().HasColumn(&Log{}, "cost_quota"))
	assert.True(t, db.Migrator().HasColumn(&Log{}, "cost_multiplier_snapshot"))
}
