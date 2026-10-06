package model

// OAuthAction contains only non-secret intent and execution state. Passwords,
// MFA material and browser credentials are never persisted. Explicitly approved
// key disclosures are stored only as short-lived authenticated ciphertext.
type OAuthAction struct {
	ID                string `json:"-" gorm:"type:varchar(64);primaryKey"`
	UserID            int    `json:"-" gorm:"not null;index"`
	ClientID          string `json:"-" gorm:"type:varchar(128);not null"`
	GrantID           int    `json:"-" gorm:"not null;index"`
	AuthVersion       int64  `json:"-" gorm:"not null"`
	GrantVersion      int64  `json:"-" gorm:"not null"`
	ShareResult       bool   `json:"-" gorm:"not null"`
	ReturnURI         string `json:"-" gorm:"type:text"`
	ReturnState       string `json:"-" gorm:"type:varchar(512)"`
	ResultCiphertext  string `json:"-" gorm:"type:text"`
	ResultClaimedAt   int64  `json:"-"`
	Operation         string `json:"-" gorm:"type:varchar(64);not null"`
	Parameters        string `json:"-" gorm:"type:text;not null"`
	ParametersHash    string `json:"-" gorm:"type:char(64);not null"`
	Status            string `json:"-" gorm:"type:varchar(16);not null;index"`
	StepIndex         int    `json:"-" gorm:"not null"`
	Bootstrap         bool   `json:"-" gorm:"not null;default:false"`
	SessionVersion    int64  `json:"-"`
	BindingResultHash string `json:"-" gorm:"type:char(64)"`
	BindingBeforeHash string `json:"-" gorm:"type:char(64)"`
	SessionID         string `json:"-" gorm:"type:varchar(64)"`
	NonceHash         string `json:"-" gorm:"type:char(64)"`
	ReceiptHash       string `json:"-" gorm:"type:char(64);not null"`
	FlowHash          string `json:"-" gorm:"type:char(64)"`
	CreatedAt         int64  `json:"-" gorm:"not null"`
	ExpiresAt         int64  `json:"-" gorm:"not null;index"`
	CompletedAt       int64  `json:"-"`
}
