package controller

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestImageGenerationDashboardRequiresAuthenticationAndScopesListsAndAssets(t *testing.T) {
	f := newCodexProxyFixture(t)
	request := func(target, token string) *httptest.ResponseRecorder {
		req, response := f.request(http.MethodGet, target, token, nil)
		f.engine.ServeHTTP(response, req)
		return response
	}
	require.NoError(t, model.DB.AutoMigrate(&model.ImageGeneration{}, &model.Midjourney{}))
	t.Setenv("IMAGE_TASK_STORAGE_DIR", t.TempDir())
	group := f.engine.Group("/api/image-tasks", middleware.UserAuth())
	group.GET("", GetImageGenerations)
	group.GET("/:id/images/:index", GetImageGenerationPreview)
	var user model.User
	require.NoError(t, model.DB.Where("role = ?", common.RoleCommonUser).First(&user).Error)
	job := model.ImageGeneration{ID: uuid.NewString(), UserID: user.Id, Status: "completed", Model: "gpt-image", ExpectedCount: 1, CompletedCount: 1, CreatedAt: time.Now().Unix(), UpdatedAt: time.Now().Unix(), Results: `[{"asset":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mime":"image/png"}]`}
	require.NoError(t, model.DB.Create(&job).Error)
	foreign := model.ImageGeneration{ID: uuid.NewString(), UserID: f.adminID, Status: "generating", Model: "foreign-model", ExpectedCount: 3, UpdatedAt: time.Now().Unix()}
	require.NoError(t, model.DB.Create(&foreign).Error)
	file, _, err := service.ImageGenerationAsset(&job, 0)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(file), 0700))
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(file, png, 0600))
	anonymous := request("/api/image-tasks", "")
	assert.Equal(t, http.StatusUnauthorized, anonymous.Code)
	own := request("/api/image-tasks?scope=all", f.commonToken)
	assert.Equal(t, http.StatusOK, own.Code)
	assert.Contains(t, own.Body.String(), job.ID)
	assert.NotContains(t, own.Body.String(), foreign.ID)
	assert.NotContains(t, own.Body.String(), "aaaaaaaa")
	admin := request("/api/image-tasks?scope=all", f.adminToken)
	assert.Contains(t, admin.Body.String(), foreign.ID)
	selfAdmin := request("/api/image-tasks?scope=self", f.adminToken)
	assert.NotContains(t, selfAdmin.Body.String(), job.ID)
	preview := request("/api/image-tasks/"+job.ID+"/images/0", f.commonToken)
	assert.Equal(t, http.StatusOK, preview.Code)
	assert.Equal(t, png, preview.Body.Bytes())
	assert.Equal(t, "image/png", preview.Header().Get("Content-Type"))
	assert.Contains(t, preview.Header().Get("Cache-Control"), "private")
	denied := request("/api/image-tasks/"+foreign.ID+"/images/0", f.commonToken)
	assert.Equal(t, http.StatusNotFound, denied.Code)
	require.NoError(t, os.Remove(file))
	require.NoError(t, os.Symlink("/etc/passwd", file))
	unsafe := request("/api/image-tasks/"+job.ID+"/images/0", f.commonToken)
	assert.Equal(t, http.StatusNotFound, unsafe.Code)
}
