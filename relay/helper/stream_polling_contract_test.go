package helper

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type pollingContractBody struct {
	stopped bool
}

func (b *pollingContractBody) StopPollingTimeout()      { b.stopped = true }
func (b *pollingContractBody) Read([]byte) (int, error) { return 0, io.EOF }
func (b *pollingContractBody) Close() error             { return nil }

func pollingContractContext() (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	r := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(r)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	return c, r
}

func TestCommitPollingStreamOutputRequiresCommittedWriter(t *testing.T) {
	c, _ := pollingContractContext()
	body := &pollingContractBody{}
	resp := &http.Response{Body: body}
	info := &relaycommon.RelayInfo{TextPollingAttemptTimeout: time.Second}

	assert.False(t, CommitPollingStreamOutput(c, resp, info))
	assert.False(t, body.stopped)

	_, err := c.Writer.Write([]byte("data: valid\n\n"))
	require.NoError(t, err)
	assert.True(t, CommitPollingStreamOutput(c, resp, info))
	assert.True(t, body.stopped)
}

func TestPollingStreamReadErrorPropagatesBeforeCommitAndSuppressesAfter(t *testing.T) {
	c, _ := pollingContractContext()
	info := &relaycommon.RelayInfo{TextPollingAttemptTimeout: time.Second}
	want := errors.New("upstream timeout")

	assert.ErrorIs(t, PollingStreamReadError(c, info, want), want)
	_, err := c.Writer.Write([]byte("data: valid\n\n"))
	require.NoError(t, err)
	assert.NoError(t, PollingStreamReadError(c, info, want))
}
