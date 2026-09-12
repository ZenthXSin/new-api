package controller

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
)

// weChatPayReconcileTaskIntervalEnv 对账任务的执行间隔（分钟），默认 5 分钟。
const weChatPayReconcileTaskIntervalEnv = "WXPAY_RECONCILE_TASK_INTERVAL_MINUTES"

// weChatPayReconcileBatchLimit 单轮对账最多查单的订单数。
const weChatPayReconcileBatchLimit = 200

// weChatPayReconcileMaxAgeSeconds 只对最近 24 小时内创建的滞留单做查单对账，
// 与微信回调的官方重试窗口（约 24h）对齐；更久远的滞留单保留 pending 状态，
// 供管理员在后台排查与补单，避免对陈年订单反复调用查单接口。
const weChatPayReconcileMaxAgeSeconds int64 = 24 * 60 * 60

// weChatPayReconcileQuerier 抽象主动查单能力，便于对账逻辑做单元测试。
type weChatPayReconcileQuerier interface {
	QueryOrderByOutTradeNo(ctx context.Context, outTradeNo string) (*payments.Transaction, error)
}

// weChatPayReconcileSummary 一轮对账的结果统计，作为任务 result 落库。
type weChatPayReconcileSummary struct {
	Checked      int `json:"checked"`
	Credited     int `json:"credited"`
	Expired      int `json:"expired"`
	StillPending int `json:"still_pending"`
	QueryErrors  int `json:"query_errors"`
	CreditErrors int `json:"credit_errors"`
	Invalid      int `json:"invalid_transactions"`
}

// weChatPayReconcileHandler 兜底微信回调丢失：微信支付订单只有回调与前端
// 轮询查单两个入账触发点，任一失败订单就会永久滞留 pending（用户已付款但
// 不到账）。本任务定期对待支付订单主动查单，成功即复用幂等的
// RechargeWeChatPay 入账，确认未支付的过期单则关单。
type wechatPayReconcileHandler struct{}

func (wechatPayReconcileHandler) Type() string { return model.SystemTaskTypeWeChatPayReconcile }

func (wechatPayReconcileHandler) Enabled() bool {
	return isWeChatPayTopUpEnabled()
}

func (wechatPayReconcileHandler) Interval() time.Duration {
	minutes := common.GetEnvOrDefault(weChatPayReconcileTaskIntervalEnv, 5)
	if minutes < 1 {
		minutes = 1
	}
	return time.Duration(minutes) * time.Minute
}

func (wechatPayReconcileHandler) NewPayload() any { return nil }

func (wechatPayReconcileHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	querier, err := service.NewWeChatPayService()
	if err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, nil, fmt.Errorf("微信支付对账客户端初始化失败: %w", err))
		return
	}
	summary := reconcilePendingWeChatPayOrders(ctx, querier)
	finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusSucceeded, summary, nil)
}

// reconcilePendingWeChatPayOrders 对滞留的待支付微信订单逐一查单并结算。
// 入账复用 RechargeWeChatPay（事务+行锁+幂等），与回调并发到达时最多入账一次。
func reconcilePendingWeChatPayOrders(ctx context.Context, querier weChatPayReconcileQuerier) weChatPayReconcileSummary {
	summary := weChatPayReconcileSummary{}
	if querier == nil {
		return summary
	}

	now := common.GetTimestamp()
	orders, err := model.GetPendingWeChatPayTopUpsForReconcile(now-weChatPayReconcileMaxAgeSeconds, weChatPayReconcileBatchLimit)
	if err != nil {
		logger.LogError(ctx, fmt.Sprintf("微信支付对账查询滞留订单失败 error=%q", err.Error()))
		summary.QueryErrors++
		return summary
	}

	expireSeconds := int64(setting.WeChatPayOrderExpireMinutes) * 60
	for _, topUp := range orders {
		select {
		case <-ctx.Done():
			return summary
		default:
		}
		summary.Checked++

		transaction, err := querier.QueryOrderByOutTradeNo(ctx, topUp.TradeNo)
		if err != nil {
			summary.QueryErrors++
			logger.LogWarn(ctx, fmt.Sprintf("微信支付对账主动查单失败 trade_no=%s error=%q", topUp.TradeNo, err.Error()))
			continue
		}
		tradeState := ""
		if transaction != nil && transaction.TradeState != nil {
			tradeState = *transaction.TradeState
		}

		if tradeState == "SUCCESS" {
			if verr := validateWeChatPayTransaction(transaction, topUp.TradeNo); verr != nil {
				summary.Invalid++
				logger.LogError(ctx, fmt.Sprintf("微信支付对账查单交易字段无效 trade_no=%s error=%q", topUp.TradeNo, verr.Error()))
				continue
			}
			if rerr := model.RechargeWeChatPay(topUp.TradeNo, *transaction.Amount.Total, *transaction.TransactionId, ""); rerr != nil {
				summary.CreditErrors++
				logger.LogError(ctx, fmt.Sprintf("微信支付对账入账失败 trade_no=%s error=%q", topUp.TradeNo, rerr.Error()))
				continue
			}
			summary.Credited++
			logger.LogInfo(ctx, fmt.Sprintf("微信支付对账补单成功 trade_no=%s user_id=%d money=%.2f", topUp.TradeNo, topUp.UserId, topUp.Money))
			continue
		}

		// 未到有效期且未支付：继续等回调（NOTPAY/USERPAYING 等状态原样保留）。
		if now < topUp.CreateTime+expireSeconds {
			summary.StillPending++
			continue
		}

		// 已过有效期：仅当微信侧确认订单不会支付时才本地关单。查单结果可能
		// 与本地状态机不同步（如 REFUND/USERPAYING），此类订单留给人工处理，
		// 避免误关真实已付款的订单。
		switch tradeState {
		case "CLOSED", "REVOKED", "NOTPAY", "PAYERROR":
		default:
			summary.StillPending++
			logger.LogWarn(ctx, fmt.Sprintf("微信支付对账遇到未处理的过期订单状态 trade_no=%s trade_state=%q", topUp.TradeNo, tradeState))
			continue
		}
		err = model.UpdatePendingTopUpStatus(topUp.TradeNo, model.PaymentProviderWeChatPay, common.TopUpStatusExpired)
		switch {
		case err == nil:
			summary.Expired++
		case errors.Is(err, model.ErrTopUpStatusInvalid):
			// 回调/其他实例并发改动了状态，下一轮对账自然确认
			summary.StillPending++
		default:
			summary.QueryErrors++
			logger.LogError(ctx, fmt.Sprintf("微信支付对账关单失败 trade_no=%s error=%q", topUp.TradeNo, err.Error()))
		}
	}
	return summary
}
