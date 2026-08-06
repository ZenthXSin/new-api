package controller

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type unreadDistributionUploadBody struct {
	reads int
}

func (body *unreadDistributionUploadBody) Read([]byte) (int, error) {
	body.reads++
	return 0, errors.New("upload body must not be read")
}

func (body *unreadDistributionUploadBody) Close() error {
	return nil
}

func TestDistributionWriteRequiresAppBearerAndLimitsJSON(t *testing.T) {
	previousDB, previousSecret, previousLimit := model.DB, common.CryptoSecret, constant.AnonymousRequestBodyLimitKB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TelemetryProject{}, &model.TelemetryApp{}, &model.TelemetryWriteKey{}, &model.DistributionRelease{}))
	model.DB, common.CryptoSecret = db, "controller-distribution-secret"
	constant.AnonymousRequestBodyLimitKB = 512
	t.Cleanup(func() {
		model.DB, common.CryptoSecret, constant.AnonymousRequestBodyLimitKB = previousDB, previousSecret, previousLimit
	})
	project, err := model.CreateTelemetryProject("controller-project")
	require.NoError(t, err)
	app, err := model.CreateTelemetryApp(project.ID, "controller-app")
	require.NoError(t, err)
	key, secret, err := service.CreateTelemetryWriteKey(app.ID, "controller-key")
	require.NoError(t, err)

	legacy := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(legacy)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/distribution/apps/controller-app/releases", bytes.NewBufferString(`{"version":"1.0.0","channel":"stable"}`))
	ctx.Request.Header.Set("X-Telemetry-Key-Id", key.KeyID)
	ctx.Request.Header.Set("X-Telemetry-Secret", secret)
	CreateDistributionRelease(ctx)
	assert.Equal(t, http.StatusUnauthorized, legacy.Code)

	valid := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(valid)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/distribution/apps/controller-app/releases", bytes.NewBufferString(`{"version":"1.0.0","channel":"stable"}`))
	ctx.Request.Header.Set("Authorization", "Bearer app_v1."+key.KeyID+"."+secret)
	CreateDistributionRelease(ctx)
	assert.Equal(t, http.StatusCreated, valid.Code)

	duplicate := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(duplicate)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/distribution/apps/controller-app/releases", bytes.NewBufferString(`{"version":"1.0.0","channel":"stable"}`))
	ctx.Request.Header.Set("Authorization", "Bearer app_v1."+key.KeyID+"."+secret)
	CreateDistributionRelease(ctx)
	assert.Equal(t, http.StatusConflict, duplicate.Code)

	invalid := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(invalid)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/distribution/apps/controller-app/releases", bytes.NewBufferString(`{"version":"1.0.2","channel":"`+strings.Repeat("a", 33)+`"}`))
	ctx.Request.Header.Set("Authorization", "Bearer app_v1."+key.KeyID+"."+secret)
	CreateDistributionRelease(ctx)
	assert.Equal(t, http.StatusBadRequest, invalid.Code)

	constant.AnonymousRequestBodyLimitKB = 0
	tooLarge := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(tooLarge)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/distribution/apps/controller-app/releases", bytes.NewBufferString(`{"version":"1.0.1","channel":"stable"}`))
	ctx.Request.Header.Set("Authorization", "Bearer app_v1."+key.KeyID+"."+secret)
	CreateDistributionRelease(ctx)
	assert.Equal(t, http.StatusRequestEntityTooLarge, tooLarge.Code)
}

func TestDownloadDistributionAssetScopesSlugAndSupportsRange(t *testing.T) {
	previousDB, previousRoot := model.DB, service.DistributionStorageRoot
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TelemetryProject{}, &model.TelemetryApp{}, &model.DistributionRelease{}, &model.DistributionAsset{}))
	model.DB, service.DistributionStorageRoot = db, t.TempDir()
	t.Cleanup(func() { model.DB, service.DistributionStorageRoot = previousDB, previousRoot })
	project, err := model.CreateTelemetryProject("download-project")
	require.NoError(t, err)
	app, err := model.CreateTelemetryApp(project.ID, "download-app")
	require.NoError(t, err)
	otherProject, err := model.CreateTelemetryProject("other-download-project")
	require.NoError(t, err)
	other, err := model.CreateTelemetryApp(otherProject.ID, "other-download-app")
	require.NoError(t, err)
	now := time.Now().UTC()
	release := model.DistributionRelease{AppID: app.ID, Version: "1.0.0", Channel: "stable", Status: model.DistributionReleasePublished, PublishedAt: &now}
	require.NoError(t, db.Create(&release).Error)
	storagePath := "opaque-asset"
	require.NoError(t, os.WriteFile(filepath.Join(service.DistributionStorageRoot, storagePath), []byte("payload"), 0600))
	asset := model.DistributionAsset{ReleaseID: release.ID, Platform: "linux", Architecture: "amd64", Filename: "app.bin", ContentType: "application/octet-stream", Size: 7, SHA256: "abcdef", StoragePath: storagePath}
	require.NoError(t, db.Create(&asset).Error)

	wrong := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(wrong)
	ctx.Params = gin.Params{{Key: "slug", Value: other.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/other-download-app/assets/1/download", nil)
	DownloadDistributionAsset(ctx)
	assert.Equal(t, http.StatusNotFound, wrong.Code)
	assert.Equal(t, "no-store", wrong.Header().Get("Cache-Control"))

	ranged := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(ranged)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/download-app/assets/1/download", nil)
	ctx.Request.Header.Set("Range", "bytes=0-2")
	DownloadDistributionAsset(ctx)
	assert.Equal(t, http.StatusPartialContent, ranged.Code)
	assert.Equal(t, "pay", ranged.Body.String())
	assert.Equal(t, `"abcdef"`, ranged.Header().Get("ETag"))
	assert.Equal(t, "public, max-age=31536000, immutable", ranged.Header().Get("Cache-Control"))

	matchingETag := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(matchingETag)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/download-app/assets/1/download", nil)
	ctx.Request.Header.Set("Range", "bytes=0-2")
	ctx.Request.Header.Set("If-Range", `"abcdef"`)
	DownloadDistributionAsset(ctx)
	assert.Equal(t, http.StatusPartialContent, matchingETag.Code)
	assert.Equal(t, "pay", matchingETag.Body.String())

	matchingDate := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(matchingDate)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/download-app/assets/1/download", nil)
	ctx.Request.Header.Set("Range", "bytes=0-2")
	ctx.Request.Header.Set("If-Range", ranged.Header().Get("Last-Modified"))
	DownloadDistributionAsset(ctx)
	assert.Equal(t, http.StatusPartialContent, matchingDate.Code)
	assert.Equal(t, "pay", matchingDate.Body.String())

	head := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(head)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodHead, "/api/distribution/apps/download-app/assets/1/download", nil)
	DownloadDistributionAsset(ctx)
	assert.Equal(t, http.StatusOK, head.Code)
	assert.Empty(t, head.Body.String())

	notModified := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(notModified)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/download-app/assets/1/download", nil)
	ctx.Request.Header.Set("If-None-Match", `"abcdef"`)
	DownloadDistributionAsset(ctx)
	ctx.Writer.WriteHeaderNow()
	assert.Equal(t, http.StatusNotModified, notModified.Code)
	assert.Equal(t, "public, max-age=31536000, immutable", notModified.Header().Get("Cache-Control"))

	preconditionFailed := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(preconditionFailed)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/download-app/assets/1/download", nil)
	ctx.Request.Header.Set("If-Match", `"outdated"`)
	DownloadDistributionAsset(ctx)
	ctx.Writer.WriteHeaderNow()
	assert.Equal(t, http.StatusPreconditionFailed, preconditionFailed.Code)
	assert.Equal(t, "no-store", preconditionFailed.Header().Get("Cache-Control"))

	invalidRange := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(invalidRange)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/download-app/assets/1/download", nil)
	ctx.Request.Header.Set("Range", "bytes=99-100")
	DownloadDistributionAsset(ctx)
	assert.Equal(t, http.StatusRequestedRangeNotSatisfiable, invalidRange.Code)
	assert.Equal(t, "no-store", invalidRange.Header().Get("Cache-Control"))

	staleDate := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(staleDate)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/download-app/assets/1/download", nil)
	ctx.Request.Header.Set("Range", "bytes=0-2")
	ctx.Request.Header.Set("If-Range", time.Unix(0, 0).UTC().Format(http.TimeFormat))
	DownloadDistributionAsset(ctx)
	assert.Equal(t, http.StatusOK, staleDate.Code)
	assert.Equal(t, "payload", staleDate.Body.String())

	var updated model.DistributionAsset
	require.NoError(t, db.First(&updated, asset.ID).Error)
	assert.Equal(t, int64(1), updated.Downloads)
}

func TestPublicDistributionResponsesCacheOnlySuccessfulData(t *testing.T) {
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TelemetryProject{}, &model.TelemetryApp{}, &model.DistributionRelease{}, &model.DistributionAsset{}, &model.DistributionAnnouncement{}))
	model.DB = db
	t.Cleanup(func() { model.DB = previousDB })
	project, err := model.CreateTelemetryProject("public-cache-project")
	require.NoError(t, err)
	app, err := model.CreateTelemetryApp(project.ID, "public-cache-app")
	require.NoError(t, err)

	success := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(success)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/public-cache-app", nil)
	GetDistributionApp(ctx)
	assert.Equal(t, http.StatusOK, success.Code)
	assert.Equal(t, "public, max-age=60", success.Header().Get("Cache-Control"))

	missing := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(missing)
	ctx.Params = gin.Params{{Key: "slug", Value: "missing-app"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/missing-app", nil)
	GetDistributionApp(ctx)
	assert.Equal(t, http.StatusNotFound, missing.Code)
	assert.Equal(t, "no-store", missing.Header().Get("Cache-Control"))

	forcedResourceError := errors.New("forced distribution release query failure")
	const callbackName = "test:distribution-public-release-query-failure"
	callbackRegistered := true
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == "distribution_releases" {
			tx.AddError(forcedResourceError)
		}
	}))
	t.Cleanup(func() {
		if callbackRegistered {
			_ = db.Callback().Query().Remove(callbackName)
		}
	})
	resourceFailure := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(resourceFailure)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/public-cache-app/releases", nil)
	GetDistributionReleases(ctx)
	require.NoError(t, db.Callback().Query().Remove(callbackName))
	callbackRegistered = false
	assert.Equal(t, http.StatusInternalServerError, resourceFailure.Code)
	assert.Equal(t, "no-store", resourceFailure.Header().Get("Cache-Control"))
	assert.NotContains(t, resourceFailure.Body.String(), forcedResourceError.Error())

	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close())
	appFailure := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(appFailure)
	ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/distribution/apps/public-cache-app", nil)
	GetDistributionApp(ctx)
	assert.Equal(t, http.StatusInternalServerError, appFailure.Code)
	assert.Equal(t, "no-store", appFailure.Header().Get("Cache-Control"))
}

func TestUploadDistributionAssetInvalidTargetsReturnBeforeReadingMultipart(t *testing.T) {
	previousDB, previousSecret, previousRoot := model.DB, common.CryptoSecret, service.DistributionStorageRoot
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TelemetryProject{}, &model.TelemetryApp{}, &model.TelemetryWriteKey{}, &model.DistributionRelease{}, &model.DistributionAsset{}))
	model.DB, common.CryptoSecret, service.DistributionStorageRoot = db, "controller-distribution-secret", t.TempDir()
	t.Cleanup(func() {
		model.DB, common.CryptoSecret, service.DistributionStorageRoot = previousDB, previousSecret, previousRoot
	})
	project, err := model.CreateTelemetryProject("missing-release-project")
	require.NoError(t, err)
	app, err := model.CreateTelemetryApp(project.ID, "missing-release-app")
	require.NoError(t, err)
	key, secret, err := service.CreateTelemetryWriteKey(app.ID, "missing-release-key")
	require.NoError(t, err)

	otherProject, err := model.CreateTelemetryProject("other-upload-project")
	require.NoError(t, err)
	otherApp, err := model.CreateTelemetryApp(otherProject.ID, "other-upload-app")
	require.NoError(t, err)
	otherRelease, err := service.CreateDistributionRelease(otherApp.ID, service.ReleaseInput{Version: "1.0.0", Channel: "stable"})
	require.NoError(t, err)
	publishedRelease := model.DistributionRelease{AppID: app.ID, Version: "2.0.0", Channel: "stable", Status: model.DistributionReleasePublished}
	require.NoError(t, db.Create(&publishedRelease).Error)

	tests := []struct {
		name      string
		releaseID int64
		expected  int
	}{
		{name: "missing release", releaseID: 999, expected: http.StatusNotFound},
		{name: "release belongs to another app", releaseID: otherRelease.ID, expected: http.StatusNotFound},
		{name: "published release", releaseID: publishedRelease.ID, expected: http.StatusConflict},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			body := &unreadDistributionUploadBody{}
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Params = gin.Params{{Key: "slug", Value: app.Slug}, {Key: "id", Value: strconv.FormatInt(testCase.releaseID, 10)}}
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/distribution/apps/missing-release-app/releases/999/assets", body)
			ctx.Request.Header.Set("Authorization", "Bearer app_v1."+key.KeyID+"."+secret)
			ctx.Request.Header.Set("Content-Type", "multipart/form-data; boundary=never-read")
			UploadDistributionAsset(ctx)

			assert.Equal(t, testCase.expected, recorder.Code)
			assert.Zero(t, body.reads)
		})
	}
}

func TestDistributionPayloadTooLargeWriteError(t *testing.T) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)

	distributionWriteError(ctx, service.ErrDistributionPayloadTooLarge)

	assert.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code)
}
