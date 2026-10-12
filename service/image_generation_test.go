package service

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const imageFixturePNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="

func imageObserverFixture(t *testing.T, format types.RelayFormat, request dto.Request, name, contentType string) (*gin.Context, *httptest.ResponseRecorder, *ImageGenerationObserver) {
	t.Helper()
	previous := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sql, err := db.DB()
	require.NoError(t, err)
	sql.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.ImageGeneration{}, &model.Midjourney{}))
	model.DB = db
	t.Setenv("IMAGE_TASK_STORAGE_DIR", t.TempDir())
	t.Cleanup(func() { model.DB = previous; require.NoError(t, sql.Close()) })
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
	c.Writer.Header().Set("Content-Type", contentType)
	observer := ObserveImageGeneration(c, &relaycommon.RelayInfo{UserId: 7, OriginModelName: name, RelayFormat: format, Request: request})
	require.NotNil(t, observer)
	return c, recorder, observer
}

func TestImageGenerationBatchKeepsResponseBytesAndCountsIdenticalImages(t *testing.T) {
	c, recorder, observer := imageObserverFixture(t, types.RelayFormatOpenAIImage, &dto.ImageRequest{N: common.GetPointer(uint(2))}, "gpt-image", "application/json")
	_, _, counts, err := model.ListImageGenerations(7, false, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 2, counts.Connecting)
	body := fmt.Sprintf("{\"data\":[{\"b64_json\":%q},{\"b64_json\":%q}]}", imageFixturePNG, imageFixturePNG)
	_, err = c.Writer.WriteString(body)
	require.NoError(t, err)
	observer.Finish(nil)
	assert.Equal(t, body, recorder.Body.String())
	jobs, _, counts, err := model.ListImageGenerations(7, false, 0, 10)
	require.NoError(t, err)
	require.Len(t, jobs, 1)
	assert.Equal(t, "completed", jobs[0].Status)
	assert.Equal(t, 2, jobs[0].CompletedCount)
	assert.Zero(t, counts.Requests)
	file, mime, err := ImageGenerationAsset(&jobs[0], 1)
	require.NoError(t, err)
	assert.Equal(t, "image/png", mime)
	data, err := os.ReadFile(file)
	require.NoError(t, err)
	want, err := base64.StdEncoding.DecodeString(imageFixturePNG)
	require.NoError(t, err)
	assert.Equal(t, want, data)
	assert.NotContains(t, jobs[0].Results, imageFixturePNG)
}

func TestImageGenerationStreamsDetectUnknownModelDeduplicateCompletedResponseAndIgnorePartial(t *testing.T) {
	c, recorder, observer := imageObserverFixture(t, types.RelayFormatOpenAIResponses, &dto.OpenAIResponsesRequest{}, "custom-visual-model", "text/event-stream")
	partial := "data: {\"type\":\"response.image_generation_call.partial_image\",\"partial_image_b64\":\"" + imageFixturePNG + "\"}\n\n"
	_, err := c.Writer.WriteString(partial)
	require.NoError(t, err)
	jobs, _, counts, err := model.ListImageGenerations(7, false, 0, 10)
	require.NoError(t, err)
	require.Len(t, jobs, 1)
	assert.Zero(t, jobs[0].CompletedCount)
	assert.EqualValues(t, 1, counts.Generating)
	item := fmt.Sprintf("{\"type\":\"image_generation_call\",\"id\":\"ig_1\",\"status\":\"completed\",\"result\":%q}", imageFixturePNG)
	body := "data: {\"type\":\"response.output_item.done\",\"item\":" + item + "}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[" + item + "]}}\n\ndata: [DONE]"
	// HTTP writes need not align with SSE lines or base64 payloads.
	for _, piece := range []string{body[:17], body[17:43], body[43:]} {
		_, err = c.Writer.WriteString(piece)
		require.NoError(t, err)
	}
	observer.Finish(nil)
	assert.Equal(t, partial+body, recorder.Body.String())
	jobs, _, counts, err = model.ListImageGenerations(7, false, 0, 10)
	require.NoError(t, err)
	require.Len(t, jobs, 1)
	assert.Equal(t, 1, jobs[0].CompletedCount)
	assert.Equal(t, "completed", jobs[0].Status)
	assert.Zero(t, counts.Requests)
}

func TestImageGenerationRecognizesProviderOutputsAndNeverRecordsInputImages(t *testing.T) {
	for _, entry := range []struct {
		name   string
		format types.RelayFormat
		body   string
		count  int
	}{
		{"Gemini", types.RelayFormatGemini, fmt.Sprintf("{\"candidates\":[{\"content\":{\"parts\":[{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":%q}}]}}]}", imageFixturePNG), 1},
		{"GeminiArray", types.RelayFormatGemini, fmt.Sprintf("[{\"candidates\":[{\"content\":{\"parts\":[{\"inline_data\":{\"mime_type\":\"image/png\",\"data\":%q}}]}}]}]", imageFixturePNG), 1},
		{"ChatImage", types.RelayFormatOpenAI, "{\"choices\":[{\"message\":{\"images\":[{\"image_url\":{\"url\":\"https://images.example/result.png\"}}]}}]}", 1},
		{"ClaudeImage", types.RelayFormatClaude, fmt.Sprintf("{\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":%q}}]}", imageFixturePNG), 1},
		{"InputEcho", types.RelayFormatOpenAIResponses, "{\"input\":[{\"type\":\"input_image\",\"image_url\":\"https://images.example/input.png\"}],\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"image analysis\"}]}]}", 0},
		{"Text", types.RelayFormatOpenAI, "{\"choices\":[{\"message\":{\"content\":\"The image is blue.\"}}]}", 0},
	} {
		t.Run(entry.name, func(t *testing.T) {
			c, recorder, observer := imageObserverFixture(t, entry.format, &dto.GeneralOpenAIRequest{}, "custom-model", "application/json")
			_, err := c.Writer.WriteString(entry.body)
			require.NoError(t, err)
			observer.Finish(nil)
			assert.Equal(t, entry.body, recorder.Body.String())
			jobs, total, _, err := model.ListImageGenerations(7, false, 0, 10)
			require.NoError(t, err)
			if entry.count == 0 {
				assert.Zero(t, total)
				return
			}
			require.Len(t, jobs, 1)
			assert.Equal(t, entry.count, jobs[0].CompletedCount)
		})
	}
}

func TestImageGenerationFailedAndDisconnectedRequestsClearActiveCounts(t *testing.T) {
	for _, failed := range []bool{true, false} {
		t.Run(fmt.Sprint(failed), func(t *testing.T) {
			c, _, observer := imageObserverFixture(t, types.RelayFormatOpenAIImage, &dto.ImageRequest{}, "gpt-image", "application/json")
			if failed {
				_, err := c.Writer.WriteString("{\"error\":{\"message\":\"upstream private diagnostic\"}}")
				require.NoError(t, err)
			} else {
				ctx, cancel := context.WithCancel(c.Request.Context())
				c.Request = c.Request.WithContext(ctx)
				cancel()
			}
			observer.Finish(nil)
			jobs, _, counts, err := model.ListImageGenerations(7, false, 0, 10)
			require.NoError(t, err)
			require.Len(t, jobs, 1)
			want := "interrupted"
			if failed {
				want = "failed"
			}
			assert.Equal(t, want, jobs[0].Status)
			assert.Zero(t, counts.Requests)
			assert.NotContains(t, jobs[0].Failure, "private diagnostic")
		})
	}
}

func TestImageGenerationOwnerFilteringAndExpiredRequests(t *testing.T) {
	_, _, observer := imageObserverFixture(t, types.RelayFormatOpenAIImage, &dto.ImageRequest{}, "gpt-image", "application/json")
	observer.Finish(nil)
	now := time.Now().Unix()
	for _, job := range []model.ImageGeneration{
		{ID: "active", UserID: 7, Status: "generating", ExpectedCount: 3, CompletedCount: 1, UpdatedAt: now},
		{ID: "stale", UserID: 7, Status: "connecting", ExpectedCount: 5, UpdatedAt: now - 300},
		{ID: "foreign", UserID: 8, Status: "connecting", ExpectedCount: 4, UpdatedAt: now},
	} {
		require.NoError(t, model.DB.Create(&job).Error)
	}
	require.NoError(t, model.ExpireImageGenerations())
	jobs, total, counts, err := model.ListImageGenerations(7, false, 0, 20)
	require.NoError(t, err)
	assert.EqualValues(t, 3, total)
	assert.EqualValues(t, 2, counts.Generating)
	assert.Zero(t, counts.Connecting)
	for _, job := range jobs {
		assert.Equal(t, 7, job.UserID)
		if job.ID == "stale" {
			assert.Equal(t, "interrupted", job.Status)
		}
	}
	_, total, counts, err = model.ListImageGenerations(7, true, 0, 20)
	require.NoError(t, err)
	assert.EqualValues(t, 4, total)
	assert.EqualValues(t, 4, counts.Connecting)
}

func TestImageGenerationRejectsNonImagePayloadAndUnsafeURL(t *testing.T) {
	c, _, observer := imageObserverFixture(t, types.RelayFormatOpenAIImage, &dto.ImageRequest{}, "gpt-image", "application/json")
	body := fmt.Sprintf("{\"data\":[{\"url\":\"javascript:alert(1)\"},{\"url\":\"https://user:pass@example.com/image\"},{\"b64_json\":%q}]}", base64.StdEncoding.EncodeToString([]byte("<svg onload='bad'>")))
	_, err := c.Writer.WriteString(body)
	require.NoError(t, err)
	observer.Finish(nil)
	jobs, _, _, err := model.ListImageGenerations(7, false, 0, 10)
	require.NoError(t, err)
	require.Len(t, jobs, 1)
	assert.Equal(t, "no_output", jobs[0].Status)
	assert.Empty(t, jobs[0].Images())
	assert.False(t, strings.Contains(jobs[0].Results, "pass"))
}
