package ipguard

// Domain types for the LLM-assisted IP attack detection engine, ported from
// the llm-ipguard Python project. Pure types only; no I/O, no database.

// TrafficEvent is one parsed log line normalized to a common shape.
type TrafficEvent struct {
	TS      int64
	IP      string
	Service string
	Kind    string
	Detail  string
	Raw     string
}

// AttackType names used as clear-cut prefilter reasons.
const (
	AttackSSHBruteforce = "SSH_BRUTEFORCE"
	AttackWebBruteforce = "WEB_BRUTEFORCE"
	AttackSQLI          = "SQLI"
	AttackXSS           = "XSS"
	AttackPathTraversal = "PATH_TRAVERSAL"
	AttackPortScan      = "PORT_SCAN"
	AttackDDoSBurst     = "DDOS_BURST"
	AttackSlowScan      = "SLOW_SCAN"
)

// LLMVerdict values produced by the LLM client.
type LLMVerdict string

const (
	VerdictBenign    LLMVerdict = "benign"
	VerdictSuspect   LLMVerdict = "suspect"
	VerdictMalicious LLMVerdict = "malicious"
	VerdictCritical  LLMVerdict = "critical"
)

// DecisionAction values emitted by the decider.
type DecisionAction string

const (
	ActionIgnore   DecisionAction = "ignore"
	ActionBan      DecisionAction = "ban"
	ActionEscalate DecisionAction = "escalate"
	ActionUnban    DecisionAction = "unban"
)

// IPFeatures are the per-IP counters aggregated from events. The JSON tags
// keep the LLM payload stable across providers.
type IPFeatures struct {
	TotalRequests     int     `json:"total_requests"`
	FailedLogins      int     `json:"failed_logins"`
	AcceptedLogins    int     `json:"accepted_logins"`
	WebFailedLogins   int     `json:"web_failed_logins"`
	SQLAttempts       int     `json:"sql_attempts"`
	XSSAttempts       int     `json:"xss_attempts"`
	TraversalAttempts int     `json:"traversal_attempts"`
	UniqueUAs         int     `json:"unique_uas"`
	IsBotUA           bool    `json:"is_bot_ua"`
	RatePerMin        float64 `json:"rate_per_min"`
	PortsSeen         int     `json:"ports_seen"`
	UALower           string  `json:"ua_lower"`
	// Cross-window cumulative counters folded in by the engine (in-memory).
	CumTotal   int `json:"_cum_total"`
	CumWindows int `json:"_cum_windows"`
	// Test-only ground-truth stamp used by MockLLM.
	Truth string `json:"_truth,omitempty"`
}

// IPProfile bundles an IP's features with evidence lines and prefilter signal.
type IPProfile struct {
	IP         string
	Features   IPFeatures
	Evidence   []string
	Signal     string
	Confidence float64
}

// BanRecord is one decision/ban trace record.
type BanRecord struct {
	IP              string
	Action          DecisionAction
	Reason          string
	DurationSeconds int64
	TS              int64
}
