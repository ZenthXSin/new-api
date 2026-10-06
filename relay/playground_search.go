package relay

import (
	"errors"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

func playgroundSearchRequested(c *gin.Context, request *dto.GeneralOpenAIRequest) bool {
	return c.GetBool(string(constant.ContextKeyPlaygroundRequest)) && request.WebSearchOptions != nil
}

func playgroundSearchError() *types.NewAPIError {
	return types.NewErrorWithStatusCode(errors.New("当前渠道或渠道配置不支持操练场联网搜索，请关闭联网搜索或选择支持搜索的模型"), types.ErrorCodeInvalidRequest, http.StatusBadRequest, types.ErrOptionWithSkipRetry())
}

// Only the playground opts into automatic Responses routing. Ordinary Chat
// clients continue to follow their configured conversion policy.
func playgroundSearchViaResponses(c *gin.Context, info *relaycommon.RelayInfo, request *dto.GeneralOpenAIRequest, passThrough bool) (bool, *types.NewAPIError) {
	if !playgroundSearchRequested(c, request) {
		return false, nil
	}
	if passThrough {
		return false, playgroundSearchError()
	}
	switch info.ApiType {
	case constant.APITypeOpenAI, constant.APITypeNewAPI, constant.APITypeSub2API:
		for _, prefix := range []string{"gpt-4o-search-preview", "gpt-4o-mini-search-preview", "gpt-5-search-api"} {
			if strings.HasPrefix(request.Model, prefix) {
				return false, nil
			}
		}
		return true, nil
	case constant.APITypeCodex:
		return true, nil
	case constant.APITypeAnthropic, constant.APITypeGemini:
		return false, nil
	default:
		return false, playgroundSearchError()
	}
}

// Validate the final wire body, after admin parameter overrides and adaptor
// conversion, so the UI never reports search enabled after it was stripped.
func playgroundSearchPresent(body []byte, apiType int, responses bool) bool {
	if responses {
		for _, tool := range gjson.GetBytes(body, "tools").Array() {
			if tool.Get("type").String() == dto.BuildInToolWebSearch || tool.Get("type").String() == dto.BuildInToolWebSearchPreview {
				return gjson.GetBytes(body, "tool_choice").String() != "none"
			}
		}
		return false
	}
	switch apiType {
	case constant.APITypeAnthropic:
		for _, tool := range gjson.GetBytes(body, "tools").Array() {
			if strings.HasPrefix(tool.Get("type").String(), "web_search_") && tool.Get("name").String() == "web_search" {
				return gjson.GetBytes(body, "tool_choice.type").String() != "none"
			}
		}
	case constant.APITypeGemini:
		for _, tool := range gjson.GetBytes(body, "tools").Array() {
			if tool.Get("googleSearch").Exists() || tool.Get("google_search").Exists() {
				return true
			}
		}
	default:
		return gjson.GetBytes(body, "web_search_options").IsObject()
	}
	return false
}
