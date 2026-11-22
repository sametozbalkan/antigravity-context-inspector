<p align="center">
  <img src="assets/logo.svg" alt="Context Inspector logo" width="76" height="76" />
</p>

<h1 align="center">Antigravity Context Inspector</h1>

<p align="center">
  A minimalist, live <strong>Context Window &amp; Subagent Inspector</strong> side panel for the <strong>Antigravity 2.0</strong> desktop app.
</p>

<p align="center">
  <a href="https://github.com/sametozbalkan/antigravity-context-inspector/actions/workflows/ci.yml">
    <img src="https://github.com/sametozbalkan/antigravity-context-inspector/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  </a>
  <img src="https://img.shields.io/badge/dependencies-zero-22c55e.svg" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/Antigravity-2.0%20Desktop-6366f1.svg" alt="Antigravity 2.0 Desktop" />
</p>

<p align="center">
  <img src="docs/img/preview.png" alt="Context Inspector in Dark Mode and Light Mode with subagent drill-down" width="860" />
</p>

---

## Highlights

- **Exact token accounting — not character guesses.** Reads the actual `ContextWindowMetadata` breakdown and prompt payload stored in `~/.gemini/antigravity/conversations/<id>.db` (read-only), paired with live model limits from Antigravity’s model catalog. Zero extra LLM tokens consumed.
- **Native window &amp; request trim budget.** Shows both the model’s native context capacity (e.g. `1M`) and Antigravity’s per-request compaction/trim budget (e.g. `512k`, `256k`, or `128k`), plus live prompt cache hit rate.
- **Minimalist single-page overview with inline content peek.** Clean by default — click any category (`System prompt`, `System tools`, `MCP tools`, `Skills`, `User messages`, `Agent responses`, `Tool calls`) to reveal individual items ranked by token cost, and click any item to inspect or copy its exact content sent to the model.
- **Subagent context monitoring.** Automatically detects spawned subagents, displays their live status and token usage, and lets you drill into any subagent’s full context overview (with `← Main` navigation and `Open ↗` to jump to its chat).
- **Safe two-step `/compact` action.** Automatically surfaces a subtle `Compact` button once context reaches **60%** of the active budget (`Confirm` → sends `/compact` to the conversation, with clipboard fallback if unavailable).
- **Native Dark &amp; Light mode.** Syncs automatically with Antigravity’s live theme variables via the sidecar preload bridge.
- **Zero external dependencies.** Uses only Python 3 standard library and Antigravity’s bundled Node.js runtime — no `npm install`, no `pip install`, no build step.

---

## Requirements

- **Antigravity 2.0 Desktop**
- **Python 3** available on your `PATH` (`python`, `py`, or `python3`)

---

## Installation

### Option 1 — One-line installer (recommended)

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/sametozbalkan/antigravity-context-inspector/main/scripts/install.ps1 | iex
```

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/sametozbalkan/antigravity-context-inspector/main/scripts/install.sh | bash
```

### Option 2 — `git clone`

**Windows (PowerShell):**
```powershell
git clone https://github.com/sametozbalkan/antigravity-context-inspector.git "$HOME\.gemini\config\plugins\context-inspector"
```

**macOS / Linux:**
```bash
git clone https://github.com/sametozbalkan/antigravity-context-inspector.git ~/.gemini/config/plugins/context-inspector
```

### Enable the side panel

1. Open **Antigravity → Customizations → Installed** and make sure **Context Inspector** is enabled (restart Antigravity if it does not appear immediately).
2. Open any conversation and select **Context Inspector** from the right-hand side panel **`+`** menu.

---

## Updating

Context Inspector supports three ways to stay up to date:

1. **In-panel update notification:** The sidecar checks GitHub Releases quietly in the background (cached every 12 hours). When a newer version is published, a subtle `vX.Y.Z available` pill appears in the footer:
   - If installed via `git`, click **Update now** to run `git pull --ff-only` explicitly, then toggle the plugin off and on in Customizations.
   - You can also copy the update command or open the GitHub Release notes without modifying files automatically.
2. **Manual `git pull`:**
   ```bash
   git -C ~/.gemini/config/plugins/context-inspector pull --ff-only
   ```
3. **Re-run the one-line installer:** Running `install.ps1` / `install.sh` again updates an existing installation in place.

---

## Native Context vs. Request Budget

Models like Gemini expose a **1M-token native context window**, while Antigravity applies a smaller per-request **trim / compaction budget** (for example `512k`, `256k`, or `128k` depending on the model) to keep latency low and prevent long-turn context degradation.

- The large top bar shows usage against the model’s **native window**.
- The **Budget** row shows usage against Antigravity’s **active trim threshold** — the point where older history starts getting compacted or trimmed.
- The **Compact** button appears when usage reaches **60%** of the active budget (or 60% of the native window when no separate budget applies).

---

## Architecture

```text
antigravity-context-inspector/
├── plugin.json                        # Antigravity plugin manifest
├── assets/logo.svg                    # Plugin icon
├── scripts/
│   ├── install.ps1                    # Windows PowerShell installer/updater
│   └── install.sh                     # macOS / Linux installer/updater
├── sidecars/inspector/
│   ├── sidecar.json                   # Registers AUX_PANE side panel
│   ├── package.json
│   ├── main.mjs                       # Sidecar HTTP server, model catalog, LRU cache, update check
│   ├── inspector.py                   # CLI entrypoint & snapshot assembler
│   ├── lib/
│   │   ├── protobuf.py                # Minimal wire decoder (stdlib only)
│   │   ├── accounting.py              # Token breakdown, checkpoints, files, subagent discovery
│   │   └── content.py                 # System sections, tool schemas, active messages
│   └── public/
│       ├── index.html                 # HTML shell
│       ├── styles.css                 # Theme-aware minimalist CSS
│       └── app.js                     # Panel UI, inline peek, subagent nav, /compact control
└── tests/
    └── test_inspector.py              # End-to-end synthetic SQLite tests (unittest)
```

### How it works

1. The panel receives the active conversation ID and workspace URIs from Antigravity’s `/preload.js` bridge and polls `/api/report` every 3 seconds while visible.
2. `main.mjs` fingerprints the conversation’s `.db` and `-wal` files (plus any discovered subagent databases) and only invokes `inspector.py --json` when something actually changed.
3. All database connections open strictly read-only (`?mode=ro`). Full item payloads are served instantly from the backend’s in-memory LRU cache via `/api/item` when you click to inspect a row.

---

## CLI Usage & Testing

The Python parser also works standalone from the command line:

```bash
# Latest Antigravity Desktop conversation
python sidecars/inspector/inspector.py

# Specific conversation ID as structured JSON
python sidecars/inspector/inspector.py --conversation-id <uuid> --json

# Arbitrary SQLite conversation database
python sidecars/inspector/inspector.py --db /path/to/<uuid>.db
```

Run the zero-dependency test suite:

```bash
python -m unittest discover -s tests -v
```

---

## License

[MIT](LICENSE) © 2026 [Samet Ozbalkan](https://github.com/sametozbalkan)
