package authz

import "github.com/QuantumNous/new-api/model"

// CurrentPermissions reads committed policy rows for delegated grants. OAuth
// authorization must not wait for another instance's enforcer reload after a
// permission is removed. The policy precedence matches Can: explicit user
// denial/allow wins over the union of role baselines; root remains superuser.
func CurrentPermissions(userID, systemRole int) PermissionsMap {
	result := make(PermissionsMap)
	roles := resolveSubjectRoles(userID, systemRole)
	if len(roles) == 0 {
		return result
	}
	for _, role := range roles {
		if isSuperuserRole(role) {
			for _, resource := range Catalog() {
				result[resource.Resource] = make(map[string]bool)
				for _, action := range resource.Actions {
					result[resource.Resource][action.Action] = true
				}
			}
			return result
		}
	}
	if model.DB == nil {
		return result
	}
	subject := UserSubject(userID)
	subjects := []string{subject}
	for _, role := range roles {
		subjects = append(subjects, RoleSubject(role))
	}
	var rules []model.CasbinRule
	if err := model.DB.Where("ptype = ? AND v0 IN ?", "p", subjects).Find(&rules).Error; err != nil {
		return result
	}
	effects := make(map[string]map[Permission]string)
	for _, rule := range rules {
		permission := Permission{Resource: rule.V1, Action: rule.V2}
		if !isKnownPermission(permission) {
			continue
		}
		effect := rule.V3
		if effect == "" {
			effect = EffectAllow
		}
		if effect != EffectAllow && effect != EffectDeny {
			continue
		}
		if effects[rule.V0] == nil {
			effects[rule.V0] = make(map[Permission]string)
		}
		if effects[rule.V0][permission] != EffectDeny {
			effects[rule.V0][permission] = effect
		}
	}
	for _, permission := range AllPermissions() {
		allowed := false
		if effect, explicit := effects[subject][permission]; explicit {
			allowed = effect == EffectAllow
		} else {
			for _, role := range roles {
				if effects[RoleSubject(role)][permission] == EffectAllow {
					allowed = true
					break
				}
			}
		}
		if result[permission.Resource] == nil {
			result[permission.Resource] = make(map[string]bool)
		}
		result[permission.Resource][permission.Action] = allowed
	}
	return result
}
