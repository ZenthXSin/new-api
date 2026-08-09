package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
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
