((CI) => {
  const {
    COLOR_BY_KEY,
    PEEK_LIMIT,
    esc,
    fmtTok,
    itemCopyBody,
    safeReleaseUrl,
    splitPath,
  } = CI.utils;

  function renderPeek(kind, id, ctx) {
    const cacheKey = `${ctx.activeCid}:${ctx.fingerprint}:${kind}:${id}`;
    const item = ctx.itemCache.get(cacheKey);
    const animCls = ctx.justOpened.item === id ? ' anim-expand' : '';
    if (!item) {
      return `<div class="peek${animCls}"><div class="peek-bar"><span>Loading…</span></div></div>`;
    }
    if (item.__error) {
      return `
        <div class="peek${animCls}" data-peek-id="${esc(id)}">
          <div class="peek-bar">
            <span class="peek-err" title="${esc(item.__error)}">${esc(item.__error)}</span>
            <button class="icon-btn btn-retry-peek" data-kind="${esc(kind)}" data-id="${esc(id)}">Retry</button>
          </div>
        </div>
      `;
    }
    const body = itemCopyBody(kind, item);
    const showAll = ctx.fullPeek.has(id);
    const cut = !showAll && body.length > PEEK_LIMIT;
    const shown = cut ? `${body.slice(0, PEEK_LIMIT)}\n\n…` : body;

    return `
      <div class="peek${animCls}" data-peek-id="${esc(id)}">
        <div class="peek-bar">
          <span class="num">${item.tokens.toLocaleString()} tokens · ${body.length.toLocaleString()} chars</span>
          <button class="icon-btn btn-copy-peek" data-kind="${esc(kind)}" data-id="${esc(id)}">Copy</button>
        </div>
        <pre>${esc(shown || '(empty)')}</pre>
        ${cut ? `<button class="peek-more" data-more="${esc(id)}">Show full content (${body.length.toLocaleString()} chars)</button>` : ''}
      </div>
    `;
  }

  function renderChildRow(ch, ctx) {
    const itemOpen = ctx.openItems.has(ch.id);
    return `
      <div class="child-row ${itemOpen ? 'active' : ''}" data-kind="${esc(ch.kind)}" data-id="${esc(ch.id)}">
        <span class="child-title" title="${esc(ch.title)}">${esc(ch.title)}${ch.sub ? `<span class="child-sub">${esc(ch.sub)}</span>` : ''}</span>
        <span class="child-tok num">${fmtTok(ch.tokens)}</span>
      </div>
      ${itemOpen ? renderPeek(ch.kind, ch.id, ctx) : ''}
    `;
  }

  function renderMcpServerChildren(children, ctx) {
    const byServer = new Map();
    for (const ch of children) {
      const srv = ch.server || 'other';
      if (!byServer.has(srv)) byServer.set(srv, { server: srv, tokens: 0, items: [] });
      const group = byServer.get(srv);
      group.tokens += ch.tokens;
      group.items.push(ch);
    }
    const groups = [...byServer.values()].sort((a, b) => b.tokens - a.tokens);
    const single = groups.length === 1;

    const catAnim = ctx.justOpened.cat === 'mcp_tools' ? ' anim-expand' : '';
    return `<div class="children${catAnim}">${groups.map((g) => {
      const open = ctx.openMcpServers.has(g.server)
        || (single && !ctx.closedMcpServers.has(g.server));
      const mcpAnim = ctx.justOpened.mcp === g.server ? ' anim-expand' : '';
      const countLabel = `${g.items.length} ${g.items.length === 1 ? 'tool' : 'tools'}`;
      return `
        <div class="mcp-srv-row ${open ? 'open' : ''}" data-mcp-server="${esc(g.server)}" data-mcp-open="${open ? '1' : '0'}">
          <span class="mcp-srv-name" title="${esc(g.server)}">${esc(g.server)}</span>
          <span class="mcp-srv-count num">${countLabel}</span>
          <span class="child-tok num">${fmtTok(g.tokens)}</span>
          <span class="chev">›</span>
        </div>
        ${open ? `<div class="mcp-srv-tools${mcpAnim}">${g.items.map((ch) => renderChildRow(ch, ctx)).join('')}</div>` : ''}
      `;
    }).join('')}</div>`;
  }

  function renderCategoryRow(c, displayDenom, children, ctx) {
    const color = Object.hasOwn(COLOR_BY_KEY, c.key) ? COLOR_BY_KEY[c.key] : 'var(--c-custom)';
    const isConv = c.group === 'conv';
    const expandable = children.length > 0;
    const isOpen = expandable && ctx.openCats.has(c.key);
    const rowPct = displayDenom > 0 ? (c.tokens / displayDenom) * 100 : c.pct;

    let childrenHtml = '';
    if (isOpen) {
      const catAnim = ctx.justOpened.cat === c.key ? ' anim-expand' : '';
      childrenHtml = c.key === 'mcp_tools'
        ? renderMcpServerChildren(children, ctx)
        : `<div class="children${catAnim}">${children.map((ch) => renderChildRow(ch, ctx)).join('')}</div>`;
    }

    return `
      <div class="cat-wrap">
        <div class="row ${expandable ? 'clickable' : ''} ${isOpen ? 'open' : ''}" ${expandable ? `data-cat="${esc(c.key)}"` : ''}>
          <span class="mark ${isConv ? '' : 'sq'}" style="background:${color}"></span>
          <span class="row-name">${esc(c.name)}</span>
          <span class="row-tok num">${fmtTok(c.tokens)}</span>
          <span class="row-pct num">${rowPct.toFixed(1)}%</span>
          <span class="chev">${expandable ? '›' : ''}</span>
        </div>
        ${childrenHtml}
      </div>
    `;
  }

  function renderSubagentsSection(subagents, displayMode) {
    if (!subagents || !subagents.length) return '';
    const hasSwarm = subagents.some((sa) => sa.source === 'swarm');
    const hasSub = subagents.some((sa) => sa.source !== 'swarm');
    const heading = hasSwarm && hasSub ? 'Agents & Workers' : hasSwarm ? 'Swarm Workers' : 'Subagents';

    return `
      <section>
        <div class="sec-head"><span>${heading}</span><span class="sec-hint num">${subagents.length}</span></div>
        ${subagents.map((sa) => {
          const isSwarm = sa.source === 'swarm';
          const isKilled = sa.status === 'killed';
          const metaParts = isSwarm
            ? [sa.model, sa.swarm_state && sa.swarm_state !== 'working' ? sa.swarm_state : '']
            : [sa.type_name, sa.model];
          const metaBits = metaParts.filter(Boolean).join(' · ');
          const saLimit = sa.limit_tokens || 0;
          const saBudget = sa.request_budget_tokens || 0;
          const hasSepBudget = saBudget > 0 && (saLimit === 0 || saBudget < saLimit);
          const useBudget = hasSepBudget && (displayMode === 'budget' || !saLimit);
          const saDenom = useBudget ? saBudget : saLimit;
          const pctShown = saDenom > 0
            ? (sa.used_tokens / saDenom) * 100
            : (useBudget ? (sa.budget_pct || 0) : (sa.used_pct || 0));
          const saBudgetPct = saBudget > 0 ? (sa.used_tokens / saBudget) * 100 : (sa.budget_pct || 0);
          const tip = hasSepBudget
            ? `${fmtTok(sa.used_tokens)} / ${fmtTok(saBudget)} budget (${saBudgetPct.toFixed(1)}%)${saLimit ? ` · ${fmtTok(saLimit)} native` : ''}`
            : `${fmtTok(sa.used_tokens)} / ${saLimit ? fmtTok(saLimit) : '?'} tokens`;
          return `
            <div class="sub-row ${isKilled ? 'muted' : ''}" data-sub-id="${esc(sa.conversation_id)}" data-sub-label="${esc(sa.role)}" title="${esc(tip)}">
              <span class="sub-dot ${sa.status === 'running' ? 'running' : ''}" title="${esc(sa.status)}"></span>
              <span class="sub-info">
                <span class="sub-role">
                  <span class="sub-role-text">${esc(sa.role)}</span>
                  ${isSwarm ? '<span class="badge-swarm">swarm</span>' : ''}
                </span>
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

  function renderSettingsPopover({ settings, settingsOpen, justOpened }) {
    if (!settingsOpen) return '';
    const st = settings;
    const thrOpts = [
      [50, '50%'],
      [60, '60%'],
      [75, '75%'],
      [0, 'Off'],
    ];
    const modeOpts = [
      ['native', 'Native'],
      ['budget', 'Budget'],
    ];
    const actOpts = [
      ['send', 'Send'],
      ['copy', 'Copy'],
    ];

    return `
      <div class="settings-box${justOpened.settings ? ' anim-pop' : ''}">
        <div class="settings-head">
          <span>Settings</span>
          <button id="btn-set-close" class="icon-btn" title="Close">✕</button>
        </div>
        <div class="set-row">
          <span>Compact threshold</span>
          <div class="seg-ctrl">
            ${thrOpts.map(([val, lbl]) => `<button class="seg-opt ${st.compactThreshold === val ? 'active' : ''}" data-set-key="compactThreshold" data-set-val="${val}">${lbl}</button>`).join('')}
          </div>
        </div>
        <div class="set-row">
          <span>Primary meter</span>
          <div class="seg-ctrl">
            ${modeOpts.map(([val, lbl]) => `<button class="seg-opt ${st.displayMode === val ? 'active' : ''}" data-set-key="displayMode" data-set-val="${val}">${lbl}</button>`).join('')}
          </div>
        </div>
        <div class="set-row">
          <span>Compact action</span>
          <div class="seg-ctrl">
            ${actOpts.map(([val, lbl]) => `<button class="seg-opt ${st.compactAction === val ? 'active' : ''}" data-set-key="compactAction" data-set-val="${val}">${lbl}</button>`).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function renderCompactControl(effectivePct, settings, compactPhase) {
    const threshold = settings.compactThreshold;
    if (threshold <= 0 && compactPhase === 'idle') return '';
    if (effectivePct < threshold && compactPhase === 'idle') return '';
    const dangerCls = effectivePct >= 85 ? ' danger' : '';
    if (compactPhase === 'confirm') {
      return `
        <button id="btn-compact-yes" class="compact-btn confirm${dangerCls}" title="Send /compact to this conversation">Send /compact</button>
        <button id="btn-compact-no" class="icon-btn" title="Cancel">✕</button>
      `;
    }
    if (compactPhase === 'sending') {
      return `<button class="compact-btn${dangerCls}" disabled>Sending…</button>`;
    }
    if (compactPhase === 'sent') {
      return `<button class="compact-btn sent" disabled>Sent ✓</button>`;
    }
    if (compactPhase === 'copied') {
      return `<button class="compact-btn sent" disabled>Copied /compact</button>`;
    }
    const tip = settings.compactAction === 'copy'
      ? `Context reached ${effectivePct.toFixed(0)}% (≥${threshold}%) — click to copy /compact`
      : `Context reached ${effectivePct.toFixed(0)}% (≥${threshold}%) — click to compact`;
    return `<button id="btn-compact" class="compact-btn${dangerCls}" title="${esc(tip)}">Compact</button>`;
  }

  function renderUpdateDrawer({ updateDrawerOpen, updateInfo, updateStatusMsg, updating, justOpened }) {
    if (!updateDrawerOpen || !updateInfo) return '';
    const u = updateInfo;
    return `
      <div class="update-box${justOpened.update ? ' anim-pop' : ''}">
        <div class="update-head">
          <span>Update v${esc(u.currentVersion)} → v${esc(u.latestVersion)}</span>
          <button id="btn-upd-close" class="icon-btn" title="Close">✕</button>
        </div>
        ${updateStatusMsg ? `<div class="update-note">${esc(updateStatusMsg)}</div>` : ''}
        <div class="update-actions">
          ${u.isGitRepo ? `<button id="btn-upd-pull" class="update-primary" ${updating ? 'disabled' : ''}>${updating ? 'Updating…' : 'Update now'}</button>` : ''}
          <button id="btn-upd-copy" class="icon-btn">Copy command</button>
          <a class="icon-btn" href="${esc(safeReleaseUrl(u.releaseUrl))}" target="_blank" rel="noopener noreferrer">Release ↗</a>
        </div>
      </div>
    `;
  }

  function renderFilesSection(title, items, activeCid) {
    if (!items || !items.length) return '';
    return `
      <section>
        <div class="sec-head"><span>${esc(title)}</span><span class="sec-hint num">${items.length}</span></div>
        <ul class="file-list">
          ${items.map((f) => {
            const { name, dir } = splitPath(f.path, activeCid);
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

  CI.views = {
    renderPeek,
    renderChildRow,
    renderMcpServerChildren,
    renderCategoryRow,
    renderSubagentsSection,
    renderSettingsPopover,
    renderCompactControl,
    renderUpdateDrawer,
    renderFilesSection,
  };
})(typeof __CI !== 'undefined' ? __CI : (globalThis.__CI = globalThis.__CI || {}));
