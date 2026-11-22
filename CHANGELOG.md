# Changelog

All notable changes to **Antigravity Context Inspector** are documented in this file.

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
