package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
)

const codexGitHubFlowPurpose = "codex_github"
const codexGitHubRequestedScopes = "repo read:org workflow"

var (
	ErrCodexGitHubUnconfigured     = errors.New("GitHub development authorization is not configured")
	ErrCodexGitHubProvider         = errors.New("GitHub authorization service failed; please retry")
	ErrCodexGitHubNotConnected     = errors.New("GitHub is not connected")
	ErrCodexGitHubRepositoryScope  = errors.New("GitHub repository permission was not granted")
	ErrCodexGitHubAlreadyConnected = errors.New("disconnect the current GitHub account before connecting again")
	codexGitHubLoginPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,99}$`)
	codexGitHubClient              = &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 15 * time.Second,
			MaxIdleConns: 16, MaxIdleConnsPerHost: 8, IdleConnTimeout: time.Minute,
		},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
)

// Only fixed stages and reasons are retained; provider bodies and secrets are excluded.
type CodexGitHubProviderError struct {
	Stage, Reason string
	Status        int
}

func (err *CodexGitHubProviderError) Error() string { return "GitHub " + err.Stage + ": " + err.Reason }
func (err *CodexGitHubProviderError) Unwrap() error { return ErrCodexGitHubProvider }

type CodexGitHubConfig struct{ ClientID, ClientSecret, RedirectURI, AppSlug string }

// A dedicated development App overrides the site's configured GitHub App.
func LoadCodexGitHubConfig() (CodexGitHubConfig, error) {
	config := CodexGitHubConfig{ClientID: strings.TrimSpace(os.Getenv("CODEX_GITHUB_CLIENT_ID")), ClientSecret: strings.TrimSpace(os.Getenv("CODEX_GITHUB_CLIENT_SECRET")), RedirectURI: strings.TrimSpace(os.Getenv("CODEX_GITHUB_REDIRECT_URI"))}
	config.AppSlug = strings.ToLower(strings.TrimSpace(os.Getenv("CODEX_GITHUB_APP_SLUG")))
	if config.AppSlug != "" && !codexGitHubLoginPattern.MatchString(config.AppSlug) {
		return config, ErrCodexGitHubUnconfigured
	}
	// Reuse the site's configured GitHub App when a dedicated Codex App is not
	// supplied. The dedicated variables remain an override for operators who
	// want repository access isolated from ordinary login OAuth.
	if config.ClientID == "" {
		config.ClientID = strings.TrimSpace(common.GitHubClientId)
	}
	if config.ClientSecret == "" {
		config.ClientSecret = strings.TrimSpace(common.GitHubClientSecret)
	}
	if file := strings.TrimSpace(os.Getenv("CODEX_GITHUB_CLIENT_SECRET_FILE")); file != "" {
		data, err := os.ReadFile(file)
		if err != nil || len(data) > 4096 {
			return config, ErrCodexGitHubUnconfigured
		}
		config.ClientSecret = strings.TrimSpace(string(data))
	}
	if config.RedirectURI == "" {
		config.RedirectURI = strings.TrimRight(system_setting.ServerAddress, "/") + "/codex?github_oauth=1"
	}
	u, err := url.Parse(config.RedirectURI)
	loopback := err == nil && u != nil && (u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback())
	if err != nil || u == nil || u.User != nil || u.Fragment != "" || u.Hostname() == "" || (u.Scheme != "https" && !(loopback && u.Scheme == "http")) || u.Path != "/codex" || u.Query().Get("github_oauth") != "1" || len(config.ClientID) < 5 || len(config.ClientID) > 256 || len(config.ClientSecret) < 16 || len(config.ClientSecret) > 4096 || strings.ContainsAny(config.ClientID+config.ClientSecret, "\r\n") {
		return config, ErrCodexGitHubUnconfigured
	}
	return config, nil
}

type CodexGitHubStatus struct {
	Configured          bool     `json:"configured"`
	Connected           bool     `json:"connected"`
	Login               string   `json:"login,omitempty"`
	AvatarURL           string   `json:"avatarUrl,omitempty"`
	Scopes              []string `json:"scopes"`
	Capabilities        []string `json:"capabilities"`
	RevocationPending   bool     `json:"revocationPending"`
	Reason              string   `json:"reason,omitempty"`
	ApplicationType     string   `json:"applicationType,omitempty"`
	RepositoryAccessURL string   `json:"repositoryAccessUrl,omitempty"`
}

func GetCodexGitHubStatus(userID int) (*CodexGitHubStatus, error) {
	config, configErr := LoadCodexGitHubConfig()
	status := &CodexGitHubStatus{Configured: configErr == nil, Scopes: []string{}, Capabilities: []string{}}
	if configErr != nil {
		status.Reason = "尚未配置 GitHub 开发授权，请管理员配置 GitHub OAuth App"
	}
	connection, err := model.GetCodexGitHubConnection(userID)
	if err != nil {
		return nil, err
	}
	status.RevocationPending = connection.RevokedAt > 0 && connection.TokenCiphertext != ""
	status.Connected = configErr == nil && config.ClientID == connection.ClientID && connection.RevokedAt == 0 && connection.TokenCiphertext != ""
	if status.Connected {
		status.Login, status.AvatarURL = connection.Login, connection.AvatarURL
		status.Scopes = strings.Fields(connection.Scopes)
		status.Capabilities = []string{"repositories", "issues", "pull_requests"}
		status.ApplicationType = "oauth_app"
		if strings.HasPrefix(connection.ClientID, "Iv") {
			status.Capabilities = []string{"app_permissions"}
			status.ApplicationType = "github_app"
			status.RepositoryAccessURL = "https://github.com/settings/apps/authorizations"
			if config.AppSlug != "" {
				status.RepositoryAccessURL = "https://github.com/apps/" + config.AppSlug + "/installations/new"
			}
		}
		if codexGitHubHasScope(connection.Scopes, "workflow") {
			status.Capabilities = append(status.Capabilities, "workflows")
		}
	}
	return status, nil
}

type codexGitHubFlow struct {
	VerifierEncrypted string `json:"verifier_encrypted"`
	Generation        int64  `json:"generation"`
	UserAuthVersion   int64  `json:"user_auth_version"`
	SessionVersion    int64  `json:"session_version"`
	RedirectURI       string `json:"redirect_uri"`
	ClientID          string `json:"client_id"`
}

func BeginCodexGitHubAuthorization(identity AuthIdentity) (string, error) {
	config, err := LoadCodexGitHubConfig()
	if err != nil {
		return "", err
	}
	connection, err := model.GetCodexGitHubConnection(identity.UserID)
	if err != nil {
		return "", err
	}
	if connection.TokenCiphertext != "" {
		return "", ErrCodexGitHubAlreadyConnected
	}
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return "", err
	}
	verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)
	encrypted, err := common.EncryptSecret(verifier, fmt.Sprintf("codex-github-pkce:%d:%s", identity.UserID, identity.SessionID))
	if err != nil {
		return "", err
	}
	payload, err := common.Marshal(codexGitHubFlow{VerifierEncrypted: encrypted, Generation: connection.Generation, UserAuthVersion: identity.UserAuthVersion, SessionVersion: identity.SessionVersion, RedirectURI: config.RedirectURI, ClientID: config.ClientID})
	if err != nil {
		return "", err
	}
	state, _, err := model.CreateAuthFlow(model.AuthFlowCreate{Purpose: codexGitHubFlowPurpose, Provider: "github", Intent: "bind", UserId: identity.UserID, SessionId: identity.SessionID, Payload: string(payload), ExpiresAt: time.Now().Add(10 * time.Minute)})
	if err != nil {
		return "", err
	}
	challenge := sha256.Sum256([]byte(verifier))
	query := url.Values{"client_id": {config.ClientID}, "redirect_uri": {config.RedirectURI}, "scope": {codexGitHubRequestedScopes}, "state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "allow_signup": {"false"}}
	// GitHub Apps grant installation permissions. OAuth repo scopes are not supported.
	if strings.HasPrefix(config.ClientID, "Iv") {
		query.Del("scope")
	}
	return "https://github.com/login/oauth/authorize?" + query.Encode(), nil
}

func FinishCodexGitHubAuthorization(ctx context.Context, identity AuthIdentity, code, state string) error {
	if len(code) < 1 || len(code) > 512 || len(state) != 43 {
		return model.ErrAuthFlowInvalid
	}
	config, err := LoadCodexGitHubConfig()
	if err != nil {
		return err
	}
	flow, err := model.ConsumeAuthFlow(state, model.AuthFlowMatch{Purpose: codexGitHubFlowPurpose, Provider: "github", Intent: "bind", UserId: identity.UserID, SessionId: identity.SessionID})
	if err != nil {
		return err
	}
	var payload codexGitHubFlow
	if common.UnmarshalJsonStr(flow.Payload, &payload) != nil || payload.UserAuthVersion != identity.UserAuthVersion || payload.SessionVersion != identity.SessionVersion || payload.RedirectURI != config.RedirectURI || payload.ClientID != config.ClientID {
		return model.ErrAuthFlowInvalid
	}
	verifier, err := common.DecryptSecret(payload.VerifierEncrypted, fmt.Sprintf("codex-github-pkce:%d:%s", identity.UserID, identity.SessionID))
	if err != nil {
		return model.ErrAuthFlowInvalid
	}
	body, err := common.Marshal(map[string]string{"client_id": config.ClientID, "client_secret": config.ClientSecret, "code": code, "redirect_uri": config.RedirectURI, "code_verifier": verifier})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://github.com/login/oauth/access_token", bytes.NewReader(body))
	if err != nil {
		return ErrCodexGitHubProvider
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "new-api-codex-workbench")
	response, err := codexGitHubClient.Do(request)
	if err != nil {
		return &CodexGitHubProviderError{Stage: "token_exchange", Reason: "network"}
	}
	defer response.Body.Close()
	var grant struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
		Error       string `json:"error"`
	}
	if common.DecodeJson(io.LimitReader(response.Body, 16384), &grant) != nil {
		return &CodexGitHubProviderError{Stage: "token_exchange", Reason: "invalid_response", Status: response.StatusCode}
	}
	switch grant.Error {
	case "bad_verification_code":
		return model.ErrAuthFlowInvalid
	case "incorrect_client_credentials", "redirect_uri_mismatch":
		return ErrCodexGitHubUnconfigured
	}
	if response.StatusCode != http.StatusOK || grant.Error != "" || grant.AccessToken == "" || len(grant.AccessToken) > 4096 || strings.ContainsAny(grant.AccessToken, "\r\n") || !strings.EqualFold(grant.TokenType, "bearer") {
		return &CodexGitHubProviderError{Stage: "token_exchange", Reason: "rejected", Status: response.StatusCode}
	}
	grant.Scope = strings.Join(strings.Fields(strings.ReplaceAll(grant.Scope, ",", " ")), " ")
	// GitHub App user tokens have an empty scope; access remains enforced by
	// GitHub's installation permissions and the following authenticated /user call.
	appToken := strings.HasPrefix(config.ClientID, "Iv") && strings.HasPrefix(grant.AccessToken, "ghu_")
	if !appToken && !codexGitHubHasScope(grant.Scope, "repo") {
		_ = RevokeCodexGitHubToken(ctx, grant.AccessToken)
		return ErrCodexGitHubRepositoryScope
	}
	var user struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	}
	if _, err := codexGitHubAPI(ctx, http.MethodGet, "/user", grant.AccessToken, nil, &user); err != nil {
		_ = RevokeCodexGitHubToken(ctx, grant.AccessToken)
		return err
	}
	if user.ID <= 0 || !codexGitHubLoginPattern.MatchString(user.Login) {
		_ = RevokeCodexGitHubToken(ctx, grant.AccessToken)
		return &CodexGitHubProviderError{Stage: "user_identity", Reason: "invalid_response"}
	}
	// Use GitHub's fixed image host rather than accepting a provider-controlled
	// arbitrary URL into the administrator page.
	avatar := fmt.Sprintf("https://avatars.githubusercontent.com/u/%d?v=4", user.ID)
	connection := &model.CodexGitHubConnection{UserID: identity.UserID, GitHubID: user.ID, ClientID: config.ClientID, Login: user.Login, AvatarURL: avatar, Scopes: grant.Scope}
	if _, _, err := ValidateLoginSession(identity); err != nil {
		_ = RevokeCodexGitHubToken(ctx, grant.AccessToken)
		return model.ErrAuthFlowInvalid
	}
	if err := model.SaveCodexGitHubConnection(connection, grant.AccessToken, payload.Generation, identity.UserAuthVersion); err != nil {
		_ = RevokeCodexGitHubToken(ctx, grant.AccessToken)
		if errors.Is(err, model.ErrCodexGitHubChanged) {
			return err
		}
		return &CodexGitHubProviderError{Stage: "credential_storage", Reason: "failed"}
	}
	return nil
}

func codexGitHubHasScope(scopes, required string) bool {
	for _, scope := range strings.Fields(scopes) {
		if scope == required {
			return true
		}
	}
	return false
}

// CodexGitHubCredential is passed only over the authenticated private runner
// connection. It must never be serialized into a browser response or event.
type CodexGitHubCredential struct {
	Token, Login string
	Generation   int64
}

func GetCodexGitHubCredential(userID int) (CodexGitHubCredential, error) {
	connection, err := model.GetCodexGitHubConnection(userID)
	if err != nil {
		return CodexGitHubCredential{}, err
	}
	credential := CodexGitHubCredential{Generation: connection.Generation}
	if connection.RevokedAt > 0 || connection.TokenCiphertext == "" {
		return credential, nil
	}
	config, err := LoadCodexGitHubConfig()
	if err != nil || config.ClientID != connection.ClientID {
		return CodexGitHubCredential{}, ErrCodexGitHubUnconfigured
	}
	credential.Token, err = connection.Token()
	if err != nil {
		return CodexGitHubCredential{}, err
	}
	credential.Login = connection.Login
	return credential, nil
}

type CodexGitHubRepository struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"fullName"`
	Private       bool   `json:"private"`
	CloneURL      string `json:"cloneUrl"`
	DefaultBranch string `json:"defaultBranch"`
}

func ListCodexGitHubRepositories(ctx context.Context, userID, page, limit int) ([]CodexGitHubRepository, bool, error) {
	credential, err := GetCodexGitHubCredential(userID)
	if err != nil {
		return nil, false, err
	}
	if credential.Token == "" {
		return nil, false, ErrCodexGitHubNotConnected
	}
	if page < 1 || page > 1000 || limit < 1 || limit > 100 {
		return nil, false, errors.New("invalid GitHub repository pagination")
	}
	var response []struct {
		ID            int64  `json:"id"`
		Name          string `json:"name"`
		FullName      string `json:"full_name"`
		Private       bool   `json:"private"`
		CloneURL      string `json:"clone_url"`
		DefaultBranch string `json:"default_branch"`
	}
	header, err := codexGitHubAPI(ctx, http.MethodGet, "/user/repos?sort=updated&direction=desc&per_page="+strconv.Itoa(limit)+"&page="+strconv.Itoa(page), credential.Token, nil, &response)
	if err != nil {
		return nil, false, err
	}
	repositories := make([]CodexGitHubRepository, 0, len(response))
	for _, repo := range response {
		u, err := url.Parse(repo.CloneURL)
		if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			continue
		}
		repositories = append(repositories, CodexGitHubRepository{ID: repo.ID, Name: repo.Name, FullName: repo.FullName, Private: repo.Private, CloneURL: repo.CloneURL, DefaultBranch: repo.DefaultBranch})
	}
	return repositories, strings.Contains(header.Get("Link"), `rel="next"`), nil
}

func RevokeCodexGitHubToken(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	config, err := LoadCodexGitHubConfig()
	if err != nil {
		return err
	}
	body, err := common.Marshal(map[string]string{"access_token": token})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, "https://api.github.com/applications/"+url.PathEscape(config.ClientID)+"/token", bytes.NewReader(body))
	if err != nil {
		return ErrCodexGitHubProvider
	}
	request.SetBasicAuth(config.ClientID, config.ClientSecret)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := codexGitHubClient.Do(request)
	if err != nil {
		return ErrCodexGitHubProvider
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusNotFound {
		return ErrCodexGitHubProvider
	}
	return nil
}

func codexGitHubAPI(ctx context.Context, method, path, token string, body io.Reader, result interface{}) (http.Header, error) {
	request, err := http.NewRequestWithContext(ctx, method, "https://api.github.com"+path, body)
	if err != nil {
		return nil, &CodexGitHubProviderError{Stage: "api_request", Reason: "network"}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "new-api-codex-workbench")
	response, err := codexGitHubClient.Do(request)
	if err != nil {
		return nil, &CodexGitHubProviderError{Stage: "api_request", Reason: "network"}
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return nil, model.ErrAuthFlowInvalid
	}
	if response.StatusCode != http.StatusOK {
		return nil, &CodexGitHubProviderError{Stage: "api_request", Reason: "rejected", Status: response.StatusCode}
	}
	if common.DecodeJson(io.LimitReader(response.Body, 2<<20), result) != nil {
		return nil, &CodexGitHubProviderError{Stage: "api_request", Reason: "invalid_response", Status: response.StatusCode}
	}
	return response.Header, nil
}
