package controller

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIntelligenceCheckSendsFixedQuestionThroughChannelWithoutOverrides(t *testing.T) {
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.Log{}))
	previousCache := common.MemoryCacheEnabled
	common.MemoryCacheEnabled = false
	t.Cleanup(func() { common.MemoryCacheEnabled = previousCache })
	previousRatios := ratio_setting.ModelRatio2JSONString()
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"gpt-4o-mini":0.075}`))
	t.Cleanup(func() { require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(previousRatios)) })
	user := &model.User{Username: "intelligence-probe-fixture", Group: "default", Status: common.UserStatusEnabled, Quota: 1_000_000}
	require.NoError(t, db.Create(user).Error)
	requests := make(chan dto.GeneralOpenAIRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request dto.GeneralOpenAIRequest
		if err := common.DecodeJson(r.Body, &request); err != nil {
			http.Error(w, "invalid fixture payload", http.StatusBadRequest)
			return
		}
		requests <- request
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"id":"probe_fixture","object":"chat.completion","model":"gpt-4o-mini","choices":[{"index":0,"message":{"role":"assistant","content":"不降智"},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":3,"total_tokens":33}}`)
	}))
	defer upstream.Close()
	channel := &model.Channel{Name: "Fixed question upstream", Type: constant.ChannelTypeOpenAI, Key: "fixture-key", BaseURL: common.GetPointer(upstream.URL), Models: "gpt-4o-mini", Group: "default", Status: common.ChannelStatusEnabled, Setting: common.GetPointer(`{"system_prompt":"injected history","system_prompt_override":true}`), ParamOverride: common.GetPointer(`{"messages":[{"role":"user","content":"overridden prompt"}],"tools":[{"type":"web_search"}]}`)}
	require.NoError(t, db.Create(channel).Error)
	result := testChannelIntelligence(context.Background(), channel, user.Id, "", "", false, false)
	require.NoError(t, result.localErr)
	require.Nil(t, result.newAPIError)
	require.NotNil(t, result.intelligenceCheck)
	assert.Equal(t, "passed", result.intelligenceCheck.Status)
	select {
	case request := <-requests:
		require.Len(t, request.Messages, 1)
		assert.Equal(t, "user", request.Messages[0].Role)
		assert.Equal(t, ChannelIntelligenceCheckPrompt, request.Messages[0].StringContent())
		assert.Empty(t, request.Tools)
	default:
		t.Fatal("diagnostic did not reach the upstream")
	}
}

func TestIntelligenceCheckClassifiesOnlyExplicitAssistantAnswers(t *testing.T) {
	tests := []struct{ name, body, status string }{
		{"chat pass is not a degraded substring", `{"choices":[{"message":{"content":"不降智"}}]}`, "passed"},
		{"chat degraded", `{"choices":[{"message":{"content":"降智"}}]}`, "degraded"},
		{"quoted answer", `{"choices":[{"message":{"content":"\"降智\""}}]}`, "degraded"},
		{"explanation is not a verdict", `{"choices":[{"message":{"content":"降智和不降智无法判断"}}]}`, "inconclusive"},
		{"empty response", `{}`, "inconclusive"},
		{"reasoning is excluded", `{"output":[{"type":"reasoning","summary":[{"text":"降智"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"不降智"}]}]}`, "passed"},
		{"nullable responses error is not a failure", `{"status":"completed","error":null,"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"不降智"}]}]}`, "passed"},
		{"claude thinking is excluded", `{"content":[{"type":"thinking","thinking":"降智"},{"type":"text","text":"不降智"}]}`, "passed"},
		{"gemini thoughts are excluded", `{"candidates":[{"content":{"parts":[{"thought":true,"text":"降智"},{"text":"不降智"}]}}]}`, "passed"},
		{"chat stream", "data: {\"choices\":[{\"delta\":{\"content\":\"不降\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"智\"}}]}\n\ndata: [DONE]\n", "passed"},
		{"responses stream", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"降智\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"降智\"}]}]}}\n", "degraded"},
		{"interrupted stream cannot disable", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"降智\"}\n", "inconclusive"},
		{"failed stream cannot disable", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"降智\"}\n\ndata: {\"type\":\"response.failed\"}\n", "inconclusive"},
		{"incomplete response cannot disable", `{"status":"incomplete","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"降智"}]}]}`, "inconclusive"},
		{"chat token limit cannot disable", `{"choices":[{"message":{"content":"降智"},"finish_reason":"length"}]}`, "inconclusive"},
		{"claude token limit cannot disable", `{"stop_reason":"max_tokens","content":[{"type":"text","text":"降智"}]}`, "inconclusive"},
		{"gemini blocked reply cannot disable", `{"candidates":[{"content":{"parts":[{"text":"降智"}]},"finishReason":"SAFETY"}]}`, "inconclusive"},
		{"malformed payload cannot disable", `{"choices":[{"message":{"content":"降智"}}`, "inconclusive"},
		{"malformed stream cannot disable", "data: {\"choices\":[{\"delta\":{\"content\":\"降智\"}}\n\ndata: [DONE]\n", "inconclusive"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, _ := classifyChannelIntelligence([]byte(test.body))
			assert.Equal(t, test.status, status)
		})
	}
}

func TestIntelligenceCheckSchedulingDoesNotRequireGlobalAvailabilityTests(t *testing.T) {
	db := setupModelListControllerTestDB(t)
	monitor := operation_setting.GetMonitorSetting()
	previous := monitor.AutoTestChannelEnabled
	monitor.AutoTestChannelEnabled = false
	t.Cleanup(func() { monitor.AutoTestChannelEnabled = previous })
	handler := channelTestHandler{}
	assert.False(t, handler.Enabled())
	channel := &model.Channel{Name: "Scheduled intelligence fixture", Key: "test-key", Models: "gpt-4o-mini", Group: "default", Status: common.ChannelStatusManuallyDisabled, OtherSettings: `{"intelligence_check_enabled":true}`}
	require.NoError(t, db.Create(channel).Error)
	assert.False(t, handler.Enabled(), "manually disabled channels are not probed")
	require.NoError(t, db.Model(channel).Update("status", common.ChannelStatusEnabled).Error)
	assert.True(t, handler.Enabled(), "channel opt-in enables its scheduled probe")
	require.NoError(t, db.Model(channel).Update("settings", `{"intelligence_check_enabled":false}`).Error)
	assert.False(t, handler.Enabled(), "turning off the last probe stops probe-only scheduling")
}

func TestIntelligenceCheckRequestsContainOnlyFixedQuestion(t *testing.T) {
	for _, endpoint := range []constant.EndpointType{constant.EndpointTypeOpenAI, constant.EndpointTypeOpenAIResponse, constant.EndpointTypeAnthropic, constant.EndpointTypeGemini} {
		t.Run(string(endpoint), func(t *testing.T) {
			request, err := buildIntelligenceCheckRequest(buildTestRequest("gpt-4o-mini", string(endpoint), &model.Channel{}, false))
			require.NoError(t, err)
			payload, err := common.Marshal(request)
			require.NoError(t, err)
			assert.Contains(t, string(payload), "Thibault Sottiaux")
			assert.Contains(t, string(payload), "不搜索互联网，不读取上下文，不调用插件")
			assert.NotContains(t, string(payload), `"tools"`)
			assert.NotContains(t, string(payload), `"previous_response_id"`)
			assert.NotContains(t, string(payload), `"hi"`)
		})
	}
	_, err := buildIntelligenceCheckRequest(buildTestRequest("text-embedding-3-small", string(constant.EndpointTypeEmbeddings), &model.Channel{}, false))
	require.Error(t, err)
}

func TestIntelligenceCheckDisableRequiresOptInAndExplicitAnswer(t *testing.T) {
	tests := []struct {
		name                               string
		enabled, autoDisable, allowDisable bool
		answer                             string
		requestError                       bool
		wantStatus                         int
		wantCheck                          string
	}{
		{"record only by default", true, false, true, "降智", false, common.ChannelStatusEnabled, "degraded"},
		{"explicit opt in disables", true, true, true, "降智", false, common.ChannelStatusAutoDisabled, "degraded"},
		{"healthy never disables", true, true, true, "不降智", false, common.ChannelStatusEnabled, "passed"},
		{"unexpected reply never disables", true, true, true, "不知道", false, common.ChannelStatusEnabled, "inconclusive"},
		{"request failure never disables", true, true, true, "降智", true, common.ChannelStatusEnabled, "error"},
		{"disabled detection cannot disable", false, true, true, "降智", false, common.ChannelStatusEnabled, "degraded"},
		{"passive recovery cannot disable", true, true, false, "降智", false, common.ChannelStatusEnabled, "degraded"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := setupModelListControllerTestDB(t)
			previousCache, previousAutoDisable := common.MemoryCacheEnabled, common.AutomaticDisableChannelEnabled
			common.MemoryCacheEnabled, common.AutomaticDisableChannelEnabled = false, false
			t.Cleanup(func() {
				common.MemoryCacheEnabled, common.AutomaticDisableChannelEnabled = previousCache, previousAutoDisable
			})
			settings, err := common.Marshal(map[string]bool{"intelligence_check_enabled": test.enabled, "intelligence_check_auto_disable": test.autoDisable})
			require.NoError(t, err)
			channel := &model.Channel{Name: "Intelligence fixture", Key: "test-key", Models: "gpt-4o-mini", Group: "default", Status: common.ChannelStatusEnabled, AutoBan: common.GetPointer(0), OtherSettings: string(settings)}
			require.NoError(t, db.Create(channel).Error)
			body, err := common.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": test.answer}}}})
			require.NoError(t, err)
			result := testResult{responseBody: body, modelName: "gpt-4o-mini"}
			if test.requestError {
				result.localErr = errors.New("upstream timeout")
			}
			require.NoError(t, recordChannelIntelligenceCheck(channel, &result, test.allowDisable))
			stored, err := model.GetChannelById(channel.Id, true)
			require.NoError(t, err)
			assert.Equal(t, test.wantStatus, stored.Status)
			assert.Equal(t, test.wantCheck, result.intelligenceCheck.Status)
			assert.NotEmpty(t, stored.IntelligenceCheck)
			assert.Equal(t, test.wantStatus == common.ChannelStatusAutoDisabled, result.intelligenceCheck.AutoDisabled)
		})
	}
}
