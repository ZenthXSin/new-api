package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type deadlineResponseWriter struct {
	gin.ResponseWriter
	deadlineSet bool
}

func (w *deadlineResponseWriter) SetWriteDeadline(time.Time) error {
	w.deadlineSet = true
	return nil
}

func TestRelayTimingWrapsWriterAndCountsAcceptedBytes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RelayTiming())
	r.GET("/timing", func(c *gin.Context) {
		_, err := c.Writer.WriteString("hello")
		require.NoError(t, err)
		tracker, ok := common.GetContextKeyType[*common.RelayTiming](c, constant.ContextKeyRelayTiming)
		require.True(t, ok)
		require.Equal(t, int64(5), tracker.Snapshot(time.Now())["sent_bytes"])
	})
	req := httptest.NewRequest("GET", "/timing", nil)
	resp := httptest.NewRecorder()
	r.ServeHTTP(resp, req)
	require.Equal(t, "hello", resp.Body.String())
}

func TestRelayTimingWriterForwardsResponseControllerUnwrap(t *testing.T) {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	base := &deadlineResponseWriter{ResponseWriter: ctx.Writer}
	w := &relayTimingWriter{ResponseWriter: base, timing: common.NewRelayTiming(time.Now())}
	require.NoError(t, http.NewResponseController(w).SetWriteDeadline(time.Now()))
	require.True(t, base.deadlineSet)
}
