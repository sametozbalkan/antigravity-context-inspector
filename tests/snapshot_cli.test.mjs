/**
 * Unit tests for snapshot assembly, fingerprinting, paths, limits, and CLI invocation (`lib/snapshot.mjs` & `inspector.mjs`).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  detectSystemFiles,
  inferContextLimit,
  shortenPath,
} from '../sidecars/inspector/lib/accounting.mjs';
import { extractMcpServer } from '../sidecars/inspector/lib/content.mjs';
import { Msg } from '../sidecars/inspector/lib/protobuf.mjs';
import { buildSnapshot } from '../sidecars/inspector/lib/snapshot.mjs';
import {
  INSPECTOR_DIR,
  buildFullConversationDb,
  concatBytes,
  createEmptyDb,
  makeGroup,
  pbBytes,
  pbStr,
  pbVarint,
  withTempDir,
} from './helpers.mjs';

describe('TestSnapshotAndCli', () => {
  it('test_special_chars_in_db_path', () => {
    withTempDir((tmpDir) => {
      const dirName = process.platform === 'win32'
        ? 'folder #1 %20 space'
        : 'folder #1 ? %20 space';
      const specialDir = path.join(tmpDir, dirName);
      fs.mkdirSync(specialDir);
      const src = buildFullConversationDb(tmpDir, '55555555-6666-7777-8888-999999999999');
      const dst = path.join(specialDir, path.basename(src));
      fs.copyFileSync(src, dst);

      const snap = buildSnapshot(dst);
      assert.equal(snap.summary.used_tokens, 5500);
    });
  });

  it('test_cli_json_invocation', () => {
    withTempDir((tmpDir) => {
      const dbPath = buildFullConversationDb(tmpDir, 'cccccccc-1111-2222-3333-444444444444');
      const proc = spawnSync(
        process.execPath,
        [path.join(INSPECTOR_DIR, 'inspector.mjs'), '--db', dbPath, '--json'],
        { encoding: 'utf8' },
      );
      assert.equal(proc.status, 0, proc.stderr);
      const parsed = JSON.parse(proc.stdout);
      assert.equal(parsed.summary.used_tokens, 5500);
    });
  });

  it('test_fingerprint_tracks_api_usage_and_budget', () => {
    withTempDir((tmpDir) => {
      const dbPath = path.join(tmpDir, '66666666-7777-8888-9999-aaaaaaaaaaaa.db');

      function writeDb(budget, outputTokens) {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
        const con = createEmptyDb(dbPath);
        try {
          const breakdown = pbBytes(1, makeGroup(1, 'System Prompt', 1000, [['identity', 1000]]));
          const cwm = concatBytes(pbBytes(3, breakdown), pbVarint(4, budget));
          const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, cwm));
          const usage = concatBytes(pbVarint(2, 200), pbVarint(3, outputTokens), pbVarint(5, 800));
          const chat = concatBytes(
            pbBytes(4, usage),
            pbBytes(9, chatStart),
            pbStr(19, 'gemini-4-neon-high'),
            pbStr(21, 'Gemini 4 Neon (High)'),
          );
          const gen = pbBytes(1, chat);
          con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
        } finally {
          con.close();
        }
      }

      writeDb(512_000, 100);
      const fpBase = buildSnapshot(dbPath).summary.fingerprint;

      writeDb(512_000, 999);
      const fpUsage = buildSnapshot(dbPath).summary.fingerprint;
      assert.notEqual(fpBase, fpUsage);

      writeDb(256_000, 100);
      const fpBudget = buildSnapshot(dbPath).summary.fingerprint;
      assert.notEqual(fpBase, fpBudget);
    });
  });

  it('test_fingerprint_reacts_to_checkpoints_categories_and_subagent_model', () => {
    withTempDir((tmpDir) => {
      const mainId = '70707070-1111-2222-3333-444444444444';
      const subId = '71717171-1111-2222-3333-444444444444';
      const mainDb = path.join(tmpDir, `${mainId}.db`);
      const subDb = path.join(tmpDir, `${subId}.db`);

      function writeSub(modelName) {
        if (fs.existsSync(subDb)) {
          fs.unlinkSync(subDb);
        }
        const con = createEmptyDb(subDb);
        try {
          const bd = pbBytes(1, makeGroup(1, 'System Prompt', 500, [['id', 500]]));
          const chat = concatBytes(
            pbBytes(9, concatBytes(pbVarint(2, -1), pbBytes(10, pbBytes(3, bd)))),
            pbStr(21, modelName),
          );
          const gen = pbBytes(1, chat);
          con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
        } finally {
          con.close();
        }
      }

      function writeMain(sysTok, rulesTok, ckIntent) {
        if (fs.existsSync(mainDb)) {
          fs.unlinkSync(mainDb);
        }
        const con = createEmptyDb(mainDb);
        try {
          const bd = concatBytes(
            pbBytes(1, makeGroup(1, 'System Prompt', sysTok, [['id', sysTok]])),
            pbBytes(1, makeGroup(3, 'Rules', rulesTok, [['r', rulesTok]])),
          );
          const chat = concatBytes(
            pbBytes(9, concatBytes(pbVarint(2, 1), pbBytes(10, pbBytes(3, bd)))),
            pbStr(19, 'gemini-4-neon-high'),
          );
          const gen = pbBytes(1, chat);
          con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
          const ckPl = concatBytes(
            pbVarint(1, 23),
            pbVarint(4, 3),
            pbBytes(30, concatBytes(pbVarint(1, 1), pbStr(4, ckIntent))),
          );
          con.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 23, 3, ?)').run(ckPl);
          const tc = concatBytes(pbStr(2, 'invoke_subagent'), pbStr(3, JSON.stringify({ Role: 'Worker' })));
          const md = pbBytes(4, tc);
          const genStep = concatBytes(
            pbVarint(1, 132),
            pbVarint(4, 3),
            pbBytes(5, md),
            pbBytes(140, pbBytes(2, pbStr(1, `{"conversationId": "${subId}"}`))),
          );
          con
            .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 132, 3, ?, ?)')
            .run(md, genStep);
        } finally {
          con.close();
        }
      }

      writeSub('Model A');
      writeMain(600, 400, 'Intent 1');
      const fpBase = buildSnapshot(mainDb).summary.fingerprint;

      // 1) Same total (1000), shifted category split
      writeMain(700, 300, 'Intent 1');
      const fpCat = buildSnapshot(mainDb).summary.fingerprint;
      assert.notEqual(fpBase, fpCat);

      // 2) Changed checkpoint intent
      writeMain(600, 400, 'Intent 2');
      const fpCk = buildSnapshot(mainDb).summary.fingerprint;
      assert.notEqual(fpBase, fpCk);

      // 3) Changed subagent model (same used_tokens and status)
      writeMain(600, 400, 'Intent 1');
      writeSub('Model B');
      const fpSub = buildSnapshot(mainDb).summary.fingerprint;
      assert.notEqual(fpBase, fpSub);
    });
  });

  it('test_mcp_server_model_limits_shorten_path_and_cli_uuid_validation', () => {
    withTempDir((tmpDir) => {
      // MCP double-underscore with mcp_ prefix
      assert.equal(extractMcpServer('mcp_github__search_issues'), 'github');
      assert.equal(extractMcpServer('mcp_github_get__item'), 'github');
      assert.equal(extractMcpServer('mcp_chrome-devtools__click'), 'chrome-devtools');

      // inferContextLimit normalization and short-prefix word boundaries
      const genFor = (slug, name) => new Msg(pbBytes(1, concatBytes(pbStr(19, slug), pbStr(21, name))));

      assert.equal(inferContextLimit(genFor('', 'Claude Sonnet 4')), 250_000);
      assert.equal(inferContextLimit(genFor('claude_opus_4', 'Claude Opus 4')), 250_000);
      assert.equal(inferContextLimit(genFor('pro4', 'Pro4')), 0);
      assert.equal(inferContextLimit(genFor('o4-mini', 'o4 mini')), 200_000);
      assert.equal(inferContextLimit(genFor('o3', 'o3')), 200_000);

      // shortenPath directory boundary
      const home = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '');
      assert.equal(shortenPath(home), '~');
      assert.equal(shortenPath(`${home}/projects/app`), '~/projects/app');
      const sibling = `${home}2/projects/app`;
      assert.equal(shortenPath(sibling), sibling);

      // detectSystemFiles with custom geminiDir
      const customGemini = path.join(tmpDir, 'custom_gemini');
      fs.mkdirSync(path.join(customGemini, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(customGemini, 'GEMINI.md'), '# rules', 'utf8');
      const sysFiles = detectSystemFiles('', null, 'antigravity', customGemini).map((f) => f.path);
      assert.ok(sysFiles.some((p) => p.endsWith('/GEMINI.md')));
      assert.ok(sysFiles.some((p) => p.endsWith('/skills/')));

      // CLI rejects path traversal in --conversation-id
      const proc = spawnSync(
        process.execPath,
        [path.join(INSPECTOR_DIR, 'inspector.mjs'), '--conversation-id', '../evil'],
        { encoding: 'utf8' },
      );
      assert.notEqual(proc.status, 0);
      assert.ok(proc.stderr.includes('Invalid conversation ID'));
    });
  });
});
