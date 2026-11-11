# Bio-Mood Engine · 虚构角色生理情绪模拟引擎

[English](./README.md) | 简体中文

一个用 **纯 ESM JavaScript、零第三方依赖** 实现的角色状态引擎：把「生理周期 / 睡眠 / 事件压力 / 神经调节 / 情绪 / 行为倾向 / 消息交付策略」拆成 8 个纯函数模块，用确定性随机与单一状态源保证「同输入 → 同输出」。可作为库、HTTP 服务或 WeChatAgent 插件三种形态运行。

```text
cycle → sleep → event/stress → regulation → mood → behavior → delivery
        (全部纯函数：显式输入，无系统时间、无网络、无隐式 I/O)
```

> 当前版本 `0.1.0` · `apiVersion` 2 · 测试 470/470 · 文档一致性核对 PASS

---

## 1. 声明（请先读）

1. **本项目是虚构角色的状态模拟，不是人体或心理学模型。** 所有数值不得用于医学诊断、治疗、用药建议或现实健康预测。
2. **神经调节使用中性抽象特征**，不映射任何真实递质浓度，也不构成伪科学式指标。
3. **引擎不生成对话文案，也不发送消息。** 它只输出状态摘要、行为倾向与交付策略；是否回复、怎么回复由宿主 Agent 决定。
4. **消息正文、发送者昵称、原始 `wxid` 不进入引擎**；情绪只由 `event_type` / `is_mentioned` / `relationship_tag` 等结构化字段推导。
5. **种子与随机计数器不进入提示词与日志。** `master_seed_hex` 只落 `state`，日志与 `meta` 不含完整种子。
6. 远程引擎模式（`engineMode=remote`）当前为占位实现，返回 `DEGRADED`；生产形态只有内嵌模式。

---

## 2. 系统版本限制

| 项目 | 要求 |
| --- | --- |
| Node.js | **≥ 20**（本仓库实测 `v24.19.0`）。Node 24 下 `node --test tests` 会把目录当模块加载并报 `MODULE_NOT_FOUND`，请使用 `node --test` |
| 运行时依赖 | **0**，仅用 Node 内置模块；不存在 `node_modules`，不打包依赖 |
| 模块格式 | ESM（`.mjs`），不支持 `require()`；无 `package.json`，直接按路径导入 |
| 操作系统 | Windows / macOS / Linux 均可；代码内无平台相关路径与 shell 依赖 |
| 宿主 | **WeChatAgent 插件 API v2**（`plugin.json` 的 `apiVersion: "2"`），权限：`storage` / `history_read` / `reply` |
| 文本编码 | UTF-8 / LF；时间一律 UTC ISO 8601 毫秒（`…Z`） |

插件包硬限制：ZIP ≤ 8 MiB、解压 ≤ 16 MiB、单文件 ≤ 4 MiB、条目 ≤ 128、目录层级 ≤ 8。当前发布包实测 137 105 B / 49 条目。

---

## 3. 运行限制

### 3.1 时间预算

| 环节 | 预算 | 超时行为 |
| --- | --- | --- |
| `setup(api)` | ≤ 2000 ms | 零网络、零 storage 写、零定时器 |
| 单次引擎推进 | ≤ 5 s | 中止事务、不写任何键，返回 `DEGRADED` + 中性上下文 |
| 单次工具调用（`observe`/`state`/`tick`/`admin`） | ≤ 8 s | 整体降级，本轮聊天继续 |
| `before-context` / `after-response` 钩子 | 800 ms，注入 ≤ 1500 字符 | 宿主跳过，本轮聊天不受影响 |
| 冷启动读 `state` | ≤ 200 ms | 只读，不迁移、不淘汰、不写盘 |

### 3.2 运行语义限制

- **单角色、单实例**：同一 `storage` 上并发写会触发乐观锁 `STATE_VERSION_CONFLICT`，表现为 `DEGRADED`。
- **排队的交付是进程内易失队列**：重启即丢；不依赖定时器，不承诺准点送达，只在下一次 `observe` / `tick` 时重估。
- **首次部署必须预置配置**：`adminActorIds` 默认为空，此时 `tick` 与全部 `admin` 动作一律 `UNAUTHORIZED`，且 `bind_primary` 不能用于引导。请同时配置 `primaryChatId` 与 `adminActorIds`。
- **管理动作失败不自动回滚**：写入 `meta.recovery_required` 并返回 `DEGRADED`，需人工介入，禁止自动重试。
- **`after-response` 默认关闭**，且需要 `reply` 权限才可启用。
- **HTTP 入口**：请求体 ≤ 64 KiB；幂等记录保留 7 天；`tick` / `admin` 的 body 不接受 `api_version` 与 `actor_id`。
- **数值范围**：所有持久化数值为 `[0, 1]` 浮点，`0–100` 只用于展示层。

### 3.3 已知限制（台账待裁决 7 项）

| 编号 | 摘要 |
| --- | --- |
| P-13-07 | 排队项未存 `deliver_after`/`expires_at`，`expired` 原因码不可达 |
| P-13-04 | bootstrap 与首轮推进同事务的约束只写在台账，未写进 13 §5.2 |
| P-09-01 | `dt=0` 事件轮仍叠加 ≤0.008/维噪声，与 13 §5.9 描述不符 |
| P-11-02 | 无事件时仍需读 sleep 计算诊断性 `wake_cost`，与 11 §5.3「不读 sleep」冲突 |
| P-16-04 | 离线场景首夜连续清醒 39 小时 |
| P-15-01 | `events` 接受 `api_version`，`tick`/`admin` 拒绝，文档未写明 |
| P-14-04 | 周期回绕容差、`STORAGE_FAILED` 上抛、迁移失败只到 `recovery_required` 三处实现口径待确认 |

完整描述、代码段与裁决选项见 [冲突报告与问题台账](./docs/冲突报告与问题台账.md)。

---

## 4. 快速开始

```bash
# 1. 全量测试（无需安装依赖）
node --test

# 2. 文档与台账一致性核对（路径、用例编号、白名单）
node tools/check-docs.mjs

# 3. 固定场景仿真：生成 trace / report / contrib / 离线 HTML
node tools/sim/run.mjs tools/sim/scenarios/quiet_week.json --out out

# 4. 两次 trace 差异定位
node tools/sim/diff.mjs out/a.trace.jsonl out/b.trace.jsonl

# 5. 打插件包
node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.0.zip
```

仿真 CLI 退出码：`0` 通过、`1` 断言失败、`2` 非确定性、`3` 输入非法。产物写入 `<out>/<scenario_id>.{trace.jsonl,report.json,contrib.json,html}`，HTML 为离线单文件（无外链、无外部脚本）。

---

## 5. 目录结构

```text
bio-mood-engine/
├── lib/
│   ├── core/            # 模型、时钟、协调器、PCG32、版本
│   ├── modules/         # cycle / sleep / stress+event / regulation / mood / behavior / delivery
│   ├── storage/         # 仓库、事务、迁移、幂等
│   └── api/             # /v1/state /v1/events /v1/tick /v1/admin
├── plugins/bio-mood-engine/   # plugin.json、index.mjs、wechatagent 适配层
├── tools/sim/           # parse / run / analyze / render / diff + 8 个场景
├── scripts/             # pack-plugin.mjs（自研 ZIP，无依赖）
├── tests/               # unit / contract / integration / simulation
├── release/             # 0.1.0 发布包与 0.0.9 回滚包
└── docs/                # 00–16 契约与台账
```

---

## 6. 文档索引

| 文档 | 内容 |
| --- | --- |
| [00-统一契约](./docs/00-统一契约.md) | 全局数据模型、时间、数值、随机、错误、API 信封（最高契约） |
| [02-核心数据模型与时间协调器](./docs/02-核心数据模型与时间协调器.md) | 状态 schema、时钟、更新流水线、离线推进 |
| [03-随机种子与 PRNG](./docs/03-随机种子与PRNG.md) | PCG32、子种子派生、计数器、金向量 |
| [04-持久化与事件幂等](./docs/04-持久化与事件幂等.md) | 仓库接口、事务、迁移、保留策略 |
| [12-API 服务与接口契约](./docs/12-API服务与接口契约.md) | 四个端点、鉴权、限流、错误码 |
| [13-WeChatAgent 插件适配层](./docs/13-WeChatAgent插件适配层.md) | 工具/钩子、预算、降级、存储键、打包 |
| [14-测试基线与长期仿真](./docs/14-测试基线与长期仿真.md) | 测试分层与用例编号 |
| [15-集成联调与发布](./docs/15-集成联调与发布.md) | E01–E07、回滚、运维、验收 |
| [16-仿真回放与可视化](./docs/16-仿真回放与可视化.md) | 场景格式、A1–A10 异常检测、M01–M16 门禁 |
| [冲突报告与问题台账](./docs/冲突报告与问题台账.md) | 唯一状态源：问题、裁决、验证证据 |

---

## 7. 当前验收状态

| 项 | 结果 |
| --- | --- |
| `node --test` | 470 pass / 0 fail |
| `node tools/check-docs.mjs` | PASS（缺失路径 0、缺失用例编号 0、白名单路径 0） |
| 端到端场景 E01–E07 | 7/7 通过 |
| 365 天仿真 | 2 428 ms（门禁 < 8 s） |
| 插件包 | 137 105 B / 解压 363 378 B / 49 条目，包内相对引用可全部解析 |
