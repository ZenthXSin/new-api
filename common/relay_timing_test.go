package common

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRelayTimingSnapshotUsesWinningAttemptAndPostEventWrite(t *testing.T) {
	base := time.Unix(100, 0)
	timing := NewRelayTiming(base)
	stale := timing.BeginAttempt(base.Add(10 * time.Millisecond))
	winning := timing.BeginAttempt(base.Add(40 * time.Millisecond))
	stale.firstByte(base.Add(15 * time.Millisecond))
	winning.gotConn(true)
	timing.RecordWrite(3, nil, base.Add(30*time.Millisecond)) // ping before event
	timing.CommitValidEvent(base.Add(60 * time.Millisecond))
	timing.RecordWrite(7, nil, base.Add(70*time.Millisecond))
	timing.SetEndStatus("normal")
	snapshot := timing.Snapshot(base.Add(80 * time.Millisecond))
	require.Equal(t, int64(40), snapshot["site_processing_ms"])
	require.Equal(t, int64(20), snapshot["upstream_first_event_ms"])
	require.Equal(t, int64(10), snapshot["relay_processing_ms"])
	require.Equal(t, int64(0), snapshot["downstream_send_ms"])
	require.Equal(t, int64(70), snapshot["total_ms"])
	require.Equal(t, int64(10), snapshot["sent_bytes"])
	require.Equal(t, "normal", snapshot["end_status"])
	connection, ok := snapshot["upstream_connection"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, true, connection["reused"])
	assert.NotContains(t, connection, "dns_ms")
}

func TestRelayTimingDropsWriteHistoryAfterFirstValidEvent(t *testing.T) {
	base := time.Unix(300, 0)
	timing := NewRelayTiming(base)
	timing.BeginAttempt(base.Add(time.Millisecond))
	timing.RecordWrite(2, nil, base.Add(2*time.Millisecond))
	timing.RecordWrite(3, nil, base.Add(3*time.Millisecond))
	timing.CommitValidEvent(base.Add(4 * time.Millisecond))
	timing.RecordWrite(5, nil, base.Add(5*time.Millisecond))
	timing.RecordWrite(7, nil, base.Add(6*time.Millisecond))

	timing.mu.Lock()
	writes := len(timing.writes)
	timing.mu.Unlock()
	require.Zero(t, writes)
	snapshot := timing.Snapshot(base.Add(7 * time.Millisecond))
	require.Equal(t, int64(17), snapshot["sent_bytes"])
	require.Equal(t, int64(6), snapshot["total_ms"])
}

func TestRelayTimingSnapshotLeavesMissingStagesAtZero(t *testing.T) {
	base := time.Unix(200, 0)
	timing := NewRelayTiming(base)
	timing.BeginAttempt(base.Add(15 * time.Millisecond))
	snapshot := timing.Snapshot(base.Add(25 * time.Millisecond))
	require.Equal(t, int64(15), snapshot["site_processing_ms"])
	require.Equal(t, int64(0), snapshot["upstream_first_event_ms"])
	require.Equal(t, int64(0), snapshot["relay_processing_ms"])
	require.Equal(t, int64(0), snapshot["downstream_send_ms"])
	require.Equal(t, int64(25), snapshot["total_ms"])
}

func TestRelayTimingBoundsWritesBeforeFirstValidEvent(t *testing.T) {
	base := time.Unix(300, 0)
	timing := NewRelayTiming(base)
	for i := 0; i < maxPreValidWriteTimes*4; i++ {
		timing.RecordWrite(1, nil, base.Add(time.Duration(i)*time.Millisecond))
	}
	require.Len(t, timing.writes, maxPreValidWriteTimes)

	validAt := base.Add(time.Duration(maxPreValidWriteTimes*4-2) * time.Millisecond)
	timing.CommitValidEvent(validAt)
	require.Empty(t, timing.writes)
	require.Equal(t, base.Add(time.Duration(maxPreValidWriteTimes*4-2)*time.Millisecond), timing.postValidWrite)
}
