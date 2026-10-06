# New API OAuth 外部客户端 SDK

零依赖 ES 模块，使用标准 `fetch`、Web Crypto、Web Streams。在 Node.js 22.13+ 和支持这些 API 的现代浏览器中使用。它提供全路由通用请求入口，不重复维护数百个容易漂移的业务包装函数。`profit.mjs` 精确复用现有金融页算法。

应用收款另有服务端入口 `payments.mjs`（包导出 `./payments`）：`NewApiPaymentClient` 使用机密应用 Basic 凭据创建、查询、取消和全额退款，`verifyPaymentWebhook` 验证原始通知字节。它依赖 Node crypto，不能打进浏览器包；它也不会使用用户 OAuth token 自动扣款。完整配置、渠道支持、签名通知和持久化会员发货示例见 [应用收款接入文档](../../docs/oauth-full-access/payments.md)。

## 最快跑通外部授权

1. 站点管理员在 New API 启用 OAuth 提供方，设置公网 issuer，例如 `https://你的站点/oidc`。
2. 注册客户端；勾选它确实允许申请的具体 scopes。客户端配置不能保存 `full`，授权请求中的 `full` 会展开为当次具体权限快照。
3. 给示例注册两个精确回调：`http://127.0.0.1:8787/callback` 和 `http://127.0.0.1:8787/action-callback`。
4. 在仓库根运行：

```sh
export NEW_API_ISSUER='https://你的站点/oidc'
export NEW_API_CLIENT_ID='你注册的client_id'
node sdk/oauth-client/examples/server.mjs
```

机密客户端另外从服务端密钥存储注入 `NEW_API_CLIENT_SECRET`。公共客户端不设置 secret。示例默认请求 `openid profile email full offline_access`；可通过 `NEW_API_SCOPES` 改成明确列表。浏览器打开 `http://127.0.0.1:8787`，点击授权，登录本站并明确同意。

这个示例使用服务端内存保存令牌，浏览器只有 HttpOnly、SameSite=Lax 会话 cookie，登录后轮换会话 ID，写操作带 CSRF 防护。重启示例会失去本地会话；生产应用请换成可靠的加密令牌存储和可原子消费的授权事务存储。示例本身不是另一个完整后台界面；它展示完整授权、能力目录、敏感操作回跳和撤销链路。

## 创建客户端与授权

```js
import { NewAPIOAuthClient, sessionTransactionStore } from './index.mjs';

const client = new NewAPIOAuthClient({
  issuer: 'https://你的站点/oidc',
  clientId: '已注册client_id',
  redirectUri: 'https://你的客户端/callback',
  // 浏览器顶层跳转会重新加载页面，需要保存短期 state/PKCE 事务。
  transactionStore: sessionTransactionStore(),
});

const { url } = await client.beginAuthorization({
  scopes: ['openid', 'profile', 'offline_access', 'profile:read', 'relay:read', 'relay:invoke'],
});
location.assign(url);
```

在回调页面重新创建相同配置的客户端并调用：

```js
await client.completeAuthorization(location.href);
history.replaceState({}, '', '/'); // 删除地址栏中的授权码与 state。
const capabilities = await client.capabilities();
const routes = await client.routes();
const operations = await client.operations();
```

SDK 使用 S256 PKCE、随机 `state` 和 `nonce`，在交换授权码前原子消费事务并校验回调地址、issuer、客户端及十分钟有效期。`openid` 请求必须返回可验证的 ID token；SDK验证 RS256 签名、JWKS、issuer、audience、时间、nonce 和可选 `at_hash`。不能把 ID token 当作业务 access token。

`MemoryTransactionStore` 适合单进程服务端示例；多实例生产环境应实现 `set(key,value)`、原子 `take(key)`，例如 Redis GETDEL，且将事务绑定本应用用户会话。`sessionTransactionStore` 只保存短期授权事务，不保存令牌。`onTokens(tokens)` 用于应用自行安全持久化轮换后的令牌；不要在日志里输出参数。

## 普通 API、上传、下载

```js
const ownAccount = await client.json('/api/user/self');
const health = await client.json('/api/group-availability?range=24h');

// 修改操作不会在 HTTP 401 后自动重放。
await client.json('/某个已授权业务接口', {
  method: 'POST',
  json: { /* 该接口的真实业务字段 */ },
});

const form = new FormData();
form.append('file', audioFile, 'audio.wav');
form.append('model', '已可用的转写模型');
const transcription = await client.json('/v1/audio/transcriptions', {
  method: 'POST', body: form,
});

const file = await client.request(`/v1/videos/${encodeURIComponent(taskId)}/content`);
const blob = await file.blob();
```

`json()` 保留原接口响应形状，例如 `{success,data}`，不会自动剥离 `data`。它检查 HTTP 错误和 `success:false`，错误类别在 `error.code`，HTTP 状态在 `error.status`，原响应仅在 `error.details`，不要直接把原错误对象呈现给非管理员。`request()` 返回原始 `Response`，用于文件或其他格式。上传 `FormData` 时不要自行设置 Content-Type，浏览器会产生正确 boundary。

所有带凭据的请求限定配置的 New API 同一 origin，拒绝重定向，省略浏览器 cookie。SDK不注入 `New-Api-User`；身份来自 access token。权限目录见 `docs/oauth-full-access/routes.json` 和在线 `/api/oauth2/routes`。OAuth可用并不代表目标上游实现了该模型或业务格式。

普通读取会按授权边界隐藏秘密字段，不能依靠 `full` 获得完整渠道配置或独立凭据。需要完整配置时，使用下面的固定托管操作，由本人在本站再验证并明确决定是否共享。支付回调和登录证明继续使用原协议；它们不接受普通业务令牌代替付款签名或用户验证。

## SSE 与 WebSocket

```js
const abort = new AbortController();
for await (const event of client.events('/v1/chat/completions', {
  method: 'POST',
  json: { model: '已可用模型', messages: [{ role: 'user', content: '你好' }], stream: true },
  signal: abort.signal,
})) {
  if (event.data === '[DONE]') break;
  const payload = JSON.parse(event.data);
  // 依实际协议更新界面。
}

const socket = await client.connectRealtime('已可用实时模型');
socket.addEventListener('message', (event) => {
  const payload = JSON.parse(event.data);
});
```

SSE通过fetch携带Bearer；解析器处理跨块UTF-8、LF/CRLF/CR、事件名、ID、多行data、心跳注释及取消，不把截断事件误当完成。调用者负责理解具体OpenAI/Claude/Gemini事件语义；SDK不把“连接结束”伪装成模型成功。

浏览器WebSocket先用Bearer调用 `POST /api/oauth2/relay-ticket`，再使用返回的一次性票据协议 `openai-insecure-api-key.nao_ws_…` 建立 `/v1/realtime`。有效期60秒、一次消费；长期 access token 不放在URL或WebSocket协议字符串里。模型与分组权限继续由原中转链路检查。非浏览器客户端也可沿用服务器支持的标准Authorization头。

撤销授权后拒绝新请求；已建立的SSE/WebSocket不会逐frame检查撤销，本版不保证立即中断正在进行的连接。客户端退出时应主动关闭自身连接。

## 刷新与撤销

```js
await client.refresh();
await client.revoke();
```

业务access token有效期15分钟；申请并同意 `offline_access` 时返回轮换refresh token，授权最长30天。SDK在已知access即将过期时先刷新，并在单个客户端实例内合并并发刷新。多个进程共享同一refresh token时，应用必须做跨进程互斥。

refresh不能改变scope。要缩权，请走本站授权管理；要新增权限，重新发起授权。旧refresh一旦成功使用就不能重放；网络失败时无法知道服务端是否消费，SDK清理本地令牌并要求重新授权，不自动重试。撤销清理本地状态并在服务端撤销对应授权；如果网络失败，SDK报告错误，不能把“本地退出”显示成“服务端撤销成功”。已发出的模型请求和已复制的数据不会因本地退出而自动撤回。

## 本站托管敏感操作与回跳

```js
const action = await client.startHostedAction('实际登记的operation', {
  // 仅固定对象参数，例如 token id；密码、MFA验证码由本站页面采集。
}, {
  returnUri: 'https://你的客户端/action-callback', // 必须精确注册。
  shareResult: false,
});
// 将 action.receipt_token 保存在当前应用会话，不放进 URL。
window.open(action.approval_url, '_blank', 'noopener,noreferrer');

const result = await client.waitForHostedAction(action.action_id, {
  receiptToken: action.receipt_token,
  signal: abort.signal,
});
```

本站操作完成后，用户可以通过页面按钮回到已注册return URI。回调只包含 `action_id`、`status`、`state`，客户端调用 `completeHostedCallback(location.href)` 单次验证 state，再从服务端查询结果；不能信任URL中可伪造的status。也可不用回跳，保留原窗口轮询。receipt token仅短期读取该操作的最小完成状态，不能恢复已撤销的业务授权；这样修改密码等导致原grant失效后，仍可显示该操作结果。

动作和receipt在5分钟时逻辑过期。领取成功立即清空结果密文；未领取的过期数据库行由每小时清理任务删除。

完整密钥确实需要外发时，仅明确支持的 `apikey.reveal`、`apikey.reveal_batch`、`channel.key.reveal`、`channel.config.reveal` 可请求 `shareResult:true`。用户必须本站再验证并明确确认共享，然后在短期内用当前有效OAuth与receipt token执行：

```js
const secretResult = await client.claimHostedResult(action.action_id, action.receipt_token);
```

非秘密结果也可按相同方式领取：sessions.list、oauth_grants.list返回安全列表，app.create和oauth_client.create仅返回裁剪后的app/client元数据，不含生成的客户端secret或遥测密钥。审批页用result_kind区分data/secret/receipt。

该结果只领取一次，不能自动重试；只在业务确实需要时保存。OAuth撤销可以阻止未来领取及授权派生凭据继续使用，但不能收回外部已经复制的原有API key或渠道key；要撤回这些凭据，必须独立撤销或轮换原密钥。密码、MFA种子、浏览器会话不会返回给外部客户端。

## 利润计算与测试

详见 `docs/oauth-full-access/profit.md`。它是本地算法，不调用账户、余额或上游。

```sh
node sdk/oauth-client/scripts/update-profit.mjs --check
node --test sdk/oauth-client/test/*.test.mjs
```

此测试集使用本地固定数据与mock网络，覆盖SDK安全/协议行为和利润算法一致性。它不代表全部业务controller或真实支付/上游已经端到端验收。项目沿用QuantumNous / New API 原许可证；见仓库LICENSE。

真实 HTTP 验收脚本为 `examples/verify-isolated.mjs`，必须由部署验收流程先启动全新、可丢弃的 loopback 实例并禁用后台流量，再从仓库根执行：

```sh
go run ./docs/oauth-full-access/generate
NEW_API_TEST_URL=http://127.0.0.1:3198 \
NEW_API_TEST_REPORT=/tmp/new-api-sdk-http-acceptance.json \
node sdk/oauth-client/examples/verify-isolated.mjs
```

脚本拒绝生产默认端口、已初始化数据库和已存在 root 的实例，会创建临时用户、配置 OAuth 服务及注册临时应用。它执行真实 PKCE / 同意 / ID token / 刷新 / 本站确认 / 单次结果领取 / 撤销流程，并将在线 capability、路由授权规则、托管操作参数和步骤与重新生成的目录逐项比较。没有模型付费请求；不能把它指向生产数据库，也不要与其他初始化脚本同时运行。结束后由运行者销毁该测试实例及其数据库。
