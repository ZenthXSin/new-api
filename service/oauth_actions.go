package service

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const OAuthActionTTL = 5 * time.Minute

var ErrOAuthActionInvalid = errors.New("OAuth action is invalid, expired, or unavailable")

type OAuthActionField struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}
type OAuthActionStep struct {
	ID         string             `json:"id"`
	Label      string             `json:"label"`
	Method     string             `json:"method"`
	Path       string             `json:"path"`
	Kind       string             `json:"kind,omitempty"`
	ProofScope string             `json:"proof_scope,omitempty"`
	Fields     []OAuthActionField `json:"fields"`
}
type OAuthActionOperation struct {
	ID         string             `json:"id"`
	Scope      string             `json:"scope"`
	MinRole    int                `json:"-"`
	Label      string             `json:"label"`
	Parameters []OAuthActionField `json:"parameters"`
	Steps      []OAuthActionStep  `json:"steps"`
}

var oauthActionRegistry = struct {
	sync.RWMutex
	operations map[string]OAuthActionOperation
}{operations: make(map[string]OAuthActionOperation)}

func RegisterOAuthActionOperation(operation OAuthActionOperation) {
	oauthActionRegistry.Lock()
	defer oauthActionRegistry.Unlock()
	if operation.ID == "" || operation.Scope == "" || len(operation.Steps) == 0 {
		panic("invalid OAuth action registration")
	}
	if _, exists := oauthActionRegistry.operations[operation.ID]; exists {
		panic("duplicate OAuth action operation")
	}
	oauthActionRegistry.operations[operation.ID] = operation
}
func OAuthActionOperations() []OAuthActionOperation {
	oauthActionRegistry.RLock()
	defer oauthActionRegistry.RUnlock()
	result := make([]OAuthActionOperation, 0, len(oauthActionRegistry.operations))
	for _, v := range oauthActionRegistry.operations {
		result = append(result, v)
	}
	slices.SortFunc(result, func(a, b OAuthActionOperation) int { return strings.Compare(a.ID, b.ID) })
	return result
}
func OAuthActionOperationByID(id string) (OAuthActionOperation, bool) {
	oauthActionRegistry.RLock()
	defer oauthActionRegistry.RUnlock()
	op, ok := oauthActionRegistry.operations[id]
	return op, ok
}
func OAuthActionHash(raw string) string {
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}
func OAuthActionRandomToken(prefix string) (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(data), nil
}

// ValidateOAuthActionFields rejects unknown names. Structured JSON belongs to a
// named field and is never expanded into an arbitrary controller request.
func ValidateOAuthActionFields(input map[string]any, fields []OAuthActionField) (map[string]any, error) {
	result := make(map[string]any, len(input))
	allowed := make(map[string]OAuthActionField, len(fields))
	for _, field := range fields {
		allowed[field.Name] = field
	}
	for name, value := range input {
		field, ok := allowed[name]
		if !ok {
			return nil, fmt.Errorf("unsupported field: %s", name)
		}
		switch field.Type {
		case "number":
			n, ok := value.(float64)
			if !ok || n < -9007199254740991 || n > 9007199254740991 || n != float64(int64(n)) || (n < 0 && name != "value") {
				return nil, ErrOAuthActionInvalid
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return nil, ErrOAuthActionInvalid
			}
		case "json": // The target handler validates this named object's schema.
		default:
			s, ok := value.(string)
			if !ok || len(s) > 8192 {
				return nil, ErrOAuthActionInvalid
			}
			if field.Required && strings.TrimSpace(s) == "" {
				return nil, ErrOAuthActionInvalid
			}
		}
		result[name] = value
	}
	for _, field := range fields {
		if field.Required {
			if _, ok := result[field.Name]; !ok {
				return nil, fmt.Errorf("required field: %s", field.Name)
			}
		}
	}
	return result, nil
}
func OAuthActionResultKind(operation string) string {
	switch operation {
	case "apikey.reveal", "apikey.reveal_batch", "channel.key.reveal", "channel.config.reveal":
		return "secret"
	case "sessions.list", "oauth_grants.list", "app.create", "oauth_client.create":
		return "data"
	default:
		return "receipt"
	}
}
func OAuthActionAllowsSharing(operation string) bool {
	return OAuthActionResultKind(operation) != "receipt"
}

// Only selected typed response data can leave the hosted browser. Credential
// envelopes for app/client creation are reduced to public object metadata.
func OAuthActionSharedResult(operation string, data any) (any, error) {
	if !OAuthActionAllowsSharing(operation) {
		return nil, ErrOAuthActionInvalid
	}
	if operation == "channel.config.reveal" {
		object, ok := data.(map[string]any)
		if !ok {
			return nil, ErrOAuthActionInvalid
		}
		result := make(map[string]any)
		// This is the approved configuration snapshot, not an arbitrary
		// response envelope. Complete API keys retain their own operation.
		for _, field := range []string{"id", "type", "name", "openai_organization", "test_model", "status", "weight", "created_time", "test_time", "response_time", "base_url", "other", "balance", "balance_updated_time", "models", "group", "used_quota", "used_tokens", "max_tokens", "model_mapping", "status_code_mapping", "priority", "auto_ban", "other_info", "tag", "setting", "param_override", "header_override", "remark", "cost_multiplier", "channel_info", "settings"} {
			if value, exists := object[field]; exists {
				result[field] = value
			}
		}
		return result, nil
	}
	if operation == "app.create" || operation == "oauth_client.create" {
		object, ok := data.(map[string]any)
		if !ok {
			return nil, ErrOAuthActionInvalid
		}
		field := "app"
		if operation == "oauth_client.create" {
			field = "client"
		}
		value, ok := object[field]
		if !ok {
			return nil, ErrOAuthActionInvalid
		}
		return map[string]any{field: value}, nil
	}
	return data, nil
}
func ValidateOAuthActionPrincipal(principal *OAuthPrincipal, operation OAuthActionOperation) error {
	if principal == nil || !slices.Contains(principal.Scopes, operation.Scope) || !slices.Contains(principal.Resources, model.OAuthResourceDashboard) {
		return ErrOAuthActionInvalid
	}
	user, err := model.GetUserById(principal.UserID, false)
	if err != nil || user == nil || user.Status != common.UserStatusEnabled || user.Role < operation.MinRole {
		return ErrOAuthActionInvalid
	}
	principal.User = user
	if !OAuthScopeAllowed(principal, operation.Scope) {
		return ErrOAuthActionInvalid
	}
	return nil
}
func CreateOAuthHostedAction(principal *OAuthPrincipal, operationID string, parameters map[string]any, shareResult bool, returnURI, state string) (*model.OAuthAction, string, error) {
	op, ok := OAuthActionOperationByID(operationID)
	if !ok {
		return nil, "", ErrOAuthActionInvalid
	}
	if err := ValidateOAuthActionPrincipal(principal, op); err != nil {
		return nil, "", err
	}
	clean, err := ValidateOAuthActionFields(parameters, op.Parameters)
	if err != nil {
		return nil, "", err
	}
	if shareResult && !OAuthActionAllowsSharing(operationID) {
		return nil, "", ErrOAuthActionInvalid
	}
	if len(state) > 512 {
		return nil, "", ErrOAuthActionInvalid
	}
	if returnURI != "" {
		client, err := model.GetOauthClientByClientId(principal.ClientID)
		if err != nil || client == nil || !slices.Contains(client.GetRedirectUris(), returnURI) {
			return nil, "", ErrOAuthActionInvalid
		}
		parsed, err := url.Parse(returnURI)
		if err != nil || parsed.Fragment != "" {
			return nil, "", ErrOAuthActionInvalid
		}
	}
	encoded, err := common.Marshal(clean)
	if err != nil {
		return nil, "", err
	}
	if len(encoded) > 32768 {
		return nil, "", ErrOAuthActionInvalid
	}
	id, err := OAuthActionRandomToken("")
	if err != nil {
		return nil, "", err
	}
	receipt, err := OAuthActionRandomToken("nao_ar_")
	if err != nil {
		return nil, "", err
	}
	now := time.Now().Unix()
	action := &model.OAuthAction{ID: id, UserID: principal.UserID, ClientID: principal.ClientID, GrantID: principal.GrantID, AuthVersion: principal.AuthVersion, GrantVersion: principal.GrantVersion, Operation: operationID, Parameters: string(encoded), ParametersHash: OAuthActionHash(string(encoded)), Status: "pending", ShareResult: shareResult, ReturnURI: returnURI, ReturnState: state, ReceiptHash: OAuthActionHash(receipt), CreatedAt: now, ExpiresAt: now + int64(OAuthActionTTL/time.Second)}
	if err := model.DB.Create(action).Error; err != nil {
		return nil, "", err
	}
	return action, receipt, nil
}
func GetOAuthHostedAction(id string) (*model.OAuthAction, error) {
	if len(id) != 43 {
		return nil, ErrOAuthActionInvalid
	}
	var action model.OAuthAction
	if err := model.DB.Where("id = ?", id).First(&action).Error; err != nil {
		return nil, ErrOAuthActionInvalid
	}
	return &action, nil
}
func RevalidateOAuthHostedAction(action *model.OAuthAction) (*OAuthPrincipal, error) {
	if action == nil || time.Now().Unix() >= action.ExpiresAt || OAuthActionHash(action.Parameters) != action.ParametersHash {
		return nil, ErrOAuthActionInvalid
	}
	principal, err := AuthenticateOAuthGrant(action.GrantID)
	if err != nil || principal == nil || principal.UserID != action.UserID || principal.ClientID != action.ClientID || principal.AuthVersion != action.AuthVersion || principal.GrantVersion != action.GrantVersion {
		return nil, ErrOAuthActionInvalid
	}
	op, ok := OAuthActionOperationByID(action.Operation)
	if !ok {
		return nil, ErrOAuthActionInvalid
	}
	if err := ValidateOAuthActionPrincipal(principal, op); err != nil {
		return nil, err
	}
	return principal, nil
}
func OAuthActionReceiptMatches(action *model.OAuthAction, raw string) bool {
	return action != nil && strings.HasPrefix(raw, "nao_ar_") && time.Now().Unix() < action.ExpiresAt && subtle.ConstantTimeCompare([]byte(action.ReceiptHash), []byte(OAuthActionHash(raw))) == 1
}
func BindOAuthActionSession(action *model.OAuthAction, identity AuthIdentity) (string, error) {
	if action.UserID != identity.UserID || identity.SessionID == "" || action.AuthVersion != identity.UserAuthVersion {
		return "", ErrOAuthActionInvalid
	}
	if _, err := RevalidateOAuthHostedAction(action); err != nil {
		return "", err
	}
	nonce, err := OAuthActionRandomToken("")
	if err != nil {
		return "", err
	}
	result := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND status IN ? AND (session_id = '' OR session_id = ?)", action.ID, []string{"pending", "approved"}, identity.SessionID).Updates(map[string]any{"session_id": identity.SessionID, "session_version": identity.SessionVersion, "nonce_hash": OAuthActionHash(nonce)})
	if result.Error != nil {
		return "", result.Error
	}
	if result.RowsAffected != 1 {
		return "", ErrOAuthActionInvalid
	}
	action.SessionID = identity.SessionID
	action.SessionVersion = identity.SessionVersion
	action.NonceHash = OAuthActionHash(nonce)
	return nonce, nil
}
func OAuthActionSessionMatches(action *model.OAuthAction, identity AuthIdentity, nonce string) bool {
	return action != nil && identity.UserID == action.UserID && identity.SessionID != "" && identity.SessionID == action.SessionID && identity.SessionVersion == action.SessionVersion && identity.UserAuthVersion == action.AuthVersion && len(nonce) > 0 && subtle.ConstantTimeCompare([]byte(action.NonceHash), []byte(OAuthActionHash(nonce))) == 1
}
func ApproveOAuthHostedAction(action *model.OAuthAction) error {
	result := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND status = ? AND expires_at > ?", action.ID, "pending", time.Now().Unix()).Update("status", "approved")
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrOAuthActionInvalid
	}
	action.Status = "approved"
	return nil
}
func ClaimOAuthActionStep(action *model.OAuthAction, index int) error {
	result := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND status = ? AND step_index = ? AND expires_at > ?", action.ID, "approved", index, time.Now().Unix()).Update("status", "running")
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrOAuthActionInvalid
	}
	action.Status = "running"
	return nil
}
func FinishOAuthActionStep(action *model.OAuthAction, success bool, totalSteps int, resultData any, flowToken string) error {
	updates := map[string]any{"status": "approved"}
	if success {
		action.StepIndex++
		updates["step_index"] = action.StepIndex
		if flowToken != "" {
			updates["flow_hash"] = OAuthActionHash(flowToken)
			// Native provider flows may otherwise outlive an expired action.
			// Clamp the underlying ceremony so cleanup cannot make a formerly
			// hosted callback look like an unrelated native flow.
			flowHash := common.GenerateHMACWithKey([]byte("auth-flow-v1:"+common.SessionSecret), flowToken)
			if err := model.DB.Model(&model.AuthFlow{}).Where("token_hash = ? AND user_id = ? AND session_id = ? AND expires_at > ?", flowHash, action.UserID, action.SessionID, time.Unix(action.ExpiresAt, 0)).Update("expires_at", time.Unix(action.ExpiresAt, 0)).Error; err != nil {
				return err
			}
		}
		if action.StepIndex >= totalSteps {
			updates["status"] = "completed"
			action.CompletedAt = time.Now().Unix()
			updates["completed_at"] = action.CompletedAt
			if action.ShareResult {
				shared, err := OAuthActionSharedResult(action.Operation, resultData)
				if err != nil {
					return err
				}
				encrypted, err := encryptOAuthActionResult(action, shared)
				if err != nil {
					return err
				}
				updates["result_ciphertext"] = encrypted
			}
		}
	}
	result := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND status = ?", action.ID, "running").Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrOAuthActionInvalid
	}
	action.Status = updates["status"].(string)
	return nil
}
func OAuthActionReturnURI(action *model.OAuthAction) string {
	if action == nil || action.ReturnURI == "" {
		return ""
	}
	parsed, err := url.Parse(action.ReturnURI)
	if err != nil {
		return ""
	}
	query := parsed.Query()
	query.Set("action_id", action.ID)
	query.Set("status", action.Status)
	query.Set("state", action.ReturnState)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
func oauthActionAEAD() (cipher.AEAD, error) {
	key := sha256.Sum256([]byte("new-api/oauth/action-result/v1\x00" + common.SessionSecret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func oauthActionAAD(action *model.OAuthAction) []byte {
	return []byte(action.ID + "\x00" + action.ClientID + "\x00" + strconv.Itoa(action.GrantID) + "\x00" + action.ParametersHash)
}
func encryptOAuthActionResult(action *model.OAuthAction, data any) (string, error) {
	plaintext, err := common.Marshal(data)
	if err != nil {
		return "", err
	}
	aead, err := oauthActionAEAD()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	encrypted := aead.Seal(nonce, nonce, plaintext, oauthActionAAD(action))
	return base64.RawURLEncoding.EncodeToString(encrypted), nil
}
func ClaimOAuthActionResult(action *model.OAuthAction, principal *OAuthPrincipal, receipt string) (any, error) {
	if !OAuthActionReceiptMatches(action, receipt) || principal == nil || principal.UserID != action.UserID || principal.ClientID != action.ClientID || principal.GrantID != action.GrantID || action.Status != "completed" || !action.ShareResult || action.ResultCiphertext == "" || action.ResultClaimedAt != 0 {
		return nil, ErrOAuthActionInvalid
	}
	if _, err := RevalidateOAuthHostedAction(action); err != nil {
		return nil, err
	}
	encrypted, err := base64.RawURLEncoding.DecodeString(action.ResultCiphertext)
	if err != nil {
		return nil, ErrOAuthActionInvalid
	}
	aead, err := oauthActionAEAD()
	if err != nil || len(encrypted) < aead.NonceSize() {
		return nil, ErrOAuthActionInvalid
	}
	plain, err := aead.Open(nil, encrypted[:aead.NonceSize()], encrypted[aead.NonceSize():], oauthActionAAD(action))
	if err != nil {
		return nil, ErrOAuthActionInvalid
	}
	var data any
	if err := common.Unmarshal(plain, &data); err != nil {
		return nil, err
	}
	result := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND result_claimed_at = 0 AND result_ciphertext <> '' AND expires_at > ?", action.ID, time.Now().Unix()).Updates(map[string]any{"result_claimed_at": time.Now().Unix(), "result_ciphertext": ""})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected != 1 {
		return nil, ErrOAuthActionInvalid
	}
	return data, nil
}
func DeleteExpiredOAuthActions() error {
	return model.DB.Where("expires_at <= ?", time.Now().Unix()).Delete(&model.OAuthAction{}).Error
}

// RecordOAuthHostedBindingSuccess links a completed provider callback to the
// exact hosted action that initiated it. A failed or unrelated callback cannot
// manufacture a completion receipt merely by consuming an AuthFlow.
func RecordOAuthHostedBindingSuccess(rawFlow string, userID int, sessionID, provider, binding string) error {
	if rawFlow == "" || userID <= 0 || sessionID == "" || provider == "" || binding == "" {
		return ErrOAuthActionInvalid
	}
	var actions []model.OAuthAction
	if err := model.DB.Where("flow_hash = ? AND user_id = ? AND session_id = ? AND operation = ? AND status = ? AND expires_at > ?", OAuthActionHash(rawFlow), userID, sessionID, "identity.oauth_bind", "approved", time.Now().Unix()).Find(&actions).Error; err != nil {
		return err
	}
	for _, action := range actions {
		var parameters map[string]any
		if common.UnmarshalJsonStr(action.Parameters, &parameters) != nil || parameters["provider"] != provider {
			continue
		}
		if err := model.DB.Model(&model.OAuthAction{}).Where("id = ? AND flow_hash = ? AND status = ?", action.ID, OAuthActionHash(rawFlow), "approved").Update("binding_result_hash", OAuthActionHash(binding)).Error; err != nil {
			return err
		}
	}
	return nil
}

// OAuthActionBootstrapAllowed only establishes the first local factor. A fresh
// external-login session never substitutes for step-up on any other operation.
func OAuthActionBootstrapAllowed(action *model.OAuthAction, identity AuthIdentity) bool {
	if action == nil || (action.Operation != "mfa.setup" && action.Operation != "passkey.register") || action.UserID != identity.UserID || action.AuthVersion != identity.UserAuthVersion {
		return false
	}
	session, _, err := ValidateLoginSession(identity)
	if err != nil {
		return false
	}
	now := time.Now().Unix()
	if session.CreatedAt > now || now-session.CreatedAt > int64(OAuthActionTTL/time.Second) || !strings.HasPrefix(session.LoginMethod, "oauth:") || strings.TrimPrefix(session.LoginMethod, "oauth:") == "" {
		return false
	}
	user, err := model.GetUserById(identity.UserID, true)
	if err != nil || user.Password != "" {
		return false
	}
	twoFA, err := model.GetTwoFAByUserId(identity.UserID)
	if err != nil || (twoFA != nil && twoFA.IsEnabled) {
		return false
	}
	_, err = model.GetPasskeyByUserID(identity.UserID)
	return errors.Is(err, model.ErrPasskeyNotFound)
}

// ValidateOAuthHostedBindingCallback closes the gap between opening an identity
// provider and completing its callback. Revoking the application while a popup
// is open prevents the callback from performing its delegated binding effect.
func ValidateOAuthHostedBindingCallback(rawFlow string, userID int, sessionID string) error {
	var actions []model.OAuthAction
	if err := model.DB.Where("flow_hash = ? AND user_id = ? AND session_id = ? AND operation IN ?", OAuthActionHash(rawFlow), userID, sessionID, []string{"identity.oauth_bind", "identity.telegram_bind"}).Find(&actions).Error; err != nil {
		return err
	}
	for _, action := range actions {
		if action.Status != "approved" || action.StepIndex != 1 {
			return ErrOAuthActionInvalid
		}
		if _, err := RevalidateOAuthHostedAction(&action); err != nil {
			return err
		}
		identity, err := ValidateSessionReference(action.UserID, action.SessionID)
		if err != nil || identity.SessionVersion != action.SessionVersion || identity.UserAuthVersion != action.AuthVersion {
			return ErrOAuthActionInvalid
		}
	}
	return nil
}
