package model

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
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

func TestUserGroupsJSONIncludesDerivedGroups(t *testing.T) {
	user := User{Group: "default", GroupsData: `["default","vip"]`}
	data, err := common.Marshal(user)
	require.NoError(t, err)
	var response struct {
		Group  string   `json:"group"`
		Groups []string `json:"groups"`
	}
	require.NoError(t, common.Unmarshal(data, &response))
	assert.Equal(t, "default", response.Group)
	assert.Equal(t, []string{"default", "vip"}, response.Groups)
}

func TestSearchUsersMatchesLiteralSpecialCharacterGroup(t *testing.T) {
	setupUserUpdateTestState(t)
	user := User{
		Username: "special-group-user",
		Password: "password",
		Status:   common.UserStatusEnabled,
		Group:    "default",
	}
	require.NoError(t, user.SetGroups([]string{"default", "vip%_literal"}))
	require.NoError(t, DB.Create(&user).Error)

	users, total, err := SearchUsers("special-group-user", "vip%_literal", nil, nil, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, users, 1)
	assert.Equal(t, user.Id, users[0].Id)

	users, total, err = SearchUsers("special-group-user", "vip", nil, nil, 0, 10)
	require.NoError(t, err)
	assert.Zero(t, total)
	assert.Empty(t, users)
}

func TestUserGroupsRejectOverlongValue(t *testing.T) {
	var user User
	assert.Error(t, user.SetGroups([]string{strings.Repeat("x", 65)}))
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
