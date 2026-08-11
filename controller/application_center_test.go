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
	previousStorageRoot := service.AppCenterStorageRoot
	previousBrowseRoot := service.AppCenterBrowseRoot
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.AppCenterApp{}, &model.AppCenterRelease{}, &model.AppCenterAsset{}))
	model.DB, common.CryptoSecret = db, "controller-app-center-secret"
	storageRoot := t.TempDir()
	browseRoot := t.TempDir()
	service.AppCenterStorageRoot = storageRoot
	service.AppCenterBrowseRoot = browseRoot
	t.Cleanup(func() {
		model.DB, common.CryptoSecret = previousDB, previousSecret
		service.AppCenterStorageRoot = previousStorageRoot
		service.AppCenterBrowseRoot = previousBrowseRoot
	})

	app, _, err := service.CreateAppCenterApp("Server", "server-app", "", true, true)
	require.NoError(t, err)
	release, err := service.CreateAppCenterRelease(app.ID, service.AppCenterReleaseInput{Version: "1.0.0", Channel: "stable"})
	require.NoError(t, err)

	require.NoError(t, os.MkdirAll(filepath.Join(browseRoot, "sub"), 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(browseRoot, "a.bin"), []byte("root-bytes"), 0o640))
	require.NoError(t, os.WriteFile(filepath.Join(browseRoot, "sub", "b.bin"), []byte("sub-bytes"), 0o640))
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("top-secret"), 0o640))

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/app-center/files", ListAppCenterServerFiles)
	router.POST("/api/app-center/apps/:id/releases/:release_id/assets", UploadAppCenterAsset)

	list := func(queryPath string) []service.AppCenterServerFile {
		rec := httptest.NewRecorder()
		target := "/api/app-center/files"
		if queryPath != "" {
			target += "?path=" + queryPath
		}
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		require.Equal(t, http.StatusOK, rec.Code)
		var response struct {
			Data []service.AppCenterServerFile `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
		return response.Data
	}
	upload := func(serverFile string) *httptest.ResponseRecorder {
		form := url.Values{}
		form.Set("platform", "linux")
		form.Set("architecture", "amd64")
		form.Set("server_file", serverFile)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/app-center/apps/%d/releases/%d/assets", app.ID, release.ID), strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		router.ServeHTTP(rec, req)
		return rec
	}

	// 根目录列举:目录在前,文件在后,同类型按名称排序
	files := list("")
	require.Len(t, files, 2)
	assert.Equal(t, "sub", files[0].Name)
	assert.True(t, files[0].IsDir)
	assert.Equal(t, int64(0), files[0].Size)
	assert.Equal(t, "a.bin", files[1].Name)
	assert.False(t, files[1].IsDir)
	assert.Equal(t, int64(len("root-bytes")), files[1].Size)

	// 子目录列举
	subFiles := list("sub")
	require.Len(t, subFiles, 1)
	assert.Equal(t, "b.bin", subFiles[0].Name)
	assert.False(t, subFiles[0].IsDir)
	assert.Equal(t, int64(len("sub-bytes")), subFiles[0].Size)

	// server_file 导入子目录文件
	uploadRec := upload("sub/b.bin")
	require.Equal(t, http.StatusCreated, uploadRec.Code)
	var uploadResponse struct {
		Data model.AppCenterAsset `json:"data"`
	}
	require.NoError(t, json.Unmarshal(uploadRec.Body.Bytes(), &uploadResponse))
	assert.Equal(t, "b.bin", uploadResponse.Data.Filename)
	assert.Equal(t, int64(len("sub-bytes")), uploadResponse.Data.Size)

	// server_file 携带浏览根前缀(前缀与注入的浏览根一致)
	prefixedRec := upload(browseRoot + "/sub/b.bin")
	require.Equal(t, http.StatusCreated, prefixedRec.Code)
	require.NoError(t, json.Unmarshal(prefixedRec.Body.Bytes(), &uploadResponse))
	assert.Equal(t, "b.bin", uploadResponse.Data.Filename)

	// server_file 逃逸浏览根(..)应被拒绝
	escapeRec := upload("../evil.bin")
	assert.Equal(t, http.StatusBadRequest, escapeRec.Code)

	// server_file 经由浏览根内指向根外的符号链接也应被拒绝
	require.NoError(t, os.Symlink(outside, filepath.Join(browseRoot, "linkdir")))
	symlinkRec := upload("linkdir/secret.txt")
	assert.Equal(t, http.StatusBadRequest, symlinkRec.Code)

	// 不存在的 server_file
	missingRec := upload("no-such-file.apk")
	assert.Equal(t, http.StatusNotFound, missingRec.Code)
}

func TestListAppCenterServerFilesRejectsEscapeAndMissingPaths(t *testing.T) {
	previousBrowseRoot := service.AppCenterBrowseRoot
	browseRoot := t.TempDir()
	service.AppCenterBrowseRoot = browseRoot
	t.Cleanup(func() { service.AppCenterBrowseRoot = previousBrowseRoot })

	require.NoError(t, os.MkdirAll(filepath.Join(browseRoot, "sub"), 0o750))
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("top-secret"), 0o640))
	require.NoError(t, os.Symlink(outside, filepath.Join(browseRoot, "linkdir")))

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/app-center/files", ListAppCenterServerFiles)

	for _, p := range []string{"..", "../../etc", "/etc", "%2e%2e%2fetc", "linkdir", "linkdir/secret.txt"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/app-center/files?path="+p, nil))
		assert.NotEqual(t, http.StatusOK, rec.Code, "path %q must not be served", p)
		assert.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound}, rec.Code, "path %q", p)
		assert.NotContains(t, rec.Body.String(), "top-secret")
	}

	// 浏览根内不存在的目录
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/app-center/files?path=nope", nil))
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestListAppCenterServerFilesSkipsSymlinks(t *testing.T) {
	previousBrowseRoot := service.AppCenterBrowseRoot
	browseRoot := t.TempDir()
	service.AppCenterBrowseRoot = browseRoot
	t.Cleanup(func() { service.AppCenterBrowseRoot = previousBrowseRoot })

	require.NoError(t, os.WriteFile(filepath.Join(browseRoot, "real.bin"), []byte("real"), 0o640))
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "secret.bin"), []byte("secret"), 0o640))
	require.NoError(t, os.Symlink(filepath.Join(outside, "secret.bin"), filepath.Join(browseRoot, "link.bin")))
	require.NoError(t, os.Symlink(outside, filepath.Join(browseRoot, "linkdir")))

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/app-center/files", ListAppCenterServerFiles)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/app-center/files", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var response struct {
		Data []service.AppCenterServerFile `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Len(t, response.Data, 1)
	assert.Equal(t, "real.bin", response.Data[0].Name)
	assert.NotContains(t, rec.Body.String(), "link.bin")
	assert.NotContains(t, rec.Body.String(), "linkdir")
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
