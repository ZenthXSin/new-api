package service

// IPGuard scan execution: owns the persistent scan engine singleton (so
// cross-window cumulative counters, the LLM reassessment cadence and the
// per-day LLM call budget survive between scheduled runs), discovers log
// files and runs one scan pass.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/ipguard"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
)

// logGlobPatterns mirrors llm-ipguard's LOG_GLOB_PATTERNS.
var logGlobPatterns = []string{"access.log*", "access*.log", "auth.log*", "secure*"}

var (
	ipguardEngineMu sync.Mutex
	ipguardEngine   *ipguard.Engine
)

// RunIPGuardScanOnce runs one IPGuard scan pass over the configured log
// directory and returns the run report. The engine singleton is reused when
// the config is unchanged so in-memory cross-window state survives between
// scheduled runs; a config change (or first run) builds a fresh engine whose
// in-memory ban state is restored from the ban table.
func RunIPGuardScanOnce(ctx context.Context) (*ipguard.RunReport, error) {
	cfg := setting.GetIPGuardConfig()

	ipguardEngineMu.Lock()
	defer ipguardEngineMu.Unlock()

	engine, err := getOrCreateIPGuardEngine(cfg)
	if err != nil {
		return nil, err
	}

	now := time.Now().Unix()
	paths := discoverIPGuardLogs(cfg)
	if len(paths) == 0 {
		logger.LogWarn(ctx, "ipguard: no log files matched in "+cfg.LogDir+" (patterns: access.log*, access*.log, auth.log*, secure*)")
		report := &ipguard.RunReport{WindowStart: now - cfg.ScanWindow, WindowEnd: now}
		if err := engine.State.RecordScan(now, now-cfg.ScanWindow, map[string]any{
			"total_events": 0, "parsed_count": 0, "profiles_count": 0,
			"clear_cut_count": 0, "llm_calls": 0, "actions": 0,
			"skipped": 0, "deferred_reassess": 0, "no_logs": true,
		}); err != nil {
			return nil, err
		}
		return report, nil
	}

	report, err := engine.RunOnce(paths, now, nil)
	if err != nil {
		return nil, err
	}
	logger.LogInfo(ctx, fmt.Sprintf("ipguard: scan done events=%d profiles=%d clear_cut=%d llm_calls=%d actions=%d window=%d..%d",
		report.TotalEvents, report.ProfilesCount, report.ClearCutCount,
		report.LLMCalls, len(report.Actions), report.WindowStart, report.WindowEnd))
	return report, nil
}

// getOrCreateIPGuardEngine returns the cached engine, rebuilding it when the
// config changed. A rebuilt engine restores in-memory ban state from the
// ban table so config flips do not drop live bans.
func getOrCreateIPGuardEngine(cfg ipguard.Config) (*ipguard.Engine, error) {
	if ipguardEngine != nil && reflect.DeepEqual(ipguardEngine.Config, cfg) {
		return ipguardEngine, nil
	}
	engine, err := ipguard.NewEngine(cfg, model.IPGuardStateStore{}, nil, nil, time.Now)
	if err != nil {
		return nil, err
	}
	restoreIPGuardBans(engine)
	ipguardEngine = engine
	return engine, nil
}

// restoreIPGuardBans seeds a fresh engine's enforcer with the currently
// active bans from the ban table (remaining duration), so a restart or config
// change does not lose enforcement state. IptablesEnforcer skips rules that
// already exist, so re-seeding never duplicates firewall rules.
func restoreIPGuardBans(engine *ipguard.Engine) {
	active, err := model.GetActiveIPGuardBans()
	if err != nil {
		common.SysError("ipguard: failed to restore active bans: " + err.Error())
		return
	}
	now := time.Now().Unix()
	for _, record := range active {
		if engine.Enforcer.IsBanned(record.IP) {
			continue
		}
		remaining := record.TS + record.DurationSeconds - now
		if remaining > 0 {
			engine.Enforcer.Ban(record.IP, remaining, record.Reason)
		}
	}
}

// discoverIPGuardLogs returns the concrete log paths for the configured dir,
// sorted and deduped, matching the access/auth/secure glob patterns.
func discoverIPGuardLogs(cfg ipguard.Config) []string {
	seen := make(map[string]bool)
	var paths []string
	for _, pattern := range logGlobPatterns {
		matches, err := filepath.Glob(filepath.Join(cfg.LogDir, pattern))
		if err != nil {
			continue
		}
		for _, p := range matches {
			if !seen[p] {
				if info, err := os.Stat(p); err == nil && !info.IsDir() {
					seen[p] = true
					paths = append(paths, p)
				}
			}
		}
	}
	sort.Strings(paths)
	return paths
}

// IPGuardRealArmed reports whether the running engine's enforcer actually
// touches the system firewall (false in dry-run and before the first scan).
func IPGuardRealArmed() bool {
	ipguardEngineMu.Lock()
	defer ipguardEngineMu.Unlock()
	if ipguardEngine == nil {
		return false
	}
	return ipguardEngine.Enforcer.RealArmed()
}

// UnbanIPGuardIP manually lifts a ban (records an UNBAN decision in state and
// removes it from the active engine if one exists).
func UnbanIPGuardIP(ip string, reason string) error {
	now := time.Now().Unix()
	ipguardEngineMu.Lock()
	if ipguardEngine != nil && ipguardEngine.Enforcer.IsBanned(ip) {
		ipguardEngine.Enforcer.Unban(ip, reason)
	}
	ipguardEngineMu.Unlock()

	record := ipguard.BanRecord{IP: ip, Action: ipguard.ActionUnban, Reason: reason, TS: now}
	if err := (model.IPGuardStateStore{}).RecordBan(record); err != nil {
		return err
	}
	return (model.IPGuardStateStore{}).RecordDecision(now, ip, "", ipguard.ActionUnban, reason)
}
