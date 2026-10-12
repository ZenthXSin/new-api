package controller

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func codexConfigTarget(c *gin.Context) (int, bool) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "用户ID无效"})
		return 0, false
	}
	user, err := model.GetUserById(id, false)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "用户不存在"})
		return 0, false
	}
	if !canManageTargetRole(c.GetInt("role"), user.Role) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权配置同级或更高权限用户"})
		return 0, false
	}
	return id, true
}

func writeCodexConfig(c *gin.Context, id int) {
	config, err := model.GetCodexUserConfig(id)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "无法读取Codex配置"})
		return
	}
	policy, err := model.GetEffectiveCodexUserPolicy(id)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "无法读取Codex权限"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"config": config, "effective": policy}})
}

func GetSelfCodexConfig(c *gin.Context) { writeCodexConfig(c, c.GetInt("id")) }
func GetUserCodexConfig(c *gin.Context) {
	if id, ok := codexConfigTarget(c); ok {
		writeCodexConfig(c, id)
	}
}
func UpdateUserCodexConfig(c *gin.Context) {
	id, ok := codexConfigTarget(c)
	if !ok {
		return
	}
	var config model.CodexUserConfig
	if err := c.ShouldBindJSON(&config); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "配置格式无效"})
		return
	}
	config.UserID = id
	if err := model.SaveCodexUserConfig(&config); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	writeCodexConfig(c, id)
}

func ListCodexAdminUsers(c *gin.Context) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 || page > 100000 {
		c.JSON(400, gin.H{"success": false, "message": "页码无效"})
		return
	}
	size, err := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
	if err != nil || size < 1 || size > 100 {
		c.JSON(400, gin.H{"success": false, "message": "分页大小无效"})
		return
	}
	keyword := strings.TrimSpace(c.Query("keyword"))
	if len(keyword) > 128 {
		c.JSON(400, gin.H{"success": false, "message": "搜索内容过长"})
		return
	}
	users, total, err := model.ListCodexAdminUsers(keyword, page, size, c.GetInt("role"))
	if err != nil {
		c.JSON(503, gin.H{"success": false, "message": "无法读取 Codex 用户"})
		return
	}
	c.JSON(200, gin.H{"success": true, "data": gin.H{"items": users, "total": total, "page": page, "pageSize": size}})
}
