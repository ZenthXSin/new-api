package controller

import (
	"bytes"
	"io"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// Hosted operations are a fixed allowlist. Fields belong to exactly one
// operation: arbitrary controller paths or an unbounded request-body object
// cannot be supplied by a delegated application.
func init() {
	for _, operation := range oauthActionOperations() {
		service.RegisterOAuthActionOperation(operation)
	}
}

func oauthActionOperations() []service.OAuthActionOperation {
	type field = service.OAuthActionField
	type step = service.OAuthActionStep
	type operation = service.OAuthActionOperation
	return []operation{
		{
			ID: "app_payment.configure", Scope: "billing:write", MinRole: common.RoleRootUser, Label: "Configure application payments",
			Parameters: []field{{Name: "client_id", Label: "Client ID", Type: "text", Required: true}, {Name: "enabled", Label: "Enable application payments", Type: "boolean", Required: true}, {Name: "webhook_url", Label: "Payment webhook URL", Type: "text", Required: true}, {Name: "methods", Label: "Allowed payment methods", Type: "json", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Save payment settings", Method: http.MethodPut, Path: "/api/payments/applications/:client_id"}},
		},
		{
			ID: "app_payment.rotate_secret", Scope: "billing:write", MinRole: common.RoleRootUser, Label: "Rotate payment webhook secret",
			Parameters: []field{{Name: "client_id", Label: "Client ID", Type: "text", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Rotate payment webhook secret", Method: http.MethodPost, Path: "/api/payments/applications/:client_id/rotate-secret"}},
		},
		{
			ID: "app_payment.retry_webhook", Scope: "billing:write", MinRole: common.RoleRootUser, Label: "Retry payment webhook delivery",
			Parameters: []field{{Name: "client_id", Label: "Client ID", Type: "text", Required: true}, {Name: "event_id", Label: "Webhook event ID", Type: "text", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Retry webhook delivery", Method: http.MethodPost, Path: "/api/payments/applications/:client_id/events/:event_id/retry"}},
		},

		{
			ID: "password.change", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Change account password",
			Steps: []step{{ID: "execute", Label: "Change password", Method: http.MethodPut, Path: "/api/user/self", Fields: []field{
				{Name: "original_password", Label: "Current password", Type: "password", Required: true},
				{Name: "password", Label: "New password", Type: "password", Required: true},
			}}},
		},
		{
			ID: "profile.update", Scope: "profile:write", MinRole: common.RoleCommonUser, Label: "Update account profile",
			Parameters: []field{
				{Name: "username", Label: "Username", Type: "text"},
				{Name: "display_name", Label: "Display name", Type: "text"},
				{Name: "language", Label: "Language", Type: "text"},
				{Name: "sidebar_modules", Label: "Sidebar modules", Type: "text"},
			},
			Steps: []step{{ID: "execute", Label: "Update profile", Method: http.MethodPut, Path: "/api/user/self"}},
		},
		{
			ID: "account.delete", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Delete your account",
			Steps: []step{{ID: "execute", Label: "Delete account", Method: http.MethodDelete, Path: "/api/user/self"}},
		},
		{
			ID: "sessions.list", Scope: "account_security:read", MinRole: common.RoleCommonUser, Label: "View sign-in sessions",
			Steps: []step{{ID: "execute", Label: "View sessions", Method: http.MethodGet, Path: "/api/user/sessions"}},
		},
		{
			ID: "sessions.revoke", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Revoke a sign-in session",
			Parameters: []field{{Name: "sid", Label: "Session ID", Type: "text", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Revoke session", Method: http.MethodDelete, Path: "/api/user/sessions/:sid"}},
		},
		{
			ID: "sessions.revoke_others", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Revoke other sign-in sessions",
			Steps: []step{{ID: "execute", Label: "Revoke other sessions", Method: http.MethodPost, Path: "/api/user/sessions/revoke-others"}},
		},
		{
			ID: "mfa.setup", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Set up two-factor authentication",
			Steps: []step{
				{ID: "setup", Label: "Generate authenticator setup", Method: http.MethodPost, Path: "/api/user/2fa/setup"},
				{ID: "enable", Label: "Confirm authenticator code", Method: http.MethodPost, Path: "/api/user/2fa/enable", Fields: []field{{Name: "code", Label: "Authenticator code", Type: "code", Required: true}}},
			},
		},
		{
			ID: "mfa.enable", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Enable two-factor authentication",
			Steps: []step{{ID: "execute", Label: "Enable two-factor authentication", Method: http.MethodPost, Path: "/api/user/2fa/enable", Fields: []field{{Name: "code", Label: "Authenticator code", Type: "code", Required: true}}}},
		},
		{
			ID: "mfa.disable", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Disable two-factor authentication",
			Steps: []step{{ID: "execute", Label: "Disable two-factor authentication", Method: http.MethodPost, Path: "/api/user/2fa/disable", Fields: []field{{Name: "code", Label: "Authenticator or backup code", Type: "code", Required: true}}}},
		},
		{
			ID: "mfa.backup_codes", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Replace two-factor backup codes",
			Steps: []step{{ID: "execute", Label: "Generate replacement backup codes", Method: http.MethodPost, Path: "/api/user/2fa/backup_codes", Fields: []field{{Name: "code", Label: "Authenticator code", Type: "code", Required: true}}}},
		},
		{
			ID: "passkey.register", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Register a passkey",
			Steps: []step{
				{ID: "begin", Label: "Create passkey", Method: http.MethodPost, Path: "/api/user/passkey/register/begin", Kind: "passkey-register", ProofScope: "passkey.register"},
				{ID: "finish", Label: "Save passkey", Method: http.MethodPost, Path: "/api/user/passkey/register/finish", ProofScope: "passkey.register", Fields: []field{
					{Name: "flow_token", Label: "Passkey flow", Type: "text", Required: true},
					{Name: "credential", Label: "Passkey response", Type: "json", Required: true},
				}},
			},
		},
		{
			ID: "passkey.delete", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Remove your passkey",
			Steps: []step{{ID: "execute", Label: "Remove passkey", Method: http.MethodDelete, Path: "/api/user/passkey", ProofScope: "passkey.delete"}},
		},
		{
			ID: "identity.email_bind", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Bind an email address",
			Parameters: []field{{Name: "email", Label: "Email address", Type: "text", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Bind email address", Method: http.MethodPost, Path: "/api/oauth/email/bind", Fields: []field{{Name: "code", Label: "Email verification code", Type: "code", Required: true}}}},
		},
		{
			ID: "identity.wechat_bind", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Bind a WeChat account",
			Steps: []step{{ID: "execute", Label: "Bind WeChat account", Method: http.MethodPost, Path: "/api/oauth/wechat/bind", Fields: []field{{Name: "code", Label: "WeChat verification code", Type: "code", Required: true}}}},
		},
		{
			ID: "identity.oauth_bind", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Bind a sign-in provider",
			Parameters: []field{{Name: "provider", Label: "Sign-in provider", Type: "text", Required: true}},
			Steps: []step{
				{ID: "start", Label: "Continue to sign-in provider", Method: http.MethodPost, Path: "/api/oauth/state", Kind: "oauth-bind"},
				{ID: "complete", Label: "Confirm provider binding", Method: http.MethodGet, Path: "/api/oauth/:provider", Fields: []field{{Name: "flow_token", Label: "Binding flow", Type: "text", Required: true}}},
			},
		},
		{
			ID: "identity.telegram_bind", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Bind a Telegram account",
			Steps: []step{
				{ID: "start", Label: "Continue to Telegram", Method: http.MethodPost, Path: "/api/oauth/telegram/bind/start", Kind: "telegram-bind"},
				{ID: "complete", Label: "Confirm Telegram binding", Method: http.MethodGet, Path: "/api/oauth/telegram/bind/:flow_token", Fields: []field{{Name: "flow_token", Label: "Binding flow", Type: "text", Required: true}}},
			},
		},
		{
			ID: "identity.oauth_unbind", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Remove a sign-in provider binding",
			Parameters: []field{{Name: "provider_id", Label: "Provider ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Remove binding", Method: http.MethodDelete, Path: "/api/user/oauth/bindings/:provider_id"}},
		},
		{
			ID: "credential.legacy_generate", Scope: "account_security:write", MinRole: common.RoleCommonUser, Label: "Replace your system access token",
			Steps: []step{{ID: "execute", Label: "Generate system access token", Method: http.MethodGet, Path: "/api/user/token"}},
		},
		{
			ID: "apikey.reveal", Scope: "api_key:reveal", MinRole: common.RoleCommonUser, Label: "Reveal an API key",
			Parameters: []field{{Name: "id", Label: "API key ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Reveal API key", Method: http.MethodPost, Path: "/api/token/:id/key"}},
		},
		{
			ID: "apikey.reveal_batch", Scope: "api_key:reveal", MinRole: common.RoleCommonUser, Label: "Reveal selected API keys",
			Parameters: []field{{Name: "ids", Label: "API key IDs", Type: "json", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Reveal API keys", Method: http.MethodPost, Path: "/api/token/batch/keys"}},
		},
		{
			ID: "channel.key.reveal", Scope: "channel:secret_view", MinRole: common.RoleRootUser, Label: "Reveal a channel credential",
			Parameters: []field{{Name: "id", Label: "Channel ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Reveal channel credential", Method: http.MethodPost, Path: "/api/channel/:id/key", ProofScope: "channel.key.read"}},
		},
		{
			ID: "channel.config.reveal", Scope: "channel:secret_view", MinRole: common.RoleRootUser, Label: "Reveal sensitive channel configuration",
			Parameters: []field{{Name: "id", Label: "Channel ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Reveal channel configuration", Method: http.MethodGet, Path: "/api/channel/:id", ProofScope: "channel.key.read"}},
		},
		{
			ID: "admin.user.create", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Create a user account",
			Parameters: []field{
				{Name: "username", Label: "Username", Type: "text", Required: true},
				{Name: "display_name", Label: "Display name", Type: "text"},
				{Name: "role", Label: "Account role", Type: "number", Required: true},
				{Name: "group", Label: "Primary group", Type: "text"},
				{Name: "groups", Label: "Allowed groups", Type: "json"},
				{Name: "admin_permissions", Label: "Administrator permissions", Type: "json"},
			},
			Steps: []step{{ID: "execute", Label: "Create user", Method: http.MethodPost, Path: "/api/user/", Fields: []field{{Name: "password", Label: "Initial password", Type: "password", Required: true}}}},
		},
		{
			ID: "admin.user.update", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Update a user account",
			Parameters: []field{
				{Name: "id", Label: "User ID", Type: "number", Required: true},
				{Name: "username", Label: "Username", Type: "text", Required: true},
				{Name: "display_name", Label: "Display name", Type: "text"},
				{Name: "email", Label: "Email address", Type: "text"},
				{Name: "status", Label: "Account status", Type: "number"},
				{Name: "remark", Label: "Account remark", Type: "text"},
				{Name: "group", Label: "Primary group", Type: "text"},
				{Name: "groups", Label: "Allowed groups", Type: "json"},
				{Name: "admin_permissions", Label: "Administrator permissions", Type: "json"},
			},
			Steps: []step{{ID: "execute", Label: "Update user", Method: http.MethodPut, Path: "/api/user/", Fields: []field{{Name: "password", Label: "Replacement password (optional)", Type: "password"}}}},
		},
		{
			ID: "admin.user.manage", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Manage a user account",
			Parameters: []field{
				{Name: "id", Label: "User ID", Type: "number", Required: true},
				{Name: "action", Label: "Account action", Type: "text", Required: true},
				{Name: "value", Label: "Quota value", Type: "number"},
				{Name: "mode", Label: "Quota change mode", Type: "text"},
			},
			Steps: []step{{ID: "execute", Label: "Apply account action", Method: http.MethodPost, Path: "/api/user/manage"}},
		},
		{
			ID: "admin.user.delete", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Delete a user account",
			Parameters: []field{{Name: "id", Label: "User ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Delete user", Method: http.MethodDelete, Path: "/api/user/:id"}},
		},
		{
			ID: "admin.user.passkey_reset", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Reset a user's passkey",
			Parameters: []field{{Name: "id", Label: "User ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Reset user passkey", Method: http.MethodDelete, Path: "/api/user/:id/reset_passkey"}},
		},
		{
			ID: "admin.user.mfa_disable", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Disable a user's two-factor authentication",
			Parameters: []field{{Name: "id", Label: "User ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Disable user two-factor authentication", Method: http.MethodDelete, Path: "/api/user/:id/2fa"}},
		},
		{
			ID: "admin.user.binding_clear", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Remove a user's account binding",
			Parameters: []field{
				{Name: "id", Label: "User ID", Type: "number", Required: true},
				{Name: "binding_type", Label: "Binding type", Type: "text", Required: true},
			},
			Steps: []step{{ID: "execute", Label: "Remove account binding", Method: http.MethodDelete, Path: "/api/user/:id/bindings/:binding_type"}},
		},
		{
			ID: "admin.user.oauth_unbind", Scope: "user:write", MinRole: common.RoleAdminUser, Label: "Remove a user's sign-in provider binding",
			Parameters: []field{
				{Name: "id", Label: "User ID", Type: "number", Required: true},
				{Name: "provider_id", Label: "Provider ID", Type: "number", Required: true},
			},
			Steps: []step{{ID: "execute", Label: "Remove sign-in provider binding", Method: http.MethodDelete, Path: "/api/user/:id/oauth/bindings/:provider_id"}},
		},
		{
			ID: "oauth_client.create", Scope: "oauth_clients:write", MinRole: common.RoleRootUser, Label: "Register an OAuth application",
			Parameters: oauthClientActionFields(),
			Steps:      []step{{ID: "execute", Label: "Register OAuth application", Method: http.MethodPost, Path: "/api/oauth_client/"}},
		},
		{
			ID: "oauth_client.update", Scope: "oauth_clients:write", MinRole: common.RoleRootUser, Label: "Update an OAuth application",
			Parameters: append([]field{{Name: "id", Label: "OAuth application ID", Type: "number", Required: true}}, oauthClientActionFields()...),
			Steps:      []step{{ID: "execute", Label: "Update OAuth application", Method: http.MethodPut, Path: "/api/oauth_client/:id"}},
		},
		{
			ID: "oauth_client.delete", Scope: "oauth_clients:write", MinRole: common.RoleRootUser, Label: "Delete an OAuth application",
			Parameters: []field{{Name: "id", Label: "OAuth application ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Delete OAuth application", Method: http.MethodDelete, Path: "/api/oauth_client/:id"}},
		},
		{
			ID: "oauth_client.reset_secret", Scope: "oauth_clients:write", MinRole: common.RoleRootUser, Label: "Replace an OAuth application secret",
			Parameters: []field{{Name: "id", Label: "OAuth application ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Replace client secret", Method: http.MethodPost, Path: "/api/oauth_client/:id/reset_secret"}},
		},
		{
			ID: "oauth_grants.list", Scope: "oauth_grants:read", MinRole: common.RoleCommonUser, Label: "View authorized applications",
			Steps: []step{{ID: "execute", Label: "View authorizations", Method: http.MethodGet, Path: "/api/oauth2/grants"}},
		},
		{
			ID: "oauth_grants.reduce", Scope: "oauth_grants:write", MinRole: common.RoleCommonUser, Label: "Reduce an application's authorization",
			Parameters: []field{
				{Name: "id", Label: "Authorization ID", Type: "number", Required: true},
				{Name: "scopes", Label: "Permissions to retain", Type: "json", Required: true},
			},
			Steps: []step{{ID: "execute", Label: "Reduce authorization", Method: http.MethodPatch, Path: "/api/oauth2/grants/:id"}},
		},
		{
			ID: "oauth_grants.revoke", Scope: "oauth_grants:write", MinRole: common.RoleCommonUser, Label: "Revoke an application's authorization",
			Parameters: []field{{Name: "id", Label: "Authorization ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Revoke authorization", Method: http.MethodDelete, Path: "/api/oauth2/grants/:id"}},
		},
		{
			ID: "app.create", Scope: "app_center:write", MinRole: common.RoleAdminUser, Label: "Create an application center entry",
			Parameters: []field{
				{Name: "name", Label: "Application name", Type: "text", Required: true},
				{Name: "slug", Label: "Application slug", Type: "text", Required: true},
				{Name: "description", Label: "Description", Type: "text"},
				{Name: "public", Label: "Public application", Type: "boolean", Required: true},
				{Name: "telemetry_enabled", Label: "Enable telemetry", Type: "boolean", Required: true},
			},
			Steps: []step{{ID: "execute", Label: "Create application", Method: http.MethodPost, Path: "/api/app-center/apps"}},
		},
		{
			ID: "app.telemetry.reveal", Scope: "app_center:reveal", MinRole: common.RoleAdminUser, Label: "Reveal an application telemetry credential",
			Parameters: []field{{Name: "id", Label: "Application ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Reveal telemetry credential", Method: http.MethodGet, Path: "/api/app-center/apps/:id/telemetry-key"}},
		},
		{
			ID: "app.telemetry.rotate", Scope: "app_center:reveal", MinRole: common.RoleAdminUser, Label: "Replace an application telemetry credential",
			Parameters: []field{{Name: "id", Label: "Application ID", Type: "number", Required: true}},
			Steps:      []step{{ID: "execute", Label: "Replace telemetry credential", Method: http.MethodPost, Path: "/api/app-center/apps/:id/telemetry-key/rotate"}},
		},
		{
			ID: "payment.compliance", Scope: "option:write", MinRole: common.RoleRootUser, Label: "Confirm payment compliance terms",
			Steps: []step{{ID: "execute", Label: "Confirm payment compliance", Method: http.MethodPost, Path: "/api/option/payment_compliance", Fields: []field{{Name: "confirmed", Label: "I confirm the payment compliance terms", Type: "boolean", Required: true}}}},
		},
	}
}

func oauthClientActionFields() []service.OAuthActionField {
	return []service.OAuthActionField{
		{Name: "name", Label: "Application name", Type: "text", Required: true},
		{Name: "description", Label: "Description", Type: "text"},
		{Name: "redirect_uris", Label: "Registered callback URLs", Type: "json", Required: true},
		{Name: "scopes", Label: "Allowed permissions", Type: "json", Required: true},
		{Name: "is_public", Label: "Public client", Type: "boolean", Required: true},
		{Name: "enabled", Label: "Enabled", Type: "boolean", Required: true},
	}
}

// oauthActionHandler must stay aligned with the catalog. Returning nil is
// intentional fail-closed behavior for unknown operations or ceremony steps.
func oauthActionHandler(operation, step string) gin.HandlerFunc {
	switch operation + ":" + step {
	case "app_payment.configure:execute":
		return SaveAppPaymentApplication
	case "app_payment.rotate_secret:execute":
		return RotateAppPaymentWebhookSecret
	case "app_payment.retry_webhook:execute":
		return RetryAppPaymentWebhookEvent

	case "password.change:execute":
		return oauthActionChangePassword
	case "profile.update:execute":
		return oauthActionUpdateProfile
	case "account.delete:execute":
		return DeleteSelf
	case "sessions.list:execute":
		return GetLoginSessions
	case "sessions.revoke:execute":
		return DeleteLoginSession
	case "sessions.revoke_others:execute":
		return RevokeOtherLoginSessions
	case "mfa.setup:setup":
		return Setup2FA
	case "mfa.setup:enable", "mfa.enable:execute":
		return Enable2FA
	case "mfa.disable:execute":
		return Disable2FA
	case "mfa.backup_codes:execute":
		return RegenerateBackupCodes
	case "passkey.register:begin":
		return PasskeyRegisterBegin
	case "passkey.register:finish":
		return PasskeyRegisterFinish
	case "passkey.delete:execute":
		return PasskeyDelete
	case "identity.email_bind:execute":
		return EmailBind
	case "identity.wechat_bind:execute":
		return WeChatBind
	case "identity.oauth_bind:start":
		return oauthActionStartProviderBinding
	case "identity.telegram_bind:start":
		return TelegramBindStart
	case "identity.oauth_bind:complete", "identity.telegram_bind:complete":
		return OAuthActionBindingComplete
	case "identity.oauth_unbind:execute":
		return UnbindCustomOAuth
	case "credential.legacy_generate:execute":
		return GenerateAccessToken
	case "apikey.reveal:execute":
		return GetTokenKey
	case "apikey.reveal_batch:execute":
		return GetTokenKeysBatch
	case "channel.key.reveal:execute":
		return GetChannelKey
	case "channel.config.reveal:execute":
		return GetChannel
	case "admin.user.create:execute":
		return CreateUser
	case "admin.user.update:execute":
		return UpdateUser
	case "admin.user.manage:execute":
		return ManageUser
	case "admin.user.delete:execute":
		return DeleteUser
	case "admin.user.passkey_reset:execute":
		return AdminResetPasskey
	case "admin.user.mfa_disable:execute":
		return AdminDisable2FA
	case "admin.user.binding_clear:execute":
		return AdminClearUserBinding
	case "admin.user.oauth_unbind:execute":
		return UnbindCustomOAuthByAdmin
	case "oauth_client.create:execute":
		return CreateOauthClient
	case "oauth_client.update:execute":
		return UpdateOauthClient
	case "oauth_client.delete:execute":
		return DeleteOauthClient
	case "oauth_client.reset_secret:execute":
		return ResetOauthClientSecret
	case "oauth_grants.list:execute":
		return GetOAuthGrants
	case "oauth_grants.reduce:execute":
		return PatchOAuthGrant
	case "oauth_grants.revoke:execute":
		return DeleteOAuthGrant
	case "app.create:execute":
		return CreateAppCenterApp
	case "app.telemetry.reveal:execute":
		return RevealAppCenterTelemetryKey
	case "app.telemetry.rotate:execute":
		return RotateAppCenterTelemetryKey
	case "payment.compliance:execute":
		return ConfirmPaymentCompliance
	default:
		return nil
	}
}

func oauthActionChangePassword(c *gin.Context) {
	var input struct {
		OriginalPassword string `json:"original_password"`
		Password         string `json:"password"`
	}
	if err := common.DecodeJsonStrict(c.Request.Body, &input); err != nil || input.OriginalPassword == "" || input.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Both current and new passwords are required"})
		return
	}
	user, err := model.GetUserById(c.GetInt("id"), false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// Password changes must not overwrite the profile or smuggle arbitrary
	// user fields through UpdateSelf's multiplexed request format.
	body, err := common.Marshal(map[string]string{
		"username": user.Username, "display_name": user.DisplayName,
		"original_password": input.OriginalPassword, "password": input.Password,
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	c.Request.ContentLength = int64(len(body))
	UpdateSelf(c)
}

func oauthActionUpdateProfile(c *gin.Context) {
	var input struct {
		Username       *string `json:"username"`
		DisplayName    *string `json:"display_name"`
		Language       *string `json:"language"`
		SidebarModules *string `json:"sidebar_modules"`
	}
	if err := common.DecodeJsonStrict(c.Request.Body, &input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Invalid profile fields"})
		return
	}
	payload := make(map[string]string)
	switch {
	case input.SidebarModules != nil:
		payload["sidebar_modules"] = *input.SidebarModules
	case input.Language != nil:
		payload["language"] = *input.Language
	default:
		user, err := model.GetUserById(c.GetInt("id"), false)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		payload["username"], payload["display_name"] = user.Username, user.DisplayName
		if input.Username != nil {
			payload["username"] = *input.Username
		}
		if input.DisplayName != nil {
			payload["display_name"] = *input.DisplayName
		}
	}
	body, err := common.Marshal(payload)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	c.Request.ContentLength = int64(len(body))
	UpdateSelf(c)
}

func oauthActionStartProviderBinding(c *gin.Context) {
	var input struct {
		Provider string `json:"provider"`
	}
	if err := common.DecodeJsonStrict(c.Request.Body, &input); err != nil || input.Provider == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "A sign-in provider is required"})
		return
	}
	body, err := common.Marshal(oauthStateRequest{Provider: input.Provider, Intent: model.AuthFlowIntentBind})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	c.Request.ContentLength = int64(len(body))
	GenerateOAuthCode(c)
}
