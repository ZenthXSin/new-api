/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type tokenGroupResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		Group string `json:"group"`
	} `json:"data"`
}

func setupTokenGroupEndpointTest(t *testing.T) *gin.Engine {
	t.Helper()

	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMainDatabaseType, previousLogDatabaseType := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedisEnabled, previousRDB := common.RedisEnabled, common.RDB
	previousSQLitePath, previousIsMasterNode := common.SQLitePath, common.IsMasterNode
	previousSQLDSN, hadSQLDSN := os.LookupEnv("SQL_DSN")
	previousUserGroups := setting.UserUsableGroups2JSONString()
	previousGroupRatios := ratio_setting.GroupRatio2JSONString()

	t.Cleanup(func() {
		model.DB = previousDB
		model.LOG_DB = previousLogDB
		common.SetDatabaseTypes(previousMainDatabaseType, previousLogDatabaseType)
		common.RedisEnabled = previousRedisEnabled
		common.RDB = previousRDB
		common.SQLitePath = previousSQLitePath
		common.IsMasterNode = previousIsMasterNode
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(previousUserGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(previousGroupRatios))
		if hadSQLDSN {
			require.NoError(t, os.Setenv("SQL_DSN", previousSQLDSN))
		} else {
			require.NoError(t, os.Unsetenv("SQL_DSN"))
		}
	})

	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	common.RDB = nil
	common.IsMasterNode = false
	common.SQLitePath = fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	require.NoError(t, os.Setenv("SQL_DSN", "local"))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"default","vip":"vip","auto":"auto"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":1}`))
	require.NoError(t, model.InitDB())
	require.NoError(t, model.DB.AutoMigrate(&model.User{}, &model.Token{}))
	testDB := model.DB
	t.Cleanup(func() {
		sqlDB, err := testDB.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})

	// This is the production /v1/token route and middleware chain from SetRelayRouter.
	router := gin.New()
	tokenInfoRouter := router.Group("/v1/token")
	tokenInfoRouter.Use(middleware.RouteTag("relay"))
	tokenInfoRouter.Use(middleware.DisableCache())
	tokenInfoRouter.Use(middleware.TokenAuth())
	tokenInfoRouter.GET("/group", GetTokenGroup)
	return router
}

func TestGetTokenGroupEndpointUsesAuthenticatedTokenGroup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := setupTokenGroupEndpointTest(t)

	tests := []struct {
		name       string
		tokenGroup string
		expected   string
	}{
		{name: "explicit token group", tokenGroup: "vip", expected: "vip"},
		{name: "empty token group uses user default", tokenGroup: "", expected: "default"},
		{name: "auto token group remains auto without a model request", tokenGroup: "auto", expected: "auto"},
	}

	for index, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			user := &model.User{
				Username:    fmt.Sprintf("token-group-user-%d", index),
				Password:    "password-placeholder",
				Role:        common.RoleCommonUser,
				Status:      common.UserStatusEnabled,
				Group:       "default",
				AffCode:     fmt.Sprintf("token-group-aff-%d", index),
				AuthVersion: 1,
			}
			require.NoError(t, model.DB.Create(user).Error)

			key := fmt.Sprintf("tokengroup%d", index)
			token := &model.Token{
				UserId:         user.Id,
				Key:            key,
				Status:         common.TokenStatusEnabled,
				CreatedTime:    1,
				AccessedTime:   1,
				ExpiredTime:    -1,
				RemainQuota:    1,
				UnlimitedQuota: true,
				Group:          tt.tokenGroup,
			}
			require.NoError(t, model.DB.Create(token).Error)

			request := httptest.NewRequest(http.MethodGet, "/v1/token/group", nil)
			request.Header.Set("Authorization", "Bearer sk-"+key)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			require.Equal(t, http.StatusOK, response.Code)
			var body tokenGroupResponse
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
			assert.True(t, body.Success)
			assert.Equal(t, "", body.Message)
			assert.Equal(t, tt.expected, body.Data.Group)
		})
	}
}

func TestGetTokenGroupEndpointRejectsMissingCredentials(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := setupTokenGroupEndpointTest(t)
	request := httptest.NewRequest(http.MethodGet, "/v1/token/group", nil)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	assert.Equal(t, http.StatusUnauthorized, response.Code)
}
