# Bio-Mood Engine · Fictional Character Bio-Emotional Simulation

English | [简体中文](./README.zh-CN.md)

A **pure ESM JavaScript engine with zero third-party dependencies**. It splits
cycles, sleep, event stress, neuromodulation, mood, behavioral tendency and
delivery policy into 8 pure-function modules, then adds deterministic
randomness + a single source of truth so that *same input → same output*.
It runs as a library, an HTTP service, or a **WeChatAgent plugin**.

```text
cycle → sleep → event/stress → regulation → mood → behavior → delivery
        (all pure functions: explicit inputs, no system clock, no network, no hidden I/O)
```

> Current version **0.1.3** · `apiVersion` 2 · **465/465** tests · docs consistency PASS
> · GitHub mirror: (your repo URL here)

---

## 1. Disclaimer (read first)

1. **This project simulates a fictional character's state. It is not a human or
   psychological model.** No value may be used for diagnosis, treatment,
   medication advice, or real-world health prediction.
2. **Neuromodulation uses neutral abstract features.** It does not map to real
   neurotransmitter concentrations and must not be presented as a scientific
   metric.
3. **The engine never generates chat text and never sends messages.** It only
   emits state summaries, behavioral tendencies and delivery policy; whether
   and how to reply is decided by the host agent.
4. **Message bodies, sender nicknames and raw `wxid` never enter the engine.**
   Mood is derived only from structured fields such as `event_type` /
   `is_mentioned` / `relationship_tag`.
5. **Seeds and random counters never appear in prompts or logs.**
   `master_seed_hex` is stored only in `state`; logs and `meta` never contain
   the full seed.
6. The remote engine mode (`engineMode=remote`) is a placeholder that returns
   `DEGRADED`; only the embedded mode is production-ready.

---

## 2. System & Version Requirements

| Item | Requirement |
| --- | --- |
| Node.js | **≥ 20** (verified on `v24.19.0`) |
| Runtime dependencies | **None.** Node built-ins only; no `node_modules`, nothing bundled |
| Module format | ESM (`.mjs`), no `require()`; no `package.json`, import by path |
| OS | Windows / macOS / Linux. No platform-specific paths or shell dependencies |
| Host | **WeChatAgent plugin API v2** (`plugin.json` `apiVersion: "2"`), permissions: `storage` / `history_read` / `reply` |
| Encoding | UTF-8 / LF; all timestamps are UTC ISO 8601 with milliseconds (`…Z`) |

Plugin package limits: ZIP ≤ 8 MiB, unpacked ≤ 16 MiB, single file ≤ 4 MiB,
≤ 128 entries, ≤ 8 directory levels.

Current release package (0.1.3):

- **156 911 B** ZIP / **421 394 B** unpacked / **53 entries**
- SHA-256: `5F33B0A4EC8AFBF34A5D8BE5D9049C7F51DEF0EF055C1081E5164919A8FE481E`

---

## 3. Runtime Limits

### 3.1 Time budgets

| Stage | Budget | Behaviour on timeout |
| --- | --- | --- |
| `setup(api)` | ≤ 2000 ms | Zero network, zero storage writes, zero timers |
| Single engine advance | ≤ 5 s | Abort the transaction, write no keys, return `DEGRADED` + neutral context |
| Single tool call (`observe`/`state`/`tick`/`admin`) | ≤ 8 s | Degrade the whole call, current chat continues |
| `before-context` / `after-response` hooks | 800 ms, ≤ 1500 characters injected | Host skips the hook, chat is unaffected |
| Cold-start `state` read | ≤ 200 ms | Read-only; no migration, no eviction, no writes |

### 3.2 Runtime semantics

- **Single character, multi-primary shared state** (0.1.3+). Up to 8 primary
  chat IDs (comma-separated in `primaryChatId`) all read and write the same
  state — like a real person chatting in multiple conversations at once.
  Non-primary chats see `NON_PRIMARY_READONLY` and cannot advance state.
- **Concurrent writes** from two primaries hit the optimistic lock
  `STATE_VERSION_CONFLICT` and surface as `DEGRADED`.
- **The delivery queue is in-process and volatile.** It is lost on restart.
  There is no timer: delivery timing is best-effort and is only re-evaluated
  on the next `observe` / `tick`.
- **First deployment requires pre-configuration.** `adminActorIds` defaults
  to empty, which makes `tick` and every `admin` action return
  `UNAUTHORIZED`; `bind_primary` cannot bootstrap. Set both `primaryChatId`
  (comma-separated list supported) and `adminActorIds`.
- **Admin actions never roll back automatically.** Failures write
  `meta.recovery_required`, return `DEGRADED`, and require manual
  intervention; do not retry automatically.
- **`after-response` is off by default** and requires the `reply` permission
  to enable.
- **HTTP entry points:** request body ≤ 64 KiB; idempotency records are
  retained for 7 days; the `tick` / `admin` bodies reject `api_version`
  and `actor_id`.
- **Numeric range:** every persisted value is a `[0, 1]` float; `0–100`
  exists only for presentation.

### 3.3 Known limitations (ledger items tracked in `docs/冲突报告与问题台账.md`)

Seven open issues at time of writing, none blocking current use. See the
ledger for full descriptions and adjudication.

---

## 4. Quick Start

```bash
# 1. Full test suite (no install step, zero deps)
node --test

# 2. Docs / ledger consistency check (paths, test IDs, whitelist)
node tools/check-docs.mjs

# 3. Deterministic scenario replay: trace / report / contrib / offline HTML
node tools/sim/run.mjs tools/sim/scenarios/quiet_week.json --out out

# 4. Diff two traces
node tools/sim/diff.mjs out/a.trace.jsonl out/b.trace.jsonl

# 5. Build the plugin package
node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.3.zip
```

Simulation CLI exit codes: `0` pass, `1` assertion failure, `2`
non-deterministic, `3` invalid input. Outputs are written to
`<out>/<scenario_id>.{trace.jsonl,report.json,contrib.json,html}`; the HTML
report is a single offline file (no external links, no external scripts).

### As a WeChatAgent plugin

1. Run `node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.3.zip`.
2. In WeChatAgent → Plugins → "Install from file…", pick the ZIP.
3. Open plugin settings and set:
   - `primaryChatId` — comma-separated list of chat IDs (e.g.
     `1689847162,928374615`). These chats share one engine state.
   - `adminActorIds` — comma-separated list of admin `wxid`s.
   - `enabled` — true.
4. Restart / reload and grant permissions when prompted.
5. Click "Open" on the plugin card for the read-only state page, or call
   the `bio-mood-engine__state` tool from any primary chat.

---

## 5. Layout

```text
bio-mood-engine/
├── lib/
│   ├── core/            # models, clock, coordinator, PCG32, versioning
│   ├── modules/         # cycle / sleep / stress+event / regulation / mood / behavior / delivery
│   ├── storage/         # repository, transaction, migration, idempotency
│   └── api/             # /v1/state /v1/events /v1/tick /v1/admin
├── plugins/bio-mood-engine/
│   ├── plugin.json      # manifest, apiVersion: 2, settings schema
│   ├── index.mjs        # setup(api) — registers tools + hooks + read-state action
│   ├── ui.json          # declares the read-only state page
│   ├── ui/              # page.html / page.js / style.css (PRTS / Rhode Island UI)
│   └── lib/adapter/wechatagent/   # manifest, repo, hooks, tools, degrade
├── tools/sim/           # parse / run / analyze / render / diff + 8 scenarios
├── scripts/             # pack-plugin.mjs (hand-rolled ZIP writer, no deps)
├── tests/               # unit / contract / integration / simulation
├── release/             # 0.1.3 · 0.1.2 · 0.1.1 · 0.1.0 · 0.0.9
├── design/              # offline preview HTML for the state page
├── acceptance/          # hands-on acceptance checklist
├── docs/                # contracts 00–16, integration reports, runbooks, issue ledger
├── CHANGELOG.md
├── LICENSE              # MIT + disclaimer addendum
└── README.md
```

---

## 6. Documentation

| Document | Contents |
| --- | --- |
| [00 — Unified Contract](./docs/00-统一契约.md) | Global data model, time, numerics, randomness, errors, API envelope (highest authority) |
| [02 — Core Models & Time Coordinator](./docs/02-核心数据模型与时间协调器.md) | State schema, clock, update pipeline, offline advance |
| [03 — Seeds & PRNG](./docs/03-随机种子与PRNG.md) | PCG32, sub-seed derivation, counters, golden vectors |
| [04 — Persistence & Idempotency](./docs/04-持久化与事件幂等.md) | Repository interface, transactions, migrations, retention |
| [12 — API Contract](./docs/12-API服务与接口契约.md) | Four endpoints, auth, rate limiting, error codes |
| [13 — WeChatAgent Adapter](./docs/13-WeChatAgent插件适配层.md) | Tools/hooks, budgets, degradation, storage keys, packaging, multi-primary semantics |
| [14 — Test Baseline](./docs/14-测试基线与长期仿真.md) | Test layers and case IDs |
| [15 — Integration & Release](./docs/15-集成联调与发布.md) | E01–E07, rollback, operations, acceptance |
| [16 — Simulation & Replay](./docs/16-仿真回放与可视化.md) | Scenario format, A1–A10 checks, M01–M16 gates |
| [Issue Ledger](./docs/冲突报告与问题台账.md) | Single source of truth: issues, rulings, evidence |
| [UI Theme Spec](./.trae/documents/明日方舟_罗德岛_UI设计主题规范.md) | Rhode-Island-inspired dark industrial UI spec |
| [CHANGELOG](./CHANGELOG.md) | Version history |

---

## 7. Current Status

| Item | Result |
| --- | --- |
| `node --test` | **465 pass / 0 fail** (unit + integration + contract) |
| `node --test tests/simulation/*.test.mjs` | 21/22 pass; T12 pure-chunk gate is a known本机 failure (0.42 vs 0.4 ms/iter on this machine), unrelated to code correctness |
| `node tools/check-docs.mjs` | PASS (0 missing paths, 0 missing case IDs, 0 whitelisted paths) |
| End-to-end scenarios E01–E07 | 7/7 pass |
| State page | read-only, auto-refresh, multi-primary aware |
| Plugin package | 156 911 B ZIP / 421 394 B unpacked / 53 entries, all internal specifiers resolvable |

---

## 8. License

MIT — see [LICENSE](./LICENSE).

### Attribution notes

- This project is an original design for a **fictional character simulation**
  and is not affiliated with any real product, game, or organisation.
- The dark industrial UI style in the state page draws aesthetic inspiration
  from the *Rhodes Island* interface language described in
  [`.trae/documents/明日方舟_罗德岛_UI设计主题规范.md`](./.trae/documents/明日方舟_罗德岛_UI设计主题规范.md)
  — this is an internal design reference, not an official asset reproduction.
