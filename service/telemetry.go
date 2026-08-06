package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/telemetry_setting"
)

const telemetrySchemaVersion = 1
const telemetryBucketSeconds int64 = 3600

var telemetryIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
var telemetryDimensionPattern = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,64}$`)
var ErrTelemetryRateLimited = errors.New("遥测请求过于频繁")

type TelemetryEvent struct {
	EventID         string           `json:"event_id"`
	OccurredAt      int64            `json:"occurred_at"`
	InstallationID  string           `json:"installation_id"`
	InstanceVersion string           `json:"instance_version"`
	EventType       string           `json:"event_type"`
	Payload         TelemetryPayload `json:"payload"`
}

type TelemetryPayload struct {
	Dimension  string `json:"dimension"`
	Status     string `json:"status"`
	Count      int64  `json:"count"`
	Successes  int64  `json:"successes"`
	DurationMs int64  `json:"duration_ms"`
	Value      int64  `json:"value"`
}

type TelemetryEnvelope struct {
	SchemaVersion int              `json:"schema_version"`
	Events        []TelemetryEvent `json:"events"`
}

type telemetryRateWindow struct {
	startedAt time.Time
	count     int
}

var telemetryRateMu sync.Mutex
var telemetryRateWindows = map[string]telemetryRateWindow{}

const telemetryRateLimitScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return count <= tonumber(ARGV[1])
`

func CreateTelemetryWriteKey(appID int64, name string) (*model.TelemetryWriteKey, string, error) {
	if appID <= 0 || strings.TrimSpace(name) == "" {
		return nil, "", errors.New("应用和密钥名称不能为空")
	}
	keyID, err := common.GenerateRandomCharsKey(32)
	if err != nil {
		return nil, "", err
	}
	secret, err := common.GenerateRandomKey(48)
	if err != nil {
		return nil, "", err
	}
	encryptedSecret, err := common.EncryptSecret(secret, "telemetry-write-key")
	if err != nil {
		return nil, "", err
	}
	key, err := model.CreateTelemetryWriteKey(appID, name, keyID, encryptedSecret)
	if err != nil {
		return nil, "", err
	}
	return key, secret, nil
}

func VerifyTelemetryRequest(clientIP, keyID, providedSecret string) (*model.TelemetryWriteKey, error) {
	if !telemetryIDPattern.MatchString(keyID) || providedSecret == "" {
		return nil, errors.New("遥测认证无效")
	}
	if !takeTelemetryRateLimit("global", telemetry_setting.GetRequestsPerMinute()*10) || !takeTelemetryRateLimit("ip:"+clientIP, telemetry_setting.GetRequestsPerMinute()) || !takeTelemetryRateLimit("key:"+keyID, telemetry_setting.GetRequestsPerMinute()) {
		return nil, ErrTelemetryRateLimited
	}
	key, err := model.FindTelemetryWriteKey(keyID)
	if err != nil {
		return nil, errors.New("遥测认证无效")
	}
	secret, err := common.DecryptSecret(key.SecretCiphertext, "telemetry-write-key")
	if err != nil || !hmac.Equal([]byte(providedSecret), []byte(secret)) {
		return nil, errors.New("遥测认证无效")
	}
	return key, nil
}

// VerifyAppBearer authenticates external app traffic. The compact bearer format
// deliberately has no method, timestamp, nonce, or secondary custom headers.
func VerifyAppBearer(clientIP, authorization string) (*model.TelemetryWriteKey, error) {
	const prefix = "Bearer app_v1."
	if !strings.HasPrefix(authorization, prefix) {
		return nil, errors.New("app authentication invalid")
	}
	parts := strings.Split(strings.TrimPrefix(authorization, prefix), ".")
	if len(parts) != 2 || !telemetryIDPattern.MatchString(parts[0]) || parts[1] == "" || strings.ContainsAny(parts[1], " \t\r\n") {
		return nil, errors.New("app authentication invalid")
	}
	return VerifyTelemetryRequest(clientIP, parts[0], parts[1])
}

func IngestTelemetry(key *model.TelemetryWriteKey, envelope *TelemetryEnvelope) (int, error) {
	if key == nil || envelope == nil || envelope.SchemaVersion != telemetrySchemaVersion {
		return 0, errors.New("遥测数据无效")
	}
	if len(envelope.Events) == 0 || len(envelope.Events) > telemetry_setting.GetMaxEventsPerBatch() {
		return 0, errors.New("遥测事件数量无效")
	}

	buckets := make([]*model.TelemetryBucket, 0, len(envelope.Events))
	for _, event := range envelope.Events {
		bucket, err := normalizeTelemetryEvent(key.AppID, event)
		if err != nil {
			return 0, err
		}
		buckets = append(buckets, bucket)
	}

	accepted := len(buckets)
	if err := model.StoreTelemetryBuckets(
		buckets,
		key.AppID,
		time.Now().Unix()/telemetryBucketSeconds*telemetryBucketSeconds,
	); err != nil {
		return 0, err
	}
	return accepted, nil
}

func normalizeTelemetryEvent(appID int64, event TelemetryEvent) (*model.TelemetryBucket, error) {
	if !telemetryIDPattern.MatchString(event.EventID) || !telemetryIDPattern.MatchString(event.InstallationID) || !telemetryIDPattern.MatchString(event.InstanceVersion) {
		return nil, errors.New("遥测事件字段无效")
	}
	if !isTelemetryEventType(event.EventType) || !telemetryDimensionPattern.MatchString(event.Payload.Dimension) || !isTelemetryStatus(event.Payload.Status) {
		return nil, errors.New("遥测事件维度无效")
	}
	if event.OccurredAt <= 0 || absInt64(time.Now().Unix()-event.OccurredAt) > 7*24*60*60 || event.Payload.Count < 1 || event.Payload.Count > 1000000 || event.Payload.Successes < 0 || event.Payload.Successes > event.Payload.Count || event.Payload.DurationMs < 0 || event.Payload.DurationMs > 86400000 || event.Payload.Value < 0 || event.Payload.Value > 1000000000 {
		return nil, errors.New("遥测事件值无效")
	}
	return &model.TelemetryBucket{
		AppID:            appID,
		InstallationHash: model.TelemetryInstallationHash(event.InstallationID),
		AppVersion:       event.InstanceVersion,
		EventType:        event.EventType,
		Dimension:        event.Payload.Dimension,
		Status:           event.Payload.Status,
		BucketTs:         event.OccurredAt / telemetryBucketSeconds * telemetryBucketSeconds,
		EventCount:       event.Payload.Count,
		SuccessCount:     event.Payload.Successes,
		TotalDurationMs:  event.Payload.DurationMs,
		TotalValue:       event.Payload.Value,
	}, nil
}

func isTelemetryEventType(value string) bool {
	switch value {
	case "startup", "request_summary", "relay_performance_bucket", "runtime_snapshot":
		return true
	default:
		return false
	}
}

func isTelemetryStatus(value string) bool {
	switch value {
	case "success", "failure", "unknown":
		return true
	default:
		return false
	}
}

func takeTelemetryRateLimit(key string, limit int) bool {
	if common.RedisEnabled && common.RDB != nil {
		allowed, err := common.RDB.Eval(
			context.Background(),
			telemetryRateLimitScript,
			[]string{"telemetry:rate-limit:" + key},
			limit,
			60,
		).Bool()
		if err != nil {
			return false
		}
		return allowed
	}

	now := time.Now()
	telemetryRateMu.Lock()
	defer telemetryRateMu.Unlock()
	window := telemetryRateWindows[key]
	if window.startedAt.IsZero() || now.Sub(window.startedAt) >= time.Minute {
		telemetryRateWindows[key] = telemetryRateWindow{startedAt: now, count: 1}
		return true
	}
	if window.count >= limit {
		return false
	}
	window.count++
	telemetryRateWindows[key] = window
	return true
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func TelemetryRequestSignature(method, path, timestamp, nonce, secret string, body []byte) string {
	canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s", method, path, timestamp, nonce, body)
	return common.GenerateHMACWithKey([]byte(secret), canonical)
}

func TelemetrySecretFingerprint(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])[:12]
}
