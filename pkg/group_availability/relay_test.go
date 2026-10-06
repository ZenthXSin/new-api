package groupavailability

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRelayOutcomeExcludesRequestErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  *types.NewAPIError
		want relayOutcome
	}{
		{"local malformed media", types.NewError(errors.New("invalid audio"), types.ErrorCodeCountTokenFailed), relayIgnored},
		{"local unsupported price", types.NewError(errors.New("no price for requested model"), types.ErrorCodeModelPriceError), relayFailure},
		{"generic upstream bad request", types.NewOpenAIError(errors.New("bad input"), types.ErrorCodeBadResponseStatusCode, 400), relayIgnored},
		{"specific code survives status rewrite", types.WithOpenAIError(types.OpenAIError{Code: "context_length_exceeded"}, 500), relayIgnored},
		{"local invalid body", types.NewError(errors.New("bad body"), types.ErrorCodeBadRequestBody), relayIgnored},
		{"upstream request size", types.WithOpenAIError(types.OpenAIError{Code: "request_too_large"}, 200), relayIgnored},
		{"upstream invalid parameter", types.WithOpenAIError(types.OpenAIError{Code: "invalid_parameter"}, 200), relayIgnored},
		{"upstream unsupported parameter", types.WithOpenAIError(types.OpenAIError{Code: "unsupported_parameter"}, 200), relayIgnored},
		{"upstream context limit", types.WithOpenAIError(types.OpenAIError{Code: "context_window_exceeded"}, 200), relayIgnored},
		{"content rejected", types.WithOpenAIError(types.OpenAIError{Code: "content_policy_violation"}, 400), relayIgnored},
		{"auth beats generic request code", types.WithOpenAIError(types.OpenAIError{Code: "invalid_request_error", Type: "authentication_error"}, 400), relayFailure},
		{"rate limit beats generic request type", types.WithOpenAIError(types.OpenAIError{Type: "invalid_request_error"}, 429), relayFailure},
		{"service failure beats generic request type", types.WithOpenAIError(types.OpenAIError{Type: "invalid_request_error"}, 503), relayFailure},
		{"missing upstream model", types.WithOpenAIError(types.OpenAIError{Code: "model_not_found", Type: "invalid_request_error"}, 404), relayFailure},
		{"local channel key error", types.NewError(errors.New("invalid key"), types.ErrorCodeChannelInvalidKey), relayFailure},
		{"local timeout", types.NewError(context.DeadlineExceeded, types.ErrorCodeDoRequestFailed), relayFailure},
		{"unknown request failure", types.WithOpenAIError(types.OpenAIError{Message: "invalid request please retry"}, 404), relayFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, classifyRelayOutcome(context.Background(), &relaycommon.RelayInfo{}, tc.err, nil))
		})
	}
}

func TestStreamRequestErrorClassification(t *testing.T) {
	previous := Default
	Default = &Collector{}
	t.Cleanup(func() { Default = previous })
	for _, tc := range []struct {
		name   string
		events []string
		want   relayOutcome
	}{
		{"gemini invalid argument", []string{`{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"bad parameter"}}`}, relayIgnored},
		{"stream numeric code", []string{`{"error":{"code":422}}`}, relayIgnored},
		{"stream numeric string code", []string{`{"error":{"code":"413"}}`}, relayIgnored},
		{"stream explicit HTTP status", []string{`{"error":{"status_code":415}}`}, relayIgnored},
		{"stream numeric status", []string{`{"error":{"status":400}}`}, relayIgnored},
		{"stream symbolic status", []string{`{"error":{"status":"INVALID_ARGUMENT"}}`}, relayIgnored},
		{"responses top level error", []string{`{"type":"error","code":"context_length_exceeded","message":"long prompt"}`}, relayIgnored},
		{"responses nested failure", []string{`{"type":"response.failed","response":{"status":"failed","error":{"code":"unsupported_parameter"}}}`}, relayIgnored},
		{"event status fallback", []string{`{"type":"error","status":400,"error":{"message":"bad input"}}`}, relayIgnored},
		{"request then terminal", []string{`{"type":"error","error":{"type":"invalid_request_error"}}`, `{"type":"message_stop"}`}, relayIgnored},
		{"request then outage", []string{`{"error":{"status":"INVALID_ARGUMENT"}}`, `{"type":"error","error":{"type":"overloaded_error"}}`}, relayFailure},
		{"request then unknown failed event", []string{`{"error":{"type":"invalid_request_error"}}`, `{"type":"response.failed"}`}, relayFailure},
		{"request then unknown failed status", []string{`{"error":{"type":"invalid_request_error"}}`, `{"type":"response.done","response":{"status":"failed"}}`}, relayFailure},
		{"authentication", []string{`{"error":{"code":"invalid_request_error","type":"authentication_error"}}`}, relayFailure},
		{"throttled", []string{`{"error":{"code":429,"type":"invalid_request_error"}}`}, relayFailure},
		{"gemini quota", []string{`{"error":{"code":400,"status":"RESOURCE_EXHAUSTED"}}`}, relayFailure},
		{"unknown bad response", []string{`{"type":"error","error":{"message":"invalid request but actually upstream failed"}}`}, relayFailure},
		{"normal terminal", []string{`{"type":"message_stop"}`}, relaySuccess},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			BeginStream(ctx)
			for _, event := range tc.events {
				ObserveStream(ctx, event)
			}
			value, found := ctx.Get(streamObservationKey)
			require.True(t, found)
			state, ok := value.(*streamObservation)
			require.True(t, ok)
			assert.Equal(t, tc.want, classifyRelayOutcome(context.Background(), &relaycommon.RelayInfo{IsStream: true}, nil, state))
		})
	}
}
