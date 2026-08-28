package model

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUserGroupsMigrationColumnExists(t *testing.T) {
	if !DB.Migrator().HasColumn(&User{}, "groups") {
		t.Fatal("expected users.groups column to exist")
	}
}

func TestUserGroupsLegacyFallbackAndNormalization(t *testing.T) {
	legacy := User{Group: " vip "}
	assert.Equal(t, []string{"vip"}, legacy.GetGroups())

	stored := User{Group: "default", GroupsData: `["default", " vip ", "vip"]`}
	assert.Equal(t, []string{"default", "vip"}, stored.GetGroups())

	user := User{}
	require.NoError(t, user.SetGroups([]string{" default ", "vip"}))
	assert.Equal(t, "default", user.Group)
	assert.Equal(t, []string{"default", "vip"}, user.Groups)
	assert.JSONEq(t, `["default","vip"]`, user.GroupsData)
}

func TestUserGroupsRejectInvalidValues(t *testing.T) {
	var user User
	assert.Error(t, user.SetGroups(nil))
	assert.Error(t, user.SetGroups([]string{"default", " default "}))
	assert.Error(t, user.SetGroups([]string{""}))
}

func TestUserBaseGroupsRoundTrip(t *testing.T) {
	user := User{Id: 1, Group: "default"}
	require.NoError(t, user.SetGroups([]string{"default", "vip"}))
	base := user.ToBaseUser()
	assert.Equal(t, []string{"default", "vip"}, base.GetGroups())
	assert.Equal(t, userCacheSchemaVersion, base.CacheSchema)
}
