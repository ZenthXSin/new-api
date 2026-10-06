package service

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"slices"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	oidcCodePurpose    = "oidc_code"
	oidcCodeTTL        = 5 * time.Minute
	oidcAccessTokenUse = "oidc_access"
	oidcIDTokenUse     = "oidc_id_token"
	oidcPKCEMethodS256 = "S256"
	oidcScopeOpenID    = "openid"
	oidcClaimGroups    = "groups"
)

// OidcErrorAccessDenied is the RFC 6749 error code for a denied consent.
const OidcErrorAccessDenied = "access_denied"

var (
	ErrOidcProviderDisabled  = errors.New("oidc provider is disabled")
	ErrOidcRequestInvalid    = errors.New("oidc request is invalid")
	ErrOidcScopeNotRequested = errors.New("scope is not granted to this client")
	ErrOidcPKCEInvalid       = errors.New("pkce verification failed")
	ErrOidcTokenInvalid      = errors.New("oidc token is invalid")
)

// OidcAuthorizeInput is the validated /authorize request bound to a code.
type OidcAuthorizeInput struct {
	Client              *model.OauthClient
	UserId              int
	Scopes              []string
	RedirectUri         string
	State               string
	Nonce               string
	CodeChallenge       string
	CodeChallengeMethod string
	Resources           []string
}

type oidcAuthorizationCodePayload struct {
	ClientId            string   `json:"client_id"`
	RedirectUri         string   `json:"redirect_uri"`
	Scope               string   `json:"scope"`
	Nonce               string   `json:"nonce,omitempty"`
	CodeChallenge       string   `json:"code_challenge,omitempty"`
	CodeChallengeMethod string   `json:"code_challenge_method,omitempty"`
	State               string   `json:"state,omitempty"`
	Resources           []string `json:"resources"`
	UserAuthVersion     int64    `json:"user_auth_version"`
	UserAuthFingerprint string   `json:"user_auth_fingerprint"`
	ClientAuthVersion   string   `json:"client_auth_version"`
	GrantID             int      `json:"grant_id,omitempty"`
}

type oidcAccessTokenClaims struct {
	Scope    string `json:"scope"`
	TokenUse string `json:"token_use"`
	ClientId string `json:"client_id"`
	jwt.RegisteredClaims
}

type oidcIDTokenClaims struct {
	Nonce             string   `json:"nonce,omitempty"`
	Name              string   `json:"name,omitempty"`
	PreferredUsername string   `json:"preferred_username,omitempty"`
	Email             string   `json:"email,omitempty"`
	EmailVerified     bool     `json:"email_verified,omitempty"`
	Groups            []string `json:"groups,omitempty"`
	Quota             int      `json:"quota"`
	UsedQuota         int      `json:"used_quota"`
	QuotaPerUnit      float64  `json:"quota_per_unit"`
	jwt.RegisteredClaims
}

// NormalizeOidcScopes splits a space-delimited scope parameter and validates it
// against both the protocol scope list and the client's allowed scopes.
func NormalizeOidcScopes(requested string, client *model.OauthClient) ([]string, error) {
	fields := strings.Fields(requested)
	if len(fields) == 0 {
		return nil, ErrOidcRequestInvalid
	}
	allowed := make(map[string]struct{})
	for _, scope := range client.GetScopes() {
		allowed[scope] = struct{}{}
	}
	result := make([]string, 0, len(fields))
	seen := make(map[string]struct{}, len(fields))
	for _, scope := range fields {
		if scope != "full" && !model.IsOauthScopeSupported(scope) {
			return nil, fmt.Errorf("%w: %s", ErrOidcScopeNotRequested, scope)
		}
		if _, ok := allowed[scope]; scope != "full" && !ok {
			return nil, fmt.Errorf("%w: %s", ErrOidcScopeNotRequested, scope)
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		result = append(result, scope)
	}
	return result, nil
}

// ValidateOidcPKCE checks a PKCE code_verifier against the stored challenge.
func ValidateOidcPKCE(challenge, method, verifier string) error {
	if ValidateOidcPKCEChallenge(challenge, method) != nil {
		return ErrOidcPKCEInvalid
	}
	verifier = strings.TrimSpace(verifier)
	if verifier == "" || len(verifier) < 43 || len(verifier) > 128 {
		return ErrOidcPKCEInvalid
	}
	for _, character := range verifier {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || strings.ContainsRune("-._~", character)) {
			return ErrOidcPKCEInvalid
		}
	}
	if method != oidcPKCEMethodS256 {
		return ErrOidcPKCEInvalid
	}
	digest := sha256.Sum256([]byte(verifier))
	expected := base64.RawURLEncoding.EncodeToString(digest[:])
	if subtle.ConstantTimeCompare([]byte(expected), []byte(challenge)) != 1 {
		return ErrOidcPKCEInvalid
	}
	return nil
}

// ValidateOidcPKCEChallenge requires S256 for public and confidential clients.
func ValidateOidcPKCEChallenge(challenge, method string) error {
	if method != oidcPKCEMethodS256 || len(challenge) != 43 {
		return ErrOidcPKCEInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challenge)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != challenge {
		return ErrOidcPKCEInvalid
	}
	return nil
}

// CreateOidcAuthorizationCode binds the user's explicit consent to the client,
// current authorization state, redirect, scope snapshot and PKCE challenge.
func CreateOidcAuthorizationCode(input OidcAuthorizeInput) (string, error) {
	if input.Client == nil || input.UserId <= 0 || !input.Client.HasRedirectURI(input.RedirectUri) || len(input.Scopes) == 0 || slices.Contains(input.Scopes, "full") {
		return "", ErrOidcRequestInvalid
	}
	if err := ValidateOidcPKCEChallenge(input.CodeChallenge, input.CodeChallengeMethod); err != nil {
		return "", err
	}
	user, err := model.GetUserById(input.UserId, true)
	if err != nil || user.Status != common.UserStatusEnabled || user.AuthVersion <= 0 {
		return "", ErrOidcRequestInvalid
	}
	scopes, err := OAuthScopesForConsent(input.UserId, input.Client, input.Scopes)
	if err != nil {
		return "", err
	}
	resources, err := OAuthNormalizeResources(input.Resources)
	if err != nil {
		return "", err
	}
	payload := oidcAuthorizationCodePayload{
		ClientId: input.Client.ClientId, RedirectUri: input.RedirectUri, Scope: strings.Join(scopes, " "), Nonce: input.Nonce,
		CodeChallenge: input.CodeChallenge, CodeChallengeMethod: input.CodeChallengeMethod, State: input.State,
		Resources: resources, UserAuthVersion: user.AuthVersion, UserAuthFingerprint: oauthUserFingerprint(user), ClientAuthVersion: oauthClientFingerprint(input.Client),
	}
	payloadBytes, err := common.Marshal(payload)
	if err != nil {
		return "", err
	}
	code, _, err := model.CreateAuthFlow(model.AuthFlowCreate{Purpose: oidcCodePurpose, UserId: input.UserId, Payload: string(payloadBytes), ExpiresAt: time.Now().Add(oidcCodeTTL)})
	return code, err
}

func issueOidcIDToken(client *model.OauthClient, user *model.User, scopes []string, nonce string) (idToken string, err error) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled || settings.GetIssuer() == "" {
		return "", ErrOidcProviderDisabled
	}
	privateKey, kid, err := model.GetOrCreateOauthSigningKey()
	if err != nil {
		return "", err
	}
	return issueOidcIDTokenWithKey(client, user, scopes, nonce, privateKey, kid)
}

func issueOidcIDTokenWithKey(client *model.OauthClient, user *model.User, scopes []string, nonce string, privateKey *rsa.PrivateKey, kid string) (idToken string, err error) {
	settings := system_setting.GetOauthProviderSettings()
	issuer := settings.GetIssuer()
	now := time.Now()
	scopeSet := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		scopeSet[scope] = struct{}{}
	}
	if _, ok := scopeSet[oidcScopeOpenID]; ok {
		idClaims := oidcIDTokenClaims{
			Nonce: nonce,
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    issuer,
				Subject:   fmt.Sprintf("%d", user.Id),
				Audience:  jwt.ClaimStrings{client.ClientId},
				ExpiresAt: jwt.NewNumericDate(now.Add(settings.GetAccessTokenTTL())),
				NotBefore: jwt.NewNumericDate(now.Add(-5 * time.Second)),
				IssuedAt:  jwt.NewNumericDate(now),
				ID:        uuid.NewString(),
			},
		}
		if _, ok := scopeSet["profile"]; ok {
			idClaims.Name = user.DisplayName
			if idClaims.Name == "" {
				idClaims.Name = user.Username
			}
			idClaims.PreferredUsername = user.Username
			idClaims.Groups = user.GetGroups()
			idClaims.Quota = user.Quota
			idClaims.UsedQuota = user.UsedQuota
			idClaims.QuotaPerUnit = common.QuotaPerUnit
		}
		if _, ok := scopeSet["email"]; ok && user.Email != "" {
			idClaims.Email = user.Email
			idClaims.EmailVerified = true
		}
		idToken, err = signOidcToken(idClaims, privateKey, kid)
		if err != nil {
			return "", err
		}
	}
	return idToken, nil
}

func signOidcToken(claims jwt.Claims, privateKey *rsa.PrivateKey, kid string) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = kid
	return token.SignedString(privateKey)
}

// ParseOidcAccessToken only accepts current, persisted access credentials.
// Legacy identity-only JWT access tokens require one new authorization after
// this upgrade; ID tokens remain JWTs and are never resource credentials.
func ParseOidcAccessToken(raw string) (userId int, scopes []string, err error) {
	principal, recognized, err := AuthenticateOAuthAccessToken(raw)
	if !recognized || err != nil || !slices.Contains(principal.Resources, OAuthResourceDashboard) {
		return 0, nil, ErrOidcTokenInvalid
	}
	return principal.UserID, principal.Scopes, nil
}

// BuildOidcDiscovery returns the OIDC discovery document for the issuer.
func BuildOidcDiscovery() map[string]interface{} {
	issuer := system_setting.GetOauthProviderSettings().GetIssuer()
	return map[string]interface{}{
		"issuer":                                issuer,
		"authorization_endpoint":                issuer + "/authorize",
		"token_endpoint":                        issuer + "/token",
		"userinfo_endpoint":                     issuer + "/userinfo",
		"revocation_endpoint":                   issuer + "/revoke",
		"jwks_uri":                              issuer + "/.well-known/jwks.json",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      model.OAuthSupportedScopes(),
		"authorization_response_iss_parameter_supported": true,
		"token_endpoint_auth_methods_supported":          []string{"client_secret_basic", "client_secret_post", "none"},
		"claims_supported":                               []string{"sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "name", "preferred_username", "email", "email_verified", "groups", "quota", "used_quota", "quota_per_unit"},
		"code_challenge_methods_supported":               []string{"S256"},
	}
}

// BuildOidcUserInfo returns the claims a granted access token may read.
func BuildOidcUserInfo(user *model.User, scopes []string) map[string]interface{} {
	claims := map[string]interface{}{
		"sub": fmt.Sprintf("%d", user.Id),
	}
	scopeSet := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		scopeSet[scope] = struct{}{}
	}
	if _, ok := scopeSet["profile"]; ok {
		displayName := user.DisplayName
		if displayName == "" {
			displayName = user.Username
		}
		claims["name"] = displayName
		claims["preferred_username"] = user.Username
		claims["groups"] = user.GetGroups()
		claims["quota"] = user.Quota
		claims["used_quota"] = user.UsedQuota
		claims["quota_per_unit"] = common.QuotaPerUnit
	}
	if _, ok := scopeSet["email"]; ok && user.Email != "" {
		claims["email"] = user.Email
		claims["email_verified"] = true
	}
	return claims
}

// GenerateOidcStateToken creates a random state parameter for the consent flow.
func GenerateOidcStateToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
