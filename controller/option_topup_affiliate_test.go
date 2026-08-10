package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func updateOptionWithValue(t *testing.T, key string, value string) (bool, string) {
	t.Helper()
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(
		http.MethodPut,
		"/api/option/",
		strings.NewReader(`{"key":"`+key+`","value":"`+value+`"}`),
	)
	UpdateOption(context)
	assert.Equal(t, http.StatusOK, response.Code)
	var payload struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
	return payload.Success, payload.Message
}

// 负倍率被拒绝,防止管理员配置出"充值反而扣邀请人额度"的错误。
func TestUpdateOptionRejectsNegativeTopUpAffiliateRatio(t *testing.T) {
	success, message := updateOptionWithValue(t, "TopUpAffiliateRatio", "-0.5")
	assert.False(t, success)
	assert.Contains(t, message, "非负数字")
}

// NaN 倍率被拒绝。
func TestUpdateOptionRejectsNaNTopUpAffiliateRatio(t *testing.T) {
	success, message := updateOptionWithValue(t, "TopUpAffiliateRatio", "NaN")
	assert.False(t, success)
	assert.Contains(t, message, "非负数字")
}

// 正倍率在未确认支付合规时被拒绝(与 QuotaForInviter 同一资金门控)。
func TestUpdateOptionRejectsTopUpAffiliateRatioWithoutCompliance(t *testing.T) {
	originalConfirmed := operation_setting.GetPaymentSetting().ComplianceConfirmed
	originalVersion := operation_setting.GetPaymentSetting().ComplianceTermsVersion
	defer func() {
		operation_setting.GetPaymentSetting().ComplianceConfirmed = originalConfirmed
		operation_setting.GetPaymentSetting().ComplianceTermsVersion = originalVersion
	}()
	operation_setting.GetPaymentSetting().ComplianceConfirmed = false
	operation_setting.GetPaymentSetting().ComplianceTermsVersion = ""

	success, message := updateOptionWithValue(t, "TopUpAffiliateRatio", "0.1")
	assert.False(t, success)
	assert.Contains(t, message, "compliance_required")
}
