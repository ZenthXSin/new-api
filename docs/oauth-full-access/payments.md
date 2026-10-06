# 为其他软件提供应用收款

本节对应已上线的 `app-payments-20261003` 版本，最终验收与发布证据见中文总文档第 11 节。它在原有 OAuth 充值、本站订阅之外增加“外部软件订单”：软件后端创建订单，用户在 New API 收银台确认，软件根据签名通知和服务端查单开通自己的会员或服务。

这里使用平台统一配置的既有商户。应用不是独立商户，没有分账、提现、商户资金账户或独立结算。余额和外部渠道是两种付款方式；支付成功不会再给 New API 充值一次。

## 认证与资金边界

应用服务端使用 confidential OAuth client 的 HTTP Basic `client_id:client_secret`。公共客户端不能启用应用收款；普通 OAuth access token 不会自动扣款。客户端、应用收款设置都必须启用。普通用户可通过 `wallet:read` 查看自己的付款订单；Root 可通过 `billing:read` 读取应用收款配置与通知状态，修改配置、轮换密钥和人工重投则通过本站真实会话，或 `billing:write` 的固定托管操作经 Root 在本站确认。用户还需要真实 New API 登录会话，在本站收银台查看金额并确认；外部请求不能传 `payer_user_id` 冒充付款人。

客户端 secret 与 webhook secret 是两个用途不同的密钥。前者只在软件后端调用订单 API，后者只用于验证本站通知；都不能放进浏览器、移动安装包、URL 或日志。原有 OAuth 的授权码、用户 scope、刷新和撤销保持独立。

余额付款扣除 New API 的现有 quota 钱包。现有钱包中的充值、赠送和兑换额度在同一个余额池，当前没有区分“充值现金余额”和“赠送余额”；若不希望赠送额度用于软件购买，不要为该应用启用 balance。此版本不将余额支付包装成现金划转或提现。应用付款与本站订阅、充值、兑换码、签到、管理员调额共享余额变更隔离；在 Redis 延迟同步到数据库的模式下，不使用旧数据库余额放大可用额度。缓存或数据库结果不确定时，相关付款保留处理中或待核对状态，由持久化恢复流程处理，不以重复扣款“修复”不确定结果。

## 配置和支持渠道

1. 超级管理员在原 OAuth 提供方界面创建机密客户端，登记软件完整 `return_url`。回跳必须精确匹配登记值。
2. 在 `/system-settings/auth/oauth-provider` 页找到对应机密客户端，点击行内“收款设置”并启用该客户端，选择允许付款方式，并登记固定 HTTPS webhook URL。订单创建请求不能覆盖 webhook URL。
3. 首次保存或轮换时复制一次性显示的 webhook secret，在软件后端保存。普通列表和详情不会再次回显。
4. 外部直付渠道继续使用本站已配置的统一商户。收银台只显示“应用允许 + 站点已配置 + 订单币种支持”的方式。

| 付款方式 | 订单币种 | 收银台 | 全额退款 |
| --- | --- | --- | --- |
| balance | CNY / USD | 本站余额确认，服务端计算额度快照 | 退回原 quota 钱包 |
| stripe | CNY / USD | Stripe Checkout | 支持，异步状态需查询确认 |
| wechatpay | CNY | 微信 Native 二维码 | 支持，异步状态需查询确认 |
| epay_具体类型 | CNY | 已配置易支付方式 | 当前不支持自动原路退款 |

Epay 依靠原有验签通知确认付款，当前没有通用主动查单和退款实现，不能将它显示为可自动退款。Waffo、Waffo Pancake、Creem 的本站充值接口仍保留，但本轮没有因此自动获得应用订单收款适配。本轮上线时生产没有配置外部支付通道；测试使用本地固定数据和 mock，不代表真实商户扣款、到账或退款已经验收。

## 服务端 SDK

Node.js 22.13 或更新版本，无需安装依赖。支付 SDK 独立入口 `sdk/oauth-client/payments.mjs` / 包导出 `@new-api/oauth-client/payments` 使用 Node crypto；不要把它加入浏览器 bundle。原 `index.mjs` 继续供用户 OAuth 使用。

```js
import { NewApiPaymentClient } from './sdk/oauth-client/payments.mjs';

const payments = new NewApiPaymentClient({
  baseUrl: 'https://你的NewAPI域名',
  clientId: process.env.NEW_API_CLIENT_ID,
  clientSecret: process.env.NEW_API_CLIENT_SECRET,
});

// 本地订单必须先持久化，金额来自软件服务端商品配置。
const order = await payments.createOrder({
  out_trade_no: localOrder.id,
  title: '软件30天会员',
  amount: 1990, // CNY 1990分，即19.90元；USD同样使用cent
  currency: 'CNY',
  return_url: 'https://你的软件/payment-return',
  expires_in: 1800,
}, { maxRetries: 2 });

// 先把order.id绑定到本地订单，再返回此URL给本软件用户。
const checkoutUrl = payments.checkoutUrl(order);
const current = await payments.getOrder(order.id);
const page = await payments.listOrders({ page: 1, pageSize: 20 });
const canceled = await payments.cancelOrder(order.id);
const refund = await payments.refundOrder(paidOrder.id); // 仅全额，不传amount
```

首次确认 Stripe 时，因为 Stripe Checkout 要求至少 30 分钟有效期，服务端必要时会把订单 expires_at 延长到确认时约 31 分钟，并持久保存；同单重试不继续延长，界面以服务端更新后的期限为准。微信、Epay 和余额不因这条规则延长。支付和退款通过验签回调及后台约 60 秒补查推进，GET API 只读取本地可靠状态，不因软件密集轮询向上游重复查询。

这些调用返回 API 的 `data`，与 OAuth SDK 的 `json()` 保留整个 envelope 有区别。`PaymentError` 包含 `code`、`status` 和可用的 `requestId`，不携带上游原始错误或秘密。checkoutUrl 方法验证新收银台 URL 与本次订单和本站 origin 一致。

订单金额上限为 100,000,000 个最小货币单位（即 1,000,000 CNY / USD）；钱包实际可付金额还受 quota 整数上限、余额和汇率校验限制，服务端不会截断价格。

订单创建的幂等键是 `client_id + out_trade_no`，没有单独 Idempotency-Key header。同参数重试返回原订单；同订单号改金额、币种、标题、回跳或有效期返回 409 `PAYMENT_IDEMPOTENCY_CONFLICT`。在本地业务中先持久化这些固定值，重试沿用，不要每次生成新订单号。

SDK 默认不自动重试。创建和只读查询可显式 `maxRetries: 0..3`，仅对网络失败和 429/502/503/504 重试，创建正文保持完全一致。取消和退款不自动重发；结果不确定时查询原订单。SDK 会拒绝退款 options 中的 amount 等未知字段，避免接入方以为申请部分退款而实际退了全额。业务状态 `refunding` 表示退款仍处理中，不能当成退款完成。只支持全额退款，无部分退款或退款到其他账户。

## HTTP 契约

| 方法和路径 | 请求 / 结果 |
| --- | --- |
| POST `/api/payments/orders` | `{out_trade_no,title,amount,currency,return_url,expires_in?}`，新建 201 / 同参数幂等 200 |
| GET `/api/payments/orders?page=1&page_size=20` | `{items,total,page,page_size}`，仅自己应用 |
| GET `/api/payments/orders/:id` | 指定订单，仅自己应用；不存在和越权都为 404 |
| POST `/api/payments/orders/:id/cancel` | 无 body，仅取消尚未启动支付的 pending；重复 canceled 幂等 |
| POST `/api/payments/orders/:id/refund` | 无 body，全额退款；重复 refunded 幂等，不支持渠道明确拒绝 |

用户自己的付款订单页为 `/payments/orders`。

成功结构 `{success:true,data:...}`；失败为适当 HTTP 4xx/5xx 及 `{success:false,code,message}`。Order 字段为 `id,client_id,out_trade_no,title,amount,currency,status,payment_method,payer_user_id,created_at,updated_at,expires_at,paid_at,refunded_at,return_url,checkout_url`，时间为 Unix 秒，尚未发生的时刻为 0。状态包括 `pending,processing,paid,canceled,expired,refunding,refunded,failed`。订单只属于创建它的应用，不因同一软件用户使用另一个应用就可查询。

## 验证通知与可靠发货

通知 payload 为 `{id,type,created_at,data:Order}`，当前事件 `payment.paid`、`payment.refunded`；通知里的订单快照可以省略 `checkout_url`，发货不依赖此 URL。请求头：

```text
NewAPI-Webhook-Id: 稳定事件ID
NewAPI-Webhook-Timestamp: 本次投递Unix秒
NewAPI-Webhook-Signature: v1=十六进制HMAC-SHA256
```

签名原文为 `timestamp + '.' + HTTP原始body字节`，密钥为该事件对应的 webhook secret。不要用 JSON.parse 后再 JSON.stringify 的结果验签，空格、编码和换行也是签名的一部分。

```js
import { verifyPaymentWebhook } from './sdk/oauth-client/payments.mjs';

const event = verifyPaymentWebhook(rawBodyBuffer, request.headers, {
  secrets: [process.env.WEBHOOK_SECRET_CURRENT, process.env.WEBHOOK_SECRET_PREVIOUS]
    .filter(Boolean),
});
const order = await payments.getOrder(event.data.id);
// 核对签名事件、服务端查单与软件本地订单三者：
// client_id、id、out_trade_no、amount、currency，以及真实paid/refunded状态。
// 在同一个数据库事务中：唯一event.id记录 + 订单状态 + 开通/撤销权益。
// 事务提交后才返回2xx，失败返回非2xx让平台重投。
```

SDK 使用常量时间签名比较，默认接受前后 5 分钟时钟偏差，签名成功后核对 header 事件 ID 与签名 body.id 一致。可以传一个 `secret`，或最多 8 个 `secrets` 支持轮换过渡；不能两者同时传。校验时间依赖接收服务器时钟同步。

事件投递是至少一次。每次重投时间戳重新签名，事件 ID 和事件原始创建时间不变；重复 event ID 不得再次发货。应用必须持久化唯一事件记录，不能只用进程内 Map。平台失败重试从 30 秒开始指数退避，间隔最多 6 小时，最多 20 次，之后由管理员人工重投；事件保留供排查。管理接口为 `GET /api/payments/applications/:client_id/events` 和 `POST /api/payments/applications/:client_id/events/:event_id/retry`，它们属于 Root 管理流程，不使用 Basic 应用 SDK；重投也可通过 `app_payment.retry_webhook` 托管操作完成。每个事件保存生成时的通知地址和加密密钥快照，轮换只影响新事件，旧事件仍按旧地址与旧密钥重投，应保留旧密钥至旧事件完成或人工处置。

支付通知可能晚于退款通知；软件处理 `payment.paid` 时重新查到 refunded，就不要开通权益。退款通知完成后，晚到的旧 paid 通知也不能恢复权益。付款人 ID 是 New API 账号，不能直接把它当作软件本地账号；本地创建订单时绑定的软件用户才是权益归属依据。

## 余额故障恢复与发布运维

余额付款使用数据库操作记录与 Redis 永久操作标记协调。`cache_pending` 只有在永久 Redis 操作标记能够证明该次变更已执行时，后台才自动提交后续数据库步骤；如果缺少标记，执行结果不确定，不会根据猜测补扣。`wallet mutation` / `unsafe` 状态会跨实例阻止该用户继续发起外部余额付款，避免不同实例分别使用不一致余额。

遇到这类状态，应保留数据库和 Redis 快照，对照操作 ID、订单状态、缓存余额、已发生的模型消费和钱包变更核对后人工处理。不能通过删除 guard、unsafe 或操作标记强行恢复支付，也不能把旧数据库余额直接写回 Redis；这可能重复扣款或恢复已经消费的额度。全局一致性 epoch 缺失时不会自动重建并假定缓存可靠，需要先核实发生了何种 Redis 丢失或恢复。

这些故障处理不要求常规模型请求每次查询数据库：模型余额热路径仍在同一次 Lua 中执行约束，没有新增每次模型调用的数据库往返。涉及余额故障处置时，应保存数据库和 Redis 状态以便核对。本轮发布已保存 MySQL 数据库备份及运行配置，未另行制作 Redis 快照；应用版本切换只重载 New API 服务，保留 MySQL、Redis 和其他服务。具体已发布版本、备份与健康证据以完整中文总文档的发布记录为准。

## 可运行的软件会员示例

`examples/payment-server.mjs` 提供一个单用户软件演示，登录后购买固定 19.90 元 / 30 天会员。`examples/membership-store.mjs` 使用 SQLite 持久化本地订单、事件、权益和会话，数据库事务保证重复通知不会重复开通。它是完整接入示例，不替代你的正式商品、用户、续费和授权系统。

先登记与 `PAYMENT_DEMO_ORIGIN` 完全一致的 `/payment-return` 回调，并把公网 HTTPS `/payment-webhook` 配为应用 webhook。示例仅监听 loopback；真实通知需要你已有的 HTTPS 反向代理转发到它。不要将 webhook 指向生产业务来测试假订单。

```sh
export NEW_API_ORIGIN='https://你的NewAPI域名'
export NEW_API_CLIENT_ID='机密应用client_id'
# NEW_API_CLIENT_SECRET、NEW_API_PAYMENT_WEBHOOK_SECRETS由私密环境注入。
# 多个 webhook key 使用逗号分隔，新旧key都需保留到旧事件完成。
export PAYMENT_DEMO_ORIGIN='https://你的软件示例域名'
# PAYMENT_DEMO_LOGIN_PASSWORD设为至少12字符的演示登录口令。
export PAYMENT_DEMO_DATABASE='./payment-demo.sqlite'
node sdk/oauth-client/examples/payment-server.mjs
```

该示例的回跳页面不依据 URL 中的 paid/status 参数发货；只有签名通知和服务端查单通过、SQLite 事务提交后，会员才生效。下单价格固定在服务端，重试只恢复当前本地用户自己的原订单。示例会员期限从核验的 `paid_at` 起算 30 天，多次独立购买产生独立权益，不实现顺延续期。

## 测试和接入检查

```sh
node --test sdk/oauth-client/test/*.test.mjs
```

SDK 契约测试覆盖 Basic 边界、幂等同正文重试、金额与订单 ID 校验、取消/全额退款 API、签名原始字节、防 header/body ID 替换、时钟窗口、多密钥过渡、持久化事务发货、金额/币种/应用隔离以及乱序退款。全部测试使用合成凭据、本地网络 fixture 和可丢弃 SQLite；没有真实商户扣款。

真实 HTTP 验收脚本为 `sdk/oauth-client/examples/verify-payments-isolated.mjs`，运行者应先启动空白、可丢弃、未初始化的本地 New API 实例并关闭后台流量：

```sh
NEW_API_TEST_URL=http://127.0.0.1:3199 \
NEW_API_TEST_REPORT=/tmp/new-api-payment-http.json \
node sdk/oauth-client/examples/verify-payments-isolated.mjs
```

脚本会创建临时 Root、用户、测试额度与收款应用，验证真实 Basic、跨秒订单幂等、真实会话确认、一次扣款、一次全额退款、订单隔离和事务事件。通知目标固定为 `https://localhost/events`，被服务端投递 IP 防护拒绝，不能有真实通知送达。脚本禁止生产默认端口并拒绝已初始化实例；结束后由运行者销毁整个测试实例和数据。
