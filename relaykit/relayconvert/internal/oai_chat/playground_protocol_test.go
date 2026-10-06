package oaichat

import (
	"context"
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/relayconvert/convmeta"
	relaymedia "github.com/QuantumNous/new-api/relaykit/relayconvert/internal/media"
	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func TestPlaygroundSearchAndPDFProviderContracts(t *testing.T) {
	var request dto.GeneralOpenAIRequest
	require.NoError(t, kitutil.Unmarshal([]byte(`{"model":"fixture-model","messages":[{"role":"user","content":[{"type":"text","text":"Summarize"},{"type":"file","file":{"filename":"report.pdf","file_data":"data:application/pdf;base64,JVBERi0="}}]}],"web_search_options":{"search_context_size":"low"}}`), &request))
	request.MaxTokens = kitutil.GetPointer(uint(32))
	response, err := ChatCompletionsRequestToResponsesRequest(&request)
	require.NoError(t, err)
	assert.Equal(t, "input_file", gjson.GetBytes(response.Input, "0.content.1.type").String())
	assert.Equal(t, "report.pdf", gjson.GetBytes(response.Input, "0.content.1.filename").String())
	assert.Equal(t, "data:application/pdf;base64,JVBERi0=", gjson.GetBytes(response.Input, "0.content.1.file_data").String())
	assert.False(t, gjson.GetBytes(response.Input, "0.content.1.file").Exists())
	assert.Equal(t, "web_search", gjson.GetBytes(response.Tools, "0.type").String())
	assert.Equal(t, "low", gjson.GetBytes(response.Tools, "0.search_context_size").String())

	// Local resolver only: decoding an attached data URI must not fetch a URL.
	relaymedia.SetMediaResolver(relaymedia.MediaResolver{GetBase64Data: func(_ context.Context, source types.FileSource, _ ...string) (string, string, error) {
		require.NotNil(t, source)
		return "JVBERi0=", "application/pdf", nil
	}})
	t.Cleanup(func() { relaymedia.SetMediaResolver(relaymedia.MediaResolver{}) })
	claude, err := OpenAIChatRequestToClaudeMessages(context.Background(), &convmeta.Values{}, request)
	require.NoError(t, err)
	data, err := kitutil.Marshal(claude)
	require.NoError(t, err)
	assert.Equal(t, "web_search_20250305", gjson.GetBytes(data, "tools.0.type").String())
	assert.Equal(t, "document", gjson.GetBytes(data, "messages.0.content.1.type").String())
	assert.Equal(t, "application/pdf", gjson.GetBytes(data, "messages.0.content.1.source.media_type").String())
	gemini, err := OpenAIChatRequestToGeminiGenerateContent(context.Background(), request, &convmeta.Values{})
	require.NoError(t, err)
	data, err = kitutil.Marshal(gemini)
	require.NoError(t, err)
	assert.True(t, gjson.GetBytes(data, "tools.0.googleSearch").Exists(), string(data))
	assert.Equal(t, "application/pdf", gjson.GetBytes(data, "contents.0.parts.1.inlineData.mimeType").String())
}
