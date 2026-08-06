package helper

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/bytedance/gopkg/util/gopool"

	"github.com/gin-gonic/gin"
)

const (
	InitialScannerBufferSize    = 64 << 10  // 64KB (64*1024)
	DefaultMaxScannerBufferSize = 128 << 20 // 64MB (64*1024*1024) default SSE buffer size
	DefaultPingInterval         = 10 * time.Second
	// streamWriteTimeout bounds a single blocked write to a slow client so the
	// unconditional wg.Wait() in cleanup can always finish. Without it, a slow
	// but connected client (full TCP buffer, no server WriteTimeout) could hang
	// the handler forever.
	streamWriteTimeout = 30 * time.Second
)

// TextPollingAttempt bounds an upstream attempt until it has committed a
// response downstream. Stopping the timeout keeps the request context alive;
// closing the attempt also releases the derived context when the handler ends.
type TextPollingAttempt struct {
	ctx    context.Context
	cancel context.CancelFunc
	timer  *time.Timer
	once   sync.Once
}

func NewTextPollingAttempt(parent context.Context, timeout time.Duration) *TextPollingAttempt {
	ctx, cancel := context.WithCancel(parent)
	attempt := &TextPollingAttempt{ctx: ctx, cancel: cancel}
	if timeout > 0 {
		attempt.timer = time.AfterFunc(timeout, cancel)
	}
	return attempt
}

func (a *TextPollingAttempt) Context() context.Context {
	return a.ctx
}

func (a *TextPollingAttempt) StopTimeout() {
	if a == nil || a.timer == nil {
		return
	}
	a.once.Do(func() { a.timer.Stop() })
}

func (a *TextPollingAttempt) Close() {
	if a == nil {
		return
	}
	a.StopTimeout()
	a.cancel()
}

func getScannerBufferSize() int {
	if constant.StreamScannerMaxBufferMB > 0 {
		return constant.StreamScannerMaxBufferMB << 20
	}
	return DefaultMaxScannerBufferSize
}

func NewStreamScanner(reader io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, InitialScannerBufferSize), getScannerBufferSize())
	return scanner
}

func copyCodexSSEHeaders(c *gin.Context, resp *http.Response) {
	if c == nil || c.Writer == nil || resp == nil {
		return
	}
	// codex
	for _, name := range []string{"X-Reasoning-Included", "X-Codex-Turn-State"} {
		values := resp.Header.Values(name)
		if !service.ShouldCopyUpstreamHeader(c, name, values) {
			continue
		}
		for _, value := range values {
			if value != "" {
				c.Writer.Header().Add(name, value)
			}
		}
	}
}

// ExtendWriteDeadline pushes the connection write deadline forward before each
// stream write. Best-effort: writers that don't support deadlines (e.g.
// httptest recorders) are silently ignored.
func ExtendWriteDeadline(c *gin.Context) {
	if c == nil || c.Writer == nil {
		return
	}
	_ = http.NewResponseController(c.Writer).SetWriteDeadline(time.Now().Add(streamWriteTimeout))
}

// PreparePollingStreamOutput delays response headers for text-polling attempts
// until an adapter has validated a real upstream event. This keeps an empty or
// timed-out attempt retryable by the polling coordinator.
func PreparePollingStreamOutput(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) {
	if info != nil && info.TextPollingAttemptTimeout > 0 && !c.Writer.Written() {
		copyCodexSSEHeaders(c, resp)
	}
	SetEventStreamHeaders(c)
}

// CommitPollingStreamOutput hands the attempt timeout back once the first real
// event has been written. It is intentionally gated on Writer.Written so
// parsing or buffering alone cannot commit an attempt.
func CommitPollingStreamOutput(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) bool {
	if c == nil || !c.Writer.Written() {
		return false
	}
	if info != nil && info.TextPollingAttemptTimeout > 0 && resp != nil && resp.Body != nil {
		if timeoutBody, ok := resp.Body.(interface{ StopPollingTimeout() }); ok {
			timeoutBody.StopPollingTimeout()
		}
	}
	return true
}

// PollingStreamReadError suppresses errors after downstream output is already
// committed, while preserving pre-commit errors for channel retry.
func PollingStreamReadError(c *gin.Context, info *relaycommon.RelayInfo, err error) error {
	if err == nil || (info != nil && info.TextPollingAttemptTimeout > 0 && c.Writer.Written()) {
		return nil
	}
	return err
}

func StreamScannerHandler(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo, dataHandler func(data string, sr *StreamResult)) error {

	if resp == nil || dataHandler == nil {
		return nil
	}

	// 无条件新建 StreamStatus
	info.StreamStatus = relaycommon.NewStreamStatus()

	ctx, cancel := context.WithCancel(context.Background())

	scanner := NewStreamScanner(resp.Body)
	streamingTimeout := time.Duration(constant.StreamingTimeout) * time.Second

	var (
		stopChan            = make(chan bool, 3) // 增加缓冲区避免阻塞
		ticker              = time.NewTicker(streamingTimeout)
		pingTicker          *time.Ticker
		writeMutex          sync.Mutex     // Mutex to protect concurrent writes
		wg                  sync.WaitGroup // 用于等待所有 goroutine 退出
		cleanupOnce         sync.Once
		stopOnce            sync.Once
		downstreamCommitted bool
	)

	stop := func() {
		stopOnce.Do(func() {
			close(stopChan)
		})
	}

	generalSettings := operation_setting.GetGeneralSetting()
	pingEnabled := info.TextPollingAttemptTimeout == 0 && generalSettings.PingIntervalEnabled && !info.DisablePing
	pingInterval := time.Duration(generalSettings.PingIntervalSeconds) * time.Second
	if pingInterval <= 0 {
		pingInterval = DefaultPingInterval
	}

	if pingEnabled {
		pingTicker = time.NewTicker(pingInterval)
	}

	logger.LogDebug(c, "relay timeout seconds: %d", common.RelayTimeout)
	logger.LogDebug(c, "relay max idle conns: %d", common.RelayMaxIdleConns)
	logger.LogDebug(c, "relay max idle conns per host: %d", common.RelayMaxIdleConnsPerHost)
	logger.LogDebug(c, "streaming timeout seconds: %d", int64(streamingTimeout.Seconds()))
	logger.LogDebug(c, "ping interval seconds: %d", int64(pingInterval.Seconds()))

	cleanup := func() {
		cleanupOnce.Do(func() {
			cancel()
			stop()
			if resp.Body != nil {
				_ = resp.Body.Close()
			}

			ticker.Stop()
			if pingTicker != nil {
				pingTicker.Stop()
			}

			wg.Wait()
		})
	}
	// Ensure gin.Context is not returned to Gin's pool while any stream goroutine can still use it.
	defer cleanup()

	scanner.Split(bufio.ScanLines)
	if info.TextPollingAttemptTimeout == 0 {
		copyCodexSSEHeaders(c, resp)
		SetEventStreamHeaders(c)
	}

	ctx = context.WithValue(ctx, "stop_chan", stopChan)

	// Handle ping data sending with improved error handling
	if pingEnabled && pingTicker != nil {
		wg.Add(1)
		gopool.Go(func() {
			defer func() {
				if r := recover(); r != nil {
					logger.LogError(c, fmt.Sprintf("ping goroutine panic: %v", r))
					info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonPanic, fmt.Errorf("ping panic: %v", r))
					stop()
				}
				logger.LogDebug(c, "ping goroutine exited")
				wg.Done()
			}()

			// 添加超时保护，防止 goroutine 无限运行
			maxPingDuration := 30 * time.Minute // 最大 ping 持续时间
			pingTimeout := time.NewTimer(maxPingDuration)
			defer pingTimeout.Stop()

			for {
				select {
				case <-pingTicker.C:
					var err error
					func() {
						writeMutex.Lock()
						defer writeMutex.Unlock()
						ExtendWriteDeadline(c)
						err = PingData(c)
					}()
					if err != nil {
						logger.LogError(c, "ping data error: "+err.Error())
						info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonPingFail, err)
						return
					}
					logger.LogDebug(c, "ping data sent")
				case <-ctx.Done():
					return
				case <-stopChan:
					return
				case <-c.Request.Context().Done():
					// 监听客户端断开连接
					return
				case <-pingTimeout.C:
					logger.LogError(c, "ping goroutine max duration reached")
					return
				}
			}
		})
	}

	// Scanner goroutine with improved error handling
	wg.Add(1)
	common.RelayCtxGo(ctx, func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogError(c, fmt.Sprintf("stream scanner panic: %v", r))
				info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonPanic, fmt.Errorf("stream scanner panic: %v", r))
			}
			stop()
			logger.LogDebug(c, "stream scanner goroutine exited")
			wg.Done()
		}()

		sr := newStreamResult(info.StreamStatus)
		pollingMode := info.TextPollingAttemptTimeout > 0
		pollingPending := pollingMode
		var pollingEventData []string
		for scanner.Scan() {
			// 检查是否需要停止
			select {
			case <-stopChan:
				return
			case <-ctx.Done():
				return
			default:
			}

			ticker.Reset(streamingTimeout)
			line := scanner.Text()
			var data string
			if pollingMode {
				// Text-polling retries must not accept partial SSE records. Accumulate
				// every data field in an event and only dispatch it at the blank-line
				// boundary required by the SSE framing rules.
				if line != "" {
					if strings.HasPrefix(line, "data:") {
						value := strings.TrimPrefix(line, "data:")
						if strings.HasPrefix(value, " ") {
							value = value[1:]
						}
						pollingEventData = append(pollingEventData, value)
					}
					continue
				}
				if len(pollingEventData) == 0 {
					continue
				}
				data = strings.Join(pollingEventData, "\n")
				pollingEventData = pollingEventData[:0]
			} else {
				logger.LogDebug(c, "stream scanner data: %s", line)
				if len(line) < 6 {
					continue
				}
				if line[:5] != "data:" && line[:6] != "[DONE]" {
					continue
				}
				data = strings.TrimSpace(line[5:])
			}

			if data == "" {
				continue
			}
			if strings.HasPrefix(data, "[DONE]") {
				if pollingPending {
					info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonScannerErr, io.ErrUnexpectedEOF)
					return
				}
				info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonDone, nil)
				logger.LogDebug(c, "received [DONE], stopping scanner")
				return
			}

			sr.reset()
			errorCountBefore := info.StreamStatus.TotalErrorCount()
			writeMutex.Lock()
			if pollingPending {
				copyCodexSSEHeaders(c, resp)
				SetEventStreamHeaders(c)
			}
			ExtendWriteDeadline(c)
			dataHandler(data, sr)
			writeMutex.Unlock()

			if c.Writer.Written() {
				downstreamCommitted = true
				if pollingPending {
					if timeoutBody, ok := resp.Body.(interface{ StopPollingTimeout() }); ok {
						timeoutBody.StopPollingTimeout()
					}
					pollingPending = false
				}
			}
			if !sr.IsStopped() && info.StreamStatus.TotalErrorCount() == errorCountBefore {
				info.SetFirstResponseTime()
				info.ReceivedResponseCount++
			}
			if sr.IsStopped() {
				return
			}
		}

		if err := scanner.Err(); err != nil {
			if err != io.EOF {
				logger.LogError(c, "scanner error: "+err.Error())
				info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonScannerErr, err)
			}
			return
		}
		if pollingPending {
			info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonScannerErr, io.ErrUnexpectedEOF)
			return
		}
		info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonEOF, nil)
	})

	// 主循环等待完成或超时
	select {
	case <-ticker.C:
		info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonTimeout, context.DeadlineExceeded)
	case <-stopChan:
		// EndReason already set by the goroutine that triggered stopChan
	case <-c.Request.Context().Done():
		// 客户端断开：立即 cleanup 关闭上游 resp.Body，解除 scanner 阻塞并让上游停止生成，
		// 避免为已放弃的请求继续消费上游 token。
		info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonClientGone, c.Request.Context().Err())
	}

	cleanup()
	if info.StreamStatus.IsNormalEnd() && !info.StreamStatus.HasErrors() {
		logger.LogInfo(c, fmt.Sprintf("stream ended: %s", info.StreamStatus.Summary()))
	} else {
		logger.LogError(c, fmt.Sprintf("stream ended: %s, received=%d", info.StreamStatus.Summary(), info.ReceivedResponseCount))
	}
	if info.TextPollingAttemptTimeout == 0 {
		return nil
	}
	if info.TextPollingAttemptTimeout > 0 && downstreamCommitted {
		return nil
	}
	return info.StreamStatus.EndError
}
