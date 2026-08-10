package ipguard

// Deterministic synthetic 24h web/SSH traffic generator with ground-truth
// labels, ported from llm-ipguard's sandbox.traffic_gen for the day-sim
// integration test. Same seed -> identical output.

import (
	"fmt"
	"math/rand"
)

var googlebotUA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
var nmapUA = "nmap 7.94"

var browserUAs = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/127.0 Gecko/20100101 Firefox/127.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
}

var normalPaths = []string{
	"/", "/index.html", "/about", "/contact", "/products",
	"/products?category=electronics", "/product/42", "/product/17",
	"/blog", "/blog/why-nginx", "/blog/launch-day", "/search?q=",
	"/cart", "/checkout", "/pricing", "/docs", "/api/items",
	"/assets/css/style.css", "/assets/js/main.js", "/favicon.ico",
}

var sqliPayloads = []string{
	"%27%20OR%201%3D1--%20",
	"%27%20OR%20sleep(5)--%20",
	"%27%20union%20select%201--",
	"%27%3Bwaitfor%20delay%270%3A0%3A5--%20",
	"%27%20AND%201%3D1--%20",
}

var xssPayloads = []string{
	"%3Cscript%3Ealert(1)%3C%2Fscript%3E",
	"%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
	"%3Cscript%3Ealert(document.cookie)%3C%2Fscript%3E",
}

var traversalFiles = []string{
	"..%2fetc%2fpasswd",
	"..%2f..%2fetc%2fshadow",
	"%2e%2e%2fetc%2fpasswd",
	"..%2f..%2f..%2fetc%2fhosts",
}

var scanPaths = []string{
	"/", "/admin", "/phpmyadmin/", "/wp-login.php", "/.git/HEAD",
	"/robots.txt", "/login", "/api/users", "/cgi-bin/test", "/ftp/",
	"/backup.zip", "/config.php", "/server-status", "/actuator", "/graphql",
}

// dayTraffic is generated traffic plus per-IP ground-truth labels.
type dayTraffic struct {
	lines       []string
	groundTruth map[string]string
}

// generateDay produces a deterministic labeled day of traffic.
func generateDay(totalEvents int, seed int64, start, end int64) dayTraffic {
	rng := rand.New(rand.NewSource(seed))
	var lines []string
	groundTruth := map[string]string{}

	randTS := func(a, b int64) int64 {
		if b <= a {
			return a
		}
		return a + rng.Int63n(b-a+1)
	}
	window := func(dur int64) (int64, int64) {
		if dur < end-start {
			s := randTS(start, end-dur)
			return s, s + dur
		}
		return start, end
	}
	web := func(ip string, ts int64, method, path string, status int, ua string) {
		if ua == "" {
			ua = browserUAs[rng.Intn(len(browserUAs))]
		}
		lines = append(lines, combinedLine(ts, ip, path, ua, status))
	}

	clamp := func(budget, lo, hi, n int) []int {
		per := float64(budget) / float64(n)
		out := make([]int, 0, n)
		for i := 0; i < n; i++ {
			if per >= float64(lo) {
				a := hi
				if int(per*0.8) > lo {
					a = int(per * 0.8)
				}
				if a > hi {
					a = hi
				}
				b := int(per * 1.2)
				if b < a {
					b = a
				}
				if b > hi {
					b = hi
				}
				out = append(out, a+rng.Intn(b-a+1))
			} else {
				base := int(per)
				count := base
				if rng.Float64() < per-float64(base) {
					count++
				}
				if count < 1 {
					count = 1
				}
				out = append(out, count)
			}
		}
		return out
	}

	const (
		sshIP   = "203.0.113.1"
		webBFIP = "203.0.113.2"
		sqliIP  = "203.0.113.3"
		xssIP   = "203.0.113.4"
		pathIP  = "203.0.113.5"
		scanIP  = "203.0.113.6"
		slowIP  = "203.0.113.9"
	)
	ddosIPs := []string{"203.0.113.7", "203.0.113.8"}
	var normalIPs []string
	for i := 1; i <= 60; i++ {
		normalIPs = append(normalIPs, fmt.Sprintf("198.51.100.%d", i))
	}
	crawlerIPs := []string{"198.51.100.61", "198.51.100.62"}

	shares := map[string]float64{
		"ssh": 0.08, "web_bf": 0.05, "sqli": 0.04, "xss": 0.03,
		"path": 0.03, "port": 0.03, "ddos": 0.02, "slow": 0.02,
		"crawler": 0.05,
	}
	roundShare := func(s string) int {
		return int(float64(totalEvents) * shares[s])
	}

	// 1. sshd brute force: 1 IP, burst in a 20-minute window.
	s, e := window(1200)
	for i := 0; i < clamp(roundShare("ssh"), 15, 40, 1)[0]; i++ {
		lines = append(lines, authLine(randTS(s, e), sshIP, "failed"))
	}
	groundTruth[sshIP] = "ATTACK:" + AttackSSHBruteforce

	// 2. web login brute force: 1 IP, 401 POST /login in a 30-minute window.
	s, e = window(1800)
	for i := 0; i < clamp(roundShare("web_bf"), 30, 60, 1)[0]; i++ {
		web(webBFIP, randTS(s, e), "POST", "/login", 401, "")
	}
	groundTruth[webBFIP] = "ATTACK:" + AttackWebBruteforce

	// 3. sql injection: 1 IP, encoded payloads on /search?q=.
	s, e = window(7200)
	n := clamp(roundShare("sqli"), 8, 20, 1)[0]
	for i := 0; i < n; i++ {
		status := 200
		if rng.Float64() >= 0.9 {
			status = 500
		}
		web(sqliIP, randTS(s, e), "GET", "/search?q="+sqliPayloads[i%len(sqliPayloads)], status, "")
	}
	groundTruth[sqliIP] = "ATTACK:" + AttackSQLI

	// 4. xss: 1 IP, encoded script payloads on /p?q=.
	s, e = window(7200)
	n = clamp(roundShare("xss"), 8, 15, 1)[0]
	for i := 0; i < n; i++ {
		web(xssIP, randTS(s, e), "GET", "/p?q="+xssPayloads[i%len(xssPayloads)], 200, "")
	}
	groundTruth[xssIP] = "ATTACK:" + AttackXSS

	// 5. path traversal: 1 IP, encoded traversal payloads on /download?file=.
	s, e = window(7200)
	n = clamp(roundShare("path"), 8, 20, 1)[0]
	for i := 0; i < n; i++ {
		status := 200
		if rng.Float64() >= 0.6 {
			status = 403
		}
		web(pathIP, randTS(s, e), "GET", "/download?file="+traversalFiles[i%len(traversalFiles)], status, "")
	}
	groundTruth[pathIP] = "ATTACK:" + AttackPathTraversal

	// 6. port scan: 1 IP, nmap UA, varied paths.
	n = clamp(roundShare("port"), 15, 40, 1)[0]
	for i := 0; i < n; i++ {
		status := 200
		if rng.Float64() >= 0.5 {
			status = 404
		}
		web(scanIP, randTS(start, end), "GET", scanPaths[rng.Intn(len(scanPaths))], status, nmapUA)
	}
	groundTruth[scanIP] = "ATTACK:" + AttackPortScan

	// 7. ddos burst: 2 IPs, GET / inside a 10-minute window.
	s, e = window(600)
	for _, ip := range ddosIPs {
		for i := 0; i < 500; i++ {
			web(ip, randTS(s, e), "GET", "/", 200, "")
		}
		groundTruth[ip] = "ATTACK:" + AttackDDoSBurst
	}

	// 8. slow-and-low: 1 IP, GET / spread thinly across 20 hours.
	s, e = window(72000)
	n = clamp(roundShare("slow"), 60, 60, 1)[0]
	for i := 0; i < n; i++ {
		web(slowIP, randTS(s, e), "GET", "/", 200, "")
	}
	groundTruth[slowIP] = "ATTACK:" + AttackSlowScan

	// 9. aggressive crawler (NORMAL): 2 Googlebot IPs.
	crawlerCounts := clamp(roundShare("crawler"), 150, 300, 2)
	for i, ip := range crawlerIPs {
		for j := 0; j < crawlerCounts[i]; j++ {
			status := 200
			if rng.Float64() >= 0.9 {
				status = 404
			}
			web(ip, randTS(start, end), "GET", normalPaths[rng.Intn(len(normalPaths))], status, googlebotUA)
		}
	}

	// 10. normal browsing: ~60 IPs, each active in 2-4 sessions.
	type session struct {
		ip     string
		s, e   int64
		budget int
	}
	var sessions []session
	for _, ip := range normalIPs {
		for k := 0; k < 2+rng.Intn(3); k++ {
			dur := int64(3600 + rng.Intn(3600))
			s := randTS(start, end-dur)
			sessions = append(sessions, session{ip: ip, s: s, e: s + dur, budget: 8 + rng.Intn(33)})
		}
	}
	for _, sess := range sessions {
		for k := 0; k < sess.budget; k++ {
			status := 200
			if rng.Float64() >= 0.9 {
				status = 404
			}
			web(sess.ip, randTS(sess.s, sess.e), "GET", normalPaths[rng.Intn(len(normalPaths))], status, "")
		}
	}

	// A few normal IPs do 1-2 failed POST /login (401) then a success.
	shuffled := append([]string{}, normalIPs...)
	rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	for _, ip := range shuffled[:3+rng.Intn(3)] {
		var sess *session
		for i := range sessions {
			if sessions[i].ip == ip {
				sess = &sessions[i]
				break
			}
		}
		if sess == nil {
			continue
		}
		for k := 0; k < 1+rng.Intn(2); k++ {
			web(ip, randTS(sess.s, sess.e), "POST", "/login", 401, "")
		}
		web(ip, randTS(sess.s, sess.e), "POST", "/login", 200, "")
	}

	// Legit SSH user: normal_ips[0] logs in successfully twice.
	for k := 0; k < 2; k++ {
		lines = append(lines, authLine(randTS(start, end), normalIPs[0], "accepted"))
	}

	// Top up to total_events inside existing sessions (per-session cap).
	const capPerSession = 60
	idx := 0
	for len(lines) < totalEvents {
		sess := &sessions[idx%len(sessions)]
		if sess.budget < capPerSession {
			status := 200
			if rng.Float64() >= 0.9 {
				status = 404
			}
			web(sess.ip, randTS(sess.s, sess.e), "GET", normalPaths[rng.Intn(len(normalPaths))], status, "")
			sess.budget++
		}
		idx++
		if idx > len(sessions)*capPerSession {
			break
		}
	}

	for _, ip := range append(normalIPs, crawlerIPs...) {
		if _, ok := groundTruth[ip]; !ok {
			groundTruth[ip] = "NORMAL"
		}
	}

	return dayTraffic{lines: lines, groundTruth: groundTruth}
}
