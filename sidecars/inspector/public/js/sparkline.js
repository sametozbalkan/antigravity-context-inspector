((CI) => {
  const { esc, fmtTok } = CI.utils;

  function computeSparkCoords(history, budget) {
    const W = 240;
    const H = 44;
    const padX = 4;
    const padY = 5;
    const maxVal = Math.max(...history.map((h) => h.tokens), 1);
    const showBudgetLine = budget > 0 && maxVal >= budget * 0.5;
    const yMax = showBudgetLine ? Math.max(maxVal * 1.08, budget * 1.06) : maxVal * 1.08;
    const n = history.length;
    const toX = (i) => (n > 1 ? padX + (i / (n - 1)) * (W - padX * 2) : W / 2);
    const toY = (v) => H - padY - (Math.max(0, v) / yMax) * (H - padY * 2);
    const pts = history.map((h, i) => {
      const x = toX(i);
      const y = toY(h.tokens);
      return { x, y, xPct: (x / W) * 100, yPct: (y / H) * 100, h };
    });
    const budgetY = showBudgetLine ? toY(budget) : null;
    const budgetYPct = budgetY !== null ? (budgetY / H) * 100 : null;
    return { W, H, padX, pts, budgetY, budgetYPct };
  }

  function renderSparkline(history, budget) {
    if (!history || history.length < 2) return '';
    const { W, H, pts, budgetY, budgetYPct } = computeSparkCoords(history, budget);
    const linePts = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPts = `${pts[0].x.toFixed(1)},${H} ${linePts} ${pts[pts.length - 1].x.toFixed(1)},${H}`;
    const showAllDots = history.length <= 32;
    const dotsHtml = pts
      .map((p, i) => {
        const isLast = i === pts.length - 1;
        const isCk = p.h.compacted;
        if (!showAllDots && !isCk && !isLast) return '';
        const cls = isCk ? 'spark-pt ck' : isLast ? 'spark-pt last' : 'spark-pt';
        return `<span class="${cls}" style="left:${p.xPct.toFixed(2)}%;top:${p.yPct.toFixed(2)}%"></span>`;
      })
      .join('');
    const last = history[history.length - 1];
    const defaultHint = history[0].turn > 1 ? `Last ${history.length} turns` : `${history.length} turns`;

    return `
      <div class="spark-box" id="spark-box">
        <div class="spark-plot" id="spark-plot">
          <svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Context growth over ${history.length} turns">
            <defs>
              <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--c-user)" stop-opacity="0.22"></stop>
                <stop offset="100%" stop-color="var(--c-user)" stop-opacity="0.0"></stop>
              </linearGradient>
            </defs>
            <polygon points="${areaPts}" fill="url(#spark-grad)"></polygon>
            ${budgetY !== null ? `<line class="spark-budget" x1="0" y1="${budgetY.toFixed(1)}" x2="${W}" y2="${budgetY.toFixed(1)}"></line>` : ''}
            <polyline class="spark-line" points="${linePts}"></polyline>
          </svg>
          ${budgetYPct !== null ? `<span class="spark-budget-lbl num${budgetYPct < 30 ? ' below' : ''}" style="top:${budgetYPct.toFixed(2)}%">${fmtTok(budget)}</span>` : ''}
          <span class="spark-guide" id="spark-guide"></span>
          ${dotsHtml}
          <span class="spark-active-dot" id="spark-dot"></span>
        </div>
        <div class="spark-tip num">
          <span id="spark-tip" class="spark-tip-text" data-default="${esc(defaultHint)}">${esc(defaultHint)}</span>
          ${last.delta !== 0 ? `<span id="spark-delta" class="spark-tip-delta">${last.delta > 0 ? '+' : '−'}${fmtTok(Math.abs(last.delta))} last</span>` : ''}
        </div>
      </div>
    `;
  }

  function wireSparkline(history, budget) {
    const box = document.getElementById('spark-box');
    const plot = document.getElementById('spark-plot');
    if (!box || !plot || !history || history.length < 2) return;
    const tip = document.getElementById('spark-tip');
    const deltaEl = document.getElementById('spark-delta');
    const guide = document.getElementById('spark-guide');
    const dot = document.getElementById('spark-dot');
    const { W, padX, pts } = computeSparkCoords(history, budget);
    const padRatio = padX / W;

    box.onmousemove = (e) => {
      const rect = plot.getBoundingClientRect();
      if (!rect.width) return;
      const rel = (e.clientX - rect.left) / rect.width;
      const norm = Math.max(0, Math.min(1, (rel - padRatio) / (1 - padRatio * 2)));
      const idx = Math.round(norm * (pts.length - 1));
      const p = pts[idx];
      const d = p.h.delta;
      const deltaStr = d === 0 ? '' : ` (${d > 0 ? '+' : '−'}${fmtTok(Math.abs(d))})`;
      const ckStr = p.h.compacted ? ' · compacted' : '';
      tip.className = 'spark-tip-text spark-tip-val';
      tip.textContent = `Turn ${p.h.turn} · ${fmtTok(p.h.tokens)}${deltaStr}${ckStr}`;
      if (deltaEl) deltaEl.style.display = 'none';
      guide.style.left = `${p.xPct.toFixed(2)}%`;
      guide.style.display = 'block';
      dot.className = p.h.compacted ? 'spark-active-dot ck' : 'spark-active-dot';
      dot.style.left = `${p.xPct.toFixed(2)}%`;
      dot.style.top = `${p.yPct.toFixed(2)}%`;
      dot.style.display = 'block';
    };

    box.onmouseleave = () => {
      tip.className = 'spark-tip-text';
      tip.textContent = tip.dataset.default || '';
      if (deltaEl) deltaEl.style.display = '';
      guide.style.display = 'none';
      dot.style.display = 'none';
    };
  }

  CI.sparkline = {
    computeSparkCoords,
    renderSparkline,
    wireSparkline,
  };
})(typeof __CI !== 'undefined' ? __CI : (globalThis.__CI = globalThis.__CI || {}));
