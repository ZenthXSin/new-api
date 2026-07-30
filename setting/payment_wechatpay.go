package service

import (
	"fmt"

	"github.com/QuantumNous/new-api/setting"
)

func init() {
	setting.RegisterOptionType("payment_wechatpay", &setting.WeChatPaySetting{})
}
