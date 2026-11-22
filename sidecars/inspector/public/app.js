(() => {
  const POLL_MS = 3000;
  const PEEK_LIMIT = 18000;
  const COMPACT_THRESHOLD_PCT = 60;

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

  const params = new URLSearchParams(location.search);
  let rootConversationId = (window.sidecar && window.sidecar.conversationId) || params.get('conversationId') || '';
  const doFetch = (window.sidecar && window.sidecar.fetch) || fetch;
  const $main = document.getElementById('main');

  let workspace = '';
  const state = {
    navStack: [],
    report: null,
    fingerprint: '',
    openCats: new Set(),
    openItems: new Set(),
    itemCache: new Map(),
    fullPeek: new Set(),
    compactPhase: 'idle', // 'idle' | 'confirm' | 'sending' | 'sent' | 'copied'
    compactTimer: null,
    updateInfo: null,
    updateDrawerOpen: false,
    updateStatusMsg: '',
    updating: false,
  };

  function activeConversationId() {
    return state.navStack.length ? state.navStack[state.navStack.length - 1].id : rootConversationId;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

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
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = prev; }, 1200);
    }
  }

  // --- Breakdown drill-down ---

  function itemsForCategory(key) {
    if (!state.report || !state.report.index) return [];
    const idx = state.report.index;
    const gtypeMap = {
      system_prompt: 1,
      rules: 3,
      skills: 5,
      subagents: 6,
      legacy_workflows: 8,
      plugins: 9,
      workflows: 10,
    };
    if (key in gtypeMap) {
      const gt = gtypeMap[key];
      return idx.system_sections
        .filter((s) => s.group_type === gt)
        .sort((a, b) => b.tokens - a.tokens)
        .map((s) => ({ kind: 'system', id: s.id, title: s.name, sub: s.preview, tokens: s.tokens }));
    }
    if (key === 'system_tools') {
      return idx.tools
        .filter((t) => !t.is_mcp)
        .sort((a, b) => b.tokens - a.tokens)
        .map((t) => ({ kind: 'tool', id: t.id, title: t.name, sub: t.preview, tokens: t.tokens }));
    }
    if (key === 'mcp_tools') {
      return idx.tools
        .filter((t) => t.is_mcp)
        .sort((a, b) => b.tokens - a.tokens)
        .map((t) => ({ kind: 'tool', id: t.id, title: t.name, sub: t.preview, tokens: t.tokens }));
    }
    if (key === 'user') {
      return idx.messages
        .filter((m) => m.role === 'user')
        .map((m) => ({ kind: 'message', id: m.id, title: `#${m.index} · ${m.label}`, sub: m.preview, tokens: m.tokens }));
    }
    if (key === 'agent') {
      return idx.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => ({ kind: 'message', id: m.id, title: `#${m.index} · ${m.label}`, sub: m.preview, tokens: m.tokens }));
    }
    if (key === 'tool') {
      return idx.messages
        .filter((m) => m.role === 'tool')
        .sort((a, b) => b.tokens - a.tokens)
        .map((m) => ({ kind: 'message', id: m.id, title: `#${m.index} · ${m.tool_name || m.label}`, sub: m.preview, tokens: m.tokens }));
    }
    if (key === 'system_messages') {
      return idx.messages
        .filter((m) => m.role === 'system')
        .map((m) => ({ kind: 'message', id: m.id, title: `#${m.index} · ${m.label}`, sub: m.preview, tokens: m.tokens }));
    }
    return [];
  }

  async function fetchFullItem(kind, id) {
    const cid = activeConversationId();
    const cacheKey = `${cid}:${state.fingerprint}:${kind}:${id}`;
    if (state.itemCache.has(cacheKey)) return state.itemCache.get(cacheKey);
    const qs = new URLSearchParams({ conversationId: cid, workspace, kind, id });
    const res = await doFetch(`/api/item?${qs}`);
    const data = await res.json();
    if (data && data.item) {
      state.itemCache.set(cacheKey, data.item);
      return data.item;
    }
    return null;
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

  function renderPeek(kind, id) {
    const cacheKey = `${activeConversationId()}:${state.fingerprint}:${kind}:${id}`;
    const item = state.itemCache.get(cacheKey);
    if (!item) {
      return `<div class="peek"><div class="peek-bar"><span>Loading…</span></div></div>`;
    }
    const body = itemCopyBody(kind, item);
    const showAll = state.fullPeek.has(id);
    const cut = !showAll && body.length > PEEK_LIMIT;
    const shown = cut ? `${body.slice(0, PEEK_LIMIT)}\n\n…` : body;

    return `
      <div class="peek">
        <div class="peek-bar">
          <span class="num">${item.tokens.toLocaleString()} tokens · ${body.length.toLocaleString()} chars</span>
          <button class="icon-btn btn-copy-peek" data-kind="${esc(kind)}" data-id="${esc(id)}">Copy</button>
        </div>
        <pre>${esc(shown || '(empty)')}</pre>
        ${cut ? `<button class="peek-more" data-more="${esc(id)}">Show full content (${body.length.toLocaleString()} chars)</button>` : ''}
      </div>
    `;
  }

  function renderCategoryRow(c) {
    const color = COLOR_BY_KEY[c.key] || 'var(--c-custom)';
    const isConv = c.group === 'conv';
    const children = itemsForCategory(c.key);
    const expandable = children.length > 0;
    const isOpen = expandable && state.openCats.has(c.key);

    let childrenHtml = '';
    if (isOpen) {
      childrenHtml = `<div class="children">${children.map((ch) => {
        const itemOpen = state.openItems.has(ch.id);
        return `
          <div class="child-row ${itemOpen ? 'active' : ''}" data-kind="${esc(ch.kind)}" data-id="${esc(ch.id)}">
            <span class="child-title" title="${esc(ch.title)}">${esc(ch.title)}${ch.sub ? `<span class="child-sub">${esc(ch.sub)}</span>` : ''}</span>
            <span class="child-tok num">${fmtTok(ch.tokens)}</span>
          </div>
          ${itemOpen ? renderPeek(ch.kind, ch.id) : ''}
        `;
      }).join('')}</div>`;
    }

    return `
      <div class="cat-wrap">
        <div class="row ${expandable ? 'clickable' : ''} ${isOpen ? 'open' : ''}" ${expandable ? `data-cat="${esc(c.key)}"` : ''}>
          <span class="mark ${isConv ? '' : 'sq'}" style="background:${color}"></span>
          <span class="row-name">${esc(c.name)}</span>
          <span class="row-tok num">${fmtTok(c.tokens)}</span>
          <span class="row-pct num">${c.pct.toFixed(1)}%</span>
          <span class="chev">${expandable ? '›' : ''}</span>
        </div>
        ${childrenHtml}
      </div>
    `;
  }

  // --- Subagents ---

  function renderSubagentsSection(subagents) {
    if (!subagents || !subagents.length) return '';
    return `
      <section>
        <div class="sec-head"><span>Subagents</span><span class="sec-hint num">${subagents.length}</span></div>
        ${subagents.map((sa) => {
          const metaBits = [sa.type_name, sa.model].filter(Boolean).join(' · ');
          const pctShown = sa.request_budget_tokens > 0 && sa.request_budget_tokens < sa.limit_tokens
            ? sa.budget_pct
            : sa.used_pct;
          const tip = sa.request_budget_tokens > 0 && sa.request_budget_tokens < sa.limit_tokens
            ? `${fmtTok(sa.used_tokens)} / ${fmtTok(sa.request_budget_tokens)} budget (${sa.budget_pct.toFixed(1)}%) · ${fmtTok(sa.limit_tokens)} native`
            : `${fmtTok(sa.used_tokens)} / ${sa.limit_tokens ? fmtTok(sa.limit_tokens) : '?'} tokens`;
          return `
            <div class="sub-row" data-sub-id="${esc(sa.conversation_id)}" data-sub-label="${esc(sa.role)}" title="${esc(tip)}">
              <span class="sub-dot ${sa.status === 'running' ? 'running' : ''}" title="${esc(sa.status)}"></span>
              <span class="sub-info">
                <span class="sub-role">${esc(sa.role)}</span>
                <span class="sub-meta-line">${esc(metaBits || sa.conversation_id.slice(0, 8))}</span>
              </span>
              <span class="row-tok num">${fmtTok(sa.used_tokens)}</span>
              <span class="row-pct num">${pctShown.toFixed(1)}%</span>
              <span class="chev">›</span>
            </div>
          `;
        }).join('')}
      </section>
    `;
  }

  // --- Compact control ---

  function setCompactPhase(phase, autoResetMs = 0) {
    clearTimeout(state.compactTimer);
    state.compactPhase = phase;
    render();
    if (autoResetMs > 0) {
      state.compactTimer = setTimeout(() => {
        state.compactPhase = 'idle';
        render();
      }, autoResetMs);
    }
  }

  async function triggerCompact() {
    const cid = activeConversationId();
    setCompactPhase('sending');
    try {
      if (window.sidecar && window.sidecar.agent && window.sidecar.agent.sendMessage) {
        await window.sidecar.agent.sendMessage('/compact', cid);
        setCompactPhase('sent', 2600);
        return;
      }
      throw new Error('agent bridge unavailable');
    } catch {
      await copyText('/compact');
      setCompactPhase('copied', 2600);
    }
  }

  function renderCompactControl(effectivePct) {
    if (effectivePct < COMPACT_THRESHOLD_PCT && state.compactPhase === 'idle') return '';
    const dangerCls = effectivePct >= 85 ? ' danger' : '';
    if (state.compactPhase === 'confirm') {
      return `
        <button id="btn-compact-yes" class="compact-btn confirm${dangerCls}" title="Send /compact to this conversation">Send /compact</button>
        <button id="btn-compact-no" class="icon-btn" title="Cancel">✕</button>
      `;
    }
    if (state.compactPhase === 'sending') {
      return `<button class="compact-btn${dangerCls}" disabled>Sending…</button>`;
    }
    if (state.compactPhase === 'sent') {
      return `<button class="compact-btn sent" disabled>Sent ✓</button>`;
    }
    if (state.compactPhase === 'copied') {
      return `<button class="compact-btn sent" disabled>Copied /compact</button>`;
    }
    return `<button id="btn-compact" class="compact-btn${dangerCls}" title="Context reached ${effectivePct.toFixed(0)}% (≥${COMPACT_THRESHOLD_PCT}%) — click to compact">Compact</button>`;
  }

  // --- Remote update drawer (2A one-click git pull + 2B copy/release) ---

  async function checkUpdates() {
    try {
      const res = await doFetch('/api/update-status');
      const data = await res.json();
      if (data && data.currentVersion) {
        state.updateInfo = data;
        if (state.report) render();
      }
    } catch {
      // ignore offline check failure
    }
  }

  async function runOneClickUpdate() {
    state.updating = true;
    state.updateStatusMsg = 'Pulling latest changes…';
    render();
    try {
      const res = await doFetch('/api/update', { method: 'POST', body: '{}' });
      const data = await res.json();
      if (data.ok) {
        state.updateStatusMsg = 'Updated! Toggle Context Inspector off and on in Customizations to reload.';
        if (state.updateInfo) state.updateInfo.updateAvailable = false;
      } else {
        state.updateStatusMsg = `Update failed (${data.error || 'error'}). Use Copy command instead.`;
      }
    } catch (err) {
      state.updateStatusMsg = `Update failed (${err.message}). Use Copy command instead.`;
    } finally {
      state.updating = false;
      render();
    }
  }

  function renderUpdateDrawer() {
    if (!state.updateDrawerOpen || !state.updateInfo) return '';
    const u = state.updateInfo;
    return `
      <div class="update-box">
        <div class="update-head">
          <span>Update v${esc(u.currentVersion)} → v${esc(u.latestVersion)}</span>
          <button id="btn-upd-close" class="icon-btn" title="Close">✕</button>
        </div>
        ${state.updateStatusMsg ? `<div class="update-note">${esc(state.updateStatusMsg)}</div>` : ''}
        <div class="update-actions">
          ${u.isGitRepo ? `<button id="btn-upd-pull" class="update-primary" ${state.updating ? 'disabled' : ''}>${state.updating ? 'Updating…' : 'Update now'}</button>` : ''}
          <button id="btn-upd-copy" class="icon-btn">Copy command</button>
          <a class="icon-btn" href="${esc(u.releaseUrl)}" target="_blank" rel="noopener">Release ↗</a>
        </div>
      </div>
    `;
  }

  // --- Files ---

  function splitPath(p) {
    const trimmed = p.replace(/\/$/, '');
    const idx = trimmed.lastIndexOf('/');
    const name = trimmed.slice(idx + 1) + (p.endsWith('/') ? '/' : '');
    let dir = idx > 0 ? trimmed.slice(0, idx) : '';
    const cid = activeConversationId();
    if (cid) dir = dir.replace(new RegExp(`^.*/brain/${cid}`), 'conversation folder');
    return { name, dir };
  }

  function renderFilesSection(title, items) {
    if (!items || !items.length) return '';
    return `
      <section>
        <div class="sec-head"><span>${esc(title)}</span><span class="sec-hint num">${items.length}</span></div>
        <ul class="file-list">
          ${items.map((f) => {
            const { name, dir } = splitPath(f.path);
            return `
              <li title="${esc(f.path)}">
                <span class="file-name">${esc(name)}${dir ? `<span class="file-dir">${esc(dir)}</span>` : ''}</span>
                ${f.tokens > 0 ? `<span class="file-tok num">${fmtTok(f.tokens)}</span>` : ''}
              </li>
            `;
          }).join('')}
        </ul>
      </section>
    `;
  }

  // --- Render ---

  function render() {
    if (!state.report) return;
    const s = state.report.summary;
    const limit = s.limit_tokens;
    const budget = s.request_budget_tokens;
    const showBudget = budget > 0 && budget !== limit;
    const effectivePct = showBudget ? s.budget_pct : s.used_pct;
    const budgetCls = s.budget_pct >= 85 ? 'danger' : s.budget_pct >= COMPACT_THRESHOLD_PCT ? 'warn' : '';

    let segsHtml = '';
    if (limit > 0) {
      s.grid_segments.forEach((tok, i) => {
        if (!tok) return;
        const w = Math.max(0.5, (tok / limit) * 100);
        const [label, color] = SEGMENT_COLORS[i];
        segsHtml += `<div class="seg" style="width:${w.toFixed(2)}%;background:${color}" title="${label}: ${fmtTok(tok)} tokens"></div>`;
      });
    }

    const metaParts = [];
    if (s.api_usage && s.api_usage.total_input_tokens > 0) {
      metaParts.push(`<span class="num">Cache ${s.api_usage.cache_hit_pct.toFixed(0)}%</span>`);
    }
    if (s.api_usage && s.api_usage.output_tokens > 0) {
      metaParts.push(`<span class="num">Last out ${fmtTok(s.api_usage.output_tokens)}</span>`);
    }
    if (s.compacted) {
      metaParts.push(`<span class="tag-warn">Compacted</span>`);
    } else if (!s.has_breakdown) {
      metaParts.push(`<span>Estimated</span>`);
    }

    const conv = s.categories.filter((c) => c.group === 'conv');
    const rest = s.categories.filter((c) => c.group !== 'conv');
    const freePct = limit ? ((s.free_tokens / limit) * 100).toFixed(1) : '0.0';

    const ckHtml = s.checkpoints && s.checkpoints.length ? `
      <section>
        <div class="sec-head"><span>Checkpoints</span><span class="sec-hint num">${s.checkpoints.length}</span></div>
        ${s.checkpoints.map((ck) => `
          <div class="ck-item">
            <span class="row-name">#${ck.index}${ck.intent ? ' · ' + esc(ck.intent) : ''} <span class="dim num">(steps ${ck.start}–${ck.end})</span></span>
            ${ck.index === s.active_checkpoint ? '<span class="ck-pill">active</span>' : ''}
          </div>
        `).join('')}
      </section>
    ` : '';

    const navHtml = state.navStack.length ? `
      <div class="nav-bar">
        <div class="nav-left">
          <button id="btn-nav-back" class="nav-back">← ${state.navStack.length === 1 ? 'Main' : esc(state.navStack[state.navStack.length - 2].label)}</button>
          <span class="dim">/</span>
          <span class="nav-title" title="${esc(state.navStack[state.navStack.length - 1].label)}">${esc(state.navStack[state.navStack.length - 1].label)}</span>
        </div>
        ${window.sidecar && window.sidecar.ui && window.sidecar.ui.toggleConversation
          ? `<button id="btn-open-sub" class="icon-btn" title="Open subagent conversation">Open ↗</button>`
          : ''}
      </div>
    ` : '';

    const u = state.updateInfo;
    const updateBadge = u && u.updateAvailable
      ? `<button id="btn-upd-pill" class="update-pill" title="New version available">v${esc(u.latestVersion)} available</button>`
      : '';

    const ts = new Date(state.report.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    $main.innerHTML = `
      ${navHtml}

      <div class="top">
        <div class="model" title="${esc(s.model_id || s.model)}">
          <span class="live on" title="Live"></span>
          <span class="model-name">${esc(s.model)}</span>
        </div>
        <div class="top-actions">
          ${renderCompactControl(effectivePct)}
          <button id="btn-copy" class="icon-btn" title="Copy summary">Copy</button>
        </div>
      </div>

      <div class="hero">
        <div class="hero-left">
          <span class="hero-val num">${fmtTok(s.used_tokens)}</span>
          <span class="hero-limit num">/ ${limit ? fmtTok(limit) : '?'}</span>
        </div>
        <span class="hero-pct num">${limit ? s.used_pct.toFixed(1) + '%' : ''}</span>
      </div>

      <div class="seg-bar">${segsHtml}</div>

      <div class="metrics">
        ${showBudget ? `
          <div class="budget-row" title="Per-request trim / compaction budget">
            <span>Budget</span>
            <div class="budget-track"><div class="budget-fill ${budgetCls}" style="width:${Math.min(100, s.budget_pct)}%"></div></div>
            <span class="num">${fmtTok(s.used_tokens)} / ${fmtTok(budget)} (${s.budget_pct.toFixed(0)}%)</span>
          </div>
        ` : ''}
        ${metaParts.length ? `<div class="sub-meta">${metaParts.join('<span class="sep">·</span>')}</div>` : ''}
      </div>

      <section>
        <div class="sec-head"><span>Breakdown</span><span class="sec-hint">Click to inspect</span></div>
        <div class="group">${conv.map(renderCategoryRow).join('')}</div>
        ${rest.length ? `<div class="group">${rest.map(renderCategoryRow).join('')}</div>` : ''}
        <div class="group">
          <div class="row">
            <span class="mark free"></span>
            <span class="row-name dim">Free space</span>
            <span class="row-tok num dim">${fmtTok(s.free_tokens)}</span>
            <span class="row-pct num">${freePct}%</span>
            <span></span>
          </div>
          ${s.checkpoint_buffer ? `
            <div class="row">
              <span class="mark sq" style="background:var(--track)"></span>
              <span class="row-name dim">Checkpoint buffer</span>
              <span class="row-tok num dim">${fmtTok(s.checkpoint_buffer)}</span>
              <span class="row-pct"></span>
              <span></span>
            </div>
          ` : ''}
        </div>
      </section>

      ${renderSubagentsSection(s.subagents)}
      ${ckHtml}
      ${renderFilesSection('Skills loaded', s.skill_files)}
      ${renderFilesSection('Artifacts', s.artifact_files)}
      ${renderFilesSection('Knowledge', s.knowledge_files)}
      ${renderFilesSection('System paths', s.system_files)}
      ${renderUpdateDrawer()}

      <footer>
        <span class="foot-left">
          <span class="num">${esc(s.conversation_id.slice(0, 8))}</span>
          ${u ? `<span class="num">· v${esc(u.currentVersion)}</span>` : ''}
          ${updateBadge}
        </span>
        <span class="num">Updated ${esc(ts)}</span>
      </footer>
    `;

    // Wire events
    document.getElementById('btn-copy').onclick = (e) => copyText(s.cli_text, e.currentTarget);

    const btnBack = document.getElementById('btn-nav-back');
    if (btnBack) {
      btnBack.onclick = () => {
        state.navStack.pop();
        state.fingerprint = '';
        state.openCats.clear();
        state.openItems.clear();
        state.compactPhase = 'idle';
        refresh(true);
      };
    }

    const btnOpenSub = document.getElementById('btn-open-sub');
    if (btnOpenSub) {
      btnOpenSub.onclick = () => window.sidecar.ui.toggleConversation(activeConversationId());
    }

    const btnCompact = document.getElementById('btn-compact');
    if (btnCompact) btnCompact.onclick = () => setCompactPhase('confirm', 6000);

    const btnCompactYes = document.getElementById('btn-compact-yes');
    if (btnCompactYes) btnCompactYes.onclick = () => triggerCompact();

    const btnCompactNo = document.getElementById('btn-compact-no');
    if (btnCompactNo) btnCompactNo.onclick = () => setCompactPhase('idle');

    const btnUpdPill = document.getElementById('btn-upd-pill');
    if (btnUpdPill) {
      btnUpdPill.onclick = () => {
        state.updateDrawerOpen = !state.updateDrawerOpen;
        render();
      };
    }
    const btnUpdClose = document.getElementById('btn-upd-close');
    if (btnUpdClose) {
      btnUpdClose.onclick = () => {
        state.updateDrawerOpen = false;
        render();
      };
    }
    const btnUpdPull = document.getElementById('btn-upd-pull');
    if (btnUpdPull) btnUpdPull.onclick = () => runOneClickUpdate();

    const btnUpdCopy = document.getElementById('btn-upd-copy');
    if (btnUpdCopy && state.updateInfo) {
      btnUpdCopy.onclick = (e) => copyText(state.updateInfo.updateCommand, e.currentTarget);
    }

    $main.querySelectorAll('.sub-row[data-sub-id]').forEach((el) => {
      el.onclick = () => {
        state.navStack.push({ id: el.dataset.subId, label: el.dataset.subLabel });
        state.fingerprint = '';
        state.openCats.clear();
        state.openItems.clear();
        state.compactPhase = 'idle';
        refresh(true);
      };
    });

    $main.querySelectorAll('.row[data-cat]').forEach((el) => {
      el.onclick = () => {
        const key = el.dataset.cat;
        if (state.openCats.has(key)) state.openCats.delete(key);
        else state.openCats.add(key);
        render();
      };
    });

    $main.querySelectorAll('.child-row[data-id]').forEach((el) => {
      el.onclick = async () => {
        const { kind, id } = el.dataset;
        if (state.openItems.has(id)) {
          state.openItems.delete(id);
          render();
        } else {
          state.openItems.add(id);
          render();
          await fetchFullItem(kind, id);
          if (state.openItems.has(id)) render();
        }
      };
    });

    $main.querySelectorAll('.btn-copy-peek').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const item = await fetchFullItem(btn.dataset.kind, btn.dataset.id);
        if (item) copyText(itemCopyBody(btn.dataset.kind, item), btn);
      };
    });

    $main.querySelectorAll('.peek-more').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        state.fullPeek.add(btn.dataset.more);
        render();
      };
    });
  }

  function showEmpty(msg) {
    state.report = null;
    state.fingerprint = '';
    const backHtml = state.navStack.length
      ? `<div class="nav-bar"><div class="nav-left"><button id="btn-nav-back" class="nav-back">← Back</button><span class="nav-title">${esc(state.navStack[state.navStack.length - 1].label)}</span></div></div>`
      : '';
    $main.innerHTML = `${backHtml}<p class="empty">${esc(msg)}</p>`;
    const btnBack = document.getElementById('btn-nav-back');
    if (btnBack) {
      btnBack.onclick = () => {
        state.navStack.pop();
        state.fingerprint = '';
        refresh(true);
      };
    }
  }

  async function refresh(force = false) {
    if (document.hidden && !force) return;
    const cid = activeConversationId();
    try {
      const qs = new URLSearchParams({ conversationId: cid, workspace });
      const res = await doFetch(`/api/report?${qs}`);
      const data = await res.json();

      if (cid !== activeConversationId()) return;
      if (data.error === 'no-conversation') return showEmpty('Open a conversation to see its context usage.');
      if (data.error === 'no-database') return showEmpty('Waiting for conversation data…');
      if (data.error) return showEmpty(data.message || data.error);

      const nextFp = data.summary.fingerprint;
      if (!force && state.report && nextFp === state.fingerprint) return;

      state.report = data;
      state.fingerprint = nextFp;

      if (state.openItems.size > 0) {
        const all = [
          ...data.index.system_sections.map((x) => ['system', x.id]),
          ...data.index.tools.map((x) => ['tool', x.id]),
          ...data.index.messages.map((x) => ['message', x.id]),
        ];
        await Promise.all(
          [...state.openItems].map((id) => {
            const pair = all.find(([, xid]) => xid === id);
            return pair ? fetchFullItem(pair[0], pair[1]) : null;
          }),
        );
      }

      render();
    } catch {
      const dot = document.querySelector('.live');
      if (dot) dot.classList.remove('on');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  async function start() {
    if (window.sidecar) {
      if (window.sidecar.getWorkspaceUris) {
        try {
          const uris = await window.sidecar.getWorkspaceUris();
          workspace = (uris && uris[0]) || '';
        } catch { /* ignore */ }
      }
      if (window.sidecar.onWorkspaceChange) {
        window.sidecar.onWorkspaceChange((next) => {
          const first = (next && next[0]) || '';
          if (first !== workspace) {
            workspace = first;
            state.fingerprint = '';
            refresh(true);
          }
        });
      }
      if (window.sidecar.onConversationChange) {
        window.sidecar.onConversationChange((nextId) => {
          if (nextId && nextId !== rootConversationId) {
            rootConversationId = nextId;
            state.navStack = [];
            state.fingerprint = '';
            state.openCats.clear();
            state.openItems.clear();
            state.itemCache.clear();
            state.compactPhase = 'idle';
            refresh(true);
          }
        });
      }
    }
    checkUpdates();
    await refresh(true);
    setInterval(() => refresh(false), POLL_MS);
  }

  start();
})();
