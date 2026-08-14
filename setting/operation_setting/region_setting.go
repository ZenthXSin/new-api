package operation_setting

import (
	"strings"

	"github.com/QuantumNous/new-api/setting/config"
)

// RegionReminderSetting GeoIP 地区访问提醒配置(仅提醒,不拦截任何请求)
type RegionReminderSetting struct {
	Enabled   bool   `json:"enabled"`   // 是否启用地区访问提醒
	Countries string `json:"countries"` // 需要提醒的国家/地区 ISO 码,逗号分隔
	Message   string `json:"message"`   // 提醒文案
}

// 默认配置
var regionReminderSetting = RegionReminderSetting{
	Enabled:   true,
	Countries: "CN",
	Message:   "请注意,本站不向中国大陆地区提供服务,受相关法律法规及合规要求限制,来自该地区的访问可能无法使用本站服务。命中国家/地区:CN",
}

func init() {
	// 注册到全局配置管理器,键名为 region_reminder
	config.GlobalConfig.Register("region_reminder", &regionReminderSetting)
}

// GetRegionReminderSetting 获取地区提醒配置实例
func GetRegionReminderSetting() *RegionReminderSetting {
	return &regionReminderSetting
}

// IsRegionReminderCountry 判断给定 ISO 国家码是否命中提醒地区列表。
// 逗号分隔、逐项 trim、忽略空项;空 code 或空列表一律返回 false。
func IsRegionReminderCountry(code string) bool {
	code = strings.TrimSpace(code)
	if code == "" {
		return false
	}
	countries := strings.TrimSpace(regionReminderSetting.Countries)
	if countries == "" {
		return false
	}
	for _, c := range strings.Split(countries, ",") {
		if strings.TrimSpace(c) == code {
			return true
		}
	}
	return false
}
