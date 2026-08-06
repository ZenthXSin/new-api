package xunfei

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestXunfeiMakeRequestHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := xunfeiMakeRequest(ctx, dto.GeneralOpenAIRequest{}, "general", "ws://127.0.0.1:1", "app-id")

	require.ErrorIs(t, err, context.Canceled)
}

func xunfeiPollingContext(t *testing.T) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	return c, w
}

func testXunfeiResponse(content string) XunfeiChatResponse {
	var response XunfeiChatResponse
	response.Payload.Choices.Text = []XunfeiChatResponseTextItem{{Content: content}}
	return response
}

func TestXunfeiPollingPreCommitErrorKeepsWriterRetryable(t *testing.T) {
	c, w := xunfeiPollingContext(t)
	attempt := helper.NewTextPollingAttempt(c.Request.Context(), time.Hour)
	defer attempt.Close()
	dataChan := make(chan XunfeiChatResponse)
	stopChan := make(chan error, 1)
	stopChan <- errors.New("upstream parse failed")

	usage, apiErr := handleXunfeiStream(c, &relaycommon.RelayInfo{
		TextPollingAttemptTimeout: time.Second,
	}, attempt, dataChan, stopChan)

	require.Nil(t, usage)
	require.NotNil(t, apiErr)
	assert.False(t, c.Writer.Written())
	assert.Empty(t, w.Body.String())
}

func TestXunfeiPollingSuppressesPostCommitErrorAndWritesDone(t *testing.T) {
	c, w := xunfeiPollingContext(t)
	attempt := helper.NewTextPollingAttempt(c.Request.Context(), time.Hour)
	defer attempt.Close()
	dataChan := make(chan XunfeiChatResponse)
	stopChan := make(chan error, 1)
	go func() {
		dataChan <- testXunfeiResponse("hello")
		stopChan <- errors.New("upstream parse failed")
	}()

	usage, apiErr := handleXunfeiStream(c, &relaycommon.RelayInfo{
		TextPollingAttemptTimeout: time.Second,
	}, attempt, dataChan, stopChan)

	require.NotNil(t, usage)
	require.Nil(t, apiErr)
	assert.True(t, c.Writer.Written())
	assert.Contains(t, w.Body.String(), "hello")
	assert.Contains(t, w.Body.String(), "data: [DONE]")
}
