package controller

// IPGuard HTTP endpoints: scan status (current bans + last scan report),
// manual unban and on-demand scan enqueue.

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/ipguard"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"

	"github.com/gin-gonic/gin"
)

// IPGuardStatusResponse is the payload of GET /api/ipguard/status.
type IPGuardStatusResponse struct {
	Enabled       bool                `json:"enabled"`
	DryRun        bool                `json:"dry_run"`
	EnforceReal   bool                `json:"enforce_real"`
	RealArmed     bool                `json:"real_armed"`
	LLMConfigured bool                `json:"llm_configured"`
	LogDir        string              `json:"log_dir"`
	ActiveBans    []ipguard.BanRecord `json:"active_bans"`
	RecentBans    []IPGuardBanView    `json:"recent_bans"`
	LastScan      *IPGuardScanView    `json:"last_scan,omitempty"`
}

// IPGuardBanView is a ban row for the UI.
type IPGuardBanView struct {
	IP        string `json:"ip"`
	Action    string `json:"action"`
	Reason    string `json:"reason"`
	Duration  int64  `json:"duration"`
	TS        int64  `json:"ts"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
}

// IPGuardScanView is the last scan summary for the UI.
type IPGuardScanView struct {
	ScanTS    int64          `json:"scan_ts"`
	Watermark int64          `json:"watermark"`
	Stats     map[string]any `json:"stats"`
}

// GetIPGuardStatus returns the feature state, active bans, recent ban history
// and the last scan summary.
func GetIPGuardStatus(c *gin.Context) {
	cfg := setting.GetIPGuardConfig()
	status := IPGuardStatusResponse{
		Enabled:       setting.IPGuardEnabled(),
		DryRun:        cfg.DryRun,
		EnforceReal:   cfg.EnforceReal,
		RealArmed:     service.IPGuardRealArmed(),
		LLMConfigured: cfg.LLMToken != "",
		LogDir:        cfg.LogDir,
	}

	active, err := model.GetActiveIPGuardBans()
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	status.ActiveBans = active

	rows, err := model.ListIPGuardRecentBans(50)
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	for _, row := range rows {
		view := IPGuardBanView{
			IP: row.IP, Action: row.Action, Reason: row.Reason,
			Duration: row.Duration, TS: row.TS,
		}
		if row.Action == string(ipguard.ActionBan) || row.Action == string(ipguard.ActionEscalate) {
			view.ExpiresAt = row.TS + row.Duration
		}
		status.RecentBans = append(status.RecentBans, view)
	}

	scan, err := model.GetLatestIPGuardScan()
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	if scan != nil {
		stats := map[string]any{}
		if err := common.UnmarshalJsonStr(scan.Stats, &stats); err != nil {
			stats["raw"] = scan.Stats
		}
		status.LastScan = &IPGuardScanView{ScanTS: scan.ScanTS, Watermark: scan.Watermark, Stats: stats}
	}

	common.ApiSuccess(c, status)
}

// UnbanIPGuard lifts a manual ban on one IP.
func UnbanIPGuard(c *gin.Context) {
	var req struct {
		IP string `json:"ip" binding:"required"`
	}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "invalid request: "+err.Error())
		return
	}
	if err := service.UnbanIPGuardIP(req.IP, "manual"); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	common.ApiSuccess(c, gin.H{"ip": req.IP})
}

// ScanIPGuardNow enqueues an on-demand scan task. It reuses the scheduled
// task type so the system task runner dedups an in-flight scan.
func ScanIPGuardNow(c *gin.Context) {
	if !setting.IPGuardEnabled() {
		common.ApiErrorMsg(c, "ipguard is disabled")
		return
	}
	task, created, err := service.EnqueueSystemTask(model.SystemTaskTypeIPGuardScan, nil)
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	common.ApiSuccess(c, gin.H{
		"task_id": task.TaskID,
		"created": created,
	})
}
