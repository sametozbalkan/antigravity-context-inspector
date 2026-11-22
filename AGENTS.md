# AGENTS.md — Antigravity Context Inspector

Guidance for AI coding agents working in this repository.

## Project Overview

**Antigravity Context Inspector** is a minimalist live Context Window & Subagent Inspector side panel (`AUX_PANE`) plugin for **Antigravity 2.0 Desktop**.

### Hard Constraints
- **Zero external dependencies.** No `npm install`, no Python requirement, no bundler/build step.
  - Backend & Parser: Antigravity's bundled Node.js runtime (ESM, Node 22.5+ / 24+) using built-ins (`node:sqlite`, `node:crypto`, `node:fs`, `node:http`, `node:https`, `node:util`, `node:child_process`) + host-provided `sidecar_sdk`.
  - Frontend: Vanilla HTML, CSS, and JS served directly from `sidecars/inspector/public/`.
- **Strictly read-only DB access.** Never open Antigravity conversation SQLite databases in read-write mode. Always use `openSqliteReadOnly()` (`new DatabaseSync(dbPath, { readOnly: true, timeout })` inside `BEGIN`/`ROLLBACK`).
- **Zero extra LLM token cost.** All accounting comes from existing local SQLite conversation records and Language Server metadata.

---

## Repository Map

```text
.
├── plugin.json                         # Antigravity plugin manifest (version source of truth)
├── assets/logo.svg                     # Plugin icon
├── scripts/
│   ├── install.ps1                     # Windows PowerShell installer/updater
│   └── install.sh                      # macOS / Linux installer/updater
├── sidecars/inspector/
│   ├── sidecar.json                    # Registers AUX_PANE web UI sidecar (`node main.mjs`)
│   ├── package.json                    # ESM marker ("type": "module") & sidecar version
│   ├── main.mjs                        # Sidecar HTTP server, in-process snapshot cache, mtime-cached static assets, LS model catalog, update check
│   ├── inspector.mjs                   # Standalone CLI entrypoint (`node sidecars/inspector/inspector.mjs`)
│   ├── lib/
│   │   ├── protobuf.mjs                # Minimal zero-copy wire-level protobuf decoder (`Msg`, `BigInt` varints, `Uint8Array.subarray`)
│   │   ├── accounting.mjs              # Read-only `node:sqlite` loader, token accounting, step rehydration, compaction, file detection
│   │   ├── subagents.mjs               # Subagent (`invoke_subagent`) & Swarm worker discovery and stats
│   │   ├── content.mjs                 # System sections, tool schemas, active messages for inline peek
│   │   └── snapshot.mjs                # Snapshot assembler (`buildSnapshot`), CLI formatter, SHA-1 fingerprinting
│   └── public/
│       ├── index.html                  # Loads `/preload.js`, `/styles.css`, and classic `/app.js`
│       ├── styles.css                  # Native Antigravity dark/light theme-aware styling
│       ├── app.js                      # Panel state, API polling, render orchestration, delegated click handling
│       └── js/
│           ├── utils.js                # Shared constants, formatting, escaping, clipboard & path helpers
│           ├── sparkline.js            # Turn-by-turn SVG sparkline renderer & hover interaction
│           └── views.js                # Pure HTML template renderers (peek, categories, MCP, subagents, settings, update drawer)
├── tests/
│   ├── helpers.mjs                     # Shared synthetic protobuf/SQLite test builders
│   ├── protobuf.test.mjs               # Wire-level protobuf & varint tests
│   ├── accounting.test.mjs             # Token breakdown, compaction, history & cache drop tests
│   ├── subagents.test.mjs              # Subagent rehydration, quickSubagentStats & Swarm tests
│   ├── content.test.mjs                # Subgroups, MCP server grouping, preview & malformed input tests
│   ├── snapshot_cli.test.mjs           # Fingerprinting, URI/path edge cases & CLI tests
│   └── frontend_utils.test.mjs         # Zero-dep `node:vm` tests for `public/js/{utils,sparkline,views}.js`
└── .github/workflows/ci.yml            # Cross-platform CI (Ubuntu, macOS, Windows; Node 24)
```

---

## Data Flow & Caching Architecture

1. **Panel (`app.js`)**:
   - Receives `conversationId`, workspace URIs, and change events from Antigravity's `/preload.js` (`window.sidecar`).
   - Loads persisted user preferences (`compactThreshold`, `displayMode`, `compactAction`) via `GET /api/settings` and saves updates via `POST /api/settings/save`.
   - Polls `GET /api/report?conversationId=...&workspace=...` every 3s while `!document.hidden`.
   - Skips DOM re-render when `data.summary.fingerprint === state.fingerprint`.
   - Lazily fetches full content for clicked breakdown items via `GET /api/item?conversationId=...&workspace=...&kind=...&id=...`.
2. **Sidecar (`main.mjs`)**:
   - Serves static panel assets (`/`, `/styles.css`, and `/app.js` assembled from `public/js/{utils,sparkline,views}.js` + `public/app.js` inside a private IIFE) via `mtime`-validated in-memory cache (`staticAssetCache`). Classic `<script src="/app.js">` avoids CORS/origin/subpath restrictions in Antigravity's sandboxed sidecar webview.
   - Reads `~/.gemini/antigravity/conversations/<uuid>.db` (configurable via `ANTIGRAVITY_GEMINI_DIR`).
   - Fingerprints `db` + `db-wal` + Swarm `members.json` + workspace + `model-catalog.json` (`baseKey`) plus discovered subagent/worker DB stamps (`subStamp`).
   - Calls `buildSnapshot(db, ws || null, existsSync(CATALOG_PATH) ? CATALOG_PATH : null)` directly in-process on cache miss (no Python subprocess).
   - Maintains a 12-conversation LRU `snapshotCache`, deduplicates concurrent parses via `snapshotInFlight` (`conversationId|baseKey`), and guards against stale writes via `snapshotSeq` and `subStamp` TOCTOU checks.
   - Persists UI preferences to `${ANTIGRAVITY_EXECUTABLE_DATA_DIR}/settings.json` with strict value sanitization (`GET /api/settings`, `POST /api/settings/save`).
   - Fetches live model limits (`maxTokens`, `displayName`) from Antigravity's Language Server (`GetAvailableModels` via `ANTIGRAVITY_LS_ADDRESS` + `ANTIGRAVITY_CSRF_TOKEN`), cached to `model-catalog.json` (10 min TTL, 60s retry cooldown on failure, single in-flight request).
   - Checks GitHub Releases every 12h (`/api/update-status`) and supports explicit user-triggered `git pull --ff-only` (`POST /api/update`).
3. **Parser (`lib/` + `inspector.mjs`)**:
   - `loadDbWithHistory()` (`lib/accounting.mjs`) opens SQLite via `DatabaseSync({ readOnly: true })` and performs a single streaming read-only pass (`BEGIN`/`ROLLBACK` + `stmt.iterate()`) over `steps` and `gen_metadata`, using zero-copy `iterFields()` (`lib/protobuf.mjs` — `BigInt` varints and `Uint8Array.subarray`) to extract per-turn sparkline `history` (last 120 turns) and weighted `sessionUsage` while retaining only the latest `latestStatsBytes` and `latestContentBytes` blobs before decoding.
   - `extractSubagents()` in `lib/subagents.mjs` discovers both `invoke_subagent` subagents (`source: "subagent"`) and Swarm workers (`source: "swarm"`) from `<appData>/brain/<convId>/.system_generated/swarm/members.json`.
   - `extractMcpServer()` in `lib/content.mjs` infers `mcp_server` (`mcp_<server>_<tool>`, `<server>__<tool>`, `server:tool`, `server/tool`, fallback `other`) for MCP server-level breakdown in the UI.
   - `buildSnapshot()` (`lib/snapshot.mjs`) emits `{ summary, content }`; `main.mjs` strips heavy content bodies into `lightReport.index` for `/api/report` and serves full items from cache on `/api/item`.

---

## Protobuf & Accounting Invariants

All protobuf decoding is schema-less wire decoding via `Msg` and `iterFields()` in `lib/protobuf.mjs` using `BigInt` varints (with 10-byte overflow guards) and `Uint8Array.subarray` zero-copy slices. Keep field numbers exact:

- **`gen_metadata.data` (`GenMetadata`)**:
  - `[1]` `chat` (`Chat` / generation request+response)
    - `[1]` fallback raw system prompt string
    - `[2]` repeated `messages`: `[2]` role (`1=user, 2=assistant, 3=system, 4=tool`), `[3]` text, `[4]` tokens (signed32), `[6]` tool_calls (`[1]` id, `[2]` name, `[3]` json args), `[7]` tool_call_id, `[11]` thinking, `[18]` step_index
    - `[4]` `api_usage`: `[2]` uncached input, `[3]` output, `[5]` cached input, `[9]` thinking, `[10]` response
    - `[8]` repeated `tools`: `[1]` name, `[2]` description, `[3]` JSON schema
    - `[9]` `chat_start`: `[2]` active checkpoint index (signed32, `-1` if none), `[10]` `ContextWindowMetadata` (`[3]` `breakdown`, `[4]` request trim/compaction budget)
    - `[16]` repeated `system_sections`: `[1]` name, `[2]` body, `[6]` group_type
    - `[19]` / `[11]` model ID; `[21]` model display name
- **`ContextWindowMetadata.breakdown`**:
  - `[1]` repeated groups: `[1]` name, `[2]` group type (`TOKEN_*`), `[4]` total tokens (signed32), `[5]` repeated children (`[1]` name, `[3]` tokens signed32).
  - **`SYSTEM_PROMPT_SUBGROUPS` invariant**: Antigravity may nest `flows`, `skills`, and `subagents` inside `TOKEN_SYSTEM_PROMPT (1)`. Both `accounting.mjs` (category totals) and `content.mjs` (`parseBreakdownMaps` + `extractContentItems`) must map them via the shared `SYSTEM_PROMPT_SUBGROUPS` dict (`flows -> TOKEN_FLOWS (10)`, `skills -> TOKEN_SKILLS (5)`, `subagents -> TOKEN_SUBAGENTS (6)`) so category rows and expandable drill-down items stay aligned.
- **`steps` table & Rehydration**:
  - Generic tool steps (`step_type = 132`, payload field `140`) may wrap an original step in `__original_cortex_step` (`type_url` ending `/gemini_coder.Step`).
  - `Step._rehydrate()` **must** preserve `this.genericResultText` before replacing `this.pb` so `extractSubagents()` can still read spawned `conversationId` values from rehydrated `INVOKE_SUBAGENT (127)` steps. `extractSubagentId()` also falls back to scanning non-metadata payload fields for native `step_type = 127` steps.
- **Compaction / Checkpoints**:
  - A completed `CHECKPOINT` step (`step_type = 23`, `status = 3`, payload field `30`) with `ck.index > chat_start.active_checkpoint` overrides pre-checkpoint chat token counts with post-checkpoint steps + checkpoint summary tokens.
  - `quickSubagentStats()` opens each subagent DB read-only (`DatabaseSync({ readOnly: true })` inside `BEGIN`/`ROLLBACK`), reads up to 5 non-null `gen_metadata` rows, and performs a targeted query for the latest completed `step_type = 23` step, loading post-checkpoint steps only when compaction occurred.
- **Snapshot `fingerprint` (`lib/snapshot.mjs`)**:
  - Hashes `used_tokens`, `limit_tokens`, `request_budget_tokens`, `model`, `has_breakdown`, `compacted`, `checkpoint_buffer`, `checkpoints`, category `(key, tokens)` pairs, `api_usage`, `history` length + latest token count, `session_usage`, `counts`, `steps.length`, `active_checkpoint`, file lists (`system_files`, `skill_files`, `artifact_files`, `knowledge_files`), and subagent/worker tuples (`conversation_id`, `role`, `model`, `used_tokens`, `limit_tokens`, `request_budget_tokens`, `status`, `swarm_state`, `source`). Update this if you add new top-level summary fields rendered in the panel.

---

## Frontend & Host Bridge Conventions (`app.js` / `styles.css`)

- **Host bridge (`window.sidecar`)**: Always guard optional APIs (`fetch`, `conversationId`, `onConversationChange`, `getWorkspaceUris`, `onWorkspaceChange`, `agent.sendMessage`, `ui.toggleConversation`) so the UI degrades gracefully if an API is absent.
- **Theme sync**: Inherit Antigravity CSS variables (`--foreground`, `--muted-foreground`, `--border`, `--background`) with light/dark fallbacks in `styles.css`.
- **State management**:
  - Always use `resetViewState()` when switching conversations or navigating `navStack` so `openCats`, `openMcpServers`, `closedMcpServers`, `openItems`, `fullPeek`, `sessionSummaryOpen`, and `compactTimer` do not leak across conversations.
  - `render()` uses template-string rendering into `$main.innerHTML` and preserves scroll offsets of open `.peek[data-peek-id] pre` blocks across refreshes. Click interactions are handled via a single delegated `$main` listener (`handleMainClick`); pure view helpers live in `public/js/{utils,sparkline,views}.js`. Escape all dynamic strings with `esc()`.
- **`/compact` control**: Surfaces when `compactThreshold > 0` and `effectivePct >= compactThreshold` (`0` = off, `50`, `60`, `75`; default `60%`, using budget % when a separate request budget applies, otherwise native limit %). In `compactAction: 'send'` mode (default), requires two-step confirmation (`Compact` -> `Send /compact`) and falls back to clipboard copy if `window.sidecar.agent.sendMessage` fails; in `'copy'` mode, copies `/compact` directly.

---

## Verification & Testing

Run these checks before finalizing any change (matches `.github/workflows/ci.yml`):

```bash
# 1. Validate JSON manifests & version sync
node -e '
  const fs = require("node:fs");
  const files = ["plugin.json", "sidecars/inspector/sidecar.json", "sidecars/inspector/package.json"];
  const m = Object.fromEntries(files.map((p) => [p, JSON.parse(fs.readFileSync(p, "utf8"))]));
  if (!m["plugin.json"].version || m["plugin.json"].version !== m["sidecars/inspector/package.json"].version) {
    throw new Error("Version mismatch");
  }
  console.log("JSON & version sync OK:", m["plugin.json"].version);
'

# 2. Node.js & frontend JS syntax check
node --check sidecars/inspector/main.mjs
node --check sidecars/inspector/inspector.mjs
node --check sidecars/inspector/lib/protobuf.mjs
node --check sidecars/inspector/lib/accounting.mjs
node --check sidecars/inspector/lib/subagents.mjs
node --check sidecars/inspector/lib/content.mjs
node --check sidecars/inspector/lib/snapshot.mjs
node --check sidecars/inspector/public/app.js
node --check sidecars/inspector/public/js/utils.js
node --check sidecars/inspector/public/js/sparkline.js
node --check sidecars/inspector/public/js/views.js
for f in tests/*.mjs; do node --check "$f"; done

# 3. Unit & end-to-end tests (synthetic SQLite + protobuf + frontend utils via node:test)
node --test tests/*.test.mjs
```

When modifying `scripts/install.ps1` (Windows PowerShell):
- Remember `$ErrorActionPreference = 'Stop'` does **not** halt on non-zero native exit codes (`git.exe`) in Windows PowerShell 5.1; always check `if ($LASTEXITCODE -ne 0) { throw ... }`.
- Validate PowerShell syntax via `[System.Management.Automation.Language.Parser]::ParseFile(...)`.

---

## Release & Editing Checklist

- Keep `plugin.json` and `sidecars/inspector/package.json` version numbers synchronized when cutting a release.
- Add or extend tests in the matching `tests/*.test.mjs` file for every parser, accounting, subagent, frontend helper, or URI edge-case change.
- Test CLI smoke output when changing formatting: `node sidecars/inspector/inspector.mjs --db <path>` and `--json`.
