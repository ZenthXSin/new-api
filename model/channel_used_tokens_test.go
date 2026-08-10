package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func insertChannelForTokenLimitTest(t *testing.T, id int, maxTokens *int64) *Channel {
	t.Helper()
	channel := &Channel{
		Id:        id,
		Type:      1,
		Key:       "token-limit-key",
		Name:      "token-limit",
		Status:    common.ChannelStatusEnabled,
		MaxTokens: maxTokens,
	}
	require.NoError(t, DB.Create(channel).Error)
	return channel
}

func getChannelForTokenLimitTest(t *testing.T, id int) *Channel {
	t.Helper()
	var channel Channel
	require.NoError(t, DB.First(&channel, "id = ?", id).Error)
	return &channel
}

// 累计消费 token,未设置上限时渠道保持启用。
func TestUpdateChannelUsedTokensAccumulatesWithoutLimit(t *testing.T) {
	truncateTables(t)
	insertChannelForTokenLimitTest(t, 701, nil)

	UpdateChannelUsedTokens(701, 123)
	UpdateChannelUsedTokens(701, 456)

	channel := getChannelForTokenLimitTest(t, 701)
	assert.Equal(t, int64(579), channel.UsedTokens)
	assert.Equal(t, common.ChannelStatusEnabled, channel.Status)
}

// max_tokens = 0 表示不限制,即使消费量再大也不禁用。
func TestUpdateChannelUsedTokensZeroLimitNeverDisables(t *testing.T) {
	truncateTables(t)
	zero := int64(0)
	insertChannelForTokenLimitTest(t, 702, &zero)

	UpdateChannelUsedTokens(702, 99999999)

	channel := getChannelForTokenLimitTest(t, 702)
	assert.Equal(t, common.ChannelStatusEnabled, channel.Status)
}

// 累计 token 达到上限(单位 M)后渠道自动禁用,并记录禁用原因。
func TestUpdateChannelUsedTokensDisablesAtLimit(t *testing.T) {
	truncateTables(t)
	maxTokens := int64(1) // 1M tokens
	insertChannelForTokenLimitTest(t, 703, &maxTokens)

	UpdateChannelUsedTokens(703, 999999)
	assert.Equal(t, common.ChannelStatusEnabled, getChannelForTokenLimitTest(t, 703).Status)

	UpdateChannelUsedTokens(703, 1)

	channel := getChannelForTokenLimitTest(t, 703)
	assert.Equal(t, int64(1000000), channel.UsedTokens)
	assert.Equal(t, common.ChannelStatusAutoDisabled, channel.Status)
	assert.Contains(t, channel.GetOtherInfo()["status_reason"], "Token usage")
}

// 渠道已因 token 上限禁用后,再次累加不会重复触发禁用(幂等)。
func TestUpdateChannelUsedTokensDisableIsIdempotent(t *testing.T) {
	truncateTables(t)
	maxTokens := int64(1)
	insertChannelForTokenLimitTest(t, 704, &maxTokens)

	UpdateChannelUsedTokens(704, 1000000)
	UpdateChannelUsedTokens(704, 500000)

	channel := getChannelForTokenLimitTest(t, 704)
	assert.Equal(t, int64(1500000), channel.UsedTokens)
	assert.Equal(t, common.ChannelStatusAutoDisabled, channel.Status)
}

// 非正 token 增量是无效调用,直接忽略。
func TestUpdateChannelUsedTokensIgnoresNonPositiveDelta(t *testing.T) {
	truncateTables(t)
	insertChannelForTokenLimitTest(t, 705, nil)

	UpdateChannelUsedTokens(705, 0)
	UpdateChannelUsedTokens(705, -1)

	assert.Zero(t, getChannelForTokenLimitTest(t, 705).UsedTokens)
}

// 多个大额消费同时逼近上限时,条件更新保证渠道只被禁用一次且状态一致。
func TestUpdateChannelUsedTokensConcurrentExceedLimit(t *testing.T) {
	truncateTables(t)
	maxTokens := int64(1)
	insertChannelForTokenLimitTest(t, 706, &maxTokens)

	done := make(chan struct{})
	for i := 0; i < 4; i++ {
		go func() {
			UpdateChannelUsedTokens(706, 300000)
			done <- struct{}{}
		}()
	}
	for i := 0; i < 4; i++ {
		<-done
	}

	channel := getChannelForTokenLimitTest(t, 706)
	assert.Equal(t, int64(1200000), channel.UsedTokens)
	assert.Equal(t, common.ChannelStatusAutoDisabled, channel.Status)
}
