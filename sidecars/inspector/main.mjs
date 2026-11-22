// Sidecar backend for Antigravity Context Inspector.
//
// Serves the minimalist single-page Web UI from ./public and exposes:
//   GET  /api/report        Live summary + lightweight item index (cached)
//   GET  /api/item          Full content for a clicked breakdown item
//   GET  /api/settings      Persisted panel preferences
//   POST /api/settings/save Update persisted panel preferences
//   GET  /api/update-status Cached GitHub release / version check
//   POST /api/update        Explicit user-triggered `git pull --ff-only`

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const PUBLIC_DIR = join(HERE, 'public');
const SCRIPT = join(HERE, 'inspector.py');
const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const CONVERSATIONS_DIR = join(GEMINI_DIR, 'antigravity', 'conversations');
const BRAIN_DIR = join(GEMINI_DIR, 'antigravity', 'brain');
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const CATALOG_PATH = join(DATA_DIR, 'model-catalog.json');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  compactThreshold: 60,
  displayMode: 'native',
  compactAction: 'send',
};
const ALLOWED_THRESHOLDS = new Set([0, 50, 60, 75]);
const THRESHOLD_STR_RE = /^(0|50|60|75)$/;

const GITHUB_REPO = 'sametozbalkan/antigravity-context-inspector';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const CATALOG_RETRY_MS = 60 * 1000;
const UPDATE_TTL_MS = 12 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 5 * 60 * 1000;
const RUNNING_SUBAGENT_TTL_MS = 15 * 1000;
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_CACHED_CONVS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = new SidecarApp();

// --- Subprocess, filesystem & HTTP helpers -----------------------------------

const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [['python', []], ['py', ['-3']], ['python3', []]]
  : process.platform === 'darwin'
    ? [
        ['/opt/homebrew/bin/python3', []],
        ['/usr/local/bin/python3', []],
        ['/Library/Frameworks/Python.framework/Versions/Current/bin/python3', []],
        ['python3', []],
        ['python', []],
      ]
    : [['python3', []], ['python', []]];

let resolvedPython = null;
let pythonInFlight = null;

function writeFileAtomic(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function execAsync(cmd, args, { timeout = 25000, cwd = undefined, extraEnv = undefined } = {}) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', ...(extraEnv || {}) };
  delete env.ANTIGRAVITY_CSRF_TOKEN;
  delete env.ANTIGRAVITY_LS_ADDRESS;
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env,
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
  if (pythonInFlight) return pythonInFlight;
  pythonInFlight = (async () => {
    for (const [cmd, pre] of PYTHON_CANDIDATES) {
      if (cmd.startsWith('/') && !existsSync(cmd)) continue;
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
  })().finally(() => {
    pythonInFlight = null;
  });
  return pythonInFlight;
}

function readJsonResponse(req, res, prefix, resolvePromise, reject) {
  const chunks = [];
  let total = 0;
  let overflow = false;
  res.on('data', (chunk) => {
    if (overflow) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_HTTP_BYTES) {
      overflow = true;
      const err = new Error(`${prefix}response exceeds ${MAX_HTTP_BYTES} bytes`);
      req.destroy(err);
      reject(err);
      return;
    }
    chunks.push(buf);
  });
  res.on('end', () => {
    if (overflow) return;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      reject(new Error(`${prefix}HTTP ${res.statusCode}`));
      return;
    }
    try {
      const text = Buffer.concat(chunks, total).toString('utf8');
      resolvePromise(JSON.parse(text));
    } catch (e) {
      reject(e);
    }
  });
  res.on('error', reject);
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
      (res) => readJsonResponse(req, res, '', resolvePromise, reject),
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// --- Live model catalog via Language Server ----------------------------------

let catalogFetchedAt = 0;
let catalogRetryAfter = 0;
let catalogInFlight = null;

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) return Promise.reject(new Error('Language server env unavailable'));
  let base;
  try {
    base = new URL(addr.includes('://') ? addr : `http://${addr}`);
  } catch {
    return Promise.reject(new Error('Invalid language server address'));
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported language server protocol: ${base.protocol}`));
  }
  if (!LOOPBACK_HOSTS.has(base.hostname.toLowerCase())) {
    return Promise.reject(new Error(`Non-loopback language server host rejected: ${base.hostname}`));
  }
  const data = JSON.stringify(body);
  const isHttps = base.protocol === 'https:';
  const transport = isHttps ? https : http;
  const reqOptions = {
    hostname: base.hostname.replace(/^\[|\]$/g, ''),
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
  };
  if (isHttps) {
    reqOptions.rejectUnauthorized = false;
  }
  return new Promise((resolvePromise, reject) => {
    const req = transport.request(
      reqOptions,
      (res) => readJsonResponse(req, res, `${method}: `, resolvePromise, reject),
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function refreshCatalog() {
  const now = Date.now();
  if (existsSync(CATALOG_PATH) && now - catalogFetchedAt < CATALOG_TTL_MS) return;
  if (now < catalogRetryAfter) return;
  if (catalogInFlight) return catalogInFlight;

  catalogInFlight = (async () => {
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
        writeFileAtomic(CATALOG_PATH, JSON.stringify(catalog));
        catalogFetchedAt = Date.now();
        catalogRetryAfter = 0;
      } else {
        catalogRetryAfter = Date.now() + CATALOG_RETRY_MS;
      }
    } catch (err) {
      catalogRetryAfter = Date.now() + CATALOG_RETRY_MS;
      console.error('[context-inspector] model catalog unavailable:', err.message);
    } finally {
      catalogInFlight = null;
    }
  })();

  return catalogInFlight;
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
    const quoted = process.platform === 'win32'
      ? `"${PLUGIN_ROOT.replace(/"/g, '`"')}"`
      : `'${PLUGIN_ROOT.replace(/'/g, "'\\''")}'`;
    return `git -C ${quoted} pull --ff-only`;
  }
  return process.platform === 'win32'
    ? `irm https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.ps1 | iex`
    : `curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.sh | bash`;
}

let updateCache = null;
let updateCheckedAt = 0;
let updateRetryAfter = 0;
let updateStatusInFlight = null;

async function getUpdateStatus(force = false) {
  const currentVersion = readLocalVersion();
  const isGitRepo = existsSync(join(PLUGIN_ROOT, '.git'));
  const defaultReleaseUrl = `https://github.com/${GITHUB_REPO}/releases`;
  const updateCommand = defaultUpdateCommand(isGitRepo);
  const fallback = {
    currentVersion,
    latestVersion: currentVersion,
    updateAvailable: false,
    isGitRepo,
    releaseUrl: defaultReleaseUrl,
    updateCommand,
  };

  const now = Date.now();
  if (!force && updateCache && now - updateCheckedAt < UPDATE_TTL_MS) {
    return {
      ...updateCache,
      currentVersion,
      isGitRepo,
      updateCommand,
      updateAvailable: compareSemver(updateCache.latestVersion, currentVersion) > 0,
    };
  }
  if (!force && now < updateRetryAfter) {
    return fallback;
  }
  if (updateStatusInFlight) {
    return updateStatusInFlight;
  }

  updateStatusInFlight = (async () => {
    try {
      let latestVersion = '';
      let releaseUrl = defaultReleaseUrl;
      try {
        const rel = await httpsGetJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
        latestVersion = String(rel.tag_name || '').replace(/^v/, '');
        if (typeof rel.html_url === 'string' && rel.html_url.startsWith('https://github.com/')) {
          releaseUrl = rel.html_url;
        }
      } catch {
        const manifest = await httpsGetJson(
          `https://raw.githubusercontent.com/${GITHUB_REPO}/main/plugin.json`,
        );
        latestVersion = String(manifest.version || '').replace(/^v/, '');
      }

      if (latestVersion) {
        updateCheckedAt = Date.now();
        updateRetryAfter = 0;
        updateCache = {
          ...fallback,
          latestVersion,
          releaseUrl,
          updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
        };
        return updateCache;
      }
    } catch {
      // Offline or repo not published yet — fail silently with short retry cooldown
    }

    updateRetryAfter = Date.now() + UPDATE_RETRY_MS;
    return fallback;
  })().finally(() => {
    updateStatusInFlight = null;
  });

  return updateStatusInFlight;
}

// --- Snapshot cache ----------------------------------------------------------

const snapshotCache = new Map();
const snapshotInFlight = new Map();
const snapshotSeq = new Map();

function workspacePath(uri) {
  if (typeof uri !== 'string' || !uri || uri.includes('\0')) return '';
  let p = uri;
  if (uri.startsWith('file:')) {
    try {
      const parsed = new URL(uri);
      if (parsed.hostname !== '' && parsed.hostname.toLowerCase() !== 'localhost') {
        return '';
      }
      p = fileURLToPath(parsed);
    } catch {
      return '';
    }
  }
  if (!p || p.includes('\0') || /^(\\\\|\/\/)/.test(p) || p.startsWith('-') || !isAbsolute(p)) {
    return '';
  }
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

function fileMtimeMs(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
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

function anySubagentModifiedSince(subIds, cutoffMs) {
  if (!subIds || !subIds.length) return false;
  return subIds.some((id) => {
    const p = join(CONVERSATIONS_DIR, `${id}.db`);
    return fileMtimeMs(p) >= cutoffMs || fileMtimeMs(`${p}-wal`) >= cutoffMs;
  });
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
        mcp_server: t.mcp_server || '',
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
  const swarmMembersPath = join(BRAIN_DIR, conversationId, '.system_generated', 'swarm', 'members.json');
  const baseKey = [
    fileStamp(db),
    fileStamp(`${db}-wal`),
    fileStamp(swarmMembersPath),
    ws,
    fileStamp(CATALOG_PATH),
  ].join('|');

  const cached = snapshotCache.get(conversationId);
  const hasRunningSub = Boolean(
    cached && (cached.snapshot.summary.subagents || []).some((sa) => sa.status === 'running'),
  );
  const runningExpired = hasRunningSub && (Date.now() - (cached.cachedAt || 0) >= RUNNING_SUBAGENT_TTL_MS);
  if (cached && !runningExpired && cached.baseKey === baseKey && cached.subStamp === subagentStamps(cached.subIds)) {
    snapshotCache.delete(conversationId);
    snapshotCache.set(conversationId, cached);
    return cached;
  }

  const inflightKey = `${conversationId}|${baseKey}`;
  if (snapshotInFlight.has(inflightKey)) {
    return snapshotInFlight.get(inflightKey);
  }

  const seq = (snapshotSeq.get(conversationId) || 0) + 1;
  snapshotSeq.set(conversationId, seq);
  const parseStartedAt = Date.now();
  const preSubStamp = cached ? subagentStamps(cached.subIds) : null;

  const task = (async () => {
    const { cmd, pre } = await findPython();
    const args = [...pre, SCRIPT, '--db', db, '--json'];
    if (existsSync(CATALOG_PATH)) args.push('--model-catalog', CATALOG_PATH);
    if (ws) args.push(`--workspace=${ws}`);

    const stdout = await execAsync(cmd, args);
    const snapshot = JSON.parse(stdout);
    const updatedAt = new Date().toISOString();
    const subIds = (snapshot.summary.subagents || []).map((sa) => sa.conversation_id);
    const postSubStamp = subagentStamps(subIds);
    const subStale = anySubagentModifiedSince(subIds, parseStartedAt - 1000)
      || (cached && preSubStamp !== postSubStamp);
    const entry = {
      baseKey,
      subIds,
      subStamp: subStale ? null : postSubStamp,
      cachedAt: Date.now(),
      snapshot,
      lightReport: buildLightReport(snapshot, updatedAt),
      updatedAt,
    };

    if (snapshotSeq.get(conversationId) === seq) {
      snapshotCache.delete(conversationId);
      snapshotCache.set(conversationId, entry);
      while (snapshotCache.size > MAX_CACHED_CONVS) {
        const oldestKey = snapshotCache.keys().next().value;
        snapshotCache.delete(oldestKey);
        const hasInFlight = [...snapshotInFlight.keys()].some((k) => k.startsWith(`${oldestKey}|`));
        if (!hasInFlight) snapshotSeq.delete(oldestKey);
      }
    }
    return entry;
  })().finally(() => {
    snapshotInFlight.delete(inflightKey);
  });

  snapshotInFlight.set(inflightKey, task);
  return task;
}

// --- Persisted user settings -------------------------------------------------

function parseThreshold(val) {
  if (typeof val === 'number' && Number.isFinite(val) && ALLOWED_THRESHOLDS.has(val)) {
    return val;
  }
  if (typeof val === 'string' && THRESHOLD_STR_RE.test(val)) {
    return Number(val);
  }
  return DEFAULT_SETTINGS.compactThreshold;
}

function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    compactThreshold: parseThreshold(src.compactThreshold),
    displayMode: src.displayMode === 'budget' ? 'budget' : 'native',
    compactAction: src.compactAction === 'copy' ? 'copy' : 'send',
  };
}

function loadSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return sanitizeSettings(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')));
    }
  } catch {
    // fallback to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(patch) {
  const cleanPatch = {};
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) cleanPatch[k] = v;
    }
  }
  const next = sanitizeSettings({ ...loadSettings(), ...cleanPatch });
  writeFileAtomic(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

// --- Static assets & API routes ----------------------------------------------

const staticAssetCache = new Map();
const APP_SCRIPT_PARTS = ['js/utils.js', 'js/sparkline.js', 'js/views.js', 'app.js'];

function serveStaticAsset(relPath, contentType) {
  const fullPath = join(PUBLIC_DIR, relPath);
  const stamp = fileStamp(fullPath);
  let entry = staticAssetCache.get(relPath);
  if (!entry || entry.stamp !== stamp) {
    const body = readFileSync(fullPath, 'utf8');
    entry = { stamp, body };
    staticAssetCache.set(relPath, entry);
  }
  return new Response(entry.body, { contentType });
}

function serveAppScript() {
  const fullPaths = APP_SCRIPT_PARTS.map((rel) => join(PUBLIC_DIR, rel));
  const stamp = fullPaths.map((p) => fileStamp(p)).join('|');
  let entry = staticAssetCache.get('__app_bundle__');
  if (!entry || entry.stamp !== stamp) {
    const parts = fullPaths.map((p) => readFileSync(p, 'utf8'));
    const body = `(() => {\n'use strict';\nconst __CI = {};\n${parts.join('\n')}\n})();\n`;
    entry = { stamp, body };
    staticAssetCache.set('__app_bundle__', entry);
  }
  return new Response(entry.body, { contentType: 'application/javascript; charset=utf-8' });
}

app.page('/', () => serveStaticAsset('index.html', 'text/html; charset=utf-8'));
app.page('/styles.css', () => serveStaticAsset('styles.css', 'text/css; charset=utf-8'));
app.page('/app.js', () => serveAppScript());

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
    return { item, fingerprint: entry.snapshot.summary.fingerprint };
  } catch (err) {
    return { error: 'failed', message: err.message };
  }
}, 'GET');

app.api('/api/settings', () => loadSettings(), 'GET');

app.api('/api/settings/save', (data) => {
  try {
    const patch = typeof data === 'string' ? JSON.parse(data) : (data || {});
    return saveSettings(patch);
  } catch (err) {
    return { error: 'invalid-settings', message: err.message };
  }
}, 'POST');

app.api('/api/update-status', async () => getUpdateStatus(false), 'GET');

let updateInFlight = null;

app.api('/api/update', async () => {
  const isGitRepo = existsSync(join(PLUGIN_ROOT, '.git'));
  if (!isGitRepo) {
    return {
      ok: false,
      error: 'not-git',
      updateCommand: defaultUpdateCommand(false),
    };
  }
  if (updateInFlight) {
    return updateInFlight;
  }
  updateInFlight = (async () => {
    try {
      const out = await execAsync('git', ['pull', '--ff-only'], {
        cwd: PLUGIN_ROOT,
        timeout: 30000,
        extraEnv: {
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      });
      updateCache = null;
      updateCheckedAt = 0;
      updateRetryAfter = 0;
      snapshotCache.clear();
      snapshotSeq.clear();
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
  })().finally(() => {
    updateInFlight = null;
  });
  return updateInFlight;
}, 'POST');

app.run();
refreshCatalog();
getUpdateStatus(false);
