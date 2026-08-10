package ipguard

import (
	"testing"
)

func testConfig() Config {
	return DefaultConfig()
}

func banRecord(ip string, action DecisionAction, ts int64, dur int64) BanRecord {
	return BanRecord{IP: ip, Action: action, Reason: "test", DurationSeconds: dur, TS: ts}
}

func TestDecideWhitelistIgnore(t *testing.T) {
	cfg := testConfig()
	records := Decide(map[string]LLMVerdict{"127.0.0.1": VerdictCritical}, nil,
		map[string]bool{}, nil, baseTS, cfg)
	if len(records) != 1 {
		t.Fatalf("records = %d, want 1", len(records))
	}
	if records[0].Action != ActionIgnore || records[0].Reason != "whitelisted" {
		t.Errorf("got %s/%s, want ignore/whitelisted", records[0].Action, records[0].Reason)
	}
}

func TestDecideBanDurationsPerVerdict(t *testing.T) {
	cfg := testConfig()
	cases := []struct {
		verdict  LLMVerdict
		expected int64
	}{
		{VerdictSuspect, 900},
		{VerdictMalicious, 21600},
		{VerdictCritical, 86400},
	}
	for _, tc := range cases {
		ip := "10.0.0.1"
		records := Decide(map[string]LLMVerdict{ip: tc.verdict}, nil,
			map[string]bool{}, nil, baseTS, cfg)
		if records[0].Action != ActionBan {
			t.Errorf("verdict %s: action = %s, want ban", tc.verdict, records[0].Action)
		}
		if records[0].DurationSeconds != tc.expected {
			t.Errorf("verdict %s: duration = %d, want %d", tc.verdict, records[0].DurationSeconds, tc.expected)
		}
		if records[0].Reason != string(tc.verdict) {
			t.Errorf("verdict %s: reason = %q, want %q", tc.verdict, records[0].Reason, tc.verdict)
		}
	}
}

func TestDecideSlowPersistenceBansBenignVerdict(t *testing.T) {
	cfg := testConfig()
	f := makeBaseFeatures()
	f.TotalRequests = 6
	f.RatePerMin = 0.1
	f.CumWindows = 14
	f.CumTotal = 20
	profile := makeProfile("203.0.113.9", f)
	profile.Signal = ReasonSlowPersistence
	records := Decide(map[string]LLMVerdict{"203.0.113.9": VerdictBenign},
		map[string]*IPProfile{"203.0.113.9": profile}, map[string]bool{}, nil, baseTS, cfg)
	if len(records) != 1 {
		t.Fatalf("records = %d, want 1", len(records))
	}
	if records[0].Action != ActionBan {
		t.Errorf("action = %s, want ban", records[0].Action)
	}
	if records[0].DurationSeconds != 900 {
		t.Errorf("duration = %d, want 900", records[0].DurationSeconds)
	}
	if records[0].Reason != "slow_persistence:monitor" {
		t.Errorf("reason = %q, want slow_persistence:monitor", records[0].Reason)
	}
}

func TestDecideRepeatOffenderEscalates(t *testing.T) {
	cfg := testConfig()
	history := []BanRecord{
		banRecord("10.0.0.9", ActionBan, baseTS-100, 900),
		banRecord("10.0.0.9", ActionBan, baseTS-200, 900),
		banRecord("10.0.0.9", ActionBan, baseTS-300, 900),
	}
	records := Decide(map[string]LLMVerdict{"10.0.0.9": VerdictSuspect}, nil,
		map[string]bool{}, history, baseTS, cfg)
	if records[0].Action != ActionEscalate {
		t.Errorf("action = %s, want escalate", records[0].Action)
	}
	if records[0].DurationSeconds != RepeatOffenderDuration {
		t.Errorf("duration = %d, want %d", records[0].DurationSeconds, RepeatOffenderDuration)
	}
	if records[0].Reason != "repeat_offender" {
		t.Errorf("reason = %q, want repeat_offender", records[0].Reason)
	}
}

func TestDecideBenignCleanBannedUnbans(t *testing.T) {
	cfg := testConfig()
	f := makeBaseFeatures()
	f.TotalRequests = 4
	profile := makeProfile("10.0.0.5", f)
	records := Decide(map[string]LLMVerdict{"10.0.0.5": VerdictBenign},
		map[string]*IPProfile{"10.0.0.5": profile}, map[string]bool{"10.0.0.5": true}, nil, baseTS, cfg)
	if records[0].Action != ActionUnban || records[0].Reason != "false_positive_recovery" {
		t.Errorf("got %s/%s, want unban/false_positive_recovery", records[0].Action, records[0].Reason)
	}
}

func TestDecideBenignWithRecentBanIgnored(t *testing.T) {
	cfg := testConfig()
	f := makeBaseFeatures()
	f.TotalRequests = 4
	profile := makeProfile("10.0.0.5", f)
	history := []BanRecord{banRecord("10.0.0.5", ActionBan, baseTS-500, 900)}
	records := Decide(map[string]LLMVerdict{"10.0.0.5": VerdictBenign},
		map[string]*IPProfile{"10.0.0.5": profile}, map[string]bool{"10.0.0.5": true}, history, baseTS, cfg)
	if records[0].Action != ActionIgnore || records[0].Reason != "benign" {
		t.Errorf("got %s/%s, want ignore/benign", records[0].Action, records[0].Reason)
	}
}

func TestDecideCooldownIgnoresSecondBan(t *testing.T) {
	cfg := testConfig()
	history := []BanRecord{banRecord("10.0.0.7", ActionBan, baseTS-100, 900)}
	records := Decide(map[string]LLMVerdict{"10.0.0.7": VerdictMalicious}, nil,
		map[string]bool{}, history, baseTS, cfg)
	if records[0].Action != ActionIgnore || records[0].Reason != "cooldown" {
		t.Errorf("got %s/%s, want ignore/cooldown", records[0].Action, records[0].Reason)
	}
}

func TestDecideAlreadyBannedIgnored(t *testing.T) {
	cfg := testConfig()
	records := Decide(map[string]LLMVerdict{"10.0.0.8": VerdictMalicious}, nil,
		map[string]bool{"10.0.0.8": true}, nil, baseTS, cfg)
	if records[0].Action != ActionIgnore || records[0].Reason != "already_banned" {
		t.Errorf("got %s/%s, want ignore/already_banned", records[0].Action, records[0].Reason)
	}
}

func TestDecideCorroborationGate(t *testing.T) {
	cfg := testConfig()

	t.Run("malicious low rate suspicious signal ignored", func(t *testing.T) {
		f := makeBaseFeatures()
		f.RatePerMin = 0.5
		profile := makeProfile("10.9.9.1", f)
		profile.Signal = ReasonSuspicious
		records := Decide(map[string]LLMVerdict{"10.9.9.1": VerdictMalicious},
			map[string]*IPProfile{"10.9.9.1": profile}, map[string]bool{}, nil, baseTS, cfg)
		if records[0].Action != ActionIgnore || records[0].Reason != "llm_verdict_uncorroborated" {
			t.Errorf("got %s/%s, want ignore/llm_verdict_uncorroborated", records[0].Action, records[0].Reason)
		}
	})

	t.Run("malicious high rate bans", func(t *testing.T) {
		f := makeBaseFeatures()
		f.RatePerMin = 5.0
		profile := makeProfile("10.9.9.2", f)
		records := Decide(map[string]LLMVerdict{"10.9.9.2": VerdictMalicious},
			map[string]*IPProfile{"10.9.9.2": profile}, map[string]bool{}, nil, baseTS, cfg)
		if records[0].Action != ActionBan || records[0].DurationSeconds != 21600 {
			t.Errorf("got %s/%d, want ban/21600", records[0].Action, records[0].DurationSeconds)
		}
	})

	t.Run("malicious attack signal bans without rate", func(t *testing.T) {
		f := makeBaseFeatures()
		f.TotalRequests = 3
		profile := makeProfile("10.9.9.3", f)
		profile.Signal = AttackSQLI
		records := Decide(map[string]LLMVerdict{"10.9.9.3": VerdictMalicious},
			map[string]*IPProfile{"10.9.9.3": profile}, map[string]bool{}, nil, baseTS, cfg)
		if records[0].Action != ActionBan || records[0].Reason != AttackSQLI {
			t.Errorf("got %s/%s, want ban/SQLI", records[0].Action, records[0].Reason)
		}
	})
}
