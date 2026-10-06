package helper

import (
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------- StreamResult empty-event unit tests ----------

func TestStreamResult_EmptyDefaultsFalse(t *testing.T) {
	t.Parallel()

	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{}}
	info.StreamStatus = relaycommon.NewStreamStatus()
	sr := newStreamResult(info.StreamStatus)

	assert.False(t, sr.IsEmptyEvent(), "a fresh StreamResult must not be empty")
}

func TestStreamResult_MarkEmptyIsIdempotent(t *testing.T) {
	t.Parallel()

	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{}}
	info.StreamStatus = relaycommon.NewStreamStatus()
	sr := newStreamResult(info.StreamStatus)

	sr.MarkEmpty()
	require.True(t, sr.IsEmptyEvent())

	// Idempotent: marking again keeps the event empty.
	sr.MarkEmpty()
	assert.True(t, sr.IsEmptyEvent())
}

func TestStreamResult_ResetClearsEmpty(t *testing.T) {
	t.Parallel()

	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{}}
	info.StreamStatus = relaycommon.NewStreamStatus()
	sr := newStreamResult(info.StreamStatus)

	sr.MarkEmpty()
	sr.Stop(fmt.Errorf("fatal"))
	require.True(t, sr.IsEmptyEvent())
	require.True(t, sr.IsStopped())

	// reset() must clear both per-event flags so the object can be reused
	// for the next stream event.
	sr.reset()
	assert.False(t, sr.IsEmptyEvent(), "reset must clear the empty flag")
	assert.False(t, sr.IsStopped(), "reset must clear the stopped flag")
}

// Event timing and content-response counts have separate contracts.
func TestStreamScannerHandler_EmptyEventDoesNotCountAsResponse(t *testing.T) {
	t.Parallel()

	body := "data: {\"usage\":{}}\ndata: {\"usage\":{}}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
		sr.MarkEmpty()
	})

	assert.Zero(t, info.ReceivedResponseCount, "empty events must not count as received responses")
	assert.NotEqual(t, info.StartTime.Add(-time.Second), info.FirstResponseTime, "empty data events must establish first-response time")
}

func TestStreamScannerHandler_ContentEventCountsAsResponse(t *testing.T) {
	t.Parallel()

	body := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {})

	assert.Equal(t, 1, info.ReceivedResponseCount)
}

func TestStreamScannerHandler_EmptyThenContentEvent(t *testing.T) {
	t.Parallel()

	body := "data: {\"usage\":{}}\ndata: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	var eventNo atomic.Int64
	var firstEventTime time.Time
	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
		if eventNo.Add(1) == 1 {
			firstEventTime = info.FirstResponseTime
			sr.MarkEmpty()
		}
	})

	assert.Equal(t, 1, info.ReceivedResponseCount, "only the content event counts")
	assert.NotEqual(t, info.StartTime.Add(-time.Second), firstEventTime, "timing must be set before handling the first empty event")
	assert.Equal(t, firstEventTime, info.FirstResponseTime, "later content must not replace first-event time")
}

func TestStreamScannerHandler_StoppedEventDoesNotCountAsResponse(t *testing.T) {
	t.Parallel()

	body := "data: {\"error\":\"boom\"}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
		sr.Stop(fmt.Errorf("boom"))
	})

	assert.Zero(t, info.ReceivedResponseCount)
	assert.NotEqual(t, info.StartTime.Add(-time.Second), info.FirstResponseTime, "an upstream error event still establishes first-response time")
}

func TestStreamScannerHandler_FirstEventTimingPrecedesHandling(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name    string
		payload string
	}{
		{name: "role_only", payload: `{"choices":[{"delta":{"role":"assistant"}}]}`},
		{name: "usage_only", payload: `{"choices":[],"usage":{"total_tokens":1}}`},
		{name: "responses_created", payload: `{"type":"response.created"}`},
		{name: "claude_message_start", payload: `{"type":"message_start"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, resp, info := setupStreamTest(t, strings.NewReader("data: "+tc.payload+"\n\ndata: [DONE]\n\n"))
			info.Timing = common.NewRelayTiming(info.StartTime)
			info.Timing.BeginAttempt(info.StartTime)

			var got string
			var firstTimeAtHandler time.Time
			var timingSetAtHandler bool
			StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
				got = data
				firstTimeAtHandler = info.FirstResponseTime
				timingSetAtHandler = !firstTimeAtHandler.Equal(info.StartTime.Add(-time.Second)) && info.Timing.HasValidEvent()
				sr.MarkEmpty()
			})

			require.Equal(t, tc.payload, got)
			assert.True(t, timingSetAtHandler, "record the event before conversion or downstream writes")
			assert.Equal(t, firstTimeAtHandler, info.FirstResponseTime)
			assert.Zero(t, info.ReceivedResponseCount)
		})
	}
}

func TestStreamScannerHandler_NonEventsDoNotStartTiming(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "empty"},
		{name: "heartbeat", body: ": PING\n\n"},
		{name: "metadata_only", body: "event: message\nid: 1\nretry: 1000\n\n"},
		{name: "blank_data", body: "data:   \n\n"},
		{name: "done_only", body: "data: [DONE]\n\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, resp, info := setupStreamTest(t, strings.NewReader(tc.body))
			info.Timing = common.NewRelayTiming(info.StartTime)
			var handled bool
			StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
				handled = true
			})

			assert.False(t, handled)
			assert.False(t, info.HasSendResponse())
			assert.False(t, info.Timing.HasValidEvent())
			assert.Equal(t, info.StartTime.Add(-time.Second), info.FirstResponseTime)
		})
	}
}
