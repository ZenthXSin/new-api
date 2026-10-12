package model

import (
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// CodexPlanConfig is separate from billing quota. Nil preserves legacy plans.
type CodexPlanConfig struct {
	Enabled       bool    `json:"enabled"`
	AllowDocker   bool    `json:"allowDocker"`
	AllowSSH      bool    `json:"allowSSH"`
	CPUPercent    float64 `json:"cpuPercent"`
	MemoryMB      int64   `json:"memoryMB"`
	DiskMB        int64   `json:"diskMB"`
	MaxProjects   int     `json:"maxProjects"`
	IdleSeconds   int     `json:"idleSeconds"`
	DefaultModel  string  `json:"defaultModel"`
	DefaultGroup  string  `json:"defaultGroup"`
	DefaultEffort string  `json:"defaultEffort"`
}

func (config *CodexPlanConfig) Validate() error {
	if config == nil {
		return nil
	}
	candidate := &CodexUserConfig{UserID: 1, CPUPercent: config.CPUPercent, MemoryMB: config.MemoryMB, DiskMB: config.DiskMB, MaxProjects: config.MaxProjects, IdleSeconds: config.IdleSeconds, DefaultModel: config.DefaultModel, DefaultGroup: config.DefaultGroup, DefaultEffort: config.DefaultEffort}
	if err := ValidateCodexUserConfig(candidate); err != nil {
		return err
	}
	config.DefaultModel, config.DefaultGroup = candidate.DefaultModel, candidate.DefaultGroup
	return nil
}

type codexSubscriptionGrant struct {
	UserID         int
	SubscriptionID int
	PlanID         int
	PlanTitle      string
	ExpiresAt      int64
	Codex          *CodexPlanConfig `gorm:"column:codex_config;serializer:json"`
}

func activeCodexGrants(db *gorm.DB, ids []int) (map[int]codexSubscriptionGrant, error) {
	result := make(map[int]codexSubscriptionGrant)
	if len(ids) == 0 {
		return result, nil
	}
	var rows []codexSubscriptionGrant
	now := common.GetTimestamp()
	err := db.Table("user_subscriptions AS subscriptions").
		Select("subscriptions.user_id, subscriptions.id AS subscription_id, subscriptions.plan_id, subscriptions.end_time AS expires_at, plans.title AS plan_title, plans.codex_config").
		Joins("JOIN subscription_plans AS plans ON plans.id = subscriptions.plan_id").
		Where("subscriptions.user_id IN ? AND subscriptions.status = ? AND subscriptions.start_time <= ? AND subscriptions.end_time > ?", ids, "active", now, now).
		Where("plans.codex_config IS NOT NULL").
		Order("subscriptions.start_time DESC, subscriptions.id DESC").Find(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if _, found := result[row.UserID]; found || row.Codex == nil || !row.Codex.Enabled {
			continue
		}
		if err := row.Codex.Validate(); err != nil {
			return nil, err
		}
		result[row.UserID] = row
	}
	return result, nil
}

func resolveCodexPolicy(user *User, config *CodexUserConfig, grant codexSubscriptionGrant) *CodexUserPolicy {
	policy := &CodexUserPolicy{UserID: user.Id, Enabled: user.Role >= common.RoleAdminUser, AllowDocker: true, AllowSSH: true, AllowHost: user.Role >= common.RoleAdminUser, Source: "none"}
	if policy.Enabled {
		policy.Source = "administrator"
	}
	if grant.Codex != nil {
		plan := grant.Codex
		policy.Enabled, policy.AllowDocker, policy.AllowSSH = true, plan.AllowDocker, plan.AllowSSH
		policy.CPUPercent, policy.MemoryMB, policy.DiskMB = plan.CPUPercent, plan.MemoryMB, plan.DiskMB
		policy.MaxProjects, policy.IdleSeconds = plan.MaxProjects, plan.IdleSeconds
		policy.DefaultModel, policy.DefaultGroup, policy.DefaultEffort = plan.DefaultModel, plan.DefaultGroup, plan.DefaultEffort
		policy.Source, policy.PlanID, policy.PlanTitle, policy.ExpiresAt, policy.SubscriptionID = "subscription", grant.PlanID, grant.PlanTitle, grant.ExpiresAt, grant.SubscriptionID
	}
	if config.Enabled != nil {
		policy.Enabled = *config.Enabled
		policy.Source = "manual"
	}
	if config.AllowDocker != nil {
		policy.AllowDocker = *config.AllowDocker
	}
	if config.AllowSSH != nil {
		policy.AllowSSH = *config.AllowSSH
	}
	if config.CPUPercent > 0 {
		policy.CPUPercent = config.CPUPercent
	}
	if config.MemoryMB > 0 {
		policy.MemoryMB = config.MemoryMB
	}
	if config.DiskMB > 0 {
		policy.DiskMB = config.DiskMB
	}
	if config.MaxProjects > 0 {
		policy.MaxProjects = config.MaxProjects
	}
	if config.IdleSeconds > 0 {
		policy.IdleSeconds = config.IdleSeconds
	}
	if config.DefaultModel != "" {
		policy.DefaultModel = config.DefaultModel
	}
	if config.DefaultGroup != "" {
		policy.DefaultGroup = config.DefaultGroup
	}
	if config.DefaultEffort != "" {
		policy.DefaultEffort = config.DefaultEffort
	}
	policy.Enabled = policy.Enabled && user.Status == common.UserStatusEnabled
	return policy
}

type CodexAdminUser struct {
	ID          int              `json:"id"`
	Username    string           `json:"username"`
	DisplayName string           `json:"displayName"`
	Role        int              `json:"role"`
	Status      int              `json:"status"`
	Config      CodexUserConfig  `json:"config"`
	Effective   *CodexUserPolicy `json:"effective"`
}

func ListCodexAdminUsers(keyword string, page, pageSize, actorRole int) ([]CodexAdminUser, int64, error) {
	query := DB.Model(&User{})
	if actorRole != common.RoleRootUser {
		query = query.Where("role < ?", actorRole)
	}
	keyword = strings.TrimSpace(keyword)
	if keyword != "" {
		if id, err := strconv.Atoi(keyword); err == nil && id > 0 {
			query = query.Where("username LIKE ? OR display_name LIKE ? OR id = ?", "%"+keyword+"%", "%"+keyword+"%", id)
		} else {
			query = query.Where("username LIKE ? OR display_name LIKE ?", "%"+keyword+"%", "%"+keyword+"%")
		}
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var users []User
	if err := query.Select("id", "username", "display_name", "role", "status").Order("id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&users).Error; err != nil {
		return nil, 0, err
	}
	ids := make([]int, 0, len(users))
	for _, user := range users {
		ids = append(ids, user.Id)
	}
	var configs []CodexUserConfig
	if len(ids) > 0 {
		if err := DB.Where("user_id IN ?", ids).Find(&configs).Error; err != nil {
			return nil, 0, err
		}
	}
	byUser := make(map[int]CodexUserConfig)
	for _, config := range configs {
		byUser[config.UserID] = config
	}
	grants, err := activeCodexGrants(DB, ids)
	if err != nil {
		return nil, 0, err
	}
	result := make([]CodexAdminUser, 0, len(users))
	for _, user := range users {
		config := byUser[user.Id]
		config.UserID = user.Id
		result = append(result, CodexAdminUser{ID: user.Id, Username: user.Username, DisplayName: user.DisplayName, Role: user.Role, Status: user.Status, Config: config, Effective: resolveCodexPolicy(&user, &config, grants[user.Id])})
	}
	return result, total, nil
}
