package model

import (
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestEnsureAppCenterSchemaStateIsIdempotent(t *testing.T) {
	previous := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&AppCenterSchemaState{}))
	DB = db
	t.Cleanup(func() { DB = previous; _ = sqlDB.Close() })
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- EnsureAppCenterSchemaState() }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	var states []AppCenterSchemaState
	require.NoError(t, DB.Find(&states).Error)
	require.Len(t, states, 1)
	require.Equal(t, AppCenterSchemaEpoch, states[0].Epoch)
}
