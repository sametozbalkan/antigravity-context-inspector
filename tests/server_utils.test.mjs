/**
 * Unit tests for the sidecar server's pure helpers (`lib/server_utils.mjs`): light report index,
 * workspace URI validation, settings sanitization, and version comparison.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_SETTINGS,
  buildLightReport,
  compareSemver,
  mergeSettings,
  sanitizeSettings,
  workspacePath,
} from '../sidecars/inspector/lib/server_utils.mjs';
import { buildSnapshot } from '../sidecars/inspector/lib/snapshot.mjs';
import { buildFullConversationDb, withTempDir } from './helpers.mjs';

describe('TestServerUtils', () => {
  it('test_buildLightReport_keeps_index_fields_and_drops_bodies', () => {
    withTempDir((tmpDir) => {
      const dbPath = buildFullConversationDb(tmpDir, '90909090-1111-2222-3333-444444444444');
      const snapshot = buildSnapshot(dbPath);
      const report = buildLightReport(snapshot, '2026-01-02T03:04:05.000Z');

      assert.deepEqual(Object.keys(report).sort(), ['index', 'summary', 'updatedAt']);
      assert.equal(report.summary, snapshot.summary);
      assert.equal(report.updatedAt, '2026-01-02T03:04:05.000Z');

      // Exactly the fields the panel reads; item bodies stay behind GET /api/item
      const { system_sections: sections, tools, messages } = report.index;
      assert.deepEqual(Object.keys(sections[0]).sort(), [
        'chars', 'group', 'group_type', 'id', 'kind', 'name', 'preview', 'tokens',
      ]);
      assert.deepEqual(Object.keys(tools[0]).sort(), [
        'chars', 'id', 'is_mcp', 'kind', 'mcp_server', 'name', 'preview', 'tokens',
      ]);
      assert.deepEqual(Object.keys(messages[0]).sort(), [
        'category', 'chars', 'has_thinking', 'id', 'index', 'kind', 'label', 'preview',
        'role', 'tokens', 'tool_call_count', 'tool_name',
      ]);

      // One index entry per content item, in the same order
      assert.deepEqual(sections.map((s) => s.id), snapshot.content.system_sections.map((s) => s.id));
      assert.deepEqual(tools.map((t) => t.id), snapshot.content.tools.map((t) => t.id));
      assert.deepEqual(messages.map((m) => m.id), snapshot.content.messages.map((m) => m.id));

      // `category` drives the panel's row grouping (role is only its fallback)
      assert.deepEqual(messages.map((m) => m.category), ['user', 'agent', 'tool']);
      assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool']);

      const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));
      assert.equal(toolsByName.read_file.mcp_server, '');
      assert.equal(toolsByName.mcp_github_search.mcp_server, 'github');
    });
  });

  it('test_workspacePath_accepts_only_local_absolute_paths', () => {
    const dir = path.resolve(os.tmpdir());
    assert.equal(workspacePath(dir), dir);
    assert.equal(workspacePath(pathToFileURL(dir).href), dir);
    // "file://localhost/..." names the same local path
    assert.equal(workspacePath(`file://localhost${pathToFileURL(dir).pathname}`), dir);

    const rejected = [
      '',
      null,
      undefined,
      42,
      {},
      'relative/dir',
      '--flag',
      '-x',
      '\\\\server\\share\\dir',
      '//server/share/dir',
      'file://evil-host/share/dir',
      'file:///%00',
      `${dir}\0`,
      'vscode-remote://ssh-remote/home/x',
      'https://example.com/x',
    ];
    for (const bad of rejected) {
      assert.equal(workspacePath(bad), '', JSON.stringify(bad));
    }
  });

  it('test_sanitizeSettings_and_mergeSettings', () => {
    // Anything that is not a settings object yields the defaults
    for (const raw of [undefined, null, 'nope', 42, []]) {
      assert.deepEqual(sanitizeSettings(raw), DEFAULT_SETTINGS);
    }

    // compactThreshold: only 0/50/60/75, as numbers or exact strings
    for (const ok of [0, 50, 60, 75]) {
      assert.equal(sanitizeSettings({ compactThreshold: ok }).compactThreshold, ok);
      assert.equal(sanitizeSettings({ compactThreshold: String(ok) }).compactThreshold, ok);
    }
    for (const bad of [55, -1, 100, '60.0', ' 60', '6e1', true, null, NaN, Infinity, {}, [60]]) {
      assert.equal(sanitizeSettings({ compactThreshold: bad }).compactThreshold, 60);
    }

    // Enumerated fields fall back to their defaults
    assert.equal(sanitizeSettings({ displayMode: 'budget' }).displayMode, 'budget');
    assert.equal(sanitizeSettings({ displayMode: 'BUDGET' }).displayMode, 'native');
    assert.equal(sanitizeSettings({ compactAction: 'copy' }).compactAction, 'copy');
    assert.equal(sanitizeSettings({ compactAction: 'delete-everything' }).compactAction, 'send');

    // Unknown keys never survive
    assert.deepEqual(Object.keys(sanitizeSettings({ extra: 1, compactAction: 'copy' })).sort(), [
      'compactAction',
      'compactThreshold',
      'displayMode',
    ]);

    // mergeSettings applies a patch on top of the current settings
    const current = { compactThreshold: 75, displayMode: 'budget', compactAction: 'copy' };
    assert.deepEqual(mergeSettings(current, { compactThreshold: 0 }), {
      compactThreshold: 0,
      displayMode: 'budget',
      compactAction: 'copy',
    });
    // Undefined values and non-object patches leave the settings as they are
    assert.deepEqual(mergeSettings(current, { displayMode: undefined }), current);
    for (const patch of [null, undefined, 'x', 5, ['budget']]) {
      assert.deepEqual(mergeSettings(current, patch), current);
    }
    // An invalid value resets that field to its default
    assert.deepEqual(mergeSettings(current, { compactThreshold: 55, displayMode: 'weird' }), {
      compactThreshold: 60,
      displayMode: 'native',
      compactAction: 'copy',
    });
    // Inputs are not mutated
    assert.deepEqual(current, { compactThreshold: 75, displayMode: 'budget', compactAction: 'copy' });
    assert.deepEqual(DEFAULT_SETTINGS, { compactThreshold: 60, displayMode: 'native', compactAction: 'send' });
  });

  it('test_compareSemver_orders_versions_numerically', () => {
    assert.equal(compareSemver('1.2.0', '1.2.0'), 0);
    assert.equal(compareSemver('v1.2.0', '1.2.0'), 0);
    assert.ok(compareSemver('1.10.0', '1.9.9') > 0);
    assert.ok(compareSemver('2.0.0', '10.0.0') < 0);
    assert.ok(compareSemver('1.2.1', '1.2') > 0);
    assert.ok(compareSemver('1.2', '1.2.1') < 0);
    // Missing or unparseable versions count as 0
    assert.ok(compareSemver('', '0.0.1') < 0);
    assert.ok(compareSemver(null, '1.0.0') < 0);
    assert.equal(compareSemver('garbage', '0'), 0);
  });
});
