package constant

import "github.com/QuantumNous/new-api/common"

const WeChatPayCallbackURL = common.GetEnvOrDefault("WECHAT_PAY_CALLBACK_URL", "https://your-domain.com/api/user/wechatpay/webhook")
