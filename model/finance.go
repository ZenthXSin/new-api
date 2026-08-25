package model

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
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

// ---------------------------------------------------------------------------
// 手动收支条目(finance_entries)
// ---------------------------------------------------------------------------

// FinanceEntry 手动收支条目:金额恒为正,方向由 EntryType(income|expense)决定。
// 用于财务概览/账单中的人工调整项,由管理员经 finance/entries 接口维护。
type FinanceEntry struct {
	Id        int64   `json:"id"`
	EntryType string  `json:"entry_type" gorm:"size:16"` // income | expense
	Category  string  `json:"category" gorm:"size:64;default:''"`
	Amount    float64 `json:"amount" gorm:"type:decimal(12,2)"` // 恒为正,方向由 EntryType 决定
	Note      string  `json:"note" gorm:"type:text"`
	CreatedBy int     `json:"created_by"`
	CreatedAt int64   `json:"created_at" gorm:"bigint;index"`
	UpdatedAt int64   `json:"updated_at" gorm:"bigint"`
}

func (FinanceEntry) TableName() string {
	return "finance_entries"
}

func (e *FinanceEntry) BeforeCreate(tx *gorm.DB) error {
	now := time.Now().Unix()
	e.CreatedAt = now
	e.UpdatedAt = now
	return nil
}

var (
	ErrFinanceEntryNotFound  = errors.New("finance entry not found")
	ErrInvalidFinanceEntryId = errors.New("invalid finance entry id")
)

func CreateFinanceEntry(entry *FinanceEntry) error {
	return DB.Create(entry).Error
}

// UpdateFinanceEntry 更新手动收支条目内容并刷新 updated_at;条目不存在时返回错误。
func UpdateFinanceEntry(id int64, entry *FinanceEntry) error {
	if id <= 0 {
		return ErrInvalidFinanceEntryId
	}
	entry.Id = id
	entry.UpdatedAt = time.Now().Unix()
	result := DB.Model(&FinanceEntry{}).Where("id = ?", id).Updates(map[string]any{
		"entry_type": entry.EntryType,
		"category":   entry.Category,
		"amount":     entry.Amount,
		"note":       entry.Note,
		"updated_at": entry.UpdatedAt,
	})
	if result.Error != nil {
		return result.Error
	}
	// MySQL 的 changed-rows 语义与 SQLite 下"原样保存"都可能返回 0 行受影响,
	// 不能据此判定不存在;改为显式确认记录存在。
	var exists int64
	if err := DB.Model(&FinanceEntry{}).Where("id = ?", id).Count(&exists).Error; err != nil {
		return err
	}
	if exists == 0 {
		return ErrFinanceEntryNotFound
	}
	return nil
}

func DeleteFinanceEntry(id int64) error {
	if id <= 0 {
		return ErrInvalidFinanceEntryId
	}
	result := DB.Delete(&FinanceEntry{}, id)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrFinanceEntryNotFound
	}
	return nil
}

// ListFinanceEntries 分页查询手动收支条目,entryType 为空表示全部,按 created_at 倒序。
func ListFinanceEntries(page, size int, entryType string, start, end int64) ([]FinanceEntry, int64, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 50
	}
	query := DB.Model(&FinanceEntry{})
	if entryType != "" {
		query = query.Where("entry_type = ?", entryType)
	}
	if start != 0 {
		query = query.Where("created_at >= ?", start)
	}
	if end != 0 {
		query = query.Where("created_at <= ?", end)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var entries []FinanceEntry
	if err := query.Order("created_at DESC, id DESC").Limit(size).Offset((page - 1) * size).Find(&entries).Error; err != nil {
		return nil, 0, err
	}
	return entries, total, nil
}

// GetManualAdjustment 汇总窗口内手动收支金额,并按 QuotaPerUnit 折算为 quota
// (折算经 common.QuotaRound 饱和处理,遵循计费安全约定)。start/end 为 0 表示不设边界。
func GetManualAdjustment(start, end int64) (incomeMoney, expenseMoney float64, incomeQuota, expenseQuota int64, err error) {
	query := DB.Model(&FinanceEntry{})
	if start != 0 {
		query = query.Where("created_at >= ?", start)
	}
	if end != 0 {
		query = query.Where("created_at <= ?", end)
	}
	var row struct {
		Income  float64 `gorm:"column:income"`
		Expense float64 `gorm:"column:expense"`
	}
	if err := query.Select("COALESCE(SUM(CASE WHEN entry_type = 'income' THEN amount ELSE 0 END), 0) AS income, COALESCE(SUM(CASE WHEN entry_type = 'expense' THEN amount ELSE 0 END), 0) AS expense").Scan(&row).Error; err != nil {
		return 0, 0, 0, 0, err
	}
	incomeMoney = row.Income
	expenseMoney = row.Expense
	incomeQuota = int64(common.QuotaRound(incomeMoney * common.QuotaPerUnit))
	expenseQuota = int64(common.QuotaRound(expenseMoney * common.QuotaPerUnit))
	return incomeMoney, expenseMoney, incomeQuota, expenseQuota, nil
}

// ManualDayAdjust 单日手动收支调整汇总(按服务器本地时区日期分桶),供趋势图并入。
type ManualDayAdjust struct {
	Date         string  `json:"date"`
	IncomeMoney  float64 `json:"income_money"`
	ExpenseMoney float64 `json:"expense_money"`
	IncomeQuota  int64   `json:"income_quota"`
	ExpenseQuota int64   `json:"expense_quota"`
}

// GetManualAdjustmentByDay 按本地时区日期汇总手动收支,返回 date("2006-01-02") → 汇总。
func GetManualAdjustmentByDay(start, end int64) (map[string]ManualDayAdjust, error) {
	query := DB.Model(&FinanceEntry{})
	if start != 0 {
		query = query.Where("created_at >= ?", start)
	}
	if end != 0 {
		query = query.Where("created_at <= ?", end)
	}
	var entries []FinanceEntry
	if err := query.Find(&entries).Error; err != nil {
		return nil, err
	}
	result := make(map[string]ManualDayAdjust)
	for _, e := range entries {
		date := time.Unix(e.CreatedAt, 0).In(time.Local).Format("2006-01-02")
		adj := result[date]
		if e.EntryType == "expense" {
			adj.ExpenseMoney += e.Amount
		} else {
			adj.IncomeMoney += e.Amount
		}
		result[date] = adj
	}
	for date, adj := range result {
		adj.IncomeQuota = int64(common.QuotaRound(adj.IncomeMoney * common.QuotaPerUnit))
		adj.ExpenseQuota = int64(common.QuotaRound(adj.ExpenseMoney * common.QuotaPerUnit))
		result[date] = adj
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// 合并账单
// ---------------------------------------------------------------------------

// FinanceBill 合并账单中的单条记录:金额带符号(收入+ 支出-)。
type FinanceBill struct {
	Time        int64   `json:"time"`
	Type        string  `json:"type"`
	Username    string  `json:"username"`
	AmountMoney float64 `json:"amount_money"` // 带符号:收入+ 支出-
	Note        string  `json:"note"`
	Source      string  `json:"source"`
}

// quotaToMoney 把 quota 折算为货币金额,保留 2 位小数(账单展示口径)。
func quotaToMoney(quota int) float64 {
	return math.Round(float64(quota)/common.QuotaPerUnit*100) / 100
}

// GetFinanceBills 合并五类收支来源(充值/退款/订阅购买/邀请分红/手动条目),按时间倒序
// 内存分页。数据量评估:topups/orders/affiliate/refund/entries 合计数量级小(千级),
// 因此先分别查询再在内存中合并分页,避免跨库 JOIN 与方言差异。
// billType 为空表示全部;username 筛选对 logs 类用 username 列、对充值与订阅用 users
// 关联;手动条目无用户名,username 筛选时整类跳过;size <= 0 表示不分页返回全部(导出用)。
func GetFinanceBills(page, size int, billType, username string, start, end int64) ([]FinanceBill, int64, error) {
	if page < 1 {
		page = 1
	}
	bills := make([]FinanceBill, 0)

	// a. 充值:top_ups status=success,时间取 complete_time
	var topupRows []struct {
		Time        int64   `gorm:"column:bill_time"`
		Username    string  `gorm:"column:username"`
		AmountMoney float64 `gorm:"column:amount_money"`
		Note        string  `gorm:"column:note"`
	}
	topupQuery := DB.Table("top_ups").
		Select("top_ups.complete_time AS bill_time, COALESCE(users.username, '') AS username, top_ups.money AS amount_money, COALESCE(top_ups.payment_method, '') AS note").
		Joins("LEFT JOIN users ON users.id = top_ups.user_id").
		Where("top_ups.status = ?", common.TopUpStatusSuccess)
	if start != 0 {
		topupQuery = topupQuery.Where("top_ups.complete_time >= ?", start)
	}
	if end != 0 {
		topupQuery = topupQuery.Where("top_ups.complete_time <= ?", end)
	}
	if username != "" {
		topupQuery = topupQuery.Where("users.username = ?", username)
	}
	if err := topupQuery.Order("top_ups.id ASC").Scan(&topupRows).Error; err != nil {
		return nil, 0, err
	}
	for _, r := range topupRows {
		bills = append(bills, FinanceBill{Time: r.Time, Type: "topup", Username: r.Username, AmountMoney: r.AmountMoney, Note: r.Note, Source: "topup"})
	}

	// b. 退款:LOG_DB logs type=Refund,金额 = -quota 折算
	var refundRows []struct {
		Time     int64  `gorm:"column:bill_time"`
		Username string `gorm:"column:username"`
		Quota    int    `gorm:"column:quota"`
		Note     string `gorm:"column:note"`
	}
	refundQuery := LOG_DB.Table("logs").
		Select("created_at AS bill_time, COALESCE(username, '') AS username, quota, COALESCE(content, '') AS note").
		Where("type = ?", LogTypeRefund)
	if start != 0 {
		refundQuery = refundQuery.Where("created_at >= ?", start)
	}
	if end != 0 {
		refundQuery = refundQuery.Where("created_at <= ?", end)
	}
	if username != "" {
		refundQuery = refundQuery.Where("username = ?", username)
	}
	if err := refundQuery.Order("logs.id ASC").Scan(&refundRows).Error; err != nil {
		return nil, 0, err
	}
	for _, r := range refundRows {
		bills = append(bills, FinanceBill{Time: r.Time, Type: "refund", Username: r.Username, AmountMoney: -quotaToMoney(r.Quota), Note: r.Note, Source: "refund"})
	}

	// c. 订阅购买:subscription_orders status=success,时间取 complete_time
	var subRows []struct {
		Time        int64   `gorm:"column:bill_time"`
		Username    string  `gorm:"column:username"`
		AmountMoney float64 `gorm:"column:amount_money"`
	}
	subQuery := DB.Table("subscription_orders").
		Select("subscription_orders.complete_time AS bill_time, COALESCE(users.username, '') AS username, subscription_orders.money AS amount_money").
		Joins("LEFT JOIN users ON users.id = subscription_orders.user_id").
		Where("subscription_orders.status = ?", common.TopUpStatusSuccess)
	if start != 0 {
		subQuery = subQuery.Where("subscription_orders.complete_time >= ?", start)
	}
	if end != 0 {
		subQuery = subQuery.Where("subscription_orders.complete_time <= ?", end)
	}
	if username != "" {
		subQuery = subQuery.Where("users.username = ?", username)
	}
	if err := subQuery.Order("subscription_orders.id ASC").Scan(&subRows).Error; err != nil {
		return nil, 0, err
	}
	for _, r := range subRows {
		bills = append(bills, FinanceBill{Time: r.Time, Type: "subscription", Username: r.Username, AmountMoney: r.AmountMoney, Note: "", Source: "subscription"})
	}

	// d. 邀请分红:LOG_DB logs type=Topup 且 content 含"分红"(recordTopUpAffiliateLog 写入)
	var affiliateRows []struct {
		Time     int64  `gorm:"column:bill_time"`
		Username string `gorm:"column:username"`
		Quota    int    `gorm:"column:quota"`
		Note     string `gorm:"column:note"`
	}
	affiliateQuery := LOG_DB.Table("logs").
		Select("created_at AS bill_time, COALESCE(username, '') AS username, quota, COALESCE(content, '') AS note").
		Where("type = ?", LogTypeTopup).
		Where("content LIKE ?", "%分红%")
	if start != 0 {
		affiliateQuery = affiliateQuery.Where("created_at >= ?", start)
	}
	if end != 0 {
		affiliateQuery = affiliateQuery.Where("created_at <= ?", end)
	}
	if username != "" {
		affiliateQuery = affiliateQuery.Where("username = ?", username)
	}
	if err := affiliateQuery.Order("logs.id ASC").Scan(&affiliateRows).Error; err != nil {
		return nil, 0, err
	}
	for _, r := range affiliateRows {
		bills = append(bills, FinanceBill{Time: r.Time, Type: "affiliate", Username: r.Username, AmountMoney: quotaToMoney(r.Quota), Note: r.Note, Source: "affiliate"})
	}

	// e. 手动条目:finance_entries(无用户名,username 筛选时整类跳过)
	if username == "" {
		entryQuery := DB.Model(&FinanceEntry{})
		if start != 0 {
			entryQuery = entryQuery.Where("created_at >= ?", start)
		}
		if end != 0 {
			entryQuery = entryQuery.Where("created_at <= ?", end)
		}
		var entries []FinanceEntry
		if err := entryQuery.Order("finance_entries.id ASC").Find(&entries).Error; err != nil {
			return nil, 0, err
		}
		for _, e := range entries {
			amount := e.Amount
			if e.EntryType == "expense" {
				amount = -amount
			}
			bills = append(bills, FinanceBill{Time: e.CreatedAt, Type: e.EntryType, AmountMoney: amount, Note: e.Note, Source: "manual"})
		}
	}

	// 合并:时间倒序,同时间按类型升序;稳定排序保证同源记录保持源查询顺序(分页不重不漏)
	sort.SliceStable(bills, func(i, j int) bool {
		if bills[i].Time != bills[j].Time {
			return bills[i].Time > bills[j].Time
		}
		return bills[i].Type < bills[j].Type
	})
	if billType != "" {
		filtered := bills[:0]
		for _, b := range bills {
			if b.Type == billType {
				filtered = append(filtered, b)
			}
		}
		bills = filtered
	}
	total := int64(len(bills))
	if size > 0 {
		startIdx := (page - 1) * size
		if startIdx > len(bills) {
			return []FinanceBill{}, total, nil
		}
		endIdx := startIdx + size
		if endIdx > len(bills) {
			endIdx = len(bills)
		}
		bills = bills[startIdx:endIdx]
	}
	return bills, total, nil
}

// ---------------------------------------------------------------------------
// 资金日志
// ---------------------------------------------------------------------------

// FundsLogItem 资金变动日志条目:quota_delta 带符号(消耗-,充值/退款/分红+)。
type FundsLogItem struct {
	Time        int64  `json:"time"`
	Username    string `json:"username"`
	Type        string `json:"type"`
	QuotaDelta  int64  `json:"quota_delta"`
	Description string `json:"description"`
}

func fundsLogTypeName(logType int) string {
	switch logType {
	case LogTypeTopup:
		return "topup"
	case LogTypeConsume:
		return "consume"
	case LogTypeRefund:
		return "refund"
	}
	return strconv.Itoa(logType)
}

// GetFundsLog 分页查询资金变动日志(LOG_DB,type IN Topup/Consume/Refund),倒序 created_at。
// quota_delta:Consume 为 -quota、Refund/Topup 为 +quota;Description:Consume 优先取
// model_name,否则取 content 摘要(200 字符截断),Topup/Refund 取 content。
func GetFundsLog(page, size int, username string, logType int, start, end int64) ([]FundsLogItem, int64, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 50
	}
	query := LOG_DB.Table("logs").Where("type IN ?", []int{LogTypeTopup, LogTypeConsume, LogTypeRefund})
	if username != "" {
		query = query.Where("username = ?", username)
	}
	if logType != 0 {
		query = query.Where("type = ?", logType)
	}
	if start != 0 {
		query = query.Where("created_at >= ?", start)
	}
	if end != 0 {
		query = query.Where("created_at <= ?", end)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []struct {
		CreatedAt int64  `gorm:"column:created_at"`
		Type      int    `gorm:"column:type"`
		Content   string `gorm:"column:content"`
		Username  string `gorm:"column:username"`
		ModelName string `gorm:"column:model_name"`
		Quota     int    `gorm:"column:quota"`
	}
	if err := query.Select("created_at, type, content, username, model_name, quota").
		Order("created_at DESC, id DESC").Limit(size).Offset((page - 1) * size).Scan(&rows).Error; err != nil {
		return nil, 0, err
	}
	items := make([]FundsLogItem, 0, len(rows))
	for _, r := range rows {
		delta := int64(r.Quota)
		if r.Type == LogTypeConsume {
			delta = -delta
		}
		desc := r.Content
		if r.Type == LogTypeConsume && r.ModelName != "" {
			desc = r.ModelName
		}
		if runes := []rune(desc); len(runes) > 200 {
			desc = string(runes[:200]) + "..."
		}
		items = append(items, FundsLogItem{
			Time:        r.CreatedAt,
			Username:    r.Username,
			Type:        fundsLogTypeName(r.Type),
			QuotaDelta:  delta,
			Description: desc,
		})
	}
	return items, total, nil
}
