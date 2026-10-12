package model

import (
	"errors"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

var ErrCodexGitHubChanged = errors.New("GitHub connection changed; begin authorization again")

// CodexGitHubConnection is separate from the site's GitHub login identity.
// Generation is retained after disconnect so an older in-flight request cannot
// restore a revoked credential in the runner. Only encrypted tokens are stored.
type CodexGitHubConnection struct {
	UserID          int    `json:"-" gorm:"primaryKey;autoIncrement:false"`
	GitHubID        int64  `json:"-" gorm:"column:github_id"`
	ClientID        string `json:"-" gorm:"type:varchar(256)"`
	Login           string `json:"login" gorm:"type:varchar(128)"`
	AvatarURL       string `json:"avatarUrl" gorm:"type:varchar(512)"`
	Scopes          string `json:"-" gorm:"type:varchar(1024)"`
	TokenCiphertext string `json:"-" gorm:"type:text"`
	Generation      int64  `json:"-"`
	ConnectedAt     int64  `json:"connectedAt"`
	RevokedAt       int64  `json:"-"`
	UpdatedAt       int64  `json:"-"`
}

func GetCodexGitHubConnection(userID int) (*CodexGitHubConnection, error) {
	var connection CodexGitHubConnection
	err := DB.Where("user_id = ?", userID).First(&connection).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &CodexGitHubConnection{UserID: userID}, nil
	}
	return &connection, err
}

func (connection *CodexGitHubConnection) Token() (string, error) {
	if connection.TokenCiphertext == "" {
		return "", nil
	}
	return common.DecryptSecret(connection.TokenCiphertext, fmt.Sprintf("codex-github:%d", connection.UserID))
}

func SaveCodexGitHubConnection(connection *CodexGitHubConnection, token string, expectedGeneration, expectedAuthVersion int64) error {
	ciphertext, err := common.EncryptSecret(token, fmt.Sprintf("codex-github:%d", connection.UserID))
	if err != nil {
		return err
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		// Lock an existing owner row to serialize first-time connection creation
		// as well as reconnect/disconnect on all supported database engines.
		var owner User
		if err := lockForUpdate(tx).Select("id", "auth_version", "status", "role").Where("id = ?", connection.UserID).First(&owner).Error; err != nil {
			return err
		}
		if owner.AuthVersion != expectedAuthVersion || owner.Status != common.UserStatusEnabled {
			return ErrCodexGitHubChanged
		}
		policy, err := GetEffectiveCodexUserPolicyWithDB(tx, connection.UserID)
		if err != nil {
			return err
		}
		if !policy.Enabled {
			return ErrCodexGitHubChanged
		}
		var previous CodexGitHubConnection
		err = tx.Where("user_id = ?", connection.UserID).First(&previous).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if previous.Generation != expectedGeneration || previous.RevokedAt > 0 && previous.TokenCiphertext != "" {
			return ErrCodexGitHubChanged
		}
		connection.TokenCiphertext = ciphertext
		connection.Generation = previous.Generation + 1
		connection.ConnectedAt = time.Now().Unix()
		connection.UpdatedAt = connection.ConnectedAt
		connection.RevokedAt = 0
		return tx.Save(connection).Error
	})
}

// DisconnectCodexGitHubConnection disables delivery immediately, keeping the
// encrypted token solely for retrying a failed upstream revocation.
func DisconnectCodexGitHubConnection(userID int) (*CodexGitHubConnection, error) {
	var connection CodexGitHubConnection
	err := DB.Transaction(func(tx *gorm.DB) error {
		var owner User
		if err := lockForUpdate(tx).Select("id").Where("id = ?", userID).First(&owner).Error; err != nil {
			return err
		}
		err := tx.Where("user_id = ?", userID).First(&connection).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		connection.UserID = userID
		connection.Generation++
		connection.RevokedAt = time.Now().Unix()
		connection.UpdatedAt = connection.RevokedAt
		return tx.Save(&connection).Error
	})
	return &connection, err
}

func CompleteCodexGitHubRevocation(userID int, generation int64) error {
	return DB.Model(&CodexGitHubConnection{}).Where("user_id = ? AND generation = ? AND revoked_at > 0", userID, generation).
		Updates(map[string]interface{}{"token_ciphertext": "", "login": "", "avatar_url": "", "scopes": "", "github_id": 0}).Error
}
