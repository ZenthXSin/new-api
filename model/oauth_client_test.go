package model

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestOauthClientSecretRoundTrip(t *testing.T) {
	client := &OauthClient{}
	secret, err := client.GenerateOauthClientSecret()
	require.NoError(t, err)
	require.NotEmpty(t, secret)
	assert.NotEqual(t, secret, client.ClientSecret, "plaintext secret must not be stored")
	assert.True(t, client.CheckSecret(secret))
	assert.False(t, client.CheckSecret(secret+"x"))
	assert.False(t, client.CheckSecret(""))
}

func TestOauthClientRedirectUrisExactMatch(t *testing.T) {
	client := &OauthClient{}
	require.NoError(t, client.SetRedirectUris([]string{
		"https://app.example.com/cb",
		" https://app.example.com/cb2 ",
		"https://app.example.com/cb",
	}))
	assert.Equal(t, []string{"https://app.example.com/cb", "https://app.example.com/cb2"}, client.GetRedirectUris())
	assert.True(t, client.HasRedirectURI("https://app.example.com/cb"))
	assert.False(t, client.HasRedirectURI("https://app.example.com/cb/extra"))
	assert.False(t, client.HasRedirectURI("https://evil.example.com/cb"))
	assert.False(t, client.HasRedirectURI(" https://app.example.com/cb"), "authorization callbacks require exact string matching")
	assert.Error(t, client.SetRedirectUris(nil))
}

func TestOauthClientRedirectURIValidation(t *testing.T) {
	tests := []struct {
		name string
		uri  string
		ok   bool
	}{
		{"https", "https://app.example.com/cb?tenant=one", true},
		{"localhost", "http://localhost:3000/cb", true},
		{"ipv4 loopback", "http://127.0.0.1:49215/cb", true},
		{"ipv6 loopback", "http://[::1]:49215/cb", true},
		{"maximum length", "https://app.example.com/" + strings.Repeat("a", 2024), true},
		{"relative URL", "/cb", false},
		{"protocol relative URL", "//app.example.com/cb", false},
		{"remote HTTP", "http://app.example.com/cb", false},
		{"lookalike localhost", "http://localhost.example.com/cb", false},
		{"nonliteral loopback", "http://127.1/cb", false},
		{"local network HTTP", "http://192.168.1.2/cb", false},
		{"custom scheme", "app://cb", false},
		{"opaque URL", "https:app.example.com/cb", false},
		{"missing host", "https:///cb", false},
		{"username", "https://user@app.example.com/cb", false},
		{"password", "https://user:password@app.example.com/cb", false},
		{"fragment", "https://app.example.com/cb#state", false},
		{"empty fragment", "https://app.example.com/cb#", false},
		{"host wildcard", "https://*.example.com/cb", false},
		{"path wildcard", "https://app.example.com/*", false},
		{"encoded wildcard", "https://app.example.com/%2a", false},
		{"control character", "https://app.example.com/cb\n", false},
		{"encoded control character", "https://app.example.com/%0acb", false},
		{"backslash", "https://app.example.com\\cb", false},
		{"internal space", "https://app.example.com/cb path", false},
		{"invalid port", "https://app.example.com:65536/cb", false},
		{"empty port", "https://app.example.com:/cb", false},
		{"reserved code", "https://app.example.com/cb?code=one", false},
		{"reserved state", "https://app.example.com/cb?state=one", false},
		{"reserved error", "https://app.example.com/cb?error=one", false},
		{"reserved description", "https://app.example.com/cb?error_description=one", false},
		{"reserved error URI", "https://app.example.com/cb?error_uri=one", false},
		{"reserved issuer", "https://app.example.com/cb?iss=one", false},
		{"encoded reserved key", "https://app.example.com/cb?%63ode=one", false},
		{"invalid query", "https://app.example.com/cb?tenant=one;code=two", false},
		{"too long", "https://app.example.com/" + strings.Repeat("a", 2026), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &OauthClient{Name: "Callback app", IsPublic: true}
			setErr := client.SetRedirectUris([]string{tt.uri})
			raw, err := common.Marshal([]string{tt.uri})
			require.NoError(t, err)
			client.RedirectUris = string(raw)
			validationErr := validateOauthClient(client)
			if tt.ok {
				require.NoError(t, setErr)
				require.NoError(t, validationErr)
				assert.True(t, client.HasRedirectURI(tt.uri))
			} else {
				assert.Error(t, setErr)
				assert.Error(t, validationErr, "raw model input must not bypass URI validation")
				assert.False(t, client.HasRedirectURI(tt.uri), "invalid existing registrations must fail closed")
			}
		})
	}

	client := &OauthClient{}
	uris := make([]string, 32)
	for index := range uris {
		uris[index] = fmt.Sprintf("https://app.example.com/cb/%d", index)
	}
	require.NoError(t, client.SetRedirectUris(uris))
	assert.Error(t, client.SetRedirectUris(append(uris, "https://app.example.com/cb/32")))
}

func TestOauthClientValidation(t *testing.T) {
	client := &OauthClient{Name: "Test App", RedirectUris: `["https://app.example.com/cb"]`, ClientSecret: "hmac"}
	assert.NoError(t, validateOauthClient(client))

	assert.Error(t, validateOauthClient(&OauthClient{RedirectUris: `["https://app.example.com/cb"]`}), "name required")
	assert.Error(t, validateOauthClient(&OauthClient{Name: "X", RedirectUris: `["https://app.example.com/cb"]`, IsPublic: false}), "secret required for confidential")
	assert.Error(t, validateOauthClient(&OauthClient{Name: "X", ClientSecret: "hmac", RedirectUris: `[]`}), "redirect uri required")
	assert.Error(t, validateOauthClient(&OauthClient{Name: "X", ClientSecret: "hmac", RedirectUris: `["https://app.example.com/cb"]`, Scopes: "openid admin"}), "scope must be supported")
}

func TestOauthClientConcreteScopes(t *testing.T) {
	client := &OauthClient{Name: "Full application", IsPublic: true, RedirectUris: `["https://app.example.com/cb"]`, Scopes: strings.Join(OAuthSupportedScopes(), " ")}
	require.NoError(t, validateOauthClient(client), "every catalog capability can be registered explicitly")
	assert.Greater(t, len(client.Scopes), 256, "the complete catalog exceeds the previous persistence limit")
	for _, scope := range []string{"full", "*", "future:unknown"} {
		client.Scopes = scope
		assert.Error(t, validateOauthClient(client), "wildcards and unknown future privileges cannot be persisted")
		assert.False(t, IsOauthScopeSupported(scope))
	}
	client.Scopes = "profile:read profile:read relay:invoke"
	require.NoError(t, validateOauthClient(client))
	assert.Equal(t, "profile:read relay:invoke", client.Scopes)
	client.Scopes = "openid" + strings.Repeat(" ", 8192-len("openid"))
	require.NoError(t, validateOauthClient(client))
	client.Scopes = "openid" + strings.Repeat(" ", 8193-len("openid"))
	assert.Error(t, validateOauthClient(client))
}

func TestOauthClientUpdatePreservesClientTypeAndSecret(t *testing.T) {
	truncateTables(t)
	for _, isPublic := range []bool{false, true} {
		t.Run(fmt.Sprintf("public=%t", isPublic), func(t *testing.T) {
			client := &OauthClient{Name: "Immutable client type", IsPublic: isPublic, Enabled: true, Scopes: strings.Join(OAuthSupportedScopes(), " ")}
			originalSecret := ""
			if !isPublic {
				var err error
				originalSecret, err = client.GenerateOauthClientSecret()
				require.NoError(t, err)
			}
			require.NoError(t, client.SetRedirectUris([]string{"https://app.example.com/cb"}))
			require.NoError(t, CreateOauthClient(client))
			storedHash := client.ClientSecret
			client.IsPublic = !isPublic
			assert.Error(t, UpdateOauthClient(client), "public and confidential clients cannot change type")
			client.IsPublic = isPublic
			client.Name = "Renamed application"
			client.ClientSecret = "replacement must be ignored"
			require.NoError(t, UpdateOauthClient(client))
			require.NoError(t, UpdateOauthClient(client), "saving unchanged settings succeeds")
			loaded, err := GetOauthClientById(client.Id)
			require.NoError(t, err)
			assert.Equal(t, isPublic, loaded.IsPublic)
			assert.Equal(t, "Renamed application", loaded.Name)
			assert.Equal(t, storedHash, loaded.ClientSecret)
			assert.Equal(t, OAuthSupportedScopes(), loaded.GetScopes())
			if !isPublic {
				assert.True(t, loaded.CheckSecret(originalSecret))
			}
		})
	}
	assert.ErrorIs(t, UpdateOauthClient(&OauthClient{Id: 987654321}), ErrOauthClientNotFound)
}

func TestOauthClientRestrictionsPermanentlyRevokeExistingGrants(t *testing.T) {
	truncateTables(t)
	require.NoError(t, DB.AutoMigrate(&OAuthGrant{}))
	var grantIDs []int
	t.Cleanup(func() {
		if len(grantIDs) > 0 {
			require.NoError(t, DB.Where("id IN ?", grantIDs).Delete(&OAuthGrant{}).Error)
		}
	})
	tests := []struct {
		name        string
		enabled     bool
		scopes      string
		wantRevoked bool
		failUpdate  bool
	}{
		{"disable", false, "openid profile:read", true, false},
		{"remove scope", true, "openid", true, false},
		{"replace scope", true, "openid relay:read", true, false},
		{"add scope", true, "openid profile:read relay:read", false, false},
		{"same scopes reordered", true, "profile:read openid", false, false},
		{"client update rollback", false, "openid profile:read", false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &OauthClient{Name: "Grant owner app", IsPublic: true, Enabled: true, Scopes: "openid profile:read"}
			require.NoError(t, client.SetRedirectUris([]string{"https://app.example.com/cb"}))
			require.NoError(t, CreateOauthClient(client))
			otherClient := &OauthClient{Name: "Other app", IsPublic: true, Enabled: true, Scopes: "openid", RedirectUris: client.RedirectUris}
			require.NoError(t, CreateOauthClient(otherClient))
			grants := make([]OAuthGrant, 4)
			for index := range grants {
				grant := &grants[index]
				*grant = OAuthGrant{
					UserID: index + 1, OAuthClientID: client.Id, Scopes: "openid",
					Resources: `["urn:new-api:dashboard"]`, UserAuthVersion: 1,
					UserAuthFingerprint: "test-user", ClientAuthVersion: "test-client",
					ExpiresAt: time.Now().Add(time.Hour).Unix(),
				}
				if index == 3 {
					grant.OAuthClientID = otherClient.Id
				}
				require.NoError(t, CreateOAuthGrant(grant))
				grantIDs = append(grantIDs, grant.ID)
			}
			// An already revoked authorization must not acquire a new version or
			// revocation timestamp just because its client is changed again.
			require.NoError(t, DB.Model(&grants[2]).Update("revoked_at", 123).Error)
			client.Enabled = tt.enabled
			client.Scopes = tt.scopes
			if tt.failUpdate {
				forcedErr := errors.New("test client update failure")
				callbackName := "test:oauth_client_update_rollback"
				require.NoError(t, DB.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
					if tx.Statement.Table == "oauth_clients" {
						tx.AddError(forcedErr)
					}
				}))
				updateErr := UpdateOauthClient(client)
				require.NoError(t, DB.Callback().Update().Remove(callbackName))
				assert.ErrorIs(t, updateErr, forcedErr)
				persistedClient, err := GetOauthClientById(client.Id)
				require.NoError(t, err)
				assert.True(t, persistedClient.Enabled, "client configuration and grant revocation must commit together")
			} else {
				require.NoError(t, UpdateOauthClient(client))
			}
			client.Enabled = true
			client.Scopes = "openid profile:read relay:read"
			require.NoError(t, UpdateOauthClient(client), "restoring configuration must never resurrect existing grants")
			for index, original := range grants {
				var persisted OAuthGrant
				require.NoError(t, DB.First(&persisted, original.ID).Error)
				assert.Equal(t, "openid", persisted.Scopes, "client scope expansion must not expand prior grants")
				switch {
				case index == 2:
					assert.Equal(t, int64(123), persisted.RevokedAt)
					assert.Equal(t, int64(1), persisted.Version)
				case index < 2 && tt.wantRevoked:
					assert.Positive(t, persisted.RevokedAt)
					assert.Equal(t, int64(2), persisted.Version)
					_, err := GetOAuthGrantByID(original.ID)
					assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
				default:
					assert.Zero(t, persisted.RevokedAt)
					assert.Equal(t, int64(1), persisted.Version)
					_, err := GetOAuthGrantByID(original.ID)
					require.NoError(t, err)
				}
			}
		})
	}
}

func TestOauthClientCrudAndCascade(t *testing.T) {
	truncateTables(t)
	client := &OauthClient{Name: "CRUD App", ClientId: "crud-client", Scopes: "openid profile", Enabled: true}
	secret, err := client.GenerateOauthClientSecret()
	require.NoError(t, err)
	require.NoError(t, client.SetRedirectUris([]string{"https://app.example.com/cb"}))
	require.NoError(t, CreateOauthClient(client))

	user := User{Username: "consent-user", Password: "password", Status: 1, Group: "default"}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, SaveOauthConsent(user.Id, client.Id, []string{"openid"}))
	require.NoError(t, SaveOauthConsent(user.Id, client.Id, []string{"openid", "profile"}))

	loaded, err := GetOauthConsent(user.Id, client.Id)
	require.NoError(t, err)
	require.NotNil(t, loaded)
	assert.True(t, loaded.CoversScopes([]string{"openid", "profile"}))
	assert.False(t, loaded.CoversScopes([]string{"openid", "email"}))

	require.NoError(t, DeleteOauthClient(client.Id))
	_, err = GetOauthClientById(client.Id)
	assert.ErrorIs(t, err, ErrOauthClientNotFound)
	consent, err := GetOauthConsent(user.Id, client.Id)
	require.NoError(t, err)
	assert.Nil(t, consent, "consents must be removed with the client")
	_ = secret
}

func TestOauthSigningKeyPersistence(t *testing.T) {
	truncateTables(t)
	privateKey, kid, err := GetOrCreateOauthSigningKey()
	require.NoError(t, err)
	require.NotEmpty(t, kid)

	again, kidAgain, err := GetOrCreateOauthSigningKey()
	require.NoError(t, err)
	assert.Equal(t, kid, kidAgain, "must reuse the existing key instead of rotating every call")
	assert.Equal(t, privateKey.N, again.N)

	keys, err := GetOauthJWKS()
	require.NoError(t, err)
	require.Len(t, keys, 1)
	assert.Equal(t, kid, keys[0].Kid)
	assert.Equal(t, "RSA", keys[0].Kty)
	assert.Equal(t, "RS256", keys[0].Alg)
	assert.NotEmpty(t, keys[0].N)
	assert.Equal(t, "AQAB", keys[0].E, "2048-bit generated keys use exponent 65537")

	loaded, err := LoadOidcSigningKeyByKid(kid)
	require.NoError(t, err)
	assert.Equal(t, privateKey.N, loaded.N)

	_, err = LoadOidcSigningKeyByKid("missing-kid")
	assert.Error(t, err)
}

func TestOauthConsentUpsertWidensScopes(t *testing.T) {
	truncateTables(t)
	client := &OauthClient{Name: "Consent App", ClientId: "consent-client", Scopes: "openid profile email", Enabled: true, IsPublic: true}
	require.NoError(t, client.SetRedirectUris([]string{"https://app.example.com/cb"}))
	require.NoError(t, CreateOauthClient(client))
	user := User{Username: "consent-widen-user", Password: "password", Status: 1, Group: "default"}
	require.NoError(t, DB.Create(&user).Error)

	assert.NoError(t, SaveOauthConsent(user.Id, client.Id, []string{"openid"}))
	require.NoError(t, SaveOauthConsent(user.Id, client.Id, []string{"openid", "profile", "email"}))
	require.NoError(t, SaveOauthConsent(user.Id, client.Id, []string{"openid"}))

	consent, err := GetOauthConsent(user.Id, client.Id)
	require.NoError(t, err)
	require.NotNil(t, consent)
	assert.True(t, consent.CoversScopes([]string{"openid", "profile", "email"}))

	missing, err := GetOauthConsent(user.Id+999, client.Id)
	require.NoError(t, err)
	assert.Nil(t, missing)
}
