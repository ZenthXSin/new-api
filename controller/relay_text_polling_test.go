package controller

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTextPollingControllerDB(t *testing.T) {
	t.Helper()

	previousMemoryCacheEnabled := common.MemoryCacheEnabled
	setupModelListControllerTestDB(t)
	common.MemoryCacheEnabled = false
	t.Cleanup(func() {
		common.MemoryCacheEnabled = previousMemoryCacheEnabled
	})
}

func createTextPollingChannel(t *testing.T, id int, priority int64, settings dto.ChannelOtherSettings) *model.Channel {
	t.Helper()
	weight := uint(1)
	channel := &model.Channel{
		Id:       id,
		Key:      "test-key",
		Status:   common.ChannelStatusEnabled,
		Name:     "test-channel",
		Group:    "default",
		Models:   "test-model",
		Priority: &priority,
		Weight:   &weight,
	}
	channel.SetOtherSettings(settings)
	require.NoError(t, model.DB.Create(channel).Error)
	require.Equal(t, id, channel.Id)
	require.NoError(t, model.DB.Create(&model.Ability{
		Group:     channel.Group,
		Model:     "test-model",
		ChannelId: channel.Id,
		Enabled:   true,
		Priority:  channel.Priority,
		Weight:    weight,
	}).Error)
	var ability model.Ability
	require.NoError(t, model.DB.First(&ability, "channel_id = ?", id).Error)
	require.Equal(t, id, ability.ChannelId)
	return channel
}

func TestGetTextPollingInitialChannelUsesContextOptIn(t *testing.T) {
	setupTextPollingControllerDB(t)
	channel := createTextPollingChannel(t, 101, 10, dto.ChannelOtherSettings{})
	tests := []struct {
		name          string
		settings      *dto.ChannelOtherSettings
		specific      bool
		relayFormat   types.RelayFormat
		wantPolling   bool
		wantChannelID int
	}{
		{name: "missing settings leaves polling disabled", relayFormat: types.RelayFormatOpenAI},
		{name: "false setting leaves polling disabled", settings: &dto.ChannelOtherSettings{}, relayFormat: types.RelayFormatOpenAI},
		{name: "enabled HTTP context setting resolves the distributor channel before relay metadata initialization", settings: &dto.ChannelOtherSettings{TextPollingEnabled: true}, relayFormat: types.RelayFormatOpenAI, wantPolling: true, wantChannelID: channel.Id},
		{name: "specific channel bypasses enabled polling", settings: &dto.ChannelOtherSettings{TextPollingEnabled: true}, specific: true, relayFormat: types.RelayFormatOpenAI},
		{name: "enabled realtime WebSocket bypasses polling", settings: &dto.ChannelOtherSettings{TextPollingEnabled: true}, relayFormat: types.RelayFormatOpenAIRealtime},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			context, _ := gin.CreateTestContext(httptest.NewRecorder())
			require.Nil(t, context.Request)
			common.SetContextKey(context, constant.ContextKeyChannelId, channel.Id)
			if tt.settings != nil {
				common.SetContextKey(context, constant.ContextKeyChannelOtherSetting, *tt.settings)
			}
			if tt.specific {
				context.Set("specific_channel_id", channel.Id)
			}

			initialChannel, polling, err := getTextPollingInitialChannel(context, tt.relayFormat)

			require.Nil(t, err)
			assert.Equal(t, tt.wantPolling, polling)
			if tt.wantPolling {
				require.NotNil(t, initialChannel)
				assert.Equal(t, tt.wantChannelID, initialChannel.Id)
			} else {
				assert.Nil(t, initialChannel)
			}
		})
	}
}

func TestTextPollingFallbackSelectsRemainingChannelsAtHighestPriority(t *testing.T) {
	setupTextPollingControllerDB(t)
	createTextPollingChannel(t, 201, 30, dto.ChannelOtherSettings{})
	second := createTextPollingChannel(t, 202, 20, dto.ChannelOtherSettings{TextPollingEnabled: true})
	third := createTextPollingChannel(t, 203, 10, dto.ChannelOtherSettings{TextPollingEnabled: true})

	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	retryParam := &service.RetryParam{Ctx: context, TokenGroup: "default", ModelName: "test-model"}
	excluded := make(map[int]struct{})
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{}, OriginModelName: "test-model"}

	first, err := getTextPollingFallbackChannel(context, info, retryParam, excluded)
	require.Nil(t, err, "fallback selection error: %v", err)
	require.NotNil(t, first)
	secondSelected, err := getTextPollingFallbackChannel(context, info, retryParam, excluded)
	require.Nil(t, err)
	require.NotNil(t, secondSelected)

	assert.Equal(t, second.Id, first.Id)
	assert.Equal(t, third.Id, secondSelected.Id)
	assert.Contains(t, excluded, 201)
	assert.Contains(t, excluded, second.Id)
	assert.Contains(t, excluded, third.Id)
	assert.Zero(t, retryParam.GetRetry())
}

func TestTextPollingCoordinatorSkipsDisabledChannelsAndAttemptsEnabledCandidates(t *testing.T) {
	baseTime := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	disabled := &model.Channel{Id: 1}
	enabled := &model.Channel{Id: 2}
	enabled.SetOtherSettings(dto.ChannelOtherSettings{TextPollingEnabled: true, TextPollingTimeoutTier1Seconds: 2})
	var selected []int
	var attempted []int

	result := textPollingCoordinator{
		ctx:      context.Background(),
		deadline: baseTime.Add(maxTextPollingDuration),
		now:      func() time.Time { return baseTime },
		selectChannel: func(_ int, excluded map[int]struct{}) (*model.Channel, *types.NewAPIError) {
			if _, skipped := excluded[disabled.Id]; !skipped {
				return disabled, nil
			}
			if _, skipped := excluded[enabled.Id]; !skipped {
				return enabled, nil
			}
			return nil, nil
		},
		selected: func(channel *model.Channel, _ int, _ time.Duration) {
			selected = append(selected, channel.Id)
		},
		attempt: func(channel *model.Channel, _ int, _ time.Duration) *types.NewAPIError {
			attempted = append(attempted, channel.Id)
			return nil
		},
		onFailure:   func(_ *model.Channel, err *types.NewAPIError) *types.NewAPIError { return err },
		shouldRetry: func(*types.NewAPIError) bool { return true },
		committed:   func() bool { return false },
	}.run()

	require.Nil(t, result)
	assert.False(t, isTextPollingChannelEnabled(disabled))
	assert.True(t, isTextPollingChannelEnabled(enabled))
	assert.Equal(t, []int{enabled.Id}, selected)
	assert.Equal(t, []int{enabled.Id}, attempted)
}

func TestTextPollingCoordinatorTerminatesWhenSelectorRepeatsDisabledChannel(t *testing.T) {
	baseTime := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	disabled := &model.Channel{Id: 1}
	var selections, attempts int

	result := textPollingCoordinator{
		ctx:      context.Background(),
		deadline: baseTime.Add(maxTextPollingDuration),
		now:      func() time.Time { return baseTime },
		selectChannel: func(int, map[int]struct{}) (*model.Channel, *types.NewAPIError) {
			return disabled, nil
		},
		selected: func(*model.Channel, int, time.Duration) { selections++ },
		attempt: func(*model.Channel, int, time.Duration) *types.NewAPIError {
			attempts++
			return nil
		},
		onFailure:   func(_ *model.Channel, err *types.NewAPIError) *types.NewAPIError { return err },
		shouldRetry: func(*types.NewAPIError) bool { return true },
		committed:   func() bool { return false },
	}.run()

	require.NotNil(t, result)
	assert.Equal(t, types.ErrorCodeGetChannelFailed, result.GetErrorCode())
	assert.Zero(t, selections)
	assert.Zero(t, attempts)
}

func TestTextPollingCoordinatorStopsBeforeSelection(t *testing.T) {
	baseTime := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	canceledContext, cancel := context.WithCancel(context.Background())
	cancel()
	tests := []struct {
		name      string
		ctx       context.Context
		deadline  time.Time
		committed bool
		wantError bool
	}{
		{name: "parent context canceled", ctx: canceledContext, deadline: baseTime.Add(maxTextPollingDuration), wantError: true},
		{name: "total deadline exhausted", ctx: context.Background(), deadline: baseTime, wantError: true},
		{name: "downstream already committed", ctx: context.Background(), deadline: baseTime.Add(maxTextPollingDuration), committed: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var selections, attempts int
			result := textPollingCoordinator{
				ctx:      tt.ctx,
				deadline: tt.deadline,
				now:      func() time.Time { return baseTime },
				selectChannel: func(int, map[int]struct{}) (*model.Channel, *types.NewAPIError) {
					selections++
					return nil, nil
				},
				selected: func(*model.Channel, int, time.Duration) {},
				attempt: func(*model.Channel, int, time.Duration) *types.NewAPIError {
					attempts++
					return nil
				},
				onFailure:   func(_ *model.Channel, err *types.NewAPIError) *types.NewAPIError { return err },
				shouldRetry: func(*types.NewAPIError) bool { return true },
				committed:   func() bool { return tt.committed },
			}.run()

			if tt.wantError {
				require.NotNil(t, result)
			} else {
				require.Nil(t, result)
			}
			assert.Zero(t, selections)
			assert.Zero(t, attempts)
		})
	}
}

func TestGetTextPollingChannelReturnsErrorForRepeatedDisabledSelection(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Set("channel_id", 1)

	channel, err := getTextPollingChannel(
		context,
		&relaycommon.RelayInfo{},
		&service.RetryParam{},
		nil,
		0,
		make(map[int]struct{}),
	)

	require.Nil(t, channel)
	require.NotNil(t, err)
	assert.Equal(t, types.ErrorCodeGetChannelFailed, err.GetErrorCode())
}

func TestTextPollingCoordinatorTraversesEnabledChannelsAtEachTier(t *testing.T) {
	baseTime := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	channels := []*model.Channel{{Id: 1}, {Id: 2}}
	channels[0].SetOtherSettings(dto.ChannelOtherSettings{TextPollingEnabled: true, TextPollingTimeoutTier1Seconds: 2, TextPollingTimeoutTier2Seconds: 4, TextPollingTimeoutTier3Seconds: 6})
	channels[1].SetOtherSettings(dto.ChannelOtherSettings{TextPollingEnabled: true, TextPollingTimeoutTier1Seconds: 3, TextPollingTimeoutTier2Seconds: 5, TextPollingTimeoutTier3Seconds: 7})
	retryErr := types.NewError(errors.New("retry"), types.ErrorCodeDoRequestFailed)
	var attempts []struct {
		id      int
		tier    int
		timeout time.Duration
	}

	result := textPollingCoordinator{
		ctx:      context.Background(),
		deadline: baseTime.Add(maxTextPollingDuration),
		now:      func() time.Time { return baseTime },
		selectChannel: func(_ int, excluded map[int]struct{}) (*model.Channel, *types.NewAPIError) {
			for _, channel := range channels {
				if _, found := excluded[channel.Id]; !found {
					return channel, nil
				}
			}
			return nil, nil
		},
		selected: func(*model.Channel, int, time.Duration) {},
		attempt: func(channel *model.Channel, tier int, timeout time.Duration) *types.NewAPIError {
			attempts = append(attempts, struct {
				id      int
				tier    int
				timeout time.Duration
			}{channel.Id, tier, timeout})
			return retryErr
		},
		onFailure:   func(_ *model.Channel, err *types.NewAPIError) *types.NewAPIError { return err },
		shouldRetry: func(*types.NewAPIError) bool { return true },
		committed:   func() bool { return false },
	}.run()

	require.Same(t, retryErr, result)
	assert.Equal(t, []struct {
		id      int
		tier    int
		timeout time.Duration
	}{
		{1, 1, 2 * time.Second}, {2, 1, 3 * time.Second},
		{1, 2, 4 * time.Second}, {2, 2, 5 * time.Second},
		{1, 3, 6 * time.Second}, {2, 3, 7 * time.Second},
	}, attempts)
}

func TestTextPollingRemainingTimeout(t *testing.T) {
	baseTime := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	deadline := baseTime.Add(maxTextPollingDuration)

	remaining, withinBudget := textPollingRemainingTimeout(deadline, baseTime)
	require.True(t, withinBudget)
	assert.Equal(t, maxTextPollingDuration, remaining)

	remaining, withinBudget = textPollingRemainingTimeout(deadline, deadline)
	assert.False(t, withinBudget)
	assert.Zero(t, remaining)
}
