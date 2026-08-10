package ipguard

// Per-IP feature aggregation over raw events. Pure functions only: given the
// same events and window bounds, the same profiles are produced. Ported from
// llm-ipguard's features.py.

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	// Attack-signature regexes (case-insensitive), matched against the event's
	// kv detail string and its raw line.
	sqliRe = regexp.MustCompile(
		`(?i)(\bunion\s+select\b|or\s+1=1|'\s*or\s*'|--\s|/\*!|\bwaitfor\b|sleep\()`)
	xssRe = regexp.MustCompile(
		`(?i)(<script|</script>|onerror\s*=|javascript:|onload\s*=|alert\()`)
	traversalRe = regexp.MustCompile(
		`(?i)(\.\./|\.\.%2f|\.\.%5c|/etc/passwd|/etc/shadow)`)

	// User-agent bot classification.
	botUARe = regexp.MustCompile(
		`(?i)(bot|crawler|spider|python-requests|curl|wget|nmap|masscan|scanner)`)

	// Source port inside ssh raw lines ("from 1.2.3.4 port 22 ssh2").
	portRe = regexp.MustCompile(`port\s+(\d+)`)

	// UA emitted by log_parser kv detail strings: ua="<ua>".
	uaRe = regexp.MustCompile(`ua="([^"]*)"`)

	// Key=value pairs in web kv detail strings:
	//   method=POST path=/login status=401 size=1234 referer="-" ua="Mozilla/5.0"
	// Quoted values may contain spaces; bare values are non-space tokens.
	kvRe = regexp.MustCompile(`(\w+)=(?:"([^"]*)"|(\S+))`)
)

const (
	minRatePerMin = 1e-6
	maxEvidence   = 8
)

// emptyFeatures returns a zero-valued feature set.
func emptyFeatures() IPFeatures { return IPFeatures{} }

// parseKV parses key=value pairs from a kv detail string (lowercased keys).
// Absent keys are simply absent from the result.
func parseKV(detail string) map[string]string {
	out := make(map[string]string)
	for _, m := range kvRe.FindAllStringSubmatch(detail, -1) {
		key := strings.ToLower(m[1])
		if m[2] != "" {
			out[key] = m[2]
		} else {
			out[key] = m[3]
		}
	}
	return out
}

// uaFromEvent best-effort UA extraction: kv detail first, then the raw line.
func uaFromEvent(event *TrafficEvent) string {
	for _, source := range []string{event.Detail, event.Raw} {
		m := uaRe.FindStringSubmatch(source)
		if m == nil {
			continue
		}
		if ua := m[1]; ua != "" && ua != "-" {
			return ua
		}
	}
	return ""
}

// signatureHit reports whether a signature regex matches the event's detail
// or raw line.
func signatureHit(re *regexp.Regexp, event *TrafficEvent) bool {
	return re.MatchString(event.Detail) || re.MatchString(event.Raw)
}

// AggregateIPs buckets events by IP and computes per-IP features. Events
// outside [windowStart, windowEnd] are skipped. Every IP is retained
// (loopback included; whitelisting is the decider's job). Evidence holds up
// to the 8 most recent raw lines per IP, sorted by ts.
func AggregateIPs(events []*TrafficEvent, windowStart, windowEnd int64) map[string]*IPProfile {
	feats := make(map[string]*IPFeatures)
	uas := make(map[string]map[string]struct{})
	ports := make(map[string]map[string]struct{})
	evidence := make(map[string][]tracedLine)
	lastUA := make(map[string]string) // ip -> lowercase ua

	for _, ev := range events {
		if ev.TS < windowStart || ev.TS > windowEnd {
			continue
		}
		ip := ev.IP
		feat := feats[ip]
		if feat == nil {
			feat = new(IPFeatures)
			feats[ip] = feat
			uas[ip] = make(map[string]struct{})
			ports[ip] = make(map[string]struct{})
			evidence[ip] = nil
		}

		feat.TotalRequests++
		switch {
		case ev.Kind == "ssh" && ev.Detail == "failed":
			feat.FailedLogins++
		case ev.Kind == "ssh" && ev.Detail == "accepted":
			feat.AcceptedLogins++
		}

		if ev.Kind == "web" {
			kv := parseKV(ev.Detail)
			method := strings.ToUpper(kv["method"])
			path := strings.ToLower(kv["path"])
			status := 0
			if s, err := parseStatus(kv["status"]); err == nil {
				status = s
			}
			if method == "POST" && strings.Contains(path, "login") && status >= 400 {
				feat.WebFailedLogins++
			}
		}

		if signatureHit(sqliRe, ev) {
			feat.SQLAttempts++
		}
		if signatureHit(xssRe, ev) {
			feat.XSSAttempts++
		}
		if signatureHit(traversalRe, ev) {
			feat.TraversalAttempts++
		}

		if ua := uaFromEvent(ev); ua != "" {
			uas[ip][ua] = struct{}{}
			if botUARe.MatchString(ua) {
				feat.IsBotUA = true
			}
			lastUA[ip] = strings.ToLower(ua)
		}

		for _, m := range portRe.FindAllStringSubmatch(ev.Raw, -1) {
			ports[ip][m[1]] = struct{}{}
		}
		for _, m := range portRe.FindAllStringSubmatch(ev.Detail, -1) {
			ports[ip][m[1]] = struct{}{}
		}

		evidence[ip] = append(evidence[ip], tracedLine{ts: ev.TS, raw: ev.Raw})
	}

	minutes := float64(windowEnd-windowStart) / 60.0
	if minutes < minRatePerMin {
		minutes = minRatePerMin
	}

	profiles := make(map[string]*IPProfile, len(feats))
	for ip, feat := range feats {
		feat.UniqueUAs = len(uas[ip])
		feat.PortsSeen = len(ports[ip])
		feat.UALower = lastUA[ip]
		rate := float64(feat.TotalRequests) / minutes
		if rate < minRatePerMin {
			rate = minRatePerMin
		}
		feat.RatePerMin = rate

		lines := evidence[ip]
		sort.Slice(lines, func(i, j int) bool { return lines[i].ts < lines[j].ts })
		n := len(lines) - maxEvidence
		if n < 0 {
			n = 0
		}
		var evLines []string
		for _, l := range lines[n:] {
			evLines = append(evLines, l.raw)
		}
		profiles[ip] = &IPProfile{
			IP:       ip,
			Features: *feat,
			Evidence: evLines,
		}
	}
	return profiles
}

type tracedLine struct {
	ts  int64
	raw string
}

func parseStatus(s string) (int, error) {
	return strconv.Atoi(s)
}
