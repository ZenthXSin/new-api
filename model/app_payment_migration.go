package model

import (
	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// SQLite 1.9's DDL parser reports every column of a composite unique index as
// individually unique. GORM then rebuilds payment_orders on every startup.
// Correct only this introspection metadata; AutoMigrate still checks all types,
// columns and indexes and preserves the actual database uniqueness constraints.
type appPaymentSQLiteDialector struct{ gorm.Dialector }

func (d appPaymentSQLiteDialector) Migrator(db *gorm.DB) gorm.Migrator {
	return appPaymentSQLiteMigrator{Migrator: d.Dialector.Migrator(db)}
}

type appPaymentSQLiteMigrator struct{ gorm.Migrator }
type appPaymentColumnType = gorm.ColumnType
type appPaymentSQLiteColumn struct {
	appPaymentColumnType
	unique bool
}

func (c appPaymentSQLiteColumn) Unique() (bool, bool) { return c.unique, true }
func (m appPaymentSQLiteMigrator) ColumnTypes(value interface{}) ([]gorm.ColumnType, error) {
	columns, err := m.Migrator.ColumnTypes(value)
	if err != nil {
		return nil, err
	}
	// Correct the composite index only; provider_trade_hash retains its
	// real, nullable single-column UNIQUE constraint.
	for i, column := range columns {
		switch column.Name() {
		case "client_id", "out_trade_no":
			columns[i] = appPaymentSQLiteColumn{appPaymentColumnType: column, unique: false}
		}
	}
	return columns, nil
}
func migrateAppPaymentOrderSchema() error {
	if !common.UsingMainDatabase(common.DatabaseTypeSQLite) {
		return DB.AutoMigrate(&PaymentOrder{})
	}
	db := DB.Session(&gorm.Session{NewDB: true})
	db.Config.Dialector = appPaymentSQLiteDialector{Dialector: DB.Dialector}
	return db.AutoMigrate(&PaymentOrder{})
}
