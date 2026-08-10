package ipguard

// Shared test helpers: deterministic timestamps, log-line builders and an
// in-memory StateStore for engine tests. Ported from llm-ipguard's sandbox
// harness.

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// baseTS is the fixed epoch base for deterministic timestamps.
const baseTS int64 = 1_700_000_000

// fakeClock is a callable clock with a mutable time.
type fakeClock struct {
	t int64
}

func newFakeClock(t int64) *fakeClock { return &fakeClock{t: t} }

func (c *fakeClock) Unix() int64      { return c.t }
func (c *fakeClock) advance(dt int64) { c.t += dt }

// combinedLine builds one combined access log line.
func combinedLine(ts int64, ip, path string, ua string, status int) string {
	if path == "" {
		path = "/"
	}
	if ua == "" {
		ua = "-"
	}
	lt := time.Unix(ts, 0).UTC().Format("02/Jan/2006:15:04:05 -0700")
	return fmt.Sprintf(`%s - - [%s] "GET %s HTTP/1.1" %d 1234 "-" "%s"`, ip, lt, path, status, ua)
}

// authLine builds one sshd auth log line.
func authLine(ts int64, ip string, result string) string {
	lt := time.Unix(ts, 0).UTC().Format("Jan _2 15:04:05")
	detail := fmt.Sprintf("Failed password for root from %s port 22 ssh2", ip)
	if result == "accepted" {
		detail = fmt.Sprintf("Accepted password for root from %s port 22 ssh2", ip)
	}
	return fmt.Sprintf("%s host sshd[1234]: %s", lt, detail)
}

// makeProfile builds an IPProfile from feature overrides.
func makeProfile(ip string, feats IPFeatures) *IPProfile {
	return &IPProfile{IP: ip, Features: feats}
}

// makeBaseFeatures returns the zero feature set (like the Python helper).
func makeBaseFeatures() IPFeatures { return IPFeatures{} }

// writeLog writes lines to path (like the Python harness).
func writeLog(path string, lines []string) error {
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// memoryState is an in-memory StateStore for engine tests.
type memoryState struct {
	mu        sync.Mutex
	watermark int64
	scans     []scanRow
	bans      []BanRecord
	decisions []decisionRow
}

type scanRow struct {
	ts        int64
	watermark int64
	stats     map[string]any
}

type decisionRow struct {
	ts      int64
	ip      string
	verdict LLMVerdict
	action  DecisionAction
	reason  string
}

func newMemoryState() *memoryState { return &memoryState{} }

func (s *memoryState) LastWatermark() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.watermark, nil
}

func (s *memoryState) RecordScan(ts, watermark int64, stats map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.watermark = watermark
	s.scans = append(s.scans, scanRow{ts: ts, watermark: watermark, stats: stats})
	return nil
}

func (s *memoryState) RecordBan(record BanRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bans = append(s.bans, record)
	return nil
}

func (s *memoryState) RecordDecision(ts int64, ip string, verdict LLMVerdict, action DecisionAction, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.decisions = append(s.decisions, decisionRow{ts: ts, ip: ip, verdict: verdict, action: action, reason: reason})
	return nil
}

func (s *memoryState) BansSince(ts int64) ([]BanRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]BanRecord, 0, len(s.bans))
	for _, r := range s.bans {
		if r.TS >= ts {
			out = append(out, r)
		}
	}
	return out, nil
}
