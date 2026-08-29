package model

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
	assert.Error(t, client.SetRedirectUris(nil))
}

func TestOauthClientValidation(t *testing.T) {
	client := &OauthClient{Name: "Test App", RedirectUris: `["https://app.example.com/cb"]`, ClientSecret: "hmac"}
	assert.NoError(t, validateOauthClient(client))

	assert.Error(t, validateOauthClient(&OauthClient{RedirectUris: `["https://app.example.com/cb"]`}), "name required")
	assert.Error(t, validateOauthClient(&OauthClient{Name: "X", RedirectUris: `["https://app.example.com/cb"]`, IsPublic: false}), "secret required for confidential")
	assert.Error(t, validateOauthClient(&OauthClient{Name: "X", ClientSecret: "hmac", RedirectUris: `[]`}), "redirect uri required")
	assert.Error(t, validateOauthClient(&OauthClient{Name: "X", ClientSecret: "hmac", RedirectUris: `["https://app.example.com/cb"]`, Scopes: "openid admin"}), "scope must be supported")
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
