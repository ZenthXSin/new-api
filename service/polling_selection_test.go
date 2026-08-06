package service

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestChannelSelectPollingSelectionAutoGroupReturnsSelectionError(t *testing.T) {
	previousDB := model.DB
	previousMemoryCacheEnabled := common.MemoryCacheEnabled
	previousAutoGroups := setting.AutoGroups2JsonString()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	model.DB = db
	common.MemoryCacheEnabled = false
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["default"]`))
	t.Cleanup(func() {
		model.DB = previousDB
		common.MemoryCacheEnabled = previousMemoryCacheEnabled
		require.NoError(t, setting.UpdateAutoGroupsByJsonString(previousAutoGroups))
		_ = sqlDB.Close()
	})
	require.NoError(t, sqlDB.Close())

	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	channel, selectedGroup, err := CacheGetRandomSatisfiedChannel(&RetryParam{
		Ctx:        ctx,
		TokenGroup: "auto",
		ModelName:  "test-model",
	})

	require.Error(t, err)
	assert.Nil(t, channel)
	assert.Equal(t, "auto", selectedGroup)
}
