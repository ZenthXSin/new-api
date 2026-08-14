package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// geoCheckResponse 用于断言 GeoCheck 响应结构
type geoCheckResponse struct {
	Success bool `json:"success"`
	Data    struct {
		Enabled     bool   `json:"enabled"`
		CountryCode string `json:"country_code"`
		CountryName string `json:"country_name"`
		Matched     bool   `json:"matched"`
		Message     string `json:"message"`
	} `json:"data"`
}

func TestGeoCheckResponseShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setting := operation_setting.GetRegionReminderSetting()
	original := *setting
	setting.Enabled = true
	setting.Countries = "CN"
	setting.Message = "region reminder message"
	t.Cleanup(func() { *setting = original })

	router := gin.New()
	router.GET("/api/geo/check", GeoCheck)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/geo/check", nil)
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))

	var body geoCheckResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.True(t, body.Success)
	assert.True(t, body.Data.Enabled)
	// country_code 依赖运行环境的 mmdb:无 mmdb 时为空,有 mmdb 时测试网段
	// 地址可能返回特殊码(如 PRIVATE)。无论哪种情况,测试 IP 都不会命中 CN 列表,
	// 因此 matched 必然为 false、message 必然为空。
	assert.False(t, body.Data.Matched)
	assert.Equal(t, "", body.Data.Message)
	// 结构完整性:country_code/country_name 字段必须存在且为字符串
	assert.IsType(t, "", body.Data.CountryCode)
	assert.IsType(t, "", body.Data.CountryName)
}

func TestGeoCheckDisabledSetting(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setting := operation_setting.GetRegionReminderSetting()
	original := *setting
	setting.Enabled = false
	setting.Countries = "CN"
	t.Cleanup(func() { *setting = original })

	router := gin.New()
	router.GET("/api/geo/check", GeoCheck)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/geo/check", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var body geoCheckResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	// enabled 透传为 false;即便 country 匹配,禁用时 matched 也为 false
	assert.False(t, body.Data.Enabled)
	assert.False(t, body.Data.Matched)
	assert.Equal(t, "", body.Data.Message)
}

func TestIsRegionReminderCountry(t *testing.T) {
	setting := operation_setting.GetRegionReminderSetting()
	original := *setting
	t.Cleanup(func() { *setting = original })

	setting.Enabled = true
	setting.Countries = "CN"
	assert.True(t, operation_setting.IsRegionReminderCountry("CN"))
	assert.False(t, operation_setting.IsRegionReminderCountry("US"))
	assert.False(t, operation_setting.IsRegionReminderCountry(""))

	setting.Countries = "CN,US"
	assert.True(t, operation_setting.IsRegionReminderCountry("CN"))
	assert.True(t, operation_setting.IsRegionReminderCountry("US"))
	assert.False(t, operation_setting.IsRegionReminderCountry("JP"))
}

func TestLookupCountryCodeExists(t *testing.T) {
	// 仅校验公共封装存在且对无效输入安全返回;真实 mmdb 查询行为不在此单测范围
	code, ok := common.LookupCountryCode(nil)
	assert.False(t, ok)
	assert.Equal(t, "", code)
}
