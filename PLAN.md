# Floorplan — any model, any harness

Branch: `any-model` · Status: **implemented** — P1–P6 landed in 0.12.0, renumbered to 0.99.11 so it sorts
above every upstream release; 545 tests with 544 passing and 1 skipped (the Windows-only case). See CHANGELOG 0.99.11 and `docs/engines.md`.
Baseline: fork `kkazakov/floorplan` @ `94f81b4` (Floorplan 0.11.0), in sync with `upstream/main`.
Test baseline (Node v24.12.0): **488 tests, 487 pass, 0 fail, 1 skipped** (`node --test`).

---

## 1. Goal

The same Floorplan works in every situation, with **no required agent harness**:

1. **Interactive map** (Ask bar, guided flows, blueprint Change, "Fix with …" prompts) answered by
   **any model** through an OpenAI-compatible HTTP endpoint — including local models (Ollama,
   LM Studio, vLLM) — with no `claude`/`codex` CLI installed.
2. **Headless map generation** driven by any model over a plain API: scan → describe → build,
   with no harness and no human in the loop.
3. **Harness portability** of the skill itself: `SKILL.md` runs unchanged in DSH, Claude Code,
   Codex, Cursor, OpenCode, Gemini CLI, or a plain script that follows the workflow file.

### Success criteria (measurable)

- A fresh machine with only Node 18+ and one API key (or local Ollama) can: create a map,
  update it, ask it questions, and change a blueprint. No agent CLIs anywhere.
- Every existing test passes unchanged; new tests cover each engine and the driver against a
  mock LLM server.
- **Zero new npm dependencies** (project constraint).
- Nothing new is committed into user repos; keys are never written to disk or logs unless the
  user chooses.

### Non-goals (v1)

- Native Anthropic / Gemini HTTP adapters (open question 1).
- A config UI / engine picker inside the map (open question 3).
- Headless blueprint creation from a PRD (the workflow file deliberately excludes it — it needs
  a person to answer questions; a *refresh* of an existing blueprint works).

---

## 2. What already works — verified in this codebase

The code is far more prepared for this than the README suggests:

| Fact | Evidence |
|---|---|
| Scripts never call a model. The agent's only job is writing three JSON files: `architecture.json`, `descriptions/*.json`, `recent-work.json` | `scripts/`, `workflow.json`; confirmed by docs and tests |
| The entire pipeline is already described **as data** in `workflow.json` (jobs, JSON Schemas, retries, `onlyChange`, optional/restore, NEXT handlers) | `skills/floorplan/workflow.json` |
| A reference headless driver exists (canned answers instead of a model) and is tested end-to-end | `tests/unattended.test.mjs` (799 lines), `docs/unattended.md` |
| The interactive server has an **`ENGINES` table** designed for adding engines: `{ name, structured, schemaFile, find, run }` | `skills/floorplan/assets/serve.mjs` (~line 158) |
| Schemas are already reshaped for **OpenAI structured outputs** ("want every property required and nothing extra") | `serve.mjs` `strict()` (~line 216) |
| Answer parsing already falls back from `structured_output` to fenced-JSON / brace extraction | `serve.mjs` `parseAnswer()` (~line 323) |
| Auth/rate-limit error mapping is reusable | `serve.mjs` `failCode()` |
| Ask/flow/change **instructions are already parameterized by engine flavor**: `'cli'` (bash + read source) vs tool-based (`find_items`, `get_item`, `dependency_path`, graph-only) | `assets/graph-query.js` `floorplanAskInstructions(G, engine)` (~line 244) |
| Agent branding is centralized and `none` already exists (neutral copy: "Fix with AI") | `scripts/lib/agent.mjs` (35 lines), `FLOORPLAN_AGENT` |
| `CLAUDE.local.md` integration is correctly gated on `agent === 'claude'` | `scripts/build.mjs` (~line 696) |
| Env knobs already exist: `FLOORPLAN_ENGINE`, `FLOORPLAN_MODEL`, `FLOORPLAN_CLAUDE`, `FLOORPLAN_CODEX`, `FLOORPLAN_UNATTENDED` | grep across scripts/assets |
| Secrets masking is a stable, exported helper any driver can call | `scripts/lib/health.mjs` `maskSecrets` (tested) |

### The actual gaps

- **G1 — Interactive answers** require the `claude` or `codex` CLI. `ENGINES` has exactly two
  entries; `docs/unattended.md` states outright: asking questions "need the map's server and
  Claude Code or Codex, as usual."
- **G2 — No shipped driver.** The executor contract exists (`workflow.json`) but the only
  driver is a test helper with canned answers; there is no real model adapter.
- **G3 — SKILL.md assumes a Claude-shaped harness.** 20 × `${CLAUDE_SKILL_DIR}`, a `!`-prefixed
  status line, `$ARGUMENTS`, `/floorplan` command references, "Fix with Claude/Codex" phrasing.
- **G4 — Unknown harnesses are branded "Claude".** `detectAgent()` falls back to `claude`
  (`scripts/lib/agent.mjs`), so DSH/Cursor/OpenCode maps say "Fix with Claude".
- **G5 — No config surface** for endpoint / key / model beyond `--model`; the server hardcodes
  the instruction flavor `'cli'` when building MODES (`serve.mjs` ~line 205).
- **G6 — UI has no notion of a configured-but-offline engine.** Ask availability and naming
  come from the injected `window.FLOORPLAN_SERVER = { token, cli, engine, want, version, model,
  change, editor }` only.

---

## 3. Target architecture

```
            codebase (read-only, root-bounded, secrets masked)
                  │
   ┌──────────────┼───────────────────┐
   │              │                   │
scripts/*.mjs   agent (any harness)   │
(scan/build/    follows SKILL.md,     │
 describe/…)    writes 3 JSON files   │
   │              │                   │
   └──────┬───────┘                   │
     floorplan/  (the map)            │
          │                           │
     open.mjs → serve.mjs             │
          │        │                  │
          │      engines:             │
          │      ├ claude CLI  (kept, unchanged)
          │      ├ codex CLI   (kept, unchanged)
          │      └ http        (NEW — default when configured)
          │              │              │
          │              └──────────────┤
          │                     scripts/lib/llm.mjs   (NEW, shared client)
          │                     OpenAI-compatible + tools + structured output + retries
          │                                     │
          └─────── driver.mjs (NEW — headless pipeline executor, no harness)
```

Everything new lives in plain, dependency-free Node ≥18 (global `fetch`).

---

## 4. Design decisions (recommended)

- **D1 — Transport-agnostic engine interface.** Refactor `runAgent`'s child-process assumption
  into an async event stream (`progress` / `answer` / `fail`). The `claude`/`codex` engines
  become adapters that feed their existing JSON-lines child output into the same stream. The
  `http` engine produces events directly. Cancellation, quiet-time hints, and the `running` map
  keep working for all engines.
- **D2 — v1 model surface = OpenAI-compatible `/v1/chat/completions` + optional function
  calling.** This one adapter covers OpenAI, DeepSeek, most gateways, Ollama, LM Studio, vLLM.
  Native Anthropic/Gemini adapters are v2 (open question 1).
- **D3 — Tools are optional; degrade honestly.** Three answer qualities per model:
  1. *Full*: model gets read-only tools (bounded file read / list / grep + the three graph
     tools), secrets masked in tool results;
  2. *Graph-only*: the existing non-`cli` instruction flavor — `find_items`, `get_item`,
     `dependency_path` served by the server, no source access;
  3. *No tools*: prompt carries a graph digest; Ask still works, Change is disabled (already
     gated on `structured`).
  Capability is detected per endpoint (structured outputs and tools can be probed/assumed, with
  graceful fallback on first failure).
- **D4 — Instruction flavor is an engine property, not a constant.** Replace the hardcoded
  `'cli'` in MODES with the engine's flavor; reuse the existing tool-flavor text from
  `graph-query.js` and extend it with the source-tools sentence for quality-1 models.
- **D5 — Config surface: `floorplan/config.json` + env overrides.** Keys:
  `{ "engine": "http", "baseUrl", "apiKeyEnv" (never the key itself), "model", "tools": "auto|on|off" }`;
  env: `FLOORPLAN_ENGINE`, `FLOORPLAN_BASE_URL`, `FLOORPLAN_API_KEY[_ENV]`, `FLOORPLAN_MODEL`,
  `FLOORPLAN_TOOLS`. The map folder self-ignores in git; `config.json` joins that ignore set.
  The UI receives only `{ configured, engineLabel, model, baseUrlHost, tools }` — never the key.
- **D6 — Agent neutrality.** `agent.mjs` `DETECT` gains best-effort probes for common harnesses
  (DSH, Cursor, OpenCode, Gemini); unknown ⇒ `none` (was: `claude`). "Fix with …" wording comes
  from the same table; `CLAUDE.local.md` stays strictly Claude-only.
- **D7 — Engine selection order.** `FLOORPLAN_ENGINE` > the map's recorded agent (if that CLI
  is installed) > configured `http` > `none`. With `none` and no config, the Ask bar shows a
  "configure an engine" hint instead of silently missing.
- **D8 — The driver is a shipped tool, not a test helper.** `skills/floorplan/driver.mjs`
  executes `workflow.json` against the shared client. CLI:
  `node skills/floorplan/driver.mjs <root> [--json] [--open]`. Implies
  `FLOORPLAN_UNATTENDED=1` (writes nothing outside `floorplan/`, exit codes per
  `docs/unattended.md`).
- **D9 — One shared LLM module.** `scripts/lib/llm.mjs` (client, strict schemas, parse,
  tool loop, retries) is imported by both `serve.mjs` engines and `driver.mjs`. `strict()` and
  `parseAnswer()` move there; `serve.mjs` imports them back (no behavior change).
- **D10 — No new UI picker in v1.** Config-only; the injected config gains one field and the
  Ask bar shows the engine name and a hint. Picker is v2 (open question 3).
- **D11 — Project constraints honored.** Zero npm dependencies; everything local; the map
  stays offline; nothing is committed to the user's repo; secrets never stored.

---

## 5. Work breakdown

### P0 — Setup ✅ (done)
Fork cloned to `~/Projects/floorplan`, `upstream` remote added, branch `any-model` created,
baseline tests green (487/488). This document is the only change so far.

### P1 — Skill portability & agent-neutral core (~1 day)
1. **SKILL.md sweep**: replace all 20 `${CLAUDE_SKILL_DIR}` references with a portable
   convention — "`FP` = the folder holding this SKILL.md (your harness may expose it as
   `${CLAUDE_SKILL_DIR}` or a skill base directory; either way, use that path)".
2. Remove the `!`-prefixed status line (Claude syntax); make "run `status.mjs` yourself" the
   universal first step (the fallback paragraph already covers this — simplify, don't expand).
3. **agent.mjs**: extend `DETECT` (DSH env, Cursor, OpenCode, Gemini probes), default `none` for
   unknown; extend `cliLabel`/naming table.
4. Confirm and test that all `CLAUDE.local.md` behavior stays gated on `claude` (it is today —
   add a regression test).
5. **New lint test**: SKILL.md contains no `${CLAUDE_SKILL_DIR}` outside the documented note,
   no `!` command lines, and frontmatter parses as plain YAML.

*Exit*: SKILL.md runs unchanged in DSH/Cursor/OpenCode; full suite green.

### P2 — Shared LLM client + mock server (~1.5 days)
1. **`scripts/lib/llm.mjs`**: request building (system/user/tool messages), structured-output
   schema (reuse `strict()`), response parsing (`structured_output` → fenced JSON → brace
   extraction), validation-feedback retries (≤2, mirroring `workflow.json` `answerRetries`),
   bounded tool-call loop, secret masking on every tool result and final answer, timeout/abort.
2. **Mock OpenAI-compatible server** in `tests/` (plain `node:http`): deterministic canned
   completions, tool-call sequences, structured output, 401/429, malformed JSON.
3. Unit tests: `strict()`, parsing, retries, masking, tool budget.

*Exit*: `llm.mjs` fully exercised via mock; no dependencies.

### P3 — Headless driver (~2 days)
1. **`driver.mjs`**: complete `workflow.json` executor — script steps (spawn, `--json`, exit
   codes), job steps (inputs/instructions/schemas), `save`/`saveFields`, `repeat`/`until` with
   `minAttempts`/`maxAttempts`, `next` handlers, `optional`/`restore`/`onFail`, `onlyChange`
   enforcement, template substitution (`{path}`, `{now}`, `forEach` items), conditions, bounded
   parallel worksheet jobs.
2. Job tools: native function calling when supported; otherwise the existing worksheet-based
   fallback (worksheets already quote endpoint code and short files — the describe job works
   with zero tool support).
3. Config resolution shared with the server (D5).
4. Extend `tests/unattended.test.mjs`: same assertions, but answers served by the mock HTTP
   server; keep the canned-driver path as a fast unit path.

*Exit*: driver produces a complete map (`build.ok`, `descriptions.complete`) on the sample
fixture against the mock; CI green.

### P4 — Interactive server engines (~2.5 days)
1. Refactor `runAgent` to the D1 event-stream interface; re-implement `claude`/`codex` on top
   (zero behavior change, existing tests stay green).
2. **`http` engine**: chat/completions with tools per D3; sessions = server-memory bounded turn
   history (reuse the `codex` conversations pattern); tool-call progress events;
   `failCode` mapping for HTTP statuses; abort wiring.
3. MODES use the engine's instruction flavor (D4); `canChange` stays `structured`-gated.
4. Engine selection per D7.

*Exit*: ask/flow/change answered by the mock server in tests; claude/codex paths unchanged.

### P5 — Config, UI injection, security (~1 day)
1. `floorplan/config.json` read/write + ignore rules + env overrides; keys never logged
   (redact in serve diagnostics).
2. `window.FLOORPLAN_SERVER` gains `{ engineLabel, baseUrlHost, tools }`; Ask bar shows engine
   name and a configure hint when no engine is available.
3. Tool sandbox for the `http` engine: root-bounded; exclude `floorplan/index.html`,
   `serve.mjs`, `page-safety.mjs`, `.cache/**` (the same list `claudeRun` passes); mask secrets;
   per-question tool budget.
4. Privacy docs: a table of where each engine sends prompts.

*Exit*: hostile-content/read-only tests extended to the `http` tool layer; no key in any log.

### P6 — Docs, release, changelog (~1 day)
1. `docs/engines.md` (engines, config, local models, privacy); README install/quick-start +
   "Any model" section; `docs/unattended.md` rewritten (driver now shipped); FAQ; SECURITY.
2. CHANGELOG entry; `CHECKSUMS.txt` + release flow per `docs/development.md`; version 0.99.11.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Model quality for `architecture.json` | Existing retry loops + build feedback; driver reports per-job attempts; `plain_language` step is `optional` |
| Structured-output variance (some providers ignore `json_schema`) | `strict()` + fenced-JSON fallback + validation retries (`parseAnswer` already tolerant) |
| Tool-calling variance | Probe/fallback on first failure; degrade to graph-only or no-tool flavors (D3) |
| Secrets via tools or model answers | `maskSecrets` on every tool result and written answer (already exported & tested) |
| Backward compat regression | `claude`/`codex` engines kept and re-implemented on the same event interface; full suite must stay green (487/488 baseline) |
| Upstream drift (upstream is active) | Merge `upstream/main` into `any-model` at the start of each phase; expect conflicts in `serve.mjs` and `SKILL.md` — resolve then |

---

## 7. Open questions (recommendations in parentheses)

1. **API scope for v1**: OpenAI-compatible only — it covers local models and most hosted
   providers. Native Anthropic/Gemini adapters in v2? *(Yes.)*
2. **No-tool models and Ask quality**: graph-only answers are honest but weaker. For models
   without function calling, should the server run `query.mjs` lookups itself and inject the
   JSON into context (equivalent quality, zero bash exposure)? *(Yes — it's the `cli`-flavor
   result without giving the model a shell.)*
3. **UI picker** for engine/model inside the map: now or later? *(Later — config file + env
   first, picker as v2.)*
4. **Driver UX**: should `driver.mjs --open` start the map server after a successful build?
   *(Yes, with default off for CI.)*
5. **Keep `claude`/`codex` engines long-term?** *(Yes, for parity; eventually propose the
   engine abstraction upstream.)*
6. **Branch name** `any-model` — rename before any PR if you prefer something else.

---

## 8. Definition of done

- On a fresh machine with Node 18+ and one OpenAI-compatible endpoint (or Ollama), a user can
  create, update, ask, and blueprint-change a map — driver + server, no agent CLIs.
- All existing tests pass; new engine/driver/mock tests pass; zero npm dependencies.
- Docs (engines, unattended, README, privacy) updated; CHANGELOG and release artifacts done.
