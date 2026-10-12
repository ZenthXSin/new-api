package model

import (
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// This is a relay activity record. Existing relay billing remains the sole
// authority for charging and refunding requests.
type ImageGeneration struct {
	ID             string `json:"id" gorm:"primaryKey;type:varchar(36)"`
	UserID         int    `json:"-" gorm:"index:idx_image_owner_created,priority:1"`
	RequestID      string `json:"request_id" gorm:"type:varchar(191)"`
	Model          string `json:"model" gorm:"type:varchar(191)"`
	Endpoint       string `json:"endpoint" gorm:"type:varchar(512)"`
	Status         string `json:"status" gorm:"type:varchar(24);index:idx_image_status_updated,priority:1"`
	ExpectedCount  int    `json:"expected_count"`
	CompletedCount int    `json:"completed_count"`
	CreatedAt      int64  `json:"created_at" gorm:"index:idx_image_owner_created,priority:2"`
	UpdatedAt      int64  `json:"updated_at" gorm:"index:idx_image_status_updated,priority:2"`
	FinishedAt     int64  `json:"finished_at"`
	Failure        string `json:"failure"`
	Results        string `json:"-" gorm:"type:text"`
}

type GeneratedImage struct {
	URL   string `json:"url,omitempty"`
	Asset string `json:"asset,omitempty"`
	Mime  string `json:"mime,omitempty"`
}

type ImageGenerationCounts struct {
	Connecting int64 `json:"connecting_images"`
	Generating int64 `json:"generating_images"`
	Requests   int64 `json:"active_requests"`
}

func ImageGenerationQuery(userID int, all bool) *gorm.DB {
	query := DB.Model(&ImageGeneration{})
	if !all {
		query = query.Where("user_id = ?", userID)
	}
	return query
}

func ExpireImageGenerations() error {
	return DB.Model(&ImageGeneration{}).
		Where("status IN ? AND updated_at < ?", []string{"connecting", "generating"}, time.Now().Unix()-180).
		Updates(map[string]any{"status": "interrupted", "failure": "Image generation was interrupted.", "finished_at": time.Now().Unix()}).Error
}

func ListImageGenerations(userID int, all bool, offset, limit int) ([]ImageGeneration, int64, ImageGenerationCounts, error) {
	var items []ImageGeneration
	var total int64
	var counts ImageGenerationCounts
	if err := ImageGenerationQuery(userID, all).Count(&total).Error; err != nil {
		return nil, 0, counts, err
	}
	if err := ImageGenerationQuery(userID, all).Order("created_at DESC, id DESC").Offset(offset).Limit(limit).Find(&items).Error; err != nil {
		return nil, 0, counts, err
	}
	var phases []struct {
		Status    string
		Requests  int64
		Images    int64
		Completed int64
	}
	err := ImageGenerationQuery(userID, all).Where("status IN ?", []string{"connecting", "generating"}).
		Select("status, COUNT(*) AS requests, SUM(expected_count) AS images, SUM(completed_count) AS completed").
		Group("status").Scan(&phases).Error
	if err != nil {
		return nil, 0, counts, err
	}
	for _, phase := range phases {
		pending := max(int64(0), phase.Images-phase.Completed)
		if phase.Status == "connecting" {
			counts.Connecting += pending
		} else {
			counts.Generating += pending
		}
		counts.Requests += phase.Requests
	}
	legacy := DB.Model(&Midjourney{}).Where("status IN ?", []string{"NOT_START", "SUBMITTED", "QUEUED", "IN_PROGRESS"})
	if !all {
		legacy = legacy.Where("user_id = ?", userID)
	}
	var mjCount int64
	if err = legacy.Count(&mjCount).Error; err != nil {
		return nil, 0, counts, err
	}
	counts.Generating += mjCount
	counts.Requests += mjCount
	return items, total, counts, nil
}

func (job *ImageGeneration) Images() []GeneratedImage {
	var images []GeneratedImage
	_ = common.UnmarshalJsonStr(job.Results, &images)
	return images
}
