# CHANGELOG

本项目的全部数值、文案与行为均为**虚构角色状态模拟**，不是人体医学模型，不用于诊断、治疗或现实健康预测。

## 0.1.3 — 2026-11-11

### 新增
- 多主会话共享引擎（P-13-19）：`primaryChatId` 现在接受逗号或空白分隔的多个 chat id（最多 8 项，合计 ≤ 512 字符）；任一命中的会话都能 observe/tick 写盘、都能注入模型上下文。

### 语义变更
- 之前：单 primary。非主会话一律 `NON_PRIMARY_READONLY`，`before-context` 返回空、`bio-mood-engine__state` 与 `bio-mood-engine__tick` 全部降级。
- 现在：多个主会话共享同一个角色的 state —— 群里被 @ 和私聊里被问，情绪都会被推动，更接近真人。非主会话依旧只读。

### 实现要点
- `normalizeConfig` 把 `primaryChatId` 逗号分隔字符串归一成运行期的 `primaryChatIds: string[]`。
- `createChatScopedRepo` 接受 `primaryChatIds` 数组；`primary_chat_id` meta 字段记逗号拼接的完整列表；`admin_source_key` 改用**当前 chatId**（admin 操作应当记在它实际发生的那个聊天上）。
- `hooks.mjs` 的上下文注入、`repo.mjs` / `tools.mjs` 的 scope 判定全部改成 `.includes(chatId)`。

### 发布包
- `release/bio-mood-engine-0.1.3.zip`：156 911 B，SHA-256 `5F33B0A4EC8AFBF34A5D8BE5D9049C7F51DEF0EF055C1081E5164919A8FE481E`。
- 回滚：上一可用包 `release/bio-mood-engine-0.1.2.zip`。

## 0.1.2 — 2026-11-11

### 新增
- 插件状态页：`ui.json` + `ui/{page.html,page.js,style.css}`，按周期 / 睡眠 / 压力 / 情绪四块展示，另附行为倾向与调节参数；只读、30 秒自动刷新（P-13-18）。
- 页面 action `read-state`：转调 `state` 工具，空参数 Schema，与模型工具共用同一套受限 Schema 自检。

### 修改
- `scripts/pack-plugin.mjs` 放行 `ui.json` 与 `ui/**`，发布包开始包含页面静态文件。
- 视觉按 `.trae/documents/明日方舟_罗德岛_UI设计主题规范.md` 落地：深色工业底板、1px 细线、切角、编号与状态灯；颜色优先继承宿主 `--wa-*`。

### 已知问题
- 宿主 `public/console/plugin-frame.mjs` 只透传 20 个 `--wa-*`，且 `MutationObserver` 只观察 `data-theme|style|class`；切换三个主题预设不会推送 `theme`。页面以宿主变量为主，并按 `--wa-bg` 底色识别罗德岛深色预设。
- 本机性能门禁 T12 / T16-90d / M03 未达标（同 0.1.1，非本次回归）。

### 发布包
- `release/bio-mood-engine-0.1.2.zip`：155 766 B，SHA-256 `B02E641D1F488E51CFD145F4B89E368BD97D8F8054D3A221DD5DAD8BACFEBFDE`。
- 回滚：上一可用包 `release/bio-mood-engine-0.1.1.zip`（144 879 B）。

## 0.1.1 — 2026-11-11

### 修改
- `adminActorIds` 改填**wxid 明文**（可带 `wxid_` 前缀），插件内部立即转 12 位候选哈希，明文不落盘、不回显（P-13-17）。
- 每项生成两个候选哈希（完整 wxid / 剥前缀主体，去重），任一命中即授权；已写成 12 位十六进制的存量值原样接受，大写归一为小写。
- **留空 = 不修改**：设置留空时沿用落盘的 `meta.admin_hashes`（最近一次非空设置，`observe` 事务内写入）；从未落盘过非空值仍 fail-closed 全拒。
- 生命周期版本号递增至 `0.1.1`，`plugin.json` 中 `adminActorIds` 的标题/描述/`maxLength`（160 → 512）同步。

### 已知问题
- 本机性能门禁 T12 / T16-90d / M03 未达标，判为整机单核性能约为阈值参考机 40%，非代码回归（见台账 §9 第二十六轮）。

## 0.1.0 — 2026-11-10

### 新增
- 引擎核心：`lib/core/{clock,random,models,coordinator,invariants}.mjs`，八模块按 `MODULE_ORDER` 装配，`advance()` 纯函数推进。
- 业务模块：周期（05）、睡眠（06）、压力（07）、事件（08）、调节（09）、情绪（10）、交付（11）、行为（13 §5.7）。
- 持久化：`lib/storage/{repository,plugin-storage,sqlite-store,file-store}.mjs`，五键单事务、乐观锁与迁移备份。
- HTTP 服务：`lib/api/*`，`/v1/events`、`/v1/state/{id}`、`/v1/tick`、`/v1/admin/reset`、`/health`、`/version`。
- WeChatAgent 插件：`plugins/bio-mood-engine/*`，四个工具（`observe`/`state`/`tick`/`admin`）与两个钩子（`before-context`/`after-response`）。
- 仿真回放：`tools/sim/*`，≥8 个确定性场景与 `diff` 对比。
- 发布工具：`scripts/pack-plugin.mjs`（自研 ZIP，零第三方依赖）。

### 修改
- `observe` 的进程内待交付队列改为以 `event.source.conversation_id` 为准；合并后同会话只保留 1 条保留项（`merged_count` 累加）。
- `tx.putMeta` 合并写入 `meta`，支持 ≤12 条状态摘要回放（C-12-01）。
- 事务中止判定移到 `ensureReady()` 之后，保证迁移日志 `migrated` 不丢失（P-13-02）。

### 已知问题
- `docs/冲突报告与问题台账.md` §3 为唯一问题清单；未裁决项与已验证项以台账为准。
- `engineMode=remote` 仅做开关与降级映射，未接入远程传输实现。
- `FUTURE_OCCURRED_AT` 目前按钳制处理，未独立返回专用错误码。

### 回滚方式
- R1：控制台关闭"允许此插件运行"。
- R2：`settings.enabled=false`（零注入、零写入）。
- R3：用 `state_backup` 覆盖 `state` 键，`state_version` 取备份值。
- R4：`shadowMode=true` 或卸载插件（回复链路不受影响）。
- 上一可用包：`release/bio-mood-engine-0.0.9.zip`（保留 ≥30 天）。
