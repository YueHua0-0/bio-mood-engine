# 12 · API 服务与接口契约

| 项目 | 内容 |
| --- | --- |
| 任务书编号 | 12 |
| 执行者 | API 服务 Agent |
| 波次 | 6 |
| 依赖 | `00` §2.2–§2.4 / §3 / §9 / §10 / §11 / §12；`02` 的 `models.mjs`、`clock.mjs`、`coordinator.mjs`；`04` 的 `StateRepository`；`09` 的情绪输出；10/11 的行为与交付结果 |
| 交付 | `lib/api/server.mjs`、`router.mjs`、`auth.mjs`、`validate.mjs`、`errors.mjs`、`docs/api_contract.md` |
| 下游 | 13 插件适配层、14 测试基线 |

## 1. 背景与目标
引擎核心是纯函数与仓库接口，外部世界需要一个窄而稳的边界：校验输入、鉴权、限流、幂等、并发保护、错误映射，然后把工作交给 02 与 04。本文件定义这条边界的**接口契约**，实现必须严格照此，不得在 HTTP 层混入业务算法。

所有响应中的生理、睡眠与情绪数值均为**虚构角色状态模拟**，不是人体医学模型，不用于诊断、治疗或现实健康预测。API 不得暴露任何可被误读为医学结论的字段。

### 1.1 关键约束（摘自 00，不得改动）
- 成功/失败信封结构与字段名严格等于 00 §12.1–§12.2。
- 时间一律 UTC ISO 8601 毫秒 + `Z`（00 §2.2）；`event_type` / `relationship_tag` 严格取 00 §2.3 / §2.4 枚举。
- 一次状态推进在单事务内完成；失败回滚，`state_version` 不变（00 §11.1）。
- 日志不得记录正文、令牌、完整种子（00 §10.2）。
- 令牌只从环境变量读取，不写入配置、响应、错误详情或日志。

## 2. 范围与非目标
**范围**：六个端点的请求/响应契约；信封；Bearer 鉴权与角色白名单；请求体与字段严格校验；限流；幂等；角色级串行与乐观锁；超时；健康与版本；`dry_run`；管理重置与审计；错误码到 HTTP 的映射；结构化日志；监听地址与部署约束。
**非目标**：不实现业务算法（02/05–11）；不实现存储（04）、插件适配（13）；不内置 TLS、不做反向代理、不做账号体系或多租户；不做 WebSocket/推送（推送由 13 依据 `delivery.policy` 处理）。

## 3. 契约摘要
| 契约项 | 位置 | 用途 |
| --- | --- | --- |
| 请求/响应示例 | 00 §12.3–§12.4 | 字段与嵌套形状 |
| 成功/失败信封 | 00 §12.1–§12.2 | 所有响应 |
| 时间格式 | 00 §2.2 | 校验与回显 |
| `event_type` / `relationship_tag` | 00 §2.3 / §2.4 | 枚举校验 |
| 错误码表 | 00 §9.2 | HTTP 映射 |
| 事务与幂等 | 00 §11.1–§11.2 | 原子推进与去重 |
| 乐观锁 | 00 §11.3 | 409 与重试上限 |
| 日志字段 | 00 §10.1 | 访问日志与推进日志 |
| 不变量 I2 / I3 / I9 / I10 | 00 §13 | 自检 |

## 4. 输入 / 输出

### 4.1 端点表
| 方法 | 路径 | 用途 | 请求要点 | 成功 `data` | 超时 |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/v1/events` | 提交单条事件并推进状态 | 00 §12.3 事件体 | 00 §12.4 引擎响应 | 5 s |
| `GET` | `/v1/state/{character_id}` | 读取状态快照 | 无 body | `{state_summary, state_version, updated_at}` | 5 s |
| `POST` | `/v1/tick` | 空闲推进 | `{character_id, now, dry_run}` | `{state_version, dry_run, delivery}` | 10 s |
| `POST` | `/v1/admin/reset` | 管理重置 | `{character_id, operation, now, payload?}` | `{operation, accepted_at}` | 5 s |
| `GET` | `/health` | 存活与存储健康 | 无 | `{status:'ok', storage:'ok'\|'degraded'}` | 5 s |
| `GET` | `/version` | 版本信息 | 无 | `{api_version:'v1', engine_version, schema_version:1}` | 5 s |

`/health` 与 `/version` 不要求角色白名单，但**仍要求** `Authorization` 头；未配置令牌时服务拒绝启动，不得以匿名模式运行。

### 4.1.1 `state_summary` 的字段与脱敏

`state_summary` 是只读投影，不是完整 `CharacterState`，禁止原样返回存储对象：

| 允许返回 | 禁止返回 |
| --- | --- |
| `character_id`、`timezone`、`state_version`、`updated_at` | `random.master_seed_hex` |
| `cycle` 的 `phase` / `cycle_day` / `phase_progress` / `confidence` | `random.streams` 的计数器与种子片段 |
| `sleep` 的状态/睡眠债/计划唤醒 | 事件正文、原始 `wxid`、令牌 |
| `stress.level` 与事件条数（不含 `source_key` 原值） | `evlog` 原始条目、`idem` 键 |
| `mood.*` 七维、`regulation.*` 六维 | 内部堆栈、文件路径、`meta.tx_journal` |

- `random` 段整体替换为 `{algorithm, algorithm_version, master_seed_id}`，其中 `master_seed_id = sha256(master_seed_hex)` 前 8 位十六进制（00 §10.2.1）。
- 任何响应、错误详情、日志都不得出现 `master_seed_hex` 全量；A19 用例强制校验。
- `/v1/events`、`/v1/state/{id}`、`/v1/tick` 的 `state_summary` 使用**同一套**字段（00 §12.4），不再区分精简版与扩展版；`GET /v1/state` 的顶层 `state_version` / `updated_at` 必须与 `state_summary` 内同名值一致。

### 4.2 信封
```json
{ "ok": true, "api_version": "v1", "request_id": "9f2c...", "data": {} }
```
```json
{ "ok": false, "api_version": "v1", "request_id": "9f2c...",
  "error": { "code": "INVALID_REQUEST", "message": "unknown field: foo", "retryable": false, "details": {"path": "foo"} } }
```
`request_id` 由服务端生成（UUID v4 或 32 位十六进制），每个请求唯一，原样回显；客户端传入的 `X-Request-Id` 只作为 `details.client_request_id` 记录，不替代服务端 `request_id`。`message` 必须可读但不含内部路径、令牌或堆栈。

### 4.3 错误对象
`error.code` 一律来自 §5.10 映射表；`error.retryable` 必须与表中一致；`error.details` 只放可公开的定位信息（字段路径、期望格式、限流剩余秒数），不含请求体原文。

## 5. 算法与规则

### 5.1 鉴权
| 项 | 规则 |
| --- | --- |
| 头格式 | `Authorization: Bearer <token>`；大小写不敏感匹配 `bearer`，其余部分原样比较 |
| 令牌来源 | 仅 `process.env.BM_API_TOKEN`；缺失或长度 <16 时服务启动失败，不得降级为无鉴权 |
| 比较 | 先对两侧做等长 SHA-256 再 `crypto.timingSafeEqual`，禁止 `===` 短路比较 |
| 缺失/格式错/不匹配 | `401 UNAUTHORIZED`，`details` 不回显收到的令牌前缀 |
| 角色白名单 | 配置 `allowed_character_ids`（数组）；不含目标角色 → `403 FORBIDDEN_CHARACTER` |
| 空白名单 | 除 `/health`、`/version` 外全部 `403 FORBIDDEN_CHARACTER` |
| 令牌轮换 | 仅支持单令牌；多令牌属契约变更 |

### 5.2 请求校验
| 规则 | 处理 |
| --- | --- |
| `Content-Type` 必须为 `application/json`（`charset` 允许） | 否则 `415 UNSUPPORTED_MEDIA_TYPE` |
| body 字节数 ≤ 64 KiB（65536） | 超限 `413 PAYLOAD_TOO_LARGE`，不读入内存后再判断 |
| 未知字段 | 拒绝，`400 INVALID_REQUEST`，`details.unknown_fields` 列出键名 |
| 嵌套对象 | 每层都 `additionalProperties:false`；缺必填字段 → `INVALID_REQUEST` |
| 时间 | 必须 `YYYY-MM-DDTHH:mm:ss.sssZ`；无毫秒、无 `Z`、Unix 秒一律 `INVALID_TIME` |
| `event_type` | 必须来自 00 §2.3；未知值 `INVALID_REQUEST`，不得回退为 `group_message` |
| `relationship_tag` | 必须来自 00 §2.4；缺省或未知按 `unknown` 处理并追加 `UNKNOWN_RELATIONSHIP_TAG` 到 `details.warnings` |
| 标识符 | `character_id` / `event_id` / `conversation_id` / `sender_id` 按 00 §2.1 正则校验 |
| 数值 | 任何 `NaN` / `Infinity` / 越界 → `INVALID_REQUEST`，不静默钳制 |

**64 KiB 的两条拒绝路径（P-12-04）**：① 带 `Content-Length` 且已超限 → 读 body 之前直接 413；② 无 `Content-Length` / 分块传输 → 累计超限时 `req.pause()` 后 413。两种情况都回 `Connection: close`，并由 2 s `unref` 定时器兜底 `socket.destroy()`。**不得**直接 `req.destroy()` 断连——否则客户端收到的是 `ECONNRESET` 而不是 413，A06 的断言会失败。

**各端点的 body 字段白名单（P-15-01，裁决 A：文档化现状）**

| 端点 | 允许字段 | `api_version` / `actor_id` |
| --- | --- | --- |
| `POST /v1/events` | `api_version`、`event_id`、`idempotency_key`、`character_id`、`event_type`、`occurred_at`、`received_at`、`source`、`payload`、`tags` | `api_version` **接受**（缺省按 00 §12.1 的当前版本处理）；`actor_id` **不接受** |
| `POST /v1/tick` | `character_id`、`now`、`dry_run?` | 两者**都不接受**，出现即 `400 INVALID_REQUEST`，`details.unknown_fields` 列出键名 |
| `POST /v1/admin/reset` | `character_id`、`operation`、`now`、`payload?` | 两者**都不接受**，同上 |

实现：`lib/api/validate.mjs` 的 `EVENT_KEYS` / `TICK_KEYS` / `ADMIN_KEYS` 三个集合 + `collectUnknown()`；未列入白名单的字段一律拒绝，不做静默忽略。调用方若需要统一的公共字段，应只发 `events`，或先收敛到本文档再改代码。

**cycle profile 配置（D2 裁决）**：HTTP 本轮**固定默认 1.0**，所有四个 `cycle.profile` 设置在服务端硬编码默认值，不接受请求体入参、不从环境变量或其他配置源读取。四个设置的完整语义、范围与非法值处理见 00 §8 和 05 §5.3.2。如需调整 profile，必须通过插件设置（13 §4.4）完成，不新增 HTTP 配置接口。

**事件时间钳制（P-02-02）**：`POST /v1/events` 在 schema 校验通过后、幂等判定与推进之前，若 `occurred_at > received_at + 300000 ms`，令 `occurred_at = received_at` 并向 `data.diagnostics.warnings` 追加 `FUTURE_OCCURRED_AT`；`evlog.occurred_at` 与 `runAdvance` 的推进基准都用钳制后的值。恰好 `+5 min` 不钳制（闭区间）。`effectiveNow()` 只负责推进基准不回退，不处理事件时间。验收见 A21。

### 5.3 限流
| 作用域 | 上限 | 窗口 | 超限 |
| --- | --- | --- | --- |
| `POST /v1/events` | 120 次 | 滑动 60 s | `429 RATE_LIMITED` + `details.retry_after_seconds` |
| 其余 3 个业务端点合计（`/v1/state`、`/v1/tick`、`/v1/admin/reset`） | 60 次 | 滑动 60 s | 同上 |

两个计数器独立：`/v1/events` 不计入"其余端点"的 60 次额度；`/health` 与 `/version` **不计入任何限流**（否则健康检查会耗尽业务配额，v1.7.11，P2-4）。**计数位置固定在鉴权之后、请求校验之前**：被限流的请求不读 body，因此非法 body 也能稳定触发 429（A10 不依赖 body 合法性，v1.7.12，P2-4 补充）。限流键为令牌指纹（`sha256(token)` 前 16 位），不得用原始令牌。响应头带 `Retry-After`，`retry_after_seconds` 为向上取整的正整数，最小 1。时间一律取注入的 `clock()` 函数（与 04 的 `clock: () => string` 同口径，v1.7.11，P2-1）。

### 5.4 幂等
| 情形 | 行为 | HTTP |
| --- | --- | --- |
| 首次请求 | 事务内推进并记录 `(character_id, idempotency_key)` | 200 |
| 重复请求 | 返回首次 `state_version`/`processed_at` + `duplicate:true`（其余字段取当时摘要） | 200（**不用 409**） |
| 有 `Idempotency-Key` 头 | 优先使用该值（与 00 §2.1 同规则） | — |
| 无该头、body 有 `idempotency_key` | 用 `body.idempotency_key` | — |
| 无该头、body 无 `idempotency_key` | 用 `body.event_id` | — |
| 三者都缺 | 拒绝 | 400 `INVALID_REQUEST` |
| 头与 body 都提供且不相等 | 拒绝，`details.reason='idempotency_key_conflict'` | 400 `INVALID_REQUEST` |
| 幂等记录已过期（7 天） | 视为新请求，正常推进 | 200 |

优先级固定为 **`Idempotency-Key` 头 > `body.idempotency_key` > `body.event_id`**（v1.7.11，P1-C，与 00 §2.1 一致）；不得静默忽略 body 上的 `idempotency_key`。

重复请求**不得重新计算、不得刷新时间戳**：`state_version` 与 `processed_at` 必须取首次值；`state_summary` / `delivery` / `behavior_context` 优先取 `meta.snapshots` 中同一 `state_version` 的摘要（00 §11.5 保留 12 条），摘要已被淘汰时返回 `null` 并置 `snapshot_evicted:true`；`snapshot_evicted` **仅在 `true` 时出现，`false` 时整键省略**（不得输出 `false` 或 `null`，v1.7.11，P3）。禁止用"当前状态"冒充首次结果，也禁止为了回放把完整响应写进 `idem`（幂等键只存 `{key, state_version, processed_at}`）。

### 5.5 并发
同一 `character_id` 的读-算-写必须串行（02 的 `createMutex()`）；冲突最多重试 2 次（总计 3 次尝试），仍失败返回 `409`，重试期间不得重复写事件日志；不同 `character_id` 必须可并行。**一次推进必须是单个 `repo.transaction`**（`putState` → `appendEvent` → `appendIdempotency`，顺序固定），乐观锁冲突时**重跑整个事务**，不得单独调 `saveState`（那样会绕过 WAL、幂等与事件日志，v1.7.11，P1-5）：

```text
attempt = 0
while attempt <= 2:
    try:
        return await repo.transaction(async tx => {
            await tx.putState(nextState, expectedVersion)   // 冲突在此抛出
            await tx.appendEvent(evlogRecord)
            await tx.appendIdempotency(idemRecord)
            await tx.putMeta(metaNext)
        })
    catch e:
        if e.code != 'STATE_VERSION_CONFLICT': throw
        attempt += 1; sleep(200ms 或 600ms)
throw STATE_VERSION_CONFLICT                   // 409, retryable:true
```

每次重试由 04 独立开 WAL 与清理，`tx_journal` 不残留。`putState` 冲突时 `fn` 立即抛出，`appendEvent` / `appendIdempotency` 尚未执行，因此重试不会产生重复的 `evlog` 条目（A12b 依赖这一点）。

### 5.6 超时与事务
| 项 | 规则 |
| --- | --- |
| 普通请求 | 处理 ≤5 s；`/v1/tick` ≤10 s |
| 超时值来源 | `config.request_timeout_ms` / `config.tick_timeout_ms`，**由部署方提供，不属于引擎配置**（不进 00 §8，v1.7.11，P2-5）；测试可设为 50 ms |
| 超时动作 | 触发 `AbortController.abort()` → `repo.transaction(fn, {signal})` 回滚 → 返回 500 `INTERNAL`（`details.reason='timeout'`），不返回半成品 |
| 客户端断开 | `req.on('close')` 中**先判 `!res.writableEnded`** 再 abort（正常响应后 `close` 也会触发，否则会误中止每个成功请求，v1.7.11，P2-2） |
| 内部 `ABORTED` | **不是**公开错误码：捕获后映射为 `INTERNAL`，不得透出 `error.code='ABORTED'` |
| 模块抛错 | 由 02 回滚，映射为 `MODULE_FAILED` 500 |
| 存储失败 | `STORAGE_FAILED` 503，`retryable:true` |

**已提交不可中止**：W7 之后 `signal` 不再被检查，因此超时只可能发生在提交前；若中止在提交后才到达，事务已成功，响应按成功返回（04 §5.3）。

### 5.7 `POST /v1/tick`
请求 `{character_id, now, dry_run}`：`dry_run` 缺省 `false`。`dry_run=true` 时只执行计算并返回 `{state_version, dry_run:true, delivery}`，**不得**调用 `saveState`、`appendEvent`、`appendIdempotency`；`data.state_version` 为"若保存将得到"的版本：`cur === null → 0`，否则 `cur.version + 1`（与 04 §5.4 的创建/更新语义一致）。`dry_run` 只由 `data.dry_run` 表达——成功信封没有 `details` 字段，**不得**用 `details.preview` 标注（v1.7.11，P1-4）。`now` 早于 `last_tick_at` 时按 00 §5.2 钳制。

`delivery` 按 11 §5.3 规则 0（纯时间推进）：`policy='silent_ignore'`、`reason_codes=['no_event']`、`recommended_delay_seconds=0`、`deliver_after=now`、`expires_at=null`、`coalesced_into` 整键省略、`wake_cost` 为 `[0,1]` 的 number。

### 5.8 `POST /v1/admin/reset`
需独立的管理令牌 `process.env.BM_ADMIN_TOKEN`（与业务令牌不同、不得相同；相同则启动失败）：

| `operation` | 语义 | 审计 |
| --- | --- | --- |
| `reset_state` | 覆盖 `state` 为契约默认值（`state_version` = 旧值 + 1，不回退为 0），清空 `idem`；**保留 `evlog` 审计记录**与 `cfg`（与 13 §5.9、04 §6 一致）。失败时若返回 `STORAGE_FAILED` 且 `details.recovery_required=true`，必须由同一 `operation` 修复，不得重试 `reset_seed`。 | 记录 `operation` + `at` |
| `reset_seed` | 重新派生 `random.streams`（五条流 `seed_hex` 重派生、计数器归零），保留 `state` 其余字段与 `evlog` | 记录 `operation` + `at` |
| `manual_cycle_correction` | 人工校正周期锚点（`anchor_at` 必填，`cycle_length_days` 可选，范围 `[20,45]`）；行为同 13 §5.9 | 记录 `operation` + `at` |

**`payload` 的位置与校验（v1.7.11，P1-3）**：请求体为 `{character_id, operation, now, payload?}`，`payload` 是**顶层嵌套对象**，不内联到 `character_id` 同级以外的位置。`manual_cycle_correction` 的 `anchor_at`（必填，UTC 毫秒 `Z`）与 `cycle_length_days`（可选，`[20,45]` 整数）**放在 `payload` 内**；其余两个 operation 的 `payload` 必须缺省或为 `{}`，且 `payload` 每层 `additionalProperties:false`。校验层按 `operation` 分支选择 schema，未知键 → `400 INVALID_REQUEST` + `details.unknown_fields`。

**唯一实现**：12 只做参数校验与结果映射，键操作全部调用 `repo.adminReset(characterId, {operation, payload, now, prepare})`（04 §6，v1.7.11，P1-A）；不得在 HTTP 层自行读写 `state` / `idem` / `evlog` / `meta`。`now` 取请求体；`manual_cycle_correction` 由 12 注入 `prepare`（内部调用 05 的 `applyManualCorrection`，见 13 §5.9），04 只强制版本与时间戳并校验结果。返回 `{ok:false, code:'STORAGE_FAILED', details:{recovery_required:true}}` 时映射为 `503` + `details.recovery_required=true`，**不自动重试**。**应用审计日志**（§5.9 的结构化单行日志）只写操作类型与时间（+ `character_id`、`request_id`），**不写**被清空的旧状态、种子或任何数值。**存储层 `evlog`** 是另一层：管理操作另需在 `evlog` 追加一条 `event_type='admin_command'` 的记录（字段、`source_key` 格式、确定性 `event_id` 见 04 §6），同样不含正文/种子/令牌，用于 13 的 `export_diagnostics` 与事后审计。两层用途不同，缺一不可。未知 `operation` → `400 INVALID_REQUEST`。

### 5.9 日志
结构化 JSON，单行，字段：`ts` / `level` / `request_id` / `method` / `path` / `status` / `duration_ms` / `character_id` / `event_id` / `state_version_before` / `state_version_after` / `policy` / `error_code`。禁止写入：请求体、响应体、`Authorization` 头、令牌、`master_seed_hex` 全量（只允许 `master_seed_id`）。推进日志字段与 00 §10.1 一致，不得另起格式。

### 5.10 错误码 → HTTP 映射
| code | HTTP | retryable | 来源 |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | false | 00 §9.2 |
| `INVALID_TIME` | 400 | false | 00 §9.2 |
| `PAYLOAD_TOO_LARGE` | 413 | false | 00 §9.2（v1.1 已并入） |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | false | 00 §9.2（v1.1 已并入） |
| `UNAUTHORIZED` | 401 | false | 00 §9.2 |
| `FORBIDDEN_CHARACTER` | 403 | false | 00 §9.2 |
| `NOT_FOUND` | 404 | false | 00 §9.2 |
| `DUPLICATE_EVENT` | 200 | false | 00 §9.2（返回 `duplicate:true`） |
| `STATE_VERSION_CONFLICT` | 409 | true | 00 §9.2 |
| `RATE_LIMITED` | 429 | true | 00 §9.2 |
| `CLOCK_REGRESSION` | 200 | false | 00 §9.2 |
| `MODULE_FAILED` | 500 | false | 00 §9.2 |
| `STORAGE_FAILED` | 503 | true | 00 §9.2 |
| `DEGRADED` | 200 | true | 00 §9.2 |
| `INTERNAL` | 500 | false | 00 §9.2 |

`PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` 已由总控并入 00 §9.2（契约 v1.1 澄清，`schema_version` 不变）；模块不得自行扩展错误码。

**200 类码不产生 `error`（v1.7.9，W6-2）**：上表的 `DUPLICATE_EVENT` / `CLOCK_REGRESSION` / `DEGRADED` 虽有 HTTP 200，但**一律走成功信封** `{ok:true, data}`，`error` 分支永不出现这三个 `code`。`DUPLICATE_EVENT` 由 `data.duplicate=true` 表达；`CLOCK_REGRESSION` 与 `DEGRADED` 由 `data.diagnostics.warnings` 表达。`/v1/events` 与 `/v1/tick` 永不返回 `error.code='DEGRADED'`（远程模式无主聊天作用域，`DEGRADED` 只属于 13 的插件模式）。

### 5.11 部署
默认只监听 `127.0.0.1`，端口由 `BM_PORT` 提供（默认 8787，禁止 `0.0.0.0` 作为默认值）。远程模式必须由反向代理终止 HTTPS，服务本身不内置 TLS、不读证书。禁止开启通配 CORS；响应头不暴露 `Server` 版本细节；错误响应不得包含堆栈或内部路径。

**启动期令牌校验（P-12-02，v1.7.13）**：`BM_API_TOKEN` 与 `BM_ADMIN_TOKEN` 任一缺失、长度 <16、或两者相等，进程**拒绝启动**并在 stderr 输出不含令牌值的错误行，不进入 `listen`。管理端点**不提供**「无令牌 401」模式——fail-closed 是唯一语义。

**存储注入（P-04-07，W1）**：HTTP 服务**不内置存储**，也不从环境变量猜测 `character_id`。部署方必须用 04 的 `createFileStore`（默认介质）或 `createSqliteStore` 组装 `createRepository({storage, character_id, ...})`，再把 `repo` 注入 `startApiServer({repo, ...})`；未注入 `repo` 时 `startApiServer` 直接抛错、不进入 `listen`，与令牌校验同级。`/health` 的 `storage` 字段来自该 `repo` 的 `loadState({readOnly:true})`，不得另行探测文件或数据库。
## 6. 边界与错误
### 6.0 请求处理顺序（v1.7.12 定死，A06/A10 依赖）

下表是**校验阶段**的顺序；auth 与限流在其之前。实现不得从 Content-Type 开始：

```text
1. request_id = crypto.randomUUID()            ← 最先；413/415 也必须有
2. Authorization 解析 + 常量时间比较            ← 401，不读 body
3. 角色白名单（path 里的 character_id；/health、/version 跳过） ← 403
4. 限流计数（鉴权后、校验前；/health、/version 不计）          ← 429，不读 body
5. Content-Type 检查                            ← 415，不读 body
6. body 上限：带 Content-Length 且超限 → 读之前 413
   无 Content-Length → 累计 >65536 时 pause + 413
   两种情况均回 Connection: close，2 s unref 定时器兜底 destroy  ← 413（P-12-04）
7. JSON 解析                                    ← 400 INVALID_REQUEST
8. schema 校验（未知字段、必填、时间、枚举、数值）← 400 / INVALID_TIME
9. 路由到业务
```

把 auth 与限流提前的理由：A02–A04 不必构造合法 body；A10 用非法 body 也能稳定触发 429；无鉴权的巨型 body 不会先被读 64 KiB 再拒绝。

| 场景 | 处理 | 错误码 |
| --- | --- | --- |
| 无非 JSON `Content-Type` | 拒绝，不解析 body | `UNSUPPORTED_MEDIA_TYPE` |
| body 超 64 KiB | 到达上限即中止读取 | `PAYLOAD_TOO_LARGE` |
| 未知字段 / 未知枚举 | 拒绝并列出字段路径 | `INVALID_REQUEST` |
| 时间缺毫秒或无 `Z` | 拒绝 | `INVALID_TIME` |
| 角色不存在 | 返回 404，不自动创建 | `NOT_FOUND` |
| 幂等键重复 | 返回首次结果 | `DUPLICATE_EVENT`（HTTP 200） |
| 版本冲突重试 2 次仍失败 | 返回 409 | `STATE_VERSION_CONFLICT` |
| 处理超时 | 中止 + 回滚 | `INTERNAL` |
| 存储不可用 | 503，`retry_after` 由调用方决定 | `STORAGE_FAILED` |
| 管理令牌缺失/错误 | 401，不提示"是管理接口" | `UNAUTHORIZED` |
| 审计写入失败 | 拒绝执行重置 | `STORAGE_FAILED` |
| 管理操作失败且已写 `recovery_required` | 返回 503，指引管理员执行 `reset_state` | `STORAGE_FAILED` |

## 7. 交付文件
```text
lib/api/server.mjs     # 监听、生命周期、超时、优雅关闭
lib/api/handler.mjs    # createHandler({repo, config, clock, idFactory, logger}) → (req,res)=>Promise（v1.7.11）
lib/api/router.mjs     # 路由表与请求分发
lib/api/auth.mjs       # Bearer 解析、常量时间比较、角色白名单
lib/api/validate.mjs   # body 上限、严格 schema、时间与枚举校验
lib/api/errors.mjs     # 错误码 → HTTP 映射、信封构造
lib/api/ratelimit.mjs  # 两个滑动窗口计数器（v1.7.11）
docs/api_contract.md   # 对外接口契约（端点、字段、示例、错误码）
tests/unit/api_auth.test.mjs        # A02–A04、A20
tests/unit/api_validation.test.mjs  # A05–A09、A16、A17
tests/unit/api_limits.test.mjs      # A10、A18
tests/unit/api_endpoints.test.mjs   # A01、A11、A12a、A12b、A13、A14、A15、A19
```

`handler.mjs` 是 A01–A19 零 mock 的关键：路由、校验、信封全在 handler 内，`server.mjs` 只做 `http.createServer(createHandler(...)).listen(...)`；集成测试用 `http.request` 打临时端口（`port: 0`），不需要 mock 半个 HTTP 栈。
不得修改 `00`–`11`，不得新增本清单以外的文件，不得在 HTTP 层实现业务算法。

## 8. 测试要求
| 编号 | 用例 | 预期 |
| --- | --- | --- |
| A01 | `POST /v1/events` 合法请求 | 200，`ok:true`、`api_version:'v1'`、`data.delivery.policy` 合法 |
| A02 | 缺 `Authorization` 头 | 401 `UNAUTHORIZED`，无业务数据 |
| A03 | 错误令牌 / 空 Bearer | 401 `UNAUTHORIZED`，`details` 不回显令牌 |
| A04 | 令牌无该 `character_id` 权限 | 403 `FORBIDDEN_CHARACTER` |
| A05 | 请求含未知字段 `foo` | 400 `INVALID_REQUEST`，`details.unknown_fields` 含 `foo` |
| A06 | body 65537 字节（用 `pad: "x".repeat(70000)` 撑大） | 413 `PAYLOAD_TOO_LARGE`，**优先于** 400（Content-Type → 64 KiB → JSON 解析 → 未知字段的校验顺序） |
| A07 | `Content-Type: text/plain` | 415 `UNSUPPORTED_MEDIA_TYPE` |
| A08 | `occurred_at` 缺毫秒 / 无 `Z` | 400 `INVALID_TIME` |
| A09 | `event_type: "chat"` | 400 `INVALID_REQUEST`，不回退为 `group_message` |
| A10 | 同一令牌 61 次 `/v1/state` / 121 次 `/v1/events`；`/health`、`/version` 任意次 | 第 61 / 121 次 429 `RATE_LIMITED`，含整数 `retry_after_seconds ≥ 1`；健康与版本请求永不计入 |
| A11 | 同 `Idempotency-Key` 连发两次 | 均为 200，第二次 `duplicate:true`，`state_version`/`processed_at` 与首次逐字段相同；`snapshot_evicted` 缺省不出现（真值才出现） |
| A12a | 并发两次推进同一角色 | 均 200，两个 `state_version` 的**集合为 `{1,2}`**（响应顺序不确定，不断言"依次"） |
| A12b | 测试替身在 `putState` 前把存储版本 +1，触发 3 次尝试全部冲突 | 409 `STATE_VERSION_CONFLICT` `retryable:true`；`evlog` 只有一条（`putState` 冲突时 `appendEvent` 未执行） |
| A13 | `GET /v1/state/{id}` 成功 / 不存在 | 200 含 `state_summary` / 404 `NOT_FOUND` |
| A14 | `POST /v1/tick` `dry_run:true` | `data.dry_run === true`、`data.state_version` = 当前 +1（无 state 时为 0）；存储无写入、`evlog` 无新增；响应中**无** `details` |
| A15 | `POST /v1/admin/reset` 三种操作 / 缺管理令牌 | 200 `{operation, accepted_at}` 且审计仅含操作类型与时间；`manual_cycle_correction` 用过去时间 `2026-11-01T00:00:00.000Z`，`anchor_at` 晚于 `now` 则 400；缺令牌 401 |
| A16 | 遍历全部响应的信封字段 | `ok` / `api_version` / `request_id` / `data` 或 `error` 完整 |
| A17 | 连续 100 次请求的 `request_id` | 全部互不相同 |
| A18 | 存储不可用时 `GET /health`，以及 `GET /version` | 200，`{status:'ok', storage:'degraded'}` 且不含内部路径；`{api_version:'v1', engine_version, schema_version:1}` |
| A19 | 遍历 `GET /v1/state/{id}`、错误详情与日志 | 无 `master_seed_hex` 全量、无 `streams` 计数器、无事件正文与原始 `wxid`；`random` 只含 `master_seed_id` |
| A20 | 启动期 `BM_ADMIN_TOKEN` 缺失 / 过短 / 与 `BM_API_TOKEN` 相等 | `readConfigFromEnv` 抛错，不进入 `listen`；错误串不含任何令牌值 |
| A21 | `occurred_at > received_at + 5min`（6 分钟）/ 恰好 `+5min` | 前者 200 且 `data.diagnostics.warnings` 含 `FUTURE_OCCURRED_AT`、`evlog.occurred_at` 等于 `received_at`；后者不钳制、不告警 |

## 9. 验收命令
```powershell
node --test tests/unit/api_auth.test.mjs tests/unit/api_validation.test.mjs tests/unit/api_limits.test.mjs tests/unit/api_endpoints.test.mjs
Select-String -Path "lib/api/*.mjs" -Pattern "process\.env" | Select-Object Filename,LineNumber
Select-String -Path "lib/api/*.mjs" -Pattern "console\.log|master_seed_hex"
```
预期：四个测试文件全通过（A01–A20）；`process.env` 只出现在 `server.mjs`（启动读取）；`console.log|master_seed_hex` 检索无输出（无直接打印、无种子落日志）。

> **W2 已完成（P-12-08）**：A01、A11、A12a、A12b、A13、A14、A15、A19 落在 `tests/unit/api_endpoints.test.mjs`，使用真实 04 仓库（内存存储）+ 真实 HTTP 端口，不再依赖 `not_implemented` 兜底。

> **鉴权头不在零输出检索内（P-12-01）**：`auth.mjs` 读取鉴权头是正常实现，且 PowerShell 的 `Select-String` 默认不区分大小写，无法区分「头名」与「令牌落日志」。令牌不落日志由 §5.9 的字段白名单保证，不靠文本检索。
>
> **测试目录（P-12-07）**：仓库当前只有 `tests/unit`、`tests/simulation`、`tests/fixtures`，12 与 14 原先写的 `tests/integration` 尚未创建；在 14 的 integration/contract 目录落地前，API 用例一律放 `tests/unit/api_*.test.mjs`。

## 10. 禁止事项
1. 禁止在 HTTP 层实现周期、睡眠、压力、情绪或行为算法；只能调用 02/04 与既有模块。
2. 禁止把令牌写入配置、响应、错误详情或日志；禁止用 `===` 比较令牌。
3. 禁止为兼容客户端把重复请求改成 409；必须 200 + `duplicate:true`。
4. 禁止超时后继续后台写状态，或返回半成品 `data`。
5. 禁止默认监听 `0.0.0.0`、内置 TLS、开启通配 CORS 或暴露堆栈。
6. 禁止记录请求/响应正文、完整种子；禁止在 `/health` 暴露路径、版本细节或依赖清单。
7. 禁止在 `dry_run` 路径调用任何写方法；禁止不同角色之间全局串行。
8. 禁止修改 `00`–`11`；需要新端点或新错误码时走契约变更流程。
## 11. 汇报模板
```text
模块：12 API 服务与接口契约
波次：6
依赖版本：00-统一契约 v1.7.3 / schema_version 1
完成的任务：六端点 / 信封 / Bearer 鉴权与白名单 / 严格校验 / 限流 / 幂等 / 并发 / 超时 / 日志 / 部署约束
新增文件：lib/api/*.mjs、docs/api_contract.md、tests/integration/api_*.test.mjs
关键设计决策：<限流双计数器 / 幂等 200 而非 409 / dry_run 预演版本>
测试命令：node --test tests/integration/api_*.test.mjs
测试结果：pass <> / fail 0；p95 延迟 <> ms
未解决问题：<逐条>
已知风险：<例如单令牌模型无法按调用方隔离额度>
是否需要契约变更：是/否（若需并入 413/415 则填"是"）
下一模块建议：13 插件适配层
```
