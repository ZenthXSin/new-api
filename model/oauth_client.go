package model

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
)

// IsOauthScopeSupported reports whether the scope can be granted.
func IsOauthScopeSupported(scope string) bool {
	_, ok := OAuthCapabilityByScope(scope)
	return ok
}

var (
	ErrOauthClientNotFound  = errors.New("oauth client not found")
	ErrOauthClientInvalid   = errors.New("oauth client configuration is invalid")
	ErrOauthSecretInvalid   = errors.New("oauth client secret is invalid")
	ErrOauthRedirectUnknown = errors.New("redirect_uri is not registered for this client")
)

// OauthClient is a third-party application registered to use this site as an
// OIDC identity provider. Client secrets are stored HMAC-hashed; the plaintext
// is only ever returned once at creation or secret reset.
type OauthClient struct {
	Id           int    `json:"id" gorm:"primaryKey"`
	ClientId     string `json:"client_id" gorm:"type:varchar(64);uniqueIndex;not null"`
	ClientSecret string `json:"-" gorm:"type:varchar(128);not null"` // HMAC-SHA256 hex of the plaintext secret
	Name         string `json:"name" gorm:"type:varchar(128);not null"`
	Description  string `json:"description" gorm:"type:varchar(512);default:''"`
	RedirectUris string `json:"redirect_uris" gorm:"type:text;not null"` // JSON array of exact-match URIs
	Scopes       string `json:"scopes" gorm:"type:varchar(8192);default:'openid profile email'"`
	IsPublic     bool   `json:"is_public" gorm:"default:false"` // PKCE-only client without a secret (mobile/desktop apps)
	Enabled      bool   `json:"enabled" gorm:"default:false"`
	CreatedBy    int    `json:"created_by" gorm:"default:0"`
	LastUsedAt   int64  `json:"last_used_at" gorm:"default:0"`
	CreatedTime  int64  `json:"created_time" gorm:"autoCreateTime"`
	UpdatedTime  int64  `json:"updated_time" gorm:"autoUpdateTime"`
}

func (OauthClient) TableName() string {
	return "oauth_clients"
}

// GetRedirectUris parses the stored redirect URI list. A malformed or empty
// list yields no URIs, which makes the client unusable for authorization.
func (c *OauthClient) GetRedirectUris() []string {
	var uris []string
	if strings.TrimSpace(c.RedirectUris) == "" {
		return nil
	}
	if err := common.Unmarshal([]byte(c.RedirectUris), &uris); err != nil {
		return nil
	}
	result := make([]string, 0, len(uris))
	seen := make(map[string]struct{}, len(uris))
	for _, uri := range uris {
		uri = strings.TrimSpace(uri)
		if uri == "" {
			continue
		}
		if _, ok := seen[uri]; ok {
			continue
		}
		seen[uri] = struct{}{}
		result = append(result, uri)
	}
	return result
}

// SetRedirectUris validates and stores an exact-match redirect URI list.
// Duplicates and blank entries are dropped silently so admin forms can be
// saved as-is; at least one URI must remain.
func (c *OauthClient) SetRedirectUris(uris []string) error {
	if len(uris) > 32 {
		return errors.New("at most 32 redirect_uris are allowed")
	}
	cleaned := make([]string, 0, len(uris))
	seen := make(map[string]struct{}, len(uris))
	for _, uri := range uris {
		if strings.IndexFunc(uri, unicode.IsControl) >= 0 {
			return errors.New("redirect_uri must not contain control characters")
		}
		uri = strings.TrimSpace(uri)
		if uri == "" {
			continue
		}
		if err := validateOauthRedirectURI(uri); err != nil {
			return err
		}
		if _, ok := seen[uri]; ok {
			continue
		}
		seen[uri] = struct{}{}
		cleaned = append(cleaned, uri)
	}
	if len(cleaned) == 0 {
		return errors.New("at least one redirect_uri is required")
	}
	data, err := common.Marshal(cleaned)
	if err != nil {
		return err
	}
	c.RedirectUris = string(data)
	return nil
}

// validateOauthRedirectURI restricts callbacks to HTTPS or explicit local
// development addresses. No host resolution or wildcard matching is performed.
func validateOauthRedirectURI(uri string) error {
	if len(uri) == 0 || len(uri) > 2048 {
		return errors.New("redirect_uri must contain between 1 and 2048 bytes")
	}
	if strings.ContainsAny(uri, "*#\\") || strings.IndexFunc(uri, unicode.IsControl) >= 0 || strings.IndexFunc(uri, unicode.IsSpace) >= 0 {
		return errors.New("redirect_uri must not contain fragments, wildcards, whitespace, or control characters")
	}
	parsed, err := url.Parse(uri)
	if err != nil || !parsed.IsAbs() || parsed.Opaque != "" || parsed.Hostname() == "" || parsed.User != nil {
		return errors.New("redirect_uri must be an absolute URL without credentials")
	}
	decoded, err := url.PathUnescape(uri)
	if err != nil || strings.Contains(decoded, "*") || strings.IndexFunc(decoded, unicode.IsControl) >= 0 {
		return errors.New("redirect_uri must not contain encoded wildcards or control characters")
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return errors.New("redirect_uri has an invalid query")
	}
	for key := range query {
		switch key {
		case "code", "state", "error", "error_description", "error_uri", "iss":
			return errors.New("redirect_uri must not contain reserved OAuth response parameters")
		}
	}
	if strings.HasSuffix(parsed.Host, ":") {
		return errors.New("redirect_uri has an invalid port")
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return errors.New("redirect_uri has an invalid port")
		}
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme == "http" {
		switch strings.ToLower(parsed.Hostname()) {
		case "127.0.0.1", "::1", "localhost":
			return nil
		}
	}
	return errors.New("redirect_uri must use HTTPS, or HTTP on 127.0.0.1, [::1], or localhost")
}

// GetScopes returns the scope list this client may request.
func (c *OauthClient) GetScopes() []string {
	fields := strings.Fields(c.Scopes)
	result := make([]string, 0, len(fields))
	seen := make(map[string]struct{}, len(fields))
	for _, scope := range fields {
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		result = append(result, scope)
	}
	return result
}

// HasRedirectURI reports whether the exact redirect URI is registered.
func (c *OauthClient) HasRedirectURI(redirectUri string) bool {
	if validateOauthRedirectURI(redirectUri) != nil {
		return false
	}
	for _, uri := range c.GetRedirectUris() {
		if uri == redirectUri {
			return true
		}
	}
	return false
}

// CheckSecret verifies a plaintext client secret against the stored HMAC.
func (c *OauthClient) CheckSecret(plaintext string) bool {
	plaintext = strings.TrimSpace(plaintext)
	if plaintext == "" || c.ClientSecret == "" {
		return false
	}
	return constantTimeEqual(common.GenerateHMAC(plaintext), c.ClientSecret)
}

// GenerateOauthClientSecret creates a fresh plaintext secret and stores only
// its HMAC. The caller must persist the client and return the plaintext once.
func (c *OauthClient) GenerateOauthClientSecret() (string, error) {
	secret, err := common.GenerateKey()
	if err != nil {
		return "", err
	}
	c.ClientSecret = common.GenerateHMAC(secret)
	return secret, nil
}

func constantTimeEqual(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func validateOauthClient(client *OauthClient) error {
	client.Name = strings.TrimSpace(client.Name)
	if client.Name == "" {
		return errors.New("client name is required")
	}
	if len(client.Name) > 128 {
		return errors.New("client name is too long")
	}
	if !client.IsPublic && strings.TrimSpace(client.ClientSecret) == "" {
		return errors.New("client secret is required for confidential clients")
	}
	var uris []string
	if strings.TrimSpace(client.RedirectUris) != "" {
		if err := common.Unmarshal([]byte(client.RedirectUris), &uris); err != nil {
			return errors.New("redirect_uris must be a JSON array of strings")
		}
	}
	if err := client.SetRedirectUris(uris); err != nil {
		return err
	}
	if len(client.Scopes) > 8192 {
		return errors.New("client scopes must not exceed 8192 bytes")
	}
	for _, scope := range strings.Fields(client.Scopes) {
		if !IsOauthScopeSupported(scope) {
			return fmt.Errorf("unsupported scope: %s", scope)
		}
	}
	client.Scopes = strings.Join(client.GetScopes(), " ")
	return nil
}

func GetOauthClients() ([]*OauthClient, error) {
	var clients []*OauthClient
	err := DB.Order("id asc").Find(&clients).Error
	return clients, err
}

func GetOauthClientById(id int) (*OauthClient, error) {
	var client OauthClient
	if err := DB.First(&client, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrOauthClientNotFound
		}
		return nil, err
	}
	return &client, nil
}

func GetOauthClientByClientId(clientId string) (*OauthClient, error) {
	clientId = strings.TrimSpace(clientId)
	if clientId == "" {
		return nil, ErrOauthClientInvalid
	}
	var client OauthClient
	if err := DB.Where("client_id = ?", clientId).First(&client).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrOauthClientNotFound
		}
		return nil, err
	}
	return &client, nil
}

func CreateOauthClient(client *OauthClient) error {
	if err := validateOauthClient(client); err != nil {
		return err
	}
	client.ClientId = strings.TrimSpace(client.ClientId)
	if client.ClientId == "" {
		id, err := common.GenerateRandomCharsKey(32)
		if err != nil {
			return err
		}
		client.ClientId = id
	}
	return DB.Create(client).Error
}

func UpdateOauthClient(client *OauthClient) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var stored OauthClient
		if err := lockForUpdate(tx).First(&stored, client.Id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrOauthClientNotFound
			}
			return err
		}
		if client.IsPublic != stored.IsPublic {
			return errors.New("client type cannot be changed after registration")
		}
		client.ClientSecret = stored.ClientSecret
		if err := validateOauthClient(client); err != nil {
			return err
		}
		revokeGrants := stored.Enabled && !client.Enabled
		allowedScopes := make(map[string]struct{})
		for _, scope := range client.GetScopes() {
			allowedScopes[scope] = struct{}{}
		}
		for _, scope := range stored.GetScopes() {
			if _, allowed := allowedScopes[scope]; !allowed {
				revokeGrants = true
				break
			}
		}
		if revokeGrants {
			if err := tx.Model(&OAuthGrant{}).
				Where("oauth_client_id = ? AND revoked_at = 0", stored.Id).
				Updates(map[string]interface{}{"revoked_at": time.Now().Unix(), "version": gorm.Expr("version + 1")}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&stored).Updates(map[string]interface{}{
			"name":          client.Name,
			"description":   client.Description,
			"redirect_uris": client.RedirectUris,
			"scopes":        client.Scopes,
			"enabled":       client.Enabled,
		}).Error
	})
}

func DeleteOauthClient(id int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var client OauthClient
		if err := tx.First(&client, id).Error; err != nil {
			return ErrOauthClientNotFound
		}
		if err := tx.Where("oauth_client_id = ?", id).Delete(&OauthConsent{}).Error; err != nil {
			return err
		}
		return tx.Delete(&client).Error
	})
}

// TouchOauthClientUsageById records the last time a client completed a flow.
func TouchOauthClientUsageById(id int) {
	if id <= 0 {
		return
	}
	now := time.Now().Unix()
	if err := DB.Model(&OauthClient{}).Where("id = ?", id).Update("last_used_at", now).Error; err != nil {
		common.SysError(fmt.Sprintf("failed to update oauth client usage: %v", err))
	}
}
