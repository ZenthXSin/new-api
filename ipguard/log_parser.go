package ipguard

// Parsers for nginx/apache combined access logs and sshd auth logs, ported
// from llm-ipguard's log_parser.py.

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Combined access log line:
//
//	1.2.3.4 - - [09/Aug/2026:10:00:00 +0000] "GET /path HTTP/1.1" 200 123 "-" "UA"
var combinedRe = regexp.MustCompile(
	`^(?P<ip>\S+) \S+ \S+ \[(?P<logts>[^\]]+)\] ` +
		`"(?P<method>\S+) (?P<path>\S+)(?:\s+\S+)?" (?P<status>\d{3}) (?P<size>\S+) ` +
		`"(?P<referer>[^"]*)" "(?P<ua>[^"]*)"\s*$`,
)

// Bracket timestamp format, fixed to the +0000 offset per the log contract.
const logTSFormat = "02/Jan/2006:15:04:05 -0700"

var authIPRe = regexp.MustCompile(`from (\d+\.\d+\.\d+\.\d+)`)
var authResultRe = regexp.MustCompile(`(?i)\b(failed|accepted)\b`)

// Auth log line timestamp: "Aug  8 06:57:16 host sshd[4070]: ...".
var authTSRe = regexp.MustCompile(
	`^(?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{1,2})\s+` +
		`(?P<hour>\d{2}):(?P<minute>\d{2}):(?P<second>\d{2})`,
)

var authMonths = map[string]int{
	"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
	"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

// SkipCounters are incremented whenever a line is unparsable and therefore
// dropped. Keyed by parser name.
type SkipCounters struct {
	Combined int
	Auth     int
}

// kvDetail builds the deterministic key=value detail string for web events.
func kvDetail(method, path, status, size, referer, ua string) string {
	return "method=" + method + " path=" + path + " status=" + status +
		" size=" + size + ` referer="` + referer + `" ua="` + ua + `"`
}

// ParseCombined parses an nginx/apache combined access log line. Returns a
// TrafficEvent with Kind "web" and a key=value detail string, or nil
// (incrementing the skipped counter) for non-matching lines. The bracket
// timestamp is parsed to epoch (UTC); the passed now is the fallback when the
// bracket cannot be parsed.
func ParseCombined(line string, now int64, skipped *SkipCounters) *TrafficEvent {
	m := combinedRe.FindStringSubmatch(line)
	if m == nil {
		skipped.Combined++
		return nil
	}
	ip := m[combinedRe.SubexpIndex("ip")]
	logts := m[combinedRe.SubexpIndex("logts")]
	method := m[combinedRe.SubexpIndex("method")]
	path := m[combinedRe.SubexpIndex("path")]
	status := m[combinedRe.SubexpIndex("status")]
	size := m[combinedRe.SubexpIndex("size")]
	referer := m[combinedRe.SubexpIndex("referer")]
	ua := m[combinedRe.SubexpIndex("ua")]

	ts := now
	if t, err := time.Parse(logTSFormat, logts); err == nil {
		ts = t.Unix()
	}
	return &TrafficEvent{
		TS:      ts,
		IP:      ip,
		Service: "web",
		Kind:    "web",
		Detail:  kvDetail(method, path, status, size, referer, ua),
		Raw:     line,
	}
}

// ParseAuth parses an sshd auth.log line (Failed/Accepted password). Returns
// a TrafficEvent with Kind "ssh" and Detail "failed" or "accepted", or nil
// for non-matching lines. The syslog-style prefix timestamp is parsed with
// *now*'s year and returned as the event epoch; unparsable prefixes fall back
// to *now*.
func ParseAuth(line string, now int64, skipped *SkipCounters) *TrafficEvent {
	if !strings.Contains(line, "sshd") {
		skipped.Auth++
		return nil
	}
	m := authIPRe.FindStringSubmatch(line)
	if m == nil {
		skipped.Auth++
		return nil
	}
	r := authResultRe.FindStringSubmatch(line)
	if r == nil {
		skipped.Auth++
		return nil
	}
	return &TrafficEvent{
		TS:      parseAuthTS(line, now),
		IP:      m[1],
		Service: "sshd",
		Kind:    "ssh",
		Detail:  strings.ToLower(r[0]),
		Raw:     line,
	}
}

// parseAuthTS returns the epoch of the auth line's syslog timestamp, or
// *fallback*. The prefix carries no year, so the year of *fallback* (the scan
// time) is assumed; when that lands in the future (a New Year's midnight
// boundary), the previous year is used. Day-of-month validation keeps
// malformed lines on the fallback path.
func parseAuthTS(line string, fallback int64) int64 {
	m := authTSRe.FindStringSubmatch(line)
	if m == nil {
		return fallback
	}
	year := time.Unix(fallback, 0).UTC().Year()
	day, err := strconv.Atoi(m[authTSRe.SubexpIndex("day")])
	if err != nil {
		return fallback
	}
	month := authMonths[strings.ToLower(m[authTSRe.SubexpIndex("mon")])]
	if month == 0 || day < 1 || day > 31 {
		return fallback
	}
	hour, _ := strconv.Atoi(m[authTSRe.SubexpIndex("hour")])
	minute, _ := strconv.Atoi(m[authTSRe.SubexpIndex("minute")])
	second, _ := strconv.Atoi(m[authTSRe.SubexpIndex("second")])
	candidate := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC).Unix()
	if candidate > fallback {
		candidate = time.Date(year-1, time.Month(month), day, hour, minute, second, 0, time.UTC).Unix()
	}
	return candidate
}
