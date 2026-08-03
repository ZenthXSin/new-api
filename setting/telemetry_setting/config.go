package telemetry_setting

import "github.com/QuantumNous/new-api/setting/config"

type TelemetrySetting struct {
	Enabled           bool `json:"enabled"`
	RetentionDays     int  `json:"retention_days"`
	MaxBodyBytes      int  `json:"max_body_bytes"`
	MaxEventsPerBatch int  `json:"max_events_per_batch"`
	TimestampSkewSec  int  `json:"timestamp_skew_seconds"`
	RequestsPerMinute int  `json:"requests_per_minute"`
}

var telemetrySetting = TelemetrySetting{
	Enabled:           false,
	RetentionDays:     30,
	MaxBodyBytes:      65536,
	MaxEventsPerBatch: 100,
	TimestampSkewSec:  300,
	RequestsPerMinute: 120,
}

func init() {
	config.GlobalConfig.Register("telemetry_setting", &telemetrySetting)
}

func GetSetting() TelemetrySetting {
	return telemetrySetting
}

func GetMaxBodyBytes() int64 {
	if telemetrySetting.MaxBodyBytes < 1024 {
		return 1024
	}
	if telemetrySetting.MaxBodyBytes > 1048576 {
		return 1048576
	}
	return int64(telemetrySetting.MaxBodyBytes)
}

func GetMaxEventsPerBatch() int {
	if telemetrySetting.MaxEventsPerBatch < 1 {
		return 1
	}
	if telemetrySetting.MaxEventsPerBatch > 1000 {
		return 1000
	}
	return telemetrySetting.MaxEventsPerBatch
}

func GetTimestampSkewSeconds() int64 {
	if telemetrySetting.TimestampSkewSec < 30 {
		return 30
	}
	if telemetrySetting.TimestampSkewSec > 3600 {
		return 3600
	}
	return int64(telemetrySetting.TimestampSkewSec)
}

func GetRequestsPerMinute() int {
	if telemetrySetting.RequestsPerMinute < 1 {
		return 1
	}
	if telemetrySetting.RequestsPerMinute > 10000 {
		return 10000
	}
	return telemetrySetting.RequestsPerMinute
}

func GetRetentionDays() int {
	if telemetrySetting.RetentionDays < 1 {
		return 1
	}
	if telemetrySetting.RetentionDays > 3650 {
		return 3650
	}
	return telemetrySetting.RetentionDays
}
