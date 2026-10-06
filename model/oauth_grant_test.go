package model

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// External DSNs must point to isolated, disposable OAuth test databases.
// The default fixture is a fresh private SQLite database for every test.
func setupOAuthGrantStorageTest(t *testing.T) {
	t.Helper()
	dialect := common.DatabaseType(os.Getenv("TEST_OAUTH_DIALECT"))
	var driver gorm.Dialector
	switch dialect {
	case "", common.DatabaseTypeSQLite:
		dialect = common.DatabaseTypeSQLite
		driver = sqlite.Open(":memory:")
		if os.Getenv("TEST_OAUTH_SQLITE_MULTICONNECTION") == "1" {
			driver = sqlite.Open(filepath.Join(t.TempDir(), "oauth.sqlite") + "?_pragma=journal_mode%3DWAL&_pragma=busy_timeout%3D1000")
		}
	case common.DatabaseTypeMySQL:
		dsn := os.Getenv("TEST_OAUTH_MYSQL_DSN")
		require.NotEmpty(t, dsn, "isolated MySQL DSN must be explicitly configured")
		driver = mysql.Open(dsn)
	case common.DatabaseTypePostgreSQL:
		dsn := os.Getenv("TEST_OAUTH_POSTGRES_DSN")
		require.NotEmpty(t, dsn, "isolated PostgreSQL DSN must be explicitly configured")
		driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
	default:
		t.Fatalf("unsupported OAuth test dialect %q", dialect)
	}
	db, err := gorm.Open(driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	if dialect == common.DatabaseTypeSQLite && os.Getenv("TEST_OAUTH_SQLITE_MULTICONNECTION") != "1" {
		sqlDB.SetMaxOpenConns(1)
	} else {
		sqlDB.SetMaxOpenConns(4)
	}
	previousDB, previousType := DB, common.MainDatabaseType()
	DB = db
	common.SetMainDatabaseType(dialect)
	t.Cleanup(func() {
		DB = previousDB
		common.SetMainDatabaseType(previousType)
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&OAuthGrant{}, &OAuthAccessToken{}, &OAuthRefreshToken{}))
	for _, table := range []interface{}{&OAuthAccessToken{}, &OAuthRefreshToken{}, &OAuthGrant{}} {
		require.NoError(t, db.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(table).Error)
	}
	t.Logf("OAuth storage database: %s", dialect)
}

func oauthGrantStorageTestHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func createOAuthGrantStorageTestGrant(t *testing.T, userID, clientID int) *OAuthGrant {
	t.Helper()
	grant := &OAuthGrant{
		UserID: userID, OAuthClientID: clientID,
		Scopes: "openid profile account:read account:write", Resources: `["newapi","reports"]`,
		UserAuthVersion: 1, UserAuthFingerprint: oauthGrantStorageTestHash("user"), ClientAuthVersion: oauthGrantStorageTestHash("client"),
		ExpiresAt: time.Now().Unix() + 3600,
	}
	require.NoError(t, CreateOAuthGrant(grant))
	return grant
}

func TestOAuthGrantStorageIssueAndExpiration(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	grant := createOAuthGrantStorageTestGrant(t, 12, 8)
	accessHash, refreshHash := oauthGrantStorageTestHash("access"), oauthGrantStorageTestHash("refresh")
	require.NoError(t, IssueOAuthTokenPair(grant.ID, accessHash, refreshHash, grant.ExpiresAt+100, grant.ExpiresAt+200))
	loaded, err := GetOAuthAccessGrant(accessHash)
	require.NoError(t, err)
	assert.Equal(t, grant.ID, loaded.ID)
	assert.Equal(t, grant.Scopes, loaded.Scopes)
	var access OAuthAccessToken
	var refresh OAuthRefreshToken
	require.NoError(t, DB.Where("token_hash = ?", accessHash).First(&access).Error)
	require.NoError(t, DB.Where("token_hash = ?", refreshHash).First(&refresh).Error)
	assert.Equal(t, grant.ExpiresAt, access.ExpiresAt, "token must not outlive its grant")
	assert.Equal(t, grant.ExpiresAt, refresh.ExpiresAt)
	assert.NotEqual(t, "access", access.TokenHash, "only the verifier is persisted")
	assert.ErrorIs(t, IssueOAuthTokenPair(grant.ID, oauthGrantStorageTestHash("branch-access"), oauthGrantStorageTestHash("branch-refresh"), grant.ExpiresAt, grant.ExpiresAt), ErrOAuthGrantInvalid)
	_, err = GetOAuthAccessGrant("access")
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	_, err = GetOAuthAccessGrant(oauthGrantStorageTestHash("unknown"))
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	_, err = GetOAuthAccessGrant(refreshHash)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid, "refresh credentials are never access credentials")
	_, err = GetOAuthRefreshGrant(accessHash, grant.OAuthClientID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	require.NoError(t, DB.Model(&OAuthAccessToken{}).Where("id = ?", access.ID).Update("expires_at", time.Now().Unix()).Error)
	_, err = GetOAuthAccessGrant(accessHash)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	require.NoError(t, DB.Model(&OAuthRefreshToken{}).Where("id = ?", refresh.ID).Update("expires_at", time.Now().Unix()).Error)
	_, err = GetOAuthRefreshGrant(refreshHash, grant.OAuthClientID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)

	accessOnly := createOAuthGrantStorageTestGrant(t, 12, 9)
	require.NoError(t, IssueOAuthTokenPair(accessOnly.ID, oauthGrantStorageTestHash("access-only"), "", accessOnly.ExpiresAt, 0))
	_, err = GetOAuthAccessGrant(oauthGrantStorageTestHash("access-only"))
	require.NoError(t, err)
	require.NoError(t, DB.Model(&OAuthGrant{}).Where("id = ?", accessOnly.ID).Update("expires_at", time.Now().Unix()).Error)
	_, err = GetOAuthAccessGrant(oauthGrantStorageTestHash("access-only"))
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid, "unexpired bearer token cannot bypass expired grant")
}

func TestOAuthGrantStorageRefreshReplayRevokesWholeFamily(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	grant := createOAuthGrantStorageTestGrant(t, 12, 8)
	access0, refresh0 := oauthGrantStorageTestHash("access0"), oauthGrantStorageTestHash("refresh0")
	access1, refresh1 := oauthGrantStorageTestHash("access1"), oauthGrantStorageTestHash("refresh1")
	access2, refresh2 := oauthGrantStorageTestHash("access2"), oauthGrantStorageTestHash("refresh2")
	require.NoError(t, IssueOAuthTokenPair(grant.ID, access0, refresh0, grant.ExpiresAt, grant.ExpiresAt))
	rotated, err := RotateOAuthRefreshToken(refresh0, grant.OAuthClientID, access1, refresh1, grant.ExpiresAt, grant.ExpiresAt)
	require.NoError(t, err)
	assert.Equal(t, grant.ID, rotated.ID)
	_, err = RotateOAuthRefreshToken(refresh1, grant.OAuthClientID, access2, refresh2, grant.ExpiresAt, grant.ExpiresAt)
	require.NoError(t, err)
	_, err = GetOAuthRefreshGrant(refresh0, grant.OAuthClientID)
	require.NoError(t, err, "prevalidation must allow consumed ancestors to reach replay detection")
	_, err = RotateOAuthRefreshToken(refresh0, grant.OAuthClientID, oauthGrantStorageTestHash("unused-access"), oauthGrantStorageTestHash("unused-refresh"), grant.ExpiresAt, grant.ExpiresAt)
	assert.ErrorIs(t, err, ErrOAuthRefreshReplay)
	for _, access := range []string{access0, access1, access2} {
		_, err = GetOAuthAccessGrant(access)
		assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	}
	_, err = GetOAuthRefreshGrant(refresh2, grant.OAuthClientID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	var persisted OAuthGrant
	require.NoError(t, DB.First(&persisted, grant.ID).Error)
	assert.Positive(t, persisted.RevokedAt, "replay revocation must commit before the error is returned")
	assert.Greater(t, persisted.Version, grant.Version)
	var tokenCount int64
	require.NoError(t, DB.Model(&OAuthRefreshToken{}).Where("grant_id = ?", grant.ID).Count(&tokenCount).Error)
	assert.Equal(t, int64(3), tokenCount, "replay must not issue a new token")
}

func TestOAuthGrantStorageConcurrentRefreshHasOneWinnerAndRevokesReplay(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	grant := createOAuthGrantStorageTestGrant(t, 12, 8)
	refreshHash := oauthGrantStorageTestHash("refresh")
	require.NoError(t, IssueOAuthTokenPair(grant.ID, oauthGrantStorageTestHash("access"), refreshHash, grant.ExpiresAt, grant.ExpiresAt))
	start := make(chan struct{})
	errorsByRequest := make([]error, 2)
	var done sync.WaitGroup
	for i := range errorsByRequest {
		done.Add(1)
		go func(index int) {
			defer done.Done()
			<-start
			_, errorsByRequest[index] = RotateOAuthRefreshToken(refreshHash, grant.OAuthClientID,
				oauthGrantStorageTestHash(fmt.Sprintf("access-%d", index)), oauthGrantStorageTestHash(fmt.Sprintf("refresh-%d", index)),
				grant.ExpiresAt, grant.ExpiresAt)
		}(i)
	}
	close(start)
	done.Wait()
	winners, replays := 0, 0
	for _, err := range errorsByRequest {
		if err == nil {
			winners++
		} else {
			assert.ErrorIs(t, err, ErrOAuthRefreshReplay)
			replays++
		}
	}
	assert.Equal(t, 1, winners)
	assert.Equal(t, 1, replays)
	_, err := GetOAuthGrantByID(grant.ID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid, "even the winning pair becomes invalid after a concurrent replay")
}

func TestOAuthGrantStorageSQLiteConcurrentSnapshotReplay(t *testing.T) {
	t.Setenv("TEST_OAUTH_DIALECT", "sqlite")
	t.Setenv("TEST_OAUTH_SQLITE_MULTICONNECTION", "1")
	setupOAuthGrantStorageTest(t)
	grant := createOAuthGrantStorageTestGrant(t, 12, 8)
	refreshHash := oauthGrantStorageTestHash("refresh")
	require.NoError(t, IssueOAuthTokenPair(grant.ID, oauthGrantStorageTestHash("access"), refreshHash, grant.ExpiresAt, grant.ExpiresAt))

	// Hold both initial reads until both transactions have the same unconsumed
	// snapshot. The loser must retry a new snapshot and commit family revocation.
	var initialReads atomic.Int32
	bothRead := make(chan struct{})
	const callbackName = "test:oauth_concurrent_refresh_snapshot"
	require.NoError(t, DB.Callback().Query().After("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table != "oauth_refresh_tokens" {
			return
		}
		read := initialReads.Add(1)
		if read == 2 {
			close(bothRead)
		}
		if read <= 2 {
			select {
			case <-bothRead:
			case <-time.After(5 * time.Second):
				tx.AddError(fmt.Errorf("concurrent SQLite snapshot test did not reach both readers"))
			}
		}
	}))
	t.Cleanup(func() { require.NoError(t, DB.Callback().Query().Remove(callbackName)) })
	results := make(chan error, 2)
	for index := 0; index < 2; index++ {
		go func(index int) {
			_, err := RotateOAuthRefreshToken(refreshHash, grant.OAuthClientID,
				oauthGrantStorageTestHash(fmt.Sprintf("race-access-%d", index)), oauthGrantStorageTestHash(fmt.Sprintf("race-refresh-%d", index)),
				grant.ExpiresAt, grant.ExpiresAt)
			results <- err
		}(index)
	}
	winners := 0
	for index := 0; index < 2; index++ {
		err := <-results
		if err == nil {
			winners++
		} else {
			assert.ErrorIs(t, err, ErrOAuthRefreshReplay)
		}
	}
	assert.Equal(t, 1, winners)
	_, err := GetOAuthGrantByID(grant.ID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
}

func TestOAuthGrantStorageIssueAndRotationRollbackOnInsertFailure(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	grant := createOAuthGrantStorageTestGrant(t, 12, 8)
	accessHash, refreshHash := oauthGrantStorageTestHash("access"), oauthGrantStorageTestHash("refresh")
	require.NoError(t, IssueOAuthTokenPair(grant.ID, accessHash, refreshHash, grant.ExpiresAt, grant.ExpiresAt))
	second := createOAuthGrantStorageTestGrant(t, 13, 8)
	newAccess := oauthGrantStorageTestHash("new-access")
	assert.Error(t, IssueOAuthTokenPair(second.ID, newAccess, refreshHash, second.ExpiresAt, second.ExpiresAt))
	_, err := GetOAuthAccessGrant(newAccess)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid, "partial pair must roll back when refresh insertion fails")
	require.NoError(t, IssueOAuthTokenPair(second.ID, newAccess, oauthGrantStorageTestHash("second-refresh"), second.ExpiresAt, second.ExpiresAt))
	_, err = RotateOAuthRefreshToken(refreshHash, grant.OAuthClientID, newAccess, oauthGrantStorageTestHash("duplicate-access-refresh"), grant.ExpiresAt, grant.ExpiresAt)
	require.Error(t, err, "access verifier collision must roll back consumption")
	var refresh OAuthRefreshToken
	require.NoError(t, DB.Where("token_hash = ?", refreshHash).First(&refresh).Error)
	assert.Zero(t, refresh.ConsumedAt)
	_, err = RotateOAuthRefreshToken(refreshHash, grant.OAuthClientID, oauthGrantStorageTestHash("next-access"), oauthGrantStorageTestHash("next-refresh"), grant.ExpiresAt, grant.ExpiresAt)
	require.NoError(t, err, "a failed transaction cannot strand the existing refresh token")
}

func TestOAuthGrantStorageOwnershipAndClientBoundRevocation(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	grant := createOAuthGrantStorageTestGrant(t, 12, 8)
	other := createOAuthGrantStorageTestGrant(t, 13, 9)
	accessHash, refreshHash := oauthGrantStorageTestHash("access"), oauthGrantStorageTestHash("refresh")
	require.NoError(t, IssueOAuthTokenPair(grant.ID, accessHash, refreshHash, grant.ExpiresAt, grant.ExpiresAt))
	_, err := GetOAuthRefreshGrant(refreshHash, other.OAuthClientID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	_, err = RotateOAuthRefreshToken(refreshHash, other.OAuthClientID, oauthGrantStorageTestHash("foreign-access"), oauthGrantStorageTestHash("foreign-refresh"), grant.ExpiresAt, grant.ExpiresAt)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	require.NoError(t, RevokeOAuthToken(accessHash, other.OAuthClientID))
	revoked, err := RevokeOAuthGrantForUser(grant.ID, other.UserID)
	require.NoError(t, err)
	assert.False(t, revoked)
	_, err = GetOAuthAccessGrant(accessHash)
	require.NoError(t, err)
	_, err = NarrowOAuthGrant(grant.ID, other.UserID, []string{"openid"}, []string{"newapi"})
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	grants, err := ListOAuthGrantsForUser(grant.UserID)
	require.NoError(t, err)
	require.Len(t, grants, 1)
	assert.Equal(t, grant.ID, grants[0].ID)
	require.NoError(t, RevokeOAuthToken(refreshHash, grant.OAuthClientID))
	_, err = GetOAuthAccessGrant(accessHash)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	grants, err = ListOAuthGrantsForUser(grant.UserID)
	require.NoError(t, err)
	assert.Empty(t, grants)
	require.NoError(t, RevokeOAuthToken(refreshHash, grant.OAuthClientID), "repeat revocation remains idempotent")
	require.NoError(t, RevokeOAuthToken(oauthGrantStorageTestHash("missing"), grant.OAuthClientID))
	_, err = GetOAuthGrantByID(other.ID)
	require.NoError(t, err, "other grant is unaffected")
	revoked, err = RevokeOAuthGrantForUser(other.ID, other.UserID)
	require.NoError(t, err)
	assert.True(t, revoked)
	revoked, err = RevokeOAuthGrantForUser(other.ID, other.UserID)
	require.NoError(t, err)
	assert.False(t, revoked)
}

func TestOAuthGrantStorageNarrowingInvalidatesExistingCredentials(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	grant := createOAuthGrantStorageTestGrant(t, 12, 8)
	accessHash, refreshHash := oauthGrantStorageTestHash("access"), oauthGrantStorageTestHash("refresh")
	require.NoError(t, IssueOAuthTokenPair(grant.ID, accessHash, refreshHash, grant.ExpiresAt, grant.ExpiresAt))
	for _, request := range []struct{ scopes, resources []string }{
		{[]string{"openid", "system:write"}, []string{"newapi"}},
		{[]string{"openid"}, []string{"other-audience"}},
	} {
		_, err := NarrowOAuthGrant(grant.ID, grant.UserID, request.scopes, request.resources)
		assert.ErrorIs(t, err, ErrOAuthScopeExpansion)
	}
	_, err := GetOAuthAccessGrant(accessHash)
	require.NoError(t, err, "rejected widening must not mutate the grant")
	narrowed, err := NarrowOAuthGrant(grant.ID, grant.UserID, []string{"openid", "account:read", "account:read"}, []string{"newapi"})
	require.NoError(t, err)
	assert.Equal(t, "openid account:read", narrowed.Scopes)
	assert.JSONEq(t, `["newapi"]`, narrowed.Resources)
	assert.Equal(t, grant.Version+1, narrowed.Version)
	_, err = GetOAuthAccessGrant(accessHash)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	_, err = GetOAuthRefreshGrant(refreshHash, grant.OAuthClientID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	_, err = RotateOAuthRefreshToken(refreshHash, grant.OAuthClientID, oauthGrantStorageTestHash("new-access"), oauthGrantStorageTestHash("new-refresh"), grant.ExpiresAt, grant.ExpiresAt)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	current, err := GetOAuthGrantByID(grant.ID)
	require.NoError(t, err)
	assert.Zero(t, current.RevokedAt)
	assert.Equal(t, narrowed.Scopes, current.Scopes)
}

func TestOAuthGrantStorageIssuanceParticipatesInCallerTransaction(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	grant := &OAuthGrant{
		UserID: 12, OAuthClientID: 8, Scopes: "openid", Resources: `["newapi"]`,
		UserAuthVersion: 1, UserAuthFingerprint: oauthGrantStorageTestHash("user"), ClientAuthVersion: oauthGrantStorageTestHash("client"),
		ExpiresAt: time.Now().Unix() + 3600,
	}
	accessHash := oauthGrantStorageTestHash("access")
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := CreateOAuthGrantWithTx(tx, grant); err != nil {
			return err
		}
		if err := IssueOAuthTokenPairWithTx(tx, grant.ID, accessHash, oauthGrantStorageTestHash("refresh"), grant.ExpiresAt, grant.ExpiresAt); err != nil {
			return err
		}
		return ErrOAuthGrantInvalid // Simulate failed authorization-code consumption.
	})
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	_, err = GetOAuthGrantByID(grant.ID)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	_, err = GetOAuthAccessGrant(accessHash)
	assert.ErrorIs(t, err, ErrOAuthGrantInvalid)
	var refreshCount int64
	require.NoError(t, DB.Model(&OAuthRefreshToken{}).Count(&refreshCount).Error)
	assert.Zero(t, refreshCount)
}

func TestOAuthGrantStorageCleanupKeepsLiveAndRetainedTokenFamilies(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	now := time.Now().UTC()
	grants := []*OAuthGrant{
		createOAuthGrantStorageTestGrant(t, 12, 8),
		createOAuthGrantStorageTestGrant(t, 12, 8),
		createOAuthGrantStorageTestGrant(t, 12, 8),
	}
	for index, grant := range grants {
		require.NoError(t, IssueOAuthTokenPair(grant.ID, oauthGrantStorageTestHash(fmt.Sprintf("access-%d", index)),
			oauthGrantStorageTestHash(fmt.Sprintf("refresh-%d", index)), grant.ExpiresAt, grant.ExpiresAt))
	}
	// A consumed ancestor of an active family remains available for detection.
	_, err := RotateOAuthRefreshToken(oauthGrantStorageTestHash("refresh-2"), grants[2].OAuthClientID,
		oauthGrantStorageTestHash("next-access"), oauthGrantStorageTestHash("next-refresh"), grants[2].ExpiresAt, grants[2].ExpiresAt)
	require.NoError(t, err)
	require.NoError(t, DB.Model(&OAuthGrant{}).Where("id = ?", grants[0].ID).Update("expires_at", now.Add(-31*24*time.Hour).Unix()).Error)
	require.NoError(t, DB.Model(&OAuthGrant{}).Where("id = ?", grants[1].ID).Update("expires_at", now.Add(-30*24*time.Hour).Unix()).Error)
	removed, err := CleanupExpiredOAuthGrants(now)
	require.NoError(t, err)
	assert.Equal(t, int64(1), removed)
	for _, model := range []interface{}{&OAuthAccessToken{}, &OAuthRefreshToken{}} {
		var count int64
		require.NoError(t, DB.Model(model).Where("grant_id = ?", grants[0].ID).Count(&count).Error)
		assert.Zero(t, count, "expired family children are removed with their grant")
		require.NoError(t, DB.Model(model).Where("grant_id = ?", grants[1].ID).Count(&count).Error)
		assert.Equal(t, int64(1), count, "the retention boundary is not collected early")
	}
	_, err = GetOAuthRefreshGrant(oauthGrantStorageTestHash("refresh-2"), grants[2].OAuthClientID)
	require.NoError(t, err)
	_, err = RotateOAuthRefreshToken(oauthGrantStorageTestHash("refresh-2"), grants[2].OAuthClientID,
		oauthGrantStorageTestHash("replay-access"), oauthGrantStorageTestHash("replay-refresh"), grants[2].ExpiresAt, grants[2].ExpiresAt)
	assert.ErrorIs(t, err, ErrOAuthRefreshReplay, "cleanup cannot erase a live family's replay evidence")
	removed, err = CleanupExpiredOAuthGrants(now)
	require.NoError(t, err)
	assert.Zero(t, removed)
}

func TestOAuthGrantStorageAuthorizationCodeTransactionAndConsumedLookup(t *testing.T) {
	setupOAuthGrantStorageTest(t)
	require.NoError(t, DB.AutoMigrate(&AuthFlow{}))
	code, flow, err := CreateAuthFlow(AuthFlowCreate{Purpose: "oidc_code", UserId: 12, Payload: `{"grant_id":13}`, ExpiresAt: time.Now().Add(time.Minute)})
	require.NoError(t, err)
	_, err = GetConsumedOAuthAuthorizationFlow(code)
	assert.ErrorIs(t, err, ErrAuthFlowInvalid, "unused codes must not reach the replay lookup")
	actionErr := errors.New("authorization grant insertion failed")
	_, err = ConsumeOAuthAuthorizationFlow(code, func(*gorm.DB, *AuthFlow) error { return actionErr })
	assert.ErrorIs(t, err, actionErr)
	_, err = GetAuthFlow(code, AuthFlowMatch{Purpose: "oidc_code"})
	require.NoError(t, err, "transaction failure leaves the code available")
	consumed, err := ConsumeOAuthAuthorizationFlow(code, nil)
	require.NoError(t, err)
	assert.Equal(t, flow.Id, consumed.Id)
	_, err = ConsumeOAuthAuthorizationFlow(code, nil)
	assert.ErrorIs(t, err, ErrAuthFlowConsumed)
	stored, err := GetConsumedOAuthAuthorizationFlow(code)
	require.NoError(t, err)
	assert.Equal(t, flow.Payload, stored.Payload)
	assert.NotNil(t, stored.ConsumedAt)

	otherCode, _, err := CreateAuthFlow(AuthFlowCreate{Purpose: AuthFlowPurposeOAuth, ExpiresAt: time.Now().Add(time.Minute)})
	require.NoError(t, err)
	_, err = ConsumeOAuthAuthorizationFlow(otherCode, nil)
	assert.ErrorIs(t, err, ErrAuthFlowInvalid, "code wrapper cannot consume unrelated authentication flows")
	_, err = ConsumeAuthFlow(otherCode, AuthFlowMatch{Purpose: AuthFlowPurposeOAuth})
	require.NoError(t, err)
	_, err = GetConsumedOAuthAuthorizationFlow(otherCode)
	assert.ErrorIs(t, err, ErrAuthFlowInvalid, "consumed flows of other purposes remain inaccessible")
}

func TestOAuthGrantStorageSQLiteConcurrentAuthorizationCodeReplay(t *testing.T) {
	t.Setenv("TEST_OAUTH_DIALECT", "sqlite")
	t.Setenv("TEST_OAUTH_SQLITE_MULTICONNECTION", "1")
	setupOAuthGrantStorageTest(t)
	require.NoError(t, DB.AutoMigrate(&AuthFlow{}))
	code, _, err := CreateAuthFlow(AuthFlowCreate{Purpose: "oidc_code", ExpiresAt: time.Now().Add(time.Minute)})
	require.NoError(t, err)
	var initialReads atomic.Int32
	var committedActions atomic.Int32
	bothRead := make(chan struct{})
	const callbackName = "test:oauth_concurrent_authorization_code"
	require.NoError(t, DB.Callback().Query().After("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table != "auth_flows" {
			return
		}
		read := initialReads.Add(1)
		if read == 2 {
			close(bothRead)
		}
		if read <= 2 {
			select {
			case <-bothRead:
			case <-time.After(5 * time.Second):
				tx.AddError(errors.New("authorization-code test did not reach both readers"))
			}
		}
	}))
	t.Cleanup(func() { require.NoError(t, DB.Callback().Query().Remove(callbackName)) })
	results := make(chan error, 2)
	for index := 0; index < 2; index++ {
		go func() {
			_, err := ConsumeOAuthAuthorizationFlow(code, func(tx *gorm.DB, flow *AuthFlow) error {
				committedActions.Add(1)
				return tx.Model(&AuthFlow{}).Where("id = ?", flow.Id).Update("payload", `{"grant_id":42}`).Error
			})
			results <- err
		}()
	}
	winners := 0
	for index := 0; index < 2; index++ {
		err := <-results
		if err == nil {
			winners++
		} else {
			assert.ErrorIs(t, err, ErrAuthFlowConsumed, "SQLite snapshot loser must reach replay detection")
		}
	}
	assert.Equal(t, 1, winners)
	assert.Equal(t, int32(1), committedActions.Load())
	consumed, err := GetConsumedOAuthAuthorizationFlow(code)
	require.NoError(t, err)
	assert.JSONEq(t, `{"grant_id":42}`, consumed.Payload, "replay recovery must locate the committed winning grant")
}
