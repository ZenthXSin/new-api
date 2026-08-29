package system_setting

import (
	"strings"
	"time"

	"github.com/QuantumNous/new-api/setting/config"
)

// OauthProviderSettings configures this site as an OAuth 2.0 / OIDC identity
// provider for third-party websites and applications.
type OauthProviderSettings struct {
	Enabled bool   `json:"enabled"`
	Issuer  string `json:"issuer"`
	// AccessTokenTTLMinutes controls how long issued access/id tokens live.
	AccessTokenTTLMinutes int `json:"access_token_ttl_minutes"`
}

const (
	defaultOauthAccessTokenTTLMinutes = 480
	minOauthAccessTokenTTLMinutes     = 5
	maxOauthAccessTokenTTLMinutes     = 30 * 24 * 60
)

var defaultOauthProviderSettings = OauthProviderSettings{
	AccessTokenTTLMinutes: defaultOauthAccessTokenTTLMinutes,
}

func init() {
	config.GlobalConfig.Register("oauth_provider", &defaultOauthProviderSettings)
}

func GetOauthProviderSettings() *OauthProviderSettings {
	return &defaultOauthProviderSettings
}

// GetIssuer returns the configured issuer URL without a trailing slash. The
// issuer is the base every OIDC endpoint URL is derived from.
func (s *OauthProviderSettings) GetIssuer() string {
	return strings.TrimRight(strings.TrimSpace(s.Issuer), "/")
}

// GetAccessTokenTTL returns the configured access token lifetime.
func (s *OauthProviderSettings) GetAccessTokenTTL() time.Duration {
	minutes := s.AccessTokenTTLMinutes
	if minutes < minOauthAccessTokenTTLMinutes {
		minutes = minOauthAccessTokenTTLMinutes
	}
	if minutes > maxOauthAccessTokenTTLMinutes {
		minutes = maxOauthAccessTokenTTLMinutes
	}
	return time.Duration(minutes) * time.Minute
}
