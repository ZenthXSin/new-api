package oairesponses

import (
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResponsesCitationsStreamAndNonStream(t *testing.T) {
	var response dto.OpenAIResponsesResponse
	require.NoError(t, kitutil.Unmarshal([]byte(`{"id":"r","model":"gpt-test","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Answer","annotations":[{"type":"url_citation","url":"https://source.example/article","title":"Source","start_index":0,"end_index":6},{"type":"url_citation","url":"javascript:alert(1)","title":"Unsafe"}]}]}]}`), &response))
	chat, _, err := ResponsesResponseToChatCompletionsResponse(&response, "r")
	require.NoError(t, err)
	require.Len(t, chat.Choices[0].Annotations, 1)
	assert.Equal(t, "https://source.example/article", chat.Choices[0].Annotations[0].URLCitation.URL)
	state := NewResponsesToChatStreamState("gpt-test", true)
	annotation := response.Output[0].Content[0].Annotations[0]
	chunks, err := ResponsesStreamEventToChatChunks(&dto.ResponsesStreamResponse{Type: "response.output_text.annotation.added", Annotation: annotation}, state)
	require.NoError(t, err)
	require.Len(t, chunks, 2)
	require.Len(t, chunks[1].Choices[0].Delta.Annotations, 1)
	chunks, err = ResponsesStreamEventToChatChunks(&dto.ResponsesStreamResponse{Type: "response.completed", Response: &response}, state)
	require.NoError(t, err)
	for _, chunk := range chunks {
		for _, choice := range chunk.Choices {
			assert.Empty(t, choice.Delta.Annotations, "terminal must not repeat earlier citations")
		}
	}
	accumulator := NewResponsesBufferedAccumulator()
	accumulator.ProcessEvent(&dto.ResponsesStreamResponse{Type: "response.output_text.delta", Delta: "Answer"})
	accumulator.ProcessEvent(&dto.ResponsesStreamResponse{Type: "response.output_text.annotation.added", Annotation: annotation})
	buffered := &dto.OpenAIResponsesResponse{}
	accumulator.SupplementResponseOutput(buffered)
	chat, _, err = ResponsesResponseToChatCompletionsResponse(buffered, "r")
	require.NoError(t, err)
	require.Len(t, chat.Choices[0].Annotations, 1)
}
