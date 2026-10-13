package model

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

type ChannelIntelligenceCheck struct {
	Status       string `json:"status"`
	Model        string `json:"model"`
	Response     string `json:"response"`
	CheckedAt    int64  `json:"checked_at"`
	AutoDisabled bool   `json:"auto_disabled"`
}

func SaveChannelIntelligenceCheck(channelID int, result ChannelIntelligenceCheck) error {
	payload, err := common.Marshal(result)
	if err != nil {
		return err
	}
	return DB.Model(&Channel{}).Where("id = ?", channelID).Update("intelligence_check", string(payload)).Error
}

func HasChannelIntelligenceChecks() bool {
	if DB == nil {
		return false
	}
	var settings []string
	if DB.Model(&Channel{}).Where("status <> ?", common.ChannelStatusManuallyDisabled).Pluck("settings", &settings).Error != nil {
		return false
	}
	for _, payload := range settings {
		var config dto.ChannelOtherSettings
		if common.UnmarshalJsonStr(payload, &config) == nil && config.IntelligenceCheckEnabled {
			return true
		}
	}
	return false
}
