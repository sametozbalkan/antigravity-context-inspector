((CI) => {
  const PEEK_LIMIT = 18000;
  const DEFAULT_RELEASES_URL = 'https://github.com/sametozbalkan/antigravity-context-inspector/releases';

  const DEFAULT_SETTINGS = {
    compactThreshold: 60,
    displayMode: 'native',
    compactAction: 'send',
  };

  const COLOR_BY_KEY = {
    user: 'var(--c-user)',
    agent: 'var(--c-agent)',
    tool: 'var(--c-tool)',
    system_messages: 'var(--c-sysmsg)',
    system_prompt: 'var(--c-system)',
    system_tools: 'var(--c-tool)',
    system_overhead: 'var(--c-system)',
    mcp_tools: 'var(--c-mcp)',
    rules: 'var(--c-custom)',
    skills: 'var(--c-custom)',
    subagents: 'var(--c-custom)',
    workflows: 'var(--c-custom)',
    legacy_workflows: 'var(--c-custom)',
    plugins: 'var(--c-custom)',
  };

  const SEGMENT_COLORS = [
    ['System', 'var(--c-system)'],
    ['User', 'var(--c-user)'],
    ['Agent', 'var(--c-agent)'],
    ['Tools', 'var(--c-tool)'],
    ['Customizations', 'var(--c-custom)'],
  ];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function safeReleaseUrl(raw) {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol === 'https:') return u.href;
    } catch {
      // fall through to default
    }
    return DEFAULT_RELEASES_URL;
  }

  function fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 1e6) {
      const v = n / 1e6;
      return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
    }
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      let ta;
      try {
        ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
        document.body.appendChild(ta);
        ta.select();
        ok = Boolean(document.execCommand && document.execCommand('copy'));
      } catch {
        ok = false;
      } finally {
        if (ta) ta.remove();
      }
    }
    if (ok && btn) {
      if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
      clearTimeout(btn._copyTimer);
      btn.textContent = 'Copied';
      btn._copyTimer = setTimeout(() => {
        btn.textContent = btn.dataset.origLabel || 'Copy';
      }, 1200);
    }
    return ok;
  }

  function splitPath(p, cid = '') {
    const trimmed = p.replace(/\/$/, '');
    const idx = trimmed.lastIndexOf('/');
    const name = trimmed.slice(idx + 1) + (p.endsWith('/') ? '/' : '');
    let dir = idx > 0 ? trimmed.slice(0, idx) : '';
    if (cid) {
      const marker = `/brain/${cid}`;
      let pos = dir.indexOf(marker);
      while (pos !== -1) {
        const after = pos + marker.length;
        if (after === dir.length || dir[after] === '/') {
          dir = `conversation folder${dir.slice(after)}`;
          break;
        }
        pos = dir.indexOf(marker, pos + 1);
      }
    }
    return { name, dir };
  }

  function itemCopyBody(kind, item) {
    if (kind === 'system' || kind === 'tool') return item.content || '';
    const parts = [];
    if (item.thinking) parts.push(`<thinking>\n${item.thinking}\n</thinking>`);
    if (item.text) parts.push(item.text);
    for (const tc of item.tool_calls || []) {
      parts.push(`${tc.name}(${tc.arguments})`);
    }
    return parts.join('\n\n');
  }

  CI.utils = {
    PEEK_LIMIT,
    DEFAULT_RELEASES_URL,
    DEFAULT_SETTINGS,
    COLOR_BY_KEY,
    SEGMENT_COLORS,
    esc,
    safeReleaseUrl,
    fmtTok,
    copyText,
    splitPath,
    itemCopyBody,
  };
})(typeof __CI !== 'undefined' ? __CI : (globalThis.__CI = globalThis.__CI || {}));
