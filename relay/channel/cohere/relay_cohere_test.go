package cohere

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

type coherePollingBody struct {
	io.ReadCloser
	stopped bool
}

func (b *coherePollingBody) StopPollingTimeout() { b.stopped = true }

func coherePollingContext(t *testing.T) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	return c, w
}

func TestCoherePollingPreCommitFailuresKeepWriterRetryable(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "upstream eof", body: ""},
		{name: "invalid first event", body: "not-json\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, w := coherePollingContext(t)
			body := &coherePollingBody{ReadCloser: io.NopCloser(strings.NewReader(tt.body))}

			usage, apiErr := cohereStreamHandler(c, &relaycommon.RelayInfo{
				ChannelMeta:               &relaycommon.ChannelMeta{UpstreamModelName: "command"},
				TextPollingAttemptTimeout: time.Second,
			}, &http.Response{Body: body})

			require.Nil(t, usage)
			require.NotNil(t, apiErr)
			assert.False(t, c.Writer.Written())
			assert.Empty(t, w.Body.String())
			assert.False(t, body.stopped)
		})
	}
}

func TestCoherePollingSuppressesErrorAfterFirstWrite(t *testing.T) {
	c, w := coherePollingContext(t)
	body := &coherePollingBody{ReadCloser: io.NopCloser(strings.NewReader("{\"is_finished\":false,\"text\":\"hello\"}\nnot-json\n"))}

	usage, apiErr := cohereStreamHandler(c, &relaycommon.RelayInfo{
		ChannelMeta:               &relaycommon.ChannelMeta{UpstreamModelName: "command"},
		TextPollingAttemptTimeout: time.Second,
	}, &http.Response{Body: body})

	require.NotNil(t, usage)
	require.Nil(t, apiErr)
	assert.True(t, c.Writer.Written())
	assert.True(t, body.stopped)
	assert.Contains(t, w.Body.String(), "hello")
	assert.Contains(t, w.Body.String(), "data: [DONE]")
}
