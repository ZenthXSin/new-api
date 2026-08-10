package ipguard

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func engineConfig() Config {
	cfg := DefaultConfig()
	cfg.Whitelist = []string{"127.0.0.1"}
	return cfg
}

func TestEngineWatermarkSkipsAlreadySeenLines(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "day.log")
	clock := newFakeClock(baseTS)

	state := newMemoryState()
	// Pre-seed: everything at/below this watermark is "already seen".
	if err := state.RecordScan(baseTS+3600, baseTS+3600, map[string]any{"parsed": 0}); err != nil {
		t.Fatal(err)
	}
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	engine, err := NewEngine(engineConfig(), state, enforcer, NewMockLLM(7), func() time.Time { return time.Unix(clock.Unix(), 0) })
	if err != nil {
		t.Fatal(err)
	}

	// Run 1: lines at/below the watermark are skipped as already seen.
	lines := []string{
		combinedLine(baseTS+3600, "10.0.0.1", "/", "-", 200),
		combinedLine(baseTS+2000, "10.0.0.9", "/", "-", 200),
	}
	if err := writeLog(logPath, lines); err != nil {
		t.Fatal(err)
	}
	clock.t = baseTS + 7200
	r1, err := engine.RunOnce([]string{logPath}, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r1.TotalEvents != 2 {
		t.Errorf("total_events = %d, want 2", r1.TotalEvents)
	}
	if r1.ParsedCount != 0 {
		t.Errorf("parsed_count = %d, want 0", r1.ParsedCount)
	}

	// Run 2: append one fresh line above the watermark.
	lines = append(lines, combinedLine(baseTS+7300, "10.0.0.2", "/api?x=1;waitfor;--", "-", 200))
	if err := writeLog(logPath, lines); err != nil {
		t.Fatal(err)
	}
	clock.t = baseTS + 10800
	r2, err := engine.RunOnce([]string{logPath}, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r2.TotalEvents != 3 {
		t.Errorf("total_events = %d, want 3", r2.TotalEvents)
	}
	if r2.ParsedCount != 1 {
		t.Errorf("parsed_count = %d, want 1", r2.ParsedCount)
	}
	if r2.ProfilesCount != 1 {
		t.Errorf("profiles_count = %d, want 1", r2.ProfilesCount)
	}
	found := false
	for _, v := range r2.Verdicts {
		if v.IP == "10.0.0.2" {
			found = true
		}
	}
	if !found {
		t.Errorf("verdicts missing 10.0.0.2: %+v", r2.Verdicts)
	}
}

func TestEngineMockFullScanClearCutBans(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "day.log")
	clock := newFakeClock(baseTS + 3600)
	state := newMemoryState()
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	engine, err := NewEngine(engineConfig(), state, enforcer, NewMockLLM(7), func() time.Time { return time.Unix(clock.Unix(), 0) })
	if err != nil {
		t.Fatal(err)
	}

	var lines []string
	for i := 0; i < 6; i++ {
		lines = append(lines, authLine(baseTS+100+int64(i*60), "10.0.0.1", "failed"))
	}
	if err := writeLog(logPath, lines); err != nil {
		t.Fatal(err)
	}
	report, err := engine.RunOnce([]string{logPath}, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.ProfilesCount < 1 {
		t.Errorf("profiles_count = %d, want >= 1", report.ProfilesCount)
	}
	if report.ClearCutCount < 1 {
		t.Errorf("clear_cut_count = %d, want >= 1", report.ClearCutCount)
	}
	if report.LLMCalls != 0 {
		t.Errorf("llm_calls = %d, want 0 (clear-cut needs no LLM)", report.LLMCalls)
	}
	banned := false
	for _, a := range report.Actions {
		if a.Action == ActionBan {
			banned = true
		}
	}
	if !banned {
		t.Errorf("no ban action in %+v", report.Actions)
	}
	if !engine.Enforcer.IsBanned("10.0.0.1") {
		t.Error("10.0.0.1 should be banned")
	}
}

func TestEngineDefersReassessmentWithinDay(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "day.log")
	clock := newFakeClock(baseTS + 3600)
	state := newMemoryState()
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	engine, err := NewEngine(engineConfig(), state, enforcer, NewMockLLM(7), func() time.Time { return time.Unix(clock.Unix(), 0) })
	if err != nil {
		t.Fatal(err)
	}

	// 40 requests in one hour -> SUSPICIOUS -> needs LLM review.
	var lines []string
	for i := 0; i < 40; i++ {
		lines = append(lines, combinedLine(baseTS+60+int64(i), "10.9.9.9", "/", "-", 200))
	}
	if err := writeLog(logPath, lines); err != nil {
		t.Fatal(err)
	}
	r1, err := engine.RunOnce([]string{logPath}, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r1.LLMCalls < 1 {
		t.Errorf("first run llm_calls = %d, want >= 1", r1.LLMCalls)
	}

	// 3h later the same IP is still active.
	for i := 0; i < 40; i++ {
		lines = append(lines, combinedLine(baseTS+11500+int64(i), "10.9.9.9", "/", "-", 200))
	}
	if err := writeLog(logPath, lines); err != nil {
		t.Fatal(err)
	}
	clock.t = baseTS + 3600 + 3*3600
	r2, err := engine.RunOnce([]string{logPath}, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r2.DeferredReassess < 1 {
		t.Errorf("deferred_reassess = %d, want >= 1", r2.DeferredReassess)
	}
	if r2.LLMCalls != 0 {
		t.Errorf("second run llm_calls = %d, want 0", r2.LLMCalls)
	}
}

func TestEngineBreaksOutOfBatchesOnLLMLimit(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "day.log")
	clock := newFakeClock(baseTS + 3600)
	state := newMemoryState()

	cfg := engineConfig()
	cfg.LLMBatchSize = 1
	cfg.LLMMaxCallsPerRun = 1
	cfg.Heuristics.LLMTotalThreshold = 1

	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"ip":"10.0.0.0","verdict":"benign"}]`))
	})
	cfg.LLMBaseURL = server.URL
	cfg.LLMToken = "sk-test-key"

	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	engine, err := NewEngine(cfg, state, enforcer, nil, func() time.Time { return time.Unix(clock.Unix(), 0) })
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for i := 0; i < 2; i++ {
		lines = append(lines, combinedLine(baseTS+10+int64(i), "10.0.0."+string(rune('0'+i)), "/", "-", 200))
	}
	if err := writeLog(logPath, lines); err != nil {
		t.Fatal(err)
	}
	report, err := engine.RunOnce([]string{logPath}, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.LLMCalls != 1 { // second batch hit the cap and broke out
		t.Errorf("llm_calls = %d, want 1", report.LLMCalls)
	}
	if report.ClearCutCount != 0 {
		t.Errorf("clear_cut_count = %d, want 0", report.ClearCutCount)
	}
}

func TestEngineExpiredBansLifted(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "day.log")
	clock := newFakeClock(baseTS + 3600)
	state := newMemoryState()
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	engine, err := NewEngine(engineConfig(), state, enforcer, NewMockLLM(7), func() time.Time { return time.Unix(clock.Unix(), 0) })
	if err != nil {
		t.Fatal(err)
	}

	// 6 failed SSH logins -> clear-cut ban (duration suspect=900s).
	var lines []string
	for i := 0; i < 6; i++ {
		lines = append(lines, authLine(baseTS+100+int64(i*60), "10.0.0.1", "failed"))
	}
	if err := writeLog(logPath, lines); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.RunOnce([]string{logPath}, 0, nil); err != nil {
		t.Fatal(err)
	}
	if !engine.Enforcer.IsBanned("10.0.0.1") {
		t.Fatal("expected banned after scan")
	}

	// 7h later the ban (malicious = 21600s, expiring at baseTS+25200) has
	// expired; a new scan must lift it.
	clock.t = baseTS + 25200 + 60
	var fresh []string
	for i := 0; i < 6; i++ {
		fresh = append(fresh, authLine(baseTS+25200+60+int64(i*60), "10.0.0.2", "failed"))
	}
	if err := writeLog(logPath, fresh); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.RunOnce([]string{logPath}, 0, nil); err != nil {
		t.Fatal(err)
	}
	if engine.Enforcer.IsBanned("10.0.0.1") {
		t.Error("expired ban should have been lifted")
	}
}

// TestDaySimulationDetectionAndFPR is the ported sandbox day simulation:
// one hourly scan per 24h with a deterministic MockLLM, asserting detection
// rate and false-positive rate bounds plus the LLM call budget.
func TestDaySimulationDetectionAndFPR(t *testing.T) {
	start, end := baseTS, baseTS+86400
	day := generateDay(2000, 7, start, end)
	dir := t.TempDir()
	logPath := filepath.Join(dir, "day1.log")
	if err := writeLog(logPath, day.lines); err != nil {
		t.Fatal(err)
	}

	clock := newFakeClock(start)
	state := newMemoryState()
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	engine, err := NewEngine(engineConfig(), state, enforcer, NewMockLLM(7), func() time.Time { return time.Unix(clock.Unix(), 0) })
	if err != nil {
		t.Fatal(err)
	}

	llmCalls, bans, escalations, unbans := 0, 0, 0, 0
	banned := map[string]bool{}
	for now := start; now < end; now += 3600 {
		clock.t = now
		report, err := engine.RunOnce([]string{logPath}, 0, day.groundTruth)
		if err != nil {
			t.Fatal(err)
		}
		llmCalls += report.LLMCalls
		for _, rec := range report.Actions {
			switch rec.Action {
			case ActionBan:
				bans++
				banned[rec.IP] = true
			case ActionEscalate:
				escalations++
				banned[rec.IP] = true
			case ActionUnban:
				unbans++
				delete(banned, rec.IP)
			}
		}
	}

	var attack, normal []string
	for ip, label := range day.groundTruth {
		if len(label) >= 7 && label[:7] == "ATTACK:" {
			attack = append(attack, ip)
		} else {
			normal = append(normal, ip)
		}
	}
	tp, fp, fn := 0, 0, 0
	for _, ip := range attack {
		if banned[ip] {
			tp++
		} else {
			fn++
		}
	}
	for _, ip := range normal {
		if banned[ip] {
			fp++
		}
	}
	tn := len(normal) - fp
	detectionRate := 0.0
	if tp+fn > 0 {
		detectionRate = float64(tp) / float64(tp+fn)
	}
	fpr := 0.0
	if fp+tn > 0 {
		fpr = float64(fp) / float64(fp+tn)
	}
	t.Logf("day sim: tp=%d fn=%d fp=%d tn=%d detection=%.3f fpr=%.3f bans=%d esc=%d unbans=%d llm_calls=%d",
		tp, fn, fp, tn, detectionRate, fpr, bans, escalations, unbans, llmCalls)

	if detectionRate < 0.85 {
		t.Errorf("detection_rate = %.3f, want >= 0.85", detectionRate)
	}
	if fpr > 0.05 {
		t.Errorf("fpr = %.3f, want <= 0.05", fpr)
	}
	if llmCalls > 50 {
		t.Errorf("llm_calls = %d, want <= 50", llmCalls)
	}
	if bans < 1 {
		t.Error("expected at least one ban")
	}
}

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
