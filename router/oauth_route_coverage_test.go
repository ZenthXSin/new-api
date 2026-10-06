package router

import (
	"net/http"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// This is a registration contract, not a count snapshot: an added business
// endpoint must receive an explicit delegation policy before it can ship.
func TestOAuthRouteCatalogCoversRegisteredRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	SetApiRouter(engine)
	SetDashboardRouter(engine)
	SetRelayRouter(engine)
	SetVideoRouter(engine)
	SetOidcRouter(engine)
	SetOAuthRouter(engine)
	SetAppPaymentRouter(engine)

	registered := make(map[string]gin.RouteInfo)
	for _, route := range engine.Routes() {
		key := route.Method + " " + route.Path
		registered[key] = route
		capability, exists := service.OAuthRouteFor(route.Method, route.Path)
		if !assert.True(t, exists, "registered endpoint has no OAuth policy: %s", key) {
			continue
		}
		assert.Equal(t, route.Method, capability.Method)
		assert.Equal(t, route.Path, capability.Path)
		assert.Equal(t, strings.HasSuffix(route.Handler, ".RelayNotImplemented"), capability.Mode == service.OAuthRouteCompatibility,
			"only an existing unimplemented endpoint can be classified as compatibility: %s", key)
	}

	declared := make(map[string]bool)
	for _, capability := range service.OAuthRouteCatalog() {
		key := capability.Method + " " + capability.Path
		assert.False(t, declared[key], "duplicate catalog entry: %s", key)
		declared[key] = true
		assert.Contains(t, registered, key, "catalog contains an unregistered endpoint")
		assert.NotEmpty(t, capability.Description, key)
		switch capability.Mode {
		case service.OAuthRouteDirect, service.OAuthRouteHosted, service.OAuthRouteCompatibility:
			assert.Contains(t, []string{service.OAuthResourceDashboard, service.OAuthResourceRelay}, capability.Resource, key)
			assert.GreaterOrEqual(t, capability.MinRole, common.RoleCommonUser, key)
			if capability.Scope == "" {
				assert.Equal(t, service.OAuthRouteDirect, capability.Mode, key)
				assert.Equal(t, service.OAuthResourceDashboard, capability.Resource, key)
				continue
			}
			scope, exists := model.OAuthCapabilityByScope(capability.Scope)
			if assert.True(t, exists, "route requests an undeclared consent scope: %s", key) {
				assert.Equal(t, scope.Resource, capability.Resource, key)
				assert.GreaterOrEqual(t, capability.MinRole, scope.MinRole, key)
			}
		case service.OAuthRoutePublic, service.OAuthRouteProtocol:
			assert.Empty(t, capability.Scope, key)
			assert.Empty(t, capability.Resource, key)
			assert.Equal(t, common.RoleGuestUser, capability.MinRole, key)
		default:
			t.Errorf("unknown delegation mode %q for %s", capability.Mode, key)
		}
	}
	assert.Len(t, declared, len(registered))
}

func TestOAuthChannelPoliciesRetainFineGrainedPermissions(t *testing.T) {
	for _, route := range channelPermissionRoutes {
		capability, exists := service.OAuthRouteFor(route.method, "/api/channel"+route.path)
		require.True(t, exists)
		assert.Equal(t, route.permission.Resource+":"+route.permission.Action, capability.Scope)
		assert.Equal(t, common.RoleAdminUser, capability.MinRole)
	}
	secret, exists := service.OAuthRouteFor(http.MethodPost, "/api/channel/:id/key")
	require.True(t, exists)
	assert.Equal(t, "channel:secret_view", secret.Scope)
	assert.Equal(t, common.RoleRootUser, secret.MinRole)
	assert.Equal(t, service.OAuthRouteHosted, secret.Mode)
}

// A hosted classification must point to a usable operation, not merely deny
// delegated access and describe future work. Auxiliary verification endpoints
// have their own protocol policy and are performed within the same real session.
func TestOAuthHostedRoutesHaveCompleteOperationDefinitions(t *testing.T) {
	covered := make(map[string]bool)
	for _, operation := range service.OAuthActionOperations() {
		scope, exists := model.OAuthCapabilityByScope(operation.Scope)
		require.True(t, exists, "operation %s has an undeclared scope", operation.ID)
		assert.Equal(t, service.OAuthResourceDashboard, scope.Resource, operation.ID)
		assert.GreaterOrEqual(t, operation.MinRole, scope.MinRole, operation.ID)
		require.NotEmpty(t, operation.Steps, operation.ID)
		for _, step := range operation.Steps {
			route, exists := service.OAuthRouteFor(step.Method, step.Path)
			require.True(t, exists, "operation %s targets an undeclared route: %s %s", operation.ID, step.Method, step.Path)
			if route.Mode != service.OAuthRouteHosted {
				continue
			}
			assert.Equal(t, route.Scope, operation.Scope, operation.ID)
			assert.GreaterOrEqual(t, operation.MinRole, route.MinRole, operation.ID)
			covered[route.Method+" "+route.Path] = true
		}
	}
	for _, route := range service.OAuthRouteCatalog() {
		if route.Mode == service.OAuthRouteHosted {
			assert.True(t, covered[route.Method+" "+route.Path], "hosted route has no external completion flow: %s %s", route.Method, route.Path)
		}
	}
}

func TestOAuthRoutePoliciesPreserveSensitiveAndProtocolBoundaries(t *testing.T) {
	tests := []struct {
		method, path, scope, mode, resource string
	}{
		{http.MethodGet, "/api/user/self", "profile:read", service.OAuthRouteDirect, service.OAuthResourceDashboard},
		{http.MethodPut, "/api/user/self", "profile:write", service.OAuthRouteDirect, service.OAuthResourceDashboard},
		{http.MethodPost, "/api/user/", "user:write", service.OAuthRouteHosted, service.OAuthResourceDashboard},
		{http.MethodPut, "/api/user/", "user:write", service.OAuthRouteHosted, service.OAuthResourceDashboard},
		{http.MethodGet, "/api/user/token", "account_security:write", service.OAuthRouteHosted, service.OAuthResourceDashboard},
		{http.MethodPost, "/api/token/:id/key", "api_key:reveal", service.OAuthRouteDirect, service.OAuthResourceDashboard},
		{http.MethodGet, "/api/app-center/apps", "app_center:read", service.OAuthRouteDirect, service.OAuthResourceDashboard},
		{http.MethodPost, "/api/app-center/apps", "app_center:write", service.OAuthRouteHosted, service.OAuthResourceDashboard},
		{http.MethodGet, "/api/app-center/apps/:id/telemetry-key", "app_center:reveal", service.OAuthRouteHosted, service.OAuthResourceDashboard},
		{http.MethodGet, "/api/oauth_client/", "oauth_clients:read", service.OAuthRouteDirect, service.OAuthResourceDashboard},
		{http.MethodPost, "/api/oauth_client/", "oauth_clients:write", service.OAuthRouteHosted, service.OAuthResourceDashboard},
		{http.MethodGet, "/api/user/wechatpay/order/:trade_no", "wallet:write", service.OAuthRouteDirect, service.OAuthResourceDashboard},
		{http.MethodPost, "/api/option/payment_compliance", "option:write", service.OAuthRouteHosted, service.OAuthResourceDashboard},
		{http.MethodGet, "/api/oauth2/consent", "", service.OAuthRouteProtocol, ""},
		{http.MethodPost, "/api/oauth2/consent", "", service.OAuthRouteProtocol, ""},
		{http.MethodPost, "/api/stripe/webhook", "", service.OAuthRouteProtocol, ""},
		{http.MethodGet, "/api/user/epay/notify", "", service.OAuthRouteProtocol, ""},
		{http.MethodPost, "/api/user/auth/refresh", "", service.OAuthRouteProtocol, ""},
		{http.MethodPost, "/api/verify", "", service.OAuthRouteProtocol, ""},
		{http.MethodPost, "/api/user/passkey/verify/begin", "", service.OAuthRouteProtocol, ""},
		{http.MethodPost, "/api/user/passkey/verify/finish", "", service.OAuthRouteProtocol, ""},
		{http.MethodPost, "/pg/chat/completions", "relay:invoke", service.OAuthRouteDirect, service.OAuthResourceRelay},
		{http.MethodGet, "/v1/realtime", "relay:invoke", service.OAuthRouteDirect, service.OAuthResourceRelay},
		{http.MethodPost, "/suno/fetch", "relay:tasks", service.OAuthRouteDirect, service.OAuthResourceRelay},
		{http.MethodPost, "/mj/task/list-by-condition", "relay:tasks", service.OAuthRouteDirect, service.OAuthResourceRelay},
		{http.MethodGet, "/v1/videos/:task_id/content", "relay:tasks", service.OAuthRouteDirect, service.OAuthResourceRelay},
		{http.MethodGet, "/api/usage/token/", "relay:read", service.OAuthRouteDirect, service.OAuthResourceRelay},
		{http.MethodGet, "/mj/image/:id", "", service.OAuthRoutePublic, ""},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			capability, exists := service.OAuthRouteFor(test.method, test.path)
			require.True(t, exists)
			assert.Equal(t, test.scope, capability.Scope)
			assert.Equal(t, test.mode, capability.Mode)
			assert.Equal(t, test.resource, capability.Resource)
		})
	}
}

func TestOAuthRouteLookupHasNoFallbackOrWildcardExpansion(t *testing.T) {
	for _, test := range []struct{ method, path string }{
		{http.MethodGet, "/api/user/self/future"},
		{http.MethodGet, "/api/user/self/"},
		{http.MethodGet, "/api/token/123"},
		{http.MethodGet, "/api/token/:id/key"},
		{http.MethodPost, "/api/channel/new-unreviewed-operation"},
		{"get", "/api/user/self"},
	} {
		_, exists := service.OAuthRouteFor(test.method, test.path)
		assert.False(t, exists, "%s %s", test.method, test.path)
	}
}
