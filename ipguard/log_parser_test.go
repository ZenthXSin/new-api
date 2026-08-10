package ipguard

import (
	"strings"
	"testing"
)

func TestParseCombinedURLEncodedSQLiPath(t *testing.T) {
	path := "/items.php?id=1%27%20OR%20%271%27%3D%271"
	line := combinedLine(baseTS, "10.1.1.2", path, "-", 200)
	skipped := &SkipCounters{}
	ev := ParseCombined(line, baseTS, skipped)
	if ev == nil {
		t.Fatal("expected event, got nil")
	}
	if ev.IP != "10.1.1.2" {
		t.Errorf("ip = %q, want 10.1.1.2", ev.IP)
	}
	if ev.Kind != "web" || ev.Service != "web" {
		t.Errorf("kind/service = %q/%q, want web/web", ev.Kind, ev.Service)
	}
	if !strings.Contains(ev.Detail, "path="+path) || !strings.Contains(ev.Detail, "method=GET") {
		t.Errorf("detail missing path/method: %q", ev.Detail)
	}
	if skipped.Combined != 0 {
		t.Errorf("skipped = %d, want 0", skipped.Combined)
	}
}

func TestParseCombinedRegularLine(t *testing.T) {
	line := combinedLine(baseTS, "203.0.113.7", "/index.html", "Mozilla/5.0", 200)
	skipped := &SkipCounters{}
	ev := ParseCombined(line, baseTS, skipped)
	if ev == nil {
		t.Fatal("expected event, got nil")
	}
	if ev.TS != baseTS {
		t.Errorf("ts = %d, want %d", ev.TS, baseTS)
	}
	if !strings.Contains(ev.Detail, `ua="Mozilla/5.0"`) {
		t.Errorf("detail missing ua: %q", ev.Detail)
	}
}

func TestParseCombinedMalformedLineSkipped(t *testing.T) {
	skipped := &SkipCounters{}
	ev := ParseCombined("this is not a combined log line at all", baseTS, skipped)
	if ev != nil {
		t.Fatalf("expected nil, got %+v", ev)
	}
	if skipped.Combined != 1 {
		t.Errorf("skipped = %d, want 1", skipped.Combined)
	}
}

func TestParseAuthFailedAndAccepted(t *testing.T) {
	skipped := &SkipCounters{}
	failed := ParseAuth(authLine(baseTS, "198.51.100.9", "failed"), baseTS, skipped)
	if failed == nil || failed.Kind != "ssh" || failed.Detail != "failed" || failed.IP != "198.51.100.9" {
		t.Fatalf("unexpected failed event: %+v", failed)
	}
	accepted := ParseAuth(authLine(baseTS, "198.51.100.9", "accepted"), baseTS, skipped)
	if accepted == nil || accepted.Detail != "accepted" {
		t.Fatalf("unexpected accepted event: %+v", accepted)
	}
	if skipped.Auth != 0 {
		t.Errorf("skipped = %d, want 0", skipped.Auth)
	}
}

func TestParseAuthNonSshdLineSkipped(t *testing.T) {
	skipped := &SkipCounters{}
	ev := ParseAuth("Aug  9 00:00:00 host cron[42]: failed something from 1.2.3.4", baseTS, skipped)
	if ev != nil {
		t.Fatalf("expected nil, got %+v", ev)
	}
	if skipped.Auth != 1 {
		t.Errorf("skipped = %d, want 1", skipped.Auth)
	}
}

func TestParseAuthLineWithoutIPSkipped(t *testing.T) {
	skipped := &SkipCounters{}
	ev := ParseAuth("Aug  9 00:00:00 host sshd[42]: Failed password", baseTS, skipped)
	if ev != nil {
		t.Fatalf("expected nil, got %+v", ev)
	}
	if skipped.Auth != 1 {
		t.Errorf("skipped = %d, want 1", skipped.Auth)
	}
}
