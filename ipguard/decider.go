package ipguard

// Deterministic ban decision logic. Decide maps per-IP verdicts to concrete
// actions (IGNORE / BAN / ESCALATE / UNBAN) using only the inputs passed to
// it, so the outcome is fully reproducible for a given now. Ported from
// llm-ipguard's decider.py.

import "sort"

const (
	// RepeatOffenderBans: a repeat offender has at least this many BAN records
	// in 24h.
	RepeatOffenderBans = 3
	// RepeatOffenderDuration: duration of a repeat-offender escalation
	// (permanent ban).
	RepeatOffenderDuration = 31536000
	// CooldownSeconds: window in which a fresh BAN silences further BAN
	// decisions.
	CooldownSeconds = 600
	// HistoryWindow: window used for "recent history" checks (24h).
	HistoryWindow = 86400

	// CumBurstMinTotal / CumBurstMaxWindows mirror heuristics' cum_burst_*
	// defaults: >= 80 requests packed into 1-2 scan windows by a non-bot IP
	// is a deterministic compact-burst signature, so the BAN does not rest on
	// the LLM verdict alone.
	CumBurstMinTotal  = 80
	CumBurstMaxWindow = 2
)

var cleanFeatureKeys = []string{"SQLAttempts", "XSSAttempts", "TraversalAttempts", "FailedLogins"}

// attackSignals are AttackType names that count as corroborating evidence on
// their own (clear-cut heuristic detection, not a raw LLM verdict).
var attackSignals = map[string]bool{
	AttackSSHBruteforce: true,
	AttackWebBruteforce: true,
	AttackSQLI:          true,
	AttackXSS:           true,
	AttackPathTraversal: true,
	AttackPortScan:      true,
	AttackDDoSBurst:     true,
	AttackSlowScan:      true,
}

// corroborated reports whether a malicious/critical verdict is backed by
// independent evidence. A missing profile preserves the legacy behaviour:
// there is no profile signal to contradict the verdict, so the ban proceeds.
func corroborated(profile *IPProfile, signal string, llmCorroborationRate float64) bool {
	if profile == nil {
		return true
	}
	features := profile.Features
	if attackSignals[signal] {
		return true
	}
	if features.RatePerMin >= llmCorroborationRate {
		return true
	}
	if !features.IsBotUA &&
		features.CumTotal >= CumBurstMinTotal &&
		features.CumWindows >= 1 && features.CumWindows <= CumBurstMaxWindow {
		return true
	}
	return false
}

func countBans(history []BanRecord, ip string, now int64, window int64, action DecisionAction) int {
	n := 0
	for _, r := range history {
		if r.IP == ip && r.Action == action && r.TS >= now-window {
			n++
		}
	}
	return n
}

func featuresClean(profile *IPProfile) bool {
	if profile == nil {
		return true
	}
	f := profile.Features
	return f.SQLAttempts == 0 && f.XSSAttempts == 0 && f.TraversalAttempts == 0 && f.FailedLogins == 0
}

// Decide produces the ban decisions for one scan run. See the llm-ipguard
// decider contract for the full rule list (whitelist, slow-persistence
// evidence, benign unban recovery, repeat-offender escalation, cooldown,
// corroboration gate). Returns one BanRecord per entry in *verdicts*, sorted
// by ts.
func Decide(verdicts map[string]LLMVerdict, profiles map[string]*IPProfile,
	banned map[string]bool, history []BanRecord, now int64, config Config) []BanRecord {
	whitelist := make(map[string]bool, len(config.Whitelist))
	for _, ip := range config.Whitelist {
		whitelist[ip] = true
	}

	records := make([]BanRecord, 0, len(verdicts))
	for ip, verdict := range verdicts {
		profile := profiles[ip]
		signal := ""
		if profile != nil {
			signal = profile.Signal
		}

		if whitelist[ip] {
			records = append(records, BanRecord{IP: ip, Action: ActionIgnore, Reason: "whitelisted", TS: now})
			continue
		}

		// Sustained low-rate persistence: the deterministic slow-and-low
		// pattern is itself the evidence; emit a short, self-healing
		// suspect-duration ban whatever the model said.
		if signal == ReasonSlowPersistence {
			records = append(records, BanRecord{
				IP: ip, Action: ActionBan, Reason: "slow_persistence:monitor",
				DurationSeconds: config.BanDurations[VerdictSuspect], TS: now,
			})
			continue
		}

		if verdict == VerdictBenign {
			hasRecentBan := false
			for _, r := range history {
				if r.IP == ip && (r.Action == ActionBan || r.Action == ActionEscalate) && r.TS >= now-HistoryWindow {
					hasRecentBan = true
					break
				}
			}
			if banned[ip] && !hasRecentBan && featuresClean(profile) {
				records = append(records, BanRecord{IP: ip, Action: ActionUnban, Reason: "false_positive_recovery", TS: now})
			} else {
				records = append(records, BanRecord{IP: ip, Action: ActionIgnore, Reason: "benign", TS: now})
			}
			continue
		}

		// suspect / malicious / critical
		if countBans(history, ip, now, HistoryWindow, ActionBan) >= RepeatOffenderBans {
			records = append(records, BanRecord{
				IP: ip, Action: ActionEscalate, Reason: "repeat_offender",
				DurationSeconds: RepeatOffenderDuration, TS: now,
			})
			continue
		}

		if banned[ip] {
			records = append(records, BanRecord{IP: ip, Action: ActionIgnore, Reason: "already_banned", TS: now})
			continue
		}

		if countBans(history, ip, now, CooldownSeconds, ActionBan) > 0 {
			records = append(records, BanRecord{IP: ip, Action: ActionIgnore, Reason: "cooldown", TS: now})
			continue
		}

		// Corroboration gate (LLM-reviewed verdicts only): applies to suspect
		// verdicts too, so a model that emits "suspect" for most
		// busy-but-normal profiles cannot run a false-positive loop.
		if verdict == VerdictSuspect || verdict == VerdictMalicious || verdict == VerdictCritical {
			if !corroborated(profile, signal, config.LLMCorroborationRate) {
				records = append(records, BanRecord{IP: ip, Action: ActionIgnore, Reason: "llm_verdict_uncorroborated", TS: now})
				continue
			}
		}

		duration := config.BanDurations[verdict]
		reason := signal
		if reason == "" {
			reason = string(verdict)
		}
		records = append(records, BanRecord{IP: ip, Action: ActionBan, Reason: reason, DurationSeconds: duration, TS: now})
	}

	sort.Slice(records, func(i, j int) bool { return records[i].TS < records[j].TS })
	return records
}
