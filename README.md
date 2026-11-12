# Bio-Mood Engine · Fictional Character Bio-Emotional Simulation

English | [简体中文](./README.zh-CN.md)

[![Stars](https://img.shields.io/github/stars/YueHua0-0/bio-mood-engine?style=flat-square&logo=github)](https://github.com/YueHua0-0/bio-mood-engine/stargazers)
[![Forks](https://img.shields.io/github/forks/YueHua0-0/bio-mood-engine?style=flat-square&logo=github)](https://github.com/YueHua0-0/bio-mood-engine/forks)
[![License](https://img.shields.io/github/license/YueHua0-0/bio-mood-engine?style=flat-square)](./LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=node.js)
![ESM](https://img.shields.io/badge/Module-ESM-blue?style=flat-square)
![Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen?style=flat-square)

**Current version 0.1.4 · Unpublished Candidate** · `apiVersion` 2

A **pure ESM JavaScript engine with zero third-party dependencies**. It splits
cycles, sleep, event stress, neuromodulation, mood, behavioral tendency and
delivery policy into 8 pure-function modules, then adds deterministic
randomness + a single source of truth so that *same input → same output*.
It runs as a library, an HTTP service, or a **WeChatAgent plugin**.

```text
cycle → sleep → event/stress → regulation → mood → behavior → delivery
        (all pure functions: explicit inputs, no system clock, no network, no hidden I/O)
```

## Core Features

- **Deterministic Simulation** — Same input always produces the same state progression; no hidden I/O, no system clock, no network.
- **Modular Pure-Function Architecture** — 8 loosely-coupled modules (cycle → sleep → stress → regulation → mood → behavior → delivery); each accepts explicit inputs and returns explicit outputs.
- **Reproducible Replay** — Scenario traces, contribution reports and offline HTML visualization for every simulation run.
- **Multiple Integration Modes** — Use as a library, mount as an HTTP service, or deploy as a WeChatAgent plugin.
- **Zero Runtime Dependencies** — No `node_modules`, nothing bundled; Node built-ins only.

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
| Node.js | **≥ 20** (only `v24.19.0` executed so far — the 20/22 matrix is still open, see §7). On Node 24, `node --test tests` treats the directory as a module and throws `MODULE_NOT_FOUND`; use `node --test` instead |
| Runtime dependencies | **None.** Node built-ins only; no `node_modules`, nothing bundled |
| Module format | ESM (`.mjs`), no `require()`; no `package.json`, import by path |
| OS | Windows / macOS / Linux. No platform-specific paths or shell dependencies |
| Host | **WeChatAgent plugin API v2** (`plugin.json` `apiVersion: "2"`), permissions: `storage` / `history_read` / `reply` |
| Encoding | UTF-8 / LF; all timestamps are UTC ISO 8601 with milliseconds (`…Z`) |

Plugin package limits: ZIP ≤ 8 MiB, unpacked ≤ 16 MiB, single file ≤ 4 MiB,
≤ 128 entries, ≤ 8 directory levels.

Local **unpublished candidate** package (0.1.4):

- **157 587 B** ZIP / **422 915 B** unpacked / **53 entries** / largest file **41 653 B**
- SHA-256: `BD9F8722328A927A4D5835E6F5F5684D980E518D6F02D5A8B2F542E028B39DC6`
- Built locally on 2026-11-11; V15 checks that it is byte-identical to
  `packPlugin()` output. Historical 0.1.3 and earlier ZIPs are left unchanged.

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

- **Single character, single primary chat** (P-13-20, ruling A). Production
  must configure exactly one `primaryChatId`. Comma/whitespace-separated
  multiple IDs and multi-item arrays are rejected with `FASTCFG_INVALID` and
  fall back to the unbound state (`PRIMARY_UNBOUND`); non-primary chats see
  `NON_PRIMARY_READONLY`. The internal array retains its shape for a possible
  future account-scoped storage design, but only its first item can be a writer.
- **Concurrent writes** inside one chat scope hit the optimistic lock
  `STATE_VERSION_CONFLICT` and surface as `DEGRADED`. The host isolates
  `ctx.storage` per *account + plugin + chat* (04 §1.1); v1 never attempts
  cross-chat reads, writes, or shared state.
- **The delivery queue is in-process and volatile.** It is lost on restart.
  There is no timer: delivery timing is best-effort and is only re-evaluated
  on the next `observe` / `tick`.
- **First deployment requires pre-configuration.** `adminActorIds` defaults
  to empty, which makes `tick` and every `admin` action return
  `UNAUTHORIZED`; `bind_primary` cannot bootstrap. Set one `primaryChatId`
  and `adminActorIds`.
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

### 3.3 Known limitations (open items tracked in `docs/冲突报告与问题台账_未裁决.md`)

The multi-primary design has been withdrawn under **P-13-20, ruling A**: v1 has
one authoritative writer and never shares state across chats. **P-15-08 remains
open for release evidence**: CI matrix/stability results and real-host grey
release/rollback drills are not complete. See §7 and the ledger before any
production freeze; local tests are not a substitute for those items.

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
node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.4.zip
```

Simulation CLI exit codes: `0` pass, `1` assertion failure, `2`
non-deterministic, `3` invalid input. Outputs are written to
`<out>/<scenario_id>.{trace.jsonl,report.json,contrib.json,html}`; the HTML
report is a single offline file (no external links, no external scripts).

### As a WeChatAgent plugin

1. Run `node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.4.zip`.
2. In WeChatAgent → Plugins → "Install from file…", pick the ZIP.
3. Open plugin settings and set:
   - `primaryChatId` — exactly one chat ID (e.g. `1689847162`). Multiple values
     are rejected and fall back to `PRIMARY_UNBOUND`; chats never share state.
   - `adminActorIds` — comma-separated list of admin `wxid`s.
   - `enabled` — true.
4. Restart / reload and grant permissions when prompted.
5. Click "Open" on the plugin card for the read-only state page, or call
   the `bio-mood-engine__state` tool from the primary chat.

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
├── release/             # 0.1.4 local candidate · 0.1.3 · 0.1.2 · 0.1.1 · 0.1.0 · 0.0.9
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
| [13 — WeChatAgent Adapter](./docs/13-WeChatAgent插件适配层.md) | Tools/hooks, budgets, degradation, storage keys, packaging, single-primary semantics |
| [14 — Test Baseline](./docs/14-测试基线与长期仿真.md) | Test layers and case IDs |
| [15 — Integration & Release](./docs/15-集成联调与发布.md) | E01–E08, rollback, operations, acceptance |
| [16 — Simulation & Replay](./docs/16-仿真回放与可视化.md) | Scenario format, A1–A10 checks, M01–M16 gates |
| [Open Issue Ledger](./docs/冲突报告与问题台账_未裁决.md) | Current handoff: pending rulings and ruled/implemented items not yet verified |
| [Verified Issue Archive](./docs/冲突报告与问题台账_已验证.md) | Closed history: verified and rejected items, rulings, and evidence |
| [UI Theme Spec](./.trae/documents/明日方舟_罗德岛_UI设计主题规范.md) | Rhode-Island-inspired dark industrial UI spec |
| [CHANGELOG](./CHANGELOG.md) | Version history |

---

## 7. Current Status

Measured 2026-11-11 on Node `v24.19.0`, Windows, `--test-concurrency=1`.

| Item | Result |
| --- | --- |
| Full suite, run 1 | **490 / 490 pass**, 36.416 s |
| Full suite, run 2 | **489 / 490 pass**, T12 failed (0.4052 ms vs 0.4 ms/iter), 34.198 s |
| Full suite, run 3 | **489 / 490 pass**, T12 failed (0.4082 ms vs 0.4 ms/iter), 34.054 s |
| Other timing gates | M03 and T17 passed all three runs; T12 is the only failure in runs 2–3. No threshold was changed and no functional assertion failed |
| Focused P-13-20 tests | 67 / 67 pass, including multi-value fail-closed and the bypass-manifest second-chat read-only case |
| `node tools/check-docs.mjs` | PASS — scope is **paths and test case IDs only**; it does not verify versions, test counts, hashes or release data |
| End-to-end scenarios E01–E08 | 8/8 pass (host context harness, not a real host) |
| State page | read-only, auto-refresh, shows degradation for non-primary chats |
| 365-day simulation | Run 1: **3 395.2 ms** (gate < 8 s) |
| 0.1.4 candidate package | 157 587 B ZIP / 422 915 B unpacked / 53 entries; every internal specifier resolves; V15 confirms byte identity with `packPlugin()` |

Real-host cross-chat shared-state E2E is **N/A** under P-13-20 ruling A: v1 has
one primary writer and does not offer cross-chat shared state. The following
release evidence is still incomplete and blocks a production freeze:

1. Node 20 / 22 / 24 CI matrix — the workflow exists, but only local `v24.19.0`
   has executed; two consecutive green CI runs have not been recorded.
2. Ten consecutive full-suite CI runs — the three local runs do not replace this
   job, and T17 is only a proxy.
3. Real WeChat host grey release C1–C3 and drills R1–R4.

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
