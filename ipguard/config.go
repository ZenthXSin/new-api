package ipguard

// Config is the runtime configuration for one scan engine. It is produced by
// the new-api settings layer (setting/ipguard_setting.go) from Option values;
// the ipguard package itself only consumes it.

type Config struct {
	// LogDir is the directory scanned for nginx access / sshd auth logs.
	LogDir string
	// Interval seconds between scans in watch mode (> 0).
	Interval int64
	// ScanWindow look-back window in seconds for feature aggregation (> 0).
	ScanWindow int64
	// Whitelist IPs that are never banned.
	Whitelist []string
	// DryRun simulates enforcement and never touches the firewall.
	DryRun bool
	// EnforceReal allows real iptables enforcement (also requires root and
	// the engine's enforceReal gate).
	EnforceReal bool
	// EnforceCommand is the executable (and fixed args) used for real
	// enforcement; "iptables" by default. May carry a host hop, e.g.
	// "ssh -p 22 root@host iptables".
	EnforceCommand string
	// BanDurations per LLM verdict, in seconds.
	BanDurations map[LLMVerdict]int64
	// Heuristics threshold overrides; the zero value selects built-in
	// defaults.
	Heuristics HeuristicsThresholds
	// LLM configuration.
	LLMModel             string
	LLMToken             string
	LLMBaseURL           string
	LLMBatchSize         int
	LLMMaxCallsPerRun    int
	LLMMaxCallsPerDay    int
	LLMMaxTokens         int
	LLMCorroborationRate float64
}

// DefaultConfig returns the llm-ipguard shipped defaults.
func DefaultConfig() Config {
	return Config{
		LogDir:         "/var/log",
		Interval:       3600,
		ScanWindow:     3600,
		Whitelist:      []string{"127.0.0.1"},
		DryRun:         true,
		EnforceReal:    false,
		EnforceCommand: "iptables",
		BanDurations: map[LLMVerdict]int64{
			VerdictSuspect:   900,
			VerdictMalicious: 21600,
			VerdictCritical:  86400,
		},
		Heuristics:           defaultThresholds(),
		LLMBatchSize:         5,
		LLMMaxCallsPerRun:    20,
		LLMMaxCallsPerDay:    500,
		LLMMaxTokens:         256,
		LLMCorroborationRate: 3.0,
	}
}
