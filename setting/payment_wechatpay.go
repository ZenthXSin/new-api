package setting

var (
	WeChatPayEnabled                         bool
	WeChatPayAppID                           string
	WeChatPayMerchantID                      string
	WeChatPayMerchantSerialNumber            string
	WeChatPayPrivateKey                      string
	WeChatPayAPIV3Key                        string
	WeChatPayPlatformCertificate             string
	WeChatPayPlatformCertificateSerialNumber string
	WeChatPayNotifyURL                       string
	WeChatPayMinTopUp                        int = 1
	WeChatPayOrderExpireMinutes              int = 15
)
