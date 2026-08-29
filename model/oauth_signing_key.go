package model

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
)

// OauthSigningKey stores an RS256 signing key for OIDC tokens. The private
// key is AES-GCM encrypted at rest; the public half is published via JWKS.
// Multiple generations coexist so tokens issued before a rotation stay valid
// until they expire.
type OauthSigningKey struct {
	Id          int    `json:"id" gorm:"primaryKey"`
	Kid         string `json:"kid" gorm:"type:varchar(64);uniqueIndex;not null"`
	PrivateKey  string `json:"-" gorm:"type:text;not null"` // encrypted PEM (PKCS#8)
	CreatedTime int64  `json:"created_time" gorm:"autoCreateTime"`
	RevokedAt   int64  `json:"revoked_at" gorm:"default:0"`
}

func (OauthSigningKey) TableName() string {
	return "oauth_signing_keys"
}

// GetOrCreateOauthSigningKey returns the newest active key, generating and
// persisting a fresh RSA-2048 keypair on first use.
func GetOrCreateOauthSigningKey() (*rsa.PrivateKey, string, error) {
	var key OauthSigningKey
	err := DB.Where("revoked_at = 0").Order("id desc").First(&key).Error
	if err == nil {
		privateKey, parseErr := key.loadPrivateKey()
		if parseErr == nil {
			return privateKey, key.Kid, nil
		}
		common.SysError(fmt.Sprintf("stored oidc signing key is unreadable, generating a replacement: %v", parseErr))
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, "", err
	}
	return createOauthSigningKey()
}

func createOauthSigningKey() (*rsa.PrivateKey, string, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, "", fmt.Errorf("generate oidc signing key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, "", err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	ciphertext, err := common.EncryptSecret(string(pemBytes), "oidc-signing-key")
	if err != nil {
		return nil, "", err
	}
	kid, err := common.GenerateRandomKey(16)
	if err != nil {
		return nil, "", err
	}
	record := OauthSigningKey{Kid: kid, PrivateKey: ciphertext}
	if err := DB.Create(&record).Error; err != nil {
		return nil, "", err
	}
	return privateKey, kid, nil
}

func (k *OauthSigningKey) loadPrivateKey() (*rsa.PrivateKey, error) {
	plaintext, err := common.DecryptSecret(k.PrivateKey, "oidc-signing-key")
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode([]byte(plaintext))
	if block == nil {
		return nil, errors.New("oidc signing key pem is malformed")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("oidc signing key is not an RSA key")
	}
	return rsaKey, nil
}

// OauthJWK is a single JSON Web Key entry for the JWKS document.
type OauthJWK struct {
	Kty string `json:"kty"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// GetOauthJWKS returns the public keys of every active signing key.
func GetOauthJWKS() ([]OauthJWK, error) {
	var records []OauthSigningKey
	if err := DB.Where("revoked_at = 0").Order("id desc").Find(&records).Error; err != nil {
		return nil, err
	}
	keys := make([]OauthJWK, 0, len(records))
	for _, record := range records {
		privateKey, err := record.loadPrivateKey()
		if err != nil {
			common.SysError(fmt.Sprintf("skipping unreadable oidc signing key %s: %v", record.Kid, err))
			continue
		}
		keys = append(keys, rsaPublicJWK(&privateKey.PublicKey, record.Kid))
	}
	return keys, nil
}

func rsaPublicJWK(publicKey *rsa.PublicKey, kid string) OauthJWK {
	return OauthJWK{
		Kty: "RSA",
		Use: "sig",
		Alg: "RS256",
		Kid: kid,
		N:   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString(bigEndianExponent(publicKey.E)),
	}
}

func bigEndianExponent(e int) []byte {
	if e == 0 {
		return []byte{0}
	}
	var raw []byte
	for value := e; value > 0; value >>= 8 {
		raw = append([]byte{byte(value)}, raw...)
	}
	return raw
}

// LoadOidcSigningKeyByKid returns the active private key with the given kid.
func LoadOidcSigningKeyByKid(kid string) (*rsa.PrivateKey, error) {
	kid = strings.TrimSpace(kid)
	if kid == "" {
		return nil, errors.New("oidc signing key kid is empty")
	}
	var key OauthSigningKey
	if err := DB.Where("kid = ? AND revoked_at = 0", kid).First(&key).Error; err != nil {
		return nil, err
	}
	return key.loadPrivateKey()
}

// LoadActiveOidcSigningKey returns the newest active private key without
// creating one. Verification paths must not generate keys as a side effect.
func LoadActiveOidcSigningKey() (*rsa.PrivateKey, error) {
	var key OauthSigningKey
	if err := DB.Where("revoked_at = 0").Order("id desc").First(&key).Error; err != nil {
		return nil, err
	}
	return key.loadPrivateKey()
}

// RevokeOauthSigningKeysBefore marks every key older than keep as revoked so
// rotation can retire compromised or aged keys.
func RevokeOauthSigningKeysBefore(keepId int) error {
	return DB.Model(&OauthSigningKey{}).
		Where("id < ? AND revoked_at = 0", keepId).
		Update("revoked_at", time.Now().Unix()).Error
}
