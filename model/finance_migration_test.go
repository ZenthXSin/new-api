package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestFinanceEntrySQLiteMigrationPreservesDecimalRows(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "fresh"
		if existing {
			name = "existing_decimal_table_with_missing_columns"
		}
		t.Run(name, func(t *testing.T) {
			recorder := &migrationSQLRecorder{}
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: recorder})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			previousDB, previousType := DB, common.MainDatabaseType()
			DB = db
			common.SetMainDatabaseType(common.DatabaseTypeSQLite)
			t.Cleanup(func() {
				DB = previousDB
				common.SetMainDatabaseType(previousType)
				require.NoError(t, sqlDB.Close())
			})
			if existing {
				require.NoError(t, db.Exec("CREATE TABLE finance_entries (id integer PRIMARY KEY, entry_type text, amount decimal(12,2), note text)").Error)
				require.NoError(t, db.Exec("INSERT INTO finance_entries (id, entry_type, amount, note) VALUES (?, ?, ?, ?)", 17, "income", 12345.67, "已有金融记录").Error)
			}
			require.NoError(t, migrateFinanceEntrySchema())
			if existing {
				var row FinanceEntry
				require.NoError(t, db.First(&row, 17).Error)
				assert.Equal(t, "income", row.EntryType)
				assert.Equal(t, 12345.67, row.Amount)
				assert.Equal(t, "已有金融记录", row.Note)
				assert.True(t, db.Migrator().HasColumn(&FinanceEntry{}, "Category"))
				assert.True(t, db.Migrator().HasIndex(&FinanceEntry{}, "idx_finance_entries_created_at"))
			}
			entry := FinanceEntry{EntryType: "expense", Category: "服务成本", Amount: 0.01, Note: "精度保留", CreatedBy: 3}
			require.NoError(t, db.Create(&entry).Error)
			recorder.reset()
			require.NoError(t, migrateFinanceEntrySchema())
			assert.Empty(t, recorder.schemaMutations(), "restart must not rebuild existing decimal tables")
			var loaded FinanceEntry
			require.NoError(t, db.First(&loaded, entry.Id).Error)
			assert.Equal(t, entry, loaded)
		})
	}
}
