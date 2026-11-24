/**
 * Pure helpers for the sidecar HTTP server (`main.mjs`).
 *
 * Kept free of `sidecar_sdk` and module state so they can be unit tested outside
 * Antigravity; `main.mjs` itself only loads inside the host.
 */

import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SETTINGS = {
  compactThreshold: 60,
  displayMode: 'native',
  compactAction: 'send',
};
const ALLOWED_THRESHOLDS = new Set([0, 50, 60, 75]);
const THRESHOLD_STR_RE = /^(0|50|60|75)$/;

// --- Version comparison ------------------------------------------------------

export function compareSemver(a, b) {
  const pa = String(a || '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// --- Workspace URI validation ------------------------------------------------

/**
 * Local absolute folder path for a workspace URI or path, or '' when it is anything
 * else (remote host, UNC share, relative path, CLI-flag lookalike, NUL byte).
 */
export function workspacePath(uri) {
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

// --- Light report (payload of GET /api/report) -------------------------------

/**
 * Summary plus a body-less item index. Full item bodies stay in the snapshot cache
 * and are served one at a time by GET /api/item.
 */
export function buildLightReport(snapshot, updatedAt) {
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
        category: m.category,
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

// --- Persisted user settings -------------------------------------------------

export function parseThreshold(val) {
  if (typeof val === 'number' && Number.isFinite(val) && ALLOWED_THRESHOLDS.has(val)) {
    return val;
  }
  if (typeof val === 'string' && THRESHOLD_STR_RE.test(val)) {
    return Number(val);
  }
  return DEFAULT_SETTINGS.compactThreshold;
}

export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    compactThreshold: parseThreshold(src.compactThreshold),
    displayMode: src.displayMode === 'budget' ? 'budget' : 'native',
    compactAction: src.compactAction === 'copy' ? 'copy' : 'send',
  };
}

/**
 * Apply a settings patch to the current settings and sanitize the result.
 * Undefined values and non-object patches are ignored.
 */
export function mergeSettings(current, patch) {
  const cleanPatch = {};
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) cleanPatch[k] = v;
    }
  }
  return sanitizeSettings({ ...current, ...cleanPatch });
}
