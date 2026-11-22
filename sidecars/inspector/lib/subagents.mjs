/**
 * Subagent (invoke_subagent) and Swarm worker discovery and stats.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CHAT_START_CHECKPOINT_FIELD,
  CHAT_START_CWM_FIELD,
  CHAT_START_FIELD,
  CHECKPOINT_INDEX_FIELD,
  CONV_ID_JSON_RE,
  CWM_BREAKDOWN_FIELD,
  GEN_CHAT_FIELD,
  MD_TOOL_CALL_FIELD,
  STATUS_DONE,
  STEP_CHECKPOINT,
  STEP_ENVELOPE_FIELDS,
  STEP_GENERIC,
  STEP_STATUS_ACTIVE,
  STEP_TYPE_CHECKPOINT,
  STEP_TYPE_ERROR_MESSAGE,
  STEP_TYPE_FINISH,
  STEP_TYPE_INVOKE_SUBAGENT,
  STEP_TYPE_PLANNER_RESPONSE,
  UUID_FIND_RE,
  Step,
  collectStats,
  extractModelId,
  extractModelName,
  extractRequestBudget,
  inferContextLimit,
  openSqliteReadOnly,
  pct,
  round1,
} from './accounting.mjs';
import { Msg, UTF8_DECODER } from './protobuf.mjs';

export const TERMINAL_STEP_TYPES = new Set([
  STEP_TYPE_FINISH,
  STEP_TYPE_PLANNER_RESPONSE,
  STEP_TYPE_ERROR_MESSAGE,
]);

export const SUBAGENT_THINKING_WINDOW_SEC = 180.0;

const ENVELOPE_FIELD_SET = new Set(STEP_ENVELOPE_FIELDS);

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

function globalRegex(re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

function nonGlobalRegex(re) {
  return new RegExp(re.source, re.flags.replace(/g/g, ''));
}

function recentDbMtime(dbPath) {
  let mtime = 0.0;
  for (const cand of [dbPath, `${dbPath}-wal`]) {
    try {
      const st = fs.statSync(cand);
      const sec = st.mtimeMs / 1000;
      if (sec > mtime) {
        mtime = sec;
      }
    } catch {
      // ignore missing/unreadable files
    }
  }
  return mtime;
}

/**
 * Fast read-only summary for a subagent conversation database.
 */
export function quickSubagentStats(subDb, catalog) {
  if (!isFile(subDb)) {
    return null;
  }

  let lastStep;
  let hasActiveStep = false;
  let gen = null;
  let stepRows = [];

  try {
    const con = openSqliteReadOnly(subDb, 1500);
    let began = false;
    try {
      con.exec('BEGIN');
      began = true;

      lastStep = con
        .prepare('SELECT idx, step_type, status FROM steps ORDER BY idx DESC LIMIT 1')
        .get();

      hasActiveStep = Boolean(
        con
          .prepare('SELECT 1 FROM steps WHERE status IN (?, ?) LIMIT 1')
          .get(...STEP_STATUS_ACTIVE),
      );

      const genRows = con
        .prepare('SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT 5')
        .all();

      for (const row of genRows) {
        const data = row.data;
        if (!(data instanceof Uint8Array) || data.byteLength === 0) {
          continue;
        }
        const cand = new Msg(data);
        if (cand.msg(GEN_CHAT_FIELD) != null) {
          gen = cand;
          break;
        }
      }

      const chat = gen != null ? gen.msg(GEN_CHAT_FIELD) : null;
      const chatStart = chat != null ? chat.msg(CHAT_START_FIELD) : null;
      const cwm = chatStart != null ? chatStart.msg(CHAT_START_CWM_FIELD) : null;
      const hasBreakdown = cwm != null && cwm.msg(CWM_BREAKDOWN_FIELD) != null;

      if (gen == null || !hasBreakdown) {
        stepRows = con
          .prepare(
            'SELECT idx, step_payload, step_type, status, metadata FROM steps ORDER BY idx ASC',
          )
          .all();
      } else {
        const genCk =
          chatStart != null
            ? chatStart.int(CHAT_START_CHECKPOINT_FIELD, { signed32: true })
            : -1;
        const ckRow = con
          .prepare(
            'SELECT idx, step_payload, step_type, status, metadata FROM steps ' +
              'WHERE step_type = ? AND status = ? ORDER BY idx DESC LIMIT 1',
          )
          .get(STEP_TYPE_CHECKPOINT, STATUS_DONE);
        if (ckRow != null) {
          const ckStep = new Step(
            ckRow.idx,
            ckRow.step_payload,
            ckRow.step_type,
            ckRow.status,
            ckRow.metadata,
          );
          const ckPayload = ckStep.payload(STEP_CHECKPOINT);
          if (ckPayload != null && ckPayload.int(CHECKPOINT_INDEX_FIELD) > genCk) {
            stepRows = con
              .prepare(
                'SELECT idx, step_payload, step_type, status, metadata FROM steps ' +
                  'WHERE idx >= ? ORDER BY idx ASC',
              )
              .all(ckRow.idx);
          }
        }
      }
    } finally {
      if (began) {
        try {
          con.exec('ROLLBACK');
        } catch {
          // ignore rollback error on closed/failed handle
        }
      }
      con.close();
    }
  } catch {
    return null;
  }

  const steps = stepRows.map(
    (r) => new Step(r.idx, r.step_payload, r.step_type, r.status, r.metadata),
  );
  const mid = extractModelId(gen);
  const rawEntry = isPlainObject(catalog) ? catalog[mid] : null;
  const catEntry = isPlainObject(rawEntry) ? rawEntry : {};
  const catLimit = parseIntOrZero(catEntry.maxTokens);
  const limit = catLimit > 0 ? catLimit : inferContextLimit(gen);
  const displayName = catEntry.displayName;
  const model =
    typeof displayName === 'string' && displayName ? displayName : extractModelName(gen);
  const budget = extractRequestBudget(gen);
  const { st } = collectStats(steps, gen, limit);
  const used = st.total;

  let status;
  if (lastStep == null) {
    status = 'starting';
  } else if (hasActiveStep) {
    status = 'running';
  } else if (
    !TERMINAL_STEP_TYPES.has(lastStep.step_type) &&
    Date.now() / 1000 - recentDbMtime(subDb) <= SUBAGENT_THINKING_WINDOW_SEC
  ) {
    status = 'running';
  } else {
    status = 'idle';
  }

  return {
    model,
    model_id: mid,
    used_tokens: used,
    limit_tokens: limit,
    used_pct: limit ? round1(Math.min(100.0, pct(used, limit))) : 0.0,
    request_budget_tokens: budget,
    budget_pct: budget ? round1(Math.min(100.0, pct(used, budget))) : 0.0,
    status,
  };
}

/**
 * Extract spawned subagent conversation UUID from generic or native step payloads.
 */
export function extractSubagentId(step, selfId) {
  const candidates = [];
  if (step.genericResultText) {
    candidates.push(step.genericResultText);
  }
  const generic = step.pb.msg(STEP_GENERIC);
  if (generic != null) {
    const res = generic.msg(2);
    if (res != null) {
      const text = res.str(1);
      if (text) {
        candidates.push(text);
      }
    }
  }

  if (candidates.length === 0) {
    for (const [fn, vals] of step.pb.fields.entries()) {
      if (ENVELOPE_FIELD_SET.has(fn)) {
        continue;
      }
      for (const v of vals) {
        if (v instanceof Uint8Array) {
          const decoded = UTF8_DECODER.decode(v);
          if (decoded) {
            candidates.push(decoded);
          }
        }
      }
    }
  }

  const convRe = globalRegex(CONV_ID_JSON_RE);
  for (const text of candidates) {
    for (const m of text.matchAll(convRe)) {
      const cid = m[1].toLowerCase();
      if (cid !== selfId) {
        return cid;
      }
    }
  }

  const uuidRe = globalRegex(UUID_FIND_RE);
  for (const text of candidates) {
    for (const m of text.matchAll(uuidRe)) {
      const cid = m[0].toLowerCase();
      if (cid !== selfId) {
        return cid;
      }
    }
  }

  return '';
}

/**
 * Normalize Swarm members.json shapes (list, dict, or {members: ...}) into [rosterName, obj].
 */
function iterSwarmMemberEntries(raw) {
  let target = raw;
  if (isPlainObject(target) && Object.hasOwn(target, 'members')) {
    target = target.members;
  }
  const entries = [];
  if (Array.isArray(target)) {
    for (const item of target) {
      if (isPlainObject(item)) {
        const name = String(item.name || item.roster_name || item.role || '');
        entries.push([name, item]);
      }
    }
  } else if (isPlainObject(target)) {
    for (const [key, item] of Object.entries(target)) {
      if (isPlainObject(item)) {
        const name = String(item.name || item.roster_name || item.role || key);
        entries.push([name, item]);
      }
    }
  }
  return entries;
}

/**
 * Read Swarm workers from <appData>/brain/<convId>/.system_generated/swarm/members.json.
 */
function loadSwarmMembers(dbPath) {
  const resolved = path.resolve(dbPath);
  const stem = path.parse(resolved).name;
  const membersPath = path.join(
    path.dirname(path.dirname(resolved)),
    'brain',
    stem,
    '.system_generated',
    'swarm',
    'members.json',
  );
  if (!isFile(membersPath)) {
    return [];
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(membersPath, 'utf8'));
  } catch {
    return [];
  }

  const uuidSearchRe = nonGlobalRegex(UUID_FIND_RE);
  const out = [];
  for (const [name, item] of iterSwarmMemberEntries(raw)) {
    const cidRaw = String(
      item.conversation_id || item.conversationId || item.conv_id || item.id || '',
    ).trim();
    const m = uuidSearchRe.exec(cidRaw);
    if (!m) {
      continue;
    }
    const state = String(item.state || item.status || '')
      .trim()
      .toLowerCase();
    const model = String(
      item.model_display_name ||
        item.modelDisplayName ||
        item.model ||
        item.model_id ||
        '',
    ).trim();
    out.push({
      conversation_id: m[0].toLowerCase(),
      role: name || 'worker',
      model,
      state,
    });
  }
  return out;
}

/**
 * Discover child subagents (invoke_subagent) and Swarm workers (members.json).
 */
export function extractSubagents(steps, dbPath, catalog) {
  const convDir = path.dirname(dbPath);
  const selfId = path.parse(dbPath).name.toLowerCase();
  const seen = new Set();
  const out = [];

  for (const step of steps) {
    const tc = step.md.msg(MD_TOOL_CALL_FIELD);
    const tcName = tc != null ? tc.str(2) : '';
    if (tcName !== 'invoke_subagent' && step.type !== STEP_TYPE_INVOKE_SUBAGENT) {
      continue;
    }

    let role = '';
    let typeName = '';
    let reqModel = '';
    if (tc != null) {
      const argsRaw = tc.str(3);
      if (argsRaw) {
        try {
          const args = JSON.parse(argsRaw);
          if (isPlainObject(args)) {
            role = String(args.Role || args.role || '');
            typeName = String(args.TypeName || args.type_name || '');
            reqModel = String(args.Model || args.model || '');
          }
        } catch {
          // ignore invalid JSON tool call args
        }
      }
    }

    const subId = extractSubagentId(step, selfId);
    if (!subId || subId === selfId || seen.has(subId)) {
      continue;
    }
    seen.add(subId);

    const stats = quickSubagentStats(path.join(convDir, `${subId}.db`), catalog);
    out.push({
      conversation_id: subId,
      source: 'subagent',
      role: role || typeName || `Subagent ${out.length + 1}`,
      type_name: typeName,
      requested_model: reqModel,
      model: stats ? stats.model : reqModel || 'Pending',
      used_tokens: stats ? stats.used_tokens : 0,
      limit_tokens: stats ? stats.limit_tokens : 0,
      used_pct: stats ? stats.used_pct : 0.0,
      request_budget_tokens: stats ? stats.request_budget_tokens : 0,
      budget_pct: stats ? stats.budget_pct : 0.0,
      status: stats ? stats.status : 'starting',
      has_db: stats !== null,
    });
  }

  for (const member of loadSwarmMembers(dbPath)) {
    const subId = member.conversation_id;
    if (!subId || subId === selfId || seen.has(subId)) {
      continue;
    }
    seen.add(subId);

    const stats = quickSubagentStats(path.join(convDir, `${subId}.db`), catalog);
    const rawState = member.state;
    let status;
    if (rawState === 'killed') {
      status = 'killed';
    } else if (rawState === 'working' || rawState === 'running') {
      status = 'running';
    } else if (rawState === 'waiting' || rawState === 'idle' || rawState === 'stopped') {
      status = rawState;
    } else {
      status = stats ? stats.status : 'starting';
    }

    out.push({
      conversation_id: subId,
      source: 'swarm',
      role: member.role,
      type_name: 'swarm',
      requested_model: member.model,
      model: stats ? stats.model : member.model || 'Pending',
      used_tokens: stats ? stats.used_tokens : 0,
      limit_tokens: stats ? stats.limit_tokens : 0,
      used_pct: stats ? stats.used_pct : 0.0,
      request_budget_tokens: stats ? stats.request_budget_tokens : 0,
      budget_pct: stats ? stats.budget_pct : 0.0,
      status,
      swarm_state: rawState,
      has_db: stats !== null,
    });
  }

  return out;
}
