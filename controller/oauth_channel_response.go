package controller

import (
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

// Channel operation scopes grant an outcome, not the upstream credentials that
// arbitrary provider errors, parameter overrides, or raw responses can contain.
func channelOperationError(c *gin.Context, err error, message string) {
	if _, delegated := middleware.GetOAuthPrincipal(c); delegated {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": message, "error_code": "channel_operation_failed"})
		return
	}
	common.ApiError(c, err)
}

type oauthUsageField struct {
	kind   string
	object map[string]oauthUsageField
	values []string
}

var oauthCodexWindowFields = map[string]oauthUsageField{
	"used_percent":         {kind: "number"},
	"reset_at":             {kind: "number"},
	"reset_after_seconds":  {kind: "number"},
	"limit_window_seconds": {kind: "number"},
}

var oauthCodexPlanField = oauthUsageField{kind: "enum", values: []string{"free", "go", "plus", "pro", "team", "business", "enterprise", "edu"}}

var oauthCodexRateLimitFields = map[string]oauthUsageField{
	"plan_type":        oauthCodexPlanField,
	"allowed":          {kind: "boolean"},
	"limit_reached":    {kind: "boolean"},
	"primary_window":   {kind: "object", object: oauthCodexWindowFields},
	"secondary_window": {kind: "object", object: oauthCodexWindowFields},
}

var oauthCodexCreditFields = map[string]oauthUsageField{
	"status":            {kind: "enum", values: []string{"available", "redeemed", "expired", "pending", "redeeming"}},
	"granted_at":        {kind: "timestamp"},
	"expires_at":        {kind: "timestamp"},
	"redeem_started_at": {kind: "timestamp"},
	"redeemed_at":       {kind: "timestamp"},
}

var oauthCodexUsageFields = map[string]oauthUsageField{
	"plan_type":  oauthCodexPlanField,
	"rate_limit": {kind: "object", object: oauthCodexRateLimitFields},
	"additional_rate_limits": {kind: "array", object: map[string]oauthUsageField{
		"plan_type":        oauthCodexPlanField,
		"rate_limit":       {kind: "object", object: oauthCodexRateLimitFields},
		"primary_window":   {kind: "object", object: oauthCodexWindowFields},
		"secondary_window": {kind: "object", object: oauthCodexWindowFields},
	}},
	"rate_limit_reset_credits": {kind: "object", object: map[string]oauthUsageField{
		"available_count": {kind: "number"},
	}},
	"credits": {kind: "credits"},
	"spend_control": {kind: "object", object: map[string]oauthUsageField{
		"reached": {kind: "boolean"},
	}},
	"available_count":    {kind: "number"},
	"total_earned_count": {kind: "number"},
	"success":            {kind: "boolean"},
	"status":             {kind: "enum", values: []string{"success", "succeeded", "completed", "pending", "redeemed"}},
}

// Only constrained values cross the delegation boundary. Even a known string
// field such as plan_type can otherwise be used to echo a key. Free text, user
// identifiers, URLs and provider-specific extensions remain site diagnostics.
func projectOAuthCodexUsage(payload any, fields map[string]oauthUsageField) map[string]any {
	input, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	output := make(map[string]any)
	for key, field := range fields {
		value, exists := input[key]
		if !exists {
			continue
		}
		switch field.kind {
		case "number":
			if number, ok := value.(float64); ok && number >= 0 && !math.IsInf(number, 0) && !math.IsNaN(number) {
				output[key] = number
			}
		case "boolean":
			if flag, ok := value.(bool); ok {
				output[key] = flag
			}
		case "enum":
			if text, ok := value.(string); ok && slices.Contains(field.values, text) {
				output[key] = text
			}
		case "timestamp":
			if value == nil {
				output[key] = nil
			} else if text, ok := value.(string); ok {
				if timestamp, err := time.Parse(time.RFC3339Nano, text); err == nil {
					output[key] = timestamp.UTC().Format(time.RFC3339Nano)
				}
			}
		case "object":
			if object := projectOAuthCodexUsage(value, field.object); len(object) > 0 {
				output[key] = object
			}
		case "credits":
			if object, ok := value.(map[string]any); ok {
				if creditFlags := projectOAuthCodexUsage(object, map[string]oauthUsageField{
					"overage_limit_reached": {kind: "boolean"},
					"has_credits":           {kind: "boolean"},
					"unlimited":             {kind: "boolean"},
				}); len(creditFlags) > 0 {
					output[key] = creditFlags
				}
				continue
			}
			field.object = oauthCodexCreditFields
			fallthrough
		case "array":
			if items, ok := value.([]any); ok {
				projected := make([]any, 0, len(items))
				for _, item := range items {
					if object := projectOAuthCodexUsage(item, field.object); len(object) > 0 {
						projected = append(projected, object)
					}
				}
				if len(items) == 0 || len(projected) > 0 {
					output[key] = projected
				}
			}
		}
	}
	return output
}
