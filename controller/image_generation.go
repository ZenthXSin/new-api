package controller

import (
	"net/http"
	"os"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func GetImageGenerations(c *gin.Context) {
	page := common.GetPageQuery(c)
	all := c.GetInt("role") >= 10 && c.Query("scope") == "all"
	if err := model.ExpireImageGenerations(); err != nil {
		common.ApiErrorMsg(c, "Could not load image tasks")
		return
	}
	items, total, counts, err := model.ListImageGenerations(c.GetInt("id"), all, page.GetStartIdx(), min(page.GetPageSize(), 100))
	if err != nil {
		common.ApiErrorMsg(c, "Could not load image tasks")
		return
	}
	results := make([]gin.H, 0, len(items))
	for _, job := range items {
		images := make([]gin.H, 0)
		for index, image := range job.Images() {
			address := image.URL
			if image.Asset != "" {
				address = "/api/image-tasks/" + job.ID + "/images/" + strconv.Itoa(index)
			}
			images = append(images, gin.H{"id": job.ID + ":" + strconv.Itoa(index), "url": address, "local": image.Asset != "", "mime": image.Mime})
		}
		results = append(results, gin.H{
			"id": job.ID, "request_id": job.RequestID, "model": job.Model, "endpoint": job.Endpoint,
			"status": job.Status, "expected_count": job.ExpectedCount, "completed_count": job.CompletedCount,
			"created_at": job.CreatedAt, "finished_at": job.FinishedAt, "failure": job.Failure, "images": images,
		})
	}
	common.ApiSuccess(c, gin.H{"items": results, "total": total, "counts": counts})
}

func GetImageGenerationPreview(c *gin.Context) {
	if _, err := uuid.Parse(c.Param("id")); err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	index, err := strconv.Atoi(c.Param("index"))
	if err != nil || index < 0 {
		c.Status(http.StatusNotFound)
		return
	}
	var job model.ImageGeneration
	query := model.DB.Where("id = ?", c.Param("id"))
	if c.GetInt("role") < 10 {
		query = query.Where("user_id = ?", c.GetInt("id"))
	}
	if err = query.First(&job).Error; err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	file, mime, err := service.ImageGenerationAsset(&job, index)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Content-Type", mime)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, max-age=3600")
	c.File(file)
}
