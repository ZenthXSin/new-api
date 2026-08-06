package palm

import (
	"io"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// https://developers.generativeai.google/api/rest/generativelanguage/models/generateMessage#request-body
// https://developers.generativeai.google/api/rest/generativelanguage/models/generateMessage#response-body

func responsePaLM2OpenAI(response *PaLMChatResponse) *dto.OpenAITextResponse {
	fullTextResponse := dto.OpenAITextResponse{
		Choices: make([]dto.OpenAITextResponseChoice, 0, len(response.Candidates)),
	}
	for i, candidate := range response.Candidates {
		choice := dto.OpenAITextResponseChoice{
			Index: i,
			Message: dto.Message{
				Role:    "assistant",
				Content: candidate.Content,
			},
			FinishReason: "stop",
		}
		fullTextResponse.Choices = append(fullTextResponse.Choices, choice)
	}
	return &fullTextResponse
}

func streamResponsePaLM2OpenAI(palmResponse *PaLMChatResponse) *dto.ChatCompletionsStreamResponse {
	var choice dto.ChatCompletionsStreamResponseChoice
	if len(palmResponse.Candidates) > 0 {
		choice.Delta.SetContentString(palmResponse.Candidates[0].Content)
	}
	choice.FinishReason = &constant.FinishReasonStop
	var response dto.ChatCompletionsStreamResponse
	response.Object = "chat.completion.chunk"
	response.Model = "palm2"
	response.Choices = []dto.ChatCompletionsStreamResponseChoice{choice}
	return &response
}

func palmStreamHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*types.NewAPIError, string) {
	responseText := ""
	responseId := helper.GetResponseID(c)
	createdTime := common.GetTimestamp()
	defer service.CloseResponseBodyGracefully(resp)
	if info.TextPollingAttemptTimeout == 0 {
		helper.SetEventStreamHeaders(c)
	}
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		common.SysLog("error reading stream response: " + err.Error())
		return types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusBadGateway), responseText
	}
	var palmResponse PaLMChatResponse
	if err := common.Unmarshal(responseBody, &palmResponse); err != nil {
		common.SysLog("error unmarshalling stream response: " + err.Error())
		return types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusBadGateway), responseText
	}
	fullTextResponse := streamResponsePaLM2OpenAI(&palmResponse)
	fullTextResponse.Id = responseId
	fullTextResponse.Created = createdTime
	if len(palmResponse.Candidates) > 0 {
		responseText = palmResponse.Candidates[0].Content
	}
	jsonResponse, err := common.Marshal(fullTextResponse)
	if err != nil {
		common.SysLog("error marshalling stream response: " + err.Error())
		return types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusBadGateway), responseText
	}
	helper.PreparePollingStreamOutput(c, resp, info)
	c.Render(-1, common.CustomEvent{Data: "data: " + string(jsonResponse)})
	helper.CommitPollingStreamOutput(c, resp, info)
	c.Writer.Flush()
	helper.Done(c)
	c.Writer.Flush()
	return nil, responseText
}

func palmHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}
	service.CloseResponseBodyGracefully(resp)
	var palmResponse PaLMChatResponse
	err = common.Unmarshal(responseBody, &palmResponse)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
	}
	if palmResponse.Error.Code != 0 || len(palmResponse.Candidates) == 0 {
		return nil, types.WithOpenAIError(types.OpenAIError{
			Message: palmResponse.Error.Message,
			Type:    palmResponse.Error.Status,
			Param:   "",
			Code:    palmResponse.Error.Code,
		}, resp.StatusCode)
	}
	fullTextResponse := responsePaLM2OpenAI(&palmResponse)
	usage := service.ResponseText2Usage(c, palmResponse.Candidates[0].Content, info.UpstreamModelName, info.GetEstimatePromptTokens())
	fullTextResponse.Usage = *usage
	jsonResponse, err := common.Marshal(fullTextResponse)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeBadResponseBody)
	}
	c.Writer.Header().Set("Content-Type", "application/json")
	c.Writer.WriteHeader(resp.StatusCode)
	service.IOCopyBytesGracefully(c, resp, jsonResponse)
	return usage, nil
}
