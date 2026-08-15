package helper

import (
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

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

// ---------- Scanner-level first-response ("首字") tests ----------

// The scanner-level contract is observable through ReceivedResponseCount:
// the scanner increments it together with SetFirstResponseTime under exactly
// the same condition (!IsStopped() && !IsEmptyEvent()). The FirstResponseTime
// fields themselves are not directly exercisable here because the
// isFirstResponse gate is unexported and only initialized by genBaseRelayInfo
// on the production path; the counter is the faithful observable proxy.

// TestStreamScannerHandler_EmptyEventDoesNotCountAsResponse pins the 首字
// contract: an event marked empty (no response content) must not count as a
// received response, even when it arrives before any real content.
func TestStreamScannerHandler_EmptyEventDoesNotCountAsResponse(t *testing.T) {
	t.Parallel()

	body := "data: {\"usage\":{}}\ndata: {\"usage\":{}}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
		sr.MarkEmpty()
	})

	assert.Zero(t, info.ReceivedResponseCount, "empty events must not count as received responses")
}

// TestStreamScannerHandler_ContentEventCountsAsResponse pins the complement:
// a real content event counts as the first response.
func TestStreamScannerHandler_ContentEventCountsAsResponse(t *testing.T) {
	t.Parallel()

	body := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {})

	assert.Equal(t, 1, info.ReceivedResponseCount)
}

// TestStreamScannerHandler_EmptyThenContentEvent pins reset semantics across
// events: the empty flag from a previous event must not leak into the next
// event, so a later content event still counts as the first response.
func TestStreamScannerHandler_EmptyThenContentEvent(t *testing.T) {
	t.Parallel()

	body := "data: {\"usage\":{}}\ndata: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	var eventNo atomic.Int64
	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
		if eventNo.Add(1) == 1 {
			sr.MarkEmpty()
		}
	})

	assert.Equal(t, 1, info.ReceivedResponseCount, "only the content event counts")
}

// TestStreamScannerHandler_StoppedEventDoesNotCountAsResponse pins that a
// fatal stop before any content still must not record a response.
func TestStreamScannerHandler_StoppedEventDoesNotCountAsResponse(t *testing.T) {
	t.Parallel()

	body := "data: {\"error\":\"boom\"}\ndata: [DONE]\n"
	c, resp, info := setupStreamTest(t, strings.NewReader(body))

	StreamScannerHandler(c, resp, info, func(data string, sr *StreamResult) {
		sr.Stop(fmt.Errorf("boom"))
	})

	assert.Zero(t, info.ReceivedResponseCount)
}
