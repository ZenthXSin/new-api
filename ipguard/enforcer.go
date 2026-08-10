package ipguard

// Enforcement backends. The decider produces BanRecords; the enforcer makes
// those decisions take effect. Enforcer is the common interface,
// SimulatedEnforcer is the in-memory dry-run backend, and IptablesEnforcer
// drives the real iptables tool when the operator disables dry-run. Ported
// from llm-ipguard's enforcer.py.

import (
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// Enforcer is the interface for ban enforcement backends.
type Enforcer interface {
	// Ban bans ip for durationSeconds seconds, citing reason.
	Ban(ip string, durationSeconds int64, reason string)
	// Unban removes the ban on ip, citing reason.
	Unban(ip string, reason string)
	// IsBanned is true while ip has a ban whose expiry is still in the future.
	IsBanned(ip string) bool
	// BannedIPs returns currently banned IPs, sorted ascending.
	BannedIPs() []string
	// ExpiredBans returns IPs whose ban has expired but was never lifted.
	ExpiredBans(now int64) []string
	// RealArmed reports whether the enforcer actually touches the system
	// firewall (false for dry-run/simulated backends).
	RealArmed() bool
}

// SimulatedEnforcer is the in-memory enforcer for dry runs; nothing leaves
// the process. Bans live in a map ip -> {until, reason}.
type SimulatedEnforcer struct {
	mu    sync.Mutex
	clock func() time.Time
	bans  map[string]banEntry
}

type banEntry struct {
	until  int64
	reason string
}

// NewSimulatedEnforcer returns a dry-run enforcer with the given clock.
func NewSimulatedEnforcer(clock func() time.Time) *SimulatedEnforcer {
	if clock == nil {
		clock = time.Now
	}
	return &SimulatedEnforcer{clock: clock, bans: map[string]banEntry{}}
}

func (e *SimulatedEnforcer) now() int64 { return e.clock().Unix() }

func (e *SimulatedEnforcer) Ban(ip string, durationSeconds int64, reason string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.bans[ip] = banEntry{until: e.now() + durationSeconds, reason: reason}
}

func (e *SimulatedEnforcer) Unban(ip string, reason string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.bans, ip)
}

func (e *SimulatedEnforcer) IsBanned(ip string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	entry, ok := e.bans[ip]
	return ok && e.now() < entry.until
}

func (e *SimulatedEnforcer) BannedIPs() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	ips := make([]string, 0, len(e.bans))
	for ip, entry := range e.bans {
		if now < entry.until {
			ips = append(ips, ip)
		}
	}
	sort.Strings(ips)
	return ips
}

func (e *SimulatedEnforcer) ExpiredBans(now int64) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var ips []string
	for ip, entry := range e.bans {
		if now >= entry.until {
			ips = append(ips, ip)
		}
	}
	sort.Strings(ips)
	return ips
}

func (e *SimulatedEnforcer) RealArmed() bool { return false }

// IptablesEnforcer enforces via the iptables command. In dry-run mode no
// subprocess is ever spawned: the intended command is printed loudly and only
// an event is recorded. Real mode requires root unless a custom enforce
// command (e.g. an ssh hop to the host) is configured, and runs
// "<cmd> -I/-D INPUT -s <ip> -j DROP", capturing output instead of leaking
// it to the log.
type IptablesEnforcer struct {
	mu     sync.Mutex
	clock  func() time.Time
	dryRun bool
	cmd    []string
	bans   map[string]banEntry
	// realArmed is true when this instance may touch the firewall.
	realArmed bool
}

// NewIptablesEnforcer builds the enforcer. enforceCommand defaults to
// "iptables". Real mode requires root (os.Geteuid() == 0) unless
// enforceCommand is not the plain iptables binary, in which case the operator
// explicitly configured an external execution path.
func NewIptablesEnforcer(clock func() time.Time, dryRun bool, enforceCommand string) (*IptablesEnforcer, error) {
	if clock == nil {
		clock = time.Now
	}
	cmd := strings.Fields(enforceCommand)
	if len(cmd) == 0 {
		cmd = []string{"iptables"}
	}
	if !dryRun && cmd[0] == "iptables" && os.Geteuid() != 0 {
		return nil, &PermissionError{}
	}
	return &IptablesEnforcer{
		clock:     clock,
		dryRun:    dryRun,
		cmd:       cmd,
		bans:      map[string]banEntry{},
		realArmed: !dryRun,
	}, nil
}

// PermissionError reports a missing root requirement for real enforcement.
type PermissionError struct{}

func (e *PermissionError) Error() string { return "real enforcement requires root when using iptables" }

func (e *IptablesEnforcer) now() int64 { return e.clock().Unix() }

func (e *IptablesEnforcer) apply(args ...string) {
	full := append(append([]string{}, e.cmd...), args...)
	if e.dryRun {
		//nolint:forbidigo // loud dry-run banner mirrors the Python original
		println("[DRY-RUN] would run: " + strings.Join(full, " "))
		return
	}
	//nolint:gosec // command and args are operator-configured
	_ = exec.Command(full[0], full[1:]...).Run()
}

// ruleExists reports whether the DROP rule for ip is already installed, so
// re-seeding (engine restart, config change) never duplicates firewall rules.
func (e *IptablesEnforcer) ruleExists(ip string) bool {
	if e.dryRun {
		return false
	}
	full := append(append([]string{}, e.cmd...), "-C", "INPUT", "-s", ip, "-j", "DROP")
	//nolint:gosec // command and args are operator-configured
	err := exec.Command(full[0], full[1:]...).Run()
	return err == nil
}

func (e *IptablesEnforcer) Ban(ip string, durationSeconds int64, reason string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.ruleExists(ip) {
		e.apply("-I", "INPUT", "-s", ip, "-j", "DROP")
	}
	e.bans[ip] = banEntry{until: e.now() + durationSeconds, reason: reason}
}

func (e *IptablesEnforcer) Unban(ip string, reason string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.apply("-D", "INPUT", "-s", ip, "-j", "DROP")
	delete(e.bans, ip)
}

func (e *IptablesEnforcer) IsBanned(ip string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	entry, ok := e.bans[ip]
	return ok && e.now() < entry.until
}

func (e *IptablesEnforcer) BannedIPs() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	ips := make([]string, 0, len(e.bans))
	for ip, entry := range e.bans {
		if now < entry.until {
			ips = append(ips, ip)
		}
	}
	sort.Strings(ips)
	return ips
}

func (e *IptablesEnforcer) ExpiredBans(now int64) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var ips []string
	for ip, entry := range e.bans {
		if now >= entry.until {
			ips = append(ips, ip)
		}
	}
	sort.Strings(ips)
	return ips
}

func (e *IptablesEnforcer) RealArmed() bool { return e.realArmed }

// MakeEnforcer returns the enforcer dictated by the config: the simulated
// backend while DryRun is on, the iptables backend otherwise (which also
// requires EnforceReal to be explicitly enabled).
func MakeEnforcer(config Config, clock func() time.Time) (Enforcer, error) {
	if config.DryRun || !config.EnforceReal {
		return NewSimulatedEnforcer(clock), nil
	}
	return NewIptablesEnforcer(clock, false, config.EnforceCommand)
}
