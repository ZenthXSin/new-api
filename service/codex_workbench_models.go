package service

import (
	"errors"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

type CodexCatalogModel struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}
type CodexCatalogGroup struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Ratio       float64             `json:"ratio"`
	Models      []CodexCatalogModel `json:"models"`
}
type CodexCatalog struct {
	Groups       []CodexCatalogGroup `json:"groups"`
	DefaultGroup string              `json:"defaultGroup"`
	DefaultModel string              `json:"defaultModel"`
}

// This tests installed adapter support, not a provider's marketing model name.
// Unsupported model families remain visible so the UI explains their limits.
func CodexChannelSupportsModel(channel *model.Channel, name, requestPath string) bool {
	lower := strings.ToLower(name)
	if common.IsImageGenerationModel(name) || strings.Contains(lower, "embedding") || strings.Contains(lower, "rerank") || strings.HasPrefix(lower, "whisper") || strings.HasPrefix(lower, "tts-") || strings.HasPrefix(lower, "sora") {
		return false
	}
	apiType, _ := common.ChannelType2APIType(channel.Type)
	if requestPath == "/v1/responses/compact" && !common.SupportsResponsesCompact(channel.Type, apiType) {
		return false
	}
	if channel.Type == constant.ChannelTypeAdvancedCustom {
		config := channel.GetOtherSettings().AdvancedCustom
		return config != nil && config.SupportsPathForModel(requestPath, name)
	}
	switch apiType {
	case constant.APITypeOpenAI, constant.APITypeCodex, constant.APITypeSub2API,
		constant.APITypeNewAPI, constant.APITypeGemini, constant.APITypeDeepSeek,
		constant.APITypeAli, constant.APITypeVolcEngine, constant.APITypePerplexity,
		constant.APITypeCloudflare, constant.APITypeXai:
		return true
	}
	return false
}

func codexModelAbilities() ([]model.AbilityWithChannel, map[int]*model.Channel, error) {
	abilities, err := model.GetAllEnableAbilityWithChannels()
	if err != nil {
		return nil, nil, err
	}
	var channels []*model.Channel
	// Capability evaluation requires only type and routing settings, never keys.
	if err := model.DB.Select("id", "type", "status", "settings").Find(&channels).Error; err != nil {
		return nil, nil, err
	}
	byID := make(map[int]*model.Channel, len(channels))
	for _, channel := range channels {
		byID[channel.Id] = channel
	}
	return abilities, byID, nil
}

func GetCodexCatalog(userID int) (*CodexCatalog, error) {
	user, err := model.GetUserCache(userID)
	if err != nil {
		return nil, err
	}
	policy, err := model.GetEffectiveCodexUserPolicy(userID)
	if err != nil {
		return nil, err
	}
	if !policy.Enabled || user.Status != common.UserStatusEnabled {
		return nil, ErrLoginSessionInvalid
	}
	abilities, channels, err := codexModelAbilities()
	if err != nil {
		return nil, err
	}
	usable := GetUserUsableGroupsByGroups(user.GetGroups())
	names := make([]string, 0, len(usable))
	for name := range usable {
		if name != "auto" && ratio_setting.ContainsGroupRatio(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	result := &CodexCatalog{Groups: []CodexCatalogGroup{}}
	for _, group := range names {
		models := map[string]bool{}
		for _, ability := range abilities {
			if ability.Group != group {
				continue
			}
			channel := channels[ability.ChannelId]
			if channel == nil || channel.Status != common.ChannelStatusEnabled {
				continue
			}
			models[ability.Model] = models[ability.Model] || CodexChannelSupportsModel(channel, ability.Model, "/v1/responses")
		}
		entry := CodexCatalogGroup{ID: group, Name: group, Description: usable[group], Ratio: GetUserGroupRatio(user.Group, group), Models: []CodexCatalogModel{}}
		for name, supported := range models {
			item := CodexCatalogModel{ID: name, Name: name, Supported: supported}
			if !supported {
				item.Reason = "This model's current channels do not support the Responses API required by Codex."
			}
			entry.Models = append(entry.Models, item)
		}
		sort.Slice(entry.Models, func(i, j int) bool { return entry.Models[i].ID < entry.Models[j].ID })
		result.Groups = append(result.Groups, entry)
	}
	for _, group := range result.Groups {
		for _, item := range group.Models {
			if !item.Supported {
				continue
			}
			if result.DefaultModel == "" || group.ID == user.Group && result.DefaultGroup != user.Group {
				result.DefaultGroup, result.DefaultModel = group.ID, item.ID
			}
			if group.ID == user.Group && item.ID == "gpt-6.1-sol" {
				result.DefaultGroup, result.DefaultModel = group.ID, item.ID
			}
		}
	}
	// Configured defaults select only an already permitted, supported pair;
	// they never add a model or a group to the user's catalog.
	if policy.DefaultGroup != "" || policy.DefaultModel != "" {
		for _, group := range result.Groups {
			if policy.DefaultGroup != "" && policy.DefaultGroup != group.ID {
				continue
			}
			for _, item := range group.Models {
				if item.Supported && (policy.DefaultModel == "" || policy.DefaultModel == item.ID) {
					result.DefaultGroup, result.DefaultModel = group.ID, item.ID
					return result, nil
				}
			}
		}
	}
	return result, nil
}

// Re-evaluate group rights and adapter availability on each model invocation.
func CodexAllowedChannels(user *model.UserBase, group, name, requestPath string) (map[int]bool, error) {
	if user == nil || user.Status != common.UserStatusEnabled || !IsUserSelectableGroupByGroups(user.GetGroups(), group) {
		return nil, errors.New("Codex group is not available")
	}
	permitted, err := model.CodexUserCanAccess(user.Id)
	if err != nil || !permitted {
		return nil, ErrLoginSessionInvalid
	}
	abilities, channels, err := codexModelAbilities()
	if err != nil {
		return nil, err
	}
	allowed := map[int]bool{}
	for _, ability := range abilities {
		channel := channels[ability.ChannelId]
		if ability.Group == group && ability.Model == name && channel != nil && channel.Status == common.ChannelStatusEnabled && CodexChannelSupportsModel(channel, name, requestPath) {
			allowed[channel.Id] = true
		}
	}
	if len(allowed) == 0 {
		return nil, errors.New("Codex model is not available in this group")
	}
	return allowed, nil
}
