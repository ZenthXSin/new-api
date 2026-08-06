package model

import (
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupPollingSelectionDB(t *testing.T) *gorm.DB {
	t.Helper()

	previousDB := DB
	previousMemoryCacheEnabled := common.MemoryCacheEnabled
	channelSyncLock.Lock()
	previousGroup2model2channels := group2model2channels
	previousChannelsIDM := channelsIDM
	previousAdvancedCustomConfigs := channel2advancedCustomConfig
	channelSyncLock.Unlock()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Channel{}, &Ability{}))
	DB = db
	t.Cleanup(func() {
		DB = previousDB
		common.MemoryCacheEnabled = previousMemoryCacheEnabled
		channelSyncLock.Lock()
		group2model2channels = previousGroup2model2channels
		channelsIDM = previousChannelsIDM
		channel2advancedCustomConfig = previousAdvancedCustomConfigs
		channelSyncLock.Unlock()
		sqlDB, sqlErr := db.DB()
		if sqlErr == nil {
			_ = sqlDB.Close()
		}
	})
	return db
}

func createPollingSelectionChannel(t *testing.T, id int, priority int64, weight uint, channelType int, settings dto.ChannelOtherSettings) {
	t.Helper()
	channel := &Channel{
		Id:       id,
		Type:     channelType,
		Key:      fmt.Sprintf("key-%d", id),
		Status:   common.ChannelStatusEnabled,
		Name:     fmt.Sprintf("channel-%d", id),
		Group:    "default",
		Models:   "test-model",
		Priority: &priority,
		Weight:   &weight,
	}
	if settings.AdvancedCustom != nil {
		channel.SetOtherSettings(settings)
	}
	require.NoError(t, DB.Create(channel).Error)
	require.NoError(t, DB.Create(&Ability{
		Group:     "default",
		Model:     "test-model",
		ChannelId: id,
		Enabled:   true,
		Priority:  &priority,
		Weight:    weight,
	}).Error)
}

func TestPollingSelectionExclusionsUseHighestRemainingPriorityAcrossCachePaths(t *testing.T) {
	setupPollingSelectionDB(t)
	createPollingSelectionChannel(t, 101, 100, 1, constant.ChannelTypeOpenAI, dto.ChannelOtherSettings{})
	createPollingSelectionChannel(t, 102, 10, 1, constant.ChannelTypeOpenAI, dto.ChannelOtherSettings{})
	excluded := map[int]struct{}{101: {}}

	for _, memoryCacheEnabled := range []bool{false, true} {
		common.MemoryCacheEnabled = memoryCacheEnabled
		if memoryCacheEnabled {
			InitChannelCache()
		}

		channel, err := GetRandomSatisfiedChannelExcluding("default", "test-model", 0, "", excluded)
		require.NoError(t, err)
		require.NotNil(t, channel)
		assert.Equal(t, 102, channel.Id)
	}
}

func TestPollingSelectionPathFilteringMatchesCacheAndDatabase(t *testing.T) {
	setupPollingSelectionDB(t)
	createPollingSelectionChannel(t, 201, 100, 1, constant.ChannelTypeAdvancedCustom, dto.ChannelOtherSettings{
		AdvancedCustom: &dto.AdvancedCustomConfig{Routes: []dto.AdvancedCustomRoute{{
			IncomingPath: "/v1/responses",
			UpstreamPath: "/v1/responses",
		}}},
	})
	createPollingSelectionChannel(t, 202, 10, 1, constant.ChannelTypeOpenAI, dto.ChannelOtherSettings{})

	for _, memoryCacheEnabled := range []bool{false, true} {
		common.MemoryCacheEnabled = memoryCacheEnabled
		if memoryCacheEnabled {
			InitChannelCache()
		}

		channel, err := GetRandomSatisfiedChannel("default", "test-model", 0, "/v1/chat/completions")
		require.NoError(t, err)
		require.NotNil(t, channel)
		assert.Equal(t, 202, channel.Id)
	}
}

func TestPollingSelectionSupportsMaximumStoredCacheWeight(t *testing.T) {
	setupPollingSelectionDB(t)
	priority := int64(100)
	weight := ^uint(0)
	common.MemoryCacheEnabled = true
	channelSyncLock.Lock()
	group2model2channels = map[string]map[string][]int{"default": {"test-model": {301}}}
	channelsIDM = map[int]*Channel{301: {Id: 301, Priority: &priority, Weight: &weight}}
	channel2advancedCustomConfig = map[int]*dto.AdvancedCustomConfig{}
	channelSyncLock.Unlock()

	channel, err := GetRandomSatisfiedChannelExcluding("default", "test-model", 0, "", nil)
	require.NoError(t, err)
	require.NotNil(t, channel)
	assert.Equal(t, 301, channel.Id)
}

func TestPollingSelectionCacheLowAverageLeavesZeroWeightUnselectable(t *testing.T) {
	setupPollingSelectionDB(t)
	priority := int64(100)
	zeroWeight := uint(0)
	lowWeight := uint(1)
	common.MemoryCacheEnabled = true
	channelSyncLock.Lock()
	group2model2channels = map[string]map[string][]int{"default": {"test-model": {401, 402}}}
	channelsIDM = map[int]*Channel{
		401: {Id: 401, Priority: &priority, Weight: &zeroWeight},
		402: {Id: 402, Priority: &priority, Weight: &lowWeight},
	}
	channel2advancedCustomConfig = map[int]*dto.AdvancedCustomConfig{}
	channelSyncLock.Unlock()

	channel, err := GetRandomSatisfiedChannelExcluding("default", "test-model", 0, "", nil)
	require.NoError(t, err)
	require.NotNil(t, channel)
	assert.Equal(t, 402, channel.Id)
}

func TestPollingSelectionAdvancedCustomDatabaseFailureFailsClosed(t *testing.T) {
	db := setupPollingSelectionDB(t)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close())

	abilities, err := filterAbilitiesByRequestPathAndModel([]Ability{{ChannelId: 401}}, "/v1/chat/completions", "test-model")
	require.Error(t, err)
	assert.Nil(t, abilities)
}
