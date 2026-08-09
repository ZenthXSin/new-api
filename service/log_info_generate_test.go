/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package service

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGenerateWssOtherInfoOmitsUninstrumentedTiming(t *testing.T) {
	ctx, _ := gin.CreateTestContext(nil)
	start := time.Unix(100, 0)
	relayInfo := &relaycommon.RelayInfo{
		Timing:            common.NewRelayTiming(start),
		StartTime:         start,
		FirstResponseTime: start.Add(time.Second),
		ChannelMeta:       &relaycommon.ChannelMeta{},
	}
	other := GenerateWssOtherInfo(ctx, relayInfo, &dto.RealtimeUsage{}, 0, 0, 0, 0, 0, 0, 0)
	assert.NotContains(t, other, "timing")
	assert.Equal(t, float64(1000), other["frt"])
}

func TestGenerateTextOtherInfoPollingTier(t *testing.T) {
	cases := []struct {
		name string
		tier int
	}{
		{name: "tier 1", tier: 1},
		{name: "tier 2", tier: 2},
		{name: "tier 3", tier: 3},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(nil)
			relayInfo := &relaycommon.RelayInfo{
				ChannelMeta:     &relaycommon.ChannelMeta{},
				TextPollingTier: tt.tier,
			}

			other := GenerateTextOtherInfo(ctx, relayInfo, 0, 0, 0, 0, 0, 0, 0)
			adminInfo, ok := other["admin_info"].(map[string]interface{})
			require.True(t, ok)
			assert.Equal(t, tt.tier, other["text_polling_tier"])
			assert.NotContains(t, other, "text_polling_fallback")
			assert.NotContains(t, adminInfo, "text_polling_tier")
			assert.NotContains(t, adminInfo, "text_polling_fallback")
		})
	}
}

func TestGenerateTextOtherInfoPollingFallback(t *testing.T) {
	ctx, _ := gin.CreateTestContext(nil)
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta:               &relaycommon.ChannelMeta{},
		TextPollingAttemptTimeout: time.Second,
	}

	other := GenerateTextOtherInfo(ctx, relayInfo, 0, 0, 0, 0, 0, 0, 0)
	adminInfo, ok := other["admin_info"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, true, other["text_polling_fallback"])
	assert.NotContains(t, other, "text_polling_tier")
	assert.NotContains(t, adminInfo, "text_polling_tier")
	assert.NotContains(t, adminInfo, "text_polling_fallback")
}

func TestGenerateTextOtherInfoPollingMetadataAbsentForNonPolling(t *testing.T) {
	ctx, _ := gin.CreateTestContext(nil)
	relayInfo := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{},
	}

	other := GenerateTextOtherInfo(ctx, relayInfo, 0, 0, 0, 0, 0, 0, 0)
	adminInfo, ok := other["admin_info"].(map[string]interface{})
	require.True(t, ok)
	assert.NotContains(t, other, "text_polling_tier")
	assert.NotContains(t, other, "text_polling_fallback")
	assert.NotContains(t, adminInfo, "text_polling_tier")
	assert.NotContains(t, adminInfo, "text_polling_fallback")
}
