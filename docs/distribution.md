# 应用分发中心

应用分发中心为外部应用提供公开的版本、安装包和公告接口。公开读取不需要登录或密钥；创建、上传、发布和归档等写操作只需要对应应用的一枚 Bearer 密钥，不需要面板登录、用户 Token、时间戳、nonce 或签名头。

## 公共读取接口

应用使用遥测管理中的应用标识 `slug`。例如应用标识为 `desktop`：

```text
GET /api/distribution/apps/desktop
GET /api/distribution/apps/desktop/releases
GET /api/distribution/apps/desktop/releases/latest?channel=stable
GET /api/distribution/apps/desktop/announcements?channel=stable&platform=windows&version=1.2.3
GET /api/distribution/apps/desktop/announcements/:id
GET /api/distribution/apps/desktop/assets/:id/download
HEAD /api/distribution/apps/desktop/assets/:id/download
```

版本和公告接口只返回已发布且仍在可见时间窗口内的数据。版本使用 SemVer 规则排序，支持请求中的 `v1.2.3` 前缀；当 SemVer 优先级相同时，较晚发布时间优先，发布时间相同则较大版本 ID 优先。公告的 `starts_at` 和 `ends_at` 由服务端过滤。安装包下载响应提供 SHA-256 ETag、`Last-Modified`、条件请求和 Range 支持，安装包使用长期不可变缓存。只有成功的完整 GET 才计入下载量；HEAD、304 和 Range 请求不计入。

## 应用 Bearer 密钥

根管理员在“系统设置 -> 运行 -> 遥测”中为应用创建或轮换密钥。创建响应中的完整 Token 只显示一次，格式为：

```text
app_v1.<key_id>.<secret>
```

外部写请求统一使用：

```http
Authorization: Bearer app_v1.<key_id>.<secret>
Content-Type: application/json
```

应用 ID 不从请求体读取，而是从 Bearer 密钥绑定的应用推断。每个应用只保留一枚活动密钥，轮换会立即停用旧密钥；已停用的密钥记录仍保留用于审计。认证失败统一返回 `401`，响应不会暴露密钥是否存在。写接口响应使用 `Cache-Control: no-store`。

## 外部写接口

### 版本

```text
POST  /api/distribution/apps/:slug/releases
PUT   /api/distribution/apps/:slug/releases/:id
POST  /api/distribution/apps/:slug/releases/:id/publish
POST  /api/distribution/apps/:slug/releases/:id/assets
GET   /api/distribution/apps/:slug/manage/releases
```

创建或更新版本的 body：

```json
{"version":"1.2.3","channel":"stable","notes":"本次更新说明"}
```

版本必须是 `major.minor.patch` 形式，可带 prerelease 和 build metadata，规范化后最多 64 个字符；发布渠道、平台和架构使用 1 至 32 个字符的标签。版本发布前必须至少上传一个安装包；已发布版本和安装包不可修改。重复版本或不符合状态转换的请求返回 `409 Conflict`。

安装包使用 multipart：

```text
file:         安装包文件
platform:     windows / macos / linux / android ...
architecture: x64 / arm64 ...
```

单个安装包最大 512 MiB，文件名最多 255 个字符，Content-Type 最多 128 个字符。服务端先在 `/data/distribution` 同一文件系统内写入临时文件，校验 SHA-256 后原子移动，再写入数据库；数据库失败会删除已移动文件。当前存储适用于单节点或所有节点共享 `/data` 的部署，不应在未接入对象存储前用于独立多节点本地盘。

### 公告

```text
POST  /api/distribution/apps/:slug/announcements
PUT   /api/distribution/apps/:slug/announcements/:id
POST  /api/distribution/apps/:slug/announcements/:id/publish
POST  /api/distribution/apps/:slug/announcements/:id/archive
GET   /api/distribution/apps/:slug/manage/announcements
```

公告 body：

```json
{
  "title":"维护通知",
  "body":"支持 Markdown 的公告正文",
  "starts_at":"2026-08-06T09:00:00Z",
  "ends_at":"2026-08-13T09:00:00Z",
  "pinned":true,
  "channel":"stable",
  "platform":"windows",
  "min_version":"1.2.0"
}
```

标题最多 200 字符，正文最多 32 KiB。正文按 Markdown 处理，服务端拒绝脚本标签；客户端渲染时仍必须进行 HTML 清理。公告先创建为草稿，只有发布后且处于时间窗口内才会出现在公共接口中。已发布公告可以归档；归档后会立即从公共列表和详情接口中隐藏。草稿公告不能归档。

## 遥测接口变化

遥测接收接口现在与分发写接口使用同一种单密钥认证：

```text
POST /api/telemetry/ingest
Authorization: Bearer app_v1.<key_id>.<secret>
```

不再需要 `X-Telemetry-Key-Id`、时间戳、nonce 或 HMAC 签名头。原始遥测事件仍不会保存，服务端只保存按小时聚合的数据；请求体、事件类型、计数和时间范围校验保持不变。接收端仍需由根管理员启用，限流仍按全局、IP 和应用密钥执行。

## 失败响应

| 状态 | 含义 |
| --- | --- |
| `400` | JSON、SemVer、字段长度、时间窗口或 multipart 参数无效。 |
| `401` | Bearer 密钥缺失、格式错误、secret 错误或密钥已停用。 |
| `404` | 应用、版本、公告或安装包不存在，或尚未公开。 |
| `409` | 重复版本、重复状态转换或已发布资源被修改。 |
| `413` | 安装包超过 512 MiB 或请求体超过限制。 |
| `429` | 超过应用/IP/全局限流。 |

外部自动化建议为创建、上传和发布请求提供自己的幂等 ID，并在收到 `409` 后先查询公共列表确认最终状态；当前接口使用唯一版本和明确状态转换避免重复发布。

JSON 写请求使用系统的匿名请求体上限，默认最大 512 KiB；超过上限返回 `413`。`manage` 接口同样只接受应用 Bearer 密钥，用于读取该应用的草稿、已发布和已归档记录，公共接口仍只返回当前可见内容。应用密钥限流触发时返回 `429`，不会触发面板登录刷新。

## 前端入口

公开页：`/distribution/:slug`，公告详情：`/distribution/:slug/announcements/:id`。管理员入口：`/distribution`。公开页匿名可访问，管理员页面只允许管理员进入；管理员页面中的应用 Bearer 密钥只保存在当前页面状态，不写入浏览器持久化存储。
