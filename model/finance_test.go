package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func insertFinanceLog(t *testing.T, ts int64, logType int, quota int, costQuota int, exclude bool) {
	t.Helper()
	require.NoError(t, DB.Create(&Log{CreatedAt: ts, Type: logType, Quota: quota, CostQuota: costQuota, ExcludeProfitStat: exclude}).Error)
}

func insertFinanceTopUp(t *testing.T, userID int, completeTime int64, status string) {
	t.Helper()
	require.NoError(t, DB.Create(&TopUp{UserId: userID, TradeNo: time.Now().String() + string(rune(userID)), Amount: 1, Money: 1, Status: status, CreateTime: completeTime, CompleteTime: completeTime}).Error)
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
	insertFinanceTopUp(t, 1, dayStart.Add(-48*time.Hour).Unix(), common.TopUpStatusSuccess)
	insertFinanceTopUp(t, 1, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusSuccess)
	insertFinanceTopUp(t, 2, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusSuccess)
	insertFinanceTopUp(t, 3, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusPending)
	insertFinanceTopUp(t, 4, dayStart.Add(24*time.Hour).Unix()+1, common.TopUpStatusSuccess)

	windowStart := dayStart.Add(-48 * time.Hour).Unix()
	windowEnd := dayStart.Add(24 * time.Hour).Unix()
	total, period, err := GetPaidUserStats(windowStart, windowEnd)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	assert.Equal(t, int64(2), period)
}

func TestGetUserGrowthByDayMergesNewAndPaidUsers(t *testing.T) {
	truncateTables(t)
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	require.NoError(t, DB.Create(&User{Username: "u1", AffCode: "aff-u1", CreatedAt: dayStart.Add(-24 * time.Hour).Unix()}).Error)
	require.NoError(t, DB.Create(&User{Username: "u2", AffCode: "aff-u2", CreatedAt: dayStart.Add(-24 * time.Hour).Unix()}).Error)
	require.NoError(t, DB.Create(&User{Username: "u3", AffCode: "aff-u3", CreatedAt: dayStart.Unix()}).Error)
	insertFinanceTopUp(t, 2, dayStart.Add(-24*time.Hour).Unix(), common.TopUpStatusSuccess)
	insertFinanceTopUp(t, 2, dayStart.Unix(), common.TopUpStatusSuccess)

	windowStart := dayStart.Add(-48 * time.Hour).Unix()
	windowEnd := dayStart.Add(24 * time.Hour).Unix()
	users, err := GetUserGrowthByDay(windowStart, windowEnd)
	require.NoError(t, err)
	require.Len(t, users, 4)
	assert.Equal(t, dayStart.Add(-48*time.Hour).Format("2006-01-02"), users[0].Date)
	assert.Zero(t, users[0].NewUsers)
	assert.Zero(t, users[0].PaidUsers)
	assert.Equal(t, dayStart.Add(-24*time.Hour).Format("2006-01-02"), users[1].Date)
	assert.Equal(t, int64(2), users[1].NewUsers)
	assert.Equal(t, int64(1), users[1].PaidUsers)
	assert.Equal(t, dayStart.Format("2006-01-02"), users[2].Date)
	assert.Equal(t, int64(1), users[2].NewUsers)
	assert.Equal(t, int64(1), users[2].PaidUsers)
}
