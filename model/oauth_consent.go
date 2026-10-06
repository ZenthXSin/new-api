package model

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
)

// OauthConsent records a user's grant of a scope set to an OIDC client. When
// the requested scopes are covered by an existing grant the consent screen is
// skipped and authorization proceeds silently.
type OauthConsent struct {
	Id            int    `json:"id" gorm:"primaryKey"`
	UserId        int    `json:"user_id" gorm:"uniqueIndex:uk_oauth_consent_user_client;not null"`
	OauthClientId int    `json:"oauth_client_id" gorm:"uniqueIndex:uk_oauth_consent_user_client;not null"`
	GrantedScopes string `json:"granted_scopes" gorm:"type:varchar(8192);not null"`
	CreatedTime   int64  `json:"created_time" gorm:"autoCreateTime"`
	UpdatedTime   int64  `json:"updated_time" gorm:"autoUpdateTime"`
}

func (OauthConsent) TableName() string {
	return "oauth_consents"
}

// CoversScopes reports whether a previous grant includes every requested scope.
func (c *OauthConsent) CoversScopes(scopes []string) bool {
	granted := strings.Fields(c.GrantedScopes)
	set := make(map[string]struct{}, len(granted))
	for _, scope := range granted {
		set[scope] = struct{}{}
	}
	for _, scope := range scopes {
		if _, ok := set[scope]; !ok {
			return false
		}
	}
	return true
}

// GetOauthConsent returns the stored consent for a user and client, or nil.
func GetOauthConsent(userId int, oauthClientId int) (*OauthConsent, error) {
	if userId <= 0 || oauthClientId <= 0 {
		return nil, nil
	}
	var consent OauthConsent
	err := DB.Where("user_id = ? AND oauth_client_id = ?", userId, oauthClientId).First(&consent).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &consent, nil
}

// SaveOauthConsent upserts the grant, widening the stored scope set.
func SaveOauthConsent(userId int, oauthClientId int, scopes []string) error {
	if userId <= 0 || oauthClientId <= 0 || len(scopes) == 0 {
		return errors.New("invalid oauth consent")
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var consent OauthConsent
		err := tx.Where("user_id = ? AND oauth_client_id = ?", userId, oauthClientId).First(&consent).Error
		if err == nil {
			if consent.CoversScopes(scopes) {
				return nil
			}
			merged := normalizeOauthScopes(append(strings.Fields(consent.GrantedScopes), scopes...))
			consent.GrantedScopes = strings.Join(merged, " ")
			consent.UpdatedTime = time.Now().Unix()
			return tx.Save(&consent).Error
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		consent = OauthConsent{
			UserId:        userId,
			OauthClientId: oauthClientId,
			GrantedScopes: strings.Join(normalizeOauthScopes(scopes), " "),
		}
		return tx.Create(&consent).Error
	})
}

func normalizeOauthScopes(scopes []string) []string {
	result := make([]string, 0, len(scopes))
	seen := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		scope = strings.TrimSpace(scope)
		if scope == "" {
			continue
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		result = append(result, scope)
	}
	return result
}

// DeleteOauthConsentsByUser removes every grant of one user (used with account cleanup).
func DeleteOauthConsentsByUser(tx *gorm.DB, userId int) error {
	if tx == nil {
		tx = DB
	}
	return tx.Where("user_id = ?", userId).Delete(&OauthConsent{}).Error
}
