package common

import (
	"crypto/tls"
	"net/http/httptrace"
	"sync"
	"time"
)

const maxPreValidWriteTimes = 64

// RelayTiming is the request-scoped timing collector used by relay consume logs.
// It is deliberately independent of relay/common so it can be attached by
// middleware before authentication and consumed by the relay adapters later.
type RelayTiming struct {
	mu                              sync.Mutex
	start                           time.Time
	attemptStart                    time.Time
	generation                      uint64
	dnsStart, tcpStart, tlsStart    time.Time
	dns, tcp, tls                   time.Duration
	reused                          bool
	traceFirst                      time.Time
	validFirst                      time.Time
	downstreamFirst, downstreamLast time.Time
	writes                          []time.Time
	postValidWrite                  time.Time
	sentBytes                       int64
	writeError                      bool
	endStatus                       string
}

func NewRelayTiming(now time.Time) *RelayTiming {
	if now.IsZero() {
		now = time.Now()
	}
	return &RelayTiming{start: now, endStatus: "unknown"}
}

type RelayAttempt struct {
	tracker    *RelayTiming
	generation uint64
	start      time.Time
}

func (t *RelayTiming) BeginAttempt(now time.Time) RelayAttempt {
	if t == nil {
		return RelayAttempt{}
	}
	if now.IsZero() {
		now = time.Now()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.generation++
	t.attemptStart = now
	t.dnsStart, t.tcpStart, t.tlsStart = time.Time{}, time.Time{}, time.Time{}
	t.dns, t.tcp, t.tls = 0, 0, 0
	t.reused, t.traceFirst = false, time.Time{}
	t.validFirst, t.postValidWrite = time.Time{}, time.Time{}
	return RelayAttempt{tracker: t, generation: t.generation, start: now}
}

func (a RelayAttempt) current() bool { return a.tracker != nil && a.generation != 0 }
func (a RelayAttempt) dnsStarted(now time.Time) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation {
		a.tracker.dnsStart = now
	}
}
func (a RelayAttempt) dnsDone(now time.Time) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation && !a.tracker.dnsStart.IsZero() {
		a.tracker.dns = nonNegative(now.Sub(a.tracker.dnsStart))
	}
}
func (a RelayAttempt) tcpStarted(now time.Time) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation {
		a.tracker.tcpStart = now
	}
}
func (a RelayAttempt) tcpDone(now time.Time) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation && !a.tracker.tcpStart.IsZero() {
		a.tracker.tcp = nonNegative(now.Sub(a.tracker.tcpStart))
	}
}
func (a RelayAttempt) tlsStarted(now time.Time) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation {
		a.tracker.tlsStart = now
	}
}
func (a RelayAttempt) tlsDone(now time.Time) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation && !a.tracker.tlsStart.IsZero() {
		a.tracker.tls = nonNegative(now.Sub(a.tracker.tlsStart))
	}
}
func (a RelayAttempt) gotConn(reused bool) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation {
		a.tracker.reused = reused
	}
}
func (a RelayAttempt) firstByte(now time.Time) {
	if !a.current() {
		return
	}
	a.tracker.mu.Lock()
	defer a.tracker.mu.Unlock()
	if a.tracker.generation == a.generation && a.tracker.traceFirst.IsZero() {
		a.tracker.traceFirst = now
	}
}

func (t *RelayTiming) Trace(attempt RelayAttempt) *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		DNSStart:             func(httptrace.DNSStartInfo) { attempt.dnsStarted(time.Now()) },
		DNSDone:              func(httptrace.DNSDoneInfo) { attempt.dnsDone(time.Now()) },
		ConnectStart:         func(_, _ string) { attempt.tcpStarted(time.Now()) },
		ConnectDone:          func(_, _ string, _ error) { attempt.tcpDone(time.Now()) },
		TLSHandshakeStart:    func() { attempt.tlsStarted(time.Now()) },
		TLSHandshakeDone:     func(_ tls.ConnectionState, _ error) { attempt.tlsDone(time.Now()) },
		GotConn:              func(i httptrace.GotConnInfo) { attempt.gotConn(i.Reused) },
		GotFirstResponseByte: func() { attempt.firstByte(time.Now()) },
	}
}

func (t *RelayTiming) CommitValidEvent(at time.Time) {
	if t == nil {
		return
	}
	if at.IsZero() {
		at = time.Now()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.validFirst.IsZero() {
		t.validFirst = at
		for _, writeAt := range t.writes {
			if !writeAt.Before(at) {
				t.postValidWrite = writeAt
				break
			}
		}
		// Writes before the first valid event are only needed for this lookup.
		// Once committed, retaining the request's complete write history would
		// grow without bound on long-lived streams.
		t.writes = nil
	}
}

func (t *RelayTiming) RecordWrite(n int, err error, at time.Time) {
	if t == nil {
		return
	}
	if at.IsZero() {
		at = time.Now()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if n > 0 {
		t.sentBytes += int64(n)
		if t.downstreamFirst.IsZero() {
			t.downstreamFirst = at
		}
		t.downstreamLast = at
		if t.validFirst.IsZero() {
			if len(t.writes) < maxPreValidWriteTimes {
				t.writes = append(t.writes, at)
			} else {
				copy(t.writes, t.writes[1:])
				t.writes[len(t.writes)-1] = at
			}
		} else if t.postValidWrite.IsZero() && !at.Before(t.validFirst) {
			t.postValidWrite = at
		}
	}
	if err != nil {
		t.writeError = true
		t.endStatus = "client_disconnect"
	}
}

func (t *RelayTiming) SetEndStatus(status string) {
	if t == nil || status == "" {
		return
	}
	t.mu.Lock()
	if t.endStatus == "client_disconnect" && status != "client_disconnect" {
		t.mu.Unlock()
		return
	}
	t.endStatus = status
	t.mu.Unlock()
}

func (t *RelayTiming) HasWriteError() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.writeError
}

func (t *RelayTiming) HasAttempt() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.generation != 0
}

func (t *RelayTiming) HasValidEvent() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.validFirst.IsZero()
}

func (t *RelayTiming) Snapshot(now time.Time) map[string]interface{} {
	if t == nil {
		return nil
	}
	if now.IsZero() {
		now = time.Now()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	start := t.start
	if start.IsZero() {
		start = now
	}
	first := t.validFirst
	if first.IsZero() {
		first = t.traceFirst
	}
	writeStart := t.postValidWrite
	if writeStart.IsZero() && first.IsZero() {
		writeStart = t.downstreamFirst
	}
	end := t.downstreamLast
	if end.IsZero() {
		end = now
	}
	status := t.endStatus
	if status == "" {
		status = "unknown"
	}
	if status == "unknown" && t.sentBytes > 0 && !t.writeError {
		status = "normal"
	}
	ms := func(d time.Duration) int64 { return nonNegative(d).Milliseconds() }
	conn := map[string]interface{}{"reused": t.reused}
	if t.dns > 0 {
		conn["dns_ms"] = ms(t.dns)
	}
	if t.tcp > 0 {
		conn["tcp_ms"] = ms(t.tcp)
	}
	if t.tls > 0 {
		conn["tls_ms"] = ms(t.tls)
	}
	firstEventMs := int64(0)
	if !first.IsZero() && !t.attemptStart.IsZero() {
		firstEventMs = ms(first.Sub(t.attemptStart))
	}
	relayMs := int64(0)
	if !first.IsZero() && !writeStart.IsZero() {
		relayMs = ms(writeStart.Sub(first))
	}
	downstreamMs := int64(0)
	if !writeStart.IsZero() && !end.IsZero() {
		downstreamMs = ms(end.Sub(writeStart))
	}
	result := map[string]interface{}{
		"site_processing_ms":      ms(t.attemptStart.Sub(start)),
		"upstream_connection":     conn,
		"upstream_first_event_ms": firstEventMs,
		"relay_processing_ms":     relayMs,
		"downstream_send_ms":      downstreamMs,
		"total_ms":                ms(end.Sub(start)),
		"sent_bytes":              t.sentBytes,
		"end_status":              status,
	}
	return result
}

func nonNegative(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	return d
}
