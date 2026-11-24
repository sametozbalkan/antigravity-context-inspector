/**
 * Unit tests for frontend pure helpers, sparkline math/rendering, and view templates
 * (`sidecars/inspector/public/js/{utils,sparkline,views}.js`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { INSPECTOR_DIR } from './helpers.mjs';

function loadFrontendModules() {
  const publicDir = path.join(INSPECTOR_DIR, 'public');
  const parts = ['js/utils.js', 'js/sparkline.js', 'js/views.js'].map((rel) =>
    fs.readFileSync(path.join(publicDir, rel), 'utf8'),
  );
  const bundle = `(() => {\n'use strict';\nconst __CI = {};\n${parts.join('\n')}\nreturn __CI;\n})();\n`;
  const sandbox = { URL };
  return vm.runInNewContext(bundle, sandbox, { filename: 'public/js/bundle.js' });
}

const CI = loadFrontendModules();
const {
  DEFAULT_RELEASES_URL,
  esc,
  fmtTok,
  itemCopyBody,
  safeReleaseUrl,
  splitPath,
} = CI.utils;
const { computeSparkCoords, renderSparkline } = CI.sparkline;
const { categoryItems, renderCompactControl, renderMcpServerChildren } = CI.views;

describe('TestFrontendUtils', () => {
  it('test_esc_escapes_html_and_xss_payloads', () => {
    assert.equal(esc('<script>alert("x" & \'y\')</script>'), '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(42), '42');
    assert.equal(esc('plain text'), 'plain text');
  });

  it('test_safeReleaseUrl_allows_https_and_rejects_unsafe_or_invalid', () => {
    const valid = 'https://github.com/sametozbalkan/antigravity-context-inspector/releases/tag/v1.0.0';
    assert.equal(safeReleaseUrl(valid), valid);
    assert.equal(safeReleaseUrl('javascript:alert(1)'), DEFAULT_RELEASES_URL);
    assert.equal(safeReleaseUrl('http://example.com/releases'), DEFAULT_RELEASES_URL);
    assert.equal(safeReleaseUrl('data:text/html,<h1>x</h1>'), DEFAULT_RELEASES_URL);
    assert.equal(safeReleaseUrl('not a url'), DEFAULT_RELEASES_URL);
    assert.equal(safeReleaseUrl(''), DEFAULT_RELEASES_URL);
    assert.equal(safeReleaseUrl(null), DEFAULT_RELEASES_URL);
  });

  it('test_fmtTok_formats_units_k_and_M', () => {
    assert.equal(fmtTok(0), '0');
    assert.equal(fmtTok(999), '999');
    assert.equal(fmtTok(1000), '1.0k');
    assert.equal(fmtTok(12_345), '12.3k');
    assert.equal(fmtTok(1_000_000), '1M');
    assert.equal(fmtTok(2_000_000), '2M');
    assert.equal(fmtTok(1_048_576), '1.0M');
    assert.equal(fmtTok(1_550_000), '1.6M');
    assert.equal(fmtTok(null), '0');
  });

  it('test_splitPath_normal_directory_and_brain_cid_substitution', () => {
    const cid = '11111111-2222-3333-4444-555555555555';

    // Normal file path
    assert.deepEqual({ ...splitPath('~/projects/app/main.mjs') }, {
      name: 'main.mjs',
      dir: '~/projects/app',
    });

    // Directory path preserves trailing slash on name
    assert.deepEqual({ ...splitPath('~/.gemini/skills/') }, {
      name: 'skills/',
      dir: '~/.gemini',
    });

    // Top-level filename with no directory
    assert.deepEqual({ ...splitPath('README.md') }, {
      name: 'README.md',
      dir: '',
    });

    // Direct /brain/<cid> file
    assert.deepEqual(
      { ...splitPath(`~/.gemini/antigravity/brain/${cid}/task.md`, cid) },
      { name: 'task.md', dir: 'conversation folder' },
    );

    // Nested subdirectory inside /brain/<cid>/
    assert.deepEqual(
      { ...splitPath(`~/.gemini/antigravity/brain/${cid}/scratch/notes.md`, cid) },
      { name: 'notes.md', dir: 'conversation folder/scratch' },
    );

    // Prefix collision (/brain/<cid>2) must not substitute
    assert.deepEqual(
      { ...splitPath(`~/.gemini/antigravity/brain/${cid}2/task.md`, cid) },
      { name: 'task.md', dir: `~/.gemini/antigravity/brain/${cid}2` },
    );
  });

  it('test_itemCopyBody_formats_system_tool_and_message_items', () => {
    assert.equal(itemCopyBody('system', { content: 'System prompt' }), 'System prompt');
    assert.equal(itemCopyBody('tool', { content: '{"type":"object"}' }), '{"type":"object"}');
    assert.equal(itemCopyBody('system', {}), '');

    const msgBody = itemCopyBody('message', {
      thinking: 'Plan first',
      text: 'Reading file now.',
      tool_calls: [
        { name: 'read_file', arguments: '{"Path":"/a.js"}' },
        { name: 'run_command', arguments: '{"CommandLine":"ls"}' },
      ],
    });
    assert.equal(
      msgBody,
      '<thinking>\nPlan first\n</thinking>\n\nReading file now.\n\nread_file({"Path":"/a.js"})\n\nrun_command({"CommandLine":"ls"})',
    );
  });
});

describe('TestFrontendSparkline', () => {
  it('test_renderSparkline_returns_empty_for_fewer_than_two_turns', () => {
    assert.equal(renderSparkline(null, 500_000), '');
    assert.equal(renderSparkline([], 500_000), '');
    assert.equal(renderSparkline([{ turn: 1, tokens: 10_000, delta: 0, compacted: false }], 500_000), '');
  });

  it('test_computeSparkCoords_and_renderSparkline_normal_growth_without_budget_line', () => {
    const history = [
      { turn: 1, tokens: 10_000, delta: 0, compacted: false },
      { turn: 2, tokens: 20_000, delta: 10_000, compacted: false },
      { turn: 3, tokens: 30_000, delta: 10_000, compacted: false },
    ];
    // maxVal (30k) < budget * 0.5 (250k) -> budget line hidden
    const coords = computeSparkCoords(history, 500_000);
    assert.equal(coords.pts.length, 3);
    assert.equal(coords.budgetY, null);
    assert.equal(coords.budgetYPct, null);
    assert.ok(coords.pts[0].x < coords.pts[1].x && coords.pts[1].x < coords.pts[2].x);
    assert.ok(coords.pts[0].y > coords.pts[2].y);

    const html = renderSparkline(history, 500_000);
    assert.ok(html.includes('<polyline class="spark-line"'));
    assert.ok(!html.includes('class="spark-budget"'));
    assert.ok(html.includes('3 turns'));
    assert.ok(html.includes('+10.0k last'));
    assert.ok(html.includes('spark-pt last'));
  });

  it('test_computeSparkCoords_and_renderSparkline_budget_line_and_compaction_markers', () => {
    const history = [
      { turn: 5, tokens: 120_000, delta: 20_000, compacted: false },
      { turn: 6, tokens: 180_000, delta: 60_000, compacted: false },
      { turn: 7, tokens: 45_000, delta: -135_000, compacted: true },
    ];
    // maxVal (180k) >= budget * 0.5 (100k) -> budget line visible
    const coords = computeSparkCoords(history, 200_000);
    assert.notEqual(coords.budgetY, null);
    assert.notEqual(coords.budgetYPct, null);
    assert.ok(coords.budgetY > 0 && coords.budgetY < coords.H);

    const html = renderSparkline(history, 200_000);
    assert.ok(html.includes('class="spark-budget"'));
    assert.ok(html.includes('200.0k</span>'));
    assert.ok(html.includes('spark-pt ck'));
    assert.ok(html.includes('Last 3 turns'));
    assert.ok(html.includes('−135.0k last'));
  });
});

describe('TestFrontendViews', () => {
  it('test_categoryItems_groups_messages_by_category_and_falls_back_to_role', () => {
    const index = {
      system_sections: [
        { id: 'sys-0-identity', name: 'identity', group_type: 1, tokens: 300, preview: '' },
        { id: 'sys-1-skills', name: 'skills', group_type: 5, tokens: 400, preview: '' },
      ],
      tools: [
        { id: 'tool-0-read_file', name: 'read_file', is_mcp: false, mcp_server: '', tokens: 254, preview: '' },
        { id: 'tool-1-mcp_github_search', name: 'mcp_github_search', is_mcp: true, mcp_server: 'github', tokens: 400, preview: '' },
      ],
      messages: [
        { id: 'msg-0', index: 0, role: 'user', category: 'user', label: 'User message', tool_name: '', tokens: 100, preview: '' },
        // SYSTEM_MESSAGE step delivered with role=user: belongs to the System messages row
        { id: 'msg-1', index: 1, role: 'user', category: 'system_messages', label: 'System message', tool_name: '', tokens: 900, preview: '' },
        { id: 'msg-2', index: 2, role: 'assistant', category: 'agent', label: 'Agent response', tool_name: '', tokens: 400, preview: '' },
        { id: 'msg-3', index: 3, role: 'tool', category: 'tool', label: 'Tool result · read_file', tool_name: 'read_file', tokens: 50, preview: '' },
        { id: 'msg-4', index: 4, role: 'user', category: 'tool', label: 'Error message', tool_name: '', tokens: 1800, preview: '' },
        // Payloads without `category` (older backend still running) are grouped by role
        { id: 'msg-5', index: 5, role: 'system', label: 'System message', tool_name: '', tokens: 20, preview: '' },
        { id: 'msg-6', index: 6, role: 'role_0', label: 'Message (role_0)', tool_name: '', tokens: 0, preview: '' },
      ],
    };
    const ids = (key) => Array.from(categoryItems(index, key), (item) => item.id);

    assert.deepEqual(ids('user'), ['msg-0']);
    assert.deepEqual(ids('system_messages'), ['msg-1', 'msg-5']);
    assert.deepEqual(ids('agent'), ['msg-2']);
    // Tool rows are ranked by token cost and titled by tool name when there is one
    assert.deepEqual(ids('tool'), ['msg-4', 'msg-3']);
    assert.equal(categoryItems(index, 'tool')[0].title, '#4 · Error message');
    assert.equal(categoryItems(index, 'tool')[1].title, '#3 · read_file');
    assert.equal(categoryItems(index, 'system_messages')[0].title, '#1 · System message');

    // Sections and tools keep their existing grouping
    assert.deepEqual(ids('system_prompt'), ['sys-0-identity']);
    assert.deepEqual(ids('skills'), ['sys-1-skills']);
    assert.deepEqual(ids('system_tools'), ['tool-0-read_file']);
    assert.deepEqual(ids('mcp_tools'), ['tool-1-mcp_github_search']);
    assert.equal(categoryItems(index, 'mcp_tools')[0].server, 'github');

    // Unknown rows and a missing index yield nothing
    assert.equal(categoryItems(index, 'system_overhead').length, 0);
    assert.equal(categoryItems(null, 'user').length, 0);
  });

  it('test_renderCompactControl_thresholds_phases_and_tooltips', () => {
    const sendSettings = { compactThreshold: 60, compactAction: 'send' };
    const copySettings = { compactThreshold: 60, compactAction: 'copy' };
    const offSettings = { compactThreshold: 0, compactAction: 'send' };

    // Threshold 0 (off) or below threshold while idle -> empty
    assert.equal(renderCompactControl(90, offSettings, 'idle'), '');
    assert.equal(renderCompactControl(59.9, sendSettings, 'idle'), '');

    // At/above threshold while idle: send vs copy tooltip
    const idleSend = renderCompactControl(65, sendSettings, 'idle');
    assert.ok(idleSend.includes('id="btn-compact"'));
    assert.ok(idleSend.includes('click to compact'));
    assert.ok(!idleSend.includes('danger'));

    const idleCopyDanger = renderCompactControl(86, copySettings, 'idle');
    assert.ok(idleCopyDanger.includes('click to copy /compact'));
    assert.ok(idleCopyDanger.includes('compact-btn danger'));

    // Non-idle phases render even when threshold is 0 or below threshold
    const confirmHtml = renderCompactControl(40, offSettings, 'confirm');
    assert.ok(confirmHtml.includes('id="btn-compact-yes"'));
    assert.ok(confirmHtml.includes('id="btn-compact-no"'));
    assert.ok(confirmHtml.includes('Send /compact'));

    const sendingHtml = renderCompactControl(88, sendSettings, 'sending');
    assert.ok(sendingHtml.includes('Sending…'));
    assert.ok(sendingHtml.includes('danger'));
    assert.ok(sendingHtml.includes('disabled'));

    const sentHtml = renderCompactControl(65, sendSettings, 'sent');
    assert.ok(sentHtml.includes('Sent ✓'));

    const copiedHtml = renderCompactControl(65, copySettings, 'copied');
    assert.ok(copiedHtml.includes('Copied /compact'));
  });

  it('test_renderMcpServerChildren_groups_servers_and_sorts_by_tokens', () => {
    const children = [
      { id: 't1', kind: 'tool', title: 'mcp_alpha_one', tokens: 150, server: 'alpha' },
      { id: 't2', kind: 'tool', title: 'mcp_beta_big', tokens: 600, server: 'beta' },
      { id: 't3', kind: 'tool', title: 'mcp_alpha_two', tokens: 250, server: 'alpha' },
      { id: 't4', kind: 'tool', title: 'mystery_tool', tokens: 50, server: '' },
    ];
    const ctx = {
      activeCid: 'cid-1',
      fingerprint: 'fp-1',
      itemCache: new Map(),
      openItems: new Set(),
      fullPeek: new Set(),
      openMcpServers: new Set(['alpha']),
      closedMcpServers: new Set(),
      justOpened: {},
    };

    const html = renderMcpServerChildren(children, ctx);

    // Server order must be descending by total tokens: beta (600), alpha (400), other (50)
    const idxBeta = html.indexOf('data-mcp-server="beta"');
    const idxAlpha = html.indexOf('data-mcp-server="alpha"');
    const idxOther = html.indexOf('data-mcp-server="other"');
    assert.ok(idxBeta !== -1 && idxAlpha !== -1 && idxOther !== -1);
    assert.ok(idxBeta < idxAlpha && idxAlpha < idxOther);

    // Tool counts & singular/plural labels
    assert.ok(html.includes('1 tool'));
    assert.ok(html.includes('2 tools'));

    // Open server renders its tools; closed servers do not
    assert.ok(html.includes('data-id="t1"'));
    assert.ok(html.includes('data-id="t3"'));
    assert.ok(!html.includes('data-id="t2"'));
    assert.ok(!html.includes('data-id="t4"'));

    // Single server auto-expands unless explicitly in closedMcpServers
    const singleOpen = renderMcpServerChildren([children[0]], {
      ...ctx,
      openMcpServers: new Set(),
      closedMcpServers: new Set(),
    });
    assert.ok(singleOpen.includes('data-mcp-open="1"'));
    assert.ok(singleOpen.includes('data-id="t1"'));

    const singleClosed = renderMcpServerChildren([children[0]], {
      ...ctx,
      openMcpServers: new Set(),
      closedMcpServers: new Set(['alpha']),
    });
    assert.ok(singleClosed.includes('data-mcp-open="0"'));
    assert.ok(!singleClosed.includes('data-id="t1"'));
  });
});
