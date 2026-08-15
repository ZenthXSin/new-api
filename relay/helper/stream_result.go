package helper

import (
	relaycommon "github.com/QuantumNous/new-api/relay/common"
)

// StreamResult is passed to each dataHandler invocation, providing methods
// to record soft errors, signal fatal stops, or mark normal completion.
// StreamScannerHandler checks IsStopped() after each callback invocation.
type StreamResult struct {
	status  *relaycommon.StreamStatus
	stopped bool
	// empty marks a data event that carried no actual response content
	// (e.g. usage-only chunks). Empty events must not count as the first
	// response ("首字") for first-response-time accounting.
	empty bool
}

func newStreamResult(status *relaycommon.StreamStatus) *StreamResult {
	return &StreamResult{status: status}
}

// Error records a soft error. The stream continues processing.
// Can be called multiple times per chunk.
func (r *StreamResult) Error(err error) {
	if err == nil {
		return
	}
	r.status.RecordError(err.Error())
}

// Stop records a fatal error and marks the stream to stop after this chunk.
func (r *StreamResult) Stop(err error) {
	if err != nil {
		r.status.RecordError(err.Error())
	}
	r.status.SetEndReason(relaycommon.StreamEndReasonHandlerStop, err)
	r.stopped = true
}

// Done signals that the handler has finished processing normally
// (e.g., Dify "message_end"). The stream stops after this chunk.
func (r *StreamResult) Done() {
	r.status.SetEndReason(relaycommon.StreamEndReasonDone, nil)
	r.stopped = true
}

// IsStopped returns whether Stop() or Done() was called during this chunk.
func (r *StreamResult) IsStopped() bool {
	return r.stopped
}

// MarkEmpty marks the current event as carrying no response content.
// Idempotent: once empty, the event stays empty.
func (r *StreamResult) MarkEmpty() {
	r.empty = true
}

// IsEmptyEvent returns whether the current event carried no response content.
func (r *StreamResult) IsEmptyEvent() bool {
	return r.empty
}

// reset clears the per-chunk stopped/empty flags so the object can be reused.
func (r *StreamResult) reset() {
	r.stopped = false
	r.empty = false
}
