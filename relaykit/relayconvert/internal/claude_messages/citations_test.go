package claudemessages

import (
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaudeSearchCitationsPreserveAllTextBlocks(t *testing.T) {
	var response dto.ClaudeResponse
	require.NoError(t, kitutil.Unmarshal([]byte(`{"type":"message","content":[{"type":"text","text":"Before. "},{"type":"server_tool_use","name":"web_search"},{"type":"text","text":"After.","citations":[{"type":"web_search_result_location","url":"https://source.example","title":"Source","encrypted_index":"private"}]}]}`), &response))
	chat := ResponseClaude2OpenAI(&response)
	native, err := kitutil.Marshal(response)
	require.NoError(t, err)
	assert.Contains(t, string(native), `"encrypted_index":"private"`)
	assert.Equal(t, "Before. After.", chat.Choices[0].StringContent())
	public, err := kitutil.Marshal(chat)
	require.NoError(t, err)
	assert.NotContains(t, string(public), "encrypted_index")
	require.Len(t, chat.Choices[0].Annotations, 1)
	var event dto.ClaudeResponse
	require.NoError(t, kitutil.Unmarshal([]byte(`{"type":"content_block_delta","index":1,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://source.example","title":"Source"}}}`), &event))
	chunk := StreamResponseClaude2OpenAI(&event)
	require.Len(t, chunk.Choices[0].Delta.Annotations, 1)
	assert.Equal(t, chat.Choices[0].Annotations, chunk.Choices[0].Delta.Annotations)
}
