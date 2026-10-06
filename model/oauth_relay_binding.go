package model

import (
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// OAuthRelayBinding retains one accounting identity for each authorization.
// Revoking an authorization never deletes its accounting token: accepted async
// tasks still need the same token ID for later settlement and refunds.
type OAuthRelayBinding struct {
	GrantID int `gorm:"primaryKey;autoIncrement:false"`
	UserID  int `gorm:"not null;index"`
	TokenID int `gorm:"not null;uniqueIndex"`
}

func (OAuthRelayBinding) TableName() string { return "oauth_relay_bindings" }

// GetOrCreateOAuthRelayToken does not grant quota. UnlimitedQuota means there
// is no extra token-level spending ceiling; the existing wallet/subscription
// funding checks and pre-consumption remain mandatory on every request.
func GetOrCreateOAuthRelayToken(grantID, userID int, grantVersion int64) (*Token, error) {
	var token Token
	if grantID <= 0 || userID <= 0 || grantVersion <= 0 {
		return nil, ErrOAuthGrantInvalid
	}
	// Existing identities use a read query without serializing all concurrent
	// requests on the grant row. Only first creation needs the write lock.
	var binding OAuthRelayBinding
	lookup := DB.Where("grant_id = ? AND user_id = ?", grantID, userID).First(&binding).Error
	if lookup == nil {
		err := DB.Where("id = ? AND user_id = ? AND oauth_internal = ? AND oauth_grant_id = ? AND oauth_grant_version = ?", binding.TokenID, userID, true, grantID, grantVersion).
			Where("EXISTS (?)", DB.Model(&OAuthGrant{}).Select("1").Where("id = ? AND user_id = ? AND version = ? AND revoked_at = 0 AND expires_at > ?", grantID, userID, grantVersion, time.Now().Unix())).First(&token).Error
		return &token, err
	}
	if !errors.Is(lookup, gorm.ErrRecordNotFound) {
		return nil, lookup
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		var grant OAuthGrant
		err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND version = ? AND revoked_at = 0 AND expires_at > ?",
			grantID, userID, grantVersion, time.Now().Unix()).First(&grant).Error
		if err != nil {
			return err
		}
		var binding OAuthRelayBinding
		err = tx.Where("grant_id = ? AND user_id = ?", grantID, userID).First(&binding).Error
		if err == nil {
			return tx.Where("id = ? AND user_id = ? AND oauth_internal = ? AND oauth_grant_id = ?", binding.TokenID, userID, true, grantID).First(&token).Error
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		key, err := common.GenerateKey()
		if err != nil {
			return err
		}
		token = Token{
			UserId: userID, Key: "naoi_" + key, Name: "OAuth application", Status: common.TokenStatusEnabled,
			CreatedTime: time.Now().Unix(), AccessedTime: time.Now().Unix(), ExpiredTime: grant.ExpiresAt,
			UnlimitedQuota: true, OAuthGrantID: grantID, OAuthGrantVersion: grantVersion, OAuthInternal: true,
		}
		if err = tx.Create(&token).Error; err != nil {
			return err
		}
		return tx.Create(&OAuthRelayBinding{GrantID: grantID, UserID: userID, TokenID: token.Id}).Error
	})
	if err != nil {
		return nil, err
	}
	return &token, nil
}

// GetOAuthRelayTokenMetadata bypasses token caches for delegation metadata. Old
// Redis entries may not contain newly introduced fields; they must never turn
// a bound key into an unrestricted legacy key.
func GetOAuthRelayTokenMetadata(tokenID int) (*Token, error) {
	var token Token
	err := DB.Select("id", "user_id", "oauth_grant_id", "oauth_grant_version", "oauth_internal").First(&token, tokenID).Error
	return &token, err
}
