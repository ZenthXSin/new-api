package controller

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/telemetry_setting"
	"github.com/gin-gonic/gin"
)

type createTelemetryProjectRequest struct {
	Name string `json:"name"`
}

type createTelemetryAppRequest struct {
	ProjectID int64  `json:"project_id"`
	Name      string `json:"name"`
}

type createTelemetryKeyRequest struct {
	AppID int64  `json:"app_id"`
	Name  string `json:"name"`
}

func IngestTelemetry(c *gin.Context) {
	setting := telemetry_setting.GetSetting()
	if !setting.Enabled {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "遥测接收未启用"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, telemetry_setting.GetMaxBodyBytes()+1))
	if err != nil || int64(len(body)) > telemetry_setting.GetMaxBodyBytes() {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"success": false, "message": "遥测请求过大"})
		return
	}
	c.Header("Cache-Control", "no-store")
	key, err := service.VerifyAppBearer(c.ClientIP(), c.GetHeader("Authorization"))
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, service.ErrTelemetryRateLimited) {
			status = http.StatusTooManyRequests
		}
		c.JSON(status, gin.H{"success": false, "message": "遥测认证失败"})
		return
	}
	var envelope service.TelemetryEnvelope
	if err := common.DecodeJsonStrict(bytes.NewReader(body), &envelope); err != nil {
		_ = model.UpsertTelemetryReceiverMetric(key.AppID, time.Now().Unix()/3600*3600, 0, 1)
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "遥测数据无效"})
		return
	}
	accepted, err := service.IngestTelemetry(key, &envelope)
	if err != nil {
		_ = model.UpsertTelemetryReceiverMetric(key.AppID, time.Now().Unix()/3600*3600, 0, 1)
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "遥测数据无效"})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"success": true, "data": gin.H{"accepted": accepted}})
}

func ListTelemetryProjects(c *gin.Context) {
	projects, err := model.ListTelemetryProjects()
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": projects})
}

func CreateTelemetryProject(c *gin.Context) {
	var request createTelemetryProjectRequest
	if err := common.DecodeJsonStrict(c.Request.Body, &request); err != nil || strings.TrimSpace(request.Name) == "" || len(request.Name) > 128 {
		telemetryBadRequest(c)
		return
	}
	project, err := model.CreateTelemetryProject(request.Name)
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": project})
}

func ListTelemetryApps(c *gin.Context) {
	projectID, err := telemetryQueryInt64(c, "project_id")
	if err != nil {
		telemetryBadRequest(c)
		return
	}
	apps, err := model.ListTelemetryApps(projectID)
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": apps})
}

func CreateTelemetryApp(c *gin.Context) {
	var request createTelemetryAppRequest
	if err := common.DecodeJsonStrict(c.Request.Body, &request); err != nil || request.ProjectID <= 0 || strings.TrimSpace(request.Name) == "" || len(request.Name) > 128 {
		telemetryBadRequest(c)
		return
	}
	app, err := model.CreateTelemetryApp(request.ProjectID, request.Name)
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": app})
}

func ListTelemetryWriteKeys(c *gin.Context) {
	appID, err := telemetryQueryInt64(c, "app_id")
	if err != nil || appID <= 0 {
		telemetryBadRequest(c)
		return
	}
	keys, err := model.ListTelemetryWriteKeys(appID)
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": keys})
}

func CreateTelemetryWriteKey(c *gin.Context) {
	var request createTelemetryKeyRequest
	if err := common.DecodeJsonStrict(c.Request.Body, &request); err != nil || request.AppID <= 0 || strings.TrimSpace(request.Name) == "" || len(request.Name) > 128 {
		telemetryBadRequest(c)
		return
	}
	key, secret, err := service.CreateTelemetryWriteKey(request.AppID, request.Name)
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": gin.H{
		"key":   key,
		"token": "app_v1." + key.KeyID + "." + secret,
	}})
}

func DisableTelemetryWriteKey(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		telemetryBadRequest(c)
		return
	}
	if err := model.DisableTelemetryWriteKey(id); err != nil {
		telemetryServerError(c)
		return
	}
	c.Status(http.StatusNoContent)
}

func GetTelemetrySummary(c *gin.Context) {
	appID, err := telemetryQueryInt64(c, "app_id")
	if err != nil {
		telemetryBadRequest(c)
		return
	}
	hours, err := telemetryQueryHours(c)
	if err != nil {
		telemetryBadRequest(c)
		return
	}
	rows, err := model.QueryTelemetrySummary(appID, time.Now().Add(-time.Duration(hours)*time.Hour).Unix())
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": rows})
}

func GetTelemetryTimeSeries(c *gin.Context) {
	appID, err := telemetryQueryInt64(c, "app_id")
	if err != nil {
		telemetryBadRequest(c)
		return
	}
	hours, err := telemetryQueryHours(c)
	if err != nil {
		telemetryBadRequest(c)
		return
	}
	rows, err := model.QueryTelemetryTimeSeries(appID, time.Now().Add(-time.Duration(hours)*time.Hour).Unix())
	if err != nil {
		telemetryServerError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": rows})
}

func CleanupTelemetryData(c *gin.Context) {
	retentionDays := telemetry_setting.GetRetentionDays()
	if err := model.DeleteTelemetryDataBefore(time.Now().AddDate(0, 0, -retentionDays)); err != nil {
		telemetryServerError(c)
		return
	}
	c.Status(http.StatusNoContent)
}

func telemetryQueryInt64(c *gin.Context, key string) (int64, error) {
	raw := c.Query(key)
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, errors.New("invalid query value")
	}
	return value, nil
}

func telemetryQueryHours(c *gin.Context) (int64, error) {
	raw := c.Query("hours")
	if raw == "" {
		return 24, nil
	}
	hours, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || hours < 1 || hours > 24*90 {
		return 0, errors.New("invalid hours")
	}
	return hours, nil
}

func telemetryBadRequest(c *gin.Context) {
	c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "无效的参数"})
}

func telemetryServerError(c *gin.Context) {
	c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "遥测操作失败"})
}
