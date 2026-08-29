package service

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"
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
}

type oidcAuthorizationCodePayload struct {
	ClientId            string `json:"client_id"`
	RedirectUri         string `json:"redirect_uri"`
	Scope               string `json:"scope"`
	Nonce               string `json:"nonce,omitempty"`
	CodeChallenge       string `json:"code_challenge,omitempty"`
	CodeChallengeMethod string `json:"code_challenge_method,omitempty"`
	State               string `json:"state,omitempty"`
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
		if !model.IsOauthScopeSupported(scope) {
			return nil, fmt.Errorf("%w: %s", ErrOidcScopeNotRequested, scope)
		}
		if _, ok := allowed[scope]; !ok {
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
	if challenge == "" {
		return nil
	}
	verifier = strings.TrimSpace(verifier)
	if verifier == "" || len(verifier) < 43 || len(verifier) > 128 {
		return ErrOidcPKCEInvalid
	}
	if method != "" && method != oidcPKCEMethodS256 {
		return ErrOidcPKCEInvalid
	}
	digest := sha256.Sum256([]byte(verifier))
	expected := base64.RawURLEncoding.EncodeToString(digest[:])
	if subtle.ConstantTimeCompare([]byte(expected), []byte(challenge)) != 1 {
		return ErrOidcPKCEInvalid
	}
	return nil
}

// CreateOidcAuthorizationCode stores a single-use authorization code bound to
// the user, client and request parameters via the shared AuthFlow table.
func CreateOidcAuthorizationCode(input OidcAuthorizeInput) (string, error) {
	if input.Client == nil || input.UserId <= 0 || input.RedirectUri == "" || len(input.Scopes) == 0 {
		return "", ErrOidcRequestInvalid
	}
	if input.Client.IsPublic && input.CodeChallenge == "" {
		return "", ErrOidcRequestInvalid
	}
	payload := oidcAuthorizationCodePayload{
		ClientId:            input.Client.ClientId,
		RedirectUri:         input.RedirectUri,
		Scope:               strings.Join(input.Scopes, " "),
		Nonce:               input.Nonce,
		CodeChallenge:       input.CodeChallenge,
		CodeChallengeMethod: input.CodeChallengeMethod,
		State:               input.State,
	}
	payloadBytes, err := common.Marshal(payload)
	if err != nil {
		return "", err
	}
	code, _, err := model.CreateAuthFlow(model.AuthFlowCreate{
		Purpose:   oidcCodePurpose,
		UserId:    input.UserId,
		Payload:   string(payloadBytes),
		ExpiresAt: time.Now().Add(oidcCodeTTL),
	})
	if err != nil {
		return "", err
	}
	return code, nil
}

// ConsumeOidcAuthorizationCode atomically redeems a code for one client.
func ConsumeOidcAuthorizationCode(code string, client *model.OauthClient, redirectUri string) (*oidcAuthorizationCodePayload, int, error) {
	if code == "" || client == nil {
		return nil, 0, ErrOidcRequestInvalid
	}
	var payload oidcAuthorizationCodePayload
	var userId int
	_, err := model.ConsumeAuthFlowWithAction(code, model.AuthFlowMatch{Purpose: oidcCodePurpose}, func(_ *gorm.DB, flow *model.AuthFlow) error {
		if strings.TrimSpace(flow.Payload) == "" {
			return ErrOidcRequestInvalid
		}
		if err := common.Unmarshal([]byte(flow.Payload), &payload); err != nil {
			return ErrOidcRequestInvalid
		}
		if payload.ClientId != client.ClientId || payload.RedirectUri != redirectUri {
			return ErrOidcRequestInvalid
		}
		userId = flow.UserId
		return nil
	})
	if err != nil {
		if errors.Is(err, model.ErrAuthFlowConsumed) {
			return nil, 0, model.ErrAuthFlowConsumed
		}
		if errors.Is(err, model.ErrAuthFlowExpired) {
			return nil, 0, model.ErrAuthFlowExpired
		}
		return nil, 0, ErrOidcRequestInvalid
	}
	return &payload, userId, nil
}

// IssueOidcTokens signs the access token and (for openid requests) the
// id_token with the provider's RS256 key.
func IssueOidcTokens(client *model.OauthClient, user *model.User, scopes []string, nonce string) (accessToken string, idToken string, expiresIn int64, err error) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled {
		return "", "", 0, ErrOidcProviderDisabled
	}
	issuer := settings.GetIssuer()
	if issuer == "" {
		return "", "", 0, ErrOidcRequestInvalid
	}
	privateKey, kid, err := model.GetOrCreateOauthSigningKey()
	if err != nil {
		return "", "", 0, err
	}
	scope := strings.Join(scopes, " ")
	now := time.Now()
	expiresIn = int64(settings.GetAccessTokenTTL() / time.Second)

	accessClaims := oidcAccessTokenClaims{
		Scope:    scope,
		TokenUse: oidcAccessTokenUse,
		ClientId: client.ClientId,
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
	accessToken, err = signOidcToken(accessClaims, privateKey, kid)
	if err != nil {
		return "", "", 0, err
	}

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
		}
		if _, ok := scopeSet["email"]; ok && user.Email != "" {
			idClaims.Email = user.Email
			idClaims.EmailVerified = true
		}
		idToken, err = signOidcToken(idClaims, privateKey, kid)
		if err != nil {
			return "", "", 0, err
		}
	}
	return accessToken, idToken, expiresIn, nil
}

func signOidcToken(claims jwt.Claims, privateKey *rsa.PrivateKey, kid string) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = kid
	return token.SignedString(privateKey)
}

// ParseOidcAccessToken verifies an RS256 access token issued by this provider
// and returns the subject user id and granted scopes.
func ParseOidcAccessToken(raw string) (userId int, scopes []string, err error) {
	settings := system_setting.GetOauthProviderSettings()
	if !settings.Enabled {
		return 0, nil, ErrOidcProviderDisabled
	}
	issuer := settings.GetIssuer()
	claims := &oidcAccessTokenClaims{}
	parsed, parseErr := jwt.NewParser(jwt.WithValidMethods([]string{"RS256"})).ParseWithClaims(raw, claims, func(token *jwt.Token) (interface{}, error) {
		kid, _ := token.Header["kid"].(string)
		key, keyErr := loadOidcSigningKeyByKid(kid)
		if keyErr != nil {
			return nil, ErrOidcTokenInvalid
		}
		return &key.PublicKey, nil
	})
	if parseErr != nil || !parsed.Valid {
		return 0, nil, ErrOidcTokenInvalid
	}
	if claims.Issuer != issuer || claims.TokenUse != oidcAccessTokenUse || claims.Subject == "" {
		return 0, nil, ErrOidcTokenInvalid
	}
	userId, convErr := strconv.Atoi(claims.Subject)
	if convErr != nil || userId <= 0 {
		return 0, nil, ErrOidcTokenInvalid
	}
	return userId, strings.Fields(claims.Scope), nil
}

func loadOidcSigningKeyByKid(kid string) (*rsa.PrivateKey, error) {
	if kid == "" {
		return model.LoadActiveOidcSigningKey()
	}
	return model.LoadOidcSigningKeyByKid(kid)
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
		"grant_types_supported":                 []string{"authorization_code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "profile", "email"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post", "none"},
		"claims_supported":                      []string{"sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "name", "preferred_username", "email", "email_verified", "groups"},
		"code_challenge_methods_supported":      []string{"S256"},
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
