package service

import (
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

func GetUserUsableGroups(userGroup string) map[string]string {
	return GetUserUsableGroupsByGroups([]string{userGroup})
}

// getUserUsableGroupsForGroup resolves one primary group's target-group
// permissions. Keeping this isolated lets multi-group users receive the union
// without making a restrictive rule depend on iteration order.
func getUserUsableGroupsForGroup(userGroup string) map[string]string {
	groupsCopy := setting.GetUserUsableGroupsCopy()
	userGroup = strings.TrimSpace(userGroup)
	if userGroup == "" {
		return groupsCopy
	}
	specialSettings, ok := ratio_setting.GetGroupRatioSetting().GroupSpecialUsableGroup.Get(userGroup)
	if ok {
		for specialGroup, desc := range specialSettings {
			if strings.HasPrefix(specialGroup, "-:") {
				delete(groupsCopy, strings.TrimPrefix(specialGroup, "-:"))
			} else if strings.HasPrefix(specialGroup, "+:") {
				groupsCopy[strings.TrimPrefix(specialGroup, "+:")] = desc
			} else {
				groupsCopy[specialGroup] = desc
			}
		}
	}
	if _, ok := groupsCopy[userGroup]; !ok {
		groupsCopy[userGroup] = "用户分组"
	}
	return groupsCopy
}

// GetUserUsableGroupsByGroups unions the target groups available to each
// assigned user group. A restriction on one member group must not revoke a
// target granted by another member group.
func GetUserUsableGroupsByGroups(userGroups []string) map[string]string {
	if len(userGroups) == 0 {
		return setting.GetUserUsableGroupsCopy()
	}
	usable := make(map[string]string)
	hasUserGroup := false
	seen := make(map[string]struct{}, len(userGroups))
	for _, userGroup := range userGroups {
		userGroup = strings.TrimSpace(userGroup)
		if userGroup == "" {
			continue
		}
		hasUserGroup = true
		if _, exists := seen[userGroup]; exists {
			continue
		}
		seen[userGroup] = struct{}{}
		for group, desc := range getUserUsableGroupsForGroup(userGroup) {
			if _, exists := usable[group]; !exists {
				usable[group] = desc
			}
		}
	}
	if !hasUserGroup {
		return setting.GetUserUsableGroupsCopy()
	}
	return usable
}

func GroupInUserUsableGroups(userGroup, groupName string) bool {
	_, ok := GetUserUsableGroups(userGroup)[groupName]
	return ok
}

func GroupInUserUsableGroupsByGroups(userGroups []string, groupName string) bool {
	_, ok := GetUserUsableGroupsByGroups(userGroups)[groupName]
	return ok
}

func IsUserSelectableGroup(userGroup, groupName string) bool {
	return IsUserSelectableGroupByGroups([]string{userGroup}, groupName)
}

func IsUserSelectableGroupByGroups(userGroups []string, groupName string) bool {
	if groupName == "" || groupName == "auto" {
		return false
	}
	return GroupInUserUsableGroupsByGroups(userGroups, groupName) && ratio_setting.ContainsGroupRatio(groupName)
}

// GetUserAutoGroup 根据用户分组获取自动分组设置
func GetUserAutoGroup(userGroup string) []string {
	return GetUserAutoGroupByGroups([]string{userGroup})
}

func GetUserAutoGroupByGroups(userGroups []string) []string {
	autoGroups := make([]string, 0)
	seen := make(map[string]struct{})
	for _, group := range setting.GetAutoGroups() {
		if !IsUserSelectableGroupByGroups(userGroups, group) {
			continue
		}
		if _, ok := seen[group]; ok {
			continue
		}
		seen[group] = struct{}{}
		autoGroups = append(autoGroups, group)
	}
	return autoGroups
}

// FilterUserTokenAutoGroups applies current permissions before the current
// per-token limit. It intentionally does not fall back to the global Auto list.
func FilterUserTokenAutoGroups(userGroup string, groups []string) []string {
	return FilterUserTokenAutoGroupsByGroups([]string{userGroup}, groups)
}

func FilterUserTokenAutoGroupsByGroups(userGroups []string, groups []string) []string {
	maxCount := setting.GetMaxTokenAutoGroups()
	filtered := make([]string, 0, min(len(groups), maxCount))
	seen := make(map[string]struct{})
	for _, group := range groups {
		if !IsUserSelectableGroupByGroups(userGroups, group) {
			continue
		}
		if _, ok := seen[group]; ok {
			continue
		}
		seen[group] = struct{}{}
		filtered = append(filtered, group)
		if len(filtered) == maxCount {
			break
		}
	}
	return filtered
}

// GetRequestAutoGroups resolves the ordered Auto groups for the current token.
// The absence of the context value means that the token inherits the complete
// global Auto list; a present (even empty) value is an explicit token snapshot.
func GetRequestAutoGroups(c *gin.Context, userGroup string) []string {
	return GetRequestAutoGroupsByGroups(c, []string{userGroup})
}

func GetRequestAutoGroupsByGroups(c *gin.Context, userGroups []string) []string {
	value, ok := common.GetContextKey(c, constant.ContextKeyTokenAutoGroups)
	if !ok {
		return GetUserAutoGroupByGroups(userGroups)
	}
	groups, ok := value.([]string)
	if !ok {
		return []string{}
	}
	return FilterUserTokenAutoGroupsByGroups(userGroups, groups)
}

// GetGroupsEnabledModels 按 groups 顺序获取各分组启用的模型并去重
func GetGroupsEnabledModels(groups []string) []string {
	seen := make(map[string]struct{})
	models := make([]string, 0)
	for _, group := range groups {
		for _, modelName := range model.GetGroupEnabledModels(group) {
			if _, ok := seen[modelName]; !ok {
				seen[modelName] = struct{}{}
				models = append(models, modelName)
			}
		}
	}
	return models
}

// GetUserGroupRatio 获取用户使用某个分组的倍率
// userGroup 用户分组
// group 需要获取倍率的分组
func GetUserGroupRatio(userGroup, group string) float64 {
	ratio, ok := ratio_setting.GetGroupGroupRatio(userGroup, group)
	if ok {
		return ratio
	}
	return ratio_setting.GetGroupRatio(group)
}
