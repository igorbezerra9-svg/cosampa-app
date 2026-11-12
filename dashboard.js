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

const dashState = { cmpDays:30, cmpBase:'all', cmpSort:'vol', reincBase:'BT', reincDays:7, enelBase:'BT', enelDays:7,
  f:{ base:'all', month:null, cs:null, causa:null, alim:null, mun:null, tipo:null, hora:null, nivel:null } };
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
  const f = o.f ? ` data-f="${esc(o.f)}" role="button" tabindex="0"` : '';
  return `<div class="kpi ${o.cls || ''}${o.f ? ' clk' : ''}${o.sel ? ' sel' : ''}"${f}><div class="k-l">${label}</div><div class="k-v">${value}</div><div class="k-s">${o.sub || ''}</div></div>`;
}
function card(title, body, o = {}) {
  return `<section class="dcard${o.span ? ' span' + o.span : ''}"><div class="dcard-h"><h3>${title}</h3>${o.right ? `<div class="legend">${o.right}</div>` : (o.sub ? `<span>${o.sub}</span>` : '')}</div>${o.help ? `<p class="dcard-help">${o.help}</p>` : ''}${body}</section>`;
}
const legend = items => items.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
function chips(label, current, opts, key) {
  return `<div class="chip-row">${label ? `<span class="lbl">${label}</span>` : ''}${opts.map(([v, l]) =>
    `<button class="filter-chip${String(current) === String(v) ? ' active' : ''}" onclick="dashSet('${key}',${typeof v === 'number' ? v : `'${v}'`})">${l}</button>`).join('')}</div>`;
}
const periodChips = (fn = 'setPeriod') => `<div class="chip-row">${[['all','Todos'],['30','30 dias'],['90','90 dias'],['180','180 dias']].map(([v, l]) =>
  `<button class="filter-chip${state.periodFilter === v ? ' active' : ''}" onclick="${fn}('${v}')">${l}</button>`).join('')}</div>`;
const noData = '<div class="no-items">Sem dados neste período</div>';

function hbars(items) {
  if (!items.length) return noData;
  const tot = i => i.segs.reduce((s, x) => s + x.v, 0);
  const mx = Math.max(1, ...items.map(tot));
  return '<div class="hb">' + items.map(i => {
    const act = i.go ? ` data-go="${esc(i.go)}" role="button" tabindex="0"` : (i.f ? ` data-f="${esc(i.f)}" role="button" tabindex="0"` : '');
    return `<div class="hb-row${i.go || i.f ? ' clickable' : ''}${i.sel ? ' sel' : ''}${i.dim ? ' dim' : ''}"${act}>
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
/* gráfico de colunas (agrupadas por série). cols: [{l, v:[...], f?}]
   Com fdim, cada coluna vira clicável (data-f="fdim|col.f"); isSel/hasSel destacam a(s) selecionada(s). */
function chartCols(cols, series, { span = 1, H = 220, labelEvery = 1, fdim = null, isSel = null, hasSel = false } = {}) {
  if (!cols.length) return noData;
  const W = cardW(span), L = 34, R = 6, T = 16, B = 24, iw = W - L - R, ih = H - T - B;
  const mxv = Math.max(1, ...cols.map(c => Math.max(0, ...c.v)));
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
    const clk = fdim && c.f, sel = hasSel && isSel && isSel(c.f);
    bars += `<g class="colg${clk ? ' clk' : ''}${hasSel ? (sel ? ' sel' : ' dim') : ''}"${clk ? ` data-f="${esc(fdim + '|' + c.f)}"` : ''}><rect class="hit" x="${(L + i * gw).toFixed(1)}" y="${T}" width="${gw.toFixed(1)}" height="${ih + B}"/>`;
    series.forEach((s, si) => {
      const v = c.v[si], h = v / top * ih, x = x0 + si * bw;
      bars += `<rect class="bar" x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.c}"><title>${esc(c.l)} · ${esc(s.n)}: ${fN(v)}</title></rect>`;
      if (v && bw >= 12) bars += `<text class="vl" x="${(x + (bw - 1) / 2).toFixed(1)}" y="${(T + ih - h - 3).toFixed(1)}" text-anchor="middle">${fN(v)}</text>`;
    });
    if (i % labelEvery === 0) bars += `<text class="ax" x="${(L + i * gw + gw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(c.l)}</text>`;
    bars += '</g>';
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="gráfico">${g}${bars}</svg>`;
}
function monthlyCols(evs, series) {
  if (!evs.length) return [];
  const key = e => { const d = new Date(e.t); return d.getFullYear() * 12 + d.getMonth(); };
  let lo = Infinity, hi = -Infinity; evs.forEach(e => { const k = key(e); if (k < lo) lo = k; if (k > hi) hi = k; });
  const cols = []; for (let k = lo; k <= hi; k++) cols.push({
    l: MESES[k % 12] + (hi - lo > 11 ? "'" + String(Math.floor(k / 12)).slice(2) : ''),
    f: Math.floor(k / 12) + '-' + String(k % 12 + 1).padStart(2, '0'), v: series.map(() => 0) });
  evs.forEach(e => { const si = series.findIndex(s => s.k === e.src); if (si >= 0) cols[key(e) - lo].v[si]++; });
  return cols;
}

/* ═══════════════════════════ DASHBOARD (filtros cruzados) ═══════════════════════════
   Clicar em qualquer barra/coluna/cartão filtra o dashboard inteiro. Cada card mostra TODAS as opções
   da sua própria dimensão (ignorando o próprio filtro), pra dar pra trocar a seleção sem limpar antes. */
const FDIMS = { cs: e => e.cs, causa: e => e.causa, alim: e => e.alim, mun: e => e.mun, tipo: e => e.tipo };
const FLABEL = { month:'Mês', cs:'Centro', causa:'Causa', alim:'Alimentador', mun:'Município', tipo:'Incidência', hora:'Horário', nivel:'Gravidade' };
const FAIXAS = [['Madrugada', '00–05h'], ['Manhã', '06–11h'], ['Tarde', '12–17h'], ['Noite', '18–23h']];
const pad2 = n => String(n).padStart(2, '0');
const monthKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); };
const monthLabel = k => { const [y, m] = k.split('-').map(Number); return MESES[m - 1] + '/' + String(y).slice(2); };
const hourOf = e => new Date(e.t).getHours();
const hourOk = (h, v) => v[0] === 'h' ? h === +v.slice(1) : Math.floor(h / 6) === +v.slice(1);
const hourLabel = v => v[0] === 'h' ? pad2(+v.slice(1)) + 'h' : FAIXAS[+v.slice(1)][0] + ' ' + FAIXAS[+v.slice(1)][1];

function applyF(evs, skip) {
  const f = dashState.f;
  let out = evs.filter(e => {
    if (f.base !== 'all' && e.src !== f.base) return false;
    if (skip !== 'month' && f.month && monthKey(e.t) !== f.month) return false;
    if (skip !== 'hora' && f.hora && !hourOk(hourOf(e), f.hora)) return false;
    for (const d in FDIMS) if (d !== skip && f[d] && FDIMS[d](e) !== f[d]) return false;
    return true;
  });
  if (skip !== 'nivel' && f.nivel) {          // só eventos de CDs/elementos que reiteraram naquele nível
    const cnt = new Map(); out.forEach(e => { const k = e.src + '|' + e.cd; cnt.set(k, (cnt.get(k) || 0) + 1); });
    out = out.filter(e => { const n = cnt.get(e.src + '|' + e.cd); return n > 1 && alertLevel(n) === f.nivel; });
  }
  return out;
}
function dashToggle(dim, val) {
  const f = dashState.f;
  if (dim === 'base') f.base = f.base === val ? 'all' : val;
  else { f[dim] = f[dim] === val ? null : val; if (dim === 'month' && f.month) state.periodFilter = 'all'; }
  render();
}
function dashBase(v) { dashState.f.base = v; render(); }
function dashClear(dim) { dashState.f[dim] = null; render(); }
function dashClearAll() { const f = dashState.f; Object.keys(f).forEach(k => { if (k !== 'base') f[k] = null; }); render(); }
function dashPeriod(v) { state.periodFilter = v; dashState.f.month = null; render(); }

function activeFiltersHTML() {
  const f = dashState.f, out = [];
  Object.keys(FLABEL).forEach(k => {
    if (!f[k]) return;
    const v = k === 'month' ? monthLabel(f[k]) : k === 'hora' ? hourLabel(f[k]) : k === 'nivel' ? LVL_LBL[f[k]] : f[k];
    out.push(`<button class="fchip" onclick="dashClear('${k}')" title="Remover filtro">${FLABEL[k]}: <b>${esc(v)}</b> ✕</button>`);
  });
  if (!out.length) return '';
  return `<div class="active-filters"><span class="lbl">Filtros ativos</span>${out.join('')}<button class="fchip clear" onclick="dashClearAll()">Limpar tudo</button></div>`;
}

function dashHTML() {
  const D = dashState, f = D.f, all = dashEvents(), a = periodStart();
  const inP = all.filter(e => e.t >= a);
  const evs = applyF(inP);
  const showBT = f.base !== 'MT', showMT = f.base !== 'BT';
  const bt = evs.filter(e => e.src === 'BT'), mt = evs.filter(e => e.src === 'MT');

  // comparação com o mês/período anterior (respeitando os mesmos filtros)
  let prevEv = null, prevLabel = '';
  if (f.month) {
    const [y, m] = f.month.split('-').map(Number), pk = monthKey(new Date(y, m - 2, 1).getTime());
    prevEv = applyF(all.filter(e => monthKey(e.t) === pk), 'month'); prevLabel = 'mês anterior';
  } else if (state.periodFilter !== 'all') {
    const n = parseInt(state.periodFilter) * DAY;
    prevEv = applyF(all.filter(e => e.t >= a - n && e.t < a)); prevLabel = 'período anterior';
  }
  const scope = f.month ? monthLabel(f.month) : state.periodFilter === 'all' ? 'todo o histórico' : 'últimos ' + state.periodFilter + ' dias';
  const subOf = (n, src) => prevEv === null ? scope : dlt(n, prevEv.filter(e => e.src === src).length) + ' vs ' + prevLabel;

  const rBT = reits(bt), rMT = reits(mt);
  const critBT = rBT.filter(g => g.level === 'critical').length, critMT = rMT.filter(g => g.level === 'critical').length;
  const occ = occurrences(evs); let occTotal = 0; occ.forEach(l => occTotal += l.length);
  const fast = pairsOf(occ).filter(p => p.gap <= 7).length;

  const S = [{ k:'BT', n:'BT', c:C_BT }, { k:'MT', n:'MT', c:C_MT }].filter(s => f.base === 'all' || s.k === f.base);
  const lg = legend(S.map(s => [s.k === 'BT' ? 'BT (CDs)' : 'MT (chaves)', s.c]));
  const segsOf = o => [showBT && { v: o.bt, c: C_BT, t: 'BT' }, showMT && { v: o.mt, c: C_MT, t: 'MT' }].filter(Boolean);
  const fitem = (dim, key, label, segs, extra = {}) => ({ label, segs, f: dim + '|' + key, sel: f[dim] === key, dim: !!f[dim] && f[dim] !== key, ...extra });
  const topWith = (list, dim, n) => { const r = list.slice(0, n); if (f[dim] && !r.some(o => o.k === f[dim])) { const x = list.find(o => o.k === f[dim]); if (x) r.push(x); } return r; };
  const dimCard = (title, dim, fn, n, help) => card(title,
    hbars(topWith(countBy(applyF(inP, dim), fn), dim, n).map(o => fitem(dim, o.k, o.k, segsOf(o)))),
    { right: lg, help });

  // gravidade (ignora o próprio filtro de nível)
  const evN = applyF(inP, 'nivel'), lBT = reits(evN.filter(e => e.src === 'BT')), lMT = reits(evN.filter(e => e.src === 'MT'));
  const levels = ['critical', 'high', 'medium', 'low'].map(l => {
    const nb = lBT.filter(g => g.level === l).length, nm = lMT.filter(g => g.level === l).length;
    return fitem('nivel', l, LVL_LBL[l], [{ v: nb + nm, c: LVL_COL[l], t: LVL_LBL[l] }], { sub: [showBT && 'BT ' + nb, showMT && 'MT ' + nm].filter(Boolean).join(' · ') });
  });
  const topList = (list, tabKey) => hbars(list.slice(0, 10).map(g => ({
    label: g.cd, sub: g.alim + (g.cs && g.cs !== 'Não informado' ? ' · ' + g.cs : ''),
    segs: [{ v: g.count, c: LVL_COL[g.level], t: LVL_LBL[g.level] }], go: tabKey + '|' + g.cd })));

  // evolução mensal e horário (cada um ignora o próprio filtro)
  const evM = applyF(inP, 'month');
  const monthsAll = [...new Set(all.map(e => monthKey(e.t)))].sort();
  const evH = applyF(inP, 'hora');
  const hours = Array.from({ length: 24 }, (_, h) => ({ l: pad2(h), f: 'h' + h, v: S.map(() => 0) }));
  evH.forEach(e => { const si = S.findIndex(s => s.k === e.src); if (si >= 0) hours[hourOf(e)].v[si]++; });
  const hTot = hours.map(h => h.v.reduce((x, y) => x + y, 0)), grand = hTot.reduce((x, y) => x + y, 0);
  const peakOf = i => { const arr = hours.map(h => h.v[i]); const m = Math.max(...arr); return m ? { h: arr.indexOf(m), n: m } : null; };
  const pk = grand ? hTot.indexOf(Math.max(...hTot)) : -1;
  const peaks = S.map((s, i) => { const x = peakOf(i); return x ? `${s.k}: pico às <b>${pad2(x.h)}h</b> (${x.n})` : ''; }).filter(Boolean).join(' · ');
  const insight = grand ? `<div class="insight">Horário mais crítico: <b>${pad2(pk)}h</b> com ${fN(hTot[pk])} ocorrências (${Math.round(hTot[pk] / grand * 100)}% do total). ${S.length > 1 ? peaks : ''}</div>` : '';
  const faixas = `<div class="faixas">${FAIXAS.map(([nm, rg], i) => {
    const n = hTot.slice(i * 6, i * 6 + 6).reduce((x, y) => x + y, 0);
    return `<div class="faixa${f.hora === 'f' + i ? ' sel' : ''}" data-f="hora|f${i}" role="button" tabindex="0"><b>${nm}</b><small>${rg}</small><span>${fN(n)}</span><em>${grand ? Math.round(n / grand * 100) : 0}%</em></div>`;
  }).join('')}</div>`;

  const monthChips = `<div class="chip-row"><span class="lbl">Mês</span>
    <button class="filter-chip${!f.month ? ' active' : ''}" onclick="dashClear('month')">Todos</button>
    ${monthsAll.map(k => `<button class="filter-chip${f.month === k ? ' active' : ''}" onclick="dashToggle('month','${k}')">${MESES[+k.slice(5) - 1]}${monthsAll.length > 12 ? '/' + k.slice(2, 4) : ''}</button>`).join('')}</div>`;
  const baseChips = `<div class="chip-row"><span class="lbl">Rede</span>
    <button class="filter-chip${f.base === 'all' ? ' active' : ''}" onclick="dashBase('all')">BT + MT</button>
    <button class="filter-chip src-bt${f.base === 'BT' ? ' active' : ''}" onclick="dashBase('BT')"><i class="dot" style="background:${C_BT}"></i>Só BT (CDs)</button>
    <button class="filter-chip src-mt${f.base === 'MT' ? ' active' : ''}" onclick="dashBase('MT')"><i class="dot" style="background:${C_MT}"></i>Só MT (chaves)</button></div>`;

  const ks = [];
  if (showBT) ks.push(kpi('Ocorrências BT', fN(bt.length), { cls:'bt', f:'base|BT', sel: f.base === 'BT', sub: subOf(bt.length, 'BT') }));
  if (showMT) ks.push(kpi('Ocorrências MT', fN(mt.length), { cls:'mt', f:'base|MT', sel: f.base === 'MT', sub: subOf(mt.length, 'MT') }));
  if (showBT) ks.push(kpi('CDs reiterados (BT)', fN(rBT.length), { sub: critBT + (critBT === 1 ? ' crítico' : ' críticos') + ' (5+)' }));
  if (showMT) ks.push(kpi('Elem. reiterados (MT)', fN(rMT.length), { sub: critMT + (critMT === 1 ? ' crítico' : ' críticos') + ' (5+)' }));
  ks.push(kpi('Voltaram em ≤ 7 dias', fN(fast), { cls:'red', sub: occTotal ? Math.round(fast / occTotal * 100) + '% das ocorrências' : '' }));
  if (showBT) ks.push(kpi('Clientes afetados (BT)', fN(bt.reduce((x, e) => x + e.cli, 0)), { sub: 'soma das ocorrências' }));

  const since = all.length ? fDMY(all[0].t) : '', until = all.length ? fDMY(all[all.length - 1].t) : '—';
  const cards = [
    card('Evolução mensal', chartCols(monthlyCols(evM, S), S, { span: 2, fdim: 'month', hasSel: !!f.month, isSel: k => k === f.month }),
      { span: 2, right: lg, help: 'Quantas ocorrências houve em cada mês. <span class="tip">Clique numa coluna</span> (ou nos botões de mês acima) para ver o dashboard só daquele mês.' }),
    dimCard('Por centro de serviço', 'cs', e => e.cs, 12, 'Onde as ocorrências aconteceram. <span class="tip">Clique</span> para filtrar por centro.'),
    card('Gravidade dos reiterados', hbars(levels), { sub: 'CDs + elementos',
      help: 'Quantas vezes o mesmo CD/elemento falhou no período: <b>Baixo</b> = 2, <b>Médio</b> = 3, <b>Alto</b> = 4, <b>Crítico</b> = 5 ou mais. <span class="tip">Clique num nível</span> para ver só eles.' }),
    dimCard('Principais causas', 'causa', e => e.causa, 8, '<span class="tip">Clique</span> numa causa para ver só essas ocorrências.'),
    dimCard('Alimentadores com mais ocorrências', 'alim', e => e.alim, 10, '<span class="tip">Clique</span> para filtrar por alimentador.'),
    dimCard('Municípios', 'mun', e => e.mun, 10, '<span class="tip">Clique</span> para filtrar por município.'),
    showBT && card('Top CDs reiterados (BT)', topList(rBT, 'reiteradas'), { sub: 'clique para abrir', help: 'Os CDs que mais falharam dentro dos filtros atuais.' }),
    showMT && card('Top elementos reiterados (MT)', topList(rMT, 'reiteradasMT'), { sub: 'clique para abrir', help: 'As chaves/religadores que mais atuaram dentro dos filtros atuais.' }),
    dimCard('Tipo de incidência', 'tipo', e => e.tipo, 8, '<span class="tip">Clique</span> para filtrar pelo tipo.'),
    card('Ocorrências por hora do dia',
      chartCols(hours, S, { span: 2, H: 200, labelEvery: contentW() < 650 ? 3 : 1, fdim: 'hora', hasSel: !!f.hora, isSel: k => hourOk(+k.slice(1), f.hora) }) + insight + faixas,
      { span: 2, right: lg,
        help: 'Em que <b>horário</b> do dia as ocorrências foram registradas (de 0h a 23h), somando todos os dias do período. Cada coluna é uma hora; as cores separam BT e MT. Serve para achar os <b>horários de pico</b> e dimensionar equipes e plantão. <span class="tip">Clique numa hora</span> ou numa <span class="tip">faixa do dia</span> (abaixo) para filtrar o resto do dashboard.' }),
  ].filter(Boolean).join('\n    ');

  return `
  <div class="dash-top"><h2>Dashboard<small>${f.base === 'all' ? 'BT + MT' : f.base === 'BT' ? 'Só BT (CDs)' : 'Só MT (chaves)'} · dados de ${since} até ${until} · <b>clique nos gráficos para filtrar</b></small></h2>${periodChips('dashPeriod')}</div>
  <div class="dash-controls">${baseChips}${monthChips}</div>
  ${activeFiltersHTML()}
  <div class="kpi-grid">${ks.join('')}</div>
  <div class="dash-grid">
    ${cards}
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
  const st = main.scrollTop;
  main.innerHTML = `<div class="dash">${html || ''}</div>`;
  main.scrollTop = st;
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

/* Filtros cruzados: qualquer elemento com data-f="dimensão|valor" alterna o filtro. */
function dashFilterFrom(el) {
  const v = el.dataset.f, i = v.indexOf('|');
  dashToggle(v.slice(0, i), v.slice(i + 1));
}
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-f]'); if (el) dashFilterFrom(el);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest && e.target.closest('[data-f]'); if (el) dashFilterFrom(el);
});
