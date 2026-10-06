package model

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// These are the exact persisted fields from the deployed group-cache-ttft-20261002
// release. Keeping frozen copies verifies a real schema upgrade, including the
// old varchar(256) OAuth scope columns, instead of migrating today's types twice.
type oauthDeployedUser struct {
	Id               int                        `json:"id"`
	Username         string                     `json:"username" gorm:"unique;index" validate:"max=20"`
	Password         string                     `json:"password" gorm:"not null;" validate:"min=8,max=20"`
	OriginalPassword string                     `json:"original_password" gorm:"-:all"` // this field is only for Password change verification, don't save it to database!
	DisplayName      string                     `json:"display_name" gorm:"index" validate:"max=20"`
	Role             int                        `json:"role" gorm:"type:int;default:1"`   // admin, common
	Status           int                        `json:"status" gorm:"type:int;default:1"` // enabled, disabled
	Email            string                     `json:"email" gorm:"index" validate:"max=50"`
	GitHubId         string                     `json:"github_id" gorm:"column:github_id;index"`
	DiscordId        string                     `json:"discord_id" gorm:"column:discord_id;index"`
	OidcId           string                     `json:"oidc_id" gorm:"column:oidc_id;index"`
	WeChatId         string                     `json:"wechat_id" gorm:"column:wechat_id;index"`
	TelegramId       string                     `json:"telegram_id" gorm:"column:telegram_id;index"`
	VerificationCode string                     `json:"verification_code" gorm:"-:all"`                         // this field is only for Email verification, don't save it to database!
	AccessToken      *string                    `json:"-" gorm:"type:char(32);column:access_token;uniqueIndex"` // this token is for system management
	Quota            int                        `json:"quota" gorm:"type:int;default:0"`
	UsedQuota        int                        `json:"used_quota" gorm:"type:int;default:0;column:used_quota"` // used quota
	RequestCount     int                        `json:"request_count" gorm:"type:int;default:0;"`               // request number
	Group            string                     `json:"group" gorm:"type:varchar(64);default:'default'"`
	Groups           []string                   `json:"groups,omitempty" gorm:"-"`
	GroupsData       string                     `json:"-" gorm:"column:groups;type:text"`
	AffCode          string                     `json:"aff_code" gorm:"type:varchar(32);column:aff_code;uniqueIndex"`
	AffCount         int                        `json:"aff_count" gorm:"type:int;default:0;column:aff_count"`
	AffQuota         int                        `json:"aff_quota" gorm:"type:int;default:0;column:aff_quota"`           // 邀请剩余额度
	AffHistoryQuota  int                        `json:"aff_history_quota" gorm:"type:int;default:0;column:aff_history"` // 邀请历史额度
	InviterId        int                        `json:"inviter_id" gorm:"type:int;column:inviter_id;index"`
	DeletedAt        gorm.DeletedAt             `gorm:"index"`
	LinuxDOId        string                     `json:"linux_do_id" gorm:"column:linux_do_id;index"`
	Setting          string                     `json:"setting" gorm:"type:text;column:setting"`
	Remark           string                     `json:"remark,omitempty" gorm:"type:varchar(255)" validate:"max=255"`
	StripeCustomer   string                     `json:"stripe_customer" gorm:"type:varchar(64);column:stripe_customer;index"`
	CreatedAt        int64                      `json:"created_at" gorm:"autoCreateTime;column:created_at"`
	LastLoginAt      int64                      `json:"last_login_at" gorm:"default:0;column:last_login_at"`
	AuthVersion      int64                      `json:"-" gorm:"type:bigint;not null;default:1;column:auth_version"`
	AdminPermissions map[string]map[string]bool `json:"admin_permissions,omitempty" gorm:"-:all"`
}

func (oauthDeployedUser) TableName() string { return "users" }

type oauthDeployedToken struct {
	Id                 int     `json:"id"`
	UserId             int     `json:"user_id" gorm:"index"`
	Key                string  `json:"key" gorm:"type:varchar(128);uniqueIndex"`
	Status             int     `json:"status" gorm:"default:1"`
	Name               string  `json:"name" gorm:"index" `
	CreatedTime        int64   `json:"created_time" gorm:"bigint"`
	AccessedTime       int64   `json:"accessed_time" gorm:"bigint"`
	ExpiredTime        int64   `json:"expired_time" gorm:"bigint;default:-1"` // -1 means never expired
	RemainQuota        int     `json:"remain_quota" gorm:"default:0"`
	UnlimitedQuota     bool    `json:"unlimited_quota"`
	ModelLimitsEnabled bool    `json:"model_limits_enabled"`
	ModelLimits        string  `json:"model_limits" gorm:"type:text"`
	AllowIps           *string `json:"allow_ips" gorm:"default:''"`
	UsedQuota          int     `json:"used_quota" gorm:"default:0"` // used quota
	Group              string  `json:"group" gorm:"default:''"`
	CrossGroupRetry    bool    `json:"cross_group_retry"` // 跨分组重试，仅auto分组有效
	AutoGroups         string  `json:"-" gorm:"type:text"`
	// ExcludeProfitStat 排除利润统计：开启后该令牌产生的消费/退款计入日志与账单，
	// 但不计入利润/营收统计的聚合。仅管理员可见可配置，默认关闭。
	ExcludeProfitStat bool           `json:"exclude_profit_stat"`
	DeletedAt         gorm.DeletedAt `gorm:"index"`
}

func (oauthDeployedToken) TableName() string { return "tokens" }

type oauthDeployedOauthClient struct {
	Id           int    `json:"id" gorm:"primaryKey"`
	ClientId     string `json:"client_id" gorm:"type:varchar(64);uniqueIndex;not null"`
	ClientSecret string `json:"-" gorm:"type:varchar(128);not null"` // HMAC-SHA256 hex of the plaintext secret
	Name         string `json:"name" gorm:"type:varchar(128);not null"`
	Description  string `json:"description" gorm:"type:varchar(512);default:''"`
	RedirectUris string `json:"redirect_uris" gorm:"type:text;not null"` // JSON array of exact-match URIs
	Scopes       string `json:"scopes" gorm:"type:varchar(256);default:'openid profile email'"`
	IsPublic     bool   `json:"is_public" gorm:"default:false"` // PKCE-only client without a secret (mobile/desktop apps)
	Enabled      bool   `json:"enabled" gorm:"default:false"`
	CreatedBy    int    `json:"created_by" gorm:"default:0"`
	LastUsedAt   int64  `json:"last_used_at" gorm:"default:0"`
	CreatedTime  int64  `json:"created_time" gorm:"autoCreateTime"`
	UpdatedTime  int64  `json:"updated_time" gorm:"autoUpdateTime"`
}

func (oauthDeployedOauthClient) TableName() string { return "oauth_clients" }

type oauthDeployedOauthConsent struct {
	Id            int    `json:"id" gorm:"primaryKey"`
	UserId        int    `json:"user_id" gorm:"uniqueIndex:uk_oauth_consent_user_client;not null"`
	OauthClientId int    `json:"oauth_client_id" gorm:"uniqueIndex:uk_oauth_consent_user_client;not null"`
	GrantedScopes string `json:"granted_scopes" gorm:"type:varchar(256);not null"`
	CreatedTime   int64  `json:"created_time" gorm:"autoCreateTime"`
	UpdatedTime   int64  `json:"updated_time" gorm:"autoUpdateTime"`
}

func (oauthDeployedOauthConsent) TableName() string { return "oauth_consents" }

type oauthDeployedOauthSigningKey struct {
	Id          int    `json:"id" gorm:"primaryKey"`
	Kid         string `json:"kid" gorm:"type:varchar(64);uniqueIndex;not null"`
	PrivateKey  string `json:"-" gorm:"type:text;not null"` // encrypted PEM (PKCS#8)
	CreatedTime int64  `json:"created_time" gorm:"autoCreateTime"`
	RevokedAt   int64  `json:"revoked_at" gorm:"default:0"`
}

func (oauthDeployedOauthSigningKey) TableName() string { return "oauth_signing_keys" }

type oauthDeployedAuthFlow struct {
	Id         int64      `json:"id" gorm:"primaryKey"`
	TokenHash  string     `json:"-" gorm:"type:char(64);not null;uniqueIndex"`
	Purpose    string     `json:"purpose" gorm:"type:varchar(32);not null;index:idx_auth_flow_purpose_expiry"`
	Provider   string     `json:"provider,omitempty" gorm:"type:varchar(64)"`
	Intent     string     `json:"intent,omitempty" gorm:"type:varchar(16)"`
	UserId     int        `json:"user_id,omitempty" gorm:"index"`
	SessionId  string     `json:"session_id,omitempty" gorm:"type:varchar(64);index"`
	Payload    string     `json:"-" gorm:"type:text"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at" gorm:"not null;index:idx_auth_flow_purpose_expiry"`
	ConsumedAt *time.Time `json:"consumed_at,omitempty" gorm:"index"`
}

func (oauthDeployedAuthFlow) TableName() string { return "auth_flows" }

// TEST_OAUTH_DIALECT and the DSNs must refer to disposable local databases.
// This test removes all tables in that explicitly configured test database.
func TestOAuthDatabaseMigration(t *testing.T) {
	dialect := common.DatabaseType(os.Getenv("TEST_OAUTH_DIALECT"))
	var driver gorm.Dialector
	switch dialect {
	case "", common.DatabaseTypeSQLite:
		dialect = common.DatabaseTypeSQLite
		driver = sqlite.Open(":memory:")
	case common.DatabaseTypeMySQL:
		dsn := os.Getenv("TEST_OAUTH_MYSQL_DSN")
		require.NotEmpty(t, dsn, "configure an isolated disposable MySQL database")
		driver = mysql.Open(dsn)
	case common.DatabaseTypePostgreSQL:
		dsn := os.Getenv("TEST_OAUTH_POSTGRES_DSN")
		require.NotEmpty(t, dsn, "configure an isolated disposable PostgreSQL database")
		driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
	default:
		t.Fatalf("unsupported OAuth migration test dialect %q", dialect)
	}
	recorder := &migrationSQLRecorder{}
	db, err := gorm.Open(driver, &gorm.Config{Logger: recorder})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previousDB, previousLogDB := DB, LOG_DB
	previousType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	DB, LOG_DB = db, db
	common.SetDatabaseTypes(dialect, dialect)
	initCol()
	t.Cleanup(func() {
		DB, LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousType, previousLogType)
		initCol()
		require.NoError(t, sqlDB.Close())
	})
	var version string
	versionQuery := "SELECT version()"
	if dialect == common.DatabaseTypeSQLite {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("OAuth migration database: %s %s", dialect, version)
	for _, existing := range []bool{false, true} {
		name := "fresh"
		if existing {
			name = "upgrade_deployed_schema"
		}
		t.Run(name, func(t *testing.T) {
			tables, err := db.Migrator().GetTables()
			require.NoError(t, err)
			for _, table := range tables {
				if table == "sqlite_sequence" {
					continue
				}
				require.NoError(t, db.Migrator().DropTable(table))
			}
			var legacyUsers []oauthDeployedUser
			var legacyTokens []oauthDeployedToken
			var legacyClients []oauthDeployedOauthClient
			var legacyConsent oauthDeployedOauthConsent
			var legacyKey oauthDeployedOauthSigningKey
			var legacyFlow oauthDeployedAuthFlow
			if existing {
				require.NoError(t, db.AutoMigrate(&oauthDeployedUser{}, &oauthDeployedToken{}, &oauthDeployedOauthClient{}, &oauthDeployedOauthConsent{}, &oauthDeployedOauthSigningKey{}, &oauthDeployedAuthFlow{}))
				legacyUsers = []oauthDeployedUser{
					{Id: 101, Username: "matrix-regular", Password: "fixture-password-verifier", DisplayName: "原有用户", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Quota: 654321, UsedQuota: 12345, RequestCount: 765, Group: "vip", GroupsData: `["vip","default"]`, AffCode: "matrix-user-aff", AuthVersion: 7, Setting: `{"language":"zh"}`, CreatedAt: 1700000000},
					{Id: 102, Username: "matrix-admin", Password: "fixture-admin-verifier", DisplayName: "原有管理员", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Quota: 999999, UsedQuota: 4321, RequestCount: 123, Group: "default", AffCode: "matrix-admin-aff", AuthVersion: 1, CreatedAt: 1700000000},
				}
				legacyTokens = []oauthDeployedToken{
					{Id: 201, UserId: 101, Key: "matrix-legacy-restricted-token", Status: common.TokenStatusEnabled, Name: "旧受限令牌", ExpiredTime: -1, RemainQuota: 765432, UsedQuota: 9876, Group: "vip", ModelLimitsEnabled: true, ModelLimits: "model-a,model-b", AutoGroups: `["vip","default"]`, CreatedTime: 1700000000, AccessedTime: 1700001000},
					{Id: 202, UserId: 102, Key: "matrix-legacy-unlimited-token", Status: common.TokenStatusEnabled, Name: "旧无限额度令牌", ExpiredTime: -1, UnlimitedQuota: true, UsedQuota: 1111, Group: "default", ExcludeProfitStat: true, CreatedTime: 1700000000},
				}
				legacyClients = []oauthDeployedOauthClient{
					{Id: 301, ClientId: "matrix-confidential", ClientSecret: "fixture-client-secret-hash", Name: "旧机密应用", RedirectUris: `["https://app.example.com/callback"]`, Scopes: "openid profile email", Enabled: true, CreatedBy: 102, CreatedTime: 1700000000, UpdatedTime: 1700001000},
					{Id: 302, ClientId: "matrix-public", Name: "旧公共应用", RedirectUris: `["https://public.example.com/callback"]`, Scopes: "openid profile", IsPublic: true, Enabled: true, CreatedBy: 102, CreatedTime: 1700000000, UpdatedTime: 1700001000},
					{Id: 303, ClientId: "matrix-disabled", ClientSecret: "fixture-disabled-secret-hash", Name: "旧停用应用", RedirectUris: `["https://disabled.example.com/callback"]`, Scopes: "openid", CreatedBy: 102, CreatedTime: 1700000000, UpdatedTime: 1700001000},
				}
				legacyConsent = oauthDeployedOauthConsent{Id: 401, UserId: 101, OauthClientId: 301, GrantedScopes: "openid profile", CreatedTime: 1700000000, UpdatedTime: 1700001000}
				legacyKey = oauthDeployedOauthSigningKey{Id: 501, Kid: "matrix-legacy-signing-key", PrivateKey: "encrypted-fixture-preserved-not-a-key", CreatedTime: 1700000000}
				legacyFlow = oauthDeployedAuthFlow{Id: 601, TokenHash: strings.Repeat("a", 64), Purpose: "oauth_authorize", Provider: "matrix-confidential", UserId: 101, Payload: `{"scope":"openid profile","legacy":true}`, CreatedAt: time.Unix(1700000000, 0).UTC(), ExpiresAt: time.Unix(4700000000, 0).UTC()}
				for _, rows := range []interface{}{&legacyUsers, &legacyTokens, &legacyClients, &legacyConsent, &legacyKey, &legacyFlow} {
					require.NoError(t, db.Create(rows).Error)
				}
			}
			require.NoError(t, migrateDB(), "actual production migration must initialize all OAuth tables")
			for _, table := range []interface{}{&OAuthGrant{}, &OAuthAccessToken{}, &OAuthRefreshToken{}, &OAuthRelayBinding{}, &OAuthAction{}, &PaymentApplication{}, &PaymentOrder{}, &PaymentWebhookEvent{}, &PaymentWalletGuard{}, &PaymentWalletOperation{}, &PaymentWalletCacheWitness{}, &PaymentWalletMutation{}} {
				assert.True(t, db.Migrator().HasTable(table))
				var rows int64
				require.NoError(t, db.Model(table).Count(&rows).Error)
				assert.Zero(t, rows, "upgrade cannot silently turn old identity consent into business authorization")
			}
			if existing {
				var users []oauthDeployedUser
				var tokens []oauthDeployedToken
				var clients []oauthDeployedOauthClient
				var consent oauthDeployedOauthConsent
				var key oauthDeployedOauthSigningKey
				var flow oauthDeployedAuthFlow
				require.NoError(t, db.Order("id").Find(&users).Error)
				require.NoError(t, db.Order("id").Find(&tokens).Error)
				require.NoError(t, db.Order("id").Find(&clients).Error)
				require.NoError(t, db.First(&consent, legacyConsent.Id).Error)
				require.NoError(t, db.First(&key, legacyKey.Id).Error)
				require.NoError(t, db.First(&flow, legacyFlow.Id).Error)
				assert.Equal(t, legacyUsers, users, "users, roles, auth versions and balances must survive")
				assert.Equal(t, legacyTokens, tokens, "ordinary token quotas and restrictions must survive")
				var currentTokens []Token
				require.NoError(t, db.Order("id").Find(&currentTokens).Error)
				require.Len(t, currentTokens, len(legacyTokens))
				for _, token := range currentTokens {
					assert.Zero(t, token.OAuthGrantID)
					assert.Zero(t, token.OAuthGrantVersion)
					assert.False(t, token.OAuthInternal)
				}
				assert.Equal(t, legacyClients, clients, "existing identity clients must not gain business scopes")
				assert.Equal(t, legacyConsent, consent)
				assert.Equal(t, legacyKey, key, "signing keys must not be rotated by migration")
				assert.Equal(t, legacyFlow.Payload, flow.Payload)
				assert.Equal(t, legacyFlow.TokenHash, flow.TokenHash)
				assert.True(t, legacyFlow.ExpiresAt.Equal(flow.ExpiresAt))
				duplicate := oauthDeployedOauthConsent{UserId: 101, OauthClientId: 301, GrantedScopes: "openid"}
				assert.Error(t, db.Create(&duplicate).Error, "old user/client consent uniqueness must survive")
			}
			// The configured full capability snapshot is larger than 256 bytes.
			// Direct persistence here isolates column capacity from policy tests.
			longScopes := make([]string, 48)
			for i := range longScopes {
				longScopes[i] = fmt.Sprintf("fixture-capability-%02d:write", i)
			}
			allScopes := strings.Join(longScopes, " ")
			require.Greater(t, len(allScopes), 256)
			client := OauthClient{ClientId: "matrix-full-scope", ClientSecret: "fixture-hash", Name: "Full scope matrix fixture", RedirectUris: `["https://full.example.com/callback"]`, Scopes: allScopes, Enabled: true}
			require.NoError(t, db.Create(&client).Error)
			consent := OauthConsent{UserId: 991, OauthClientId: client.Id, GrantedScopes: allScopes}
			require.NoError(t, db.Create(&consent).Error)
			grant := &OAuthGrant{UserID: 991, OAuthClientID: client.Id, Scopes: allScopes, Resources: `["https://api.example.com"]`, UserAuthVersion: 7, UserAuthFingerprint: strings.Repeat("c", 64), ClientAuthVersion: strings.Repeat("d", 64), ExpiresAt: time.Now().Unix() + 3600}
			require.NoError(t, CreateOAuthGrant(grant))
			accessHash, refreshHash := strings.Repeat("e", 64), strings.Repeat("f", 64)
			require.NoError(t, IssueOAuthTokenPair(grant.ID, accessHash, refreshHash, grant.ExpiresAt, grant.ExpiresAt))
			finance := FinanceEntry{EntryType: "expense", Category: "fixture", Amount: 12345.67, Note: "升级前财务数据", CreatedBy: 991}
			require.NoError(t, db.Create(&finance).Error)
			action := OAuthAction{
				ID: "matrix-existing-hosted-action", UserID: grant.UserID, ClientID: client.ClientId, GrantID: grant.ID,
				AuthVersion: grant.UserAuthVersion, GrantVersion: grant.Version, ShareResult: true,
				ReturnURI: "https://full.example.com/callback", ReturnState: "existing-return-state",
				ResultCiphertext: "encrypted-fixture-preserved-not-a-key", ResultClaimedAt: 1700000300,
				Operation: "identity.oauth_bind", Parameters: `{"provider":"github"}`, ParametersHash: strings.Repeat("1", 64),
				Status: "completed", StepIndex: 2, Bootstrap: true, SessionVersion: 3,
				BindingResultHash: strings.Repeat("2", 64), BindingBeforeHash: strings.Repeat("3", 64),
				SessionID: "existing-browser-session", NonceHash: strings.Repeat("4", 64), ReceiptHash: strings.Repeat("5", 64), FlowHash: strings.Repeat("6", 64),
				CreatedAt: 1700000000, ExpiresAt: grant.ExpiresAt, CompletedAt: 1700000200,
			}
			require.NoError(t, db.Create(&action).Error)

			paymentApp := PaymentApplication{ClientID: client.ClientId, Enabled: true, WebhookURL: "https://merchant.example/payments", WebhookSecret: "encrypted-migration-secret-fixture", Methods: `["balance","stripe"]`, CreatedAt: 1700000001, UpdatedAt: 1700000002}
			payment := PaymentOrder{ID: "ap_00112233445566778899aabbccdd", ClientID: client.ClientId, OutTradeNo: "migration-merchant-order", Amount: 12345, Currency: "CNY", Title: "重启保留订单", ReturnURL: "https://full.example.com/callback", ExpiresIn: 1800, ExpiresAt: 1700001800, PayerUserID: 991, Status: AppPaymentProcessing, PaymentMethod: "balance", Provider: "balance", BalanceQuota: 123456, ExchangeRate: "7.12345", BalanceState: "cache_pending", PaymentData: `{"private":"preserve"}`, CreatedAt: 1700000000, UpdatedAt: 1700000001}
			event := PaymentWebhookEvent{EventID: "ape_migration_event", ClientID: client.ClientId, OrderID: payment.ID, EventType: "payment.paid", Payload: `{"id":"ape_migration_event","private":"preserve"}`, WebhookURL: paymentApp.WebhookURL, SecretEncrypted: paymentApp.WebhookSecret, Attempts: 3, NextAttemptAt: 1700000009, LeaseToken: "migration-lease", LeaseUntil: 1700000050, LastError: "retryable", CreatedAt: 1700000003}
			walletOperation := PaymentWalletOperation{ID: payment.ID + ":debit", OrderID: payment.ID, UserID: 991, Quota: payment.BalanceQuota, Direction: "debit", State: "cache_pending", UsesRedis: true, LastError: "pending-fixture", CreatedAt: 1700000000, UpdatedAt: 1700000001}
			walletGuard := PaymentWalletGuard{UserID: 991, OperationID: walletOperation.ID, CreatedAt: 1700000000}
			witness := PaymentWalletCacheWitness{UserID: 991, Unsafe: true, CreatedAt: 1700000000}
			mutation := PaymentWalletMutation{ID: "migration-durable-mutation", UserID: 991, CreatedAt: 1700000000}
			for _, row := range []any{&paymentApp, &payment, &event, &walletOperation, &walletGuard, &witness, &mutation} {
				require.NoError(t, db.Create(row).Error)
			}

			recorder.reset()
			migrationErr := migrateDB()
			if migrationErr != nil {
				recorder.mu.Lock()
				start := max(0, len(recorder.statements)-12)
				for _, statement := range recorder.statements[start:] {
					t.Logf("migration context: %s", statement)
				}
				recorder.mu.Unlock()
			}
			require.NoError(t, migrationErr, "full restart migration must succeed")
			for _, statement := range recorder.schemaMutations() {
				lower := strings.ToLower(statement)
				paymentDDL := false
				for _, table := range []string{"payment_applications", "payment_orders", "payment_webhook_events", "payment_wallet_guards", "payment_wallet_operations", "payment_wallet_cache_witnesses", "payment_wallet_mutations"} {
					if strings.Contains(lower, table) {
						paymentDDL = true
					}
				}
				if paymentDDL || strings.Contains(lower, "oauth_grants") || strings.Contains(lower, "oauth_access_tokens") || strings.Contains(lower, "oauth_refresh_tokens") || strings.Contains(lower, "oauth_relay_bindings") || strings.Contains(lower, "oauth_actions") || (dialect == common.DatabaseTypeSQLite && strings.Contains(lower, "finance_entries")) {
					assert.Fail(t, "new OAuth, payment and finance schema must not repeat DDL on restart", "%s", statement)
				}
			}
			var loadedPaymentApp PaymentApplication
			require.NoError(t, db.First(&loadedPaymentApp, paymentApp.ID).Error)
			assert.Equal(t, paymentApp, loadedPaymentApp, "restart must preserve application settings and encrypted webhook secret")
			var loadedPayment PaymentOrder
			require.NoError(t, db.Where("id = ?", payment.ID).First(&loadedPayment).Error)
			assert.Equal(t, payment, loadedPayment, "restart must preserve order, payer, fixed quote and ambiguous payment state")
			var loadedEvent PaymentWebhookEvent
			require.NoError(t, db.First(&loadedEvent, event.ID).Error)
			assert.Equal(t, event, loadedEvent, "restart must preserve signed event payload, secret snapshot and delivery lease")
			var loadedOperation PaymentWalletOperation
			require.NoError(t, db.Where("id = ?", walletOperation.ID).First(&loadedOperation).Error)
			assert.Equal(t, walletOperation, loadedOperation)
			var loadedGuard PaymentWalletGuard
			require.NoError(t, db.Where("user_id = ?", walletGuard.UserID).First(&loadedGuard).Error)
			assert.Equal(t, walletGuard, loadedGuard)
			var loadedWitness PaymentWalletCacheWitness
			require.NoError(t, db.Where("user_id = ?", witness.UserID).First(&loadedWitness).Error)
			assert.Equal(t, witness, loadedWitness)
			var loadedMutation PaymentWalletMutation
			require.NoError(t, db.Where("id = ?", mutation.ID).First(&loadedMutation).Error)
			assert.Equal(t, mutation, loadedMutation)
			// SQLite introspection compatibility must preserve composite and
			// nullable provider-transaction uniqueness, not replace it with
			// single-column uniqueness on a client or merchant order number.
			secondPayment := payment
			secondPayment.ID = "ap_11112233445566778899aabbccdd"
			secondPayment.OutTradeNo = "migration-second-order"
			require.NoError(t, db.Create(&secondPayment).Error)
			otherClientPayment := payment
			otherClientPayment.ID = "ap_22112233445566778899aabbccdd"
			otherClientPayment.ClientID = "another-client"
			require.NoError(t, db.Create(&otherClientPayment).Error)
			duplicatePayment := payment
			duplicatePayment.ID = "ap_33112233445566778899aabbccdd"
			assert.Error(t, db.Create(&duplicatePayment).Error, "same client + merchant number remains unique")
			providerHash := strings.Repeat("f", 64)
			require.NoError(t, db.Model(&PaymentOrder{}).Where("id = ?", payment.ID).Update("provider_trade_hash", providerHash).Error)
			assert.Error(t, db.Model(&PaymentOrder{}).Where("id = ?", secondPayment.ID).Update("provider_trade_hash", providerHash).Error, "provider transaction remains unique after restart")

			var loadedFinance FinanceEntry
			require.NoError(t, db.First(&loadedFinance, finance.Id).Error)
			assert.Equal(t, finance, loadedFinance, "financial rows must survive the full second migration exactly")
			var loadedAction OAuthAction
			require.NoError(t, db.First(&loadedAction, "id = ?", action.ID).Error)
			assert.Equal(t, action, loadedAction, "restart must preserve hosted approval, callback, receipt and claimed-result state")
			var loadedClient OauthClient
			var loadedConsent OauthConsent
			require.NoError(t, db.First(&loadedClient, client.Id).Error)
			require.NoError(t, db.First(&loadedConsent, consent.Id).Error)
			assert.Equal(t, allScopes, loadedClient.Scopes)
			assert.Equal(t, allScopes, loadedConsent.GrantedScopes)
			loadedGrant, err := GetOAuthAccessGrant(accessHash)
			require.NoError(t, err, "restart must preserve the issued grant and access credential")
			assert.Equal(t, allScopes, loadedGrant.Scopes)
			assert.Equal(t, grant.Version, loadedGrant.Version)
			_, err = GetOAuthRefreshGrant(refreshHash, client.Id)
			require.NoError(t, err, "restart must preserve the refresh credential")
		})
	}
}

func TestOAuthDatabaseRelayBinding(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	require.NoError(t, DB.AutoMigrate(&User{}, &Token{}, &OAuthRelayBinding{}))
	for _, table := range []interface{}{&OAuthRelayBinding{}, &Token{}, &User{}} {
		require.NoError(t, DB.Unscoped().Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(table).Error)
	}
	user := User{Username: "matrix-relay-owner", Password: "fixture-password-verifier", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1, Quota: 876543, UsedQuota: 12345, RequestCount: 13, Group: "default"}
	require.NoError(t, DB.Create(&user).Error)
	legacy := Token{UserId: user.Id, Key: "matrix-existing-ordinary-key", Name: "existing ordinary token", Status: common.TokenStatusEnabled, RemainQuota: 123456, UsedQuota: 9876, ExpiredTime: -1, Group: "default"}
	require.NoError(t, DB.Create(&legacy).Error)
	grant := createOAuthGrantStorageTestGrant(t, user.Id, 78)
	first, err := GetOrCreateOAuthRelayToken(grant.ID, user.Id, grant.Version)
	require.NoError(t, err)
	second, err := GetOrCreateOAuthRelayToken(grant.ID, user.Id, grant.Version)
	require.NoError(t, err, "existing binding fast path must work on every database")
	assert.Equal(t, first.Id, second.Id)
	assert.Equal(t, first.Key, second.Key)
	assert.True(t, second.OAuthInternal)
	assert.Equal(t, grant.ID, second.OAuthGrantID)
	assert.Equal(t, grant.Version, second.OAuthGrantVersion)
	assert.Equal(t, user.Id, second.UserId)
	assert.Equal(t, grant.ExpiresAt, second.ExpiredTime)
	var bindings int64
	require.NoError(t, DB.Model(&OAuthRelayBinding{}).Where("grant_id = ?", grant.ID).Count(&bindings).Error)
	assert.EqualValues(t, 1, bindings, "repeated requests share exactly one accounting identity")
	var persistedUser User
	var persistedLegacy Token
	require.NoError(t, DB.First(&persistedUser, user.Id).Error)
	require.NoError(t, DB.First(&persistedLegacy, legacy.Id).Error)
	assert.Equal(t, user.Quota, persistedUser.Quota)
	assert.Equal(t, user.UsedQuota, persistedUser.UsedQuota)
	assert.Equal(t, user.RequestCount, persistedUser.RequestCount)
	assert.Equal(t, legacy, persistedLegacy)
	revoked, err := RevokeOAuthGrantForUser(grant.ID, user.Id)
	require.NoError(t, err)
	require.True(t, revoked)
	_, err = GetOrCreateOAuthRelayToken(grant.ID, user.Id, grant.Version)
	assert.Error(t, err, "revoked grants cannot reuse the binding fast path")
	metadata, err := GetOAuthRelayTokenMetadata(first.Id)
	require.NoError(t, err, "the accounting identity must remain for already accepted task settlement")
	assert.Equal(t, grant.ID, metadata.OAuthGrantID)
	assert.True(t, metadata.OAuthInternal)
}
