package model

// IPGuard persistent state: scan watermarks/stats, ban records and per-IP
// decisions. The engine (ipguard package) persists through these tables so
// scans are resumable and bans are auditable across restarts.

import (
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/ipguard"
	"gorm.io/gorm"
)

// IPGuardScan records one scan run's watermark and stats.
type IPGuardScan struct {
	ID        int64     `json:"id" gorm:"primary_key"`
	ScanTS    int64     `json:"scan_ts" gorm:"bigint;index"`
	Watermark int64     `json:"watermark" gorm:"bigint"`
	Stats     string    `json:"stats" gorm:"type:text"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// IPGuardBan records one ban decision trace (BAN/ESCALATE/UNBAN).
type IPGuardBan struct {
	ID        int64     `json:"id" gorm:"primary_key"`
	IP        string    `json:"ip" gorm:"type:varchar(64);index"`
	Action    string    `json:"action" gorm:"type:varchar(32)"`
	Reason    string    `json:"reason" gorm:"type:varchar(128)"`
	Duration  int64     `json:"duration" gorm:"bigint"`
	TS        int64     `json:"ts" gorm:"bigint;index"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// IPGuardDecision records one per-IP LLM/decision trace entry.
type IPGuardDecision struct {
	ID        int64     `json:"id" gorm:"primary_key"`
	TS        int64     `json:"ts" gorm:"bigint;index"`
	IP        string    `json:"ip" gorm:"type:varchar(64);index"`
	Verdict   string    `json:"verdict" gorm:"type:varchar(32)"`
	Action    string    `json:"action" gorm:"type:varchar(32)"`
	Reason    string    `json:"reason" gorm:"type:varchar(128)"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// IPGuardStateStore implements ipguard.StateStore on the main database.
type IPGuardStateStore struct{}

// LastWatermark returns the latest recorded scan watermark, or 0.
func (IPGuardStateStore) LastWatermark() (int64, error) {
	var scan IPGuardScan
	err := DB.Order("scan_ts DESC").First(&scan).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}
	return scan.Watermark, nil
}

// RecordScan persists one scan run; stats is stored as JSON text.
func (IPGuardStateStore) RecordScan(ts, watermark int64, stats map[string]any) error {
	raw, err := common.Marshal(stats)
	if err != nil {
		return err
	}
	return DB.Create(&IPGuardScan{ScanTS: ts, Watermark: watermark, Stats: string(raw)}).Error
}

// RecordBan persists one decision record (BAN, ESCALATE or UNBAN).
func (IPGuardStateStore) RecordBan(record ipguard.BanRecord) error {
	return DB.Create(&IPGuardBan{
		IP:       record.IP,
		Action:   string(record.Action),
		Reason:   record.Reason,
		Duration: record.DurationSeconds,
		TS:       record.TS,
	}).Error
}

// RecordDecision persists one per-IP decision.
func (IPGuardStateStore) RecordDecision(ts int64, ip string, verdict ipguard.LLMVerdict, action ipguard.DecisionAction, reason string) error {
	return DB.Create(&IPGuardDecision{
		TS:      ts,
		IP:      ip,
		Verdict: string(verdict),
		Action:  string(action),
		Reason:  reason,
	}).Error
}

// BansSince returns all ban records with TS >= ts, ordered by TS then IP.
func (IPGuardStateStore) BansSince(ts int64) ([]ipguard.BanRecord, error) {
	var rows []IPGuardBan
	err := DB.Where("ts >= ?", ts).Order("ts ASC").Order("id ASC").Find(&rows).Error
	if err != nil {
		return nil, err
	}
	records := make([]ipguard.BanRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, ipguard.BanRecord{
			IP:              row.IP,
			Action:          ipguard.DecisionAction(row.Action),
			Reason:          row.Reason,
			DurationSeconds: row.Duration,
			TS:              row.TS,
		})
	}
	return records, nil
}

// GetActiveIPGuardBans computes the currently enforced bans from the ban
// table: an IP is banned when its most recent state-affecting record is a
// BAN/ESCALATE whose expiry is still in the future.
func GetActiveIPGuardBans() ([]ipguard.BanRecord, error) {
	var rows []IPGuardBan
	if err := DB.Order("ts ASC").Order("id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	now := common.GetTimestamp()
	latest := make(map[string]ipguard.BanRecord)
	hasRecord := make(map[string]bool)
	for _, row := range rows {
		record := ipguard.BanRecord{
			IP:              row.IP,
			Action:          ipguard.DecisionAction(row.Action),
			Reason:          row.Reason,
			DurationSeconds: row.Duration,
			TS:              row.TS,
		}
		if row.Action == string(ipguard.ActionBan) || row.Action == string(ipguard.ActionEscalate) ||
			row.Action == string(ipguard.ActionUnban) {
			latest[row.IP] = record
			hasRecord[row.IP] = true
		}
	}
	var active []ipguard.BanRecord
	for ip, record := range latest {
		if !hasRecord[ip] {
			continue
		}
		switch record.Action {
		case ipguard.ActionBan, ipguard.ActionEscalate:
			if now < record.TS+record.DurationSeconds {
				active = append(active, record)
			}
		case ipguard.ActionUnban:
			// most recent action lifted the ban
		}
	}
	return active, nil
}

// GetLatestIPGuardScan returns the most recent scan row, if any.
func GetLatestIPGuardScan() (*IPGuardScan, error) {
	var scan IPGuardScan
	err := DB.Order("scan_ts DESC").First(&scan).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &scan, nil
}

// ListIPGuardRecentBans returns the most recent ban records (default 50).
func ListIPGuardRecentBans(limit int) ([]IPGuardBan, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var rows []IPGuardBan
	err := DB.Order("ts DESC").Order("id DESC").Limit(limit).Find(&rows).Error
	return rows, err
}

// IPGuardBanCountSince counts state-affecting ban records for one IP since ts.
func IPGuardBanCountSince(ip string, ts int64) (int64, error) {
	var count int64
	err := DB.Model(&IPGuardBan{}).
		Where("ip = ? AND ts >= ? AND action IN ?", ip, ts,
			[]string{string(ipguard.ActionBan), string(ipguard.ActionEscalate)}).
		Count(&count).Error
	return count, err
}
