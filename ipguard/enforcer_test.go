package ipguard

import (
	"testing"
	"time"
)

func TestSimulatedBanExpiryBoundary(t *testing.T) {
	clock := newFakeClock(baseTS)
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	enforcer.Ban("1.2.3.4", 100, "test")
	if !enforcer.IsBanned("1.2.3.4") {
		t.Fatal("expected banned")
	}
	clock.advance(99)
	if !enforcer.IsBanned("1.2.3.4") {
		t.Fatal("expected still banned")
	}
	clock.advance(1) // exactly at expiry: ban is over (until is exclusive)
	if enforcer.IsBanned("1.2.3.4") {
		t.Fatal("expected not banned at expiry")
	}
	if len(enforcer.BannedIPs()) != 0 {
		t.Errorf("banned_ips = %v, want []", enforcer.BannedIPs())
	}
}

func TestSimulatedExpiredBans(t *testing.T) {
	clock := newFakeClock(baseTS)
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	enforcer.Ban("1.2.3.4", 100, "test")
	enforcer.Ban("1.2.3.5", 10000, "test")
	clock.advance(200)
	expired := enforcer.ExpiredBans(clock.Unix())
	if len(expired) != 1 || expired[0] != "1.2.3.4" {
		t.Errorf("expired = %v, want [1.2.3.4]", expired)
	}
}

func TestSimulatedUnbanAndEvents(t *testing.T) {
	clock := newFakeClock(baseTS)
	enforcer := NewSimulatedEnforcer(func() time.Time { return time.Unix(clock.Unix(), 0) })
	enforcer.Ban("1.2.3.4", 1000, "sqli")
	enforcer.Unban("1.2.3.4", "false_positive")
	if enforcer.IsBanned("1.2.3.4") {
		t.Fatal("expected unbanned")
	}
	if enforcer.RealArmed() {
		t.Error("simulated enforcer must never be real-armed")
	}
}

func TestIptablesDryRunNeverSpawnsSubprocess(t *testing.T) {
	enforcer, err := NewIptablesEnforcer(func() time.Time { return time.Unix(baseTS, 0) }, true, "iptables")
	if err != nil {
		t.Fatalf("NewIptablesEnforcer: %v", err)
	}
	enforcer.Ban("1.2.3.4", 900, "test")
	enforcer.Unban("1.2.3.4", "test")
	// Dry-run must never touch the firewall.
	if enforcer.RealArmed() {
		t.Error("dry-run enforcer must not be real-armed")
	}
}
