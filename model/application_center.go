package model

import (
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const AppCenterSchemaEpoch int64 = 1

type AppCenterSchemaState struct {
	ID        int64 `gorm:"primaryKey"`
	Epoch     int64 `gorm:"uniqueIndex"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (AppCenterSchemaState) TableName() string { return "app_center_schema_state" }

type AppCenterApp struct {
	ID                        int64     `json:"id" gorm:"primaryKey"`
	Name                      string    `json:"name" gorm:"size:128"`
	Slug                      string    `json:"slug" gorm:"size:128;uniqueIndex"`
	Description               string    `json:"description" gorm:"type:text"`
	Public                    bool      `json:"public"`
	TelemetryEnabled          bool      `json:"telemetry_enabled"`
	TelemetryKeyID            string    `json:"-" gorm:"size:48;uniqueIndex"`
	TelemetrySecret           string    `json:"-" gorm:"type:text"`
	TelemetrySecretCiphertext string    `json:"-" gorm:"column:telemetry_secret_ciphertext;<-:false"`
	CreatedAt                 time.Time `json:"created_at"`
	UpdatedAt                 time.Time `json:"updated_at"`
}

func (AppCenterApp) TableName() string { return "app_center_apps" }

const (
	AppCenterReleaseDraft     = "draft"
	AppCenterReleasePublished = "published"
	AppCenterReleaseArchived  = "archived"
)

type AppCenterRelease struct {
	ID          int64            `json:"id" gorm:"primaryKey"`
	AppID       int64            `json:"app_id" gorm:"index;uniqueIndex:idx_app_center_release,priority:1"`
	Version     string           `json:"version" gorm:"size:64;uniqueIndex:idx_app_center_release,priority:2"`
	Channel     string           `json:"channel" gorm:"size:32;uniqueIndex:idx_app_center_release,priority:3"`
	Status      string           `json:"status" gorm:"size:16;index"`
	Notes       string           `json:"notes" gorm:"type:text"`
	PublishedAt *time.Time       `json:"published_at,omitempty" gorm:"index"`
	CreatedAt   time.Time        `json:"created_at"`
	UpdatedAt   time.Time        `json:"updated_at"`
	Assets      []AppCenterAsset `json:"assets,omitempty" gorm:"foreignKey:ReleaseID"`
}

func (AppCenterRelease) TableName() string { return "app_center_releases" }

type AppCenterAsset struct {
	ID           int64     `json:"id" gorm:"primaryKey"`
	ReleaseID    int64     `json:"release_id" gorm:"index"`
	Platform     string    `json:"platform" gorm:"size:32;index"`
	Architecture string    `json:"architecture" gorm:"size:32;index"`
	Filename     string    `json:"filename" gorm:"size:255"`
	ContentType  string    `json:"content_type" gorm:"size:128"`
	Size         int64     `json:"size"`
	SHA256       string    `json:"sha256" gorm:"size:64"`
	StoragePath  string    `json:"-" gorm:"size:128;uniqueIndex"`
	Downloads    int64     `json:"downloads"`
	CreatedAt    time.Time `json:"created_at"`
}

func (AppCenterAsset) TableName() string { return "app_center_assets" }

type AppCenterAnnouncement struct {
	ID         int64      `json:"id" gorm:"primaryKey"`
	AppID      int64      `json:"app_id" gorm:"index"`
	Title      string     `json:"title" gorm:"size:200"`
	Body       string     `json:"body" gorm:"type:text"`
	Status     string     `json:"status" gorm:"size:16;index"`
	StartsAt   *time.Time `json:"starts_at,omitempty"`
	EndsAt     *time.Time `json:"ends_at,omitempty"`
	Pinned     bool       `json:"pinned"`
	Channel    string     `json:"channel,omitempty" gorm:"size:32"`
	Platform   string     `json:"platform,omitempty" gorm:"size:32"`
	MinVersion string     `json:"min_version,omitempty" gorm:"size:64"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

func (AppCenterAnnouncement) TableName() string { return "app_center_announcements" }

type AppCenterUsageSession struct {
	ID               int64      `json:"id" gorm:"primaryKey"`
	AppID            int64      `json:"app_id" gorm:"index;uniqueIndex:idx_app_center_session,priority:1"`
	SessionHash      string     `json:"-" gorm:"size:64;uniqueIndex:idx_app_center_session,priority:2"`
	InstallationHash string     `json:"-" gorm:"size:64;index"`
	LastSequence     int64      `json:"-"`
	LastSeenAt       time.Time  `json:"last_seen_at"`
	StartedAt        time.Time  `json:"started_at"`
	ClosedAt         *time.Time `json:"closed_at,omitempty"`
	Version          string     `json:"version" gorm:"size:64"`
	Platform         string     `json:"platform" gorm:"size:32"`
	Architecture     string     `json:"architecture" gorm:"size:32"`
	SourceIP         string     `json:"-" gorm:"size:64;index"`
	Country          string     `json:"country" gorm:"size:64;index"`
	Region           string     `json:"region" gorm:"size:128;index"`
	City             string     `json:"city" gorm:"size:128;index"`
}

func (AppCenterUsageSession) TableName() string { return "app_center_usage_sessions" }

type AppCenterUsageBucket struct {
	ID            int64  `json:"id" gorm:"primaryKey"`
	AppID         int64  `json:"app_id" gorm:"uniqueIndex:idx_app_center_usage_bucket,priority:1"`
	BucketTs      int64  `json:"bucket_ts" gorm:"uniqueIndex:idx_app_center_usage_bucket,priority:2;index"`
	Version       string `json:"version" gorm:"size:64;uniqueIndex:idx_app_center_usage_bucket,priority:3"`
	Platform      string `json:"platform" gorm:"size:32;uniqueIndex:idx_app_center_usage_bucket,priority:4"`
	Architecture  string `json:"architecture" gorm:"size:32;uniqueIndex:idx_app_center_usage_bucket,priority:5"`
	StartCount    int64  `json:"start_count"`
	OnlineSeconds int64  `json:"online_seconds"`
	ActiveUsers   int64  `json:"active_users"`
}

func (AppCenterUsageBucket) TableName() string { return "app_center_usage_buckets" }

type AppCenterUsageActiveBucket struct {
	ID               int64  `json:"id" gorm:"primaryKey"`
	AppID            int64  `json:"app_id" gorm:"uniqueIndex:idx_app_center_usage_active,priority:1"`
	BucketTs         int64  `json:"bucket_ts" gorm:"uniqueIndex:idx_app_center_usage_active,priority:2;index"`
	InstallationHash string `json:"-" gorm:"size:64;uniqueIndex:idx_app_center_usage_active,priority:3;index"`
	Version          string `json:"version" gorm:"size:64;uniqueIndex:idx_app_center_usage_active,priority:4"`
	Platform         string `json:"platform" gorm:"size:32;uniqueIndex:idx_app_center_usage_active,priority:5"`
	Architecture     string `json:"architecture" gorm:"size:32;uniqueIndex:idx_app_center_usage_active,priority:6"`
}

func (AppCenterUsageActiveBucket) TableName() string { return "app_center_usage_active_buckets" }

type AppCenterDownloadBucket struct {
	ID           int64  `json:"id" gorm:"primaryKey"`
	AppID        int64  `json:"app_id" gorm:"uniqueIndex:idx_app_center_download_bucket,priority:1"`
	BucketTs     int64  `json:"bucket_ts" gorm:"uniqueIndex:idx_app_center_download_bucket,priority:2;index"`
	Version      string `json:"version" gorm:"size:64;uniqueIndex:idx_app_center_download_bucket,priority:3"`
	Platform     string `json:"platform" gorm:"size:32;uniqueIndex:idx_app_center_download_bucket,priority:4"`
	Architecture string `json:"architecture" gorm:"size:32;uniqueIndex:idx_app_center_download_bucket,priority:5"`
	Count        int64  `json:"count"`
}

func (AppCenterDownloadBucket) TableName() string { return "app_center_download_buckets" }

type AppCenterCustomEventBucket struct {
	ID             int64  `json:"id" gorm:"primaryKey"`
	AppID          int64  `json:"app_id" gorm:"uniqueIndex:idx_app_center_event_bucket,priority:1"`
	BucketTs       int64  `json:"bucket_ts" gorm:"uniqueIndex:idx_app_center_event_bucket,priority:2;index"`
	Name           string `json:"name" gorm:"size:128;uniqueIndex:idx_app_center_event_bucket,priority:3"`
	Dimensions     string `json:"dimensions" gorm:"type:text"`
	DimensionsHash string `json:"-" gorm:"size:64;uniqueIndex:idx_app_center_event_bucket,priority:4"`
	Count          int64  `json:"count"`
	UniqueUsers    int64  `json:"unique_users"`
}

func (AppCenterCustomEventBucket) TableName() string { return "app_center_custom_event_buckets" }

type AppCenterEventReceipt struct {
	ID        int64     `gorm:"primaryKey"`
	AppID     int64     `gorm:"uniqueIndex:idx_app_center_receipt,priority:1"`
	EventID   string    `gorm:"size:128;uniqueIndex:idx_app_center_receipt,priority:2"`
	ExpiresAt time.Time `gorm:"index"`
	CreatedAt time.Time
}

func (AppCenterEventReceipt) TableName() string { return "app_center_event_receipts" }

// AppCenterEventIPReceipt keeps a short-lived per-IP record for event
// analytics. It is an admin-only business table and intentionally stores the
// canonical source address supplied by the trusted proxy chain.
type AppCenterEventIPReceipt struct {
	ID             int64     `gorm:"primaryKey"`
	AppID          int64     `gorm:"uniqueIndex:idx_app_center_event_ip_receipt,priority:1;index:idx_app_center_event_ip_trend,priority:1"`
	BucketTs       int64     `gorm:"uniqueIndex:idx_app_center_event_ip_receipt,priority:2;index;index:idx_app_center_event_ip_trend,priority:2"`
	Name           string    `gorm:"size:128;uniqueIndex:idx_app_center_event_ip_receipt,priority:3;index:idx_app_center_event_ip_trend,priority:3"`
	DimensionsHash string    `gorm:"size:64;uniqueIndex:idx_app_center_event_ip_receipt,priority:4"`
	SourceIP       string    `json:"-" gorm:"size:64;uniqueIndex:idx_app_center_event_ip_receipt,priority:5;index;index:idx_app_center_event_ip_trend,priority:4"`
	Country        string    `json:"country" gorm:"size:64;index"`
	Region         string    `json:"region" gorm:"size:128;index"`
	City           string    `json:"city" gorm:"size:128;index"`
	ExpiresAt      time.Time `gorm:"index"`
	CreatedAt      time.Time
}

func (AppCenterEventIPReceipt) TableName() string { return "app_center_event_ip_receipts" }

// AppCenterCustomMessage stores the raw custom telemetry messages reported by
// clients (authenticated with the app telemetry key). It is an admin-only
// business table; CreatedAt is an int64 unix timestamp consistent with the
// other app-center aggregation tables.
type AppCenterCustomMessage struct {
	ID        int64  `json:"id" gorm:"primaryKey"`
	AppID     int64  `json:"app_id" gorm:"index"`
	Name      string `json:"name" gorm:"size:64"`
	Content   string `json:"content" gorm:"type:text"`
	SourceIP  string `json:"source_ip,omitempty" gorm:"size:45"`
	Country   string `json:"country,omitempty" gorm:"size:64"`
	Region    string `json:"region,omitempty" gorm:"size:64"`
	City      string `json:"city,omitempty" gorm:"size:64"`
	CreatedAt int64  `json:"created_at" gorm:"bigint;index"`
}

func (AppCenterCustomMessage) TableName() string { return "app_center_custom_messages" }

func EnsureAppCenterSchemaState() error {
	if DB == nil {
		return errors.New("database unavailable")
	}
	var state AppCenterSchemaState
	err := DB.Where("id = ?", 1).First(&state).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if createErr := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&AppCenterSchemaState{ID: 1, Epoch: AppCenterSchemaEpoch}).Error; createErr != nil {
			return createErr
		}
		// Another master may have initialized the singleton concurrently.
		if err := DB.Where("id = ?", 1).First(&state).Error; err != nil {
			return err
		}
		if state.Epoch != AppCenterSchemaEpoch {
			return errors.New("unsupported app center schema epoch")
		}
		return nil
	}
	if err != nil {
		return err
	}
	if state.Epoch != AppCenterSchemaEpoch {
		return errors.New("unsupported app center schema epoch")
	}
	return nil
}
func AppCenterHash(value string) string {
	return common.GenerateHMACWithKey([]byte("app-center-v1:"+common.CryptoSecret), value)
}
func FindAppCenterBySlug(slug string) (*AppCenterApp, error) {
	var app AppCenterApp
	err := DB.Where("slug = ? AND public = ?", strings.ToLower(strings.TrimSpace(slug)), true).First(&app).Error
	return &app, err
}
func FindAppCenterBearer(keyID, secret string) (*AppCenterApp, error) {
	var app AppCenterApp
	if err := DB.Where("telemetry_key_id = ? AND telemetry_enabled = ?", keyID, true).First(&app).Error; err != nil {
		return nil, err
	}
	// 明文为空时回退解密旧密文,兼容历史加密数据
	plain := app.TelemetrySecret
	if plain == "" && app.TelemetrySecretCiphertext != "" {
		var err error
		plain, err = common.DecryptSecret(app.TelemetrySecretCiphertext, "app-center-telemetry-key")
		if err != nil {
			return nil, gorm.ErrRecordNotFound
		}
	}
	if plain != secret {
		return nil, gorm.ErrRecordNotFound
	}
	return &app, nil
}
func LockAppCenterSession(tx *gorm.DB, appID int64, hash string) (*AppCenterUsageSession, error) {
	var s AppCenterUsageSession
	err := lockForUpdate(tx).Where("app_id = ? AND session_hash = ?", appID, hash).First(&s).Error
	return &s, err
}

// LockAppCenterForUpdate applies the dialect-aware row lock used by app-center
// ingestion before updating its aggregate counters.
func LockAppCenterForUpdate(tx *gorm.DB) *gorm.DB {
	return lockForUpdate(tx)
}

func UpsertAppCenterUsageBucket(tx *gorm.DB, b *AppCenterUsageBucket) error {
	return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "app_id"}, {Name: "bucket_ts"}, {Name: "version"}, {Name: "platform"}, {Name: "architecture"}}, DoUpdates: clause.Assignments(map[string]interface{}{"start_count": gorm.Expr("app_center_usage_buckets.start_count + ?", b.StartCount), "online_seconds": gorm.Expr("app_center_usage_buckets.online_seconds + ?", b.OnlineSeconds)})}).Create(b).Error
}

func UpsertAppCenterDownloadBucket(tx *gorm.DB, b *AppCenterDownloadBucket) error {
	return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "app_id"}, {Name: "bucket_ts"}, {Name: "version"}, {Name: "platform"}, {Name: "architecture"}}, DoUpdates: clause.Assignments(map[string]interface{}{"count": gorm.Expr("app_center_download_buckets.count + ?", b.Count)})}).Create(b).Error
}
