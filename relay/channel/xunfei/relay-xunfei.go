package xunfei

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/samber/lo"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// https://console.xfyun.cn/services/cbm
// https://www.xfyun.cn/doc/spark/Web.html

func requestOpenAI2Xunfei(request dto.GeneralOpenAIRequest, xunfeiAppId string, domain string) *XunfeiChatRequest {
	messages := make([]XunfeiMessage, 0, len(request.Messages))
	shouldCovertSystemMessage := !strings.HasSuffix(request.Model, "3.5")
	for _, message := range request.Messages {
		if message.Role == "system" && shouldCovertSystemMessage {
			messages = append(messages, XunfeiMessage{
				Role:    "user",
				Content: message.StringContent(),
			})
			messages = append(messages, XunfeiMessage{
				Role:    "assistant",
				Content: "Okay",
			})
		} else {
			messages = append(messages, XunfeiMessage{
				Role:    message.Role,
				Content: message.StringContent(),
			})
		}
	}
	xunfeiRequest := XunfeiChatRequest{}
	xunfeiRequest.Header.AppId = xunfeiAppId
	xunfeiRequest.Parameter.Chat.Domain = domain
	xunfeiRequest.Parameter.Chat.Temperature = request.Temperature
	xunfeiRequest.Parameter.Chat.TopK = lo.FromPtrOr(request.N, 0)
	xunfeiRequest.Parameter.Chat.MaxTokens = request.GetMaxTokens()
	xunfeiRequest.Payload.Message.Text = messages
	return &xunfeiRequest
}

func responseXunfei2OpenAI(response *XunfeiChatResponse) *dto.OpenAITextResponse {
	if len(response.Payload.Choices.Text) == 0 {
		response.Payload.Choices.Text = []XunfeiChatResponseTextItem{
			{
				Content: "",
			},
		}
	}
	choice := dto.OpenAITextResponseChoice{
		Index: 0,
		Message: dto.Message{
			Role:    "assistant",
			Content: response.Payload.Choices.Text[0].Content,
		},
		FinishReason: constant.FinishReasonStop,
	}
	fullTextResponse := dto.OpenAITextResponse{
		Object:  "chat.completion",
		Created: common.GetTimestamp(),
		Choices: []dto.OpenAITextResponseChoice{choice},
		Usage:   response.Payload.Usage.Text,
	}
	return &fullTextResponse
}

func streamResponseXunfei2OpenAI(xunfeiResponse *XunfeiChatResponse) *dto.ChatCompletionsStreamResponse {
	if len(xunfeiResponse.Payload.Choices.Text) == 0 {
		xunfeiResponse.Payload.Choices.Text = []XunfeiChatResponseTextItem{
			{
				Content: "",
			},
		}
	}
	var choice dto.ChatCompletionsStreamResponseChoice
	choice.Delta.SetContentString(xunfeiResponse.Payload.Choices.Text[0].Content)
	if xunfeiResponse.Payload.Choices.Status == 2 {
		choice.FinishReason = &constant.FinishReasonStop
	}
	response := dto.ChatCompletionsStreamResponse{
		Object:  "chat.completion.chunk",
		Created: common.GetTimestamp(),
		Model:   "SparkDesk",
		Choices: []dto.ChatCompletionsStreamResponseChoice{choice},
	}
	return &response
}

func buildXunfeiAuthUrl(hostUrl string, apiKey, apiSecret string) string {
	HmacWithShaToBase64 := func(algorithm, data, key string) string {
		mac := hmac.New(sha256.New, []byte(key))
		mac.Write([]byte(data))
		encodeData := mac.Sum(nil)
		return base64.StdEncoding.EncodeToString(encodeData)
	}
	ul, err := url.Parse(hostUrl)
	if err != nil {
		fmt.Println(err)
	}
	date := time.Now().UTC().Format(time.RFC1123)
	signString := []string{"host: " + ul.Host, "date: " + date, "GET " + ul.Path + " HTTP/1.1"}
	sign := strings.Join(signString, "\n")
	sha := HmacWithShaToBase64("hmac-sha256", sign, apiSecret)
	authUrl := fmt.Sprintf("hmac username=\"%s\", algorithm=\"%s\", headers=\"%s\", signature=\"%s\"", apiKey,
		"hmac-sha256", "host date request-line", sha)
	authorization := base64.StdEncoding.EncodeToString([]byte(authUrl))
	v := url.Values{}
	v.Add("host", ul.Host)
	v.Add("date", date)
	v.Add("authorization", authorization)
	callUrl := hostUrl + "?" + v.Encode()
	return callUrl
}

func xunfeiStreamHandler(c *gin.Context, info *relaycommon.RelayInfo, textRequest dto.GeneralOpenAIRequest, appId string, apiSecret string, apiKey string) (*dto.Usage, *types.NewAPIError) {
	domain, authUrl := getXunfeiAuthUrl(c, apiKey, apiSecret, textRequest.Model)
	attempt := helper.NewTextPollingAttempt(c.Request.Context(), info.TextPollingAttemptTimeout)
	defer attempt.Close()
	dataChan, stopChan, err := xunfeiMakeRequest(attempt.Context(), textRequest, domain, authUrl, appId)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeDoRequestFailed)
	}
	if info.TextPollingAttemptTimeout == 0 {
		helper.SetEventStreamHeaders(c)
	}
	return handleXunfeiStream(c, info, attempt, dataChan, stopChan)
}

func handleXunfeiStream(c *gin.Context, info *relaycommon.RelayInfo, attempt *helper.TextPollingAttempt, dataChan <-chan XunfeiChatResponse, stopChan <-chan error) (*dto.Usage, *types.NewAPIError) {
	var usage dto.Usage
	for {
		select {
		case xunfeiResponse, ok := <-dataChan:
			if !ok {
				if info.TextPollingAttemptTimeout > 0 && !c.Writer.Written() {
					return nil, types.NewError(io.ErrUnexpectedEOF, types.ErrorCodeReadResponseBodyFailed)
				}
				helper.Done(c)
				c.Writer.Flush()
				return &usage, nil
			}
			response := streamResponseXunfei2OpenAI(&xunfeiResponse)
			jsonResponse, err := common.Marshal(response)
			if err != nil {
				common.SysLog("error marshalling stream response: " + err.Error())
				if readErr := helper.PollingStreamReadError(c, info, err); readErr != nil {
					return nil, types.NewError(readErr, types.ErrorCodeBadResponseBody)
				}
				continue
			}
			usage.PromptTokens += xunfeiResponse.Payload.Usage.Text.PromptTokens
			usage.CompletionTokens += xunfeiResponse.Payload.Usage.Text.CompletionTokens
			usage.TotalTokens += xunfeiResponse.Payload.Usage.Text.TotalTokens
			helper.PreparePollingStreamOutput(c, nil, info)
			c.Render(-1, common.CustomEvent{Data: "data: " + string(jsonResponse)})
			if helper.CommitPollingStreamOutput(c, nil, info) {
				attempt.StopTimeout()
			}
			c.Writer.Flush()
		case streamErr := <-stopChan:
			if streamErr != nil {
				if readErr := helper.PollingStreamReadError(c, info, streamErr); readErr != nil {
					return nil, types.NewError(readErr, types.ErrorCodeReadResponseBodyFailed)
				}
			}
			if info.TextPollingAttemptTimeout > 0 && !c.Writer.Written() {
				return nil, types.NewError(io.ErrUnexpectedEOF, types.ErrorCodeReadResponseBodyFailed)
			}
			helper.Done(c)
			c.Writer.Flush()
			return &usage, nil
		case <-attempt.Context().Done():
			if c.Writer.Written() {
				return &usage, nil
			}
			return nil, types.NewError(attempt.Context().Err(), types.ErrorCodeDoRequestFailed)
		}
	}
}

func xunfeiHandler(c *gin.Context, info *relaycommon.RelayInfo, textRequest dto.GeneralOpenAIRequest, appId string, apiSecret string, apiKey string) (*dto.Usage, *types.NewAPIError) {
	domain, authUrl := getXunfeiAuthUrl(c, apiKey, apiSecret, textRequest.Model)
	attempt := helper.NewTextPollingAttempt(c.Request.Context(), info.TextPollingAttemptTimeout)
	defer attempt.Close()
	dataChan, stopChan, err := xunfeiMakeRequest(attempt.Context(), textRequest, domain, authUrl, appId)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeDoRequestFailed)
	}
	var usage dto.Usage
	var content string
	var xunfeiResponse XunfeiChatResponse
	var ok bool
	stop := false
	for !stop {
		select {
		case xunfeiResponse, ok = <-dataChan:
			if !ok {
				return nil, types.NewError(io.ErrUnexpectedEOF, types.ErrorCodeDoRequestFailed)
			}
			if len(xunfeiResponse.Payload.Choices.Text) == 0 {
				continue
			}
			content += xunfeiResponse.Payload.Choices.Text[0].Content
			usage.PromptTokens += xunfeiResponse.Payload.Usage.Text.PromptTokens
			usage.CompletionTokens += xunfeiResponse.Payload.Usage.Text.CompletionTokens
			usage.TotalTokens += xunfeiResponse.Payload.Usage.Text.TotalTokens
		case <-stopChan:
			stop = true
		case <-attempt.Context().Done():
			return nil, types.NewError(attempt.Context().Err(), types.ErrorCodeDoRequestFailed)
		}
	}
	if len(xunfeiResponse.Payload.Choices.Text) == 0 {
		xunfeiResponse.Payload.Choices.Text = []XunfeiChatResponseTextItem{
			{
				Content: "",
			},
		}
	}
	xunfeiResponse.Payload.Choices.Text[0].Content = content

	response := responseXunfei2OpenAI(&xunfeiResponse)
	jsonResponse, err := common.Marshal(response)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeBadResponseBody)
	}
	c.Writer.Header().Set("Content-Type", "application/json")
	_, _ = c.Writer.Write(jsonResponse)
	if c.Writer.Written() {
		attempt.StopTimeout()
	}
	return &usage, nil
}

func xunfeiMakeRequest(ctx context.Context, textRequest dto.GeneralOpenAIRequest, domain, authUrl, appId string) (chan XunfeiChatResponse, chan error, error) {
	d := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
	}
	conn, resp, err := d.DialContext(ctx, authUrl, nil)
	if err != nil {
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		return nil, nil, err
	}
	if resp == nil || resp.StatusCode != http.StatusSwitchingProtocols {
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		return nil, nil, fmt.Errorf("unexpected websocket handshake response")
	}

	data := requestOpenAI2Xunfei(textRequest, appId, domain)
	err = conn.WriteJSON(data)
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}

	dataChan := make(chan XunfeiChatResponse)
	stopChan := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	go func() {
		var streamErr error
		defer func() {
			close(done)
			_ = conn.Close()
			stopChan <- streamErr
		}()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				common.SysLog("error reading stream response: " + err.Error())
				streamErr = err
				break
			}
			var response XunfeiChatResponse
			err = common.Unmarshal(msg, &response)
			if err != nil {
				common.SysLog("error unmarshalling stream response: " + err.Error())
				streamErr = err
				break
			}
			select {
			case dataChan <- response:
			case <-ctx.Done():
				return
			}
			if response.Payload.Choices.Status == 2 {
				if err != nil {
					common.SysLog("error closing websocket connection: " + err.Error())
				}
				break
			}
		}
	}()

	return dataChan, stopChan, nil
}

func apiVersion2domain(apiVersion string) string {
	switch apiVersion {
	case "v1.1":
		return "lite"
	case "v2.1":
		return "generalv2"
	case "v3.1":
		return "generalv3"
	case "v3.5":
		return "generalv3.5"
	case "v4.0":
		return "4.0Ultra"
	}
	return "general" + apiVersion
}

func getXunfeiAuthUrl(c *gin.Context, apiKey string, apiSecret string, modelName string) (string, string) {
	apiVersion := getAPIVersion(c, modelName)
	domain := apiVersion2domain(apiVersion)
	authUrl := buildXunfeiAuthUrl(fmt.Sprintf("wss://spark-api.xf-yun.com/%s/chat", apiVersion), apiKey, apiSecret)
	return domain, authUrl
}

func getAPIVersion(c *gin.Context, modelName string) string {
	query := c.Request.URL.Query()
	apiVersion := query.Get("api-version")
	if apiVersion != "" {
		return apiVersion
	}
	parts := strings.Split(modelName, "-")
	if len(parts) == 2 {
		apiVersion = parts[1]
		return apiVersion

	}
	apiVersion = c.GetString("api_version")
	if apiVersion != "" {
		return apiVersion
	}
	apiVersion = "v1.1"
	common.SysLog("api_version not found, using default: " + apiVersion)
	return apiVersion
}
