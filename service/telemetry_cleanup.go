package service

import (
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/telemetry_setting"
)

const telemetryCleanupInterval = time.Hour

func StartTelemetryCleanup() {
	if !common.IsMasterNode {
		return
	}
	go func() {
		cleanupTelemetryData()
		ticker := time.NewTicker(telemetryCleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			cleanupTelemetryData()
		}
	}()
}

func cleanupTelemetryData() {
	cutoff := time.Now().AddDate(0, 0, -telemetry_setting.GetRetentionDays())
	if err := model.DeleteTelemetryDataBefore(cutoff); err != nil {
		common.SysError("failed to clean telemetry data: " + err.Error())
	}
}
