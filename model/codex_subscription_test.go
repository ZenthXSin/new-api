package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func codexSubscriptionDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&User{}, &CodexUserConfig{}, &SubscriptionPlan{}, &UserSubscription{}))
	previous := DB
	DB = db
	t.Cleanup(func() {
		DB = previous
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.Create(&User{Id: 25, Username: "trial-user", AffCode: "trial25", Role: common.RoleCommonUser, Status: common.UserStatusEnabled}).Error)
	return db
}

func TestCodexSubscriptionGrantExpiryAndManualOverrides(t *testing.T) {
	db := codexSubscriptionDB(t)
	now := common.GetTimestamp()
	plan := SubscriptionPlan{Title: "Codex trial", Codex: &CodexPlanConfig{Enabled: true, AllowDocker: true, MemoryMB: 1024, DiskMB: 4096, MaxProjects: 5, CPUPercent: 10, DefaultEffort: "high"}}
	require.NoError(t, db.Create(&plan).Error)
	sub := UserSubscription{UserId: 25, PlanId: plan.Id, Status: "active", StartTime: now - 100, EndTime: now + 3600}
	require.NoError(t, db.Create(&sub).Error)
	policy, err := GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.True(t, policy.Enabled)
	assert.True(t, policy.AllowDocker)
	assert.False(t, policy.AllowSSH)
	assert.Equal(t, int64(1024), policy.MemoryMB)
	assert.Equal(t, "subscription", policy.Source)
	assert.Equal(t, sub.EndTime, policy.ExpiresAt)
	assert.Equal(t, plan.Id, policy.PlanID)
	require.NoError(t, SaveCodexUserConfig(&CodexUserConfig{UserID: 25, Enabled: common.GetPointer(false), MemoryMB: 2048, AllowSSH: common.GetPointer(true)}))
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.False(t, policy.Enabled)
	assert.Equal(t, "manual", policy.Source)
	assert.Equal(t, int64(2048), policy.MemoryMB)
	assert.True(t, policy.AllowSSH)
	require.NoError(t, SaveCodexUserConfig(&CodexUserConfig{UserID: 25}))
	require.NoError(t, db.Model(&sub).Update("end_time", now-1).Error)
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.False(t, policy.Enabled)
	assert.Zero(t, policy.PlanID)
	assert.Zero(t, policy.MemoryMB)
	require.NoError(t, SaveCodexUserConfig(&CodexUserConfig{UserID: 25, Enabled: common.GetPointer(true)}))
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.True(t, policy.Enabled)
	require.NoError(t, db.Model(&User{}).Where("id = ?", 25).Update("status", common.UserStatusDisabled).Error)
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.False(t, policy.Enabled)
}

func TestCodexSubscriptionsUseLatestActiveGrantAndLivePlanSettings(t *testing.T) {
	db := codexSubscriptionDB(t)
	now := common.GetTimestamp()
	older := SubscriptionPlan{Title: "Older", Codex: &CodexPlanConfig{Enabled: true, AllowDocker: true, MemoryMB: 512}}
	newer := SubscriptionPlan{Title: "Newer", Codex: &CodexPlanConfig{Enabled: true, AllowSSH: true, MemoryMB: 2048}}
	legacy := SubscriptionPlan{Title: "API only"}
	for _, p := range []*SubscriptionPlan{&older, &newer, &legacy} {
		require.NoError(t, db.Create(p).Error)
	}
	subs := []UserSubscription{
		{UserId: 25, PlanId: older.Id, Status: "active", StartTime: now - 100, EndTime: now + 3000},
		{UserId: 25, PlanId: newer.Id, Status: "active", StartTime: now - 50, EndTime: now + 4000},
		{UserId: 25, PlanId: legacy.Id, Status: "active", StartTime: now - 10, EndTime: now + 5000},
		{UserId: 25, PlanId: older.Id, Status: "active", StartTime: now + 100, EndTime: now + 6000},
	}
	require.NoError(t, db.Create(&subs).Error)
	policy, err := GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.Equal(t, newer.Id, policy.PlanID)
	assert.False(t, policy.AllowDocker)
	assert.True(t, policy.AllowSSH)
	newer.Codex.MemoryMB = 4096
	require.NoError(t, db.Save(&newer).Error)
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.Equal(t, int64(4096), policy.MemoryMB)
	// Removing a plan from sale must not revoke a customer's active entitlement.
	require.NoError(t, db.Model(&newer).Update("enabled", false).Error)
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.True(t, policy.Enabled)
	require.NoError(t, db.Model(&subs[1]).Update("status", "cancelled").Error)
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.Equal(t, older.Id, policy.PlanID)
	older.Codex.Enabled = false
	require.NoError(t, db.Save(&older).Error)
	policy, err = GetEffectiveCodexUserPolicy(25)
	require.NoError(t, err)
	assert.False(t, policy.Enabled)
}

func TestCodexAdminListRespectsRoleSearchAndPagination(t *testing.T) {
	db := codexSubscriptionDB(t)
	require.NoError(t, db.Create(&User{Id: 26, Username: "site-admin", AffCode: "admin26", Role: common.RoleAdminUser, Status: common.UserStatusEnabled}).Error)
	users, total, err := ListCodexAdminUsers("", 1, 1, common.RoleAdminUser)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	require.Len(t, users, 1)
	assert.Equal(t, 25, users[0].ID)
	users, total, err = ListCodexAdminUsers("26", 1, 20, common.RoleRootUser)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	require.Len(t, users, 1)
	assert.Equal(t, 26, users[0].ID)
	assert.True(t, users[0].Effective.Enabled)
	users, total, err = ListCodexAdminUsers("", 2, 1, common.RoleRootUser)
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)
	require.Len(t, users, 1)
	assert.Equal(t, 25, users[0].ID)
}

func TestCodexPlanValidationRejectsInvalidResourceLimits(t *testing.T) {
	for _, p := range []*CodexPlanConfig{{Enabled: true, MemoryMB: 1}, {CPUPercent: 101}, {DiskMB: -1}, {MaxProjects: 1001}, {IdleSeconds: 1}, {DefaultEffort: "unlimited"}} {
		assert.Error(t, p.Validate())
	}
	var legacy *CodexPlanConfig
	require.NoError(t, legacy.Validate())
	require.NoError(t, (&CodexPlanConfig{Enabled: true, AllowDocker: true, MemoryMB: 256, DefaultEffort: "ultra"}).Validate())
}

func TestCodexSubscriptionSQLiteUpgradePreservesLegacyPlan(t *testing.T) {
	db := codexSubscriptionDB(t)
	require.NoError(t, db.Create(&SubscriptionPlan{Id: 7, Title: "Legacy"}).Error)
	require.NoError(t, db.Migrator().DropColumn(&SubscriptionPlan{}, "codex_config"))
	require.NoError(t, ensureSubscriptionPlanTableSQLite())
	require.NoError(t, ensureSubscriptionPlanTableSQLite())
	var plan SubscriptionPlan
	require.NoError(t, db.First(&plan, 7).Error)
	assert.Equal(t, "Legacy", plan.Title)
	assert.Nil(t, plan.Codex)
	plan.Codex = &CodexPlanConfig{Enabled: true, MemoryMB: 1024}
	require.NoError(t, db.Save(&plan).Error)
	var restored SubscriptionPlan
	require.NoError(t, db.First(&restored, 7).Error)
	require.NotNil(t, restored.Codex)
	assert.Equal(t, int64(1024), restored.Codex.MemoryMB)
}
