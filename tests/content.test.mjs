/**
 * Unit tests for content extraction, subgroup alignment, MCP server grouping, and malformed inputs (`lib/content.mjs`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  Step,
  compactionTokens,
  extractTurnTelemetry,
  loadDbWithHistory,
} from '../sidecars/inspector/lib/accounting.mjs';
import { extractMcpServer, makePreview } from '../sidecars/inspector/lib/content.mjs';
import { buildSnapshot } from '../sidecars/inspector/lib/snapshot.mjs';
import {
  buildFullConversationDb,
  concatBytes,
  createEmptyDb,
  makeGroup,
  pbBytes,
  pbStr,
  pbVarint,
  withTempDir,
} from './helpers.mjs';

describe('TestContent', () => {
  it('test_system_prompt_subgroups_alignment', () => {
    withTempDir((tmpDir) => {
      const dbPath = path.join(tmpDir, 'dddddddd-1111-2222-3333-444444444444.db');
      const con = createEmptyDb(dbPath);
      try {
        const breakdown = pbBytes(
          1,
          makeGroup(1, 'System Prompt', 1100, [
            ['identity', 300],
            ['skills', 400],
            ['subagents', 250],
            ['flows', 150],
          ]),
        );
        const cwm = concatBytes(pbBytes(3, breakdown), pbVarint(4, 256_000));
        const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, cwm));

        // Sections nested under group_type=1 or unset (0)
        const secIdentity = concatBytes(pbStr(1, 'identity'), pbStr(2, 'Identity text'), pbVarint(6, 1));
        const secSkills = concatBytes(pbStr(1, 'skills'), pbStr(2, 'Skills list'), pbVarint(6, 1));
        const secSubagents = concatBytes(pbStr(1, 'subagents'), pbStr(2, 'Subagent list'));
        const secFlows = concatBytes(pbStr(1, 'flows'), pbStr(2, 'Workflows list'), pbVarint(6, 1));

        const chat = concatBytes(
          pbBytes(9, chatStart),
          pbBytes(16, secIdentity),
          pbBytes(16, secSkills),
          pbBytes(16, secSubagents),
          pbBytes(16, secFlows),
          pbStr(19, 'gemini-4-neon-high'),
        );
        const gen = pbBytes(1, chat);
        con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
      } finally {
        con.close();
      }

      const snap = buildSnapshot(dbPath);
      const cats = Object.fromEntries(snap.summary.categories.map((c) => [c.key, c.tokens]));
      assert.equal(cats.system_prompt, 300);
      assert.equal(cats.skills, 400);
      assert.equal(cats.subagents, 250);
      assert.equal(cats.workflows, 150);

      const secs = Object.fromEntries(snap.content.system_sections.map((s) => [s.name, s]));
      assert.equal(secs.identity.group_type, 1);
      assert.equal(secs.skills.group_type, 5);
      assert.equal(secs.skills.group, 'Skills');
      assert.equal(secs.subagents.group_type, 6);
      assert.equal(secs.subagents.group, 'Subagents');
      assert.equal(secs.flows.group_type, 10);
      assert.equal(secs.flows.group, 'Workflows');
    });
  });

  it('test_mcp_server_grouping', () => {
    assert.equal(extractMcpServer('mcp_github_search_issues'), 'github');
    assert.equal(extractMcpServer('mcp_chrome-devtools_click'), 'chrome-devtools');
    assert.equal(extractMcpServer('supabase__execute_sql'), 'supabase');
    assert.equal(extractMcpServer('mcp__linear__list_issues'), 'linear');
    assert.equal(extractMcpServer('notion:search_pages'), 'notion');
    assert.equal(extractMcpServer('custom_tool'), 'other');

    withTempDir((tmpDir) => {
      const dbPath = buildFullConversationDb(tmpDir, '99999999-aaaa-bbbb-cccc-dddddddddddd');
      const snap = buildSnapshot(dbPath);
      const tools = Object.fromEntries(snap.content.tools.map((t) => [t.name, t]));
      assert.equal(tools.mcp_github_search.mcp_server, 'github');
      assert.equal(tools.read_file.mcp_server, '');
    });
  });

  it('test_step_idx_zero_omitted_proto3_and_colliding_sections_and_preview', () => {
    withTempDir((tmpDir) => {
      const dbPath = path.join(tmpDir, '50505050-1111-2222-3333-444444444444.db');
      const con = createEmptyDb(dbPath);
      const hugeSchema = `{"k":"${'a'.repeat(100_050)}"}`;
      try {
        const breakdown = concatBytes(
          pbBytes(1, makeGroup(1, 'System Prompt', 100, [['overview', 100]])),
          pbBytes(1, makeGroup(3, 'Rules', 350, [['overview', 350]])),
          pbBytes(1, makeGroup(7, 'Chat Messages', 222, [['0: USER_INPUT', 222]])),
        );
        const cwm = pbBytes(3, breakdown);
        const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, cwm));

        const secSys = concatBytes(pbStr(1, 'overview'), pbStr(2, 'System overview'), pbVarint(6, 1));
        const secRule = concatBytes(pbStr(1, 'overview'), pbStr(2, 'Rule overview'), pbVarint(6, 3));
        // First message omits field 18 (step_index == 0 in proto3) and field 4 (tokens)
        const msg0 = concatBytes(pbVarint(2, 1), pbStr(3, 'First prompt'));
        // Huge schema (>100_000 chars) should skip pretty-printing cleanly
        const toolHuge = concatBytes(pbStr(1, 'big_tool'), pbStr(2, 'Big'), pbStr(3, hugeSchema));

        const chat = concatBytes(
          pbBytes(2, msg0),
          pbBytes(8, toolHuge),
          pbBytes(9, chatStart),
          pbBytes(16, secSys),
          pbBytes(16, secRule),
          pbStr(19, 'gemini-4-neon-high'),
        );
        const gen = pbBytes(1, chat);
        con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
      } finally {
        con.close();
      }

      const snap = buildSnapshot(dbPath);
      const secs = new Map(snap.content.system_sections.map((s) => [`${s.group_type}:${s.name}`, s.tokens]));
      assert.equal(secs.get('1:overview'), 100);
      assert.equal(secs.get('3:overview'), 350);

      const m0 = snap.content.messages[0];
      assert.equal(m0.step_index, 0);
      assert.equal(m0.step_type, 'USER_INPUT');
      assert.equal(m0.tokens, 222);
      assert.equal(m0.estimated, false);

      assert.equal(snap.content.tools[0].schema, hugeSchema);
      // Streaming makePreview on massive no-whitespace string
      const prev = makePreview('x'.repeat(200_000), 20);
      assert.equal(prev.length, 20);
      assert.equal(prev.endsWith('…'), true);
    });
  });

  it('test_malformed_wire_json_catalog_and_db_cells', () => {
    withTempDir((tmpDir) => {
      // 1) Wrong wire types in extractTurnTelemetry (field 1/4/9 as varint)
      assert.equal(extractTurnTelemetry(pbVarint(1, 42)), null);
      assert.equal(
        extractTurnTelemetry(pbBytes(1, concatBytes(pbVarint(4, 99), pbVarint(9, 7)))),
        null,
      );
      // Varint overflow inside gen_metadata blob stops cleanly without raising
      const badVarint = new Uint8Array(14);
      badVarint[0] = 0x08;
      badVarint.fill(0x80, 1, 13);
      badVarint[13] = 0x01;
      assert.equal(extractTurnTelemetry(badVarint), null);

      // 2) Non-dict JSON tool args in Step._rehydrate for read_file/view_file
      for (const badArgs of ['[1, 2, 3]', 'null', '42', '{not-json']) {
        const tc = concatBytes(pbStr(2, 'read_file'), pbStr(3, badArgs));
        const md = pbBytes(4, tc);
        const generic = pbBytes(2, pbStr(1, 'ok'));
        const pl = concatBytes(pbVarint(1, 132), pbVarint(4, 3), pbBytes(5, md), pbBytes(140, generic));
        const step = new Step(0, pl, 132, 3, md);
        assert.equal(step.type, 132);
        assert.equal(step.viewFileOverride, null);
      }

      // 3) compactionTokens skips aborted retry (out <= thinking) and reads earlier entry
      const retryGood = pbBytes(2, concatBytes(pbVarint(3, 500), pbVarint(9, 100))); // 400
      const retryAborted = pbBytes(2, concatBytes(pbVarint(3, 50), pbVarint(9, 50))); // 0 -> skip
      const ckMd = concatBytes(pbBytes(28, retryGood), pbBytes(28, retryAborted));
      const ckStep = new Step(0, concatBytes(pbVarint(1, 23), pbBytes(5, ckMd)), 23, 3, ckMd);
      assert.equal(compactionTokens(ckStep), 400);

      // 4) Malformed model-catalog.json shapes fall back safely
      const dbPath = buildFullConversationDb(tmpDir, '20202020-1111-2222-3333-444444444444');
      for (const badCatalog of [
        '["not-a-dict"]',
        '{"gemini-4-neon-high": "not-a-dict"}',
        '{"gemini-4-neon-high": {"maxTokens": "bad", "displayName": 123}}',
        '{broken json',
      ]) {
        const catFile = path.join(tmpDir, 'catalog.json');
        fs.writeFileSync(catFile, badCatalog, 'utf8');
        const snap = buildSnapshot(dbPath, null, catFile).summary;
        assert.equal(snap.limit_tokens, 1_048_576);
        assert.equal(snap.model, 'Gemini 4 Neon (High)');
      }

      // 5) Non-bytes DB cells and >25 trailing content-less gen rows don't evict latestContent
      const con = new DatabaseSync(dbPath);
      try {
        con.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (1, 'not-bytes', 9)").run();
        con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, 12345, 5)').run();
        const minimalUsage = pbBytes(
          1,
          concatBytes(
            pbBytes(4, concatBytes(pbVarint(2, 100), pbVarint(5, 500))),
            pbStr(19, 'gemini-4-neon-high'),
          ),
        );
        const ins = con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
        for (let i = 3; i < 35; i += 1) {
          ins.run(i, minimalUsage, minimalUsage.length);
        }
      } finally {
        con.close();
      }

      const { latestStats, latestContent, history } = loadDbWithHistory(dbPath);
      assert.notEqual(latestStats, null);
      assert.notEqual(latestContent, null);
      assert.equal(latestContent.msg(1).has(16), true);
      assert.equal(history.length, 33);
    });
  });
});
