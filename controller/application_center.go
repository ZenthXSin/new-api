package controller

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

type appCenterAppRequest struct {
	Name             string `json:"name"`
	Slug             string `json:"slug"`
	Description      string `json:"description"`
	Public           bool   `json:"public"`
	TelemetryEnabled bool   `json:"telemetry_enabled"`
}
type appCenterReleaseRequest struct {
	Version string `json:"version"`
	Channel string `json:"channel"`
	Notes   string `json:"notes"`
}
type appCenterAnnouncementRequest struct {
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	Channel    string     `json:"channel"`
	Platform   string     `json:"platform"`
	MinVersion string     `json:"min_version"`
	StartsAt   *time.Time `json:"starts_at"`
	EndsAt     *time.Time `json:"ends_at"`
	Pinned     bool       `json:"pinned"`
}

type appCenterEventTrendRow struct {
	BucketTs    int64  `json:"bucket_ts"`
	Name        string `json:"name"`
	Count       int64  `json:"count"`
	UniqueUsers int64  `json:"unique_users"`
}

func appCenterJSON(c *gin.Context, status int, data any) {
	c.JSON(status, gin.H{"success": status < 400, "data": data})
}
func appCenterError(c *gin.Context, status int) {
	c.Header("Cache-Control", "no-store")
	c.JSON(status, gin.H{"success": false, "message": "应用中心操作失败"})
}
func GetPublicAppCenterApps(c *gin.Context) {
	var apps []model.AppCenterApp
	if err := model.DB.Where("public = ?", true).Order("name ASC").Find(&apps).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	c.Header("Cache-Control", "public, max-age=60")
	appCenterJSON(c, 200, apps)
}
func GetPublicAppCenterApp(c *gin.Context) {
	a, err := model.FindAppCenterBySlug(c.Param("slug"))
	if err != nil {
		appCenterError(c, 404)
		return
	}
	c.Header("Cache-Control", "public, max-age=60")
	appCenterJSON(c, 200, a)
}
func publicApp(c *gin.Context) (*model.AppCenterApp, bool) {
	a, err := model.FindAppCenterBySlug(c.Param("slug"))
	if err != nil {
		appCenterError(c, 404)
		return nil, false
	}
	return a, true
}
func GetPublicAppCenterReleases(c *gin.Context) {
	a, ok := publicApp(c)
	if !ok {
		return
	}
	rows, err := service.ListAppCenterReleases(a.ID, true, c.Query("channel"))
	if err != nil {
		appCenterError(c, 500)
		return
	}
	c.Header("Cache-Control", "public, max-age=60")
	appCenterJSON(c, 200, rows)
}
func GetLatestPublicAppCenterRelease(c *gin.Context) {
	a, ok := publicApp(c)
	if !ok {
		return
	}
	r, err := service.LatestAppCenterRelease(a.ID, c.Query("channel"))
	if err != nil {
		appCenterError(c, 404)
		return
	}
	c.Header("Cache-Control", "public, max-age=60")
	appCenterJSON(c, 200, r)
}
func GetPublicAppCenterAnnouncements(c *gin.Context) {
	a, ok := publicApp(c)
	if !ok {
		return
	}
	rows, err := service.ListAppCenterAnnouncements(a.ID, true, c.Query("channel"), c.Query("platform"), c.Query("version"))
	if err != nil {
		appCenterError(c, 500)
		return
	}
	c.Header("Cache-Control", "public, max-age=60")
	appCenterJSON(c, 200, rows)
}
func GetPublicAppCenterAnnouncement(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	a, ok := publicApp(c)
	if !ok {
		return
	}
	rows, err := service.ListAppCenterAnnouncements(a.ID, true, "", "", "")
	if err != nil {
		appCenterError(c, 500)
		return
	}
	for _, v := range rows {
		if v.ID == id {
			c.Header("Cache-Control", "public, max-age=60")
			appCenterJSON(c, 200, v)
			return
		}
	}
	appCenterError(c, 404)
}
func DownloadAppCenterAsset(c *gin.Context) {
	a, ok := publicApp(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	asset, err := service.FindAppCenterAsset(a.ID, id)
	if err != nil {
		appCenterError(c, 404)
		return
	}
	f, err := service.AppCenterAssetFile(asset)
	if err != nil {
		appCenterError(c, 404)
		return
	}
	defer f.Close()
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.Header("ETag", `"`+asset.SHA256+`"`)
	c.Header("Last-Modified", asset.CreatedAt.UTC().Format(http.TimeFormat))
	c.Header("Accept-Ranges", "bytes")
	c.Header("Content-Disposition", "attachment; filename="+strconv.Quote(asset.Filename))
	http.ServeContent(c.Writer, c.Request, asset.Filename, asset.CreatedAt, f)
	if c.Request.Method == http.MethodGet {
		service.IncrementAppCenterDownload(asset)
	}
}
func GetAppCenterUpdate(c *gin.Context) {
	a, ok := publicApp(c)
	if !ok {
		return
	}
	r, err := service.LatestAppCenterRelease(a.ID, c.Query("channel"))
	announcements, announcementErr := service.ListAppCenterAnnouncements(a.ID, true, c.Query("channel"), c.Query("platform"), c.Query("version"))
	if announcementErr != nil {
		appCenterError(c, http.StatusBadRequest)
		return
	}
	if err != nil {
		appCenterJSON(c, 200, gin.H{"update_available": false, "release": nil, "assets": []any{}, "announcements": announcements})
		return
	}
	platform := strings.ToLower(strings.TrimSpace(c.Query("platform")))
	architecture := strings.ToLower(strings.TrimSpace(c.Query("arch")))
	assets := make([]model.AppCenterAsset, 0, len(r.Assets))
	for _, asset := range r.Assets {
		if platform != "" && asset.Platform != platform {
			continue
		}
		if architecture != "" && asset.Architecture != architecture {
			continue
		}
		assets = append(assets, asset)
	}
	filteredRelease := *r
	filteredRelease.Assets = assets
	appCenterJSON(c, 200, gin.H{"update_available": len(assets) > 0 && service.AppCenterUpdateAvailable(c.Query("version"), r.Version), "release": filteredRelease, "assets": assets, "announcements": announcements})
}

func CreateAppCenterApp(c *gin.Context) {
	var in appCenterAppRequest
	if common.DecodeJsonStrict(c.Request.Body, &in) != nil {
		appCenterError(c, 400)
		return
	}
	a, key, err := service.CreateAppCenterApp(in.Name, in.Slug, in.Description, in.Public, in.TelemetryEnabled)
	if err != nil {
		appCenterError(c, 400)
		return
	}
	c.Header("Cache-Control", "no-store")
	appCenterJSON(c, 201, gin.H{"app": a, "token": key})
}
func ListAppCenterApps(c *gin.Context) {
	var a []model.AppCenterApp
	if err := model.DB.Order("created_at DESC").Find(&a).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	appCenterJSON(c, 200, a)
}
func GetAppCenterApp(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var a model.AppCenterApp
	if model.DB.First(&a, id).Error != nil {
		appCenterError(c, 404)
		return
	}
	appCenterJSON(c, 200, a)
}
func UpdateAppCenterApp(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var in appCenterAppRequest
	if common.DecodeJsonStrict(c.Request.Body, &in) != nil {
		appCenterError(c, 400)
		return
	}
	if err := model.DB.Model(&model.AppCenterApp{}).Where("id = ?", id).Updates(map[string]interface{}{"name": strings.TrimSpace(in.Name), "description": in.Description, "public": in.Public, "telemetry_enabled": in.TelemetryEnabled}).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	GetAppCenterApp(c)
}
func DeleteAppCenterApp(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if err := service.DeleteAppCenterData(id); err != nil {
		appCenterError(c, 500)
		return
	}
	c.Status(204)
}
func RevealAppCenterTelemetryKey(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	key, err := service.RevealAppCenterKey(id)
	if err != nil {
		appCenterError(c, 404)
		return
	}
	c.Header("Cache-Control", "no-store")
	appCenterJSON(c, 200, gin.H{"token": key})
}
func RotateAppCenterTelemetryKey(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	key, err := service.RotateAppCenterKey(id)
	if err != nil {
		appCenterError(c, 500)
		return
	}
	c.Header("Cache-Control", "no-store")
	appCenterJSON(c, 200, gin.H{"token": key})
}
func CreateAppCenterRelease(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var in appCenterReleaseRequest
	if common.DecodeJsonStrict(c.Request.Body, &in) != nil {
		appCenterError(c, 400)
		return
	}
	r, err := service.CreateAppCenterRelease(id, service.AppCenterReleaseInput{Version: in.Version, Channel: in.Channel, Notes: in.Notes})
	if err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 201, r)
}
func ListManagedAppCenterReleases(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	r, err := service.ListAppCenterReleases(id, false, "")
	if err != nil {
		appCenterError(c, 500)
		return
	}
	appCenterJSON(c, 200, r)
}
func UpdateAppCenterRelease(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	rid, _ := strconv.ParseInt(c.Param("release_id"), 10, 64)
	var in appCenterReleaseRequest
	if common.DecodeJsonStrict(c.Request.Body, &in) != nil {
		appCenterError(c, 400)
		return
	}
	r, err := service.UpdateAppCenterRelease(appID, rid, service.AppCenterReleaseInput{Version: in.Version, Channel: in.Channel, Notes: in.Notes})
	if err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 200, r)
}
func PublishAppCenterRelease(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	rid, _ := strconv.ParseInt(c.Param("release_id"), 10, 64)
	r, err := service.PublishAppCenterRelease(appID, rid)
	if err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 200, r)
}
func ListAppCenterServerFiles(c *gin.Context) {
	path := strings.TrimSpace(c.Query("path"))
	files, err := service.ListAppCenterServerDir(path)
	if err != nil {
		if errors.Is(err, service.ErrAppCenterInvalid) {
			appCenterError(c, http.StatusBadRequest)
			return
		}
		if errors.Is(err, service.ErrAppCenterNotFound) {
			appCenterError(c, http.StatusNotFound)
			return
		}
		appCenterError(c, http.StatusInternalServerError)
		return
	}
	appCenterJSON(c, http.StatusOK, files)
}

func UploadAppCenterAsset(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	rid, _ := strconv.ParseInt(c.Param("release_id"), 10, 64)
	platform := c.PostForm("platform")
	architecture := c.PostForm("architecture")
	var (
		src         io.Reader
		filename    string
		contentType string
		sourceName  string
	)
	serverFile := strings.TrimSpace(c.PostForm("server_file"))
	if serverFile != "" {
		f, err := service.OpenAppCenterServerFile(serverFile)
		if err != nil {
			if errors.Is(err, service.ErrAppCenterInvalid) {
				appCenterError(c, http.StatusBadRequest)
				return
			}
			appCenterError(c, http.StatusNotFound)
			return
		}
		defer f.Close()
		src = f
		filename = filepath.Base(serverFile)
		contentType = mime.TypeByExtension(filepath.Ext(filename))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		sourceName = serverFile
	} else {
		file, err := c.FormFile("file")
		if err != nil {
			common.SysError(fmt.Sprintf("app-center asset form failed: app_id=%d release_id=%d err=%v", appID, rid, err))
			appCenterError(c, 400)
			return
		}
		fileSrc, err := file.Open()
		if err != nil {
			common.SysError(fmt.Sprintf("app-center asset open failed: app_id=%d release_id=%d filename=%q err=%v", appID, rid, file.Filename, err))
			appCenterError(c, 400)
			return
		}
		defer fileSrc.Close()
		src = fileSrc
		filename = file.Filename
		contentType = file.Header.Get("Content-Type")
		sourceName = filename
	}
	a, err := service.UploadAppCenterAsset(appID, rid, platform, architecture, filename, contentType, src)
	if err != nil {
		common.SysError(fmt.Sprintf("app-center asset upload failed: app_id=%d release_id=%d platform=%q architecture=%q source=%q err=%v", appID, rid, platform, architecture, sourceName, err))
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 201, a)
}

func DeleteAppCenterAsset(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	releaseID, _ := strconv.ParseInt(c.Param("release_id"), 10, 64)
	assetID, _ := strconv.ParseInt(c.Param("asset_id"), 10, 64)
	if err := service.DeleteAppCenterAsset(appID, releaseID, assetID); err != nil {
		appCenterError(c, http.StatusBadRequest)
		return
	}
	c.Status(http.StatusNoContent)
}
func CreateAppCenterAnnouncement(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var in appCenterAnnouncementRequest
	if common.DecodeJsonStrict(c.Request.Body, &in) != nil {
		appCenterError(c, 400)
		return
	}
	a, err := service.CreateAppCenterAnnouncement(id, service.AppCenterAnnouncementInput{Title: in.Title, Body: in.Body, Channel: in.Channel, Platform: in.Platform, MinVersion: in.MinVersion, StartsAt: in.StartsAt, EndsAt: in.EndsAt, Pinned: in.Pinned})
	if err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 201, a)
}
func ListManagedAppCenterAnnouncements(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	a, err := service.ListAppCenterAnnouncements(id, false, "", "", "")
	if err != nil {
		appCenterError(c, 500)
		return
	}
	appCenterJSON(c, 200, a)
}

func UpdateAppCenterAnnouncement(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	announcementID, _ := strconv.ParseInt(c.Param("announcement_id"), 10, 64)
	var in appCenterAnnouncementRequest
	if common.DecodeJsonStrict(c.Request.Body, &in) != nil {
		appCenterError(c, http.StatusBadRequest)
		return
	}
	announcement, err := service.UpdateAppCenterAnnouncement(appID, announcementID, service.AppCenterAnnouncementInput{Title: in.Title, Body: in.Body, Channel: in.Channel, Platform: in.Platform, MinVersion: in.MinVersion, StartsAt: in.StartsAt, EndsAt: in.EndsAt, Pinned: in.Pinned})
	if err != nil {
		appCenterError(c, http.StatusBadRequest)
		return
	}
	appCenterJSON(c, http.StatusOK, announcement)
}

func DeleteAppCenterAnnouncement(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	announcementID, _ := strconv.ParseInt(c.Param("announcement_id"), 10, 64)
	result := model.DB.Where("id = ? AND app_id = ? AND status = ?", announcementID, appID, model.AppCenterReleaseDraft).Delete(&model.AppCenterAnnouncement{})
	if result.Error != nil || result.RowsAffected == 0 {
		appCenterError(c, http.StatusBadRequest)
		return
	}
	c.Status(http.StatusNoContent)
}
func PublishAppCenterAnnouncement(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	aid, _ := strconv.ParseInt(c.Param("announcement_id"), 10, 64)
	a, err := service.PublishAppCenterAnnouncement(id, aid, false)
	if err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 200, a)
}
func ArchiveAppCenterAnnouncement(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	aid, _ := strconv.ParseInt(c.Param("announcement_id"), 10, 64)
	a, err := service.PublishAppCenterAnnouncement(id, aid, true)
	if err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 200, a)
}
func IngestAppCenterUsage(c *gin.Context) {
	body, _ := io.ReadAll(io.LimitReader(c.Request.Body, 1<<20))
	a, err := service.VerifyAppCenterBearer(c.ClientIP(), c.GetHeader("Authorization"))
	if err != nil {
		if errors.Is(err, service.ErrTelemetryRateLimited) {
			appCenterError(c, http.StatusTooManyRequests)
			return
		}
		appCenterError(c, 401)
		return
	}
	var in service.AppCenterUsageInput
	if common.DecodeJsonStrict(bytes.NewReader(body), &in) != nil {
		appCenterError(c, 400)
		return
	}
	elapsed, err := service.RecordAppCenterUsage(a, in, c.ClientIP())
	if err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 202, gin.H{"accepted": true, "online_seconds": elapsed})
}
func IngestAppCenterEvents(c *gin.Context) {
	body, _ := io.ReadAll(io.LimitReader(c.Request.Body, 2<<20))
	a, err := service.VerifyAppCenterBearer(c.ClientIP(), c.GetHeader("Authorization"))
	if err != nil {
		if errors.Is(err, service.ErrTelemetryRateLimited) {
			appCenterError(c, http.StatusTooManyRequests)
			return
		}
		appCenterError(c, 401)
		return
	}
	var in struct {
		Events []service.AppCenterEvent `json:"events"`
	}
	if common.DecodeJsonStrict(bytes.NewReader(body), &in) != nil {
		appCenterError(c, 400)
		return
	}
	n, err := service.RecordAppCenterEvents(a, in.Events, c.ClientIP())
	if err != nil {
		if errors.Is(err, service.ErrTelemetryRateLimited) {
			appCenterError(c, http.StatusTooManyRequests)
			return
		}
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 202, gin.H{"accepted": n})
}
func IngestAppCenterCustomMessage(c *gin.Context) {
	body, _ := io.ReadAll(io.LimitReader(c.Request.Body, 1<<20))
	a, err := service.VerifyAppCenterBearer(c.ClientIP(), c.GetHeader("Authorization"))
	if err != nil {
		if errors.Is(err, service.ErrTelemetryRateLimited) {
			appCenterError(c, http.StatusTooManyRequests)
			return
		}
		appCenterError(c, 401)
		return
	}
	var in service.AppCenterCustomMessageInput
	if common.DecodeJsonStrict(bytes.NewReader(body), &in) != nil {
		appCenterError(c, 400)
		return
	}
	if err := service.RecordAppCenterCustomMessage(a, in, c.ClientIP()); err != nil {
		appCenterError(c, 400)
		return
	}
	appCenterJSON(c, 202, gin.H{"accepted": true})
}
func ListAppCenterCustomMessages(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	page := 1
	if raw := c.Query("page"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 {
			page = parsed
		}
	}
	size := 50
	if raw := c.Query("size"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 {
			size = parsed
		}
	}
	if size > 200 {
		size = 200
	}
	items, total, err := service.ListAppCenterCustomMessages(appID, page, size)
	if err != nil {
		appCenterError(c, http.StatusInternalServerError)
		return
	}
	appCenterJSON(c, http.StatusOK, gin.H{"items": items, "total": total, "page": page, "size": size})
}
func ClearAppCenterCustomMessages(c *gin.Context) {
	appID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if _, err := service.ClearAppCenterCustomMessages(appID); err != nil {
		appCenterError(c, http.StatusInternalServerError)
		return
	}
	c.Status(http.StatusNoContent)
}
func GetAppCenterUsageDashboard(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	hours := 720
	if raw := c.Query("hours"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 720 {
			hours = parsed
		}
	}
	var rows []model.AppCenterUsageBucket
	if err := model.DB.Where("app_id = ? AND bucket_ts >= ?", id, time.Now().Add(-time.Duration(hours)*time.Hour).Unix()).Order("bucket_ts ASC").Find(&rows).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	var activeRows []struct {
		BucketTs     int64
		Version      string
		Platform     string
		Architecture string
		Users        int64
	}
	if err := model.DB.Table("app_center_usage_active_buckets").Select("bucket_ts, version, platform, architecture, COUNT(*) AS users").Where("app_id = ? AND bucket_ts >= ?", id, time.Now().Add(-time.Duration(hours)*time.Hour).Unix()).Group("bucket_ts, version, platform, architecture").Scan(&activeRows).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	activeByKey := make(map[string]int64, len(activeRows))
	for _, row := range activeRows {
		key := fmt.Sprintf("%d|%s|%s|%s", row.BucketTs, row.Version, row.Platform, row.Architecture)
		activeByKey[key] = row.Users
	}
	for i := range rows {
		key := fmt.Sprintf("%d|%s|%s|%s", rows[i].BucketTs, rows[i].Version, rows[i].Platform, rows[i].Architecture)
		rows[i].ActiveUsers = activeByKey[key]
	}
	appCenterJSON(c, 200, rows)
}

// GetAppCenterDownloads returns the raw hourly download buckets of an app,
// covering the last N complete hourly buckets including the current one.
func GetAppCenterDownloads(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	hours := 720
	if raw := c.Query("hours"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 720 {
			hours = parsed
		}
	}
	now := time.Now().UTC()
	cutoff := now.Unix()/3600*3600 - int64(hours-1)*3600
	var rows []model.AppCenterDownloadBucket
	if err := model.DB.Where("app_id = ? AND bucket_ts >= ?", id, cutoff).Order("bucket_ts ASC").Find(&rows).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	appCenterJSON(c, 200, rows)
}

func GetAppCenterUsageRegionsDashboard(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	hours := 720
	if raw := c.Query("hours"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 720 {
			hours = parsed
		}
	}
	var rows []struct {
		Country     string `json:"country"`
		Region      string `json:"region"`
		City        string `json:"city"`
		UniqueUsers int64  `json:"unique_users"`
	}
	if err := model.DB.Model(&model.AppCenterUsageSession{}).
		Select("country, region, city, COUNT(DISTINCT installation_hash) AS unique_users").
		Where("app_id = ? AND last_seen_at >= ?", id, time.Now().Add(-time.Duration(hours)*time.Hour)).
		Group("country, region, city").Order("unique_users DESC").Find(&rows).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	appCenterJSON(c, 200, rows)
}
func GetAppCenterEventsDashboard(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	hours := 720
	if raw := c.Query("hours"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 720 {
			hours = parsed
		}
	}
	var rows []model.AppCenterCustomEventBucket
	if err := model.DB.Where("app_id = ? AND bucket_ts >= ?", id, time.Now().Add(-time.Duration(hours)*time.Hour).Unix()).Order("bucket_ts ASC").Find(&rows).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	appCenterJSON(c, 200, rows)
}

// GetAppCenterEventTrendDashboard returns hourly event counts and distinct
// source-IP users. The existing /events endpoint remains unchanged for
// clients that only need the raw event buckets.
func GetAppCenterEventTrendDashboard(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	hours := 720
	if raw := c.Query("hours"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 720 {
			hours = parsed
		}
	}
	now := time.Now().UTC()
	cutoff := now.Unix()/3600*3600 - int64(hours-1)*3600

	var buckets []model.AppCenterCustomEventBucket
	if err := model.DB.Where("app_id = ? AND bucket_ts >= ?", id, cutoff).Find(&buckets).Error; err != nil {
		appCenterError(c, 500)
		return
	}

	trend := make(map[int64]map[string]*appCenterEventTrendRow)
	for _, bucket := range buckets {
		byName := trend[bucket.BucketTs]
		if byName == nil {
			byName = make(map[string]*appCenterEventTrendRow)
			trend[bucket.BucketTs] = byName
		}
		row := byName[bucket.Name]
		if row == nil {
			row = &appCenterEventTrendRow{BucketTs: bucket.BucketTs, Name: bucket.Name}
			byName[bucket.Name] = row
		}
		row.Count += bucket.Count
	}

	var uniqueRows []struct {
		BucketTs    int64  `json:"bucket_ts"`
		Name        string `json:"name"`
		UniqueUsers int64  `json:"unique_users"`
	}
	if err := model.DB.Model(&model.AppCenterEventIPReceipt{}).
		Select("bucket_ts, name, COUNT(DISTINCT CASE WHEN source_ip <> '' THEN source_ip END) AS unique_users").
		Where("app_id = ? AND bucket_ts >= ? AND expires_at >= ?", id, cutoff, now).
		Group("bucket_ts, name").Find(&uniqueRows).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	for _, uniqueRow := range uniqueRows {
		byName := trend[uniqueRow.BucketTs]
		if byName == nil {
			byName = make(map[string]*appCenterEventTrendRow)
			trend[uniqueRow.BucketTs] = byName
		}
		row := byName[uniqueRow.Name]
		if row == nil {
			row = &appCenterEventTrendRow{BucketTs: uniqueRow.BucketTs, Name: uniqueRow.Name}
			byName[uniqueRow.Name] = row
		}
		row.UniqueUsers = uniqueRow.UniqueUsers
	}

	rows := make([]appCenterEventTrendRow, 0)
	for _, byName := range trend {
		for _, row := range byName {
			rows = append(rows, *row)
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].BucketTs == rows[j].BucketTs {
			return rows[i].Name < rows[j].Name
		}
		return rows[i].BucketTs < rows[j].BucketTs
	})
	appCenterJSON(c, 200, rows)
}

func GetAppCenterEventRegionsDashboard(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	hours := 720
	if raw := c.Query("hours"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 720 {
			hours = parsed
		}
	}
	now := time.Now().UTC()
	cutoff := now.Unix()/3600*3600 - int64(hours-1)*3600
	var rows []struct {
		Country     string `json:"country"`
		Region      string `json:"region"`
		City        string `json:"city"`
		UniqueUsers int64  `json:"unique_users"`
	}
	if err := model.DB.Model(&model.AppCenterEventIPReceipt{}).
		Select("country, region, city, COUNT(DISTINCT CASE WHEN source_ip <> '' THEN source_ip END) AS unique_users").
		Where("app_id = ? AND bucket_ts >= ? AND expires_at >= ?", id, cutoff, now).
		Group("country, region, city").
		Order("unique_users DESC").Find(&rows).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	var events []struct {
		Name        string `json:"name"`
		UniqueUsers int64  `json:"unique_users"`
	}
	if err := model.DB.Model(&model.AppCenterEventIPReceipt{}).
		Select("name, COUNT(DISTINCT CASE WHEN source_ip <> '' THEN source_ip END) AS unique_users").
		Where("app_id = ? AND bucket_ts >= ? AND expires_at >= ?", id, cutoff, now).
		Group("name").Order("unique_users DESC").Find(&events).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	appCenterJSON(c, 200, gin.H{"regions": rows, "events": events})
}
func ResetAppCenterTelemetry(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if err := model.DB.Where("app_id = ?", id).Delete(&model.AppCenterUsageBucket{}).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	if err := model.DB.Where("app_id = ?", id).Delete(&model.AppCenterCustomEventBucket{}).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	if err := model.DB.Where("app_id = ?", id).Delete(&model.AppCenterEventIPReceipt{}).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	if err := model.DB.Where("app_id = ?", id).Delete(&model.AppCenterEventReceipt{}).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	if err := model.DB.Where("app_id = ?", id).Delete(&model.AppCenterCustomMessage{}).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	if err := model.DB.Where("app_id = ?", id).Delete(&model.AppCenterUsageSession{}).Error; err != nil {
		appCenterError(c, 500)
		return
	}
	c.Status(204)
}
