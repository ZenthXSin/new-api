package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
	version "github.com/hashicorp/go-version"
	"gorm.io/gorm"
)

const DistributionMaxAssetBytes int64 = 512 << 20
const DistributionMaxAnnouncementBytes = 32 << 10

var DistributionStorageRoot = distributionStorageRoot()
var distributionTagPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)
var distributionSemverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

var ErrDistributionConflict = errors.New("distribution conflict")
var ErrDistributionNotFound = errors.New("distribution not found")
var ErrDistributionInvalid = errors.New("distribution invalid")
var ErrDistributionPayloadTooLarge = errors.New("distribution payload too large")

type ReleaseInput struct{ Version, Channel, Notes string }
type AnnouncementInput struct {
	Title, Body, Channel, Platform, MinVersion string
	StartsAt, EndsAt                           *time.Time
	Pinned                                     bool
}

func validDistributionTag(value string) bool {
	return distributionTagPattern.MatchString(strings.ToLower(strings.TrimSpace(value)))
}
func normalizeChannel(value string) string { return strings.ToLower(strings.TrimSpace(value)) }
func distributionStorageRoot() string {
	if value := strings.TrimSpace(os.Getenv("DISTRIBUTION_STORAGE_ROOT")); value != "" {
		return value
	}
	return "/data/distribution"
}
func canonicalVersion(value string) (string, bool) {
	value = strings.TrimSpace(strings.TrimPrefix(value, "v"))
	if len(value) > 64 || !distributionSemverPattern.MatchString(value) {
		return "", false
	}
	if _, err := version.NewSemver(value); err != nil {
		return "", false
	}
	return value, true
}

func distributionReleaseConflict(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return ErrDistributionConflict
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "idx_distribution_release") &&
		(strings.Contains(message, "duplicate") || strings.Contains(message, "unique")) {
		return ErrDistributionConflict
	}
	if strings.Contains(message, "unique constraint failed: distribution_releases.app_id, distribution_releases.version, distribution_releases.channel") {
		return ErrDistributionConflict
	}
	return err
}

func CreateDistributionRelease(appID int64, input ReleaseInput) (*model.DistributionRelease, error) {
	version, ok := canonicalVersion(input.Version)
	channel := normalizeChannel(input.Channel)
	if appID <= 0 || !ok || !validDistributionTag(channel) || len(input.Notes) > DistributionMaxAnnouncementBytes {
		return nil, ErrDistributionInvalid
	}
	release := &model.DistributionRelease{AppID: appID, Version: version, Channel: channel, Notes: strings.TrimSpace(input.Notes), Status: model.DistributionReleaseDraft}
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.DistributionRelease{}).Where("app_id = ? AND version = ? AND channel = ?", appID, version, channel).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrDistributionConflict
		}
		return distributionReleaseConflict(tx.Create(release).Error)
	})
	return release, distributionReleaseConflict(err)
}

func UpdateDistributionRelease(appID, releaseID int64, input ReleaseInput) (*model.DistributionRelease, error) {
	var release model.DistributionRelease
	if err := model.DB.Where("id = ? AND app_id = ?", releaseID, appID).First(&release).Error; err != nil {
		return nil, distributionNotFound(err)
	}
	version, ok := canonicalVersion(input.Version)
	channel := normalizeChannel(input.Channel)
	if !ok || !validDistributionTag(channel) || len(input.Notes) > DistributionMaxAnnouncementBytes {
		return nil, ErrDistributionInvalid
	}
	result := model.DB.Model(&model.DistributionRelease{}).Where("id = ? AND app_id = ? AND status = ?", releaseID, appID, model.DistributionReleaseDraft).Updates(map[string]interface{}{"version": version, "channel": channel, "notes": strings.TrimSpace(input.Notes)})
	if result.Error != nil {
		return nil, distributionReleaseConflict(result.Error)
	}
	if result.RowsAffected == 0 {
		return nil, ErrDistributionConflict
	}
	if err := model.DB.Where("id = ?", releaseID).First(&release).Error; err != nil {
		return nil, err
	}
	return &release, nil
}

func PublishDistributionRelease(appID, releaseID int64) (*model.DistributionRelease, error) {
	var release model.DistributionRelease
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("id = ? AND app_id = ?", releaseID, appID).First(&release).Error; err != nil {
			return distributionNotFound(err)
		}
		var assets int64
		if err := tx.Model(&model.DistributionAsset{}).Where("release_id = ?", releaseID).Count(&assets).Error; err != nil {
			return err
		}
		if assets == 0 {
			return ErrDistributionInvalid
		}
		now := time.Now().UTC()
		result := tx.Model(&model.DistributionRelease{}).Where("id = ? AND app_id = ? AND status = ?", releaseID, appID, model.DistributionReleaseDraft).Updates(map[string]interface{}{"status": model.DistributionReleasePublished, "published_at": &now})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrDistributionConflict
		}
		release.Status, release.PublishedAt = model.DistributionReleasePublished, &now
		return nil
	})
	return &release, err
}

func WithdrawDistributionRelease(appID, releaseID int64) error {
	result := model.DB.Model(&model.DistributionRelease{}).Where("id = ? AND app_id = ? AND status = ?", releaseID, appID, model.DistributionReleasePublished).Update("status", model.DistributionReleaseWithdrawn)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrDistributionConflict
	}
	return nil
}

func ValidateDistributionAssetUploadTarget(appID, releaseID int64) error {
	var release model.DistributionRelease
	if err := model.DB.Where("id = ? AND app_id = ?", releaseID, appID).First(&release).Error; err != nil {
		return distributionNotFound(err)
	}
	if release.Status != model.DistributionReleaseDraft {
		return ErrDistributionConflict
	}
	return nil
}

func UploadDistributionAsset(appID, releaseID int64, platform, architecture, filename, contentType string, source io.Reader) (*model.DistributionAsset, error) {
	contentType = strings.TrimSpace(contentType)
	if !validDistributionTag(platform) || !validDistributionTag(architecture) || strings.TrimSpace(filename) == "" || len(filename) > 255 || len(contentType) > 128 || source == nil {
		return nil, ErrDistributionInvalid
	}
	if err := ValidateDistributionAssetUploadTarget(appID, releaseID); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(DistributionStorageRoot, 0750); err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp(DistributionStorageRoot, ".upload-*")
	if err != nil {
		return nil, err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	size, checksum, copyErr := copyDistributionAsset(source, temporary, DistributionMaxAssetBytes)
	closeErr := temporary.Close()
	if copyErr != nil {
		return nil, copyErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	storagePath := uuid.NewString()
	finalPath := filepath.Join(DistributionStorageRoot, storagePath)
	if err := os.Rename(temporaryName, finalPath); err != nil {
		return nil, err
	}
	asset := &model.DistributionAsset{ReleaseID: releaseID, Platform: normalizeChannel(platform), Architecture: normalizeChannel(architecture), Filename: filepath.Base(filename), ContentType: contentType, Size: size, SHA256: checksum, StoragePath: storagePath}
	if err := model.DB.Transaction(func(tx *gorm.DB) error {
		// The conditional write takes a portable write lock and rechecks draft state
		// immediately before the asset becomes visible.
		result := tx.Model(&model.DistributionRelease{}).Where("id = ? AND app_id = ? AND status = ?", releaseID, appID, model.DistributionReleaseDraft).Update("updated_at", time.Now().UTC())
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrDistributionConflict
		}
		return tx.Create(asset).Error
	}); err != nil {
		_ = os.Remove(finalPath)
		return nil, err
	}
	return asset, nil
}

func copyDistributionAsset(source io.Reader, destination io.Writer, byteLimit int64) (int64, string, error) {
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(destination, hash), io.LimitReader(source, byteLimit+1))
	checksum := hex.EncodeToString(hash.Sum(nil))
	if err != nil {
		return size, checksum, err
	}
	if size > byteLimit {
		return size, checksum, ErrDistributionPayloadTooLarge
	}
	return size, checksum, nil
}

func PublicDistributionApp(slug string) (*model.TelemetryApp, error) {
	return model.FindTelemetryAppBySlug(slug)
}
func PublicDistributionReleases(appID int64, channel string) ([]model.DistributionRelease, error) {
	query := model.DB.Preload("Assets").Where("app_id = ? AND status = ? AND published_at <= ?", appID, model.DistributionReleasePublished, time.Now().UTC())
	if channel = normalizeChannel(channel); channel != "" {
		query = query.Where("channel = ?", channel)
	}
	var releases []model.DistributionRelease
	if err := query.Find(&releases).Error; err != nil {
		return nil, err
	}
	sort.Slice(releases, func(i, j int) bool {
		return publicDistributionReleaseBefore(releases[i], releases[j])
	})
	return releases, nil
}
func LatestPublicDistributionRelease(appID int64, channel string) (*model.DistributionRelease, error) {
	releases, err := PublicDistributionReleases(appID, channel)
	if err != nil {
		return nil, err
	}
	if len(releases) == 0 {
		return nil, ErrDistributionNotFound
	}
	return &releases[0], nil
}

func ManageDistributionReleases(appID int64) ([]model.DistributionRelease, error) {
	var releases []model.DistributionRelease
	if err := model.DB.Preload("Assets").Where("app_id = ?", appID).Order("created_at DESC").Find(&releases).Error; err != nil {
		return nil, err
	}
	return releases, nil
}
func FindPublicDistributionAsset(appID, id int64) (*model.DistributionAsset, error) {
	var asset model.DistributionAsset
	err := model.DB.Joins("JOIN distribution_releases ON distribution_releases.id = distribution_assets.release_id").Where("distribution_assets.id = ? AND distribution_releases.app_id = ? AND distribution_releases.status = ? AND distribution_releases.published_at <= ?", id, appID, model.DistributionReleasePublished, time.Now().UTC()).First(&asset).Error
	if err != nil {
		return nil, distributionNotFound(err)
	}
	return &asset, nil
}
func AssetFile(asset *model.DistributionAsset) (*os.File, error) {
	if asset == nil || filepath.Base(asset.StoragePath) != asset.StoragePath || asset.StoragePath == "" {
		return nil, ErrDistributionNotFound
	}
	return os.Open(filepath.Join(DistributionStorageRoot, asset.StoragePath))
}
func IncrementDistributionDownload(id int64) {
	_ = model.DB.Model(&model.DistributionAsset{}).Where("id = ?", id).UpdateColumn("downloads", gorm.Expr("downloads + ?", 1)).Error
}

func CreateDistributionAnnouncement(appID int64, input AnnouncementInput) (*model.DistributionAnnouncement, error) {
	if err := validateAnnouncement(input); err != nil {
		return nil, err
	}
	minVersion := ""
	if input.MinVersion != "" {
		minVersion, _ = canonicalVersion(input.MinVersion)
	}
	announcement := &model.DistributionAnnouncement{AppID: appID, Title: strings.TrimSpace(input.Title), Body: strings.TrimSpace(input.Body), Status: model.DistributionAnnouncementDraft, StartsAt: input.StartsAt, EndsAt: input.EndsAt, Pinned: input.Pinned, Channel: normalizeChannel(input.Channel), Platform: normalizeChannel(input.Platform), MinVersion: minVersion}
	if err := model.DB.Create(announcement).Error; err != nil {
		return nil, err
	}
	return announcement, nil
}
func UpdateDistributionAnnouncement(appID, id int64, input AnnouncementInput) (*model.DistributionAnnouncement, error) {
	if err := validateAnnouncement(input); err != nil {
		return nil, err
	}
	var announcement model.DistributionAnnouncement
	if err := model.DB.Where("id = ? AND app_id = ?", id, appID).First(&announcement).Error; err != nil {
		return nil, distributionNotFound(err)
	}
	minVersion := ""
	if input.MinVersion != "" {
		minVersion, _ = canonicalVersion(input.MinVersion)
	}
	updates := map[string]interface{}{"title": strings.TrimSpace(input.Title), "body": strings.TrimSpace(input.Body), "starts_at": input.StartsAt, "ends_at": input.EndsAt, "pinned": input.Pinned, "channel": normalizeChannel(input.Channel), "platform": normalizeChannel(input.Platform), "min_version": minVersion}
	result := model.DB.Model(&model.DistributionAnnouncement{}).Where("id = ? AND app_id = ? AND status = ?", id, appID, model.DistributionAnnouncementDraft).Updates(updates)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, ErrDistributionConflict
	}
	if err := model.DB.Where("id = ?", id).First(&announcement).Error; err != nil {
		return nil, err
	}
	return &announcement, nil
}
func SetDistributionAnnouncementStatus(appID, id int64, from, to string) (*model.DistributionAnnouncement, error) {
	var announcement model.DistributionAnnouncement
	if err := model.DB.Where("id = ? AND app_id = ?", id, appID).First(&announcement).Error; err != nil {
		return nil, distributionNotFound(err)
	}
	result := model.DB.Model(&model.DistributionAnnouncement{}).Where("id = ? AND app_id = ? AND status = ?", id, appID, from).Update("status", to)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, ErrDistributionConflict
	}
	announcement.Status = to
	return &announcement, nil
}
func PublicDistributionAnnouncements(appID int64, channel, platform, version string) ([]model.DistributionAnnouncement, error) {
	now := time.Now().UTC()
	query := model.DB.Where("app_id = ? AND status = ? AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)", appID, model.DistributionAnnouncementPublished, now, now).Order("pinned DESC, created_at DESC")
	if channel = normalizeChannel(channel); channel != "" {
		query = query.Where("channel = '' OR channel = ?", channel)
	}
	if platform = normalizeChannel(platform); platform != "" {
		query = query.Where("platform = '' OR platform = ?", platform)
	}
	var values []model.DistributionAnnouncement
	if err := query.Find(&values).Error; err != nil {
		return nil, err
	}
	if version == "" {
		return values, nil
	}
	current, ok := canonicalVersion(version)
	if !ok {
		return nil, ErrDistributionInvalid
	}
	filtered := values[:0]
	for _, value := range values {
		if value.MinVersion == "" || compareVersions(current, value.MinVersion) >= 0 {
			filtered = append(filtered, value)
		}
	}
	return filtered, nil
}
func PublicDistributionAnnouncement(appID, id int64) (*model.DistributionAnnouncement, error) {
	values, err := PublicDistributionAnnouncements(appID, "", "", "")
	if err != nil {
		return nil, err
	}
	for _, value := range values {
		if value.ID == id {
			return &value, nil
		}
	}
	return nil, ErrDistributionNotFound
}

func ManageDistributionAnnouncements(appID int64) ([]model.DistributionAnnouncement, error) {
	var announcements []model.DistributionAnnouncement
	if err := model.DB.Where("app_id = ?", appID).Order("created_at DESC").Find(&announcements).Error; err != nil {
		return nil, err
	}
	return announcements, nil
}
func validateAnnouncement(input AnnouncementInput) error {
	if strings.TrimSpace(input.Title) == "" || len(input.Title) > 200 || len(input.Body) > DistributionMaxAnnouncementBytes || strings.Contains(strings.ToLower(input.Body), "<script") {
		return ErrDistributionInvalid
	}
	if input.Channel != "" && !validDistributionTag(input.Channel) || input.Platform != "" && !validDistributionTag(input.Platform) {
		return ErrDistributionInvalid
	}
	if input.MinVersion != "" {
		if _, ok := canonicalVersion(input.MinVersion); !ok {
			return ErrDistributionInvalid
		}
	}
	if input.StartsAt != nil && input.EndsAt != nil && !input.EndsAt.After(*input.StartsAt) {
		return ErrDistributionInvalid
	}
	return nil
}
func distributionNotFound(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrDistributionNotFound
	}
	return err
}
func compareVersions(left, right string) int {
	l, _ := canonicalVersion(left)
	r, _ := canonicalVersion(right)
	leftVersion, leftErr := version.NewSemver(l)
	rightVersion, rightErr := version.NewSemver(r)
	if leftErr != nil || rightErr != nil {
		return 0
	}
	return leftVersion.Compare(rightVersion)
}

func publicDistributionReleaseBefore(left, right model.DistributionRelease) bool {
	if precedence := compareVersions(left.Version, right.Version); precedence != 0 {
		return precedence > 0
	}
	if left.PublishedAt != nil && right.PublishedAt != nil && !left.PublishedAt.Equal(*right.PublishedAt) {
		return left.PublishedAt.After(*right.PublishedAt)
	}
	if left.PublishedAt != nil && right.PublishedAt == nil {
		return true
	}
	if left.PublishedAt == nil && right.PublishedAt != nil {
		return false
	}
	return left.ID > right.ID
}
