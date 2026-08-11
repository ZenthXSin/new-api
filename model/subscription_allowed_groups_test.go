package model

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seedAllowedGroupsPlan(t *testing.T, plan *SubscriptionPlan) {
	t.Helper()
	require.NoError(t, DB.Create(plan).Error)
}

func seedAllowedGroupsSub(t *testing.T, sub *UserSubscription) {
	t.Helper()
	require.NoError(t, DB.Create(sub).Error)
}

func getAllowedGroupsSub(t *testing.T, id int) UserSubscription {
	t.Helper()
	var sub UserSubscription
	require.NoError(t, DB.Where("id = ?", id).First(&sub).Error)
	return sub
}

func setupAllowedGroupsTest(t *testing.T) {
	t.Helper()
	truncateTables(t)
	// SubscriptionPreConsumeRecord is not part of the package TestMain migration;
	// AutoMigrate is idempotent, so migrate it here for the pre-consume flow.
	require.NoError(t, DB.AutoMigrate(&SubscriptionPreConsumeRecord{}))
}

func newAllowedGroupsPlan(id int, allowed string) *SubscriptionPlan {
	return &SubscriptionPlan{
		Id:            id,
		Title:         "Grouped plan",
		PriceAmount:   10,
		DurationUnit:  SubscriptionDurationMonth,
		DurationValue: 1,
		TotalAmount:   1000,
		AllowedGroups: allowed,
	}
}

func newAllowedGroupsSub(id int, userId int, planId int, allowed string) *UserSubscription {
	now := GetDBTimestamp()
	return &UserSubscription{
		Id:            id,
		UserId:        userId,
		PlanId:        planId,
		AmountTotal:   1000,
		AmountUsed:    0,
		StartTime:     now - 3600,
		EndTime:       now + 30*24*3600,
		Status:        "active",
		AllowedGroups: allowed,
	}
}

func TestPreConsumeUserSubscriptionEmptyAllowedGroupsMatchesAnyGroup(t *testing.T) {
	setupAllowedGroupsTest(t)

	plan := newAllowedGroupsPlan(9701, "")
	seedAllowedGroupsPlan(t, plan)
	seedAllowedGroupsSub(t, newAllowedGroupsSub(9801, 601, plan.Id, ""))

	res, err := PreConsumeUserSubscription("req-empty-allowed-1", 601, "gpt-4o", 0, 100, "default")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, 9801, res.UserSubscriptionId)
	assert.EqualValues(t, 100, res.PreConsumed)
	assert.EqualValues(t, 100, res.AmountUsedAfter)
}

func TestPreConsumeUserSubscriptionAllowedGroupsMatchRequestGroup(t *testing.T) {
	setupAllowedGroupsTest(t)

	plan := newAllowedGroupsPlan(9702, "vip")
	seedAllowedGroupsPlan(t, plan)
	seedAllowedGroupsSub(t, newAllowedGroupsSub(9802, 602, plan.Id, "vip"))

	res, err := PreConsumeUserSubscription("req-vip-2", 602, "gpt-4o", 0, 100, "vip")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, 9802, res.UserSubscriptionId)
	assert.EqualValues(t, 100, res.AmountUsedAfter)
}

func TestPreConsumeUserSubscriptionAllowedGroupsMismatchFailsAndKeepsAmountUsed(t *testing.T) {
	setupAllowedGroupsTest(t)

	plan := newAllowedGroupsPlan(9703, "vip")
	seedAllowedGroupsPlan(t, plan)
	seedAllowedGroupsSub(t, newAllowedGroupsSub(9803, 603, plan.Id, "vip"))

	res, err := PreConsumeUserSubscription("req-mismatch-3", 603, "gpt-4o", 0, 100, "default")
	require.Error(t, err)
	assert.Nil(t, res)
	assert.True(t, strings.Contains(err.Error(), "subscription quota insufficient"))
	assert.EqualValues(t, 0, getAllowedGroupsSub(t, 9803).AmountUsed)
}

func TestPreConsumeUserSubscriptionPicksAllowedSubscriptionAmongCandidates(t *testing.T) {
	setupAllowedGroupsTest(t)

	planA := newAllowedGroupsPlan(9704, "vip")
	planB := newAllowedGroupsPlan(9705, "default")
	seedAllowedGroupsPlan(t, planA)
	seedAllowedGroupsPlan(t, planB)
	// Same end_time, ordered by id asc: 9804 (allowed "vip") is checked first and
	// must be skipped, then 9805 (allowed "default") takes the pre-consume.
	seedAllowedGroupsSub(t, newAllowedGroupsSub(9804, 604, planA.Id, "vip"))
	seedAllowedGroupsSub(t, newAllowedGroupsSub(9805, 604, planB.Id, "default"))

	res, err := PreConsumeUserSubscription("req-multi-4", 604, "gpt-4o", 0, 100, "default")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, 9805, res.UserSubscriptionId)
	assert.EqualValues(t, 100, res.AmountUsedAfter)
	assert.EqualValues(t, 0, getAllowedGroupsSub(t, 9804).AmountUsed)
}

func TestCreateUserSubscriptionFromPlanTxSnapshotsAllowedGroups(t *testing.T) {
	setupAllowedGroupsTest(t)

	plan := newAllowedGroupsPlan(9706, "vip, pro")
	seedAllowedGroupsPlan(t, plan)

	sub, err := CreateUserSubscriptionFromPlanTx(DB, 605, plan, "test")
	require.NoError(t, err)
	require.NotNil(t, sub)
	assert.Equal(t, "vip, pro", sub.AllowedGroups)

	plan.AllowedGroups = "default"
	require.NoError(t, DB.Model(plan).Update("allowed_groups", plan.AllowedGroups).Error)

	stored := getAllowedGroupsSub(t, sub.Id)
	assert.Equal(t, "vip, pro", stored.AllowedGroups)
}

func TestPreConsumeUserSubscriptionAllowedGroupsTrimSpaces(t *testing.T) {
	setupAllowedGroupsTest(t)

	plan := newAllowedGroupsPlan(9707, "vip, default")
	seedAllowedGroupsPlan(t, plan)
	seedAllowedGroupsSub(t, newAllowedGroupsSub(9807, 607, plan.Id, "vip, default"))

	res, err := PreConsumeUserSubscription("req-trim-7", 607, "gpt-4o", 0, 100, "default")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, 9807, res.UserSubscriptionId)
	assert.EqualValues(t, 100, res.AmountUsedAfter)
}

func TestPreConsumeUserSubscriptionEmptyGroupDoesNotMatchRestriction(t *testing.T) {
	setupAllowedGroupsTest(t)

	plan := newAllowedGroupsPlan(9708, "vip")
	seedAllowedGroupsPlan(t, plan)
	seedAllowedGroupsSub(t, newAllowedGroupsSub(9808, 608, plan.Id, "vip"))

	res, err := PreConsumeUserSubscription("req-empty-group-8", 608, "gpt-4o", 0, 100, "")
	require.Error(t, err)
	assert.Nil(t, res)
	assert.True(t, strings.Contains(err.Error(), "subscription quota insufficient"))
	assert.EqualValues(t, 0, getAllowedGroupsSub(t, 9808).AmountUsed)
}
