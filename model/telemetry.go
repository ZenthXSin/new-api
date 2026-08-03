package model

import (
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type TelemetryProject struct {
	ID        int64          `json:"id" gorm:"primaryKey"`
	Name      string         `json:"name" gorm:"size:128;uniqueIndex"`
	CreatedAt time.Time      `json:"created_at"`
	Apps      []TelemetryApp `json:"apps,omitempty" gorm:"foreignKey:ProjectID"`
}

type TelemetryApp struct {
	ID        int64             `json:"id" gorm:"primaryKey"`
	ProjectID int64             `json:"project_id" gorm:"uniqueIndex:idx_telemetry_app,priority:1;index"`
	Name      string            `json:"name" gorm:"size:128;uniqueIndex:idx_telemetry_app,priority:2"`
	CreatedAt time.Time         `json:"created_at"`
	Project   *TelemetryProject `json:"project,omitempty" gorm:"-"`
}

type TelemetryWriteKey struct {
	ID               int64      `json:"id" gorm:"primaryKey"`
	AppID            int64      `json:"app_id" gorm:"index"`
	Name             string     `json:"name" gorm:"size:128"`
	KeyID            string     `json:"key_id" gorm:"size:48;uniqueIndex"`
	SecretCiphertext string     `json:"-" gorm:"type:text"`
	KeyPrefix        string     `json:"key_prefix" gorm:"size:16"`
	DisabledAt       *time.Time `json:"disabled_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
}

type TelemetryNonce struct {
	ID        int64     `gorm:"primaryKey"`
	KeyID     string    `gorm:"size:48;uniqueIndex:idx_telemetry_nonce,priority:1"`
	Nonce     string    `gorm:"size:96;uniqueIndex:idx_telemetry_nonce,priority:2"`
	ExpiresAt time.Time `gorm:"index"`
	CreatedAt time.Time
}

type TelemetryBucket struct {
	ID               int64  `json:"id" gorm:"primaryKey"`
	AppID            int64  `json:"app_id" gorm:"uniqueIndex:idx_telemetry_bucket,priority:1;index"`
	InstallationHash string `json:"-" gorm:"size:64;uniqueIndex:idx_telemetry_bucket,priority:2"`
	AppVersion       string `json:"app_version" gorm:"size:64;uniqueIndex:idx_telemetry_bucket,priority:3;index"`
	EventType        string `json:"event_type" gorm:"size:32;uniqueIndex:idx_telemetry_bucket,priority:4;index"`
	Dimension        string `json:"dimension" gorm:"size:64;uniqueIndex:idx_telemetry_bucket,priority:5"`
	Status           string `json:"status" gorm:"size:16;uniqueIndex:idx_telemetry_bucket,priority:6"`
	BucketTs         int64  `json:"bucket_ts" gorm:"uniqueIndex:idx_telemetry_bucket,priority:7;index"`
	EventCount       int64  `json:"event_count"`
	SuccessCount     int64  `json:"success_count"`
	TotalDurationMs  int64  `json:"total_duration_ms"`
	TotalValue       int64  `json:"total_value"`
}

type TelemetryReceiverMetric struct {
	ID            int64 `json:"id" gorm:"primaryKey"`
	AppID         int64 `json:"app_id" gorm:"uniqueIndex:idx_telemetry_receiver_bucket,priority:1;index"`
	BucketTs      int64 `json:"bucket_ts" gorm:"uniqueIndex:idx_telemetry_receiver_bucket,priority:2;index"`
	AcceptedCount int64 `json:"accepted_count"`
	RejectedCount int64 `json:"rejected_count"`
}

func (TelemetryProject) TableName() string        { return "telemetry_projects" }
func (TelemetryApp) TableName() string            { return "telemetry_apps" }
func (TelemetryWriteKey) TableName() string       { return "telemetry_write_keys" }
func (TelemetryNonce) TableName() string          { return "telemetry_nonces" }
func (TelemetryBucket) TableName() string         { return "telemetry_buckets" }
func (TelemetryReceiverMetric) TableName() string { return "telemetry_receiver_metrics" }

func CreateTelemetryWriteKey(appID int64, name, keyID, secretCiphertext string) (*TelemetryWriteKey, error) {
	var app TelemetryApp
	if err := DB.First(&app, appID).Error; err != nil {
		return nil, err
	}
	key := &TelemetryWriteKey{
		AppID:            appID,
		Name:             strings.TrimSpace(name),
		KeyID:            keyID,
		SecretCiphertext: secretCiphertext,
		KeyPrefix:        keyID[:min(12, len(keyID))],
	}
	if err := DB.Create(key).Error; err != nil {
		return nil, err
	}
	return key, nil
}

func FindTelemetryWriteKey(keyID string) (*TelemetryWriteKey, error) {
	var key TelemetryWriteKey
	if err := DB.Where("key_id = ?", strings.TrimSpace(keyID)).First(&key).Error; err != nil {
		return nil, err
	}
	if key.DisabledAt != nil {
		return nil, gorm.ErrRecordNotFound
	}
	return &key, nil
}

func StoreTelemetryNonce(keyID, nonce string, expiresAt time.Time) error {
	return DB.Create(&TelemetryNonce{KeyID: keyID, Nonce: nonce, ExpiresAt: expiresAt}).Error
}

func UpsertTelemetryBucket(bucket *TelemetryBucket) error {
	if bucket == nil || bucket.EventCount <= 0 {
		return nil
	}
	return upsertTelemetryBucket(DB, bucket)
}

func upsertTelemetryBucket(tx *gorm.DB, bucket *TelemetryBucket) error {
	return tx.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "app_id"}, {Name: "installation_hash"}, {Name: "app_version"}, {Name: "event_type"}, {Name: "dimension"}, {Name: "status"}, {Name: "bucket_ts"}},
		DoUpdates: clause.Assignments(map[string]interface{}{
			"event_count":       gorm.Expr("telemetry_buckets.event_count + ?", bucket.EventCount),
			"success_count":     gorm.Expr("telemetry_buckets.success_count + ?", bucket.SuccessCount),
			"total_duration_ms": gorm.Expr("telemetry_buckets.total_duration_ms + ?", bucket.TotalDurationMs),
			"total_value":       gorm.Expr("telemetry_buckets.total_value + ?", bucket.TotalValue),
		}),
	}).Create(bucket).Error
}

func UpsertTelemetryReceiverMetric(appID, bucketTs, accepted, rejected int64) error {
	return upsertTelemetryReceiverMetric(DB, appID, bucketTs, accepted, rejected)
}

func upsertTelemetryReceiverMetric(tx *gorm.DB, appID, bucketTs, accepted, rejected int64) error {
	return tx.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "app_id"}, {Name: "bucket_ts"}},
		DoUpdates: clause.Assignments(map[string]interface{}{
			"accepted_count": gorm.Expr("telemetry_receiver_metrics.accepted_count + ?", accepted),
			"rejected_count": gorm.Expr("telemetry_receiver_metrics.rejected_count + ?", rejected),
		}),
	}).Create(&TelemetryReceiverMetric{AppID: appID, BucketTs: bucketTs, AcceptedCount: accepted, RejectedCount: rejected}).Error
}

func StoreTelemetryBuckets(buckets []*TelemetryBucket, appID, receiverBucketTs int64) error {
	if len(buckets) == 0 || appID <= 0 {
		return nil
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		for _, bucket := range buckets {
			if err := upsertTelemetryBucket(tx, bucket); err != nil {
				return err
			}
		}
		return upsertTelemetryReceiverMetric(tx, appID, receiverBucketTs, int64(len(buckets)), 0)
	})
}

func DeleteTelemetryDataBefore(cutoff time.Time) error {
	if cutoff.IsZero() {
		return nil
	}
	if err := DB.Where("bucket_ts < ?", cutoff.Unix()).Delete(&TelemetryBucket{}).Error; err != nil {
		return err
	}
	if err := DB.Where("bucket_ts < ?", cutoff.Unix()).Delete(&TelemetryReceiverMetric{}).Error; err != nil {
		return err
	}
	return DB.Where("expires_at < ?", time.Now()).Delete(&TelemetryNonce{}).Error
}

func TelemetryInstallationHash(installationID string) string {
	return common.GenerateHMACWithKey([]byte("telemetry-installation-v1:"+common.CryptoSecret), installationID)
}

func CreateTelemetryProject(name string) (*TelemetryProject, error) {
	project := &TelemetryProject{Name: strings.TrimSpace(name)}
	if err := DB.Create(project).Error; err != nil {
		return nil, err
	}
	return project, nil
}

func CreateTelemetryApp(projectID int64, name string) (*TelemetryApp, error) {
	var project TelemetryProject
	if err := DB.First(&project, projectID).Error; err != nil {
		return nil, err
	}
	app := &TelemetryApp{ProjectID: projectID, Name: strings.TrimSpace(name)}
	if err := DB.Create(app).Error; err != nil {
		return nil, err
	}
	return app, nil
}

func ListTelemetryProjects() ([]TelemetryProject, error) {
	var projects []TelemetryProject
	if err := DB.Order("id ASC").Find(&projects).Error; err != nil {
		return nil, err
	}
	return projects, nil
}

func ListTelemetryApps(projectID int64) ([]TelemetryApp, error) {
	query := DB.Order("id ASC")
	if projectID > 0 {
		query = query.Where("project_id = ?", projectID)
	}
	var apps []TelemetryApp
	if err := query.Find(&apps).Error; err != nil {
		return nil, err
	}
	return apps, nil
}

func ListTelemetryWriteKeys(appID int64) ([]TelemetryWriteKey, error) {
	var keys []TelemetryWriteKey
	if err := DB.Where("app_id = ?", appID).Order("id ASC").Find(&keys).Error; err != nil {
		return nil, err
	}
	return keys, nil
}

func DisableTelemetryWriteKey(id int64) error {
	now := time.Now()
	return DB.Model(&TelemetryWriteKey{}).Where("id = ? AND disabled_at IS NULL", id).Update("disabled_at", &now).Error
}

type TelemetrySummaryRow struct {
	AppID           int64  `json:"app_id"`
	AppVersion      string `json:"app_version"`
	EventType       string `json:"event_type"`
	Dimension       string `json:"dimension"`
	Status          string `json:"status"`
	EventCount      int64  `json:"event_count"`
	SuccessCount    int64  `json:"success_count"`
	TotalDurationMs int64  `json:"total_duration_ms"`
	TotalValue      int64  `json:"total_value"`
}

type TelemetryTimeSeriesRow struct {
	AppID           int64  `json:"app_id"`
	BucketTs        int64  `json:"bucket_ts"`
	AppVersion      string `json:"app_version"`
	EventType       string `json:"event_type"`
	Dimension       string `json:"dimension"`
	Status          string `json:"status"`
	EventCount      int64  `json:"event_count"`
	SuccessCount    int64  `json:"success_count"`
	TotalDurationMs int64  `json:"total_duration_ms"`
	TotalValue      int64  `json:"total_value"`
}

func QueryTelemetrySummary(appID, since int64) ([]TelemetrySummaryRow, error) {
	query := DB.Model(&TelemetryBucket{}).
		Select("app_id, app_version, event_type, dimension, status, SUM(event_count) AS event_count, SUM(success_count) AS success_count, SUM(total_duration_ms) AS total_duration_ms, SUM(total_value) AS total_value").
		Where("bucket_ts >= ?", since).
		Group("app_id, app_version, event_type, dimension, status").
		Order("app_id ASC, event_type ASC, app_version ASC")
	if appID > 0 {
		query = query.Where("app_id = ?", appID)
	}
	var rows []TelemetrySummaryRow
	if err := query.Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func QueryTelemetryTimeSeries(appID, since int64) ([]TelemetryTimeSeriesRow, error) {
	query := DB.Model(&TelemetryBucket{}).
		Select("app_id, bucket_ts, app_version, event_type, dimension, status, SUM(event_count) AS event_count, SUM(success_count) AS success_count, SUM(total_duration_ms) AS total_duration_ms, SUM(total_value) AS total_value").
		Where("bucket_ts >= ?", since).
		Group("app_id, bucket_ts, app_version, event_type, dimension, status").
		Order("bucket_ts ASC, event_type ASC, app_version ASC")
	if appID > 0 {
		query = query.Where("app_id = ?", appID)
	}
	var rows []TelemetryTimeSeriesRow
	if err := query.Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
