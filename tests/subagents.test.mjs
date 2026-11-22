/**
 * Unit tests for subagent and Swarm worker discovery and stats (`lib/subagents.mjs`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { Step } from '../sidecars/inspector/lib/accounting.mjs';
import { buildSnapshot } from '../sidecars/inspector/lib/snapshot.mjs';
import { extractSubagentId, quickSubagentStats } from '../sidecars/inspector/lib/subagents.mjs';
import {
  buildFullConversationDb,
  concatBytes,
  createEmptyDb,
  pbBytes,
  pbStr,
  pbVarint,
  withTempDir,
} from './helpers.mjs';

describe('TestSubagents', () => {
  it('test_subagent_rehydrated_and_native_step_types', () => {
    withTempDir((tmpDir) => {
      const subRehydrated = '22222222-3333-4444-5555-666666666666';
      const subNative = '33333333-4444-5555-6666-777777777777';
      const mainId = 'eeeeeeee-1111-2222-3333-444444444444';

      buildFullConversationDb(tmpDir, subRehydrated);
      buildFullConversationDb(tmpDir, subNative);

      const dbPath = path.join(tmpDir, `${mainId}.db`);
      const con = createEmptyDb(dbPath);
      try {
        // 1) GENERIC step that rehydrates into step_type=127 via packed original step
        const tc1 = concatBytes(
          pbStr(2, 'invoke_subagent'),
          pbStr(3, JSON.stringify({ Role: 'Rehydrated Worker', TypeName: 'research' })),
        );
        const md1 = pbBytes(4, tc1);
        const origStep = concatBytes(pbVarint(1, 127), pbVarint(4, 3), pbBytes(5, md1));
        const packedAny = concatBytes(
          pbStr(1, 'type.googleapis.com/gemini_coder.Step'),
          pbBytes(2, origStep),
        );
        const genericRes = concatBytes(
          pbStr(1, `{"conversationId": "${subRehydrated}"}`),
          pbBytes(6, packedAny),
        );
        const step1Pl = concatBytes(
          pbVarint(1, 132),
          pbVarint(4, 3),
          pbBytes(5, md1),
          pbBytes(140, pbBytes(2, genericRes)),
        );
        con
          .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (0, 132, 3, ?, ?)')
          .run(md1, step1Pl);

        // 2) Native INVOKE_SUBAGENT (step_type=127) without STEP_GENERIC wrapper
        const tc2 = concatBytes(
          pbStr(2, 'invoke_subagent'),
          pbStr(3, JSON.stringify({ Role: 'Native Worker', TypeName: 'browser' })),
        );
        const md2 = pbBytes(4, tc2);
        const nativePayload = pbStr(1, subNative);
        const step2Pl = concatBytes(
          pbVarint(1, 127),
          pbVarint(4, 3),
          pbBytes(5, md2),
          pbBytes(130, nativePayload),
        );
        con
          .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 127, 3, ?, ?)')
          .run(md2, step2Pl);
      } finally {
        con.close();
      }

      const snap = buildSnapshot(dbPath);
      const subs = Object.fromEntries(snap.summary.subagents.map((sa) => [sa.conversation_id, sa]));
      assert.ok(Object.hasOwn(subs, subRehydrated));
      assert.equal(subs[subRehydrated].role, 'Rehydrated Worker');
      assert.ok(Object.hasOwn(subs, subNative));
      assert.equal(subs[subNative].role, 'Native Worker');
    });
  });

  it('test_quick_subagent_stats_compaction_and_null_gen_row', () => {
    withTempDir((tmpDir) => {
      const subId = '44444444-5555-6666-7777-888888888888';
      const mainId = 'ffffffff-1111-2222-3333-444444444444';

      const subDb = buildFullConversationDb(tmpDir, subId);
      const con = new DatabaseSync(subDb);
      try {
        // Add a trailing NULL gen_metadata row and a completed compaction checkpoint newer than gen_ck=-1
        con.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, NULL, 0)').run();
        const ckPayload = concatBytes(pbVarint(1, 1), pbStr(4, 'Short compacted summary.'));
        const ckStep = concatBytes(pbVarint(1, 23), pbVarint(4, 3), pbBytes(30, ckPayload));
        con
          .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (10, 23, 3, ?)')
          .run(ckStep);
        const uiStep = concatBytes(
          pbVarint(1, 14),
          pbVarint(4, 3),
          pbBytes(19, pbStr(2, 'Continue after compact')),
        );
        con
          .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (11, 14, 3, ?)')
          .run(uiStep);
      } finally {
        con.close();
      }

      const mainDb = buildFullConversationDb(tmpDir, mainId, subId);
      const fullSub = buildSnapshot(subDb).summary;
      const mainSnap = buildSnapshot(mainDb).summary;
      const sa = mainSnap.subagents[0];

      assert.equal(fullSub.compacted, true);
      assert.equal(sa.used_tokens, fullSub.used_tokens);
      assert.ok(sa.used_tokens < 5500);
    });
  });

  it('test_quick_subagent_stats_without_breakdown', () => {
    withTempDir((tmpDir) => {
      const subDb = path.join(tmpDir, '40404040-1111-2222-3333-444444444444.db');
      const con = createEmptyDb(subDb);
      try {
        // Steps with text/tokens, plus a gen_metadata record that has NO breakdown
        const uiPl = concatBytes(
          pbVarint(1, 14),
          pbVarint(4, 3),
          pbBytes(19, pbStr(2, 'Analyze module '.repeat(40))),
        );
        con.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 14, 3, ?)').run(uiPl);
        const genNoBd = pbBytes(1, concatBytes(pbBytes(4, pbVarint(2, 500)), pbStr(19, 'gemini-4-neon-high')));
        con
          .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)')
          .run(genNoBd, genNoBd.length);
      } finally {
        con.close();
      }

      const full = buildSnapshot(subDb).summary;
      const quick = quickSubagentStats(subDb, { 'gemini-4-neon-high': { maxTokens: 'invalid' } });
      assert.notEqual(quick, null);
      assert.ok(quick.used_tokens > 0);
      assert.equal(quick.used_tokens, full.used_tokens);
      assert.equal(quick.limit_tokens, 1_048_576);
    });
  });

  it('test_quick_subagent_running_status_detection', () => {
    withTempDir((tmpDir) => {
      // 1) Parallel tool calls: earlier step status=2 (running) while latest step status=3 (done)
      const dbParallel = path.join(tmpDir, 'f1111111-1111-2222-3333-444444444444.db');
      const con1 = createEmptyDb(dbParallel);
      try {
        con1.prepare('INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)').run();
        con1.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 132, 2)').run();
        con1.prepare('INSERT INTO steps (idx, step_type, status) VALUES (2, 132, 3)').run();
      } finally {
        con1.close();
      }
      assert.equal(quickSubagentStats(dbParallel, {}).status, 'running');

      // 2) Thinking phase: last step is recently completed tool call (step_type=132, status=3)
      const dbThinking = path.join(tmpDir, 'f2222222-1111-2222-3333-444444444444.db');
      const con2 = createEmptyDb(dbThinking);
      try {
        con2.prepare('INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)').run();
        con2.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 132, 3)').run();
      } finally {
        con2.close();
      }
      assert.equal(quickSubagentStats(dbThinking, {}).status, 'running');

      // 3) Stale abandoned subagent (>3 min old non-terminal step) -> idle
      const oldDate = new Date(Date.now() - 600_000);
      fs.utimesSync(dbThinking, oldDate, oldDate);
      assert.equal(quickSubagentStats(dbThinking, {}).status, 'idle');

      // 4) Completed turn ending with PLANNER_RESPONSE (step_type=15, status=3) -> idle
      const dbDone = path.join(tmpDir, 'f3333333-1111-2222-3333-444444444444.db');
      const con3 = createEmptyDb(dbDone);
      try {
        con3.prepare('INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)').run();
        con3.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 15, 3)').run();
      } finally {
        con3.close();
      }
      assert.equal(quickSubagentStats(dbDone, {}).status, 'idle');
    });
  });

  it('test_swarm_members_discovery', () => {
    withTempDir((tmpDir) => {
      const appRoot = path.join(tmpDir, 'antigravity');
      const convDir = path.join(appRoot, 'conversations');
      fs.mkdirSync(convDir, { recursive: true });

      const mainId = '12121212-3434-5656-7878-909090909090';
      const workerActive = 'abababab-1111-2222-3333-444444444444';
      const workerKilled = 'cdcdcdcd-1111-2222-3333-444444444444';

      for (const cid of [mainId, workerActive, workerKilled]) {
        const src = buildFullConversationDb(tmpDir, cid);
        fs.copyFileSync(src, path.join(convDir, `${cid}.db`));
      }

      const membersPath = path.join(appRoot, 'brain', mainId, '.system_generated', 'swarm', 'members.json');
      fs.mkdirSync(path.dirname(membersPath), { recursive: true });
      fs.writeFileSync(
        membersPath,
        JSON.stringify({
          members: [
            {
              name: 'backend-1',
              conversationId: workerActive,
              model: 'Gemini 4 Neon (High)',
              state: 'working',
            },
            {
              name: 'reviewer-1',
              conversation_id: workerKilled,
              model: 'Claude Sonnet 4',
              state: 'killed',
            },
          ],
        }),
        'utf8',
      );

      const snap = buildSnapshot(path.join(convDir, `${mainId}.db`)).summary;
      const byId = Object.fromEntries(snap.subagents.map((sa) => [sa.conversation_id, sa]));
      assert.equal(Object.keys(byId).length, 2);
      assert.equal(byId[workerActive].source, 'swarm');
      assert.equal(byId[workerActive].role, 'backend-1');
      assert.equal(byId[workerActive].status, 'running');
      assert.equal(byId[workerActive].used_tokens, 5500);
      assert.equal(byId[workerKilled].source, 'swarm');
      assert.equal(byId[workerKilled].status, 'killed');
    });
  });

  it('test_relative_db_swarm_and_rehydrate_outer_md_and_self_id_skip', () => {
    withTempDir((tmpDir) => {
      const appRoot = path.join(tmpDir, 'rel_app');
      const convDir = path.join(appRoot, 'conversations');
      fs.mkdirSync(convDir, { recursive: true });

      const mainId = '60606060-1111-2222-3333-444444444444';
      const workerId = '61616161-1111-2222-3333-444444444444';
      const subId = '62626262-1111-2222-3333-444444444444';

      for (const cid of [mainId, workerId, subId]) {
        const src = buildFullConversationDb(tmpDir, cid);
        fs.copyFileSync(src, path.join(convDir, `${cid}.db`));
      }

      // Rehydrated step where packed original step omits field 5 (metadata)
      // and genericResultText lists selfId before child subId
      const tc = concatBytes(
        pbStr(2, 'invoke_subagent'),
        pbStr(3, JSON.stringify({ Role: 'Preserved Role', TypeName: 'research' })),
      );
      const outerMd = pbBytes(4, tc);
      const origWithoutMd = concatBytes(pbVarint(1, 127), pbVarint(4, 3));
      const packed = concatBytes(
        pbStr(1, 'type.googleapis.com/gemini_coder.Step'),
        pbBytes(2, origWithoutMd),
      );
      const resText = `{"conversationId": "${mainId}"} -> {"conversationId": "${subId}"}`;
      const genericRes = concatBytes(pbStr(1, resText), pbBytes(6, packed));
      const stepPl = concatBytes(
        pbVarint(1, 132),
        pbVarint(4, 3),
        pbBytes(5, outerMd),
        pbBytes(140, pbBytes(2, genericRes)),
      );

      const stepObj = new Step(0, stepPl, 132, 3, outerMd);
      assert.equal(stepObj.md.msg(4).str(2), 'invoke_subagent');
      assert.equal(extractSubagentId(stepObj, mainId), subId);

      const con = new DatabaseSync(path.join(convDir, `${mainId}.db`));
      try {
        con
          .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (5, 132, 3, ?, ?)')
          .run(outerMd, stepPl);
      } finally {
        con.close();
      }

      const membersPath = path.join(appRoot, 'brain', mainId, '.system_generated', 'swarm', 'members.json');
      fs.mkdirSync(path.dirname(membersPath), { recursive: true });
      fs.writeFileSync(
        membersPath,
        JSON.stringify({ members: [{ name: 'rel-worker', conversationId: workerId, state: 'working' }] }),
        'utf8',
      );

      const oldCwd = process.cwd();
      let snap;
      try {
        process.chdir(convDir);
        snap = buildSnapshot(`${mainId}.db`).summary;
      } finally {
        process.chdir(oldCwd);
      }

      const byId = Object.fromEntries(snap.subagents.map((sa) => [sa.conversation_id, sa]));
      assert.ok(Object.hasOwn(byId, workerId));
      assert.equal(byId[workerId].role, 'rel-worker');
      assert.ok(Object.hasOwn(byId, subId));
      assert.equal(byId[subId].role, 'Preserved Role');
    });
  });
});
