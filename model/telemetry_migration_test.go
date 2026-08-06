package model

import (
	"errors"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type legacyDistributionAsset struct {
	ID           int64  `gorm:"primaryKey"`
	ReleaseID    int64  `gorm:"index"`
	Platform     string `gorm:"size:32;index"`
	Architecture string `gorm:"size:32;index"`
	Filename     string `gorm:"size:255"`
	ContentType  string `gorm:"size:128"`
	Size         int64
	SHA256       string `gorm:"size:64;uniqueIndex"`
	StoragePath  string `gorm:"size:128;uniqueIndex"`
	Downloads    int64
	CreatedAt    time.Time
}

func (legacyDistributionAsset) TableName() string { return "distribution_assets" }

func TestTelemetryMigrationsBackfillSlugAndSingleActiveKey(t *testing.T) {
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	t.Cleanup(func() { DB = previousDB })

	require.NoError(t, DB.AutoMigrate(&TelemetryProject{}, &TelemetryApp{}, &TelemetryWriteKey{}))
	project := &TelemetryProject{Name: "migration-project"}
	require.NoError(t, DB.Create(project).Error)
	app := &TelemetryApp{ProjectID: project.ID, Name: "Migration App", Slug: "temporary"}
	require.NoError(t, DB.Create(app).Error)
	require.NoError(t, DB.Session(&gorm.Session{SkipHooks: true}).Model(app).Update("slug", "").Error)

	older := time.Now().Add(-time.Hour)
	keys := []TelemetryWriteKey{
		{AppID: app.ID, Name: "old", KeyID: "old-key", SecretCiphertext: "old", CreatedAt: older},
		{AppID: app.ID, Name: "new", KeyID: "new-key", SecretCiphertext: "new", CreatedAt: time.Now()},
	}
	require.NoError(t, DB.Create(&keys).Error)

	require.NoError(t, MigrateTelemetryAppSlugs())
	require.NoError(t, MigrateTelemetryActiveKeys())

	var migratedApp TelemetryApp
	require.NoError(t, DB.First(&migratedApp, app.ID).Error)
	assert.Equal(t, "app-1", migratedApp.Slug)

	var migratedKeys []TelemetryWriteKey
	require.NoError(t, DB.Where("app_id = ?", app.ID).Order("created_at ASC").Find(&migratedKeys).Error)
	require.Len(t, migratedKeys, 2)
	assert.NotNil(t, migratedKeys[0].DisabledAt)
	assert.Nil(t, migratedKeys[0].ActiveSlot)
	assert.Nil(t, migratedKeys[1].DisabledAt)
	require.NotNil(t, migratedKeys[1].ActiveSlot)
	assert.Equal(t, "active", *migratedKeys[1].ActiveSlot)
}

func TestCreateTelemetryAppGeneratesSlugForLocalizedName(t *testing.T) {
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	t.Cleanup(func() { DB = previousDB })
	require.NoError(t, DB.AutoMigrate(&TelemetryProject{}, &TelemetryApp{}))
	project := &TelemetryProject{Name: "localized-project"}
	require.NoError(t, DB.Create(project).Error)

	app, err := CreateTelemetryApp(project.ID, "桌面客户端")
	require.NoError(t, err)
	assert.Equal(t, "桌面客户端", app.Name)
	assert.True(t, ValidTelemetrySlug(app.Slug))
	assert.Contains(t, app.Slug, "app-")
}

func TestCreateTelemetryAppsUseDistinctSlugsAcrossProjects(t *testing.T) {
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	t.Cleanup(func() { DB = previousDB })
	require.NoError(t, DB.AutoMigrate(&TelemetryProject{}, &TelemetryApp{}))

	firstProject, err := CreateTelemetryProject("first-project")
	require.NoError(t, err)
	secondProject, err := CreateTelemetryProject("second-project")
	require.NoError(t, err)
	first, err := CreateTelemetryApp(firstProject.ID, "desktop")
	require.NoError(t, err)
	second, err := CreateTelemetryApp(secondProject.ID, "desktop")
	require.NoError(t, err)

	assert.Equal(t, "desktop", first.Slug)
	assert.NotEqual(t, first.Slug, second.Slug)
	assert.True(t, ValidTelemetrySlug(second.Slug))
	resolvedFirst, err := FindTelemetryAppBySlug(first.Slug)
	require.NoError(t, err)
	assert.Equal(t, first.ID, resolvedFirst.ID)
	resolvedSecond, err := FindTelemetryAppBySlug(second.Slug)
	require.NoError(t, err)
	assert.Equal(t, second.ID, resolvedSecond.ID)
	_, err = CreateTelemetryApp(firstProject.ID, "desktop")
	assert.Error(t, err)
}

func TestTelemetryAppSlugUniqueErrorClassifier(t *testing.T) {
	assert.True(t, isTelemetryAppSlugUniqueError(errors.New("UNIQUE constraint failed: telemetry_apps.slug")))
	assert.True(t, isTelemetryAppSlugUniqueError(errors.New("Error 1062: Duplicate entry for key 'idx_telemetry_apps_slug'")))
	assert.True(t, isTelemetryAppSlugUniqueError(errors.New("duplicate key value violates unique constraint \"idx_telemetry_apps_slug\"")))
	assert.False(t, isTelemetryAppSlugUniqueError(errors.New("UNIQUE constraint failed: telemetry_apps.project_id, telemetry_apps.name")))
}

func TestDistributionAssetMigrationRemovesLegacySHA256Uniqueness(t *testing.T) {
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	t.Cleanup(func() { DB = previousDB })

	require.NoError(t, DB.AutoMigrate(&legacyDistributionAsset{}))
	const legacyIndex = "idx_distribution_assets_sha256"
	assert.True(t, DB.Migrator().HasIndex(&DistributionAsset{}, legacyIndex))

	require.NoError(t, MigrateDistributionAssetSHA256Index())
	assert.False(t, DB.Migrator().HasIndex(&DistributionAsset{}, legacyIndex))
	require.NoError(t, MigrateDistributionAssetSHA256Index())
	assets := []DistributionAsset{
		{SHA256: "same", StoragePath: "first"},
		{SHA256: "same", StoragePath: "second"},
	}
	require.NoError(t, DB.Create(&assets).Error)
}
