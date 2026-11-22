/**
 * Shared synthetic SQLite & protobuf test builders for Antigravity Context Inspector.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { encodeVarint } from '../sidecars/inspector/lib/protobuf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, '..');
export const INSPECTOR_DIR = path.join(ROOT, 'sidecars', 'inspector');

// --- Minimal protobuf wire encoders for synthetic test DBs -------------------

export function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) {
    total += c.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function pbVarint(fn, val) {
  let v = typeof val === 'bigint' ? val : BigInt(val);
  if (v < 0n) {
    v &= (1n << 64n) - 1n;
  }
  return concatBytes(encodeVarint((BigInt(fn) << 3n) | 0n), encodeVarint(v));
}

export function pbBytes(fn, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return concatBytes(encodeVarint((BigInt(fn) << 3n) | 2n), encodeVarint(bytes.length), bytes);
}

export function pbStr(fn, text) {
  return pbBytes(fn, Buffer.from(String(text), 'utf8'));
}

export function createEmptyDb(dbPath) {
  const con = new DatabaseSync(dbPath);
  con.exec(`
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0,
      has_subtrajectory NUMERIC NOT NULL DEFAULT 0,
      metadata BLOB,
      error_details BLOB,
      permissions BLOB,
      task_details BLOB,
      render_info BLOB,
      step_payload BLOB,
      step_format INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      data BLOB,
      size INTEGER NOT NULL DEFAULT 0
    );
  `);
  return con;
}

export function makeGroup(gtype, name, total, children) {
  const parts = [pbStr(1, name), pbVarint(2, gtype), pbVarint(4, total)];
  for (const [cname, ctok] of children) {
    parts.push(pbBytes(5, concatBytes(pbStr(1, cname), pbVarint(3, ctok))));
  }
  return concatBytes(...parts);
}

export function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ctx-test-'));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function buildFullConversationDb(tmpDir, convId, subagentId = null) {
  const dbPath = path.join(tmpDir, `${convId}.db`);
  const con = createEmptyDb(dbPath);
  try {
    // Build synthetic gen_metadata with exact breakdown + content
    const breakdown = concatBytes(
      pbBytes(1, makeGroup(1, 'System Prompt', 1200, [['identity', 300], ['guidelines', 900]])),
      pbBytes(1, makeGroup(5, 'Skills', 800, [['skills', 800]])),
      pbBytes(1, makeGroup(2, 'Tools', 600, [['read_file', 600]])),
      pbBytes(1, makeGroup(4, 'MCP Tools', 400, [['mcp_github_search', 400]])),
      pbBytes(
        1,
        makeGroup(7, 'Chat Messages', 2500, [
          ['0: USER_INPUT', 200],
          ['1: PLANNER_RESPONSE', 500],
          ['2: GENERIC', 1800],
        ]),
      ),
    );
    const cwm = concatBytes(pbBytes(3, breakdown), pbVarint(4, 512_000));
    const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, cwm));

    const usage = concatBytes(
      pbVarint(2, 500),  // uncached input
      pbVarint(3, 450),  // output
      pbVarint(5, 5000), // cached input
      pbVarint(9, 120),  // thinking
      pbVarint(10, 330), // response
    );

    // System sections (chat[16])
    const secIdentity = concatBytes(pbStr(1, 'identity'), pbStr(2, 'You are Antigravity.'), pbVarint(6, 1));
    const secGuidelines = concatBytes(pbStr(1, 'guidelines'), pbStr(2, 'Follow best practices.'), pbVarint(6, 1));
    const secSkills = concatBytes(pbStr(1, 'skills'), pbStr(2, 'Available skills: plugin'), pbVarint(6, 5));

    // Tool declarations (chat[8])
    const toolRead = concatBytes(pbStr(1, 'read_file'), pbStr(2, 'Read a file'), pbStr(3, '{"type":"object"}'));
    const toolMcp = concatBytes(pbStr(1, 'mcp_github_search'), pbStr(2, 'Search GitHub'), pbStr(3, '{"type":"object"}'));

    // Chat messages (chat[2])
    const msgUser = concatBytes(pbVarint(2, 1), pbStr(3, 'Inspect this repo'), pbVarint(4, 200), pbVarint(18, 0));
    const tcCall = concatBytes(pbStr(1, 'call_1'), pbStr(2, 'read_file'), pbStr(3, '{"Path":"/app/main.py"}'));
    const msgAgent = concatBytes(
      pbVarint(2, 2),
      pbVarint(4, 500),
      pbBytes(6, tcCall),
      pbStr(11, 'Let me read main.py first.'),
      pbVarint(18, 1),
    );
    const msgTool = concatBytes(
      pbVarint(2, 4),
      pbStr(3, "print('hello')"),
      pbVarint(4, 1800),
      pbStr(7, 'call_1'),
      pbVarint(18, 2),
    );

    const chat = concatBytes(
      pbStr(1, 'You are Antigravity.\nFollow best practices.'),
      pbBytes(2, msgUser),
      pbBytes(2, msgAgent),
      pbBytes(2, msgTool),
      pbBytes(4, usage),
      pbBytes(8, toolRead),
      pbBytes(8, toolMcp),
      pbBytes(9, chatStart),
      pbBytes(16, secIdentity),
      pbBytes(16, secGuidelines),
      pbBytes(16, secSkills),
      pbStr(19, 'gemini-4-neon-high'),
      pbStr(21, 'Gemini 4 Neon (High)'),
    );
    const gen = pbBytes(1, chat);
    con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);

    if (subagentId) {
      const tcSub = concatBytes(
        pbStr(2, 'invoke_subagent'),
        pbStr(
          3,
          JSON.stringify({ Role: 'Codebase Researcher', TypeName: 'research', Model: 'flash_lite' }),
        ),
      );
      const mdSub = pbBytes(4, tcSub);
      const resText = `Created the following subagent:\n{"conversationId": "${subagentId}"}`;
      const generic = pbBytes(2, pbStr(1, resText));
      const stepPl = concatBytes(
        pbVarint(1, 132),
        pbVarint(4, 3),
        pbBytes(5, mdSub),
        pbBytes(140, generic),
      );
      con
        .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (3, 132, 3, ?, ?)')
        .run(mdSub, stepPl);
    }
  } finally {
    con.close();
  }
  return dbPath;
}
