package model

import (
	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// migrateFinanceEntrySchema preserves SQLite's existing decimal storage and
// data. The legacy SQLite migrator misreads decimal(12,2) column metadata and
// attempts a table rebuild on each restart, failing with unbalanced DDL. SQLite
// uses type affinity, so existing columns need no type rewrite; missing columns
// and indexes can be added without copying or dropping financial records.
func migrateFinanceEntrySchema() error {
	entry := &FinanceEntry{}
	if !common.UsingMainDatabase(common.DatabaseTypeSQLite) {
		return DB.AutoMigrate(entry)
	}
	if !DB.Migrator().HasTable(entry) {
		return DB.Migrator().CreateTable(entry)
	}
	statement := &gorm.Statement{DB: DB}
	if err := statement.Parse(entry); err != nil {
		return err
	}
	for _, field := range statement.Schema.Fields {
		if field.DBName == "" || field.IgnoreMigration {
			continue
		}
		if !DB.Migrator().HasColumn(entry, field.DBName) {
			if err := DB.Migrator().AddColumn(entry, field.Name); err != nil {
				return err
			}
		}
	}
	for name := range statement.Schema.ParseIndexes() {
		if !DB.Migrator().HasIndex(entry, name) {
			if err := DB.Migrator().CreateIndex(entry, name); err != nil {
				return err
			}
		}
	}
	return nil
}
