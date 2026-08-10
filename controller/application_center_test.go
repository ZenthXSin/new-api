package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAppCenterPublicAndAdminRouteBoundaries(t *testing.T) {
	previousDB, previousSecret := model.DB, common.CryptoSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.AppCenterApp{}, &model.User{}))
	model.DB, common.CryptoSecret = db, "controller-app-center-secret"
	t.Cleanup(func() { model.DB, common.CryptoSecret = previousDB, previousSecret })
	_, _, err = service.CreateAppCenterApp("Public", "public-app", "", true, true)
	require.NoError(t, err)
	_, _, err = service.CreateAppCenterApp("Private", "private-app", "", false, true)
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/public/apps", GetPublicAppCenterApps)
	router.GET("/api/app-center/apps", middleware.AppCenterAuthScope(), middleware.UserAuth(), middleware.AppCenterAdmin(), ListAppCenterApps)
	public := httptest.NewRecorder()
	router.ServeHTTP(public, httptest.NewRequest(http.MethodGet, "/api/public/apps", nil))
	require.Equal(t, http.StatusOK, public.Code)
	assert.Contains(t, public.Body.String(), "public-app")
	assert.NotContains(t, public.Body.String(), "private-app")
	adminPAT := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/app-center/apps", nil)
	req.Header.Set("Authorization", "Bearer not-a-dashboard-session")
	router.ServeHTTP(adminPAT, req)
	assert.Equal(t, http.StatusUnauthorized, adminPAT.Code)
	appKey := httptest.NewRecorder()
	appKeyReq := httptest.NewRequest(http.MethodGet, "/api/app-center/apps", nil)
	appKeyReq.Header.Set("Authorization", "Bearer app_v2.fake.secret")
	router.ServeHTTP(appKey, appKeyReq)
	assert.Equal(t, http.StatusUnauthorized, appKey.Code)
	adminMissing := httptest.NewRecorder()
	router.ServeHTTP(adminMissing, httptest.NewRequest(http.MethodGet, "/api/app-center/apps", nil))
	assert.Equal(t, http.StatusUnauthorized, adminMissing.Code)
	adminSessionMissing := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(adminSessionMissing)
	ctx.Set("role", common.RoleAdminUser)
	middleware.AppCenterAdmin()(ctx)
	assert.False(t, ctx.IsAborted())
}

func TestAppCenterEventTrendDashboardDeduplicatesIPAndExpiresRows(t *testing.T) {
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.AppCenterApp{},
		&model.AppCenterCustomEventBucket{},
		&model.AppCenterEventIPReceipt{},
	))
	model.DB = db
	t.Cleanup(func() { model.DB = previousDB })

	app := &model.AppCenterApp{Name: "Trend", Slug: "trend", TelemetryEnabled: true}
	require.NoError(t, db.Create(app).Error)
	bucketTs := time.Now().UTC().Unix() / 3600 * 3600
	require.NoError(t, db.Create(&model.AppCenterCustomEventBucket{
		AppID: app.ID, BucketTs: bucketTs, Name: "opened", DimensionsHash: "d1", Count: 2,
	}).Error)
	require.NoError(t, db.Create(&model.AppCenterCustomEventBucket{
		AppID: app.ID, BucketTs: bucketTs, Name: "opened", DimensionsHash: "d2", Count: 3,
	}).Error)
	now := time.Now().UTC()
	require.NoError(t, db.Create(&model.AppCenterEventIPReceipt{
		AppID: app.ID, BucketTs: bucketTs, Name: "opened", DimensionsHash: "d1", SourceIP: "203.0.113.1", ExpiresAt: now.Add(time.Hour),
	}).Error)
	require.NoError(t, db.Create(&model.AppCenterEventIPReceipt{
		AppID: app.ID, BucketTs: bucketTs, Name: "opened", DimensionsHash: "d2", SourceIP: "203.0.113.1", ExpiresAt: now.Add(time.Hour),
	}).Error)
	require.NoError(t, db.Create(&model.AppCenterEventIPReceipt{
		AppID: app.ID, BucketTs: bucketTs, Name: "opened", DimensionsHash: "d1", SourceIP: "203.0.113.2", ExpiresAt: now.Add(time.Hour),
	}).Error)
	require.NoError(t, db.Create(&model.AppCenterEventIPReceipt{
		AppID: app.ID, BucketTs: bucketTs, Name: "opened", DimensionsHash: "d3", SourceIP: "203.0.113.3", ExpiresAt: now.Add(-time.Hour),
	}).Error)
	require.NoError(t, db.Create(&model.AppCenterEventIPReceipt{
		AppID: app.ID, BucketTs: bucketTs, Name: "opened", DimensionsHash: "d4", SourceIP: "", ExpiresAt: now.Add(time.Hour),
	}).Error)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: strconv.FormatInt(app.ID, 10)}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/app-center/apps/1/events/trend?hours=24", nil)
	GetAppCenterEventTrendDashboard(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Data []appCenterEventTrendRow `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.Len(t, response.Data, 1)
	assert.Equal(t, int64(5), response.Data[0].Count)
	assert.Equal(t, int64(2), response.Data[0].UniqueUsers)

	regionsRecorder := httptest.NewRecorder()
	regionsCtx, _ := gin.CreateTestContext(regionsRecorder)
	regionsCtx.Params = gin.Params{{Key: "id", Value: strconv.FormatInt(app.ID, 10)}}
	regionsCtx.Request = httptest.NewRequest(http.MethodGet, "/api/app-center/apps/1/events/regions?hours=24", nil)
	GetAppCenterEventRegionsDashboard(regionsCtx)
	require.Equal(t, http.StatusOK, regionsRecorder.Code)
	var regionsResponse struct {
		Data struct {
			Regions []struct {
				UniqueUsers int64 `json:"unique_users"`
			} `json:"regions"`
			Events []struct {
				Name        string `json:"name"`
				UniqueUsers int64  `json:"unique_users"`
			} `json:"events"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(regionsRecorder.Body.Bytes(), &regionsResponse))
	require.Len(t, regionsResponse.Data.Regions, 1)
	assert.Equal(t, int64(2), regionsResponse.Data.Regions[0].UniqueUsers)
	require.Len(t, regionsResponse.Data.Events, 1)
	assert.Equal(t, "opened", regionsResponse.Data.Events[0].Name)
	assert.Equal(t, int64(2), regionsResponse.Data.Events[0].UniqueUsers)
}

func TestGetAppCenterUsageDashboardMergesActiveUsers(t *testing.T) {
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.AppCenterApp{},
		&model.AppCenterUsageBucket{},
		&model.AppCenterUsageActiveBucket{},
	))
	model.DB = db
	t.Cleanup(func() { model.DB = previousDB })

	now := time.Now().UTC()
	current := now.Unix() / 3600 * 3600
	older := current - 3600
	key := func(bucketTs int64, hash string) *model.AppCenterUsageActiveBucket {
		return &model.AppCenterUsageActiveBucket{AppID: 1, BucketTs: bucketTs, InstallationHash: hash, Version: "1.0.0", Platform: "linux", Architecture: "amd64"}
	}
	require.NoError(t, db.Create(&model.AppCenterUsageBucket{AppID: 1, BucketTs: current, Version: "1.0.0", Platform: "linux", Architecture: "amd64", StartCount: 2, OnlineSeconds: 90}).Error)
	require.NoError(t, db.Create(&model.AppCenterUsageBucket{AppID: 1, BucketTs: older, Version: "1.0.0", Platform: "linux", Architecture: "amd64", StartCount: 1, OnlineSeconds: 45}).Error)
	require.NoError(t, db.Create(key(current, "h1")).Error)
	require.NoError(t, db.Create(key(current, "h2")).Error)
	require.NoError(t, db.Create(key(older, "h1")).Error)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: strconv.FormatInt(1, 10)}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/app-center/apps/1/usage?hours=24", nil)
	GetAppCenterUsageDashboard(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Data []model.AppCenterUsageBucket `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.Len(t, response.Data, 2)
	assert.Equal(t, older, response.Data[0].BucketTs)
	assert.Equal(t, int64(1), response.Data[0].ActiveUsers)
	assert.Equal(t, current, response.Data[1].BucketTs)
	assert.Equal(t, int64(2), response.Data[1].ActiveUsers)
	assert.Equal(t, int64(90), response.Data[1].OnlineSeconds)
}

func TestDownloadAppCenterAssetSetsContentDisposition(t *testing.T) {
	previousDB, previousSecret := model.DB, common.CryptoSecret
	previousRoot := service.AppCenterStorageRoot
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.AppCenterApp{}, &model.AppCenterRelease{}, &model.AppCenterAsset{}))
	model.DB, common.CryptoSecret = db, "controller-app-center-secret"
	root := t.TempDir()
	service.AppCenterStorageRoot = root
	t.Cleanup(func() {
		model.DB, common.CryptoSecret = previousDB, previousSecret
		service.AppCenterStorageRoot = previousRoot
	})

	app, _, err := service.CreateAppCenterApp("Download", "download-app", "", true, true)
	require.NoError(t, err)
	release, err := service.CreateAppCenterRelease(app.ID, service.AppCenterReleaseInput{Version: "1.0.0", Channel: "stable"})
	require.NoError(t, err)
	storagePath := "stored-file"
	require.NoError(t, os.WriteFile(filepath.Join(root, storagePath), []byte("payload"), 0o640))
	asset := &model.AppCenterAsset{ReleaseID: release.ID, Platform: "linux", Architecture: "amd64", Filename: "app-release-1.0.0.apk", ContentType: "application/octet-stream", Size: 7, SHA256: "x", StoragePath: storagePath}
	require.NoError(t, db.Create(asset).Error)
	_, err = service.PublishAppCenterRelease(app.ID, release.ID)
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/public/apps/:slug/assets/:id/download", DownloadAppCenterAsset)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/public/apps/download-app/assets/1/download", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	contentDisposition := rec.Header().Get("Content-Disposition")
	assert.Contains(t, contentDisposition, "attachment")
	assert.Contains(t, contentDisposition, "app-release-1.0.0.apk")
}

func TestListAppCenterServerFilesAndServerFileUpload(t *testing.T) {
	previousDB, previousSecret := model.DB, common.CryptoSecret
	previousRoot := service.AppCenterStorageRoot
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.AppCenterApp{}, &model.AppCenterRelease{}, &model.AppCenterAsset{}))
	model.DB, common.CryptoSecret = db, "controller-app-center-secret"
	root := t.TempDir()
	service.AppCenterStorageRoot = root
	t.Cleanup(func() {
		model.DB, common.CryptoSecret = previousDB, previousSecret
		service.AppCenterStorageRoot = previousRoot
	})

	app, _, err := service.CreateAppCenterApp("Server", "server-app", "", true, true)
	require.NoError(t, err)
	release, err := service.CreateAppCenterRelease(app.ID, service.AppCenterReleaseInput{Version: "1.0.0", Channel: "stable"})
	require.NoError(t, err)

	importDir := filepath.Join(root, "imports")
	require.NoError(t, os.MkdirAll(importDir, 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(importDir, "server-package-1.0.0.apk"), []byte("server-bytes"), 0o640))
	require.NoError(t, os.MkdirAll(filepath.Join(importDir, "subdir"), 0o750))

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/app-center/files", ListAppCenterServerFiles)
	router.POST("/api/app-center/apps/:id/releases/:release_id/assets", UploadAppCenterAsset)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/app-center/files", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var listResponse struct {
		Data []service.AppCenterServerFile `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &listResponse))
	require.Len(t, listResponse.Data, 1)
	assert.Equal(t, "server-package-1.0.0.apk", listResponse.Data[0].Name)
	assert.Equal(t, int64(len("server-bytes")), listResponse.Data[0].Size)

	form := url.Values{}
	form.Set("platform", "linux")
	form.Set("architecture", "amd64")
	form.Set("server_file", "server-package-1.0.0.apk")
	uploadRec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/app-center/apps/%d/releases/%d/assets", app.ID, release.ID), strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	router.ServeHTTP(uploadRec, req)
	require.Equal(t, http.StatusCreated, uploadRec.Code)
	var uploadResponse struct {
		Data model.AppCenterAsset `json:"data"`
	}
	require.NoError(t, json.Unmarshal(uploadRec.Body.Bytes(), &uploadResponse))
	assert.Equal(t, "server-package-1.0.0.apk", uploadResponse.Data.Filename)
	assert.Equal(t, int64(len("server-bytes")), uploadResponse.Data.Size)
	assert.Equal(t, "application/vnd.android.package-archive", uploadResponse.Data.ContentType)

	missingRec := httptest.NewRecorder()
	form.Set("server_file", "no-such-file.apk")
	missingReq := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/app-center/apps/%d/releases/%d/assets", app.ID, release.ID), strings.NewReader(form.Encode()))
	missingReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	router.ServeHTTP(missingRec, missingReq)
	assert.Equal(t, http.StatusNotFound, missingRec.Code)
}

func TestGetAppCenterDownloadsFiltersHourWindowAndSortsAscending(t *testing.T) {
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.AppCenterDownloadBucket{}))
	model.DB = db
	t.Cleanup(func() { model.DB = previousDB })

	now := time.Now().UTC()
	current := now.Unix() / 3600 * 3600
	older := current - 3600
	outside := current - 10*3600
	require.NoError(t, db.Create(&model.AppCenterDownloadBucket{AppID: 1, BucketTs: current, Version: "1.0.0", Platform: "linux", Architecture: "amd64", Count: 5}).Error)
	require.NoError(t, db.Create(&model.AppCenterDownloadBucket{AppID: 1, BucketTs: older, Version: "1.0.0", Platform: "linux", Architecture: "amd64", Count: 2}).Error)
	require.NoError(t, db.Create(&model.AppCenterDownloadBucket{AppID: 1, BucketTs: outside, Version: "1.0.0", Platform: "linux", Architecture: "amd64", Count: 9}).Error)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: strconv.FormatInt(1, 10)}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/app-center/apps/1/downloads?hours=2", nil)
	GetAppCenterDownloads(ctx)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Data []model.AppCenterDownloadBucket `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.Len(t, response.Data, 2)
	assert.Equal(t, older, response.Data[0].BucketTs)
	assert.Equal(t, int64(2), response.Data[0].Count)
	assert.Equal(t, current, response.Data[1].BucketTs)
	assert.Equal(t, int64(5), response.Data[1].Count)
}
