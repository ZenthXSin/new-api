package model

import (
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"testing"
)

func TestCodexUserConfigReasoningDefaults(t *testing.T) {
	previous := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&CodexUserConfig{}))
	DB = db
	t.Cleanup(func() {
		DB = previous
		connection, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, connection.Close())
	})
	for _, effort := range []string{"max", "ultra"} {
		t.Run(effort, func(t *testing.T) {
			require.NoError(t, SaveCodexUserConfig(&CodexUserConfig{UserID: 25, DefaultModel: "gpt-6.1-sol", DefaultEffort: effort}))
			saved, err := GetCodexUserConfig(25)
			require.NoError(t, err)
			assert.Equal(t, effort, saved.DefaultEffort)
		})
	}
	require.Error(t, SaveCodexUserConfig(&CodexUserConfig{UserID: 25, DefaultEffort: "unlimited"}))
	saved, err := GetCodexUserConfig(25)
	require.NoError(t, err)
	assert.Equal(t, "ultra", saved.DefaultEffort)
}
