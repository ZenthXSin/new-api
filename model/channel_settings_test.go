package model

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChannelValidateSettingsRejectsInvalidHTTPTransport(t *testing.T) {
	tests := []struct {
		name    string
		setting dto.ChannelSettings
		wantErr string
	}{
		{
			name:    "auto with shards is valid",
			setting: dto.ChannelSettings{HTTPProtocol: "auto", HTTP2ConnectionShards: 4},
		},
		{
			name:    "http1 with shards greater than one rejected",
			setting: dto.ChannelSettings{HTTPProtocol: "http1", HTTP2ConnectionShards: 2},
			wantErr: "http2_connection_shards",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{}
			channel.SetSetting(tt.setting)
			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestAdvancedCustomChannelRequiresModelListRouteOnlyWhenUpdateChecksEnabled(t *testing.T) {
	inferenceRoute := dto.AdvancedCustomRoute{
		IncomingPath: "/v1/chat/completions",
		UpstreamPath: "/v1/chat/completions",
		Converter:    "none",
	}

	tests := []struct {
		name          string
		checksEnabled bool
		routes        []dto.AdvancedCustomRoute
		wantErr       string
	}{
		{
			name:   "legacy channel without discovery route remains valid",
			routes: []dto.AdvancedCustomRoute{inferenceRoute},
		},
		{
			name:          "enabled checks require discovery route",
			checksEnabled: true,
			routes:        []dto.AdvancedCustomRoute{inferenceRoute},
			wantErr:       dto.AdvancedCustomModelListPath,
		},
		{
			name:          "enabled checks accept discovery route",
			checksEnabled: true,
			routes: []dto.AdvancedCustomRoute{
				inferenceRoute,
				{
					IncomingPath: dto.AdvancedCustomModelListPath,
					UpstreamPath: dto.AdvancedCustomModelListPath,
					Converter:    "none",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{Type: constant.ChannelTypeAdvancedCustom}
			channel.SetOtherSettings(dto.ChannelOtherSettings{
				UpstreamModelUpdateCheckEnabled: tt.checksEnabled,
				AdvancedCustom: &dto.AdvancedCustomConfig{
					Routes: tt.routes,
				},
			})

			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestChannelTextPollingTimeoutDefaultsAndValidation(t *testing.T) {
	legacy := &Channel{OtherSettings: `{}`}
	require.NoError(t, legacy.ValidateSettings())
	settings := legacy.GetOtherSettings()
	assert.False(t, settings.TextPollingEnabled)
	assert.Equal(t, 3, settings.TextPollingTimeoutTier1Seconds)
	assert.Equal(t, 6, settings.TextPollingTimeoutTier2Seconds)
	assert.Equal(t, 12, settings.TextPollingTimeoutTier3Seconds)

	partialLegacy := &Channel{OtherSettings: `{"text_polling_timeout_tier1_seconds":2}`}
	require.NoError(t, partialLegacy.ValidateSettings())
	settings = partialLegacy.GetOtherSettings()
	assert.Equal(t, 2, settings.TextPollingTimeoutTier1Seconds)
	assert.Equal(t, 6, settings.TextPollingTimeoutTier2Seconds)
	assert.Equal(t, 12, settings.TextPollingTimeoutTier3Seconds)

	tests := []struct {
		name     string
		settings dto.ChannelOtherSettings
		wantErr  string
	}{
		{name: "custom values", settings: dto.ChannelOtherSettings{TextPollingTimeoutTier1Seconds: 2, TextPollingTimeoutTier2Seconds: 5, TextPollingTimeoutTier3Seconds: 20}},
		{name: "negative", settings: dto.ChannelOtherSettings{TextPollingTimeoutTier1Seconds: -1, TextPollingTimeoutTier2Seconds: 5, TextPollingTimeoutTier3Seconds: 20}, wantErr: "between"},
		{name: "too large", settings: dto.ChannelOtherSettings{TextPollingTimeoutTier1Seconds: 2, TextPollingTimeoutTier2Seconds: 5, TextPollingTimeoutTier3Seconds: dto.MaxTextPollingTimeoutSeconds + 1}, wantErr: "between"},
		{name: "unordered", settings: dto.ChannelOtherSettings{TextPollingTimeoutTier1Seconds: 8, TextPollingTimeoutTier2Seconds: 5, TextPollingTimeoutTier3Seconds: 20}, wantErr: "ordered"},
		{name: "equal first and second tiers", settings: dto.ChannelOtherSettings{TextPollingTimeoutTier1Seconds: 5, TextPollingTimeoutTier2Seconds: 5, TextPollingTimeoutTier3Seconds: 20}, wantErr: "ordered"},
		{name: "equal second and third tiers", settings: dto.ChannelOtherSettings{TextPollingTimeoutTier1Seconds: 2, TextPollingTimeoutTier2Seconds: 5, TextPollingTimeoutTier3Seconds: 5}, wantErr: "ordered"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{}
			channel.SetOtherSettings(tt.settings)
			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}

	for _, timeoutField := range []string{
		"text_polling_timeout_tier1_seconds",
		"text_polling_timeout_tier2_seconds",
		"text_polling_timeout_tier3_seconds",
	} {
		t.Run("explicit zero "+timeoutField, func(t *testing.T) {
			channel := &Channel{OtherSettings: `{"` + timeoutField + `":0}`}
			err := channel.ValidateSettings()
			require.Error(t, err)
			assert.Contains(t, err.Error(), "between")
		})
	}
}

func TestChannelTextPollingEnabledPersistsOnlyWhenOptedIn(t *testing.T) {
	channel := &Channel{}
	channel.SetOtherSettings(dto.ChannelOtherSettings{TextPollingEnabled: true})

	assert.Contains(t, channel.OtherSettings, `"text_polling_enabled":true`)
	assert.True(t, channel.GetOtherSettings().TextPollingEnabled)

	legacy := &Channel{OtherSettings: `{}`}
	assert.False(t, legacy.GetOtherSettings().TextPollingEnabled)
}
