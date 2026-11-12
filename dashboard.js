/* ───────────────────────────────────────────────────────────────────────────
   COSAMPA — Dashboard, Comparativos (período / reincidência / Cosampa × Enel) e
   gaveta de detalhe do CD.
   Depende de globais do index.html: state, col, esc, alertLevel, setTab, parseLatLng,
   safeUrl, fetchSheet, cleanRows, openDetailReit, render.
   ─────────────────────────────────────────────────────────────────────────── */

const C_BT = '#f0a500', C_MT = '#3b82f6', C_COS = '#f0a500', C_ENEL = '#14b8a6', C_SEM = '#7a8aa0';
const LVL_COL = { critical:'#ef4444', high:'#f97316', medium:'#eab308', low:'#22c55e' };
const LVL_LBL = { critical:'Crítico (5+)', high:'Alto (4)', medium:'Médio (3)', low:'Baixo (2)' };
const DAY = 86400000;
const BURST_MS = 60 * 60000;           // eventos do mesmo CD com < 1h entre si = mesma ocorrência
const MESES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const DIAS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

/* Filtros compartilhados (Dashboard, Reincidência e Cosampa × Enel). O período rápido (30/90/180 dias)
   fica em state.periodFilter; mês e datas são mutuamente exclusivos com ele. */
const dashState = { cmpDays:30, cmpBase:'all', cmpSort:'vol', reincBase:'BT', reincDays:7, enelBase:'BT', enelDays:7,
  f:{ base:'all', month:null, from:null, to:null, cs:null, causa:null, alim:null, mun:null, tipo:null, hora:null, dow:null, ator:null, nivel:null } };
let _evCache = { key:null, list:[] };

/* ── utilidades ─────────────────────────────────────────────────────────── */
const fN = n => Number(n || 0).toLocaleString('pt-BR');
const pad2 = n => String(n).padStart(2, '0');
const cleanV = v => { v = String(v == null ? '' : v).trim(); return v === '#N/A' ? '' : v; };
function parseDT(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) : null;
}
const fDM = t => { const d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1); };
const fDMY = t => fDM(t) + '/' + String(new Date(t).getFullYear()).slice(2);
const fDT = t => { const d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const isoDay = t => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const fBR = iso => iso ? iso.split('-').reverse().join('/') : '';
function fGap(days) { return days < 2 ? Math.max(1, Math.round(days * 24)) + 'h' : Math.round(days) + 'd'; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x,y) => x-y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; }
function mostCommon(a) { const m = new Map(); a.forEach(x => x && m.set(x, (m.get(x) || 0) + 1)); let b = '', n = 0; m.forEach((v, k) => { if (v > n) { b = k; n = v; } }); return b; }

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
      gps: col(r, 'Mapa', 'MAPA', 'GPS', 'gps', 'Localização') || '',
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

/* ── QUEM ATENDEU ───────────────────────────────────────────────────────────
   Pelo código da equipe que aparece na observação (ex.: "MLS-RD-15B"):
   está na lista de Estrutura (equipes.json) = Cosampa · outro código = Enel · sem código = Sem equipe
   (disparo automático ou equipe não informada). */
const TEAM_RE = /\b[A-Z]{2,4}-[A-Z]{2,4}-\d{1,3}[A-Z]?\b/;
const ATOR = { COS:{ n:'Cosampa', k:'c', c:C_COS }, ENEL:{ n:'Enel', k:'e', c:C_ENEL }, SEM:{ n:'Sem equipe', k:'s', c:C_SEM } };
const ATOR_HINT = 'Sem código de equipe na observação: disparo automático ou equipe não informada.';
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
const equipesOk = () => EQUIPES !== null && !EQUIPES_ERR;
function teamCode(obs) { const m = String(obs || '').toUpperCase().match(TEAM_RE); return m ? m[0] : null; }
function atorOf(obs) {                     // 'COS' | 'ENEL' | null (sem código de equipe)
  const c = teamCode(obs);
  return c ? (EQUIPES.has(c) ? 'COS' : 'ENEL') : null;
}
function atorEv(e) {                       // 'COS' | 'ENEL' | 'SEM' | null (lista de equipes ainda não carregou)
  if (!equipesOk()) return null;
  if (e._a === undefined) e._a = atorOf(e.obs) || 'SEM';
  return e._a;
}
const atorItem = o => o.ator !== undefined ? o.ator : atorEv(o);
function atTag(a, code, cnt) {
  const A = ATOR[a];
  return `<span class="at at-${A.k}"${a === 'SEM' ? ` title="${esc(ATOR_HINT)}"` : ''}>${A.n}${cnt != null ? ' ' + cnt : ''}${code ? `<small>${esc(code)}</small>` : ''}</span>`;
}
const atTagsFromCounts = at => ['COS', 'ENEL', 'SEM'].filter(k => at && at[k]).map(k => atTag(k, null, at[k])).join('');
function atorTagFromObs(obs) {             // usado também pelas abas antigas (Reiteradas / ocorrência)
  if (!equipesOk()) return '';
  const code = teamCode(obs);
  return atTag(code ? (EQUIPES.has(code) ? 'COS' : 'ENEL') : 'SEM', code);
}
const atorCell = r => atorTagFromObs(col(r, 'OBSERVAÇÕES', 'OBSERVACOES', 'Observações', 'obs'));

/* ── agrupamentos ───────────────────────────────────────────────────────── */
function reits(evs) {                      // CDs/elementos com 2+ ocorrências no conjunto
  const m = new Map();
  evs.forEach(e => {
    let g = m.get(e.cd);
    if (!g) { g = { cd:e.cd, alim:e.alim, cs:e.cs, count:0, cli:0, last:0, at:{ COS:0, ENEL:0, SEM:0 } }; m.set(e.cd, g); }
    g.count++; g.cli += e.cli; if (e.t > g.last) g.last = e.t;
    const a = atorEv(e); if (a) g.at[a]++;
  });
  return [...m.values()].filter(g => g.count > 1).map(g => (g.level = alertLevel(g.count), g))
    .sort((a, b) => b.count - a.count || b.last - a.last);
}
function countBy(evs, fn) {                // by = contagem por e.src (BT/MT ou COS/ENEL/SEM)
  const m = new Map();
  evs.forEach(e => {
    const k = fn(e); if (!k) return;
    let o = m.get(k); if (!o) { o = { k, bt:0, mt:0, n:0, by:{} }; m.set(k, o); }
    o.n++; o.by[e.src] = (o.by[e.src] || 0) + 1;
    if (e.src === 'BT') o.bt++; else if (e.src === 'MT') o.mt++;
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
    list.push({ cd:e.cd, src:e.src, alim:e.alim, cs:e.cs, mun:e.mun, tipo:e.tipo, causa:e.causa, cli:e.cli, t:e.t, end:e.t, n:1,
      ator: e.ator !== undefined ? e.ator : atorEv(e) });
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
const noData = '<div class="no-items">Sem dados neste recorte</div>';

function hbars(items) {
  if (!items.length) return noData;
  const tot = i => i.segs.reduce((s, x) => s + x.v, 0);
  const mx = Math.max(1, ...items.map(tot));
  return '<div class="hb">' + items.map(i => {
    const act = i.go ? ` data-go="${esc(i.go)}" role="button" tabindex="0"` : (i.f ? ` data-f="${esc(i.f)}" role="button" tabindex="0"` : '');
    return `<div class="hb-row${i.go || i.f ? ' clickable' : ''}${i.sel ? ' sel' : ''}${i.dim ? ' dim' : ''}"${act}>
      <div class="hb-l" title="${esc(i.label)}">${esc(i.label)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</div>
      <div class="hb-t">${i.segs.map(s => s.v ? `<div class="hb-s" style="width:${(s.v / mx * 100).toFixed(2)}%;background:${s.c}" title="${esc(s.t || '')}: ${s.v}"></div>` : '').join('')}</div>
      <div class="hb-v">${fN(tot(i))}</div>${i.tags ? `<div class="hb-tags">${i.tags}</div>` : ''}</div>`;
  }).join('') + '</div>';
}
/* item de barra que alterna um filtro ao clicar */
const fitem = (dim, key, label, segs, extra = {}) => { const cur = dashState.f[dim];
  return { label, segs, f: dim + '|' + key, sel: cur === key, dim: !!cur && cur !== key, ...extra }; };
function topWith(list, dim, n) {           // top N, garantindo que o item filtrado continue visível
  const cur = dashState.f[dim], r = list.slice(0, n);
  if (cur && !r.some(o => o.k === cur)) { const x = list.find(o => o.k === cur); if (x) r.push(x); }
  return r;
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
    f: Math.floor(k / 12) + '-' + pad2(k % 12 + 1), v: series.map(() => 0) });
  evs.forEach(e => { const si = series.findIndex(s => s.k === e.src); if (si >= 0) cols[key(e) - lo].v[si]++; });
  return cols;
}

/* ═══════════════════════════ FILTROS COMPARTILHADOS ═══════════════════════════
   Clicar em qualquer barra/coluna/cartão filtra a tela. Cada card mostra TODAS as opções da sua própria
   dimensão (ignorando o próprio filtro), pra dar pra trocar a seleção sem limpar antes. */
const FDIMS = { cs: e => e.cs, causa: e => e.causa, alim: e => e.alim, mun: e => e.mun, tipo: e => e.tipo, dow: e => String(new Date(e.t).getDay()) };
const FLABEL = { month:'Mês', from:'Datas', cs:'Centro', causa:'Causa', alim:'Alimentador', mun:'Município', tipo:'Incidência', hora:'Horário', dow:'Dia', ator:'Atendimento', nivel:'Gravidade' };
const FAIXAS = [['Madrugada', '00–05h'], ['Manhã', '06–11h'], ['Tarde', '12–17h'], ['Noite', '18–23h']];
const monthKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); };
const monthLabel = k => { const [y, m] = k.split('-').map(Number); return MESES[m - 1] + '/' + String(y).slice(2); };
const hourOf = e => new Date(e.t).getHours();
const hourOk = (h, v) => v[0] === 'h' ? h === +v.slice(1) : Math.floor(h / 6) === +v.slice(1);
const hourLabel = v => v[0] === 'h' ? pad2(+v.slice(1)) + 'h' : FAIXAS[+v.slice(1)][0] + ' ' + FAIXAS[+v.slice(1)][1];

/* janela de tempo ativa: datas > mês > período rápido > tudo */
function timeRange(skipMonth) {
  const f = dashState.f;
  if (f.from || f.to) return [f.from ? +new Date(f.from + 'T00:00:00') : 0, f.to ? +new Date(f.to + 'T00:00:00') + DAY : Infinity];
  if (f.month && !skipMonth) { const [y, m] = f.month.split('-').map(Number); return [+new Date(y, m - 1, 1), +new Date(y, m, 1)]; }
  if (state.periodFilter !== 'all') return [Date.now() - parseInt(state.periodFilter) * DAY, Infinity];
  return [0, Infinity];
}
function timeLabel() {
  const f = dashState.f;
  if (f.from || f.to) return f.from ? 'de ' + fBR(f.from) + ' até ' + (f.to ? fBR(f.to) : 'hoje') : 'até ' + fBR(f.to);
  if (f.month) return monthLabel(f.month);
  return state.periodFilter === 'all' ? 'todo o histórico' : 'últimos ' + state.periodFilter + ' dias';
}
function prevWindow() {                    // janela imediatamente anterior, pra comparar
  const f = dashState.f, [a, b] = timeRange();
  if (!f.from && !f.to && f.month) { const [y, m] = f.month.split('-').map(Number); return { a: +new Date(y, m - 2, 1), b: +new Date(y, m - 1, 1), label: 'mês anterior' }; }
  if (a > 0) { const L = (b === Infinity ? Date.now() : b) - a; return { a: a - L, b: a, label: 'período anterior' }; }
  return null;
}
/* o (evento ou ocorrência) passa nos filtros? skip: dimensão a ignorar ('time' ignora todo o tempo);
   pairMode: ignora o filtro de rede (BT/MT é escolhido na própria aba). */
function matchF(o, skip, pairMode) {
  const f = dashState.f;
  if (skip !== 'time') { const [a, b] = timeRange(skip === 'month'); if (o.t < a || o.t >= b) return false; }
  if (!pairMode && f.base !== 'all' && o.src !== f.base) return false;
  if (skip !== 'hora' && f.hora && !hourOk(hourOf(o), f.hora)) return false;
  if (skip !== 'ator' && f.ator && atorItem(o) !== f.ator) return false;
  for (const d in FDIMS) if (d !== skip && f[d] && FDIMS[d](o) !== f[d]) return false;
  return true;
}
function applyF(evs, skip, pairMode) {
  const f = dashState.f;
  let out = evs.filter(e => matchF(e, skip, pairMode));
  if (!pairMode && skip !== 'nivel' && f.nivel) {   // só eventos de CDs/elementos que reiteraram naquele nível
    const cnt = new Map(); out.forEach(e => { const k = e.src + '|' + e.cd; cnt.set(k, (cnt.get(k) || 0) + 1); });
    out = out.filter(e => { const n = cnt.get(e.src + '|' + e.cd); return n > 1 && alertLevel(n) === f.nivel; });
  }
  return out;
}
function dashRefresh() { render(); }
function dashSet(k, v) { dashState[k] = v; render(); }
function dashToggle(dim, val) {
  const f = dashState.f;
  if (dim === 'base') f.base = f.base === val ? 'all' : val;
  else {
    f[dim] = f[dim] === val ? null : val;
    if (dim === 'month' && f.month) { state.periodFilter = 'all'; f.from = f.to = null; }
  }
  render();
}
function dashBase(v) { dashState.f.base = v; render(); }
function dashClear(dim) { const f = dashState.f; if (dim === 'from') f.from = f.to = null; else f[dim] = null; render(); }
function dashClearAll() { const f = dashState.f; Object.keys(f).forEach(k => { if (k !== 'base') f[k] = null; }); render(); }
function dashPeriod(v) { const f = dashState.f; state.periodFilter = v; f.month = f.from = f.to = null; render(); }
function dashDate(which, val) {
  const f = dashState.f; f[which] = val || null;
  if (f.from && f.to && f.from > f.to) { const t = f.from; f.from = f.to; f.to = t; }
  if (f.from || f.to) { f.month = null; state.periodFilter = 'all'; }
  render();
}

/* barra de tempo: período rápido, mês e datas (valem para Dashboard, Reincidência e Cosampa × Enel) */
function timeBarHTML() {
  const f = dashState.f, all = dashEvents(), custom = !!(f.from || f.to);
  const months = [...new Set(all.map(e => monthKey(e.t)))].sort();
  const lo = all.length ? isoDay(all[0].t) : '', hi = all.length ? isoDay(all[all.length - 1].t) : '';
  const per = [['all', 'Tudo'], ['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['180', '180 dias']];
  return `<div class="timebar">
    <div class="tb-row"><span class="lbl">Período</span>${per.map(([v, l]) =>
      `<button class="filter-chip${!f.month && !custom && state.periodFilter === v ? ' active' : ''}" onclick="dashPeriod('${v}')">${l}</button>`).join('')}</div>
    <div class="tb-row"><span class="lbl">Mês</span>${months.map(k =>
      `<button class="filter-chip${f.month === k ? ' active' : ''}" onclick="dashToggle('month','${k}')">${MESES[+k.slice(5) - 1]}${months.length > 12 ? '/' + k.slice(2, 4) : ''}</button>`).join('')}</div>
    <div class="tb-row"><span class="lbl">Datas</span>
      <label class="dt">De <input type="date" value="${f.from || ''}" min="${lo}" max="${hi}" class="${f.from ? 'on' : ''}" onchange="dashDate('from',this.value)"></label>
      <label class="dt">Até <input type="date" value="${f.to || ''}" min="${lo}" max="${hi}" class="${f.to ? 'on' : ''}" onchange="dashDate('to',this.value)"></label>
      ${custom ? `<button class="filter-chip" onclick="dashClear('from')">Limpar datas</button>` : ''}</div>
  </div>`;
}
function redeChipsHTML(mode) {             // mode 'dash' = BT+MT/só BT/só MT · 'reinc'/'enel' = BT ou MT da aba
  const f = dashState.f;
  if (mode === 'dash') return `<div class="chip-row"><span class="lbl">Rede</span>
    <button class="filter-chip${f.base === 'all' ? ' active' : ''}" onclick="dashBase('all')">BT + MT</button>
    <button class="filter-chip src-bt${f.base === 'BT' ? ' active' : ''}" onclick="dashBase('BT')"><i class="dot" style="background:${C_BT}"></i>Só BT (CDs)</button>
    <button class="filter-chip src-mt${f.base === 'MT' ? ' active' : ''}" onclick="dashBase('MT')"><i class="dot" style="background:${C_MT}"></i>Só MT (chaves)</button></div>`;
  const key = mode === 'reinc' ? 'reincBase' : 'enelBase', cur = dashState[key];
  return `<div class="chip-row"><span class="lbl">Rede</span>
    <button class="filter-chip src-bt${cur === 'BT' ? ' active' : ''}" onclick="dashSet('${key}','BT')"><i class="dot" style="background:${C_BT}"></i>BT (CDs)</button>
    <button class="filter-chip src-mt${cur === 'MT' ? ' active' : ''}" onclick="dashSet('${key}','MT')"><i class="dot" style="background:${C_MT}"></i>MT (chaves)</button></div>`;
}
function activeFiltersHTML(hide = []) {
  const f = dashState.f, out = [];
  Object.keys(FLABEL).forEach(k => {
    if (hide.includes(k) || !(k === 'from' ? (f.from || f.to) : f[k])) return;
    const v = k === 'month' ? monthLabel(f[k]) : k === 'from' ? (f.from ? fBR(f.from) : '…') + ' → ' + (f.to ? fBR(f.to) : 'hoje')
      : k === 'hora' ? hourLabel(f[k]) : k === 'nivel' ? LVL_LBL[f[k]] : k === 'ator' ? ATOR[f[k]].n : k === 'dow' ? DIAS[+f[k]] : f[k];
    out.push(`<button class="fchip" onclick="dashClear('${k}')" title="Remover filtro">${FLABEL[k]}: <b>${esc(v)}</b> ✕</button>`);
  });
  if (!out.length) return '';
  return `<div class="active-filters"><span class="lbl">Filtros ativos</span>${out.join('')}<button class="fchip clear" onclick="dashClearAll()">Limpar tudo</button></div>`;
}
const helpBox = rows => `<details class="ctl-help"><summary>O que significam estes filtros</summary><dl>${rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl></details>`;
const HELP_TIME = [
  ['Período', 'Janela de tempo olhando para trás a partir de hoje: <b>7, 30, 90 ou 180 dias</b>. "Tudo" usa todo o histórico da planilha.'],
  ['Mês', 'Mostra só um mês fechado. Ao escolher um mês, o período volta para "Tudo". Também dá para clicar numa coluna do gráfico mensal.'],
  ['Datas', 'Intervalo livre, de uma data até outra (inclusive). Tem prioridade sobre período e mês.'],
];

/* ═══════════════════════════ DASHBOARD ═══════════════════════════ */
function dashHTML() {
  const f = dashState.f, all = dashEvents();
  const evs = applyF(all);
  const showBT = f.base !== 'MT', showMT = f.base !== 'BT';
  const bt = evs.filter(e => e.src === 'BT'), mt = evs.filter(e => e.src === 'MT');

  const pw = prevWindow(), prevEv = pw ? applyF(all.filter(e => e.t >= pw.a && e.t < pw.b), 'time') : null;
  const subOf = (n, src) => prevEv === null ? timeLabel() : dlt(n, prevEv.filter(e => e.src === src).length) + ' vs ' + pw.label;

  const rBT = reits(bt), rMT = reits(mt);
  const critBT = rBT.filter(g => g.level === 'critical').length, critMT = rMT.filter(g => g.level === 'critical').length;
  const plural = n => n + (n === 1 ? ' crítico' : ' críticos') + ' (5+)';
  const occ = occurrences(evs); let occTotal = 0; occ.forEach(l => occTotal += l.length);
  const fast = pairsOf(occ).filter(p => p.gap <= 7).length;

  const S = [{ k:'BT', n:'BT', c:C_BT }, { k:'MT', n:'MT', c:C_MT }].filter(s => f.base === 'all' || s.k === f.base);
  const lg = legend(S.map(s => [s.k === 'BT' ? 'BT (CDs)' : 'MT (chaves)', s.c]));
  const segsOf = o => [showBT && { v: o.bt, c: C_BT, t: 'BT' }, showMT && { v: o.mt, c: C_MT, t: 'MT' }].filter(Boolean);
  const dimCard = (title, dim, fn, n, help) => card(title,
    hbars(topWith(countBy(applyF(all, dim), fn), dim, n).map(o => fitem(dim, o.k, o.k, segsOf(o)))), { right: lg, help });

  // gravidade (ignora o próprio filtro de nível)
  const evN = applyF(all, 'nivel'), lBT = reits(evN.filter(e => e.src === 'BT')), lMT = reits(evN.filter(e => e.src === 'MT'));
  const levels = ['critical', 'high', 'medium', 'low'].map(l => {
    const nb = lBT.filter(g => g.level === l).length, nm = lMT.filter(g => g.level === l).length;
    return fitem('nivel', l, LVL_LBL[l], [{ v: nb + nm, c: LVL_COL[l], t: LVL_LBL[l] }], { sub: [showBT && 'BT ' + nb, showMT && 'MT ' + nm].filter(Boolean).join(' · ') });
  });
  const topList = (list, tabKey) => hbars(list.slice(0, 10).map(g => ({
    label: g.cd, sub: g.alim + (g.cs && g.cs !== 'Não informado' ? ' · ' + g.cs : ''),
    segs: [{ v: g.count, c: LVL_COL[g.level], t: LVL_LBL[g.level] }], go: tabKey + '|' + g.cd, tags: atTagsFromCounts(g.at) })));

  // quem atendeu (ignora o próprio filtro)
  let atorCard;
  if (!equipesOk()) atorCard = card('Quem atendeu', '<div class="no-items">Carregando lista de equipes…</div>');
  else {
    const m = new Map(countBy(applyF(all, 'ator'), e => atorEv(e)).map(o => [o.k, o]));
    atorCard = card('Quem atendeu', hbars(['COS', 'ENEL', 'SEM'].map(k => { const o = m.get(k);
      return fitem('ator', k, ATOR[k].n, [{ v: o ? o.n : 0, c: ATOR[k].c, t: ATOR[k].n }], { sub: o ? [showBT && 'BT ' + o.bt, showMT && 'MT ' + o.mt].filter(Boolean).join(' · ') : '' }); })),
      { sub: 'pela equipe da observação', help: 'Quem atendeu a ocorrência, pelo <b>código da equipe</b> na observação: na lista de Estrutura = <b>Cosampa</b>; outro código = <b>Enel</b>; sem código = <b>Sem equipe</b> (disparo automático ou equipe não informada). <span class="tip">Clique</span> para filtrar.' });
  }

  // evolução mensal, horário e dia da semana (cada um ignora o próprio filtro)
  const evM = applyF(all, 'month');
  const evH = applyF(all, 'hora');
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
  const evD = applyF(all, 'dow');
  const dows = [1, 2, 3, 4, 5, 6, 0].map(d => ({ l: DIAS[d], f: String(d), v: S.map(() => 0) }));
  evD.forEach(e => { const si = S.findIndex(s => s.k === e.src); if (si >= 0) dows.find(x => x.f === String(new Date(e.t).getDay())).v[si]++; });

  const ks = [];
  if (showBT) ks.push(kpi('Ocorrências BT', fN(bt.length), { cls:'bt', f:'base|BT', sel: f.base === 'BT', sub: subOf(bt.length, 'BT') }));
  if (showMT) ks.push(kpi('Ocorrências MT', fN(mt.length), { cls:'mt', f:'base|MT', sel: f.base === 'MT', sub: subOf(mt.length, 'MT') }));
  if (showBT) ks.push(kpi('CDs reiterados (BT)', fN(rBT.length), { sub: plural(critBT) }));
  if (showMT) ks.push(kpi('Elem. reiterados (MT)', fN(rMT.length), { sub: plural(critMT) }));
  ks.push(kpi('Voltaram em ≤ 7 dias', fN(fast), { cls:'red', sub: occTotal ? Math.round(fast / occTotal * 100) + '% das ocorrências' : '' }));
  if (showBT) ks.push(kpi('Clientes afetados (BT)', fN(bt.reduce((x, e) => x + e.cli, 0)), { sub: 'soma das ocorrências' }));

  const since = all.length ? fDMY(all[0].t) : '', until = all.length ? fDMY(all[all.length - 1].t) : '—';
  const cards = [
    card('Evolução mensal', chartCols(monthlyCols(evM, S), S, { span: 2, fdim: 'month', hasSel: !!f.month, isSel: k => k === f.month }),
      { span: 2, right: lg, help: 'Quantas ocorrências houve em cada mês. <span class="tip">Clique numa coluna</span> (ou nos botões de mês acima) para ver o dashboard só daquele mês.' }),
    dimCard('Por centro de serviço', 'cs', e => e.cs, 12, 'Onde as ocorrências aconteceram. <span class="tip">Clique</span> para filtrar por centro.'),
    card('Gravidade dos reiterados', hbars(levels), { sub: 'CDs + elementos',
      help: 'Quantas vezes o mesmo CD/elemento falhou no recorte: <b>Baixo</b> = 2, <b>Médio</b> = 3, <b>Alto</b> = 4, <b>Crítico</b> = 5 ou mais. <span class="tip">Clique num nível</span> para ver só eles.' }),
    dimCard('Principais causas', 'causa', e => e.causa, 8, '<span class="tip">Clique</span> numa causa para ver só essas ocorrências.'),
    dimCard('Alimentadores com mais ocorrências', 'alim', e => e.alim, 10, '<span class="tip">Clique</span> para filtrar por alimentador.'),
    dimCard('Municípios', 'mun', e => e.mun, 10, '<span class="tip">Clique</span> para filtrar por município.'),
    showBT && card('Top CDs reiterados (BT)', topList(rBT, 'reiteradas'), { sub: 'clique para abrir', help: 'Os CDs que mais falharam dentro dos filtros atuais. As etiquetas mostram quem atendeu cada ocorrência. <span class="tip">Clique num CD</span> para ver o histórico completo.' }),
    showMT && card('Top elementos reiterados (MT)', topList(rMT, 'reiteradasMT'), { sub: 'clique para abrir', help: 'As chaves/religadores que mais atuaram dentro dos filtros atuais.' }),
    dimCard('Tipo de incidência', 'tipo', e => e.tipo, 8, '<span class="tip">Clique</span> para filtrar pelo tipo.'),
    atorCard,
    card('Dia da semana', chartCols(dows, S, { fdim: 'dow', hasSel: !!f.dow, isSel: k => k === f.dow, H: 200 }), { right: lg,
      help: 'Em que dia da semana as ocorrências foram registradas. <span class="tip">Clique num dia</span> para filtrar.' }),
    card('Ocorrências por hora do dia',
      chartCols(hours, S, { span: 3, H: 200, labelEvery: contentW() < 650 ? 3 : 1, fdim: 'hora', hasSel: !!f.hora, isSel: k => hourOk(+k.slice(1), f.hora) }) + insight + faixas,
      { span: 3, right: lg,
        help: 'Em que <b>horário</b> do dia as ocorrências foram registradas (de 0h a 23h), somando todos os dias do período. Cada coluna é uma hora; as cores separam BT e MT. Serve para achar os <b>horários de pico</b> e dimensionar equipes e plantão. <span class="tip">Clique numa hora</span> ou numa <span class="tip">faixa do dia</span> (abaixo) para filtrar o resto do dashboard.' }),
  ].filter(Boolean).join('\n    ');

  return `
  <div class="dash-top"><h2>Dashboard<small>${f.base === 'all' ? 'BT + MT' : f.base === 'BT' ? 'Só BT (CDs)' : 'Só MT (chaves)'} · dados de ${since} até ${until} · <b>clique nos gráficos para filtrar</b></small></h2></div>
  ${timeBarHTML()}
  ${redeChipsHTML('dash')}
  ${helpBox([...HELP_TIME, ['Rede', '<b>BT</b> = baixa tensão (cada linha é um CD/transformador). <b>MT</b> = média tensão (cada linha é uma chave ou religador, o "elemento operado").']])}
  ${activeFiltersHTML()}
  <div class="kpi-grid">${ks.join('')}</div>
  <div class="dash-grid">
    ${cards}
  </div>`;
}

/* ═══════════════════════════ COMPARATIVO POR PERÍODO ═══════════════════════════ */
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
  ${helpBox([['Janela', 'Tamanho do período comparado. Em <b>30 dias</b>, compara os últimos 30 dias com os 30 dias anteriores a eles.'],
    ['Base', 'Quais ocorrências entram: <b>BT</b> (CDs), <b>MT</b> (chaves) ou as duas.'],
    ['Ordenar', '<b>Maior volume</b> lista quem tem mais ocorrências agora. <b>Maior alta</b> lista quem mais piorou em relação ao período anterior.']])}
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

/* ═══════════════════════════ REINCIDÊNCIA (normalizou e voltou) ═══════════════════════════
   Retorno = o mesmo CD/elemento falhou de novo depois de uma ocorrência anterior. As ocorrências anteriores
   vêm de todo o histórico; os filtros (período, mês, datas, causa, centro…) valem para a FALHA QUE VOLTOU. */
const GAP_BUCKETS = [[1, '≤ 1 dia'], [3, '1–3 d'], [7, '3–7 d'], [15, '7–15 d'], [30, '15–30 d'], [Infinity, '> 30 d']];
function cmpReincHTML() {
  const D = dashState, f = D.f, src = D.reincBase, N = D.reincDays;
  const occMap = occurrences(dashEvents().filter(e => e.src === src));
  const pairsAll = pairsOf(occMap);
  const P = skip => pairsAll.filter(p => matchF(p.y, skip, true));
  const quickOf = skip => P(skip).filter(p => p.gap <= N);
  let occF = 0; occMap.forEach(l => l.forEach(o => { if (matchF(o, '', true)) occF++; }));
  const pairs = P(), quick = pairs.filter(p => p.gap <= N);
  const same = quick.filter(p => p.x.causa === p.y.causa && p.x.causa !== 'Não informada').length;
  const med = median(pairs.map(p => p.gap));
  const dist = GAP_BUCKETS.map(([mx, l], i) => ({ l, v: [pairs.filter(p => p.gap <= mx && p.gap > (i ? GAP_BUCKETS[i - 1][0] : -1)).length] }));
  const byCd = new Map();
  quick.forEach(p => {
    let o = byCd.get(p.y.cd);
    if (!o) { o = { cd:p.y.cd, alim:p.y.alim, cs:p.y.cs, n:0, min:Infinity, last:0, same:0, at:{ COS:0, ENEL:0, SEM:0 } }; byCd.set(p.y.cd, o); }
    o.n++; o.min = Math.min(o.min, p.gap); o.last = Math.max(o.last, p.y.t);
    if (p.x.causa === p.y.causa && p.x.causa !== 'Não informada') o.same++;
    if (p.y.ator) o.at[p.y.ator]++;
  });
  const rank = [...byCd.values()].sort((x, y) => y.n - x.n || x.min - y.min).slice(0, 40);
  const tabKey = src === 'BT' ? 'reiteradas' : 'reiteradasMT', unit = src === 'BT' ? 'CD' : 'elemento', Unit = unit[0].toUpperCase() + unit.slice(1);
  const dimCardQ = (title, dim, fn, n, help) => card(title,
    hbars(topWith(countBy(quickOf(dim).map(p => p.y), fn), dim, n).map(o => fitem(dim, o.k, o.k, [{ v: o.n, c: src === 'BT' ? C_BT : C_MT, t: 'Retornos' }]))),
    { sub: 'retornos ≤ ' + N + 'd', help });
  let atorCard;
  if (!equipesOk()) atorCard = card('Quem atendeu o retorno', '<div class="no-items">Carregando lista de equipes…</div>');
  else {
    const m = new Map(countBy(quickOf('ator').map(p => p.y), o => o.ator).map(o => [o.k, o]));
    atorCard = card('Quem atendeu o retorno', hbars(['COS', 'ENEL', 'SEM'].map(k => fitem('ator', k, ATOR[k].n, [{ v: m.get(k) ? m.get(k).n : 0, c: ATOR[k].c, t: ATOR[k].n }]))),
      { sub: 'retornos ≤ ' + N + 'd', help: 'Equipe que atendeu a <b>segunda falha</b> (a que voltou), pelo código da equipe na observação. <span class="tip">Clique</span> para filtrar.' });
  }

  return `
  <div class="dash-top"><h2>Reincidência<small>o que normalizou e voltou a falhar no mesmo ${unit} · eventos com menos de 1h contam como uma só ocorrência · <b>clique nos gráficos para filtrar</b></small></h2></div>
  ${timeBarHTML()}
  <div class="dash-controls">${redeChipsHTML('reinc')}${chips('Retorno em até', N, [[2,'2 dias'],[7,'7 dias'],[15,'15 dias'],[30,'30 dias']], 'reincDays')}</div>
  ${helpBox([...HELP_TIME,
    ['Rede', '<b>BT (CDs)</b> analisa transformadores; <b>MT (chaves)</b> analisa chaves e religadores.'],
    ['Retorno em até', 'Quantos dias depois da ocorrência anterior o mesmo ' + unit + ' precisa falhar de novo para contar como <b>retorno rápido</b>. Em <b>7 dias</b>: falhou, normalizou e voltou a falhar em até uma semana.'],
    ['Como é contado', 'Os filtros valem para a <b>falha que voltou</b> (a segunda). A ocorrência anterior pode ser mais antiga que o período escolhido.']])}
  ${activeFiltersHTML(['base', 'nivel'])}
  <div class="kpi-grid">
    ${kpi('Ocorrências distintas', fN(occF), { cls: src === 'BT' ? 'bt' : 'mt', sub: timeLabel() })}
    ${kpi('Retornos ≤ ' + N + ' dias', fN(quick.length), { cls:'red', sub: occF ? Math.round(quick.length / occF * 100) + '% das ocorrências' : '' })}
    ${kpi(Unit + 's que voltaram', fN(byCd.size), { sub: 'pelo menos 1 retorno ≤ ' + N + 'd' })}
    ${kpi('Mesma causa', quick.length ? Math.round(same / quick.length * 100) + '%' : '—', { sub: 'voltou pelo mesmo motivo' })}
    ${kpi('Intervalo mediano', med === null ? '—' : fGap(med), { sub: 'entre uma falha e a próxima' })}
    ${kpi('Total de retornos', fN(pairs.length), { sub: 'em qualquer prazo' })}
  </div>
  <div class="dash-grid">
    ${card('Tempo até voltar a falhar', chartCols(dist, [{ n:'Retornos', c: src === 'BT' ? C_BT : C_MT }], { H: 210 }), { sub: 'nº de retornos por faixa', help: 'Entre uma falha e a próxima do mesmo ' + unit + ': quanto mais colunas à esquerda, mais rápido o problema volta.' })}
    ${dimCardQ('Causa da falha que voltou', 'causa', o => o.causa, 8, 'Causa da <b>segunda falha</b>. <span class="tip">Clique</span> para filtrar.')}
    ${atorCard}
    ${dimCardQ('Por centro de serviço', 'cs', o => o.cs, 8, 'Onde os retornos aconteceram. <span class="tip">Clique</span> para filtrar.')}
    ${dimCardQ('Municípios', 'mun', o => o.mun, 10, '<span class="tip">Clique</span> para filtrar por município.')}
    ${card('Mais retornos rápidos (≤ ' + N + ' dias)', rank.length ? `<div class="dtable-wrap"><table class="dtable"><thead><tr>
      <th>${Unit}</th><th>Alimentador</th><th class="r">Retornos</th><th class="r">Menor intervalo</th><th class="r">Mesma causa</th><th class="r">Quem atendeu</th><th class="r">Última</th></tr></thead><tbody>
      ${rank.map(r => `<tr data-go="${esc(tabKey + '|' + r.cd)}"><td class="n">${esc(r.cd)}</td><td class="m">${esc(r.alim)}${r.cs !== 'Não informado' ? ' · ' + esc(r.cs) : ''}</td>
        <td class="r n">${r.n}</td><td class="r">${fGap(r.min)}</td><td class="r m">${r.same}/${r.n}</td><td class="r"><div class="tags-cell">${atTagsFromCounts(r.at)}</div></td><td class="r m">${fDMY(r.last)}</td></tr>`).join('')}
      </tbody></table></div>` : noData, { span: 3, sub: 'clique numa linha para abrir o histórico', help: 'Os ' + unit + 's que mais voltaram a falhar dentro do prazo escolhido.' })}
  </div>`;
}

/* ═══════════════════════════ COSAMPA × ENEL ═══════════════════════════ */
function cmpEnelHTML() {
  const head = `<div class="dash-top"><h2>Cosampa × Enel<small>quem atendeu cada ocorrência e quem voltou lá depois · <b>clique nos gráficos para filtrar</b></small></h2></div>`;
  if (EQUIPES_ERR) return head + `<div class="dash-note"><b>Não consegui carregar a lista de equipes (equipes.json).</b> Sem ela não dá para separar Cosampa de Enel. Confira se o arquivo foi publicado junto com o app e tente atualizar.</div>`;
  const D = dashState, f = D.f, N = D.enelDays, src = D.enelBase;
  const hist = dashEvents().filter(e => e.src === src).map(e => { const a = atorEv(e) || 'SEM'; return { ...e, src: a, ator: a }; });
  const ident = hist.filter(e => e.ator !== 'SEM');
  const occI = occurrences(ident), pairsAll = pairsOf(occI), occAll = occurrences(hist);
  const P = skip => pairsAll.filter(p => matchF(p.y, skip, true));
  const evF = skip => hist.filter(e => matchF(e, skip, true));
  const evs = evF();
  const cos = evs.filter(e => e.ator === 'COS'), ene = evs.filter(e => e.ator === 'ENEL'), sem = evs.filter(e => e.ator === 'SEM');
  const q = P().filter(p => p.gap <= N), kind = (x, y) => q.filter(p => p.x.src === x && p.y.src === y).length;
  const cc = kind('COS', 'COS'), ce = kind('COS', 'ENEL'), ec = kind('ENEL', 'COS'), ee = kind('ENEL', 'ENEL');
  const sets = new Map(); evs.forEach(e => { if (e.ator === 'SEM') return; let s = sets.get(e.cd); if (!s) sets.set(e.cd, s = new Set()); s.add(e.ator); });
  let both = 0; sets.forEach(s => { if (s.size > 1) both++; });
  const swaps = new Map(); q.filter(p => p.x.src !== p.y.src).forEach(p => swaps.set(p.y.cd, (swaps.get(p.y.cd) || 0) + 1));
  const rank = [...swaps.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40);
  const S = [{ k:'COS', n:'Cosampa', c:C_COS }, { k:'ENEL', n:'Enel', c:C_ENEL }, { k:'SEM', n:'Sem equipe', c:C_SEM }];
  const lg = legend(S.map(s => [s.n, s.c]));
  const segs3 = o => S.map(s => ({ v: o.by[s.k] || 0, c: s.c, t: s.n }));
  const dimCard3 = (title, dim, fn, n, help) => card(title,
    hbars(topWith(countBy(evF(dim), fn), dim, n).map(o => fitem(dim, o.k, o.k, segs3(o)))), { right: lg, help });
  const tl = cd => { const l = occAll.get(cd).slice(-8); return `<div class="tl-row">${l.map((o, i) => {
      const g = i ? (o.t - l[i - 1].end) / DAY : null, k = ATOR[o.ator || 'SEM'].k;
      return (i ? `<i class="tl-gap${g <= N ? ' fast' : ''}">→ ${fGap(g)} →</i>` : '') + `<span class="tl ${k}" title="${esc(o.causa)}">${ATOR[o.ator || 'SEM'].n} ${fDM(o.t)}</span>`;
    }).join('')}</div>`; };
  const tabKey = src === 'BT' ? 'reiteradas' : 'reiteradasMT', unit = src === 'BT' ? 'CD' : 'Elemento';
  const cov = hist.length ? Math.round(ident.length / hist.length * 100) : 0;
  const atKpi = (k, label, list, cls) => kpi(label, fN(list.length), { cls, f: 'ator|' + k, sel: f.ator === k, sub: evs.length ? Math.round(list.length / evs.length * 100) + '% das ocorrências' : '' });

  return head + `
  ${timeBarHTML()}
  <div class="dash-controls">${redeChipsHTML('enel')}${chips('Retorno em até', N, [[2,'2 dias'],[7,'7 dias'],[15,'15 dias'],[30,'30 dias']], 'enelDays')}</div>
  ${helpBox([...HELP_TIME,
    ['Rede', '<b>BT (CDs)</b> tem boa cobertura de equipe. <b>MT (chaves)</b> quase não traz código de equipe na observação, então fica quase tudo em "Sem equipe".'],
    ['Retorno em até', 'Se o mesmo ' + unit.toLowerCase() + ' voltar a ser atendido em até esse prazo depois do atendimento anterior, conta como retorno. <b>Cosampa voltou</b> = Cosampa → Cosampa. <b>Troca de equipe</b> = quem voltou foi a outra empresa.'],
    ['Quem atendeu', 'Pelo <b>código da equipe</b> na observação: na lista de Estrutura = <b>Cosampa</b>; outro código = <b>Enel</b>; sem código = <b>Sem equipe</b> (disparo automático ou equipe não informada). Os "Sem equipe" aparecem em cinza e <b>não entram</b> nas contas de retorno e troca.']])}
  ${activeFiltersHTML(['base', 'nivel'])}
  <div class="dash-note">Foi possível identificar a equipe de <b>${fN(ident.length)} de ${fN(hist.length)}</b> ocorrências do histórico (<b>${cov}%</b>).${src === 'MT' && cov < 60 ? ' <b>Em MT a cobertura é baixa</b>: use com cautela.' : ''} Eventos &lt; 1h da mesma equipe contam como um.</div>
  <div class="kpi-grid">
    ${atKpi('COS', 'Atendidas Cosampa', cos, 'bt')}
    ${atKpi('ENEL', 'Atendidas Enel', ene, '')}
    ${atKpi('SEM', 'Sem equipe', sem, '')}
    ${kpi('Cosampa voltou', fN(cc), { cls:'red', sub: 'Cosampa → Cosampa ≤ ' + N + 'd' })}
    ${kpi('Enel voltou', fN(ee), { cls:'red', sub: 'Enel → Enel ≤ ' + N + 'd' })}
    ${kpi('Troca de equipe', fN(ce + ec), { sub: 'Cosampa→Enel ' + ce + ' · Enel→Cosampa ' + ec })}
    ${kpi(unit + 's com as duas', fN(both), { sub: 'falha de todo mundo' })}
  </div>
  <div class="dash-grid">
    ${card('Evolução mensal', chartCols(monthlyCols(evF('month'), S), S, { span: 2, fdim: 'month', hasSel: !!f.month, isSel: k => k === f.month }), { span: 2, right: lg, help: 'Ocorrências por mês, separadas por quem atendeu. <span class="tip">Clique numa coluna</span> para filtrar o mês.' })}
    ${dimCard3('Por centro de serviço', 'cs', e => e.cs, 12, '<span class="tip">Clique</span> para filtrar por centro.')}
    ${dimCard3('Principais causas', 'causa', e => e.causa, 8, '<span class="tip">Clique</span> para filtrar por causa.')}
    ${dimCard3('Municípios', 'mun', e => e.mun, 10, '<span class="tip">Clique</span> para filtrar por município.')}
    ${card('Onde as equipes se alternaram (≤ ' + N + ' dias)', rank.length ? `<div class="dtable-wrap"><table class="dtable"><thead><tr><th>${unit}</th><th>Alimentador</th><th class="r">Trocas</th><th>Linha do tempo</th></tr></thead><tbody>
      ${rank.map(([cd, n]) => `<tr data-go="${esc(tabKey + '|' + cd)}"><td class="n">${esc(cd)}</td><td class="m">${esc(occAll.get(cd)[0].alim)}</td><td class="r n">${n}</td><td>${tl(cd)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="no-items">Nenhuma troca de equipe neste recorte</div>', { span: 3, sub: 'clique numa linha para abrir o histórico',
      help: 'Cada linha mostra, em ordem, quem atendeu o ' + unit.toLowerCase() + ' (laranja = Cosampa, verde = Enel, cinza = sem equipe) e o tempo entre os atendimentos; em vermelho, retorno dentro do prazo escolhido.' })}
  </div>`;
}

/* ═══════════════════════════ GAVETA DE DETALHE DO CD ═══════════════════════════
   Abre por cima da tela atual (sem trocar de aba), com o histórico completo do CD/elemento. */
let _drawer = null;
function drawerEl() {
  let el = document.getElementById('cdDrawer');
  if (!el) { el = document.createElement('div'); el.id = 'cdDrawer'; el.className = 'drawer'; (document.getElementById('app') || document.body).appendChild(el); }
  return el;
}
function openCDDrawer(tabKey, key) {
  _drawer = { src: tabKey === 'reiteradasMT' ? 'MT' : 'BT', cd: key, tabKey };
  const el = drawerEl(); el.innerHTML = drawerHTML(); el.classList.add('open');
  const b = el.querySelector('.dr-body'); if (b) b.scrollTop = 0;
}
function closeDrawer() { const el = document.getElementById('cdDrawer'); if (el) el.classList.remove('open'); _drawer = null; }
function drawerHTML() {
  const { src, cd } = _drawer;
  const evs = dashEvents().filter(e => e.src === src && e.cd === cd);
  const unit = src === 'BT' ? 'CD (baixa tensão)' : 'Elemento (média tensão)';
  if (!evs.length) return `<div class="dr-bg" data-close></div><aside class="dr-panel"><div class="dr-head"><button class="dr-x" data-close>✕</button><div><div class="dr-title">${esc(cd)}</div><div class="dr-sub">Nenhuma ocorrência encontrada.</div></div></div></aside>`;
  const n = evs.length, last = evs[n - 1], lvl = alertLevel(n);
  const occ = occurrences(evs).get(cd) || [], gaps = occ.slice(1).map((o, i) => (o.t - occ[i].end) / DAY);
  const at = { COS: 0, ENEL: 0, SEM: 0 }; evs.forEach(e => { const a = atorEv(e); if (a) at[a]++; });
  const gps = [...evs].reverse().map(e => e.gps).find(Boolean) || '', ll = typeof parseLatLng === 'function' ? parseLatLng(gps) : null;
  const mun = mostCommon(evs.map(e => e.mun)), ago = Math.floor((Date.now() - last.t) / DAY);
  const causas = countBy(evs, e => e.causa).slice(0, 5);
  const fast = gaps.filter(g => g <= 7).length;
  const sub = [...new Set([last.alim, last.cs !== 'Não informado' ? last.cs : '', mun !== 'Não informado' ? mun : ''].filter(Boolean))].join(' · ');
  const timeline = [...evs].map((e, i) => ({ e, prev: i ? evs[i - 1] : null })).reverse().map(({ e, prev }) => {
    const a = atorEv(e), code = teamCode(e.obs), k = a === 'COS' ? 'c' : a === 'ENEL' ? 'e' : '';
    let gap = '';
    if (prev) { const ms = e.t - prev.t; gap = ms < BURST_MS ? `<span class="gap">+${Math.max(1, Math.round(ms / 60000))} min (mesmo evento)</span>` : `<span class="gap${ms / DAY <= 7 ? ' fast' : ''}">${fGap(ms / DAY)} depois da anterior</span>`; }
    return `<div class="tli ${k}"><div class="d">${fDT(e.t)} ${a ? atTag(a, code) : ''} ${gap}</div>
      <div class="m"><b>${esc(e.causa)}</b> · ${esc(e.tipo)}${e.mun !== 'Não informado' ? ' · ' + esc(e.mun) : ''}${e.cli ? ' · ' + fN(e.cli) + ' clientes' : ''}</div>
      ${e.obs ? `<details><summary>Ver observação</summary><div>${esc(e.obs)}</div></details>` : ''}</div>`;
  }).join('');
  return `<div class="dr-bg" data-close></div>
  <aside class="dr-panel" role="dialog" aria-label="Detalhe de ${esc(cd)}">
    <div class="dr-head"><button class="dr-x" data-close aria-label="Fechar">✕</button>
      <div><div class="dr-title">${esc(cd)} <span class="badge ${lvl}">${n}x</span></div><div class="dr-sub">${esc(unit)}${sub ? ' · ' + esc(sub) : ''}</div></div></div>
    <div class="dr-body">
      <div class="dr-actions">
        ${ll ? `<a class="dr-btn go" href="https://www.google.com/maps/dir/?api=1&destination=${ll.lat},${ll.lng}&travelmode=driving" target="_blank" rel="noopener noreferrer">➤ Iniciar rota</a>` : ''}
        ${typeof safeUrl === 'function' && safeUrl(gps) ? `<a class="dr-btn" href="${esc(safeUrl(gps))}" target="_blank" rel="noopener noreferrer">Abrir no Maps</a>` : ''}
        <button class="dr-btn" id="drCopy" onclick="drawerCopy()">Copiar informações</button>
        <button class="dr-btn" onclick="drawerOpenTab()">Ver na aba Reiteradas</button>
      </div>
      <div class="dr-kpis">
        ${kpi('Ocorrências', n, { cls: src === 'BT' ? 'bt' : 'mt', sub: occ.length !== n ? occ.length + ' distintas' : 'histórico completo' })}
        ${kpi('Última', ago === 0 ? 'hoje' : ago + 'd', { sub: fDMY(last.t) })}
        ${kpi('Voltou ≤ 7 dias', fast, { cls: fast ? 'red' : '', sub: gaps.length ? 'de ' + gaps.length + ' retornos' : 'sem retornos' })}
        ${kpi('Menor intervalo', gaps.length ? fGap(Math.min(...gaps)) : '—', { sub: 'entre ocorrências' })}
        ${kpi('Intervalo mediano', gaps.length ? fGap(median(gaps)) : '—', { sub: 'entre ocorrências' })}
        ${src === 'BT' ? kpi('Clientes', fN(last.cli), { sub: 'na última ocorrência' }) : kpi('Causa principal', esc(causas[0] ? causas[0].k.slice(0, 14) : '—'), { sub: causas[0] ? causas[0].n + 'x' : '' })}
      </div>
      <section class="dr-sec"><h4>Quem atendeu</h4>
        ${equipesOk() ? `<div class="tags-cell" style="justify-content:flex-start">${atTagsFromCounts(at) || '—'}</div><div class="note">Pela equipe citada na observação de cada ocorrência. "Sem equipe" = ${esc(ATOR_HINT.toLowerCase())}</div>` : '<div class="note">Carregando lista de equipes…</div>'}
      </section>
      <section class="dr-sec"><h4>Causas</h4>${hbars(causas.map(o => ({ label: o.k, segs: [{ v: o.n, c: src === 'BT' ? C_BT : C_MT, t: 'Ocorrências' }] })))}</section>
      <section class="dr-sec"><h4>Linha do tempo (mais recente primeiro)</h4>${timeline}</section>
    </div>
  </aside>`;
}
function drawerCopy() {
  if (!_drawer) return;
  const evs = dashEvents().filter(e => e.src === _drawer.src && e.cd === _drawer.cd); if (!evs.length) return;
  const last = evs[evs.length - 1], gps = [...evs].reverse().map(e => e.gps).find(Boolean) || '';
  const msg = `📋 *Informações — ${_drawer.cd}*\n*Alimentador:* ${last.alim}\n*Município:* ${mostCommon(evs.map(e => e.mun))}\n` +
    (_drawer.src === 'BT' && last.cli ? `*Total Clientes:* ${last.cli}\n` : '') + `*Reiterações:* ${evs.length}x\n*Última causa:* ${last.causa}\n` + (gps ? `*Localização:* ${gps}` : '');
  const done = () => { const b = document.getElementById('drCopy'); if (b) { b.textContent = '✓ Copiado!'; setTimeout(() => { b.textContent = 'Copiar informações'; }, 2000); } };
  (navigator.clipboard ? navigator.clipboard.writeText(msg) : Promise.reject()).catch(() => {
    const ta = document.createElement('textarea'); ta.value = msg; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }).finally(done);
}
function drawerOpenTab() { if (!_drawer) return; const { cd, tabKey } = _drawer; closeDrawer(); openCDByKey(cd, tabKey); }

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

/* Abre o CD na aba Reiteradas (lista + detalhe), como antes. */
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

/* Cliques: abrir gaveta (data-go), fechar (data-close) e alternar filtro (data-f). */
function dashFilterFrom(el) {
  const v = el.dataset.f, i = v.indexOf('|');
  dashToggle(v.slice(0, i), v.slice(i + 1));
}
function dashHandle(e) {
  const t = e.target; if (!t || !t.closest) return;
  if (t.closest('[data-close]')) { closeDrawer(); return; }
  const go = t.closest('[data-go]'); if (go) { const [tab, key] = go.dataset.go.split('|'); openCDDrawer(tab, key); return; }
  const fl = t.closest('[data-f]'); if (fl) dashFilterFrom(fl);
}
document.addEventListener('click', dashHandle);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDrawer(); return; }
  if (e.key === 'Enter') dashHandle(e);
});

/* A lista de equipes é pequena: carrega logo no começo e redesenha, pra etiquetas e filtros já aparecerem. */
window.addEventListener('load', () => {
  loadEquipesIfNeeded().then(() => { try { if (state.loaded) render(); } catch (e) {} });
});
