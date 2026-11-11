# Bio-Mood Engine · 对外接口契约（v1）

> 依据：`00-统一契约.md` §12、`12-API服务与接口契约.md` §4–§5。本文件只描述对外可见行为，不重复内部算法。
> 所有生理、睡眠与情绪数值均为**虚构角色状态模拟**，不是医学模型，不用于诊断或现实健康预测。

## 1. 基础约定

| 项 | 约定 |
| --- | --- |
| Base URL | 由部署方决定；监听地址默认 `127.0.0.1`，不内置 TLS |
| 版本前缀 | `/v1` |
| 时间 | UTC ISO 8601，毫秒 + `Z`：`2026-11-09T09:00:00.000Z` |
| 请求体 | `Content-Type: application/json`，≤ 64 KiB |
| 鉴权 | `Authorization: Bearer <token>`；令牌只来自环境变量 `BM_API_TOKEN` |
| 管理鉴权 | `/v1/admin/reset` 使用 `BM_ADMIN_TOKEN`；业务令牌一律 401 |
| 响应 | 成功/失败统一信封；`request_id` 由服务端生成 |
| 限流 | `/v1/events` 120 次/60 s；其余业务端点合计 60 次/60 s；`/health`、`/version` 不限流 |

## 2. 信封

成功：

```json
{
  "ok": true,
  "api_version": "v1",
  "request_id": "0f7c5d0a-7a5e-4a2b-9d1e-2c3b4a5d6e7f",
  "data": {}
}
```

失败：

```json
{
  "ok": false,
  "api_version": "v1",
  "request_id": "0f7c5d0a-7a5e-4a2b-9d1e-2c3b4a5d6e7f",
  "error": {
    "code": "INVALID_REQUEST",
    "message": "unknown field: foo",
    "retryable": false,
    "details": { "unknown_fields": ["foo"] }
  }
}
```

`message` 不含内部路径、令牌或堆栈；`details` 只放字段路径、期望格式、限流剩余秒数等可公开信息。

## 3. 端点

### 3.1 `POST /v1/events`

提交单条事件并推进状态（单事务）。

请求体（示例）：

```json
{
  "api_version": "v1",
  "event_id": "evt_20261109_ab12cd34",
  "idempotency_key": "evt_20261109_ab12cd34",
  "character_id": "whale_character",
  "event_type": "group_message",
  "occurred_at": "2026-11-09T09:20:00.000Z",
  "received_at": "2026-11-09T09:20:01.000Z",
  "source": {
    "platform": "wechat",
    "conversation_id": "group_123",
    "conversation_kind": "group",
    "sender_id": "sender_a1",
    "is_mentioned": false,
    "relationship_tag": "ordinary"
  },
  "payload": {
    "message_type": "text",
    "text_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "text_summary": "",
    "is_direct_question": false
  },
  "tags": []
}
```

时间钳制（P-02-02）：`occurred_at > received_at + 5 min` 时服务端令 `occurred_at = received_at`，在 `data.diagnostics.warnings` 追加 `FUTURE_OCCURRED_AT`，`evlog.occurred_at` 写钳制后的值；恰好 `+5 min` 不钳制。验收 A21。

成功 `data`：

```json
{
  "event_id": "evt_20261109_ab12cd34",
  "character_id": "whale_character",
  "state_version": 1,
  "duplicate": false,
  "processed_at": "2026-11-09T09:20:01.000Z",
  "state_summary": { },
  "delivery": { "policy": "silent_ignore" },
  "behavior_context": { },
  "diagnostics": { "warnings": [] }
}
```

幂等键优先级：`Idempotency-Key` 头 > `body.idempotency_key` > `body.event_id`。重复请求返回 **200**（不是 409），`duplicate: true`，`state_version` / `processed_at` 取首次值；摘要不可用时返回 `state_summary: null` 并带 `snapshot_evicted: true`（该键只在 `true` 时出现）。

### 3.2 `GET /v1/state/{character_id}`

成功 `data`：

```json
{
  "state_summary": { },
  "state_version": 1,
  "updated_at": "2026-11-09T09:20:01.000Z"
}
```

`state_summary` 是脱敏投影：不含种子、随机流计数器、事件正文、原始 `wxid`、幂等键。`random` 段只有 `{algorithm, algorithm_version, master_seed_id}`。状态不存在 → `404 NOT_FOUND`。

### 3.3 `POST /v1/tick`

请求：`{ "character_id": "...", "now": "...", "dry_run": false }`。

字段白名单（P-15-01）：仅上述三个键；**`api_version` 与 `actor_id` 不接受**，出现即 `400 INVALID_REQUEST`（`details.unknown_fields`）。与 `/v1/events` 不同，这里没有 `api_version` 入参——版本只体现在响应信封。

成功 `data`：`{ state_version, dry_run, delivery, state_summary, diagnostics }`。

- `dry_run: true` 只计算不写库，`state_version` 为“若保存将得到”的值（无状态时为 `0`）。
- 预演不写 `state` / `evlog` / `idem`，不使用 `details.preview` 标注。

### 3.4 `POST /v1/admin/reset`

请求：`{ "character_id", "operation", "now", "payload"? }`。

字段白名单（P-15-01）：仅上述四个键；**`api_version` 与 `actor_id` 不接受**，出现即 `400 INVALID_REQUEST`（`details.unknown_fields`）。

| `operation` | 语义 |
| --- | --- |
| `reset_state` | 重建默认状态，`state_version` = 旧值 + 1，清空幂等索引，保留 `evlog` |
| `reset_seed` | 重派生五条随机流，保留状态其余字段与 `evlog` |
| `manual_cycle_correction` | `payload.anchor_at` 必填（不得晚于 `now`），`payload.cycle_length_days` 可选 `[20,45]` |

成功 `data`：`{ operation, accepted_at, state_version }`。审计只记录操作类型与时间，不含状态内容。

### 3.5 `GET /health`、`GET /version`

```json
{ "status": "ok", "storage": "ok" }
```

```json
{ "api_version": "v1", "engine_version": "0.1.0", "schema_version": 1 }
```

`storage` 为 `degraded` 时仍返回 200，不暴露路径或依赖清单。两者仍要求 `Authorization`，不计入限流。

## 4. 错误码

| `code` | HTTP | `retryable` | 说明 |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | false | 未知字段、缺字段、枚举/数值非法 |
| `INVALID_TIME` | 400 | false | 时间格式不符 |
| `UNAUTHORIZED` | 401 | false | 缺失/错误令牌 |
| `FORBIDDEN_CHARACTER` | 403 | false | 角色不在白名单 |
| `NOT_FOUND` | 404 | false | 路由或角色状态不存在 |
| `STATE_VERSION_CONFLICT` | 409 | true | 乐观锁重试 2 次后仍冲突 |
| `PAYLOAD_TOO_LARGE` | 413 | false | 请求体 > 64 KiB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | false | 非 `application/json` |
| `RATE_LIMITED` | 429 | true | 超限，`details.retry_after_seconds ≥ 1`，带 `Retry-After` |
| `MODULE_FAILED` | 500 | false | 引擎模块失败 |
| `INTERNAL` | 500 | false | 未预期错误（含超时 `details.reason='timeout'`） |
| `STORAGE_FAILED` | 503 | true | 存储不可用 |

## 5. 幂等、并发与超时

- 一次推进在单个 `repo.transaction` 内完成：`putState` → `appendEvent` → `appendIdempotency` → `putMeta`。
- 同一 `character_id` 串行；乐观锁冲突最多重试 2 次（总计 3 次尝试），仍失败返回 409。
- 普通请求 5 s、`/v1/tick` 10 s；超时中止事务并返回 500 `INTERNAL`，不返回半成品。
- 客户端断开时先判响应是否已写完，再决定是否中止。

## 6. 安全与日志

- 令牌仅从环境变量读取，不写入配置、响应、错误详情或日志。
- 日志字段白名单：`ts`、`level`、`request_id`、`method`、`path`、`status`、`duration_ms`，可选 `character_id`、`event_id`、`state_version_before`、`state_version_after`、`policy`、`error_code`。
- 任何响应与日志都不得出现 `master_seed_hex` 全量、随机流计数器、事件正文或原始 `wxid`。
