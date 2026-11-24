# Changelog

All notable changes to **Antigravity Context Inspector** are documented in this file.

## [1.2.1] - 2026-11-24

### Fixed
- **Breakdown & drill-down alignment:** Grouped conversation messages by the same step-type category as the row totals (`category` field + `categoryItems()` in `public/js/views.js`), fixing `SYSTEM_MESSAGE` and `ERROR_MESSAGE` items (which reach the model with `role=user`) previously inflating *User messages* and leaving *System messages* empty.
- **Unknown breakdown groups:** Treated unknown `ContextWindowMetadata` group types (such as `0` "Unspecified", which carries the `Identity` section) as *System prompt* in both accounting and content parsing instead of dropping them from `used_tokens`.
- **Chat label parsing:** Added support for `Message <n> (CHAT_MESSAGE_SOURCE_*)` chat breakdown labels and counted unknown step type names as tools rather than falling back to proportional scaling for the entire message list.
- **Windows path shortening & deduplication:** Matched drive-letter home directories case-insensitively in `shortenPath()` and deduplicated detected file lists (`skill_files`, `artifact_files`, `knowledge_files`) by shortened path instead of raw URI.

### Changed
- **Testable server utilities (`lib/server_utils.mjs`):** Extracted pure helpers (`buildLightReport`, `workspacePath`, settings sanitization, and `compareSemver`) from `main.mjs` into `sidecars/inspector/lib/server_utils.mjs` (no `sidecar_sdk` dependency) and expanded the test suite to 41 tests.
- **Housekeeping:** Removed the leftover `sidecars/inspector/lib/__init__.py` and Python `.gitignore` entries, and documented Node.js `22.16+` as the standalone CLI requirement in `README.md`.

## [1.2.0] - 2026-11-23

### Changed
- **Pure Node.js (`node:sqlite`) single-runtime migration:** Eliminated the Python 3 dependency completely. Context Inspector now runs 100% on Antigravity Desktop’s bundled Node.js runtime using built-in modules (`node:sqlite`, `node:crypto`, `node:fs`, `node:util`) with zero external dependencies.
- **Direct in-process parsing (~8x faster):** `sidecars/inspector/main.mjs` now calls `buildSnapshot()` directly in-process instead of spawning a Python subprocess and JSON-parsing stdout on every cache miss, while preserving LRU caching, in-flight deduplication, `subStamp` TOCTOU guards, and read-only SQLite transactions (`DatabaseSync({ readOnly: true })` + `BEGIN`/`ROLLBACK` + `stmt.iterate()`).
- **Zero-copy Node.js protobuf wire decoder (`lib/protobuf.mjs`):** Ported schema-less wire decoding to `BigInt` varints (with 10-byte overflow guards) and `Uint8Array.subarray` zero-copy slices across `lib/{protobuf,accounting,subagents,content,snapshot}.mjs` with 100% output parity.
- **Standalone Node.js CLI & modular `node:test` suite (33 tests):** Replaced the Python CLI and `unittest` suite with `sidecars/inspector/inspector.mjs` (`node sidecars/inspector/inspector.mjs`) and modular `tests/*.test.mjs` suites (`protobuf`, `accounting`, `subagents`, `content`, `snapshot_cli`, plus 10 new zero-dependency `frontend_utils` tests).
- **Node-only CI:** Streamlined `.github/workflows/ci.yml` to run solely on Node.js 24 across Ubuntu, macOS, and Windows (manifest JSON & version sync validation, `node --check` on all ESM/browser modules, `node --test`, and shell/PowerShell installer syntax checks).

## [1.1.0] - 2026-11-22

### Added
- **Turn-by-turn growth sparkline:** Crisp 44px borderless SVG sparkline right below the segmented context bar (`≥ 2` turns) with auto-scaled Y-axis, adaptive round turn markers (`≤ 32` turns), labeled dashed budget threshold guide, compaction markers, and zero-flicker full-area hover telemetry (`Turn N · tokens (+delta)`).
- **MCP server breakdown:** Groups MCP tools by server (`mcp_<server>_<tool>`, `<server>__<tool>`, `server:tool`, `server/tool`) ranked by total token cost, with nested per-tool schema peek.
- **Swarm Worker support:** Automatically discovers Swarm workers from `<appData>/brain/<convId>/.system_generated/swarm/members.json`, tracks live `.db` / `-wal` / `members.json` changes, labels Swarm workers with a subtle `swarm` badge, and supports full `← Main` / `Open ↗` drill-down.
- **Minimalist Settings popover (`⚙`):** Persisted in `${ANTIGRAVITY_EXECUTABLE_DATA_DIR}/settings.json` via `GET /api/settings` and `POST /api/settings/save`:
  - Compact threshold (`50%`, `60%`, `75%`, `Off`)
  - Primary meter mode (`Native` vs `Budget` — scales hero, segmented bar, category percentages, and free space to the active trim budget)
  - Compact action (`Send /compact` with two-step confirmation vs 1-click `Copy only`)
- **Cache drop warning & session summary:** Highlights unexpected prompt cache drops (`< 50%` after active caching, excluding compaction cold turns) in amber (`Cache X% ↓`), and reveals a 1-line weighted session summary (`turns · avg cache · total out · thinking`) on click.
- **Subagent status & smooth transitions:** Accurately detects running subagents across parallel tool steps, pending steps, and LLM thinking phases (with 15s running-cache revalidation and a subtle pulse dot), plus zero-flash directional slide+fade drill-down transitions and subtle expand/pop micro-animations (`prefers-reduced-motion` aware).
- **Interactive demo GIF** (`docs/img/demo.gif`) and updated dual Dark/Light preview (`docs/img/preview.png`).

### Fixed & Improved
- Zero-copy wire-level protobuf field skipping (`iter_fields`) with streaming O(2-blob) `gen_metadata` tracking, 10-byte varint overflow guards, O(limit) `make_preview()`, and atomic SQLite read transactions (`BEGIN`/`ROLLBACK`).
- Fixed proto3 zero-omission bugs on first compaction (`checkpoint = 0`) and message `step_index = 0`, plus `system_overhead` double-counting and `quick_subagent_stats()` fallback when `breakdown` is absent.
- Hardened sidecar security and concurrency: strict `workspacePath` validation (`fileURLToPath`, UNC & CLI flag rejection), sanitized subprocess `env` (no `ANTIGRAVITY_CSRF_TOKEN` leak), loopback-only `lsRequest`, atomic writes for `settings.json`/`model-catalog.json`, `subStamp` TOCTOU and `snapshotInFlight` sequence guards, `/api/update` lock, and macOS Homebrew Python discovery.
- Hardened frontend state & security: monotonic `refreshSeq`/`settingsSeq` race guards, `fetchFullItem` inline error/retry state, bounded 40-entry LRU `itemCache`, `https:` validation for `releaseUrl`, regex-free `splitPath()`, and narrow-panel CSS polish.
- Made `scripts/install.ps1` and `scripts/install.sh` stage downloads/clones before replacing an existing install (with TLS 1.2 for PS 5.1 and `$LASTEXITCODE` checks), and hardened `.github/workflows/ci.yml` (`permissions: contents: read`, `shell: bash`, installer syntax & version-sync checks).
- Aligned `TOKEN_SYSTEM_PROMPT` nested subgroups (`skills`, `subagents`, `flows`), preserved outer metadata and raw generic result text during `Step._rehydrate()`, and expanded unit test suite to 23 tests.
- Modularized the zero-dependency codebase: extracted subagent/Swarm discovery into `lib/subagents.py` with named protobuf/step constants, split the frontend into `public/js/{utils,sparkline,views}.js` + `public/app.js` with single delegated click handling (assembled in-memory into classic `/app.js` for sandboxed webview compatibility), and added `mtime`-validated static asset caching in `main.mjs`.

## [1.0.0] - 2026-11-22

### Added
- Initial release of Antigravity Context Inspector (`AUX_PANE` side panel, zero external dependencies, read-only SQLite inspection, native & request budget meters, inline content peek, subagent drill-down, two-step `/compact`, native Dark/Light theme sync, and GitHub Releases update notification).
