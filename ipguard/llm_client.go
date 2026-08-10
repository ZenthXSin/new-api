package ipguard

// LLM clients for verdict production. Two implementations:
//
//   - GatewayLLM — real HTTP client that calls the gateway's OWN
//     OpenAI-compatible /v1/chat/completions endpoint (the "仅走网关自身通道"
//     mode): channel selection, model routing and billing all flow through
//     the gateway itself. The token is sent only in the Authorization header.
//   - MockLLM — fully deterministic offline scorer used by tests and
//     sandbox runs; performs no network I/O.
//
// Both share the fail-safe contract: any call that cannot produce a verdict
// marks the whole batch suspect rather than crashing the scan.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

// ErrLLMLimitExceeded is raised when the per-run or per-day LLM call budget
// is exhausted.
type ErrLLMLimitExceeded struct{ reason string }

func (e *ErrLLMLimitExceeded) Error() string { return e.reason }

// LLMClient assesses batches of profiles and returns one verdict per profile,
// aligned 1:1 by position.
type LLMClient interface {
	Assess(batch []*IPProfile) ([]LLMVerdict, error)
}

// ---------------------------------------------------------------------------
// Gateway client (real, self-call)
// ---------------------------------------------------------------------------

// gatewayLLMConfig carries the client's own knobs (subset of Config).
type gatewayLLMConfig struct {
	BaseURL        string
	Model          string
	Token          string
	MaxTokens      int
	MaxCallsPerRun int
	MaxCallsPerDay int
}

// GatewayLLM is an OpenAI-compatible chat-completions client with fail-safe
// and cost-guard behaviour:
//   - Each Assess counts as exactly one call (internal retry does not count
//     again). calls is the per-run counter; callsToday resets when the
//     injected clock enters a new epoch-day.
//   - On HTTP error or empty content the request is retried exactly once with
//     maxTokens*2; if that also fails the batch fails safe: every profile is
//     marked suspect.
//   - A response that cannot be parsed as JSON also fails safe to suspect for
//     every profile. Per-item problems (mismatched IP, unknown verdict value)
//     fall back to suspect for that item only.
type GatewayLLM struct {
	config     gatewayLLMConfig
	clock      func() time.Time
	client     *http.Client
	calls      int
	callsToday int
	day        int64
}

// NewGatewayLLM builds the client. BaseURL defaults to the gateway's own
// loopback; if no token is configured the client is inert (every batch fails
// safe to suspect with a logged warning).
func NewGatewayLLM(config Config, clock func() time.Time) *GatewayLLM {
	if clock == nil {
		clock = time.Now
	}
	baseURL := strings.TrimRight(config.LLMBaseURL, "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:3000"
	}
	maxTokens := config.LLMMaxTokens
	if maxTokens <= 0 {
		maxTokens = 256
	}
	return &GatewayLLM{
		config: gatewayLLMConfig{
			BaseURL:        baseURL,
			Model:          config.LLMModel,
			Token:          config.LLMToken,
			MaxTokens:      maxTokens,
			MaxCallsPerRun: config.LLMMaxCallsPerRun,
			MaxCallsPerDay: config.LLMMaxCallsPerDay,
		},
		clock:  clock,
		client: &http.Client{Timeout: 60 * time.Second},
	}
}

// TokenConfigured reports whether an API token is set (the gateway self-call
// needs one to authenticate).
func (c *GatewayLLM) TokenConfigured() bool { return c.config.Token != "" }

// CallsUsed returns the number of LLM calls consumed this run.
func (c *GatewayLLM) CallsUsed() int { return c.calls }

func (c *GatewayLLM) Assess(batch []*IPProfile) ([]LLMVerdict, error) {
	if len(batch) == 0 {
		return nil, nil
	}
	if err := c.guardCall(); err != nil {
		return nil, err
	}
	if c.config.Token == "" {
		log.Printf("ipguard: no LLM token configured; fail-safe suspect for %d profiles", len(batch))
		return failSafeSuspect(len(batch)), nil
	}

	content, err := c.chat(batch, c.config.MaxTokens, true)
	if err != nil || content == "" {
		content, err = c.chat(batch, c.config.MaxTokens*2, false)
	}
	if err != nil || content == "" {
		log.Printf("ipguard: LLM retry failed; fail-safe suspect for %d profiles", len(batch))
		return failSafeSuspect(len(batch)), nil
	}
	return parseResponse(content, batch), nil
}

func (c *GatewayLLM) guardCall() error {
	now := c.clock().Unix()
	today := now / 86400
	if c.day != today {
		c.day = today
		c.callsToday = 0
	}
	if c.calls >= c.config.MaxCallsPerRun {
		return &ErrLLMLimitExceeded{reason: fmt.Sprintf("LLM per-run call budget exceeded: %d", c.config.MaxCallsPerRun)}
	}
	if c.callsToday >= c.config.MaxCallsPerDay {
		return &ErrLLMLimitExceeded{reason: fmt.Sprintf("LLM per-day call budget exceeded: %d", c.config.MaxCallsPerDay)}
	}
	c.calls++
	c.callsToday++
	return nil
}

func (c *GatewayLLM) chat(batch []*IPProfile, maxTokens int, responseFormat bool) (string, error) {
	url := c.config.BaseURL + "/v1/chat/completions"
	body := map[string]any{
		"model":       c.config.Model,
		"temperature": 0,
		"max_tokens":  maxTokens,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": payload(batch)},
		},
	}
	if responseFormat {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("llm HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

const systemPrompt = "You are a network-threat verifier. You receive IP profiles as JSON " +
	"(IP, features, evidence). Return ONLY a JSON array, one entry per profile, " +
	"in the same order: [{\"ip\":\"...\", \"verdict\": \"benign|suspect|malicious|critical\", " +
	"\"reason\":\"...\"}]. No other text."

// payload renders the profiles as the user message body.
func payload(batch []*IPProfile) string {
	entries := make([]map[string]any, 0, len(batch))
	for _, p := range batch {
		entry := map[string]any{
			"ip":       p.IP,
			"features": p.Features,
		}
		if p.Signal != "" {
			entry["signal"] = p.Signal
		}
		if p.Confidence != 0 {
			entry["confidence"] = p.Confidence
		}
		if len(p.Evidence) > 0 {
			entry["evidence"] = p.Evidence
		}
		entries = append(entries, entry)
	}
	raw, _ := json.Marshal(entries)
	return string(raw)
}

// stripFences removes markdown code fences around a JSON response.
func stripFences(text string) string {
	s := strings.TrimSpace(text)
	if strings.HasPrefix(s, "```") {
		if close := strings.Index(s[3:], "```"); close != -1 {
			s = s[3 : 3+close]
		} else {
			s = s[3:]
		}
	}
	return strings.TrimSpace(s)
}

// extractJSON returns the first balanced JSON array or object found in text.
func extractJSON(text string) (any, error) {
	s := stripFences(text)
	start := -1
	for i := 0; i < len(s); i++ {
		if s[i] == '[' || s[i] == '{' {
			start = i
			break
		}
	}
	if start == -1 {
		return nil, fmt.Errorf("no JSON structure found")
	}
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		ch := s[i]
		if inStr {
			if esc {
				esc = false
			} else if ch == '\\' {
				esc = true
			} else if ch == '"' {
				inStr = false
			}
			continue
		}
		switch ch {
		case '"':
			inStr = true
		case '[', '{':
			depth++
		case ']', '}':
			depth--
			if depth == 0 {
				var v any
				if err := json.Unmarshal([]byte(s[start:i+1]), &v); err != nil {
					return nil, err
				}
				return v, nil
			}
		}
	}
	return nil, fmt.Errorf("unbalanced JSON structure")
}

// parseResponse converts an LLM response into per-profile verdicts.
func parseResponse(text string, batch []*IPProfile) []LLMVerdict {
	obj, err := extractJSON(text)
	if err != nil {
		log.Printf("ipguard: LLM response parse failed (%v); fail-safe suspect", err)
		return failSafeSuspect(len(batch))
	}

	// Accept a wrapper object that holds the array under some key.
	if arr, ok := obj.(map[string]any); ok {
		found := false
		for _, v := range arr {
			if list, isList := v.([]any); isList {
				obj = list
				found = true
				break
			}
		}
		if !found {
			log.Printf("ipguard: object response without a list; fail-safe suspect")
			return failSafeSuspect(len(batch))
		}
	}

	list, ok := obj.([]any)
	if !ok {
		log.Printf("ipguard: response is not a list; fail-safe suspect")
		return failSafeSuspect(len(batch))
	}

	verdicts := make([]LLMVerdict, 0, len(batch))
	for i, p := range batch {
		if i < len(list) {
			verdicts = append(verdicts, itemVerdict(p, list[i]))
		} else {
			// short answer -> remaining profiles suspect
			verdicts = append(verdicts, VerdictSuspect)
		}
	}
	return verdicts
}

func itemVerdict(profile *IPProfile, item any) LLMVerdict {
	m, ok := item.(map[string]any)
	if !ok || m["ip"] != profile.IP {
		return VerdictSuspect
	}
	raw, ok := m["verdict"].(string)
	if !ok {
		return VerdictSuspect
	}
	switch LLMVerdict(strings.ToLower(raw)) {
	case VerdictBenign, VerdictSuspect, VerdictMalicious, VerdictCritical:
		return LLMVerdict(strings.ToLower(raw))
	default:
		return VerdictSuspect
	}
}

func failSafeSuspect(n int) []LLMVerdict {
	verdicts := make([]LLMVerdict, n)
	for i := range verdicts {
		verdicts[i] = VerdictSuspect
	}
	return verdicts
}

// ---------------------------------------------------------------------------
// Mock provider (deterministic, no network)
// ---------------------------------------------------------------------------

// MockLLM is a deterministic offline scorer driven by the test-only Truth
// feature. The same seed always produces the same verdict sequence for the
// same batch. Calibrated to behave like a real detector (see llm-ipguard
// docs): strong attacks 97% malicious, brute force 96%, port scan 90%, DDOS
// 95% critical, slow scan 85% suspect; normal traffic 94% benign.
type MockLLM struct {
	seed int64
	rng  *rand.Rand
}

// NewMockLLM returns a deterministic mock scorer. The same seed always
// produces the same verdict sequence.
func NewMockLLM(seed int64) *MockLLM {
	return &MockLLM{seed: seed, rng: rand.New(rand.NewSource(seed))}
}

func (m *MockLLM) Assess(batch []*IPProfile) ([]LLMVerdict, error) {
	verdicts := make([]LLMVerdict, 0, len(batch))
	for _, p := range batch {
		verdicts = append(verdicts, m.verdictFor(p))
	}
	return verdicts, nil
}

func (m *MockLLM) verdictFor(profile *IPProfile) LLMVerdict {
	truth := strings.ToUpper(profile.Features.Truth)
	roll := m.rng.Float64()
	switch truth {
	case AttackSQLI, AttackXSS, AttackPathTraversal:
		if roll < 0.97 {
			return VerdictMalicious
		}
		return VerdictSuspect
	case AttackSSHBruteforce, AttackWebBruteforce:
		if roll < 0.96 {
			return VerdictMalicious
		}
		return VerdictSuspect
	case AttackPortScan:
		if roll < 0.90 {
			return VerdictMalicious
		}
		return VerdictSuspect
	case AttackDDoSBurst:
		if roll < 0.95 {
			return VerdictCritical
		}
		return VerdictMalicious
	case AttackSlowScan:
		if roll < 0.85 {
			return VerdictSuspect
		}
		return VerdictBenign
	}
	// None / "" / unknown: normal-traffic branch.
	f := profile.Features
	if f.IsBotUA && f.TotalRequests > 100 {
		if roll < 0.01 {
			return VerdictMalicious
		}
		if roll < 0.06 {
			return VerdictSuspect
		}
		return VerdictBenign
	}
	if f.TotalRequests > 100 || f.RatePerMin > 60 {
		if roll < 0.02 {
			return VerdictSuspect
		}
		return VerdictBenign
	}
	if roll < 0.06 {
		return VerdictSuspect
	}
	return VerdictBenign
}
