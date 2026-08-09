package service

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	hosttypes "github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"github.com/stretchr/testify/assert"
)

func TestCalculateTextCostExcludesGroupRatio(t *testing.T) {
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 3},
		PriceData: hosttypes.PriceData{
			ModelRatio:     2,
			GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 10},
		},
	}
	snapshot := CalculateTextCost(relayInfo, textQuotaSummary{CostAvailable: true, CostQuotaBeforeGroup: decimal.NewFromInt(200)}, nil)
	assert.Equal(t, 200, snapshot.BaseCostQuota)
	assert.Equal(t, 600, snapshot.CostQuota)
	assert.Equal(t, 3.0, snapshot.Multiplier)
}

func TestCalculateTextCostBasisExcludesFreeGroup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 2},
		PriceData: hosttypes.PriceData{
			ModelRatio:         3,
			CompletionRatio:    1,
			CacheRatio:         1,
			ImageRatio:         1,
			CacheCreationRatio: 1,
			GroupRatioInfo:     hosttypes.GroupRatioInfo{GroupRatio: 0},
		},
	}
	summary := calculateTextQuotaSummary(ctx, relayInfo, &dto.Usage{PromptTokens: 100})
	snapshot := CalculateTextCost(relayInfo, summary, nil)
	assert.Equal(t, 300, snapshot.BaseCostQuota)
	assert.Equal(t, 600, snapshot.CostQuota)
}

func TestTextCostBasisRetainsCacheAndImageDimensions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 1},
		PriceData: hosttypes.PriceData{
			ModelRatio: 2, CompletionRatio: 1, CacheRatio: 0.5, ImageRatio: 0.25,
			CacheCreationRatio: 2, GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 0},
		},
	}
	summary := calculateTextQuotaSummary(ctx, relayInfo, &dto.Usage{
		PromptTokens: 100, CompletionTokens: 10,
		PromptTokensDetails: dto.InputTokenDetails{CachedTokens: 20, CachedCreationTokens: 10, ImageTokens: 10},
	})
	snapshot := CalculateTextCost(relayInfo, summary, nil)
	// (60 base + 10 cache + 20 cache-write + 2.5 image + 10 completion) * 2.
	assert.Equal(t, 205, snapshot.BaseCostQuota)
}

func TestTextCostBasisRetainsClaudeSplitCacheDimensions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 1},
		PriceData: hosttypes.PriceData{
			ModelRatio: 1, CompletionRatio: 1, CacheRatio: 1, CacheCreationRatio: 2,
			CacheCreation5mRatio: 3, CacheCreation1hRatio: 4,
			GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 0},
		},
	}
	summary := calculateTextQuotaSummary(ctx, relayInfo, &dto.Usage{
		PromptTokens: 100, UsageSemantic: "anthropic",
		PromptTokensDetails:         dto.InputTokenDetails{CachedCreationTokens: 30},
		ClaudeCacheCreation5mTokens: 10, ClaudeCacheCreation1hTokens: 10,
	})
	snapshot := CalculateTextCost(relayInfo, summary, nil)
	assert.Equal(t, 190, snapshot.BaseCostQuota)
}

func TestCalculateTextCostUsesProvidedTieredActualBasis(t *testing.T) {
	relayInfo := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 2}, TieredBillingSnapshot: &billingexpr.BillingSnapshot{BillingMode: "tiered_expr"}}
	snapshot := CalculateTextCost(relayInfo, textQuotaSummary{
		CostAvailable:        true,
		ToolSurchargeItems:   []ToolSurchargeItem{{Name: "web_search", Count: 1, Price: 1}},
		CostQuotaBeforeGroup: decimal.NewFromInt(999999),
	}, &billingexpr.TieredResult{ActualQuotaBeforeGroup: 100})
	assert.Equal(t, 600, snapshot.BaseCostQuota)
	assert.Equal(t, 1200, snapshot.CostQuota)
}

func TestCalculateTextCostRecordsSaturation(t *testing.T) {
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 1000},
		PriceData:   hosttypes.PriceData{ModelRatio: 1000, GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 1}},
	}
	snapshot := CalculateTextCost(relayInfo, textQuotaSummary{CostAvailable: true, CostQuotaBeforeGroup: decimal.NewFromInt(int64(common.MaxQuota))}, nil)
	assert.Equal(t, common.MaxQuota, snapshot.CostQuota)
	assert.NotNil(t, relayInfo.QuotaClamp)
}

func TestCostSnapshotFromFixedPriceAudioExcludesCustomerGroupMarkup(t *testing.T) {
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 2},
		PriceData: hosttypes.PriceData{
			UsePrice:       true,
			ModelPrice:     0.02,
			GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 0.25},
		},
	}
	snapshot := CostSnapshotFromAudioQuota(relayInfo, QuotaInfo{
		ModelName:  "fixed-price-audio",
		UsePrice:   true,
		ModelPrice: 0.02,
		GroupRatio: 0.25,
	})

	assert.Equal(t, 10000, snapshot.BaseCostQuota)
	assert.Equal(t, 20000, snapshot.CostQuota)
	assert.Equal(t, 2.0, snapshot.Multiplier)
}

func TestCostSnapshotFromFixedPriceWssExcludesCustomerGroupMarkup(t *testing.T) {
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 1.5},
		PriceData: hosttypes.PriceData{
			UsePrice:       true,
			ModelPrice:     0.04,
			GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 0},
		},
	}
	snapshot := CostSnapshotFromAudioQuota(relayInfo, QuotaInfo{
		ModelName:  "fixed-price-wss",
		UsePrice:   true,
		ModelPrice: 0.04,
		GroupRatio: 0,
	})

	assert.Equal(t, 20000, snapshot.BaseCostQuota)
	assert.Equal(t, 30000, snapshot.CostQuota)
}

func TestCostSnapshotFromAudioQuotaUsesFrozenRatios(t *testing.T) {
	completionRatio := 5.0
	audioRatio := 7.0
	audioCompletionRatio := 11.0
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 2},
		PriceData: hosttypes.PriceData{
			ModelRatio:           3,
			CompletionRatio:      completionRatio,
			AudioRatio:           audioRatio,
			AudioCompletionRatio: audioCompletionRatio,
			GroupRatioInfo:       hosttypes.GroupRatioInfo{GroupRatio: 0},
		},
	}
	snapshot := CostSnapshotFromAudioQuota(relayInfo, QuotaInfo{
		InputDetails:  TokenDetails{TextTokens: 10, AudioTokens: 2},
		OutputDetails: TokenDetails{TextTokens: 3, AudioTokens: 4},
		ModelName:     "not-reloaded-from-settings",
		ModelRatio:    999,
		GroupRatio:    0,
	})

	// (10 + 3*5 + 2*7 + 4*7*11) * 3. The group ratio is deliberately zero.
	assert.Equal(t, 1041, snapshot.BaseCostQuota)
	assert.Equal(t, 2082, snapshot.CostQuota)
}

func TestCalculateTaskCostIgnoresFreeGroupMarker(t *testing.T) {
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{CostMultiplier: 2},
		PriceData: hosttypes.PriceData{
			FreeModel:      true,
			ModelRatio:     2,
			GroupRatioInfo: hosttypes.GroupRatioInfo{GroupRatio: 0},
		},
	}
	snapshot := CalculateTaskCost(relayInfo)
	assert.Positive(t, snapshot.BaseCostQuota)
	assert.Positive(t, snapshot.CostQuota)
	assert.Equal(t, snapshot.BaseCostQuota*2, snapshot.CostQuota)
}
