package openai

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOaiStreamHandlerPollingCommitsSingleEventBeforeDone(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	data := `{"id":"chatcmpl-single","object":"chat.completion.chunk","created":1710000000,"model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}`
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader("data: " + data + "\n\ndata: [DONE]\n\n")),
	}
	info := &relaycommon.RelayInfo{
		ChannelMeta:               &relaycommon.ChannelMeta{UpstreamModelName: "gpt-test"},
		IsStream:                  true,
		RelayFormat:               types.RelayFormatOpenAI,
		RelayMode:                 relayconstant.RelayModeChatCompletions,
		DisablePing:               true,
		TextPollingAttemptTimeout: time.Second,
	}

	usage, err := OaiStreamHandler(c, info, resp)

	require.Nil(t, err)
	require.NotNil(t, usage)
	require.True(t, c.Writer.Written())
	require.Contains(t, recorder.Body.String(), `data: `+data)
	require.Contains(t, recorder.Body.String(), "data: [DONE]")
}

type pollingPauseBody struct {
	io.ReadCloser
	stopped chan struct{}
	once    sync.Once
}

func (b *pollingPauseBody) StopPollingTimeout() {
	b.once.Do(func() { close(b.stopped) })
}

func TestOaiStreamHandlerPollingCommitsFirstCompleteEventBeforeAttemptTimeout(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	reader, writer := io.Pipe()
	body := &pollingPauseBody{ReadCloser: reader, stopped: make(chan struct{})}
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       body,
	}
	info := &relaycommon.RelayInfo{
		ChannelMeta:               &relaycommon.ChannelMeta{UpstreamModelName: "gpt-test"},
		IsStream:                  true,
		RelayFormat:               types.RelayFormatOpenAI,
		RelayMode:                 relayconstant.RelayModeChatCompletions,
		DisablePing:               true,
		TextPollingAttemptTimeout: 50 * time.Millisecond,
	}

	done := make(chan *types.NewAPIError, 1)
	go func() {
		_, err := OaiStreamHandler(c, info, resp)
		done <- err
	}()

	data := `{"id":"chatcmpl-pause","object":"chat.completion.chunk","created":1710000000,"model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"}}]}`
	_, err := writer.Write([]byte("data: " + data + "\n\n"))
	require.NoError(t, err)

	select {
	case <-body.stopped:
	case <-time.After(time.Second):
		t.Fatal("polling timeout was not stopped after the first complete event")
	}
	require.True(t, c.Writer.Written())
	require.Contains(t, recorder.Body.String(), "data: "+data)

	// Keep the upstream open past the attempt timeout. A stopped timeout must
	// leave this stream active until its later terminal event arrives.
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("stream ended during upstream pause: %v", err)
	default:
	}

	_, err = writer.Write([]byte("data: [DONE]\n\n"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	require.Nil(t, <-done)
	assert.Equal(t, 1, strings.Count(recorder.Body.String(), "data: "+data))
}
