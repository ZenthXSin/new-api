package service

import (
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/golang-jwt/jwt/v5"
)

const CodexRelayTokenPrefix = "nacx_"
const CodexRelayContextKey = "codex_workbench_relay"
const CodexRelayAllowedChannelsKey = "codex_workbench_allowed_channels"

type CodexRelayClaims struct {
	Identity AuthIdentity `json:"identity"`
	Group    string       `json:"group"`
	Model    string       `json:"model"`
	jwt.RegisteredClaims
}

func IssueCodexRelayToken(identity AuthIdentity, group, name string) (string, error) {
	_, user, err := ValidateLoginSession(identity)
	if err != nil {
		return "", err
	}
	if _, err := CodexAllowedChannels(user, group, name, "/v1/responses"); err != nil {
		return "", err
	}
	now := time.Now()
	claims := CodexRelayClaims{Identity: identity, Group: group, Model: name, RegisteredClaims: jwt.RegisteredClaims{
		Issuer: "new-api", Audience: jwt.ClaimStrings{"new-api-codex-relay"}, Subject: strconv.Itoa(identity.UserID),
		IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now.Add(-5 * time.Second)), ExpiresAt: jwt.NewNumericDate(now.Add(6 * time.Hour)),
	}}
	value, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(authSigningKey("codex-relay"))
	return CodexRelayTokenPrefix + value, err
}

func ValidateCodexRelayToken(raw string) (*CodexRelayClaims, *model.UserBase, error) {
	if !strings.HasPrefix(raw, CodexRelayTokenPrefix) || len(raw) > 8192 {
		return nil, nil, ErrAuthTokenInvalid
	}
	claims := &CodexRelayClaims{}
	token, err := jwt.ParseWithClaims(strings.TrimPrefix(raw, CodexRelayTokenPrefix), claims, func(token *jwt.Token) (interface{}, error) {
		return authSigningKey("codex-relay"), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("new-api"), jwt.WithAudience("new-api-codex-relay"), jwt.WithExpirationRequired())
	if err != nil || !token.Valid || claims.Subject != strconv.Itoa(claims.Identity.UserID) || claims.Group == "" || claims.Model == "" {
		return nil, nil, ErrAuthTokenInvalid
	}
	_, user, err := ValidateLoginSession(claims.Identity)
	if err != nil {
		return nil, nil, ErrLoginSessionInvalid
	}
	allowed, err := model.CodexUserCanAccess(user.Id)
	if err != nil || !allowed {
		return nil, nil, ErrLoginSessionInvalid
	}
	return claims, user, nil
}
