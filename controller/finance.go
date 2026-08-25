package controller

import (
	"encoding/csv"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

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

// financeRange 解析账单/资金日志接口的时间范围:优先 start/end,兼容 start_timestamp/end_timestamp。
func financeRange(c *gin.Context) (int64, int64) {
	start, _ := strconv.ParseInt(c.Query("start"), 10, 64)
	end, _ := strconv.ParseInt(c.Query("end"), 10, 64)
	if start == 0 {
		start, _ = strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	}
	if end == 0 {
		end, _ = strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	}
	if end == 0 {
		end = time.Now().Unix()
	}
	if start == 0 {
		start = end - 30*86400
	}
	return start, end
}

// financePageQuery 解析分页参数:默认 page=1/size=50,size 上限 200。
func financePageQuery(c *gin.Context) (int, int) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.Query("size"))
	if size < 1 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	return page, size
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
	manualIncomeMoney, manualExpenseMoney, manualIncomeQuota, manualExpenseQuota, err := model.GetManualAdjustment(start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// 手动调整并入毛利:收入加到 revenue、支出加到 cost,再算 gross/margin;
	// 原有自动统计字段(请求数/成本覆盖率/付费用户等)保持不变,新增 manual 字段。
	revenueQuota := report.RevenueQuota + manualIncomeQuota
	costQuota := report.CostQuota + manualExpenseQuota
	grossProfitQuota := revenueQuota - costQuota
	var margin float64
	if revenueQuota > 0 {
		margin = float64(grossProfitQuota) / float64(revenueQuota)
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"revenue_quota":        revenueQuota,
			"cost_quota":           costQuota,
			"gross_profit_quota":   grossProfitQuota,
			"margin":               margin,
			"request_count":        report.RequestCount,
			"cost_coverage":        report.CostCoverage,
			"paid_users_total":     paidTotal,
			"paid_users_period":    paidPeriod,
			"paid_money_total":     moneyTotal,
			"paid_money_period":    moneyPeriod,
			"manual_income_money":  manualIncomeMoney,
			"manual_expense_money": manualExpenseMoney,
			"manual_income_quota":  manualIncomeQuota,
			"manual_expense_quota": manualExpenseQuota,
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
	// 手动调整按天并入对应的营收/成本日
	manualByDay, err := model.GetManualAdjustmentByDay(start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	for i := range cost {
		if adj, ok := manualByDay[cost[i].Date]; ok {
			cost[i].RevenueQuota += adj.IncomeQuota
			cost[i].CostQuota += adj.ExpenseQuota
			cost[i].GrossProfitQuota = cost[i].RevenueQuota - cost[i].CostQuota
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"cost":   cost,
			"users":  users,
			"manual": manualByDay,
		},
	})
}

// GetFinanceBills 合并账单:query 参数 page/size(默认 1/50,size≤200)/type/username/start/end。
func GetFinanceBills(c *gin.Context) {
	page, size := financePageQuery(c)
	billType := c.Query("type")
	username := c.Query("username")
	start, end := financeRange(c)
	bills, total, err := model.GetFinanceBills(page, size, billType, username, start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"items": bills,
			"total": total,
			"page":  page,
			"size":  size,
		},
	})
}

// ExportFinanceBills 导出全部账单为 CSV(不分页,应用 start/end/type/username 过滤)。
func ExportFinanceBills(c *gin.Context) {
	billType := c.Query("type")
	username := c.Query("username")
	start, end := financeRange(c)
	bills, _, err := model.GetFinanceBills(1, 0, billType, username, start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", "attachment; filename="+strconv.Quote("finance_bills_"+time.Now().Format("20060102_150405")+".csv"))
	// UTF-8 BOM,便于 Excel 直接打开识别编码
	if _, err := c.Writer.WriteString("\xEF\xBB\xBF"); err != nil {
		return
	}
	// 防 CSV 公式注入:以 = + - @ 开头的用户可控单元格加单引号前缀
	escapeCSVCell := func(s string) string {
		if s != "" {
			switch s[0] {
			case '=', '+', '-', '@':
				return "'" + s
			}
		}
		return s
	}
	writer := csv.NewWriter(c.Writer)
	writeRow := func(row []string) {
		if err := writer.Write(row); err != nil {
			common.SysError(fmt.Sprintf("finance bills csv write failed: %v", err))
		}
	}
	writeRow([]string{"time", "type", "username", "amount_money", "note", "source"})
	for _, b := range bills {
		writeRow([]string{
			time.Unix(b.Time, 0).In(time.Local).Format("2006-01-02 15:04:05"),
			b.Type,
			escapeCSVCell(b.Username),
			strconv.FormatFloat(b.AmountMoney, 'f', 2, 64),
			escapeCSVCell(b.Note),
			b.Source,
		})
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		common.SysError(fmt.Sprintf("finance bills csv flush failed: %v", err))
	}
}

// GetFinanceFundsLog 资金变动日志:query 参数 page/size/type(数字)/username/start/end。
func GetFinanceFundsLog(c *gin.Context) {
	page, size := financePageQuery(c)
	username := c.Query("username")
	// 兼容字符串("topup"/"consume"/"refund")与数字(1/2/6)两种类型参数
	logType, _ := strconv.Atoi(c.Query("type"))
	if logType == 0 {
		switch c.Query("type") {
		case "topup":
			logType = model.LogTypeTopup
		case "consume":
			logType = model.LogTypeConsume
		case "refund":
			logType = model.LogTypeRefund
		}
	}
	start, end := financeRange(c)
	items, total, err := model.GetFundsLog(page, size, username, logType, start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"items": items,
			"total": total,
			"page":  page,
			"size":  size,
		},
	})
}

// ListFinanceEntries 手动收支条目列表:query 参数 page/size/type(income|expense)/start/end。
func ListFinanceEntries(c *gin.Context) {
	page, size := financePageQuery(c)
	entryType := c.Query("entry_type")
	if entryType == "" {
		entryType = c.Query("type")
	}
	start, _ := strconv.ParseInt(c.Query("start"), 10, 64)
	end, _ := strconv.ParseInt(c.Query("end"), 10, 64)
	entries, total, err := model.ListFinanceEntries(page, size, entryType, start, end)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"items": entries,
			"total": total,
			"page":  page,
			"size":  size,
		},
	})
}

// validateFinanceEntry 校验手动收支条目:类型、金额(>0 且 ≤1e8)、备注(≤2000)、分类(≤64)。
func validateFinanceEntry(entry *model.FinanceEntry) error {
	if entry.EntryType != "income" && entry.EntryType != "expense" {
		return errors.New("收支类型必须为 income 或 expense")
	}
	if entry.Amount <= 0 || entry.Amount > 1e8 {
		return errors.New("金额必须大于 0 且不超过 1e8")
	}
	if utf8.RuneCountInString(entry.Note) > 2000 {
		return errors.New("备注长度不能超过 2000 字符")
	}
	if utf8.RuneCountInString(entry.Category) > 64 {
		return errors.New("分类长度不能超过 64 字符")
	}
	return nil
}

func CreateFinanceEntry(c *gin.Context) {
	var entry model.FinanceEntry
	if err := c.ShouldBindJSON(&entry); err != nil {
		common.ApiErrorMsg(c, "无效的请求参数: "+err.Error())
		return
	}
	if err := validateFinanceEntry(&entry); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	entry.CreatedBy = c.GetInt("id")
	if err := model.CreateFinanceEntry(&entry); err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    entry,
	})
}

func UpdateFinanceEntry(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		common.ApiErrorMsg(c, "无效的收支条目 ID")
		return
	}
	var entry model.FinanceEntry
	if err := c.ShouldBindJSON(&entry); err != nil {
		common.ApiErrorMsg(c, "无效的请求参数: "+err.Error())
		return
	}
	if err := validateFinanceEntry(&entry); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	if err := model.UpdateFinanceEntry(id, &entry); err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    entry,
	})
}

func DeleteFinanceEntry(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		common.ApiErrorMsg(c, "无效的收支条目 ID")
		return
	}
	if err := model.DeleteFinanceEntry(id); err != nil {
		common.ApiError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
