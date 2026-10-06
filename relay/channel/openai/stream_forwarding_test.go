package openai

import (
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The upstream cannot send its next event until the first has been flushed.
type gatedOaiStreamBody struct {
	first     *strings.Reader
	rest      *strings.Reader
	forwarded <-chan struct{}
	closed    chan struct{}
	closeOnce sync.Once
}

func (b *gatedOaiStreamBody) Read(p []byte) (int, error) {
	if b.first.Len() > 0 {
		return b.first.Read(p)
	}
	select {
	case <-b.forwarded:
		return b.rest.Read(p)
	case <-b.closed:
		return 0, io.EOF
	}
}

func (b *gatedOaiStreamBody) Close() error {
	b.closeOnce.Do(func() { close(b.closed) })
	return nil
}

func TestOaiStreamHandlerForwardsBeforeNextEvent(t *testing.T) {
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 5
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	for _, tc := range []struct {
		name              string
		first             string
		marker            string
		format            types.RelayFormat
		mode              int
		includeUsage      bool
		forceFormat       bool
		thinkingToContent bool
	}{
		{name: "role", first: `{"choices":[{"index":0,"delta":{"role":"assistant"}}]}`, marker: `"role":"assistant"`},
		{name: "content", first: `{"choices":[{"index":0,"delta":{"content":"first-text"}}]}`, marker: "first-text"},
		{name: "reasoning", first: `{"choices":[{"index":0,"delta":{"reasoning_content":"first-thought"}}]}`, marker: "first-thought"},
		{name: "forced formatting", first: `{"choices":[{"index":0,"delta":{"content":"first-text"}}]}`, marker: "first-text", forceFormat: true},
		{name: "thinking to content", first: `{"choices":[{"index":0,"delta":{"reasoning_content":"first-thought"}}]}`, marker: "first-thought", thinkingToContent: true},
		{name: "tool call", first: `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"first_tool","arguments":"{}"}}]}}]}`, marker: "first_tool"},
		{name: "content with usage", first: `{"choices":[{"index":0,"delta":{"content":"first-text"}}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}`, marker: "first-text"},
		{name: "requested usage", first: `{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}`, marker: `"total_tokens":11`, includeUsage: true},
		{name: "audio", first: `{"choices":[{"index":0,"delta":{"audio":{"data":"first-audio"}}}]}`, marker: "first-audio"},
		{name: "completions", first: `{"choices":[{"index":0,"text":"first-text"}]}`, marker: "first-text", mode: relayconstant.RelayModeCompletions},
		{name: "Claude role", first: `{"choices":[{"index":0,"delta":{"role":"assistant"}}]}`, marker: "event: message_start", format: types.RelayFormatClaude},
		{name: "Claude content", first: `{"choices":[{"index":0,"delta":{"content":"first-text"}}]}`, marker: "first-text", format: types.RelayFormatClaude},
		{name: "Gemini content", first: `{"choices":[{"index":0,"delta":{"content":"first-text"}}]}`, marker: "first-text", format: types.RelayFormatGemini},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _, resp, info := newResponsesChatTestContext(t, "", true)
			info.RelayMode = relayconstant.RelayModeChatCompletions
			if tc.mode != 0 {
				info.RelayMode = tc.mode
			}
			if tc.format != "" {
				info.RelayFormat = tc.format
			}
			info.EnsureClaudeConvertInfo()
			info.ShouldIncludeUsage = tc.includeUsage
			info.ChannelSetting.ForceFormat = tc.forceFormat
			info.ChannelSetting.ThinkingToContent = tc.thinkingToContent
			info.ThinkingContentInfo.IsFirstThinkingContent = true
			info.SetEstimatePromptTokens(100)
			writer := &observedStreamWriter{ResponseRecorder: httptest.NewRecorder(), marker: tc.marker, forwarded: make(chan struct{})}
			request := c.Request
			c, _ = gin.CreateTestContext(writer)
			c.Request = request
			resp.Body = &gatedOaiStreamBody{
				first:     strings.NewReader("data: " + tc.first + "\n\n"),
				rest:      strings.NewReader("data: " + `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}` + "\n\ndata: [DONE]\n\n"),
				forwarded: writer.forwarded,
				closed:    make(chan struct{}),
			}

			usage, apiErr := OaiStreamHandler(c, info, resp)
			require.Nil(t, apiErr)
			require.NotNil(t, info.StreamStatus)
			assert.Equal(t, relaycommon.StreamEndReasonDone, info.StreamStatus.EndReason, "the next upstream event must be released by the first downstream flush, not a timeout")
			require.NotNil(t, usage)
			assert.Equal(t, 10, usage.PromptTokens)
			assert.Equal(t, 3, usage.CompletionTokens)
			assert.Equal(t, 13, usage.TotalTokens)
			assert.Equal(t, 1, strings.Count(writer.Body.String(), tc.marker), "do not replay the first event at finalization")
		})
	}
}

func TestOaiStreamHandlerPreservesNativeTailAndUsage(t *testing.T) {
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 5
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	const role = `{"id":"chat_forward","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"}}]}`
	const content = `{"id":"chat_forward","model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"}}]}`
	const stop = `{"id":"chat_forward","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`
	const reportedUsage = `{"id":"chat_forward","model":"gpt-test","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}`
	const combined = `{"id":"chat_forward","model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}`
	const audioUsage = `{"id":"chat_forward","model":"gpt-test-audio","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13,"prompt_tokens_details":{"audio_tokens":7},"completion_tokens_details":{"audio_tokens":2}}}`
	for _, tc := range []struct {
		name         string
		events       []string
		wantEvents   []string
		includeUsage bool
		audio        bool
		estimated    bool
		eof          bool
	}{
		{name: "omit unrequested final usage", events: []string{role, content, stop, reportedUsage}, wantEvents: []string{role, content, stop}},
		{name: "include requested usage once", events: []string{role, content, stop, reportedUsage}, wantEvents: []string{role, content, stop, reportedUsage}, includeUsage: true},
		{name: "single content and usage event", events: []string{combined}, wantEvents: []string{combined}},
		{name: "single content at EOF", events: []string{content}, wantEvents: []string{content}, estimated: true, eof: true},
		{name: "estimate without upstream usage", events: []string{role, content, stop}, wantEvents: []string{role, content, stop}, estimated: true},
		{name: "retain intermediate usage", events: []string{role, reportedUsage, content, stop, reportedUsage}, wantEvents: []string{role, reportedUsage, content, stop}},
		{name: "audio penultimate usage", events: []string{role, content, audioUsage, stop}, wantEvents: []string{role, content, audioUsage, stop}, audio: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var input, expected strings.Builder
			for _, event := range tc.events {
				input.WriteString("data: " + event + "\n\n")
			}
			if !tc.eof {
				input.WriteString("data: [DONE]\n\n")
			}
			for _, event := range tc.wantEvents {
				expected.WriteString("data: " + event + "\n\n")
			}
			expected.WriteString("data: [DONE]\n\n")
			c, recorder, resp, info := newResponsesChatTestContext(t, input.String(), true)
			info.RelayMode = relayconstant.RelayModeChatCompletions
			info.ShouldIncludeUsage = tc.includeUsage
			info.SetEstimatePromptTokens(100)
			if tc.audio {
				info.UpstreamModelName = "gpt-test-audio"
			}

			usage, apiErr := OaiStreamHandler(c, info, resp)
			require.Nil(t, apiErr)
			require.NotNil(t, usage)
			assert.Equal(t, expected.String(), recorder.Body.String(), "preserve event order without replaying the final delta or DONE")
			if tc.estimated {
				assert.Equal(t, 100, usage.PromptTokens)
				assert.Equal(t, service.EstimateTokenByModel(info.UpstreamModelName, "hello"), usage.CompletionTokens)
			} else {
				assert.Equal(t, 10, usage.PromptTokens)
				assert.Equal(t, 3, usage.CompletionTokens)
			}
			assert.Equal(t, usage.PromptTokens+usage.CompletionTokens, usage.TotalTokens)
			if tc.audio {
				assert.Equal(t, 7, usage.PromptTokensDetails.AudioTokens)
				assert.Equal(t, 2, usage.CompletionTokenDetails.AudioTokens)
			}
		})
	}
}

func TestOaiStreamHandlerPreservesConvertedTail(t *testing.T) {
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 5
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	const first = `{"id":"chat_forward","model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"}}]}`
	const finish = `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`
	const usageOnly = `{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}`
	const combined = `{"id":"chat_forward","model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}`
	for _, tc := range []struct {
		name      string
		events    []string
		estimated bool
	}{
		{name: "split usage", events: []string{first, finish, usageOnly}},
		{name: "terminal without usage", events: []string{first, finish}, estimated: true},
		{name: "single content without terminal", events: []string{first}, estimated: true},
		{name: "single combined terminal", events: []string{combined}},
	} {
		for _, format := range []types.RelayFormat{types.RelayFormatClaude, types.RelayFormatGemini} {
			t.Run(tc.name+"/"+string(format), func(t *testing.T) {
				body := "data: " + strings.Join(tc.events, "\n\ndata: ") + "\n\ndata: [DONE]\n\n"
				c, recorder, resp, info := newResponsesChatTestContext(t, body, true)
				info.RelayMode = relayconstant.RelayModeChatCompletions
				info.RelayFormat = format
				info.EnsureClaudeConvertInfo()
				info.SetEstimatePromptTokens(100)
				usage, apiErr := OaiStreamHandler(c, info, resp)
				require.Nil(t, apiErr)
				require.NotNil(t, usage)
				got := recorder.Body.String()
				assert.Equal(t, 1, strings.Count(got, `"hello"`), "finalization must not replay the last content delta")
				assert.NotContains(t, got, "data: [DONE]", "converted protocols have their own terminal events")
				if tc.estimated {
					assert.Equal(t, 100, usage.PromptTokens)
					assert.Equal(t, service.EstimateTokenByModel(info.UpstreamModelName, "hello"), usage.CompletionTokens)
				} else {
					assert.Equal(t, 10, usage.PromptTokens)
					assert.Equal(t, 3, usage.CompletionTokens)
				}
				if format == types.RelayFormatClaude {
					assert.Equal(t, 1, strings.Count(got, "event: message_start\n"))
					assert.Equal(t, 1, strings.Count(got, "event: content_block_stop\n"))
					assert.Equal(t, 1, strings.Count(got, "event: message_delta\n"))
					assert.Equal(t, 1, strings.Count(got, "event: message_stop\n"))
					assert.True(t, info.ClaudeConvertInfo.Done)
					requireOrderedSubstrings(t, got, "event: message_start", `"hello"`, "event: content_block_stop", "event: message_delta", "event: message_stop")
				} else if tc.name != "single content without terminal" {
					assert.Equal(t, 1, strings.Count(got, `"finishReason":"STOP"`))
				}
			})
		}
	}
}
