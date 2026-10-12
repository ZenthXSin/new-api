package groupavailability

type Metrics struct {
	Status        string   `json:"status"`
	SampleState   string   `json:"sample_state"`
	RequestCount  *int64   `json:"request_count"`
	SuccessCount  *int64   `json:"success_count"`
	ErrorCount    *int64   `json:"error_count"`
	SuccessRate   *float64 `json:"success_rate"`
	AvgTtftMs     *int64   `json:"avg_ttft_ms"`
	AvgDurationMs *int64   `json:"avg_duration_ms"`
	CacheHitRate  *float64 `json:"cache_hit_rate"`
	AvgOutputTPS  *float64 `json:"avg_output_tps"`
}

type Bucket struct {
	StartTime int64 `json:"start_time"`
	Metrics
}

type Group struct {
	Group         string   `json:"group"`
	DisplayName   string   `json:"display_name"`
	Description   string   `json:"description"`
	LastRequestAt *int64   `json:"last_request_at"`
	Buckets       []Bucket `json:"buckets"`
	Metrics
}

type Result struct {
	Range                  string  `json:"range"`
	Source                 string  `json:"source"`
	BucketSeconds          int64   `json:"bucket_seconds"`
	GeneratedAt            int64   `json:"generated_at"`
	StartTime              int64   `json:"start_time"`
	EndTime                int64   `json:"end_time"`
	CollectionStartedAt    int64   `json:"collection_started_at"`
	CoverageComplete       bool    `json:"coverage_complete"`
	RefreshIntervalSeconds int     `json:"refresh_interval_seconds"`
	DataThrough            *int64  `json:"data_through"`
	MinInputTokens         int64   `json:"min_input_tokens"`
	MinSamples             int64   `json:"min_samples"`
	WarningErrorRate       float64 `json:"warning_error_rate"`
	CriticalErrorRate      float64 `json:"critical_error_rate"`
	Groups                 []Group `json:"groups"`
}

type Sample struct {
	Group            string
	InputTokens      int64
	OutputTokens     int64
	GenerationMs     int64
	Success          bool
	LatencyMs        int64
	TtftMs           int64
	HasTtft          bool
	CacheInputTokens int64
	CacheReadTokens  int64
}
