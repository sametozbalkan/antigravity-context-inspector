((CI) => {
const {
  DEFAULT_SETTINGS,
  SEGMENT_COLORS,
  copyText,
  esc,
  fmtTok,
  itemCopyBody,
} = CI.utils;
const { renderSparkline, wireSparkline } = CI.sparkline;
const {
  categoryItems,
  renderCategoryRow,
  renderCompactControl,
  renderFilesSection,
  renderSettingsPopover,
  renderSubagentsSection,
  renderUpdateDrawer,
} = CI.views;

const POLL_MS = 3000;
const MAX_ITEM_CACHE = 40;

const params = new URLSearchParams(location.search);
let rootConversationId = (window.sidecar && window.sidecar.conversationId) || params.get('conversationId') || '';
const doFetch = window.sidecar && typeof window.sidecar.fetch === 'function'
  ? window.sidecar.fetch.bind(window.sidecar)
  : window.fetch.bind(window);
const $main = document.getElementById('main');

let workspace = '';
let refreshSeq = 0;
let refreshInFlight = false;
let activeRefreshes = 0;
let settingsSeq = 0;

const state = {
  navStack: [],
  report: null,
  reportCid: '',
  fingerprint: '',
  pendingTransition: '', // '' | 'forward' | 'back' | 'switch'
  justOpened: { cat: '', mcp: '', item: '', settings: false, update: false, session: false },
  openCats: new Set(),
  openMcpServers: new Set(),
  closedMcpServers: new Set(),
  openItems: new Set(),
  itemCache: new Map(),
  fullPeek: new Set(),
  sessionSummaryOpen: false,
  settings: { ...DEFAULT_SETTINGS },
  settingsOpen: false,
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

function cacheGet(key) {
  if (!state.itemCache.has(key)) return undefined;
  const val = state.itemCache.get(key);
  state.itemCache.delete(key);
  state.itemCache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (state.itemCache.has(key)) state.itemCache.delete(key);
  state.itemCache.set(key, val);
  while (state.itemCache.size > MAX_ITEM_CACHE) {
    const oldest = state.itemCache.keys().next().value;
    state.itemCache.delete(oldest);
  }
}

function pruneStaleCache(cid, nextFp) {
  const prefix = `${cid}:`;
  const keepPrefix = `${cid}:${nextFp}:`;
  for (const key of state.itemCache.keys()) {
    if (key.startsWith(prefix) && !key.startsWith(keepPrefix)) {
      state.itemCache.delete(key);
    }
  }
}

function clearJustOpened() {
  state.justOpened.cat = '';
  state.justOpened.mcp = '';
  state.justOpened.item = '';
  state.justOpened.settings = false;
  state.justOpened.update = false;
  state.justOpened.session = false;
}

function resetViewState({ clearCache = false, transition = '' } = {}) {
  clearTimeout(state.compactTimer);
  state.compactTimer = null;
  refreshSeq += 1;
  state.report = null;
  state.reportCid = '';
  state.fingerprint = '';
  state.pendingTransition = transition;
  clearJustOpened();
  state.openCats.clear();
  state.openMcpServers.clear();
  state.closedMcpServers.clear();
  state.openItems.clear();
  state.fullPeek.clear();
  state.sessionSummaryOpen = false;
  state.compactPhase = 'idle';
  if (clearCache) state.itemCache.clear();
}

// --- Breakdown drill-down ---

function itemsForCategory(key) {
  return state.report ? categoryItems(state.report.index, key) : [];
}

async function fetchFullItem(kind, id, { force = false, fp = state.fingerprint } = {}) {
  const cid = activeConversationId();
  const cacheKey = `${cid}:${fp}:${kind}:${id}`;
  if (!force && state.itemCache.has(cacheKey)) {
    const cached = cacheGet(cacheKey);
    if (cached && cached.__error) return null;
    return cached;
  }
  if (force) state.itemCache.delete(cacheKey);
  try {
    const qs = new URLSearchParams({ conversationId: cid, workspace, kind, id });
    const res = await doFetch(`/api/item?${qs}`);
    if (cid !== activeConversationId()) return null;
    if (!res.ok) {
      cacheSet(cacheKey, { __error: `Failed to load content (HTTP ${res.status})` });
      return null;
    }
    const data = await res.json();
    if (cid !== activeConversationId()) return null;
    if (data && data.item) {
      cacheSet(cacheKey, data.item);
      if (data.fingerprint && data.fingerprint !== fp) {
        cacheSet(`${cid}:${data.fingerprint}:${kind}:${id}`, data.item);
      }
      return data.item;
    }
    const errMsg = (data && (data.message || data.error)) || 'Failed to load content';
    cacheSet(cacheKey, { __error: errMsg });
    return null;
  } catch {
    if (cid === activeConversationId()) {
      cacheSet(cacheKey, { __error: 'Failed to load content' });
    }
    return null;
  }
}

// --- Settings ---

async function loadSettings() {
  const seq = settingsSeq;
  try {
    const res = await doFetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    if (seq !== settingsSeq) return;
    if (data && typeof data === 'object' && !data.error) {
      state.settings = { ...DEFAULT_SETTINGS, ...data };
      if (state.report) render();
    }
  } catch {
    // use defaults
  }
}

async function updateSettings(patch) {
  const seq = ++settingsSeq;
  state.settings = { ...state.settings, ...patch };
  render();
  try {
    const res = await doFetch('/api/settings/save', {
      method: 'POST',
      body: JSON.stringify(state.settings),
    });
    if (!res.ok) return;
    const saved = await res.json();
    if (seq !== settingsSeq) return;
    if (saved && typeof saved === 'object' && !saved.error) {
      const normalized = { ...DEFAULT_SETTINGS, ...saved };
      const changed = Object.keys(DEFAULT_SETTINGS).some((k) => normalized[k] !== state.settings[k]);
      state.settings = normalized;
      if (changed && state.report) render();
    }
  } catch {
    // keep optimistic UI state
  }
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
  if (state.settings.compactAction === 'copy') {
    const ok = await copyText('/compact');
    if (cid !== activeConversationId()) return;
    if (ok) setCompactPhase('copied', 2600);
    return;
  }
  setCompactPhase('sending');
  try {
    if (window.sidecar && window.sidecar.agent && typeof window.sidecar.agent.sendMessage === 'function') {
      await window.sidecar.agent.sendMessage('/compact', cid);
      if (cid !== activeConversationId()) return;
      setCompactPhase('sent', 2600);
      return;
    }
    throw new Error('agent bridge unavailable');
  } catch {
    if (cid !== activeConversationId()) return;
    const ok = await copyText('/compact');
    if (cid !== activeConversationId()) return;
    setCompactPhase(ok ? 'copied' : 'idle', ok ? 2600 : 0);
  }
}

// --- Remote update drawer (2A one-click git pull + 2B copy/release) ---

async function checkUpdates() {
  try {
    const res = await doFetch('/api/update-status');
    if (!res.ok) return;
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
  if (state.updating) return;
  state.updating = true;
  state.updateStatusMsg = 'Pulling latest changes…';
  render();
  try {
    const res = await doFetch('/api/update', { method: 'POST', body: '{}' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.ok) {
      state.updateStatusMsg = 'Updated! Toggle Context Inspector off and on in Customizations to reload.';
      if (state.updateInfo) {
        state.updateInfo.updateAvailable = false;
        if (data.currentVersion) state.updateInfo.currentVersion = data.currentVersion;
      }
    } else {
      state.updateStatusMsg = `Update failed (${(data && data.error) || 'error'}). Use Copy command instead.`;
    }
  } catch (err) {
    state.updateStatusMsg = `Update failed (${err.message}). Use Copy command instead.`;
  } finally {
    state.updating = false;
    render();
  }
}

// --- Render ---

function render() {
  const activeCid = activeConversationId();
  if (!state.report || state.reportCid !== activeCid) return;
  const s = state.report.summary;
  const limit = s.limit_tokens;
  const budget = s.request_budget_tokens;
  const showBudget = budget > 0 && (limit === 0 || budget < limit);
  const budgetPrimary = showBudget && state.settings.displayMode === 'budget';
  const primaryLimit = budgetPrimary ? budget : limit;
  const realUsedPct = limit > 0 ? (s.used_tokens / limit) * 100 : (s.used_pct || 0);
  const realBudgetPct = budget > 0 ? (s.used_tokens / budget) * 100 : (s.budget_pct || 0);
  const primaryPct = primaryLimit > 0 ? (s.used_tokens / primaryLimit) * 100 : 0;
  const primaryFree = primaryLimit ? Math.max(0, primaryLimit - s.used_tokens) : 0;
  const effectivePct = showBudget ? realBudgetPct : realUsedPct;
  const threshold = state.settings.compactThreshold || 60;
  const budgetCls = realBudgetPct >= 85 ? 'danger' : realBudgetPct >= threshold ? 'warn' : '';

  let segsHtml = '';
  if (primaryLimit > 0) {
    const segDenom = Math.max(primaryLimit, s.used_tokens);
    s.grid_segments.forEach((tok, i) => {
      if (!tok) return;
      const w = Math.max(0.5, (tok / segDenom) * 100);
      const [label, color] = SEGMENT_COLORS[i];
      segsHtml += `<div class="seg" style="width:${w.toFixed(2)}%;background:${color}" title="${label}: ${fmtTok(tok)} tokens"></div>`;
    });
  }

  const su = s.session_usage;
  const metaParts = [];
  if (s.api_usage && s.api_usage.total_input_tokens > 0) {
    const isDrop = Boolean(su && su.cache_drop);
    const cacheTip = su
      ? `${su.turns} turns · avg cache ${su.avg_cache_hit_pct.toFixed(0)}% · click for session summary`
      : 'Prompt cache hit rate';
    metaParts.push(
      `<button id="btn-cache-meta" class="meta-btn num ${isDrop ? 'tag-warn' : ''}" title="${esc(cacheTip)}">Cache ${s.api_usage.cache_hit_pct.toFixed(0)}%${isDrop ? ' ↓' : ''}</button>`,
    );
  }
  if (s.api_usage && s.api_usage.output_tokens > 0) {
    metaParts.push(`<span class="num">Last out ${fmtTok(s.api_usage.output_tokens)}</span>`);
  }
  if (s.compacted) {
    metaParts.push(`<span class="tag-warn">Compacted</span>`);
  } else if (!s.has_breakdown) {
    metaParts.push(`<span>Estimated</span>`);
  }

  let sessionStripHtml = '';
  if (state.sessionSummaryOpen && su) {
    const thinkPart = su.total_thinking_tokens > 0 ? ` (${fmtTok(su.total_thinking_tokens)} thinking)` : '';
    const dropPart = su.cache_drop ? ' · cache drop detected' : su.cache_drop_after_compact ? ' · cold after compact' : '';
    sessionStripHtml = `<div class="session-strip num${state.justOpened.session ? ' anim-expand' : ''}">${su.turns} ${su.turns === 1 ? 'turn' : 'turns'} · avg cache ${su.avg_cache_hit_pct.toFixed(0)}% · ${fmtTok(su.total_output_tokens)} out${thinkPart}${dropPart}</div>`;
  }

  const secondaryMeterHtml = showBudget
    ? budgetPrimary
      ? limit > 0
        ? `
          <div class="budget-row" title="Model native context window">
            <span>Native</span>
            <div class="budget-track"><div class="budget-fill" style="width:${Math.min(100, realUsedPct)}%"></div></div>
            <span class="num">${fmtTok(s.used_tokens)} / ${fmtTok(limit)} (${realUsedPct.toFixed(0)}%)</span>
          </div>
        `
        : ''
      : `
        <div class="budget-row" title="Per-request trim / compaction budget">
          <span>Budget</span>
          <div class="budget-track"><div class="budget-fill ${budgetCls}" style="width:${Math.min(100, realBudgetPct)}%"></div></div>
          <span class="num">${fmtTok(s.used_tokens)} / ${fmtTok(budget)} (${realBudgetPct.toFixed(0)}%)</span>
        </div>
      `
    : '';

  const conv = s.categories.filter((c) => c.group === 'conv');
  const rest = s.categories.filter((c) => c.group !== 'conv');
  const freePct = primaryLimit ? ((primaryFree / primaryLimit) * 100).toFixed(1) : '0.0';

  const viewCtx = {
    activeCid,
    fingerprint: state.fingerprint,
    itemCache: state.itemCache,
    fullPeek: state.fullPeek,
    justOpened: state.justOpened,
    openCats: state.openCats,
    openMcpServers: state.openMcpServers,
    closedMcpServers: state.closedMcpServers,
    openItems: state.openItems,
  };

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
      ${window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleConversation === 'function'
        ? `<button id="btn-open-sub" class="icon-btn" title="Open subagent conversation">Open ↗</button>`
        : ''}
    </div>
  ` : '';

  const u = state.updateInfo;
  const updateBadge = u && u.updateAvailable
    ? `<button id="btn-upd-pill" class="update-pill" title="New version available">v${esc(u.latestVersion)} available</button>`
    : '';

  const ts = new Date(state.report.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const scrollMap = new Map();
  $main.querySelectorAll('.peek[data-peek-id] pre').forEach((pre) => {
    if (pre.scrollTop > 0 || pre.scrollLeft > 0) {
      scrollMap.set(pre.parentElement.dataset.peekId, [pre.scrollTop, pre.scrollLeft]);
    }
  });

  const viewAnim = state.pendingTransition;
  state.pendingTransition = '';
  const viewAnimCls = viewAnim ? ` anim-${viewAnim}` : '';

  $main.innerHTML = `<div class="view-stage${viewAnimCls}">
    ${navHtml}

    <div class="top">
      <div class="model" title="${esc(s.model_id || s.model)}">
        <span class="model-name">${esc(s.model)}</span>
      </div>
      <div class="top-actions">
        ${renderCompactControl(effectivePct, state.settings, state.compactPhase)}
        <button id="btn-copy" class="icon-btn" title="Copy summary">Copy</button>
      </div>
    </div>

    <div class="hero">
      <div class="hero-left">
        <span class="hero-val num">${fmtTok(s.used_tokens)}</span>
        <span class="hero-limit num">/ ${primaryLimit ? fmtTok(primaryLimit) : '?'}${budgetPrimary ? ' budget' : ''}</span>
      </div>
      <span class="hero-pct num">${primaryLimit ? primaryPct.toFixed(1) + '%' : ''}</span>
    </div>

    <div class="seg-bar">${segsHtml}</div>
    ${renderSparkline(s.history, budget)}

    <div class="metrics">
      ${secondaryMeterHtml}
      ${metaParts.length ? `<div class="sub-meta">${metaParts.join('<span class="sep">·</span>')}</div>` : ''}
      ${sessionStripHtml}
    </div>

    <section>
      <div class="sec-head"><span>Breakdown</span><span class="sec-hint">Click to inspect</span></div>
      <div class="group">${conv.map((c) => renderCategoryRow(c, primaryLimit, itemsForCategory(c.key), viewCtx)).join('')}</div>
      ${rest.length ? `<div class="group">${rest.map((c) => renderCategoryRow(c, primaryLimit, itemsForCategory(c.key), viewCtx)).join('')}</div>` : ''}
      <div class="group">
        <div class="row">
          <span class="mark free"></span>
          <span class="row-name dim">Free space</span>
          <span class="row-tok num dim">${fmtTok(primaryFree)}</span>
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

    ${renderSubagentsSection(s.subagents, state.settings.displayMode)}
    ${ckHtml}
    ${renderFilesSection('Skills loaded', s.skill_files, activeCid)}
    ${renderFilesSection('Artifacts', s.artifact_files, activeCid)}
    ${renderFilesSection('Knowledge', s.knowledge_files, activeCid)}
    ${renderFilesSection('System paths', s.system_files, activeCid)}
    ${renderSettingsPopover({ settings: state.settings, settingsOpen: state.settingsOpen, justOpened: state.justOpened })}
    ${renderUpdateDrawer({
      updateDrawerOpen: state.updateDrawerOpen,
      updateInfo: state.updateInfo,
      updateStatusMsg: state.updateStatusMsg,
      updating: state.updating,
      justOpened: state.justOpened,
    })}

    <footer>
      <span class="foot-left">
        <span class="num">${esc(s.conversation_id.slice(0, 8))}</span>
        ${u ? `<span class="num">· v${esc(u.currentVersion)}</span>` : ''}
        ${updateBadge}
      </span>
      <span class="foot-right">
        <span class="num">Updated ${esc(ts)}</span>
        <button id="btn-settings" class="gear-btn ${state.settingsOpen ? 'active' : ''}" title="Settings" aria-label="Settings">⚙</button>
      </span>
    </footer>
  </div>`;

  clearJustOpened();

  if (scrollMap.size > 0) {
    $main.querySelectorAll('.peek[data-peek-id] pre').forEach((pre) => {
      const saved = scrollMap.get(pre.parentElement.dataset.peekId);
      if (saved) {
        pre.scrollTop = saved[0];
        pre.scrollLeft = saved[1];
      }
    });
  }

  wireSparkline(s.history, budget);
}

function showEmpty(msg) {
  state.report = null;
  state.reportCid = '';
  state.fingerprint = '';
  const viewAnim = state.pendingTransition;
  state.pendingTransition = '';
  const viewAnimCls = viewAnim ? ` anim-${viewAnim}` : '';
  const backHtml = state.navStack.length
    ? `<div class="nav-bar"><div class="nav-left"><button id="btn-nav-back" class="nav-back">← Back</button><span class="nav-title">${esc(state.navStack[state.navStack.length - 1].label)}</span></div></div>`
    : '';
  $main.innerHTML = `<div class="view-stage${viewAnimCls}">${backHtml}<p class="empty">${esc(msg)}</p></div>`;
}

// --- Delegated click handling ---

async function handleMainClick(e) {
  const target = e.target instanceof Element ? e.target : e.target?.parentElement;
  if (!target) return;

  // Nested peek controls (matched before .child-row[data-id])
  const retryBtn = target.closest('.btn-retry-peek');
  if (retryBtn) {
    const { kind, id } = retryBtn.dataset;
    const cid = activeConversationId();
    const cacheKey = `${cid}:${state.fingerprint}:${kind}:${id}`;
    state.itemCache.delete(cacheKey);
    render();
    await fetchFullItem(kind, id, { force: true });
    if (cid === activeConversationId() && state.openItems.has(id)) render();
    return;
  }

  const copyPeekBtn = target.closest('.btn-copy-peek');
  if (copyPeekBtn) {
    const { kind, id } = copyPeekBtn.dataset;
    const item = await fetchFullItem(kind, id);
    if (item) copyText(itemCopyBody(kind, item), copyPeekBtn);
    return;
  }

  const peekMoreBtn = target.closest('.peek-more');
  if (peekMoreBtn) {
    state.fullPeek.add(peekMoreBtn.dataset.more);
    render();
    return;
  }

  // ID-based buttons
  const copyBtn = target.closest('#btn-copy');
  if (copyBtn) {
    const s = state.report && state.report.summary;
    if (s) copyText(s.cli_text, copyBtn);
    return;
  }

  if (target.closest('#btn-cache-meta')) {
    const su = state.report && state.report.summary && state.report.summary.session_usage;
    if (su) {
      state.sessionSummaryOpen = !state.sessionSummaryOpen;
      if (state.sessionSummaryOpen) state.justOpened.session = true;
      render();
    }
    return;
  }

  if (target.closest('#btn-nav-back')) {
    if (state.navStack.length) {
      state.navStack.pop();
      resetViewState({ transition: 'back' });
      refresh(true);
    }
    return;
  }

  if (target.closest('#btn-open-sub')) {
    try {
      if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleConversation === 'function') {
        window.sidecar.ui.toggleConversation(activeConversationId());
      }
    } catch {
      // ignore host bridge error
    }
    return;
  }

  if (target.closest('#btn-compact')) {
    if (state.settings.compactAction === 'copy') triggerCompact();
    else setCompactPhase('confirm', 6000);
    return;
  }

  if (target.closest('#btn-compact-yes')) {
    triggerCompact();
    return;
  }

  if (target.closest('#btn-compact-no')) {
    setCompactPhase('idle');
    return;
  }

  if (target.closest('#btn-settings')) {
    state.settingsOpen = !state.settingsOpen;
    if (state.settingsOpen) {
      state.updateDrawerOpen = false;
      state.justOpened.settings = true;
    }
    render();
    return;
  }

  if (target.closest('#btn-set-close')) {
    state.settingsOpen = false;
    render();
    return;
  }

  if (target.closest('#btn-upd-pill')) {
    state.updateDrawerOpen = !state.updateDrawerOpen;
    if (state.updateDrawerOpen) {
      state.settingsOpen = false;
      state.justOpened.update = true;
    }
    render();
    return;
  }

  if (target.closest('#btn-upd-close')) {
    state.updateDrawerOpen = false;
    render();
    return;
  }

  if (target.closest('#btn-upd-pull')) {
    runOneClickUpdate();
    return;
  }

  const updCopyBtn = target.closest('#btn-upd-copy');
  if (updCopyBtn) {
    if (state.updateInfo) copyText(state.updateInfo.updateCommand, updCopyBtn);
    return;
  }

  // Data-attribute controls & rows
  const segOpt = target.closest('.seg-opt[data-set-key]');
  if (segOpt) {
    const key = segOpt.dataset.setKey;
    const raw = segOpt.dataset.setVal;
    const val = key === 'compactThreshold' ? Number(raw) : raw;
    updateSettings({ [key]: val });
    return;
  }

  const subRow = target.closest('.sub-row[data-sub-id]');
  if (subRow) {
    state.navStack.push({ id: subRow.dataset.subId, label: subRow.dataset.subLabel });
    resetViewState({ transition: 'forward' });
    refresh(true);
    return;
  }

  const catRow = target.closest('.row[data-cat]');
  if (catRow) {
    const key = catRow.dataset.cat;
    if (state.openCats.has(key)) {
      state.openCats.delete(key);
    } else {
      state.openCats.add(key);
      state.justOpened.cat = key;
    }
    render();
    return;
  }

  const mcpRow = target.closest('.mcp-srv-row[data-mcp-server]');
  if (mcpRow) {
    const srv = mcpRow.dataset.mcpServer;
    const isOpen = mcpRow.dataset.mcpOpen === '1';
    if (isOpen) {
      state.openMcpServers.delete(srv);
      state.closedMcpServers.add(srv);
    } else {
      state.closedMcpServers.delete(srv);
      state.openMcpServers.add(srv);
      state.justOpened.mcp = srv;
    }
    render();
    return;
  }

  const childRow = target.closest('.child-row[data-id]');
  if (childRow) {
    const { kind, id } = childRow.dataset;
    const cid = activeConversationId();
    if (state.openItems.has(id)) {
      state.openItems.delete(id);
      render();
    } else {
      state.openItems.add(id);
      state.justOpened.item = id;
      render();
      await fetchFullItem(kind, id);
      if (cid === activeConversationId() && state.openItems.has(id)) render();
    }
  }
}

async function refresh(force = false) {
  if (document.hidden && !force) return;
  if (!force && refreshInFlight) return;
  const seq = force ? ++refreshSeq : refreshSeq;
  const cid = activeConversationId();
  activeRefreshes += 1;
  refreshInFlight = true;
  try {
    const qs = new URLSearchParams({ conversationId: cid, workspace });
    const res = await doFetch(`/api/report?${qs}`);
    if (!res.ok) return;
    const data = await res.json();

    if (seq !== refreshSeq || cid !== activeConversationId()) return;
    if (!data || typeof data !== 'object') return;
    if (data.error === 'no-conversation') return showEmpty('Open a conversation to see its context usage.');
    if (data.error === 'no-database') return showEmpty('Waiting for conversation data…');
    if (data.error) return showEmpty(data.message || data.error);

    const nextFp = data.summary.fingerprint;
    if (!force && state.report && nextFp === state.fingerprint) return;

    if (state.openItems.size > 0) {
      const all = [
        ...data.index.system_sections.map((x) => ['system', x.id]),
        ...data.index.tools.map((x) => ['tool', x.id]),
        ...data.index.messages.map((x) => ['message', x.id]),
      ];
      await Promise.allSettled(
        [...state.openItems].map((id) => {
          const pair = all.find(([, xid]) => xid === id);
          return pair ? fetchFullItem(pair[0], pair[1], { fp: nextFp }) : null;
        }),
      );
      if (seq !== refreshSeq || cid !== activeConversationId()) return;
    }

    if (state.fingerprint && state.fingerprint !== nextFp) {
      pruneStaleCache(cid, nextFp);
    }
    state.report = data;
    state.reportCid = cid;
    state.fingerprint = nextFp;
    render();
  } catch {
    // ignore transient poll error
  } finally {
    activeRefreshes = Math.max(0, activeRefreshes - 1);
    refreshInFlight = activeRefreshes > 0;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

async function start() {
  $main.addEventListener('click', handleMainClick);

  if (window.sidecar) {
    if (window.sidecar.getWorkspaceUris) {
      try {
        const uris = await window.sidecar.getWorkspaceUris();
        workspace = (uris && uris[0]) || '';
      } catch { /* ignore */ }
    }
    if (window.sidecar.onWorkspaceChange) {
      try {
        window.sidecar.onWorkspaceChange((next) => {
          const first = (next && next[0]) || '';
          if (first !== workspace) {
            workspace = first;
            state.fingerprint = '';
            refreshSeq += 1;
            refresh(true);
          }
        });
      } catch { /* ignore */ }
    }
    if (window.sidecar.onConversationChange) {
      try {
        window.sidecar.onConversationChange((nextId) => {
          const normalized = nextId || '';
          if (!normalized) {
            rootConversationId = '';
            state.navStack = [];
            resetViewState({ clearCache: true });
            showEmpty('Open a conversation to see its context usage.');
            return;
          }
          if (normalized !== rootConversationId) {
            rootConversationId = normalized;
            state.navStack = [];
            resetViewState({ clearCache: true, transition: 'switch' });
            refresh(true);
          }
        });
      } catch { /* ignore */ }
    }
  }
  await loadSettings();
  checkUpdates();
  await refresh(true);
  setInterval(() => refresh(false), POLL_MS);
}

start();
})(typeof __CI !== 'undefined' ? __CI : (globalThis.__CI = globalThis.__CI || {}));
