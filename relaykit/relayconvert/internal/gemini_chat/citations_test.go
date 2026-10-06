package geminichat

import (
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGeminiStructuredGroundingCitations(t *testing.T) {
	var response dto.GeminiChatResponse
	require.NoError(t, kitutil.Unmarshal([]byte(`{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Answer"}]},"groundingMetadata":{"webSearchQueries":["query"],"groundingChunks":[{"web":{"uri":"https://source.example/article","title":"Source"}},{"web":{"uri":"data:text/html,bad","title":"Unsafe"}}]}}]}`), &response))
	chat := ResponseGeminiChat2OpenAI("id", 1, &response)
	require.Len(t, chat.Choices[0].Annotations, 1)
	stream, _ := StreamResponseGeminiChat2OpenAI(&response)
	assert.Equal(t, chat.Choices[0].Annotations, stream.Choices[0].Delta.Annotations)
}
