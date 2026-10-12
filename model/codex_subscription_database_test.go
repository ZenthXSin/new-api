package model

import (
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Opt-in verification uses a disposable database, never an application database.
func TestCodexSubscriptionDatabaseUpgradeAndGrant(t *testing.T) {
	dsn := os.Getenv("CODEX_TEST_DB_DSN")
	if dsn == "" {
		t.Skip("disposable database not configured")
	}
	require.Contains(t, dsn, "codex_v17_verify")
	var dialector gorm.Dialector
	switch os.Getenv("CODEX_TEST_DB_DRIVER") {
	case "mysql":
		dialector = mysql.Open(dsn)
	case "postgres":
		dialector = postgres.Open(dsn)
	default:
		t.Fatal("unsupported disposable database driver")
	}
	db, err := gorm.Open(dialector, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	require.NoError(t, db.AutoMigrate(&User{}, &CodexUserConfig{}, &SubscriptionPlan{}, &UserSubscription{}))
	plan := SubscriptionPlan{Title: "Legacy database plan"}
	require.NoError(t, db.Create(&plan).Error)
	require.NoError(t, db.Migrator().DropColumn(&SubscriptionPlan{}, "codex_config"))
	require.NoError(t, db.AutoMigrate(&SubscriptionPlan{}))
	require.NoError(t, db.AutoMigrate(&SubscriptionPlan{}))
	var restored SubscriptionPlan
	require.NoError(t, db.First(&restored, plan.Id).Error)
	assert.Nil(t, restored.Codex)
	assert.Equal(t, plan.Title, restored.Title)
	require.NoError(t, db.Create(&User{Id: 25, Username: "disposable-trial-user", AffCode: "trial", Role: common.RoleCommonUser, Status: common.UserStatusEnabled}).Error)
	plan.Codex = &CodexPlanConfig{Enabled: true, AllowDocker: true, MemoryMB: 2048, DefaultEffort: "ultra"}
	require.NoError(t, db.Save(&plan).Error)
	now := common.GetTimestamp()
	subscription := UserSubscription{UserId: 25, PlanId: plan.Id, Status: "active", StartTime: now - 1, EndTime: now + 1000}
	require.NoError(t, db.Create(&subscription).Error)
	policy, err := GetEffectiveCodexUserPolicyWithDB(db, 25)
	require.NoError(t, err)
	assert.True(t, policy.Enabled)
	assert.Equal(t, "subscription", policy.Source)
	assert.Equal(t, int64(2048), policy.MemoryMB)
	assert.Equal(t, "ultra", policy.DefaultEffort)
	disabled, err := common.Marshal(&CodexPlanConfig{Enabled: false, MemoryMB: 0, AllowDocker: false})
	require.NoError(t, err)
	require.NoError(t, db.Model(&SubscriptionPlan{}).Where("id = ?", plan.Id).Update("codex_config", string(disabled)).Error)
	policy, err = GetEffectiveCodexUserPolicyWithDB(db, 25)
	require.NoError(t, err)
	assert.False(t, policy.Enabled)
	var disabledPlan SubscriptionPlan
	require.NoError(t, db.First(&disabledPlan, plan.Id).Error)
	require.NotNil(t, disabledPlan.Codex)
	assert.False(t, disabledPlan.Codex.AllowDocker)
	assert.Zero(t, disabledPlan.Codex.MemoryMB)
}
