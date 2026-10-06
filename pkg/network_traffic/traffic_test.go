package networktraffic

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func trafficFixture(t *testing.T) *Manager {
	t.Helper()
	common.OptionMapRWMutex.Lock()
	previous := common.OptionMap
	common.OptionMap = map[string]string{EnabledOption: "true", BudgetOption: "5"}
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		common.OptionMap = previous
		common.OptionMapRWMutex.Unlock()
	})
	path := filepath.Join(t.TempDir(), "config.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"enabled":true}`), 0600))
	m, err := openManager(path)
	require.NoError(t, err)
	t.Cleanup(m.release)
	m.random = func(int64) int64 { return 0 }
	return m
}

func TestDailyBudgetPersistsBeforeTransferAndSurvivesRestart(t *testing.T) {
	m := trafficFixture(t)
	now := time.Now()
	_, err := openManager(m.configPath)
	require.ErrorContains(t, err, "already owned")
	require.True(t, m.reserve(transferPlan{Source: "cloudflare_download", WireLimit: 4_900_000_000}, now))
	assert.False(t, m.reserve(transferPlan{WireLimit: 100_000_001}, now))
	m.release()
	restarted, err := openManager(m.configPath)
	require.NoError(t, err)
	defer restarted.release()
	assert.EqualValues(t, 4_900_000_000, restarted.state.ReservedBytes)
	assert.False(t, restarted.reserve(transferPlan{WireLimit: 100_000_001}, now))
	restarted.rollDay(now.Add(-24 * time.Hour))
	assert.EqualValues(t, 4_900_000_000, restarted.state.ReservedBytes)
	restarted.rollDay(now.Add(24 * time.Hour))
	assert.Zero(t, restarted.state.ReservedBytes)
}

func TestSamplingDelaySingleWorkerAndDisable(t *testing.T) {
	m := trafficFixture(t)
	now := time.Date(2026, 10, 3, 10, 0, 0, 0, budgetLocation)
	m.next = now
	m.threshold, m.chance = 2, 50
	m.lastSeen.Store(now.UnixNano())
	m.schedule(now) // No activity cannot schedule a transfer.
	assert.Nil(t, m.pending)
	m.requests.Store(1)
	m.schedule(now)
	assert.Nil(t, m.pending)
	m.requests.Store(2)
	m.random = func(n int64) int64 { return n - 1 }
	m.schedule(now) // Meeting the threshold alone does not force a transfer.
	assert.Nil(t, m.pending)
	m.random = func(int64) int64 { return 0 }
	m.schedule(now)
	require.NotNil(t, m.pending)
	start := m.pending.StartAt
	assert.True(t, start.After(now))
	called := make(chan struct{})
	m.execute = func(ctx context.Context, p transferPlan) transferResult {
		close(called)
		<-ctx.Done()
		return transferResult{Status: "cancelled_or_timeout", Received: 123}
	}
	m.step(start.Add(-time.Nanosecond))
	assert.Zero(t, m.state.JobsStarted)
	m.step(start)
	select {
	case <-called:
	case <-time.After(2 * time.Second):
		t.Fatal("sampled transfer did not start")
	}
	m.requests.Store(100)
	m.schedule(start)
	assert.Nil(t, m.pending)
	assert.EqualValues(t, 1, m.state.JobsStarted)
	common.OptionMapRWMutex.Lock()
	common.OptionMap[EnabledOption] = "false"
	common.OptionMapRWMutex.Unlock()
	m.reload()
	assert.False(t, m.config.Enabled)
	select {
	case result := <-m.completed:
		m.finish(result, start)
	case <-time.After(2 * time.Second):
		t.Fatal("disabling did not cancel the active transfer")
	}
	assert.Positive(t, m.state.ReservedBytes)
	assert.EqualValues(t, 123, m.state.ReceivedBytes)
	m.schedule(start.Add(time.Hour))
	assert.Nil(t, m.pending)
}

func TestIdleAndLoweredBudgetCancelPendingTransfers(t *testing.T) {
	m := trafficFixture(t)
	now := time.Now()
	m.pending = &transferPlan{WireLimit: 1 << 20, StartAt: now}
	m.lastSeen.Store(now.Add(-3 * time.Minute).UnixNano())
	m.step(now)
	assert.Zero(t, m.state.JobsStarted)
	assert.Nil(t, m.pending)
	require.True(t, m.reserve(transferPlan{WireLimit: 2_000_000_000}, now))
	common.OptionMapRWMutex.Lock()
	common.OptionMap[BudgetOption] = "1"
	common.OptionMapRWMutex.Unlock()
	m.pending = &transferPlan{WireLimit: 1 << 20, StartAt: now}
	m.reload()
	assert.Nil(t, m.pending)
	assert.EqualValues(t, 1_000_000_000, m.config.DailyBudgetBytes)
	assert.False(t, m.reserve(transferPlan{WireLimit: 1}, now))
}

func TestInvalidSettingsAndCorruptLedgerFailClosed(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "0.09", "5.1", "NaN", "Inf", "bad"} {
		assert.Error(t, ValidateOption(BudgetOption, value), value)
	}
	for _, value := range []string{"0.1", "1.5", "5"} {
		assert.NoError(t, ValidateOption(BudgetOption, value), value)
	}
	assert.Error(t, ValidateOption(EnabledOption, "1"))
	m := trafficFixture(t)
	m.release()
	require.NoError(t, os.WriteFile(m.statePath, []byte(`{"reserved_bytes":1}`), 0600))
	_, err := openManager(m.configPath)
	require.ErrorContains(t, err, "ledger")
	config := DefaultConfig()
	config.Sources = []string{"https://private.example/"}
	assert.Error(t, config.validate())
}

func TestWireLimitCapsReadsAndWrites(t *testing.T) {
	for _, writing := range []bool{false, true} {
		client, server := net.Pipe()
		budget := &wireBudget{}
		budget.remaining.Store(10)
		connection := &budgetConn{Conn: client, budget: budget}
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			if writing {
				_, _ = io.Copy(io.Discard, server)
			} else {
				_, _ = server.Write(make([]byte, 20))
			}
		}()
		var n int
		var err error
		if writing {
			n, err = connection.Write(make([]byte, 20))
			assert.ErrorIs(t, err, io.ErrShortWrite)
			assert.EqualValues(t, 10, budget.sent.Load())
		} else {
			n, err = connection.Read(make([]byte, 20))
			require.NoError(t, err)
			assert.EqualValues(t, 10, budget.received.Load())
		}
		assert.Equal(t, 10, n)
		_, err = connection.Read(make([]byte, 1))
		assert.ErrorIs(t, err, errWireLimit)
		require.NoError(t, client.Close())
		require.NoError(t, server.Close())
		<-finished
	}
}

func TestPublicDestinationsAndCancelledUpload(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:192.168.1.1", "2001:db8::1"} {
		assert.False(t, publicAddress(netip.MustParseAddr(address)), address)
	}
	assert.True(t, publicAddress(netip.MustParseAddr("1.1.1.1")))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &pacedReader{ctx: ctx, reader: nil, remaining: 100, rate: 1, chunk: 100}
	_, err := r.Read(make([]byte, 100))
	assert.ErrorIs(t, err, context.Canceled)
	client := newClient("speed.cloudflare.com", &wireBudget{})
	assert.ErrorIs(t, client.CheckRedirect(nil, nil), http.ErrUseLastResponse)
}

func TestConfiguredPublicTransferEndpoints(t *testing.T) {
	if os.Getenv("TEST_NETWORK_TRAFFIC_PUBLIC_ENDPOINTS") != "1" {
		t.Skip("explicit network integration check is disabled")
	}
	for _, name := range DefaultConfig().Sources {
		t.Run(name, func(t *testing.T) {
			src := sources[name]
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			plan := transferPlan{Source: name, URL: src.URLs[0], Upload: src.Upload, Range: src.Range,
				PayloadBytes: 64 << 10, BytesPerSecond: 1 << 20, ChunkBytes: 16 << 10, WireLimit: 512 << 10}
			result := executeTransfer(ctx, plan)
			t.Logf("source=%s status=%s received=%d sent=%d", name, result.Status, result.Received, result.Sent)
			require.Equal(t, "ok", result.Status)
			assert.Positive(t, result.Received+result.Sent)
			assert.LessOrEqual(t, result.Received+result.Sent, plan.WireLimit)
		})
	}
}
