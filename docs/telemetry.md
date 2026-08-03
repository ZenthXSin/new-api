# 被动遥测接收接口

本服务只接收外部应用主动提交的聚合诊断数据，不会采集本项目的请求内容，也不会向任何外部服务发送遥测数据。

接收端默认关闭。根管理员需要在“系统设置 -> 运行 -> 遥测”中启用接收端，并创建项目、应用和写入密钥。

## 数据边界

允许上报的数据仅限于：

- 客户端生成的随机安装标识；服务端入库前会使用服务端密钥进行 HMAC 哈希。
- 应用版本、固定事件类型、有限的维度与状态。
- 聚合后的计数、成功数、耗时和值。

不得上报 prompt、completion、请求或响应正文、请求头、Cookie、Token、API Key、用户信息、支付或账单信息、数据库内容、配置值、URL 查询参数、原始错误堆栈或任意扩展字段。未知 JSON 字段会被拒绝。

服务端只保存按小时聚合后的数据，不保存原始事件或原始 `installation_id`。

## 写入接口

```text
POST /api/telemetry/ingest
```

该接口不使用面板登录态、用户 API Token 或支付凭据。客户端必须使用管理员创建的遥测写入密钥签名请求。

### 请求头

| 请求头 | 说明 |
| --- | --- |
| `Content-Type` | 必须为 `application/json`。 |
| `X-Telemetry-Key-Id` | 遥测写入密钥 ID。 |
| `X-Telemetry-Timestamp` | Unix 秒级时间戳。默认允许与服务端时间相差 300 秒。 |
| `X-Telemetry-Nonce` | 本次请求唯一随机值，使用字母、数字、`.`、`_`、`-`，长度 1 至 64。 |
| `X-Telemetry-Signature` | 64 位十六进制 HMAC-SHA256 签名。 |

### 签名规则

签名原文使用换行符 `\n` 连接，最后一段为未改动的原始 HTTP 请求体字节：

```text
POST
/api/telemetry/ingest
<timestamp>
<nonce>
<raw-json-body>
```

使用创建写入密钥时仅展示一次的 `secret` 作为 HMAC-SHA256 密钥，计算后将小写十六进制摘要放入 `X-Telemetry-Signature`。

客户端不得先格式化、重编码或解析后再序列化已签名的 body；签名与实际发送内容必须逐字节一致。

### 请求体

```json
{
  "schema_version": 1,
  "events": [
    {
      "event_id": "startup-20260802-0001",
      "occurred_at": 1785681300,
      "installation_id": "d7b84c75-07e7-4bef-9c93-7944a9f4fd90",
      "instance_version": "v1.2.3",
      "event_type": "startup",
      "payload": {
        "dimension": "summary",
        "status": "success",
        "count": 1,
        "successes": 1,
        "duration_ms": 125,
        "value": 0
      }
    }
  ]
}
```

字段约束：

| 字段 | 规则 |
| --- | --- |
| `schema_version` | 当前固定为 `1`。 |
| `events` | 非空数组；默认最多 100 条，可由管理员配置为 1 至 1000。 |
| `event_id`、`installation_id`、`instance_version` | 使用字母、数字、`.`、`_`、`-`，长度 1 至 64。`installation_id` 应为客户端安装时生成的随机标识，不能包含用户身份信息。 |
| `occurred_at` | Unix 秒级时间戳，与服务端当前时间差不得超过 7 天。 |
| `event_type` | 仅允许 `startup`、`request_summary`、`relay_performance_bucket`、`runtime_snapshot`。 |
| `payload.dimension` | 使用字母、数字、`.`、`_`、`:`、`/`、`-`，长度 1 至 64。 |
| `payload.status` | 仅允许 `success`、`failure`、`unknown`。 |
| `payload.count` | 1 至 1,000,000。 |
| `payload.successes` | 0 至 `count`。 |
| `payload.duration_ms` | 0 至 86,400,000。 |
| `payload.value` | 0 至 1,000,000,000。 |

默认请求体最大为 65,536 字节，可由管理员配置为 1,024 至 1,048,576 字节。时间戳容差默认 300 秒，可配置为 30 至 3,600 秒。

### 成功响应

```json
{
  "success": true,
  "data": {
    "accepted": 1
  }
}
```

成功时返回 `202 Accepted`。一个批次中的全部事件会先完成校验，再在同一事务中写入聚合数据；任何事件无效时，整个批次都不会被持久化。

### 失败响应

| HTTP 状态 | 含义 |
| --- | --- |
| `400 Bad Request` | 请求体不符合严格协议、字段越界、事件类型不支持或事件时间无效。 |
| `401 Unauthorized` | 写入密钥、签名、时间戳或 nonce 无效；也用于已使用的 nonce。 |
| `413 Payload Too Large` | 请求体超过配置的大小限制。 |
| `429 Too Many Requests` | 超过全局、来源 IP 或写入密钥的速率限制。 |
| `503 Service Unavailable` | 遥测接收端尚未启用。 |

为避免泄露认证细节，认证失败响应统一为通用错误消息。服务端不会记录完整签名、写入密钥 secret 或原始遥测 body。

## 管理接口

以下接口均需要根管理员面板鉴权，普通用户无权访问。响应均采用 `success` 和 `data` 包装结构。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/telemetry/projects` | 获取遥测项目。 |
| `POST` | `/api/telemetry/projects` | 创建项目，body：`{"name":"..."}`。 |
| `GET` | `/api/telemetry/apps?project_id=<id>` | 获取项目下的应用；省略 `project_id` 时获取全部应用。 |
| `POST` | `/api/telemetry/apps` | 创建应用，body：`{"project_id":1,"name":"..."}`。 |
| `GET` | `/api/telemetry/keys?app_id=<id>` | 获取应用的写入密钥列表；不会返回 secret。 |
| `POST` | `/api/telemetry/keys` | 创建写入密钥，body：`{"app_id":1,"name":"..."}`。 |
| `DELETE` | `/api/telemetry/keys/:id` | 立即禁用写入密钥。 |
| `GET` | `/api/telemetry/summary?app_id=<id>&hours=<n>` | 获取按版本、事件、维度和状态汇总的数据；`hours` 默认为 24，范围为 1 至 2160。 |
| `GET` | `/api/telemetry/timeseries?app_id=<id>&hours=<n>` | 获取按小时、版本、事件、维度和状态汇总的时间序列；参数范围与 `summary` 相同。 |
| `DELETE` | `/api/telemetry/data` | 立即删除超过当前保留期限的聚合数据和过期 nonce。 |

时间序列响应中的每一行包含 `app_id`、`bucket_ts`、`app_version`、`event_type`、`dimension`、`status`、`event_count`、`success_count`、`total_duration_ms` 和 `total_value`。`bucket_ts` 是小时桶起始时间的 Unix 秒级时间戳。同一应用、小时和维度下的不同安装数据会合并，响应不会返回安装标识哈希、事件 ID、写入密钥、原始事件或请求内容。

创建写入密钥的响应示例：

```json
{
  "success": true,
  "data": {
    "key": {
      "id": 1,
      "app_id": 1,
      "name": "production",
      "key_id": "...",
      "key_prefix": "...",
      "created_at": "2026-08-02T00:00:00Z"
    },
    "secret": "..."
  }
}
```

`secret` 只会在创建响应中返回一次。应立即存放到调用方的受控密钥存储中，之后无法通过管理接口恢复。禁用密钥后，使用该密钥的后续写入会被拒绝。

## 限流与保留

默认每分钟最多接收 120 个请求，分别对全局、来源 IP 和写入密钥执行限制；全局上限是单项配置的 10 倍。启用 Redis 时，限流计数在共享 Redis 的节点间一致；未启用 Redis 时计数仅在本地进程内生效。

聚合数据默认保留 30 天，管理员可配置为 1 至 3650 天。只有 master 节点执行定期保留期清理；管理员也可以使用管理页面或 `DELETE /api/telemetry/data` 手动清理。

## 客户端实现建议

- 每个安装生成并持久化一个随机 `installation_id`；不要从用户名、邮箱、设备指纹或网络地址派生。
- 使用加密安全随机数生成 nonce，并确保在写入密钥的时间戳有效窗口内不重复。
- 将事件预先聚合后再批量上报，避免逐请求或逐用户上报。
- 遇到 `429` 或网络错误时使用有限次数的指数退避；不得无限重试或发送历史原始数据。
- 遇到 `401` 时停止使用当前写入密钥并通知管理员检查密钥是否禁用、secret 是否正确或系统时间是否异常。
- 不要将写入密钥 secret 打印到日志、浏览器存储、遥测事件或错误报告中。
