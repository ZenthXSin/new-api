package coze

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestCozePollingAttemptCancelsCustomRetrieveRequest(t *testing.T) {
	service.InitHttpClient()
	retrieveStarted := make(chan struct{})
	retrieveCanceled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v3/chat":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"code":0,"data":{"conversation_id":"conversation","id":"chat"}}`)
		case "/v3/chat/retrieve":
			close(retrieveStarted)
			<-r.Context().Done()
			close(retrieveCanceled)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	info := &relaycommon.RelayInfo{
		TextPollingAttemptTimeout: 50 * time.Millisecond,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelBaseUrl: server.URL,
		},
	}

	done := make(chan error, 1)
	go func() {
		_, err := (&Adaptor{}).DoRequest(c, info, strings.NewReader(`{}`))
		done <- err
	}()

	select {
	case <-retrieveStarted:
	case <-time.After(time.Second):
		t.Fatal("Coze retrieve request did not start")
	}
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("Coze polling attempt did not return after its timeout")
	}
	select {
	case <-retrieveCanceled:
	case <-time.After(time.Second):
		t.Fatal("Coze retrieve request did not inherit the polling context")
	}
}

func TestCozePollingAttemptHonorsRequestCancellation(t *testing.T) {
	service.InitHttpClient()
	retrieveStarted := make(chan struct{})
	retrieveCanceled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v3/chat":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"code":0,"data":{"conversation_id":"conversation","id":"chat"}}`)
		case "/v3/chat/retrieve":
			close(retrieveStarted)
			<-r.Context().Done()
			close(retrieveCanceled)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	requestCtx, requestCancel := context.WithCancel(context.Background())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(requestCtx)
	info := &relaycommon.RelayInfo{
		TextPollingAttemptTimeout: time.Hour,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelBaseUrl: server.URL,
		},
	}

	done := make(chan error, 1)
	go func() {
		_, err := (&Adaptor{}).DoRequest(c, info, strings.NewReader(`{}`))
		done <- err
	}()
	select {
	case <-retrieveStarted:
	case <-time.After(time.Second):
		t.Fatal("Coze retrieve request did not start")
	}
	requestCancel()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("Coze polling attempt did not return after request cancellation")
	}
	select {
	case <-retrieveCanceled:
	case <-time.After(time.Second):
		t.Fatal("Coze retrieve request did not inherit request cancellation")
	}
}
