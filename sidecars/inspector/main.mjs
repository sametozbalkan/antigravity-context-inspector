// Sidecar backend for Antigravity Context Inspector.
//
// Serves the minimalist single-page Web UI from ./public and exposes:
//   GET  /api/report        Live summary + lightweight item index (cached)
//   GET  /api/item          Full content for a clicked breakdown item
//   GET  /api/update-status Cached GitHub release / version check
//   POST /api/update        Explicit user-triggered `git pull --ff-only`

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const PUBLIC_DIR = join(HERE, 'public');
const SCRIPT = join(HERE, 'inspector.py');
const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const CONVERSATIONS_DIR = join(GEMINI_DIR, 'antigravity', 'conversations');
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const CATALOG_PATH = join(DATA_DIR, 'model-catalog.json');

const GITHUB_REPO = 'sametozbalkan/antigravity-context-inspector';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const UPDATE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CACHED_CONVS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = new SidecarApp();

// --- Subprocess & HTTP helpers -----------------------------------------------

const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [['python', []], ['py', ['-3']], ['python3', []]]
  : [['python3', []], ['python', []]];

let resolvedPython = null;

function execAsync(cmd, args, { timeout = 25000, cwd = undefined } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || String(err)).trim()));
        else resolvePromise(stdout);
      },
    );
  });
}

async function findPython() {
  if (resolvedPython) return resolvedPython;
  for (const [cmd, pre] of PYTHON_CANDIDATES) {
    try {
      const out = await execAsync(cmd, [...pre, '--version'], { timeout: 5000 });
      if (/^Python 3\./.test(out.trim())) {
        resolvedPython = { cmd, pre };
        return resolvedPython;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error('Python 3 not found on PATH.');
}

function httpsGetJson(urlStr, timeout = 5000) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      urlStr,
      {
        headers: {
          'User-Agent': 'antigravity-context-inspector',
          Accept: 'application/vnd.github+json',
        },
        timeout,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// --- Live model catalog via Language Server ----------------------------------

let catalogFetchedAt = 0;

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) return Promise.reject(new Error('Language server env unavailable'));
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const data = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolvePromise, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method}: HTTP ${res.statusCode}`));
            return;
          }
          try { resolvePromise(JSON.parse(text)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function refreshCatalog() {
  if (Date.now() - catalogFetchedAt < CATALOG_TTL_MS && existsSync(CATALOG_PATH)) return;
  catalogFetchedAt = Date.now();
  try {
    const resp = await lsRequest('GetAvailableModels', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    });
    const models = resp?.response?.models || resp?.models || {};
    const catalog = {};
    for (const [id, m] of Object.entries(models)) {
      const maxTokens = Number(m?.maxTokens) || 0;
      if (maxTokens > 0) {
        catalog[id] = { maxTokens, displayName: m.displayName || '' };
      }
    }
    if (Object.keys(catalog).length > 0) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
    }
  } catch (err) {
    console.error('[context-inspector] model catalog unavailable:', err.message);
  }
}

// --- Remote version check & optional git pull --------------------------------

function readLocalVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
    return String(manifest.version || '1.0.0').replace(/^v/, '');
  } catch {
    return '1.0.0';
  }
}

function compareSemver(a, b) {
  const pa = String(a || '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function defaultUpdateCommand(isGit) {
  if (isGit) {
    return process.platform === 'win32'
      ? 'git -C "$HOME\\.gemini\\config\\plugins\\context-inspector" pull --ff-only'
      : 'git -C ~/.gemini/config/plugins/context-inspector pull --ff-only';
  }
  return process.platform === 'win32'
    ? `irm https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.ps1 | iex`
    : `curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.sh | bash`;
}

let updateCache = null;
let updateCheckedAt = 0;

async function getUpdateStatus(force = false) {
  const currentVersion = readLocalVersion();
  const isGitRepo = existsSync(join(PLUGIN_ROOT, '.git'));
  const fallback = {
    currentVersion,
    latestVersion: currentVersion,
    updateAvailable: false,
    isGitRepo,
    releaseUrl: `https://github.com/${GITHUB_REPO}/releases`,
    updateCommand: defaultUpdateCommand(isGitRepo),
  };

  if (!force && updateCache && Date.now() - updateCheckedAt < UPDATE_TTL_MS) {
    return { ...updateCache, currentVersion, isGitRepo };
  }
  updateCheckedAt = Date.now();

  try {
    let latestVersion = '';
    let releaseUrl = fallback.releaseUrl;
    try {
      const rel = await httpsGetJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      latestVersion = String(rel.tag_name || '').replace(/^v/, '');
      if (rel.html_url) releaseUrl = rel.html_url;
    } catch {
      const manifest = await httpsGetJson(
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/plugin.json`,
      );
      latestVersion = String(manifest.version || '').replace(/^v/, '');
    }

    if (latestVersion) {
      updateCache = {
        ...fallback,
        latestVersion,
        releaseUrl,
        updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
      };
      return updateCache;
    }
  } catch {
    // Offline or repo not published yet — fail silently
  }

  updateCache = fallback;
  return fallback;
}

// --- Snapshot cache ----------------------------------------------------------

const snapshotCache = new Map();

function workspacePath(uri) {
  if (!uri) return '';
  if (!uri.startsWith('file:')) return uri;
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

function fileStamp(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

function subagentStamps(subIds) {
  if (!subIds || !subIds.length) return '';
  return subIds
    .map((id) => {
      const p = join(CONVERSATIONS_DIR, `${id}.db`);
      return `${id}:${fileStamp(p)}:${fileStamp(`${p}-wal`)}`;
    })
    .join(',');
}

function buildLightReport(snapshot, updatedAt) {
  const { summary, content } = snapshot;
  return {
    summary,
    updatedAt,
    index: {
      system_sections: content.system_sections.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        group: s.group,
        group_type: s.group_type,
        tokens: s.tokens,
        chars: s.chars,
        preview: s.preview,
      })),
      tools: content.tools.map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        is_mcp: t.is_mcp,
        tokens: t.tokens,
        chars: t.chars,
        preview: t.preview,
      })),
      messages: content.messages.map((m) => ({
        id: m.id,
        kind: m.kind,
        index: m.index,
        role: m.role,
        label: m.label,
        tool_name: m.tool_name,
        has_thinking: m.has_thinking,
        tool_call_count: m.tool_call_count,
        tokens: m.tokens,
        chars: m.chars,
        preview: m.preview,
      })),
    },
  };
}

async function getSnapshotEntry(conversationId, workspaceUri) {
  if (!UUID_RE.test(conversationId || '')) {
    return { error: 'no-conversation' };
  }
  const db = join(CONVERSATIONS_DIR, `${conversationId}.db`);
  if (!existsSync(db)) {
    return { error: 'no-database' };
  }

  await refreshCatalog();
  const ws = workspacePath(workspaceUri);
  const baseKey = [fileStamp(db), fileStamp(`${db}-wal`), ws, fileStamp(CATALOG_PATH)].join('|');

  const cached = snapshotCache.get(conversationId);
  if (cached && cached.baseKey === baseKey && cached.subStamp === subagentStamps(cached.subIds)) {
    snapshotCache.delete(conversationId);
    snapshotCache.set(conversationId, cached);
    return cached;
  }

  const { cmd, pre } = await findPython();
  const args = [...pre, SCRIPT, '--db', db, '--json'];
  if (existsSync(CATALOG_PATH)) args.push('--model-catalog', CATALOG_PATH);
  if (ws) args.push('--workspace', ws);

  const stdout = await execAsync(cmd, args);
  const snapshot = JSON.parse(stdout);
  const updatedAt = new Date().toISOString();
  const subIds = (snapshot.summary.subagents || []).map((sa) => sa.conversation_id);
  const entry = {
    baseKey,
    subIds,
    subStamp: subagentStamps(subIds),
    snapshot,
    lightReport: buildLightReport(snapshot, updatedAt),
    updatedAt,
  };

  snapshotCache.set(conversationId, entry);
  while (snapshotCache.size > MAX_CACHED_CONVS) {
    const oldestKey = snapshotCache.keys().next().value;
    snapshotCache.delete(oldestKey);
  }
  return entry;
}

// --- Static assets & API routes ----------------------------------------------

app.page('/', () => new Response(
  readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8'),
  { contentType: 'text/html; charset=utf-8' },
));

app.page('/styles.css', () => new Response(
  readFileSync(join(PUBLIC_DIR, 'styles.css'), 'utf8'),
  { contentType: 'text/css; charset=utf-8' },
));

app.page('/app.js', () => new Response(
  readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8'),
  { contentType: 'application/javascript; charset=utf-8' },
));

app.api('/api/report', async (data) => {
  try {
    const entry = await getSnapshotEntry(data.conversationId, data.workspace);
    if (entry.error) return entry;
    return entry.lightReport;
  } catch (err) {
    return { error: 'failed', message: err.message };
  }
}, 'GET');

app.api('/api/item', async (data) => {
  try {
    const entry = await getSnapshotEntry(data.conversationId, data.workspace);
    if (entry.error) return entry;
    const { content } = entry.snapshot;
    const { kind, id } = data;
    const list = kind === 'system'
      ? content.system_sections
      : kind === 'tool'
        ? content.tools
        : kind === 'message'
          ? content.messages
          : null;
    if (!list) return { error: 'invalid-kind' };
    const item = list.find((x) => x.id === id);
    if (!item) return { error: 'not-found' };
    return { item };
  } catch (err) {
    return { error: 'failed', message: err.message };
  }
}, 'GET');

app.api('/api/update-status', async () => getUpdateStatus(false), 'GET');

app.api('/api/update', async () => {
  const isGitRepo = existsSync(join(PLUGIN_ROOT, '.git'));
  if (!isGitRepo) {
    return {
      ok: false,
      error: 'not-git',
      updateCommand: defaultUpdateCommand(false),
    };
  }
  try {
    const out = await execAsync('git', ['pull', '--ff-only'], { cwd: PLUGIN_ROOT, timeout: 30000 });
    updateCache = null;
    return {
      ok: true,
      output: out.trim() || 'Updated.',
      needsReload: true,
      currentVersion: readLocalVersion(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      updateCommand: defaultUpdateCommand(true),
    };
  }
}, 'POST');

app.run();
refreshCatalog();
getUpdateStatus(false);
