package middleware

import (
	"io"
	"net/http"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
)

type relayTimingWriter struct {
	gin.ResponseWriter
	timing *common.RelayTiming
}

func (w *relayTimingWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *relayTimingWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.timing.RecordWrite(n, err, time.Now())
	return n, err
}

func (w *relayTimingWriter) WriteString(s string) (int, error) {
	n, err := w.ResponseWriter.WriteString(s)
	w.timing.RecordWrite(n, err, time.Now())
	return n, err
}

var _ io.Writer = (*relayTimingWriter)(nil)
var _ http.ResponseWriter = (*relayTimingWriter)(nil)

// RelayTiming captures request receipt and downstream writes for relay logs.
// It is installed before token authentication/distribution on relay groups.
func RelayTiming() gin.HandlerFunc {
	return func(c *gin.Context) {
		timing := common.NewRelayTiming(time.Now())
		c.Set(string(constant.ContextKeyRelayTiming), timing)
		c.Writer = &relayTimingWriter{ResponseWriter: c.Writer, timing: timing}
		c.Next()
		if c.Request != nil && c.Request.Context().Err() != nil {
			timing.SetEndStatus("client_disconnect")
		} else if len(c.Errors) > 0 {
			timing.SetEndStatus("handler_error")
		} else if timing.Snapshot(time.Now())["end_status"] == "unknown" {
			timing.SetEndStatus("normal")
		}
	}
}
