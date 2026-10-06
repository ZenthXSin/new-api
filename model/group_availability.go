package model

import (
	"context"
	"fmt"
	"strconv"

	"gorm.io/gorm/clause"
)

// Each process writes absolute snapshots under its own source ID. Retrying a
// flush cannot count the same request twice, including after an uncertain commit.
type GroupAvailabilityBucket struct {
	ID               int    `gorm:"primaryKey"`
	Group            string `gorm:"column:group;size:64;uniqueIndex:idx_group_availability_bucket,priority:1"`
	BucketTs         int64  `gorm:"uniqueIndex:idx_group_availability_bucket,priority:2;index:idx_group_availability_time"`
	SourceID         string `gorm:"size:32;uniqueIndex:idx_group_availability_bucket,priority:3"`
	RequestCount     int64
	SuccessCount     int64
	TotalLatencyMs   int64
	TtftSumMs        int64
	TtftCount        int64
	LastRequestAt    int64
	CacheInputTokens int64 `gorm:"not null;default:0"`
	CacheReadTokens  int64 `gorm:"not null;default:0"`
}

const groupAvailabilityStartedKey = "group_availability.collection_started_at"

func InitGroupAvailability(now int64) (int64, error) {
	option := Option{Key: groupAvailabilityStartedKey, Value: strconv.FormatInt(now, 10)}
	if err := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&option).Error; err != nil {
		return 0, err
	}
	if err := DB.Where(commonKeyCol+" = ?", groupAvailabilityStartedKey).First(&option).Error; err != nil {
		return 0, err
	}
	started, err := strconv.ParseInt(option.Value, 10, 64)
	if err != nil || started <= 0 || started > now {
		return 0, fmt.Errorf("invalid group availability collection start")
	}
	return started, nil
}

func SaveGroupAvailabilityBuckets(buckets []GroupAvailabilityBucket) error {
	if len(buckets) == 0 {
		return nil
	}
	return DB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "group"}, {Name: "bucket_ts"}, {Name: "source_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"request_count", "success_count", "total_latency_ms", "ttft_sum_ms", "ttft_count", "last_request_at", "cache_input_tokens", "cache_read_tokens",
		}),
	}).CreateInBatches(buckets, 200).Error
}

// An empty grant set is always empty, never an unrestricted query. Filtering
// precedes aggregation, so no cross-group totals enter a user's response.
func GetGroupAvailabilityBuckets(ctx context.Context, groups []string, start, end int64) ([]GroupAvailabilityBucket, error) {
	rows := make([]GroupAvailabilityBucket, 0)
	if len(groups) == 0 {
		return rows, nil
	}
	err := DB.WithContext(ctx).Model(&GroupAvailabilityBucket{}).
		Select(commonGroupCol+", bucket_ts, SUM(request_count) AS request_count, SUM(success_count) AS success_count, SUM(total_latency_ms) AS total_latency_ms, SUM(ttft_sum_ms) AS ttft_sum_ms, SUM(ttft_count) AS ttft_count, MAX(last_request_at) AS last_request_at, SUM(cache_input_tokens) AS cache_input_tokens, SUM(cache_read_tokens) AS cache_read_tokens").
		Where(commonGroupCol+" IN ? AND bucket_ts >= ? AND bucket_ts < ?", groups, start, end).
		Group(commonGroupCol + ", bucket_ts").Order("bucket_ts ASC").Find(&rows).Error
	return rows, err
}

func DeleteGroupAvailabilityBefore(cutoff int64) error {
	return DB.Where("bucket_ts < ?", cutoff).Delete(&GroupAvailabilityBucket{}).Error
}
