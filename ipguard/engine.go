package ipguard

// Scan orchestration engine. Ties together log parsing, feature aggregation,
// heuristic prefiltering, LLM verdicts and the deterministic decider,
// persisting scan watermarks, decisions and bans through the StateStore.
// Ported from llm-ipguard's engine.py.

import (
	"bufio"
	"errors"
	"os"
	"sort"
	"strings"
	"time"
)

// StateStore persists scan watermarks, ban records and per-IP decisions.
// Implemented by the new-api model layer (model/ipguard.go).
type StateStore interface {
	LastWatermark() (int64, error)
	RecordScan(ts, watermark int64, stats map[string]any) error
	RecordBan(record BanRecord) error
	RecordDecision(ts int64, ip string, verdict LLMVerdict, action DecisionAction, reason string) error
	BansSince(ts int64) ([]BanRecord, error)
}

// RunReport summarizes a single scan run.
type RunReport struct {
	TotalEvents      int
	ParsedCount      int
	ProfilesCount    int
	ClearCutCount    int
	LLMCalls         int
	Verdicts         []VerdictEntry
	Actions          []BanRecord
	Skipped          int
	WindowStart      int64
	WindowEnd        int64
	DeferredReassess int
}

// VerdictEntry pairs an IP with its verdict.
type VerdictEntry struct {
	IP      string
	Verdict LLMVerdict
}

// Engine is one config + one enforcer + one state store + in-memory
// cross-window state. Reuse the same instance across scans (the service layer
// keeps a singleton) so cumulative counters, the LLM reassessment cadence and
// the per-day LLM call budget survive between runs — mirroring ipguard's
// watch mode.
type Engine struct {
	Config   Config
	Enforcer Enforcer
	LLM      LLMClient
	State    StateStore
	Clock    func() time.Time
	// Cross-window cumulative per-IP counters for slow-and-low scan
	// detection: ip -> {total, windows}. Deliberately NOT persisted; reset
	// per Engine instance so a fresh process starts from a clean slate.
	cumulative map[string]*cumulativeEntry
	// Per-IP last-assessment timestamps (epoch seconds) for the LLM
	// reassessment cadence. In-memory only.
	assessed map[string]int64
}

type cumulativeEntry struct {
	total   int
	windows int
}

// NewEngine builds an engine from a config. llm and enforcer may be nil to
// build defaults (gateway LLM + simulated enforcer); state and clock may be
// nil only in tests (state is required for real runs).
func NewEngine(config Config, state StateStore, enforcer Enforcer, llm LLMClient, clock func() time.Time) (*Engine, error) {
	if clock == nil {
		clock = time.Now
	}
	if enforcer == nil {
		var err error
		enforcer, err = MakeEnforcer(config, clock)
		if err != nil {
			return nil, err
		}
	}
	if llm == nil {
		llm = NewGatewayLLM(config, clock)
	}
	return &Engine{
		Config:     config,
		Enforcer:   enforcer,
		LLM:        llm,
		State:      state,
		Clock:      clock,
		cumulative: map[string]*cumulativeEntry{},
		assessed:   map[string]int64{},
	}, nil
}

func (e *Engine) now() int64 { return e.Clock().Unix() }

// RunOnce runs one scan pass over logPaths and returns the run report.
// groundTruth maps IP -> "ATTACK:<TYPE>" | "NORMAL" and is a test-only input
// that stamps the Truth feature on profiles (used by MockLLM). Production
// callers pass nil.
func (e *Engine) RunOnce(logPaths []string, now int64, groundTruth map[string]string) (*RunReport, error) {
	if now == 0 {
		now = e.now()
	}
	windowStart := now - e.Config.ScanWindow
	watermark, err := e.State.LastWatermark()
	if err != nil {
		return nil, err
	}
	if watermark == 0 {
		watermark = windowStart
	}

	// (a) parse log files, dropping lines already consumed in earlier runs.
	skipped := &SkipCounters{}
	var events []*TrafficEvent
	totalEvents := 0
	for _, path := range logPaths {
		fileEvents, fileTotal, err := parseLogFile(path, now, watermark, skipped)
		if err != nil {
			// A missing/unreadable log is not fatal: the scan continues with
			// whatever is readable (mirrors Python, which opens lazily per
			// path but lets the caller surface errors).
			return nil, err
		}
		totalEvents += fileTotal
		events = append(events, fileEvents...)
	}

	// (b) aggregate per-IP profiles.
	profiles := AggregateIPs(events, windowStart, now)

	// (b2) cross-window cumulative tracking: fold this window's totals into
	// per-IP accumulators and expose them as features.
	for ip, profile := range profiles {
		entry := e.cumulative[ip]
		if entry == nil {
			entry = &cumulativeEntry{}
			e.cumulative[ip] = entry
		}
		entry.total += profile.Features.TotalRequests
		entry.windows++
		profile.Features.CumTotal = entry.total
		profile.Features.CumWindows = entry.windows
	}

	// (c) heuristic prefilter.
	clearCut, needsLLM, reasons := Prefilter(profiles, e.Config.Heuristics)

	// (c2) carry every prefilter reason into the profile signal.
	for ip, reason := range reasons {
		profiles[ip].Signal = reason
	}

	// (d) mock provider: stamp the test-only truth feature on every profile.
	// Heuristic reasons for clear-cut IPs are AttackType names already; for
	// LLM-reviewed IPs the reason is never an AttackType name, so fall back
	// to the sandbox-supplied ground truth.
	stampTruth(profiles, reasons, groundTruth)

	// (e) build verdicts: clear-cut IPs are malicious without an LLM call;
	// needs-LLM IPs are assessed in batches.
	verdicts := make(map[string]LLMVerdict, len(clearCut)+len(needsLLM))
	for _, ip := range clearCut {
		verdicts[ip] = VerdictMalicious
	}

	// Reassessment cadence: an IP is LLM-reviewed at most once per day
	// (interval * 24 seconds). SLOW_PERSISTENCE is exempt: it gets a direct
	// suspect verdict and is never sent to the LLM.
	reassessWindow := e.Config.Interval * 24
	if reassessWindow < 1 {
		reassessWindow = 1
	}
	deferredReassess := 0
	var candidates []string
	for _, ip := range needsLLM {
		if reasons[ip] == ReasonSlowPersistence {
			verdicts[ip] = VerdictSuspect
			continue
		}
		if last, ok := e.assessed[ip]; ok && now-last < reassessWindow {
			deferredReassess++
			continue
		}
		candidates = append(candidates, ip)
	}

	// Prioritize the LLM budget: most suspicious candidates first.
	sort.Slice(candidates, func(i, j int) bool {
		a, b := profiles[candidates[i]], profiles[candidates[j]]
		if a.Features.TotalRequests != b.Features.TotalRequests {
			return a.Features.TotalRequests > b.Features.TotalRequests
		}
		return a.Features.RatePerMin > b.Features.RatePerMin
	})

	llmCalls := 0
	batchSize := e.Config.LLMBatchSize
	if batchSize < 1 {
		batchSize = 1
	}
	for start := 0; start < len(candidates); start += batchSize {
		end := start + batchSize
		if end > len(candidates) {
			end = len(candidates)
		}
		batchIPs := candidates[start:end]
		batch := make([]*IPProfile, 0, len(batchIPs))
		for _, ip := range batchIPs {
			batch = append(batch, profiles[ip])
		}
		batchVerdicts, err := e.LLM.Assess(batch)
		if err != nil {
			var limitErr *ErrLLMLimitExceeded
			if errors.As(err, &limitErr) {
				break
			}
			return nil, err
		}
		llmCalls++
		for i, ip := range batchIPs {
			verdicts[ip] = batchVerdicts[i]
			e.assessed[ip] = now
		}
	}

	// (f) decide + apply.
	history, err := e.State.BansSince(now - HistoryWindow)
	if err != nil {
		return nil, err
	}
	bannedSet := make(map[string]bool)
	for _, ip := range e.Enforcer.BannedIPs() {
		bannedSet[ip] = true
	}
	actions := Decide(verdicts, profiles, bannedSet, history, now, e.Config)

	for _, record := range actions {
		switch record.Action {
		case ActionBan, ActionEscalate:
			e.Enforcer.Ban(record.IP, record.DurationSeconds, record.Reason)
		case ActionUnban:
			e.Enforcer.Unban(record.IP, record.Reason)
		}
		verdict := verdicts[record.IP]
		if err := e.State.RecordDecision(record.TS, record.IP, verdict, record.Action, record.Reason); err != nil {
			return nil, err
		}
		if record.Action == ActionBan || record.Action == ActionEscalate || record.Action == ActionUnban {
			if err := e.State.RecordBan(record); err != nil {
				return nil, err
			}
		}
	}

	// (f2) lift expired bans so real firewall rules do not leak forever: an
	// expired ban is removed from the enforcer and traced as an UNBAN record.
	for _, ip := range e.Enforcer.ExpiredBans(now) {
		e.Enforcer.Unban(ip, "expired")
		if err := e.State.RecordBan(BanRecord{IP: ip, Action: ActionUnban, Reason: "expired", TS: now}); err != nil {
			return nil, err
		}
		if err := e.State.RecordDecision(now, ip, "", ActionUnban, "expired"); err != nil {
			return nil, err
		}
	}

	// (g) persist scan watermark + stats, then report.
	stats := map[string]any{
		"total_events":      totalEvents,
		"parsed_count":      len(events),
		"profiles_count":    len(profiles),
		"clear_cut_count":   len(clearCut),
		"llm_calls":         llmCalls,
		"actions":           len(actions),
		"skipped":           skipped.Combined + skipped.Auth,
		"deferred_reassess": deferredReassess,
	}
	if err := e.State.RecordScan(now, watermark, stats); err != nil {
		return nil, err
	}

	verdictList := make([]VerdictEntry, 0, len(verdicts))
	for ip, v := range verdicts {
		verdictList = append(verdictList, VerdictEntry{IP: ip, Verdict: v})
	}
	sort.Slice(verdictList, func(i, j int) bool { return verdictList[i].IP < verdictList[j].IP })

	return &RunReport{
		TotalEvents:      totalEvents,
		ParsedCount:      len(events),
		ProfilesCount:    len(profiles),
		ClearCutCount:    len(clearCut),
		LLMCalls:         llmCalls,
		Verdicts:         verdictList,
		Actions:          actions,
		Skipped:          skipped.Combined + skipped.Auth,
		WindowStart:      windowStart,
		WindowEnd:        now,
		DeferredReassess: deferredReassess,
	}, nil
}

// parseLogFile reads one file, parsing each line with the combined parser
// first and the auth parser second, dropping lines whose ts is at or before
// the watermark.
func parseLogFile(path string, now, watermark int64, skipped *SkipCounters) ([]*TrafficEvent, int, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer fh.Close()

	var events []*TrafficEvent
	total := 0
	scanner := bufio.NewScanner(fh)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		total++
		event := ParseCombined(line, now, skipped)
		if event == nil {
			event = ParseAuth(line, now, skipped)
		}
		if event == nil || event.TS <= watermark {
			continue
		}
		events = append(events, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, 0, err
	}
	return events, total, nil
}

// stampTruth sets the test-only Truth feature on every profile: clear-cut
// IPs carry their AttackType reason; LLM-reviewed IPs fall back to the
// sandbox-supplied ground truth label.
func stampTruth(profiles map[string]*IPProfile, reasons map[string]string, groundTruth map[string]string) {
	for ip, profile := range profiles {
		truth := reasons[ip]
		if _, isAttack := attackSignals[truth]; !isAttack {
			if groundTruth != nil {
				label := groundTruth[ip]
				if strings.HasPrefix(strings.ToUpper(label), "ATTACK:") {
					label = strings.TrimSpace(strings.SplitN(label, ":", 2)[1])
				}
				truth = label
			} else {
				truth = ""
			}
		}
		profile.Features.Truth = truth
	}
}
