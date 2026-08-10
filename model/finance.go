package model

import (
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// CostDayStat 单日营收聚合结果
type CostDayStat struct {
	Date             string `json:"date" gorm:"column:date"`
	RevenueQuota     int64  `json:"revenue_quota" gorm:"column:revenue_quota"`
	CostQuota        int64  `json:"cost_quota" gorm:"column:cost_quota"`
	GrossProfitQuota int64  `json:"gross_profit_quota"`
	RequestCount     int64  `json:"request_count" gorm:"column:request_count"`
}

// UserDayStat 单日新增用户、付费用户数与付费金额
type UserDayStat struct {
	Date      string  `json:"date" gorm:"column:date"`
	NewUsers  int64   `json:"new_users" gorm:"column:new_users"`
	PaidUsers int64   `json:"paid_users" gorm:"column:paid_users"`
	PaidMoney float64 `json:"paid_money" gorm:"column:paid_money"`
}

// dayBucketExpr 返回把 unix 秒列截断为服务器本地时区日期的方言表达式
func dayBucketExpr(column string, logDB bool) string {
	if logDB {
		if common.UsingLogDatabase(common.DatabaseTypeMySQL) {
			return fmt.Sprintf("FROM_UNIXTIME(%s, '%%%%Y-%%%%m-%%%%d')", column)
		}
		if common.UsingLogDatabase(common.DatabaseTypePostgreSQL) {
			return fmt.Sprintf("TO_CHAR(TO_TIMESTAMP(%s), 'YYYY-MM-DD')", column)
		}
		if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
			return fmt.Sprintf("toDate(%s)", column)
		}
		return fmt.Sprintf("date(%s, 'unixepoch', 'localtime')", column)
	}
	if common.UsingMainDatabase(common.DatabaseTypeMySQL) {
		return fmt.Sprintf("FROM_UNIXTIME(%s, '%%%%Y-%%%%m-%%%%d')", column)
	}
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		return fmt.Sprintf("TO_CHAR(TO_TIMESTAMP(%s), 'YYYY-MM-DD')", column)
	}
	if common.UsingMainDatabase(common.DatabaseTypeClickHouse) {
		return fmt.Sprintf("toDate(%s)", column)
	}
	return fmt.Sprintf("date(%s, 'unixepoch', 'localtime')", column)
}

// fillDayGaps 把聚合结果按本地时区日期序列补零,保证窗口内每天一行
func fillDayGaps(startTimestamp, endTimestamp int64, dayStats map[string]CostDayStat) []CostDayStat {
	result := make([]CostDayStat, 0)
	for day := time.Unix(startTimestamp, 0).In(time.Local); !day.After(time.Unix(endTimestamp, 0).In(time.Local)); day = day.AddDate(0, 0, 1) {
		date := day.Format("2006-01-02")
		stat, ok := dayStats[date]
		if !ok {
			stat = CostDayStat{Date: date}
		}
		stat.GrossProfitQuota = stat.RevenueQuota - stat.CostQuota
		result = append(result, stat)
	}
	return result
}

// GetCostTrendByDay 按天聚合日志口径营收/成本/请求数,口径与 AggregateCost 一致
func GetCostTrendByDay(startTimestamp, endTimestamp int64) ([]CostDayStat, error) {
	query := LOG_DB.Table("logs").Where("type IN ?", []int{LogTypeConsume, LogTypeRefund}).
		Where("COALESCE(exclude_profit_stat, false) = false")
	if startTimestamp != 0 {
		query = query.Where("created_at >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		query = query.Where("created_at <= ?", endTimestamp)
	}
	dayExpr := dayBucketExpr("created_at", true)
	var rows []CostDayStat
	err := query.Select(fmt.Sprintf("%s AS date, COALESCE(SUM(CASE WHEN type = %d THEN -quota ELSE quota END),0) AS revenue_quota, COALESCE(SUM(cost_quota),0) AS cost_quota, COALESCE(SUM(CASE WHEN type = %d THEN 1 ELSE 0 END),0) AS request_count", dayExpr, LogTypeRefund, LogTypeConsume)).
		Group(dayExpr).Order("date ASC").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	byDate := make(map[string]CostDayStat, len(rows))
	for _, row := range rows {
		byDate[row.Date] = row
	}
	return fillDayGaps(startTimestamp, endTimestamp, byDate), nil
}

// GetPaidUserStats 统计成功充值用户数与金额:total/period 分别为累计与窗口内
func GetPaidUserStats(startTimestamp, endTimestamp int64) (paidTotal, paidPeriod int64, moneyTotal, moneyPeriod float64, err error) {
	if err := DB.Model(&TopUp{}).Where("status = ?", common.TopUpStatusSuccess).Distinct("user_id").Count(&paidTotal).Error; err != nil {
		return 0, 0, 0, 0, err
	}
	if err := DB.Model(&TopUp{}).Where("status = ?", common.TopUpStatusSuccess).Select("COALESCE(SUM(money),0)").Scan(&moneyTotal).Error; err != nil {
		return 0, 0, 0, 0, err
	}
	query := DB.Model(&TopUp{}).Where("status = ?", common.TopUpStatusSuccess)
	if startTimestamp != 0 {
		query = query.Where("complete_time >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		query = query.Where("complete_time <= ?", endTimestamp)
	}
	if err := query.Distinct("user_id").Count(&paidPeriod).Error; err != nil {
		return 0, 0, 0, 0, err
	}
	if err := query.Session(&gorm.Session{}).Select("COALESCE(SUM(money),0)").Scan(&moneyPeriod).Error; err != nil {
		return 0, 0, 0, 0, err
	}
	return paidTotal, paidPeriod, moneyTotal, moneyPeriod, nil
}

// GetUserGrowthByDay 按天统计新增注册用户数与成功充值付费用户数
func GetUserGrowthByDay(startTimestamp, endTimestamp int64) ([]UserDayStat, error) {
	dayExpr := dayBucketExpr("created_at", false)
	var newUsers []UserDayStat
	err := DB.Table("users").Select(fmt.Sprintf("%s AS date, COUNT(*) AS new_users", dayExpr)).
		Where("created_at >= ? AND created_at <= ?", startTimestamp, endTimestamp).
		Group(dayExpr).Scan(&newUsers).Error
	if err != nil {
		return nil, err
	}
	newByDate := make(map[string]int64, len(newUsers))
	for _, row := range newUsers {
		newByDate[row.Date] = row.NewUsers
	}
	paidExpr := dayBucketExpr("complete_time", false)
	var paidUsers []UserDayStat
	err = DB.Table("top_ups").Select(fmt.Sprintf("%s AS date, COUNT(DISTINCT user_id) AS paid_users, COALESCE(SUM(money),0) AS paid_money", paidExpr)).
		Where("status = ? AND complete_time >= ? AND complete_time <= ?", common.TopUpStatusSuccess, startTimestamp, endTimestamp).
		Group(paidExpr).Scan(&paidUsers).Error
	if err != nil {
		return nil, err
	}
	paidByDate := make(map[string]UserDayStat, len(paidUsers))
	for _, row := range paidUsers {
		paidByDate[row.Date] = row
	}
	result := make([]UserDayStat, 0)
	for day := time.Unix(startTimestamp, 0).In(time.Local); !day.After(time.Unix(endTimestamp, 0).In(time.Local)); day = day.AddDate(0, 0, 1) {
		date := day.Format("2006-01-02")
		paid := paidByDate[date]
		result = append(result, UserDayStat{Date: date, NewUsers: newByDate[date], PaidUsers: paid.PaidUsers, PaidMoney: paid.PaidMoney})
	}
	return result, nil
}
