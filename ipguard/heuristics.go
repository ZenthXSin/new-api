package ipguard

import "strings"

// Deterministic prefilter heuristics over aggregated IP profiles. Pure
// functions only. Thresholds come from HeuristicsThresholds with built-in
// defaults, so callers may pass the zero value.
//
// Reason strings follow the AttackType names (SSH_BRUTEFORCE, SQLI, ...) plus
// "BOT_FLOOD" for bot floods, "SLOW_PERSISTENCE" for sustained low-rate
// presence (a slow-and-low scan), and "SUSPICIOUS" for everything that
// warrants a closer (LLM) look.

const (
	ReasonSuspicious      = "SUSPICIOUS"
	ReasonBotFlood        = "BOT_FLOOD"
	ReasonSlowPersistence = "SLOW_PERSISTENCE"
)

// HeuristicsThresholds mirrors llm-ipguard's built-in prefilter defaults.
// The zero value selects these defaults.
type HeuristicsThresholds struct {
	SSHFailThreshold       int
	SQLThreshold           int
	XSSThreshold           int
	TraversalThreshold     int
	BotFloodThreshold      int
	WebFailThreshold       int
	DDOSRateThreshold      int
	DDOSTotalThreshold     int
	LLMTotalThreshold      int
	LLMFailedMin           int
	PortScanThreshold      int
	CumTotalThreshold      int
	CumWindowsThreshold    int
	CumAvgMax              float64
	CumBurstTotalThreshold int
	CumBurstWindowsMax     int
	SlowPersistenceWindows int
	SlowPersistenceTotal   int
	SlowPersistenceRateMax float64
}

func defaultThresholds() HeuristicsThresholds {
	return HeuristicsThresholds{
		SSHFailThreshold:       5,
		SQLThreshold:           2,
		XSSThreshold:           2,
		TraversalThreshold:     2,
		BotFloodThreshold:      100,
		WebFailThreshold:       10,
		DDOSRateThreshold:      30,
		DDOSTotalThreshold:     100,
		LLMTotalThreshold:      30,
		LLMFailedMin:           2,
		PortScanThreshold:      5,
		CumTotalThreshold:      35,
		CumWindowsThreshold:    4,
		CumAvgMax:              4.0,
		CumBurstTotalThreshold: 80,
		CumBurstWindowsMax:     2,
		SlowPersistenceWindows: 12,
		SlowPersistenceTotal:   8,
		SlowPersistenceRateMax: 0.5,
	}
}

// resolvedThresholds merges cfg overrides over the built-in defaults.
func resolvedThresholds(cfg HeuristicsThresholds) HeuristicsThresholds {
	def := defaultThresholds()
	if cfg.SSHFailThreshold != 0 {
		def.SSHFailThreshold = cfg.SSHFailThreshold
	}
	if cfg.SQLThreshold != 0 {
		def.SQLThreshold = cfg.SQLThreshold
	}
	if cfg.XSSThreshold != 0 {
		def.XSSThreshold = cfg.XSSThreshold
	}
	if cfg.TraversalThreshold != 0 {
		def.TraversalThreshold = cfg.TraversalThreshold
	}
	if cfg.BotFloodThreshold != 0 {
		def.BotFloodThreshold = cfg.BotFloodThreshold
	}
	if cfg.WebFailThreshold != 0 {
		def.WebFailThreshold = cfg.WebFailThreshold
	}
	if cfg.DDOSRateThreshold != 0 {
		def.DDOSRateThreshold = cfg.DDOSRateThreshold
	}
	if cfg.DDOSTotalThreshold != 0 {
		def.DDOSTotalThreshold = cfg.DDOSTotalThreshold
	}
	if cfg.LLMTotalThreshold != 0 {
		def.LLMTotalThreshold = cfg.LLMTotalThreshold
	}
	if cfg.LLMFailedMin != 0 {
		def.LLMFailedMin = cfg.LLMFailedMin
	}
	if cfg.PortScanThreshold != 0 {
		def.PortScanThreshold = cfg.PortScanThreshold
	}
	if cfg.CumTotalThreshold != 0 {
		def.CumTotalThreshold = cfg.CumTotalThreshold
	}
	if cfg.CumWindowsThreshold != 0 {
		def.CumWindowsThreshold = cfg.CumWindowsThreshold
	}
	if cfg.CumAvgMax != 0 {
		def.CumAvgMax = cfg.CumAvgMax
	}
	if cfg.CumBurstTotalThreshold != 0 {
		def.CumBurstTotalThreshold = cfg.CumBurstTotalThreshold
	}
	if cfg.CumBurstWindowsMax != 0 {
		def.CumBurstWindowsMax = cfg.CumBurstWindowsMax
	}
	if cfg.SlowPersistenceWindows != 0 {
		def.SlowPersistenceWindows = cfg.SlowPersistenceWindows
	}
	if cfg.SlowPersistenceTotal != 0 {
		def.SlowPersistenceTotal = cfg.SlowPersistenceTotal
	}
	if cfg.SlowPersistenceRateMax != 0 {
		def.SlowPersistenceRateMax = cfg.SlowPersistenceRateMax
	}
	return def
}

// ruleReason classifies a single IP's features and returns the reason string.
// See the module docstring for the ordered rules.
func ruleReason(features IPFeatures, t HeuristicsThresholds) string {
	total := features.TotalRequests
	failed := features.FailedLogins
	webFailed := features.WebFailedLogins
	sql := features.SQLAttempts
	xss := features.XSSAttempts
	trav := features.TraversalAttempts
	ports := features.PortsSeen
	isBot := features.IsBotUA
	rate := features.RatePerMin
	uaLower := features.UALower
	cumTotal := features.CumTotal
	cumWindows := features.CumWindows

	// Clear-cut rules (ordered; first match wins).
	if failed >= t.SSHFailThreshold {
		return AttackSSHBruteforce
	}
	if sql >= t.SQLThreshold {
		return AttackSQLI
	}
	if xss >= t.XSSThreshold {
		return AttackXSS
	}
	if trav >= t.TraversalThreshold {
		return AttackPathTraversal
	}
	if isBot && total >= t.BotFloodThreshold {
		return ReasonBotFlood
	}
	// Web-login brute force: repeated failed POST logins.
	if webFailed >= t.WebFailThreshold {
		return AttackWebBruteforce
	}
	// Scan tools: nmap/masscan user agents.
	if isBot && (strings.Contains(uaLower, "nmap") || strings.Contains(uaLower, "masscan")) {
		return AttackPortScan
	}
	// DDOS burst: sustained high rate with a large request total.
	if rate >= float64(t.DDOSRateThreshold) && total >= t.DDOSTotalThreshold {
		return AttackDDoSBurst
	}

	// LLM-review rules.
	// Sustained low-rate persistence (slow-and-low scan).
	if !isBot &&
		cumWindows >= t.SlowPersistenceWindows &&
		cumTotal >= t.SlowPersistenceTotal &&
		rate <= t.SlowPersistenceRateMax {
		return ReasonSlowPersistence
	}
	failsBelowThreshold := failed >= t.LLMFailedMin && failed < t.SSHFailThreshold
	singles := sql == 1 || xss == 1 || trav == 1
	// Slow-and-low scan via cumulative counters, and compact bursts.
	cumAvg := float64(cumTotal) / float64(maxInt(cumWindows, 1))
	cumSlow := cumTotal >= t.CumTotalThreshold &&
		cumWindows >= t.CumWindowsThreshold &&
		!isBot &&
		cumAvg <= t.CumAvgMax
	cumBurst := cumTotal >= t.CumBurstTotalThreshold &&
		cumWindows >= 1 && cumWindows <= t.CumBurstWindowsMax &&
		!isBot
	if total >= t.LLMTotalThreshold ||
		failsBelowThreshold ||
		singles ||
		ports >= t.PortScanThreshold ||
		cumSlow ||
		cumBurst {
		return ReasonSuspicious
	}
	return ""
}

// Prefilter splits profiles into clear-cut and needs-LLM buckets. Returns
// (clearCutIPs, needsLLMIPs, reasons) where reasons maps every flagged IP to
// its reason string. "SUSPICIOUS" and "SLOW_PERSISTENCE" both need LLM
// review (no clear-cut).
func Prefilter(profiles map[string]*IPProfile, cfg HeuristicsThresholds) (clearCut, needsLLM []string, reasons map[string]string) {
	t := resolvedThresholds(cfg)
	reasons = make(map[string]string)
	for ip, profile := range profiles {
		if profile == nil {
			continue
		}
		reason := ruleReason(profile.Features, t)
		if reason == "" {
			continue
		}
		reasons[ip] = reason
		if reason == ReasonSuspicious || reason == ReasonSlowPersistence {
			needsLLM = append(needsLLM, ip)
		} else {
			clearCut = append(clearCut, ip)
		}
	}
	return clearCut, needsLLM, reasons
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
