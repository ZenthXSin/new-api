package controller

import (
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func financeTimeRange(c *gin.Context) (int64, int64) {
	start, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	end, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	if end == 0 {
		end = time.Now().Unix()
	}
	if start == 0 {
		start = end - 30*86400
	}
	return start, end
}

func GetFinanceOverview(c *gin.Context) {
	start, end := financeTimeRange(c)
	report, err := model.AggregateCost(start, end, 0, "", "", "", "")
	if err != nil {
		common.ApiError(c, err)
		return
	}
	paidTotal, paidPeriod, moneyTotal, moneyPeriod, err := model.GetPaidUserStats(start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"revenue_quota":      report.RevenueQuota,
			"cost_quota":         report.CostQuota,
			"gross_profit_quota": report.GrossProfitQuota,
			"margin":             report.Margin,
			"request_count":      report.RequestCount,
			"cost_coverage":      report.CostCoverage,
			"paid_users_total":   paidTotal,
			"paid_users_period":  paidPeriod,
			"paid_money_total":   moneyTotal,
			"paid_money_period":  moneyPeriod,
		},
	})
}

func GetFinanceTrends(c *gin.Context) {
	start, end := financeTimeRange(c)
	cost, err := model.GetCostTrendByDay(start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	users, err := model.GetUserGrowthByDay(start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"cost":  cost,
			"users": users,
		},
	})
}
