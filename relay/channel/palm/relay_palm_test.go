package palm

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type palmPollingBody struct {
	io.ReadCloser
	stopped bool
}

func (b *palmPollingBody) StopPollingTimeout() { b.stopped = true }

func palmPollingContext(t *testing.T) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	return c, w
}

func TestPaLMPollingParseFailureKeepsWriterRetryable(t *testing.T) {
	c, w := palmPollingContext(t)
	body := &palmPollingBody{ReadCloser: io.NopCloser(strings.NewReader("not-json"))}

	apiErr, responseText := palmStreamHandler(c, &relaycommon.RelayInfo{
		TextPollingAttemptTimeout: time.Second,
	}, &http.Response{Body: body})

	require.NotNil(t, apiErr)
	assert.Empty(t, responseText)
	assert.False(t, c.Writer.Written())
	assert.Empty(t, w.Body.String())
	assert.False(t, body.stopped)
}

func TestPaLMPollingCommitsFirstEventAndWritesDone(t *testing.T) {
	c, w := palmPollingContext(t)
	body := &palmPollingBody{ReadCloser: io.NopCloser(strings.NewReader("{\"candidates\":[{\"author\":\"1\",\"content\":\"hello\"}]}"))}

	apiErr, responseText := palmStreamHandler(c, &relaycommon.RelayInfo{
		TextPollingAttemptTimeout: time.Second,
	}, &http.Response{Body: body})

	require.Nil(t, apiErr)
	assert.Equal(t, "hello", responseText)
	assert.True(t, c.Writer.Written())
	assert.True(t, body.stopped)
	assert.Contains(t, w.Body.String(), "hello")
	assert.Contains(t, w.Body.String(), "data: [DONE]")
}
