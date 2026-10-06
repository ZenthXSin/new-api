package service

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthFullConsentIsConcreteRoleSnapshot(t *testing.T) {
	scopes, err := OAuthExpandScopesForUser(1, common.RoleCommonUser, []string{"full", "profile:read"})
	require.NoError(t, err)
	assert.Contains(t, scopes, "profile:read")
	assert.Contains(t, scopes, "relay:invoke")
	assert.NotContains(t, scopes, "full")
	assert.NotContains(t, scopes, "*")
	assert.NotContains(t, scopes, "user:write")
	assert.NotContains(t, scopes, "channel:read")
	assert.NotContains(t, scopes, "option:write")
	user := &model.User{Id: 1, Role: common.RoleRootUser, Status: common.UserStatusEnabled}
	principal := &OAuthPrincipal{UserID: 1, User: user, Scopes: scopes}
	assert.False(t, OAuthScopeAllowed(principal, "option:write"), "later promotion must not extend old grants")
	assert.True(t, OAuthScopeAllowed(principal, "profile:read"))
}

func TestOAuthScopesRejectUnknownAndUngrantablePermissions(t *testing.T) {
	for _, scope := range []string{"*", "profile:*", "future:read", " profile:read"} {
		_, err := OAuthExpandScopesForUser(1, common.RoleCommonUser, []string{scope})
		assert.ErrorIs(t, err, ErrOAuthScopeInvalid, scope)
	}
	_, err := OAuthExpandScopesForUser(1, common.RoleCommonUser, []string{"user:write"})
	assert.ErrorIs(t, err, ErrOAuthScopeForbidden)
	scopes, err := OAuthExpandScopesForUser(1, common.RoleCommonUser, []string{"wallet:read", "profile:read", "wallet:read"})
	require.NoError(t, err)
	assert.Equal(t, []string{"profile:read", "wallet:read"}, scopes)
}

func TestOAuthScopeRequiresCurrentEnabledMatchingUser(t *testing.T) {
	user := &model.User{Id: 42, Role: common.RoleAdminUser, Status: common.UserStatusEnabled}
	principal := &OAuthPrincipal{UserID: 42, User: user, Scopes: []string{"user:read", "profile:read"}}
	assert.True(t, OAuthScopeAllowed(principal, "user:read"))
	user.Role = common.RoleCommonUser
	assert.False(t, OAuthScopeAllowed(principal, "user:read"))
	assert.True(t, OAuthScopeAllowed(principal, "profile:read"))
	user.Status = common.UserStatusDisabled
	assert.False(t, OAuthScopeAllowed(principal, "profile:read"))
	assert.False(t, OAuthScopeAllowed(principal, ""))
	user.Status = common.UserStatusEnabled
	principal.UserID = 99
	assert.False(t, OAuthScopeAllowed(principal, "profile:read"))
	assert.False(t, OAuthScopeAllowed(nil, "profile:read"))
}
