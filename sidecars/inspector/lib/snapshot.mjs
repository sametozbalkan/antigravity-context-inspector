/**
 * Snapshot assembler and CLI formatter for Antigravity Context Inspector.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CATEGORIES,
  CHAT_START_CWM_FIELD,
  CHAT_START_FIELD,
  CWM_BREAKDOWN_FIELD,
  GEN_CHAT_FIELD,
  collectStats,
  detectSystemFiles,
  extractModelId,
  extractModelName,
  extractRequestBudget,
  fmtTok,
  gridSegments,
  inferContextLimit,
  loadDbWithHistory,
  pct,
  round1,
  statsHeading,
} from './accounting.mjs';
import { extractContentItems } from './content.mjs';
import { extractSubagents } from './subagents.mjs';

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function parseIntOrZero(val) {
  if (val == null || val === '' || typeof val === 'boolean') return 0;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? Math.trunc(val) : 0;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      const n = Number.parseInt(trimmed, 10);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

export function renderCliText(report) {
  const limitStr = report.limit_tokens ? fmtTok(report.limit_tokens) : 'Unknown';
  const lines = [
    `${report.model} · ${fmtTok(report.used_tokens)}/${limitStr} tokens (${report.used_pct.toFixed(1)}%)`,
    report.heading,
  ];
  if (report.request_budget_tokens) {
    lines.push(
      `Request budget: ${fmtTok(report.used_tokens)}/${fmtTok(report.request_budget_tokens)} (${report.budget_pct.toFixed(1)}%)`,
    );
  }
  lines.push('');
  for (const c of report.categories) {
    lines.push(
      `  ${c.name.padEnd(20)} ${fmtTok(c.tokens).padStart(8)} (${c.pct.toFixed(1).padStart(5)}%)`,
    );
  }
  const freePct = pct(report.free_tokens, report.limit_tokens);
  lines.push(
    `  ${'Free space'.padEnd(20)} ${fmtTok(report.free_tokens).padStart(8)} (${freePct.toFixed(1).padStart(5)}%)`,
  );
  if (report.checkpoint_buffer) {
    lines.push(
      `  ${'Checkpoint buffer'.padEnd(20)} ${fmtTok(report.checkpoint_buffer).padStart(8)} (excluded)`,
    );
  }
  if (report.subagents && report.subagents.length > 0) {
    lines.push('');
    lines.push(`Subagents (${report.subagents.length}):`);
    for (const sa of report.subagents) {
      lines.push(
        `  - ${sa.role} (${sa.model}): ${fmtTok(sa.used_tokens)} tokens [${sa.status}]`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Deterministic JSON serializer with sorted object keys for snapshot fingerprinting.
 */
export function stableStringify(val) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  const keys = Object.keys(val).sort();
  const parts = [];
  for (const k of keys) {
    if (val[k] === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(k)}:${stableStringify(val[k])}`);
  }
  return `{${parts.join(',')}}`;
}

export function buildSnapshot(
  dbPath,
  workspace = null,
  catalogPath = null,
  appDir = 'antigravity',
) {
  const {
    steps,
    latestStats: statsGen,
    latestContent: contentGen,
    history,
    sessionUsage,
  } = loadDbWithHistory(dbPath);

  let catalog = {};
  let catalogEntry = {};
  const mid = extractModelId(statsGen);
  if (catalogPath && isFile(catalogPath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      if (isPlainObject(loaded)) {
        catalog = loaded;
        const entry = catalog[mid];
        if (isPlainObject(entry)) {
          catalogEntry = entry;
        }
      }
    } catch {
      catalog = {};
      catalogEntry = {};
    }
  }

  const catLimit = parseIntOrZero(catalogEntry.maxTokens);
  const limit = catLimit > 0 ? catLimit : inferContextLimit(statsGen);
  const displayName = catalogEntry.displayName;
  const model =
    typeof displayName === 'string' && displayName ? displayName : extractModelName(statsGen);
  const budget = extractRequestBudget(statsGen);

  const { st, breakdown } = collectStats(steps, statsGen, limit);
  let contentBreakdown = breakdown;
  if (contentGen != null && contentGen !== statsGen) {
    const cChat = contentGen.msg(GEN_CHAT_FIELD);
    const cStart = cChat != null ? cChat.msg(CHAT_START_FIELD) : null;
    const cCwm = cStart != null ? cStart.msg(CHAT_START_CWM_FIELD) : null;
    contentBreakdown = cCwm != null ? cCwm.msg(CWM_BREAKDOWN_FIELD) : breakdown;
  }

  const content = extractContentItems(steps, contentGen, contentBreakdown, st.total);
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || null;
  const systemFiles = detectSystemFiles(os.homedir(), workspace, appDir, geminiDir);
  const subagents = extractSubagents(steps, dbPath, catalog);

  const categoriesOut = [];
  for (const cat of CATEGORIES) {
    const [name, key, always, grp] = Array.isArray(cat)
      ? cat
      : [cat.name, cat.key, cat.always, cat.group];
    if (always || st[key]) {
      categoriesOut.push({
        name,
        key,
        group: grp,
        tokens: st[key],
        pct: round1(pct(st[key], limit)),
      });
    }
  }

  const used = st.total;
  const summary = {
    conversation_id: path.parse(dbPath).name,
    model,
    model_id: mid,
    heading: statsHeading(st),
    used_tokens: used,
    limit_tokens: limit,
    used_pct: limit ? round1(Math.min(100.0, pct(used, limit))) : 0.0,
    free_tokens: limit ? Math.max(0, limit - used) : 0,
    request_budget_tokens: budget,
    budget_pct: budget ? round1(Math.min(100.0, pct(used, budget))) : 0.0,
    has_breakdown: st.has_breakdown,
    compacted: st.compacted,
    checkpoint_buffer: st.checkpoint,
    active_checkpoint: st.active_checkpoint,
    checkpoints: st.checkpoints,
    grid_segments: gridSegments(st),
    categories: categoriesOut,
    api_usage: st.api_usage,
    history,
    session_usage: sessionUsage,
    knowledge_files: st.knowledge_files,
    artifact_files: st.artifact_files,
    skill_files: st.skill_files,
    system_files: systemFiles,
    subagents,
    counts: {
      system_sections: content.system_sections.length,
      tools: content.tools.length,
      messages: content.messages.length,
      subagents: subagents.length,
    },
    has_full_content: contentGen != null,
  };
  summary.cli_text = renderCliText(summary);

  const fpSrc = stableStringify([
    summary.used_tokens,
    summary.limit_tokens,
    summary.request_budget_tokens,
    summary.model,
    summary.has_breakdown,
    summary.compacted,
    summary.checkpoint_buffer,
    summary.checkpoints,
    categoriesOut.map((c) => [c.key, c.tokens]),
    summary.api_usage,
    history.length,
    history.length > 0 ? history[history.length - 1].tokens : 0,
    sessionUsage,
    summary.counts,
    steps.length,
    st.active_checkpoint,
    summary.system_files,
    summary.skill_files,
    summary.artifact_files,
    summary.knowledge_files,
    subagents.map((sa) => [
      sa.conversation_id,
      sa.role,
      sa.model,
      sa.used_tokens,
      sa.limit_tokens,
      sa.request_budget_tokens,
      sa.status,
      sa.swarm_state ?? null,
      sa.source ?? null,
    ]),
  ]);
  summary.fingerprint = crypto
    .createHash('sha1')
    .update(fpSrc, 'utf8')
    .digest('hex')
    .slice(0, 12);

  return {
    summary,
    content,
  };
}
