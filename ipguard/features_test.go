package ipguard

import (
	"strconv"
	"testing"
)

func webEvent(ts int64, ip, detail string) *TrafficEvent {
	return &TrafficEvent{TS: ts, IP: ip, Service: "web", Kind: "web", Detail: detail, Raw: ip + " " + detail}
}

func TestAggregateBucketingAndWindowFiltering(t *testing.T) {
	events := []*TrafficEvent{
		webEvent(baseTS+10, "1.1.1.1", "method=GET path=/"),
		webEvent(baseTS+20, "1.1.1.1", "method=GET path=/"),
		webEvent(baseTS+30, "2.2.2.2", "method=GET path=/"),
		webEvent(baseTS-1000, "3.3.3.3", "method=GET path=/"),
		webEvent(baseTS+99999, "4.4.4.4", "method=GET path=/"),
	}
	profiles := AggregateIPs(events, baseTS, baseTS+60)
	if len(profiles) != 2 {
		t.Fatalf("profiles = %d, want 2", len(profiles))
	}
	if _, ok := profiles["1.1.1.1"]; !ok {
		t.Fatal("missing 1.1.1.1")
	}
	if _, ok := profiles["2.2.2.2"]; !ok {
		t.Fatal("missing 2.2.2.2")
	}
	if profiles["1.1.1.1"].Features.TotalRequests != 2 {
		t.Errorf("total_requests = %d, want 2", profiles["1.1.1.1"].Features.TotalRequests)
	}
	if profiles["2.2.2.2"].Features.TotalRequests != 1 {
		t.Errorf("total_requests = %d, want 1", profiles["2.2.2.2"].Features.TotalRequests)
	}
}

func TestAggregateAttackCounters(t *testing.T) {
	events := []*TrafficEvent{
		webEvent(baseTS+1, "1.1.1.1", `path=/x.php?id=1' OR '1'='1`),
		webEvent(baseTS+2, "1.1.1.1", `path=/?q=<script>alert(1)</script>`),
		webEvent(baseTS+3, "1.1.1.1", "path=/../../etc/passwd"),
		webEvent(baseTS+4, "1.1.1.1", "path=/union select 1"),
		webEvent(baseTS+5, "1.1.1.1", "path=/ok"),
	}
	profiles := AggregateIPs(events, baseTS, baseTS+60)
	f := profiles["1.1.1.1"].Features
	if f.SQLAttempts != 2 {
		t.Errorf("sql_attempts = %d, want 2", f.SQLAttempts)
	}
	if f.XSSAttempts != 1 {
		t.Errorf("xss_attempts = %d, want 1", f.XSSAttempts)
	}
	if f.TraversalAttempts != 1 {
		t.Errorf("traversal_attempts = %d, want 1", f.TraversalAttempts)
	}
}

func TestAggregateRatePerMin(t *testing.T) {
	var events []*TrafficEvent
	for i := int64(0); i < 30; i++ {
		events = append(events, webEvent(baseTS+i, "1.1.1.1", "method=GET path=/"))
	}
	profiles := AggregateIPs(events, baseTS, baseTS+60)
	if got := profiles["1.1.1.1"].Features.RatePerMin; got < 29.9 || got > 30.1 {
		t.Errorf("rate_per_min = %v, want ~30", got)
	}
	profiles2 := AggregateIPs(events, baseTS, baseTS+3600)
	if got := profiles2["1.1.1.1"].Features.RatePerMin; got < 0.49 || got > 0.51 {
		t.Errorf("rate_per_min = %v, want ~0.5", got)
	}
}

func TestAggregateEvidenceCappedAtEight(t *testing.T) {
	var events []*TrafficEvent
	for i := int64(0); i < 12; i++ {
		raw := "raw-line-" + strconv.FormatInt(i, 10)
		events = append(events, &TrafficEvent{TS: baseTS + i, IP: "1.1.1.1", Service: "web", Kind: "web", Detail: "method=GET path=/", Raw: raw})
	}
	profiles := AggregateIPs(events, baseTS, baseTS+60)
	evidence := profiles["1.1.1.1"].Evidence
	if len(evidence) != 8 {
		t.Fatalf("evidence = %d, want 8", len(evidence))
	}
	if evidence[len(evidence)-1] != "raw-line-11" {
		t.Errorf("newest = %q, want raw-line-11", evidence[len(evidence)-1])
	}
	if evidence[0] != "raw-line-4" {
		t.Errorf("oldest = %q, want raw-line-4", evidence[0])
	}
}

func TestAggregateBotUADetection(t *testing.T) {
	bot := webEvent(baseTS, "1.1.1.1", `method=GET path=/ ua="python-requests/2.31"`)
	human := webEvent(baseTS+1, "2.2.2.2", `method=GET path=/ ua="Mozilla/5.0 (X11)"`)
	profiles := AggregateIPs([]*TrafficEvent{bot, human}, baseTS, baseTS+60)
	if !profiles["1.1.1.1"].Features.IsBotUA {
		t.Error("1.1.1.1 should be a bot")
	}
	if profiles["2.2.2.2"].Features.IsBotUA {
		t.Error("2.2.2.2 should not be a bot")
	}
}

func TestAggregateFailedLoginsAndUniqueUAs(t *testing.T) {
	events := []*TrafficEvent{
		{TS: baseTS, IP: "1.1.1.1", Service: "sshd", Kind: "ssh", Detail: "failed", Raw: authLine(baseTS, "1.1.1.1", "failed")},
		{TS: baseTS + 1, IP: "1.1.1.1", Service: "sshd", Kind: "ssh", Detail: "accepted", Raw: authLine(baseTS+1, "1.1.1.1", "accepted")},
		webEvent(baseTS+2, "2.2.2.2", `method=GET path=/ ua="curl/8.0"`),
		webEvent(baseTS+3, "2.2.2.2", `method=GET path=/ ua="Mozilla/5.0"`),
	}
	profiles := AggregateIPs(events, baseTS, baseTS+60)
	if profiles["1.1.1.1"].Features.FailedLogins != 1 {
		t.Errorf("failed_logins = %d, want 1", profiles["1.1.1.1"].Features.FailedLogins)
	}
	if profiles["1.1.1.1"].Features.AcceptedLogins != 1 {
		t.Errorf("accepted_logins = %d, want 1", profiles["1.1.1.1"].Features.AcceptedLogins)
	}
	if profiles["2.2.2.2"].Features.UniqueUAs != 2 {
		t.Errorf("unique_uas = %d, want 2", profiles["2.2.2.2"].Features.UniqueUAs)
	}
}
