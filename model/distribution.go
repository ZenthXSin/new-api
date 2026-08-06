package model

import "time"

const (
	DistributionReleaseDraft          = "draft"
	DistributionReleasePublished      = "published"
	DistributionReleaseWithdrawn      = "withdrawn"
	DistributionAnnouncementDraft     = "draft"
	DistributionAnnouncementPublished = "published"
	DistributionAnnouncementArchived  = "archived"
)

type DistributionRelease struct {
	ID          int64               `json:"id" gorm:"primaryKey"`
	AppID       int64               `json:"app_id" gorm:"uniqueIndex:idx_distribution_release,priority:1;index"`
	Version     string              `json:"version" gorm:"size:64;uniqueIndex:idx_distribution_release,priority:2"`
	Channel     string              `json:"channel" gorm:"size:32;uniqueIndex:idx_distribution_release,priority:3"`
	Status      string              `json:"status" gorm:"size:16;index"`
	Notes       string              `json:"notes" gorm:"type:text"`
	PublishedAt *time.Time          `json:"published_at,omitempty" gorm:"index"`
	CreatedAt   time.Time           `json:"created_at"`
	UpdatedAt   time.Time           `json:"updated_at"`
	Assets      []DistributionAsset `json:"assets,omitempty" gorm:"foreignKey:ReleaseID"`
}

type DistributionAsset struct {
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

type DistributionAnnouncement struct {
	ID         int64      `json:"id" gorm:"primaryKey"`
	AppID      int64      `json:"app_id" gorm:"index"`
	Title      string     `json:"title" gorm:"size:200"`
	Body       string     `json:"body" gorm:"type:text"`
	Status     string     `json:"status" gorm:"size:16;index"`
	StartsAt   *time.Time `json:"starts_at,omitempty" gorm:"index"`
	EndsAt     *time.Time `json:"ends_at,omitempty" gorm:"index"`
	Pinned     bool       `json:"pinned"`
	Channel    string     `json:"channel,omitempty" gorm:"size:32"`
	Platform   string     `json:"platform,omitempty" gorm:"size:32"`
	MinVersion string     `json:"min_version,omitempty" gorm:"size:64"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

func (DistributionRelease) TableName() string      { return "distribution_releases" }
func (DistributionAsset) TableName() string        { return "distribution_assets" }
func (DistributionAnnouncement) TableName() string { return "distribution_announcements" }

// MigrateDistributionAssetSHA256Index removes the legacy global unique index.
// An asset checksum describes its bytes and may legitimately repeat across releases.
func MigrateDistributionAssetSHA256Index() error {
	if DB == nil || !DB.Migrator().HasTable(&DistributionAsset{}) {
		return nil
	}
	const legacyIndex = "idx_distribution_assets_sha256"
	if !DB.Migrator().HasIndex(&DistributionAsset{}, legacyIndex) {
		return nil
	}
	if err := DB.Migrator().DropIndex(&DistributionAsset{}, legacyIndex); err != nil {
		return err
	}
	return nil
}
