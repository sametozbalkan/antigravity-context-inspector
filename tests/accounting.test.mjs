/**
 * Unit tests for token accounting, compaction, turn history, and cache drop detection (`lib/accounting.mjs`).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CAT_AGENT,
  CAT_SYSTEM,
  CAT_TOOL,
  CAT_USER,
  parseChatLabel,
} from '../sidecars/inspector/lib/accounting.mjs';
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

describe('TestAccounting', () => {
  it('test_exact_breakdown_content_and_subagents', () => {
    withTempDir((tmpDir) => {
      const subId = '11111111-2222-3333-4444-555555555555';
      const mainId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      buildFullConversationDb(tmpDir, subId);
      const mainDb = buildFullConversationDb(tmpDir, mainId, subId);

      const snap = buildSnapshot(mainDb);
      const s = snap.summary;
      const c = snap.content;

      // Totals & model info
      assert.equal(s.model, 'Gemini 4 Neon (High)');
      assert.equal(s.limit_tokens, 1_048_576);
      assert.equal(s.request_budget_tokens, 512_000);
      assert.equal(s.used_tokens, 1200 + 800 + 600 + 400 + 2500);
      assert.equal(s.has_breakdown, true);

      // API cache hit ratio: 5000 / (500 + 5000) = 90.9%
      assert.ok(Math.abs(s.api_usage.cache_hit_pct - 90.9) < 0.05);

      // System sections
      assert.equal(c.system_sections.length, 3);
      const byName = Object.fromEntries(c.system_sections.map((x) => [x.name, x]));
      assert.equal(byName.identity.tokens, 300);
      assert.equal(byName.skills.group_type, 5);

      // Tools (built-in vs MCP)
      const toolsByName = Object.fromEntries(c.tools.map((x) => [x.name, x]));
      assert.equal(toolsByName.read_file.is_mcp, false);
      assert.equal(toolsByName.mcp_github_search.is_mcp, true);
      assert.equal(toolsByName.mcp_github_search.tokens, 400);

      // Messages & linked tool result
      assert.equal(c.messages.length, 3);
      assert.equal(c.messages[0].role, 'user');
      assert.equal(c.messages[1].has_thinking, true);
      assert.equal(c.messages[2].role, 'tool');
      assert.equal(c.messages[2].tool_name, 'read_file');

      // Subagent discovery
      assert.equal(s.subagents.length, 1);
      const sa = s.subagents[0];
      assert.equal(sa.conversation_id, subId);
      assert.equal(sa.role, 'Codebase Researcher');
      assert.equal(sa.used_tokens, 5500);
      assert.equal(sa.has_db, true);
    });
  });

  it('test_pre_generation_step_fallback', () => {
    withTempDir((tmpDir) => {
      const dbPath = path.join(tmpDir, 'bbbbbbbb-1111-2222-3333-444444444444.db');
      const con = createEmptyDb(dbPath);
      try {
        const uiPayload = pbStr(2, 'Hello Antigravity! '.repeat(20));
        const stepPl = concatBytes(pbVarint(1, 14), pbVarint(4, 3), pbBytes(19, uiPayload));
        con
          .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 14, 3, ?)')
          .run(stepPl);
      } finally {
        con.close();
      }

      const snap = buildSnapshot(dbPath);
      assert.equal(snap.summary.has_breakdown, false);
      assert.ok(snap.summary.used_tokens > 0);
      assert.equal(snap.content.messages.length, 1);
      assert.equal(snap.content.messages[0].role, 'user');
    });
  });

  it('test_turn_history_and_session_cache_drop', () => {
    withTempDir((tmpDir) => {
      const dbPath = path.join(tmpDir, '77777777-8888-9999-aaaa-bbbbbbbbbbbb.db');
      const con = createEmptyDb(dbPath);
      try {
        function insertTurn(idx, uncached, cached, outTok, thinkTok, ck = -1) {
          const usage = concatBytes(
            pbVarint(2, uncached),
            pbVarint(3, outTok),
            pbVarint(5, cached),
            pbVarint(9, thinkTok),
          );
          const chatStart = pbVarint(2, ck);
          const chat = concatBytes(pbBytes(4, usage), pbBytes(9, chatStart), pbStr(19, 'gemini-4-neon-high'));
          const gen = pbBytes(1, chat);
          con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(idx, gen, gen.length);
        }

        // Turn 1: cold (10k uncached, 0 cached)
        insertTurn(0, 10_000, 0, 500, 100, -1);
        // Turn 2: warm (2k uncached, 18k cached -> 90%, total 20k, delta +10k)
        insertTurn(1, 2_000, 18_000, 700, 200, -1);
        // Turn 3: warm (1.5k uncached, 28.5k cached -> 95%, total 30k, delta +10k)
        insertTurn(2, 1_500, 28_500, 800, 150, -1);
        // Turn 4: unexpected cache drop (34k uncached, 6k cached -> 15%, total 40k, delta +10k)
        insertTurn(3, 34_000, 6_000, 600, 50, -1);

        const snap = buildSnapshot(dbPath).summary;
        const hist = snap.history;
        const su = snap.session_usage;

        assert.equal(hist.length, 4);
        assert.deepEqual(hist.map((h) => h.tokens), [10_000, 20_000, 30_000, 40_000]);
        assert.deepEqual(hist.map((h) => h.delta), [0, 10_000, 10_000, 10_000]);
        assert.equal(su.turns, 4);
        assert.equal(su.total_output_tokens, 2600);
        assert.equal(su.total_thinking_tokens, 500);
        // Weighted avg excluding turn 1: (18000 + 28500 + 6000) / (20000 + 30000 + 40000) = 52500 / 90000 = 58.3%
        assert.ok(Math.abs(su.avg_cache_hit_pct - 58.3) < 0.05);
        assert.equal(su.cache_drop, true);
        assert.equal(su.cache_drop_after_compact, false);

        // Turn 5: post-compaction cold turn (ck=1, 15k total, 1.5k cached -> 10%, delta -25k)
        insertTurn(4, 13_500, 1_500, 400, 0, 1);
      } finally {
        con.close();
      }

      const snap2 = buildSnapshot(dbPath).summary;
      assert.equal(snap2.history.at(-1).compacted, true);
      assert.equal(snap2.history.at(-1).delta, -25_000);
      assert.equal(snap2.session_usage.cache_drop, false);
      assert.equal(snap2.session_usage.cache_drop_after_compact, true);
    });
  });

  it('test_non_caching_model_does_not_trigger_cache_drop', () => {
    withTempDir((tmpDir) => {
      const dbPath = path.join(tmpDir, '88888888-9999-aaaa-bbbb-cccccccccccc.db');
      const con = createEmptyDb(dbPath);
      try {
        for (let i = 0; i < 3; i += 1) {
          const usage = concatBytes(pbVarint(2, 5000 * (i + 1)), pbVarint(3, 200), pbVarint(5, 0));
          const gen = pbBytes(1, concatBytes(pbBytes(4, usage), pbStr(19, 'gpt-oss')));
          con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(i, gen, gen.length);
        }
      } finally {
        con.close();
      }

      const su = buildSnapshot(dbPath).summary.session_usage;
      assert.equal(su.avg_cache_hit_pct, 0.0);
      assert.equal(su.cache_drop, false);
    });
  });

  it('test_proto3_checkpoint_zero_compaction_and_cache_drop', () => {
    withTempDir((tmpDir) => {
      const dbPath = path.join(tmpDir, '10101010-1111-2222-3333-444444444444.db');
      const con = createEmptyDb(dbPath);
      try {
        function insertTurn(idx, uncached, cached, chatStartBytes) {
          const usage = concatBytes(pbVarint(2, uncached), pbVarint(3, 200), pbVarint(5, cached));
          const chat = concatBytes(
            pbBytes(4, usage),
            pbBytes(9, chatStartBytes),
            pbStr(19, 'gemini-4-neon-high'),
          );
          const gen = pbBytes(1, chat);
          con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(idx, gen, gen.length);
        }

        // Turns 1 & 2: pre-compaction (ck = -1 explicitly encoded), warm cache (90%)
        insertTurn(0, 10_000, 0, pbVarint(2, -1));
        insertTurn(1, 2_000, 18_000, pbVarint(2, -1));
        // Turn 3: first compaction (checkpoint = 0 -> omitted on wire in proto3!), cache drops to 10%
        const cwmOnly = pbBytes(10, pbVarint(4, 256_000));
        insertTurn(2, 9_000, 1_000, cwmOnly);
      } finally {
        con.close();
      }

      const snap = buildSnapshot(dbPath).summary;
      assert.equal(snap.history.at(-1).compacted, true);
      assert.equal(snap.session_usage.cache_drop, false);
      assert.equal(snap.session_usage.cache_drop_after_compact, true);
    });
  });

  it('test_system_overhead_no_double_counting_and_proportional_fallback', () => {
    withTempDir((tmpDir) => {
      // Case A: system_overhead subtracts rules/skills so total == api_input
      const dbPath = path.join(tmpDir, '30303030-1111-2222-3333-444444444444.db');
      const con = createEmptyDb(dbPath);
      try {
        const breakdown = concatBytes(
          pbBytes(1, makeGroup(3, 'Rules', 1000, [['r1', 1000]])),
          pbBytes(1, makeGroup(5, 'Skills', 500, [['s1', 500]])),
          pbBytes(
            1,
            makeGroup(7, 'Chat Messages', 4000, [
              ['0: USER_INPUT', 1500],
              ['1: PLANNER_RESPONSE', 2500],
            ]),
          ),
        );
        const cwm = pbBytes(3, breakdown);
        const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, cwm));
        const usage = concatBytes(pbVarint(2, 2000), pbVarint(5, 8000)); // total api_input = 10_000
        const chat = concatBytes(pbBytes(4, usage), pbBytes(9, chatStart), pbStr(19, 'gemini-4-neon-high'));
        const gen = pbBytes(1, chat);
        con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
      } finally {
        con.close();
      }

      const snap = buildSnapshot(dbPath).summary;
      const cats = Object.fromEntries(snap.categories.map((c) => [c.key, c.tokens]));
      assert.equal(cats.system_overhead, 4500);
      assert.equal(snap.used_tokens, 10_000);

      // Case B: proportional fallback includes and scales system_messages
      const dbProp = path.join(tmpDir, '31313131-1111-2222-3333-444444444444.db');
      const conProp = createEmptyDb(dbProp);
      try {
        // User step: 100 tokens via metadata usage[3]; System step (101): 100 tokens via metadata usage[3]
        const uMd = pbBytes(9, pbVarint(3, 100));
        const sMd = pbBytes(9, pbVarint(3, 100));
        conProp
          .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (0, 14, 3, ?, ?)')
          .run(uMd, concatBytes(pbVarint(1, 14), pbVarint(4, 3), pbBytes(5, uMd)));
        conProp
          .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 101, 3, ?, ?)')
          .run(sMd, concatBytes(pbVarint(1, 101), pbVarint(4, 3), pbBytes(5, sMd)));
        // Unparseable chat items trigger proportional scaling to chat_tok = 1000
        const bdProp = pbBytes(1, makeGroup(7, 'Chat Messages', 1000, [['bad-label', 1000]]));
        const genProp = pbBytes(1, pbBytes(9, concatBytes(pbVarint(2, -1), pbBytes(10, pbBytes(3, bdProp)))));
        conProp
          .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)')
          .run(genProp, genProp.length);
      } finally {
        conProp.close();
      }

      const snapProp = buildSnapshot(dbProp).summary;
      const catsProp = Object.fromEntries(snapProp.categories.map((c) => [c.key, c.tokens]));
      assert.equal(catsProp.user, 500);
      assert.equal(catsProp.system_messages, 500);
      assert.equal(snapProp.used_tokens, 1000);
    });
  });

  it('test_unknown_breakdown_group_counts_as_system_prompt', () => {
    withTempDir((tmpDir) => {
      // Case A: type 0 "Unspecified" group (Identity) next to a real system prompt group
      const dbPath = path.join(tmpDir, '40404040-1111-2222-3333-444444444444.db');
      const con = createEmptyDb(dbPath);
      try {
        const breakdown = concatBytes(
          pbBytes(1, makeGroup(0, 'Unspecified', 199, [['Identity', 199]])),
          pbBytes(
            1,
            makeGroup(1, 'System Prompt', 1457, [
              ['user_information', 220],
              ['artifacts', 1237],
            ]),
          ),
          pbBytes(1, makeGroup(7, 'Chat Messages', 300, [['0: USER_INPUT', 300]])),
        );
        const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, pbBytes(3, breakdown)));
        // The Identity section carries no group type of its own (field 6 omitted);
        // its 720-byte body would estimate to 180 tokens, not the exact 199.
        const secIdentity = concatBytes(pbStr(1, 'Identity'), pbStr(2, 'You are an agent. '.repeat(40)));
        const secInfo = concatBytes(pbStr(1, 'user_information'), pbStr(2, 'OS: test'), pbVarint(6, 1));
        const secArtifacts = concatBytes(pbStr(1, 'artifacts'), pbStr(2, 'Artifact rules'), pbVarint(6, 1));
        const chat = concatBytes(
          pbBytes(9, chatStart),
          pbBytes(16, secIdentity),
          pbBytes(16, secInfo),
          pbBytes(16, secArtifacts),
          pbStr(19, 'gemini-4-neon-high'),
        );
        const gen = pbBytes(1, chat);
        con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
      } finally {
        con.close();
      }

      const snap = buildSnapshot(dbPath);
      const cats = Object.fromEntries(snap.summary.categories.map((c) => [c.key, c.tokens]));
      assert.equal(cats.system_prompt, 199 + 1457);
      assert.equal(snap.summary.used_tokens, 199 + 1457 + 300);

      // Drill-down uses the exact breakdown value and adds up to the row total
      const secs = snap.content.system_sections;
      const identity = secs.find((s) => s.name === 'Identity');
      assert.equal(identity.group_type, 1);
      assert.equal(identity.tokens, 199);
      assert.equal(identity.estimated, false);
      const promptChildren = secs
        .filter((s) => s.group_type === 1)
        .reduce((sum, s) => sum + s.tokens, 0);
      assert.equal(promptChildren, cats.system_prompt);

      // Case B: no real prompt/tools group -> the overhead estimate must not double count it
      const dbOverhead = path.join(tmpDir, '41414141-1111-2222-3333-444444444444.db');
      const conOverhead = createEmptyDb(dbOverhead);
      try {
        const breakdown = concatBytes(
          pbBytes(1, makeGroup(0, 'Unspecified', 199, [['Identity', 199]])),
          pbBytes(1, makeGroup(3, 'Rules', 1000, [['r1', 1000]])),
          pbBytes(
            1,
            makeGroup(7, 'Chat Messages', 4000, [
              ['0: USER_INPUT', 1500],
              ['1: PLANNER_RESPONSE', 2500],
            ]),
          ),
        );
        const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, pbBytes(3, breakdown)));
        const usage = concatBytes(pbVarint(2, 2000), pbVarint(5, 8000)); // total api_input = 10_000
        const chat = concatBytes(pbBytes(4, usage), pbBytes(9, chatStart), pbStr(19, 'gemini-4-neon-high'));
        const gen = pbBytes(1, chat);
        conOverhead
          .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)')
          .run(gen, gen.length);
      } finally {
        conOverhead.close();
      }

      const snapOverhead = buildSnapshot(dbOverhead).summary;
      const catsOverhead = Object.fromEntries(snapOverhead.categories.map((c) => [c.key, c.tokens]));
      assert.equal(catsOverhead.system_prompt, 199);
      assert.equal(catsOverhead.system_overhead, 10_000 - 4000 - 1000 - 199);
      assert.equal(snapOverhead.used_tokens, 10_000);
    });
  });

  it('test_chat_label_formats_and_unknown_step_types', () => {
    // parseChatLabel: both label formats, unknown names and rejects
    assert.deepEqual(parseChatLabel('12: USER_INPUT'), {
      key: 'step',
      index: 12,
      name: 'USER_INPUT',
      cat: CAT_USER,
    });
    assert.equal(parseChatLabel('3: SYSTEM_MESSAGE').cat, CAT_SYSTEM);
    assert.equal(parseChatLabel('4: BRAND_NEW_TOOL').cat, CAT_TOOL);
    assert.deepEqual(parseChatLabel('Message 7 (CHAT_MESSAGE_SOURCE_SYSTEM)'), {
      key: 'message',
      index: 7,
      name: 'SYSTEM',
      cat: CAT_AGENT,
    });
    assert.equal(parseChatLabel('Message 0 (CHAT_MESSAGE_SOURCE_USER)').cat, CAT_USER);
    assert.equal(parseChatLabel('Message 2 (CHAT_MESSAGE_SOURCE_TOOL)').cat, CAT_TOOL);
    assert.equal(parseChatLabel('Message 9 (CHAT_MESSAGE_SOURCE_UNKNOWN)').cat, CAT_SYSTEM);
    for (const bad of ['bad-label', 'x: USER_INPUT', '5: ', 'Message 3', 'Message x (CHAT_MESSAGE_SOURCE_USER)', '']) {
      assert.equal(parseChatLabel(bad), null);
    }

    withTempDir((tmpDir) => {
      function insertGen(dbPath, chatChildren, messages) {
        const con = createEmptyDb(dbPath);
        try {
          const total = chatChildren.reduce((sum, [, tok]) => sum + tok, 0);
          const breakdown = pbBytes(1, makeGroup(7, 'Chat Messages', total, chatChildren));
          const chatStart = concatBytes(pbVarint(2, -1), pbBytes(10, pbBytes(3, breakdown)));
          const chat = concatBytes(
            ...messages.map((m) => pbBytes(2, m)),
            pbBytes(9, chatStart),
            pbStr(19, 'gemini-4-neon-high'),
          );
          const gen = pbBytes(1, chat);
          con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gen, gen.length);
        } finally {
          con.close();
        }
      }

      // Case A: "Message <n> (CHAT_MESSAGE_SOURCE_<NAME>)" labels keyed by message index.
      // Messages carry no token counts of their own, so tokens must come from the labels.
      const dbMsgLabels = path.join(tmpDir, '60606060-1111-2222-3333-444444444444.db');
      insertGen(
        dbMsgLabels,
        [
          ['Message 0 (CHAT_MESSAGE_SOURCE_USER)', 135],
          ['Message 1 (CHAT_MESSAGE_SOURCE_SYSTEM)', 233],
          ['Message 2 (CHAT_MESSAGE_SOURCE_TOOL)', 1170],
        ],
        [
          concatBytes(pbVarint(2, 1), pbStr(3, 'Summarize the repo')),
          concatBytes(pbVarint(2, 2), pbStr(3, 'Reading files'), pbVarint(18, 2)),
          concatBytes(pbVarint(2, 4), pbStr(3, 'file contents'), pbVarint(18, 3)),
        ],
      );
      const snapMsg = buildSnapshot(dbMsgLabels);
      const catsMsg = Object.fromEntries(snapMsg.summary.categories.map((c) => [c.key, c.tokens]));
      assert.equal(catsMsg.user, 135);
      assert.equal(catsMsg.agent, 233);
      assert.equal(catsMsg.tool, 1170);
      assert.equal(snapMsg.summary.used_tokens, 1538);
      assert.deepEqual(snapMsg.content.messages.map((m) => m.tokens), [135, 233, 1170]);
      assert.deepEqual(snapMsg.content.messages.map((m) => m.category), ['user', 'agent', 'tool']);
      assert.deepEqual(snapMsg.content.messages.map((m) => m.estimated), [false, false, false]);

      // Case B: one step type name this parser has never seen counts as a tool;
      // the other rows stay exact instead of falling back to proportional scaling.
      const dbUnknown = path.join(tmpDir, '61616161-1111-2222-3333-444444444444.db');
      insertGen(
        dbUnknown,
        [
          ['0: USER_INPUT', 100],
          ['1: PLANNER_RESPONSE', 200],
          ['2: BRAND_NEW_TOOL', 400],
        ],
        [],
      );
      const catsUnknown = Object.fromEntries(
        buildSnapshot(dbUnknown).summary.categories.map((c) => [c.key, c.tokens]),
      );
      assert.equal(catsUnknown.user, 100);
      assert.equal(catsUnknown.agent, 200);
      assert.equal(catsUnknown.tool, 400);
    });
  });
});
