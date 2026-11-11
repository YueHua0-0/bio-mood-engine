# 13 · WeChatAgent 插件适配层

| 项目 | 内容 |
| --- | --- |
| 任务书编号 | 13 |
| 执行者 | 适配层 Agent |
| 波次 | 6 |
| 依赖 | `00`（全文）、`01` 的 G0 结论、`02` 核心与时间、`10` 行为上下文、`11` 交付策略、`12` API 契约；宿主规范 `WeChatAgent-plugin-api-v2.md` |
| 交付 | `plugin.json`、`index.mjs`、`lib/adapter/wechatagent/*.mjs`、插件内 `README.md` |
| 下游 | 15 集成联调与发布 |

## 1. 背景与目标
引擎是纯函数与仓库接口，不能直接跑在微信里。适配层是唯一接触宿主的薄边界：把微信消息压缩成**不含正文**的标准事件，把宿主 `ctx` 转换成引擎输入，再把 `state_summary` / `delivery` / `behavior_context` 交回 DSH。四条硬目标：`setup` ≤2 秒且不联网；推进 ≤8 秒（引擎 ≤5 秒）；`before-context` ≤800 毫秒且只读；任何失败都降级为"聊天照常"。

本任务书的全部数值、阈值与文案均为**虚构角色状态模拟**，不是人体医学模型，不用于诊断、治疗或现实健康预测。适配层不得输出任何可被误读为医学结论的字段或文案。

### 1.1 关键约束（摘自 00 与 API v2，不得改动）
- 时间一律 UTC ISO 8601 毫秒 + `Z`；本地时间只用 `Intl.DateTimeFormat`（00 §2.2）。
- 只提交 `text_hash`，不提交正文；日志不得出现正文、原始 wxid、令牌、完整种子（00 §10.2–§10.3）；`ctx.storage` 是"账号 + 插件 + 聊天"三重隔离，不能跨聊天读写，也不能用参数改目标。
- 钩子只允许读存储/历史，不允许写存储、联网或申请发送；每类钩子 800 毫秒；ZIP ≤ 8 MiB、解压 ≤ 16 MiB、单文件 ≤ 4 MiB、条目 ≤ 128、目录 ≤ 8 层。
- **推进位置受 01 A9 约束**：状态只在 `observe` / `tick` 两个工具内推进；`before-context` 只读、不推进、不写 storage；不注册定时器，不在 `setup` 内后台推进。若 A9 结论为"无消息级订阅"，`long_silence` 只能在下次工具调用时被发现（01 §2.2）。

## 2. 范围与非目标
**范围**：插件包结构、`plugin.json` 与 `settings`、`setup(api)` 注册顺序与预算、四个工具（`observe`/`state`/`tick`/`admin`）、两个钩子的只读边界、事件标准化与脱敏、存储键与体积、主聊天作用域与降级、打包与静态资源定位。**非目标**：不实现周期/睡眠/压力/情绪/行为算法（05–10）；不实现交付判定（11）与 HTTP 服务（12）；不接管 DSH 角色卡与提示词；不实现跨聊天广播、定时器或远程拉取的**传输实现**（远程模式的部署与客户端由 15 决定，13 只声明 `engineMode`/`engineRemoteUrl` 两个配置项）；不定义新枚举或新状态字段。

**隐私声明**：`observe` 的 `text` 明文只在插件进程内停留一次哈希的时间，哈希后立即丢弃，不落盘（P-13-12）；引擎侧始终只接收 `text_hash`。

## 3. 契约摘要
| 契约项 | 位置 | 用途 |
| --- | --- | --- |
| `CharacterState` 字段与范围 | 00 §3.1–§3.2 | 快照校验、`round6` |
| 事件请求结构 / 禁止字段 | 00 §12.3 / §3.3 | 标准化字段唯一来源，落库前拒绝 |
| 引擎响应结构 | 00 §12.4 | 工具返回裁剪依据 |
| `advance` 返回与调用方边界 | 00 §11.4 | 禁止适配层重复调用 10/11 |
| 存储键、预算、淘汰顺序 | 00 §11.5 / 04 §5.1–§5.2 | 唯一预算来源 |
| 错误码表 | 00 §9.2 | 工具错误映射 |
| 推进日志 / 保留 | 00 §10.1–§10.4 | 脱敏、滚动上限 |
| 幂等键 | 00 §2.1 / §11.2 | `idempotency_key = event_id` |
| 清单 / 工具 / 钩子 / ctx / 存储 / ZIP | API v2 对应章节 | 宿主硬约束 |

## 4. 输入 / 输出

### 4.1 包结构（允许清单）
| 路径 | 必需 | 说明 |
| --- | --- | --- |
| `plugin.json` | 是 | UTF-8 清单，字段见 §4.2 |
| `index.mjs` | 是 | 唯一入口，导出 `setup(api)` 与 `hooks` |
| `lib/**` | 是 | 适配层与引擎模块，ESM，零运行时依赖 |
| `README.md` | 是 | 面向安装者：功能、触发示例、权限用途、数据范围 |

`tests/`、`docs/`、`package.json`、`node_modules/`、`.git/`、符号链接与目录链接**不得出现在包内**。

### 4.2 `plugin.json` 字段
| 字段 | 值 | 校验 |
| --- | --- | --- |
| `id` | `bio-mood-engine` | 小写字母开头，仅小写字母、数字和 `-`，≤40，`^[a-z][a-z0-9-]{0,39}$`；`native-` 保留前缀不可用 |
| `name` / `version` | `生理情绪模拟引擎（虚构）` / `0.1.0` | 1–80 字符 / semver；更新只递增 version，不改 id |
| `description` | 一句话说明用途与边界 | **必填**，1–1024 字符（P-13-08：缺此项安装被拒） |
| `apiVersion` / `host` | 数字 `2` / 字符串 `"wechatagent"` | 固定值；`apiVersion` 必须是**数字**，写成字符串 `"2"` 会被安装期拒绝 |
| `permissions` | `["storage","history_read","reply"]` | 最小集合，不多不少 |
| `settings` | 见 §4.3 | 键集必须与 `configSchema` 完全一致 |
| `configSchema` | 见 §4.3 | **「设置字段名 → Schema」扁平映射**，1–24 项，嵌套 ≤12 层；禁止 `type` / `additionalProperties` / `properties` 外壳（出现即被当作设置字段名，安装被拒） |

禁止出现 `entry`、`enabledByDefault`、`scripts`、`author`、`homepage`（可选但本项目不声明）或任何未知顶层字段，出现即安装拒绝（API v2「plugin.json」）。清单不得声明默认启用、不得扩大聊天范围。

### 4.3 `settings` 默认值

`configSchema` 与 `settings` **同键同构**：`configSchema` 是「字段名 → 受限 Schema」的扁平映射，**不得**再套 `{type:"object", properties:{...}}` 外壳（P-13-08）。

受限子集以宿主规范为准，**只允许**这些关键词：
`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`description`、`title`、`default`、`minimum`、`maximum`、`minLength`、`maxLength`、`secret`；
`type` 只允许 `object`、`array`、`string`、`number`、`integer`、`boolean`。

`maxItems`、`minItems`、`pattern`、`format`、`uniqueItems`、`$ref`、`oneOf`/`anyOf` 一律**不可用**，出现即安装期报「Schema 使用了不支持的类型或字段」（P-13-09）。数组上限由宿主统一按 100 项约束，不在 Schema 里声明。

| 键 | 类型 | 默认 | 约束 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 应用级总开关（与宿主启用状态并行） |
| `primaryChatId` | string | `""` | v1 仅允许 1 个 chat id，1–128 字符；空表示未绑定，工具返回 `DEGRADED`。逗号/空白分隔的多值或多项数组在配置规范化时触发 `FASTCFG_INVALID` 并回退为空；多主会话需账号级共享存储（P-13-20 裁决 A） |
| `adminActorIds` | string | `""` | 管理员白名单，**逗号分隔字符串**（宿主设置页只存字符串，P-13-11）：每项填**宿主设置里的 wxid 明文**（P-13-17），插件内部立即转成候选哈希，明文不落盘、不回显。每项生成两个候选（去重）：完整 wxid 与剥掉 `wxid_` 前缀后的主体各自的 `sha256(...)` 前 12 位十六进制——宿主实测 `ctx.actor.id` 是带前缀的完整 wxid，保留裸主体候选是为了让「按字面删掉 `wxid_`」的填法同样命中自己；已写成 12 位哈希的存量值原样接受（大写会归一为小写），不再二次哈希。最多 8 项；整串校验，任一项既不是 `^[0-9a-fA-F]{12}$` 也不满足 `^[A-Za-z][A-Za-z0-9_-]{2,63}$` 则整项回退空数组并告警 `FASTCFG_INVALID`。**留空 = 不修改**：不产生候选，运行时沿用落盘的 `meta.admin_hashes`（最近一次非空设置，在 `observe` 事务内写入）；从未落盘过非空值才全拒（fail-closed，见 §5.9）。 |
| `characterId` | string | `whale_character` | `^[a-z][a-z0-9_-]{0,63}$`（00 §2.1） |
| `timezone` | string | `Asia/Shanghai` | IANA 名称，`Intl` 必须接受 |
| `masterSeedHex` | string | `""` | `secret:true`；留空时首次运行生成 32 位十六进制，写入 `state.random.master_seed_hex`（随 `state` 持久化），不得写入 `cfg`/`meta`/日志 |
| `behaviorContextMaxChars` | integer | `800` | 200–1500，钩子注入上限 |
| `debugLogging` | boolean | `false` | 只提升本地日志级别，不改变任何计算结果 |
| `shadowMode` | boolean | `false` | 只计算并记录，不向 DSH 注入上下文（15 §5.1） |
| `engineMode` | string | `embedded` | `embedded` / `remote`（15 §5.1）；`remote` 的传输由 15 的部署配置提供 |
| `engineRemoteUrl` | string | `""` | `remote` 时必填，`https://` 开头、≤200 字符；未配置且 `engineMode=remote` 时工具返回 `DEGRADED` |
| `engineRemoteToken` | string | `""` | `secret:true`；仅 `engineMode=remote` 时使用；运行时优先读宿主密钥或 `process.env.BM_REMOTE_TOKEN`，settings 值仅作 fallback；写入 `cfg` 时脱敏为 `***`，禁止进入日志/工具返回 |
| `afterResponseMode` | string | `off` | `off` / `protocol`；见 §5.6 |

`masterSeedHex` 只在初始化与重置种子时读取；运行时一律以 `state.random.master_seed_hex` 为准，`settings.masterSeedHex` 在首次运行后保持为空属正常；不得写入日志、工具返回或 `behavior_context`；日志只允许 `master_seed_id`（`sha256(seed)` 前 8 位，00 §10.2）。

### 4.4 工具（4 个，上限 16；id ≤20；最终名 `<id>__<tool>`）
| 工具 id | 最终名 | 入参 | 返回 | 预算 |
| --- | --- | --- | --- | --- |
| `observe` | `bio-mood-engine__observe` | `{event_type, text}` + 可选 `{relationship_tag, is_mentioned, is_direct_question}` | `{ok, event_id, character_id, state_version, duplicate, processed_at, state_summary, delivery, behavior_context}` | 工具 ≤8 s，引擎 ≤5 s |
| `state` | `bio-mood-engine__state` | 无（可选 `{detailed:false}`） | `{ok, character_id, state_version, state_summary, delivery, behavior_context}` | ≤2 s |
| `tick` | `bio-mood-engine__tick` | `{now, dry_run}` | `{ok, character_id, state_version, dry_run, delivery}` | ≤8 s |
| `admin` | `bio-mood-engine__admin` | `{action}`（§5.9） | `{ok, action, result}` | ≤2 s |

- 四个工具都必须 `additionalProperties:false`；未知参数直接拒绝，不得兜底。
- **`observe` 的派生字段（P-13-12）**：模型只填 `event_type` 与明文 `text`，`text_hash`（`SHA-256(text)`）、`sender_id`（`SHA-256(ctx.actor.id)` 前 12 位）、`conversation_id`（`ctx.chat.id`）、`occurred_at`（`ctx.now`，缺失回退注入时钟）全部在插件内派生，不再作为工具参数，模型无法伪造或覆盖；`relationship_tag` / `is_mentioned` / `is_direct_question` 缺失时取 `unknown` / `false` / `false`。
- `event_type` / `relationship_tag` 只取 00 §2.3 / §2.4 枚举；`state` 只读；`tick` 仅管理员可用。`ctx.actor` 只有 `{id}`、**不是**授权凭据，授权只认 `sha256(ctx.actor.id)` 前 12 位是否命中生效白名单；生效白名单 = 设置非空时的候选哈希，设置留空时取落盘的 `meta.admin_hashes`（P-13-17）。设置留空且从未落盘过非空值、`actor.id` 为空或未命中，一律 fail-closed 拒绝（§5.9）。
- 返回字段与 §5.9 裁剪规则一致：`state` 为只读、`tick` 为预演，二者无事件处理过程，故省略 `event_id`/`duplicate`/`processed_at`；`tick` 额外返回 `dry_run`。
- 工具 `parameters` 与 `configSchema` 用**同一套**受限子集校验（P-13-14）：`setup()` 注册前调用 `collectToolSchemaErrors(TOOL_DEFINITIONS)`，越界即抛 `PLUGIN_TOOL_SCHEMA_INVALID`（`details.errors` 给出 `tools.<id>.parameters.<字段>`），不等到宿主拒装；`pattern`/`format`/`minItems`/`maxItems`/`uniqueItems`/`oneOf`/`anyOf`/`$ref` 一律禁用，格式约束写进 `execute` 运行时判断。
- `state` 因 `readonly_scope` 降级时，`details` 额外带 `config`（脱敏后的生效配置：`enabled`/`primary_chat_id`/`admin_ids` 条数/`engine_mode`/`shadow_mode`），用于排查「宿主设置是否真的到达插件」（P-13-13）；不回显哈希、种子与令牌。

### 4.5 钩子
| 钩子 | 权限 | 返回 | 上限 | 允许 | 禁止 |
| --- | --- | --- | --- | --- | --- |
| `before-context` | `storage` / `history_read` | `{context}` | 800 ms，≤1500 字符 | 读 storage/历史、拼定性提示 | 写 storage、推进状态、联网、注入数值 |
| `after-response` | 需 `reply` | `{text}` / `{}` | 800 ms | 保留 `SILENT` / `RESPOND:` 协议 | 默认关闭；无 `reply` 不得启用 |

`before-context` 的注入上限取 `min(behaviorContextMaxChars, 1500)`；宿主允许 4000 字符，本插件主动收紧，避免挤占角色卡与工具结果。

两个钩子都由宿主以**单个 `ctx`** 调用（`before-context` 额外带 `ctx.message`，`after-response` 额外带 `ctx.text`），因此实现签名是 `hook(ctx)` 而不是 `hook(input, ctx)`（P-13-10）。

## 5. 算法与规则

### 5.1 `setup(api)`（≤2 s，无副作用）
```text
setup(api):
  01 assert api.apiVersion === 2，否则抛错（安装期已校验，仍须防御）
  02 构造规范化配置用于注册期校验；**工具与钩子每次调用都重新读 `ctx.config()`**，不得把 `setup` 时的快照当运行配置（P-13-15：宿主保存设置后不重载插件，快照会永远停在旧值）
  03 api.registerTool({id, description, parameters, execute(ctx, args)}) 注册 observe / state / tick / admin
     - parameters 必须是 object Schema，且关键词与类型落在宿主受限子集内（与 configSchema 同一白名单，见 §4.3）
     - execute 只接收宿主 ctx 与 args；返回值只能是字符串或 {content, isError}，这里统一返回 {content: JSON.stringify(result)}
  04 导出 hooks = { 'before-context', 'after-response' }，两者都按宿主形状接收**单个 ctx**（P-13-10）
  05 不读 storage、不写 storage、不 fetch、不 setTimeout、不创建子进程
```
初始化阶段禁止生成种子（种子在首次工具调用时生成），避免 `setup` 期间产生 I/O。

### 5.2 `observe` 流程（8 s / 引擎 5 s）

**适配层不得直接 `storage.get/set`；所有键读写只能经由 04 的 `createChatScopedRepo(...)`。推进必须走 `transaction()`；管理动作走 04 §6 的专用写入路径（不走 `transaction()`）。**

```text
01 校验入参（类型、枚举、长度、时间格式）        失败 -> INVALID_REQUEST，不写任何键
02 enabled=false 或 primaryChatId 为空             -> DEGRADED，返回中性结果
03 ctx.chat.id !== primaryChatId                    -> DEGRADED + 本聊天冷快照（§5.5）
04 事件标准化（§5.3）                               -> event_id / idempotency_key / source_key
05 ev  = await repo.transaction(async (t) => {
        cur = await t.getState(characterId)
        if (!cur) {
          // 种子生成只在"确认无 state"的分支内执行，避免每次 observe 都读取系统熵
          seed = settings.masterSeedHex || createMasterSeed(crypto.randomBytes(16))
          cur  = {state: createDefaultState({..., master_seed_hex: seed}), version: 0}
        }
        dup = await t.getIdempotency(idempotency_key)
        if (dup) return {duplicate: true, dup}
        rng = RandomProvider.fromPersisted({random: cur.state.random, character_id})
        r   = coordinator.advance({state: cur.state, event, now, rngProvider: rng, config})
        await t.putState(r.state, cur.version)
        await t.appendEvent(eventRecord)
        await t.appendIdempotency(idemRecord)
        return {duplicate: false, r, state_version: cur.version + 1}
      })
06 返回裁剪后的 state_summary / delivery / behavior_context
```

- `elapsed > 1h` 由 `advance` 内部按 1h 分块，适配层**不得**自行循环调用。
- **种子生成必须在 `createDefaultState` 之前完成，且只在 `if (!cur)` 分支内执行**：若 `state.random.master_seed_hex` 已存在则直接使用，绝不重新生成；`settings.masterSeedHex` 非空时优先采用，为空时才用 `createMasterSeed(crypto.randomBytes(16))` 生成 32 位十六进制主种子（P-04-02：格式只由 03 的 `createMasterSeed` 决定，此处仅注入熵源）。03 的 `deriveSeed` 据此派生五条流。生成结果只写入 `state.random.master_seed_hex`，不写 `cfg`/`meta`/日志。**并发创建**：后到的事务会被 04 的乐观锁（`t.putState` 的 `expectedVersion` 检查）拒绝并触发 04 §5.4 的重试；重试时 `getState` 已返回非空，不会进入 `if (!cur)` 分支，因此不会重新生成种子——第一次生成但未写入的 `seed` 随该事务回滚一并丢弃，绝不会覆盖已有 `state`。
- 引擎耗时 ≤5 s：超时中止事务（不写任何键）、返回 `DEGRADED` + 中性上下文；工具整体 ≤8 s。
- **bootstrap 与首轮推进必须在同一个 `repo.transaction()` 内完成（P-13-04，裁决 A）**：禁止在事务外调用 `saveState(init, 0)` 初始化状态。初始化状态只是本次事务的临时基础状态，最终状态统一通过 `t.putState()` 提交；否则迁移日志（`meta.schema_migrations`）与回滚一致性无法保证，且现有测试不会报错。`t.putState` 的乐观锁负责并发创建时的重试（见上条）。
- 写入顺序、回滚与崩溃恢复全部由 04 §5.3 负责，适配层不再实现第二套。

### 5.3 事件标准化（入口收明文，引擎只收哈希）
| 字段 | 构造 | 说明 |
| --- | --- | --- |
| `text` | 模型传入的明文（`observe` 必填，1–1000 字符） | **只在适配层入口存在**：即时 `SHA-256` 后丢弃，不进入事件对象 |
| `text_hash` | `SHA-256(text)` 64 位十六进制 | 引擎与 `evlog` 只认它；正文用完即弃，不缓存、不落库、不写日志 |
| `sender_id` | `SHA-256(ctx.actor.id)` 前 12 位十六进制 | 从宿主 `ctx` 派生，不可逆；不接收明文 wxid |
| `event_id` | `SHA-256(conversation_id \| sender_id \| timestamp \| text_hash)` 前 24 位 | 匹配 `^[A-Za-z0-9_-]{8,128}$` |
| `idempotency_key` | 等于 `event_id` | 同键只推进一次（00 §11.2） |
| `occurred_at` | 宿主 `ctx.now`（缺失回退注入时钟）→ UTC 毫秒 `Z` | 不由模型提供；非法 → `INVALID_TIME` |
| `conversation_id` | 宿主 `ctx.chat.id` | 不由模型提供，也不能用参数改目标 |
| `relationship_tag` / `is_mentioned` / `is_direct_question` | 宿主/模型可选提供；缺失取 `unknown` / `false` / `false` | 不得按内容猜测 |

适配层入口接受明文 `text`，在插件内存内即时 `sha256` 后丢弃；**引擎侧仍然只接收 `text_hash`**，`event.payload.text` 恒为 `undefined`。哈希后的正文不进入 `evlog` / 日志 / 工具返回 / `behavior_context`；正文也不得作为系统指令、配置或引擎参数的一部分。

### 5.4 存储键与体积

**键名、上限、淘汰顺序唯一来源是 00 §11.5 与 04 §5.1–§5.2；本模块只提供 `storage` 适配对象，不得自定义键或数字。**

| 键 | 内容 | 上限 | 保留 |
| --- | --- | --- | --- |
| `state` | 最新 `CharacterState`（含 `random.master_seed_hex`） | 8 KiB | 仅 1 份 |
| `evlog` | `{event_id,type,time,source_key,intensity}` | 16 KiB | 最近 200 条 / 90 天 |
| `idem` | `{key, state_version, processed_at}` | 32 KiB | 最近 300 条 / 7 天 |
| `meta` | `schema_version`、`master_seed_id`、12 条摘要、`config_version` | 24 KiB | 仅 1 份 |
| `cfg` | 规范化配置快照（脱敏，不含种子） | 4 KiB | 仅 1 份 |

- 键名只允许 `[A-Za-z0-9_-]`、1–64 位；不得出现 `/`、`.`、空格、Unicode。
- 总占用目标 ≤64 KiB（宿主配额 256 KiB）；淘汰由 `ensureReady` 在事务内统一执行（`meta.snapshots` → `idem` → `evlog`，`state`/`cfg` 永不淘汰），工具层**不再**淘汰后重试；仍超 224 KiB 时底层返回 `STORAGE_FAILED`，工具统一映射为 `DEGRADED`（只读）。
- 单次工具内 storage 读写合计**遵守 00 §11.0 / 04 §5.3 的 ≤40 次事务上限**，13 不另设数字（W6-1，v1.7.9）。实测预算：`observe` 稳态 19–21 次（`ensureReady` 淘汰 5 读 + 0–3 写；W1–W8b 4 读 7 写；fn 2 读 3 写），首轮触发淘汰时最坏 ≤24 次；`state` 1 读；`tick` 约 5 次。三处写入必须同处一个 04 的事务内，任一失败整体回滚，`state_version` 不变（管理动作是例外，见 §5.9：走 04 §6 的 B 方案直写，不整体回滚、失败写 `recovery_required`）。

### 5.5 主聊天作用域
| 情形 | 行为 |
| --- | --- |
| `ctx.chat.id === primaryChatId` | 权威状态，可推进、可写三键 |
| `ctx.chat.id !== primaryChatId` | 返回 `DEGRADED` + 本聊天 `meta` 冷快照（可能为 `null`），不推进、不写 `state` |
| `primaryChatId` 为空 | 所有工具返回 `DEGRADED` + `PRIMARY_UNBOUND`，提示运维在宿主设置中预置单个 `primaryChatId`（`bind_primary` 不能用于 bootstrap，见下） |
| `primaryChatId` 含多个值 | 配置规范化/保存校验触发 `FASTCFG_INVALID`，回退为空主会话；不会选择其中一个继续写入 |
| 同账号多插件实例 | 各自独立存储；宿主无跨聊天通道，"最近快照"只能来自该聊天自身的历史冷快照，不得绕过隔离 |

**v1 只允许配置 1 个 `primaryChatId`**：内部数组只使用首项，即使调用方绕过清单传入多个 ID，第二个聊天也为 `NON_PRIMARY_READONLY`。`bind_primary` 只在当前聊天的 `meta` 生效，无法让其他聊天看到绑定结果；宿主按「账号 + 插件 + 聊天」隔离存储，不提供账号级共享存储或跨聊天发现（04 §1.1 / §5.5）。v1 不尝试跨聊天读写或共享状态。

**bootstrap 顺序（v1.7.2）**：`adminActorIds` 默认空 → `admin` 与 `tick` 全部 `UNAUTHORIZED`；`bind_primary` 本身也是 admin 动作、同样受白名单约束，因此**不能**用来完成首次绑定。首次部署必须由运维在宿主设置里同时预置 `settings.primaryChatId` 与 `settings.adminActorIds`；`primaryChatId` 已填而白名单为空时，`observe`/`state` 正常，`tick`/`admin` 一律拒绝。

### 5.6 `before-context` 与 `after-response`
```text
before-context(ctx):
  00 宿主单参调用：ctx.message 为本轮消息，ctx.config()/ctx.storage/ctx.chat 与工具一致
  01 enabled=false                          -> {context: ''}
  02 非主聊天                               -> {context: ''}（或该聊天静态冷提示，不含数值）
  03 repo.loadState(characterId, {readOnly:true})（≤200 ms，唯一读；不迁移/不淘汰/不写盘） -> 失败 -> {context: ''}
  04 取 10 的 behavior_notes（≤3 条）+ 固定免责声明 1 句
  05 删除数字、维度名、公式符号；超长按整句截断到 min(maxChars,1500)
  06 预算 800 ms；超时由宿主跳过，本轮聊天不受影响
```
- 内容只允许"定性行为提示 + 一句免责声明"，免责声明必须使用 00 §1.1 的完整句（"本引擎中的生理周期、睡眠、神经调节和情绪数据均为虚构角色状态模拟，不是人体医学模型，不用于诊断、治疗或现实健康预测。"），可整体截断但不得改写为简化句；不得出现 `reply_likelihood`、0.18 等数值。
- 注入内容不得包含 `master_seed_hex`、`random.streams` 计数器、事件正文、原始 `wxid`；若上游 `behavior_notes` 混入，先过滤再注入（00 §10.2.1）。
- 必须**只读**：禁止写 storage、禁止推进 `state_version`、禁止 `fetch`。实现上固定调用 `repo.loadState(characterId, { readOnly: true })`（04 §5.2）：不迁移、不淘汰、不恢复、不写任何键；该写法与 `loadStateReadOnly()` 严格等价。若返回 `warnings` 含 `MIGRATION_DEFERRED` / `STORAGE_OVER_BUDGET` / `RECOVERY_DEFERRED`（定义见 00 §9.2.1），三者任一出现即按 `DEGRADED` 处理：本轮按 `{context: ''}` 降级，**不写盘、不重试**，把迁移 / 淘汰 / 恢复留给下一次写路径。
- **发送边界**：插件**不主动发送**——工具只返回 `delivery` 与 `behavior_context`，由 DSH 生成文本后由宿主统一发送；工具、钩子内一律不得调用 `ctx.reply`。`reply` 权限只用于 `after-response` 改写（返回文本或空串抑制），不代表插件可以直接发消息；`after-response` 默认 `off`，返回 `{}`。设为 `protocol` 时必须已授权 `reply`，只在文本含精确 `SILENT` 或 `RESPOND:` 前缀时改写，不得改变其语义与大小写。

### 5.7 降级矩阵
| 触发 | 返回 | 状态 | 聊天影响 |
| --- | --- | --- | --- |
| storage 读/写失败 / 非主聊天 / 未绑定主聊天 | `DEGRADED`（非主聊天附冷快照或 `null`）；未绑定主聊天用 `details.warnings:['PRIMARY_UNBOUND']`，已绑定但非当前聊天用 `['NON_PRIMARY_READONLY']`，两者不得混为一类 | 不推进 | 无，正常回复 |
| 引擎抛错 / 超 5 s | `DEGRADED` + 中性上下文（不注入 `reply_likelihood` 等） | 不变 | 无 |
| 引擎 `ABORTED`（`transaction` 被 `AbortController` 中止） | `DEGRADED`，**不是 `INTERNAL`**：插件工具的失败语义是"本轮照常聊天"，不是服务端 500；W7 前中止已回滚，W7 后中止视为已提交 | 不变 | 无，正常回复 |
| `enabled=false` / 单次预算超时 | 工具 `DEGRADED`、钩子空注入；超时由宿主终止 | 不变 | 无 |
| 版本冲突（3 次尝试后） | `STATE_VERSION_CONFLICT` | 不变 | 无 |

### 5.8 打包与体积
| 项 | 限额 | 核对方式 |
| --- | --- | --- |
| ZIP / 解压后 / 单文件 | ≤8 MiB / ≤16 MiB / ≤4 MiB | 打包脚本输出实际字节并逐文件检查 |
| 条目 / 目录层数 | ≤128 / ≤8 | 条目计数、最长路径分隔计数 |
| 包内资源 / 工作目录 | `new URL('./assets/x', import.meta.url)`；禁止 `process.cwd()` | 静态检索 |

插件包只含 `plugin.json`、`index.mjs`、`lib/**`、`README.md`、可选 `assets/**`；`tests/`、`docs/`、`package.json`、`node_modules/`、`.git/` 不得入包。

### 5.9 管理动作、返回裁剪与时间上限

| 动作 | 工具 | 权限 | 行为 |
| --- | --- | --- | --- |
| `bind_primary` | `bio-mood-engine__admin` | `ctx.actor.id` 哈希命中 `adminActorIds` | 仅在 `meta.primary_chat_id` 为空时写入**当前聊天**；不改 `state`；成功后写 `meta` 摘要。注意：`ctx.storage` 按聊天隔离，本动作只对当前聊天生效——第一版只支持**单聊天部署**，多聊天场景必须通过 `settings.primaryChatId` 预置，宿主不提供跨聊天发现（04 §5.5） |
| `reset_state` | `bio-mood-engine__admin` | 管理员（同上白名单） | 破坏性操作，需二次确认；事务内以 `createDefaultState` 生成新状态后**把 `state_version` 设为旧值 + 1（不重置为 0）**，`created_at` 保留原值、`updated_at` 设为当前时间；清空 `idem`；**保留 `evlog`**（审计依据，含本次管理操作记录，04 §5.6 的 90 天保留不变）、`cfg` 与 `meta.schema_version`；**`reset_state` 是迁移失败后的唯一逃生舱**：`meta.state_backup` 非空时仍允许执行并清除备份与 `migration_failed_at`，`reset_seed` / `manual_cycle_correction` 则返回 `migration_backup_pending`（04 §6，v1.7.12 P1） |
| `reset_seed` | `bio-mood-engine__admin` | 管理员（同上白名单） | 生成新 32 位主种子（`createMasterSeed(crypto.randomBytes(16))`，P-04-02），调用 03 的 `deriveSeed` 重新派生五条流的 `seed_hex`、计数器全部归零，写入 `state.random`；同步 `meta.master_seed_id`；旧种子的 `state.random` 不得留存 |
| `manual_cycle_correction` | `bio-mood-engine__admin` | 管理员（同上白名单） | 人工校正周期锚点：入参 `{anchor_at}` 必填、`{cycle_length_days}` 可选（`[20,45]`）；复用 05 §5.5 的 `manual_anchor_at` / `manual_cycle_length_days`，写入 `state.cycle.anchor_at` / `cycle_length_days` 并把 `cycle_length_source` 置 `manual`；`anchor_at` 不得晚于 `now`，否则 `INVALID_REQUEST`；不改 `cycle` 之外的字段；`state_version` 按旧值 + 1 写入（与其他管理动作一致） |
| `export_diagnostics` | `bio-mood-engine__admin` | 管理员（同上白名单） | 返回脱敏 `state_summary` + 最近 20 条 `evlog` 字段（无正文/种子/令牌） |

- 管理动作**不走 `repo.transaction()`**（04 §6 B 方案），按 `state` → `idem`（仅 `reset_state` 清空）→ `evlog` → `meta` 顺序直接写；`reset_state` / `reset_seed` / `manual_cycle_correction` 失败时**不自动回滚**（它们改写种子或整体重建状态，回滚语义不成立），写 `meta.recovery_required` 并返回 `DEGRADED`，`result` 中标记 `recovery_required: true`，**不得自动重试**。未授权一律 `UNAUTHORIZED`。
- **管理动作统一调用 04 的 `repo.adminReset(characterId, {operation, payload, now, prepare})`（v1.7.11，P1-A）**：13 只做参数收集、权限校验、`prepare` 注入与结果映射，**不得自行实现**键操作（读写 `state` / `idem` / `evlog` / `meta`）。`now` 取请求体时间；`manual_cycle_correction` 的 `prepare = (state, payload, now) => applyManualCorrection({cycle: state.cycle, now, manual_anchor_at: payload.anchor_at, manual_cycle_length_days: payload.cycle_length_days ?? null})` 并返回 `{...state, cycle}`。上述键影响是 04 §6 的语义说明，不是 13 的实现清单；`reset_state` 沿用原 `master_seed_hex` 也由 04 保证。
- **管理员判定（v1.7.2，关闭 C-01/C-02；P-13-17 扩展填法）**：`ctx.actor` 只有 `{id}`，**没有 `role` 字段，也不是授权凭据**（API v2:134）。判定只认 `sha256(ctx.actor.id)` 前 12 位十六进制是否命中生效白名单；设置非空时生效白名单 = 每项 wxid 的两个候选哈希（完整 / 剥前缀，见 §4.3），设置留空时取 `meta.admin_hashes`（最近一次非空设置，`observe` 事务写入）。`ctx.actor.id` 为空串、设置留空且从未落盘过非空值、或未命中 → `UNAUTHORIZED`（fail-closed）。宿主未暴露管理员清单接口，**不得**读取"宿主管理员配置"。`ctx.actor` 仍不可被调用方伪造，但它只是身份提示，授权完全由白名单决定。
- **bootstrap 顺序**：`adminActorIds` 默认空 → 首次部署时 `tick` 与全部 `admin` 动作一律 `UNAUTHORIZED`，且 `bind_primary` **不能**用作引导手段。首次启用必须由运维在宿主设置里同时填 `settings.primaryChatId` 与 `settings.adminActorIds`（见 §5.5 与 15 的运维章节）。管理员填 wxid 明文即可，插件内部转哈希；此后把该设置清空不会撤销授权，需填入新的 wxid 才能覆盖。
- **admin 返回裁剪**：`admin` 统一返回 `{ok, action, result}`，`result` 按动作裁剪——`bind_primary` 返回 `{primary_chat_id}`；`reset_state` / `reset_seed` 返回 `{state_version}`；`manual_cycle_correction` 返回 `{state_version, cycle}`（`cycle` 只含 `anchor_at`/`cycle_length_days`/`cycle_length_source`）；`export_diagnostics` 返回 `{state_summary, recent_events}`（已脱敏，无正文/种子/令牌）。`result` 内不得出现完整 `state`、种子、`evlog` 原始条目。
- **管理操作的审计写入**：五个管理动作都追加一条 `evlog`，字段按 04 §6 固定为 `event_type='admin_command'`、`source_key='wechat:<primaryChatId>:admin'`、`intensity=0`、确定性 `event_id=adm_<sha256(character_id|operation|occurred_at)[0:16]>`；`evlog` 只追加不重放，不影响 `stress`。`reset_state` / `reset_seed` / `manual_cycle_correction` 的 `state_version` 按旧值 + 1 口径写入该记录。
- **返回裁剪**：工具默认返回 00 §12.4 的 `data` 去掉 `diagnostics`，只保留 `event_id`/`character_id`/`state_version`/`duplicate`/`processed_at`/`state_summary`/`delivery`/`behavior_context`；`state`/`tick` 无事件处理过程，省略 `event_id`/`duplicate`/`processed_at`（§4.4 的返回表以此为准）；仅 `debugLogging=true` 时附加 `diagnostics`（`module_ms` + `warnings`，不含原始输入）。
- **`state_summary.mood` 的时点（P-09-01，裁决 B）**：`observe` 在事件阶段调用 09 时 `inputs.dt=0`；事件当轮只改 `stress.level`，`mood` 仅叠加 **≤0.008/维** 的噪声（09 §5.2 的 `noise.d=(u1+u2-1)*0.008` 不乘 `alpha`，实现在 `lib/modules/mood/index.mjs` 的 `raw.noise` 一项），惯性影响在后续 chunk 经 `stress` 通道释放（00 §7.3、09 §5.2）。因此返回的 `state_summary.mood` **不是**「事件前的值」，而是「事件前的值 + 微小噪声」；DSH 不应据此判断"角色情绪未变化"，也不应把它当作事件造成的情绪变化。
- **合并队列的消费规则（v1.7.8，W5-1）**：`observe` 收到 `delivery.coalesced_into` 时，按以下顺序处理，**不得**自行重扫窗口重算（规则归 11 §5.5）：
  1. 从进程内待交付队列移除 `coalesced_into.event_id` 对应的保留项（该条将被折叠，不再单独交付）；
  2. 按保留项重新登记一条 `{event_id, conversation_id, queued_at: earliest_queued_at, merged_count}`；
  3. 若该保留项原本已带 `merged_count`，累加：`merged_count = 旧值 + coalesced_into.merged_count - 1`（减 1 是扣掉本条，避免重复计数）；
  4. 本条自身**不入队**（它是被折叠方）；
  5. `delivery.policy='silent_ignore'` 仍写 `evlog`（11 §5.7），但不触发 DSH。
  
  队列是**进程内易失队列**：重启后丢弃；`deliver_after` 已过期且未过 `expires_at` 的项在下次 `observe` 按 11 §5.6 的 `recheck` 处理，过 `expires_at` 则转 `silent_ignore`（`expired`）。判定顺序固定为**先看 `coalesced_into` 是否存在、再看 `policy`**——睡眠中的合并会同时带 `sleeping` 与 `coalesced`，只看 `reason_codes[0]` 会误判。
- **`no_event` 的消费规则（v1.7.9，W5-5）**：`observe` / `tick` 收到 `delivery.policy='silent_ignore'` 且 `reason_codes` 含 `no_event`（纯时间推进，11 §5.3 规则 0）时：**不入队、不写 `evlog`、不触发 DSH**，仅把 `state_summary` 用于返回与 `before-context` 注入。注意与事件型 `silent_ignore`（合并、过期、高困倦低优先）区分：后者必须写 `evlog`（11 §5.7）。
- **队列项字段与入口清理顺序（P-13-07，裁决 A）**：队列项固定为 `{event_id, conversation_id, queued_at, merged_count, deliver_after, expires_at, event_type, source_key, intensity, occurred_at}`；后四项只用于过期时补写 `evlog`（11 §5.7），不含正文、种子或原始账号。`observe` / `tick` 在**推进前**先执行入口清理：`now > expires_at` 的项移出队列，按 11 §5.6 改判 `silent_ignore` + `expired`，并在同一事务内写一条 `evlog`——`event_id = 'exp_' + sha256(原 event_id|expires_at)[0:16]`（原事件在入队当轮已写进 `evlog`，必须用独立 id 才能落盘），沿用原事件的 `event_type` / `source_key` / `intensity` / `occurred_at`，附 `policy='silent_ignore'` 与 `reason_codes=['expired']`。`dry_run` 只算不写，不清理队列、不写 `evlog`；清理不引入定时器，且不改变"每会话合并后 ≤1 条"的约束。
- **`state` 的 `delivery` / `behavior_context` 来源**：`state` 不调 `advance`、存储中也没有这两个字段（10 §2 明确不持久化）。实现方式是**用当前 `state` 快照调用 10 / 11 的纯函数重新计算**（10 §4.2 的 `previous_context` 传 `null`、11 §4.1 的输入只取 `state` + `config`），**不写回、不消耗随机数、不产生 `evlog`**；计算失败时两字段返回 `null` 并追加 `DEGRADED`。因 `previous_context=null`，`state` 工具的结果会带 `HYSTERESIS_RESET`（与 10 §5.4 口径一致）。读取状态必须用 `repo.loadState(characterId, { readOnly: true })`（04 §5.2）：该工具与 `before-context` 一样不得迁移、不得淘汰、不得写任何键。
- **时间上限**：单次 `elapsed` 上限 4320 小时（180 天），超出部分由 02 的粗推进吸收；适配层不得自行分片循环调用；`advance` 超过 5 秒即中止事务并返回 `DEGRADED`。

## 6. 边界与错误
| 场景 | 处理 | 错误码 |
| --- | --- | --- |
| `plugin.json` 含未知字段 / `id` 非法 | 安装拒绝 | 宿主 `PLUGIN_MANIFEST_INVALID` |
| 工具参数缺 `text` / `event_type` 非枚举 / 时间非法 | 拒绝，不推进 | `INVALID_REQUEST` / `INVALID_TIME` |
| `sender_id` 传入明文 wxid | 拒绝，要求先脱敏 | `INVALID_REQUEST` |
| 非管理员调用 `tick` | 拒绝；`ctx.actor` 不作凭据 | `UNAUTHORIZED` |
| `dry_run:true` / 重复 `event_id` | 只计算不写键 / 返回首次结果（12 §5.4） | 成功（`duplicate:true`） |
| 版本冲突重试 3 次失败 | 不写事件日志 | `STATE_VERSION_CONFLICT` |
| 存储超 64 KiB | 本次返回 `DEGRADED` + `warnings:['STORAGE_OVER_BUDGET']`，**不重试**；下次 `observe` 的 `ensureReady` 自动淘汰（W6-1 连带，与只读路径复用同一码，不新增码） |
| 存储不可用 | 不阻塞聊天 | `DEGRADED` |
| 宿主运行时无 `blake2b512`（Electron/BoringSSL，`openssl 0.0.0`） | `deriveSeed` 自动退回内置纯 JS BLAKE2b-512（与 OpenSSL 逐位一致），不降级 | 成功（P-13-16） |
| 钩子超 800 ms / 钩子尝试写存储 | 宿主跳过 / 宿主拒绝并自查 | 无 / `MODULE_FAILED` |

## 7. 交付文件
```text
plugins/bio-mood-engine/plugin.json
plugins/bio-mood-engine/index.mjs
plugins/bio-mood-engine/README.md
plugins/bio-mood-engine/lib/adapter/wechatagent/manifest.mjs   # 清单/配置校验与默认值
plugins/bio-mood-engine/lib/adapter/wechatagent/events.mjs     # 标准化、哈希、脱敏
plugins/bio-mood-engine/lib/adapter/wechatagent/repo.mjs       # 构造 04 的 ChatScopedStorageRepo + 工具级事务包装
plugins/bio-mood-engine/lib/adapter/wechatagent/tools.mjs      # observe / state / tick / admin
plugins/bio-mood-engine/lib/adapter/wechatagent/hooks.mjs      # before-context / after-response
plugins/bio-mood-engine/lib/adapter/wechatagent/degrade.mjs    # 降级与中性上下文
tests/integration/_plugin_helpers.mjs                          # 测试夹具（下划线开头，不被 --test 收集）
tests/integration/plugin_manifest.test.mjs
tests/integration/plugin_tools.test.mjs
tests/integration/plugin_hooks.test.mjs
tests/integration/plugin_package.test.mjs
tests/unit/plugin_inject.test.mjs                              # P-14-01 群消息提示注入
```
不得修改 `00`–`12`；不得新增本清单以外的包内文件；不得把引擎算法复制进适配层。

## 8. 测试要求
| 编号 | 用例 | 预期 |
| --- | --- | --- |
| P01 | 读取 `plugin.json` 逐字段核对 | `id/version/apiVersion/host/permissions` 一致；`configSchema` ≤24；默认值合法 |
| P02 | 注入 `entry` / `enabledByDefault` / `scripts` / `foo` | 安装检查分别拒绝，并指出字段名 |
| P03 | 计时 `setup(api)`，监控网络/storage/定时器 | ≤2000 ms；零网络、零 storage 写、零定时器 |
| P04 | `observe` 缺 `text`、非法 `event_type`、超长 `conversation_id` | 三次均 `INVALID_REQUEST`，`state` 未变化 |
| P05a | `adminActorIds` 为空（默认）时调用 `tick` 或任一 `admin` 动作 | `UNAUTHORIZED`，`state_version` 不变 |
| P05b | `sha256(ctx.actor.id)` 命中 `adminActorIds` 后调用 `tick` | 放行，正常推进（`state_version` +1） |
| P06 | `before-context` 注入 150 ms storage 桩延迟 | 总耗时 <800 ms，返回合法 `{context}` |
| P07 | 钩子内写 storage / 推进 / `fetch` | 三者均被拒绝或未调用；断言失败即用例失败 |
| P08 | 20 条文案的超长提示 | ≤`min(1500, behaviorContextMaxChars)`，含 00 §1.1 完整免责声明，无数字与维度名 |
| P09 | 同一消息连续标准化两次 | `text_hash` 64 位、`sender_id` 12 位、`event_id` 24 位；两次相等 |
| P10 | 同 `event_id` 连续 `observe` 两次 | 第二次 `duplicate:true`，版本不变，`evlog` 不重复 |
| P11 | 扫描全部 storage 值与日志 | 无正文、无原始 wxid、无令牌、无完整 `masterSeedHex` |
| P12 | 非 `primaryChatId` 调用 `observe` / `state` | `DEGRADED`；不写、不推进；返回冷快照或 `null` |
| P13 | 收集键名；`storage.set` 抛错；写入后 >64 KiB | 键名全部匹配 `^[A-Za-z0-9_-]{1,64}$`、每次 ≤40 次（00 §11.0）；抛错 `DEGRADED` 且聊天继续；超限返回 `DEGRADED` + `STORAGE_OVER_BUDGET` 不重试，下次 `observe` 由 `ensureReady` 淘汰 |
| P14 | `enabled=false` | 三工具 `DEGRADED`；两钩子空注入；版本不变 |
| P15 | 打包后核对 ZIP | ≤8 MiB / ≤16 MiB / 单文件 ≤4 MiB / 条目 ≤128 / 层数 ≤8；无禁用目录与链接 |
| P16 | 静态检索 `lib/**` 与 `index.mjs` | 无 `process.cwd()`；资源用 `new URL(..., import.meta.url)`；无 `node_modules` 导入 |
| P17 | `after-response` 关闭 / 开启，输入含 `SILENT` 与 `RESPOND:` | 关闭返回 `{}`；开启前缀原样保留且只发送一次 |

## 9. 验收命令
```powershell
node --test tests/integration/plugin_manifest.test.mjs tests/integration/plugin_tools.test.mjs tests/integration/plugin_hooks.test.mjs tests/integration/plugin_package.test.mjs tests/unit/plugin_inject.test.mjs
Select-String -Path "plugins/bio-mood-engine/lib/**/*.mjs","plugins/bio-mood-engine/index.mjs" -Pattern "process\.cwd|Math\.random|new Date\("
Select-String -Path "plugins/bio-mood-engine/lib/**/*.mjs","plugins/bio-mood-engine/index.mjs" -Pattern "console\.log|wxid"
node scripts/pack-plugin.mjs plugins/bio-mood-engine release/bio-mood-engine-0.1.0.zip
```
预期：五个测试文件全通过（P01–P17）；两条检索无输出（无 `process.cwd`、随机、系统时间、直接打印、明文 wxid）；打包输出体积明细且全部低于 §5.8 限额。种子泄露由 P07/P12 的运行时断言覆盖（响应、`behavior_context`、日志均不得出现 `master_seed_hex` 全量），因此静态检索不再包含字段名字面量（同 P-12-01 的处理口径）。

## 10. 禁止事项
1. 禁止把消息正文、原始 wxid、令牌或完整种子写入 storage、日志、工具返回或 `behavior_context`。
2. 禁止把群消息正文当作系统指令、配置或提示词注入；外部文本一律视为不可信数据；禁止把引擎状态写进角色卡、人设、DSH 记忆或文档存储。
3. 禁止跨聊天读写存储、伪造 `primaryChatId` 或试图共享状态。
4. 禁止在 `setup` 或安装阶段联网、读种子、起定时器、写 storage。
5. 禁止在 `before-context` 内写 storage、推进状态或联网；禁止注入数值型倾向。
6. 禁止默认启用 `after-response`，或破坏 `SILENT` / `RESPOND:` 协议。
7. 禁止用 `process.cwd()` 定位资源，禁止在包内携带 `node_modules`、`tests/`、`docs/`、`package.json`。

## 11. 汇报模板
```text
模块：13 WeChatAgent 插件适配层
波次：6
依赖版本：00-统一契约 v1.7.3 / schema_version 1
完成的任务：清单 / 工具 / 钩子 / 标准化 / 存储 / 降级 / 打包
新增文件：plugins/bio-mood-engine/*、tests/integration/plugin_*.test.mjs
关键设计决策：<主聊天作用域 / 冷快照 / 800 ms 钩子预算 / 淘汰顺序>
测试命令：node --test tests/integration/plugin_*.test.mjs
测试结果：pass <> / fail 0；setup <> ms；observe P95 <> ms；钩子 <> ms
包体积：ZIP <> MiB / 解压 <> MiB / 条目 <> / 层数 <>
未解决问题：<逐条>
已知风险：<例如宿主未暴露管理员清单导致 tick 默认拒绝>
是否需要契约变更：是/否
```
