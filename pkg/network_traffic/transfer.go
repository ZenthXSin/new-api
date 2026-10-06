package networktraffic

import (
	"context"
	cryptorand "crypto/rand"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"
)

var errWireLimit = errors.New("network traffic transfer byte limit reached")

type wireBudget struct {
	remaining atomic.Int64
	received  atomic.Int64
	sent      atomic.Int64
}

type budgetConn struct {
	net.Conn
	budget *wireBudget
}

func (b *wireBudget) claim(size int) int {
	for {
		remaining := b.remaining.Load()
		if remaining <= 0 {
			return 0
		}
		size = min(size, 32<<10, int(remaining))
		if b.remaining.CompareAndSwap(remaining, remaining-int64(size)) {
			return size
		}
	}
}

func (c *budgetConn) Read(p []byte) (int, error) {
	size := c.budget.claim(len(p))
	if size == 0 {
		return 0, errWireLimit
	}
	n, err := c.Conn.Read(p[:size])
	c.budget.remaining.Add(int64(size - n))
	c.budget.received.Add(int64(n))
	return n, err
}

func (c *budgetConn) Write(p []byte) (int, error) {
	size := c.budget.claim(len(p))
	if size == 0 {
		return 0, errWireLimit
	}
	n, err := c.Conn.Write(p[:size])
	c.budget.remaining.Add(int64(size - n))
	c.budget.sent.Add(int64(n))
	if err == nil && n < len(p) {
		err = io.ErrShortWrite
	}
	return n, err
}

func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range []string{"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		if netip.MustParsePrefix(prefix).Contains(ip) {
			return false
		}
	}
	return true
}

func newClient(target string, budget *wireBudget) *http.Client {
	transport := &http.Transport{
		Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		ForceAttemptHTTP2: false, MaxConnsPerHost: 1,
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second,
		MaxResponseHeaderBytes: 32 << 10,
	}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || host != target || port != "443" {
			return nil, errors.New("network traffic destination is not allowed")
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			return nil, errors.New("network traffic DNS lookup failed")
		}
		for _, ip := range ips {
			if !publicAddress(ip) {
				return nil, errors.New("network traffic destination is not public")
			}
		}
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		for _, i := range rand.Perm(len(ips)) {
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(ips[i].String(), port))
			if err == nil {
				// Bound kernel prefetch as well as application reads when truncating
				// an archive response. Never buffer the complete download in memory.
				if tcp, ok := connection.(*net.TCPConn); ok {
					if err := tcp.SetReadBuffer(32 << 10); err != nil {
						connection.Close()
						return nil, err
					}
					if err := tcp.SetWriteBuffer(32 << 10); err != nil {
						connection.Close()
						return nil, err
					}
				}
				return &budgetConn{Conn: connection, budget: budget}, nil
			}
		}
		return nil, errors.New("network traffic connection failed")
	}
	return &http.Client{
		Transport: transport, Timeout: 70 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

type pacedReader struct {
	ctx       context.Context
	reader    io.Reader
	remaining int64
	rate      int64
	chunk     int64
	pause     int64
}

func (r *pacedReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}
	size := min(int64(len(p)), r.remaining, r.chunk)
	// Sleep before each chunk, so the first chunk is bounded as well.
	delay := time.Duration(size) * time.Second / time.Duration(r.rate)
	if rand.Int64N(100) < r.pause {
		delay += time.Duration(10+rand.Int64N(240)) * time.Millisecond
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	case <-timer.C:
	}
	n, err := r.reader.Read(p[:size])
	r.remaining -= int64(n)
	return n, err
}

func executeTransfer(ctx context.Context, p transferPlan) (result transferResult) {
	result.Status = "network_error"
	budget := &wireBudget{}
	budget.remaining.Store(p.WireLimit)
	defer func() {
		result.Received = budget.received.Load()
		result.Sent = budget.sent.Load()
		if ctx.Err() != nil {
			result.Status = "cancelled_or_timeout"
		}
	}()
	target, err := url.Parse(p.URL)
	if err != nil || target.Scheme != "https" || target.User != nil {
		result.Status = "invalid_destination"
		return
	}
	method := http.MethodGet
	var body io.Reader
	if p.Upload {
		method = http.MethodPost
		// The upload source is generated entropy, never an API request or a file.
		body = &pacedReader{ctx: ctx, reader: cryptorand.Reader, remaining: p.PayloadBytes, rate: p.BytesPerSecond, chunk: p.ChunkBytes, pause: p.PausePercent}
	} else if p.Source == "cloudflare_download" {
		query := target.Query()
		query.Set("bytes", strconv.FormatInt(p.PayloadBytes, 10))
		target.RawQuery = query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return
	}
	request.Header.Set("User-Agent", "new-api-network-traffic/1.0")
	request.Header.Set("Accept-Encoding", "identity")
	if p.Upload {
		request.ContentLength = p.PayloadBytes
		request.Header.Set("Content-Type", "application/octet-stream")
	} else if p.Range {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", p.Offset, p.Offset+p.PayloadBytes-1))
	}
	client := newClient(target.Hostname(), budget)
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		result.Status = "http_" + strconv.Itoa(response.StatusCode)
		return
	}
	limit := p.PayloadBytes
	if p.Upload {
		limit = 16 << 10
	}
	reader := &pacedReader{ctx: ctx, reader: response.Body, remaining: limit, rate: p.BytesPerSecond, chunk: p.ChunkBytes, pause: p.PausePercent}
	if _, err := io.CopyBuffer(io.Discard, reader, make([]byte, 32<<10)); err != nil {
		return
	}
	result.Status = "ok"
	return
}
