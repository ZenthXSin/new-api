package model

import (
	"errors"
	"math"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Kept outside user-editable profile settings. Zero resource values inherit the deployment defaults.
type CodexUserConfig struct {
	UserID        int     `json:"userId" gorm:"primaryKey;autoIncrement:false"`
	Enabled       *bool   `json:"enabled"`
	AllowDocker   *bool   `json:"allowDocker"`
	AllowSSH      *bool   `json:"allowSSH"`
	CPUPercent    float64 `json:"cpuPercent"`
	MemoryMB      int64   `json:"memoryMB"`
	DiskMB        int64   `json:"diskMB"`
	MaxProjects   int     `json:"maxProjects"`
	IdleSeconds   int     `json:"idleSeconds"`
	DefaultModel  string  `json:"defaultModel" gorm:"size:200"`
	DefaultGroup  string  `json:"defaultGroup" gorm:"size:64"`
	DefaultEffort string  `json:"defaultEffort" gorm:"size:20"`
}

type CodexUserPolicy struct {
	Source         string  `json:"source"`
	SubscriptionID int     `json:"subscriptionId,omitempty"`
	PlanID         int     `json:"planId,omitempty"`
	PlanTitle      string  `json:"planTitle,omitempty"`
	ExpiresAt      int64   `json:"expiresAt,omitempty"`
	UserID         int     `json:"userId"`
	Enabled        bool    `json:"enabled"`
	AllowDocker    bool    `json:"allowDocker"`
	AllowSSH       bool    `json:"allowSSH"`
	AllowHost      bool    `json:"allowHost"`
	CPUPercent     float64 `json:"cpuPercent"`
	MemoryMB       int64   `json:"memoryMB"`
	DiskMB         int64   `json:"diskMB"`
	MaxProjects    int     `json:"maxProjects"`
	IdleSeconds    int     `json:"idleSeconds"`
	DefaultModel   string  `json:"defaultModel"`
	DefaultGroup   string  `json:"defaultGroup"`
	DefaultEffort  string  `json:"defaultEffort"`
}

func GetCodexUserConfig(id int) (*CodexUserConfig, error) {
	config := &CodexUserConfig{UserID: id}
	err := DB.Where("user_id = ?", id).First(config).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return config, nil
	}
	return config, err
}

func GetEffectiveCodexUserPolicy(id int) (*CodexUserPolicy, error) {
	return GetEffectiveCodexUserPolicyWithDB(DB, id)
}

func GetEffectiveCodexUserPolicyWithDB(db *gorm.DB, id int) (*CodexUserPolicy, error) {
	user := &User{}
	err := db.First(user, id).Error
	if err != nil {
		return nil, err
	}
	config := &CodexUserConfig{UserID: id}
	err = db.Where("user_id = ?", id).First(config).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	grants, err := activeCodexGrants(db, []int{id})
	if err != nil {
		return nil, err
	}
	return resolveCodexPolicy(user, config, grants[id]), nil
}

func CodexUserCanAccess(id int) (bool, error) {
	policy, err := GetEffectiveCodexUserPolicy(id)
	if err != nil {
		return false, err
	}
	return policy.Enabled, nil
}

func ValidateCodexUserConfig(config *CodexUserConfig) error {
	if config.UserID < 1 || math.IsNaN(config.CPUPercent) || math.IsInf(config.CPUPercent, 0) || config.CPUPercent < 0 || config.CPUPercent > 100 || config.MemoryMB < 0 || config.MemoryMB > 1048576 || (config.MemoryMB > 0 && config.MemoryMB < 256) || config.DiskMB < 0 || config.DiskMB > 10485760 || (config.DiskMB > 0 && config.DiskMB < 256) || config.MaxProjects < 0 || config.MaxProjects > 1000 || config.IdleSeconds < 0 || config.IdleSeconds > 86400 || (config.IdleSeconds > 0 && config.IdleSeconds < 60) {
		return errors.New("资源配置超出范围：CPU 0–100%，内存/磁盘至少256 MiB，项目最多1000，空闲时间60–86400秒；0继承默认值")
	}
	config.DefaultModel = strings.TrimSpace(config.DefaultModel)
	config.DefaultGroup = strings.TrimSpace(config.DefaultGroup)
	if len(config.DefaultModel) > 200 || len(config.DefaultGroup) > 64 || strings.ContainsAny(config.DefaultModel+config.DefaultGroup, "\x00\r\n") {
		return errors.New("默认模型或分组无效")
	}
	switch config.DefaultEffort {
	case "", "low", "medium", "high", "xhigh", "max", "ultra":
	default:
		return errors.New("推理强度无效")
	}
	return nil
}

func SaveCodexUserConfig(config *CodexUserConfig) error {
	if err := ValidateCodexUserConfig(config); err != nil {
		return err
	}
	return DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}}, UpdateAll: true}).Create(config).Error
}
