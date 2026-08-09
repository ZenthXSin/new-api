# 应用中心完整接口文档

本文档对应正式站点：

```text
https://ai.example.com:20082
```

应用中心包含四部分：公开下载站、公开公告、管理员分发管理和外部遥测。新模块使用 `app_center_*` 表，不读取、迁移或删除旧 `distribution_*`、`telemetry_*` 数据和旧文件。

公开下载与公告接口的 OpenAPI 3.0 定义位于 [`docs/openapi/application-center-public.json`](./openapi/application-center-public.json)，可直接导入 Postman、Apifox 或客户端代码生成工具。

## 1. 通用约定

### 1.1 认证范围

| 接口前缀 | 认证方式 | 用途 |
| --- | --- | --- |
| `/api/public/*` | 无需认证 | 下载站、公告列表、版本查询、客户端更新检查和文件下载 |
| `/api/app-center/*` | 当前登录管理员的网页会话 | 创建应用、发布版本、上传安装包、发布公告和读取统计 |
| `/api/external/v1/telemetry/*` | `Authorization: Bearer app_v2.<key_id>.<secret>` | 软件上报使用时长和自定义事件 |

应用遥测密钥不能管理版本、上传文件、发布公告或读取统计。个人访问令牌也不能代替管理员网页会话访问 `/api/app-center/*`。未登录或非管理员访问管理接口统一返回 HTTP 500。

### 1.2 JSON 响应

普通成功响应：

```json
{
  "success": true,
  "data": {}
}
```

普通错误响应：

```json
{
  "success": false,
  "message": "应用中心操作失败"
}
```

删除成功返回 HTTP 204，没有响应体。安装包下载接口直接返回文件内容，不使用 JSON 包装。

所有 JSON 写接口使用严格解析：未知字段、无效 JSON 或尾随的第二个 JSON 值都会返回 HTTP 400。

### 1.3 时间、版本和标签

- 时间字段使用 RFC 3339，例如 `2026-08-07T18:00:00+08:00`。
- 版本号使用 SemVer，例如 `1.2.0`、`v1.2.0` 或 `1.2.0-beta.1`；保存时会移除开头的 `v`。
- `slug`、`channel`、`platform` 和 `architecture` 会转成小写。
- 标签格式为 `[a-z0-9][a-z0-9._-]{0,31}`，最大 32 个字符。
- `app_id`、`release_id`、`announcement_id` 和 `asset_id` 均为十进制整数。

## 2. 数据结构

### 2.1 应用 App

```json
{
  "id": 1,
  "name": "桌面客户端",
  "slug": "desktop-client",
  "description": "客户端稳定版",
  "public": true,
  "telemetry_enabled": true,
  "created_at": "2026-08-07T10:00:00Z",
  "updated_at": "2026-08-07T10:00:00Z"
}
```

`public=false` 时，公开应用、版本、公告、更新和下载接口均不可访问该应用。

### 2.2 版本 Release

```json
{
  "id": 10,
  "app_id": 1,
  "version": "1.2.0",
  "channel": "stable",
  "status": "published",
  "notes": "修复更新检查",
  "published_at": "2026-08-07T11:00:00Z",
  "created_at": "2026-08-07T10:30:00Z",
  "updated_at": "2026-08-07T11:00:00Z",
  "assets": []
}
```

版本状态为 `draft`、`published` 或 `archived`。当前管理接口支持创建草稿、修改草稿和发布草稿；没有删除版本或归档版本的接口。

### 2.3 安装包 Asset

```json
{
  "id": 21,
  "release_id": 10,
  "platform": "windows",
  "architecture": "amd64",
  "filename": "desktop-client-1.2.0.exe",
  "content_type": "application/octet-stream",
  "size": 73400320,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "downloads": 12,
  "created_at": "2026-08-07T10:45:00Z"
}
```

文件存储路径不会出现在 API 中。公开下载 URL 由应用 `slug` 和资源 `id` 组成。

### 2.4 公告 Announcement

```json
{
  "id": 31,
  "app_id": 1,
  "title": "1.2.0 已发布",
  "body": "请在设置中检查更新。",
  "status": "published",
  "starts_at": "2026-08-07T12:00:00Z",
  "ends_at": "2026-08-14T12:00:00Z",
  "pinned": true,
  "channel": "stable",
  "platform": "windows",
  "min_version": "1.0.0",
  "created_at": "2026-08-07T11:30:00Z",
  "updated_at": "2026-08-07T11:40:00Z"
}
```

公告状态为 `draft`、`published` 或 `archived`。

## 3. 公开下载站接口

公开接口只返回 `public=true` 的应用和已发布内容，不需要任何密钥。

### 3.1 获取公开应用列表

```http
GET /api/public/apps
```

响应：HTTP 200，`data` 为 App 数组。结果按应用名称升序排列，缓存 60 秒。

```bash
curl 'https://ai.example.com:20082/api/public/apps'
```

### 3.2 获取单个公开应用

```http
GET /api/public/apps/{slug}
```

响应：HTTP 200，`data` 为 App；应用不存在或未公开时返回 HTTP 404。

### 3.3 获取已发布版本

```http
GET /api/public/apps/{slug}/releases?channel=stable
```

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `channel` | 否 | 发布渠道；省略时返回全部渠道 |

响应：HTTP 200，`data` 为 Release 数组，每个版本包含 `assets`。只返回 `published_at` 不晚于当前时间的 `published` 版本，按 SemVer 从高到低排列。

### 3.4 获取最新版本

```http
GET /api/public/apps/{slug}/releases/latest?channel=stable
```

响应：HTTP 200，`data` 为最高 SemVer 的 Release；没有已发布版本时返回 HTTP 404。

```bash
curl 'https://ai.example.com:20082/api/public/apps/desktop-client/releases/latest?channel=stable'
```

### 3.5 客户端更新检查

```http
GET /api/public/apps/{slug}/update?version=1.1.0&channel=stable&platform=windows&arch=amd64
```

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 否 | 客户端当前 SemVer；省略时只要存在匹配安装包就认为可更新 |
| `channel` | 否 | 发布渠道；省略时从全部渠道选择最高版本 |
| `platform` | 否 | 平台过滤，例如 `windows`、`linux`、`darwin` |
| `arch` | 否 | 架构过滤，例如 `amd64`、`arm64`；这里的参数名是 `arch` |

响应：

```json
{
  "success": true,
  "data": {
    "update_available": true,
    "release": {
      "id": 10,
      "app_id": 1,
      "version": "1.2.0",
      "channel": "stable",
      "status": "published",
      "notes": "修复更新检查",
      "published_at": "2026-08-07T11:00:00Z",
      "created_at": "2026-08-07T10:30:00Z",
      "updated_at": "2026-08-07T11:00:00Z",
      "assets": [
        {
          "id": 21,
          "release_id": 10,
          "platform": "windows",
          "architecture": "amd64",
          "filename": "desktop-client-1.2.0.exe",
          "content_type": "application/octet-stream",
          "size": 73400320,
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "downloads": 12,
          "created_at": "2026-08-07T10:45:00Z"
        }
      ]
    },
    "assets": [
      {
        "id": 21,
        "release_id": 10,
        "platform": "windows",
        "architecture": "amd64",
        "filename": "desktop-client-1.2.0.exe",
        "content_type": "application/octet-stream",
        "size": 73400320,
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "downloads": 12,
        "created_at": "2026-08-07T10:45:00Z"
      }
    ],
    "announcements": []
  }
}
```

行为说明：

- `release` 是对应渠道的最高已发布版本，并且其 `assets` 已按平台和架构过滤。
- 顶层 `assets` 与 `release.assets` 内容相同，方便客户端直接读取。
- `update_available` 只有在版本更高且至少存在一个匹配安装包时才为 `true`。
- 当前版本格式无效时 `update_available=false`。
- 没有已发布版本时仍返回 HTTP 200，此时 `release=null`、`assets=[]`，公告仍会返回。
- `announcements` 使用相同的 `channel`、`platform` 和 `version` 参数过滤。

### 3.6 下载安装包

```http
GET  /api/public/apps/{slug}/assets/{asset_id}/download
HEAD /api/public/apps/{slug}/assets/{asset_id}/download
```

仅允许下载属于该应用已发布版本的资源。响应支持：

- HTTP Range，分段请求成功时返回 HTTP 206。
- `Accept-Ranges: bytes`。
- `ETag: "<SHA256>"`。
- `Last-Modified`。
- `Cache-Control: public, max-age=31536000, immutable`。
- HEAD 请求只返回响应头，不增加下载次数。
- GET 请求完成处理后增加资源的 `downloads` 计数。

完整下载：

```bash
curl -L \
  -o desktop-client.exe \
  'https://ai.example.com:20082/api/public/apps/desktop-client/assets/21/download'
```

读取文件信息：

```bash
curl -I \
  'https://ai.example.com:20082/api/public/apps/desktop-client/assets/21/download'
```

断点或分段下载：

```bash
curl -H 'Range: bytes=0-1048575' \
  -o desktop-client.part \
  'https://ai.example.com:20082/api/public/apps/desktop-client/assets/21/download'
```

资源不存在、应用未公开、版本未发布或文件丢失时返回 HTTP 404。

## 4. 公开公告接口

### 4.1 获取有效公告列表

```http
GET /api/public/apps/{slug}/announcements?channel=stable&platform=windows&version=1.1.0
```

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `channel` | 否 | 指定渠道；公告的 `channel` 为空时视为全渠道公告 |
| `platform` | 否 | 指定平台；公告的 `platform` 为空时视为全平台公告 |
| `version` | 否 | 当前客户端 SemVer；只保留 `min_version` 为空或当前版本不低于 `min_version` 的公告 |

只返回满足以下全部条件的公告：

- 状态为 `published`。
- `starts_at` 为空或不晚于当前时间。
- `ends_at` 为空或晚于当前时间。
- 渠道、平台和最低版本满足过滤条件。

结果按 `pinned=true` 优先，其次按创建时间倒序排列，缓存 60 秒。

### 4.2 获取单条有效公告

```http
GET /api/public/apps/{slug}/announcements/{announcement_id}
```

响应：HTTP 200，`data` 为 Announcement。该接口仍会检查发布状态和有效时间，但不会接收渠道、平台和版本过滤参数。不满足公开条件时返回 HTTP 404。

```bash
curl 'https://ai.example.com:20082/api/public/apps/desktop-client/announcements/31'
```

## 5. 管理员应用接口

以下接口使用当前网页登录后的管理员会话。示例中的 Cookie 仅表示浏览器会话，实际 Cookie 名称和值以登录响应为准。

### 5.1 路由总表

| 方法 | 路径 | 成功状态 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/app-center/apps` | 200 | 获取全部应用 |
| POST | `/api/app-center/apps` | 201 | 创建应用并返回遥测密钥 |
| GET | `/api/app-center/apps/{id}` | 200 | 获取单个应用 |
| PUT/PATCH | `/api/app-center/apps/{id}` | 200 | 更新应用 |
| DELETE | `/api/app-center/apps/{id}` | 204 | 删除应用及其版本、文件、公告和遥测数据 |
| GET | `/api/app-center/apps/{id}/telemetry-key` | 200 | 读取当前遥测密钥 |
| POST | `/api/app-center/apps/{id}/telemetry-key/rotate` | 200 | 轮换遥测密钥 |

### 5.2 创建应用

```http
POST /api/app-center/apps
Content-Type: application/json

{
  "name": "桌面客户端",
  "slug": "desktop-client",
  "description": "稳定版客户端下载",
  "public": true,
  "telemetry_enabled": true
}
```

字段约束：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | 非空，UTF-8 编码后最多 128 字节 |
| `slug` | 是 | 标签格式，全局唯一；创建后不可修改 |
| `description` | 否 | UTF-8 编码后最多 65535 字节 |
| `public` | 是 | 是否允许公开下载和公告读取 |
| `telemetry_enabled` | 是 | 是否接受该应用密钥提交遥测 |

响应：

```json
{
  "success": true,
  "data": {
    "app": {},
    "token": "app_v2.<key_id>.<secret>"
  }
}
```

### 5.3 更新应用

```http
PUT /api/app-center/apps/{id}
PATCH /api/app-center/apps/{id}
Content-Type: application/json

{
  "name": "桌面客户端",
  "description": "新的说明",
  "public": true,
  "telemetry_enabled": true
}
```

当前 `PUT` 和 `PATCH` 行为相同，都应提交完整对象。未提交的布尔字段会按 `false` 处理。`slug` 创建后不可修改，即使请求中提供也会被忽略。

### 5.4 读取与轮换遥测密钥

```http
GET /api/app-center/apps/{id}/telemetry-key
POST /api/app-center/apps/{id}/telemetry-key/rotate
```

响应：

```json
{
  "success": true,
  "data": {
    "token": "app_v2.<key_id>.<secret>"
  }
}
```

密钥可重复读取和复制。轮换成功后旧密钥立即失效。含密钥响应带 `Cache-Control: no-store`。

## 6. 管理员版本与安装包接口

### 6.1 路由总表

| 方法 | 路径 | 成功状态 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/app-center/apps/{id}/releases` | 200 | 获取草稿、已发布和已归档版本 |
| POST | `/api/app-center/apps/{id}/releases` | 201 | 创建版本草稿 |
| PUT/PATCH | `/api/app-center/apps/{id}/releases/{release_id}` | 200 | 修改版本草稿 |
| POST | `/api/app-center/apps/{id}/releases/{release_id}/publish` | 200 | 发布版本草稿 |
| POST | `/api/app-center/apps/{id}/releases/{release_id}/assets` | 201 | 向版本草稿上传安装包 |
| DELETE | `/api/app-center/apps/{id}/releases/{release_id}/assets/{asset_id}` | 204 | 删除版本草稿中的安装包 |

### 6.2 创建或修改版本草稿

```http
POST /api/app-center/apps/{id}/releases
Content-Type: application/json

{
  "version": "1.2.0",
  "channel": "stable",
  "notes": "修复更新检查"
}
```

`PUT` 和 `PATCH` 使用相同请求体。版本和渠道必填，客户端应将 `notes` 控制在 32 KiB 内；创建接口会强制执行该上限。同一应用下 `(version, channel)` 组合必须唯一。只有 `draft` 状态可以修改，写接口应提交全部三个字段。

### 6.3 上传安装包

```http
POST /api/app-center/apps/{id}/releases/{release_id}/assets
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | 是 | 文件本体，最大 512 MiB；基础文件名最多 255 字节 |
| `platform` | 是 | 平台标签，例如 `windows`、`linux`、`darwin` |
| `architecture` | 是 | 架构标签，例如 `amd64`、`arm64` |

```bash
curl -X POST \
  -b 'session=<管理员会话>' \
  -F 'file=@desktop-client-1.2.0.exe' \
  -F 'platform=windows' \
  -F 'architecture=amd64' \
  'https://ai.example.com:20082/api/app-center/apps/1/releases/10/assets'
```

服务端自动计算 `size` 和 SHA-256。只有版本草稿可以上传或删除资源。发布后资源不可再增加或删除。

### 6.4 发布版本

```http
POST /api/app-center/apps/{id}/releases/{release_id}/publish
```

发布条件：版本必须为 `draft`，并且至少包含一个安装包。成功后状态变为 `published` 并写入 `published_at`。发布后的版本不能再修改。

## 7. 管理员公告接口

### 7.1 路由总表

| 方法 | 路径 | 成功状态 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/app-center/apps/{id}/announcements` | 200 | 获取全部状态的公告 |
| POST | `/api/app-center/apps/{id}/announcements` | 201 | 创建公告草稿 |
| PUT/PATCH | `/api/app-center/apps/{id}/announcements/{announcement_id}` | 200 | 修改公告草稿 |
| DELETE | `/api/app-center/apps/{id}/announcements/{announcement_id}` | 204 | 删除公告草稿 |
| POST | `/api/app-center/apps/{id}/announcements/{announcement_id}/publish` | 200 | 将公告状态设为 `published` |
| POST | `/api/app-center/apps/{id}/announcements/{announcement_id}/archive` | 200 | 将公告状态设为 `archived` |

### 7.2 创建公告草稿

```http
POST /api/app-center/apps/{id}/announcements
Content-Type: application/json

{
  "title": "1.2.0 已发布",
  "body": "请在设置中检查更新。",
  "starts_at": "2026-08-07T12:00:00Z",
  "ends_at": "2026-08-14T12:00:00Z",
  "pinned": true,
  "channel": "stable",
  "platform": "windows",
  "min_version": "1.0.0"
}
```

字段约束：

| 字段 | 必填 | 约束和含义 |
| --- | --- | --- |
| `title` | 是 | 非空，UTF-8 编码后最多 200 字节 |
| `body` | 否 | UTF-8 编码后最多 32 KiB |
| `starts_at` | 否 | 公开展示开始时间 |
| `ends_at` | 否 | 公开展示结束时间，必须晚于 `starts_at` |
| `pinned` | 否 | 是否置顶 |
| `channel` | 否 | 空值表示全部渠道 |
| `platform` | 否 | 空值表示全部平台 |
| `min_version` | 否 | 合法 SemVer；当前客户端版本不低于该值时展示 |

### 7.3 修改公告草稿

```http
PUT /api/app-center/apps/{id}/announcements/{announcement_id}
PATCH /api/app-center/apps/{id}/announcements/{announcement_id}
```

只有 `draft` 状态可以修改。当前 `PUT` 和 `PATCH` 都要求至少提交完整的 `title` 和 `body`，未提交的其他字段会被清空或置为默认值。

当前实现限制：创建后不能通过更新接口修改 `min_version`；如需调整最低版本，请删除仍处于草稿状态的公告并重新创建。

### 7.4 发布、归档和删除

- `publish` 将状态设置为 `published`，公开接口还会继续检查 `starts_at` 和 `ends_at`。
- `archive` 将状态设置为 `archived`，归档公告不再出现在公开接口。
- DELETE 只允许删除 `draft` 公告。

## 8. 外部软件读取流程

推荐客户端只保存应用 `slug`，不保存数据库 ID：

1. 调用 `/api/public/apps/{slug}/update` 检查新版本并同时取得有效公告。
2. 当 `update_available=true` 时，从顶层 `assets` 选择安装包。
3. 使用 `/api/public/apps/{slug}/assets/{asset_id}/download` 下载。
4. 下载后校验响应中的 `sha256` 和实际文件 SHA-256。
5. 需要单独刷新公告时调用 `/api/public/apps/{slug}/announcements`。

最小更新检查示例：

```bash
curl --get \
  --data-urlencode 'version=1.1.0' \
  --data-urlencode 'channel=stable' \
  --data-urlencode 'platform=windows' \
  --data-urlencode 'arch=amd64' \
  'https://ai.example.com:20082/api/public/apps/desktop-client/update'
```

## 9. 外部遥测接口

下载、版本和公告读取不需要密钥。只有遥测写入需要应用自己的单个密钥。

### 9.1 软件使用和在线时长

```http
POST /api/external/v1/telemetry/usage
Authorization: Bearer app_v2.<key_id>.<secret>
Content-Type: application/json

{
  "type": "start",
  "session_id": "session-123",
  "installation_id": "install-abc",
  "sequence": 1,
  "version": "1.2.0",
  "platform": "windows",
  "architecture": "amd64"
}
```

`type` 为 `start`、`heartbeat` 或 `stop`。同一 session 使用严格递增的 `sequence` 去重；单次心跳最多计入 300 秒，已停止的 session 不再接受心跳。

成功响应为 HTTP 202：

```json
{
  "success": true,
  "data": {
    "accepted": true,
    "online_seconds": 60
  }
}
```

### 9.2 自定义事件

```http
POST /api/external/v1/telemetry/events
Authorization: Bearer app_v2.<key_id>.<secret>
Content-Type: application/json

{
  "events": [
    {
      "event_id": "evt-123",
      "name": "editor_opened",
      "occurred_at": 1786080000,
      "count": 1,
      "dimensions": {
        "platform": "windows",
        "channel": "stable"
      }
    }
  ]
}
```

每批最多 100 个事件，`event_id` 在应用内幂等，`count` 范围为 1 至 1,000,000。事件最多包含 8 个维度；维度名最多 32 个字符，值最多 128 个字符。事件时间不能早于 7 天前，也不能晚于服务器时间 5 分钟以上。

成功响应为 HTTP 202：

```json
{
  "success": true,
  "data": {
    "accepted": 1
  }
}
```

### 9.3 遥测限流

每分钟限制：全局 600 次、单 IP 120 次、单应用密钥 120 次。超过限制返回 HTTP 429；密钥缺失、格式错误、已轮换或遥测已关闭时返回 HTTP 401。

## 10. 管理员统计接口

| 方法 | 路径 | 返回内容 |
| --- | --- | --- |
| GET | `/api/app-center/apps/{id}/usage?hours=24` | 按小时、版本、平台和架构聚合的启动次数与在线秒数 |
| GET | `/api/app-center/apps/{id}/usage/regions?hours=24` | 按国家、地区、城市聚合的独立安装数 |
| GET | `/api/app-center/apps/{id}/events?hours=24` | 按小时、事件名和维度聚合的事件次数与独立 IP 数 |
| GET | `/api/app-center/apps/{id}/events/trend?hours=24` | 按小时和事件名汇总的事件次数与跨维度去重独立 IP 数 |
| GET | `/api/app-center/apps/{id}/events/regions?hours=24` | 事件地区分布和每个事件的独立 IP 数 |
| DELETE | `/api/app-center/apps/{id}/telemetry-data` | 清空该应用全部 usage、事件、IP 和聚合数据 |

`hours` 可选，范围为 1 至 720；省略或无效时使用 720 小时。

来源 IP 从受信任代理链解析并直接写入业务表。管理统计只返回聚合后的地区和独立 IP 数，不返回原始 IP。`events/trend` 的每行格式为 `{ "bucket_ts": 1786107600, "name": "export", "count": 12, "unique_users": 5 }`，其中 `bucket_ts` 是 UTC 小时起点的 Unix 秒时间戳。事件 IP 明细保留 30 天并在后续事件写入时清理；usage 会话最近 IP 保留到管理员清空遥测或删除应用。

地区解析使用 `APP_CENTER_GEOIP_DB` 指定的 MaxMind MMDB。Country 数据库只能提供国家，省市为“未知”；使用 City 数据库后接口无需改变。

## 11. 状态码速查

| 状态码 | 含义 |
| --- | --- |
| 200 | 查询、更新、发布或归档成功 |
| 201 | 应用、版本草稿、公告草稿或安装包创建成功 |
| 202 | 遥测数据已接受 |
| 204 | 删除或清空成功，无响应体 |
| 206 | Range 分段下载成功 |
| 400 | JSON、字段、版本、状态流转、上传文件或筛选参数无效 |
| 401 | 外部遥测密钥缺失或无效 |
| 404 | 公开应用、版本、公告、资源或文件不存在 |
| 429 | 外部遥测超过限流 |
| 500 | 管理员会话无效、权限不足或内部处理失败 |

为了避免泄露资源存在性，错误响应统一使用 `应用中心操作失败`，调用方应主要依据 HTTP 状态码处理。
