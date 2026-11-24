/**
 * Token accounting, step decoding, and file detection.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Msg, encodeVarint, iterFields, utf8ByteLength } from './protobuf.mjs';

// --- Wire & enum constants ---------------------------------------------------

// Step payload field numbers on gemini_coder.Step
export const STEP_CODE_ACTION = 10;
export const STEP_VIEW_FILE = 14;
export const STEP_USER_INPUT = 19;
export const STEP_PLANNER_RESPONSE = 20;
export const STEP_CHECKPOINT = 30;
export const STEP_GENERIC = 140;

// Step envelope field numbers
export const STEP_FIELD_TYPE = 1;
export const STEP_FIELD_STATUS = 4;
export const STEP_FIELD_METADATA = 5;
export const STEP_ENVELOPE_FIELDS = new Set([
  STEP_FIELD_TYPE,
  STEP_FIELD_STATUS,
  STEP_FIELD_METADATA,
]);

// Step type enum values
export const STEP_TYPE_UNSPECIFIED = 0;
export const STEP_TYPE_FINISH = 2;
export const STEP_TYPE_VIEW_FILE = 8;
export const STEP_TYPE_USER_INPUT = 14;
export const STEP_TYPE_PLANNER_RESPONSE = 15;
export const STEP_TYPE_ERROR_MESSAGE = 17;
export const STEP_TYPE_CHECKPOINT = 23;
export const STEP_TYPE_SYSTEM_MESSAGE = 101;
export const STEP_TYPE_INVOKE_SUBAGENT = 127;
export const GENERIC_TYPE = 132;

// Step status enum values
export const STATUS_PENDING = 1;
export const STATUS_RUNNING = 2;
export const STATUS_DONE = 3;
export const STEP_STATUS_ACTIVE = [STATUS_PENDING, STATUS_RUNNING];

export const ORIGINAL_STEP_TYPE_URL = '/gemini_coder.Step';

// Step payload & metadata field numbers
export const CODE_ACTION_RESULT_FIELD = 2;
export const CODE_ACTION_EDIT_FIELD = 1;
export const CODE_ACTION_EDIT_URI_FIELD = 8;
export const CODE_ACTION_IS_ARTIFACT_FIELD = 21;
export const CODE_ACTION_IS_KNOWLEDGE_FIELD = 24;
export const VIEW_FILE_PATH_FIELD = 1;
export const VIEW_FILE_IS_SKILL_FIELD = 17;

export const MD_TOOL_CALL_FIELD = 4;
export const MD_USAGE_FIELD = 9;
export const MD_OUTPUT_TOKENS_FIELD = 23;
export const MD_RETRY_INFO_FIELD = 28;

export const CHECKPOINT_INDEX_FIELD = 1;
export const CHECKPOINT_SUMMARY_ALT_FIELD = 3;
export const CHECKPOINT_INTENT_FIELD = 4;
export const CHECKPOINT_START_FIELD = 11;
export const CHECKPOINT_END_FIELD = 12;

// GenMetadata / Chat / Usage / ContextWindowMetadata field numbers
export const GEN_CHAT_FIELD = 1;
export const CHAT_SYSTEM_PROMPT_FIELD = 1;
export const CHAT_MESSAGES_FIELD = 2;
export const CHAT_USAGE_FIELD = 4;
export const CHAT_TOOLS_FIELD = 8;
export const CHAT_START_FIELD = 9;
export const CHAT_MODEL_ID_ALT_FIELD = 11;
export const CHAT_SYSTEM_SECTIONS_FIELD = 16;
export const CHAT_MODEL_ID_FIELD = 19;
export const CHAT_MODEL_NAME_FIELD = 21;

export const USAGE_UNCACHED_INPUT_FIELD = 2;
export const USAGE_OUTPUT_FIELD = 3;
export const USAGE_CACHED_INPUT_FIELD = 5;
export const USAGE_THINKING_FIELD = 9;
export const USAGE_RESPONSE_FIELD = 10;

export const CHAT_START_CHECKPOINT_FIELD = 2;
export const CHAT_START_CWM_FIELD = 10;
export const CWM_BREAKDOWN_FIELD = 3;
export const CWM_REQUEST_BUDGET_FIELD = 4;

const GEN_CHAT_FIELDS = new Set([GEN_CHAT_FIELD]);
const CHAT_CONTENT_FIELDS = new Set([
  CHAT_SYSTEM_PROMPT_FIELD,
  CHAT_MESSAGES_FIELD,
  CHAT_TOOLS_FIELD,
  CHAT_SYSTEM_SECTIONS_FIELD,
]);
const CHAT_SCAN_FIELDS = new Set([
  ...CHAT_CONTENT_FIELDS,
  CHAT_USAGE_FIELD,
  CHAT_START_FIELD,
]);
const CHAT_TELEMETRY_FIELDS = new Set([CHAT_USAGE_FIELD, CHAT_START_FIELD]);
const USAGE_TELEMETRY_FIELDS = new Set([
  USAGE_UNCACHED_INPUT_FIELD,
  USAGE_OUTPUT_FIELD,
  USAGE_CACHED_INPUT_FIELD,
  USAGE_THINKING_FIELD,
]);
const CHAT_START_CHECKPOINT_FIELDS = new Set([CHAT_START_CHECKPOINT_FIELD]);

export const TOKEN_SYSTEM_PROMPT = 1;
export const TOKEN_TOOLS = 2;
export const TOKEN_RULES = 3;
export const TOKEN_MCP_TOOLS = 4;
export const TOKEN_SKILLS = 5;
export const TOKEN_SUBAGENTS = 6;
export const TOKEN_CHAT_MESSAGES = 7;
export const TOKEN_WORKFLOWS = 8;
export const TOKEN_PLUGINS = 9;
export const TOKEN_FLOWS = 10;

export const SYSTEM_PROMPT_SUBGROUPS = {
  flows: TOKEN_FLOWS,
  skills: TOKEN_SKILLS,
  subagents: TOKEN_SUBAGENTS,
};

// Breakdown group types this parser understands. Any other type (e.g. 0 "Unspecified",
// which carries the Identity section) is treated as TOKEN_SYSTEM_PROMPT by both
// accounting.mjs and content.mjs, so its tokens stay in the total and the drill-down.
export const KNOWN_GROUP_TYPES = new Set([
  TOKEN_SYSTEM_PROMPT,
  TOKEN_TOOLS,
  TOKEN_RULES,
  TOKEN_MCP_TOOLS,
  TOKEN_SKILLS,
  TOKEN_SUBAGENTS,
  TOKEN_CHAT_MESSAGES,
  TOKEN_WORKFLOWS,
  TOKEN_PLUGINS,
  TOKEN_FLOWS,
]);

export const GROUP_LABELS = {
  [TOKEN_SYSTEM_PROMPT]: 'System prompt',
  [TOKEN_TOOLS]: 'System tools',
  [TOKEN_RULES]: 'Rules',
  [TOKEN_MCP_TOOLS]: 'MCP tools',
  [TOKEN_SKILLS]: 'Skills',
  [TOKEN_SUBAGENTS]: 'Subagents',
  [TOKEN_CHAT_MESSAGES]: 'Chat messages',
  [TOKEN_WORKFLOWS]: 'Legacy workflows',
  [TOKEN_PLUGINS]: 'Plugins',
  [TOKEN_FLOWS]: 'Workflows',
};

export const STEP_TYPES = {
  UNSPECIFIED: 0, DUMMY: 1, FINISH: 2, PLAN_INPUT: 3, MQUERY: 4, CODE_ACTION: 5,
  GIT_COMMIT: 6, GREP_SEARCH: 7, VIEW_FILE: 8, LIST_DIRECTORY: 9, COMPILE: 10,
  VIEW_CODE_ITEM: 13, USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17,
  RUN_COMMAND: 21, CHECKPOINT: 23, PROPOSE_CODE: 24, FIND: 25, SUGGESTED_RESPONSES: 27,
  COMMAND_STATUS: 28, MEMORY: 29, READ_URL_CONTENT: 31, VIEW_CONTENT_CHUNK: 32,
  SEARCH_WEB: 33, RETRIEVE_MEMORY: 34, MCP_TOOL: 38, MANAGER_FEEDBACK: 39,
  TOOL_CALL_PROPOSAL: 40, TOOL_CALL_CHOICE: 41, TRAJECTORY_CHOICE: 42, CLIPBOARD: 45,
  VIEW_FILE_OUTLINE: 47, POST_PR_REVIEW: 49, LIST_RESOURCES: 51, READ_RESOURCE: 52,
  LINT_DIFF: 53, FIND_ALL_REFERENCES: 54, BRAIN_UPDATE: 55, OPEN_BROWSER_URL: 56,
  RUN_EXTENSION_CODE: 57, PROPOSAL_FEEDBACK: 59, TRAJECTORY_SEARCH: 60,
  EXECUTE_BROWSER_JAVASCRIPT: 61, LIST_BROWSER_PAGES: 62, CAPTURE_BROWSER_SCREENSHOT: 63,
  CLICK_BROWSER_PIXEL: 64, READ_TERMINAL: 65, CAPTURE_BROWSER_CONSOLE_LOGS: 66,
  READ_BROWSER_PAGE: 67, BROWSER_GET_DOM: 68, CODE_SEARCH: 73, BROWSER_INPUT: 74,
  BROWSER_MOVE_MOUSE: 75, BROWSER_SELECT_OPTION: 76, BROWSER_SCROLL_UP: 77,
  BROWSER_SCROLL_DOWN: 78, BROWSER_CLICK_ELEMENT: 79, BROWSER_PRESS_KEY: 80,
  TASK_BOUNDARY: 81, NOTIFY_USER: 82, CODE_ACKNOWLEDGEMENT: 83, INTERNAL_SEARCH: 84,
  BROWSER_SUBAGENT: 85, FILE_CHANGE: 86, MOVE: 87, BROWSER_SCROLL: 88,
  KNOWLEDGE_GENERATION: 89, EPHEMERAL_MESSAGE: 90, GENERATE_IMAGE: 91,
  DELETE_DIRECTORY: 92, COMPILE_APPLET: 93, INSTALL_APPLET_DEPENDENCIES: 94,
  INSTALL_APPLET_PACKAGE: 95, BROWSER_RESIZE_WINDOW: 96, BROWSER_DRAG_PIXEL_TO_PIXEL: 97,
  CONVERSATION_HISTORY: 98, KNOWLEDGE_ARTIFACTS: 99, SEND_COMMAND_INPUT: 100,
  SYSTEM_MESSAGE: 101, WAIT: 102, AGENCY_TOOL_CALL: 103, CIDER_AGENT_DUMMY: 104,
  SHELL_EXEC: 112, INVOKE_SUBAGENT: 127, GENERIC: 132, ASK_QUESTION: 138,
  DIRECTORY_RULES: 139, TOOL_SEARCH: 140,
};

export const STEP_TYPE_NAMES = Object.fromEntries(
  Object.entries(STEP_TYPES).map(([k, v]) => [v, k]),
);

export const CAT_USER = 0;
export const CAT_AGENT = 1;
export const CAT_TOOL = 2;
export const CAT_CHECKPOINT = 3;
export const CAT_SYSTEM = 4;

// Conversation category row keys, in the order chatTokensByCategory() reports them.
export const CHAT_CATEGORY_KEYS = ['user', 'agent', 'tool', 'system_messages'];

export const NATIVE_CONTEXT_WINDOWS = [
  ['gemini', 1_048_576],
  ['claude-sonnet-5', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-5', 1_000_000],
  ['claude-sonnet-4', 250_000],
  ['claude-opus-4', 250_000],
  ['claude-4', 250_000],
  ['claude', 200_000],
  ['gpt-oss', 131_072],
  ['gpt-4', 128_000],
  ['o3', 200_000],
  ['o4', 200_000],
];

export const CATEGORIES = [
  ['User messages', 'user', true, 'conv'],
  ['Agent responses', 'agent', true, 'conv'],
  ['Tool calls', 'tool', true, 'conv'],
  ['System prompt', 'system_prompt', false, 'sys'],
  ['System tools', 'system_tools', false, 'sys'],
  ['System overhead', 'system_overhead', false, 'sys'],
  ['Rules', 'rules', false, 'custom'],
  ['Skills', 'skills', false, 'custom'],
  ['Subagents', 'subagents', false, 'custom'],
  ['Legacy workflows', 'legacy_workflows', false, 'custom'],
  ['Workflows', 'workflows', false, 'custom'],
  ['Plugins', 'plugins', false, 'custom'],
  ['MCP tools', 'mcp_tools', false, 'custom'],
  ['System messages', 'system_messages', false, 'conv'],
];

export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UUID_FIND_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const CONV_ID_JSON_RE = new RegExp(`"conversationId"\\s*:\\s*"(${UUID_PATTERN})"`, 'i');

export const MAX_HISTORY_POINTS = 120;

const INT_LABEL_RE = /^[+-]?[0-9]+$/;
const MESSAGE_LABEL_RE = /^Message ([0-9]+) \(CHAT_MESSAGE_SOURCE_([A-Z0-9_]+)\)$/;
// Source names used by "Message <n> (CHAT_MESSAGE_SOURCE_<NAME>)" labels.
// SYSTEM is the model's own turn (role 2, "assistant" in content.mjs).
const MESSAGE_SOURCE_CATS = { USER: CAT_USER, SYSTEM: CAT_AGENT, TOOL: CAT_TOOL };

// --- Formatting helpers ------------------------------------------------------

export function round1(n) {
  return Math.round(n * 10) / 10 + 0;
}

export function fmtTok(n) {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return Number.isInteger(v) ? `${v.toFixed(0)}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

export function pct(n, denom) {
  return denom > 0 ? (n / denom) * 100.0 : 0.0;
}

function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%[0-9a-fA-F]{2}/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
}

const WINDOWS_DRIVE_RE = /^[A-Za-z]:(\/|$)/;

/**
 * Whether forward-slash path `p` is `home` or lies inside it. A drive-letter home is
 * compared ignoring case: Windows paths are case-insensitive, and Antigravity stores
 * most of them with a lowercase drive letter (c:/Users/...) while os.homedir()
 * reports C:\Users\...
 */
function isUnderHome(p, home) {
  if (p.length !== home.length && p[home.length] !== '/') {
    return false;
  }
  const head = p.slice(0, home.length);
  return WINDOWS_DRIVE_RE.test(home) ? head.toLowerCase() === home.toLowerCase() : head === home;
}

/**
 * Key under which two spellings of the same shortened path count as one file
 * (Windows paths differing only in case).
 */
export function pathDedupeKey(shortPath, home = os.homedir()) {
  const homeDir = String(home ?? '').replace(/\\/g, '/');
  return WINDOWS_DRIVE_RE.test(homeDir) || WINDOWS_DRIVE_RE.test(shortPath)
    ? shortPath.toLowerCase()
    : shortPath;
}

export function shortenPath(uri, home = os.homedir()) {
  let p = String(uri ?? '');
  if (p.startsWith('file:')) {
    try {
      const parsed = new URL(p);
      p = safeDecodeURIComponent(parsed.pathname);
    } catch {
      // Fallback for non-standard file: strings
      p = safeDecodeURIComponent(p.replace(/^file:(\/\/)?/, ''));
    }
    if (p.length > 2 && p[0] === '/' && p[2] === ':') {
      p = p.slice(1);
    }
  }
  const homeDir = String(home ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  p = p.replace(/\\/g, '/');
  if (homeDir && isUnderHome(p, homeDir)) {
    return '~' + p.slice(homeDir.length);
  }
  return p;
}

export function stepCategory(stepType) {
  if (stepType === STEP_TYPE_USER_INPUT) return CAT_USER;
  if (stepType === STEP_TYPE_PLANNER_RESPONSE) return CAT_AGENT;
  if (stepType === STEP_TYPE_CHECKPOINT) return CAT_CHECKPOINT;
  if (
    stepType === STEP_TYPE_UNSPECIFIED ||
    stepType === STEP_TYPE_FINISH ||
    stepType === STEP_TYPE_SYSTEM_MESSAGE
  ) {
    return CAT_SYSTEM;
  }
  return CAT_TOOL;
}

/**
 * Category row key ('user' | 'agent' | 'tool' | 'system_messages') for a CAT_* value.
 * Checkpoint summaries count as agent output, matching collectStats().
 * @param {number} cat
 */
export function chatCategoryKey(cat) {
  if (cat === CAT_USER) return 'user';
  if (cat === CAT_AGENT || cat === CAT_CHECKPOINT) return 'agent';
  if (cat === CAT_TOOL) return 'tool';
  return 'system_messages';
}

/**
 * Parse a TOKEN_CHAT_MESSAGES breakdown child label. Two formats exist:
 *   "<stepIdx>: <STEP_TYPE>"                    keyed by step index
 *   "Message <n> (CHAT_MESSAGE_SOURCE_<NAME>)"  keyed by message index
 * Step type names missing from STEP_TYPES count as tools, like stepCategory() does
 * for unlisted step types.
 * @param {string} label
 * @returns {{ key: 'step' | 'message', index: number, name: string, cat: number } | null}
 */
export function parseChatLabel(label) {
  const text = String(label ?? '');
  const sepIdx = text.indexOf(': ');
  if (sepIdx !== -1) {
    const left = text.slice(0, sepIdx);
    const name = text.slice(sepIdx + 2);
    if (!INT_LABEL_RE.test(left) || !name) {
      return null;
    }
    const cat = Object.hasOwn(STEP_TYPES, name) ? stepCategory(STEP_TYPES[name]) : CAT_TOOL;
    return { key: 'step', index: Number.parseInt(left, 10), name, cat };
  }
  const m = MESSAGE_LABEL_RE.exec(text);
  if (m === null) {
    return null;
  }
  const cat = Object.hasOwn(MESSAGE_SOURCE_CATS, m[2]) ? MESSAGE_SOURCE_CATS[m[2]] : CAT_SYSTEM;
  return { key: 'message', index: Number.parseInt(m[1], 10), name: m[2], cat };
}

export function isSkillFile(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/').endsWith('/SKILL.md');
}

// --- Step decoding & token estimation ----------------------------------------

/**
 * @param {Msg} generic
 * @returns {Uint8Array | null}
 */
export function packedOriginalStep(generic) {
  const result = generic.msg(2);
  if (result === null) {
    return null;
  }
  const payload = result.msg(6);
  if (payload !== null && payload.str(1).endsWith(ORIGINAL_STEP_TYPE_URL)) {
    return payload.bytes(2);
  }
  for (const entry of result.msgs(5)) {
    if (entry.str(1) === '__original_cortex_step') {
      const value = entry.msg(2);
      if (value !== null && value.str(1).endsWith(ORIGINAL_STEP_TYPE_URL)) {
        return value.bytes(2);
      }
    }
  }
  return null;
}

export class Step {
  /**
   * @param {number} pos
   * @param {Uint8Array | null | undefined} payload
   * @param {number} stepType
   * @param {number} status
   * @param {Uint8Array | null | undefined} metadata
   */
  constructor(pos, payload, stepType, status, metadata) {
    this.pos = pos;
    this.pb = new Msg(payload);
    this.type = this.pb.has(STEP_FIELD_TYPE) ? this.pb.int(STEP_FIELD_TYPE) : stepType;
    this.status = this.pb.has(STEP_FIELD_STATUS) ? this.pb.int(STEP_FIELD_STATUS) : status;
    this.md = this.pb.msg(STEP_FIELD_METADATA) || new Msg(metadata);
    /** @type {Msg | null} */
    this.viewFileOverride = null;
    this.genericResultText = '';
    if (this.type === GENERIC_TYPE) {
      this._rehydrate();
    }
  }

  _rehydrate() {
    const generic = this.pb.msg(STEP_GENERIC);
    if (generic === null) {
      return;
    }
    const res = generic.msg(2);
    if (res !== null) {
      this.genericResultText = res.str(1);
    }
    const original = packedOriginalStep(generic);
    if (original !== null) {
      this.pb = new Msg(original);
      this.type = this.pb.int(STEP_FIELD_TYPE);
      this.md = this.pb.msg(STEP_FIELD_METADATA) || this.md;
      return;
    }
    const tc = this.md.msg(MD_TOOL_CALL_FIELD);
    if (tc === null) {
      return;
    }
    const toolName = tc.str(2);
    if (toolName !== 'view_file' && toolName !== 'read_file') {
      return;
    }
    let args;
    try {
      args = JSON.parse(tc.str(3) || '{}');
    } catch {
      return;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return;
    }
    let filePath = '';
    for (const k of ['AbsolutePath', 'Path', 'FilePath']) {
      if (typeof args[k] === 'string' && args[k]) {
        filePath = args[k];
        break;
      }
    }
    if (filePath) {
      this.type = STEP_TYPE_VIEW_FILE;
      const encoded = Buffer.from(filePath, 'utf8');
      const parts = [
        encodeVarint((VIEW_FILE_PATH_FIELD << 3) | 2),
        encodeVarint(encoded.length),
        encoded,
      ];
      if (isSkillFile(filePath)) {
        parts.push(
          encodeVarint((VIEW_FILE_IS_SKILL_FIELD << 3) | 0),
          new Uint8Array([1]),
        );
      }
      this.viewFileOverride = new Msg(Buffer.concat(parts));
    }
  }

  /**
   * @param {number} fn
   * @returns {Msg | null}
   */
  payload(fn) {
    if (fn === STEP_VIEW_FILE && this.viewFileOverride !== null) {
      return this.viewFileOverride;
    }
    return this.pb.msg(fn);
  }
}

export function estimateStepTokens(step) {
  const ui = step.payload(STEP_USER_INPUT);
  const pr = step.payload(STEP_PLANNER_RESPONSE);
  let n;
  if (ui !== null) {
    n = ui.bytes(2).length;
  } else if (pr !== null) {
    n = pr.bytes(1).length;
  } else {
    const tc = step.md.msg(MD_TOOL_CALL_FIELD);
    n = tc ? tc.bytes(3).length : 0;
    const out = step.md.int(MD_OUTPUT_TOKENS_FIELD, { signed32: true });
    if (out > 0) {
      return out;
    }
  }
  return n > 0 ? Math.max(1, Math.trunc(n / 4)) : 0;
}

export function stepTokens(step) {
  const usage = step.md.msg(MD_USAGE_FIELD);
  if (usage !== null) {
    return usage.int(USAGE_OUTPUT_FIELD);
  }
  return estimateStepTokens(step);
}

export function compactionTokens(step) {
  const retryInfos = step.md.msgs(MD_RETRY_INFO_FIELD);
  for (let i = retryInfos.length - 1; i >= 0; i--) {
    const usage = retryInfos[i].msg(2);
    if (usage === null) {
      continue;
    }
    const resp = usage.int(USAGE_RESPONSE_FIELD);
    if (resp) {
      return resp;
    }
    const out = usage.int(USAGE_OUTPUT_FIELD);
    const thinking = usage.int(USAGE_THINKING_FIELD);
    if (out > thinking) {
      return out - thinking;
    }
  }
  return 0;
}

export function checkpointSummaryTokens(step) {
  const t = compactionTokens(step);
  if (t) {
    return t;
  }
  const ck = step.payload(STEP_CHECKPOINT) || new Msg(null);
  const text = ck.str(CHECKPOINT_INTENT_FIELD) || ck.str(CHECKPOINT_SUMMARY_ALT_FIELD);
  return text ? Math.max(1, Math.trunc(utf8ByteLength(text) / 4)) : 0;
}

/**
 * @param {Step[]} steps
 * @param {Msg | null} chatStart
 * @returns {[number, Step | null]}
 */
export function checkpointNewerThanGeneration(steps, chatStart) {
  const genCk = chatStart != null
    ? chatStart.int(CHAT_START_CHECKPOINT_FIELD, { signed32: true })
    : -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === STEP_TYPE_CHECKPOINT && s.status === STATUS_DONE) {
      const ck = s.payload(STEP_CHECKPOINT);
      if (ck !== null && ck.int(CHECKPOINT_INDEX_FIELD) > genCk) {
        return [i, s];
      }
      break;
    }
  }
  return [-1, null];
}

/**
 * @param {Msg[]} items
 * @returns {[boolean, number[]]}
 */
export function chatTokensByCategory(items) {
  const out = [0, 0, 0, 0];
  if (!items || items.length === 0) {
    return [false, out];
  }
  for (const it of items) {
    const parsed = parseChatLabel(it.str(1));
    if (parsed === null) {
      return [false, [0, 0, 0, 0]];
    }
    const tok = Math.max(0, it.int(3, { signed32: true }));
    out[CHAT_CATEGORY_KEYS.indexOf(chatCategoryKey(parsed.cat))] += tok;
  }
  return [true, out];
}

// --- Model & DB helpers ------------------------------------------------------

function _telemetryFromViews(usageBuf, startBuf) {
  let uncached = 0;
  let output = 0;
  let cached = 0;
  let thinking = 0;
  for (const [fn, val] of iterFields(usageBuf, USAGE_TELEMETRY_FIELDS)) {
    if (typeof val !== 'bigint') {
      continue;
    }
    const n = Number(val);
    if (fn === USAGE_UNCACHED_INPUT_FIELD) {
      uncached = n;
    } else if (fn === USAGE_OUTPUT_FIELD) {
      output = n;
    } else if (fn === USAGE_CACHED_INPUT_FIELD) {
      cached = n;
    } else if (fn === USAGE_THINKING_FIELD) {
      thinking = n;
    }
  }

  const totalIn = uncached + cached;
  if (totalIn <= 0) {
    return null;
  }

  let activeCk = -1;
  if (startBuf !== null) {
    activeCk = 0;
    for (const [fn, val] of iterFields(startBuf, CHAT_START_CHECKPOINT_FIELDS)) {
      if (fn === CHAT_START_CHECKPOINT_FIELD && typeof val === 'bigint') {
        activeCk = Number(BigInt.asIntN(64, val));
      }
    }
  }

  return {
    tokens: totalIn,
    cached_tokens: cached,
    output_tokens: output,
    thinking_tokens: thinking,
    active_checkpoint: activeCk,
  };
}

/**
 * Fast zero-copy extractor for per-turn usage & checkpoint from a gen_metadata blob.
 * @param {Uint8Array} data
 */
export function extractTurnTelemetry(data) {
  let chatBuf = null;
  for (const [fn, val] of iterFields(data, GEN_CHAT_FIELDS)) {
    if (fn === GEN_CHAT_FIELD && val instanceof Uint8Array) {
      chatBuf = val;
    }
  }
  if (chatBuf === null) {
    return null;
  }

  let usageBuf = null;
  let startBuf = null;
  for (const [fn, val] of iterFields(chatBuf, CHAT_TELEMETRY_FIELDS)) {
    if (fn === CHAT_USAGE_FIELD && val instanceof Uint8Array) {
      usageBuf = val;
    } else if (fn === CHAT_START_FIELD && val instanceof Uint8Array) {
      startBuf = val;
    }
  }

  if (usageBuf === null) {
    return null;
  }
  return _telemetryFromViews(usageBuf, startBuf);
}

/**
 * Build turn-by-turn sparkline history and weighted session cache/output summary.
 * @param {Array<object>} rawTurns
 */
export function computeHistoryAndSession(rawTurns) {
  if (!rawTurns || rawTurns.length === 0) {
    return { history: [], sessionUsage: null };
  }

  const fullTurns = [];
  let prevTokens = 0;
  let prevCk = -1;
  let totalOutput = 0;
  let totalThinking = 0;
  let warmCached = 0;
  let warmInput = 0;

  for (let i = 0; i < rawTurns.length; i++) {
    const t = rawTurns[i];
    const tok = t.tokens;
    const cached = t.cached_tokens;
    const outTok = t.output_tokens;
    const thinkTok = t.thinking_tokens;
    const ck = t.active_checkpoint;

    const delta = i > 0 ? tok - prevTokens : 0;
    const compacted = Boolean(i > 0 && ck > prevCk);
    const hitPct = round1(pct(cached, tok));

    totalOutput += outTok;
    totalThinking += thinkTok;
    if (i > 0) {
      warmCached += cached;
      warmInput += tok;
    }

    fullTurns.push({
      turn: i + 1,
      tokens: tok,
      delta,
      cache_hit_pct: hitPct,
      output_tokens: outTok,
      compacted,
    });
    prevTokens = tok;
    prevCk = ck;
  }

  const n = fullTurns.length;
  const avgCache = warmInput > 0 ? round1(pct(warmCached, warmInput)) : fullTurns[0].cache_hit_pct;
  const last = fullTurns[n - 1];
  const prev = n > 1 ? fullTurns[n - 2] : null;
  const hadActiveCache = Boolean(
    prev !== null && (prev.cache_hit_pct >= 50.0 || avgCache >= 50.0),
  );
  const cacheDrop = Boolean(
    n > 1 && hadActiveCache && last.cache_hit_pct < 50.0 && !last.compacted,
  );
  const cacheDropAfterCompact = Boolean(
    n > 1 && hadActiveCache && last.cache_hit_pct < 50.0 && last.compacted,
  );

  const sessionUsage = {
    turns: n,
    total_output_tokens: totalOutput,
    total_thinking_tokens: totalThinking,
    avg_cache_hit_pct: avgCache,
    cache_drop: cacheDrop,
    cache_drop_after_compact: cacheDropAfterCompact,
  };

  const history = n > MAX_HISTORY_POINTS ? fullTurns.slice(-MAX_HISTORY_POINTS) : fullTurns;
  return { history, sessionUsage };
}

export function openSqliteReadOnly(dbPath, timeoutMs = 2500) {
  return new DatabaseSync(String(dbPath), { readOnly: true, timeout: timeoutMs });
}

/**
 * Read steps, latest generation records, and per-turn telemetry in a single read-only pass.
 * @param {string} dbPath
 */
export function loadDbWithHistory(dbPath) {
  const db = openSqliteReadOnly(dbPath, 2500);
  const rawTurns = [];
  let latestStatsBytes = null;
  let latestContentBytes = null;
  const steps = [];
  let began = false;
  try {
    db.exec('BEGIN');
    began = true;
    const stepStmt = db.prepare(
      'SELECT idx, step_payload, step_type, status, metadata FROM steps ORDER BY idx ASC',
    );
    for (const row of stepStmt.iterate()) {
      steps.push(new Step(row.idx, row.step_payload, row.step_type, row.status, row.metadata));
    }
    const genStmt = db.prepare(
      'SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC',
    );
    for (const row of genStmt.iterate()) {
      const data = row.data;
      if (!(data instanceof Uint8Array) || data.length === 0) {
        continue;
      }
      let chatBuf = null;
      for (const [fn, val] of iterFields(data, GEN_CHAT_FIELDS)) {
        if (fn === GEN_CHAT_FIELD && val instanceof Uint8Array) {
          chatBuf = val;
        }
      }
      if (chatBuf === null) {
        continue;
      }
      let hasContent = false;
      let usageBuf = null;
      let startBuf = null;
      for (const [fn, val] of iterFields(chatBuf, CHAT_SCAN_FIELDS)) {
        if (CHAT_CONTENT_FIELDS.has(fn)) {
          hasContent = true;
        } else if (fn === CHAT_USAGE_FIELD && val instanceof Uint8Array) {
          usageBuf = val;
        } else if (fn === CHAT_START_FIELD && val instanceof Uint8Array) {
          startBuf = val;
        }
      }
      latestStatsBytes = data;
      if (hasContent) {
        latestContentBytes = data;
      }
      if (usageBuf !== null) {
        const tel = _telemetryFromViews(usageBuf, startBuf);
        if (tel !== null) {
          rawTurns.push(tel);
        }
      }
    }
  } finally {
    if (began) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors during cleanup
      }
    }
    db.close();
  }

  const latestStats = latestStatsBytes !== null ? new Msg(latestStatsBytes) : null;
  const latestContent = latestContentBytes === latestStatsBytes
    ? latestStats
    : latestContentBytes !== null
      ? new Msg(latestContentBytes)
      : null;

  const { history, sessionUsage } = computeHistoryAndSession(rawTurns);
  return { steps, latestStats, latestContent, history, sessionUsage };
}

/**
 * Read steps and latest generation records from a conversation SQLite DB.
 * @param {string} dbPath
 */
export function loadDb(dbPath) {
  const { steps, latestStats, latestContent } = loadDbWithHistory(dbPath);
  return { steps, latestStats, latestContent };
}

export function extractModelId(gen) {
  const chat = gen != null ? gen.msg(GEN_CHAT_FIELD) : null;
  if (chat === null) {
    return '';
  }
  return chat.str(CHAT_MODEL_ID_FIELD) || chat.str(CHAT_MODEL_ID_ALT_FIELD) || '';
}

export function extractModelName(gen) {
  const chat = gen != null ? gen.msg(GEN_CHAT_FIELD) : null;
  if (chat === null) {
    return 'Unknown Model';
  }
  const displayName = chat.str(CHAT_MODEL_NAME_FIELD);
  if (displayName) {
    return displayName;
  }
  return extractModelId(gen) || 'Unknown Model';
}

export function extractRequestBudget(gen) {
  const chat = gen != null ? gen.msg(GEN_CHAT_FIELD) : null;
  const start = chat !== null ? chat.msg(CHAT_START_FIELD) : null;
  const cwm = start !== null ? start.msg(CHAT_START_CWM_FIELD) : null;
  return cwm !== null ? cwm.int(CWM_REQUEST_BUDGET_FIELD, { signed32: true }) : 0;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function inferContextLimit(gen) {
  const slug = extractModelId(gen).trim().toLowerCase().replace(/[\s_]+/g, '-');
  const name = extractModelName(gen).trim().toLowerCase().replace(/[\s_]+/g, '-');
  for (const [prefix, tokens] of NATIVE_CONTEXT_WINDOWS) {
    if (prefix.length <= 2) {
      const pat = new RegExp(`(?<![a-z0-9])${escapeRegex(prefix)}(?![a-z0-9])`);
      if (pat.test(slug) || pat.test(name)) {
        return tokens;
      }
    } else if (slug.startsWith(prefix) || name.includes(prefix)) {
      return tokens;
    }
  }
  return extractRequestBudget(gen);
}

// --- Stats and files ---------------------------------------------------------

function expandHome(p) {
  const s = String(p);
  if (s === '~') {
    return os.homedir();
  }
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function detectSystemFiles(home, workspace, appDir, geminiDir = null) {
  if (!home && !geminiDir) {
    return [];
  }
  const gemini = geminiDir ? expandHome(geminiDir) : path.join(String(home), '.gemini');
  const prefix = geminiDir ? shortenPath(gemini).replace(/\/+$/, '') : '~/.gemini';
  const found = [];
  if (isFile(path.join(gemini, 'GEMINI.md'))) {
    found.push(`${prefix}/GEMINI.md`);
  }
  for (const sub of ['skills', 'rules', 'agents', 'global_workflows']) {
    if (isDir(path.join(gemini, sub))) {
      found.push(`${prefix}/${sub}/`);
    }
  }
  if (appDir) {
    for (const sub of ['rules', 'skills', 'agents', 'global_workflows']) {
      if (isDir(path.join(gemini, appDir, sub))) {
        found.push(`${prefix}/${appDir}/${sub}/`);
      }
    }
  }
  if (workspace) {
    const ws = String(workspace);
    for (const root of ['.agents', '_agents']) {
      for (const sub of ['rules', 'skills', 'agents', 'workflows']) {
        if (isDir(path.join(ws, root, sub))) {
          found.push(`${root}/${sub}/`);
        }
      }
      if (isFile(path.join(ws, root, 'hooks.json'))) {
        found.push(`${root}/hooks.json`);
      }
    }
  }
  return found.map((p) => ({ path: p }));
}

const TOTAL_KEYS = [
  'user', 'agent', 'tool', 'system_messages', 'system_prompt',
  'system_tools', 'system_overhead', 'rules', 'skills', 'subagents',
  'legacy_workflows', 'workflows', 'plugins', 'mcp_tools',
];

export function collectStats(steps, gen, limit) {
  const st = {
    user: 0,
    agent: 0,
    tool: 0,
    checkpoint: 0,
    system_messages: 0,
    system_prompt: 0,
    system_tools: 0,
    system_overhead: 0,
    rules: 0,
    skills: 0,
    subagents: 0,
    legacy_workflows: 0,
    workflows: 0,
    plugins: 0,
    mcp_tools: 0,
    has_breakdown: false,
    active_checkpoint: -1,
    compacted: false,
  };

  const checkpoints = [];
  const knowledge = [];
  const artifacts = [];
  const skillFiles = [];
  const seenK = new Set();
  const seenA = new Set();
  const seenS = new Set();

  const chat = gen != null ? gen.msg(GEN_CHAT_FIELD) : null;
  const chatStart = chat !== null ? chat.msg(CHAT_START_FIELD) : null;
  const [newerPos, newerStep] = checkpointNewerThanGeneration(steps, chatStart);
  const hasNewer = newerStep !== null;
  st.compacted = hasNewer;

  for (let pos = 0; pos < steps.length; pos++) {
    const step = steps[pos];
    const cat = stepCategory(step.type);
    const tok = stepTokens(step);
    const counted = hasNewer && newerPos > pos ? 0 : tok;
    if (cat === CAT_USER) {
      st.user += counted;
    } else if (cat === CAT_AGENT) {
      st.agent += counted;
    } else if (cat === CAT_TOOL) {
      st.tool += counted;
    } else if (cat === CAT_CHECKPOINT) {
      st.checkpoint += tok;
      const ck = step.payload(STEP_CHECKPOINT);
      if (ck !== null) {
        checkpoints.push({
          index: ck.int(CHECKPOINT_INDEX_FIELD),
          start: ck.int(CHECKPOINT_START_FIELD),
          end: ck.int(CHECKPOINT_END_FIELD),
          intent: ck.str(CHECKPOINT_INTENT_FIELD),
        });
      }
    } else {
      st.system_messages += counted;
    }

    const ca = step.payload(STEP_CODE_ACTION);
    const result = ca !== null ? ca.msg(CODE_ACTION_RESULT_FIELD) : null;
    const edit = result !== null ? result.msg(CODE_ACTION_EDIT_FIELD) : null;
    if (edit !== null) {
      const uri = edit.str(CODE_ACTION_EDIT_URI_FIELD);
      const short = shortenPath(uri);
      const key = pathDedupeKey(short);
      if (ca.int(CODE_ACTION_IS_ARTIFACT_FIELD) && !seenA.has(key)) {
        seenA.add(key);
        artifacts.push({ path: short, tokens: tok });
      }
      if (ca.int(CODE_ACTION_IS_KNOWLEDGE_FIELD) && !seenK.has(key)) {
        seenK.add(key);
        knowledge.push({ path: short, tokens: tok });
      }
    }

    const vf = step.payload(STEP_VIEW_FILE);
    if (vf !== null && vf.int(VIEW_FILE_IS_SKILL_FIELD)) {
      const short = shortenPath(vf.str(VIEW_FILE_PATH_FIELD));
      const key = pathDedupeKey(short);
      if (!seenS.has(key)) {
        seenS.add(key);
        skillFiles.push({ path: short, tokens: tok });
      }
    }
  }

  const cwm = chatStart !== null ? chatStart.msg(CHAT_START_CWM_FIELD) : null;
  const breakdown = cwm !== null ? cwm.msg(CWM_BREAKDOWN_FIELD) : null;

  if (breakdown !== null) {
    st.has_breakdown = true;
    let seenPrompt = false;
    let seenTools = false;
    let chatTok = 0;
    const chatItems = [];
    for (const g of breakdown.msgs(1)) {
      const gtype = g.int(2);
      const gtok = Math.max(0, g.int(4, { signed32: true }));
      const isPromptGroup = gtype === TOKEN_SYSTEM_PROMPT;
      if (isPromptGroup || !KNOWN_GROUP_TYPES.has(gtype)) {
        let extracted = 0;
        for (const child of g.msgs(5)) {
          const name = child.str(1);
          const ctok = Math.max(0, child.int(3, { signed32: true }));
          if (name === 'flows') {
            st.workflows += ctok;
          } else if (name === 'skills') {
            st.skills += ctok;
          } else if (name === 'subagents') {
            st.subagents += ctok;
          } else {
            continue;
          }
          extracted += ctok;
        }
        st.system_prompt += Math.max(0, gtok - extracted);
        // Only a real system prompt group turns off the overhead estimate below.
        if (isPromptGroup) {
          seenPrompt = true;
        }
      } else if (gtype === TOKEN_TOOLS) {
        st.system_tools += gtok;
        seenTools = true;
      } else if (gtype === TOKEN_RULES) {
        st.rules += gtok;
      } else if (gtype === TOKEN_MCP_TOOLS) {
        st.mcp_tools += gtok;
      } else if (gtype === TOKEN_SKILLS) {
        st.skills += gtok;
      } else if (gtype === TOKEN_SUBAGENTS) {
        st.subagents += gtok;
      } else if (gtype === TOKEN_CHAT_MESSAGES) {
        chatTok += gtok;
        chatItems.push(...g.msgs(5));
      } else if (gtype === TOKEN_WORKFLOWS) {
        st.legacy_workflows += gtok;
      } else if (gtype === TOKEN_PLUGINS) {
        st.plugins += gtok;
      } else if (gtype === TOKEN_FLOWS) {
        st.workflows += gtok;
      }
    }

    if (!seenPrompt && !seenTools && chatTok > 0 && chat !== null) {
      const usage = chat.msg(CHAT_USAGE_FIELD);
      const apiInput = usage !== null
        ? usage.int(USAGE_UNCACHED_INPUT_FIELD) + usage.int(USAGE_CACHED_INPUT_FIELD)
        : 0;
      const knownCustom =
        st.rules + st.skills + st.subagents +
        st.legacy_workflows + st.workflows + st.plugins + st.mcp_tools;
      // With no real prompt group, st.system_prompt holds only unknown-type groups.
      st.system_overhead = Math.max(0, apiInput - chatTok - knownCustom - st.system_prompt);
    }

    if (chatTok > 0 && !hasNewer) {
      const [ok, cats] = chatTokensByCategory(chatItems);
      if (ok) {
        [st.user, st.agent, st.tool, st.system_messages] = cats;
      } else {
        const est = st.user + st.agent + st.tool + st.system_messages;
        if (est === 0) {
          st.agent = chatTok;
          st.system_messages = 0;
        } else {
          const f = chatTok / est;
          st.user = Math.trunc(st.user * f);
          st.agent = Math.trunc(st.agent * f);
          st.tool = Math.trunc(st.tool * f);
          st.system_messages = Math.trunc(st.system_messages * f);
        }
      }
    }
  }

  if (chatStart !== null) {
    st.active_checkpoint = chatStart.int(CHAT_START_CHECKPOINT_FIELD, { signed32: true });
  }
  if (hasNewer && newerStep !== null) {
    st.agent += checkpointSummaryTokens(newerStep);
    const ck = newerStep.payload(STEP_CHECKPOINT);
    if (ck !== null) {
      st.active_checkpoint = ck.int(CHECKPOINT_INDEX_FIELD);
    }
  }

  let total = 0;
  for (const k of TOTAL_KEYS) {
    total += st[k];
  }
  st.total = total;
  st.limit = limit;
  st.checkpoints = checkpoints;
  st.knowledge_files = knowledge;
  st.artifact_files = artifacts;
  st.skill_files = skillFiles;

  const usage = chat !== null ? chat.msg(CHAT_USAGE_FIELD) : null;
  if (usage !== null) {
    const uncached = usage.int(USAGE_UNCACHED_INPUT_FIELD);
    const cached = usage.int(USAGE_CACHED_INPUT_FIELD);
    const totalIn = uncached + cached;
    st.api_usage = {
      input_tokens: uncached,
      cached_tokens: cached,
      total_input_tokens: totalIn,
      output_tokens: usage.int(USAGE_OUTPUT_FIELD),
      thinking_tokens: usage.int(USAGE_THINKING_FIELD),
      response_tokens: usage.int(USAGE_RESPONSE_FIELD),
      cache_hit_pct: totalIn > 0 ? round1(pct(cached, totalIn)) : 0.0,
    };
  } else {
    st.api_usage = null;
  }

  return { st, breakdown };
}

/**
 * [system, user, agent, tool, customizations] token totals.
 */
export function gridSegments(st) {
  const sysTot = st.system_prompt + st.system_tools + st.system_overhead + st.system_messages;
  const customTot =
    st.rules + st.skills + st.subagents +
    st.legacy_workflows + st.workflows + st.plugins + st.mcp_tools;
  return [sysTot, st.user, st.agent, st.tool, customTot];
}

export function statsHeading(st) {
  if (st.compacted) {
    return 'Estimated after compaction \u00b7 updates next turn';
  }
  if (st.has_breakdown) {
    return 'Exact token usage from latest model call';
  }
  return 'Estimated usage (awaiting first generation)';
}
