package model

import (
	"math"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setTopUpAffiliateRatio(t *testing.T, ratio float64) {
	t.Helper()
	original := common.TopUpAffiliateRatio
	common.TopUpAffiliateRatio = ratio
	t.Cleanup(func() { common.TopUpAffiliateRatio = original })
}

func insertUserWithInviterForTest(t *testing.T, id int, quota int, inviterID int) {
	t.Helper()
	user := &User{
		Id:        id,
		Username:  "affiliate_user",
		AffCode:   "aff" + strconv.Itoa(id),
		Status:    common.UserStatusEnabled,
		Quota:     quota,
		InviterId: inviterID,
	}
	require.NoError(t, DB.Create(user).Error)
}

func getUserQuotaForAffiliateTest(t *testing.T, id int) int {
	t.Helper()
	var user User
	require.NoError(t, DB.Select("quota").First(&user, "id = ?", id).Error)
	return user.Quota
}

func getAffRewardsForAffiliateTest(t *testing.T, id int) (quota, history int) {
	t.Helper()
	var user User
	require.NoError(t, DB.Select("aff_quota", "aff_history").First(&user, "id = ?", id).Error)
	return user.AffQuota, user.AffHistoryQuota
}

// 倍率为 0(默认)时,充值不产生任何分红,充值本身正常入账。
func TestRechargeWeChatPay_AffiliateRewardDisabledByZeroRatio(t *testing.T) {
	truncateTables(t)
	insertUserForPaymentGuardTest(t, 601, 100)
	insertUserWithInviterForTest(t, 602, 0, 601)
	insertWeChatPayTopUp(t, "aff-zero-ratio", 602, 2, 9.99)

	require.NoError(t, RechargeWeChatPay("aff-zero-ratio", 999, "wx-aff-0", "127.0.0.1"))

	assert.Equal(t, 2*int(common.QuotaPerUnit), getUserQuotaForAffiliateTest(t, 602))
	assert.Equal(t, 100, getUserQuotaForAffiliateTest(t, 601))
}

// 被邀请人没有邀请人(inviter_id = 0)时,充值不产生分红,充值本身正常入账。
func TestRechargeWeChatPay_AffiliateRewardSkipsWithoutInviter(t *testing.T) {
	truncateTables(t)
	setTopUpAffiliateRatio(t, 0.1)
	insertUserForPaymentGuardTest(t, 603, 0)
	insertWeChatPayTopUp(t, "aff-no-inviter", 603, 2, 9.99)

	require.NoError(t, RechargeWeChatPay("aff-no-inviter", 999, "wx-aff-1", "127.0.0.1"))

	assert.Equal(t, 2*int(common.QuotaPerUnit), getUserQuotaForAffiliateTest(t, 603))
}

// 被邀请人充值 2 美元(倍率 0.1)时,邀请人获得充值所得额度 10% 的分红。
func TestRechargeWeChatPay_AffiliateRewardCreditedToInviter(t *testing.T) {
	truncateTables(t)
	setTopUpAffiliateRatio(t, 0.1)
	insertUserForPaymentGuardTest(t, 604, 100)
	insertUserWithInviterForTest(t, 605, 0, 604)
	insertWeChatPayTopUp(t, "aff-credit", 605, 2, 9.99)

	quotaToAdd := 2 * int(common.QuotaPerUnit)
	require.NoError(t, RechargeWeChatPay("aff-credit", 999, "wx-aff-2", "127.0.0.1"))

	expected := common.QuotaFromFloat(float64(quotaToAdd) * 0.1)
	assert.True(t, expected > 0)
	assert.Equal(t, quotaToAdd, getUserQuotaForAffiliateTest(t, 605))
	// 分红计入邀请体系(推荐计划余额/累计收益),不直接进主余额
	assert.Equal(t, 100, getUserQuotaForAffiliateTest(t, 604))
	affQuota, affHistory := getAffRewardsForAffiliateTest(t, 604)
	assert.Equal(t, expected, affQuota)
	assert.Equal(t, expected, affHistory)
}

// 倍率大于 1 时分红可以超过充值所得额度(管理员自行承担亏损风险)。
func TestRechargeWeChatPay_AffiliateRewardWithRatioAboveOne(t *testing.T) {
	truncateTables(t)
	setTopUpAffiliateRatio(t, 2.0)
	insertUserForPaymentGuardTest(t, 606, 0)
	insertUserWithInviterForTest(t, 607, 0, 606)
	insertWeChatPayTopUp(t, "aff-ratio-2", 607, 1, 5.00)

	require.NoError(t, RechargeWeChatPay("aff-ratio-2", 500, "wx-aff-3", "127.0.0.1"))

	assert.Equal(t, int(common.QuotaPerUnit), getUserQuotaForAffiliateTest(t, 607))
	assert.Zero(t, getUserQuotaForAffiliateTest(t, 606))
	affQuota, affHistory := getAffRewardsForAffiliateTest(t, 606)
	expected := common.QuotaFromFloat(float64(int(common.QuotaPerUnit)) * 2.0)
	assert.Equal(t, expected, affQuota)
	assert.Equal(t, expected, affHistory)
}

// 同一订单重复回调(幂等)不会重复分红。
func TestRechargeWeChatPay_AffiliateRewardIsIdempotent(t *testing.T) {
	truncateTables(t)
	setTopUpAffiliateRatio(t, 0.1)
	insertUserForPaymentGuardTest(t, 608, 0)
	insertUserWithInviterForTest(t, 609, 0, 608)
	insertWeChatPayTopUp(t, "aff-idempotent", 609, 1, 5.00)

	quotaToAdd := int(common.QuotaPerUnit)
	expected := common.QuotaFromFloat(float64(quotaToAdd) * 0.1)
	require.NoError(t, RechargeWeChatPay("aff-idempotent", 500, "wx-aff-4", "127.0.0.1"))
	require.NoError(t, RechargeWeChatPay("aff-idempotent", 500, "wx-aff-4", "127.0.0.1"))

	affQuota, affHistory := getAffRewardsForAffiliateTest(t, 608)
	assert.Equal(t, expected, affQuota)
	assert.Equal(t, expected, affHistory)
}

// 分红额度不足 1 个单位(截断为 0)时跳过,不产生 0 分红记录。
func TestRechargeWeChatPay_AffiliateRewardSkippedWhenBelowOneUnit(t *testing.T) {
	truncateTables(t)
	setTopUpAffiliateRatio(t, 0.000001)
	insertUserForPaymentGuardTest(t, 610, 0)
	insertUserWithInviterForTest(t, 611, 0, 610)
	insertWeChatPayTopUp(t, "aff-tiny", 611, 1, 5.00)

	require.NoError(t, RechargeWeChatPay("aff-tiny", 500, "wx-aff-5", "127.0.0.1"))

	assert.Equal(t, 0, getUserQuotaForAffiliateTest(t, 610))
}

// 邀请人已被删除时,分红静默跳过,充值本身不受影响。
func TestRechargeWeChatPay_AffiliateRewardSkipsWhenInviterMissing(t *testing.T) {
	truncateTables(t)
	setTopUpAffiliateRatio(t, 0.1)
	insertUserWithInviterForTest(t, 612, 0, 9999)
	insertWeChatPayTopUp(t, "aff-missing-inviter", 612, 1, 5.00)

	require.NoError(t, RechargeWeChatPay("aff-missing-inviter", 500, "wx-aff-6", "127.0.0.1"))

	topUp := GetTopUpByTradeNo("aff-missing-inviter")
	require.NotNil(t, topUp)
	assert.Equal(t, common.TopUpStatusSuccess, topUp.Status)
}

// 极端倍率与充值额度的乘积超过 int32 上限时饱和到上限,绝不回绕成负数。
// 注:充值额度本身需在 int32 上限内(官方 int32 钱包上限保护会拒绝超额充值),
// 由分红倍率制造溢出。
func TestRechargeWeChatPay_AffiliateRewardSaturatesAtInt32Max(t *testing.T) {
	truncateTables(t)
	setTopUpAffiliateRatio(t, 1000.0)
	insertUserForPaymentGuardTest(t, 613, 0)
	insertUserWithInviterForTest(t, 614, 0, 613)
	insertWeChatPayTopUp(t, "aff-saturate", 614, 6, 30.00)

	require.NoError(t, RechargeWeChatPay("aff-saturate", 3000, "wx-aff-7", "127.0.0.1"))

	inviterQuota := getUserQuotaForAffiliateTest(t, 613)
	assert.Zero(t, inviterQuota)
	affQuota, _ := getAffRewardsForAffiliateTest(t, 613)
	assert.Equal(t, math.MaxInt32, affQuota)
	assert.Positive(t, affQuota)
}
