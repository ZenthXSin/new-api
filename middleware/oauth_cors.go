package middleware

import (
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

var oauthCORSHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// OAuthCORS permits credential-free browser API calls only from origins listed
// in an enabled OAuth client's redirect URIs. Cookies are never authorized by
// this policy. Bearer scope, resource, role, and object checks still run.
func OAuthCORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		parsedOrigin, _ := url.Parse(origin)
		if origin == "" || origin == "null" || (parsedOrigin != nil && parsedOrigin.Host == c.Request.Host) {
			c.Next()
			return
		}
		c.Writer.Header().Add("Vary", "Origin")
		if model.DB == nil {
			c.Next()
			return
		}
		clients, err := model.GetOauthClients()
		if err != nil {
			c.Next()
			return
		}
		allowed := false
		for _, client := range clients {
			if client.Enabled && OAuthClientAllowsOrigin(client, origin) {
				allowed = true
				break
			}
		}
		if !allowed {
			c.Next()
			return
		}
		c.Set("oauth_cors_origin_allowed", true)
		c.Header("Access-Control-Allow-Origin", origin)
		c.Header("Access-Control-Expose-Headers", "Content-Disposition, X-Request-Id, WWW-Authenticate, Retry-After, Auth-Version")
		if c.Request.Method == http.MethodOptions && c.GetHeader("Access-Control-Request-Method") != "" {
			method := c.GetHeader("Access-Control-Request-Method")
			if !slices.Contains([]string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}, method) {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			// Registered applications may use provider-specific request headers.
			// Validate header-name syntax and reflect the requested names; the
			// bearer authentication and browser forbidden-header rules still apply.
			allowedHeaders := []string{"authorization", "content-type"}
			for _, header := range strings.Split(c.GetHeader("Access-Control-Request-Headers"), ",") {
				header = strings.ToLower(strings.TrimSpace(header))
				if header == "" {
					continue
				}
				if !oauthCORSHeaderName.MatchString(header) {
					c.AbortWithStatus(http.StatusForbidden)
					return
				}
				if !slices.Contains(allowedHeaders, header) {
					allowedHeaders = append(allowedHeaders, header)
				}
			}
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS")
			c.Header("Access-Control-Allow-Headers", strings.Join(allowedHeaders, ", "))
			c.Header("Access-Control-Max-Age", "300")
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func OAuthClientAllowsOrigin(client *model.OauthClient, origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	for _, uri := range client.GetRedirectUris() {
		redirect, err := url.Parse(uri)
		if err == nil && redirect.Scheme == parsed.Scheme && redirect.Host == parsed.Host {
			return true
		}
	}
	return false
}
