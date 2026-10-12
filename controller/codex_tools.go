package controller

import (
	"bytes"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
)

type codexAccountTool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Mutating    bool                   `json:"mutating"`
	InputSchema map[string]interface{} `json:"inputSchema"`
	Method      string                 `json:"-"`
	Path        string                 `json:"-"`
	Handler     gin.HandlerFunc        `json:"-"`
	Fields      map[string]string      `json:"-"`
	BrowserURL  string                 `json:"browserUrl,omitempty"`
}

func newCodexAccountTool(name, description, method, path string, handler gin.HandlerFunc, fields map[string]string) codexAccountTool {
	properties := map[string]interface{}{}
	for field, kind := range fields {
		properties[field] = map[string]interface{}{"type": kind}
		if kind == "array" {
			properties[field].(map[string]interface{})["items"] = map[string]interface{}{"type": "string"}
		}
	}
	return codexAccountTool{Name: name, Description: description, Mutating: method != "GET" || name == "wallet.referral", Method: method, Path: path, Handler: handler, Fields: fields, InputSchema: map[string]interface{}{"type": "object", "properties": properties, "additionalProperties": false}}
}

// Fixed operations use existing owner-checked controllers. No caller chooses
// an HTTP path, administrator role, owner id, or authentication headers.
var codexAccountTools = []codexAccountTool{
	newCodexAccountTool("profile.get", "Read your account and current preferences; secrets are redacted", "GET", "/api/user/self", GetSelf, nil),
	newCodexAccountTool("profile.update", "Update username or display_name; omitted fields retain their current values", "PUT", "/api/user/self", UpdateSelf, map[string]string{"username": "string", "display_name": "string"}),
	newCodexAccountTool("preferences.update", "Update notification, language, sidebar or logging preferences; omitted settings are preserved. Configure secret values in the profile page", "PUT", "/api/user/setting", UpdateUserSetting, map[string]string{"language": "string", "sidebar_modules": "string", "notify_type": "string", "quota_warning_threshold": "number", "webhook_url": "string", "notification_email": "string", "bark_url": "string", "gotify_url": "string", "gotify_priority": "integer", "accept_unset_model_ratio_model": "boolean", "record_ip_log": "boolean"}),
	newCodexAccountTool("groups.list", "List your available user groups", "GET", "/api/user/self/groups", GetUserGroups, nil),
	newCodexAccountTool("models.list", "List models available to your account", "GET", "/api/user/models", GetUserModels, nil),
	newCodexAccountTool("codex.config", "Read your effective Codex access and resource limits; only administrators can grant resources or host execution", "GET", "/api/user/self/codex-config", GetSelfCodexConfig, nil),
	newCodexAccountTool("tokens.list", "List your API tokens with masked keys; page_size is limited to 50", "GET", "/api/token/", GetAllTokens, map[string]string{"p": "integer", "page_size": "integer"}),
	newCodexAccountTool("tokens.search", "Search your API tokens by keyword", "GET", "/api/token/search", SearchTokens, map[string]string{"keyword": "string", "p": "integer", "page_size": "integer"}),
	newCodexAccountTool("tokens.get", "Read one of your API tokens with its key masked", "GET", "/api/token/:id", GetToken, map[string]string{"id": "integer"}),
	newCodexAccountTool("tokens.groups", "Read groups available for automatic token routing", "GET", "/api/token/auto-groups", GetTokenAutoGroups, nil),
	newCodexAccountTool("tokens.create", "Create an API token. No plaintext key is returned. Use tokens.reveal to open the key page", "POST", "/api/token/", AddToken, map[string]string{"name": "string", "expired_time": "integer", "remain_quota": "integer", "unlimited_quota": "boolean", "model_limits_enabled": "boolean", "model_limits": "string", "allow_ips": "string", "group": "string", "auto_groups": "array", "cross_group_retry": "boolean"}),
	newCodexAccountTool("tokens.update", "Update one of your API tokens; id is required and omitted fields are retained", "PUT", "/api/token/", UpdateToken, map[string]string{"id": "integer", "name": "string", "status": "integer", "expired_time": "integer", "remain_quota": "integer", "unlimited_quota": "boolean", "model_limits_enabled": "boolean", "model_limits": "string", "allow_ips": "string", "group": "string", "auto_groups": "array", "cross_group_retry": "boolean"}),
	newCodexAccountTool("tokens.delete", "Delete one of your API tokens; id is required", "DELETE", "/api/token/:id", DeleteToken, map[string]string{"id": "integer"}),
	newCodexAccountTool("subscription.get", "Read your subscriptions and billing preference", "GET", "/api/subscription/self", GetSubscriptionSelf, nil),
	newCodexAccountTool("subscription.plans", "List available subscription plans and Codex benefits", "GET", "/api/subscription/plans", GetSubscriptionPlans, nil),
	newCodexAccountTool("subscription.preference", "Set billing_preference to subscription_first, wallet_first, subscription_only or wallet_only", "PUT", "/api/subscription/self/preference", UpdateSubscriptionPreference, map[string]string{"billing_preference": "string"}),
	newCodexAccountTool("wallet.info", "Read available top-up options", "GET", "/api/user/topup/info", GetTopUpInfo, nil),
	newCodexAccountTool("wallet.history", "Read your top-up history", "GET", "/api/user/topup/self", GetUserTopUps, map[string]string{"p": "integer", "page_size": "integer"}),
	newCodexAccountTool("wallet.referral", "Read or initialize your referral code", "GET", "/api/user/aff", GetAffCode, nil),
	newCodexAccountTool("checkin.status", "Read check-in status for your account", "GET", "/api/user/checkin", GetCheckinStatus, map[string]string{"month": "string"}),
	newCodexAccountTool("checkin.claim", "Claim your daily check-in reward", "POST", "/api/user/checkin", DoCheckin, nil),
	newCodexAccountTool("usage.logs", "Read your usage logs; page_size is limited to 50", "GET", "/api/log/self", GetUserLogs, map[string]string{"p": "integer", "page_size": "integer", "type": "integer", "start_timestamp": "integer", "end_timestamp": "integer", "model_name": "string", "token_name": "string", "group": "string", "request_id": "string"}),
	newCodexAccountTool("usage.stats", "Read your aggregate usage statistics", "GET", "/api/log/self/stat", GetLogsSelfStat, map[string]string{"type": "integer", "start_timestamp": "integer", "end_timestamp": "integer", "model_name": "string", "token_name": "string"}),
	newCodexAccountTool("security.mfa_status", "Read whether two-factor authentication is enabled", "GET", "/api/user/2fa/status", Get2FAStatus, nil),
	newCodexAccountTool("security.passkey_status", "Read your passkey status", "GET", "/api/user/passkey", PasskeyStatus, nil),
	newCodexAccountTool("security.bindings", "Read your connected identity providers", "GET", "/api/user/oauth/bindings", GetUserOAuthBindings, nil),
}

func init() {
	// Existing browser flows retain password, verification and payment checks.
	for _, operation := range []struct{ name, description, path string }{
		{"security.password", "Open your profile to change your password", "/profile"},
		{"security.mfa", "Open your profile to set up or disable MFA and manage recovery codes", "/profile"},
		{"security.passkeys", "Open your profile to register or remove a passkey", "/profile"},
		{"security.identities", "Open your profile to bind or unbind an identity provider or email", "/profile"},
		{"security.sessions", "Open your profile to inspect or revoke login sessions", "/profile"},
		{"security.authorizations", "Open your profile to inspect, reduce or revoke application grants", "/profile"},
		{"security.delete_account", "Open your profile to delete your account after its existing checks", "/profile"},
		{"tokens.reveal", "Open your API key page; plaintext credentials never enter tool results", "/keys"},
		{"wallet.manage", "Open your wallet to pay, redeem a code, buy a plan or transfer referral rewards", "/wallet"},
		{"codex.preferences", "Open Codex settings to change browser-local model, effort, theme and approval preferences", "/codex"},
	} {
		tool := newCodexAccountTool(operation.name, operation.description, "GET", "", nil, nil)
		tool.BrowserURL = operation.path
		codexAccountTools = append(codexAccountTools, tool)
	}
}

func CodexToolsCatalog(c *gin.Context) {
	policy, err := model.GetEffectiveCodexUserPolicy(c.GetInt("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"tools": codexAccountTools, "allowHost": policy.AllowHost && policy.Enabled, "allowDocker": policy.AllowDocker && policy.Enabled, "scope": "own-account"})
}

func CodexToolsCall(c *gin.Context) {
	var input struct {
		Name      string                 `json:"name"`
		Arguments map[string]interface{} `json:"arguments"`
		Confirmed bool                   `json:"confirmed"`
	}
	if err := common.DecodeJsonStrict(http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10), &input); err != nil {
		c.JSON(400, gin.H{"success": false, "message": "Invalid tool request"})
		return
	}
	var tool *codexAccountTool
	for index := range codexAccountTools {
		if codexAccountTools[index].Name == input.Name {
			tool = &codexAccountTools[index]
			break
		}
	}
	if tool == nil {
		c.JSON(404, gin.H{"success": false, "message": "Unknown account tool"})
		return
	}
	if tool.Name == "subscription.preference" {
		value, ok := input.Arguments["billing_preference"].(string)
		if !ok || (value != "subscription_first" && value != "wallet_first" && value != "subscription_only" && value != "wallet_only") {
			c.JSON(400, gin.H{"success": false, "message": "Choose a supported billing preference"})
			return
		}
	}
	if tool.BrowserURL != "" {
		browserURL := tool.BrowserURL
		if base, err := url.Parse(system_setting.ServerAddress); err == nil && (base.Scheme == "https" || base.Scheme == "http") && base.Host != "" && base.User == nil && base.RawQuery == "" && base.Fragment == "" {
			browserURL = base.ResolveReference(&url.URL{Path: tool.BrowserURL}).String()
		}
		common.ApiSuccess(c, gin.H{"interaction_required": true, "url": browserURL, "message": tool.Description})
		return
	}
	for field, value := range input.Arguments {
		kind, allowed := tool.Fields[field]
		valid := false
		switch kind {
		case "string":
			v, ok := value.(string)
			valid = ok && len(v) <= 4096 && !strings.ContainsRune(v, '\x00')
		case "boolean":
			_, valid = value.(bool)
		case "integer", "number":
			v, ok := value.(float64)
			valid = ok && !math.IsNaN(v) && !math.IsInf(v, 0) && math.Abs(v) <= float64(math.MaxInt32)
			if kind == "integer" {
				valid = valid && math.Trunc(v) == v
			}
		case "array":
			v, ok := value.([]interface{})
			valid = ok && len(v) <= 64
			for _, item := range v {
				text, ok := item.(string)
				valid = valid && ok && len(text) <= 64
			}
		}
		if !allowed || !valid {
			c.JSON(400, gin.H{"success": false, "message": "Invalid or unsupported tool argument: " + field})
			return
		}
	}
	if tool.Mutating && !input.Confirmed {
		c.JSON(409, gin.H{"success": false, "code": "codex_tool_confirmation_required", "message": "The runner must apply the selected approval mode before changing account settings"})
		return
	}
	arguments := input.Arguments
	if arguments == nil {
		arguments = map[string]interface{}{}
	}
	path := tool.Path
	parameters := gin.Params{}
	if strings.Contains(path, ":id") || tool.Name == "tokens.update" {
		id, ok := arguments["id"].(float64)
		if !ok || id <= 0 {
			c.JSON(400, gin.H{"success": false, "message": "A positive token id is required"})
			return
		}
		parameters = append(parameters, gin.Param{Key: "id", Value: strconv.Itoa(int(id))})
		path = strings.ReplaceAll(path, ":id", strconv.Itoa(int(id)))
	}
	if tool.Name == "tokens.create" {
		if _, exists := arguments["expired_time"]; !exists {
			arguments["expired_time"] = float64(-1)
		}
	}
	if tool.Name == "profile.update" {
		user, err := model.GetUserById(c.GetInt("id"), false)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if _, ok := arguments["username"]; !ok {
			arguments["username"] = user.Username
		}
		if _, ok := arguments["display_name"]; !ok {
			arguments["display_name"] = user.DisplayName
		}
	}
	if tool.Name == "tokens.update" {
		existing, err := model.GetTokenByIds(int(arguments["id"].(float64)), c.GetInt("id"))
		if err != nil {
			c.JSON(404, gin.H{"success": false, "message": "Token not found"})
			return
		}
		data, err := common.Marshal(buildMaskedTokenResponse(existing, false))
		if err != nil {
			common.ApiError(c, err)
			return
		}
		merged := map[string]interface{}{}
		if err = common.Unmarshal(data, &merged); err != nil {
			common.ApiError(c, err)
			return
		}
		for key, value := range arguments {
			merged[key] = value
		}
		arguments = merged
	}
	if tool.Name == "preferences.update" {
		codexUpdatePreferences(c, arguments)
		return
	}
	query := url.Values{}
	if tool.Method == "GET" {
		query.Set("page_size", "50")
		for field, value := range arguments {
			if field == "id" {
				continue
			}
			if field == "page_size" && (value.(float64) < 1 || value.(float64) > 50) {
				c.JSON(400, gin.H{"success": false, "message": "page_size must be between 1 and 50"})
				return
			}
			query.Set(field, fmt.Sprint(value))
		}
	}
	body, err := common.Marshal(arguments)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	recorder := httptest.NewRecorder()
	inner, _ := gin.CreateTestContext(recorder)
	inner.Request = httptest.NewRequest(tool.Method, path+"?"+query.Encode(), bytes.NewReader(body))
	inner.Request.Header.Set("Content-Type", "application/json")
	// Copy only authenticated context, never caller headers or an arbitrary role.
	inner.Keys = c.Copy().Keys
	inner.Params = parameters
	tool.Handler(inner)
	var result interface{}
	if recorder.Body.Len() > 512<<10 {
		c.JSON(413, gin.H{"success": false, "message": "Tool result is too large; narrow the query"})
		return
	}
	if err = common.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		c.JSON(502, gin.H{"success": false, "message": "Tool returned an invalid result"})
		return
	}
	c.JSON(recorder.Code, codexRedactToolResult(result))
}

func codexUpdatePreferences(c *gin.Context, changes map[string]interface{}) {
	user, err := model.GetUserById(c.GetInt("id"), false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	existing := user.GetSetting()
	if value, present := changes["record_ip_log"]; present {
		existing.RecordIpLog = value.(bool)
		delete(changes, "record_ip_log")
	}
	if value, present := changes["accept_unset_model_ratio_model"]; present {
		existing.AcceptUnsetRatioModel = value.(bool)
		delete(changes, "accept_unset_model_ratio_model")
	}
	language, hasLanguage := changes["language"]
	sidebar, hasSidebar := changes["sidebar_modules"]
	delete(changes, "language")
	delete(changes, "sidebar_modules")
	if hasLanguage {
		switch language.(string) {
		case "en", "zh", "zh-TW", "fr", "ru", "ja", "vi":
		default:
			c.JSON(400, gin.H{"success": false, "message": "Unsupported language"})
			return
		}
	}
	if hasSidebar {
		var value map[string]interface{}
		if common.UnmarshalJsonStr(sidebar.(string), &value) != nil {
			c.JSON(400, gin.H{"success": false, "message": "sidebar_modules must contain a JSON object"})
			return
		}
	}
	if len(changes) > 0 {
		raw, err := common.Marshal(existing)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		merged := map[string]interface{}{}
		if err = common.Unmarshal(raw, &merged); err != nil {
			common.ApiError(c, err)
			return
		}
		for key, value := range changes {
			merged[key] = value
		}
		raw, err = common.Marshal(merged)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		recorder := httptest.NewRecorder()
		inner, _ := gin.CreateTestContext(recorder)
		inner.Keys = c.Copy().Keys
		inner.Request = httptest.NewRequest("PUT", "/api/user/setting", bytes.NewReader(raw))
		inner.Request.Header.Set("Content-Type", "application/json")
		UpdateUserSetting(inner)
		var result struct {
			Success bool `json:"success"`
		}
		if common.Unmarshal(recorder.Body.Bytes(), &result) != nil || !result.Success {
			c.Data(recorder.Code, "application/json", recorder.Body.Bytes())
			return
		}
		user, err = model.GetUserById(c.GetInt("id"), false)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		existing = user.GetSetting()
	}
	if hasLanguage {
		existing.Language = language.(string)
	}
	if hasSidebar {
		existing.SidebarModules = sidebar.(string)
	}
	if err = model.UpdateUserSetting(user.Id, existing); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

func codexRedactToolResult(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, item := range typed {
			switch strings.ToLower(key) {
			case "password", "original_password", "access_token", "key", "webhook_secret", "gotify_token", "refresh_token", "client_secret", "backup_codes", "secret":
				typed[key] = "[REDACTED]"
			case "setting":
				if text, ok := item.(string); ok {
					var settings interface{}
					if common.UnmarshalJsonStr(text, &settings) == nil {
						typed[key] = codexRedactToolResult(settings)
					}
				}
			default:
				typed[key] = codexRedactToolResult(item)
			}
		}
	case []interface{}:
		for index, item := range typed {
			typed[index] = codexRedactToolResult(item)
		}
	}
	return value
}
