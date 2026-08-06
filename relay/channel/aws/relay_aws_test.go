package aws

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestNewAwsInvokeContextHonorsPollingTimeoutAndRequestCancellation(t *testing.T) {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	requestCtx, requestCancel := context.WithCancel(context.Background())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil).WithContext(requestCtx)

	attempt := newAwsInvokeContext(c, &relaycommon.RelayInfo{TextPollingAttemptTimeout: time.Millisecond})
	defer attempt.Close()
	select {
	case <-attempt.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("AWS invocation did not honor the polling attempt timeout")
	}

	attempt = newAwsInvokeContext(c, &relaycommon.RelayInfo{TextPollingAttemptTimeout: time.Hour})
	defer attempt.Close()
	requestCancel()
	select {
	case <-attempt.Context().Done():
		require.ErrorIs(t, attempt.Context().Err(), context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("AWS invocation did not inherit the request context")
	}
}

func TestDoAwsClientRequest_AppliesRuntimeHeaderOverrideToAnthropicBeta(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)

	info := &relaycommon.RelayInfo{
		OriginModelName:           "claude-3-5-sonnet-20240620",
		IsStream:                  false,
		UseRuntimeHeadersOverride: true,
		RuntimeHeadersOverride: map[string]any{
			"anthropic-beta": "computer-use-2025-01-24",
		},
		ChannelMeta: &relaycommon.ChannelMeta{
			ApiKey:            "access-key|secret-key|us-east-1",
			UpstreamModelName: "claude-3-5-sonnet-20240620",
		},
	}

	requestBody := bytes.NewBufferString(`{"messages":[{"role":"user","content":"hello"}],"max_tokens":128}`)
	adaptor := &Adaptor{}

	_, err := doAwsClientRequest(ctx, info, adaptor, requestBody)
	require.NoError(t, err)

	awsReq, ok := adaptor.AwsReq.(*bedrockruntime.InvokeModelInput)
	require.True(t, ok)

	var payload map[string]any
	require.NoError(t, common.Unmarshal(awsReq.Body, &payload))

	anthropicBeta, exists := payload["anthropic_beta"]
	require.True(t, exists)

	values, ok := anthropicBeta.([]any)
	require.True(t, ok)
	require.Equal(t, []any{"computer-use-2025-01-24"}, values)
}
