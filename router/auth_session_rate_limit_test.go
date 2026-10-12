package router

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func authRateLimitRouter(t *testing.T, apiLimit int) *gin.Engine {
	t.Helper()
	previousRedisEnabled, previousRedisClient := common.RedisEnabled, common.RDB
	previousAPIEnabled, previousAPINum, previousAPIDuration := common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration
	previousCriticalEnabled, previousCriticalNum, previousCriticalDuration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	redisServer := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	require.NoError(t, client.Ping(context.Background()).Err())
	common.RedisEnabled, common.RDB = true, client
	common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = true, apiLimit, 180
	common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 2, 1200
	t.Cleanup(func() {
		_ = client.Close()
		common.RedisEnabled, common.RDB = previousRedisEnabled, previousRedisClient
		common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = previousAPIEnabled, previousAPINum, previousAPIDuration
		common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = previousCriticalEnabled, previousCriticalNum, previousCriticalDuration
	})
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	require.NoError(t, engine.SetTrustedProxies(nil))
	SetApiRouter(engine)
	return engine
}

func authRateLimitRequest(engine *gin.Engine, path string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, nil)
	request.RemoteAddr = "192.0.2.41:12345"
	request.Header.Set("Origin", "http://example.com")
	result := httptest.NewRecorder()
	engine.ServeHTTP(result, request)
	return result
}

func TestSessionRefreshDoesNotConsumeLoginRateLimit(t *testing.T) {
	engine := authRateLimitRouter(t, 30)
	for range 3 {
		require.Equal(t, http.StatusUnauthorized, authRateLimitRequest(engine, "/api/user/auth/refresh").Code)
	}
	require.Equal(t, http.StatusOK, authRateLimitRequest(engine, "/api/user/auth/logout").Code)
	for range 2 {
		assert.NotEqual(t, http.StatusTooManyRequests, authRateLimitRequest(engine, "/api/user/login").Code)
	}
	blocked := authRateLimitRequest(engine, "/api/user/login")
	assert.Equal(t, http.StatusTooManyRequests, blocked.Code)
	assert.Equal(t, "1200", blocked.Header().Get("Retry-After"))
}

func TestLoginLimitDoesNotBlockSessionRefreshOrLogout(t *testing.T) {
	engine := authRateLimitRouter(t, 30)
	for range 2 {
		authRateLimitRequest(engine, "/api/user/login")
	}
	require.Equal(t, http.StatusTooManyRequests, authRateLimitRequest(engine, "/api/user/login").Code)
	assert.Equal(t, http.StatusUnauthorized, authRateLimitRequest(engine, "/api/user/auth/refresh").Code)
	assert.Equal(t, http.StatusOK, authRateLimitRequest(engine, "/api/user/auth/logout").Code)
}

func TestSessionRefreshRetainsGlobalAPIRateLimit(t *testing.T) {
	engine := authRateLimitRouter(t, 2)
	for range 2 {
		require.Equal(t, http.StatusUnauthorized, authRateLimitRequest(engine, "/api/user/auth/refresh").Code)
	}
	blocked := authRateLimitRequest(engine, "/api/user/auth/refresh")
	assert.Equal(t, http.StatusTooManyRequests, blocked.Code)
	assert.Equal(t, "180", blocked.Header().Get("Retry-After"))
}

func TestSessionRefreshKeepsCookieOriginGuard(t *testing.T) {
	engine := authRateLimitRouter(t, 30)
	previousSecure := common.SessionCookieSecure
	common.SessionCookieSecure = true
	t.Cleanup(func() { common.SessionCookieSecure = previousSecure })
	request := httptest.NewRequest(http.MethodPost, "/api/user/auth/refresh", nil)
	request.RemoteAddr = "192.0.2.41:12345"
	request.Header.Set("Origin", "https://untrusted.example")
	blocked := httptest.NewRecorder()
	engine.ServeHTTP(blocked, request)
	assert.Equal(t, http.StatusForbidden, blocked.Code)
	assert.Contains(t, blocked.Body.String(), "AUTH_ORIGIN_FORBIDDEN")
	assert.Equal(t, http.StatusUnauthorized, authRateLimitRequest(engine, "/api/user/auth/refresh").Code)
}
