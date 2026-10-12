# New API OAuth 全功能开放平台完整中文文档

文档日期：2026-10-04（北京时间，19:32:42当前发布验收完成）。项目为 QuantumNous / New API。

OAuth 全功能开放平台与为外部软件收款的应用支付功能已上线。当前镜像为 `new-api:playground-markdown-fix-20261004`，当前源码为 `/srv/new-api/playground-markdown-fix-20261004/source`，部署时间为北京时间2026-10-04 19:32:39。本轮修复操练场长回复、代码与公式的Markdown渲染；此前附件、搜索、参数、真实用量、浏览器历史、OAuth与应用收款功能保持。本机与公网协议、页面与最终资源哈希验收通过；issuer 保持 `https://ai.example.com/oidc`。

2026-10-03支付版本新增应用订单、用户确认收银台、余额与已适配渠道直付、全额退款、持久通知与服务端 SDK，完整接入见第 17 节。平台使用统一商户，没有分账或商户提现。上线时尚未配置外部支付渠道，余额流程和渠道模拟验收已通过，不能据此认定真实商户扣款到账或退款已实测。Root 仍需为具体机密客户端启用收款并配置通知地址和付款方式。

本版继承 `availability-invalid-request-20261003` 的分组健康修订，以及 `oauth-complete-20261003` 的完整 OAuth、渠道诊断脱敏和 PostgreSQL 兼容修复。上一生产源 `/srv/new-api/playground-complete-20261004/source` 保留，支持同一操练场历史格式、OAuth及应用支付；第11节同时保留更早版本的回退限制。后续维护与构建使用当前发布源码，不能把 `/projects/new-api` 中其他工作内容当成本次发布。

## 1. 这套功能解决什么问题

外部自有网站、桌面或移动客户端、第三方应用，可以通过 OAuth 代表已授权用户使用 New API 的现有业务能力。普通用户只能操作自己有权访问的数据；管理员、受限管理员、超级管理员继续服从原来的角色、对象归属和渠道细分权限。渠道信息保持管理员范围，普通用户仅能读取自己被允许的分组健康聚合。

“全量”表示每条现有服务入口都有明确的外部使用方式和授权规则。外部使用路径分为：直接 OAuth API、本站托管敏感操作、原有公开入口、保留自身签名或证明的协议入口，以及基线本就未实现的兼容占位入口。全量覆盖不代表外部应用可跳过本人确认、读取所有秘密字段或调用原本没有实现的功能。支付平台回调仍需其原有付款证明；Passkey、MFA、密码验证由本人在本站完成。

纯前端利润计算也提供零依赖 SDK，和金融页原算法逐结果一致。它不读取或更改真实余额、账单、利润报表。

## 2. 文件、入口和运行条件

| 功能 | 路径 |
| --- | --- |
| SDK 使用说明 | `sdk/oauth-client/README.md` |
| 零依赖 JavaScript SDK | `sdk/oauth-client/index.mjs` |
| 应用收款 SDK | `sdk/oauth-client/payments.mjs` |
| 接入示例 | `sdk/oauth-client/examples/server.mjs` |
| 软件会员收款示例 | `sdk/oauth-client/examples/payment-server.mjs` |
| 利润计算 SDK | `sdk/oauth-client/profit.mjs` |
| 路由及能力目录 | `docs/oauth-full-access/routes.json`、`capabilities.json` |
| 固定托管操作 | `docs/oauth-full-access/actions.json` |
| OpenAPI 授权索引 | `docs/oauth-full-access/openapi.authorization.json` |
| 目录生成器 | `docs/oauth-full-access/generate/main.go` |
| 操练场说明 | `docs/playground/README.zh-CN.md` |

SDK 使用 fetch、Web Crypto 与 Web Streams，不需要额外 npm 依赖。运行环境和私有发布记录由安装方管理。

## 3. 管理员如何启用和注册应用

由超级管理员打开 `/system-settings/auth/oauth-provider`，在 OAuth 提供方设置中启用服务，issuer填写对外可访问的固定地址，例如 `https://你的NewAPI域名/oidc`。发行者必须与客户端配置及发现文档完全一致。反向代理应把 `/oidc/*`、`/api/oauth2/*` 和业务API路由转发到同一站点。已启用客户端登记回调的Web origin可跨域调用API，使用Bearer且不带cookies，CORS覆盖PATCH与支持的模型SDK自定义headers；任意未登记来源不会自动获准。

超级管理员创建客户端时配置名称、用途、精确回调地址、公共或机密类型、允许申请的具体scope以及是否启用。自有应用与第三方应用使用同一套权限执行逻辑，没有通过“自有”标签绕过用户同意或角色检查。

客户端配置约束：

- 回调仅HTTPS，或localhost、127.0.0.1、[::1]的HTTP开发回调；不支持自定义app scheme。
- 回调精确字符串匹配，拒绝fragment、URL凭据、wildcard和控制字符；每项最多2048字节，最多32项。登记query不能预带code、state、error、error_description、error_uri、iss等协议保留参数。
- 公共客户端没有可以保密的client secret；浏览器、桌面和移动应用不得把内置secret当保密凭据。
- `is_public`创建后不允许变更；要切换类型，应创建新客户端。
- 客户端保存具体scope列表，最长8192字节；`full`只用于授权请求，不能保存成客户端永久通配scope。
- 禁用客户端或减少任一允许scope，会在同一数据库事务中永久撤销它现有的全部授权；重新启用或加回scope不会复活旧授权。仅增加scope不会自动给既有授权增权。
- 机密客户端的secret只在创建/重置时返回，数据库保存验证值。外部服务从私密环境或密钥管理服务加载，不能写进仓库或浏览器。

浏览器或桌面应用如需系统浏览器回跳，可使用已注册HTTPS回调或精确loopback地址。本版未实现任意自定义scheme和动态loopback端口通配，接入前必须选择支持的回调形式。

## 4. OAuth 协议契约

发行者发现地址为 `/oidc/.well-known/openid-configuration`，JWK公钥地址为 `/oidc/.well-known/jwks.json`。

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/oidc/authorize` | GET | 校验授权请求并进入本站登录/同意页面 |
| `/oidc/token` | POST | 授权码换令牌、refresh轮换 |
| `/oidc/revoke` | POST | 服务端实际撤销授权令牌族 |
| `/oidc/userinfo` | GET / POST | 读取已同意的OIDC身份资料，要求openid |
| `/api/oauth2/capabilities` | GET | 当前账号能力目录、当前授权scope与资源 |
| `/api/oauth2/routes` | GET | 当前角色可见路由与授权元数据 |
| `/api/oauth2/grants` | GET | 本站已授权应用管理，要求真实登录会话 |
| `/api/oauth2/grants/:id` | PATCH / DELETE | 本站缩权或撤销，外部通过托管动作完成 |
| `/api/oauth2/relay-ticket` | POST | 以有效OAuth换取浏览器实时连接一次性票据 |
| `/api/oauth2/operations` | GET | 读取当前授权可用的固定操作、参数与步骤目录 |
| `/api/oauth2/actions` | POST | 外部创建本站托管动作 |
| `/api/oauth2/actions/:id` | GET | 当前OAuth或仅该动作receipt token查询状态 |
| `/api/oauth2/actions/:id/claim` | POST | 有效OAuth和receipt token一次领取明确共享的密钥结果 |

所有客户端包括机密客户端都使用授权码＋PKCE S256。授权请求包含 `response_type=code`、`client_id`、`redirect_uri`、`scope`、随机state、`code_challenge`、`code_challenge_method=S256`；请求OIDC时带nonce。回调带issuer用于混淆攻击检测。授权码单次使用，必须与同一client、redirect URI、PKCE verifier匹配。

`/token`和`/revoke`只接受 `application/x-www-form-urlencoded`，请求体最多64KiB；拒绝URL query、重复单值参数和Basic/body混合客户端认证。public client只发body client_id，不发client_secret。机密客户端支持标准Basic或body方式；SDK使用client_secret_post。`resource`可多值，只接受：

- `urn:new-api:dashboard`：管理与用户业务API。
- `urn:new-api:relay`：模型读取、调用与任务能力。

省略resource时当前默认请求dashboard与relay两个资源；实际可执行操作仍受具体scope限制；令牌不能因更换URL自动获得其他受众权限。access token是专用opaque随机凭据，前缀 `nao_at_`，refresh前缀 `nao_rt_`。错误或过期OAuth凭据不会降级尝试旧PAT或API key。

业务access token有效期15分钟；只有同意offline_access才发refresh token。授权有效期最长30天。refresh每次原子消费旧token并产生新对；旧refresh重放撤销其对应令牌族。refresh不支持改scope或resource；缩权通过管理流程并使旧凭据失效，之后重新授权；增权也必须重新同意。数据表仅存token的SHA-256验证值，不存raw access/refresh。

OIDC ID token用于客户端验证登录身份，不能用来调用业务API。SDK校验RS256签名、可信JWK、issuer、audience、exp/iat/nbf、nonce及可选at_hash；申请openid而缺IDtoken时拒绝。

## 5. “授权全部”的准确含义

授权请求可用 `full` 作为当次展开指令。最终保存的是用户此刻权限、应用允许范围、所选scope和资源的明确快照。普通用户同意full不会得到管理员能力；账号之后升为管理员或系统增加新scope，既有授权不会自动扩张。

能力目录包括身份资料、个人设置、API key、使用量、钱包、账号安全、OAuth授权、模型中转、用户、财务、模型/供应商、部署、全站日志、兑换码、分组、应用中心、渠道、系统设置、OAuth客户端和运维。以机器文件 `capabilities.json` 的实际条目为准，不通过英语标签猜权限。

入口鉴权会重新检查grant、client、user状态，以及用户认证版本、角色/分组/密码相关指纹和客户端配置版本。禁用、降权、分组变化、关键认证资料变化或客户端配置变更后，旧授权可能整体失效并要求重新授权，以避免残留权限。各业务controller仍检查对象归属、细分权限、分组、模型、余额与额度。OAuth渠道细分权限从当前Casbin数据库状态重新核对，撤权无需等待旧权限缓存自然过期。channel:read读接口会移除header_override、param_override、setting/settings、other/other_info、base_url等可能嵌入上游凭据的完整配置字段；完整配置通过Root的channel:secret_view与本站channel.key.read再验证，执行channel.config.reveal并按秘密结果一次领取。

本版继承的渠道诊断限制：余额查询和连通性测试失败只返回固定错误、错误码及必要耗时；不转发可能夹带凭据的 URL、覆盖参数或上游原始错误。高级自定义余额只接受标准 `credit_summary.total_available` 数字，未知 JSON 明确返回 `channel_response_not_supported`。Codex 用量、额度和重置返回已知字段及类型，保留合法的零值和 false；未知字段、自由文本、账号标识和原始正文只在本站原诊断流程处理。上游重置已返回 2xx 但正文未知时，外部收到成功和空数据，避免误判失败后重复消耗额度。需要新的 provider 扩展字段，应先定义安全字段结构；完整渠道配置仍通过 `channel.config.reveal`，不能借诊断响应领取任意秘密。该修订已随 `oauth-complete-20261003` 上线，验收证据见第 11 节。

能力查询返回目录版本、可用capabilities、当前OAuth的granted_scopes及resources。路由查询返回method、精确Gin路由path、scope、resource、mode、min_role、description。目录不是“按前缀放行”；新路由缺少明确规则会拒绝OAuth，并由覆盖测试提示补全。

## 6. 路由覆盖与已存在的限制

2026-10-03支付版本生成、当前版本沿用且未新增路由：46 项 capability、460 条 method＋path 路由，以及 44 个固定托管 operation。路由分类为 direct 331、hosted 39、protocol 55、public 23、compatibility 12。相较早期OAuth目录，支付版本新增16条支付路由和3个管理托管操作；本轮操练场没有新增路由，验证范围见第11节。路由数、操作数和用户可用功能数不是同一个概念：一个操作可能包含多步和多个路由；普通用户只能看到自己的角色可用子集。全部名单见 `capabilities.json`、`routes.json`、`actions.json`；路由与真实 Gin 注册继续通过双向覆盖测试核对。

| mode | 含义 | 外部完成方式 |
| --- | --- | --- |
| direct | 接受有相应scope/资源的OAuth访问令牌 | 使用现有业务参数、响应结构和计费；秘密字段按授权边界脱敏 |
| hosted | 必须本人在本站确认或验证 | 创建托管动作，本站完成，回跳/查询结果 |
| protocol | 原有登录、签名、回调、授权协议等 | 通过原协议完成，不以OAuth伪造证明 |
| public | 原有公开入口 | 保持原公开协议与限流 |
| compatibility | 基线已有未实现占位接口 | 维持原未实现响应，不宣称已新增功能 |

12个compatibility主要是旧OpenAI文件、fine-tune、图片变体等占位路由。OAuth授权不会使原本未实现的上游功能突然可用。完整列表可直接筛 `routes.json` 中 `mode=compatibility`。

OpenAPI文件是全路由授权索引，包含scope/resource/mode/角色及原Gin路径。它不是全部业务的完整新 DTO 模型；已有请求/响应schema仍见原 `docs/openapi/api.json` 和 `relay.json`，缺少细化schema的索引明确标记 `x-payload-schema-status`。SDK的generic fetch入口能调用这些业务，但接入方仍需遵循实际controller参数。

## 7. 自有客户端与第三方接入

最小可运行外部客户端在 `sdk/oauth-client/examples/server.mjs`。先注册两个回调：

```text
http://127.0.0.1:8787/callback
http://127.0.0.1:8787/action-callback
```

在源目录运行：

```sh
export NEW_API_ISSUER='https://你的站点/oidc'
export NEW_API_CLIENT_ID='已注册client_id'
node sdk/oauth-client/examples/server.mjs
```

机密客户端额外通过私密环境注入secret；公共客户端不需要。示例默认申请 `openid profile email full offline_access`。在浏览器访问loopback8787，点击授权，在本站登录并确认。完成后示例展示当前能力和可见路由，支持托管动作回跳、结果读取与撤销。

示例令牌仅存服务端内存，浏览器页面不展示token。会话cookie为HttpOnly/SameSite=Lax，HTTPS时加Secure；授权成功轮换会话ID，写请求验证Origin和CSRF，页面禁止外部脚本、frame嵌入与引用泄漏。示例是接入流程演示，不是第二套完整产品后台。生产应用需加可靠会话、加密持久化、跨实例refresh互斥、业务界面及自己的审计。

浏览器SPA可使用SDK的 `sessionTransactionStore()` 保留短期PKCE/state事务。不要把access/refresh硬编码、打印进控制台或作为URL参数。SDK默认仅内存保存token；应用自行通过onTokens安全持久化。独立用户必须独立客户端实例/事务空间，不能全站共享一个授权状态。

## 8. 业务API、模型首字与多种传输

普通API使用 `Authorization: Bearer nao_at_...`。无需另传New-Api-User；身份由授权确定。原业务返回结构保留。SDK的json方法会识别HTTP错误和success:false；request返回原Response用于下载。任何错误或401之后均不会自动重放写操作或模型请求，避免重复扣费与重复执行。

SSE使用fetch而非无法设Bearer头的EventSource。解析器支持UTF-8拆块、CR/LF/CRLF、多行data、event/id、心跳注释、取消，遇到截断末事件会丢弃而不是误报完成。调用者按实际模型协议处理DONE、完成状态、错误与usage。

浏览器实时WebSocket先向 `/api/oauth2/relay-ticket` 申请60秒一次性票据，然后连接同站 `wss://.../v1/realtime?model=...`，协议为 `realtime` 和返回的 `openai-insecure-api-key.nao_ws_...`。票据仅绑定GET `/v1/realtime`，不赋予其他路径权限；模型选择仍受当前用户模型/渠道约束。长期OAuth token不出现在URL或WebSocket子协议中。

multipart上传直接将FormData交给fetch，不能手动拼Content-Type boundary。下载读取Response.blob/arrayBuffer或stream。异步任务按原任务ID与归属轮询结果；不把任务提交成功当作最终任务完成。SDK示例见README。

OAuth校验发生在请求入口，不逐SSE片段请求远程OAuth服务器。撤销后拒绝新请求；已经建立的SSE/WebSocket不逐frame检查撤权，本版不承诺立即中断存量连接。模型调用映射到本grant的真实内部计费token，使用现有分组、配额、余额、预扣费、结算、并发和日志链路。OAuth不会创造余额，也不会绕开渠道权限。首字延迟仍主要取决于原网关和上游，这次认证改造不宣称未测量的提速幅度。

## 9. 密钥派生、敏感动作及不可逆边界

外部创建的派生API key绑定原grant。后续每次调用重新核对授权状态和scope，不能借助派生key摆脱OAuth撤销；model/IP/group等限制仍按原token字段生效。grant内部用于计费的token不应作为用户可复制的全局凭据。属于当前grant的派生API key可通过原key读取API直接取回；原有独立key必须走明确共享的本站托管流程，不能借派生key接口导出。

敏感动作通过固定operation目录登记，并绑定用户、client、grant、认证版本、操作与固定参数摘要。外部只传声明过的对象参数；本站收集密码、MFA验证码、Passkey响应等。批准和步骤执行要求真实本站会话与动作nonce，不能用伪造SessionID代替登录。首次建立本地MFA/Passkey允许受限bootstrap流程，依据新近本站OAuth登录会话；这不等于强制第三方身份提供商重新验证身份，也不能用于查看密钥或其他操作。

典型操作包括修改密码、MFA设置/关闭/恢复码、Passkey登记/删除、邮箱和第三方绑定、会话撤销、完整API key或渠道key查看、管理员账号安全操作、OAuth客户端与授权管理、应用中心密钥等。MFA初次设置的secret/二维码/恢复码只在本站当前页面内存展示，刷新后丢失时应重新发起配置。动作若停留running且遇到进程或数据库故障，执行结果可能不确定，不自动重发步骤；先查询实际业务状态，再决定是否创建新动作。具体operation与必填参数以 `/api/oauth2/operations` 及 `actions.json` 固定注册目录为准，SDK不接受任意URL当敏感操作代理。

创建动作请求：

```json
{
  "operation": "apikey.reveal",
  "parameters": {"id": 123},
  "share_result": true,
  "return_uri": "https://已注册客户端/action-callback",
  "state": "客户端本次随机值"
}
```

响应返回action_id、approval_url、expires_at和receipt_token。receipt_token仅用于该动作短期最小状态读取，不能调用其他业务；修改密码或MFA导致原grant失效后，仍能告诉外部用户操作已完成。动作及receipt在5分钟时立即逻辑过期，不再允许查询/执行/领取。领取成功会通过CAS立即清空结果密文；未领取的过期行由每小时清理任务物理删除，最多约一小时后从表中移除。不能把逻辑到期时间写成物理删除时刻。

回跳URI必须精确注册，state最多512字符。本站完成按钮只带action_id、status、state回去，秘密不放URL。SDK验证单次state与原action，再服务端查询真实状态，URL中的status仅是展示提示。无需回跳也可轮询。

明确请求外发完整密钥时，`apikey.reveal`、`apikey.reveal_batch`、`channel.key.reveal`、`channel.config.reveal` 支持share_result。非秘密类型结果还支持 `sessions.list`、`oauth_grants.list`、`app.create`、`oauth_client.create`：前两者为安全列表，后两者分别只返回经裁剪的app/client元数据，排除token、client_secret和telemetry等密钥，便于外部拿到ID继续管理。审批元数据result_kind区分secret、data或receipt，其他动作仅返回完成凭据。用户在本站再次验证并确认共享后，结果短期AES-GCM加密保存；外部用有效OAuth＋receipt token执行一次claim，CAS防重复领取。撤销后的grant不能领取。

已经被外部应用复制的原有API key或渠道key无法靠OAuth撤销收回；必须独立撤销/轮换原key。敏感操作本身、已经完成的付费调用和已经下载的数据同样不能靠“撤销授权”撤回。应用应只在业务必要时请求reveal，明确告知持久性。

## 10. 数据库、迁移与运维

新增持久化结构包括oauth_grants、oauth_access_tokens、oauth_refresh_tokens、oauth_actions与oauth_relay_bindings；实时短票据复用短期授权流程存储。已有oauth_clients扩展具体scope存储及回调规则，旧openid/profile/email配置仍能保留身份登录用途；旧身份JWT访问令牌升级后不再接受，需要一次重新授权；新OIDC协议及RS256 ID token继续支持。旧oauth_provider.access_token_ttl_minutes配置保留，只控制ID token寿命，业务access token固定15分钟。

迁移沿用GORM；SQLite、MySQL与PostgreSQL都已实际验证。验证时修复了基线SQLite金融decimal表二次迁移解析失败，以及新OAuth hash唯一索引在PostgreSQL上的重复DDL问题；金融金额与旧账号/普通token数据保留。部分旧表仍可能被旧ORM执行无意义DDL，但完整迁移成功；详细证据见oauth-database-verification.md。row lock使用项目lockForUpdate，SQLite走可用事务/CAS路径；refresh消费、一次claim、撤销与版本变化避免单纯依赖内存。修改密码/角色/状态/分组和禁用应用在令牌校验时检查，避免缓存长期保留旧权限。

本轮三库复验发现 `ChannelInfo` 的数据库 Valuer 返回字节数组，PostgreSQL 驱动 simple protocol 会将其编码为 bytea，导致渠道 JSON 写入失败。已改为返回 JSON 字符串，并保留字符串、字节数组及旧 NULL 的读取兼容性；不新增表或修改生产数据。修复后 SQLite 3.50.4、MySQL 8.4.11、PostgreSQL 18.6 的渠道配置读写与 7 项托管 / 单次领取回归均通过。证据为本轮 `oauth-db-channel-fix-results.json`；修复前 PostgreSQL 失败记录在 `oauth-db-completion-results.json` 中保留，不能将它误作最终结果。

注意保护SessionSecret与数据库备份：托管短期密钥结果的加密依赖服务端密钥；丢失或随意更换会使待领取结果无法解密。授权码、access/refresh、receipt、WS票据、client_secret、API key、渠道key不得进入公开日志、错误页面或测试附件。

发布前应完成应用二进制、前端、SQLite/MySQL/PostgreSQL迁移与权限回归，生成路由目录，并备份数据库及compose/env。运行中的MySQL/Redis不因应用镜像发布重建。OAuth启用配置与应用注册属于站点状态，镜像部署并不意味着已经为第三方创建了客户端。

## 11. 发布、回退与验收

部署前备份应用数据库、配置、签名密钥和 webhook 密钥。程序版本及数据库格式应配套恢复；应用回退不等于撤销 OAuth 授权，也不应覆盖已生成的订单、事件或余额。

SDK 与 HTTP 验收脚本应连接新建的可丢弃实例，使用测试客户端和本地 fixture，避免连接生产数据库或真实支付渠道。部署地址、镜像 ID、证据目录和回滚记录保存在各安装环境的私有发布目录，公开源码不包含个人部署清单。

## 12. 常见问题

**为什么full没有管理员渠道？** 当前账号不是管理员，或应用未被允许申请该scope，或渠道细分权限不允许。full不会提升账号权限。

**为什么修改密码后外部应用掉线？** 关键认证状态变化使旧grant失效是预期行为；托管receipt只读该次完成结果，重新授权后再继续业务。

**为什么refresh失败后要重新授权？** 轮换请求可能已被服务端消费。盲目重试旧refresh会触发重放检测并撤销整族；SDK因此不自动重试。

**为什么接口返回hosted要求？** 该路由需要本站本人确认/再验证。通过固定operation创建动作，再引导用户完成。

**为什么图片变体或files仍未实现？** 这些是原发布版本已有占位接口，OAuth只管理权限，不实现不存在的上游能力。

**为什么无流量分组健康为未知？** 它按真实请求聚合；该时段没有请求时保持未知，不伪造可用性或缓存率。当前规则是至少 1 条可计入可用性的真实请求才参与该时段判定；无效参数、上下文超限等被排除的请求不污染成功率、首字和缓存率，OAuth 读取结果与站内一致。

**是否已经重建一套外部完整前端？** 当前提供开放协议、权限目录、SDK、托管界面和完整接入流程示例；现有New API后台仍是产品界面。完整外部产品可据这些能力开发自己的UI，不能把示例说成第二套后台已全部重做。

## 13. 规范与安全依据

实现参考 [RFC 9700 OAuth 2.0 安全最佳实践](https://www.rfc-editor.org/rfc/rfc9700.html) 的PKCE、精确回调、refresh保护与权限限制，并按 [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) 校验ID token。权限、会话和敏感操作审查参考 [OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/)、[OAuth2 Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)、[Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。这些是设计与审查依据，不意味着本项目获得第三方认证。

## 14. 全部 46 项权限中文索引

此表对应本次生成目录。最低角色只是第一道条件，当前账号权限、客户端允许范围、用户同意、resource 和对象归属必须同时满足。标为敏感的 scope 不一定全部走托管；具体入口依第 6 节路由目录，具体托管操作依下一节。`openid`、`profile`、`email` 是 OIDC 身份 scope，`profile:read` 等是业务 scope，不能混用。

| scope | 中文用途 | 最低角色 | 资源 | 敏感权限 |
| --- | --- | --- | --- | --- |
| `openid` | OIDC 登录身份 | 普通用户 | dashboard | 否 |
| `profile` | OIDC 基本资料 | 普通用户 | dashboard | 否 |
| `email` | OIDC 邮箱 | 普通用户 | dashboard | 否 |
| `offline_access` | 离线刷新授权 | 普通用户 | dashboard | 是 |
| `profile:read` | 读取个人资料、可用模型和分组健康 | 普通用户 | dashboard | 否 |
| `profile:write` | 修改个人资料和偏好 | 普通用户 | dashboard | 否 |
| `api_key:read` | 读取 API key 列表和配置 | 普通用户 | dashboard | 否 |
| `api_key:write` | 管理绑定本应用授权的 API key | 普通用户 | dashboard | 是 |
| `api_key:reveal` | 经本站确认查看完整 API key | 普通用户 | dashboard | 是 |
| `usage:read` | 读取自己的使用量、日志和任务 | 普通用户 | dashboard | 否 |
| `wallet:read` | 读取余额、充值、订阅和邀请信息 | 普通用户 | dashboard | 否 |
| `wallet:write` | 发起付款、购买订阅、兑换和签到 | 普通用户 | dashboard | 是 |
| `account_security:read` | 读取登录方式、MFA 状态和会话 | 普通用户 | dashboard | 是 |
| `account_security:write` | 经本站确认管理密码、绑定、MFA、会话和账号 | 普通用户 | dashboard | 是 |
| `oauth_grants:read` | 经本站确认读取已授权应用 | 普通用户 | dashboard | 是 |
| `oauth_grants:write` | 经本站确认缩权和撤销授权 | 普通用户 | dashboard | 是 |
| `relay:read` | 读取模型和中转凭据用量 | 普通用户 | relay | 否 |
| `relay:invoke` | 调用模型、提交生成任务、SSE 和实时连接 | 普通用户 | relay | 是 |
| `relay:tasks` | 读取和管理自己的生成任务 | 普通用户 | relay | 否 |
| `user:read` | 读取用户资料 | 管理员 | dashboard | 是 |
| `user:write` | 管理用户和账号安全 | 管理员 | dashboard | 是 |
| `billing:read` | 读取财务、充值和订阅 | 管理员 | dashboard | 是 |
| `billing:write` | 管理财务条目、充值订单和订阅 | 管理员 | dashboard | 是 |
| `model:read` | 读取模型、供应商和同步预览 | 管理员 | dashboard | 否 |
| `model:write` | 管理模型、供应商和上游同步 | 管理员 | dashboard | 是 |
| `deployment:read` | 读取部署、日志、基础设施和预估价格 | 管理员 | dashboard | 是 |
| `deployment:write` | 创建、修改、延期、删除部署和测试连接 | 管理员 | dashboard | 是 |
| `log:read` | 按管理权限读取全站使用日志和任务 | 管理员 | dashboard | 是 |
| `redemption:read` | 读取兑换码配置 | 管理员 | dashboard | 是 |
| `redemption:write` | 创建、修改和删除兑换码 | 管理员 | dashboard | 是 |
| `group:read` | 读取分组配置 | 管理员 | dashboard | 否 |
| `group:write` | 管理预填分组配置 | 管理员 | dashboard | 是 |
| `app_center:read` | 读取应用中心、版本、公告和遥测 | 管理员 | dashboard | 是 |
| `app_center:write` | 管理应用、版本、附件、公告和遥测 | 管理员 | dashboard | 是 |
| `app_center:reveal` | 经本站确认查看或轮换遥测凭据 | 管理员 | dashboard | 是 |
| `channel:read` | 读取脱敏渠道列表和详情 | 管理员 | dashboard | 是 |
| `channel:operate` | 测试渠道、刷新余额、启用和停用 | 管理员 | dashboard | 是 |
| `channel:write` | 管理渠道模型、分组和路由 | 管理员 | dashboard | 是 |
| `channel:sensitive_write` | 创建渠道或修改 key、上游地址、参数和请求头覆盖 | 管理员 | dashboard | 是 |
| `channel:secret_view` | 经本站再验证查看渠道秘密 | 超级管理员 | dashboard | 是 |
| `option:read` | 读取脱敏系统设置、身份提供方和价格同步配置 | 超级管理员 | dashboard | 是 |
| `option:write` | 管理系统设置、身份提供方和价格同步 | 超级管理员 | dashboard | 是 |
| `oauth_clients:read` | 读取 OAuth 应用配置 | 超级管理员 | dashboard | 是 |
| `oauth_clients:write` | 经本站确认管理 OAuth 应用 | 超级管理员 | dashboard | 是 |
| `ops:read` | 读取性能、运行日志、任务和实例 | 超级管理员 | dashboard | 是 |
| `ops:write` | 执行维护、清理缓存和管理运行设置 | 超级管理员 | dashboard | 是 |

## 15. 全部 44 个托管操作中文索引

外部创建 action 时只传表内的 `parameters`；带 `*` 表示必填，未标记表示可选。`ids`、`scopes`、`groups`、`admin_permissions`、`redirect_uris` 等 JSON 字段的具体值遵循 `actions.json` 和原业务接口。密码、验证码、Passkey 响应等步骤输入由本站界面收集，不要塞进外部创建请求的 parameters。所有动作都先进行本人确认，渠道秘密额外要求 `channel.key.read` 的 MFA / Passkey 证明。

“本站完成凭据”只告知结果，不把独立凭据交给外部；“可共享”仍要求外部显式请求 `share_result=true`、本人同意和有效授权的一次领取。未共享时只在本站处理结果。

| operation | 用途 | 所需 scope | 外部 parameters | 外部结果 |
| --- | --- | --- | --- | --- |
| `account.delete` | 删除本人账号 | `account_security:write` | 无 | 本站完成凭据 |
| `admin.user.binding_clear` | 清除指定用户绑定 | `user:write` | `id`*、`binding_type`* | 本站完成凭据 |
| `admin.user.create` | 创建用户 | `user:write` | `username`*、`display_name`、`role`*、`group`、`groups`、`admin_permissions` | 本站完成凭据 |
| `admin.user.delete` | 删除用户 | `user:write` | `id`* | 本站完成凭据 |
| `admin.user.manage` | 执行用户状态、角色或额度管理 | `user:write` | `id`*、`action`*、`value`、`mode` | 本站完成凭据 |
| `admin.user.mfa_disable` | 关闭指定用户 MFA | `user:write` | `id`* | 本站完成凭据 |
| `admin.user.oauth_unbind` | 解绑指定用户登录提供方 | `user:write` | `id`*、`provider_id`* | 本站完成凭据 |
| `admin.user.passkey_reset` | 重置指定用户 Passkey | `user:write` | `id`* | 本站完成凭据 |
| `admin.user.update` | 更新用户资料 | `user:write` | `id`*、`username`*、`display_name`、`email`、`status`、`remark`、`group`、`groups`、`admin_permissions` | 本站完成凭据 |
| `apikey.reveal` | 查看完整 API key | `api_key:reveal` | `id`* | 可共享秘密结果 |
| `apikey.reveal_batch` | 批量查看完整 API key | `api_key:reveal` | `ids`* | 可共享秘密结果 |
| `app.create` | 创建应用中心条目 | `app_center:write` | `name`*、`slug`*、`description`、`public`*、`telemetry_enabled`* | 可共享安全数据 |
| `app_payment.configure` | 配置应用收款 | `billing:write` | `client_id`*、`enabled`*、`webhook_url`*、`methods`* | 本站完成凭据 |
| `app_payment.retry_webhook` | 人工重投应用收款通知 | `billing:write` | `client_id`*、`event_id`* | 本站完成凭据 |
| `app_payment.rotate_secret` | 轮换应用收款通知密钥 | `billing:write` | `client_id`* | 本站完成凭据 |
| `app.telemetry.reveal` | 在本站查看遥测凭据 | `app_center:reveal` | `id`* | 本站完成凭据 |
| `app.telemetry.rotate` | 轮换应用遥测凭据 | `app_center:reveal` | `id`* | 本站完成凭据 |
| `channel.config.reveal` | 查看渠道完整敏感配置 | `channel:secret_view` | `id`* | 可共享秘密结果 |
| `channel.key.reveal` | 查看完整渠道 key | `channel:secret_view` | `id`* | 可共享秘密结果 |
| `credential.legacy_generate` | 在本站生成旧式全局凭据 | `account_security:write` | 无 | 本站完成凭据 |
| `identity.email_bind` | 绑定邮箱 | `account_security:write` | `email`* | 本站完成凭据 |
| `identity.oauth_bind` | 绑定 OAuth 登录提供方 | `account_security:write` | `provider`* | 本站完成凭据 |
| `identity.oauth_unbind` | 解绑 OAuth 登录提供方 | `account_security:write` | `provider_id`* | 本站完成凭据 |
| `identity.telegram_bind` | 绑定 Telegram | `account_security:write` | 无 | 本站完成凭据 |
| `identity.wechat_bind` | 绑定微信 | `account_security:write` | 无 | 本站完成凭据 |
| `mfa.backup_codes` | 更新 MFA 恢复码 | `account_security:write` | 无 | 本站完成凭据 |
| `mfa.disable` | 关闭 MFA | `account_security:write` | 无 | 本站完成凭据 |
| `mfa.enable` | 完成 MFA 启用 | `account_security:write` | 无 | 本站完成凭据 |
| `mfa.setup` | 配置并启用 MFA | `account_security:write` | 无 | 本站完成凭据 |
| `oauth_client.create` | 注册 OAuth 应用 | `oauth_clients:write` | `name`*、`description`、`redirect_uris`*、`scopes`*、`is_public`*、`enabled`* | 可共享安全数据 |
| `oauth_client.delete` | 删除 OAuth 应用 | `oauth_clients:write` | `id`* | 本站完成凭据 |
| `oauth_client.reset_secret` | 在本站重置应用 secret | `oauth_clients:write` | `id`* | 本站完成凭据 |
| `oauth_client.update` | 更新 OAuth 应用 | `oauth_clients:write` | `id`*、`name`*、`description`、`redirect_uris`*、`scopes`*、`is_public`*、`enabled`* | 本站完成凭据 |
| `oauth_grants.list` | 读取本人授权列表 | `oauth_grants:read` | 无 | 可共享安全数据 |
| `oauth_grants.reduce` | 缩小授权范围 | `oauth_grants:write` | `id`*、`scopes`* | 本站完成凭据 |
| `oauth_grants.revoke` | 撤销授权 | `oauth_grants:write` | `id`* | 本站完成凭据 |
| `passkey.delete` | 删除 Passkey | `account_security:write` | 无 | 本站完成凭据 |
| `passkey.register` | 注册 Passkey | `account_security:write` | 无 | 本站完成凭据 |
| `password.change` | 修改密码 | `account_security:write` | 无 | 本站完成凭据 |
| `payment.compliance` | 确认支付条款 | `option:write` | 无 | 本站完成凭据 |
| `profile.update` | 更新本人资料 | `profile:write` | `username`、`display_name`、`language`、`sidebar_modules` | 本站完成凭据 |
| `sessions.list` | 读取本人登录会话 | `account_security:read` | 无 | 可共享安全数据 |
| `sessions.revoke` | 撤销指定登录会话 | `account_security:write` | `sid`* | 本站完成凭据 |
| `sessions.revoke_others` | 撤销其他登录会话 | `account_security:write` | 无 | 本站完成凭据 |

## 16. 接入错误与恢复策略

SDK 的 `error.status` 为 HTTP 状态，`error.code` 和 `error.details` 取决于目标接口返回的错误结构。错误原文可能含业务内部信息；应用应按明确错误分类显示中文提示，保留服务端 request ID 供排查。不要把整个错误对象、请求头或令牌写入公开日志。

| 常见服务端错误 | 含义 | 应用处理 |
| --- | --- | --- |
| `OAUTH_INVALID_TOKEN` / `invalid_token` | 令牌失效、到期或授权已撤销 | 若尚有可用 refresh 则按 SDK 串行刷新；失败则重新授权，不自动重发写请求 |
| `OAUTH_INVALID_RESOURCE` | token 不属于此资源 | 为所需 dashboard / relay 资源重新授权 |
| `OAUTH_INSUFFICIENT_SCOPE` / `insufficient_scope` | 缺少所需权限 | 说明用途并重新发起授权；不尝试退回全局 key |
| `OAUTH_INSUFFICIENT_PRIVILEGE` | 本人角色或细分权限已不允许 | 停止操作，由有权账号处理；full 不会提权 |
| `OAUTH_HOSTED_ACTION_REQUIRED` | 接口要求本站确认 | 查询 operations，选择固定操作创建 action，引导本人完成 |
| `OAUTH_ACTION_VERIFICATION_REQUIRED` | 尚缺本站身份再验证 | 留在本站验证流程完成；不向外部索取密码或 MFA 种子 |
| `OAUTH_ACTION_UNAVAILABLE` | 动作不属于此用户 / 授权、过期、结果已领取或其他状态不允许 | 查询现有业务状态；不盲目重发步骤或 claim |
| `OAUTH_ROUTE_UNDECLARED` | 该路由没有可委托的明确规则 | 升级或补齐目录并验证，不能按 URL 前缀绕过 |
| `OAUTH_PROTOCOL_AUTH_REQUIRED` | 登录或签名入口需其原协议 | 按原绑定、付款或授权流程处理 |

刷新、模型调用、付款、托管步骤、一次领取均可能已被服务器执行但响应未到达。SDK 不通过自动重放掩盖这种情况；应利用任务 ID、付款订单、动作状态或业务查询确认实际结果。刷新令牌不确定是否已被消费时，重新授权比反复重放旧 refresh 更合适。

## 17. 为其他软件提供应用收款

本节对应已上线的 `app-payments-20261003` 版本，最终验收与发布证据见中文总文档第 11 节。它在原有 OAuth 充值、本站订阅之外增加“外部软件订单”：软件后端创建订单，用户在 New API 收银台确认，软件根据签名通知和服务端查单开通自己的会员或服务。

这里使用平台统一配置的既有商户。应用不是独立商户，没有分账、提现、商户资金账户或独立结算。余额和外部渠道是两种付款方式；支付成功不会再给 New API 充值一次。

### 认证与资金边界

应用服务端使用 confidential OAuth client 的 HTTP Basic `client_id:client_secret`。公共客户端不能启用应用收款；普通 OAuth access token 不会自动扣款。客户端、应用收款设置都必须启用。普通用户可通过 `wallet:read` 查看自己的付款订单；Root 可通过 `billing:read` 读取应用收款配置与通知状态，修改配置、轮换密钥和人工重投则通过本站真实会话，或 `billing:write` 的固定托管操作经 Root 在本站确认。用户还需要真实 New API 登录会话，在本站收银台查看金额并确认；外部请求不能传 `payer_user_id` 冒充付款人。

客户端 secret 与 webhook secret 是两个用途不同的密钥。前者只在软件后端调用订单 API，后者只用于验证本站通知；都不能放进浏览器、移动安装包、URL 或日志。原有 OAuth 的授权码、用户 scope、刷新和撤销保持独立。

余额付款扣除 New API 的现有 quota 钱包。现有钱包中的充值、赠送和兑换额度在同一个余额池，当前没有区分“充值现金余额”和“赠送余额”；若不希望赠送额度用于软件购买，不要为该应用启用 balance。此版本不将余额支付包装成现金划转或提现。应用付款与本站订阅、充值、兑换码、签到、管理员调额共享余额变更隔离；在 Redis 延迟同步到数据库的模式下，不使用旧数据库余额放大可用额度。缓存或数据库结果不确定时，相关付款保留处理中或待核对状态，由持久化恢复流程处理，不以重复扣款“修复”不确定结果。

### 配置和支持渠道

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

### 服务端 SDK

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

### HTTP 契约

| 方法和路径 | 请求 / 结果 |
| --- | --- |
| POST `/api/payments/orders` | `{out_trade_no,title,amount,currency,return_url,expires_in?}`，新建 201 / 同参数幂等 200 |
| GET `/api/payments/orders?page=1&page_size=20` | `{items,total,page,page_size}`，仅自己应用 |
| GET `/api/payments/orders/:id` | 指定订单，仅自己应用；不存在和越权都为 404 |
| POST `/api/payments/orders/:id/cancel` | 无 body，仅取消尚未启动支付的 pending；重复 canceled 幂等 |
| POST `/api/payments/orders/:id/refund` | 无 body，全额退款；重复 refunded 幂等，不支持渠道明确拒绝 |

用户自己的付款订单页为 `/payments/orders`。

成功结构 `{success:true,data:...}`；失败为适当 HTTP 4xx/5xx 及 `{success:false,code,message}`。Order 字段为 `id,client_id,out_trade_no,title,amount,currency,status,payment_method,payer_user_id,created_at,updated_at,expires_at,paid_at,refunded_at,return_url,checkout_url`，时间为 Unix 秒，尚未发生的时刻为 0。状态包括 `pending,processing,paid,canceled,expired,refunding,refunded,failed`。订单只属于创建它的应用，不因同一软件用户使用另一个应用就可查询。

### 验证通知与可靠发货

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

### 余额故障恢复与发布运维

余额付款使用数据库操作记录与 Redis 永久操作标记协调。`cache_pending` 只有在永久 Redis 操作标记能够证明该次变更已执行时，后台才自动提交后续数据库步骤；如果缺少标记，执行结果不确定，不会根据猜测补扣。`wallet mutation` / `unsafe` 状态会跨实例阻止该用户继续发起外部余额付款，避免不同实例分别使用不一致余额。

遇到这类状态，应保留数据库和 Redis 快照，对照操作 ID、订单状态、缓存余额、已发生的模型消费和钱包变更核对后人工处理。不能通过删除 guard、unsafe 或操作标记强行恢复支付，也不能把旧数据库余额直接写回 Redis；这可能重复扣款或恢复已经消费的额度。全局一致性 epoch 缺失时不会自动重建并假定缓存可靠，需要先核实发生了何种 Redis 丢失或恢复。

这些故障处理不要求常规模型请求每次查询数据库：模型余额热路径仍在同一次 Lua 中执行约束，没有新增每次模型调用的数据库往返。涉及余额故障处置时，应保存数据库和 Redis 状态以便核对。本轮发布已保存 MySQL 数据库备份及运行配置，未另行制作 Redis 快照；应用版本切换只重载 New API 服务，保留 MySQL、Redis 和其他服务。具体已发布版本、备份与健康证据以完整中文总文档的发布记录为准。

### 可运行的软件会员示例

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

### 测试和接入检查

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
