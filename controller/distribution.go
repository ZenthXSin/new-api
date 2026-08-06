package controller

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type distributionReleaseRequest struct {
	Version string `json:"version"`
	Channel string `json:"channel"`
	Notes   string `json:"notes"`
}
type distributionAnnouncementRequest struct {
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	StartsAt   *time.Time `json:"starts_at,omitempty"`
	EndsAt     *time.Time `json:"ends_at,omitempty"`
	Pinned     bool       `json:"pinned"`
	Channel    string     `json:"channel"`
	Platform   string     `json:"platform"`
	MinVersion string     `json:"min_version"`
}

type distributionDownloadResponseWriter struct {
	gin.ResponseWriter
}

func (writer *distributionDownloadResponseWriter) WriteHeader(status int) {
	if status >= http.StatusBadRequest {
		writer.Header().Set("Cache-Control", "no-store")
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *distributionDownloadResponseWriter) Write(data []byte) (int, error) {
	if writer.Status() >= http.StatusBadRequest {
		writer.Header().Set("Cache-Control", "no-store")
	}
	return writer.ResponseWriter.Write(data)
}

func (writer *distributionDownloadResponseWriter) WriteString(value string) (int, error) {
	if writer.Status() >= http.StatusBadRequest {
		writer.Header().Set("Cache-Control", "no-store")
	}
	return writer.ResponseWriter.WriteString(value)
}

func distributionPublicHeaders(c *gin.Context) { c.Header("Cache-Control", "public, max-age=60") }
func distributionNoStore(c *gin.Context)       { c.Header("Cache-Control", "no-store") }

func GetDistributionApp(c *gin.Context) {
	app, err := service.PublicDistributionApp(c.Param("slug"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	distributionPublicHeaders(c)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"id": app.ID, "slug": app.Slug, "name": app.Name}})
}
func GetDistributionReleases(c *gin.Context) {
	app, err := service.PublicDistributionApp(c.Param("slug"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	items, err := service.PublicDistributionReleases(app.ID, c.Query("channel"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	distributionPublicHeaders(c)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items})
}
func GetLatestDistributionRelease(c *gin.Context) {
	app, err := service.PublicDistributionApp(c.Param("slug"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	item, err := service.LatestPublicDistributionRelease(app.ID, c.Query("channel"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	distributionPublicHeaders(c)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": item})
}
func GetManagedDistributionReleases(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	items, err := service.ManageDistributionReleases(appID)
	if err != nil {
		distributionServerError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items})
}
func GetDistributionAnnouncements(c *gin.Context) {
	app, err := service.PublicDistributionApp(c.Param("slug"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	items, err := service.PublicDistributionAnnouncements(app.ID, c.Query("channel"), c.Query("platform"), c.Query("version"))
	if errors.Is(err, service.ErrDistributionInvalid) {
		distributionBadRequest(c)
		return
	}
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	distributionPublicHeaders(c)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items})
}
func GetDistributionAnnouncement(c *gin.Context) {
	app, err := service.PublicDistributionApp(c.Param("slug"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		distributionNotFound(c)
		return
	}
	item, err := service.PublicDistributionAnnouncement(app.ID, id)
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	distributionPublicHeaders(c)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": item})
}
func GetManagedDistributionAnnouncements(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	items, err := service.ManageDistributionAnnouncements(appID)
	if err != nil {
		distributionServerError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items})
}

func CreateDistributionRelease(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	limitDistributionJSON(c)
	var request distributionReleaseRequest
	if !decodeDistributionJSON(c, &request) {
		return
	}
	item, err := service.CreateDistributionRelease(appID, service.ReleaseInput{Version: request.Version, Channel: request.Channel, Notes: request.Notes})
	if err != nil {
		distributionWriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": item})
}
func UpdateDistributionRelease(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	limitDistributionJSON(c)
	id, err := distributionID(c)
	if err != nil {
		distributionBadRequest(c)
		return
	}
	var request distributionReleaseRequest
	if !decodeDistributionJSON(c, &request) {
		return
	}
	item, err := service.UpdateDistributionRelease(appID, id, service.ReleaseInput{Version: request.Version, Channel: request.Channel, Notes: request.Notes})
	if err != nil {
		distributionWriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": item})
}
func PublishDistributionRelease(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	id, err := distributionID(c)
	if err != nil {
		distributionBadRequest(c)
		return
	}
	item, err := service.PublishDistributionRelease(appID, id)
	if err != nil {
		distributionWriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": item})
}
func UploadDistributionAsset(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	id, err := distributionID(c)
	if err != nil {
		distributionBadRequest(c)
		return
	}
	if err := service.ValidateDistributionAssetUploadTarget(appID, id); err != nil {
		distributionWriteError(c, err)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, service.DistributionMaxAssetBytes+1024*1024)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			distributionPayloadTooLarge(c)
			return
		}
		distributionBadRequest(c)
		return
	}
	defer file.Close()
	item, err := service.UploadDistributionAsset(appID, id, c.PostForm("platform"), c.PostForm("architecture"), header.Filename, header.Header.Get("Content-Type"), file)
	if err != nil {
		distributionWriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": item})
}

func CreateDistributionAnnouncement(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	limitDistributionJSON(c)
	request, ok := decodeAnnouncement(c)
	if !ok {
		return
	}
	item, err := service.CreateDistributionAnnouncement(appID, service.AnnouncementInput{Title: request.Title, Body: request.Body, StartsAt: request.StartsAt, EndsAt: request.EndsAt, Pinned: request.Pinned, Channel: request.Channel, Platform: request.Platform, MinVersion: request.MinVersion})
	if err != nil {
		distributionWriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": item})
}
func UpdateDistributionAnnouncement(c *gin.Context) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	limitDistributionJSON(c)
	id, err := distributionID(c)
	if err != nil {
		distributionBadRequest(c)
		return
	}
	request, ok := decodeAnnouncement(c)
	if !ok {
		return
	}
	item, err := service.UpdateDistributionAnnouncement(appID, id, service.AnnouncementInput{Title: request.Title, Body: request.Body, StartsAt: request.StartsAt, EndsAt: request.EndsAt, Pinned: request.Pinned, Channel: request.Channel, Platform: request.Platform, MinVersion: request.MinVersion})
	if err != nil {
		distributionWriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": item})
}
func PublishDistributionAnnouncement(c *gin.Context) {
	updateDistributionAnnouncementStatus(c, model.DistributionAnnouncementDraft, model.DistributionAnnouncementPublished)
}
func ArchiveDistributionAnnouncement(c *gin.Context) {
	updateDistributionAnnouncementStatus(c, model.DistributionAnnouncementPublished, model.DistributionAnnouncementArchived)
}
func updateDistributionAnnouncementStatus(c *gin.Context, from, target string) {
	appID, ok := distributionBearerApp(c)
	if !ok {
		return
	}
	id, err := distributionID(c)
	if err != nil {
		distributionBadRequest(c)
		return
	}
	item, err := service.SetDistributionAnnouncementStatus(appID, id, from, target)
	if err != nil {
		distributionWriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": item})
}

func DownloadDistributionAsset(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		distributionNotFound(c)
		return
	}
	app, err := service.PublicDistributionApp(c.Param("slug"))
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	asset, err := service.FindPublicDistributionAsset(app.ID, id)
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	file, err := service.AssetFile(asset)
	if err != nil {
		distributionPublicError(c, err)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		distributionServerError(c)
		return
	}
	etag := `"` + asset.SHA256 + `"`
	c.Header("ETag", etag)
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.Header("Last-Modified", stat.ModTime().UTC().Format(http.TimeFormat))
	name := strings.ReplaceAll(asset.Filename, `"`, "")
	c.Header("Content-Disposition", `attachment; filename="`+name+`"`)
	contentType := asset.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Header("Content-Type", contentType)
	responseWriter := &distributionDownloadResponseWriter{ResponseWriter: c.Writer}
	http.ServeContent(responseWriter, c.Request, asset.Filename, stat.ModTime(), file)
	if c.Request.Method == http.MethodGet && c.Writer.Status() == http.StatusOK && int64(c.Writer.Size()) == stat.Size() {
		service.IncrementDistributionDownload(asset.ID)
	}
}

func distributionBearerApp(c *gin.Context) (int64, bool) {
	distributionNoStore(c)
	key, err := service.VerifyAppBearer(c.ClientIP(), c.GetHeader("Authorization"))
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, service.ErrTelemetryRateLimited) {
			status = http.StatusTooManyRequests
		}
		c.JSON(status, gin.H{"success": false, "message": "unauthorized"})
		return 0, false
	}
	if slug := c.Param("slug"); slug != "" {
		app, appErr := model.FindTelemetryAppBySlug(slug)
		if appErr != nil || app.ID != key.AppID {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "unauthorized"})
			return 0, false
		}
	}
	return key.AppID, true
}

func limitDistributionJSON(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, common.GetAnonymousRequestBodyLimitBytes())
}
func distributionID(c *gin.Context) (int64, error) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid id")
	}
	return id, nil
}
func decodeAnnouncement(c *gin.Context) (distributionAnnouncementRequest, bool) {
	var request distributionAnnouncementRequest
	return request, decodeDistributionJSON(c, &request)
}
func decodeDistributionJSON(c *gin.Context, target any) bool {
	if err := common.DecodeJsonStrict(c.Request.Body, target); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			distributionPayloadTooLarge(c)
			return false
		}
		distributionBadRequest(c)
		return false
	}
	return true
}
func distributionWriteError(c *gin.Context, err error) {
	distributionNoStore(c)
	status := http.StatusInternalServerError
	if errors.Is(err, service.ErrDistributionInvalid) {
		status = http.StatusBadRequest
	}
	if errors.Is(err, service.ErrDistributionConflict) {
		status = http.StatusConflict
	}
	if errors.Is(err, service.ErrDistributionNotFound) {
		status = http.StatusNotFound
	}
	if errors.Is(err, service.ErrDistributionPayloadTooLarge) {
		status = http.StatusRequestEntityTooLarge
	}
	if status >= 500 {
		c.JSON(status, gin.H{"success": false, "message": "distribution operation failed"})
	} else {
		c.JSON(status, gin.H{"success": false, "message": "invalid distribution request"})
	}
}
func distributionBadRequest(c *gin.Context) {
	distributionNoStore(c)
	c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid distribution request"})
}
func distributionPayloadTooLarge(c *gin.Context) {
	distributionNoStore(c)
	c.JSON(http.StatusRequestEntityTooLarge, gin.H{"success": false, "message": "distribution request too large"})
}
func distributionNotFound(c *gin.Context) {
	distributionNoStore(c)
	c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "not found"})
}
func distributionServerError(c *gin.Context) {
	distributionNoStore(c)
	c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "distribution operation failed"})
}
func distributionPublicError(c *gin.Context, err error) {
	if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, service.ErrDistributionNotFound) {
		distributionNotFound(c)
		return
	}
	distributionServerError(c)
}
