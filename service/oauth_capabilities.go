package service

import (
	"errors"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/authz"
)

const (
	OAuthCatalogVersion    = model.OAuthCatalogVersion
	OAuthResourceDashboard = model.OAuthResourceDashboard
	OAuthResourceRelay     = model.OAuthResourceRelay
)

type OAuthCapability = model.OAuthCapability

var (
	ErrOAuthScopeInvalid   = errors.New("oauth scope is invalid")
	ErrOAuthScopeForbidden = errors.New("oauth scope cannot be granted")
)

// OAuthScopesForUser returns the current role and permission intersection. It
// does not infer future scopes or future administrator privileges.
func OAuthScopesForUser(userID, role int) []OAuthCapability {
	capabilities := make([]OAuthCapability, 0)
	if userID <= 0 || !common.IsValidateRole(role) {
		return capabilities
	}
	permissions := authz.CurrentPermissions(userID, role)
	for _, capability := range model.OAuthCapabilities() {
		if role < capability.MinRole {
			continue
		}
		resource, action, _ := strings.Cut(capability.Scope, ":")
		if resource == authz.ResourceChannel && !permissions[resource][action] {
			continue
		}
		capabilities = append(capabilities, capability)
	}
	return capabilities
}

// OAuthExpandScopesForUser validates literal requested scopes and expands the
// full consent macro once. A stored grant must only contain its return value.
func OAuthExpandScopesForUser(userID, role int, requested []string) ([]string, error) {
	allowed := make(map[string]bool)
	for _, capability := range OAuthScopesForUser(userID, role) {
		allowed[capability.Scope] = true
	}
	result := make(map[string]bool)
	for _, scope := range requested {
		if scope == "full" {
			for scope := range allowed {
				result[scope] = true
			}
			continue
		}
		if _, known := model.OAuthCapabilityByScope(scope); !known {
			return nil, ErrOAuthScopeInvalid
		}
		if !allowed[scope] {
			return nil, ErrOAuthScopeForbidden
		}
		result[scope] = true
	}
	scopes := make([]string, 0, len(result))
	for scope := range result {
		scopes = append(scopes, scope)
	}
	slices.Sort(scopes)
	return scopes, nil
}

// OAuthScopeAllowed applies literal grant membership and the current user
// permissions. Access-token validation refreshes principal.User from storage
// on each request; a caller must never build a principal from untrusted JSON.
func OAuthScopeAllowed(principal *OAuthPrincipal, requiredScope string) bool {
	if principal == nil || principal.User == nil || principal.UserID != principal.User.Id || principal.User.Status != common.UserStatusEnabled {
		return false
	}
	if requiredScope == "" {
		return true
	}
	if !slices.Contains(principal.Scopes, requiredScope) {
		return false
	}
	capability, known := model.OAuthCapabilityByScope(requiredScope)
	if !known || principal.User.Role < capability.MinRole {
		return false
	}
	resource, action, _ := strings.Cut(requiredScope, ":")
	if resource == authz.ResourceChannel {
		return authz.CurrentPermissions(principal.UserID, principal.User.Role)[resource][action]
	}
	return true
}

// OAuthRequiredRelayScope is the exact registered relay rule. Unknown routes
// fail closed, including future extension routes missing catalog metadata.
func OAuthRequiredRelayScope(method, path string) (string, bool) {
	route, ok := OAuthRouteFor(method, path)
	if !ok || route.Resource != OAuthResourceRelay || (route.Mode != OAuthRouteDirect && route.Mode != OAuthRouteCompatibility) {
		return "", false
	}
	return route.Scope, route.Scope != ""
}
