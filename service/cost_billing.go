package service

import (
	"math"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/shopspring/decimal"
)

type CostSnapshot struct {
	BaseCostQuota int
	CostQuota     int
	Multiplier    float64
}

func AppendCostSnapshotAdminInfo(other map[string]interface{}, snapshot CostSnapshot, revenue int, source string) {
	if other == nil {
		return
	}
	adminInfo, ok := other["admin_info"].(map[string]interface{})
	if !ok || adminInfo == nil {
		adminInfo = map[string]interface{}{}
		other["admin_info"] = adminInfo
	}
	if snapshot.Multiplier > 0 {
		adminInfo["cost_coverage"] = "actual_usage"
		adminInfo["cost_source"] = source
		adminInfo["base_cost_quota"] = snapshot.BaseCostQuota
		adminInfo["cost_quota"] = snapshot.CostQuota
		adminInfo["cost_multiplier_snapshot"] = snapshot.Multiplier
		adminInfo["gross_profit_quota"] = revenue - snapshot.CostQuota
		return
	}
	if source == "retained_upstream_cost" {
		adminInfo["cost_coverage"] = "retained_upstream_cost"
		adminInfo["cost_source"] = source
		return
	}
	adminInfo["cost_coverage"] = "unavailable"
}

// CalculateTextCost uses the exact pre-group basis frozen while calculating
// the user settlement. Tiered callers pass the already-evaluated result through
// summary, so this path never recompiles or re-evaluates billing expressions.
func CalculateTextCost(relayInfo *relaycommon.RelayInfo, summary textQuotaSummary, tieredResult *billingexpr.TieredResult) CostSnapshot {
	if relayInfo == nil || relayInfo.ChannelMeta == nil || !summary.CostAvailable {
		return CostSnapshot{}
	}
	if relayInfo.TieredBillingSnapshot != nil && tieredResult == nil {
		return CostSnapshot{}
	}
	multiplier := relayInfo.ChannelMeta.CostMultiplier
	if multiplier <= 0 {
		multiplier = model.DefaultChannelCostMultiplier
	}
	base := summary.CostQuotaBeforeGroup
	if tieredResult != nil {
		base = decimal.NewFromFloat(tieredResult.ActualQuotaBeforeGroup).Add(calculateTextToolCostBase(summary.ToolSurchargeItems))
	}
	baseQuota, clamp := common.QuotaFromDecimalChecked(base)
	noteQuotaClamp(relayInfo, clamp)
	costQuota, clamp := common.QuotaFromDecimalChecked(base.Mul(decimal.NewFromFloat(multiplier)))
	noteQuotaClamp(relayInfo, clamp)
	return CostSnapshot{BaseCostQuota: baseQuota, CostQuota: costQuota, Multiplier: multiplier}
}

func CostSnapshotFromAudioQuota(relayInfo *relaycommon.RelayInfo, quotaInfo QuotaInfo) CostSnapshot {
	if relayInfo == nil || relayInfo.ChannelMeta == nil {
		return CostSnapshot{}
	}
	priceData := relayInfo.PriceData
	if priceData.UsePrice {
		if !validInternalCostRate(priceData.ModelPrice) {
			return CostSnapshot{}
		}
	} else if !validInternalCostRate(priceData.ModelRatio) {
		return CostSnapshot{}
	}

	// The channel selected for this request owns the frozen upstream pricing.
	// Group ratios belong to customer billing and must not affect internal cost.
	completionRatio := priceData.CompletionRatio
	audioRatio := priceData.AudioRatio
	audioCompletionRatio := priceData.AudioCompletionRatio
	quotaInfo.UsePrice = priceData.UsePrice
	quotaInfo.ModelPrice = priceData.ModelPrice
	quotaInfo.ModelRatio = priceData.ModelRatio
	quotaInfo.GroupRatio = 1
	quotaInfo.CompletionRatio = &completionRatio
	quotaInfo.AudioRatio = &audioRatio
	quotaInfo.AudioCompletionRatio = &audioCompletionRatio
	return costSnapshotFromBaseDecimal(relayInfo, calculateAudioQuotaDecimal(quotaInfo))
}

func CalculateTaskCost(relayInfo *relaycommon.RelayInfo) CostSnapshot {
	if relayInfo == nil || relayInfo.ChannelMeta == nil {
		return CostSnapshot{}
	}
	var base decimal.Decimal
	if relayInfo.PriceData.UsePrice {
		if !validInternalCostRate(relayInfo.PriceData.ModelPrice) {
			return CostSnapshot{}
		}
		base = decimal.NewFromFloat(relayInfo.PriceData.ModelPrice).Mul(decimal.NewFromFloat(common.QuotaPerUnit))
	} else {
		if !validInternalCostRate(relayInfo.PriceData.ModelRatio) {
			return CostSnapshot{}
		}
		base = decimal.NewFromFloat(relayInfo.PriceData.ModelRatio / 2).Mul(decimal.NewFromFloat(common.QuotaPerUnit))
	}
	base = relayInfo.PriceData.ApplyOtherRatiosToDecimal(base)
	return costSnapshotFromBaseDecimal(relayInfo, base)
}

func validInternalCostRate(rate float64) bool {
	return rate > 0 && !math.IsNaN(rate) && !math.IsInf(rate, 0)
}

func costSnapshotFromBaseDecimal(relayInfo *relaycommon.RelayInfo, base decimal.Decimal) CostSnapshot {
	if relayInfo == nil || relayInfo.ChannelMeta == nil {
		return CostSnapshot{}
	}
	multiplier := relayInfo.ChannelMeta.CostMultiplier
	if multiplier <= 0 {
		multiplier = model.DefaultChannelCostMultiplier
	}
	baseQuota, clamp := common.QuotaFromDecimalChecked(base)
	noteQuotaClamp(relayInfo, clamp)
	costQuota, clamp := common.QuotaFromDecimalChecked(base.Mul(decimal.NewFromFloat(multiplier)))
	noteQuotaClamp(relayInfo, clamp)
	return CostSnapshot{BaseCostQuota: baseQuota, CostQuota: costQuota, Multiplier: multiplier}
}
