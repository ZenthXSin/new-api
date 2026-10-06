package openai

import (
	"fmt"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

// Both output_item.done and the terminal response can contain the same call.
// Charge the actual call once, including providers that send only the terminal.
type chatResponsesToolCounter struct {
	seen map[string]bool
}

func (counter *chatResponsesToolCounter) observe(info *relaycommon.RelayInfo, item *dto.ResponsesOutput, index *int) {
	if item == nil {
		return
	}
	switch item.Type {
	case dto.BuildInCallWebSearchCall, dto.BuildInCallFileSearchCall, dto.BuildInCallFunctionCall:
	default:
		return
	}
	switch item.Status {
	case "failed", "cancelled", "canceled", "in_progress", "searching":
		return
	}
	var keys []string
	if item.ID != "" {
		keys = append(keys, "id:"+item.ID)
	}
	if index != nil {
		keys = append(keys, fmt.Sprintf("index:%d", *index))
	}
	if counter.seen == nil {
		counter.seen = make(map[string]bool)
	}
	for _, key := range keys {
		if counter.seen[key] {
			return
		}
	}
	for _, key := range keys {
		counter.seen[key] = true
	}
	info.CountBillableToolCall(item.Type, item.Name)
}

func (counter *chatResponsesToolCounter) response(info *relaycommon.RelayInfo, response *dto.OpenAIResponsesResponse) {
	if response == nil {
		return
	}
	for i := range response.Output {
		counter.observe(info, &response.Output[i], &i)
	}
}

func (counter *chatResponsesToolCounter) event(info *relaycommon.RelayInfo, event *dto.ResponsesStreamResponse) {
	switch event.Type {
	case dto.ResponsesOutputTypeItemDone:
		counter.observe(info, event.Item, event.OutputIndex)
	case "response.completed", "response.done", "response.incomplete":
		counter.response(info, event.Response)
	}
}
