package setting

// IPGuard (LLM-assisted IP attack detection) settings. Option keys are
// registered in model/option.go defaults; typed getters below parse the
// live OptionMap so admin changes apply to the next scan without a restart.

import (
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/ipguard"
)

const (
	IPGuardEnabledKey           = "IPGuardEnabled"
	IPGuardLogDirKey            = "IPGuardLogDir"
	IPGuardIntervalSecondsKey   = "IPGuardIntervalSeconds"
	IPGuardScanWindowSecondsKey = "IPGuardScanWindowSeconds"
	IPGuardWhitelistKey         = "IPGuardWhitelist"
	IPGuardDryRunKey            = "IPGuardDryRun"
	IPGuardEnforceRealKey       = "IPGuardEnforceReal"
	IPGuardEnforceCommandKey    = "IPGuardEnforceCommand"
	IPGuardBanDurationsKey      = "IPGuardBanDurations"
	IPGuardHeuristicsKey        = "IPGuardHeuristics"
	IPGuardLLMModelKey          = "IPGuardLLMModel"
	IPGuardLLMTokenKey          = "IPGuardLLMToken"
	IPGuardLLMBaseURLKey        = "IPGuardLLMBaseURL"
	IPGuardLLMBatchSizeKey      = "IPGuardLLMBatchSize"
	IPGuardLLMMaxCallsPerRunKey = "IPGuardLLMMaxCallsPerRun"
	IPGuardLLMMaxCallsPerDayKey = "IPGuardLLMMaxCallsPerDay"
	IPGuardLLMMaxTokensKey      = "IPGuardLLMMaxTokens"
	IPGuardLLMCorroborationKey  = "IPGuardLLMCorroborationRate"
)

// IPGuardOptionKeys lists every ipguard option key for UI registration.
var IPGuardOptionKeys = []string{
	IPGuardEnabledKey,
	IPGuardLogDirKey,
	IPGuardIntervalSecondsKey,
	IPGuardScanWindowSecondsKey,
	IPGuardWhitelistKey,
	IPGuardDryRunKey,
	IPGuardEnforceRealKey,
	IPGuardEnforceCommandKey,
	IPGuardBanDurationsKey,
	IPGuardHeuristicsKey,
	IPGuardLLMModelKey,
	IPGuardLLMTokenKey,
	IPGuardLLMBaseURLKey,
	IPGuardLLMBatchSizeKey,
	IPGuardLLMMaxCallsPerRunKey,
	IPGuardLLMMaxCallsPerDayKey,
	IPGuardLLMMaxTokensKey,
	IPGuardLLMCorroborationKey,
}

func ipguardOption(key string) string {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	return common.OptionMap[key]
}

// IPGuardEnabled reports whether the scheduled scan is enabled.
func IPGuardEnabled() bool {
	return ipguardOption(IPGuardEnabledKey) == "true"
}

// IPGuardLogDir returns the configured log directory (default /var/log).
func IPGuardLogDir() string {
	v := strings.TrimSpace(ipguardOption(IPGuardLogDirKey))
	if v == "" {
		return "/var/log"
	}
	return v
}

// GetIPGuardConfig parses the live options into an engine config. Returns
// the default config when options are unset, with overrides applied.
func GetIPGuardConfig() ipguard.Config {
	cfg := ipguard.DefaultConfig()

	cfg.LogDir = IPGuardLogDir()
	cfg.Whitelist = parseStringList(ipguardOption(IPGuardWhitelistKey))
	if len(cfg.Whitelist) == 0 {
		cfg.Whitelist = []string{"127.0.0.1"}
	}
	cfg.DryRun = ipguardOption(IPGuardDryRunKey) != "false"
	cfg.EnforceReal = ipguardOption(IPGuardEnforceRealKey) == "true"
	cfg.EnforceCommand = strings.TrimSpace(ipguardOption(IPGuardEnforceCommandKey))
	if cfg.EnforceCommand == "" {
		cfg.EnforceCommand = "iptables"
	}

	if v, err := strconv.ParseInt(ipguardOption(IPGuardIntervalSecondsKey), 10, 64); err == nil && v > 0 {
		cfg.Interval = v
	}
	if v, err := strconv.ParseInt(ipguardOption(IPGuardScanWindowSecondsKey), 10, 64); err == nil && v > 0 {
		cfg.ScanWindow = v
	}

	if raw := ipguardOption(IPGuardBanDurationsKey); raw != "" {
		if durations := parseBanDurations(raw); len(durations) > 0 {
			cfg.BanDurations = durations
		}
	}
	if raw := ipguardOption(IPGuardHeuristicsKey); raw != "" {
		cfg.Heuristics = parseHeuristicsOverrides(raw, cfg.Heuristics)
	}

	cfg.LLMModel = strings.TrimSpace(ipguardOption(IPGuardLLMModelKey))
	cfg.LLMToken = ipguardOption(IPGuardLLMTokenKey)
	cfg.LLMBaseURL = strings.TrimSpace(ipguardOption(IPGuardLLMBaseURLKey))

	if v, err := strconv.Atoi(ipguardOption(IPGuardLLMBatchSizeKey)); err == nil && v > 0 {
		cfg.LLMBatchSize = v
	}
	if v, err := strconv.Atoi(ipguardOption(IPGuardLLMMaxCallsPerRunKey)); err == nil && v > 0 {
		cfg.LLMMaxCallsPerRun = v
	}
	if v, err := strconv.Atoi(ipguardOption(IPGuardLLMMaxCallsPerDayKey)); err == nil && v > 0 {
		cfg.LLMMaxCallsPerDay = v
	}
	if v, err := strconv.Atoi(ipguardOption(IPGuardLLMMaxTokensKey)); err == nil && v > 0 {
		cfg.LLMMaxTokens = v
	}
	if v, err := strconv.ParseFloat(ipguardOption(IPGuardLLMCorroborationKey), 64); err == nil && v > 0 {
		cfg.LLMCorroborationRate = v
	}
	return cfg
}

// IPGuardScanInterval returns the scan cadence for the scheduled task.
func IPGuardScanInterval() time.Duration {
	cfg := GetIPGuardConfig()
	seconds := cfg.Interval
	if seconds < 60 {
		seconds = 3600
	}
	return time.Duration(seconds) * time.Second
}

func parseStringList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var out []string
	if err := common.UnmarshalJsonStr(raw, &out); err != nil {
		return nil
	}
	return out
}

func parseBanDurations(raw string) map[ipguard.LLMVerdict]int64 {
	var parsed map[string]int64
	if err := common.UnmarshalJsonStr(raw, &parsed); err != nil {
		return nil
	}
	out := make(map[ipguard.LLMVerdict]int64)
	for key, value := range parsed {
		switch ipguard.LLMVerdict(key) {
		case ipguard.VerdictSuspect, ipguard.VerdictMalicious, ipguard.VerdictCritical:
			if value > 0 {
				out[ipguard.LLMVerdict(key)] = value
			}
		}
	}
	return out
}

func parseHeuristicsOverrides(raw string, base ipguard.HeuristicsThresholds) ipguard.HeuristicsThresholds {
	var parsed map[string]any
	if err := common.UnmarshalJsonStr(raw, &parsed); err != nil {
		return base
	}
	if v, ok := intKey(parsed, "ssh_fail_threshold"); ok {
		base.SSHFailThreshold = v
	}
	if v, ok := intKey(parsed, "sql_threshold"); ok {
		base.SQLThreshold = v
	}
	if v, ok := intKey(parsed, "xss_threshold"); ok {
		base.XSSThreshold = v
	}
	if v, ok := intKey(parsed, "traversal_threshold"); ok {
		base.TraversalThreshold = v
	}
	if v, ok := intKey(parsed, "bot_flood_threshold"); ok {
		base.BotFloodThreshold = v
	}
	if v, ok := intKey(parsed, "web_fail_threshold"); ok {
		base.WebFailThreshold = v
	}
	if v, ok := intKey(parsed, "ddos_rate_threshold"); ok {
		base.DDOSRateThreshold = v
	}
	if v, ok := intKey(parsed, "ddos_total_threshold"); ok {
		base.DDOSTotalThreshold = v
	}
	if v, ok := intKey(parsed, "llm_total_threshold"); ok {
		base.LLMTotalThreshold = v
	}
	if v, ok := intKey(parsed, "llm_failed_min"); ok {
		base.LLMFailedMin = v
	}
	if v, ok := intKey(parsed, "port_scan_threshold"); ok {
		base.PortScanThreshold = v
	}
	if v, ok := intKey(parsed, "cum_total_threshold"); ok {
		base.CumTotalThreshold = v
	}
	if v, ok := intKey(parsed, "cum_windows_threshold"); ok {
		base.CumWindowsThreshold = v
	}
	if v, ok := floatKey(parsed, "cum_avg_max"); ok {
		base.CumAvgMax = v
	}
	if v, ok := intKey(parsed, "cum_burst_total_threshold"); ok {
		base.CumBurstTotalThreshold = v
	}
	if v, ok := intKey(parsed, "cum_burst_windows_max"); ok {
		base.CumBurstWindowsMax = v
	}
	if v, ok := intKey(parsed, "slow_persistence_windows"); ok {
		base.SlowPersistenceWindows = v
	}
	if v, ok := intKey(parsed, "slow_persistence_total"); ok {
		base.SlowPersistenceTotal = v
	}
	if v, ok := floatKey(parsed, "slow_persistence_rate_max"); ok {
		base.SlowPersistenceRateMax = v
	}
	return base
}

func intKey(m map[string]any, key string) (int, bool) {
	switch v := m[key].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n, true
		}
	}
	return 0, false
}

func floatKey(m map[string]any, key string) (float64, bool) {
	switch v := m[key].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f, true
		}
	}
	return 0, false
}
