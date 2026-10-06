package relay

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPlaygroundSearchRoutingIsOptIn(t *testing.T) {
	for _, apiType := range []int{constant.APITypeOpenAI, constant.APITypeCodex, constant.APITypeSub2API, constant.APITypeNewAPI, constant.APITypeAnthropic, constant.APITypeGemini, constant.APITypeDeepSeek} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ApiType: apiType}}
		request := &dto.GeneralOpenAIRequest{Model: "fixture", WebSearchOptions: &dto.WebSearchOptions{SearchContextSize: "medium"}}
		force, err := playgroundSearchViaResponses(c, info, request, false)
		require.Nil(t, err)
		assert.False(t, force, "ordinary clients keep existing policy")
		c.Set(string(constant.ContextKeyPlaygroundRequest), true)
		force, err = playgroundSearchViaResponses(c, info, request, false)
		switch apiType {
		case constant.APITypeAnthropic, constant.APITypeGemini:
			require.Nil(t, err)
			assert.False(t, force)
		case constant.APITypeDeepSeek:
			require.NotNil(t, err)
			assert.Equal(t, 400, err.StatusCode)
			assert.True(t, types.IsSkipRetryError(err))
		default:
			require.Nil(t, err)
			assert.True(t, force)
		}
		_, err = playgroundSearchViaResponses(c, info, request, true)
		require.NotNil(t, err, "passthrough cannot silently bypass native tool conversion")
	}
}

func TestPlaygroundSearchWireBodyRejectsRemovedOrDisabledTool(t *testing.T) {
	assert.True(t, playgroundSearchPresent([]byte(`{"tools":[{"type":"web_search"}]}`), constant.APITypeOpenAI, true))
	assert.False(t, playgroundSearchPresent([]byte(`{"tools":[]}`), constant.APITypeOpenAI, true))
	assert.False(t, playgroundSearchPresent([]byte(`{"tools":[{"type":"web_search"}],"tool_choice":"none"}`), constant.APITypeOpenAI, true))
	assert.True(t, playgroundSearchPresent([]byte(`{"tools":[{"type":"web_search_20250305","name":"web_search"}]}`), constant.APITypeAnthropic, false))
	assert.True(t, playgroundSearchPresent([]byte(`{"tools":[{"googleSearch":{}}]}`), constant.APITypeGemini, false))
	assert.True(t, playgroundSearchPresent([]byte(`{"web_search_options":{}}`), constant.APITypeOpenAI, false))
}
