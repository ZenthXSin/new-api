package model

import "github.com/QuantumNous/new-api/common"

const (
	OAuthCatalogVersion    = "2026-10-02"
	OAuthResourceDashboard = "urn:new-api:dashboard"
	OAuthResourceRelay     = "urn:new-api:relay"
)

// OAuthCapability describes a concrete consent scope. full is deliberately not
// a capability: authorization expands it to a snapshot of this catalog.
type OAuthCapability struct {
	Scope       string `json:"scope"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Resource    string `json:"resource"`
	Sensitive   bool   `json:"sensitive"`
	MinRole     int    `json:"min_role"`
}

var oauthCapabilities = []OAuthCapability{
	{"openid", "Sign in", "Identify your account using OpenID Connect.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"profile", "Basic profile", "View your public profile information.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"email", "Email address", "View your account email address.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"offline_access", "Stay connected", "Renew access until you revoke the application or the authorization expires.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"profile:read", "Read account", "View your account, settings, available models, and group availability.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"profile:write", "Edit account", "Change your display name and personal settings.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"api_key:read", "Read API keys", "View your API key settings without exposing complete keys.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"api_key:write", "Manage API keys", "Create and manage credentials bound to this application authorization.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"api_key:reveal", "Reveal API keys", "Reveal complete API keys after confirmation on this site.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"usage:read", "Read usage", "View your usage logs, statistics, and task history.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"wallet:read", "Read wallet", "View balance, top-ups, subscriptions, and referral information.", OAuthResourceDashboard, false, common.RoleCommonUser},
	{"wallet:write", "Manage wallet", "Start payments, buy subscriptions, redeem credit, check in, and transfer referral rewards.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"account_security:read", "Read account security", "View sign-in methods, two-factor status, and sessions.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"account_security:write", "Manage account security", "Change password, sign-in bindings, two-factor settings, sessions, or delete your account after confirmation on this site.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"oauth_grants:read", "Read authorizations", "View applications authorized by your account after confirmation on this site.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"oauth_grants:write", "Manage authorizations", "Reduce or revoke application authorizations after confirmation on this site.", OAuthResourceDashboard, true, common.RoleCommonUser},
	{"relay:read", "Read model access", "Read available models and the usage of this application's relay credentials.", OAuthResourceRelay, false, common.RoleCommonUser},
	{"relay:invoke", "Call models", "Send model requests, create generation tasks, and use streaming or realtime responses with your account balance.", OAuthResourceRelay, true, common.RoleCommonUser},
	{"relay:tasks", "Read model tasks", "Read and manage generation tasks owned by your account.", OAuthResourceRelay, false, common.RoleCommonUser},
	{"user:read", "Read users", "View users and their account information with your existing administrator permissions.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"user:write", "Manage users", "Create, modify, disable, or delete users and reset their security settings within your existing permissions.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"billing:read", "Read finances", "View financial reports, top-up records, subscription plans, and user subscriptions.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"billing:write", "Manage finances", "Manage financial entries, complete top-up orders, and administer subscriptions.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"model:read", "Read model settings", "View model and vendor configuration and upstream synchronization previews.", OAuthResourceDashboard, false, common.RoleAdminUser},
	{"model:write", "Manage model settings", "Edit models and vendors and synchronize upstream model configuration.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"deployment:read", "Read deployments", "View deployments, logs, infrastructure, and price estimates.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"deployment:write", "Manage deployments", "Create, modify, extend, or delete deployments and test connections.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"log:read", "Read all usage", "View account-wide usage logs, statistics, and tasks with administrator permissions.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"redemption:read", "Read redemption codes", "View redemption code configuration.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"redemption:write", "Manage redemption codes", "Create, edit, and delete redemption codes.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"group:read", "Read group settings", "View groups and prefill group configuration.", OAuthResourceDashboard, false, common.RoleAdminUser},
	{"group:write", "Manage group settings", "Create, edit, and delete prefill groups.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"app_center:read", "Read application center", "View managed applications, releases, announcements, and telemetry.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"app_center:write", "Manage application center", "Manage applications, releases, uploaded assets, announcements, and telemetry.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"app_center:reveal", "Reveal application secrets", "Reveal or rotate telemetry credentials after confirmation on this site.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"channel:read", "Read channels", "View channel lists and details without secrets.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"channel:operate", "Operate channels", "Test channels, refresh balances, and enable or disable channels.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"channel:write", "Edit channel routing", "Edit channel models, groups, and routing rules with your existing channel permissions.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"channel:sensitive_write", "Edit sensitive channel settings", "Create channels or edit upstream keys, base URLs, and overrides with your existing channel permissions.", OAuthResourceDashboard, true, common.RoleAdminUser},
	{"channel:secret_view", "View channel secrets", "View complete channel keys after confirmation on this site.", OAuthResourceDashboard, true, common.RoleRootUser},
	{"option:read", "Read system settings", "View system settings, identity providers, and price synchronization sources.", OAuthResourceDashboard, true, common.RoleRootUser},
	{"option:write", "Manage system settings", "Change system settings, identity providers, and price synchronization configuration.", OAuthResourceDashboard, true, common.RoleRootUser},
	{"oauth_clients:read", "Read OAuth applications", "View registered OAuth client configuration.", OAuthResourceDashboard, true, common.RoleRootUser},
	{"oauth_clients:write", "Manage OAuth applications", "Create, modify, disable, or delete OAuth clients after confirmation on this site.", OAuthResourceDashboard, true, common.RoleRootUser},
	{"ops:read", "Read operations", "View service performance, logs, system tasks, and instances.", OAuthResourceDashboard, true, common.RoleRootUser},
	{"ops:write", "Manage operations", "Run maintenance tasks, clear caches, and manage service operation settings.", OAuthResourceDashboard, true, common.RoleRootUser},
}

func OAuthCapabilities() []OAuthCapability {
	return append([]OAuthCapability(nil), oauthCapabilities...)
}

func OAuthCapabilityByScope(scope string) (OAuthCapability, bool) {
	for _, capability := range oauthCapabilities {
		if capability.Scope == scope {
			return capability, true
		}
	}
	return OAuthCapability{}, false
}

func OAuthSupportedScopes() []string {
	scopes := make([]string, 0, len(oauthCapabilities))
	for _, capability := range oauthCapabilities {
		scopes = append(scopes, capability.Scope)
	}
	return scopes
}
