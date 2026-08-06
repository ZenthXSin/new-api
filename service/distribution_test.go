package service

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupDistributionTest(t *testing.T) (*model.TelemetryApp, string) {
	t.Helper()
	previousDB, previousSecret, previousRoot := model.DB, common.CryptoSecret, DistributionStorageRoot
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.TelemetryProject{}, &model.TelemetryApp{}, &model.TelemetryWriteKey{}, &model.DistributionRelease{}, &model.DistributionAsset{}, &model.DistributionAnnouncement{}))
	model.DB, common.CryptoSecret, DistributionStorageRoot = db, "distribution-test-secret", t.TempDir()
	t.Cleanup(func() {
		model.DB, common.CryptoSecret, DistributionStorageRoot = previousDB, previousSecret, previousRoot
	})
	project, err := model.CreateTelemetryProject("distribution-project")
	require.NoError(t, err)
	app, err := model.CreateTelemetryApp(project.ID, "distribution-app")
	require.NoError(t, err)
	return app, DistributionStorageRoot
}

func TestVerifyAppBearerAndKeyRotation(t *testing.T) {
	app, _ := setupDistributionTest(t)
	first, firstSecret, err := CreateTelemetryWriteKey(app.ID, "first")
	require.NoError(t, err)
	verified, err := VerifyAppBearer("127.0.0.1", "Bearer app_v1."+first.KeyID+"."+firstSecret)
	require.NoError(t, err)
	assert.Equal(t, first.ID, verified.ID)
	second, _, err := CreateTelemetryWriteKey(app.ID, "second")
	require.NoError(t, err)
	_, err = VerifyAppBearer("127.0.0.1", "Bearer app_v1."+first.KeyID+"."+firstSecret)
	require.Error(t, err)
	_, err = VerifyAppBearer("127.0.0.1", "Bearer app_v1.bad.extra.parts")
	require.Error(t, err)
	var active int64
	require.NoError(t, model.DB.Model(&model.TelemetryWriteKey{}).Where("app_id = ? AND disabled_at IS NULL", app.ID).Count(&active).Error)
	assert.Equal(t, int64(1), active)
	require.NoError(t, model.DisableTelemetryWriteKey(second.ID))
	third, _, err := CreateTelemetryWriteKey(app.ID, "third")
	require.NoError(t, err)
	assert.NotZero(t, third.ID)
}

func TestDistributionPublicFilteringLatestAndAsset(t *testing.T) {
	app, _ := setupDistributionTest(t)
	draft, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "1.0.0", Channel: "stable"})
	require.NoError(t, err)
	_, err = PublicDistributionReleases(app.ID, "stable")
	require.NoError(t, err)
	asset, err := UploadDistributionAsset(app.ID, draft.ID, "linux", "amd64", "app.tar.gz", "application/gzip", bytes.NewBufferString("payload"))
	require.NoError(t, err)
	_, err = PublishDistributionRelease(app.ID, draft.ID)
	require.NoError(t, err)
	second, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "1.1.0", Channel: "stable"})
	require.NoError(t, err)
	_, err = UploadDistributionAsset(app.ID, second.ID, "linux", "amd64", "next.tar.gz", "application/gzip", bytes.NewBufferString("next"))
	require.NoError(t, err)
	_, err = PublishDistributionRelease(app.ID, second.ID)
	require.NoError(t, err)
	latest, err := LatestPublicDistributionRelease(app.ID, "stable")
	require.NoError(t, err)
	assert.Equal(t, "1.1.0", latest.Version)
	publicAsset, err := FindPublicDistributionAsset(app.ID, asset.ID)
	require.NoError(t, err)
	file, err := AssetFile(publicAsset)
	require.NoError(t, err)
	defer file.Close()
	content := make([]byte, 7)
	_, err = file.Read(content)
	require.NoError(t, err)
	assert.Equal(t, "payload", string(content))
	otherProject, err := model.CreateTelemetryProject("other-project")
	require.NoError(t, err)
	otherApp, err := model.CreateTelemetryApp(otherProject.ID, "other-app")
	require.NoError(t, err)
	_, err = FindPublicDistributionAsset(otherApp.ID, asset.ID)
	assert.ErrorIs(t, err, ErrDistributionNotFound)
}

func TestDistributionSemverPrereleaseOrdering(t *testing.T) {
	assert.Greater(t, compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2"), 0)
	assert.Greater(t, compareVersions("1.0.0", "1.0.0-rc.1"), 0)
	assert.Zero(t, compareVersions("1.0.0+build.2", "1.0.0+build.1"))
	_, valid := canonicalVersion("1.0.0-01")
	assert.False(t, valid)
}

func TestDistributionReleaseSchemaStringBoundaries(t *testing.T) {
	channel32 := strings.Repeat("a", 32)
	version64 := "1.0.0+" + strings.Repeat("a", 58)
	version65 := "1.0.0+" + strings.Repeat("a", 59)
	cases := []struct {
		name  string
		input ReleaseInput
		valid bool
	}{
		{name: "32 character channel", input: ReleaseInput{Version: "1.0.0", Channel: channel32}, valid: true},
		{name: "33 character channel", input: ReleaseInput{Version: "1.0.0", Channel: strings.Repeat("a", 33)}},
		{name: "64 character version", input: ReleaseInput{Version: version64, Channel: "stable"}, valid: true},
		{name: "65 character version", input: ReleaseInput{Version: version65, Channel: "stable"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			app, _ := setupDistributionTest(t)
			release, err := CreateDistributionRelease(app.ID, testCase.input)
			if !testCase.valid {
				assert.ErrorIs(t, err, ErrDistributionInvalid)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, strings.TrimPrefix(testCase.input.Version, "v"), release.Version)
			assert.Equal(t, normalizeChannel(testCase.input.Channel), release.Channel)
		})
	}
}

func TestDistributionAnnouncementSchemaStringBoundaries(t *testing.T) {
	tag32 := strings.Repeat("a", 32)
	version64 := "1.0.0+" + strings.Repeat("a", 58)
	version65 := "1.0.0+" + strings.Repeat("a", 59)
	cases := []struct {
		name  string
		input AnnouncementInput
		valid bool
	}{
		{name: "32 character channel", input: AnnouncementInput{Title: "title", Body: "body", Channel: tag32}, valid: true},
		{name: "33 character channel", input: AnnouncementInput{Title: "title", Body: "body", Channel: strings.Repeat("a", 33)}},
		{name: "32 character platform", input: AnnouncementInput{Title: "title", Body: "body", Platform: tag32}, valid: true},
		{name: "33 character platform", input: AnnouncementInput{Title: "title", Body: "body", Platform: strings.Repeat("a", 33)}},
		{name: "64 character min version", input: AnnouncementInput{Title: "title", Body: "body", MinVersion: version64}, valid: true},
		{name: "65 character min version", input: AnnouncementInput{Title: "title", Body: "body", MinVersion: version65}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			app, _ := setupDistributionTest(t)
			announcement, err := CreateDistributionAnnouncement(app.ID, testCase.input)
			if !testCase.valid {
				assert.ErrorIs(t, err, ErrDistributionInvalid)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, normalizeChannel(testCase.input.Channel), announcement.Channel)
			assert.Equal(t, normalizeChannel(testCase.input.Platform), announcement.Platform)
			expectedMinVersion := ""
			if testCase.input.MinVersion != "" {
				expectedMinVersion, _ = canonicalVersion(testCase.input.MinVersion)
			}
			assert.Equal(t, expectedMinVersion, announcement.MinVersion)
		})
	}
}

func TestDistributionAssetSchemaStringBoundaries(t *testing.T) {
	tag32 := strings.Repeat("a", 32)
	content128 := strings.Repeat("c", 128)
	cases := []struct {
		name         string
		platform     string
		architecture string
		contentType  string
		valid        bool
	}{
		{name: "32 character platform and architecture", platform: tag32, architecture: tag32, valid: true},
		{name: "33 character platform", platform: strings.Repeat("a", 33), architecture: "amd64"},
		{name: "33 character architecture", platform: "linux", architecture: strings.Repeat("a", 33)},
		{name: "trimmed 128 character content type", platform: "linux", architecture: "amd64", contentType: " " + content128 + " ", valid: true},
		{name: "trimmed 129 character content type", platform: "linux", architecture: "amd64", contentType: " " + strings.Repeat("c", 129) + " "},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			app, _ := setupDistributionTest(t)
			release, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "1.0.0", Channel: "stable"})
			require.NoError(t, err)
			asset, err := UploadDistributionAsset(app.ID, release.ID, testCase.platform, testCase.architecture, "installer.tar.gz", testCase.contentType, bytes.NewBufferString("asset"))
			if !testCase.valid {
				assert.ErrorIs(t, err, ErrDistributionInvalid)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, normalizeChannel(testCase.platform), asset.Platform)
			assert.Equal(t, normalizeChannel(testCase.architecture), asset.Architecture)
			assert.Equal(t, strings.TrimSpace(testCase.contentType), asset.ContentType)
		})
	}
}

type unreadDistributionAssetSource struct {
	reads int
}

func (source *unreadDistributionAssetSource) Read([]byte) (int, error) {
	source.reads++
	return 0, io.ErrUnexpectedEOF
}

func TestUploadDistributionAssetPreflightsReleaseBeforeReading(t *testing.T) {
	tests := []struct {
		name           string
		prepareRelease func(t *testing.T, appID int64) int64
		expected       error
	}{
		{
			name: "missing release",
			prepareRelease: func(_ *testing.T, _ int64) int64 {
				return 999
			},
			expected: ErrDistributionNotFound,
		},
		{
			name: "release belongs to another app",
			prepareRelease: func(t *testing.T, _ int64) int64 {
				project, err := model.CreateTelemetryProject("other-distribution-project")
				require.NoError(t, err)
				otherApp, err := model.CreateTelemetryApp(project.ID, "other-distribution-app")
				require.NoError(t, err)
				release, err := CreateDistributionRelease(otherApp.ID, ReleaseInput{Version: "1.0.0", Channel: "stable"})
				require.NoError(t, err)
				return release.ID
			},
			expected: ErrDistributionNotFound,
		},
		{
			name: "non draft release",
			prepareRelease: func(t *testing.T, appID int64) int64 {
				release := model.DistributionRelease{
					AppID:   appID,
					Version: "1.0.0",
					Channel: "stable",
					Status:  model.DistributionReleasePublished,
				}
				require.NoError(t, model.DB.Create(&release).Error)
				return release.ID
			},
			expected: ErrDistributionConflict,
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			app, _ := setupDistributionTest(t)
			releaseID := testCase.prepareRelease(t, app.ID)
			assert.ErrorIs(t, ValidateDistributionAssetUploadTarget(app.ID, releaseID), testCase.expected)
			source := &unreadDistributionAssetSource{}
			_, err := UploadDistributionAsset(
				app.ID,
				releaseID,
				"linux",
				"amd64",
				"installer.tar.gz",
				"application/gzip",
				source,
			)

			assert.ErrorIs(t, err, testCase.expected)
			assert.Zero(t, source.reads)
		})
	}
}

func TestPublicDistributionReleaseOrderingBreaksSemverTiesDeterministically(t *testing.T) {
	app, _ := setupDistributionTest(t)
	earlier := time.Date(2020, time.January, 1, 0, 0, 0, 0, time.UTC)
	later := earlier.Add(time.Hour)
	releases := []model.DistributionRelease{
		{AppID: app.ID, Version: "1.0.0+build.1", Channel: "stable", Status: model.DistributionReleasePublished, PublishedAt: &earlier},
		{AppID: app.ID, Version: "1.0.0+build.2", Channel: "stable", Status: model.DistributionReleasePublished, PublishedAt: &later},
		{AppID: app.ID, Version: "1.0.0+build.3", Channel: "stable", Status: model.DistributionReleasePublished, PublishedAt: &later},
	}
	require.NoError(t, model.DB.Create(&releases).Error)

	items, err := PublicDistributionReleases(app.ID, "stable")
	require.NoError(t, err)
	require.Len(t, items, 3)
	assert.Equal(t, []int64{releases[2].ID, releases[1].ID, releases[0].ID}, []int64{items[0].ID, items[1].ID, items[2].ID})
	latest, err := LatestPublicDistributionRelease(app.ID, "stable")
	require.NoError(t, err)
	assert.Equal(t, releases[2].ID, latest.ID)
}

func TestDistributionReleaseUniqueConstraintIsConflict(t *testing.T) {
	app, _ := setupDistributionTest(t)
	first, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "1.0.0", Channel: "stable"})
	require.NoError(t, err)

	err = model.DB.Create(&model.DistributionRelease{
		AppID:   app.ID,
		Version: first.Version,
		Channel: first.Channel,
		Status:  model.DistributionReleaseDraft,
	}).Error
	require.Error(t, err)
	assert.ErrorIs(t, distributionReleaseConflict(err), ErrDistributionConflict)

	second, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "1.0.1", Channel: "stable"})
	require.NoError(t, err)
	_, err = UpdateDistributionRelease(app.ID, second.ID, ReleaseInput{Version: "1.0.0", Channel: "stable"})
	assert.ErrorIs(t, err, ErrDistributionConflict)
}

func TestDistributionAssetsAllowMatchingSHA256AcrossReleases(t *testing.T) {
	app, _ := setupDistributionTest(t)
	first, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "1.0.0", Channel: "stable"})
	require.NoError(t, err)
	second, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "1.0.1", Channel: "stable"})
	require.NoError(t, err)

	firstAsset, err := UploadDistributionAsset(app.ID, first.ID, "linux", "amd64", "first.tar.gz", "application/gzip", bytes.NewBufferString("same installer"))
	require.NoError(t, err)
	secondAsset, err := UploadDistributionAsset(app.ID, second.ID, "linux", "amd64", "second.tar.gz", "application/gzip", bytes.NewBufferString("same installer"))
	require.NoError(t, err)
	assert.Equal(t, firstAsset.SHA256, secondAsset.SHA256)
}

func TestCopyDistributionAssetEnforcesByteLimit(t *testing.T) {
	temporary, err := os.CreateTemp(t.TempDir(), "asset-")
	require.NoError(t, err)

	size, _, err := copyDistributionAsset(bytes.NewBufferString("abc"), temporary, 2)
	assert.ErrorIs(t, err, ErrDistributionPayloadTooLarge)
	assert.Equal(t, int64(3), size)
	require.NoError(t, temporary.Close())
	content, err := os.ReadFile(temporary.Name())
	require.NoError(t, err)
	assert.Equal(t, "abc", string(content))

	size, checksum, err := copyDistributionAsset(bytes.NewBufferString("ab"), io.Discard, 2)
	require.NoError(t, err)
	assert.Equal(t, int64(2), size)
	assert.NotEmpty(t, checksum)
}

func TestDistributionPublishedResourcesRemainImmutable(t *testing.T) {
	app, root := setupDistributionTest(t)
	release, err := CreateDistributionRelease(app.ID, ReleaseInput{Version: "2.0.0", Channel: "stable"})
	require.NoError(t, err)
	_, err = UploadDistributionAsset(app.ID, release.ID, "linux", "amd64", "app.bin", "application/octet-stream", bytes.NewBufferString("release"))
	require.NoError(t, err)
	_, err = PublishDistributionRelease(app.ID, release.ID)
	require.NoError(t, err)

	_, err = UpdateDistributionRelease(app.ID, release.ID, ReleaseInput{Version: "2.0.1", Channel: "stable"})
	assert.ErrorIs(t, err, ErrDistributionConflict)
	_, err = UploadDistributionAsset(app.ID, release.ID, "linux", "arm64", "late.bin", "application/octet-stream", bytes.NewBufferString("late"))
	assert.ErrorIs(t, err, ErrDistributionConflict)
	files, err := os.ReadDir(root)
	require.NoError(t, err)
	assert.Len(t, files, 1)

	announcement, err := CreateDistributionAnnouncement(app.ID, AnnouncementInput{Title: "发布公告", Body: "内容"})
	require.NoError(t, err)
	_, err = SetDistributionAnnouncementStatus(app.ID, announcement.ID, model.DistributionAnnouncementDraft, model.DistributionAnnouncementPublished)
	require.NoError(t, err)
	_, err = UpdateDistributionAnnouncement(app.ID, announcement.ID, AnnouncementInput{Title: "篡改", Body: "内容"})
	assert.ErrorIs(t, err, ErrDistributionConflict)
}

func TestArchivePublishedDistributionAnnouncementRemovesPublicVisibility(t *testing.T) {
	app, _ := setupDistributionTest(t)
	announcement, err := CreateDistributionAnnouncement(app.ID, AnnouncementInput{Title: "维护", Body: "稍后重试"})
	require.NoError(t, err)
	_, err = SetDistributionAnnouncementStatus(app.ID, announcement.ID, model.DistributionAnnouncementDraft, model.DistributionAnnouncementPublished)
	require.NoError(t, err)

	_, err = SetDistributionAnnouncementStatus(app.ID, announcement.ID, model.DistributionAnnouncementPublished, model.DistributionAnnouncementArchived)
	require.NoError(t, err)
	items, err := PublicDistributionAnnouncements(app.ID, "", "", "")
	require.NoError(t, err)
	assert.Empty(t, items)
	_, err = PublicDistributionAnnouncement(app.ID, announcement.ID)
	assert.ErrorIs(t, err, ErrDistributionNotFound)
}
