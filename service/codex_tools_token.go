package service

import (
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/golang-jwt/jwt/v5"
)

const CodexToolsTokenPrefix = "nact_"

type CodexToolsClaims struct {
	Identity AuthIdentity `json:"identity"`
	jwt.RegisteredClaims
}

// This credential stays in the runner control process. Model relay credentials
// exposed inside workspaces must never authorize account configuration.
func IssueCodexToolsToken(identity AuthIdentity) (string, error) {
	if _, _, err := ValidateLoginSession(identity); err != nil {
		return "", err
	}
	now := time.Now()
	claims := CodexToolsClaims{Identity: identity, RegisteredClaims: jwt.RegisteredClaims{
		Issuer: "new-api", Audience: jwt.ClaimStrings{"new-api-codex-tools"}, Subject: strconv.Itoa(identity.UserID),
		IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now.Add(-5 * time.Second)), ExpiresAt: jwt.NewNumericDate(now.Add(6 * time.Hour)),
	}}
	value, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(authSigningKey("codex-tools"))
	return CodexToolsTokenPrefix + value, err
}

func ValidateCodexToolsToken(raw string) (*CodexToolsClaims, *model.UserBase, error) {
	if !strings.HasPrefix(raw, CodexToolsTokenPrefix) || len(raw) > 8192 {
		return nil, nil, ErrAuthTokenInvalid
	}
	claims := &CodexToolsClaims{}
	token, err := jwt.ParseWithClaims(strings.TrimPrefix(raw, CodexToolsTokenPrefix), claims, func(token *jwt.Token) (interface{}, error) {
		return authSigningKey("codex-tools"), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("new-api"), jwt.WithAudience("new-api-codex-tools"), jwt.WithExpirationRequired())
	if err != nil || !token.Valid || claims.Subject != strconv.Itoa(claims.Identity.UserID) {
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
