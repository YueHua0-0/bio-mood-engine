# 宿主约束表（阶段 0 · G0）

| 项目 | 内容 |
| --- | --- |
| 模块 | 01 阶段 0：仓库与宿主审查 |
| 依赖版本 | 00-统一契约 v1.7.2 |
| 事实来源 | `WeChatAgent-plugin-api-v2.md`（文档层，唯一可用来源）+ 3 份真实 ZIP 实测 |
| 配套报告 | `architecture_audit.md` |

> 本表把宿主预算换算成**引擎可用的实际额度**。凡标「待验证」的条目，必须在拿到宿主源码后补代码行号；在此之前，实现一律按本表的**保守值**执行。

---

## 1. 宿主硬限制

| 编号 | 限制 | 数值 | 来源 | 对引擎的含义 |
| --- | --- | --- | --- | --- |
| H01 | ZIP 大小 | ≤8 MiB | `WeChatAgent-plugin-api-v2.md:33` | 本项目目标 <1 MiB |
| H02 | 解压后合计 | ≤16 MiB | 同上 | 目标 <2 MiB |
| H03 | 单文件 | ≤4 MiB | 同上 | 禁止内联大表 |
| H04 | ZIP 条目数 / 目录深度 / 压缩比 | ≤128 / ≤8 / ≤500 | 同上 | 拆分模块时控制文件数 |
| H05 | 安装数 / 同时运行数 | ≤32 / ≤8 | `:35` | 与本插件无关 |
| H06 | `setup()` 初始化 | ≤2 s，禁止联网、禁止常驻任务 | `:86` | 只做注册；禁止在 setup 内 `fromPersisted` 或预计算 |
| H07 | 工具单次执行 | ≤8 s | `:124` | 引擎计算预算见 §2 |
| H08 | 每轮工具调用次数 | ≤3 | `:124` | `observe` 只调一次；禁止在钩子里补偿调用 |
| H09 | 工具结果 | ≤64 KiB / 给模型 ≤12,000 字符 | `:122` | `state_summary` + `delivery` + `behavior_context` 合计必须 <12,000 字符 |
| H10 | 钩子单次 / 单类总预算 | ≤800 ms / ≤2 s | `:167` | 钩子内只做读取 + 字符串拼接 |
| H11 | `before-context` 注入上限 | 4,000 字符 | `:165` | 13 的 `behaviorContextMaxChars` 默认 800，余量充足 |
| H12 | 存储总量 | 单账号单插件 ≤256 KiB | `:148` | 04 的 84 KiB 硬上限 / 44 KiB 稳态在此之内 |
| H13 | 存储键名 | 1–64 位 `[A-Za-z0-9_-]` | `:148` | 04 的 3–5 字符字面量键方案合规；**禁止 `:` 与中文** |
| H14 | 存储 API | 仅 `get/set/delete`（单键、JSON 值） | `:139-141` | **无事务原语**，见 §3 |
| H15 | `ctx.reply` | 每轮 ≤3 条 / 合计 ≤12,000 字符，仅当轮有效 | `:145`、`:154` | 无延迟发送，见 §5 |
| H16 | `ctx.fetch` | 公开 HTTPS GET，`maxChars` 256–32000，`timeoutMs` 100–7000 | `:152` | 嵌入式模式**不使用**网络 |
| H17 | 动作 / 每日计划 | ≤35 s；**不支持 `ctx.reply`** | `:200`、`:202` | `onSchedule` 只能做维护推进 |
| H18 | 每日计划粒度 | 宿主每分钟检查，失败 15 min 重试 | `:221` | 不可当定时器用于准点交付 |
| H19 | 子进程内存 | V8 旧生代 96 MiB（非硬上限） | `:171` | 禁止全量历史入内存 |
| H20 | 消息级订阅 | **不存在**（仅语音/日记两项专用路由） | `:229-234` | 推进必须惰性补算，见 §5 |
| H21 | 钩子写权限 | 只读 storage/history，禁止联网与发送 | `:167` | `before-context` 内**不得** `advance` |
| H22 | 并发 | 同插件其他聊天的并发调用可能失败 | `:124` | 02 的 `createMutex()` 只在本进程内有效 |
| H23 | 更新语义 | id 不变、version 递增；旧代码归档、数据保留、插件停用 | `:254` | `schema_version` 迁移必须幂等 |
| H24 | 持久数据位置 | `state/plugins/<账号哈希>/<插件id>/data.json` | `:264` | 无法直接寻址文件，只能经 `ctx.storage` |

---

## 2. 预算换算（宿主 → 引擎）

| 宿主预算 | 数值 | 引擎预留 | 引擎可用 | 目标 |
| --- | --- | --- | --- | --- |
| 工具单次 | 8 s | 序列化 + storage 读 0.5 s + 写 0.5 s + 回复 1 s | **≤5 s** | P99 ≤300 ms（14 §5.5） |
| `setup()` | 2 s | 注册 4 个工具 + 2 个钩子 | 无重计算 | <50 ms |
| 钩子单次 | 800 ms | storage 读 ≤200 ms | ≤600 ms | <50 ms（只格式化） |
| 钩子单类总预算 | 2 s | 同上 | 单次不叠加 | — |
| 工具结果 | 64 KiB | JSON 包装 + 转义 | **≤48 KiB**（保守） | `state_summary` 投影 <8 KiB |
| 模型可见文本 | 12,000 字符 | 同上 | **≤8,000 字符** | `behavior_context` ≤800 字符 |
| 存储 | 256 KiB | 宿主自身开销未公开 | **≤192 KiB**（保守） | 04 的 84 KiB 硬上限 |
| V8 旧生代 | 96 MiB | 宿主加载 + 解析 | **≤64 MiB** | 峰值 <8 MiB |
| 每日计划 | 1 次/分钟 | — | 每次 ≤35 s | `tick` 兜底 ≤5 s |

**结论**：所有宿主预算对本项目都有 3 倍以上余量，唯一硬约束是 **H12 存储 256 KiB** 与 **H09 结果 12,000 字符**，二者已在 04（84 KiB）与 13（800 字符）中预留。

---

## 3. 存储层约束（无事务）

宿主只提供单键 `get/set/delete`（H14），**没有多键原子写**。因此：

| 约束 | 说明 | 04 的应对（§5.3.1 已落实，前提待 D-3 验证） |
| --- | --- | --- |
| 无跨键原子性 | `state` / `meta` / `evlog` / `idem` 分键写，中途失败会半写 | W1–W8 两阶段 + 提交标记 + `meta.rollback_state` 补偿（04 §5.3.1，已写明 7 个崩溃点） |
| 无版本 CAS | 宿主不校验 `expectedVersion` | `t.putState(state, expectedVersion)` 自校验；冲突转 `STATE_VERSION_CONFLICT`（04 §5.3） |
| 并发窗口 | 两个调用同时读到旧版本后都可能通过校验 | 02 的 `createMutex()` 进程内串行 + 写入前重读；**D-3 已关闭（单长驻 worker，见 §9）**，进程内互斥成立；多开宿主等残余风险仍以 `state_version` 乐观锁兜底 |
| 整文件重写 | 未知 `set` 是否整文件重写 `data.json`；若整写，单键写入会覆盖全部数据 | 待验证 Q2。**当前唯一缓解手段是单写者不变式**（13 §5.5 / 04 §5.5）：只有 `primary_chat_id` 对应的聊天可写，非主聊天 `saveState` → `DEGRADED`、`appendEvent` 丢弃、`transaction` → `DEGRADED`，因此不存在两个聊天并发 `set` 同一 `data.json`；再叠加"每次只 `set` 一个键、不并发 `set`"。若未来启用多写者，必须先解决 Q2（确认是否整写）并新增账号级预算协调（D-5） |
| 键名约束 | 1–64 位 `[A-Za-z0-9_-]` | 现有 3–5 字符字面量键合规，不得引入 `:`、`.`、中文 |
| 值类型 | 必须 JSON 可序列化 | 禁止 `Map`/`Set`/`Date`/`BigInt`/`undefined`/`NaN` 落库（`NaN` 会被序列化为 `null`） |

**账号级配额的当前缓解（D-5 复核，2026-11-10）**：宿主无"已用字节"接口，账号级 256 KiB 不可测量。当前唯一缓解是**单写者不变式**（13 §5.5 / 04 §5.5）：只有 `primary_chat_id` 可写，非主聊天 `saveState` → `DEGRADED`、`appendEvent` 丢弃，因此账号占用 = 主聊天占用 ≤ 84 KiB < 256 KiB。若未来启用 `AccountScopedStorageRepo`（多聊天共享存储）或放开非主聊天写入，必须先在 04 §5.2 新增账号级预算协调（各角色预算之和 ≤ 256 KiB 的分配与占用上报），否则 256 KiB 会被静默突破。04 §5.2 已同步登记（v1.7.9）。

---

## 4. 体积预算实测

**本项目包尚未构建**（阶段 0 无 `lib/**`）。以下为真实参考包实测，命令与输出如下：

```powershell
Add-Type -A System.IO.Compression.FileSystem
foreach($p in @('chat-notes-1.1.0.zip','chat-archive-0.1.0.zip','fish-notebook-module-20261109.zip')){
  $f=Join-Path 'c:\Users\Admin（无密码）\Desktop\Agent\Trae\WeChatAgent' $p
  $z=[IO.Compression.ZipFile]::OpenRead($f)
  $m=$z.Entries | Measure-Object -Property Length -Sum -Maximum
  "$p size=$((Get-Item $f).Length) entries=$($z.Entries.Count) uncompressed=$($m.Sum) maxEntry=$($m.Maximum)"
  $z.Dispose()
}
```

真实输出：

```text
chat-notes-1.1.0.zip size=5766 entries=9 uncompressed=8723 maxEntry=1855
chat-archive-0.1.0.zip size=8356 entries=9 uncompressed=17031 maxEntry=5199
fish-notebook-module-20261109.zip size=25329 entries=17 uncompressed=43864 maxEntry=8043
```

| 项 | 预算 | 本项目实测 | 结论 |
| --- | --- | --- | --- |
| `plugin.json` | ≤8 KiB | 待构建（预计 <2 KiB） | 待回填 |
| `index.mjs` | ≤80 KiB | 待构建（预计 <15 KiB） | 待回填 |
| `lib/**`（压缩前） | ≤1.5 MiB | 待构建（预计 <600 KiB） | 待回填 |
| `lib/**`（ZIP 内） | ≤1.0 MiB | 待构建 | 待回填 |
| 解压后总计 | ≤16 MiB | 参考包最大 43,864 B | 余量 >300 倍 |
| 最大单文件 | ≤4 MiB | 参考包最大 8,043 B | 余量 >500 倍 |
| 条目数 | ≤128 | 参考包最多 17 | 余量充足 |
| 目录深度 | ≤8 | 参考包最多 3 层 | 余量充足 |

回填命令（波次 1 产出 `dist/bio-mood-engine.zip` 后执行）：

```powershell
$p = "bio-mood-engine/dist/bio-mood-engine.zip"
(Get-Item $p).Length
$z = [IO.Compression.ZipFile]::OpenRead($p); $z.Entries.Count
$z.Entries | Measure-Object -Property Length -Sum -Maximum
$z.Dispose()
```

---

## 5. 降级手段（无消息级订阅 / 无延迟发送）

| 能力缺口 | 涉及的模块 | 降级方式 | 不得承诺 |
| --- | --- | --- | --- |
| 无消息级订阅 | 02 / 07 / 11 | 状态推进集中在 `observe` / `tick`；`elapsed` 一次性补算；`coarseForward` 处理跨多周期与长静默 | 不得声称"实时感知消息" |
| 无延迟发送 | 11 | `queue_until_awake` 降级为"唤醒后首次推进返回一条补发摘要"，`delivery.policy` 仅作宿主建议 | 不得承诺准点送达 |
| 无后台推送 | 11 / 13 | 睡眠期只能"下次工具调用时再决定是否回复" | 不得注册常驻定时器（`:221`） |
| `long_silence` 精度 | 07 | 仅在下次 `advance` 时发现，发现时间 = 上次推进 + 下次触发 | 不得声称 6 h 精确触发 |
| 无管理员配置接口 | 13 | 管理动作默认 fail-closed；改为 `settings.adminActorIds` 白名单（见 audit C-01） | 不得把 `ctx.actor` 当授权 |
| 无事务 | 04 | 日志键 + 补偿 + 进程内互斥 + 写后重读 | 不得假设宿主原子性 |
| 每日计划不支持回复 | 13 / 11 | `onSchedule` 只做 `tick` 维护，结果留待下次工具调用呈现 | 不得在计划中 `ctx.reply` |

---

## 6. 不允许做的事

1. 不得在 `setup()` 内联网、读 storage、跑 `advance` 或启动定时器（H06）。
2. 不得在 `before-context` / `after-response` 内写 storage 或推进状态（H21）。
3. 不得依赖 `process.cwd()` 定位包内资源，必须用 `new URL('./assets/...', import.meta.url)`（`:31`）。
4. 不得携带 `node_modules`、`.git`、符号链接，或任何构建期脚本（`:29`）。
5. 不得把 `master_seed_hex`、令牌、事件正文写入 storage 之外的日志或工具返回（00 §10.2 + H09）。
6. 不得注册常驻定时器、WebSocket 或后台推送来"补足"实时性（`:221`）。
7. 不得为过 8 MiB 限制而删文档/测试，或改动宿主校验（01 §8）。
8. 不得在嵌入式模式下调用 `ctx.fetch`（本插件零网络依赖）。

---

## 7. 部署模式决策

| 维度 | 权重 | 内嵌核心 | 远程 HTTP | 加权（内嵌 / 远程） |
| --- | --- | --- | --- | --- |
| 部署复杂度 | 25% | 5（单 ZIP） | 2（进程 + 域名 + 证书） | 1.25 / 0.50 |
| 体积可行性 | 20% | 5（<1 MiB） | 5（不受 8 MiB） | 1.00 / 1.00 |
| 可用性 / 故障域 | 20% | 4（本机可用，崩溃隔离） | 2（断网即失效） | 0.80 / 0.40 |
| 延迟 | 10% | 5（无网络往返） | 3（RTT + 排队） | 0.50 / 0.30 |
| 隐私 | 15% | 5（不出本机） | 2（需传聚合状态） | 0.75 / 0.30 |
| 可运维性 | 10% | 2（无集中日志） | 5（热更新、集中日志） | 0.20 / 0.50 |
| **合计** | 100% | **4.50** | 3.00 | — |

**推荐：内嵌（embedded）为默认，远程仅作为同一核心的第二部署壳。**
依据：存储 256 KiB 对本项目 84 KiB 预算充足（不触发 01 §3 的"存储不足再评估远程"条件）；无消息级订阅属于宿主能力缺口，切换远程**不能**弥补，故不构成切换理由。

---

## 8. 验证记录

| 编号 | 验证项 | 命令 | 结果 |
| --- | --- | --- | --- |
| V1 | ZIP 限制来源 | 文档检索 `8 MiB` | 命中 `:33`（代码常量**待验证**） |
| V2 | 子进程堆限制 | 检索 `96 MiB` | 命中 `:171`（代码**待验证**） |
| V3 | 钩子预算 | 检索 `800` | 命中 `:167`（代码**待验证**） |
| V4 | 存储配额 | 检索 `256 KiB` | 命中 `:148`（代码**待验证**） |
| V5 | 消息触达 | 检索 `onMessage` / `hooks` | **无**消息级订阅（只有两类钩子 + 两项专用能力） |
| V6 | 体积实测 | 见 §4 | 参考包已实测；本项目待构建 |
| V7 | 文档一致性 | 逐条核对 F01–F10 | 无未解释冲突；新增 C-01/C-02 冲突见 audit §7 |

---

## 9. 债务验证记录

### D-3｜插件子进程长驻性（已关闭，源码级）

- **关闭时间**：2026-11-10
- **依据级别**：**源码级**（公开仓库 `https://github.com/sourcepro5/WeChatAgent`，`main` 分支；只读，未修改宿主仓库任何文件）
- **证据**：
  1. `packages/plugin-api/process.mjs`：`PluginProcess.start()` 只 `fork('./worker.mjs', …)` 一次并保存为 `this.child`；之后每次工具/钩子调用走 `call()`，都 `this.child.send({type:'call', …})` 复用同一子进程；`this.pending.size >= 8` 时直接返回 `PLUGIN_PROCESS_BUSY`；只有 `stop()`（超时/取消/崩溃/停用）才 `child.kill('SIGKILL')`。→ **不是每次调用 spawn 新进程**。
  2. `packages/plugin-api/worker.mjs`：子进程侧只有**一个** `process.on('message')` 长驻循环，处理 `call` / `service-result` / `dispose`；仅在 `dispose`、`disconnect`、加载失败时退出。→ 子进程是长驻 worker。
  3. `WeChatAgent-plugin-api-v2.md:168`："可导出 `activate()`，只在启用后、子进程初始化时执行。启停通过独立进程创建/结束实现"；`:171` "插件在独立 Node 子进程运行"；`:366` 只有**设置动作**明确"每次调用启动一个短时 Node 子进程"——反证工具调用不按次启进程。
- **结论**：**单长驻 worker（每插件一个子进程，启停即创建/结束）**。02 的 `createMutex()` 在同一进程内即可串行化同一 `character_id` 的读-算-写；04 按现文档（§5.3 / §5.3.1）实现即可，**不需要 `tx_id` 槽位**，不改 00 契约。
- **残余风险**（不改变结论）：
  1. 宿主侧"进程池管理"代码不在公开仓库，无法排除"同一插件多实例并存"（例如多开宿主应用）；04 的 `expectedVersion` 校验与"写入前重读"必须保留。
  2. 单进程内最多 8 个并发 `call`，它们会在 `await` 处交错，`createMutex` 必须包住**完整**的读-算-写，不能只包写入。
  3. 并发超限直接失败（`PLUGIN_PROCESS_BUSY`），13 需映射为可重试错误，避免用户侧看到"偶发失败"。
