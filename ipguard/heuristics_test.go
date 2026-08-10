package ipguard

import (
	"testing"
)

func TestPrefilterDefaultSSHBruteforce(t *testing.T) {
	f := makeBaseFeatures()
	f.FailedLogins = 5
	p := makeProfile("1.1.1.1", f)
	clear, needsLLM, reasons := Prefilter(map[string]*IPProfile{"1.1.1.1": p}, HeuristicsThresholds{})
	if len(clear) != 1 || clear[0] != "1.1.1.1" {
		t.Errorf("clear = %v, want [1.1.1.1]", clear)
	}
	if reasons["1.1.1.1"] != AttackSSHBruteforce {
		t.Errorf("reason = %q, want SSH_BRUTEFORCE", reasons["1.1.1.1"])
	}
	if len(needsLLM) != 0 {
		t.Errorf("needsLLM = %v, want []", needsLLM)
	}
}

func TestPrefilterClearCutCases(t *testing.T) {
	cases := []struct {
		name     string
		feats    func() IPFeatures
		expected string
	}{
		{
			name: "sqli",
			feats: func() IPFeatures {
				f := makeBaseFeatures()
				f.SQLAttempts = 2
				return f
			},
			expected: AttackSQLI,
		},
		{
			name: "xss",
			feats: func() IPFeatures {
				f := makeBaseFeatures()
				f.XSSAttempts = 2
				return f
			},
			expected: AttackXSS,
		},
		{
			name: "traversal",
			feats: func() IPFeatures {
				f := makeBaseFeatures()
				f.TraversalAttempts = 2
				return f
			},
			expected: AttackPathTraversal,
		},
		{
			name: "bot flood",
			feats: func() IPFeatures {
				f := makeBaseFeatures()
				f.TotalRequests = 100
				f.IsBotUA = true
				return f
			},
			expected: ReasonBotFlood,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := makeProfile("10.0.0.1", tc.feats())
			clear, _, reasons := Prefilter(map[string]*IPProfile{"10.0.0.1": p}, HeuristicsThresholds{})
			if len(clear) != 1 || reasons["10.0.0.1"] != tc.expected {
				t.Errorf("clear=%v reason=%q, want %q", clear, reasons["10.0.0.1"], tc.expected)
			}
		})
	}
}

func TestPrefilterSingleHitIsSuspicious(t *testing.T) {
	f := makeBaseFeatures()
	f.SQLAttempts = 1
	p := makeProfile("1.1.1.1", f)
	clear, needsLLM, reasons := Prefilter(map[string]*IPProfile{"1.1.1.1": p}, HeuristicsThresholds{})
	if len(clear) != 0 {
		t.Errorf("clear = %v, want []", clear)
	}
	if len(needsLLM) != 1 || needsLLM[0] != "1.1.1.1" {
		t.Errorf("needsLLM = %v, want [1.1.1.1]", needsLLM)
	}
	if reasons["1.1.1.1"] != ReasonSuspicious {
		t.Errorf("reason = %q, want SUSPICIOUS", reasons["1.1.1.1"])
	}
}

func TestPrefilterNormalLowVolumeNotFlagged(t *testing.T) {
	f := makeBaseFeatures()
	f.TotalRequests = 10
	f.UniqueUAs = 1
	p := makeProfile("1.1.1.1", f)
	clear, needsLLM, reasons := Prefilter(map[string]*IPProfile{"1.1.1.1": p}, HeuristicsThresholds{})
	if len(clear) != 0 || len(needsLLM) != 0 || len(reasons) != 0 {
		t.Errorf("expected no flags: clear=%v needsLLM=%v reasons=%v", clear, needsLLM, reasons)
	}
}

func TestPrefilterCustomThresholds(t *testing.T) {
	f := makeBaseFeatures()
	f.FailedLogins = 3
	p := makeProfile("1.1.1.1", f)
	cfg := HeuristicsThresholds{SSHFailThreshold: 3}
	clear, _, reasons := Prefilter(map[string]*IPProfile{"1.1.1.1": p}, cfg)
	if len(clear) != 1 || reasons["1.1.1.1"] != AttackSSHBruteforce {
		t.Errorf("clear=%v reason=%q, want [1.1.1.1]/SSH_BRUTEFORCE", clear, reasons["1.1.1.1"])
	}
}

func TestPrefilterSlowPersistenceBotNotFlagged(t *testing.T) {
	base := func() IPFeatures {
		f := makeBaseFeatures()
		f.TotalRequests = 6
		f.RatePerMin = 0.1
		f.CumWindows = 14
		f.CumTotal = 20
		f.UALower = "python-requests/2.31"
		return f
	}

	bot := makeProfile("10.0.9.1", func() IPFeatures {
		f := base()
		f.IsBotUA = true
		return f
	}())
	clear, needsLLM, reasons := Prefilter(map[string]*IPProfile{"10.0.9.1": bot}, HeuristicsThresholds{})
	if len(clear) != 0 || len(needsLLM) != 0 || len(reasons) != 0 {
		t.Errorf("bot must not be flagged: clear=%v needsLLM=%v reasons=%v", clear, needsLLM, reasons)
	}

	plain := makeProfile("10.0.9.2", base())
	clear, needsLLM, reasons = Prefilter(map[string]*IPProfile{"10.0.9.2": plain}, HeuristicsThresholds{})
	if reasons["10.0.9.2"] != ReasonSlowPersistence {
		t.Errorf("reason = %q, want SLOW_PERSISTENCE", reasons["10.0.9.2"])
	}
	if len(needsLLM) != 1 || needsLLM[0] != "10.0.9.2" {
		t.Errorf("needsLLM = %v, want [10.0.9.2]", needsLLM)
	}
}

func TestPrefilterSlowPersistenceShortHistoryUnflagged(t *testing.T) {
	profiles := map[string]*IPProfile{}
	for i := 1; i <= 5; i++ {
		ip := "198.51.100." + string(rune('0'+i))
		f := makeBaseFeatures()
		f.TotalRequests = 2
		f.RatePerMin = 0.05
		f.CumWindows = 2
		f.CumTotal = 2
		profiles[ip] = makeProfile(ip, f)
	}
	clear, needsLLM, reasons := Prefilter(profiles, HeuristicsThresholds{})
	if len(clear) != 0 || len(needsLLM) != 0 || len(reasons) != 0 {
		t.Errorf("expected no flags: clear=%v needsLLM=%v reasons=%v", clear, needsLLM, reasons)
	}
}
