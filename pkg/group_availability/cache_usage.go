package groupavailability

import (
	"bytes"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

const cacheUsageKey = "group_availability_cache_usage"
const maxCacheUsageTokens int64 = 2147483647

// Only upstream token facts enter this snapshot. In particular, settlement's
// locally estimated usage and converted responses cannot turn missing cache
// information into a reported zero. No response content is retained.
type cacheUsage struct {
	mu                                                       sync.Mutex
	semantic                                                 string
	input, read, creation, creation5m, creation1h, toolInput int64
	output, reasoning                                        int64
	hasOutput                                                bool
	hasInput, hasRead, invalid                               bool
}

func ResetCacheUsage(c *gin.Context) {
	if Default != nil {
		c.Set(cacheUsageKey, &cacheUsage{})
		c.Set(relayUsageKey, relayUsage{})
	}
}

// ObserveCacheUsage receives bytes already read by a provider handler, before
// any usage estimation or response conversion. GetBytes copies only the small
// matching usage object, never the complete (possibly image-sized) response.
func ObserveCacheUsage(c *gin.Context, data []byte) {
	if Default == nil || c == nil || (!bytes.Contains(data, []byte(`"usage"`)) && !bytes.Contains(data, []byte(`"usageMetadata"`))) {
		return
	}
	for _, path := range []string{"usage", "response.usage", "message.usage", "usageMetadata"} {
		if usage := gjson.GetBytes(data, path); usage.IsObject() {
			observeCacheFields(c, usage, path == "usageMetadata", path == "message.usage")
		}
	}
}

// The scanner already owns data as a string. Avoid converting and copying a
// whole SSE chunk; ordinary token deltas have no usage and return immediately.
func ObserveCacheUsageString(c *gin.Context, data string) {
	if Default == nil || c == nil || (!strings.Contains(data, `"usage"`) && !strings.Contains(data, `"usageMetadata"`)) {
		return
	}
	for _, path := range []string{"usage", "response.usage", "message.usage", "usageMetadata"} {
		if usage := gjson.Get(data, path); usage.IsObject() {
			observeCacheFields(c, usage, path == "usageMetadata", path == "message.usage")
		}
	}
}

func observeCacheFields(c *gin.Context, usage gjson.Result, gemini, claudeMessage bool) {
	value, exists := c.Get(cacheUsageKey)
	if !exists {
		ResetCacheUsage(c)
		value, _ = c.Get(cacheUsageKey)
	}
	state, ok := value.(*cacheUsage)
	if !ok {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if !gjson.Valid(usage.Raw) {
		state.invalid = true
		return
	}
	semantic := "openai"
	input := usage.Get("prompt_tokens")
	if !input.Exists() {
		input = usage.Get("input_tokens")
	}
	output := usage.Get("completion_tokens")
	if !output.Exists() {
		output = usage.Get("output_tokens")
	}
	read := usage.Get("prompt_tokens_details.cached_tokens")
	if !read.Exists() {
		read = usage.Get("input_tokens_details.cached_tokens")
	}
	if !read.Exists() {
		read = usage.Get("prompt_cache_hit_tokens")
	}
	if (!usage.Get("prompt_tokens").Exists() && !usage.Get("input_tokens_details").Exists() && (usage.Get("cache_read_input_tokens").Exists() || usage.Get("cache_creation_input_tokens").Exists())) || claudeMessage || state.semantic == "anthropic" {
		semantic, input, read = "anthropic", usage.Get("input_tokens"), usage.Get("cache_read_input_tokens")
	}
	if gemini {
		semantic, input, read = "gemini", usage.Get("promptTokenCount"), usage.Get("cachedContentTokenCount")
		output = usage.Get("candidatesTokenCount")
	}
	if state.semantic != "" && semantic != state.semantic {
		state.invalid = true
		return
	}
	if state.semantic == "" {
		state.semantic = semantic
	}
	// Actual upstream counts are bounded independently of quota conversion.
	// Reject fractional, negative, overflowed and inconsistent facts; do not
	// saturate them into a misleading percentage or alter billable quantities.
	for _, field := range []struct {
		value   gjson.Result
		target  *int64
		present *bool
	}{
		{input, &state.input, &state.hasInput}, {read, &state.read, &state.hasRead},
		{output, &state.output, &state.hasOutput},
		{usage.Get("thoughtsTokenCount"), &state.reasoning, nil},
		{usage.Get("toolUsePromptTokenCount"), &state.toolInput, nil},
		{usage.Get("cache_creation_input_tokens"), &state.creation, nil},
		{usage.Get("cache_creation.ephemeral_5m_input_tokens"), &state.creation5m, nil},
		{usage.Get("cache_creation.ephemeral_1h_input_tokens"), &state.creation1h, nil},
	} {
		if !field.value.Exists() {
			continue
		}
		n, err := strconv.ParseInt(field.value.Raw, 10, 64)
		if field.value.Type != gjson.Number || err != nil || n < 0 || n > maxCacheUsageTokens {
			state.invalid = true
			continue
		}
		*field.target = n
		if field.present != nil {
			*field.present = true
		}
	}
}

func cacheUsageSnapshot(c *gin.Context) (int64, int64) {
	if c == nil {
		return 0, 0
	}
	value, exists := c.Get(cacheUsageKey)
	if !exists {
		return 0, 0
	}
	state, ok := value.(*cacheUsage)
	if !ok {
		return 0, 0
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.invalid || !state.hasInput || !state.hasRead {
		return 0, 0
	}
	total := state.input
	if state.semantic == "anthropic" {
		// Claude input_tokens excludes cache creation/read; OpenAI and Gemini
		// prompt counts already include cached input. Never add it twice.
		total += state.read + max(state.creation, state.creation5m+state.creation1h)
	}
	if state.semantic == "gemini" {
		total += state.toolInput
	}
	if total <= 0 || total > maxCacheUsageTokens || state.read > total {
		return 0, 0
	}
	return total, state.read
}

const relayUsageKey = "group_availability_relay_usage"

type relayUsage struct {
	input, output int64
	hasInput      bool
	endedAt       time.Time
}

// ObserveRelayUsage captures the adapter's normalized usage before settlement
// writes. This covers providers without raw cache hooks and avoids adding DB
// settlement time to the generation duration. Billing usage is never mutated.
func ObserveRelayUsage(c *gin.Context, usage *dto.Usage) {
	if Default == nil || c == nil || usage == nil {
		return
	}
	input := int64(usage.InputTokens)
	if input <= 0 {
		input = int64(usage.PromptTokens)
		if usage.UsageSemantic == dto.BillingUsageSemanticAnthropic {
			input += int64(usage.PromptTokensDetails.CachedTokens) + int64(usage.PromptTokensDetails.CacheCreationTokensTotal())
		}
	}
	output := int64(usage.CompletionTokens)
	if output == 0 {
		output = int64(usage.OutputTokens)
	}
	c.Set(relayUsageKey, relayUsage{input: input, output: output, hasInput: input > 0, endedAt: time.Now()})
}

func tokenUsageSnapshot(c *gin.Context) relayUsage {
	result := relayUsage{}
	if c == nil {
		return result
	}
	if value, exists := c.Get(relayUsageKey); exists {
		result, _ = value.(relayUsage)
	}
	if value, exists := c.Get(cacheUsageKey); exists {
		if state, ok := value.(*cacheUsage); ok {
			state.mu.Lock()
			defer state.mu.Unlock()
			if !state.invalid {
				if state.hasInput {
					total := state.input
					if state.semantic == "anthropic" {
						total += state.read + max(state.creation, state.creation5m+state.creation1h)
					}
					if state.semantic == "gemini" {
						total += state.toolInput
					}
					if total >= 0 && total <= maxCacheUsageTokens {
						result.input = total
						result.hasInput = true
					}
				}
				if state.hasOutput && state.output+state.reasoning <= maxCacheUsageTokens {
					result.output = state.output + state.reasoning
				}
			}
		}
	}
	return result
}
