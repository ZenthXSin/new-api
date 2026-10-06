package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"gorm.io/gorm"
)

const (
	OAuthAccessTokenPrefix  = "nao_at_"
	OAuthRefreshTokenPrefix = "nao_rt_"
	OAuthAccessTokenTTL     = 15 * time.Minute
	OAuthGrantTTL           = 30 * 24 * time.Hour
)

// OAuthPrincipal is a freshly validated delegated identity. It is deliberately
// not a dashboard session and cannot satisfy browser or step-up authentication.
type OAuthPrincipal struct {
	UserID       int
	ClientID     string
	GrantID      int
	Scopes       []string
	Resources    []string
	AuthVersion  int64
	GrantVersion int64
	ExpiresAt    int64
	User         *model.User
}

type OAuthTokenResponse struct {
	AccessToken  string   `json:"access_token"`
	TokenType    string   `json:"token_type"`
	ExpiresIn    int64    `json:"expires_in"`
	Scope        string   `json:"scope"`
	RefreshToken string   `json:"refresh_token,omitempty"`
	IDToken      string   `json:"id_token,omitempty"`
	Resources    []string `json:"resource"`
}

type OAuthGrantView struct {
	ID         int      `json:"id"`
	UserID     int      `json:"user_id"`
	ClientID   string   `json:"client_id"`
	ClientName string   `json:"client_name"`
	Scopes     []string `json:"scopes"`
	Resources  []string `json:"resources"`
	CreatedAt  int64    `json:"created_at"`
	ExpiresAt  int64    `json:"expires_at"`
	RevokedAt  int64    `json:"revoked_at"`
	Active     bool     `json:"active"`
}

func oauthTokenHash(raw string) string {
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}

// The fingerprint supplements AuthVersion so direct database updates cannot
// leave a delegated token alive after password, role, status or group changes.
func oauthUserFingerprint(user *model.User) string {
	payload, _ := common.Marshal([]interface{}{user.Id, user.Password, user.Role, user.Status, user.GetGroups(), user.AuthVersion})
	return oauthTokenHash(string(payload))
}

func oauthClientFingerprint(client *model.OauthClient) string {
	// Adding allowed scopes does not extend or invalidate old grants. Removing
	// scopes is checked against each grant at use time; redirects/keys are bound.
	payload, _ := common.Marshal([]interface{}{client.ClientId, client.ClientSecret, client.IsPublic, client.GetRedirectUris()})
	return oauthTokenHash(string(payload))
}

func OAuthNormalizeResources(requested []string) ([]string, error) {
	if len(requested) == 0 {
		return []string{OAuthResourceDashboard, OAuthResourceRelay}, nil
	}
	result := make([]string, 0, 2)
	for _, resource := range requested {
		if resource != OAuthResourceDashboard && resource != OAuthResourceRelay {
			return nil, ErrOidcRequestInvalid
		}
		if !slices.Contains(result, resource) {
			result = append(result, resource)
		}
	}
	slices.Sort(result)
	return result, nil
}

func OAuthScopesForConsent(userID int, client *model.OauthClient, requested []string) ([]string, error) {
	if client == nil || !client.Enabled {
		return nil, ErrOidcRequestInvalid
	}
	user, err := model.GetUserById(userID, false)
	if err != nil || user.Status != common.UserStatusEnabled {
		return nil, ErrOidcRequestInvalid
	}
	expanded, err := OAuthExpandScopesForUser(userID, user.Role, requested)
	if err != nil {
		return nil, err
	}
	allowed := client.GetScopes()
	full := slices.Contains(requested, "full")
	result := make([]string, 0, len(expanded))
	for _, scope := range expanded {
		if !slices.Contains(allowed, scope) {
			if full && !slices.Contains(requested, scope) {
				continue
			}
			return nil, ErrOidcScopeNotRequested
		}
		result = append(result, scope)
	}
	if len(result) == 0 {
		return nil, ErrOidcScopeNotRequested
	}
	return result, nil
}

func OAuthConsentCapabilities(scopes []string) []model.OAuthCapability {
	capabilities := make([]model.OAuthCapability, 0, len(scopes))
	for _, scope := range scopes {
		if capability, ok := model.OAuthCapabilityByScope(scope); ok {
			capabilities = append(capabilities, capability)
		}
	}
	return capabilities
}

func validateOAuthGrant(grant *model.OAuthGrant) (*OAuthPrincipal, error) {
	if grant == nil || grant.RevokedAt != 0 || grant.ExpiresAt <= time.Now().Unix() {
		return nil, ErrOidcTokenInvalid
	}
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled || settings.GetIssuer() == "" {
		return nil, ErrOidcTokenInvalid
	}
	user, err := model.GetUserById(grant.UserID, true)
	if err != nil || user.Status != common.UserStatusEnabled || user.AuthVersion != grant.UserAuthVersion || oauthUserFingerprint(user) != grant.UserAuthFingerprint {
		return nil, ErrOidcTokenInvalid
	}
	client, err := model.GetOauthClientById(grant.OAuthClientID)
	if err != nil || !client.Enabled || oauthClientFingerprint(client) != grant.ClientAuthVersion {
		return nil, ErrOidcTokenInvalid
	}
	scopes := strings.Fields(grant.Scopes)
	allowed := client.GetScopes()
	for _, scope := range scopes {
		if !slices.Contains(allowed, scope) {
			return nil, ErrOidcTokenInvalid
		}
	}
	if _, err := OAuthExpandScopesForUser(user.Id, user.Role, scopes); err != nil {
		return nil, ErrOidcTokenInvalid
	}
	var resources []string
	if common.UnmarshalJsonStr(grant.Resources, &resources) != nil || len(resources) == 0 {
		return nil, ErrOidcTokenInvalid
	}
	resources, err = OAuthNormalizeResources(resources)
	if err != nil {
		return nil, ErrOidcTokenInvalid
	}
	// Do not retain secrets on the request principal.
	user.Password = ""
	user.AccessToken = nil
	return &OAuthPrincipal{UserID: user.Id, ClientID: client.ClientId, GrantID: grant.ID, Scopes: scopes, Resources: resources, AuthVersion: user.AuthVersion, GrantVersion: grant.Version, ExpiresAt: grant.ExpiresAt, User: user}, nil
}

func AuthenticateOAuthGrant(grantID int) (*OAuthPrincipal, error) {
	grant, err := model.GetOAuthGrantByID(grantID)
	if err != nil {
		return nil, ErrOidcTokenInvalid
	}
	return validateOAuthGrant(grant)
}

// recognized prevents malformed OAuth credentials from falling through to
// legacy API-key/PAT authentication. Refresh and ticket tokens are never ATs.
func AuthenticateOAuthAccessToken(raw string) (*OAuthPrincipal, bool, error) {
	if !strings.HasPrefix(raw, "nao_") {
		return nil, false, nil
	}
	if !strings.HasPrefix(raw, OAuthAccessTokenPrefix) || len(raw) != len(OAuthAccessTokenPrefix)+43 {
		return nil, true, ErrOidcTokenInvalid
	}
	grant, err := model.GetOAuthAccessGrant(oauthTokenHash(raw))
	if err != nil {
		return nil, true, ErrOidcTokenInvalid
	}
	principal, err := validateOAuthGrant(grant)
	return principal, true, err
}

func oauthRawTokenPair(offline bool) (string, string, error) {
	access, err := GenerateOidcStateToken()
	if err != nil {
		return "", "", err
	}
	refresh := ""
	if offline {
		refresh, err = GenerateOidcStateToken()
		if err != nil {
			return "", "", err
		}
		refresh = OAuthRefreshTokenPrefix + refresh
	}
	return OAuthAccessTokenPrefix + access, refresh, nil
}

func RefreshOAuthTokens(raw string, client *model.OauthClient, requestedScope string, requestedResources ...string) (*OAuthTokenResponse, error) {
	if client == nil || !client.Enabled || !strings.HasPrefix(raw, OAuthRefreshTokenPrefix) || len(raw) != len(OAuthRefreshTokenPrefix)+43 {
		return nil, ErrOidcTokenInvalid
	}
	grant, err := model.GetOAuthRefreshGrant(oauthTokenHash(raw), client.Id)
	if err != nil {
		return nil, ErrOidcTokenInvalid
	}
	principal, err := validateOAuthGrant(grant)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(principal.Scopes, "offline_access") {
		return nil, ErrOidcTokenInvalid
	}
	// Scope/resource changes require a fresh explicit authorization. This also
	// avoids silently mutating an existing family when one client refreshes.
	if requestedScope != "" {
		requested := strings.Fields(requestedScope)
		slices.Sort(requested)
		existing := append([]string(nil), principal.Scopes...)
		slices.Sort(existing)
		if !slices.Equal(requested, existing) {
			return nil, ErrOAuthScopeInvalid
		}
	}
	if len(requestedResources) > 0 {
		resources, err := OAuthNormalizeResources(requestedResources)
		existing := append([]string(nil), principal.Resources...)
		slices.Sort(existing)
		if err != nil || !slices.Equal(resources, existing) {
			return nil, ErrOAuthScopeInvalid
		}
	}
	access, refresh, err := oauthRawTokenPair(true)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	accessExpiry := min(now+int64(OAuthAccessTokenTTL/time.Second), grant.ExpiresAt)
	if _, err = model.RotateOAuthRefreshToken(oauthTokenHash(raw), client.Id, oauthTokenHash(access), oauthTokenHash(refresh), accessExpiry, grant.ExpiresAt); err != nil {
		return nil, ErrOidcTokenInvalid
	}
	return &OAuthTokenResponse{AccessToken: access, RefreshToken: refresh, TokenType: "Bearer", ExpiresIn: accessExpiry - now, Scope: grant.Scopes, Resources: principal.Resources}, nil
}

func RevokeOAuthToken(raw string, client *model.OauthClient) error {
	if client == nil || !client.Enabled {
		return ErrOidcTokenInvalid
	}
	if strings.HasPrefix(raw, OAuthAccessTokenPrefix) || strings.HasPrefix(raw, OAuthRefreshTokenPrefix) {
		return model.RevokeOAuthToken(oauthTokenHash(raw), client.Id)
	}
	// Pre-upgrade identity-only JWTs are retired rather than receiving resource
	// access. An unknown token must remain indistinguishable under RFC 7009.
	return nil
}

func ListOAuthGrants(userID int) ([]OAuthGrantView, error) {
	grants, err := model.ListOAuthGrantsForUser(userID)
	if err != nil {
		return nil, err
	}
	result := make([]OAuthGrantView, 0, len(grants))
	for _, grant := range grants {
		item := OAuthGrantView{ID: grant.ID, UserID: grant.UserID, Scopes: strings.Fields(grant.Scopes), CreatedAt: grant.CreatedAt, ExpiresAt: grant.ExpiresAt, RevokedAt: grant.RevokedAt}
		_ = common.UnmarshalJsonStr(grant.Resources, &item.Resources)
		if client, err := model.GetOauthClientById(grant.OAuthClientID); err == nil {
			item.ClientID = client.ClientId
			item.ClientName = client.Name
		}
		_, err := validateOAuthGrant(&grant)
		item.Active = err == nil
		result = append(result, item)
	}
	return result, nil
}

func NarrowOAuthGrant(userID, grantID int, scopes []string) error {
	grant, err := model.GetOAuthGrantByID(grantID)
	if err != nil || grant.UserID != userID || len(scopes) == 0 {
		return ErrOidcRequestInvalid
	}
	var resources []string
	if common.UnmarshalJsonStr(grant.Resources, &resources) != nil {
		return ErrOidcRequestInvalid
	}
	_, err = model.NarrowOAuthGrant(grantID, userID, scopes, resources)
	return err
}

func RevokeOAuthGrant(userID, grantID int) error {
	found, err := model.RevokeOAuthGrantForUser(grantID, userID)
	if err != nil {
		return err
	}
	if !found {
		return ErrOidcRequestInvalid
	}
	return nil
}

func CreateOAuthConsentChallenge(userID int, sessionID string, request any) (string, error) {
	if userID <= 0 || sessionID == "" {
		return "", ErrOidcRequestInvalid
	}
	data, err := common.Marshal(request)
	if err != nil {
		return "", err
	}
	token, _, err := model.CreateAuthFlow(model.AuthFlowCreate{Purpose: "oauth_consent", UserId: userID, SessionId: sessionID, Payload: oauthTokenHash(string(data)), ExpiresAt: time.Now().Add(5 * time.Minute)})
	return token, err
}

func ConsumeOAuthConsentChallenge(raw string, userID int, sessionID string, request any) error {
	if raw == "" || userID <= 0 || sessionID == "" {
		return ErrOidcRequestInvalid
	}
	data, err := common.Marshal(request)
	if err != nil {
		return err
	}
	_, err = model.ConsumeAuthFlowWithAction(raw, model.AuthFlowMatch{Purpose: "oauth_consent", UserId: userID, SessionId: sessionID}, func(_ *gorm.DB, flow *model.AuthFlow) error {
		if flow.Payload != oauthTokenHash(string(data)) {
			return ErrOidcRequestInvalid
		}
		return nil
	})
	if err != nil {
		return ErrOidcRequestInvalid
	}
	return nil
}

// IssueOAuthTokens is a service entry point for explicitly authorized callers;
// HTTP clients must complete the PKCE authorization-code exchange.
func IssueOAuthTokens(client *model.OauthClient, user *model.User, scopes []string, resources []string, nonce string) (*OAuthTokenResponse, error) {
	return issueOAuthTokens(client, user, scopes, resources, nonce)
}

func issueOAuthTokens(client *model.OauthClient, user *model.User, scopes []string, resources []string, nonce string) (*OAuthTokenResponse, error) {
	if client == nil || user == nil {
		return nil, ErrOidcRequestInvalid
	}
	currentUser, err := model.GetUserById(user.Id, true)
	if err != nil {
		return nil, ErrOidcRequestInvalid
	}
	currentClient, err := model.GetOauthClientById(client.Id)
	if err != nil {
		return nil, ErrOidcRequestInvalid
	}
	scopes, err = OAuthScopesForConsent(currentUser.Id, currentClient, scopes)
	if err != nil {
		return nil, err
	}
	resources, err = OAuthNormalizeResources(resources)
	if err != nil {
		return nil, err
	}
	idToken := ""
	if slices.Contains(scopes, "openid") {
		idToken, err = issueOidcIDToken(currentClient, currentUser, scopes, nonce)
		if err != nil {
			return nil, err
		}
	}
	var response *OAuthTokenResponse
	err = model.DB.Transaction(func(tx *gorm.DB) error {
		response, _, err = persistOAuthTokens(tx, currentClient, currentUser, scopes, resources, idToken)
		return err
	})
	return response, err
}

func persistOAuthTokens(tx *gorm.DB, client *model.OauthClient, user *model.User, scopes, resources []string, idToken string) (*OAuthTokenResponse, *model.OAuthGrant, error) {
	access, refresh, err := oauthRawTokenPair(slices.Contains(scopes, "offline_access"))
	if err != nil {
		return nil, nil, err
	}
	now := time.Now().Unix()
	grantExpiry := now + int64(OAuthAccessTokenTTL/time.Second)
	if refresh != "" {
		grantExpiry = now + int64(OAuthGrantTTL/time.Second)
	}
	encodedResources, err := common.Marshal(resources)
	if err != nil {
		return nil, nil, err
	}
	grant := &model.OAuthGrant{UserID: user.Id, OAuthClientID: client.Id, Scopes: strings.Join(scopes, " "), Resources: string(encodedResources), UserAuthVersion: user.AuthVersion, UserAuthFingerprint: oauthUserFingerprint(user), ClientAuthVersion: oauthClientFingerprint(client), ExpiresAt: grantExpiry}
	if err := model.CreateOAuthGrantWithTx(tx, grant); err != nil {
		return nil, nil, err
	}
	refreshHash := ""
	if refresh != "" {
		refreshHash = oauthTokenHash(refresh)
	}
	if err := model.IssueOAuthTokenPairWithTx(tx, grant.ID, oauthTokenHash(access), refreshHash, now+int64(OAuthAccessTokenTTL/time.Second), grantExpiry); err != nil {
		return nil, nil, err
	}
	return &OAuthTokenResponse{AccessToken: access, RefreshToken: refresh, TokenType: "Bearer", ExpiresIn: int64(OAuthAccessTokenTTL / time.Second), Scope: grant.Scopes, Resources: resources, IDToken: idToken}, grant, nil
}

// ExchangeOAuthAuthorizationCode verifies PKCE and consumes the code in the
// same transaction that creates its grant. Invalid verifiers do not burn a
// valid code; replay with the correct bindings revokes its issued family.
func ExchangeOAuthAuthorizationCode(code string, client *model.OauthClient, redirectURI, verifier string, requestedResources ...string) (*OAuthTokenResponse, error) {
	if client == nil || !client.Enabled || code == "" || !client.HasRedirectURI(redirectURI) {
		return nil, ErrOidcRequestInvalid
	}
	// Signing-key creation may own a transaction; prepare it before acquiring
	// the authorization-code transaction, including on single-connection SQLite.
	privateKey, signingKid, keyErr := model.GetOrCreateOauthSigningKey()
	if keyErr != nil {
		return nil, keyErr
	}
	var response *OAuthTokenResponse
	_, err := model.ConsumeOAuthAuthorizationFlow(code, func(tx *gorm.DB, flow *model.AuthFlow) error {
		var payload oidcAuthorizationCodePayload
		if common.UnmarshalJsonStr(flow.Payload, &payload) != nil || payload.ClientId != client.ClientId || payload.RedirectUri != redirectURI {
			return ErrOidcRequestInvalid
		}
		if err := ValidateOidcPKCE(payload.CodeChallenge, payload.CodeChallengeMethod, verifier); err != nil {
			return err
		}
		var currentClient model.OauthClient
		if err := tx.First(&currentClient, client.Id).Error; err != nil || !currentClient.Enabled || payload.ClientAuthVersion != oauthClientFingerprint(&currentClient) {
			return ErrOidcTokenInvalid
		}
		var user model.User
		if err := tx.First(&user, flow.UserId).Error; err != nil || user.Status != common.UserStatusEnabled || user.AuthVersion != payload.UserAuthVersion || oauthUserFingerprint(&user) != payload.UserAuthFingerprint {
			return ErrOidcTokenInvalid
		}
		scopes := strings.Fields(payload.Scope)
		allowed := currentClient.GetScopes()
		for _, scope := range scopes {
			if !slices.Contains(allowed, scope) || scope == "full" {
				return ErrOidcScopeNotRequested
			}
		}
		// Consent already resolved role and object permissions; current AuthVersion
		// plus fingerprint prevents promotions or demotions from changing it here.
		resources, err := OAuthNormalizeResources(payload.Resources)
		if err != nil {
			return err
		}
		if len(requestedResources) > 0 {
			requested, err := OAuthNormalizeResources(requestedResources)
			if err != nil {
				return err
			}
			for _, resource := range requested {
				if !slices.Contains(resources, resource) {
					return ErrOidcRequestInvalid
				}
			}
			resources = requested
		}
		idToken := ""
		if slices.Contains(scopes, "openid") {
			// Signing uses the preloaded active key and performs no database calls.
			idToken, err = issueOidcIDTokenWithKey(&currentClient, &user, scopes, payload.Nonce, privateKey, signingKid)
			if err != nil {
				return err
			}
		}
		var grant *model.OAuthGrant
		response, grant, err = persistOAuthTokens(tx, &currentClient, &user, scopes, resources, idToken)
		if err != nil {
			return err
		}
		payload.GrantID = grant.ID
		encoded, err := common.Marshal(payload)
		if err != nil {
			return err
		}
		return tx.Model(&model.AuthFlow{}).Where("id = ?", flow.Id).Update("payload", string(encoded)).Error
	})
	if errors.Is(err, model.ErrAuthFlowConsumed) {
		// ConsumeAuthFlow intentionally does not expose a consumed flow. Resolve its
		// keyed verifier only for replay handling, and prove client+redirect+PKCE
		// again before revoking: a random code cannot revoke another user's grant.
		if flow, lookupErr := model.GetConsumedOAuthAuthorizationFlow(code); lookupErr == nil {
			var payload oidcAuthorizationCodePayload
			if common.UnmarshalJsonStr(flow.Payload, &payload) == nil && payload.ClientId == client.ClientId && payload.RedirectUri == redirectURI && payload.GrantID > 0 && ValidateOidcPKCE(payload.CodeChallenge, payload.CodeChallengeMethod, verifier) == nil {
				if _, revokeErr := model.RevokeOAuthGrantForUser(payload.GrantID, flow.UserId); revokeErr != nil {
					common.SysError("failed to revoke replayed OAuth authorization")
					return nil, revokeErr
				}
			}
		}
	}
	if err != nil {
		return nil, err
	}
	return response, nil
}
