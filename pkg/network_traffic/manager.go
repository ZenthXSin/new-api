package networktraffic

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/QuantumNous/new-api/common"
)

type State struct {
	Day           string `json:"day_utc_plus_8"`
	ReservedBytes int64  `json:"reserved_bytes"`
	ReceivedBytes int64  `json:"received_tls_bytes"`
	SentBytes     int64  `json:"sent_tls_bytes"`
	JobsStarted   int64  `json:"jobs_started"`
	JobsSucceeded int64  `json:"jobs_succeeded"`
	LastSource    string `json:"last_source"`
	LastStarted   string `json:"last_started"`
	LastFinished  string `json:"last_finished"`
	LastStatus    string `json:"last_status"`
	UpdatedAt     string `json:"updated_at"`
}

type transferPlan struct {
	Source         string
	URL            string
	Upload         bool
	Range          bool
	Offset         int64
	PayloadBytes   int64
	BytesPerSecond int64
	WireLimit      int64
	ChunkBytes     int64
	PausePercent   int64
	StartAt        time.Time
}

type transferResult struct {
	Received int64
	Sent     int64
	Status   string
}

type Manager struct {
	configPath string
	statePath  string
	config     Config
	state      State
	lock       *os.File
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	wake       chan struct{}
	completed  chan transferResult
	requests   atomic.Int64
	lastSeen   atomic.Int64
	threshold  int64
	chance     int64
	next       time.Time
	pending    *transferPlan
	active     context.CancelFunc
	blocked    map[string]time.Time
	failures   map[string]int
	random     func(int64) int64
	execute    func(context.Context, transferPlan) transferResult
}

var current atomic.Pointer[Manager]

// StartFromEnvironment opts in only when a local configuration path is set.
// The ordinary server remains available if this optional feature cannot start.
func StartFromEnvironment() *Manager {
	path := os.Getenv("NETWORK_TRAFFIC_CONFIG")
	if path == "" {
		return nil
	}
	m, err := openManager(path)
	if err != nil {
		common.SysError("network traffic disabled: " + err.Error())
		return nil
	}
	if !current.CompareAndSwap(nil, m) {
		m.release()
		return nil
	}
	common.SysLog(fmt.Sprintf("network traffic initialized: enabled=%t daily_budget=%d concurrency=1", m.config.Enabled, m.config.DailyBudgetBytes))
	go m.run()
	return m
}

// NotifyRequest accepts no request data and performs no network or disk I/O.
// Events coalesce instead of growing a queue or spawning per-request goroutines.
func NotifyRequest() {
	if m := current.Load(); m != nil {
		m.requests.Add(1)
		m.lastSeen.Store(time.Now().UnixNano())
		select {
		case m.wake <- struct{}{}:
		default:
		}
	}
}

func (m *Manager) Close() {
	if m == nil {
		return
	}
	current.CompareAndSwap(m, nil)
	m.cancel()
	<-m.done
}

func openManager(path string) (*Manager, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("NETWORK_TRAFFIC_CONFIG must be an absolute path")
	}
	cfg, err := readConfig(path)
	if err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(path), "budget.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("network traffic budget is already owned by another process")
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		configPath: path, statePath: filepath.Join(filepath.Dir(path), "state.json"),
		config: cfg, lock: lock, ctx: ctx, cancel: cancel,
		done: make(chan struct{}), wake: make(chan struct{}, 1), completed: make(chan transferResult, 1),
		blocked: make(map[string]time.Time), failures: make(map[string]int),
		random: rand.Int64N, execute: executeTransfer,
	}
	data, err := os.ReadFile(m.statePath)
	if err == nil {
		err = common.Unmarshal(data, &m.state)
		_, dateErr := time.Parse(time.DateOnly, m.state.Day)
		if err == nil && (dateErr != nil || m.state.ReservedBytes < 0 || m.state.ReceivedBytes < 0 || m.state.SentBytes < 0 || m.state.JobsStarted < 0 || m.state.JobsSucceeded < 0) {
			err = errors.New("invalid network traffic budget ledger")
		}
	} else if os.IsNotExist(err) {
		err = nil
	}
	if err != nil {
		m.release()
		return nil, err
	}
	m.rollDay(time.Now())
	m.resetSampling()
	// Restarting never immediately triggers traffic and never resets the ledger.
	m.next = time.Now().Add(time.Duration(m.between(int64(cfg.MinCooldownSeconds), int64(cfg.MaxCooldownSeconds))) * time.Second)
	if err := m.persist(); err != nil {
		m.release()
		return nil, err
	}
	return m, nil
}

func (m *Manager) release() {
	m.cancel()
	_ = syscall.Flock(int(m.lock.Fd()), syscall.LOCK_UN)
	_ = m.lock.Close()
}

func (m *Manager) between(low, high int64) int64 {
	return low + m.random(high-low+1)
}

func (m *Manager) resetSampling() {
	m.threshold = m.between(int64(m.config.MinRequestThreshold), int64(m.config.MaxRequestThreshold))
	m.chance = m.between(int64(m.config.MinTriggerPercent), int64(m.config.MaxTriggerPercent))
	m.requests.Store(0)
}

func (m *Manager) rollDay(now time.Time) {
	day := now.In(budgetLocation).Format(time.DateOnly)
	// Clock rollback must not replenish spent budget.
	if day > m.state.Day {
		m.state = State{Day: day}
	}
}

func (m *Manager) persist() error {
	m.state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	data, err := common.Marshal(m.state)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(m.statePath), ".budget-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(file.Name(), m.statePath); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(m.statePath))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (m *Manager) schedule(now time.Time) {
	if !m.config.Enabled || m.active != nil || m.pending != nil || now.Before(m.next) || m.requests.Load() < m.threshold {
		return
	}
	if m.random(100) >= m.chance {
		return
	}
	// No task straddles the daily budget boundary (timeout is 75 seconds).
	local := now.In(budgetLocation)
	if local.Hour() == 23 && local.Minute() >= 58 {
		return
	}
	eligible := make([]string, 0, len(m.config.Sources))
	weight := int64(0)
	for _, name := range m.config.Sources {
		if now.Before(m.blocked[name]) {
			continue
		}
		eligible = append(eligible, name)
		weight += int64(sources[name].Weight)
	}
	if weight == 0 {
		return
	}
	pick := m.random(weight)
	name := eligible[0]
	for _, candidate := range eligible {
		pick -= int64(sources[candidate].Weight)
		if pick < 0 {
			name = candidate
			break
		}
	}
	src := sources[name]
	rate := m.between(m.config.MinBytesPerSecond, m.config.MaxBytesPerSecond)
	size := m.between(m.config.MinDownloadBytes, m.config.MaxDownloadBytes)
	if src.Upload {
		size = m.between(128<<10, 2<<20)
	}
	size = min(size, rate*45)
	p := transferPlan{
		Source: name, URL: src.URLs[m.random(int64(len(src.URLs)))], Upload: src.Upload, Range: src.Range,
		Offset: m.between(0, 2<<20), PayloadBytes: size, BytesPerSecond: rate,
		// Reserve conservatively, including TLS/HTTP and an additional 30% margin.
		WireLimit:  size + size*30/100 + (128 << 10),
		ChunkBytes: m.between(4<<10, 32<<10), PausePercent: m.between(1, 8),
		StartAt: now.Add(time.Duration(m.between(int64(m.config.MinDelaySeconds), int64(m.config.MaxDelaySeconds))) * time.Second),
	}
	m.pending = &p
	m.resetSampling()
}

func (m *Manager) reserve(p transferPlan, now time.Time) bool {
	m.rollDay(now)
	if p.WireLimit <= 0 || m.state.ReservedBytes > m.config.DailyBudgetBytes-p.WireLimit {
		return false
	}
	m.state.ReservedBytes += p.WireLimit
	m.state.JobsStarted++
	m.state.LastSource = p.Source
	m.state.LastStarted = now.UTC().Format(time.RFC3339)
	m.state.LastStatus = "reserved"
	// Reserve before sending; crashes and failed jobs never refund budget.
	if err := m.persist(); err != nil {
		m.config.Enabled = false
		common.SysError("network traffic paused: budget persistence failed")
		return false
	}
	return true
}

func (m *Manager) step(now time.Time) {
	if m.pending == nil || now.Before(m.pending.StartAt) || m.active != nil {
		return
	}
	p := *m.pending
	m.pending = nil
	if !m.config.Enabled || now.Sub(time.Unix(0, m.lastSeen.Load())) > activityTTL || !m.reserve(p, now) {
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, 75*time.Second)
	m.active = cancel
	go func() {
		result := transferResult{Status: "internal_error"}
		defer func() {
			if recover() != nil {
				result.Status = "internal_error"
			}
			cancel()
			m.completed <- result
		}()
		result = m.execute(ctx, p)
	}()
}

func (m *Manager) finish(result transferResult, now time.Time) {
	m.active = nil
	m.state.ReceivedBytes += result.Received
	m.state.SentBytes += result.Sent
	m.state.LastStatus = result.Status
	m.state.LastFinished = now.UTC().Format(time.RFC3339)
	source := m.state.LastSource
	if result.Status == "ok" {
		m.state.JobsSucceeded++
		m.failures[source] = 0
	} else {
		m.failures[source] = min(m.failures[source]+1, 4)
		m.blocked[source] = now.Add(time.Duration(1<<m.failures[source]) * 150 * time.Second)
	}
	m.next = now.Add(time.Duration(m.between(int64(m.config.MinCooldownSeconds), int64(m.config.MaxCooldownSeconds))) * time.Second)
	if err := m.persist(); err != nil {
		m.config.Enabled = false
		common.SysError("network traffic paused: cannot save result")
	}
	common.SysLog(fmt.Sprintf("network traffic: source=%s result=%s received=%d sent=%d reserved_today=%d limit=%d", source, result.Status, result.Received, result.Sent, m.state.ReservedBytes, m.config.DailyBudgetBytes))
}

func (m *Manager) reload() {
	cfg, err := readConfig(m.configPath)
	if err != nil {
		cfg = m.config
		cfg.Enabled = false
	}
	m.config = cfg
	if !cfg.Enabled || m.state.ReservedBytes > cfg.DailyBudgetBytes {
		m.pending = nil
		if m.active != nil {
			m.active()
		}
	}
}

func (m *Manager) run() {
	defer close(m.done)
	defer m.release()
	tick := time.NewTicker(time.Second)
	reload := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	defer reload.Stop()
	for {
		select {
		case <-m.ctx.Done():
			if m.active != nil {
				m.active()
				m.finish(<-m.completed, time.Now())
			}
			return
		case <-m.wake:
			m.schedule(time.Now())
		case now := <-tick.C:
			m.step(now)
		case <-reload.C:
			m.reload()
		case result := <-m.completed:
			m.finish(result, time.Now())
		}
	}
}
