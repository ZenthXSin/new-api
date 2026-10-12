package groupavailability

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
)

type relayOutcome int

const (
	relayIgnored relayOutcome = iota
	relaySuccess
	relayFailure
)

const streamObservationKey = "group_availability_stream_observation"

// The release's stream status predates protocol terminal events. Observe the
// existing scanner's data without changing forwarding, stopping, or billing.
// State belongs to this Gin request and is reset for each upstream attempt.
type streamObservation struct {
	mu             sync.Mutex
	terminal       bool
	failed         bool
	ignored        bool
	choices        map[int]bool
	candidates     map[int]bool
	observed       bool
	previousStream *relaycommon.StreamStatus
}

// Reset at the start of each attempt, including JSON responses after an earlier
// stream attempt. A previous attempt's StreamStatus must not taint the result.
func BeginAttempt(c *gin.Context, info *relaycommon.RelayInfo) {
	ResetCacheUsage(c)
	if Default != nil {
		// Reject markers describe the final upstream attempt, just like stream
		// status. Do not let a previous refused attempt hide a later outcome.
		common.SetContextKey(c, constant.ContextKeyAdminRejectReason, "")
		c.Set(streamObservationKey, &streamObservation{previousStream: info.StreamStatus})
	}
}

func BeginStream(c *gin.Context) {
	ResetCacheUsage(c)
	if Default != nil {
		c.Set(streamObservationKey, &streamObservation{observed: true})
	}
}

func ObserveStream(c *gin.Context, data string) {
	ObserveCacheUsageString(c, data)
	value, exists := c.Get(streamObservationKey)
	if !exists {
		return
	}
	state := value.(*streamObservation)
	var event struct {
		Type       string          `json:"type"`
		Event      string          `json:"event"`
		Status     any             `json:"status"`
		StatusCode int             `json:"status_code"`
		Error      json.RawMessage `json:"error"`
		Response   struct {
			Status            string          `json:"status"`
			Error             json.RawMessage `json:"error"`
			IncompleteDetails struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
		} `json:"response"`
		Delta struct {
			StopReason string `json:"stop_reason"`
		} `json:"delta"`
		Choices []struct {
			Index        int    `json:"index"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Candidates []struct {
			Index        int    `json:"index"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		PromptFeedback struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
	}
	if common.Unmarshal([]byte(data), &event) != nil {
		return // Existing handlers remain responsible for malformed responses.
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	errorObserved := false
	eventIgnored := false
	for _, raw := range []json.RawMessage{event.Error, event.Response.Error} {
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		errorObserved = true
		outcome := classifyStreamFailure(raw, event.Status, event.StatusCode)
		state.failed = state.failed || outcome == relayFailure
		state.ignored = state.ignored || outcome == relayIgnored
		eventIgnored = eventIgnored || outcome == relayIgnored
	}
	// Responses error events may carry code/status directly, without an error
	// object. A normal chunk's type/status must never be treated as an error.
	if !errorObserved && (event.Type == "error" || event.Type == "response.error") {
		outcome := classifyStreamFailure(json.RawMessage(data), nil, 0)
		state.failed = state.failed || outcome == relayFailure
		state.ignored = state.ignored || outcome == relayIgnored
		eventIgnored = eventIgnored || outcome == relayIgnored
	}
	switch event.Type {
	case "response.completed", "response.done", "message_stop", "image_generation.completed", "image_edit.completed":
		state.terminal = true
	case "response.failed", "response.error", "error":
		if !eventIgnored {
			state.failed = true
		}
	case "response.cancelled", "response.canceled":
		state.ignored = true
	case "response.incomplete":
		switch event.Response.IncompleteDetails.Reason {
		case "max_output_tokens", "max_tokens":
			state.terminal = true
		case "content_filter", "safety", "content_policy_violation":
			state.ignored = true
		default:
			state.failed = true
		}
	}
	if event.Response.Status == "failed" && !eventIgnored {
		state.failed = true
	}
	if event.Event == "message_end" {
		state.terminal = true
	}
	if event.Delta.StopReason == "refusal" || event.PromptFeedback.BlockReason != "" {
		state.ignored = true
	}
	for _, choice := range event.Choices {
		if state.choices == nil {
			state.choices = make(map[int]bool)
		}
		if _, exists := state.choices[choice.Index]; !exists {
			state.choices[choice.Index] = false
		}
		switch choice.FinishReason {
		case "":
		case "content_filter", "safety", "refusal":
			state.ignored = true
		default:
			state.choices[choice.Index] = true
		}
	}
	for _, candidate := range event.Candidates {
		if state.candidates == nil {
			state.candidates = make(map[int]bool)
		}
		if _, exists := state.candidates[candidate.Index]; !exists {
			state.candidates[candidate.Index] = false
		}
		switch candidate.FinishReason {
		case "", "FINISH_REASON_UNSPECIFIED":
		case "STOP", "MAX_TOKENS":
			state.candidates[candidate.Index] = true
		case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY":
			state.ignored = true
		default:
			state.failed = true
		}
	}
}

func RecordRelayResultWithContext(c *gin.Context, info *relaycommon.RelayInfo, apiErr *types.NewAPIError) {
	if Default == nil || c == nil || c.Request == nil || info == nil {
		return
	}
	var state *streamObservation
	if value, exists := c.Get(streamObservationKey); exists {
		state, _ = value.(*streamObservation)
	}
	// Some JSON adaptors write a refusal/error response but return usage,nil.
	// Use only their structured marker, and never hide a real returned failure.
	if classifyRelayOutcome(c.Request.Context(), info, apiErr, state) == relaySuccess {
		reason := common.GetContextKeyString(c, constant.ContextKeyAdminRejectReason)
		if reason == "claude_stop_reason=refusal" || reason == "openai_finish_reason=content_filter" {
			return
		}
		if blockReason, ok := strings.CutPrefix(reason, "gemini_block_reason="); ok && strings.TrimSpace(blockReason) != "" {
			return
		}
		if reason == "gemini_empty_candidates" {
			apiErr = types.NewError(errors.New("empty upstream candidates"), types.ErrorCodeEmptyResponse)
		}
	}
	input, read := cacheUsageSnapshot(c)
	recordRelayResult(c.Request.Context(), info, apiErr, state, input, read, tokenUsageSnapshot(c))
}

// Also available for non-scanner callers and API-contract tests.
func RecordRelayResult(ctx context.Context, info *relaycommon.RelayInfo, apiErr *types.NewAPIError) {
	recordRelayResult(ctx, info, apiErr, nil, 0, 0, relayUsage{})
}

func recordRelayResult(ctx context.Context, info *relaycommon.RelayInfo, apiErr *types.NewAPIError, state *streamObservation, input, read int64, usage relayUsage) {
	if Default == nil || info == nil {
		return
	}
	outcome := classifyRelayOutcome(ctx, info, apiErr, state)
	if outcome == relayIgnored {
		return
	}
	// Upstream facts take precedence; a missing usage snapshot can still
	// classify a failed large request using the existing local token estimate.
	inputTokens := usage.input
	if !usage.hasInput {
		inputTokens = int64(info.GetEstimatePromptTokens())
	}
	if inputTokens <= MinInputTokens || inputTokens > maxCacheUsageTokens {
		return
	}
	endedAt := usage.endedAt
	if endedAt.IsZero() {
		endedAt = time.Now()
	}
	generationMs := endedAt.Sub(info.StartTime).Milliseconds()
	hasTtft := info.IsStream && info.HasSendResponse()
	if hasTtft {
		generationMs = endedAt.Sub(info.FirstResponseTime).Milliseconds()
	}
	Default.Record(Sample{InputTokens: inputTokens, OutputTokens: usage.output, GenerationMs: generationMs, Group: info.UsingGroup, Success: outcome == relaySuccess,
		CacheInputTokens: input, CacheReadTokens: read,
		LatencyMs: endedAt.Sub(info.StartTime).Milliseconds(), HasTtft: hasTtft,
		TtftMs: info.FirstResponseTime.Sub(info.StartTime).Milliseconds()})
}

func classifyRelayOutcome(ctx context.Context, info *relaycommon.RelayInfo, apiErr *types.NewAPIError, state *streamObservation) relayOutcome {
	if info == nil || (ctx != nil && ctx.Err() == context.Canceled) || (apiErr != nil && errors.Is(apiErr, context.Canceled)) {
		return relayIgnored
	}
	if apiErr != nil {
		root := apiErr
		for {
			var inner *types.NewAPIError
			if !errors.As(root.Unwrap(), &inner) || inner == root {
				break
			}
			root = inner
		}
		return classifyFailure(root.GetErrorType() == types.ErrorTypeNewAPIError, string(root.GetErrorCode()), root.ToOpenAIError().Type, root.StatusCode)
	}
	terminal := false
	stream := info.StreamStatus
	observed := false
	if state != nil {
		state.mu.Lock()
		failed, ignored := state.failed, state.ignored
		terminal = state.terminal
		observed = state.observed
		if !observed && stream == state.previousStream {
			stream = nil
		}
		expected := 1
		switch request := info.Request.(type) {
		case *dto.GeneralOpenAIRequest:
			if request.N != nil {
				expected = max(1, *request.N)
			}
		case *dto.GeminiChatRequest:
			if request.GenerationConfig.CandidateCount != nil {
				expected = max(1, *request.GenerationConfig.CandidateCount)
			}
		}
		for _, choices := range []map[int]bool{state.choices, state.candidates} {
			allDone := len(choices) >= expected
			for _, done := range choices {
				allDone = allDone && done
			}
			terminal = terminal || allDone
		}
		state.mu.Unlock()
		if failed {
			return relayFailure
		}
		if ignored {
			return relayIgnored
		}
	}
	if stream != nil {
		deadline := errors.Is(stream.EndError, context.DeadlineExceeded)
		if stream.EndReason == relaycommon.StreamEndReasonPingFail || (stream.EndReason == relaycommon.StreamEndReasonClientGone && !deadline) {
			return relayIgnored
		}
		if stream.HasErrors() || deadline {
			return relayFailure
		}
		switch stream.EndReason {
		case relaycommon.StreamEndReasonTimeout, relaycommon.StreamEndReasonScannerErr, relaycommon.StreamEndReasonPanic:
			return relayFailure
		case relaycommon.StreamEndReasonDone:
			terminal = true
		}
	}
	// A clean EOF alone is not evidence that a streamed generation completed.
	// Some adaptors turn a fully validated JSON response into downstream SSE.
	// They have no upstream scanner; their successful return is authoritative.
	if (observed || stream != nil) && !terminal {
		return relayFailure
	}
	return relaySuccess
}

func classifyStreamFailure(raw json.RawMessage, outerStatus any, outerStatusCode int) relayOutcome {
	var upstream struct {
		Code       any    `json:"code"`
		Type       string `json:"type"`
		Status     any    `json:"status"`
		StatusCode int    `json:"status_code"`
	}
	if common.Unmarshal(raw, &upstream) != nil {
		return relayFailure
	}
	code, codeStatus := upstreamErrorSignal(upstream.Code)
	statusType, innerStatus := upstreamErrorSignal(upstream.Status)
	outerType, parentStatus := upstreamErrorSignal(outerStatus)
	status := 0
	for _, candidate := range []int{upstream.StatusCode, innerStatus, codeStatus, outerStatusCode, parentStatus} {
		if candidate == 401 || candidate == 403 || candidate == 408 || candidate == 429 || candidate >= 500 {
			status = candidate
			break
		}
		if status == 0 && candidate >= 100 && candidate <= 599 {
			status = candidate
		}
	}
	return classifyFailure(false, code, upstream.Type, status, statusType, outerType)
}

func upstreamErrorSignal(value any) (string, int) {
	switch value := value.(type) {
	case float64:
		if value >= 100 && value <= 599 && value == float64(int(value)) {
			return "", int(value)
		}
	case string:
		value = strings.TrimSpace(value)
		if status, err := strconv.Atoi(value); err == nil && status >= 100 && status <= 599 {
			return "", status
		}
		return value, 0
	}
	return "", 0
}

func classifyFailure(local bool, code, errorType string, status int, statusTypes ...string) relayOutcome {
	code, errorType = strings.ToLower(strings.TrimSpace(code)), strings.ToLower(strings.TrimSpace(errorType))
	if local {
		if strings.HasPrefix(code, "violation_fee.") {
			return relayIgnored
		}
		switch types.ErrorCode(code) {
		case types.ErrorCodeInvalidRequest, types.ErrorCodeSensitiveWordsDetected, types.ErrorCodeReadRequestBodyFailed,
			types.ErrorCodeConvertRequestFailed, types.ErrorCodeAccessDenied, types.ErrorCodeBadRequestBody,
			types.ErrorCodeInsufficientUserQuota, types.ErrorCodePreConsumeTokenQuotaFailed, types.ErrorCodePromptBlocked,
			types.ErrorCodeCountTokenFailed:
			return relayIgnored
		}
		return relayFailure
	}
	values := append([]string{code, errorType}, statusTypes...)
	for index := range values {
		values[index] = strings.ToLower(strings.TrimSpace(values[index]))
	}
	// A provider may combine a generic invalid-request type with a concrete
	// authentication, throttling or outage code. Concrete failures take priority.
	for _, value := range values {
		switch value {
		case "invalid_api_key", "api_key_invalid", "api_key_expired", "api_key_service_blocked", "invalid_authentication",
			"authentication_error", "unauthenticated", "permission_denied", "permission_error", "access_denied",
			"insufficient_quota", "quota_exceeded", "resource_exhausted", "rate_limit_exceeded", "rate_limit_error",
			"overloaded_error", "server_error", "internal_error", "internal", "service_unavailable", "unavailable", "model_not_found",
			"timeout", "request_timeout", "deadline_exceeded",
			"insufficient_user_quota", "pre_consume_token_quota_failed":
			return relayFailure
		}
	}
	for _, value := range values {
		switch value {
		case "context_length_exceeded", "context_window_exceeded", "invalid_argument", "invalid_parameter", "invalid_value",
			"unsupported_parameter", "unsupported_value", "missing_required_parameter", "request_too_large", "request_too_large_error",
			"sensitive_words_detected", "prompt_blocked", "content_filter", "content_policy_violation", "safety":
			return relayIgnored
		}
		if strings.HasPrefix(value, "violation_fee.") {
			return relayIgnored
		}
	}
	// HTTP failure statuses must not be hidden by a generic invalid_request type.
	// Specific parameter/content codes above survive configured status rewrites.
	if status == 401 || status == 403 || status == 408 || status == 429 || status >= 500 {
		return relayFailure
	}
	for _, value := range values {
		if value == "invalid_request" || value == "invalid_request_error" {
			return relayIgnored
		}
	}
	switch status {
	case 400, 405, 409, 413, 415, 422:
		return relayIgnored
	}
	return relayFailure
}
