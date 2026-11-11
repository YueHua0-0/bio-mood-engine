# 03 · 随机种子与 PRNG

| 项目 | 内容 |
| --- | --- |
| 任务书编号 | 03 |
| 执行者 | 随机系统 Agent |
| 波次 | 1（与 02 并行） |
| 依赖 | `00-统一契约.md` §6 |
| 交付 | `lib/core/random.mjs`、`tests/unit/random.test.mjs` |
| 下游 | 05 周期、06 睡眠、07 事件、09 情绪、11 交付 |

---

## 1. 背景与目标

角色的自然波动必须"看起来随机、实际可复现"。本项目不使用 `Math.random()`，也不依赖任何运行时默认随机实现，而是：

1. 用 **BLAKE2b-512** 从主种子派生每个模块的子种子；
2. 用 **PCG32（XSH RR）** 生成 32 位无符号整数；
3. 每个模块**独占**一条随机流，互不影响；
4. 持久化 `seed_hex + counter`，恢复时精确快进。

目标：同一种子 + 同一调用序列 → 逐位相同的输出；一个模块多取一个随机数，不影响其他模块。

### 1.1 为什么不用 `Math.random()`

- 序列不承诺跨 Node 版本稳定；
- 无法持久化"调用到第几个数"；
- 无法隔离模块间影响；
- 无法编写金向量测试。

---

## 2. 范围与非目标

**范围**

- `deriveSeed({master_seed_hex, character_id, stream_label, algorithm_version})`；
- `Pcg32` 类：`nextU32 / nextFloat / nextRange / nextNormal / nextInt / counter`；
- `RandomProvider`：按 `stream_label` 创建、缓存、序列化、恢复；
- `createMasterSeed()`：仅在**初始化时**由调用方传入随机源（本模块不读系统熵）；
- 金向量测试与流隔离测试。

**非目标**

- 不决定哪个模块取几个随机数（由 05–11 决定）；
- 不负责把种子写入存储（属于 04）；
- 不把种子当密码学密钥（不做密钥派生用途）。

---

## 3. 契约摘要

| 契约项 | 值 |
| --- | --- |
| `algorithm` | `"pcg32"` |
| `algorithm_version` | `1` |
| `master_seed_hex` | 32 位小写十六进制（128 位） |
| `seed_hex` | 32 位小写十六进制（128 位） |
| 流标签 | `cycle` / `sleep` / `mood` / `event` / `delivery`，以及 `cycle:${cycle_index}`、`event:${event_id}` |
| 派生消息 | `master_seed_hex + "|" + character_id + "|" + stream_label + "|" + algorithm_version` |
| 摘要 | `BLAKE2b-512(UTF-8(message))`，取前 32 个十六进制字符 |
| initstate | `seed_hex` 前 16 位十六进制 → BigInt |
| initseq | `seed_hex` 后 16 位十六进制 → BigInt |
| 持久化 | 每个流保存 `{seed_hex, counter}` |

---

## 4. 输入 / 输出

```js
export function deriveSeed({ master_seed_hex, character_id, stream_label, algorithm_version = 1 }) {}

export class Pcg32 {
  constructor({ initstate, initseq }) {}
  static fromSeedHex(seed_hex) {}
  nextU32() {}            // 0 .. 2^32-1
  nextFloat() {}          // [0,1)
  nextRange(min, max) {}  // [min,max)
  nextInt(minInclusive, maxInclusive) {}
  nextNormal() {}         // 均值 0，标准差 1（Box-Muller）
  get counter() {}
  exportState() {}        // { seed_hex, counter }
}

export class RandomProvider {
  constructor({ master_seed_hex, character_id, algorithm_version = 1, streams }) {}
  stream(label) {}        // 返回 Pcg32，同 label 复用同一实例
  serialize() {}          // -> {algorithm, algorithm_version, character_id, master_seed_hex, streams}
                          //    完整内存快照，用于同一次 advance 内的重算回滚
  static restore(snapshot) {}                  // 接受 serialize() 的完整快照（自包含）
  toPersisted() {}        // -> {algorithm, algorithm_version, master_seed_hex, streams}
                          //    与 00 §3.1 的 random 一致，写回 state.random
  static fromPersisted({ random, character_id }) {}  // 从 state.random + character_id 恢复
  snapshotCounters() {}
}

export function createMasterSeed(entropy) {}  // Uint8Array(≥16 字节) 或 32 位十六进制 → 32 位小写十六进制
                                             // 熵源由调用方注入，本模块不读系统熵（P-04-02）
```

`RandomProvider` 必须是**唯一可变状态持有者**，生命周期为单次 `advance()`（00 §11.4 方案 A）：**调用方**负责提供与 `state.random` 一致的 provider，通常在每次 `advance` 前用 `fromPersisted({ random: state.random, character_id })` 创建并作为 `rngProvider` 传入；`advance` 内部不新建 provider；**协调器**在返回前把 `rngProvider.toPersisted()` 写回 `draft.random`，调用方不得再次自行写回。同一步内连续多次 `advance`（16 仿真）允许复用同一实例，持久化或丢弃后必须重新 `fromPersisted`。`master_seed_hex` 按 00 §10.2.1 处理：**只允许**随 `state` 键持久化，禁止进入 `evlog`/`idem`/`meta`/快照/日志/API 响应（对外只暴露 `master_seed_id`）。

---

## 5. 算法与规则

### 5.1 PCG32 常量

```js
const MASK64 = (1n << 64n) - 1n;
const MULT   = 6364136223846793005n;   // PCG32 乘数
const MASK32 = 0xFFFFFFFFn;
```

### 5.2 播种（必须与参考实现一致）

```js
constructor({ initstate, initseq }) {
  this._state = 0n;
  this._inc = ((initseq << 1n) | 1n) & MASK64;
  this._counter = 0;
  this.nextU32();                                  // 步进 1（计数器不计）
  this._state = (this._state + initstate) & MASK64;
  this.nextU32();                                  // 步进 2（计数器不计）
  this._counter = 0;                               // 播种消耗不计入业务计数
}
```

**播种期间两次 `nextU32` 不得计入 `counter`**，否则"第 0 个随机数"的定义会随实现漂移。实现上可用内部 `_step()` 计数。

口径明确：播种结束后 `counter = 0`；每次 `nextU32()` **先自增再返回**（见 §5.3 参考实现），因此调用后 `counter` 表示"已消耗的业务随机数个数"——第 1 次业务调用返回后 `counter = 1`。`serialize().streams[label].counter` 按此口径，`vectors.random.json` 中的期望值按此口径生成（R10 的"一次 `nextU32` 后为 1"即此语义）。

### 5.3 生成

```js
_step() {
  const old = this._state;
  this._state = (old * MULT + this._inc) & MASK64;
  const xorshifted = (((old >> 18n) ^ old) >> 27n) & MASK32;
  const rot = Number(old >> 59n);
  return Number(((xorshifted >> BigInt(rot)) |
                 (xorshifted << BigInt((-rot) & 31))) & MASK32);
}
nextU32() { this._counter += 1; return this._step(); }
nextFloat() { return this.nextU32() / 4294967296; }
nextRange(a, b) { return a + (b - a) * this.nextFloat(); }
nextInt(lo, hi) { return lo + Math.floor(this.nextFloat() * (hi - lo + 1)); }
```

- 必须使用 `BigInt` 做 64 位运算，**禁止**用两个 32 位整数模拟。
- `nextFloat` 必须是 `u32 / 2^32`（与金向量一致），不要用 `u32 >>> 8` 的 24 位版本。
- `nextRange` 必须保证 `a < b`，否则抛 `INVALID_REQUEST`。
- `nextInt` 的区间是闭区间 `[lo, hi]`，且必须是整数。

### 5.4 正态分布

```js
nextNormal() {
  let u1 = this.nextFloat();
  const u2 = this.nextFloat();
  if (u1 < 1e-12) u1 = 1e-12;          // 防止 log(0)
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(3.5, Math.max(-3.5, z));
}
```

- **固定消耗 2 个 u32**，任何情况下都不得重试、不得额外取样；`u2` 必须无条件取出。
- 结果直接裁剪到 `[-3.5, 3.5]`（每秒最多一次裁剪，不影响分布主体）。
- 需要不同分布时（如对数正态），在模块内用 `nextNormal` 变换，不得新增随机原语。
- 若业务真的需要"拒绝重采样"，必须在新方法 `nextNormalRejection()` 中实现，并同时提升 `algorithm_version`，不得改动 `nextNormal` 的消费规则。

### 5.5 派生

```js
import { createHash } from 'node:crypto';

export function deriveSeed({ master_seed_hex, character_id, stream_label, algorithm_version = 1 }) {
  const message = `${master_seed_hex}|${character_id}|${stream_label}|${algorithm_version}`;
  const digest = createHash('blake2b512').update(Buffer.from(message, 'utf8')).digest('hex');
  return { seed_hex: digest.slice(0, 32), message };
}
```

`node:crypto` 是 Node 内置模块，不属于"运行时依赖"，允许使用。若目标环境不支持 `blake2b512`（极少见），必须报 `MODULE_FAILED` 并附 `details.algorithm='blake2b512'`，**不得**偷偷换成 sha256。

### 5.6 流标签规范

| 用途 | 标签 |
| --- | --- |
| 周期推进（按周期） | `cycle:${cycle_index}` |
| 周期全局（初始化长度采样） | `cycle` |
| 睡眠 | `sleep` |
| 情绪噪声 | `mood` |
| 单事件 | `event:${event_id}` |
| 事件批量（无法给 id 时） | `event` |
| 交付抖动 | `delivery` |

规则：

1. 标签只允许 `[a-z0-9:_-]`，长度 1–96；
2. 同一标签必须得到同一子种子（纯函数，无状态）；
3. **不得**从父流"借"随机数来派生；派生只走 BLAKE2b；
4. `state.random.streams` 只保存基础五条流（`cycle/sleep/mood/event/delivery`）；`cycle:3`、`event:evt_x` 这类临时流**不写入状态**，其 `counter` 由所在业务上下文（周期序号、事件 id）保证确定性。

### 5.7 持久化与恢复

- `advance()` 结束时由**协调器**执行 `draft.random = rngProvider.toPersisted()` 写回 `{algorithm, algorithm_version, master_seed_hex, streams}`（00 §3.1 / §11.4）；本模块不提供也不允许其他写回路径。
- 恢复入口一律走 `fromPersisted({ random, character_id })`；同一次 `advance()` 内部的"丢弃重算"才使用 `serialize()` / `restore(snapshot)`。
- `master_seed_hex` 只在 `state` 键内允许完整出现；`serialize()` 结果禁止写日志、禁止写快照（00 §10.2.1）。
- 快进成本：每 100 万步约 1.5–2 秒（BigInt 乘法），因此设上限 `MAX_FAST_FORWARD = 5_000_000`；超过视为数据损坏，抛 `MODULE_FAILED`（`details.reason='counter_too_large'`）。
- 允许的另一种实现：额外保存 `pcg_state_hex`（64 位十六进制）直接还原。两种实现二选一，但**必须**在 `random.mjs` 顶部注释声明所选项，并保证 `exportState()` 形状一致。

### 5.8 并发

- `Pcg32` 实例**不得**跨调用共享；`RandomProvider` 生命周期为单次 `advance()`。
- 同一 `character_id` 的推进已由 02 的互斥保证串行；若未来并发，必须每个事务创建独立 provider，冲突由乐观锁解决，禁止共享可变实例。

---

## 6. 金向量（实现必须逐位匹配）

### 6.1 参考向量（PCG 官方）

```text
initstate = 42
initseq   = 54
nextU32() 前 6 个：
0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e
```

### 6.2 项目派生向量

```text
master_seed_hex   = 000102030405060708090a0b0c0d0e0f
character_id      = whale_character
stream_label      = cycle
algorithm_version = 1

seed_hex   = 764d289e285a86b68df58ef666b4c9ab
initstate  = 0x764d289e285a86b6
initseq    = 0x8df58ef666b4c9ab
nextU32() 前 5 个：
0x3e60b694, 0x5b31491f, 0x28f715f3, 0x15b85784, 0x3803ea34
nextFloat() 前 5 个（9 位小数）：
0.243663226, 0.356220789, 0.160020229, 0.084844084, 0.218809736
```

### 6.3 其他基础流的期望 `seed_hex`（用于交叉校验）

```text
sleep    = 2a335db9e807acd15ced81dd3d031dd0
mood     = ecf6bd05e6e6f015b0a1d365b8c07051
event    = 9398027bcf759ae763ab788570dbeb47
delivery = 09a2ee87bac47513794a69b42e3b6e80
```

> 五个值必须由实现现场算出并与上表比对；若不一致，先检查 `character_id`、标签与版本号是否被误改，**不要**反过来改表。

---

## 7. 边界与错误

| 场景 | 处理 | 错误码 |
| --- | --- | --- |
| `master_seed_hex` 非 32 位十六进制 | 拒绝 | `INVALID_REQUEST` |
| `character_id` 不匹配 `^[a-z][a-z0-9_-]{0,63}$` | 拒绝 | `INVALID_REQUEST` |
| `stream_label` 非法字符或超长 | 拒绝 | `INVALID_REQUEST` |
| `algorithm_version` ≠ 1 且无迁移 | 拒绝 | `MODULE_FAILED` |
| `nextRange(1,1)` | 拒绝 | `INVALID_REQUEST` |
| `counter < 0` 或非整数 | 视为损坏 | `MODULE_FAILED` |
| `counter > 5e6` | 拒绝快进 | `MODULE_FAILED` |
| 运行环境无 `blake2b512` | 拒绝降级 | `MODULE_FAILED` |
| 同一 provider 被两个异步任务同时写 | 禁止；由调用方保证串行 | — |

---

## 8. 交付文件

```text
lib/core/random.mjs
tests/unit/random.test.mjs
tests/unit/_random_vectors.mjs     # 金向量常量（供多模块复用）
```

---

## 9. 测试要求

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| R01 | 参考向量 42/54 | 前 6 个 u32 全等 |
| R02 | 派生 `cycle` | `seed_hex === 764d...c9ab` |
| R03 | 派生前 5 个 u32 | 全等 |
| R04 | 派生前 5 个 float（9 位小数） | 全等 |
| R05 | `sleep/mood/event/delivery` 的 `seed_hex` | 与 §6.3 全等 |
| R06 | 相同参数调用 `deriveSeed` 两次 | 深度相等 |
| R07 | 改变 `character_id` | `seed_hex` 变化 |
| R08 | 改变 `algorithm_version` | `seed_hex` 变化 |
| R09 | 流隔离：先消耗 `mood` 100 个数，再取 `cycle` 前 5 个 | 与 R03 相同 |
| R10 | `counter` 语义：播种后 `counter===0`，一次 `nextU32` 后为 1 | 成立 |
| R11 | `exportState` → `restore` → 下一个数 | 与原实例下一个数相同 |
| R12 | 快进 10 万次后恢复 | 输出一致，耗时 < 300 ms |
| R13 | `nextNormal` 10 万次 | 均值 ∈ `[-0.02,0.02]`，标准差 ∈ `[0.97,1.03]`，全部 `[-3.5,3.5]` |
| R13b | 连续调用 `nextNormal` 1000 次 | `counter` 恰好增加 2000，无额外消耗 |
| R14 | `nextFloat` 100 万次 | 全部 `[0,1)`，无 `1` |
| R15 | `nextInt(1,6)` 6 万次 | 六个值都出现，频次偏差 < 8% |
| R16 | `nextRange(0.2,0.8)` | 全部落在区间内 |
| R17 | `counter=5_000_001` 恢复 | 抛 `MODULE_FAILED` |
| R18 | 非法种子 `'zz'` | 抛 `INVALID_REQUEST` |
| R19 | `toPersisted()` | 形状与 00 §3.1 `random` 完全一致且可 `JSON.stringify`；`serialize()` 额外含 `character_id`，仅用于本次推进回滚 |
| R20 | 五个流各自独立 `counter` | 互不影响 |

---

## 10. 验收命令

```powershell
node --test tests/unit/random.test.mjs
Select-String -Path "lib/core/random.mjs" -Pattern "Math\.random|Math\.floor\(.*\)\s*\*\s*2\*\*32"
```

预期：20 项全通过；检索无 `Math.random`。

性能抽检：

```powershell
node -e "import('./lib/core/random.mjs').then(async m=>{const s=m.deriveSeed({master_seed_hex:'000102030405060708090a0b0c0d0e0f',character_id:'whale_character',stream_label:'mood'});const p=m.Pcg32.fromSeedHex(s.seed_hex);console.time('1e6');for(let i=0;i<1e6;i++)p.nextU32();console.timeEnd('1e6');console.log(p.counter)})"
```

要求：100 万次 < 2 秒，`counter === 1000000`。

---

## 11. 禁止事项

1. 禁止使用 `Math.random()`、`crypto.randomInt()`、`crypto.randomBytes()` 生成**模拟**随机（仅允许初始化时由调用方提供主种子）。
2. 禁止用 32 位算术模拟 64 位 PCG 状态。
3. 禁止在模块间共享同一个 `Pcg32` 实例。
4. 禁止用"消费父流"的方式派生子种子。
5. 禁止把 `master_seed_hex` 全量写入日志（只允许 `master_seed_id`）。
6. 禁止把随机数直接映射为情绪标签或回复内容。
7. 禁止为了让测试通过而修改金向量。
8. 禁止引入外部 PRNG 库。

---

## 12. 汇报模板

```text
模块：03 随机种子与 PRNG
波次：1
依赖版本：00-统一契约 v1.7.3（§6）（v1.7.3：saveState details.warnings、state_backup 例外）
完成的任务：派生 / PCG32 / Provider / 序列化恢复
新增文件：lib/core/random.mjs、tests/unit/random.test.mjs、tests/unit/_random_vectors.mjs
修改文件：无
关键设计决策：<播种是否计 counter / 是否额外保存 pcg_state_hex>
接口变化：无 / <列出>
测试命令：node --test tests/unit/random.test.mjs
测试结果：pass <> / fail 0；100 万次耗时 <> ms
金向量核对：R01–R05 全部匹配 / 不匹配项：<列出>
未解决问题：<逐条>
已知风险：<逐条>
是否需要契约变更：是/否
下一模块建议：04 持久化与事件幂等
```
