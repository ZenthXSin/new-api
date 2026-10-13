package controller

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/tidwall/gjson"
)

const ChannelIntelligenceCheckPrompt = `不搜索互联网，不读取上下文，不调用插件。你能识别X上的Thibault Sottiaux是谁吗?如果能，只回答“不降智”;如果不能，只回答"降智”。`

func buildIntelligenceCheckRequest(request dto.Request) (dto.Request, error) {
	const maxOutputTokens = uint(4096)
	switch req := request.(type) {
	case *dto.GeneralOpenAIRequest:
		req.Messages = []dto.Message{{Role: "user", Content: ChannelIntelligenceCheckPrompt}}
		if req.MaxCompletionTokens != nil {
			req.MaxCompletionTokens = common.GetPointer(maxOutputTokens)
		} else {
			req.MaxTokens = common.GetPointer(maxOutputTokens)
		}
	case *dto.OpenAIResponsesRequest:
		input, err := common.Marshal([]dto.Message{{Role: "user", Content: ChannelIntelligenceCheckPrompt}})
		if err != nil {
			return nil, err
		}
		req.Input = input
		req.MaxOutputTokens = common.GetPointer(maxOutputTokens)
	case *dto.ClaudeRequest:
		req.Messages = []dto.ClaudeMessage{{Role: "user", Content: ChannelIntelligenceCheckPrompt}}
		req.MaxTokens = common.GetPointer(maxOutputTokens)
	case *dto.GeminiChatRequest:
		req.Contents = []dto.GeminiChatContent{{Role: "user", Parts: []dto.GeminiPart{{Text: ChannelIntelligenceCheckPrompt}}}}
		req.GenerationConfig.MaxOutputTokens = common.GetPointer(maxOutputTokens)
	default:
		return nil, errors.New("降智检测仅支持文本对话接口，请配置文本测试模型")
	}
	return request, nil
}

func intelligenceResponseText(payload gjson.Result) string {
	var text strings.Builder
	if content := payload.Get("choices.0.message.content"); content.Type == gjson.String {
		return content.String()
	} else if content.IsArray() {
		for _, part := range content.Array() {
			if part.Get("type").String() == "text" {
				text.WriteString(part.Get("text").String())
			}
		}
		return text.String()
	}
	for _, message := range payload.Get("output").Array() {
		if message.Get("type").String() != "message" || message.Get("role").String() != "assistant" {
			continue
		}
		for _, part := range message.Get("content").Array() {
			if part.Get("type").String() == "output_text" {
				text.WriteString(part.Get("text").String())
			}
		}
	}
	for _, part := range payload.Get("content").Array() {
		if part.Get("type").String() == "text" {
			text.WriteString(part.Get("text").String())
		}
	}
	for _, part := range payload.Get("candidates.0.content.parts").Array() {
		if !part.Get("thought").Bool() {
			text.WriteString(part.Get("text").String())
		}
	}
	return text.String()
}

func classifyChannelIntelligence(body []byte) (string, string) {
	var payload gjson.Result
	if gjson.ValidBytes(body) {
		payload = gjson.ParseBytes(body)
	}
	upstreamError := payload.Get("error")
	if status := payload.Get("status").String(); (status != "" && status != "completed") || (upstreamError.Exists() && upstreamError.Type != gjson.Null) {
		return "inconclusive", ""
	}
	if finish := payload.Get("choices.0.finish_reason").String(); finish != "" && finish != "stop" {
		return "inconclusive", ""
	}
	if payload.Get("stop_reason").String() == "max_tokens" {
		return "inconclusive", ""
	}
	if finish := payload.Get("candidates.0.finishReason").String(); finish != "" && finish != "STOP" {
		return "inconclusive", ""
	}
	response := intelligenceResponseText(payload)
	if response == "" {
		var streamed strings.Builder
		completed := false
		for _, line := range strings.Split(string(body), "\n") {
			if !strings.HasPrefix(strings.TrimSpace(line), "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "data:"))
			if data == "[DONE]" {
				completed = true
				continue
			}
			if !gjson.Valid(data) {
				return "inconclusive", streamed.String()
			}
			payload := gjson.Parse(data)
			upstreamError := payload.Get("error")
			if upstreamError.Exists() && upstreamError.Type != gjson.Null {
				return "inconclusive", ""
			}
			if payload.Get("choices.0.finish_reason").String() == "length" || payload.Get("delta.stop_reason").String() == "max_tokens" || payload.Get("candidates.0.finishReason").String() == "MAX_TOKENS" {
				return "inconclusive", streamed.String()
			}
			switch payload.Get("type").String() {
			case "response.failed", "response.incomplete", "error":
				return "inconclusive", ""
			case "response.completed":
				if status := payload.Get("response.status").String(); status != "" && status != "completed" {
					return "inconclusive", streamed.String()
				}
				if err := payload.Get("response.error"); err.Exists() && err.Type != gjson.Null {
					return "inconclusive", streamed.String()
				}
				completed = true
				if final := intelligenceResponseText(payload.Get("response")); final != "" {
					response = final
				}
			case "response.output_text.delta":
				streamed.WriteString(payload.Get("delta").String())
			case "content_block_delta":
				if payload.Get("delta.type").String() == "text_delta" {
					streamed.WriteString(payload.Get("delta.text").String())
				}
			case "message_stop":
				completed = true
			default:
				if payload.Get("choices.0.finish_reason").String() == "stop" || payload.Get("candidates.0.finishReason").String() == "STOP" {
					completed = true
				}
				streamed.WriteString(payload.Get("choices.0.delta.content").String())
				streamed.WriteString(intelligenceResponseText(payload))
			}
		}
		if !completed {
			return "inconclusive", streamed.String()
		}
		if response == "" {
			response = streamed.String()
		}
	}
	answer := strings.TrimSpace(strings.Trim(strings.TrimSpace(response), "\"'“”‘’「」"))
	switch answer {
	case "不降智":
		return "passed", response
	case "降智":
		return "degraded", response
	default:
		return "inconclusive", response
	}
}

func recordChannelIntelligenceCheck(channel *model.Channel, result *testResult, allowDisable bool) error {
	check := model.ChannelIntelligenceCheck{Model: result.modelName, CheckedAt: time.Now().Unix(), Status: "error"}
	if result.localErr == nil && result.newAPIError == nil {
		check.Status, check.Response = classifyChannelIntelligence(result.responseBody)
	}
	if check.Model == "" && channel.TestModel != nil {
		check.Model = *channel.TestModel
	}
	response := []rune(check.Response)
	if len(response) > 1024 {
		check.Response = string(response[:1024])
	}
	if allowDisable && check.Status == "degraded" {
		current, err := model.GetChannelById(channel.Id, true)
		if err != nil {
			return err
		}
		settings := current.GetOtherSettings()
		if current.Status == common.ChannelStatusEnabled && current.OtherSettings == channel.OtherSettings &&
			settings.IntelligenceCheckEnabled && settings.IntelligenceCheckAutoDisable {
			usingKey := ""
			if result.context != nil {
				usingKey = common.GetContextKeyString(result.context, constant.ContextKeyChannelKey)
			}
			check.AutoDisabled = model.UpdateChannelStatus(channel.Id, usingKey, common.ChannelStatusAutoDisabled, "降智检测：模型明确回答降智")
			if check.AutoDisabled {
				service.NotifyRootUser(dto.NotifyTypeChannelUpdate, "渠道降智检测触发自动停用", "渠道「"+channel.Name+"」的模型明确回答“降智”，已自动停用该渠道或本次使用的密钥。")
			}
		}
	}
	result.intelligenceCheck = &check
	return model.SaveChannelIntelligenceCheck(channel.Id, check)
}

func testChannelIntelligence(ctx context.Context, channel *model.Channel, testUserID int, testModel, endpoint string, stream, allowDisable bool) testResult {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result := testChannel(ctx, channel, testUserID, testModel, endpoint, stream || shouldUseStreamForAutomaticChannelTest(channel), true)
	if err := recordChannelIntelligenceCheck(channel, &result, allowDisable); err != nil {
		result.localErr = err
	}
	return result
}

func checkChannelIntelligenceHealth(ctx context.Context, channel *model.Channel, testUserID int, allowDisable bool) channelTestSummary {
	started := time.Now()
	result := testChannelIntelligence(ctx, channel, testUserID, "", "", shouldUseStreamForAutomaticChannelTest(channel), allowDisable)
	if ctx.Err() != nil {
		return channelTestSummary{}
	}
	summary := channelTestSummary{Tested: 1}
	check := result.intelligenceCheck
	if result.localErr != nil || check == nil || check.Status != "passed" {
		summary.Failed = 1
	} else {
		summary.Succeeded = 1
		if service.ShouldEnableChannel(nil, channel.Status) {
			service.EnableChannel(channel.Id, common.GetContextKeyString(result.context, constant.ContextKeyChannelKey), channel.Name)
			summary.Enabled = 1
		}
	}
	if check != nil && check.AutoDisabled {
		summary.Disabled = 1
	}
	channel.UpdateResponseTime(time.Since(started).Milliseconds())
	return summary
}
