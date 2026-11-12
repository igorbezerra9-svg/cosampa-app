/* ───────────────────────────────────────────────────────────────────────────
   COSAMPA — Dashboard, Comparativos (período / reincidência) e Cosampa × Enel.
   Depende de globais do index.html: state, col, esc, alertLevel, setTab, setPeriod,
   fetchSheet, cleanRows, openDetailReit, render.
   ─────────────────────────────────────────────────────────────────────────── */

const C_BT = '#f0a500', C_MT = '#3b82f6', C_COS = '#f0a500', C_ENEL = '#14b8a6';
const LVL_COL = { critical:'#ef4444', high:'#f97316', medium:'#eab308', low:'#22c55e' };
const LVL_LBL = { critical:'Crítico (5+)', high:'Alto (4)', medium:'Médio (3)', low:'Baixo (2)' };
const DAY = 86400000;
const BURST_MS = 60 * 60000;           // eventos do mesmo CD com < 1h entre si = mesma ocorrência
const MESES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

const dashState = { cmpDays:30, cmpBase:'all', cmpSort:'vol', reincBase:'BT', reincDays:7, enelBase:'BT', enelDays:7 };
let _evCache = { key:null, list:[] };

/* ── utilidades ─────────────────────────────────────────────────────────── */
const fN = n => Number(n || 0).toLocaleString('pt-BR');
const cleanV = v => { v = String(v == null ? '' : v).trim(); return v === '#N/A' ? '' : v; };
function parseDT(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) : null;
}
const fDM = t => { const d = new Date(t); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0'); };
const fDMY = t => fDM(t) + '/' + String(new Date(t).getFullYear()).slice(2);
function fGap(days) { return days < 2 ? Math.max(1, Math.round(days * 24)) + 'h' : Math.round(days) + 'd'; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x,y) => x-y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; }

/* ── eventos normalizados (BT = CDs, MT = elementos operados) ───────────── */
function rowsToEvents(rows, src, keyNames) {
  const out = [];
  (rows || []).forEach(r => {
    const d = parseDT(col(r, 'Data', 'DATA', 'data'));
    const cd = cleanV(col(r, ...keyNames));
    if (!d || !cd) return;
    out.push({
      src, cd, t: d.getTime(),
      alim: cleanV(col(r, 'ALIMENTADOR', 'Alimentador')),
      cs: cleanV(col(r, 'CENTRO DE SERVIÇO', 'CENTRO DE SERVICO')) || 'Não informado',
      mun: cleanV(col(r, 'MUNICIPIO', 'Município')) || 'Não informado',
      causa: cleanV(col(r, 'Tipo de Causa', 'TIPO_CAUSA')) || 'Não informada',
      tipo: cleanV(col(r, 'Tipo de Incidencia', 'TIPO_INCIDENCIA')) || 'Não informado',
      cli: parseInt(col(r, 'CLIENTES', 'Clientes')) || 0,
      obs: col(r, 'OBSERVAÇÕES', 'OBSERVACOES', 'Observações') || '',
    });
  });
  return out;
}
function dashEvents() {
  if (_evCache.key === state.data) return _evCache.list;
  const list = [
    ...rowsToEvents(state.data.reiteradas, 'BT', ['CD', 'Código', 'Code', 'cd']),
    ...rowsToEvents(state.data.reiteradasMT, 'MT', ['ELEMENTO OPERADO', 'Elemento Operado', 'CD']),
  ].sort((a, b) => a.t - b.t);
  _evCache = { key: state.data, list };
  return list;
}
const periodStart = () => state.periodFilter === 'all' ? 0 : Date.now() - parseInt(state.periodFilter) * DAY;

/* ── agrupamentos ───────────────────────────────────────────────────────── */
function reits(evs) {                      // CDs/elementos com 2+ ocorrências no conjunto
  const m = new Map();
  evs.forEach(e => {
    let g = m.get(e.cd);
    if (!g) { g = { cd:e.cd, alim:e.alim, cs:e.cs, count:0, cli:0, last:0 }; m.set(e.cd, g); }
    g.count++; g.cli += e.cli; if (e.t > g.last) g.last = e.t;
  });
  return [...m.values()].filter(g => g.count > 1).map(g => (g.level = alertLevel(g.count), g))
    .sort((a, b) => b.count - a.count || b.last - a.last);
}
function countBy(evs, fn) {
  const m = new Map();
  evs.forEach(e => {
    const k = fn(e); if (!k) return;
    let o = m.get(k); if (!o) { o = { k, bt:0, mt:0, enel:0, n:0 }; m.set(k, o); }
    o.n++; if (e.src === 'BT') o.bt++; else if (e.src === 'MT') o.mt++; else o.enel++;
  });
  return [...m.values()].sort((a, b) => b.n - a.n);
}
/* Junta eventos colados (< 1h, mesma origem) numa ocorrência única, por CD. */
function occurrences(evs) {
  const by = new Map();
  [...evs].sort((a, b) => a.t - b.t).forEach(e => {
    let list = by.get(e.cd); if (!list) { list = []; by.set(e.cd, list); }
    const last = list[list.length - 1];
    if (last && last.src === e.src && e.t - last.end < BURST_MS) { last.end = e.t; last.n++; last.cli = Math.max(last.cli, e.cli); return; }
    list.push({ cd:e.cd, src:e.src, alim:e.alim, cs:e.cs, causa:e.causa, cli:e.cli, t:e.t, end:e.t, n:1 });
  });
  return by;
}
function pairsOf(occMap) {                 // pares de ocorrências consecutivas do mesmo CD
  const pairs = [];
  occMap.forEach(list => { for (let i = 1; i < list.length; i++) pairs.push({ x:list[i-1], y:list[i], gap:(list[i].t - list[i-1].end) / DAY }); });
  return pairs;
}

/* ── componentes visuais ────────────────────────────────────────────────── */
function dlt(c, p) {
  if (!c && !p) return '<span class="dl eq">—</span>';
  if (!p) return '<span class="dl up">▲ novo</span>';
  const d = c - p; if (!d) return '<span class="dl eq">= 0%</span>';
  const pc = Math.round(Math.abs(d) / p * 100);
  return `<span class="dl ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${fN(Math.abs(d))} <small>(${d > 0 ? '+' : '−'}${pc}%)</small></span>`;
}
function kpi(label, value, o = {}) {
  return `<div class="kpi ${o.cls || ''}"><div class="k-l">${label}</div><div class="k-v">${value}</div><div class="k-s">${o.sub || ''}</div></div>`;
}
function card(title, body, o = {}) {
  return `<section class="dcard${o.span ? ' span' + o.span : ''}"><div class="dcard-h"><h3>${title}</h3>${o.right ? `<div class="legend">${o.right}</div>` : (o.sub ? `<span>${o.sub}</span>` : '')}</div>${body}</section>`;
}
const legend = items => items.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
function chips(label, current, opts, key) {
  return `<div class="chip-row">${label ? `<span class="lbl">${label}</span>` : ''}${opts.map(([v, l]) =>
    `<button class="filter-chip${String(current) === String(v) ? ' active' : ''}" onclick="dashSet('${key}',${typeof v === 'number' ? v : `'${v}'`})">${l}</button>`).join('')}</div>`;
}
const periodChips = () => `<div class="chip-row">${[['all','Todos'],['30','30 dias'],['90','90 dias'],['180','180 dias']].map(([v, l]) =>
  `<button class="filter-chip${state.periodFilter === v ? ' active' : ''}" onclick="setPeriod('${v}')">${l}</button>`).join('')}</div>`;
const noData = '<div class="no-items">Sem dados neste período</div>';

function hbars(items) {
  if (!items.length) return noData;
  const tot = i => i.segs.reduce((s, x) => s + x.v, 0);
  const mx = Math.max(1, ...items.map(tot));
  return '<div class="hb">' + items.map(i => {
    const go = i.go ? ` data-go="${esc(i.go)}" role="button" tabindex="0"` : '';
    return `<div class="hb-row${i.go ? ' clickable' : ''}"${go}>
      <div class="hb-l" title="${esc(i.label)}">${esc(i.label)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</div>
      <div class="hb-t">${i.segs.map(s => s.v ? `<div class="hb-s" style="width:${(s.v / mx * 100).toFixed(2)}%;background:${s.c}" title="${esc(s.t || '')}: ${s.v}"></div>` : '').join('')}</div>
      <div class="hb-v">${fN(tot(i))}</div></div>`;
  }).join('') + '</div>';
}

/* largura útil (px) de um card, pra o SVG caber sem ficar com fonte minúscula no celular */
const contentW = () => (document.getElementById('mainContent') || {}).clientWidth || 360;
function cardW(span = 1) {
  const vw = contentW();                       // mesmos pontos de corte do CSS (900px/1500px de tela, menos 208px do menu)
  const cols = vw >= 1250 ? 3 : vw >= 650 ? 2 : 1;
  const pad = vw >= 650 ? 48 : 24, gap = 14;
  const colw = (vw - pad - (cols - 1) * gap) / cols, s = Math.min(span, cols);
  return Math.max(260, Math.round(colw * s + (s - 1) * gap - 30));
}
/* gráfico de colunas (agrupadas por série). cols: [{l, v:[...]}] */
function chartCols(cols, series, { span = 1, H = 220, labelEvery = 1 } = {}) {
  if (!cols.length) return noData;
  const W = cardW(span), L = 34, R = 6, T = 16, B = 24, iw = W - L - R, ih = H - T - B;
  const mxv = Math.max(1, ...cols.map(c => Math.max(...c.v)));
  const raw = mxv / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, [1, 2, 5, 10].map(m => m * p).find(s => s >= raw)), top = Math.ceil(mxv / step) * step;
  const gw = iw / cols.length, bw = Math.max(3, Math.min(28, gw * 0.78 / series.length));
  let g = '', bars = '';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = T + ih - v / top * ih;
    g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="ax" x="${L - 5}" y="${y + 3}" text-anchor="end">${fN(v)}</text>`;
  }
  cols.forEach((c, i) => {
    const x0 = L + i * gw + (gw - bw * series.length) / 2;
    series.forEach((s, si) => {
      const v = c.v[si], h = v / top * ih, x = x0 + si * bw;
      bars += `<rect x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.c}"><title>${esc(c.l)} · ${esc(s.n)}: ${fN(v)}</title></rect>`;
      if (v && bw >= 12) bars += `<text class="vl" x="${(x + (bw - 1) / 2).toFixed(1)}" y="${(T + ih - h - 3).toFixed(1)}" text-anchor="middle">${fN(v)}</text>`;
    });
    if (i % labelEvery === 0) bars += `<text class="ax" x="${(L + i * gw + gw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(c.l)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="gráfico">${g}${bars}</svg>`;
}
function monthlyCols(evs, series) {
  if (!evs.length) return [];
  const key = e => { const d = new Date(e.t); return d.getFullYear() * 12 + d.getMonth(); };
  let lo = Infinity, hi = -Infinity; evs.forEach(e => { const k = key(e); if (k < lo) lo = k; if (k > hi) hi = k; });
  const cols = []; for (let k = lo; k <= hi; k++) cols.push({ l: MESES[k % 12] + (hi - lo > 11 ? "'" + String(Math.floor(k / 12)).slice(2) : ''), v: series.map(() => 0) });
  evs.forEach(e => { const si = series.findIndex(s => s.k === e.src); if (si >= 0) cols[key(e) - lo].v[si]++; });
  return cols;
}

/* ═══════════════════════════ DASHBOARD ═══════════════════════════ */
function dashHTML() {
  const all = dashEvents(), a = periodStart();
  const evs = all.filter(e => e.t >= a);
  const bt = evs.filter(e => e.src === 'BT'), mt = evs.filter(e => e.src === 'MT');
  let pBT = null, pMT = null;
  if (state.periodFilter !== 'all') {
    const n = parseInt(state.periodFilter) * DAY;
    const prev = all.filter(e => e.t >= a - n && e.t < a);
    pBT = prev.filter(e => e.src === 'BT').length; pMT = prev.filter(e => e.src === 'MT').length;
  }
  const rBT = reits(bt), rMT = reits(mt);
  const critBT = rBT.filter(g => g.level === 'critical').length, critMT = rMT.filter(g => g.level === 'critical').length;
  const pairs = pairsOf(occurrences(evs));
  const fast = pairs.filter(p => p.gap <= 7).length, occTotal = (() => { let n = 0; occurrences(evs).forEach(l => n += l.length); return n; })();
  const cli = bt.reduce((s, e) => s + e.cli, 0);
  const lvl = [...rBT, ...rMT];
  const levels = ['critical', 'high', 'medium', 'low'].map(l => ({
    label: LVL_LBL[l], sub: `BT ${rBT.filter(g => g.level === l).length} · MT ${rMT.filter(g => g.level === l).length}`,
    segs: [{ v: lvl.filter(g => g.level === l).length, c: LVL_COL[l], t: LVL_LBL[l] }] }));
  const seg2 = o => [{ v: o.bt, c: C_BT, t: 'BT' }, { v: o.mt, c: C_MT, t: 'MT' }];
  const topList = (list, tabKey) => hbars(list.slice(0, 10).map(g => ({
    label: g.cd, sub: g.alim + (g.cs && g.cs !== 'Não informado' ? ' · ' + g.cs : ''),
    segs: [{ v: g.count, c: LVL_COL[g.level], t: LVL_LBL[g.level] }], go: tabKey + '|' + g.cd })));
  const hours = Array.from({ length: 24 }, (_, h) => ({ l: String(h).padStart(2, '0'), v: [0, 0] }));
  evs.forEach(e => { hours[new Date(e.t).getHours()].v[e.src === 'BT' ? 0 : 1]++; });
  const S = [{ k:'BT', n:'BT', c:C_BT }, { k:'MT', n:'MT', c:C_MT }];
  const lg = legend([['BT (CDs)', C_BT], ['MT (chaves)', C_MT]]);
  const since = all.length ? fDMY(all[0].t) : '';

  return `
  <div class="dash-top"><h2>Dashboard<small>BT + MT · dados de ${since} até ${all.length ? fDMY(all[all.length - 1].t) : '—'}</small></h2>${periodChips()}</div>
  <div class="kpi-grid">
    ${kpi('Ocorrências BT', fN(bt.length), { cls:'bt', sub: pBT === null ? 'todo o histórico' : dlt(bt.length, pBT) + ' vs período anterior' })}
    ${kpi('Ocorrências MT', fN(mt.length), { cls:'mt', sub: pMT === null ? 'todo o histórico' : dlt(mt.length, pMT) + ' vs período anterior' })}
    ${kpi('CDs reiterados (BT)', fN(rBT.length), { sub: critBT + ' críticos (5+)' })}
    ${kpi('Elem. reiterados (MT)', fN(rMT.length), { sub: critMT + ' críticos (5+)' })}
    ${kpi('Voltaram em ≤ 7 dias', fN(fast), { cls:'red', sub: occTotal ? Math.round(fast / occTotal * 100) + '% das ocorrências' : '' })}
    ${kpi('Clientes afetados (BT)', fN(cli), { sub: 'soma das ocorrências' })}
  </div>
  <div class="dash-grid">
    ${card('Evolução mensal', chartCols(monthlyCols(evs, S), S, { span: 2 }), { span: 2, right: lg })}
    ${card('Por centro de serviço', hbars(countBy(evs, e => e.cs).map(o => ({ label: o.k, segs: seg2(o) }))), { right: lg })}
    ${card('Gravidade dos reiterados', hbars(levels), { sub: 'CDs + elementos' })}
    ${card('Principais causas', hbars(countBy(evs, e => e.causa).slice(0, 8).map(o => ({ label: o.k, segs: seg2(o) }))), { right: lg })}
    ${card('Alimentadores com mais ocorrências', hbars(countBy(evs, e => e.alim).slice(0, 10).map(o => ({ label: o.k, segs: seg2(o) }))), { right: lg })}
    ${card('Municípios', hbars(countBy(evs, e => e.mun).slice(0, 10).map(o => ({ label: o.k, segs: seg2(o) }))), { right: lg })}
    ${card('Top CDs reiterados (BT)', topList(rBT, 'reiteradas'), { sub: 'toque para abrir' })}
    ${card('Top elementos reiterados (MT)', topList(rMT, 'reiteradasMT'), { sub: 'toque para abrir' })}
    ${card('Tipo de incidência', hbars(countBy(evs, e => e.tipo).slice(0, 8).map(o => ({ label: o.k, segs: seg2(o) }))), { right: lg })}
    ${card('Ocorrências por hora do dia', chartCols(hours, S, { span: 2, H: 200, labelEvery: contentW() < 650 ? 3 : 1 }), { span: 2, right: lg })}
  </div>`;
}

/* ═══════════════════════════ COMPARATIVO POR PERÍODO ═══════════════════════════ */
function dashSet(k, v) { dashState[k] = v; render(); }

function cmpTable(cur, prv, fn, limit = 12) {
  const m = new Map();
  const add = (evs, f) => evs.forEach(e => { const k = fn(e); if (!k) return; let o = m.get(k); if (!o) { o = { k, c:0, p:0 }; m.set(k, o); } o[f]++; });
  add(cur, 'c'); add(prv, 'p');
  let rows = [...m.values()];
  rows = dashState.cmpSort === 'up' ? rows.sort((a, b) => (b.c - b.p) - (a.c - a.p) || b.c - a.c) : rows.sort((a, b) => b.c - a.c || b.p - a.p);
  rows = rows.slice(0, limit);
  if (!rows.length) return noData;
  return `<div class="dtable-wrap"><table class="dtable"><thead><tr><th>Nome</th><th class="r">Atual</th><th class="r">Anterior</th><th class="r">Variação</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.k)}</td><td class="r n">${fN(r.c)}</td><td class="r m">${fN(r.p)}</td><td class="r">${dlt(r.c, r.p)}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function cmpPeriodoHTML() {
  const D = dashState, n = D.cmpDays, now = Date.now();
  const all = dashEvents().filter(e => D.cmpBase === 'all' || e.src === D.cmpBase);
  const cur = all.filter(e => e.t >= now - n * DAY), prv = all.filter(e => e.t >= now - 2 * n * DAY && e.t < now - n * DAY);
  const first = dashEvents()[0];
  const incomplete = first && first.t > now - 2 * n * DAY;
  const rc = reits(cur), rp = reits(prv);
  const cnt = (rs, l) => rs.filter(g => g.level === l).length;
  const totals = [
    ['Ocorrências', cur.length, prv.length],
    ['CDs / elementos reiterados (2+)', rc.length, rp.length],
    ['Críticos (5+ ocorrências)', cnt(rc, 'critical'), cnt(rp, 'critical')],
    ['Clientes afetados (só BT)', cur.reduce((s, e) => s + e.cli, 0), prv.reduce((s, e) => s + e.cli, 0)],
  ];
  return `
  <div class="dash-top"><h2>Comparativo por período<small>últimos ${n} dias × ${n} dias anteriores</small></h2></div>
  <div class="chip-row" style="gap:16px">
    ${chips('Janela', n, [[30,'30 dias'],[90,'90 dias'],[180,'180 dias']], 'cmpDays')}
    ${chips('Base', D.cmpBase, [['all','BT + MT'],['BT','Só BT'],['MT','Só MT']], 'cmpBase')}
    ${chips('Ordenar', D.cmpSort, [['vol','Maior volume'],['up','Maior alta']], 'cmpSort')}
  </div>
  ${incomplete ? `<div class="dash-note"><b>Atenção:</b> a planilha só tem dados desde ${fDMY(first.t)}, então o período anterior está <b>incompleto</b> e a variação aparece exagerada. Use uma janela menor.</div>` : ''}
  <div class="dash-grid">
    ${card('Resumo', `<div class="dtable-wrap"><table class="dtable"><thead><tr><th></th><th class="r">Atual</th><th class="r">Anterior</th><th class="r">Variação</th></tr></thead><tbody>
      ${totals.map(([l, c, p]) => `<tr><td>${l}</td><td class="r n">${fN(c)}</td><td class="r m">${fN(p)}</td><td class="r">${dlt(c, p)}</td></tr>`).join('')}</tbody></table></div>`)}
    ${card('Por centro de serviço', cmpTable(cur, prv, e => e.cs, 8))}
    ${card('Por causa', cmpTable(cur, prv, e => e.causa, 12))}
    ${card('Por município', cmpTable(cur, prv, e => e.mun, 12))}
    ${card('Por alimentador', cmpTable(cur, prv, e => e.alim, 15))}
  </div>`;
}

/* ═══════════════════════════ REINCIDÊNCIA (normalizou e voltou) ═══════════════════════════ */
const GAP_BUCKETS = [[1, '≤ 1 dia'], [3, '1–3 d'], [7, '3–7 d'], [15, '7–15 d'], [30, '15–30 d'], [Infinity, '> 30 d']];
function cmpReincHTML() {
  const D = dashState, src = D.reincBase, N = D.reincDays, a = periodStart();
  const evs = dashEvents().filter(e => e.src === src && e.t >= a);
  const occ = occurrences(evs), pairs = pairsOf(occ);
  let occTotal = 0; occ.forEach(l => occTotal += l.length);
  const quick = pairs.filter(p => p.gap <= N);
  const same = quick.filter(p => p.x.causa === p.y.causa && p.x.causa !== 'Não informada').length;
  const med = median(pairs.map(p => p.gap));
  const dist = GAP_BUCKETS.map(([mx, l], i) => ({ l, v: [pairs.filter(p => p.gap <= mx && p.gap > (i ? GAP_BUCKETS[i - 1][0] : -1)).length] }));
  // ranking
  const byCd = new Map();
  quick.forEach(p => {
    let o = byCd.get(p.x.cd);
    if (!o) { o = { cd:p.x.cd, alim:p.x.alim, cs:p.x.cs, n:0, min:Infinity, last:0, same:0, causas:new Set() }; byCd.set(p.x.cd, o); }
    o.n++; o.min = Math.min(o.min, p.gap); o.last = Math.max(o.last, p.y.t); o.causas.add(p.x.causa); o.causas.add(p.y.causa);
    if (p.x.causa === p.y.causa && p.x.causa !== 'Não informada') o.same++;
  });
  const rank = [...byCd.values()].sort((x, y) => y.n - x.n || x.min - y.min).slice(0, 40);
  const tabKey = src === 'BT' ? 'reiteradas' : 'reiteradasMT';
  const causeTop = countBy(quick.map(p => ({ ...p.y, src })), e => e.causa).slice(0, 8);
  const unit = src === 'BT' ? 'CDs' : 'elementos';

  return `
  <div class="dash-top"><h2>Reincidência<small>o que normalizou e voltou a falhar no mesmo ${src === 'BT' ? 'CD' : 'elemento'} · eventos com menos de 1h contam como uma só ocorrência</small></h2>${periodChips()}</div>
  <div class="chip-row" style="gap:16px">
    ${chips('Base', src, [['BT','BT (CDs)'],['MT','MT (chaves)']], 'reincBase')}
    ${chips('Voltou em até', N, [[2,'2 dias'],[7,'7 dias'],[15,'15 dias'],[30,'30 dias']], 'reincDays')}
  </div>
  <div class="kpi-grid">
    ${kpi('Ocorrências distintas', fN(occTotal), { cls: src === 'BT' ? 'bt' : 'mt', sub: fN(occ.size) + ' ' + unit })}
    ${kpi('Retornos ≤ ' + N + ' dias', fN(quick.length), { cls:'red', sub: occTotal ? Math.round(quick.length / occTotal * 100) + '% das ocorrências' : '' })}
    ${kpi(unit.charAt(0).toUpperCase() + unit.slice(1) + ' que voltaram', fN(byCd.size), { sub: 'pelo menos 1 retorno ≤ ' + N + 'd' })}
    ${kpi('Mesma causa', quick.length ? Math.round(same / quick.length * 100) + '%' : '—', { sub: 'voltou pelo mesmo motivo' })}
    ${kpi('Intervalo mediano', med === null ? '—' : fGap(med), { sub: 'entre uma falha e a próxima' })}
    ${kpi('Total de retornos', fN(pairs.length), { sub: 'em qualquer prazo' })}
  </div>
  <div class="dash-grid">
    ${card('Tempo até voltar a falhar', chartCols(dist, [{ n:'Retornos', c: src === 'BT' ? C_BT : C_MT }], { span: 1, H: 210 }), { sub: 'nº de retornos por faixa' })}
    ${card('Causa das falhas que voltaram', hbars(causeTop.map(o => ({ label: o.k, segs: [{ v: o.n, c: C_COS, t: 'Retornos' }] }))), { sub: 'causa da 2ª falha' })}
    ${card('Mais retornos rápidos (≤ ' + N + ' dias)', rank.length ? `<div class="dtable-wrap"><table class="dtable"><thead><tr>
      <th>${src === 'BT' ? 'CD' : 'Elemento'}</th><th>Alimentador</th><th class="r">Retornos</th><th class="r">Menor intervalo</th><th class="r">Mesma causa</th><th class="r">Última</th></tr></thead><tbody>
      ${rank.map(r => `<tr data-go="${esc(tabKey + '|' + r.cd)}"><td class="n">${esc(r.cd)}</td><td class="m">${esc(r.alim)}${r.cs !== 'Não informado' ? ' · ' + esc(r.cs) : ''}</td>
        <td class="r n">${r.n}</td><td class="r">${fGap(r.min)}</td><td class="r m">${r.same}/${r.n}</td><td class="r m">${fDMY(r.last)}</td></tr>`).join('')}
      </tbody></table></div>` : noData, { span: 3, sub: 'toque numa linha para abrir' })}
  </div>`;
}

/* ═══════════════════════════ COSAMPA × ENEL ═══════════════════════════
   Quem atendeu = código da equipe que aparece na observação (ex.: "MLS-RD-15B").
   Código que consta na lista de Estrutura (equipes.json) = Cosampa; qualquer outro código = Enel;
   sem código = não dá para saber (disparo automático ou equipe não informada) e fica de fora. */
const TEAM_RE = /\b[A-Z]{2,4}-[A-Z]{2,4}-\d{1,3}[A-Z]?\b/;
let EQUIPES = null, EQUIPES_LOADING = false, EQUIPES_ERR = false;
async function loadEquipesIfNeeded() {
  if (EQUIPES !== null || EQUIPES_LOADING) return;
  EQUIPES_LOADING = true;
  try {
    const r = await fetch('equipes.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    EQUIPES = new Set((await r.json()).equipes.map(e => e.c));
  } catch (e) { EQUIPES = new Set(); EQUIPES_ERR = true; }
  EQUIPES_LOADING = false;
}
function atorOf(obs) {                     // 'COS' | 'ENEL' | null (sem código de equipe)
  const m = String(obs || '').toUpperCase().match(TEAM_RE);
  return m ? (EQUIPES.has(m[0]) ? 'COS' : 'ENEL') : null;
}
function cmpEnelHTML() {
  const head = `<div class="dash-top"><h2>Cosampa × Enel<small>quem atendeu cada ocorrência e quem voltou lá depois</small></h2>`;
  if (EQUIPES_ERR) return head + `</div><div class="dash-note"><b>Não consegui carregar a lista de equipes (equipes.json).</b> Sem ela não dá para separar Cosampa de Enel. Confira se o arquivo foi publicado junto com o app e tente atualizar.</div>`;
  const D = dashState, N = D.enelDays, src = D.enelBase, a = periodStart();
  const base = dashEvents().filter(e => e.src === src && e.t >= a);
  const ev = []; let und = 0;
  base.forEach(e => { const t = atorOf(e.obs); if (!t) und++; else ev.push({ ...e, src: t }); });
  const cos = ev.filter(e => e.src === 'COS'), ene = ev.filter(e => e.src === 'ENEL');
  const occ = occurrences(ev), pairs = pairsOf(occ);
  const q = pairs.filter(p => p.gap <= N), kind = (x, y) => q.filter(p => p.x.src === x && p.y.src === y).length;
  const cc = kind('COS', 'COS'), ce = kind('COS', 'ENEL'), ec = kind('ENEL', 'COS'), ee = kind('ENEL', 'ENEL');
  let both = 0; occ.forEach(l => { if (l.some(o => o.src === 'COS') && l.some(o => o.src === 'ENEL')) both++; });
  const swaps = new Map(); q.filter(p => p.x.src !== p.y.src).forEach(p => swaps.set(p.x.cd, (swaps.get(p.x.cd) || 0) + 1));
  const rank = [...swaps.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40);
  const S = [{ k:'COS', n:'Cosampa', c:C_COS }, { k:'ENEL', n:'Enel', c:C_ENEL }];
  const cnt2 = fn => countBy(ev, fn).map(o => ({ label: o.k, segs: [{ v: cos.filter(e => fn(e) === o.k).length, c: C_COS, t: 'Cosampa' }, { v: ene.filter(e => fn(e) === o.k).length, c: C_ENEL, t: 'Enel' }] }));
  const lg = legend([['Cosampa', C_COS], ['Enel', C_ENEL]]);
  const tl = cd => { const l = occ.get(cd).slice(-8); return `<div class="tl-row">${l.map((o, i) => {
      const g = i ? (o.t - l[i - 1].end) / DAY : null;
      return (i ? `<i class="tl-gap${g <= N ? ' fast' : ''}">→ ${fGap(g)} →</i>` : '') + `<span class="tl ${o.src === 'ENEL' ? 'e' : 'c'}" title="${esc(o.causa)}">${o.src === 'ENEL' ? 'Enel' : 'Cosampa'} ${fDM(o.t)}</span>`;
    }).join('')}</div>`; };
  const tabKey = src === 'BT' ? 'reiteradas' : 'reiteradasMT', unit = src === 'BT' ? 'CD' : 'Elemento';
  const cov = base.length ? Math.round(ev.length / base.length * 100) : 0;

  return head + `${periodChips()}</div>
  <div class="chip-row" style="gap:16px">
    ${chips('Base', src, [['BT','BT (CDs)'],['MT','MT (chaves)']], 'enelBase')}
    ${chips('Voltou em até', N, [[2,'2 dias'],[7,'7 dias'],[15,'15 dias'],[30,'30 dias']], 'enelDays')}
  </div>
  <div class="dash-note">Classificado pelo <b>código da equipe na observação</b>: está na lista de Estrutura = <b>Cosampa</b>; outro código = <b>Enel</b>. Foi possível identificar <b>${fN(ev.length)} de ${fN(base.length)}</b> ocorrências (<b>${cov}%</b>); as ${fN(und)} restantes não trazem código (disparo automático ou equipe não informada) e ficam fora das contas.${src === 'MT' && cov < 60 ? ' <b>Em MT a cobertura é baixa</b>: use com cautela.' : ''} Eventos &lt; 1h da mesma equipe contam como um.</div>
  <div class="kpi-grid">
    ${kpi('Atendidas Cosampa', fN(cos.length), { cls:'bt', sub: ev.length ? Math.round(cos.length / ev.length * 100) + '% das identificadas' : '' })}
    ${kpi('Atendidas Enel', fN(ene.length), { sub: ev.length ? Math.round(ene.length / ev.length * 100) + '% das identificadas' : '' })}
    ${kpi('Cosampa voltou', fN(cc), { cls:'red', sub: 'Cosampa → Cosampa ≤ ' + N + 'd' })}
    ${kpi('Enel voltou', fN(ee), { cls:'red', sub: 'Enel → Enel ≤ ' + N + 'd' })}
    ${kpi('Troca de equipe', fN(ce + ec), { sub: 'Cosampa→Enel ' + ce + ' · Enel→Cosampa ' + ec })}
    ${kpi(unit + 's com as duas', fN(both), { sub: 'falha de todo mundo' })}
  </div>
  <div class="dash-grid">
    ${card('Evolução mensal', chartCols(monthlyCols(ev, S), S, { span: 2 }), { span: 2, right: lg })}
    ${card('Por centro de serviço', hbars(cnt2(e => e.cs)), { right: lg })}
    ${card('Principais causas', hbars(cnt2(e => e.causa).slice(0, 8)), { right: lg })}
    ${card('Onde as equipes se alternaram (≤ ' + N + ' dias)', rank.length ? `<div class="dtable-wrap"><table class="dtable"><thead><tr><th>${unit}</th><th>Alimentador</th><th class="r">Trocas</th><th>Linha do tempo</th></tr></thead><tbody>
      ${rank.map(([cd, n]) => `<tr data-go="${esc(tabKey + '|' + cd)}"><td class="n">${esc(cd)}</td><td class="m">${esc(occ.get(cd)[0].alim)}</td><td class="r n">${n}</td><td>${tl(cd)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="no-items">Nenhuma troca de equipe neste prazo</div>', { span: 3, sub: 'toque numa linha para abrir' })}
  </div>`;
}

/* ═══════════════════════════ ENTRADA + NAVEGAÇÃO ═══════════════════════════ */
function renderWideTab(main) {
  const t = state.tab;
  let html;
  if (t === 'dashboard') html = dashHTML();
  else if (t === 'comp-periodo') html = cmpPeriodoHTML();
  else if (t === 'comp-reinc') html = cmpReincHTML();
  else if (t === 'comp-enel') {
    if (EQUIPES === null) {
      loadEquipesIfNeeded().then(() => { if (state.tab === 'comp-enel') render(); });
      html = '<div class="status-box"><div class="spinner"></div><span>Carregando equipes…</span></div>';
    } else html = cmpEnelHTML();
  }
  main.innerHTML = `<div class="dash">${html || ''}</div>`;
}

/* Abre o detalhe de um CD/elemento a partir de qualquer tela (dashboard, comparativos). */
function openCDByKey(key, tabKey) {
  setTab(tabKey);
  const sorted = tabKey === 'reiteradasMT' ? state.sortedReiteradasMT : state.sortedReiteradas;
  let i = (sorted || []).findIndex(g => g.cd === key);
  if (i >= 0) { openDetailReit(i, tabKey); return; }
  const grp = (tabKey === 'reiteradasMT' ? state.groupedReiteradasMT : state.groupedReiteradas || {})[key];
  if (!grp) return;
  const k = tabKey === 'reiteradasMT' ? 'sortedReiteradasMT' : 'sortedReiteradas', prev = state[k];
  state[k] = [grp]; openDetailReit(0, tabKey); state[k] = prev;
}
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-go]'); if (!el) return;
  const [tab, key] = el.dataset.go.split('|'); openCDByKey(key, tab);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest && e.target.closest('[data-go]'); if (!el) return;
  const [tab, key] = el.dataset.go.split('|'); openCDByKey(key, tab);
});
