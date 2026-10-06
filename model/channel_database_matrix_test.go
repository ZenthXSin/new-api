package model

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// This fixture uses the same simple-protocol PostgreSQL connection as
// production, so JSON values cannot accidentally rely on prepared statements.
func TestOAuthDatabaseChannelConfigurationRoundTrip(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	require.NoError(t, DB.AutoMigrate(&Channel{}))
	channel := &Channel{
		Key: "isolated-channel-fixture-key", Name: "matrix-channel-json", Models: "fixture-model", Group: "default",
		ChannelInfo: ChannelInfo{
			IsMultiKey: true, MultiKeySize: 2, MultiKeyStatusList: map[int]int{0: 1, 1: 2},
			MultiKeyDisabledReason: map[int]string{1: "原有禁用状态"}, MultiKeyDisabledTime: map[int]int64{1: 1700000000},
			MultiKeyPollingIndex: 1, MultiKeyMode: constant.MultiKeyModePolling,
		},
	}
	require.NoError(t, DB.Create(channel).Error, "channel creation must persist JSON using the production driver mode")
	var loaded Channel
	require.NoError(t, DB.First(&loaded, channel.Id).Error)
	assert.Equal(t, channel.ChannelInfo, loaded.ChannelInfo)
	loaded.ChannelInfo.MultiKeyPollingIndex = 0
	loaded.ChannelInfo.MultiKeyStatusList[1] = 1
	loaded.ChannelInfo.MultiKeyDisabledReason = nil
	loaded.ChannelInfo.MultiKeyDisabledTime = nil
	require.NoError(t, loaded.SaveChannelInfo())
	var updated Channel
	require.NoError(t, DB.First(&updated, channel.Id).Error)
	assert.Equal(t, loaded.ChannelInfo, updated.ChannelInfo, "channel polling and status changes must round trip")
	assert.Equal(t, channel.Key, updated.Key, "updating configuration must preserve the channel credential")

	legacy := `{"is_multi_key":true,"multi_key_size":2,"multi_key_status_list":{"0":1,"1":2},"multi_key_disabled_reason":{"1":"原有渠道停用"},"multi_key_disabled_time":{"1":1700000000},"multi_key_polling_index":1,"multi_key_mode":"polling"}`
	require.NoError(t, DB.Model(channel).Update("channel_info", legacy).Error)
	var legacyLoaded Channel
	require.NoError(t, DB.First(&legacyLoaded, channel.Id).Error)
	assert.True(t, legacyLoaded.ChannelInfo.IsMultiKey)
	assert.Equal(t, "原有渠道停用", legacyLoaded.ChannelInfo.MultiKeyDisabledReason[1])
	assert.Equal(t, 1, legacyLoaded.ChannelInfo.MultiKeyPollingIndex)

	require.NoError(t, DB.Model(channel).Update("channel_info", nil).Error)
	var withoutInfo Channel
	require.NoError(t, DB.First(&withoutInfo, channel.Id).Error)
	assert.Equal(t, ChannelInfo{}, withoutInfo.ChannelInfo, "legacy SQL NULL represents no channel configuration")
	require.NoError(t, withoutInfo.SaveChannelInfo())
	var zeroInfo Channel
	require.NoError(t, DB.First(&zeroInfo, channel.Id).Error)
	assert.Equal(t, ChannelInfo{}, zeroInfo.ChannelInfo, "zero configuration must remain writable after reading NULL")
}

func TestChannelInfoScansDriverValuesAndLegacyNull(t *testing.T) {
	legacy := `{"is_multi_key":true,"multi_key_size":2,"multi_key_status_list":{"0":1,"1":2},"multi_key_mode":"polling"}`
	expected := ChannelInfo{IsMultiKey: true, MultiKeySize: 2, MultiKeyStatusList: map[int]int{0: 1, 1: 2}, MultiKeyMode: constant.MultiKeyModePolling}
	for _, test := range []struct {
		name  string
		value any
		want  ChannelInfo
	}{
		{"bytes", []byte(legacy), expected},
		{"text", legacy, expected},
		{"sql null", nil, ChannelInfo{}},
		{"typed nil", []byte(nil), ChannelInfo{}},
		{"json null", "null", ChannelInfo{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			info := ChannelInfo{MultiKeyPollingIndex: 99}
			require.NoError(t, info.Scan(test.value))
			assert.Equal(t, test.want, info)
		})
	}
	for _, value := range []any{42, "invalid-json", []byte{}} {
		info := ChannelInfo{MultiKeyPollingIndex: 99}
		require.Error(t, info.Scan(value))
		assert.Equal(t, ChannelInfo{MultiKeyPollingIndex: 99}, info, "failed scans must not partly replace existing configuration")
	}
}
