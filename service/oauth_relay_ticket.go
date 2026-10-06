package service

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

const (
	OAuthRelayTicketPrefix  = "nao_ws_"
	OAuthRelayTicketTTL     = time.Minute
	oauthRelayTicketPurpose = "oauth_relay_ticket"
	oauthRelayTicketPath    = "/v1/realtime"
)

var ErrOAuthRelayTicketInvalid = errors.New("oauth relay ticket is invalid or has expired")

type oauthRelayTicketPayload struct {
	GrantID      int    `json:"grant_id"`
	GrantVersion int64  `json:"grant_version"`
	AuthVersion  int64  `json:"auth_version"`
	Method       string `json:"method"`
	Path         string `json:"path"`
}

// CreateOAuthRelayTicket gives browsers a single-use WebSocket credential so
// the reusable OAuth access token never needs to enter a URL or subprotocol.
// Model selection still passes through the ordinary relay authorization.
func CreateOAuthRelayTicket(principal *OAuthPrincipal) (string, error) {
	if principal == nil || principal.UserID <= 0 || principal.GrantID <= 0 {
		return "", ErrOAuthRelayTicketInvalid
	}
	current, err := AuthenticateOAuthGrant(principal.GrantID)
	if err != nil || current.UserID != principal.UserID || current.GrantVersion != principal.GrantVersion || current.AuthVersion != principal.AuthVersion {
		return "", ErrOAuthRelayTicketInvalid
	}
	if !OAuthScopeAllowed(current, "relay:invoke") || !slices.Contains(current.Resources, OAuthResourceRelay) {
		return "", ErrOAuthScopeForbidden
	}
	payload, err := common.Marshal(oauthRelayTicketPayload{
		GrantID: current.GrantID, GrantVersion: current.GrantVersion, AuthVersion: current.AuthVersion,
		Method: http.MethodGet, Path: oauthRelayTicketPath,
	})
	if err != nil {
		return "", err
	}
	raw, _, err := model.CreateAuthFlow(model.AuthFlowCreate{
		Purpose: oauthRelayTicketPurpose, UserId: current.UserID,
		Payload: string(payload), ExpiresAt: time.Now().Add(OAuthRelayTicketTTL),
	})
	if err != nil {
		return "", err
	}
	return OAuthRelayTicketPrefix + raw, nil
}

// AuthenticateOAuthRelayTicket consumes only tickets bound to this handshake.
// Invalid method/path attempts do not burn a valid ticket. The atomic consume
// prevents concurrent handshakes and rechecks revocation and grant narrowing.
func AuthenticateOAuthRelayTicket(raw, method, path string) (*OAuthPrincipal, bool, error) {
	if !strings.HasPrefix(raw, OAuthRelayTicketPrefix) {
		return nil, false, nil
	}
	if len(raw) != len(OAuthRelayTicketPrefix)+43 || method != http.MethodGet || path != oauthRelayTicketPath {
		return nil, true, ErrOAuthRelayTicketInvalid
	}
	flowToken := strings.TrimPrefix(raw, OAuthRelayTicketPrefix)
	flow, err := model.GetAuthFlow(flowToken, model.AuthFlowMatch{Purpose: oauthRelayTicketPurpose})
	if err != nil {
		return nil, true, ErrOAuthRelayTicketInvalid
	}
	var payload oauthRelayTicketPayload
	if common.UnmarshalJsonStr(flow.Payload, &payload) != nil || flow.UserId <= 0 || payload.GrantID <= 0 || payload.Method != method || payload.Path != path {
		return nil, true, ErrOAuthRelayTicketInvalid
	}
	principal, err := AuthenticateOAuthGrant(payload.GrantID)
	if err != nil || principal.UserID != flow.UserId || principal.GrantVersion != payload.GrantVersion || principal.AuthVersion != payload.AuthVersion ||
		!OAuthScopeAllowed(principal, "relay:invoke") || !slices.Contains(principal.Resources, OAuthResourceRelay) {
		return nil, true, ErrOAuthRelayTicketInvalid
	}
	_, err = model.ConsumeAuthFlowWithAction(flowToken, model.AuthFlowMatch{Purpose: oauthRelayTicketPurpose, UserId: principal.UserID}, func(tx *gorm.DB, consumed *model.AuthFlow) error {
		var consumedPayload oauthRelayTicketPayload
		if common.UnmarshalJsonStr(consumed.Payload, &consumedPayload) != nil || consumedPayload != payload {
			return ErrOAuthRelayTicketInvalid
		}
		var grant model.OAuthGrant
		return tx.Select("id").Where("id = ? AND user_id = ? AND version = ? AND user_auth_version = ? AND revoked_at = 0 AND expires_at > ?",
			principal.GrantID, principal.UserID, principal.GrantVersion, principal.AuthVersion, time.Now().Unix()).Take(&grant).Error
	})
	if err != nil {
		return nil, true, ErrOAuthRelayTicketInvalid
	}
	return principal, true, nil
}
