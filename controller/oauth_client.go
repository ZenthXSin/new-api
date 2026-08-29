package controller

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

type oauthClientPayload struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	RedirectUris []string `json:"redirect_uris"`
	Scopes       []string `json:"scopes"`
	IsPublic     bool     `json:"is_public"`
	Enabled      bool     `json:"enabled"`
}

func buildOauthClientModel(payload oauthClientPayload, createdBy int) (*model.OauthClient, error) {
	client := &model.OauthClient{
		Name:        strings.TrimSpace(payload.Name),
		Description: strings.TrimSpace(payload.Description),
		Scopes:      strings.Join(payload.Scopes, " "),
		IsPublic:    payload.IsPublic,
		Enabled:     payload.Enabled,
		CreatedBy:   createdBy,
	}
	if client.Scopes == "" {
		client.Scopes = "openid profile email"
	}
	if err := client.SetRedirectUris(payload.RedirectUris); err != nil {
		return nil, err
	}
	return client, nil
}

func oauthClientResponse(client *model.OauthClient) gin.H {
	return gin.H{
		"id":            client.Id,
		"client_id":     client.ClientId,
		"name":          client.Name,
		"description":   client.Description,
		"redirect_uris": client.GetRedirectUris(),
		"scopes":        client.GetScopes(),
		"is_public":     client.IsPublic,
		"enabled":       client.Enabled,
		"last_used_at":  client.LastUsedAt,
		"created_time":  client.CreatedTime,
	}
}

// GetOauthClients lists every registered OIDC client.
func GetOauthClients(c *gin.Context) {
	clients, err := model.GetOauthClients()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items := make([]gin.H, 0, len(clients))
	for _, client := range clients {
		items = append(items, oauthClientResponse(client))
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    items,
	})
}

// CreateOauthClient registers a client and returns the plaintext secret once.
func CreateOauthClient(c *gin.Context) {
	var payload oauthClientPayload
	if err := common.DecodeJson(c.Request.Body, &payload); err != nil {
		common.ApiError(c, err)
		return
	}
	client, err := buildOauthClientModel(payload, c.GetInt("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	secret := ""
	if !client.IsPublic {
		secret, err = client.GenerateOauthClientSecret()
		if err != nil {
			common.ApiError(c, err)
			return
		}
	}
	if err := model.CreateOauthClient(client); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, client.Id, "oauth_client.create", map[string]interface{}{
		"client_id": client.ClientId,
		"name":      client.Name,
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"client": oauthClientResponse(client),
			// Only ever returned here; the database stores an HMAC.
			"client_secret": secret,
		},
	})
}

// UpdateOauthClient updates editable fields without touching the secret.
func UpdateOauthClient(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiError(c, errors.New("invalid client id"))
		return
	}
	var payload oauthClientPayload
	if err := common.DecodeJson(c.Request.Body, &payload); err != nil {
		common.ApiError(c, err)
		return
	}
	client, err := model.GetOauthClientById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	updated, err := buildOauthClientModel(payload, client.CreatedBy)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	updated.Id = client.Id
	updated.ClientId = client.ClientId
	updated.ClientSecret = client.ClientSecret
	if err := model.UpdateOauthClient(updated); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, client.Id, "oauth_client.update", map[string]interface{}{
		"client_id": client.ClientId,
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    oauthClientResponse(updated),
	})
}

// DeleteOauthClient removes a client and its recorded consents.
func DeleteOauthClient(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiError(c, errors.New("invalid client id"))
		return
	}
	client, err := model.GetOauthClientById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.DeleteOauthClient(id); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, client.Id, "oauth_client.delete", map[string]interface{}{
		"client_id": client.ClientId,
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
}

// ResetOauthClientSecret rotates the client secret and returns it once.
func ResetOauthClientSecret(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiError(c, errors.New("invalid client id"))
		return
	}
	client, err := model.GetOauthClientById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if client.IsPublic {
		common.ApiError(c, errors.New("public clients do not have a secret"))
		return
	}
	secret, err := client.GenerateOauthClientSecret()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.DB.Model(&model.OauthClient{}).Where("id = ?", client.Id).
		Update("client_secret", client.ClientSecret).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, client.Id, "oauth_client.reset_secret", map[string]interface{}{
		"client_id": client.ClientId,
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"client_secret": secret,
		},
	})
}
