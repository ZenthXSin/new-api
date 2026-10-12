package groupavailability

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	MinSamples     = 1
	MinInputTokens = model.GroupAvailabilityMinInputTokens
	retention      = 35 * 24 * time.Hour
)

type bucketKey struct {
	group string
	start int64
}

// Collector stores no credentials, request IDs, models, channels or user data.
// Writes are batched outside the request path. Reads use the shared database,
// so instances see the same persisted data without adding local counters twice.
type Collector struct {
	mu          sync.Mutex
	flushMu     sync.Mutex
	now         func() time.Time
	startedAt   int64
	buckets     map[bucketKey]model.GroupAvailabilityBucket
	lastCleanup int64
}

var Default *Collector

func NewCollector(now func() time.Time) (*Collector, error) {
	started, err := model.InitGroupAvailability(now().Unix())
	if err != nil {
		return nil, err
	}
	return &Collector{now: now, startedAt: started, buckets: make(map[bucketKey]model.GroupAvailabilityBucket)}, nil
}

func Init() error {
	collector, err := NewCollector(time.Now)
	if err != nil {
		return err
	}
	Default = collector
	go func() {
		for range time.NewTicker(15 * time.Second).C {
			if err := collector.Flush(); err != nil {
				common.SysError("failed to flush group availability metrics: " + err.Error())
			}
		}
	}()
	return nil
}

func (c *Collector) Record(sample Sample) {
	if c == nil || sample.Group == "" || sample.Group == "auto" || sample.InputTokens <= MinInputTokens || sample.InputTokens > maxCacheUsageTokens {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now().Unix()
	key := bucketKey{group: sample.Group, start: now - now%60}
	bucket := c.buckets[key]
	if bucket.SourceID == "" {
		// A clock correction may revisit an already persisted and evicted minute.
		// A new snapshot ID preserves its previous counts instead of replacing them.
		bucket.SourceID = common.GetUUID()
	}
	bucket.Group, bucket.BucketTs = key.group, key.start
	bucket.MinInputTokens = MinInputTokens
	bucket.RequestCount++
	if sample.Success {
		bucket.SuccessCount++
	}
	bucket.TotalLatencyMs += max(0, sample.LatencyMs)
	if sample.HasTtft && sample.TtftMs >= 0 {
		bucket.TtftCount++
		bucket.TtftSumMs += sample.TtftMs
	}
	bucket.LastRequestAt = max(now, bucket.LastRequestAt)
	if sample.Success && sample.CacheInputTokens > 0 && sample.CacheInputTokens <= maxCacheUsageTokens && sample.CacheReadTokens >= 0 && sample.CacheReadTokens <= sample.CacheInputTokens {
		bucket.CacheInputTokens += sample.CacheInputTokens
		bucket.CacheReadTokens += sample.CacheReadTokens
	}
	if sample.Success && sample.OutputTokens > 0 && sample.OutputTokens <= maxCacheUsageTokens && sample.GenerationMs > 0 {
		bucket.OutputTokens += sample.OutputTokens
		bucket.GenerationMs += sample.GenerationMs
	}
	c.buckets[key] = bucket
}

// Flush is serialized per process. Absolute per-process snapshots make a retry
// idempotent even when the database committed but the client lost the reply.
func (c *Collector) Flush() error {
	if c == nil {
		return nil
	}
	c.flushMu.Lock()
	defer c.flushMu.Unlock()
	c.mu.Lock()
	now := c.now().Unix()
	rows := make([]model.GroupAvailabilityBucket, 0, len(c.buckets))
	for key, bucket := range c.buckets {
		if key.start < now-int64(retention/time.Second) {
			delete(c.buckets, key)
			continue
		}
		rows = append(rows, bucket)
	}
	c.mu.Unlock()
	if err := model.SaveGroupAvailabilityBuckets(rows); err != nil {
		return err
	}
	c.mu.Lock()
	for _, row := range rows {
		key := bucketKey{group: row.Group, start: row.BucketTs}
		if current := c.buckets[key]; row.BucketTs < now-now%60 && current.RequestCount == row.RequestCount {
			delete(c.buckets, key)
		}
	}
	c.mu.Unlock()
	if now-c.lastCleanup >= 3600 {
		if err := model.DeleteGroupAvailabilityBefore(now - int64(retention/time.Second)); err != nil {
			return err
		}
		c.lastCleanup = now
	}
	return nil
}

func (c *Collector) Query(ctx context.Context, rangeName string, allowed map[string]string, showCounts bool) (Result, error) {
	return c.QuerySorted(ctx, rangeName, allowed, showCounts, false)
}

// QuerySorted orders by request count, then success count for tied totals,
// before hiding counts from ordinary users. Equal totals imply equal denominators.
func (c *Collector) QuerySorted(ctx context.Context, rangeName string, allowed map[string]string, showCounts, autoSort bool) (Result, error) {
	if c == nil {
		return Result{}, fmt.Errorf("group availability collection is unavailable")
	}
	var duration, bucket int64
	switch rangeName {
	case "90m":
		duration, bucket = 90*60, 60
	case "", "24h":
		rangeName, duration, bucket = "24h", 24*3600, 1800
	case "7d":
		duration, bucket = 7*24*3600, 4*3600
	case "30d":
		duration, bucket = 30*24*3600, 12*3600
	default:
		return Result{}, fmt.Errorf("range must be 90m, 24h, 7d or 30d")
	}
	now := c.now().Unix()
	// The current partial bucket plus prior complete buckets; never split one
	// minute's facts across display buckets or invent finer-grained history.
	start := now - now%bucket - duration + bucket
	result := Result{Range: rangeName, Source: "passive_requests", BucketSeconds: bucket, GeneratedAt: now,
		StartTime: start, EndTime: now, CollectionStartedAt: c.startedAt, CoverageComplete: start >= c.startedAt,
		RefreshIntervalSeconds: 15, MinInputTokens: MinInputTokens, MinSamples: MinSamples, WarningErrorRate: 5, CriticalErrorRate: 20, Groups: make([]Group, 0, len(allowed))}
	groups := make([]string, 0, len(allowed))
	for group := range allowed {
		if group != "" && group != "auto" {
			groups = append(groups, group)
		}
	}
	slices.Sort(groups)
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, err := model.GetGroupAvailabilityBuckets(queryCtx, groups, start, now+1)
	if err != nil {
		return Result{}, err
	}
	byGroup := make(map[string]map[int64]model.GroupAvailabilityBucket, len(groups))
	for _, row := range rows {
		if byGroup[row.Group] == nil {
			byGroup[row.Group] = make(map[int64]model.GroupAvailabilityBucket)
		}
		ts := row.BucketTs - row.BucketTs%bucket
		value := byGroup[row.Group][ts]
		merge(&value, row)
		byGroup[row.Group][ts] = value
	}
	totals := make(map[string]model.GroupAvailabilityBucket, len(groups))
	for _, name := range groups {
		group := Group{Group: name, DisplayName: name, Description: allowed[name], Buckets: make([]Bucket, 0, duration/bucket)}
		var total model.GroupAvailabilityBucket
		for ts := start; ts <= now; ts += bucket {
			value := byGroup[name][ts]
			merge(&total, value)
			group.Buckets = append(group.Buckets, Bucket{StartTime: ts, Metrics: describe(value, showCounts)})
		}
		totals[name] = total
		group.Metrics = describe(total, showCounts)
		if total.LastRequestAt > 0 {
			last := total.LastRequestAt
			group.LastRequestAt = &last
			if result.DataThrough == nil || last > *result.DataThrough {
				result.DataThrough = &last
			}
		}
		result.Groups = append(result.Groups, group)
	}
	if autoSort {
		slices.SortStableFunc(result.Groups, func(a, b Group) int {
			left, right := totals[a.Group], totals[b.Group]
			if order := cmp.Compare(right.RequestCount, left.RequestCount); order != 0 {
				return order
			}
			return cmp.Compare(right.SuccessCount, left.SuccessCount)
		})
	}
	return result, nil
}

func merge(target *model.GroupAvailabilityBucket, value model.GroupAvailabilityBucket) {
	target.RequestCount += value.RequestCount
	target.SuccessCount += value.SuccessCount
	target.TotalLatencyMs += value.TotalLatencyMs
	target.TtftSumMs += value.TtftSumMs
	target.TtftCount += value.TtftCount
	target.LastRequestAt = max(target.LastRequestAt, value.LastRequestAt)
	target.CacheInputTokens += value.CacheInputTokens
	target.CacheReadTokens += value.CacheReadTokens
	target.OutputTokens += value.OutputTokens
	target.GenerationMs += value.GenerationMs
}

func describe(value model.GroupAvailabilityBucket, showCounts bool) Metrics {
	metrics := Metrics{Status: "unknown", SampleState: "none"}
	if value.CacheInputTokens > 0 && value.CacheReadTokens >= 0 && value.CacheReadTokens <= value.CacheInputTokens {
		rate := math.Round(float64(value.CacheReadTokens)/float64(value.CacheInputTokens)*10000) / 100
		metrics.CacheHitRate = &rate
	}
	if value.OutputTokens > 0 && value.GenerationMs > 0 {
		speed := math.Round(float64(value.OutputTokens)/float64(value.GenerationMs)*100000) / 100
		metrics.AvgOutputTPS = &speed
	}
	errors := value.RequestCount - value.SuccessCount
	if showCounts {
		metrics.RequestCount, metrics.SuccessCount, metrics.ErrorCount = &value.RequestCount, &value.SuccessCount, &errors
	}
	if value.RequestCount <= 0 {
		return metrics
	}
	metrics.SampleState = "insufficient"
	rate := math.Round(float64(value.SuccessCount)/float64(value.RequestCount)*10000) / 100
	latency := value.TotalLatencyMs / value.RequestCount
	metrics.SuccessRate, metrics.AvgDurationMs = &rate, &latency
	if value.TtftCount > 0 {
		ttft := value.TtftSumMs / value.TtftCount
		metrics.AvgTtftMs = &ttft
	}
	if value.RequestCount >= MinSamples {
		metrics.SampleState, metrics.Status = "sufficient", "healthy"
		errorRate := float64(errors) / float64(value.RequestCount) * 100
		if errorRate >= 20 {
			metrics.Status = "critical"
		} else if errorRate >= 5 {
			metrics.Status = "warning"
		}
	}
	return metrics
}
