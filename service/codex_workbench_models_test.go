package service

import (
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodexCatalogAndCredentialsPreserveGroupAndSessionBoundaries(t *testing.T) {
	identity := newCodexGitHubFixture(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}))
	before := ratio_setting.GetGroupRatioCopy()
	defer func() { data, _ := common.Marshal(before); _ = ratio_setting.UpdateGroupRatioByJSONString(string(data)) }()
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"unavailable":2}`))
	channels := []model.Channel{
		{Id: 201, Type: constant.ChannelTypeOpenAI, Name: "Coding", Status: common.ChannelStatusEnabled},
		{Id: 202, Type: constant.ChannelTypeAnthropic, Name: "Unsupported Responses", Status: common.ChannelStatusEnabled},
	}
	for _, channel := range channels { require.NoError(t, model.DB.Create(&channel).Error) }
	for _, ability := range []model.Ability{
		{Group: "default", Model: "fixture-model", ChannelId: 201, Enabled: true},
		{Group: "default", Model: "unsupported-model", ChannelId: 202, Enabled: true},
		{Group: "unavailable", Model: "private-model", ChannelId: 201, Enabled: true},
	} { require.NoError(t, model.DB.Create(&ability).Error) }
	catalog, err := GetCodexCatalog(identity.UserID)
	require.NoError(t, err)
	var selected *CodexCatalogGroup
	for index := range catalog.Groups { if catalog.Groups[index].ID == "default" { selected = &catalog.Groups[index] } }
	require.NotNil(t, selected)
	assert.Equal(t, []CodexCatalogModel{
		{ID: "fixture-model", Name: "fixture-model", Supported: true},
		{ID: "unsupported-model", Name: "unsupported-model", Supported: false, Reason: "This model's current channels do not support the Responses API required by Codex."},
	}, selected.Models)
	token, err := IssueCodexRelayToken(identity, "default", "fixture-model")
	require.NoError(t, err)
	claims, user, err := ValidateCodexRelayToken(token)
	require.NoError(t, err)
	assert.Equal(t, identity.UserID, user.Id)
	assert.Equal(t, "default", claims.Group)
	assert.Equal(t, "fixture-model", claims.Model)
	allowed, err := CodexAllowedChannels(user, claims.Group, claims.Model, "/v1/responses")
	require.NoError(t, err)
	assert.Equal(t, map[int]bool{201: true}, allowed)
	_, err = IssueCodexRelayToken(identity, "default", "unsupported-model")
	require.Error(t, err)
	_, err = IssueCodexRelayToken(identity, "forbidden", "fixture-model")
	require.Error(t, err)
	_, err = CodexAllowedChannels(user, "default", "private-model", "/v1/responses")
	require.Error(t, err)
	_, _, err = ValidateCodexRelayToken(token + "tampered")
	require.Error(t, err)
	access, _, err := IssueAccessToken(identity)
	require.NoError(t, err)
	_, _, err = ValidateCodexRelayToken(CodexRelayTokenPrefix + access)
	require.Error(t, err, "dashboard access JWT cannot be substituted for a relay credential")
	claims.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
	expired, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(authSigningKey("codex-relay"))
	require.NoError(t, err)
	_, _, err = ValidateCodexRelayToken(CodexRelayTokenPrefix + expired)
	require.Error(t, err)
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("revoked_at", time.Now().Unix()).Error)
	_, _, err = ValidateCodexRelayToken(token)
	require.Error(t, err, "revoked browser sessions must revoke task credentials")
	assert.False(t, strings.Contains(token, common.SessionSecret))
}
