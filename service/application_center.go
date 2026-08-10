package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
	version "github.com/hashicorp/go-version"
	"github.com/oschwald/geoip2-golang"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var AppCenterStorageRoot = "/data/app-center"

const AppCenterMaxAssetBytes int64 = 512 << 20
const AppCenterMaxEventBuckets int64 = 10000

var appCenterTag = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)
var appCenterSemver = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
var ErrAppCenterInvalid = errors.New("应用中心参数无效")
var ErrAppCenterNotFound = errors.New("应用中心资源不存在")
var ErrAppCenterConflict = errors.New("应用中心资源冲突")
var ErrTelemetryRateLimited = errors.New("遥测请求过于频繁")

type appCenterRateWindow struct {
	startedAt time.Time
	count     int
}

var appCenterRateMu sync.Mutex
var appCenterRateWindows = map[string]appCenterRateWindow{}

type AppCenterReleaseInput struct{ Version, Channel, Notes string }
type AppCenterAnnouncementInput struct {
	Title, Body, Channel, Platform, MinVersion string
	StartsAt, EndsAt                           *time.Time
	Pinned                                     bool
}
type AppCenterUsageInput struct {
	Type           string `json:"type"`
	SessionID      string `json:"session_id"`
	InstallationID string `json:"installation_id"`
	Sequence       int64  `json:"sequence"`
	Version        string `json:"version"`
	Platform       string `json:"platform"`
	Architecture   string `json:"architecture"`
}
type AppCenterEvent struct {
	EventID    string            `json:"event_id"`
	Name       string            `json:"name"`
	OccurredAt int64             `json:"occurred_at"`
	Count      int64             `json:"count"`
	Dimensions map[string]string `json:"dimensions"`
}

var appCenterGeoIPMu sync.Mutex
var appCenterGeoIPReader *geoip2.Reader
var appCenterGeoIPPath string

func appCenterGeoIPDatabasePath() string {
	if path := strings.TrimSpace(os.Getenv("APP_CENTER_GEOIP_DB")); path != "" {
		return path
	}
	if _, err := os.Stat("/data/app-center/Country.mmdb"); err == nil {
		return "/data/app-center/Country.mmdb"
	}
	return "/root/clash-for-linux-install/resources/Country.mmdb"
}

func appCenterGeoIP(ip net.IP) (country, region, city string) {
	if ip == nil {
		return "未知", "未知", "未知"
	}
	path := appCenterGeoIPDatabasePath()
	appCenterGeoIPMu.Lock()
	if appCenterGeoIPPath != path {
		if appCenterGeoIPReader != nil {
			_ = appCenterGeoIPReader.Close()
		}
		appCenterGeoIPReader = nil
		appCenterGeoIPPath = path
		if reader, err := geoip2.Open(path); err == nil {
			appCenterGeoIPReader = reader
		}
	}
	reader := appCenterGeoIPReader
	appCenterGeoIPMu.Unlock()
	if reader == nil {
		return "未知", "未知", "未知"
	}
	record, err := reader.City(ip)
	if err == nil {
		country = record.Country.Names["zh-CN"]
		if country == "" {
			country = record.Country.IsoCode
		}
		if len(record.Subdivisions) > 0 {
			region = record.Subdivisions[0].Names["zh-CN"]
			if region == "" {
				region = record.Subdivisions[0].IsoCode
			}
		}
		city = record.City.Names["zh-CN"]
		if city == "" {
			city = record.City.Names["en"]
		}
	} else if record, countryErr := reader.Country(ip); countryErr == nil {
		country = record.Country.Names["zh-CN"]
		if country == "" {
			country = record.Country.IsoCode
		}
	}
	if country == "" {
		country = "未知"
	}
	if region == "" {
		region = "未知"
	}
	if city == "" {
		city = "未知"
	}
	return country, region, city
}

func normalizeAppCenterSourceIP(value string) (string, net.IP) {
	ip := net.ParseIP(strings.TrimSpace(value))
	if ip == nil {
		return "", nil
	}
	return ip.String(), ip
}

func normalizeCenter(v string) string { return strings.ToLower(strings.TrimSpace(v)) }
func validCenterTag(v string) bool    { return appCenterTag.MatchString(normalizeCenter(v)) }
func canonicalCenterVersion(v string) (string, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if len(v) > 64 || !appCenterSemver.MatchString(v) {
		return "", false
	}
	if _, err := version.NewSemver(v); err != nil {
		return "", false
	}
	return v, true
}
func CreateAppCenterApp(name, slug, description string, public, telemetry bool) (*model.AppCenterApp, string, error) {
	name = strings.TrimSpace(name)
	slug = normalizeCenter(slug)
	if name == "" || len(name) > 128 || !validCenterTag(slug) || len(description) > 65535 {
		return nil, "", ErrAppCenterInvalid
	}
	keyID, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, "", err
	}
	secret, err := common.GenerateRandomKey(48)
	if err != nil {
		return nil, "", err
	}
	app := &model.AppCenterApp{Name: name, Slug: slug, Description: description, Public: public, TelemetryEnabled: telemetry, TelemetryKeyID: keyID, TelemetrySecret: secret}
	if err := model.DB.Create(app).Error; err != nil {
		return nil, "", err
	}
	return app, "app_v2." + keyID + "." + secret, nil
}
func RevealAppCenterKey(appID int64) (string, error) {
	var a model.AppCenterApp
	if err := model.DB.First(&a, appID).Error; err != nil {
		return "", ErrAppCenterNotFound
	}
	secret := a.TelemetrySecret
	// 明文为空时回退解密旧密文,兼容历史加密数据
	if secret == "" {
		legacy, err := common.DecryptSecret(a.TelemetrySecretCiphertext, "app-center-telemetry-key")
		if err != nil {
			return "", err
		}
		secret = legacy
	}
	return "app_v2." + a.TelemetryKeyID + "." + secret, nil
}
func RotateAppCenterKey(appID int64) (string, error) {
	key, err := CreateRotatedAppCenterKey(appID)
	return key, err
}
func CreateRotatedAppCenterKey(appID int64) (string, error) {
	var a model.AppCenterApp
	if err := model.DB.First(&a, appID).Error; err != nil {
		return "", ErrAppCenterNotFound
	}
	kid, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return "", err
	}
	sec, err := common.GenerateRandomKey(48)
	if err != nil {
		return "", err
	}
	if err = model.DB.Model(&a).Updates(map[string]interface{}{"telemetry_key_id": kid, "telemetry_secret": sec, "telemetry_secret_ciphertext": ""}).Error; err != nil {
		return "", err
	}
	return "app_v2." + kid + "." + sec, nil
}

func CreateAppCenterRelease(appID int64, in AppCenterReleaseInput) (*model.AppCenterRelease, error) {
	v, ok := canonicalCenterVersion(in.Version)
	ch := normalizeCenter(in.Channel)
	if appID <= 0 || !ok || !validCenterTag(ch) || len(in.Notes) > 32<<10 {
		return nil, ErrAppCenterInvalid
	}
	var app model.AppCenterApp
	if err := model.DB.Select("id").First(&app, appID).Error; err != nil {
		return nil, ErrAppCenterNotFound
	}
	r := &model.AppCenterRelease{AppID: appID, Version: v, Channel: ch, Notes: strings.TrimSpace(in.Notes), Status: model.AppCenterReleaseDraft}
	if err := model.DB.Create(r).Error; err != nil {
		return nil, err
	}
	return r, nil
}
func UpdateAppCenterRelease(appID, id int64, in AppCenterReleaseInput) (*model.AppCenterRelease, error) {
	v, ok := canonicalCenterVersion(in.Version)
	ch := normalizeCenter(in.Channel)
	if !ok || !validCenterTag(ch) {
		return nil, ErrAppCenterInvalid
	}
	res := model.DB.Model(&model.AppCenterRelease{}).Where("id = ? AND app_id = ? AND status = ?", id, appID, model.AppCenterReleaseDraft).Updates(map[string]interface{}{"version": v, "channel": ch, "notes": strings.TrimSpace(in.Notes)})
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, ErrAppCenterConflict
	}
	var r model.AppCenterRelease
	err := model.DB.Preload("Assets").First(&r, id).Error
	return &r, err
}
func PublishAppCenterRelease(appID, id int64) (*model.AppCenterRelease, error) {
	var r model.AppCenterRelease
	if err := model.DB.Preload("Assets").Where("id = ? AND app_id = ?", id, appID).First(&r).Error; err != nil {
		return nil, ErrAppCenterNotFound
	}
	if len(r.Assets) == 0 {
		return nil, ErrAppCenterInvalid
	}
	now := time.Now().UTC()
	res := model.DB.Model(&model.AppCenterRelease{}).Where("id = ? AND app_id = ? AND status = ?", id, appID, model.AppCenterReleaseDraft).Updates(map[string]interface{}{"status": model.AppCenterReleasePublished, "published_at": &now})
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, ErrAppCenterConflict
	}
	r.Status = model.AppCenterReleasePublished
	r.PublishedAt = &now
	return &r, nil
}
func ListAppCenterReleases(appID int64, publicOnly bool, channel string) ([]model.AppCenterRelease, error) {
	q := model.DB.Preload("Assets").Where("app_id = ?", appID)
	if publicOnly {
		q = q.Where("status = ? AND published_at <= ?", model.AppCenterReleasePublished, time.Now().UTC())
	}
	if channel = normalizeCenter(channel); channel != "" {
		q = q.Where("channel = ?", channel)
	}
	var rows []model.AppCenterRelease
	if err := q.Find(&rows).Error; err != nil {
		return nil, err
	}
	sort.Slice(rows, func(i, j int) bool {
		a, _ := version.NewSemver(rows[i].Version)
		b, _ := version.NewSemver(rows[j].Version)
		return a.GreaterThan(b)
	})
	return rows, nil
}
func LatestAppCenterRelease(appID int64, channel string) (*model.AppCenterRelease, error) {
	rows, err := ListAppCenterReleases(appID, true, channel)
	if err != nil || len(rows) == 0 {
		return nil, ErrAppCenterNotFound
	}
	return &rows[0], nil
}

func AppCenterUpdateAvailable(current, available string) bool {
	if strings.TrimSpace(current) == "" {
		return true
	}
	currentVersion, ok := canonicalCenterVersion(current)
	if !ok {
		return false
	}
	left, leftErr := version.NewSemver(currentVersion)
	right, rightErr := version.NewSemver(available)
	return leftErr == nil && rightErr == nil && right.GreaterThan(left)
}

func UploadAppCenterAsset(appID, releaseID int64, platform, arch, filename, contentType string, src io.Reader) (*model.AppCenterAsset, error) {
	if !validCenterTag(platform) || !validCenterTag(arch) || src == nil || strings.TrimSpace(filename) == "" || len(filename) > 255 {
		return nil, ErrAppCenterInvalid
	}
	var r model.AppCenterRelease
	if err := model.DB.Where("id = ? AND app_id = ? AND status = ?", releaseID, appID, model.AppCenterReleaseDraft).First(&r).Error; err != nil {
		return nil, ErrAppCenterConflict
	}
	if err := os.MkdirAll(AppCenterStorageRoot, 0750); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(AppCenterStorageRoot, ".upload-")
	if err != nil {
		return nil, err
	}
	name := tmp.Name()
	defer os.Remove(name)
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(src, AppCenterMaxAssetBytes+1))
	tmp.Close()
	if err != nil {
		return nil, err
	}
	if n > AppCenterMaxAssetBytes {
		return nil, errors.New("asset too large")
	}
	path := uuid.NewString()
	if err := os.Rename(name, filepath.Join(AppCenterStorageRoot, path)); err != nil {
		return nil, err
	}
	a := &model.AppCenterAsset{ReleaseID: releaseID, Platform: normalizeCenter(platform), Architecture: normalizeCenter(arch), Filename: filepath.Base(filename), ContentType: contentType, Size: n, SHA256: hex.EncodeToString(h.Sum(nil)), StoragePath: path}
	if err := model.DB.Create(a).Error; err != nil {
		_ = os.Remove(filepath.Join(AppCenterStorageRoot, path))
		return nil, err
	}
	return a, nil
}

// AppCenterImportDir 服务器文件导入目录:管理员把安装包放到该目录后,
// 可经由 upload 的 server_file 字段直接导入,无需重新上传。
func AppCenterImportDir() string {
	return filepath.Join(AppCenterStorageRoot, "imports")
}

type AppCenterServerFile struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mod_time"`
}

func ListAppCenterServerFiles() ([]AppCenterServerFile, error) {
	entries, err := os.ReadDir(AppCenterImportDir())
	if err != nil {
		if os.IsNotExist(err) {
			return []AppCenterServerFile{}, nil
		}
		return nil, err
	}
	files := make([]AppCenterServerFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, AppCenterServerFile{Name: entry.Name(), Size: info.Size(), ModTime: info.ModTime().Unix()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files, nil
}

func OpenAppCenterServerFile(name string) (*os.File, error) {
	if filepath.Base(name) != name {
		return nil, ErrAppCenterInvalid
	}
	return os.Open(filepath.Join(AppCenterImportDir(), name))
}

func FindAppCenterAsset(appID, id int64) (*model.AppCenterAsset, error) {
	var a model.AppCenterAsset
	err := model.DB.Joins("JOIN app_center_releases ON app_center_releases.id = app_center_assets.release_id").Where("app_center_assets.id = ? AND app_center_releases.app_id = ? AND app_center_releases.status = ? AND app_center_releases.published_at <= ?", id, appID, model.AppCenterReleasePublished, time.Now().UTC()).First(&a).Error
	if err != nil {
		return nil, ErrAppCenterNotFound
	}
	return &a, nil
}
func AppCenterAssetFile(a *model.AppCenterAsset) (*os.File, error) {
	if a == nil || filepath.Base(a.StoragePath) != a.StoragePath {
		return nil, ErrAppCenterNotFound
	}
	return os.Open(filepath.Join(AppCenterStorageRoot, a.StoragePath))
}
func IncrementAppCenterDownload(asset *model.AppCenterAsset) {
	if asset == nil {
		return
	}
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		var release model.AppCenterRelease
		if err := tx.First(&release, "id = ?", asset.ReleaseID).Error; err != nil {
			return err
		}
		res := tx.Model(&model.AppCenterAsset{}).Where("id = ?", asset.ID).UpdateColumn("downloads", gorm.Expr("downloads + ?", 1))
		if res.Error != nil {
			return res.Error
		}
		bucket := &model.AppCenterDownloadBucket{AppID: release.AppID, BucketTs: time.Now().Unix() / 3600 * 3600, Version: release.Version, Platform: asset.Platform, Architecture: asset.Architecture, Count: 1}
		if err := model.UpsertAppCenterDownloadBucket(tx, bucket); err != nil {
			common.SysError(fmt.Sprintf("app-center download bucket write failed: app_id=%d asset_id=%d err=%v", release.AppID, asset.ID, err))
		}
		return nil
	})
	if err != nil {
		common.SysError(fmt.Sprintf("app-center download counting failed: asset_id=%d err=%v", asset.ID, err))
	}
}

func CreateAppCenterAnnouncement(appID int64, in AppCenterAnnouncementInput) (*model.AppCenterAnnouncement, error) {
	if strings.TrimSpace(in.Title) == "" || len(in.Title) > 200 || len(in.Body) > 32<<10 || (in.Channel != "" && !validCenterTag(in.Channel)) || (in.Platform != "" && !validCenterTag(in.Platform)) {
		return nil, ErrAppCenterInvalid
	}
	if in.StartsAt != nil && in.EndsAt != nil && !in.EndsAt.After(*in.StartsAt) {
		return nil, ErrAppCenterInvalid
	}
	var app model.AppCenterApp
	if err := model.DB.Select("id").First(&app, appID).Error; err != nil {
		return nil, ErrAppCenterNotFound
	}
	min := ""
	if in.MinVersion != "" {
		var ok bool
		min, ok = canonicalCenterVersion(in.MinVersion)
		if !ok {
			return nil, ErrAppCenterInvalid
		}
	}
	a := &model.AppCenterAnnouncement{AppID: appID, Title: strings.TrimSpace(in.Title), Body: strings.TrimSpace(in.Body), Status: model.AppCenterReleaseDraft, StartsAt: in.StartsAt, EndsAt: in.EndsAt, Pinned: in.Pinned, Channel: normalizeCenter(in.Channel), Platform: normalizeCenter(in.Platform), MinVersion: min}
	return a, model.DB.Create(a).Error
}
func ListAppCenterAnnouncements(appID int64, publicOnly bool, channel, platform, current string) ([]model.AppCenterAnnouncement, error) {
	q := model.DB.Where("app_id = ?", appID)
	now := time.Now().UTC()
	if publicOnly {
		q = q.Where("status = ? AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)", model.AppCenterReleasePublished, now, now)
	}
	if channel = normalizeCenter(channel); channel != "" {
		q = q.Where("channel = '' OR channel = ?", channel)
	}
	if platform = normalizeCenter(platform); platform != "" {
		q = q.Where("platform = '' OR platform = ?", platform)
	}
	var rows []model.AppCenterAnnouncement
	if err := q.Order("pinned DESC, created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	if current == "" {
		return rows, nil
	}
	v, ok := canonicalCenterVersion(current)
	if !ok {
		return nil, ErrAppCenterInvalid
	}
	out := rows[:0]
	for _, a := range rows {
		if a.MinVersion == "" {
			out = append(out, a)
			continue
		}
		av, _ := version.NewSemver(v)
		mv, _ := version.NewSemver(a.MinVersion)
		if av.GreaterThanOrEqual(mv) {
			out = append(out, a)
		}
	}
	return out, nil
}
func PublishAppCenterAnnouncement(appID, id int64, archive bool) (*model.AppCenterAnnouncement, error) {
	to := model.AppCenterReleasePublished
	if archive {
		to = model.AppCenterReleaseArchived
	}
	res := model.DB.Model(&model.AppCenterAnnouncement{}).Where("id = ? AND app_id = ?", id, appID).Update("status", to)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, ErrAppCenterNotFound
	}
	var a model.AppCenterAnnouncement
	return &a, model.DB.First(&a, id).Error
}

func UpdateAppCenterAnnouncement(appID, id int64, in AppCenterAnnouncementInput) (*model.AppCenterAnnouncement, error) {
	if strings.TrimSpace(in.Title) == "" || len(in.Title) > 200 || len(in.Body) > 32<<10 {
		return nil, ErrAppCenterInvalid
	}
	result := model.DB.Model(&model.AppCenterAnnouncement{}).Where("id = ? AND app_id = ? AND status = ?", id, appID, model.AppCenterReleaseDraft).Updates(map[string]interface{}{"title": strings.TrimSpace(in.Title), "body": strings.TrimSpace(in.Body), "channel": normalizeCenter(in.Channel), "platform": normalizeCenter(in.Platform), "pinned": in.Pinned, "starts_at": in.StartsAt, "ends_at": in.EndsAt})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, ErrAppCenterConflict
	}
	var announcement model.AppCenterAnnouncement
	return &announcement, model.DB.First(&announcement, id).Error
}

func DeleteAppCenterAsset(appID, releaseID, assetID int64) error {
	var asset model.AppCenterAsset
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		var release model.AppCenterRelease
		if err := tx.Where("id = ? AND app_id = ? AND status = ?", releaseID, appID, model.AppCenterReleaseDraft).First(&release).Error; err != nil {
			return ErrAppCenterConflict
		}
		if err := tx.Where("id = ? AND release_id = ?", assetID, releaseID).First(&asset).Error; err != nil {
			return ErrAppCenterNotFound
		}
		return tx.Delete(&asset).Error
	})
	if err == nil {
		_ = os.Remove(filepath.Join(AppCenterStorageRoot, asset.StoragePath))
	}
	return err
}

func VerifyAppCenterBearer(ip, header string) (*model.AppCenterApp, error) {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(header), "Bearer "), ".")
	if len(parts) != 3 || parts[0] != "app_v2" || parts[1] == "" || parts[2] == "" {
		return nil, ErrAppCenterNotFound
	}
	if !takeTelemetryRateLimit("app-center-global", 600) || !takeTelemetryRateLimit("app-center-ip:"+ip, 120) || !takeTelemetryRateLimit("app-center-key:"+parts[1], 120) {
		return nil, ErrTelemetryRateLimited
	}
	return model.FindAppCenterBearer(parts[1], parts[2])
}
func takeTelemetryRateLimit(key string, limit int) bool {
	now := time.Now()
	appCenterRateMu.Lock()
	defer appCenterRateMu.Unlock()
	w := appCenterRateWindows[key]
	if w.startedAt.IsZero() || now.Sub(w.startedAt) >= time.Minute {
		appCenterRateWindows[key] = appCenterRateWindow{startedAt: now, count: 1}
		return true
	}
	if w.count >= limit {
		return false
	}
	w.count++
	appCenterRateWindows[key] = w
	return true
}
func RecordAppCenterUsage(app *model.AppCenterApp, in AppCenterUsageInput, sourceIPs ...string) (int64, error) {
	if app == nil || in.Type != "start" && in.Type != "heartbeat" && in.Type != "stop" || len(in.SessionID) == 0 || len(in.InstallationID) == 0 || in.Sequence < 1 || len(in.Version) > 64 || !validCenterTag(in.Platform) || !validCenterTag(in.Architecture) {
		return 0, ErrAppCenterInvalid
	}
	now := time.Now().UTC()
	sourceIP := ""
	var sourceNetIP net.IP
	if len(sourceIPs) > 0 {
		sourceIP, sourceNetIP = normalizeAppCenterSourceIP(sourceIPs[0])
	}
	country, region, city := appCenterGeoIP(sourceNetIP)
	sh := model.AppCenterHash(in.SessionID)
	ih := model.AppCenterHash(in.InstallationID)
	var elapsed int64
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		s, err := model.LockAppCenterSession(tx, app.ID, sh)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if in.Type != "start" {
				return ErrAppCenterInvalid
			}
			s = &model.AppCenterUsageSession{AppID: app.ID, SessionHash: sh, InstallationHash: ih, LastSequence: in.Sequence, LastSeenAt: now, StartedAt: now, Version: in.Version, Platform: normalizeCenter(in.Platform), Architecture: normalizeCenter(in.Architecture), SourceIP: sourceIP, Country: country, Region: region, City: city}
			if err := tx.Create(s).Error; err != nil {
				return err
			}
			elapsed = 0
		} else if err != nil {
			return err
		} else {
			if in.Sequence <= s.LastSequence {
				return nil
			}
			if s.ClosedAt != nil || in.Type == "start" || s.InstallationHash != ih {
				return ErrAppCenterInvalid
			}
			gap := now.Sub(s.LastSeenAt).Seconds()
			if gap > 300 {
				gap = 300
			}
			if gap > 0 {
				elapsed = int64(gap)
			}
			s.LastSequence = in.Sequence
			s.LastSeenAt = now
			if sourceIP != "" {
				s.SourceIP = sourceIP
				s.Country = country
				s.Region = region
				s.City = city
			}
			if in.Type == "stop" {
				s.ClosedAt = &now
			}
			if err := tx.Save(s).Error; err != nil {
				return err
			}
		}
		b := &model.AppCenterUsageBucket{AppID: app.ID, BucketTs: now.Unix() / 3600 * 3600, Version: s.Version, Platform: s.Platform, Architecture: s.Architecture, OnlineSeconds: elapsed}
		if in.Type == "start" {
			b.StartCount = 1
		}
		if err := model.UpsertAppCenterUsageBucket(tx, b); err != nil {
			return err
		}
		ab := &model.AppCenterUsageActiveBucket{AppID: app.ID, BucketTs: b.BucketTs, InstallationHash: ih, Version: s.Version, Platform: s.Platform, Architecture: s.Architecture}
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(ab).Error
	})
	return elapsed, err
}

func RecordAppCenterEvents(app *model.AppCenterApp, events []AppCenterEvent, sourceIPs ...string) (int, error) {
	if app == nil || len(events) == 0 || len(events) > 100 {
		return 0, ErrAppCenterInvalid
	}
	accepted := 0
	sourceIP := ""
	sourceCountry, sourceRegion, sourceCity := "", "", ""
	if len(sourceIPs) > 0 {
		var sourceNetIP net.IP
		sourceIP, sourceNetIP = normalizeAppCenterSourceIP(sourceIPs[0])
		if sourceIP != "" {
			sourceCountry, sourceRegion, sourceCity = appCenterGeoIP(sourceNetIP)
		}
	}
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		var lockedApp model.AppCenterApp
		if err := model.LockAppCenterForUpdate(tx).Select("id").First(&lockedApp, app.ID).Error; err != nil {
			return ErrAppCenterNotFound
		}
		var bucketCount int64
		if err := tx.Model(&model.AppCenterCustomEventBucket{}).Where("app_id = ?", app.ID).Count(&bucketCount).Error; err != nil {
			return err
		}
		if bucketCount+int64(len(events)) > AppCenterMaxEventBuckets {
			return ErrTelemetryRateLimited
		}
		if err := tx.Where("app_id = ? AND expires_at < ?", app.ID, time.Now().UTC()).Delete(&model.AppCenterEventReceipt{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ? AND expires_at < ?", app.ID, time.Now().UTC()).Delete(&model.AppCenterEventIPReceipt{}).Error; err != nil {
			return err
		}
		for _, e := range events {
			if e.EventID == "" || len(e.EventID) > 128 || e.Name == "" || len(e.Name) > 128 || e.Count < 1 || e.Count > 1000000 || len(e.Dimensions) > 8 {
				return ErrAppCenterInvalid
			}
			now := time.Now().UTC()
			if e.OccurredAt <= 0 || now.Sub(time.Unix(e.OccurredAt, 0)) > 7*24*time.Hour || time.Unix(e.OccurredAt, 0).After(now.Add(5*time.Minute)) {
				return ErrAppCenterInvalid
			}
			for k, v := range e.Dimensions {
				if len(k) > 32 || len(v) > 128 {
					return ErrAppCenterInvalid
				}
			}
			dimensionsJSON, err := common.Marshal(e.Dimensions)
			if err != nil {
				return ErrAppCenterInvalid
			}
			d := string(dimensionsJSON)
			dimensionsSum := sha256.Sum256([]byte(d))
			receipt := &model.AppCenterEventReceipt{AppID: app.ID, EventID: e.EventID, ExpiresAt: now.Add(7 * 24 * time.Hour)}
			res := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "app_id"}, {Name: "event_id"}}, DoNothing: true}).Create(receipt)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				continue
			}
			bucket := &model.AppCenterCustomEventBucket{AppID: app.ID, BucketTs: e.OccurredAt / 3600 * 3600, Name: e.Name, Dimensions: d, DimensionsHash: hex.EncodeToString(dimensionsSum[:]), Count: e.Count}
			if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "app_id"}, {Name: "bucket_ts"}, {Name: "name"}, {Name: "dimensions_hash"}}, DoUpdates: clause.Assignments(map[string]interface{}{"count": gorm.Expr("app_center_custom_event_buckets.count + ?", e.Count)})}).Create(bucket).Error; err != nil {
				return err
			}
			if sourceIP != "" {
				ipReceipt := &model.AppCenterEventIPReceipt{AppID: app.ID, BucketTs: bucket.BucketTs, Name: e.Name, DimensionsHash: bucket.DimensionsHash, SourceIP: sourceIP, Country: sourceCountry, Region: sourceRegion, City: sourceCity, ExpiresAt: now.Add(30 * 24 * time.Hour)}
				ipResult := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(ipReceipt)
				if ipResult.Error != nil {
					return ipResult.Error
				}
				if ipResult.RowsAffected == 1 {
					if err := tx.Model(&model.AppCenterCustomEventBucket{}).Where("app_id = ? AND bucket_ts = ? AND name = ? AND dimensions_hash = ?", app.ID, bucket.BucketTs, e.Name, bucket.DimensionsHash).UpdateColumn("unique_users", gorm.Expr("unique_users + 1")).Error; err != nil {
						return err
					}
				}
			}
			accepted++
		}
		return nil
	})
	return accepted, err
}

func DeleteAppCenterData(appID int64) error {
	paths := make([]string, 0)
	err := model.DB.Transaction(func(tx *gorm.DB) error {
		var releases []model.AppCenterRelease
		if err := tx.Where("app_id = ?", appID).Find(&releases).Error; err != nil {
			return err
		}
		for _, r := range releases {
			var assets []model.AppCenterAsset
			if err := tx.Where("release_id = ?", r.ID).Find(&assets).Error; err != nil {
				return err
			}
			for _, a := range assets {
				paths = append(paths, a.StoragePath)
			}
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterUsageBucket{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterDownloadBucket{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterCustomEventBucket{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterEventReceipt{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterEventIPReceipt{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterUsageSession{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterAnnouncement{}).Error; err != nil {
			return err
		}
		if err := tx.Where("release_id IN (?)", tx.Model(&model.AppCenterRelease{}).Select("id").Where("app_id = ?", appID)).Delete(&model.AppCenterAsset{}).Error; err != nil {
			return err
		}
		if err := tx.Where("app_id = ?", appID).Delete(&model.AppCenterRelease{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.AppCenterApp{}, appID).Error
	})
	if err != nil {
		return err
	}
	for _, path := range paths {
		_ = os.Remove(filepath.Join(AppCenterStorageRoot, path))
	}
	return nil
}

func appCenterReleaseBefore(a, b model.AppCenterRelease) bool {
	av, _ := version.NewSemver(a.Version)
	bv, _ := version.NewSemver(b.Version)
	return av.GreaterThan(bv)
}
