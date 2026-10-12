package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/tidwall/gjson"
)

const maxImageCapture = 64 * 1024 * 1024
const maxImageAsset = 32 * 1024 * 1024

// Preserve exact downstream bytes and streaming semantics; recognize output
// image fields rather than user-uploaded input images.
type ImageGenerationObserver struct {
	gin.ResponseWriter
	context    *gin.Context
	info       *relaycommon.RelayInfo
	job        *model.ImageGeneration
	buffer     []byte
	discarding bool
	images     []model.GeneratedImage
	seen       map[string]bool
	failed     bool
	cancel     context.CancelFunc
}

func imageRequestCount(request dto.Request, name string) (bool, int) {
	expected := 1
	known := false
	switch request := request.(type) {
	case *dto.ImageRequest:
		known = true
		if request.N != nil {
			expected = int(min(*request.N, uint(dto.MaxImageN)))
		}
	case *dto.OpenAIResponsesRequest:
		for _, tool := range request.GetToolsMap() {
			if tool["type"] == "image_generation" {
				known = true
			}
		}
	case *dto.GeminiChatRequest:
		for _, modality := range request.GenerationConfig.ResponseModalities {
			if strings.EqualFold(modality, "image") {
				known = true
			}
		}
	case *dto.GeneralOpenAIRequest:
		for _, modality := range gjson.ParseBytes(request.Modalities).Array() {
			if strings.EqualFold(modality.String(), "image") {
				known = true
			}
		}
	}
	lower := strings.ToLower(name)
	for _, marker := range []string{"dall-e", "gpt-image", "imagen", "flux", "stable-diffusion", "-image", "image-"} {
		if strings.Contains(lower, marker) {
			known = true
		}
	}
	return known, max(1, expected)
}

func ObserveImageGeneration(c *gin.Context, info *relaycommon.RelayInfo) *ImageGenerationObserver {
	switch info.RelayFormat {
	case types.RelayFormatOpenAIImage, types.RelayFormatOpenAI, types.RelayFormatOpenAIResponses, types.RelayFormatGemini, types.RelayFormatClaude:
	default:
		return nil
	}
	if model.DB == nil || info.UserId <= 0 {
		return nil
	}
	observer := &ImageGenerationObserver{ResponseWriter: c.Writer, context: c, info: info, seen: make(map[string]bool)}
	known, expected := imageRequestCount(info.Request, info.OriginModelName)
	if known {
		observer.begin(expected)
	}
	c.Writer = observer
	return observer
}

func (observer *ImageGenerationObserver) begin(expected int) {
	if observer.job != nil {
		return
	}
	now := time.Now().Unix()
	job := &model.ImageGeneration{
		ID: uuid.NewString(), UserID: observer.info.UserId, RequestID: observer.context.GetString(common.RequestIdKey),
		Model: observer.info.OriginModelName, Endpoint: observer.context.Request.URL.Path,
		Status: "connecting", ExpectedCount: expected, CreatedAt: now, UpdatedAt: now, Results: "[]",
	}
	if err := model.DB.Create(job).Error; err != nil {
		common.SysError("Could not record image generation")
		return
	}
	observer.job = job
	ctx, cancel := context.WithCancel(context.Background())
	observer.cancel = cancel
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = model.DB.Model(&model.ImageGeneration{}).Where("id = ? AND status IN ?", job.ID, []string{"connecting", "generating"}).
					Update("updated_at", time.Now().Unix()).Error
			}
		}
	}()
}

func (observer *ImageGenerationObserver) MarkGenerating() {
	if observer == nil || observer.job == nil || observer.job.Status == "generating" {
		return
	}
	observer.job.Status = "generating"
	observer.save()
}

func (observer *ImageGenerationObserver) save() {
	if observer.job == nil {
		return
	}
	raw, err := common.Marshal(observer.images)
	if err != nil {
		return
	}
	observer.job.Results = string(raw)
	observer.job.CompletedCount = len(observer.images)
	observer.job.ExpectedCount = max(observer.job.ExpectedCount, len(observer.images))
	observer.job.UpdatedAt = time.Now().Unix()
	if err = model.DB.Model(&model.ImageGeneration{}).Where("id = ?", observer.job.ID).Updates(map[string]any{
		"status": observer.job.Status, "completed_count": observer.job.CompletedCount, "expected_count": observer.job.ExpectedCount,
		"results": observer.job.Results, "updated_at": observer.job.UpdatedAt, "finished_at": observer.job.FinishedAt, "failure": observer.job.Failure,
	}).Error; err != nil {
		common.SysError("Could not update image generation")
	}
}

func (observer *ImageGenerationObserver) Write(data []byte) (int, error) {
	n, err := observer.ResponseWriter.Write(data)
	if n > 0 {
		observer.capture(data[:n])
	}
	if err != nil {
		observer.failed = true
	}
	return n, err
}

func (observer *ImageGenerationObserver) WriteString(data string) (int, error) {
	return observer.Write([]byte(data))
}

func (observer *ImageGenerationObserver) capture(data []byte) {
	if !strings.Contains(observer.Header().Get("Content-Type"), "text/event-stream") {
		if !observer.discarding && len(observer.buffer)+len(data) <= maxImageCapture {
			observer.buffer = append(observer.buffer, data...)
		} else {
			observer.buffer = nil
			observer.discarding = true
		}
		return
	}
	for len(data) > 0 {
		index := bytes.IndexByte(data, '\n')
		part := data
		if index >= 0 {
			part = data[:index]
		}
		if !observer.discarding {
			if len(observer.buffer)+len(part) > maxImageCapture {
				observer.buffer = nil
				observer.discarding = true
			} else {
				observer.buffer = append(observer.buffer, part...)
			}
		}
		if index < 0 {
			break
		}
		if !observer.discarding {
			line := bytes.TrimSpace(observer.buffer)
			if bytes.HasPrefix(line, []byte("data:")) {
				observer.observe(bytes.TrimSpace(line[5:]))
			}
		}
		observer.buffer = nil
		observer.discarding = false
		data = data[index+1:]
	}
}

func (observer *ImageGenerationObserver) observe(data []byte) {
	// Most relay traffic is text. Skip JSON parsing for ordinary token events.
	if !bytes.Contains(data, []byte("image")) && !bytes.Contains(data, []byte("inlineData")) && !bytes.Contains(data, []byte("inline_data")) && !bytes.Contains(data, []byte("b64_json")) && !bytes.Contains(data, []byte("\"url\"")) && !bytes.Contains(data, []byte("\"error\"")) && !bytes.Contains(data, []byte("response.failed")) {
		return
	}
	if !gjson.ValidBytes(data) {
		return
	}
	root := gjson.ParseBytes(data)
	if root.IsArray() {
		for _, frame := range root.Array() {
			observer.observe([]byte(frame.Raw))
		}
		return
	}
	event := root.Get("type").String()
	if event == "error" || event == "response.failed" || root.Get("error").Exists() {
		observer.failed = true
		return
	}
	if strings.Contains(event, "image_generation") || strings.HasPrefix(event, "image_edit.") {
		observer.begin(1)
		observer.MarkGenerating()
	}
	switch event {
	case "image_generation.partial_image", "image_edit.partial_image", "response.image_generation_call.partial_image":
		return
	}
	before := len(observer.images)
	for index, item := range root.Get("data").Array() {
		observer.addImage(item.Get("url").String(), item.Get("b64_json").String(), fmt.Sprintf("images/%d", index))
	}
	if event == "image_generation.completed" || event == "image_edit.completed" {
		observer.addImage(root.Get("url").String(), root.Get("b64_json").String(), "images/"+root.Get("image_index").String())
	}
	observer.responsesImages(root)
	for candidateIndex, candidate := range root.Get("candidates").Array() {
		for partIndex, part := range candidate.Get("content.parts").Array() {
			inline := part.Get("inlineData")
			if !inline.Exists() {
				inline = part.Get("inline_data")
			}
			mime := inline.Get("mimeType").String()
			if mime == "" {
				mime = inline.Get("mime_type").String()
			}
			if strings.HasPrefix(mime, "image/") {
				observer.addImage("", inline.Get("data").String(), fmt.Sprintf("gemini/%d/%d", candidateIndex, partIndex))
			}
		}
	}
	for choiceIndex, choice := range root.Get("choices").Array() {
		for _, key := range []string{"message", "delta"} {
			message := choice.Get(key)
			for index, image := range message.Get("images").Array() {
				observer.addImage(image.Get("image_url.url").String(), image.Get("b64_json").String(), fmt.Sprintf("chat/%d/%d", choiceIndex, index))
			}
			for index, part := range message.Get("content").Array() {
				if part.Get("type").String() == "image_url" || part.Get("type").String() == "output_image" {
					observer.addImage(part.Get("image_url.url").String(), part.Get("b64_json").String(), fmt.Sprintf("chat/%d/content/%d", choiceIndex, index))
				}
			}
		}
	}
	blocks := root.Get("content").Array()
	if root.Get("content_block.type").String() == "image" {
		blocks = append(blocks, root.Get("content_block"))
	}
	for index, block := range blocks {
		if block.Get("type").String() == "image" && strings.HasPrefix(block.Get("source.media_type").String(), "image/") {
			observer.addImage(block.Get("source.url").String(), block.Get("source.data").String(), fmt.Sprintf("claude/%d", index))
		}
	}
	if len(observer.images) != before {
		observer.MarkGenerating()
		observer.save()
	}
}

func (observer *ImageGenerationObserver) responsesImages(root gjson.Result) {
	items := root.Get("output").Array()
	items = append(items, root.Get("response.output").Array()...)
	if item := root.Get("item"); item.Exists() {
		items = append(items, item)
	}
	for index, item := range items {
		if item.Get("type").String() == "image_generation_call" && item.Get("status").String() == "completed" {
			identity := item.Get("id").String()
			if identity == "" {
				identity = fmt.Sprintf("%d", index)
			}
			observer.addImage("", item.Get("result").String(), "responses/"+identity)
		}
	}
}

func ImageGenerationStorage() string {
	return common.GetEnvOrDefaultString("IMAGE_TASK_STORAGE_DIR", "./image-tasks")
}

func (observer *ImageGenerationObserver) addImage(address, encoded, identity string) {
	if len(observer.images) >= dto.MaxImageN {
		return
	}
	if strings.HasPrefix(address, "data:image/") {
		if comma := strings.Index(address, ","); comma > 0 && strings.HasSuffix(address[:comma], ";base64") {
			encoded = address[comma+1:]
			address = ""
		} else {
			return
		}
	}
	image := model.GeneratedImage{}
	var content []byte
	if address != "" {
		parsed, err := url.Parse(address)
		if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || len(address) > 8192 {
			return
		}
		image.URL = address
	} else if encoded != "" && len(encoded) <= (maxImageAsset+2)/3*4 {
		var err error
		content, err = base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(content) > maxImageAsset {
			return
		}
		image.Mime = http.DetectContentType(content)
		switch image.Mime {
		case "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif":
		default:
			return
		}
	} else {
		return
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte(image.URL))
	_, _ = digest.Write(content)
	key := hex.EncodeToString(digest.Sum(nil))
	occurrence := identity + "/" + key
	if observer.seen[occurrence] {
		return
	}
	observer.begin(1)
	if observer.job == nil {
		return
	}
	if content != nil {
		image.Asset = key
		directory := filepath.Join(ImageGenerationStorage(), observer.job.ID)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return
		}
		if err := os.WriteFile(filepath.Join(directory, key), content, 0o600); err != nil {
			return
		}
	}
	observer.seen[occurrence] = true
	observer.images = append(observer.images, image)
}

func (observer *ImageGenerationObserver) Finish(relayError *types.NewAPIError) {
	if observer == nil {
		return
	}
	defer func() {
		if observer.cancel != nil {
			observer.cancel()
		}
		observer.context.Writer = observer.ResponseWriter
	}()
	if !strings.Contains(observer.Header().Get("Content-Type"), "text/event-stream") {
		observer.observe(observer.buffer)
	}
	if strings.Contains(observer.Header().Get("Content-Type"), "text/event-stream") && !observer.discarding {
		line := bytes.TrimSpace(observer.buffer)
		if bytes.HasPrefix(line, []byte("data:")) {
			observer.observe(bytes.TrimSpace(line[5:]))
		}
	}
	observer.buffer = nil
	if observer.job == nil {
		return
	}
	observer.job.Status = "completed"
	if len(observer.images) == 0 {
		observer.job.Status = "no_output"
	}
	if relayError != nil || observer.failed || observer.Status() >= 400 {
		observer.job.Status = "failed"
		observer.job.Failure = "Image generation failed."
	} else if observer.context.Request.Context().Err() != nil {
		observer.job.Status = "interrupted"
		observer.job.Failure = "Image generation was interrupted."
	}
	observer.job.FinishedAt = time.Now().Unix()
	observer.save()
}

func ImageGenerationAsset(job *model.ImageGeneration, index int) (string, string, error) {
	images := job.Images()
	if index < 0 || index >= len(images) || len(images[index].Asset) != 64 {
		return "", "", fmt.Errorf("image preview not found")
	}
	if _, err := uuid.Parse(job.ID); err != nil {
		return "", "", err
	}
	if _, err := hex.DecodeString(images[index].Asset); err != nil {
		return "", "", err
	}
	return filepath.Join(ImageGenerationStorage(), job.ID, images[index].Asset), images[index].Mime, nil
}
