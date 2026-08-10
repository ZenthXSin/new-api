package ipguard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func truthBatch() []*IPProfile {
	mix := []struct {
		truth string
		n     int
	}{
		{AttackSQLI, 60},
		{AttackXSS, 20},
		{AttackSSHBruteforce, 12},
		{AttackDDoSBurst, 8},
	}
	var batch []*IPProfile
	idx := 0
	for _, m := range mix {
		for i := 0; i < m.n; i++ {
			ip := "10.1.0." + itoa(idx)
			f := makeBaseFeatures()
			f.Truth = m.truth
			batch = append(batch, makeProfile(ip, f))
			idx++
		}
	}
	return batch
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}

func TestMockDeterminismSameSeed(t *testing.T) {
	batch := truthBatch()
	first, err := NewMockLLM(7).Assess(batch)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewMockLLM(7).Assess(batch)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != len(second) {
		t.Fatalf("length mismatch")
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("verdict %d differs between same-seed runs", i)
		}
	}
}

func TestMockRecallAboveNinetyPercent(t *testing.T) {
	verdicts, err := NewMockLLM(7).Assess(truthBatch())
	if err != nil {
		t.Fatal(err)
	}
	strong := 0
	for _, v := range verdicts {
		if v == VerdictMalicious || v == VerdictCritical {
			strong++
		}
	}
	recall := float64(strong) / float64(len(verdicts))
	if recall < 0.90 {
		t.Errorf("recall = %.3f, want >= 0.90", recall)
	}
}

func TestMockNoTruthStaysBenignMostly(t *testing.T) {
	f := makeBaseFeatures()
	f.TotalRequests = 3
	batch := []*IPProfile{makeProfile("10.9.9.9", f)}
	verdicts, err := NewMockLLM(7).Assess(batch)
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictBenign && verdicts[0] != VerdictSuspect {
		t.Errorf("verdict = %s, want benign|suspect", verdicts[0])
	}
}

// gatewayTestServer runs an OpenAI-compatible /v1/chat/completions stub.
func gatewayTestServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func gatewayConfig(server *httptest.Server, token string) Config {
	cfg := DefaultConfig()
	cfg.LLMBaseURL = server.URL
	cfg.LLMToken = token
	cfg.LLMModel = "test-model"
	return cfg
}

func TestGatewayLLMMalformedJSONAllSuspect(t *testing.T) {
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("this is not json at all {{{"))
	})
	client := NewGatewayLLM(gatewayConfig(server, "sk-test-key"), nil)
	f1, f2 := makeBaseFeatures(), makeBaseFeatures()
	f1.TotalRequests = 60
	f2.TotalRequests = 60
	verdicts, err := client.Assess([]*IPProfile{
		makeProfile("1.1.1.1", f1), makeProfile("1.1.1.2", f2),
	})
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictSuspect || verdicts[1] != VerdictSuspect {
		t.Errorf("verdicts = %v, want [suspect suspect]", verdicts)
	}
}

func TestGatewayLLMEmptyContentRetryThenSuspect(t *testing.T) {
	calls := 0
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(""))
	})
	client := NewGatewayLLM(gatewayConfig(server, "sk-test-key"), nil)
	f := makeBaseFeatures()
	f.TotalRequests = 60
	verdicts, err := client.Assess([]*IPProfile{makeProfile("1.1.1.1", f)})
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictSuspect {
		t.Errorf("verdict = %s, want suspect", verdicts[0])
	}
	if calls != 2 { // first attempt + exactly one retry
		t.Errorf("calls = %d, want 2", calls)
	}
}

func TestGatewayLLMHTTPErrorRetryThenSuspect(t *testing.T) {
	calls := 0
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "server exploded", http.StatusInternalServerError)
	})
	client := NewGatewayLLM(gatewayConfig(server, "sk-test-key"), nil)
	f := makeBaseFeatures()
	f.TotalRequests = 60
	verdicts, err := client.Assess([]*IPProfile{makeProfile("1.1.1.1", f)})
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictSuspect {
		t.Errorf("verdict = %s, want suspect", verdicts[0])
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2", calls)
	}
}

func TestGatewayLLMGoodJSONParsed(t *testing.T) {
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := `[{"ip": "1.1.1.1", "verdict": "malicious", "reason": "sqli pattern"}]`
		_, _ = w.Write([]byte(body))
	})
	client := NewGatewayLLM(gatewayConfig(server, "sk-test-key"), nil)
	f := makeBaseFeatures()
	f.TotalRequests = 60
	verdicts, err := client.Assess([]*IPProfile{makeProfile("1.1.1.1", f)})
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictMalicious {
		t.Errorf("verdict = %s, want malicious", verdicts[0])
	}
}

func TestGatewayLLMWrapperObjectParsed(t *testing.T) {
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := `{"results": [{"ip": "1.1.1.1", "verdict": "critical", "reason": "x"}]}`
		_, _ = w.Write([]byte(body))
	})
	client := NewGatewayLLM(gatewayConfig(server, "sk-test-key"), nil)
	f := makeBaseFeatures()
	f.TotalRequests = 60
	verdicts, err := client.Assess([]*IPProfile{makeProfile("1.1.1.1", f)})
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictCritical {
		t.Errorf("verdict = %s, want critical", verdicts[0])
	}
}

func TestGatewayLLMShortAnswerSuspectsRemainder(t *testing.T) {
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := `[{"ip": "1.1.1.1", "verdict": "benign", "reason": "x"}]`
		_, _ = w.Write([]byte(body))
	})
	client := NewGatewayLLM(gatewayConfig(server, "sk-test-key"), nil)
	f := makeBaseFeatures()
	f.TotalRequests = 60
	verdicts, err := client.Assess([]*IPProfile{
		makeProfile("1.1.1.1", f), makeProfile("1.1.1.2", f),
	})
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictBenign || verdicts[1] != VerdictSuspect {
		t.Errorf("verdicts = %v, want [benign suspect]", verdicts)
	}
}

func TestGatewayLLMNoTokenFailsSafeWithoutCalling(t *testing.T) {
	calls := 0
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"ip":"1.1.1.1","verdict":"benign"}]`))
	})
	client := NewGatewayLLM(gatewayConfig(server, ""), nil)
	f := makeBaseFeatures()
	f.TotalRequests = 60
	verdicts, err := client.Assess([]*IPProfile{makeProfile("1.1.1.1", f)})
	if err != nil {
		t.Fatal(err)
	}
	if verdicts[0] != VerdictSuspect {
		t.Errorf("verdict = %s, want suspect", verdicts[0])
	}
	if calls != 0 {
		t.Errorf("calls = %d, want 0 (no token, no request)", calls)
	}
}

func TestGatewayLLMCostGuardPerRunLimit(t *testing.T) {
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"ip":"1.1.1.1","verdict":"benign"}]`))
	})
	cfg := gatewayConfig(server, "sk-test-key")
	cfg.LLMMaxCallsPerRun = 1
	client := NewGatewayLLM(cfg, nil)
	f := makeBaseFeatures()
	f.TotalRequests = 60
	batch := []*IPProfile{makeProfile("1.1.1.1", f)}
	if _, err := client.Assess(batch); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Assess(batch); err == nil {
		t.Fatal("expected ErrLLMLimitExceeded on second call")
	}
}

func TestGatewayLLMDailyReset(t *testing.T) {
	server := gatewayTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"ip":"1.1.1.1","verdict":"benign"}]`))
	})
	cfg := gatewayConfig(server, "sk-test-key")
	cfg.LLMMaxCallsPerDay = 1
	clock := newFakeClock(1_700_000_000)
	client := NewGatewayLLM(cfg, func() time.Time { return time.Unix(clock.Unix(), 0) })
	f := makeBaseFeatures()
	f.TotalRequests = 60
	batch := []*IPProfile{makeProfile("1.1.1.1", f)}
	if _, err := client.Assess(batch); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Assess(batch); err == nil {
		t.Fatal("expected ErrLLMLimitExceeded within the same day")
	}
	// Next epoch day: budget resets.
	clock.advance(86400)
	if _, err := client.Assess(batch); err != nil {
		t.Fatalf("expected budget reset on new day, got %v", err)
	}
}

func TestExtractJSONDefensive(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain array", `[{"ip":"1.1.1.1","verdict":"malicious"}]`, "1.1.1.1"},
		{"fenced array", "```json\n[{\"ip\":\"1.1.1.1\",\"verdict\":\"malicious\"}]\n```", "1.1.1.1"},
		{"text around array", "Sure, here: [{\"ip\":\"1.1.1.1\",\"verdict\":\"malicious\"}] done", "1.1.1.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			obj, err := extractJSON(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(obj)
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) == "" {
				t.Error("empty parsed output")
			}
		})
	}
}
