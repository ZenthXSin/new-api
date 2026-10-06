package controller

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// GetOAuthGrants lists authorizations owned by the current dashboard account.
func GetOAuthGrants(c *gin.Context) {
	oidcNoStore(c)
	identity, ok := requireBrowserSession(c)
	if !ok {
		return
	}
	grants, err := service.ListOAuthGrants(identity.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "unable to load authorizations"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": grants})
}

// PatchOAuthGrant narrows an existing snapshot. Expanding scope always requires
// a new authorization-code consent, even for the owner of the authorization.
func PatchOAuthGrant(c *gin.Context) {
	oidcNoStore(c)
	identity, ok := requireBrowserSession(c)
	if !ok {
		return
	}
	grantID, err := strconv.Atoi(c.Param("id"))
	if err != nil || grantID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid authorization id"})
		return
	}
	var request struct {
		Scopes []string `json:"scopes"`
	}
	if err := common.DecodeJsonStrict(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10), &request); err != nil || len(request.Scopes) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "at least one scope is required"})
		return
	}
	if err := service.NarrowOAuthGrant(identity.UserID, grantID, request.Scopes); err != nil {
		if errors.Is(err, model.ErrOAuthScopeExpansion) || errors.Is(err, service.ErrOidcScopeNotRequested) {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "authorization scopes cannot be expanded"})
		} else {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "authorization is unavailable"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func DeleteOAuthGrant(c *gin.Context) {
	oidcNoStore(c)
	identity, ok := requireBrowserSession(c)
	if !ok {
		return
	}
	grantID, err := strconv.Atoi(c.Param("id"))
	if err != nil || grantID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid authorization id"})
		return
	}
	if err := service.RevokeOAuthGrant(identity.UserID, grantID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "authorization is unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
