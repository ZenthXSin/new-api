package controller

import (
	"bytes"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/oauth"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func oauthActionError(c *gin.Context, status int) {
	c.Header("Cache-Control", "no-store")
	c.JSON(status, gin.H{"success": false, "code": "OAUTH_ACTION_UNAVAILABLE", "message": "The operation is unavailable, expired, or requires a new authorization."})
}
func oauthActionPublicData(action *model.OAuthAction) gin.H {
	status := action.Status
	if time.Now().Unix() >= action.ExpiresAt {
		status = "expired"
	}
	data := gin.H{"action_id": action.ID, "operation": action.Operation, "status": status, "expires_at": action.ExpiresAt, "completed_at": action.CompletedAt}
	if status == "completed" {
		data["receipt"] = gin.H{"completed": true, "shared_result": action.ShareResult, "result_claimed": action.ResultClaimedAt != 0}
	}
	return data
}
func GetOAuthActionOperations(c *gin.Context) {
	ops := service.OAuthActionOperations()
	if p, ok := middleware.GetOAuthPrincipal(c); ok {
		filtered := make([]service.OAuthActionOperation, 0, len(ops))
		for _, op := range ops {
			if service.ValidateOAuthActionPrincipal(p, op) == nil {
				filtered = append(filtered, op)
			}
		}
		ops = filtered
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": ops})
}
func CreateOAuthAction(c *gin.Context) {
	principal, ok := middleware.GetOAuthPrincipal(c)
	if !ok {
		oauthActionError(c, http.StatusForbidden)
		return
	}
	var request struct {
		Operation   string         `json:"operation"`
		Parameters  map[string]any `json:"parameters"`
		ShareResult bool           `json:"share_result"`
		ReturnURI   string         `json:"return_uri"`
		State       string         `json:"state"`
	}
	if err := common.DecodeJsonStrict(http.MaxBytesReader(c.Writer, c.Request.Body, 48<<10), &request); err != nil {
		oauthActionError(c, http.StatusBadRequest)
		return
	}
	action, receipt, err := service.CreateOAuthHostedAction(principal, request.Operation, request.Parameters, request.ShareResult, request.ReturnURI, request.State)
	if err != nil {
		oauthActionError(c, http.StatusBadRequest)
		return
	}
	data := oauthActionPublicData(action)
	data["approval_url"] = "/oauth/actions/" + action.ID
	data["receipt_token"] = receipt
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": data})
}
func GetOAuthAction(c *gin.Context) {
	action, err := service.GetOAuthHostedAction(c.Param("id"))
	if err != nil {
		oauthActionError(c, http.StatusNotFound)
		return
	}
	raw, ok := dashboardBearer(c.GetHeader("Authorization"))
	if !ok {
		oauthActionError(c, http.StatusUnauthorized)
		return
	}
	if !service.OAuthActionReceiptMatches(action, raw) {
		p, recognized, err := service.AuthenticateOAuthAccessToken(raw)
		if err != nil || !recognized || p == nil || p.UserID != action.UserID || p.ClientID != action.ClientID || p.GrantID != action.GrantID {
			oauthActionError(c, http.StatusUnauthorized)
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": oauthActionPublicData(action)})
}

// A real dashboard bearer and same-origin browser context are both required.
// An OAuth bearer, cookie alone, or forged action nonce cannot create a session.
func oauthActionBrowserSession(c *gin.Context) (service.AuthIdentity, bool) {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	if !ok {
		oauthActionError(c, http.StatusUnauthorized)
		return service.AuthIdentity{}, false
	}
	if _, _, err := service.ValidateLoginSession(identity); err != nil {
		oauthActionError(c, http.StatusUnauthorized)
		return service.AuthIdentity{}, false
	}
	if c.GetHeader("Sec-Fetch-Site") == "cross-site" {
		oauthActionError(c, http.StatusForbidden)
		return service.AuthIdentity{}, false
	}
	origin := c.GetHeader("Origin")
	if origin == "" {
		if referer, err := url.Parse(c.GetHeader("Referer")); err == nil && referer.Host != "" {
			origin = referer.Scheme + "://" + referer.Host
		}
	}
	if origin != "" {
		normalized, err := common.NormalizeOrigin(origin)
		if err != nil {
			oauthActionError(c, http.StatusForbidden)
			return service.AuthIdentity{}, false
		}
		scheme := "http"
		if c.Request.TLS != nil {
			scheme = "https"
		}
		expected, _ := common.NormalizeOrigin(scheme + "://" + c.Request.Host)
		allowed := normalized == expected
		for _, trusted := range common.SessionCookieTrustedURLs {
			allowed = allowed || normalized == trusted
		}
		if !allowed {
			oauthActionError(c, http.StatusForbidden)
			return service.AuthIdentity{}, false
		}
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Frame-Options", "DENY")
	c.Header("Referrer-Policy", "no-referrer")
	return identity, true
}
func GetOAuthActionApproval(c *gin.Context) {
	identity, ok := oauthActionBrowserSession(c)
	if !ok {
		return
	}
	action, err := service.GetOAuthHostedAction(c.Param("id"))
	if err != nil || action.UserID != identity.UserID {
		oauthActionError(c, http.StatusNotFound)
		return
	}
	terminal := action.Status == "completed" || action.Status == "rejected" || action.Status == "failed" || time.Now().Unix() >= action.ExpiresAt
	nonce := ""
	if !terminal {
		nonce, err = service.BindOAuthActionSession(action, identity)
		if err != nil {
			oauthActionError(c, http.StatusForbidden)
			return
		}
	}
	op, _ := service.OAuthActionOperationByID(action.Operation)
	client, err := model.GetOauthClientByClientId(action.ClientID)
	clientName := action.ClientID
	if err == nil {
		clientName = client.Name
	} else if !terminal {
		oauthActionError(c, http.StatusForbidden)
		return
	}
	var parameters map[string]any
	if common.UnmarshalJsonStr(action.Parameters, &parameters) != nil {
		oauthActionError(c, http.StatusInternalServerError)
		return
	}
	steps := make([]gin.H, 0, len(op.Steps))
	twoFA, err := model.GetTwoFAByUserId(identity.UserID)
	if err != nil {
		oauthActionError(c, http.StatusInternalServerError)
		return
	}
	hasMFA := twoFA != nil && twoFA.IsEnabled
	for i, step := range op.Steps {
		state := "pending"
		if i < action.StepIndex {
			state = "completed"
		}
		proof := step.ProofScope
		if action.Operation == "passkey.register" && !hasMFA {
			proof = ""
		}
		fields := step.Fields
		if fields == nil {
			fields = []service.OAuthActionField{}
		}
		steps = append(steps, gin.H{"id": step.ID, "label": step.Label, "method": step.Method, "path": step.Path, "kind": step.Kind, "proof_scope": proof, "fields": fields, "state": state})
	}
	current := ""
	if !terminal && action.StepIndex < len(op.Steps) {
		current = op.Steps[action.StepIndex].ID
	}
	data := oauthActionPublicData(action)
	data["client_name"] = clientName
	data["label"] = op.Label
	data["parameters"] = parameters
	data["steps"] = steps
	data["current_step_id"] = current
	data["approval_nonce"] = nonce
	data["share_result"] = action.ShareResult
	data["result_kind"] = "receipt"
	if action.ShareResult {
		data["result_kind"] = service.OAuthActionResultKind(action.Operation)
	}
	data["return_uri"] = service.OAuthActionReturnURI(action)
	data["verification_scope"] = "channel.key.read"
	data["has_two_factor"] = hasMFA
	user, userErr := model.GetUserById(identity.UserID, true)
	data["has_password"] = userErr == nil && user.Password != ""
	data["bootstrap_operation"] = action.Operation == "mfa.setup" || action.Operation == "passkey.register"
	data["bootstrap_allowed"] = !terminal && service.OAuthActionBootstrapAllowed(action, identity)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

type oauthActionApprovalRequest struct {
	ApprovalNonce        string         `json:"approval_nonce"`
	VerificationPassword string         `json:"verification_password,omitempty"`
	Input                map[string]any `json:"input,omitempty"`
}

func oauthActionBoundRequest(c *gin.Context) (*model.OAuthAction, service.AuthIdentity, oauthActionApprovalRequest, bool) {
	identity, ok := oauthActionBrowserSession(c)
	if !ok {
		return nil, identity, oauthActionApprovalRequest{}, false
	}
	var request oauthActionApprovalRequest
	if common.DecodeJsonStrict(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10), &request) != nil {
		oauthActionError(c, http.StatusBadRequest)
		return nil, identity, request, false
	}
	action, err := service.GetOAuthHostedAction(c.Param("id"))
	if err != nil || !service.OAuthActionSessionMatches(action, identity, request.ApprovalNonce) {
		oauthActionError(c, http.StatusForbidden)
		return nil, identity, request, false
	}
	if _, err := service.RevalidateOAuthHostedAction(action); err != nil {
		oauthActionError(c, http.StatusForbidden)
		return nil, identity, request, false
	}
	return action, identity, request, true
}
func ApproveOAuthAction(c *gin.Context) {
	action, identity, request, ok := oauthActionBoundRequest(c)
	if !ok {
		return
	}
	proof := strings.TrimSpace(c.GetHeader("X-Security-Proof"))
	verified := false
	if proof != "" {
		_, err := service.VerifySecurityProof(proof, identity, "channel.key.read", []string{"2fa", "passkey"})
		verified = err == nil
	} else if request.VerificationPassword != "" && len(request.VerificationPassword) <= 256 {
		twoFA, err := model.GetTwoFAByUserId(identity.UserID)
		if err == nil && (twoFA == nil || !twoFA.IsEnabled) {
			user, err := model.GetUserById(identity.UserID, true)
			verified = err == nil && user != nil && user.Password != "" && common.ValidatePasswordAndHash(request.VerificationPassword, user.Password)
		}
	}
	if !verified && service.OAuthActionBootstrapAllowed(action, identity) {
		if err := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND status = ?", action.ID, "pending").Update("bootstrap", true).Error; err != nil {
			oauthActionError(c, http.StatusInternalServerError)
			return
		}
		action.Bootstrap = true
		verified = true
	}
	if !verified {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "code": "OAUTH_ACTION_VERIFICATION_REQUIRED", "message": "Confirm your identity on this site before approving this operation."})
		return
	}
	if err := service.ApproveOAuthHostedAction(action); err != nil {
		oauthActionError(c, http.StatusConflict)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": oauthActionPublicData(action)})
}
func RejectOAuthAction(c *gin.Context) {
	action, _, _, ok := oauthActionBoundRequest(c)
	if !ok {
		return
	}
	result := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND status IN ?", action.ID, []string{"pending", "approved"}).Update("status", "rejected")
	if result.Error != nil || result.RowsAffected != 1 {
		oauthActionError(c, http.StatusConflict)
		return
	}
	action.Status = "rejected"
	data := oauthActionPublicData(action)
	data["return_uri"] = service.OAuthActionReturnURI(action)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}
func ExecuteOAuthActionStep(c *gin.Context) {
	action, identity, request, ok := oauthActionBoundRequest(c)
	if !ok {
		return
	}
	op, exists := service.OAuthActionOperationByID(action.Operation)
	if !exists || action.StepIndex < 0 || action.StepIndex >= len(op.Steps) || op.Steps[action.StepIndex].ID != c.Param("step") {
		oauthActionError(c, http.StatusConflict)
		return
	}
	if action.Bootstrap && !service.OAuthActionBootstrapAllowed(action, identity) {
		oauthActionError(c, http.StatusForbidden)
		return
	}
	step := op.Steps[action.StepIndex]
	handler := oauthActionHandler(action.Operation, step.ID)
	if handler == nil {
		oauthActionError(c, http.StatusBadRequest)
		return
	}
	input, err := service.ValidateOAuthActionFields(request.Input, step.Fields)
	if err != nil {
		oauthActionError(c, http.StatusBadRequest)
		return
	}
	if action.FlowHash != "" {
		if flow, ok := input["flow_token"].(string); ok && service.OAuthActionHash(flow) != action.FlowHash {
			oauthActionError(c, http.StatusForbidden)
			return
		}
	}
	var parameters map[string]any
	if err := common.UnmarshalJsonStr(action.Parameters, &parameters); err != nil {
		oauthActionError(c, http.StatusInternalServerError)
		return
	}
	for name := range input {
		if _, exists := parameters[name]; exists {
			oauthActionError(c, http.StatusBadRequest)
			return
		}
	}
	body := maps.Clone(parameters)
	maps.Copy(body, input)
	routePath := step.Path
	params := make(gin.Params, 0)
	for _, segment := range strings.Split(step.Path, "/") {
		if !strings.HasPrefix(segment, ":") {
			continue
		}
		name := strings.TrimPrefix(segment, ":")
		value, exists := body[name]
		if !exists {
			oauthActionError(c, http.StatusBadRequest)
			return
		}
		text := fmt.Sprint(value)
		if number, ok := value.(float64); ok {
			text = strconv.FormatInt(int64(number), 10)
		}
		if strings.ContainsAny(text, "/\\?#\x00\r\n") || text == "" {
			oauthActionError(c, http.StatusBadRequest)
			return
		}
		params = append(params, gin.Param{Key: name, Value: text})
		routePath = strings.ReplaceAll(routePath, ":"+name, text)
		delete(body, name)
	}
	if action.Operation == "identity.oauth_bind" && step.ID == "complete" {
		body["provider"] = parameters["provider"]
	}
	if action.Operation == "identity.telegram_bind" && step.ID == "complete" {
		body["flow_token"] = input["flow_token"]
	}
	if step.ID == "start" && (action.Operation == "identity.oauth_bind" || action.Operation == "identity.telegram_bind") {
		before, err := oauthActionBindingValue(action, parameters)
		if err != nil {
			oauthActionError(c, http.StatusBadRequest)
			return
		}
		action.BindingBeforeHash = service.OAuthActionHash(before)
		if err := model.DB.Model(action).Update("binding_before_hash", action.BindingBeforeHash).Error; err != nil {
			oauthActionError(c, http.StatusInternalServerError)
			return
		}
	}
	encoded, err := common.Marshal(body)
	if err != nil {
		oauthActionError(c, http.StatusBadRequest)
		return
	}
	principal, err := service.RevalidateOAuthHostedAction(action)
	if err != nil {
		oauthActionError(c, http.StatusForbidden)
		return
	}
	if err := service.ClaimOAuthActionStep(action, action.StepIndex); err != nil {
		oauthActionError(c, http.StatusConflict)
		return
	}
	// A fresh Gin context contains only server-provided identity. Neither the
	// delegated access token nor application-supplied headers are forwarded.
	recorder := httptest.NewRecorder()
	inner, _ := gin.CreateTestContext(recorder)
	inner.Request = c.Request.Clone(c.Request.Context())
	inner.Request.URL = &url.URL{Path: routePath}
	inner.Request.Method = step.Method
	inner.Request.Body = io.NopCloser(bytes.NewReader(encoded))
	inner.Request.ContentLength = int64(len(encoded))
	inner.Request.Header = c.Request.Header.Clone()
	inner.Request.Header.Set("Content-Type", "application/json")
	inner.Request.Header.Del("Authorization")
	inner.Request.Header.Del("Cookie")
	inner.Request.Header.Del("X-OAuth-Token")
	inner.Params = params
	inner.Keys = maps.Clone(c.Keys)
	delete(inner.Keys, "oauth_principal")
	inner.Set("oauth_hosted_principal", principal)
	inner.Set("oauth_hosted_action_id", action.ID)
	inner.Set("oauth_hosted_action", action)
	inner.Set("use_access_token", false)
	if action.Operation == "channel.key.reveal" || action.Operation == "channel.config.reveal" {
		if !middleware.RequireSecurityProof(inner, "channel.key.read", []string{"2fa", "passkey"}) {
			_ = service.FinishOAuthActionStep(action, false, len(op.Steps), nil, "")
			c.Data(recorder.Code, "application/json", recorder.Body.Bytes())
			return
		}
		inner.Set("secure_verified", true)
	}
	_ = identity // authenticated above; the inner context retains this real session.
	handler(inner)
	var response map[string]any
	parseErr := common.Unmarshal(recorder.Body.Bytes(), &response)
	success := recorder.Code >= 200 && recorder.Code < 300 && parseErr == nil
	if value, present := response["success"]; present {
		success = success && value == true
	}
	if recorder.Code == http.StatusNoContent {
		success = true
		response = map[string]any{"success": true}
	}
	if response == nil {
		response = map[string]any{"success": false, "message": "The operation could not be completed."}
	}
	if !common.GetContextKeyBool(inner, constant.ContextKeyAuditLogged) {
		metadata := middleware.OAuthAuditMetadata(inner)
		model.RecordOperationAuditLog(action.UserID, "OAuth hosted operation", c.ClientIP(), "oauth.hosted.step", map[string]any{"operation": action.Operation, "step": step.ID, "action_id": action.ID, "parameters_hash": action.ParametersHash}, metadata, map[string]any{"status": recorder.Code, "success": success})
	}
	flowToken := ""
	if success {
		if data, ok := response["data"].(map[string]any); ok {
			flowToken, _ = data["flow_token"].(string)
		}
	}
	if err := service.FinishOAuthActionStep(action, success, len(op.Steps), response["data"], flowToken); err != nil {
		oauthActionError(c, http.StatusInternalServerError)
		return
	}
	response["action_status"] = action.Status
	response["next_step_id"] = ""
	if action.StepIndex < len(op.Steps) {
		response["next_step_id"] = op.Steps[action.StepIndex].ID
	}
	if action.Status == "completed" {
		response["return_uri"] = service.OAuthActionReturnURI(action)
	}
	for _, cookie := range recorder.Header().Values("Set-Cookie") {
		c.Writer.Header().Add("Set-Cookie", cookie)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(recorder.Code, response)
}
func ClaimOAuthActionResult(c *gin.Context) {
	principal, ok := middleware.GetOAuthPrincipal(c)
	if !ok {
		oauthActionError(c, http.StatusUnauthorized)
		return
	}
	var request struct {
		ReceiptToken string `json:"receipt_token"`
	}
	if common.DecodeJsonStrict(http.MaxBytesReader(c.Writer, c.Request.Body, 1024), &request) != nil {
		oauthActionError(c, http.StatusBadRequest)
		return
	}
	action, err := service.GetOAuthHostedAction(c.Param("id"))
	if err != nil {
		oauthActionError(c, http.StatusNotFound)
		return
	}
	data, err := service.ClaimOAuthActionResult(action, principal, request.ReceiptToken)
	if err != nil {
		oauthActionError(c, http.StatusForbidden)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

// Completion checks both this action's server-recorded flow and an actual
// binding change; consuming a callback alone is not proof of a successful bind.
func OAuthActionBindingComplete(c *gin.Context) {
	value, ok := c.Get("oauth_hosted_action")
	action, typed := value.(*model.OAuthAction)
	if !ok || !typed {
		oauthActionError(c, http.StatusForbidden)
		return
	}
	var input map[string]any
	if common.DecodeJson(c.Request.Body, &input) != nil {
		oauthActionError(c, http.StatusBadRequest)
		return
	}
	raw, _ := input["flow_token"].(string)
	if raw == "" || service.OAuthActionHash(raw) != action.FlowHash {
		oauthActionError(c, http.StatusForbidden)
		return
	}
	var flow model.AuthFlow
	hash := common.GenerateHMACWithKey([]byte("auth-flow-v1:"+common.SessionSecret), raw)
	if model.DB.Where("token_hash = ? AND user_id = ? AND session_id = ?", hash, action.UserID, action.SessionID).First(&flow).Error != nil || flow.ConsumedAt == nil || flow.CreatedAt.Unix() < action.CreatedAt || !flow.ExpiresAt.After(time.Now()) {
		oauthActionError(c, http.StatusConflict)
		return
	}
	var parameters map[string]any
	_ = common.UnmarshalJsonStr(action.Parameters, &parameters)
	if action.Operation == "identity.telegram_bind" {
		if flow.Purpose != model.AuthFlowPurposeTelegramBind {
			oauthActionError(c, http.StatusForbidden)
			return
		}
	} else {
		providerName, _ := parameters["provider"].(string)
		if flow.Purpose != model.AuthFlowPurposeOAuth || flow.Intent != model.AuthFlowIntentBind || flow.Provider != providerName {
			oauthActionError(c, http.StatusForbidden)
			return
		}
	}
	binding, err := oauthActionBindingValue(action, parameters)
	if err != nil || binding == "" || service.OAuthActionHash(binding) == action.BindingBeforeHash {
		oauthActionError(c, http.StatusConflict)
		return
	}
	if action.Operation == "identity.oauth_bind" && (action.BindingResultHash == "" || action.BindingResultHash != service.OAuthActionHash(binding)) {
		oauthActionError(c, http.StatusConflict)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"bound": true}})
}
func oauthActionBindingValue(action *model.OAuthAction, parameters map[string]any) (string, error) {
	user, err := model.GetUserById(action.UserID, false)
	if err != nil {
		return "", err
	}
	if action.Operation == "identity.telegram_bind" {
		return user.TelegramId, nil
	}
	name, _ := parameters["provider"].(string)
	provider := oauth.GetProvider(name)
	if provider == nil {
		return "", service.ErrOAuthActionInvalid
	}
	if generic, ok := provider.(*oauth.GenericOAuthProvider); ok {
		var binding model.UserOAuthBinding
		result := model.DB.Where("user_id = ? AND provider_id = ?", action.UserID, generic.GetProviderId()).Find(&binding)
		return binding.ProviderUserId, result.Error
	}
	switch provider.ProviderUserIDColumn() {
	case "github_id":
		return user.GitHubId, nil
	case "discord_id":
		return user.DiscordId, nil
	case "oidc_id":
		return user.OidcId, nil
	case "wechat_id":
		return user.WeChatId, nil
	case "linux_do_id":
		return user.LinuxDOId, nil
	default:
		return "", service.ErrOAuthActionInvalid
	}
}
