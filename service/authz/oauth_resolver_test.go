package authz

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthCurrentPermissionsObserveCommittedRevocationBeforeEnforcerReload(t *testing.T) {
	db := newAuthzTestDB(t)
	previous := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
	require.NoError(t, Init(db))
	assert.True(t, Can(42, common.RoleAdminUser, ChannelRead))
	assert.True(t, CurrentPermissions(42, common.RoleAdminUser)[ResourceChannel][ActionRead])
	require.NoError(t, db.Create(&model.CasbinRule{Ptype: "p", V0: UserSubject(42), V1: ResourceChannel, V2: ActionRead, V3: EffectDeny}).Error)
	assert.True(t, Can(42, common.RoleAdminUser, ChannelRead), "fixture models another instance before policy reload")
	assert.False(t, CurrentPermissions(42, common.RoleAdminUser)[ResourceChannel][ActionRead], "delegated request must observe committed revocation immediately")
	assert.True(t, CurrentPermissions(43, common.RoleAdminUser)[ResourceChannel][ActionRead], "another user's grant is unaffected")
	require.NoError(t, db.Create(&model.CasbinRule{Ptype: "p", V0: UserSubject(42), V1: ResourceChannel, V2: ActionSensitiveWrite, V3: EffectAllow}).Error)
	assert.True(t, CurrentPermissions(42, common.RoleAdminUser)[ResourceChannel][ActionSensitiveWrite])
	assert.Empty(t, CurrentPermissions(42, common.RoleCommonUser), "role demotion removes administrator permissions")
	assert.True(t, CurrentPermissions(42, common.RoleRootUser)[ResourceChannel][ActionRead], "root behavior remains identical to existing Casbin policy")
}
