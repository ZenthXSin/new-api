package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	groupavailability "github.com/QuantumNous/new-api/pkg/group_availability"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

func GetGroupAvailability(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	userID := c.GetInt("id")
	if userID <= 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "authentication required"})
		return
	}
	user, err := model.GetUserCache(userID)
	if err != nil || user == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "unable to verify group access"})
		return
	}
	if user.Status != common.UserStatusEnabled {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "account is unavailable"})
		return
	}
	rangeName := c.DefaultQuery("range", "24h")
	if rangeName != "90m" && rangeName != "24h" && rangeName != "7d" && rangeName != "30d" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "range must be 90m, 24h, 7d or 30d"})
		return
	}
	sortMode := c.DefaultQuery("sort", "name")
	if sortMode != "auto" && sortMode != "name" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "sort must be auto or name"})
		return
	}
	allowed := make(map[string]string)
	userGroups := user.GetGroups()
	// An empty/malformed membership must not invoke the helper's global default.
	if len(userGroups) > 0 {
		configured := ratio_setting.GetGroupRatioCopy()
		for group, description := range service.GetUserUsableGroupsByGroups(userGroups) {
			if _, exists := configured[group]; exists && group != "auto" && group != "" {
				allowed[group] = description
			}
		}
	}
	result, err := groupavailability.Default.QuerySorted(c.Request.Context(), rangeName, allowed, user.Role >= common.RoleAdminUser, sortMode == "auto")
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "group availability is temporarily unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": result})
}
