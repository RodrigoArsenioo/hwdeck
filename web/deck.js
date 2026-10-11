'use strict';
// HW Deck page. The host (app.cs) sends the catalog of HWiNFO readings, a tick of values once a second and the saved
// files; this page owns the layout and draws it three ways (Tiles, Overview, Grid).
//   layout   { v, cats: [{ id, name, collapsed, cells: [cellId] }], cells: { cellId: cell } }
//   cell     { key, match, name, dec, graph, gates: { mode none|y|yr, dir above|below, y, r, hold },
//              curve: { src, pts: [[temp, rpm]], tol, hold }, pred }   (pred: a predicted fan, no key)

const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const send = m => { if (host) host.postMessage(m); };
const $ = id => document.getElementById(id);
const app = $('app'), sectionsEl = $('sections'), dropmark = $('dropmark');
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setText(el, s) { s = s === null || s === undefined ? '' : String(s); if (el && el._t !== s) { el.textContent = s; el._t = s; } }

const ICONS = {
  temp: '<svg viewBox="0 0 24 24"><path d="M12 4a2 2 0 0 1 2 2v8.3a4 4 0 1 1-4 0V6a2 2 0 0 1 2-2z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7z"/></svg>',
  fan: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M12 10c0-3 -1-6 3-6 3 0 3 4 0 5M12 14c0 3 1 6-3 6-3 0-3-4 0-5M10 12c-3 0-6 1-6-3 0-3 4-3 5 0M14 12c3 0 6-1 6 3 0 3-4 3-5 0"/></svg>',
  load: '<svg viewBox="0 0 24 24"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><path d="M4 12h3l2-6 4 12 2-6h5"/></svg>',
  mem: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 15V11M12 15V8M16 15v-2"/></svg>',
  game: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="11" rx="4"/><path d="M8 11v3M6.5 12.5h3"/></svg>',
  grip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  pad: '<svg viewBox="0 0 64 64"><rect x="8" y="12" width="20" height="16" rx="3"/><rect x="36" y="12" width="20" height="16" rx="3"/><rect x="8" y="36" width="20" height="16" rx="3"/><rect x="36" y="36" width="20" height="16" rx="3" stroke-dasharray="3 3"/></svg>'
};
const COLORS = { white: '#e8e8e8', yellow: '#e6c84a', red: '#e5484d', grey: '#555555' };

// ---------- the catalog: every reading HWiNFO shares ----------
const TYPES = ['none', 'temp', 'volt', 'fan', 'current', 'power', 'clock', 'usage', 'other'];
const TYPE_NAME = { temp: 'Temp', volt: 'Volt', fan: 'Fan', power: 'Power', current: 'Current', clock: 'Clock', usage: 'Usage', other: 'Other' };
let SENS = [], READ = [], BYKEY = new Map(), BYMATCH = new Map();
const feed = { status: 'missing', age: 0, fake: false, dataDir: '', version: '', got: false, game: null, front: false, gameSince: 0, hwinfo: null, autostart: false, pm: false, nonClient: true };

function shortName(n) {
  // "S.M.A.R.T.: SAMSUNG SSD 990 PRO 2TB (0123456789ABCDEF) [C:]" is "SAMSUNG SSD 990 PRO 2TB", "CPU [#0]: AMD Ryzen 7 9800X3D: Enhanced" is "CPU"
  const s = n.replace(/\s*\[#\d+\]/g, '').replace(/\s*\[[A-Z]:\]\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '');
  const parts = s.split(/:\s/).map(x => x.trim()).filter(Boolean);
  if (parts.length > 1 && /^(S\.M\.A\.R\.T\.|Drive)$/i.test(parts[0])) return parts[1].replace(/\s*\([^)]*\)/g, '').trim();
  return parts[0] || n;
}
const matchOf = r => (SENS[r.s] ? SENS[r.s].name : '') + '|' + r.label;
const isPM = r => !!r && !!SENS[r.s] && /^PresentMon/.test(SENS[r.s].name);   // fps that only count while a game is in front
const seenKeys = new Set();   // every key a catalog had this session: one that drops out for a while is not re-linked
function setCatalog(m) {
  const old = BYKEY;
  SENS = m.sensors.map(([key, name]) => ({ key, name, short: shortName(name) }));
  // sensors that share a short name get what tells them apart
  const byShort = {};
  for (const sn of SENS) (byShort[sn.short] = byShort[sn.short] || []).push(sn);
  // ("CPU [#0]: Ryzen 7" stays "CPU", "CPU [#0]: Ryzen 7: Enhanced" is "CPU Enhanced"; two "DDR5 DIMM" get their [#n])
  const partsOf = sn => sn.name.replace(/\s*\[#\d+\]/g, '').replace(/\s*\[[A-Z]:\]\s*$/, '').split(/:\s/).map(x => x.trim()).filter(Boolean);
  for (const k in byShort) {
    const g = byShort[k]; if (g.length < 2) continue;
    for (const sn of g) { const pp = partsOf(sn); if (pp.length > 2) sn.short = k + ' ' + pp[pp.length - 1]; }
    const again = {};
    for (const sn of g) (again[sn.short] = again[sn.short] || []).push(sn);
    for (const k2 in again) {
      const same = again[k2], tags = same.map(sn => (/\[#(\d+)\]/.exec(sn.name) || [])[1]);
      if (same.length > 1 && tags.every(t => t != null) && new Set(tags).size === tags.length) same.forEach((sn, i) => { sn.short = k2 + ' #' + tags[i]; });
    }
  }
  let unknown = -1;
  READ = m.readings.map(([s, t, key, label, unit], idx) => {
    if (!SENS[s]) { if (unknown < 0) { unknown = SENS.length; SENS.push({ key: 'unknown.0', name: 'Unknown sensor', short: 'Unknown' }); } s = unknown; }
    const r = { idx, key, s, t: TYPES[t] || 'other', label, unit, v: null, mn: null, mx: null, av: null };
    const o = old.get(key); if (o) { r.v = o.v; r.mn = o.mn; r.mx = o.mx; r.av = o.av; }
    r.hay = ((SENS[s] ? SENS[s].name : '') + ' ' + label + ' ' + unit + ' ' + r.t).toLowerCase();
    return r;
  });
  BYKEY = new Map(READ.map(r => [r.key, r]));
  BYMATCH = new Map();
  for (const r of READ) { const k = matchOf(r); BYMATCH.set(k, BYMATCH.has(k) ? null : r); }   // null: more than one
  BYMATCH2 = new Map();
  for (const r of READ) { const k = matchOf(r) + '|' + r.unit; BYMATCH2.set(k, BYMATCH2.has(k) ? null : r); }
  const n = relinkByName();
  for (const r of READ) seenKeys.add(r.key);
  if (n) toast('Re-linked ' + n + (n > 1 ? ' cells' : ' cell') + ' by sensor name');
}
let BYMATCH2 = new Map();
// a cell whose key this PC never had (another PC, new hardware) finds its reading by sensor name, label and unit,
// when exactly one reading fits; a key that was here and dropped out for a while just waits for it to come back
function relinkByName() {
  let n = 0;
  for (const c of Object.values(S.L.cells)) {
    if (!c.key || BYKEY.has(c.key) || !c.match || seenKeys.has(c.key)) continue;
    const r = c.u != null ? BYMATCH2.get(c.match + '|' + c.u) : BYMATCH.get(c.match);
    if (r) { c.key = r.key; n++; }
  }
  if (n) saveState();
  return n;
}
const isFanR = r => !!r && (r.t === 'fan' || r.unit === 'RPM');
const isF = u => /\u00b0F/.test(u || '');   // HWiNFO can show temperatures in Fahrenheit
const tempUnit = r => r && isF(r.unit) ? '\u00b0F' : '\u00b0C';
const cToU = (c, r) => r && isF(r.unit) ? Math.round(c * 9 / 5 + 32) : c;
function iconOf(c, r) {
  if (c && c.pred) return ICONS.fan;
  if (!r) return ICONS.mem;
  if (isFanR(r)) return ICONS.fan;
  if (r.unit === 'FPS' || /^Frame/.test(r.label)) return ICONS.game;
  return { temp: ICONS.temp, volt: ICONS.bolt, power: ICONS.bolt, current: ICONS.bolt, usage: ICONS.load, clock: ICONS.clock }[r.t] || ICONS.mem;
}

// ---------- history: the last 15 min at 1 s for every cell reading, kept by absolute second ----------
const HLEN = 900;
const rings = new Map();   // key -> { v: Float32Array, at: Float64Array }
let nowTs = 0;
function ring(key) { let g = rings.get(key); if (!g) { g = { v: new Float32Array(HLEN).fill(NaN), at: new Float64Array(HLEN) }; rings.set(key, g); } return g; }
function dropRings(keep) { for (const k of rings.keys()) if (!keep.has(k)) rings.delete(k); }
function ringPut(key, ts, v) { const g = ring(key), k = ts % HLEN; g.v[k] = v == null ? NaN : v; g.at[k] = ts; }
function ringFill(key, ts, arr) { const g = ring(key); for (let i = 0; i < HLEN; i++) { const s = ts - HLEN + 1 + i, k = s % HLEN; g.v[k] = arr[i] == null ? NaN : arr[i]; g.at[k] = s; } }
// the last n seconds of a reading, oldest first, NaN where nothing was measured
function series(key, n, end) {
  end = end || nowTs; const g = rings.get(key), out = new Array(n);
  for (let i = 0; i < n; i++) { const s = end - n + 1 + i, k = ((s % HLEN) + HLEN) % HLEN; out[i] = g && g.at[k] === s ? g.v[k] : NaN; }
  return out;
}
// a cell's own series: a predicted fan's is its temperature's through the curve
function cellSeries(c, n) {
  if (c.pred) return series(c.curve && c.curve.src, n).map(x => isFinite(x) ? interp(c.curve.pts, x) : NaN);
  return series(c.key, n);
}
// 15 min as 6 s buckets on fixed boundaries, so a graph scrolls with time instead of being re-stretched
const BUCKET = 6, NB = HLEN / BUCKET;
function buckets(c, peak) {
  const s = cellSeries(c, HLEN), start = nowTs - HLEN + 1, out = [];
  const b0 = Math.floor(start / BUCKET), b1 = Math.floor(nowTs / BUCKET);
  for (let b = b0; b <= b1; b++) {
    let sum = 0, n = 0;
    let mx = -Infinity;
    for (let t = Math.max(start, b * BUCKET); t <= Math.min(nowTs, b * BUCKET + BUCKET - 1); t++) { const x = s[t - start]; if (isFinite(x)) { sum += x; n++; if (x > mx) mx = x; } }
    out.push({ b, v: n ? (peak ? mx : sum / n) : null });
  }
  return out;
}
const bucketArr = (c, peak) => buckets(c, peak).slice(-NB).map(q => q.v);

// ---------- formatting ----------
// default decimals per unit (the host's Alerts.DecFor says the same in the warning log)
function decFor(r) {
  const u = r ? r.unit || '' : '';
  if (u === 'V') return 3; if (u === 'A' || u === 'x') return 2;
  if (u.indexOf('\u00b0') >= 0 || ['W', 'ms', 'GT/s', 'GB', 'MB/s', 'KB/s', 'GB/s'].includes(u)) return 1;
  return 0;
}
const decOfCell = (c, r) => c.dec != null ? c.dec : r ? decFor(r) : 0;
function fmt(v, dec) { return v == null || !isFinite(v) ? '--' : (+v).toLocaleString('en-US', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 }); }
const isYN = r => !!r && r.unit === 'Yes/No';
// a value as the cell shows it: Yes/No readings in words, the rest with their decimals
const fmtV = (v, dec, r) => isYN(r) ? (v == null || !isFinite(v) ? '--' : v >= 0.5 ? 'Yes' : 'No') : fmt(v, dec);
const unitOf = r => !r || r.unit === 'Yes/No' ? '' : r.unit;
function valTxt(r) { if (!r || r.v == null) return '--'; return isYN(r) ? fmtV(r.v, 0, r) : fmt(r.v, decFor(r)) + (r.unit ? ' ' + r.unit : ''); }
const fmtL = (x, dec) => (+x).toLocaleString('en-US', { maximumFractionDigits: dec == null ? 1 : dec });
function interp(pts, x) {
  if (!pts || !pts.length || x == null || !isFinite(x)) return null;
  const p = pts.slice().sort((a, b) => a[0] - b[0]);
  if (x <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) if (x <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1); }
  return p[p.length - 1][1];
}
const mixHex = (a, b, w) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.substr(i, 2), 16) * (1 - w) + parseInt(b.substr(i, 2), 16) * w).toString(16).padStart(2, '0')).join('');
const durTxt = sec => { const m = Math.max(0, Math.round(sec / 60)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm'; };
const plural = (n, one, many) => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many || one + 's');
const hhmm = u => { const d = new Date(u * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
const localDay = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// ---------- state: the working layout, 5 slots, saved through the host ----------
let uid = 1;
const nid = p => p + Date.now().toString(36) + (uid++).toString(36);
const emptyLayout = () => ({ v: 1, cats: [], cells: {} });
// a layout from a file (state, a slot, an import from another PC) as the page expects it: ids that are safe in
// markup and selectors, every field of the right type, every listed cell present and listed once
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/, idOk = id => typeof id === 'string' && ID_OK.test(id) && !(id in Object.prototype);
function cleanLayout(L) {
  const out = emptyLayout(), cells = L && typeof L.cells === 'object' && L.cells ? L.cells : {}, ids = new Map(), used = new Set(), listed = new Set();
  const str = (x, n) => typeof x === 'string' ? x.slice(0, n || 300) : undefined;
  const fin = x => typeof x === 'number' && isFinite(x) ? x : NaN;
  for (const id of Object.keys(cells)) {
    const c = cells[id];
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const cell = { graph: c.graph !== false };
    if (c.pred === true) cell.pred = true; else { cell.key = str(c.key, 200) || ''; if (str(c.match)) cell.match = str(c.match); if (str(c.u, 20) !== undefined) cell.u = str(c.u, 20); }
    if (str(c.name) && c.name.trim()) cell.name = str(c.name, 200);
    if (Number.isInteger(c.dec) && c.dec >= 0 && c.dec <= 3) cell.dec = c.dec;
    const g = c.gates;
    if (g && typeof g === 'object') cell.gates = { mode: ['y', 'yr'].includes(g.mode) ? g.mode : 'none', dir: g.dir === 'below' ? 'below' : 'above', y: fin(g.y), r: fin(g.r), hold: Math.min(1e9, Math.max(0, fin(g.hold) || 0)) };
    const curveOf = cv => {
      const pts = cv && typeof cv === 'object' && Array.isArray(cv.pts) ? cv.pts.filter(p => Array.isArray(p) && p.length >= 2 && isFinite(fin(p[0])) && isFinite(fin(p[1]))).map(p => [p[0], p[1]]) : [];
      return pts.length >= 2 ? { src: str(cv.src, 200) || '', pts, tol: Math.max(1, isFinite(fin(cv.tol)) ? cv.tol : 15), hold: Math.min(1e9, Math.max(0, isFinite(fin(cv.hold)) ? cv.hold : 10)) } : null;
    };
    const cv = curveOf(c.curve), off = curveOf(c.curveOff);
    if (cv) cell.curve = cv; else if (cell.pred) continue;   // a predicted fan is nothing without its curve
    if (off && !cv) cell.curveOff = off;
    const nid2 = idOk(id) && !used.has(id) ? id : nid('a');
    used.add(nid2); ids.set(id, nid2); out.cells[nid2] = cell;
  }
  for (const cat of L && Array.isArray(L.cats) ? L.cats : []) {
    if (!cat || typeof cat !== 'object') continue;
    const id = idOk(cat.id) && !used.has(cat.id) ? cat.id : nid('c');
    used.add(id);
    const list = [];
    for (const x of Array.isArray(cat.cells) ? cat.cells : []) { const m = typeof x === 'string' ? ids.get(x) : null; if (m && !listed.has(m)) { listed.add(m); list.push(m); } }
    out.cats.push({ id, name: str(cat.name, 200) && cat.name.trim() ? str(cat.name, 200) : 'Category', collapsed: cat.collapsed === true, cells: list });
  }
  for (const id of Object.keys(out.cells)) if (!listed.has(id)) delete out.cells[id];
  return out;
}
const cleanSlot = s => s && typeof s === 'object' && s.layout && Array.isArray(s.layout.cats)
  ? { v: 1, name: typeof s.name === 'string' ? s.name.trim().slice(0, 80) : '', layout: cleanLayout(s.layout) } : null;
const S = { L: emptyLayout(), slots: [null, null, null, null, null], active: null, edit: true, screen: 'tiles', motion: undefined };
// animations, in Settings: Full (all of it), Reduced (lighter: quick number rolls, fans turned by a 10 Hz timer, graphs
// glide at 10 fps, no wave when a view opens), Minimal (nothing keeps moving: numbers just change, fans stand still,
// graphs step; popups and views still slide), Off (nothing moves). Not chosen yet: Full, or Off when Windows asks apps
// for less motion
const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const MOTIONS = ['full', 'reduced', 'minimal', 'off'];
const motionMode = () => MOTIONS.includes(S.motion) ? S.motion : reducedMotion.matches ? 'off' : 'full';
const motionOn = () => motionMode() === 'full';   // the smooth moving parts: spins, draw-ins
const motionSome = () => { const m = motionMode(); return m === 'full' || m === 'reduced'; };   // rolls and glides, quicker or slower in Reduced
function applyMotion() { document.documentElement.dataset.motion = motionMode(); }
if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', () => { applyMotion(); if (feed.got) renderView(false); });
let saveT = 0;
function saveState() { clearTimeout(saveT); saveT = setTimeout(() => send({ t: 'save', file: 'state', data: { v: 1, L: S.L, active: S.active, edit: S.edit, screen: S.screen, motion: S.motion } }), 300); }
function saveSlot(i) { send({ t: 'save', file: 'slots/slot' + (i + 1), data: S.slots[i] }); }
// undo steps hold the layout and which slot it came from, so Clear then Undo is exactly where you were
let undoStack = [], redoStack = [];
const snapOf = () => JSON.stringify({ L: S.L, active: S.active });
// folding a category is how you look at it, not a change: undo keeps the folds as they are
function restore(json) {
  const o = JSON.parse(json), was = new Map(S.L.cats.map(c => [c.id, c.collapsed]));
  S.L = o.L; S.active = Number.isInteger(o.active) && S.slots[o.active] ? o.active : null;
  for (const c of S.L.cats) if (was.has(c.id)) c.collapsed = was.get(c.id);
}
function pushUndo(before) { undoStack.push(before); if (undoStack.length > 80) undoStack.shift(); redoStack = []; toastStale(); }
function snap() { pushUndo(snapOf()); }
// a change that changes nothing (Alt+arrow at the end of a list) leaves no undo step
function mutate(fn, msg) { const before = snapOf(); fn(); if (snapOf() === before) { syncUndo(); renderInsp(); return; } pushUndo(before); afterChange(); if (msg) toast(msg, true); }
function afterChange() { if (relinkFor && !S.L.cells[relinkFor]) endRelink(true); saveState(); subscribe(); renderView(false); renderStorage(); renderInsp(); syncUndo(); syncSaves(); }
function undo() { if (!undoStack.length) return; retireToastUndo(); redoStack.push(snapOf()); restore(undoStack.pop()); fixSel(); afterChange(); }
function redo() { if (!redoStack.length) return; retireToastUndo(); undoStack.push(snapOf()); restore(redoStack.pop()); fixSel(); afterChange(); }
function syncUndo() { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; }
function fixSel() { if (sel && !S.L.cells[sel]) sel = null; }
const layoutSig = L => JSON.stringify(L, (k, v) => k === 'collapsed' ? undefined : v);
const isDirty = () => S.active != null && layoutSig(S.L) !== layoutSig(S.slots[S.active] ? S.slots[S.active].layout : emptyLayout());
function inView() { const set = new Set(); for (const c of Object.values(S.L.cells)) if (c.key) set.add(c.key); return set; }
const catOf = cid => S.L.cats.find(c => c.cells.includes(cid));
const slotName = i => S.slots[i] ? (S.slots[i].name || 'Slot ' + (i + 1)) : 'Slot ' + (i + 1);
function syncSaves() {
  const d = isDirty();
  $('savesDot').classList.toggle('on', d);
  $('savesBtn').title = 'Saves' + (S.active != null ? ': ' + slotName(S.active) + (d ? ', unsaved changes' : '') : '');
  if ($('smodal').classList.contains('open')) renderSaves();
}

// ---------- what the host streams: every cell reading and curve source, plus the Storage rows in sight ----------
let rowKeys = [], subT = 0, lastSub = '', lastTick = 0;
function cellKeys() {
  const set = new Set();
  for (const c of Object.values(S.L.cells)) { if (c.key) set.add(c.key); if (c.curve && c.curve.src) set.add(c.curve.src); }
  return [...set];
}
function subscribe() {
  clearTimeout(subT);
  subT = setTimeout(() => {
    const cells = cellKeys(), m = JSON.stringify([cells, rowKeys]);
    dropRings(new Set(cells));
    if (m === lastSub) return; lastSub = m;
    send({ t: 'sub', cells, rows: rowKeys });
  }, 60);
}

// ---------- a cell's value and state: gates (with their hold), fan curve, warming toward yellow ----------
let sel = null, relinkFor = null;
const holdSince = {};
function cellValue(c) {
  if (c.pred) { const src = BYKEY.get(c.curve && c.curve.src); return src ? interp(c.curve.pts, src.v) : null; }
  const r = BYKEY.get(c.key); return r ? r.v : null;
}
const gatesBad = g => g.mode === 'yr' && Number.isFinite(g.r) && Number.isFinite(g.y) && (g.dir === 'below' ? g.r >= g.y : g.r <= g.y);
const gatesOn = g => !!g && g.mode !== 'none' && Number.isFinite(g.y) && !gatesBad(g);
function evalCell(cid, c, peek, quick) {
  const r = c.key ? BYKEY.get(c.key) : null, live = feed.status === 'ok';
  const v = cellValue(c);
  const out = { v, lvl: 0, warm: 0, sub: '', curve: null, col: 'white' };
  if (v == null) {
    out.col = 'grey';
    if (c.pred && !BYKEY.get(c.curve && c.curve.src)) out.sub = 'its temperature is missing';
    return out;
  }
  let raw = 0, hold = 0;
  const g = c.gates, dec0 = decOfCell(c, r), pmOff = isPM(r) && !feed.pm;
  if (gatesOn(g) && !pmOff) {
    const above = g.dir !== 'below', past = x => above ? v >= x : v <= x;
    if (g.mode === 'yr' && Number.isFinite(g.r) && past(g.r)) raw = 2; else if (past(g.y)) raw = 1;
    // closing in on yellow: border and graph warm toward it over the last 12% (at least 3 steps of the cell's
    // precision: 3 degrees, 0.003 V), in steps
    if (!raw) { const span = Math.max(Math.abs(g.y) * 0.12, dec0 > 1 ? 3 * Math.pow(10, -dec0) : 3), d = above ? g.y - v : v - g.y; if (d < span) out.warm = Math.round((1 - d / span) * 20) / 20; }
    hold = g.hold || 0;
  }
  if (c.curve && !c.pred) {
    const src = BYKEY.get(c.curve.src), exp = src ? interp(c.curve.pts, src.v) : null;
    if (exp != null) {
      const dev = exp > 0 ? (v - exp) / exp * 100 : 0;
      out.curve = { exp, dev, src };
      if (Math.abs(dev) > c.curve.tol && raw < 1) { raw = 1; hold = c.curve.hold || 0; out.offCurve = true; }
    }
  }
  // a gate only turns after the value stayed past it for the hold time
  const now = Date.now() / 1000;
  if (!peek) { if (raw) { if (!holdSince[cid]) holdSince[cid] = now; } else delete holdSince[cid]; }
  out.lvl = raw && holdSince[cid] && now - holdSince[cid] >= hold ? raw : 0;
  out.col = !live ? 'grey' : out.lvl === 2 ? 'red' : out.lvl === 1 ? 'yellow' : 'white';
  if (out.lvl) out.warm = 0;
  const dec = dec0;
  if (pmOff && gatesOn(g) && !out.curve) out.sub = 'lines count while a game is in front';
  else if (out.lvl === 2) out.sub = (g.dir === 'below' ? 'under red ' : 'over red ') + fmt(g.r, dec);
  else if (out.lvl === 1 && !out.offCurve) out.sub = (g.dir === 'below' ? 'under yellow ' : 'over yellow ') + fmt(g.y, dec);
  else if (out.curve) {
    const d = Math.round(out.curve.dev);
    out.sub = Math.abs(out.curve.dev) <= c.curve.tol ? 'on curve, expects ' + fmt(out.curve.exp, 0) : Math.abs(d) + '% ' + (d < 0 ? 'under' : 'over') + ' its curve';
  } else if (c.pred) {
    const src = BYKEY.get(c.curve.src);
    out.sub = src ? 'from ' + src.label + ' ' + fmt(src.v, decFor(src)) + (src.unit ? ' ' + src.unit : '') : 'its temperature is missing';
  } else if (r && !quick && !isYN(r)) {
    let mx = -Infinity; for (const x of series(r.key, HLEN)) if (x > mx) mx = x;
    out.sub = isFinite(mx) ? '15 min max ' + fmt(mx, dec) + (unitOf(r) ? ' ' + r.unit : '') : '';
  }
  return out;
}
const sparkColor = (e, hero) => e.col === 'yellow' ? COLORS.yellow : e.col === 'red' ? COLORS.red : e.col === 'grey' ? '#3a3a3a' : hero ? '#8f8f8f' : '#7c7c7c';
const graphCol = (e, hero) => { const base = sparkColor(e, hero); return e.warm ? mixHex(base, COLORS.yellow, e.warm * 0.75) : base; };

// ---------- odometer numbers: the digits roll to their new places, forward when it goes up, back when it goes down ----------
const REEL = '0123456789'.repeat(3).split('').join('\n');   // three turns of digits: rest in the middle one, roll into a neighbour
const reelAt = (rl, p) => { rl._p = p; rl.style.transform = 'translateY(' + (-p * 100 / 30).toFixed(4) + '%)'; };
const ODO_HOLD = 1500;
// numbers held back by ODO_HOLD wait in one set and roll together, not each on its own timer
const odoWait = new Set();
let odoT = 0;
function odoFlush() {
  clearTimeout(odoT); odoT = 0;
  const now = performance.now();
  let next = Infinity;
  for (const el of [...odoWait]) {
    if (!el.isConnected) { odoWait.delete(el); continue; }
    const left = ODO_HOLD - (now - el._at);
    if (left <= 150) { odoWait.delete(el); const p = el._pend; el._pend = null; if (p != null) odo(el, p, true); }   // due: shown now
    else next = Math.min(next, left);
  }
  if (next < Infinity && !odoT) odoT = setTimeout(odoFlush, next);
}
function odo(el, s, due) {
  if (!el) return;
  s = s === null || s === undefined ? '' : String(s);
  const built = !!el._ocells && el._t === el._ot;
  if (built && el._ot === s) { if (el._pend != null) { el._pend = null; odoWait.delete(el); } return; }
  const now = performance.now();
  // a number replacing "--" (start, HWiNFO back) shows at once; a number replacing a number waits its turn
  if (!due && built && /[0-9]/.test(el._ot) && now - (el._at || 0) < ODO_HOLD) {
    el._pend = s; odoWait.add(el);
    if (!odoT) odoT = setTimeout(odoFlush, ODO_HOLD - (now - el._at));
    return;
  }
  odoWait.delete(el); el._pend = null; el._at = now;
  const old = built ? el._ot : null, num = x => { const n = parseFloat(String(x).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const a = num(old), b = num(s), up = a === null || b === null || b >= a, roll = motionSome();
  const shape = x => x.replace(/[0-9]/g, '0');
  el._t = el._ot = s;
  if (!built || shape(old) !== shape(s)) {
    // a new shape (987 to 1,012, -1 to 0) has no digit-for-digit roll that reads right: it just shows
    let h = '';
    for (const ch of s) h += ch >= '0' && ch <= '9' ? '<span class="od"><span class="odh">' + ch + '</span><span class="odr" aria-hidden="true">' + REEL + '</span></span>' : '<span>' + esc(ch) + '</span>';
    el.innerHTML = h;
    const cells = [...el.children].map((sp, i) => ({ d: +s[i], rl: sp.className === 'od' ? sp.lastChild : null, h: sp.className === 'od' ? sp.firstChild : null }));
    for (const c of cells) if (c.rl) { c.rl.style.transition = 'none'; reelAt(c.rl, c.d + 10); c.rl._snap = true; }
    el._ocells = cells;
    return;
  }
  const cells = el._ocells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]; if (!c.rl) continue;
    const d = +s[i]; if (d === c.d) continue;
    c.d = d; c.h.textContent = s[i];
    if (roll) rollTo(c, d, up); else { c.rl.style.transition = 'none'; reelAt(c.rl, d + 10); c.rl._snap = true; }
  }
}
function rollTo(c, d, up) {
  const rl = c.rl;
  if (rl._snap) { getComputedStyle(rl).opacity; rl.style.transition = ''; rl._snap = false; }
  if (rl._p < 10 || rl._p > 19) { rl.style.transition = 'none'; reelAt(rl, rl._p % 10 + 10); getComputedStyle(rl).opacity; rl.style.transition = ''; }
  const p = rl._p; let t = null;
  for (let k = 0; k < 3; k++) { const q = d + 10 * k; if (up ? q >= p && (t === null || q < t) : q <= p && (t === null || q > t)) t = q; }
  if (t === null) t = d + 10;
  if (t !== p) { rl.parentNode.classList.add('roll'); clearTimeout(rl._tm); rl._tm = setTimeout(settleReel, 800, rl); }
  reelAt(rl, t);
}
function settleReel(rl) {
  clearTimeout(rl._tm);
  const home = rl._p % 10 + 10;
  if (rl._p !== home) { rl.style.transition = 'none'; reelAt(rl, home); rl._snap = true; }
  rl.parentNode.classList.remove('roll');
}
document.addEventListener('transitionend', e => { const rl = e.target; if (rl.className === 'odr' && e.propertyName === 'transform') settleReel(rl); });

// ---------- fan icons turn with their fan: one turn a second at 1500 rpm ----------
const spinning = new Set();
function sweepSpins() { for (const s of spinning) if (!s.isConnected) { s._spin.cancel(); spinning.delete(s); } }
function spinWrap(svg) {
  let w = svg.parentNode;
  if (w.className !== 'spw') { w = document.createElement('i'); w.className = 'spw'; svg.replaceWith(w); w.appendChild(svg); }
  return w;
}
// Reduced: one shared timer turns the fans in steps, 10 times a second, so the page draws 10 frames a second, not one per refresh
const SPIN_HZ = 10;
const stepped = new Set();
let stepT = 0;
function stepSpins() {
  for (const svg of stepped) if (!svg.isConnected || motionMode() !== 'reduced') { stepped.delete(svg); svg.parentNode.style.transform = ''; }
  if (!stepped.size) { clearInterval(stepT); stepT = 0; return; }
  if (document.hidden) return;
  for (const svg of stepped) if (svg._srate) { svg._ang = (svg._ang + svg._srate * 360 / SPIN_HZ) % 360; svg.parentNode.style.transform = 'rotate(' + svg._ang.toFixed(1) + 'deg)'; }
}
function spinIcon(svg, rpm) {
  if (!svg) return;
  const mode = motionMode();
  const rate = (mode === 'full' || mode === 'reduced') && rpm > 0 && feed.status === 'ok' ? Math.max(0.05, Math.round(rpm / 1500 * 20) / 20) : 0;
  if (mode === 'reduced') {
    if (svg._spin) { svg._spin.cancel(); svg._spin = null; spinning.delete(svg); }
    if (!rate && !stepped.has(svg)) return;
    spinWrap(svg);
    svg._srate = rate; if (svg._ang == null) svg._ang = 0;
    stepped.add(svg);
    if (!stepT) stepT = setInterval(stepSpins, 1000 / SPIN_HZ);
    return;
  }
  if (stepped.delete(svg)) svg.parentNode.style.transform = '';
  if (!svg._spin) {
    if (!rate) return;
    sweepSpins(); spinning.add(svg);
    const w = spinWrap(svg);
    svg._spin = w.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1000, iterations: Infinity });
    svg._spin.playbackRate = rate; svg._rate = rate;
  } else if (!rate) { if (svg._spin.playState !== 'paused') svg._spin.pause(); svg._rate = 0; }   // a paused animation draws nothing
  else {
    if (svg._rate !== rate) { svg._spin.updatePlaybackRate(rate); svg._rate = rate; }
    if (svg._spin.playState === 'paused') svg._spin.play();
  }
}
const pauseSpin = svg => { if (!svg) return; svg._srate = 0; if (svg._spin) svg._spin.pause(); };
function glow(r, lvl) {
  if (motionMode() === 'off') return;
  const c = lvl === 2 ? '229,72,77' : '230,200,74';
  const kf = [{ boxShadow: 'inset 0 0 0 999px rgba(' + c + ',0.16)' }, { boxShadow: 'inset 0 0 0 999px rgba(' + c + ',0)' }];
  for (const el of r.root.tagName === 'TR' ? [...r.root.children] : [r.root]) el.animate(kf, { duration: 1800, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
}

// ---------- graphs: 15 min that scroll with time; each new second the line morphs into the new one ----------
const GDUR = 500;
const graphs = new Map();
let graphRaf = 0, graphT = 0;
const easeOut = p => 1 - Math.pow(1 - p, 3);
const easeInOut = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
function graphState(c) {
  const bs = buckets(c), pts = [];
  for (let i = 0; i < bs.length; i++) { if (bs[i].v === null) continue; pts.push({ s: bs[i].b, v: bs[i].v, x: i === bs.length - 1 ? (nowTs + 1) / BUCKET : bs[i].b + 0.5 }); }
  if (pts.length < 2) return null;
  let lo = Infinity, hi = -Infinity;
  for (const q of pts) { if (q.v < lo) lo = q.v; if (q.v > hi) hi = q.v; }
  const dec = c.pred ? 0 : decOfCell(c, BYKEY.get(c.key));
  const minSpan = Math.max(dec > 1 ? Math.pow(10, 1 - dec) : 1, Math.abs(hi) * 0.04);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const end = (nowTs + 1) / BUCKET;
  // a young history spans what there is (at least a minute) and widens as it builds up
  const span = Math.min(NB, Math.max(10, end - pts[0].s));
  return { pts, end, span, lo, hi, map: new Map(pts.map(q => [q.s, q])) };
}
function lerpState(a, b, p) {
  if (!a || !b) return b;
  const e = easeInOut(p);
  const pts = b.pts.map(q => { const o = a.map.get(q.s); return o ? { s: q.s, v: o.v + (q.v - o.v) * e, x: o.x + (q.x - o.x) * p } : q; });
  return { pts, end: a.end + (b.end - a.end) * p, span: a.span + (b.span - a.span) * p, lo: a.lo + (b.lo - a.lo) * e, hi: a.hi + (b.hi - a.hi) * e, map: new Map(pts.map(q => [q.s, q])) };
}
function graphFeed(cv, c, col) {
  const now = performance.now();
  let G = graphs.get(cv);
  if (!G) { G = { cur: null, from: null, to: null, t0: 0, rev0: cv._enter && motionOn() ? now : 0, last: 0 }; graphs.set(cv, G); cv._enter = false; }
  G.col = col;
  const st = graphState(c);
  if (!st) { G.cur = G.from = G.to = null; G.dirty = true; kickGraphs(); return; }
  if (!G.to || !motionSome()) { G.cur = G.from = G.to = st; G.t0 = 0; } else { G.from = G.cur || G.to; G.to = st; G.t0 = now; }
  G.dirty = true; kickGraphs();
}
function kickGraphs() { if (!graphRaf && !graphT) graphRaf = requestAnimationFrame(graphLoop); }
function graphTick() { graphT = 0; kickGraphs(); }
function graphLoop(now) {
  graphRaf = 0;
  let more = false;
  const todo = [];
  for (const [cv, G] of graphs) {
    if (!cv.isConnected) { graphs.delete(cv); continue; }
    const p = G.t0 ? Math.min(1, (now - G.t0) / GDUR) : 1, rv = G.rev0 ? Math.min(1, (now - G.rev0) / 800) : 1;
    const moving = p < 1 || rv < 1;
    if (!moving && !G.dirty) continue;
    if (moving && now - G.last < (rv < 1 ? 15 : 32)) { more = true; continue; }
    todo.push({ cv, G, p, rv, moving });
  }
  // every size first, then the drawing: a size read after a canvas was resized would lay out the page each time
  for (const t of todo) if (t.G.cw == null) { t.G.cw = t.cv.clientWidth; t.G.ch = t.cv.clientHeight; }
  for (const { cv, G, p, rv, moving } of todo) {
    G.last = now;
    G.cur = p < 1 ? lerpState(G.from, G.to, p) : G.to;
    if (rv >= 1) G.rev0 = 0;
    drawGraph(cv, G, rv < 1 ? easeOut(rv) : 1);
    G.dirty = false;
    if (moving) more = true;
  }
  if (more && motionMode() === 'reduced') { if (!graphT) graphT = setTimeout(graphTick, 100); }   // Reduced: a glide in 10 fps steps
  else if (more) kickGraphs();
}
function drawGraph(cv, G, rev) {
  if (G.cw == null) { G.cw = cv.clientWidth; G.ch = cv.clientHeight; }
  const dpr = window.devicePixelRatio || 1, w = Math.round(G.cw * dpr), h = Math.round(G.ch * dpr);
  if (!w || !h) return;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const st = G.cur;
  if (!st || st.pts.length < 2) return;
  const pad = 5 * dpr, x0 = st.end - st.span, X = x => 1 + (x - x0) / st.span * (w - 1 - pad), Y = v => h - 3 * dpr - (v - st.lo) / (st.hi - st.lo) * (h - 3 * dpr - pad);
  ctx.save();
  if (rev < 1) { ctx.beginPath(); ctx.rect(0, 0, w * rev, h); ctx.clip(); }
  // a stretch with no readings (HWiNFO away) is a gap, not a straight line across it
  const segs = [];
  st.pts.forEach((q, i) => { if (!i || q.s - st.pts[i - 1].s > 2) segs.push([]); segs[segs.length - 1].push(q); });
  ctx.beginPath();
  for (const sg of segs) sg.forEach((q, i) => i ? ctx.lineTo(X(q.x), Y(q.v)) : ctx.moveTo(X(q.x), Y(q.v)));
  ctx.strokeStyle = G.col; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.4 * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();
  const tip = st.pts[st.pts.length - 1];
  ctx.beginPath();
  for (const sg of segs) { sg.forEach((q, i) => i ? ctx.lineTo(X(q.x), Y(q.v)) : ctx.moveTo(X(q.x), Y(q.v))); ctx.lineTo(X(sg[sg.length - 1].x), h); ctx.lineTo(X(sg[0].x), h); ctx.closePath(); }
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, G.col + '2e'); grad.addColorStop(1, G.col + '00');
  ctx.globalAlpha = 1; ctx.fillStyle = grad; ctx.fill();
  if (rev >= 1) {
    ctx.fillStyle = G.col + '38'; ctx.beginPath(); ctx.arc(X(tip.x), Y(tip.v), 4.2 * dpr, 0, 7); ctx.fill();
    ctx.fillStyle = G.col; ctx.beginPath(); ctx.arc(X(tip.x), Y(tip.v), 1.9 * dpr, 0, 7); ctx.fill();
  }
  ctx.restore();
}
// a graph that changes size redraws on the next frame, with the size the observer already measured
const ro = new ResizeObserver(entries => {
  for (const en of entries) { const G = graphs.get(en.target); if (G) { G.cw = en.contentRect.width; G.ch = en.contentRect.height; G.dirty = true; } }
  kickGraphs();
});

// ---------- the three views ----------
let E = new Map();       // cell id -> its elements in the current view
let CARDS = [];          // the Overview's cards (their tags)
let enterNext = true, slideDir = 0, entrance = null, animI = 0;
const anim = () => ' anim" style="--i:' + (animI++);
function cellName(c) { const r = c.key ? BYKEY.get(c.key) : null; return c.name || (r ? r.label : c.pred ? 'Predicted fan' : (c.match ? c.match.split('|')[1] : 'Missing reading')); }
const isMissing = c => !c.pred && READ.length > 0 && !BYKEY.has(c.key);
// a missing reading whose sensor is here was dropped by HWiNFO for now (hidden, device idle); else it's from another PC
const sensorHere = c => !!c.key && SENS.some(sn => c.key.startsWith(sn.key + '/'));
const missingTxt = c => sensorHere(c) ? 'HWiNFO isn\'t sharing this reading right now' : 'not on this PC: ' + (c.match ? c.match.split('|')[0] : c.key);
const isFanCell = c => c.pred || isFanR(BYKEY.get(c.key));
function catHead(cat, inner) {
  return '<span class="grip" title="Drag to move the category">' + ICONS.grip + '</span><button class="ib chev" title="Collapse">' + ICONS.chev + '</button>' + (inner || '') +
    '<span class="cn" title="Double-click to rename">' + esc(cat.name) + '</span><span class="cnt">' + cat.cells.length + '</span>' +
    '<span class="acts"><button class="ib ren" title="Rename">' + ICONS.pen + '</button><button class="ib del" title="Remove the category and its cells">' + ICONS.x + '</button></span>';
}
const catCls = cat => 'dcat' + (cat.collapsed ? ' collapsed' : '') + (cat.cells.length ? '' : ' isempty');
const cellsOf = cat => cat.cells.filter(id => S.L.cells[id]);
function tileHtml(cid) {
  const c = S.L.cells[cid], r = c.key ? BYKEY.get(c.key) : null, miss = isMissing(c);
  return '<div class="tile dc' + (c.pred ? ' pred' : '') + (miss ? ' missing' : '') + (cid === sel ? ' sel' : '') + anim() + '" data-cid="' + esc(cid) + '" data-k="tile" tabindex="0">' +
    '<div class="tn">' + iconOf(c, r) + '<span>' + esc(cellName(c)) + '</span>' + (c.pred && !/predicted/i.test(cellName(c)) ? '<span class="badge">predicted</span>' : '') + '</div>' +
    '<div class="tv"><span class="v"></span><small class="u">' + esc(c.pred ? 'RPM' : unitOf(r)) + '</small></div><div class="tc"></div>' +
    (miss ? (S.edit ? '<button class="btn rl">Re-link</button>' : '') : c.graph !== false ? '<canvas></canvas>' : '') + '</div>';
}
function buildTiles() {
  return '<div class="tl" id="view">' + S.L.cats.map(cat => {
    const ids = cellsOf(cat);
    return '<section class="blk ' + catCls(cat) + (ids.length > 6 ? ' wide' : '') + '" data-cat="' + esc(cat.id) + '"><h2 class="dch">' + catHead(cat) + '</h2>' +
      '<div class="tg dgrid">' + ids.map(tileHtml).join('') + '</div></section>';
  }).join('') + '</div>';
}
function buildOverview() {
  return '<div class="ov" id="view">' + S.L.cats.map(cat => {
    const ids = cellsOf(cat), first = ids.length ? S.L.cells[ids[0]] : null;
    const icon = first ? iconOf(first, first.key ? BYKEY.get(first.key) : null) : ICONS.mem;
    return '<section class="card ' + catCls(cat) + anim() + '" data-cat="' + esc(cat.id) + '"><div class="ch dch">' + catHead(cat, icon) + '<span class="tag"></span></div>' +
      '<div class="dgrid vert">' + ids.map((cid, i) => {
        const c = S.L.cells[cid], r = c.key ? BYKEY.get(c.key) : null, miss = isMissing(c), u = esc(c.pred ? 'RPM' : unitOf(r));
        const cls = (miss ? ' missing' : '') + (cid === sel ? ' sel' : '');
        if (i === 0) return '<div class="hero dc' + cls + '" data-cid="' + esc(cid) + '" data-k="hero" tabindex="0"><div><div class="nm">' + iconOf(c, r) + '<span>' + esc(cellName(c)) + '</span></div>' +
          '<div class="hv"><span class="v"></span><small class="u">' + u + '</small></div><div class="hc"></div>' + (miss && S.edit ? '<button class="btn rl">Re-link</button>' : '') + '</div>' +
          (c.graph !== false && !miss ? '<canvas></canvas>' : '<span></span>') + '</div>';
        return '<div class="row dc' + cls + '" data-cid="' + esc(cid) + '" data-k="row" tabindex="0"><span class="lbl"><span class="nm">' + iconOf(c, r) + '<span>' + esc(cellName(c)) + '</span></span><i></i></span>' +
          (c.graph !== false && !miss ? '<canvas class="rsp"></canvas>' : miss && S.edit ? '<button class="btn rl">Re-link</button>' : '<span></span>') +
          '<span class="val"><span class="v"></span><small class="u">' + u + '</small></span></div>';
      }).join('') + '</div></section>';
  }).join('') + '</div>';
}
function buildGrid() {
  // two tables side by side when there is room, split near the middle row
  const cats = S.L.cats, rows = cats.map(c => cellsOf(c).length + 1), total = rows.reduce((a, b) => a + b, 0);
  let acc = 0, cut = cats.length;
  for (let i = 0; i < cats.length; i++) { if (acc >= total / 2 && i > 0) { cut = i; break; } acc += rows[i]; }
  const table = list => '<div class="gtable' + anim() + '"><table class="gt"><colgroup><col style="width:26%"><col style="width:15%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:10%"><col></colgroup>' +
    '<thead><tr><th class="l">sensor</th><th>current</th><th title="HWiNFO\'s own, since it started or was reset">min</th><th title="HWiNFO\'s own, since it started or was reset">max</th><th title="HWiNFO\'s own, since it started or was reset">average</th><th>lines</th><th class="l">info</th></tr></thead>' +
    list.map(cat => '<tbody class="' + catCls(cat) + '" data-cat="' + esc(cat.id) + '"><tr class="ghdr"><td colspan="7"><span class="dchw dch">' + catHead(cat) + '</span></td></tr>' +
      cellsOf(cat).map(cid => {
        const c = S.L.cells[cid], r = c.key ? BYKEY.get(c.key) : null, miss = isMissing(c);
        return '<tr class="dc' + (miss ? ' missing' : '') + (cid === sel ? ' sel' : '') + '" data-cid="' + esc(cid) + '" data-k="grow" tabindex="0"><td class="gname">' + iconOf(c, r) + '<span>' + esc(cellName(c)) + '</span>' + (miss && S.edit ? '<button class="btn rl">Re-link</button>' : '') + '</td>' +
          '<td class="gval"><span class="v"></span><span class="u gu">' + esc(c.pred ? 'RPM' : unitOf(r)) + '</span></td><td class="gn"></td><td class="gn"></td><td class="gn"></td><td class="glines"></td><td class="ginfo"></td></tr>';
      }).join('') + '</tbody>').join('') + '</table></div>';
  return '<div class="gsplit" id="view">' + (cats.length ? table(cats.slice(0, cut)) + (cut < cats.length ? table(cats.slice(cut)) : '') : '') + '</div>';
}
function setupHtml() {
  return '<div class="setup" id="view"><h2>HWiNFO isn\'t sharing its sensors</h2><span>HW Deck shows what HWiNFO measures, so it needs HWiNFO running with its shared memory on:</span><ol>' +
    '<li>Install HWiNFO (hwinfo.com) and start it in <b>Sensors-only</b> mode.</li><li>In its Settings, turn on <b>Shared Memory Support</b>.</li>' +
    '<li>Keep HWiNFO running. The free version turns shared memory off after 12 hours; HW Deck then offers to restart it.</li></ol>' +
    '<span>This screen goes away by itself once the readings arrive. HWiNFO already running with shared memory on, and still nothing?</span>' +
    '<span><button class="btn" id="setupRestart"' + (feed.fake ? ' disabled' : '') + '>Restart HWiNFO</button></span></div>';
}
function emptyHtml() {
  return '<div class="empty" id="view">' + ICONS.pad + '<b>No cells yet</b><span>' + (S.edit ? 'Drag readings from Storage into here, or press + on a row.<br>Dropping on the box below makes a category.'
    : 'Turn on Edit layout (the pencil, or E) to add readings.') + '</span></div>';
}
function buildView() {
  // a category rename in progress keeps what was typed (without a second render in the middle of this one)
  const ren = document.querySelector('#view .cn-in');
  if (ren && ren._commit) ren._commit(true, true);
  ro.disconnect(); sweepSpins();
  animI = 0;
  if (sectionsEl._slide) { sectionsEl._slide.cancel(); sectionsEl._slide = null; }
  sectionsEl.classList.remove('sliding');
  const old = $('view');
  for (const cv of old.querySelectorAll('canvas')) { cv.width = 0; cv.height = 0; }   // their memory goes now, not at some later collection
  const html = !S.L.cats.length ? (feed.got && !READ.length && feed.status === 'missing' && !feed.fake ? setupHtml() : emptyHtml())
    : S.screen === 'grid' ? buildGrid() : S.screen === 'overview' ? buildOverview() : buildTiles();
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  old.replaceWith(tmp.firstChild);
  E = new Map();
  for (const el of document.querySelectorAll('#view .dc')) {
    const q = s => el.querySelector(s), cid = el.dataset.cid, c = S.L.cells[cid];
    const r = { root: el, cid, kind: el.dataset.k, v: q('.v'), u: q('.u'), vbox: q('.tv, .hv, .val, .gval'), cap: q('.tc, .hc, .lbl i, .ginfo'), canvas: q('canvas'), lines: q('.glines') };
    if (r.kind === 'grow') r.td = el.children;
    if (c && isFanCell(c)) r.fan = q('.tn svg, .nm svg, .gname svg');
    if (r.canvas) { r.canvas._enter = enterNext; ro.observe(r.canvas); }
    E.set(cid, r);
  }
  CARDS = [...document.querySelectorAll('#view .card')].map(el => ({ el, cat: el.dataset.cat, tag: el.querySelector('.tag') }));
  const view = $('view');
  const mm = motionMode();
  if (mm === 'off' || ((mm === 'reduced' || mm === 'minimal') && !(enterNext && slideDir))) entrance = null;   // Reduced and Minimal keep the view slide, not the wave
  else if (enterNext && slideDir) entrance = slideDir;
  else if (enterNext) {
    const vr = view.getBoundingClientRect();
    for (const el of view.querySelectorAll('.anim')) {
      const b = el.getBoundingClientRect();
      el.style.animationDelay = Math.round(((b.left - vr.left) / Math.max(1, vr.width) * 0.35 + (b.top - vr.top) / Math.max(1, vr.height) * 0.65) * 240) + 'ms';
    }
    entrance = 0;
  } else entrance = null;
  enterNext = false; slideDir = 0;
}
function playEntrance() {
  const view = $('view'), dir = entrance;
  entrance = null;
  if (dir === null || !view) return;
  if (dir) {
    sectionsEl.classList.add('sliding');
    const a = sectionsEl._slide = view.animate([{ transform: 'translateX(' + (dir * 3) + '%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    a.onfinish = a.oncancel = () => { if (sectionsEl._slide === a) { sectionsEl._slide = null; sectionsEl.classList.remove('sliding'); } };
  } else { view.classList.add('enter'); setTimeout(() => view.classList.remove('enter'), 1000); }
}
function renderView(enter) {
  if (enter) enterNext = true;
  buildView();
  updateView(true);
  autofit();
  playEntrance();
}

// every tick: numbers, colours, captions, graphs; reads first (which cells are in sight), then writes
function updateView(all) {
  // seen: gets its number this time (all of them after a rebuild); sight: its graph is drawn (only what is on screen)
  const sr = sectionsEl.getBoundingClientRect(), seen = new Map(), sight = new Map();
  for (const [cid, r] of E) { const b = r.root.getBoundingClientRect(), on = b.bottom > sr.top - 60 && b.top < sr.bottom + 60 && b.height > 0; sight.set(cid, on); seen.set(cid, all || on); }
  const cardLvl = {};
  for (const [cid, r] of E) {
    const c = S.L.cells[cid]; if (!c) continue;
    const rd = c.key ? BYKEY.get(c.key) : null, vis = seen.get(cid);
    if (isMissing(c)) { odo(r.v, '--'); setText(r.cap, missingTxt(c)); continue; }
    const e = evalCell(cid, c, false, !vis);
    const cat = catOf(cid); if (cat) cardLvl[cat.id] = Math.max(cardLvl[cat.id] || 0, e.lvl);
    const dec = decOfCell(c, rd);
    if (vis) odo(r.v, fmtV(e.v, dec, rd));
    const colCls = e.col === 'white' ? '' : e.col;
    if (r.vbox) { for (const k of ['yellow', 'red', 'grey']) r.vbox.classList.toggle(k, colCls === k); }
    if (r.cap) { setText(r.cap, e.sub); r.cap.classList.toggle('y', e.lvl === 1); r.cap.classList.toggle('r', e.lvl === 2); }
    if (r.kind === 'tile') {
      r.root.classList.toggle('yellow', e.lvl === 1); r.root.classList.toggle('red', e.lvl === 2); r.root.classList.toggle('warm', e.warm > 0);
      if (r._w !== e.warm) { r._w = e.warm; r.root.style.setProperty('--wb', e.warm ? mixHex('#242424', '#5c4f1d', e.warm * 0.85) : ''); }
    }
    if (r.kind === 'grow') {
      const f = x => x == null ? '' : fmtV(x, dec, rd);
      setText(r.td[2], c.pred ? '' : f(rd && rd.mn)); setText(r.td[3], c.pred ? '' : f(rd && rd.mx));
      setText(r.td[4], c.pred || !rd || rd.av == null ? '' : isYN(rd) ? Math.round(rd.av) + '% yes' : f(rd.av));
      for (const i of [2, 3, 4]) if (r.td[i].title !== r.td[i]._t) r.td[i].title = r.td[i]._t || '';
      const cur = fmtV(e.v, dec, rd) + (unitOf(rd) && e.v != null ? ' ' + unitOf(rd) : c.pred && e.v != null ? ' RPM' : '');
      if (r.td[1].title !== cur) r.td[1].title = cur;
      if (r.cap && r.cap.title !== (e.sub || '')) r.cap.title = e.sub || '';
      const g = c.gates, lh = gatesOn(g) ? '<span class="y">' + fmtL(g.y, dec) + '</span>' + (g.mode === 'yr' && Number.isFinite(g.r) ? '&nbsp; <span class="r">' + fmtL(g.r, dec) + '</span>' : '') : '';
      if (r.lines._h !== lh) { r.lines.innerHTML = lh; r.lines._h = lh; }
    }
    if (r.fan) spinIcon(r.fan, e.v);
    if (r._lvl !== undefined && e.lvl > r._lvl) glow(r, e.lvl);
    r._lvl = e.lvl;
    if (r.canvas && sight.get(cid)) graphFeed(r.canvas, c, graphCol(e, r.kind === 'hero'));
  }
  for (const k of CARDS) {
    const cat = S.L.cats.find(c => c.id === k.cat); if (!cat) continue;
    const ids = cellsOf(cat), lv = cardLvl[cat.id] || 0;
    let n = 0; for (const id of ids) { const r = E.get(id); if (r && r._lvl) n++; }
    const fans = ids.length && ids.every(id => isFanCell(S.L.cells[id]));
    const txt = n ? plural(n, 'warning') : fans ? ids.filter(id => !S.L.cells[id].pred && (cellValue(S.L.cells[id]) || 0) > 100).length + ' spinning' : 'all normal';
    if (k.tag) { setText(k.tag, txt); k.tag.className = 'tag' + (lv === 2 ? ' r' : lv === 1 ? ' y' : ''); }
    k.el.classList.toggle('warn-y', lv === 1); k.el.classList.toggle('warn-r', lv === 2);
  }
}

// ---------- fit: in the clean view, the largest scale at which nothing scrolls (it scrolls past 60%) ----------
let fitRatio = 1, fitTimer = 0;
const cssScale = () => Math.min(22, Math.max(12, 0.0048 * Math.min(innerWidth, innerHeight * 1.9) + 7));
const fits = () => sectionsEl.scrollHeight <= sectionsEl.clientHeight;
function autofit() {
  const root = document.documentElement;
  if (S.edit || !S.L.cats.length) { root.style.fontSize = '13px'; fitRatio = 1; return; }
  const target = cssScale();
  root.style.fontSize = target + 'px';
  if (fits()) { fitRatio = 1; return; }
  let lo = Math.max(9, target * 0.6), hi = target;
  root.style.fontSize = lo + 'px';
  if (fits()) {
    for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; root.style.fontSize = mid + 'px'; if (fits()) lo = mid; else hi = mid; }
    root.style.fontSize = lo + 'px';
  } else {
    // the smallest size didn't fit (tiles reflow, so a size between may): the largest that does, else readable and scrolling
    let found = 0;
    for (let fs = target - 0.5; fs > lo; fs -= 0.5) { root.style.fontSize = fs + 'px'; if (fits()) { found = fs; break; } }
    lo = found || target; root.style.fontSize = lo + 'px';
  }
  fitRatio = lo / target;
}
window.addEventListener('resize', () => {
  if (!S.edit) document.documentElement.style.fontSize = (cssScale() * fitRatio) + 'px';
  clearTimeout(fitTimer); fitTimer = setTimeout(() => { autofit(); updateView(true); }, 250);
  placeTabInd(true); drawRows();
});

// ---------- views: Tiles, Overview, Grid ----------
function placeTabInd(still) {
  const b = document.querySelector('#screens button[data-s="' + S.screen + '"]'), ind = $('tabind');
  if (!b) return;
  ind.classList.toggle('still', !!still); ind.style.width = b.offsetWidth + 'px'; ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
}
function showScreen(s, first) {
  const order = ['tiles', 'overview', 'grid'];
  slideDir = first ? 0 : Math.sign(order.indexOf(s) - order.indexOf(S.screen));
  S.screen = s;
  for (const b of document.querySelectorAll('#screens button[data-s]')) b.classList.toggle('active', b.dataset.s === s);
  placeTabInd(!!first);
  if (!first) saveState();
  hidePrev();
  renderView(true);
}
$('screens').addEventListener('click', e => { const b = e.target.closest('button[data-s]'); if (b && b.dataset.s !== S.screen) showScreen(b.dataset.s); });

// ---------- Storage: a virtual list, only the rows in sight exist ----------
const ROWH = 30;
let rows = [], typeFilter = 'all', query = '', hideIn = false;
const collapsedGroups = new Set();
function passes(r, toks, iv) {
  if (typeFilter !== 'all' && r.t !== typeFilter) return false;
  if (hideIn && iv.has(r.key)) return false;
  for (const t of toks) if (!r.hay.includes(t)) return false;
  return true;
}
let chipCounts = {};
function computeRows() {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean), iv = inView();
  const counts = new Map(), hits = [];
  chipCounts = { all: 0 };
  for (const r of READ) {
    if ((hideIn && iv.has(r.key)) || toks.some(t => !r.hay.includes(t))) continue;   // the chips count what the search leaves
    chipCounts.all++; chipCounts[r.t] = (chipCounts[r.t] || 0) + 1;
    if (typeFilter === 'all' || r.t === typeFilter) { hits.push(r); counts.set(r.s, (counts.get(r.s) || 0) + 1); }
  }
  rows = [];
  let cur = -1, gi = -1;
  for (const r of hits) {
    if (r.s !== cur) { cur = r.s; gi = rows.length; rows.push({ g: true, s: r.s, n: counts.get(r.s) }); }
    if (!collapsedGroups.has(SENS[r.s].key)) rows.push({ g: false, r, gi });
  }
}
function renderStorage() {
  if (!S.edit) return;
  computeRows();
  $('vspace').style.height = rows.length * ROWH + 'px';
  drawRows(); renderChips();
}
function drawRows() {
  if (!S.edit) return;
  const vl = $('vlist'), sp = $('vspace');
  const top = vl.scrollTop, hgt = vl.clientHeight || 400;
  if (!rows.length && READ.length) {
    const h = '<div class="vempty">No readings match' + (query ? ' "' + esc(query) + '"' : typeFilter !== 'all' ? ' this type' : '') + '. <button class="linkbtn" id="qClear">Show all</button></div>';
    if (sp._h !== h) { sp.innerHTML = h; sp._h = h; }
    if (rowKeys.length) { rowKeys = []; subscribe(); }
    $('vsticky').hidden = true;
    return;
  }
  const a = Math.max(0, Math.floor(top / ROWH) - 4), b = Math.min(rows.length, Math.ceil((top + hgt) / ROWH) + 4);
  const iv = inView(), keys = [];
  let html = '';
  for (let i = a; i < b; i++) {
    const row = rows[i];
    if (row.g) {
      const sn = SENS[row.s];
      html += '<div class="vrow g' + (collapsedGroups.has(sn.key) ? ' collapsed' : '') + '" style="top:' + i * ROWH + 'px" data-gs="' + row.s + '"><button class="tw" title="Collapse">' + ICONS.chev + '</button><span class="gn" title="' + esc(sn.name) + '">' + esc(sn.name) + '</span><span class="gc">' + row.n + '</span>' + (relinkFor ? '' : '<button class="addall" title="Add these as a new category">+ all</button>') + '</div>';
    } else {
      const r = row.r, has = iv.has(r.key);
      keys.push(r.key);
      html += '<div class="vrow r" style="top:' + i * ROWH + 'px" data-key="' + esc(r.key) + '"><span class="ti t-' + r.t + '"></span><span class="lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="val"></span>' +
        (relinkFor ? '<button class="add link" data-act="link">Link</button>' : has ? '<span class="inv" title="In the view">' + ICONS.check + '</span>' : '<button class="add" data-act="add" title="Add to the view">+</button>') + '</div>';
    }
  }
  // the same rows as last time stay the same elements (a click that spans a tick still lands); only values change
  if (sp._h !== html) { sp.innerHTML = html; sp._h = html; }
  for (const el of sp.children) if (el.dataset.key) setText(el.children[2], valTxt(BYKEY.get(el.dataset.key)));
  if (keys.join('\n') !== rowKeys.join('\n')) { rowKeys = keys; subscribe(); }
  const st = $('vsticky'), first = rows[Math.floor(top / ROWH)];
  if (first && !first.g && top > 0) { const sn = SENS[first.r.s]; st.hidden = false; st.innerHTML = '<span class="gn">' + esc(sn.name) + '</span><span class="gc">' + rows[first.gi].n + '</span>'; }
  else st.hidden = true;
}
function renderChips() {
  const counts = chipCounts;
  $('chips').innerHTML = ['all', 'temp', 'volt', 'fan', 'power', 'current', 'clock', 'usage', 'other'].filter(t => counts[t] || t === typeFilter)
    .map(t => '<button class="chip' + (typeFilter === t ? ' on' : '') + '" data-t="' + t + '">' + (t === 'all' ? 'All' : TYPE_NAME[t]) + ' ' + (counts[t] || 0).toLocaleString('en-US') + '</button>').join('');
}

// ---------- adding and removing cells ----------
function newCell(key) { const r = BYKEY.get(key); return { key, match: r ? matchOf(r) : undefined, u: r ? r.unit : undefined, graph: true }; }
function addKeys(keys, catId, index, newCatName) {
  mutate(() => {
    let cat = catId && S.L.cats.find(c => c.id === catId);
    if (!cat) { cat = { id: nid('c'), name: newCatName || 'New category', collapsed: false, cells: [] }; S.L.cats.push(cat); }
    const ids = keys.map(k => { const id = nid('a'); S.L.cells[id] = newCell(k); return id; });
    cat.cells.splice(index == null ? cat.cells.length : index, 0, ...ids);
    if (ids.length === 1) sel = ids[0];
  }, keys.length > 1 ? 'Added ' + keys.length + ' cells' : null);
}
function targetForAdd() {
  if (sel) { const c = catOf(sel); if (c) return { cat: c.id, index: c.cells.indexOf(sel) + 1 }; }
  const last = S.L.cats[S.L.cats.length - 1];
  return last ? { cat: last.id, index: null } : { cat: null, index: null };
}
function removeCell(cid) { mutate(() => { const c = catOf(cid); if (c) c.cells.splice(c.cells.indexOf(cid), 1); delete S.L.cells[cid]; if (sel === cid) sel = null; }, 'Cell removed'); }
// the temperature a fan most likely follows: one whose label shares a word with the fan's (CPU fan, CPU), the GPU's
// for a GPU fan, the CPU's (pumps and case fans usually follow it), the same sensor's, else any
function guessTemp(fanKey) {
  const f = BYKEY.get(fanKey), temps = READ.filter(x => x.t === 'temp');
  if (!temps.length) return null;
  const fl = f ? (SENS[f.s].name + ' ' + f.label).toLowerCase() : '', gpuFan = /gpu/.test(fl);
  const words = f ? f.label.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !/^(fan|fans|rpm|speed|opt|header|\d+)$/.test(w)) : [];
  if (/pump|aio|water|liquid/.test(fl)) words.push('cpu');
  const cpuMain = x => /^(CPU \(Tctl\/Tdie\)|CPU Package|CPU \(Tctl\)|Core Max|CPU Die \(average\))$/.test(x.label);
  let best = null, bs = -1;
  for (const x of temps) {
    const lw = x.label.toLowerCase().split(/[^a-z0-9]+/);
    let sc = 0;
    for (const w of words) if (lw.includes(w)) sc += 4;
    if (gpuFan && /^GPU Temperature$/i.test(x.label) && !/igpu/i.test(SENS[x.s].name)) sc += 6;
    if (!gpuFan && cpuMain(x)) sc += 2;
    if (f && x.s === f.s) sc += 1;
    if (sc > bs) { bs = sc; best = x; }
  }
  return best;
}
// a starting curve with the fan on it right now (its rpm at the temperature it sees now), so turning it on warns nothing
function startCurve(fanR, src) {
  const v = src && src.v != null ? src.v : cToU(50, src), t = Math.round(v), rpm = fanR && fanR.v > 0 ? fanR.v : 0;
  if (rpm > 0) return [[t - 15, Math.round(rpm * 0.7)], [t, Math.round(rpm)], [t + 20, Math.round(rpm * 1.6)]];
  const t0 = Math.ceil(v) + 10;   // a stopped fan (zero rpm mode): its curve starts 10 degrees above what it sees now
  return [[t0, 0], [t0 + 10, 900], [t0 + 25, 1500]];
}

// ---------- drag and drop (edit mode, any view): pointer events, one path for mouse, pen and touch ----------
let drag = null, justDragged = false;
function startDrag(ev, kind, data, label, val) { drag = { kind, data, x0: ev.clientX, y0: ev.clientY, started: false, label, val, target: null }; }
function beginDrag() {
  drag.started = true;
  const gh = document.createElement('div'); gh.className = 'ghost';
  gh.innerHTML = '<span>' + esc(drag.label) + '</span>' + (drag.val ? '<span class="val">' + esc(drag.val) + '</span>' : '');
  document.body.appendChild(gh); drag.ghost = gh;
  if (drag.kind === 'cell') { const el = document.querySelector('#view .dc[data-cid="' + drag.data + '"]'); if (el) el.classList.add('dragging'); }
  if (drag.kind === 'cat') for (const el of document.querySelectorAll('#view .dcat[data-cat="' + drag.data + '"]')) el.style.opacity = '0.4';
  requestAnimationFrame(autoScroll);
}
function moveDrag(ev) {
  if (!drag) return;
  if (!drag.started) { if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 5) return; beginDrag(); }
  drag.ghost.style.left = ev.clientX + 'px'; drag.ghost.style.top = ev.clientY + 'px';
  drag.px = ev.clientX; drag.py = ev.clientY;
  hitTest(ev.clientX, ev.clientY);
}
function vrect(el) { const r = el.getBoundingClientRect(), v = sectionsEl.getBoundingClientRect(); return { x: r.left - v.left + sectionsEl.scrollLeft, y: r.top - v.top + sectionsEl.scrollTop, w: r.width, h: r.height }; }
function showMark(x, y, w, h) { Object.assign(dropmark.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); }
function hitTest(x, y) {
  drag.target = null; dropmark.style.display = 'none';
  const nc = $('newcat'); nc.classList.remove('over');
  const vr = sectionsEl.getBoundingClientRect();
  if (x < vr.left || x > vr.right || y < vr.top || y > vr.bottom) return;
  const cats = [...document.querySelectorAll('#view .dcat')];
  if (drag.kind === 'cat') {
    // Grid can be two tables side by side: only the one under the pointer counts
    let list = cats;
    if (S.screen === 'grid') {
      const tables = [...document.querySelectorAll('#view .gtable')];
      const tb = tables.find(t => { const r = t.getBoundingClientRect(); return x >= r.left && x <= r.right; }) || tables[tables.length - 1];
      if (tb) list = [...tb.querySelectorAll('.dcat')];
    }
    let idx = null;
    for (const el of list) { const r = el.getBoundingClientRect(); if (y < r.top + Math.min(r.height / 2, 40) && (S.screen === 'grid' || x < r.right + 20)) { idx = cats.indexOf(el); break; } }
    if (idx === null) idx = list.length ? cats.indexOf(list[list.length - 1]) + 1 : cats.length;
    drag.target = { index: idx };
    const before = idx < cats.length && list.includes(cats[idx]), ref = before ? cats[idx] : list[list.length - 1] || cats[cats.length - 1];
    if (ref) { const rr = vrect(ref); showMark(rr.x, before ? rr.y - 7 : rr.y + rr.h + 4, rr.w, 3); }
    return;
  }
  const under = document.elementFromPoint(x, y);
  if (!under) return;
  if (under.closest('#newcat')) { nc.classList.add('over'); drag.target = { newcat: true }; return; }
  let catEl = under.closest('#view .dcat');
  if (!catEl) {   // in a gap: the nearest category above the pointer in the same column
    let best = null, bd = Infinity;
    for (const c of cats) { const r = c.getBoundingClientRect(); if (r.top > y) continue; const d = Math.abs(x - Math.max(r.left, Math.min(x, r.right))) * 3 + (y - r.bottom > 0 ? y - r.bottom : 0); if (d < bd) { bd = d; best = c; } }
    catEl = best; if (!catEl) return;
  }
  const catId = catEl.dataset.cat, cat = S.L.cats.find(c => c.id === catId);
  if (!cat) return;
  const order = cat.cells.filter(id => S.L.cells[id] && !(drag.kind === 'cell' && id === drag.data));
  if (catEl.classList.contains('collapsed') || under.closest('.dch, .ghdr')) {
    // on the header: first, where the mark is; on a folded category: last
    drag.target = { cat: catId, index: catEl.classList.contains('collapsed') ? order.length : 0 };
    const rr = vrect(catEl.querySelector('.dch, .ghdr')); showMark(rr.x, rr.y + rr.h, rr.w, 3); return;
  }
  const cells = [...catEl.querySelectorAll('.dc')].filter(el => !(drag.kind === 'cell' && el.dataset.cid === drag.data));
  if (!cells.length) {
    drag.target = { cat: catId, index: 0 };
    const g = catEl.querySelector('.dgrid') || catEl.querySelector('.ghdr'); const rr = vrect(g);
    showMark(rr.x + 2, rr.y + rr.h - 3, Math.max(rr.w - 4, 40), 3); return;
  }
  // the nearest cell, then before or after it: by side in a grid of tiles, by half in a list (Overview, Grid)
  const vertical = S.screen !== 'tiles';
  let best = null, bd = Infinity;
  for (const el of cells) {
    const r = el.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy * 4; if (d < bd) { bd = d; best = { el, r }; }
  }
  const after = vertical ? y > best.r.top + best.r.height / 2 : x > best.r.left + best.r.width / 2;
  drag.target = { cat: catId, index: order.indexOf(best.el.dataset.cid) + (after ? 1 : 0) };
  const rr = vrect(best.el.tagName === 'TR' ? best.el.children[0] : best.el);
  if (vertical) { const w = best.el.tagName === 'TR' ? vrect(best.el.closest('table')).w : rr.w; showMark(rr.x, after ? rr.y + rr.h - 1 : rr.y - 2, w, 3); }
  else showMark(after ? rr.x + rr.w + 3 : rr.x - 6, rr.y, 3, rr.h);
}
function endDrag(cancel) {
  if (!drag) return;
  const d = drag; drag = null;
  dropmark.style.display = 'none';
  if (d.ghost) d.ghost.remove();
  $('newcat').classList.remove('over');
  for (const el of document.querySelectorAll('#view .dragging')) el.classList.remove('dragging');
  for (const el of document.querySelectorAll('#view .dcat')) el.style.opacity = '';
  if (!d.started || cancel) return;
  justDragged = true; setTimeout(() => { justDragged = false; }, 0);
  const t = d.target; if (!t) return;
  if (d.kind === 'cell' && !catOf(d.data)) return;   // removed while it was dragged
  if (d.kind === 'cat' && !S.L.cats.some(c => c.id === d.data)) return;
  if (d.kind === 'cat') {
    mutate(() => { const i = S.L.cats.findIndex(c => c.id === d.data); const [c] = S.L.cats.splice(i, 1); S.L.cats.splice(t.index > i ? t.index - 1 : t.index, 0, c); });
  } else if (d.kind === 'row') {
    const r = BYKEY.get(d.data);
    if (t.newcat) addKeys([d.data], null, null, r ? SENS[r.s].short : null); else addKeys([d.data], t.cat, t.index);
  } else if (d.kind === 'cell') {
    mutate(() => {
      const from = catOf(d.data); from.cells.splice(from.cells.indexOf(d.data), 1);
      let to = t.newcat ? null : S.L.cats.find(c => c.id === t.cat);
      if (!to) { to = { id: nid('c'), name: 'New category', collapsed: false, cells: [] }; S.L.cats.push(to); }
      // the index counts only live cells; map it onto the stored list
      const live = to.cells.filter(id => S.L.cells[id]), before = live[t.index];
      to.cells.splice(before ? to.cells.indexOf(before) : to.cells.length, 0, d.data);
      sel = d.data;
    });
  }
}
function autoScroll() {
  if (!drag || !drag.started) return;
  const vr = sectionsEl.getBoundingClientRect(), y = drag.py;
  if (y != null && drag.px >= vr.left && drag.px <= vr.right && (y < vr.top + 40 || y > vr.bottom - 40)) { sectionsEl.scrollTop += y < vr.top + 40 ? -12 : 12; hitTest(drag.px, drag.py); }
  requestAnimationFrame(autoScroll);
}

// ---------- events: the view ----------
function setEdit(on) {
  S.edit = on; app.classList.toggle('editing', on);
  $('editBtn').classList.toggle('on', on);
  if (!on) { sel = null; endRelink(true); app.classList.remove('has-sel'); }
  hidePrev(); saveState();
  renderView(false); renderStorage(); renderInsp(); placeTabInd(true);
}
$('editBtn').onclick = () => setEdit(!S.edit);
$('undo').onclick = undo; $('redo').onclick = redo;
$('toastUndo').onclick = () => { if (toastDepth >= 0 && undoStack.length === toastDepth) undo(); $('toast').classList.remove('show'); retireToastUndo(); };
sectionsEl.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 || ev.target.closest('button,input') || (host && zoneAt(ev))) return;   // the window edge: a resize
  hidePrev();
  if (!S.edit) return;
  const g = ev.target.closest('.dch .grip');
  if (g) { const cat = g.closest('.dcat').dataset.cat; startDrag(ev, 'cat', cat, S.L.cats.find(c => c.id === cat).name); ev.preventDefault(); return; }
  const cell = ev.target.closest('#view .dc');
  if (cell) {
    const c = S.L.cells[cell.dataset.cid], r = c.key && BYKEY.get(c.key);
    startDrag(ev, 'cell', cell.dataset.cid, cellName(c), r ? valTxt(r) : '');
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#insp')) document.activeElement.blur();
    ev.preventDefault(); cell.focus({ preventScroll: true });   // no text selection painted across the view while dragging
  }
});
sectionsEl.addEventListener('click', ev => {
  if (justDragged) return;
  if (ev.target.closest('#setupRestart')) { send({ t: 'restartHwinfo' }); return; }
  const catEl = ev.target.closest('.dcat');
  if (ev.target.closest('#newcat')) { mutate(() => S.L.cats.push({ id: nid('c'), name: 'New category', collapsed: false, cells: [] })); const all = document.querySelectorAll('#view .dcat'); renameCat(all[all.length - 1]); return; }
  if (ev.target.closest('.chev') && catEl) { const c = S.L.cats.find(x => x.id === catEl.dataset.cat); c.collapsed = !c.collapsed; saveState(); syncSaves(); renderView(false); return; }
  if (ev.target.closest('.ren') && catEl) { renameCat(catEl); return; }
  if (ev.target.closest('.del') && catEl) {
    const c = S.L.cats.find(x => x.id === catEl.dataset.cat);
    mutate(() => { for (const id of c.cells) delete S.L.cells[id]; S.L.cats = S.L.cats.filter(x => x !== c); fixSel(); }, 'Removed "' + c.name + '"');
    return;
  }
  if (ev.target.closest('.rl')) { startRelink(ev.target.closest('.dc').dataset.cid); return; }
  const cell = ev.target.closest('#view .dc');
  if (!S.edit) { if (cell) openDetail(cell.dataset.cid); return; }
  if (cell) { selectCell(cell.dataset.cid); return; }
  if (sel && !ev.target.closest('.dch')) { sel = null; for (const el of document.querySelectorAll('#view .dc.sel')) el.classList.remove('sel'); renderInsp(); }
});
function selectCell(cid) { sel = cid; for (const el of document.querySelectorAll('#view .dc.sel')) el.classList.remove('sel'); const el = document.querySelector('#view .dc[data-cid="' + cid + '"]'); if (el) el.classList.add('sel'); renderInsp(); }
sectionsEl.addEventListener('dblclick', ev => {
  const cn = ev.target.closest('.cn');
  if (cn && S.edit) { renameCat(cn.closest('.dcat')); return; }
  const cell = ev.target.closest('#view .dc');
  if (cell && S.edit) openDetail(cell.dataset.cid);
});
function renameCat(catEl) {
  if (!catEl || !S.edit) return;
  const c = S.L.cats.find(x => x.id === catEl.dataset.cat), cn = catEl.querySelector('.cn');
  if (!c || !cn) return;
  const inp = document.createElement('input'); inp.className = 'cn-in'; inp.value = c.name; inp.setAttribute('aria-label', 'Category name');
  cn.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  // quiet: the view is being rebuilt anyway (a catalog arrived mid-rename), so no render of its own
  const commit = (keep, quiet) => {
    if (done) return; done = true;
    const v = inp.value.trim().slice(0, 200);
    if (keep && v && v !== c.name) { if (quiet) { snap(); c.name = v; saveState(); syncUndo(); syncSaves(); } else mutate(() => { c.name = v; }); }
    else if (!quiet) renderView(false);
  };
  inp._commit = commit;
  inp.onkeydown = e => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); commit(true); onSave(); return; }
    if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false);
  };
  inp.onblur = () => commit(true);
}
document.addEventListener('pointermove', moveDrag);
document.addEventListener('pointerup', () => endDrag(false));
document.addEventListener('pointercancel', () => endDrag(true));
// the spotlight under the pointer
let spotEl = null, spotX = 0, spotY = 0, spotRaf = 0;
sectionsEl.addEventListener('pointermove', e => {
  spotEl = e.target.closest('.tile, .card, .gtable'); spotX = e.clientX; spotY = e.clientY;
  if (!spotRaf) spotRaf = requestAnimationFrame(() => { spotRaf = 0; if (!spotEl) return; const b = spotEl.getBoundingClientRect(); spotEl.style.setProperty('--mx', Math.round(spotX - b.left) + 'px'); spotEl.style.setProperty('--my', Math.round(spotY - b.top) + 'px'); });
});
let scrollT = 0;
sectionsEl.addEventListener('scroll', () => { hidePrev(); if (!scrollT) scrollT = requestAnimationFrame(() => { scrollT = 0; if (!drag || !drag.started) updateView(false); }); });

// ---------- events: Storage ----------
$('vlist').addEventListener('scroll', () => requestAnimationFrame(drawRows));
$('q').addEventListener('input', e => { query = e.target.value; $('vlist').scrollTop = 0; renderStorage(); });
$('chips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; typeFilter = b.dataset.t; $('vlist').scrollTop = 0; renderStorage(); });
$('hideIn').addEventListener('click', () => { hideIn = !hideIn; $('hideIn').classList.toggle('on', hideIn); $('hideIn').setAttribute('aria-pressed', hideIn); renderStorage(); });
$('vspace').addEventListener('click', e => {
  if (e.target.closest('#qClear')) { query = ''; $('q').value = ''; typeFilter = 'all'; renderStorage(); return; }
  const g = e.target.closest('.vrow.g');
  if (g) {
    const s = Number(g.dataset.gs), sk = SENS[s].key;
    if (e.target.closest('.addall')) {
      const toks = query.toLowerCase().split(/\s+/).filter(Boolean), iv = inView();
      const keys = READ.filter(r => r.s === s && passes(r, toks, iv) && !iv.has(r.key)).map(r => r.key);
      if (!keys.length) { toast('Everything there is already in view'); return; }
      addKeys(keys, null, null, SENS[s].short + (typeFilter !== 'all' ? ' ' + TYPE_NAME[typeFilter].toLowerCase() : ''));
      return;
    }
    if (collapsedGroups.has(sk)) collapsedGroups.delete(sk); else collapsedGroups.add(sk);
    renderStorage(); return;
  }
  const row = e.target.closest('.vrow.r'); if (!row) return;
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'add') { const t = targetForAdd(), r = BYKEY.get(row.dataset.key); addKeys([row.dataset.key], t.cat, t.index, r ? SENS[r.s].short : null); }
  if (act && act.dataset.act === 'link' && relinkFor) {
    const cid = relinkFor, r = BYKEY.get(row.dataset.key);
    if (!S.L.cells[cid] || !r) { endRelink(); renderView(false); return; }   // the cell went while picking
    mutate(() => { S.L.cells[cid].key = r.key; S.L.cells[cid].match = matchOf(r); S.L.cells[cid].u = r.unit; }, 'Re-linked');
    endRelink(); sel = cid; renderView(false); renderInsp();
  }
});
$('vspace').addEventListener('pointerdown', e => {
  if (!S.edit || e.button !== 0 || e.target.closest('button') || relinkFor || (host && zoneAt(e))) return;
  const row = e.target.closest('.vrow.r'); if (!row) return;
  const r = BYKEY.get(row.dataset.key); if (!r) return;
  startDrag(e, 'row', r.key, r.label, valTxt(r)); e.preventDefault();
});
$('addPred').onclick = () => {
  const t = targetForAdd(), src = guessTemp(null);
  mutate(() => {
    let cat = t.cat && S.L.cats.find(c => c.id === t.cat);
    if (!cat) { cat = { id: nid('c'), name: 'Fans', collapsed: false, cells: [] }; S.L.cats.push(cat); }
    const id = nid('a');
    S.L.cells[id] = { pred: true, name: 'Predicted fan', graph: true, curve: { src: src ? src.key : '', pts: [[30, 500], [50, 800], [70, 1300], [85, 1800]].map(p => [cToU(p[0], src), p[1]]), tol: 15, hold: 10 } };
    cat.cells.splice(t.index == null ? cat.cells.length : t.index, 0, id); sel = id;
  });
};
function startRelink(cid) {
  if (!S.edit) setEdit(true);
  relinkFor = cid; sel = cid; const c = S.L.cells[cid];
  const lbl = c.match ? c.match.split('|')[1] : '';
  $('relinkBar').hidden = false; $('relinkTxt').textContent = 'Pick the reading for "' + (c.name || lbl || 'this cell') + '"';
  // the search starts with the label; if this PC calls it something else, the list says so and offers everything
  query = lbl; $('q').value = lbl; typeFilter = 'all'; renderStorage(); renderView(false); renderInsp();
}
function endRelink(quiet) { if (!relinkFor && quiet) return; relinkFor = null; $('relinkBar').hidden = true; query = ''; $('q').value = ''; if (!quiet) renderStorage(); }
$('relinkCancel').onclick = () => { endRelink(); renderView(false); };

// ---------- cell settings ----------
function renderInsp() {
  const box = $('insp');
  const c = sel && S.L.cells[sel];
  app.classList.toggle('has-sel', !!c);
  if (!S.edit) return;
  if (!c) {
    const cells = Object.values(S.L.cells);
    const nb = (n, one, many) => '<b>' + n + '</b> ' + (n === 1 ? one : many);
    if (!READ.length) { box.innerHTML = '<div class="none"><span>Nothing to pick from yet: HWiNFO isn\'t sharing its sensors. The steps are in the middle.</span></div>'; return; }
    box.innerHTML = '<div class="none"><span>Select a cell to set its name, decimals, lines and fan curve. Double-click one for its graphs (outside edit mode, one click).</span>' +
      '<span>' + nb(S.L.cats.length, 'category', 'categories') + ', ' + nb(cells.length, 'cell', 'cells') + ', ' + nb(cells.filter(x => gatesOn(x.gates)).length, 'with lines', 'with lines') + ', ' + nb(cells.filter(x => x.curve).length, 'on a fan curve', 'on a fan curve') + '.</span>' +
      '<span>Tip: pick a type in Storage (Temp, Fan...), then <b>+ all</b> on a sensor to add all of those readings as one category.</span></div>';
    return;
  }
  const r = c.key ? BYKEY.get(c.key) : null, sen = r ? SENS[r.s] : null;
  const g = c.gates || { mode: 'none', dir: 'above', y: NaN, r: NaN, hold: 3 };
  const unit = c.pred ? 'RPM' : unitOf(r);
  const num = x => (x == null || !isFinite(x)) ? '' : x;
  let h = '<div class="src">' + (c.pred ? '<span>Predicted fan: no sensor, its rpm comes from the curve below.</span>'
    : r ? '<span>' + esc(sen.name) + '</span><span style="color:var(--fg)" title="' + esc(r.key) + '">' + esc(r.label) + '</span>'
    : '<span style="color:#e08a8d">' + (sensorHere(c) ? 'HWiNFO isn\'t sharing this reading right now' : 'Not on this PC' + (c.match ? ': ' + esc(c.match.replace('|', ', ')) : '')) + '</span><span class="k">' + esc(c.key) + '</span>') + '</div>';
  h += '<label class="fld"><span>Name</span><input id="iName" value="' + esc(c.name || '') + '" placeholder="' + esc(r ? r.label : c.pred ? 'Predicted fan' : '') + '"></label>';
  h += '<div class="two"><label class="fld"><span>Decimals</span><select id="iDec">' + [0, 1, 2, 3].map(d => '<option' + (decOfCell(c, r) === d ? ' selected' : '') + '>' + d + '</option>').join('') + '</select></label>' +
       '<label class="fld"><span>Graph</span><select id="iGraph"><option value="1"' + (c.graph !== false ? ' selected' : '') + '>Show</option><option value="0"' + (c.graph === false ? ' selected' : '') + '>Hide</option></select></label></div>';
  if (!c.pred) {
    h += '<div class="fgrp"><span class="lab">Lines</span><div class="seg" id="iMode">' + [['none', 'None'], ['y', 'Yellow'], ['yr', 'Yellow + red']].map(([v, t]) => '<button data-v="' + v + '" class="' + (g.mode === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
    if (g.mode !== 'none') {
      h += '<div class="seg" id="iDir">' + [['above', 'Bad when above'], ['below', 'Bad when below']].map(([v, t]) => '<button data-v="' + v + '" class="' + (g.dir === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
      h += '<div class="two"><label class="fld gate-y"><span>Yellow ' + esc(unit) + '</span><input id="iY" type="number" step="any" value="' + num(g.y) + '"></label>' +
           (g.mode === 'yr' ? '<label class="fld gate-r"><span>Red ' + esc(unit) + '</span><input id="iR" type="number" step="any" value="' + num(g.r) + '"></label>' : '<span></span>') + '</div>';
      h += '<label class="fld"><span>Hold before it turns (s)</span><input id="iHold" type="number" min="0" step="1" value="' + num(g.hold) + '"></label>';
      h += '<div class="err" id="gErr"></div><div class="scale" id="gScale"></div>';
    } else if (r) {
      const pre = presetFor(r);
      h += '<span class="hint">No lines: the cell never turns yellow or red.' + (pre ? ' Suggestion: <button class="linkbtn" id="iPreset">' + esc(pre.txt) + '</button>' : '') + '</span>';
    }
    h += '</div>';
  }
  if (isFanCell(c)) {
    const cv = c.curve;
    h += '<div class="fgrp curve"><span class="lab">Fan curve</span>';
    if (!c.pred) h += '<label class="chk"><input type="checkbox" id="iCurveOn"' + (cv ? ' checked' : '') + '> Track this fan against a curve</label>';
    if (cv) {
      const temps = READ.filter(x => x.t === 'temp'), tu = tempUnit(BYKEY.get(cv.src));
      if (cv.src && !BYKEY.has(cv.src)) temps.unshift({ key: cv.src, label: 'missing reading', s: -1 });
      const optTxt = x => x.label + (SENS[x.s] ? ' (' + SENS[x.s].short + ')' : ''), cur = temps.find(x => x.key === cv.src);
      h += '<label class="fld"><span>Driven by</span><select id="iSrc" title="' + esc(cur ? optTxt(cur) : '') + '">' + temps.map(x => '<option value="' + esc(x.key) + '"' + (x.key === cv.src ? ' selected' : '') + '>' + esc(optTxt(x)) + '</option>').join('') + '</select></label>';
      h += '<div id="cChart"></div>';
      h += '<div class="ptab" id="cTab"><span class="h">Temp ' + tu + '</span><span class="h">RPM</span><span></span>' +
        cv.pts.map((p, i) => '<input type="number" step="any" data-i="' + i + '" data-j="0" value="' + p[0] + '"><input type="number" step="any" data-i="' + i + '" data-j="1" value="' + p[1] + '"><button class="ib" data-del="' + i + '" title="Remove point">' + ICONS.x + '</button>').join('') + '</div>';
      h += '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><button class="linkbtn" id="cAdd">+ Add point</button><button class="linkbtn" id="cPaste">Paste points</button></div>';
      h += '<div id="cPasteBox" hidden><label class="fld"><span>Points as temp:rpm, Enter to apply</span><input id="cPasteIn" placeholder="40:500, 55:800, 65:1200"></label></div>';
      if (!c.pred) h += '<div class="two"><label class="fld"><span>Tolerance &plusmn;%</span><input id="cTol" type="number" min="1" step="1" value="' + cv.tol + '"></label><label class="fld"><span>Hold (s)</span><input id="cHold" type="number" min="0" step="1" value="' + cv.hold + '"></label></div>';
      h += '<div class="cstat" id="cStat"></div>';
    }
    h += '</div>';
  }
  h += '<div class="fgrp"><div style="display:flex;gap:8px;flex-wrap:wrap">' + (isMissing(c) ? '<button class="btn" id="iRelink">Re-link</button>' : '') +
    '<button class="btn" id="iOpen">Open graphs</button><button class="btn warn" id="iRemove">Remove from view</button></div></div>';
  box.innerHTML = h;
  tickInsp();
}
// new lines start a little past where the value is now, on its bad side, at the cell's decimals (nothing without a value)
function seedLines(c, r, again) {
  const g = c.gates, v = r && r.v != null ? r.v : null;
  if (v == null || g.mode === 'none' || (isFanR(r) && v <= 0)) return;   // nothing to go on (a fan standing still): the fields stay empty
  const dec = decOfCell(c, r), step = Math.pow(10, -dec);
  const past = (x, k) => +(x + (g.dir === 'below' ? -1 : 1) * Math.max(Math.abs(x) * k, step)).toFixed(dec);
  if (again || !Number.isFinite(g.y)) g.y = past(v, g.dir === 'below' ? 0.2 : 0.15);
  if (g.mode === 'yr' && (again || !Number.isFinite(g.r))) g.r = past(g.y, g.dir === 'below' ? 0.3 : 0.12);
}
function presetFor(r) {
  const sn = SENS[r.s] ? SENS[r.s].name : '';
  if (r.t === 'temp') {
    const gpu = /GPU/i.test(sn + r.label), y = cToU(gpu ? 80 : 85, r), red = cToU(gpu ? 90 : 95, r);
    return { txt: 'yellow ' + y + ', red ' + red + ' (above)', g: { mode: 'yr', dir: 'above', y, r: red, hold: 3 } };
  }
  if (r.unit === 'FPS') return { txt: 'yellow 60, red 30 (below, while a game is in front)', g: { mode: 'yr', dir: 'below', y: 60, r: 30, hold: 2 } };
  if (r.unit === '%') return { txt: 'yellow 95 (above)', g: { mode: 'y', dir: 'above', y: 95, r: NaN, hold: 10 } };
  return null;
}
function tickInsp() {
  const c = sel && S.L.cells[sel]; if (!c || !S.edit) return;
  const e = evalCell(sel, c, true, true);
  const sc = $('gScale');
  if (sc && c.gates && c.gates.mode !== 'none') {
    const g = c.gates;
    $('gErr').textContent = !Number.isFinite(g.y) ? 'Set the yellow value.' : gatesBad(g) ? 'Red has to be ' + (g.dir === 'below' ? 'below' : 'above') + ' yellow.' : (g.mode === 'yr' && !Number.isFinite(g.r)) ? 'Set the red value.' : '';
    const s = c.key ? series(c.key, HLEN).filter(isFinite) : [];
    if (e.v != null) s.push(e.v);
    let mn = s.length ? Math.min(...s) : 0, mx = s.length ? Math.max(...s) : 1;
    for (const x of [g.y, g.mode === 'yr' ? g.r : NaN]) if (Number.isFinite(x)) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
    const pad = (mx - mn || 1) * 0.15; mn -= pad; mx += pad;
    const P = x => Math.max(0, Math.min(100, (x - mn) / (mx - mn) * 100));
    const py = Number.isFinite(g.y) ? P(g.y) : (g.dir === 'below' ? 0 : 100), pr = g.mode === 'yr' && Number.isFinite(g.r) ? P(g.r) : (g.dir === 'below' ? 0 : 100);
    const bar = g.dir !== 'below'
      ? '<i style="width:' + py + '%;background:#1f2a22"></i><i style="width:' + Math.max(0, pr - py) + '%;background:#4d4317"></i><i style="flex:1;background:#4a1e21"></i>'
      : '<i style="width:' + pr + '%;background:#4a1e21"></i><i style="width:' + Math.max(0, py - pr) + '%;background:#4d4317"></i><i style="flex:1;background:#1f2a22"></i>';
    const r = c.key ? BYKEY.get(c.key) : null, dec = decOfCell(c, r);
    sc.innerHTML = '<div class="bar">' + bar + '</div>' + (e.v != null ? '<span class="mk" style="left:' + P(e.v) + '%"></span><span class="tk" style="left:' + P(e.v) + '%;top:-12px;color:var(--fg)">now ' + fmt(e.v, dec) + '</span>' : '') +
      (Number.isFinite(g.y) ? '<span class="tk" style="left:' + py + '%">' + fmt(g.y, dec) + '</span>' : '') + (g.mode === 'yr' && Number.isFinite(g.r) ? '<span class="tk" style="left:' + pr + '%">' + fmt(g.r, dec) + '</span>' : '');
  }
  if ($('cChart') && c.curve) drawCurveSvg(c, e);
  const st = $('cStat');
  if (st && c.curve) {
    const src = BYKEY.get(c.curve.src);
    if (c.pred) { st.className = 'cstat'; st.textContent = !src ? 'Its temperature reading is not on this PC: pick another one above' : src.v != null ? 'At ' + fmt(src.v, 0) + ' ' + tempUnit(src) + ' the curve gives ' + fmt(e.v, 0) + ' rpm' : 'Its temperature reading has no value yet'; }
    else if (e.curve) {
      const off = Math.abs(e.curve.dev) > c.curve.tol;
      st.className = 'cstat' + (off ? ' y' : '');
      st.textContent = 'Now ' + fmt(e.v, 0) + ' rpm, the curve expects ' + fmt(e.curve.exp, 0) + ' at ' + fmt(e.curve.src.v, 0) + ' ' + tempUnit(e.curve.src) + ': ' + (off ? Math.abs(Math.round(e.curve.dev)) + '% ' + (e.curve.dev < 0 ? 'under' : 'over') : 'on curve');
    } else { st.className = 'cstat'; st.textContent = 'Waiting for values'; }
  }
}
let dragPt = null, curveWait = null;
// gridlines on round numbers: a step of 1, 2, 2.5 or 5 times a power of ten, about n of them
function niceAxis(max, n) {
  const raw = Math.max(max, 1) / n, pw = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pw).find(x => x >= raw);
  return { step, max: Math.ceil(max / step) * step };
}
const kLabel = v => v >= 1000 ? (v / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'k' : String(v);
function curveRange(src) { return isF(src && src.unit) ? { min: 32, max: 212, step: 36 } : { min: 0, max: 100, step: 20 }; }
function drawCurveSvg(c, e) {
  const box = $('cChart'); const W = 270, H = 160, l = 34, rr = 8, t = 8, b = 22;
  const pts = c.curve.pts.slice().sort((a, b) => a[0] - b[0]);
  const src0 = BYKEY.get(c.curve.src), fh = isF(src0 && src0.unit), xmin = fh ? 68 : 20, xmax = fh ? 212 : 100, xstep = fh ? 36 : 20;
  const ax = niceAxis(Math.max(500, Math.max(...pts.map(p => p[1]), e.v || 0) * 1.15), 4), ymax = ax.max;
  const X = v => l + (Math.max(xmin, Math.min(xmax, v)) - xmin) / (xmax - xmin) * (W - l - rr), Y = v => t + (1 - v / ymax) * (H - t - b);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" id="cSvg">';
  for (let x = xmin; x <= xmax; x += xstep) s += '<line x1="' + X(x) + '" x2="' + X(x) + '" y1="' + t + '" y2="' + (H - b) + '" stroke="#202020"/><text x="' + X(x) + '" y="' + (H - 7) + '" fill="#6a6a6a" font-size="9" text-anchor="middle">' + x + '\u00b0</text>';
  for (let v = 0; v <= ymax + 1e-9; v += ax.step) s += '<line x1="' + l + '" x2="' + (W - rr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="#202020"/><text x="' + (l - 4) + '" y="' + (Y(v) + 3) + '" fill="#6a6a6a" font-size="9" text-anchor="end">' + kLabel(v) + '</text>';
  if (!c.pred) { const tl = c.curve.tol / 100; s += '<path d="' + pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]) + ' ' + Y(p[1] * (1 + tl))).join(' ') + ' ' + pts.slice().reverse().map(p => 'L' + X(p[0]) + ' ' + Y(p[1] * (1 - tl))).join(' ') + 'Z" fill="rgba(127,166,232,0.10)" stroke="none"/>'; }
  s += '<polyline points="' + pts.map(p => X(p[0]) + ',' + Y(p[1])).join(' ') + '" fill="none" stroke="#7fa6e8" stroke-width="1.6"/>';
  const src = BYKEY.get(c.curve.src);
  // where the fan is now goes under the points, so a point on top of it can still be dragged
  if (src && src.v != null && e.v != null) {
    const off = e.curve && Math.abs(e.curve.dev) > c.curve.tol;
    s += '<g pointer-events="none"><line x1="' + X(src.v) + '" x2="' + X(src.v) + '" y1="' + t + '" y2="' + (H - b) + '" stroke="#3a3a3a" stroke-dasharray="2 3"/><circle cx="' + X(src.v) + '" cy="' + Y(e.v) + '" r="4.5" fill="' + (off ? '#e6c84a' : '#e0e0e0') + '" stroke="none"/></g>';
  }
  c.curve.pts.forEach((p, i) => { s += '<circle class="pt" data-i="' + i + '" cx="' + X(p[0]) + '" cy="' + Y(p[1]) + '" r="5" fill="#0f0f0f" stroke="#7fa6e8" stroke-width="1.6"/>'; });
  box.innerHTML = s + '</svg>';
  box._scale = { l, t, W, H, b, rr, xmin, xmax, ymax };
}
const insp = $('insp');
$('inspClose').onclick = () => { sel = null; for (const el of document.querySelectorAll('#view .dc.sel')) el.classList.remove('sel'); renderInsp(); };
function setCell(fn, withUndo) {
  const c = S.L.cells[sel]; if (!c) return;
  const before = withUndo ? snapOf() : null;
  fn(c);
  if (withUndo) { if (snapOf() === before) return; pushUndo(before); syncUndo(); }   // clicking what is already on changes nothing
  saveState(); syncSaves();
}
let editSnap = false;   // typing in a field takes one undo step, not one per key
insp.addEventListener('focusin', e => { if (e.target.matches('input')) editSnap = false; });
insp.addEventListener('input', e => {
  const c = S.L.cells[sel]; if (!c) return; const t = e.target;
  if (!editSnap && t.id !== 'cPasteIn') { snap(); syncUndo(); editSnap = true; }
  if (t.id === 'iName') {
    setCell(c => { c.name = t.value.trim() || undefined; });
    const el = document.querySelector('#view .dc[data-cid="' + sel + '"] .tn > span, #view .dc[data-cid="' + sel + '"] .nm > span, #view .dc[data-cid="' + sel + '"] .gname > span');
    if (el) el.textContent = cellName(c);
  }
  if (t.id === 'iY' || t.id === 'iR' || t.id === 'iHold') { setCell(c => { const k = t.id === 'iY' ? 'y' : t.id === 'iR' ? 'r' : 'hold'; c.gates[k] = t.value === '' ? NaN : k === 'hold' ? Math.min(1e9, Math.max(0, Number(t.value) || 0)) : Number(t.value); }); tickInsp(); updateView(false); }
  if (t.id === 'cTol' || t.id === 'cHold') { if (t.value === '') return; setCell(c => { c.curve[t.id === 'cTol' ? 'tol' : 'hold'] = Math.max(t.id === 'cTol' ? 1 : 0, Number(t.value) || 0); }); tickInsp(); updateView(false); }
  if (t.dataset && t.dataset.i != null && t.closest('#cTab') && t.value !== '') { setCell(c => { c.curve.pts[Number(t.dataset.i)][Number(t.dataset.j)] = Number(t.value); }); tickInsp(); updateView(false); }
});
insp.addEventListener('change', e => {
  const t = e.target, c = S.L.cells[sel]; if (!c) return;
  if (t.id === 'cTol' || t.id === 'cHold') t.value = c.curve[t.id === 'cTol' ? 'tol' : 'hold'];   // what it keeps, not what was typed
  if (t.id === 'iDec') { setCell(c => { c.dec = Number(t.value); }, true); updateView(false); t.blur(); }
  if (t.id === 'iGraph') { setCell(c => { c.graph = t.value === '1'; }, true); renderView(false); t.blur(); }
  if (t.id === 'iSrc') { setCell(c => { c.curve.src = t.value; }, true); subscribe(); renderInsp(); updateView(false); }
  if (t.id === 'iCurveOn') {
    setCell(c => {
      // off keeps the curve aside, so on brings it back
      if (t.checked) {
        if (c.curveOff) { c.curve = c.curveOff; delete c.curveOff; }
        else {
          const src = guessTemp(c.key), streamed = new Set(cellKeys());
          c.curve = { src: src ? src.key : '', pts: startCurve(BYKEY.get(c.key), src), tol: 15, hold: 10 };
          // a temperature that isn't a cell has no fresh value here: centred again once the host sends its seconds
          if (src && (src.v == null || !streamed.has(src.key))) curveWait = { cid: sel, src: src.key };
        }
      } else { c.curveOff = c.curve; delete c.curve; }
    }, true);
    subscribe(); renderInsp(); renderView(false);
  }
});
insp.addEventListener('keydown', e => {
  if (e.target.id !== 'cPasteIn' || e.key !== 'Enter') return;
  const items = e.target.value.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  const pts = items.map(s => s.split(/\s*[:=]\s*|\s+/)).filter(p => p.length === 2 && p[0] !== '' && p[1] !== '' && p.every(x => isFinite(Number(x)))).map(p => p.map(Number));
  if (pts.length >= 2) { setCell(c => { c.curve.pts = pts; }, true); renderInsp(); updateView(false); toast(plural(pts.length, 'point') + ' set' + (items.length > pts.length ? ', ' + (items.length - pts.length) + ' skipped (write them as temp:rpm)' : '')); }
  else toast('Write the points as temp:rpm, separated by commas');
});
insp.addEventListener('click', e => {
  const c = S.L.cells[sel]; if (!c) return;
  const m = e.target.closest('#iMode button'), d = e.target.closest('#iDir button');
  if (m && m.dataset.v !== (c.gates ? c.gates.mode : 'none')) {
    setCell(c => {
      const g = c.gates || (c.gates = { mode: 'none', dir: 'above', y: NaN, r: NaN, hold: 3 });
      g.mode = m.dataset.v;
      const r = BYKEY.get(c.key), pre = r && presetFor(r);
      if (!Number.isFinite(g.y) && pre) { g.dir = pre.g.dir; g.y = pre.g.y; g.hold = pre.g.hold; if (g.mode === 'yr') g.r = pre.g.r; }   // the suggestion shown under them
      else if (!Number.isFinite(g.y) && isFanR(r)) g.dir = 'below';   // a fan is in trouble when it slows down or stops
      if (g.mode === 'yr' && !Number.isFinite(g.r) && pre && pre.g.mode === 'yr' && g.y === pre.g.y) g.r = pre.g.r;
      seedLines(c, r, false);
    }, true);
    renderInsp(); updateView(false);
  }
  if (d) {
    setCell(c => {
      const g = c.gates; g.dir = d.dataset.v;
      // lines that are now on the wrong side (picked for "above" before the direction) move to the new side
      const r = BYKEY.get(c.key), v = r ? r.v : null;
      if (v != null && (gatesBad(g) || (Number.isFinite(g.y) && (g.dir === 'below' ? v <= g.y : v >= g.y)))) seedLines(c, r, true);
    }, true);
    renderInsp(); updateView(false);
  }
  if (e.target.closest('#iPreset')) { const p = presetFor(BYKEY.get(c.key)); setCell(c => { c.gates = Object.assign({}, p.g); }, true); renderInsp(); updateView(false); }
  if (e.target.closest('#iRemove')) removeCell(sel);
  if (e.target.closest('#iRelink')) startRelink(sel);
  if (e.target.closest('#iOpen')) openDetail(sel);
  if (e.target.closest('#cAdd')) {
    // a new point goes into the widest gap, or past the last one while there is room on the chart
    const pts = c.curve.pts.slice().sort((a, b) => a[0] - b[0]), top = curveRange(BYKEY.get(c.curve.src)).max;
    let at = -1, gap = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] > gap) { gap = pts[i][0] - pts[i - 1][0]; at = i; }
    const last = pts[pts.length - 1] || [60, 1000];
    if (last[0] + 5 <= top) setCell(c => { c.curve.pts = [...pts, [Math.min(top, last[0] + 10), Math.round(last[1] * 1.2)]]; }, true);
    else if (gap >= 2) setCell(c => { const a = pts[at - 1], b = pts[at]; c.curve.pts = [...pts.slice(0, at), [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2)], ...pts.slice(at)]; }, true);
    else toast('No room for another point');
    renderInsp();
  }
  if (e.target.closest('#cPaste')) { const b = $('cPasteBox'); b.hidden = !b.hidden; if (!b.hidden) $('cPasteIn').focus(); }
  const del = e.target.closest('[data-del]');
  if (del && c.curve.pts.length > 2) { setCell(c => { c.curve.pts.splice(Number(del.dataset.del), 1); }, true); renderInsp(); updateView(false); }
});
insp.addEventListener('pointerdown', e => { const pt = e.target.closest('.pt'); if (!pt) return; dragPt = { i: Number(pt.dataset.i), moved: false }; e.preventDefault(); });
document.addEventListener('pointermove', e => {
  if (!dragPt) return;
  const c = S.L.cells[sel], box = $('cChart'), svg = $('cSvg'); if (!c || !svg) return;
  if (!dragPt.moved) { dragPt.moved = true; snap(); syncUndo(); }   // a click on a point is no undo step
  const sc = box._scale, r = svg.getBoundingClientRect(), k = sc.W / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
  const tv = Math.round(sc.xmin + (x - sc.l) / (sc.W - sc.l - sc.rr) * (sc.xmax - sc.xmin));
  const rv = Math.round((1 - (y - sc.t) / (sc.H - sc.t - sc.b)) * sc.ymax / 10) * 10;
  c.curve.pts[dragPt.i] = [Math.max(sc.xmin, Math.min(sc.xmax, tv)), Math.max(0, rv)];
  tickInsp(); updateView(false);
  const ins = $('cTab').querySelectorAll('input[data-i="' + dragPt.i + '"]'); if (ins.length === 2) { ins[0].value = c.curve.pts[dragPt.i][0]; ins[1].value = c.curve.pts[dragPt.i][1]; }
});
document.addEventListener('pointerup', () => { if (dragPt) { const moved = dragPt.moved; dragPt = null; if (moved) { saveState(); syncSaves(); renderInsp(); } } });

// ---------- the cell popup: 15 min live, 1 h to 7 days from the host, HWiNFO's own min / max / average ----------
const modal = $('modal'), mrng = $('mrng'), mgraph = $('mgraph'), mgsec = $('mgraphsec');
let openedAt = 0, modalCid = null, bigRange = '15m', bigHist = null, histAsked = 0, bigMap = null, bigRev0 = 0, lastBig = null, modalGateInView = false;
function bigRev() { if (!bigRev0) return 1; const p = (performance.now() - bigRev0) / 700; return p >= 1 ? 1 : easeOut(Math.max(0, p)); }
function bigLoop() { requestAnimationFrame(() => { if (!modalCid || !lastBig) return; drawBigGraph.apply(null, lastBig); if (bigRev() < 1) bigLoop(); else bigRev0 = 0; }); }
function placeRng(still) {
  const b = mrng.querySelector('button[data-r="' + bigRange + '"]'), ri = mrng.querySelector('.ri');
  if (!b) return;
  ri.classList.toggle('still', !!still); ri.style.width = b.offsetWidth + 'px'; ri.style.transform = 'translateX(' + (b.offsetLeft - 2) + 'px)';
}
const histKey = c => c.pred ? c.curve.src : c.key;
function askHist() { const c = S.L.cells[modalCid]; if (!c) return; histAsked = Date.now(); send({ t: 'hist', key: histKey(c), range: bigRange }); }
function setRange(r, still) {
  bigRange = r;
  for (const b of mrng.querySelectorAll('button')) b.classList.toggle('on', b.dataset.r === r);
  placeRng(still);
  if (r !== '15m') askHist();
}
mrng.addEventListener('click', e => {
  const b = e.target.closest('button[data-r]');
  if (!b || b.dataset.r === bigRange) return;
  setRange(b.dataset.r, false);
  bigRev0 = motionOn() ? performance.now() : 0;
  if (modalCid) { refreshModal(); bigLoop(); }
});
const histReady = () => { const c = S.L.cells[modalCid]; return c && bigHist && bigHist.key === histKey(c) && bigHist.range === bigRange; };
function histOf(c) {   // the host's long history for this cell; a predicted fan's goes through its curve
  if (!c.pred) return bigHist;
  const f = a => a.map(x => x == null ? null : interp(c.curve.pts, x));
  return Object.assign({}, bigHist, { avg: f(bigHist.avg), max: f(bigHist.max) });
}
function openDetail(cid) {
  const c = S.L.cells[cid]; if (!c) return;
  hidePrev();
  modalCid = cid; modal.classList.add('open'); lastBig = null; openedAt = performance.now();
  const mv = $('mval'); if (mv._n) mv._n._ot = undefined;
  setRange('15m', true);
  refreshModal(true);
  bigRev0 = motionOn() ? performance.now() : 0; bigLoop();
}
function closeDetail() { modalCid = null; modal.classList.remove('open'); pauseSpin(document.querySelector('#micon svg')); }
function refreshModal(full) {
  const c = S.L.cells[modalCid]; if (!c) { closeDetail(); return; }
  const r = c.key ? BYKEY.get(c.key) : null, e = evalCell(modalCid, c, true, true), dec = decOfCell(c, r), unit = c.pred ? 'RPM' : unitOf(r);
  const mi = $('micon'), ic = iconOf(c, r);
  if (mi._h !== ic) { mi.innerHTML = ic; mi._h = ic; sweepSpins(); }
  if (isFanCell(c)) spinIcon(mi.querySelector('svg'), e.v);
  setText($('mtitle'), cellName(c));
  const mv = $('mval');
  mv.style.color = COLORS[e.col] || COLORS.white;
  if (!mv._n) { mv.innerHTML = '<span></span><span class="u"></span>'; mv._n = mv.firstChild; mv._u = mv.lastChild; }
  odo(mv._n, fmtV(e.v, dec, r)); setText(mv._u, e.v == null ? '' : ' ' + unit);
  const g = c.gates, det = gatesOn(g) ? { y: g.y, r: g.mode === 'yr' && Number.isFinite(g.r) ? g.r : undefined } : {};
  if (full) {
    let d = c.pred ? 'Predicted from ' + esc(BYKEY.get(c.curve.src) ? BYKEY.get(c.curve.src).label : 'a missing reading') + ' through its curve; there is no fan sensor.'
      : r ? '<span title="' + esc(r.key) + '">' + esc(SENS[r.s].name) + ', ' + esc(r.label) + '.</span>' : sensorHere(c) ? 'HWiNFO isn\'t sharing this reading right now.' : 'This reading is not on this PC.';
    if (gatesOn(g)) d += ' Lines: yellow ' + fmtL(g.y, dec) + (det.r !== undefined ? ', red ' + fmtL(g.r, dec) : '') + ' ' + esc(unit) + (g.dir === 'below' ? ' (bad when below)' : '') + (g.hold ? ', after ' + fmtL(g.hold, 1) + ' s' : '') + '.';
    if (c.curve && !c.pred) d += ' Follows a fan curve on ' + esc(BYKEY.get(c.curve.src) ? BYKEY.get(c.curve.src).label : 'a missing reading') + ', within ' + fmtL(c.curve.tol, 1) + '%.';
    $('mdesc').innerHTML = d;
  }
  const sp = bucketArr(c, isYN(r));
  if (full) {   // the yellow line joins the scale when it is close above the data; decided once per opening
    modalGateInView = false;
    const vals = sp.filter(x => x !== null);
    if (vals.length > 1 && det.y !== undefined) { const hi = Math.max(...vals), spn = Math.max(1.2, hi - Math.min(...vals)); modalGateInView = det.y > hi && det.y < hi + spn * 1.2; }
  }
  const gu = isYN(r) ? 'Yes/No' : unit;
  if (bigRange === '15m') lastBig = [mgraph, sp, det, dec, gu, modalGateInView, null, HLEN * 1000];
  else if (histReady()) { const H = histOf(c); lastBig = isYN(r) ? [mgraph, H.max, det, dec, gu, modalGateInView, null, H.span * 1000] : [mgraph, H.avg, det, dec, gu, modalGateInView, H.max, H.span * 1000]; }
  else lastBig = [mgraph, [], det, dec, gu, modalGateInView, null, 0];
  mgraph.classList.toggle('loading', bigRange !== '15m' && !histReady());
  drawBigGraph.apply(null, lastBig);
  const f = x => x == null || !isFinite(x) ? '--' : fmtV(x, dec, r);
  let st, long = false;
  // 15 min from the seconds themselves (a 1 s spike counts); the long ranges only have per-minute averages and peaks
  if (bigRange === '15m' || !histReady()) { const v = cellSeries(c, HLEN).filter(x => isFinite(x)); st = v.length ? { mn: Math.min(...v), av: v.reduce((a, b) => a + b, 0) / v.length, mx: Math.max(...v) } : {}; }
  else { long = true; const H = histOf(c), a = H.avg.filter(x => x !== null), m = H.max.filter(x => x !== null); st = a.length ? { mn: Math.min(...a), av: a.reduce((p, q) => p + q, 0) / a.length, mx: Math.max(...m) } : {}; }
  $('mstats').innerHTML = (isYN(r) ? '' : '<span' + (long ? ' title="The lowest ' + (bigRange === '7d' ? '10-minute' : '1-minute') + ' average"' : '') + '><em>' + (long ? 'lowest avg' : 'min') + '</em>' + f(st.mn) + '</span><span><em>avg</em>' + f(st.av) + '</span><span><em>max</em>' + f(st.mx) + '</span>') +
    (r && !c.pred && r.mx != null ? '<span title="HWiNFO\'s own, since it started or was reset"><em>HWiNFO min / avg / max</em>' + f(r.mn) + ' / ' + (isYN(r) ? Math.round(r.av) + '% yes' : f(r.av)) + ' / ' + f(r.mx) + '</span>' : '') +
    (e.sub ? '<span style="color:' + (e.lvl ? '#8f7c2e' : '#6a6a6a') + '">' + esc(e.sub) + '</span>' : '');
  const extra = $('mextra');
  if (c.curve) {
    if (full || !extra.querySelector('#mcurve')) extra.innerHTML = '<div class="msec">' + (c.pred ? 'its curve' : 'fan curve') + '</div><canvas id="mcurve"></canvas>';
    drawCurveChart(extra.querySelector('#mcurve'), c, e);
  } else if (full) extra.innerHTML = '';
}
modal.addEventListener('mousedown', e => { if (e.target === modal && performance.now() - openedAt > 450) closeDetail(); });
$('mclose').onclick = closeDetail;
function graphCtx(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}
function yCaption(ctx, dpr, text) { if (!text) return; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#555'; ctx.font = (10 * dpr) + 'px Segoe UI'; ctx.fillText(text, 4 * dpr, 1 * dpr); }
// the popup's big graph: the line and its area, the peaks as a faint line on the long ranges, the gate lines, time along the bottom
function drawBigGraph(cv, data, det, dec, unit, gateInView, maxData, spanMs, preview) {
  const { ctx, w, h, dpr } = graphCtx(cv);
  const vals = (data || []).filter(x => x !== null && x !== undefined), pvals = (maxData || []).filter(x => x !== null && x !== undefined);
  if (vals.length < 2) {
    if (!preview) bigMap = null;
    ctx.fillStyle = '#555'; ctx.font = (12 * dpr) + 'px Segoe UI'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.fillText(!preview && bigRange !== '15m' && !histReady() ? 'loading...' : 'no history here yet', 10 * dpr, 20 * dpr);
    return;
  }
  const padL = 58 * dpr, padR = 8 * dpr, padT = 10 * dpr, padB = 36 * dpr, yn = unit === 'Yes/No';
  let dLo = Math.min(...vals), dHi = Math.max(...vals, ...(pvals.length ? pvals : vals));
  if (yn) { dLo = 0; dHi = 1; }
  if (gateInView) { if (det.y !== undefined) dHi = Math.max(dHi, det.y); if (det.r !== undefined) dHi = Math.max(dHi, det.r); }
  const mag = Math.max(Math.abs(dLo), Math.abs(dHi), 1e-6), minSpan = Math.max(mag * 0.06, dec ? Math.pow(10, -dec) * 4 : 2);   // a flat 0 gets -1..1, not 8 decimals
  if (dHi - dLo < minSpan) { const mid = (dLo + dHi) / 2; dLo = mid - minSpan / 2; dHi = mid + minSpan / 2; }
  const pad = (dHi - dLo) * 0.12; dLo -= pad; dHi += pad;
  const rawStep = yn ? 1 : (dHi - dLo) / 3, pw = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = yn ? 1 : [1, 2, 5, 10].map(m => m * pw).find(s => s >= rawStep) || 10 * pw;
  const stepDec = step >= 1 ? 0 : Math.ceil(-Math.log10(step) - 1e-9);
  const lo = yn ? -0.25 : Math.floor(dLo / step) * step, hi = yn ? 1.25 : Math.ceil(dHi / step) * step;
  const X = i => padL + i / (data.length - 1) * (w - padL - padR), Y = v => h - padB - (v - lo) / (hi - lo) * (h - padT - padB);
  ctx.font = (11 * dpr) + 'px Segoe UI'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const nTicks = yn ? 1 : Math.round((hi - lo) / step);
  for (let i = 0; i <= nTicks; i++) {
    const v = yn ? i : lo + i * step, y = Y(v);
    ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = dpr; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.fillText(yn ? (v ? 'Yes' : 'No') : dec ? v.toFixed(Math.max(dec, stepDec)) : (step >= 1 ? Math.round(v).toLocaleString('en-US') : v.toFixed(stepDec)), padL - 6 * dpr, y);
  }
  const span = spanMs || HLEN * 1000;
  const tAt = f => { const d2 = new Date(Date.now() - span * (1 - f)); const hm = ('0' + d2.getHours()).slice(-2) + ':' + ('0' + d2.getMinutes()).slice(-2); return span >= 2 * 86400000 ? d2.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + hm : hm; };
  ctx.textBaseline = 'top'; ctx.fillStyle = '#666';
  ctx.textAlign = 'left'; ctx.fillText(tAt(0), padL + 3 * dpr, h - padB + 8 * dpr);
  ctx.textAlign = 'center'; ctx.fillText(tAt(0.5), (padL + w - padR) / 2, h - padB + 8 * dpr);
  ctx.textAlign = 'right'; ctx.fillText('now', w - padR, h - padB + 8 * dpr);
  ctx.textAlign = 'center'; ctx.fillStyle = '#555';
  ctx.fillText(span >= 2 * 86400000 ? 'last 7 days' : span >= 3600000 ? 'last ' + Math.round(span / 3600000) + (span >= 5400000 ? ' hours' : ' hour') : 'last 15 minutes', (padL + w - padR) / 2, h - padB + 22 * dpr);
  yCaption(ctx, dpr, yn ? '' : unit || '');
  const yGy = det.y !== undefined ? Y(det.y) : null, rGy = det.r !== undefined ? Y(det.r) : null;
  const gateClose = yGy !== null && rGy !== null && Math.abs(yGy - rGy) < 15 * dpr;
  for (const g of [['y', '#e6c84a'], ['r', '#e5484d']]) {
    const gv = det[g[0]];
    if (gv === undefined || gv < lo || gv > hi) continue;
    const gy = Y(gv);
    ctx.strokeStyle = g[1]; ctx.globalAlpha = 0.55; ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    if (g[0] === 'y' && gateClose) continue;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = g[1]; ctx.globalAlpha = 0.85;
    ctx.fillText(dec ? (+gv).toFixed(dec) : String(gv), w - padR - 3 * dpr, gy - 2 * dpr); ctx.globalAlpha = 1;
  }
  const rv = preview ? preview.rev : bigRev();
  ctx.save();
  if (rv < 1) { ctx.beginPath(); ctx.rect(0, 0, padL + (w - padL - padR) * rv, h); ctx.clip(); }
  // runs of values; where nothing was measured the line stops (no straight line across a gap)
  const runs = arr => { const out = []; let cur = null; arr.forEach((v, i) => { if (v === null || v === undefined) { cur = null; return; } if (!cur) out.push(cur = []); cur.push(i); }); return out; };
  const path = (arr, rs) => { ctx.beginPath(); for (const run of rs) run.forEach((i, j) => j ? ctx.lineTo(X(i), Y(arr[i])) : ctx.moveTo(X(i), Y(arr[i]))); };
  if (maxData) { path(maxData, runs(maxData)); ctx.strokeStyle = 'rgba(201,201,201,0.30)'; ctx.lineWidth = 1.2 * dpr; ctx.lineJoin = 'round'; ctx.stroke(); }
  const rs = runs(data);
  path(data, rs); ctx.strokeStyle = '#c9c9c9'; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.stroke();
  if (!maxData) {
    ctx.beginPath();
    for (const run of rs) { run.forEach((i, j) => j ? ctx.lineTo(X(i), Y(data[i])) : ctx.moveTo(X(i), Y(data[i]))); ctx.lineTo(X(run[run.length - 1]), h - padB); ctx.lineTo(X(run[0]), h - padB); ctx.closePath(); }
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB); grad.addColorStop(0, 'rgba(201,201,201,0.16)'); grad.addColorStop(1, 'rgba(201,201,201,0)');
    ctx.fillStyle = grad; ctx.fill();
  }
  ctx.restore();
  if (preview) return;
  bigMap = { padL, padR, padT, padB, w, h, Y, n: data.length, data, maxData, span, dec, unit };
  if (HV.on) kickHover();
}
// a fan's curve in the popup: temperature 0-100 along the bottom, the live point on it
function drawCurveChart(cv, c, e) {
  const { ctx, w, h, dpr } = graphCtx(cv);
  const padL = 58 * dpr, padR = 10 * dpr, padT = 12 * dpr, padB = 38 * dpr;
  const pts = c.curve.pts.slice().sort((a, b) => a[0] - b[0]);
  const src = BYKEY.get(c.curve.src), cr = curveRange(src);
  const ax = niceAxis(Math.max(500, Math.max(...pts.map(p => p[1]), e.v || 0) * 1.12), 5), yMax = ax.max;
  const X = t => padL + (t - cr.min) / (cr.max - cr.min) * (w - padL - padR), Y = v => h - padB - v / yMax * (h - padT - padB);
  ctx.font = (11 * dpr) + 'px Segoe UI'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= yMax + 1e-9; v += ax.step) { const y = Y(v); ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = dpr; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillStyle = '#666'; ctx.fillText(v.toLocaleString('en-US'), padL - 6 * dpr, y); }
  ctx.textBaseline = 'top'; ctx.fillStyle = '#666';
  for (let t = cr.min; t <= cr.max; t += cr.step) { ctx.textAlign = t === cr.min ? 'left' : t === cr.max ? 'right' : 'center'; ctx.fillText(t, X(t) + (t === cr.min ? 3 * dpr : 0), h - padB + 8 * dpr); }
  ctx.textAlign = 'center'; ctx.fillStyle = '#555'; ctx.fillText((src ? src.label : 'temperature') + ' ' + tempUnit(src), (padL + w - padR) / 2, h - padB + 22 * dpr);
  yCaption(ctx, dpr, 'RPM');
  ctx.save(); ctx.beginPath(); ctx.rect(padL, padT - 6 * dpr, w - padL - padR, h - padT - padB + 6 * dpr); ctx.clip();
  if (!c.pred) {   // the tolerance band
    const tl = c.curve.tol / 100; ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1] * (1 + tl))) : ctx.moveTo(X(p[0]), Y(p[1] * (1 + tl))));
    pts.slice().reverse().forEach(p => ctx.lineTo(X(p[0]), Y(p[1] * (1 - tl)))); ctx.closePath(); ctx.fillStyle = 'rgba(201,201,201,0.06)'; ctx.fill();
  }
  ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
  ctx.strokeStyle = '#8f8f8f'; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = '#bdbdbd'; for (const p of pts) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 3 * dpr, 0, 7); ctx.fill(); }
  ctx.restore();
  if (src && src.v != null && e.v != null) {
    const t = Math.max(cr.min, Math.min(cr.max, src.v));
    ctx.strokeStyle = '#e8e8e8'; ctx.globalAlpha = 0.4; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(X(t), padT); ctx.lineTo(X(t), h - padB); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = e.offCurve ? COLORS.yellow : '#e8e8e8'; ctx.beginPath(); ctx.arc(X(t), Y(e.v), 4.5 * dpr, 0, 7); ctx.fill();
    const lbl = 'now: ' + src.v.toFixed(0) + ' ' + tempUnit(src) + ', ' + Math.round(e.v).toLocaleString('en-US') + ' RPM' + (e.curve ? ', curve ' + Math.round(e.curve.exp).toLocaleString('en-US') : '');
    ctx.fillStyle = '#cfcfcf'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(lbl, Math.max(X(t) - 8 * dpr, padL + ctx.measureText(lbl).width + 2 * dpr), padT);
  }
}
// the popup graph's hover: a guide line and a dot glide to the pointer along the line, with value and time beside it
const mhover = document.createElement('canvas'); mhover.id = 'mhover'; mgsec.appendChild(mhover);
const mtip = document.createElement('div'); mtip.id = 'mtip'; mgsec.appendChild(mtip);
const HV = { on: false, tx: 0, cx: null, a: 0, raf: 0 };
mgraph.addEventListener('mousemove', e => { HV.tx = e.clientX - mgraph.getBoundingClientRect().left; HV.on = true; kickHover(); });
mgraph.addEventListener('mouseleave', () => { HV.on = false; kickHover(); });
function kickHover() { if (!HV.raf) HV.raf = requestAnimationFrame(hoverStep); }
function valAt(arr, f) { const i = Math.floor(f), j = Math.min(arr.length - 1, i + 1), a = arr[i], b = arr[j]; if (a === null || a === undefined) return b === null || b === undefined ? null : b; if (b === null || b === undefined) return a; return a + (b - a) * (f - i); }
function hoverStep() {
  HV.raf = 0;
  const M = bigMap, dpr = window.devicePixelRatio || 1, W = mgraph.offsetWidth, Hh = mgraph.offsetHeight;
  mhover.style.left = mgraph.offsetLeft + 'px'; mhover.style.top = mgraph.offsetTop + 'px'; mhover.style.width = W + 'px'; mhover.style.height = Hh + 'px';
  if (mhover.width !== Math.round(W * dpr)) mhover.width = Math.round(W * dpr);
  if (mhover.height !== Math.round(Hh * dpr)) mhover.height = Math.round(Hh * dpr);
  const ctx = mhover.getContext('2d'); ctx.clearRect(0, 0, mhover.width, mhover.height);
  HV.a += ((HV.on && M ? 1 : 0) - HV.a) * 0.24;
  if (!M || (!HV.on && HV.a < 0.02)) { mtip.style.opacity = 0; HV.cx = HV.on ? HV.cx : null; return; }
  const plotL = M.padL / dpr, plotR = (M.w - M.padR) / dpr, tx = Math.max(plotL, Math.min(plotR, HV.tx));
  HV.cx = HV.cx === null ? tx : HV.cx + (tx - HV.cx) * 0.28;
  const f = (HV.cx - plotL) / Math.max(1, plotR - plotL) * (M.n - 1), v = valAt(M.data, f), X = HV.cx * dpr;
  ctx.globalAlpha = HV.a; ctx.strokeStyle = 'rgba(232,232,232,0.28)'; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath(); ctx.moveTo(X, M.padT); ctx.lineTo(X, M.h - M.padB); ctx.stroke(); ctx.setLineDash([]);
  let tipY = M.padT / dpr + 8;
  if (M.maxData) { const pv = valAt(M.maxData, f); if (pv !== null) { ctx.fillStyle = '#8a8a8a'; ctx.beginPath(); ctx.arc(X, M.Y(pv), 2.6 * dpr, 0, 7); ctx.fill(); } }
  if (v !== null) { const Y = M.Y(v); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.beginPath(); ctx.arc(X, Y, 8 * dpr, 0, 7); ctx.fill(); ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.arc(X, Y, 3.6 * dpr, 0, 7); ctx.fill(); tipY = Y / dpr; }
  ctx.globalAlpha = 1;
  const when = new Date(Date.now() - M.span * (1 - f / Math.max(1, M.n - 1)));
  const hm = ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2), day = M.span >= 2 * 86400000 ? when.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' : '';
  const fm = x => x === null ? '--' : M.unit === 'Yes/No' ? (x >= 0.5 ? 'Yes' : 'No') : (M.dec ? x.toFixed(M.dec) : Math.round(x).toLocaleString('en-US'));
  const peak = M.maxData ? valAt(M.maxData, f) : null;
  const html = '<b>' + fm(v) + '</b> ' + esc(M.unit === 'Yes/No' ? '' : M.unit || '') + (peak !== null && M.maxData ? '<em>peak ' + fm(peak) + '</em>' : '') + '<em>' + day + hm + '</em>';
  if (mtip._h !== html) { mtip.innerHTML = html; mtip._h = html; }
  const tw = mtip.offsetWidth, th = mtip.offsetHeight;
  let lx = mgraph.offsetLeft + HV.cx + 14; if (lx + tw > mgraph.offsetLeft + W) lx = mgraph.offsetLeft + HV.cx - tw - 14;
  const ly = mgraph.offsetTop + Math.max(0, Math.min(Hh - th, tipY - th - 10));
  mtip.style.transform = 'translate(' + lx.toFixed(1) + 'px,' + ly.toFixed(1) + 'px)'; mtip.style.opacity = HV.a > 0.5 ? 1 : 0;
  if (Math.abs(tx - HV.cx) > 0.3 || (HV.on ? HV.a < 0.99 : HV.a > 0.02)) kickHover();
}

// ---------- hover preview: rest the pointer on a cell (clean view) and its 15 min graph shows beside it ----------
const hprev = document.createElement('div');
hprev.id = 'hprev';
hprev.innerHTML = '<div class="ph"><span class="pi"></span><span class="pt"></span><span class="pv"></span></div><canvas></canvas><div class="ps"></div><div class="pc"></div>';
document.body.appendChild(hprev);
const HP = { cid: null, el: null, timer: 0, shown: false, rev0: 0, raf: 0 };
const anyModalOpen = () => [...document.querySelectorAll('.modal')].some(m => m.classList.contains('open'));
sectionsEl.addEventListener('pointerover', e => {
  const n = S.edit || drag ? null : e.target.closest('#view .dc');
  const cid = n && !n.classList.contains('missing') ? n.dataset.cid : null;
  if (cid === HP.cid) return;
  HP.cid = cid; HP.el = n; clearTimeout(HP.timer);
  if (!cid || anyModalOpen()) { hidePrev(); return; }
  if (HP.shown) showPrev(true);
  else HP.timer = setTimeout(() => { if (HP.cid === cid && !anyModalOpen()) showPrev(false); }, 330);
});
sectionsEl.addEventListener('pointerleave', () => { HP.cid = null; clearTimeout(HP.timer); hidePrev(); });
window.addEventListener('blur', () => { HP.cid = null; hidePrev(); });
function hidePrev() { HP.shown = false; hprev.classList.remove('on'); pauseSpin(hprev.querySelector('.pi svg')); }
function fillPrev() {
  const c = S.L.cells[HP.cid]; if (!c) return false;
  const r = c.key ? BYKEY.get(c.key) : null, e = evalCell(HP.cid, c, true, true), dec = decOfCell(c, r), f = x => x == null || !isFinite(x) ? '--' : fmt(x, dec);
  const pi = hprev.querySelector('.pi'), ic = iconOf(c, r);
  if (pi._h !== ic) { pi.innerHTML = ic; pi._h = ic; sweepSpins(); }
  if (isFanCell(c)) spinIcon(pi.querySelector('svg'), e.v);
  setText(hprev.querySelector('.pt'), cellName(c));
  const pv = hprev.querySelector('.pv'), vh = esc(fmtV(e.v, dec, r)) + '<small>' + esc(c.pred ? 'RPM' : unitOf(r)) + '</small>';
  if (pv._h !== vh) { pv.innerHTML = vh; pv._h = vh; }
  pv.style.color = COLORS[e.col] || COLORS.white;
  const v = cellSeries(c, HLEN).filter(x => isFinite(x));
  const sh = v.length && !isYN(r) ? '<span><em>min</em>' + f(Math.min(...v)) + '</span><span><em>avg</em>' + f(v.reduce((a, b) => a + b, 0) / v.length) + '</span><span><em>max</em>' + f(Math.max(...v)) + '</span>' : '';
  const ps = hprev.querySelector('.ps'); if (ps._h !== sh) { ps.innerHTML = sh; ps._h = sh; }
  setText(hprev.querySelector('.pc'), e.sub);
  return true;
}
function drawPrev() {
  const c = S.L.cells[HP.cid]; if (!c) { HP.rev0 = 0; return; }
  const r = c.key ? BYKEY.get(c.key) : null, g = c.gates, det = gatesOn(g) ? { y: g.y, r: g.mode === 'yr' && Number.isFinite(g.r) ? g.r : undefined } : {};
  const sp = bucketArr(c), vals = sp.filter(x => x !== null);
  let gate = false;
  if (vals.length > 1 && det.y !== undefined) { const hi = Math.max(...vals), spn = Math.max(1.2, hi - Math.min(...vals)); gate = det.y > hi && det.y < hi + spn * 1.2; }
  const p = HP.rev0 && motionOn() ? Math.min(1, (performance.now() - HP.rev0) / 450) : 1;
  drawBigGraph(hprev.querySelector('canvas'), sp, det, decOfCell(c, r), c.pred ? 'RPM' : isYN(r) ? 'Yes/No' : unitOf(r), gate, null, HLEN * 1000, { rev: easeOut(p) });
  if (p < 1) { if (!HP.raf) HP.raf = requestAnimationFrame(() => { HP.raf = 0; if (HP.shown) drawPrev(); }); } else HP.rev0 = 0;
}
function showPrev(glide) {
  if (!fillPrev() || !HP.el || !HP.el.isConnected) return;
  const r = HP.el.getBoundingClientRect(), W = 360, H = hprev.offsetHeight || 230, gap = 12;
  let x = r.right + gap; if (x + W > innerWidth - 8) x = r.left - W - gap; if (x < 8) x = Math.min(innerWidth - W - 8, Math.max(8, r.left));
  const y = Math.max(8, Math.min(innerHeight - H - 8, r.top + r.height / 2 - H / 2));
  const at = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  if (!glide || !HP.shown) { hprev.style.transition = 'none'; hprev.style.transform = at + ' translateY(6px) scale(0.97)'; void hprev.offsetWidth; hprev.style.transition = ''; }
  hprev.style.transform = at; hprev.classList.add('on'); HP.shown = true; HP.rev0 = performance.now(); drawPrev();
}

// ---------- confirmations, in their own small popup ----------
const cmodal = $('cmodal');
let confirmYes = null;
function askConfirm(title, desc, yes, onYes, calm) {
  setText($('ctitle'), title); setText($('cdesc'), desc); setText($('cyes'), yes); confirmYes = onYes;
  cmodal.classList.toggle('calm', !!calm);
  cmodal.classList.add('open'); (calm ? $('cyes') : $('cno')).focus();
}
function closeConfirm() { confirmYes = null; cmodal.classList.remove('open'); }
$('cno').onclick = closeConfirm;
$('cyes').onclick = () => { const f = confirmYes; closeConfirm(); if (f) f(); };
cmodal.addEventListener('mousedown', e => { if (e.target === cmodal) closeConfirm(); });
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => $(b.dataset.close).classList.remove('open');
for (const id of ['wmodal', 'gmodal', 'smodal', 'setmodal']) $(id).addEventListener('mousedown', e => { if (e.target === $(id)) $(id).classList.remove('open'); });

// ---------- saves ----------
const smodal = $('smodal');
let smenu = null;
function closeSmenu() { if (smenu) { smenu.remove(); smenu = null; } }
function renderSaves() {
  closeSmenu();
  const dirty = isDirty();
  $('slist').innerHTML = S.slots.map((s, i) => {
    const n = s && s.layout ? Object.keys(s.layout.cells || {}).length : 0, act = S.active === i;
    const nc = (s && s.layout.cats || []).length;
    const meta = !s ? 'empty' : plural(n, 'cell') + ', ' + plural(nc, 'category', 'categories') + (act ? (dirty ? ', <b>unsaved changes</b>' : ', loaded') : '');
    return '<div class="srow2' + (s ? '' : ' vacant') + (act ? ' active' : '') + '" data-slot="' + i + '"><span class="sn">' + (i + 1) + '</span>' +
      '<div style="min-width:0"><div class="st"' + (s ? ' title="Double-click to rename"' : '') + '>' + esc(s ? slotName(i) : 'Empty slot') + '</div>' + (s ? '<div class="sm">' + meta + '</div>' : '') + '</div>' +
      '<div class="sa">' + (s ? '<button class="btn" data-a="load"' + (act && !dirty ? ' disabled' : '') + '>Load</button>' : '') + '<button class="btn pri" data-a="save">Save' + (s ? '' : ' here') + '</button>' +
      '<button class="ib" data-a="more" title="More">' + ICONS.more + '</button></div></div>';
  }).join('');
}
$('savesBtn').onclick = () => { renderSaves(); smodal.classList.add('open'); };
$('slist').addEventListener('click', e => {
  const row = e.target.closest('.srow2'); if (!row) return;
  const i = Number(row.dataset.slot), a = e.target.closest('[data-a]');
  if (!a) return;
  if (a.dataset.a === 'load') {
    if (isDirty() || (S.active == null && S.L.cats.length)) askConfirm('Load ' + slotName(i) + '?', 'The view you have now has changes that are not in a slot. Loading replaces it (Undo can bring it back).', 'Load', () => loadSlot(i), true);
    else loadSlot(i);
  }
  if (a.dataset.a === 'save') {
    if (S.slots[i] && S.active !== i) askConfirm('Overwrite ' + slotName(i) + '?', 'The slot gets the view you have now; what it held is replaced.', 'Overwrite', () => saveTo(i));
    else saveTo(i);
  }
  if (a.dataset.a === 'more') {
    closeSmenu();
    const s = S.slots[i], m = document.createElement('div'); m.className = 'smenu';
    m.innerHTML = (s ? '<button data-m="rename">Rename</button><button data-m="export">Export to a file</button>' : '') + '<button data-m="import">Import from a file</button>' + (s ? '<button data-m="empty" class="warn">Empty this slot</button>' : '');
    const card = smodal.querySelector('.mcard'); card.appendChild(m); smenu = m;
    const ar = a.getBoundingClientRect(), cr = card.getBoundingClientRect();
    m.style.top = (ar.bottom - cr.top + card.scrollTop + 4) + 'px'; m.style.left = Math.max(8, ar.right - cr.left - m.offsetWidth) + 'px';
    m.onclick = ev => {
      const b = ev.target.closest('[data-m]'); if (!b) return; closeSmenu();
      if (b.dataset.m === 'rename') renameSlot(i);
      if (b.dataset.m === 'export') send({ t: 'export', name: slotName(i), data: S.slots[i] });
      if (b.dataset.m === 'import') send({ t: 'import', slot: i });
      if (b.dataset.m === 'empty') askConfirm('Empty ' + slotName(i) + '?', 'The slot forgets its layout. The view you have now stays.', 'Empty slot', () => { S.slots[i] = null; if (S.active === i) S.active = null; saveSlot(i); saveState(); syncSaves(); renderSaves(); });
    };
  }
});
$('slist').addEventListener('dblclick', e => { const row = e.target.closest('.srow2'); if (row && e.target.closest('.st') && S.slots[Number(row.dataset.slot)]) renameSlot(Number(row.dataset.slot)); });
smodal.addEventListener('mousedown', e => { if (smenu && !smenu.contains(e.target) && !e.target.closest('[data-a="more"]')) closeSmenu(); });
function renameSlot(i) {
  const st = $('slist').querySelector('.srow2[data-slot="' + i + '"] .st'); if (!st) return;
  const inp = document.createElement('input'); inp.value = slotName(i); inp.setAttribute('aria-label', 'Slot name');
  st.innerHTML = ''; st.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const fin = keep => { if (done) return; done = true; if (keep && inp.value.trim()) { S.slots[i].name = inp.value.trim(); saveSlot(i); } syncSaves(); renderSaves(); };
  inp.onkeydown = ev => {
    ev.stopPropagation();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); fin(true); onSave(); return; }
    if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false);
  };
  inp.onblur = () => fin(true);
}
function loadSlot(i) {
  snap();
  S.L = JSON.parse(JSON.stringify(S.slots[i] ? S.slots[i].layout : emptyLayout()));
  S.active = i; sel = null; endRelink(true);
  const n = relinkByName();
  smodal.classList.remove('open');   // you load a slot to look at it
  enterNext = true; afterChange();
  toast('Loaded ' + slotName(i) + (n ? ', ' + plural(n, 'cell') + ' re-linked by sensor name' : ''), true);
}
function saveTo(i) {
  const name = S.slots[i] ? S.slots[i].name : 'Slot ' + (i + 1);
  S.slots[i] = { v: 1, name, layout: JSON.parse(JSON.stringify(S.L)) };
  S.active = i; saveSlot(i); saveState(); syncSaves(); toast('Saved to ' + slotName(i));
}
function onSave() {
  if (S.active != null) { saveTo(S.active); return; }
  const free = S.slots.findIndex(s => !s);
  if (free >= 0) saveTo(free); else { renderSaves(); smodal.classList.add('open'); }
}
$('clearBtn').onclick = () => askConfirm('Clear the view?', 'Back to the first run: no cells. Your slots stay as they are, and Undo brings the view back.', 'Clear view', () => {
  snap(); S.L = emptyLayout(); S.active = null; sel = null; endRelink(true);
  smodal.classList.remove('open'); afterChange(); toast('View cleared', true);
});

// ---------- the warning log: merged episodes from alerts.log, last 7 days ----------
const wmodal = $('wmodal');
let lastLogCount = 0;
$('logBtn').onclick = () => { wmodal.classList.add('open'); $('wlist').innerHTML = '<div class="wempty">loading...</div>'; if (host) send({ t: 'alerts' }); else renderWarnings(''); };
$('wclear').onclick = () => askConfirm('Clear warning history?', 'This wipes the warning log (' + lastLogCount + ' crossings in the last 7 days). A copy is kept as alerts.log.bak first, so it can be brought back.', 'Clear history', () => send({ t: 'alerts:clear' }));
function fmtDur(ms) { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's'; const m = Math.round(s / 60); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
function renderWarnings(log) {
  const open = {}, eps = [];
  for (const line of (log || '').split(/\r?\n/)) {
    // times carry their UTC offset (so a summer-time change doesn't make durations negative); older lines don't
    const m0 = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)([+-]\d\d:\d\d)?\s+(YELLOW|RED|OK|MARK)\s+(.+)$/);
    if (!m0) continue;
    const m = [m0[0], m0[1], m0[2], m0[4], m0[5]];
    const when = new Date(m[1] + 'T' + m[2] + (m0[3] || '')), rest = m[4].trim();
    // a MARK ends what was open: at its own time (app exit, HWiNFO stopped), or unknown (the next start after a crash)
    if (m[3] === 'MARK') { const known = !/^app start/.test(rest); for (const k in open) { open[k].end = known ? when : null; open[k].interrupted = true; open[k].cut = rest; delete open[k]; } continue; }
    if (m[3] === 'OK') {
      const name = rest.split(': back to normal')[0], ep = open[name];
      if (ep) { ep.end = when; const pk = rest.match(/peak ([^)]+)\)/); if (pk) ep.peak = pk[1]; delete open[name]; }
      continue;
    }
    const cut = rest.lastIndexOf(': '), name = cut > 0 ? rest.slice(0, cut) : rest, detail = cut > 0 ? rest.slice(cut + 2) : '';
    if (open[name]) { if (m[3] === 'RED') { open[name].level = 'RED'; open[name].redDetail = detail; } continue; }
    const ep = { when, day: m[1], time: m[2].slice(0, 5), level: m[3], name, detail, end: null, peak: null, interrupted: false };
    open[name] = ep; eps.push(ep);
  }
  const recent = eps.filter(ep => ep.when.getTime() >= Date.now() - 7 * 86400000);
  const groups = [], lastOf = {};
  for (const ep of recent) {
    const g = lastOf[ep.name], prevEnd = g ? (g.end || g.last.when) : null;
    if (g && g.day === ep.day && ep.when - prevEnd <= 600000) { g.eps.push(ep); g.last = ep; if (ep.level === 'RED') g.level = 'RED'; g.end = ep.end; g.ongoing = !ep.end && !ep.interrupted; g.cut = ep.interrupted && !ep.end; }
    else { const ng = { name: ep.name, day: ep.day, first: ep, last: ep, eps: [ep], level: ep.level, end: ep.end, ongoing: !ep.end && !ep.interrupted, cut: ep.interrupted && !ep.end }; groups.push(ng); lastOf[ep.name] = ng; }
  }
  const num = x => { const m = /^([\d.]+)\s*(.*)$/.exec(x || ''); return m ? { v: parseFloat(m[1]), u: m[2].replace(/\s*\(.*$/, '') } : null; };
  for (const g of groups) {
    let pk = null, dur = 0;
    for (const ep of g.eps) { const c = num(ep.peak) || num(ep.redDetail) || num(ep.detail); if (c && (!pk || c.v > pk.v)) pk = c; if (ep.end) dur += Math.max(0, ep.end - ep.when); }
    g.peak = pk; g.dur = dur;
  }
  lastLogCount = recent.length;
  const nRed = recent.filter(ep => ep.level === 'RED').length, nYel = recent.length - nRed;
  $('wsum').innerHTML = groups.length ? '<span>crossings in the last 7 days:</span><span><b style="color:#e5484d">' + nRed + '</b> red</span><span><b style="color:#e6c84a">' + nYel + '</b> yellow</span><span>' + plural(groups.length, 'row') + '</span>' : '';
  const today = localDay(new Date()), y = new Date(); y.setDate(y.getDate() - 1); const yest = localDay(y);
  let hh = '', lastDay = null;
  groups.reverse().forEach((g, gi) => {
    if (g.day !== lastDay) { lastDay = g.day; hh += '<div class="wday">' + (g.day === today ? 'today' : g.day === yest ? 'yesterday' : g.day) + '</div>'; }
    const col = g.level === 'RED' ? '#e5484d' : '#e6c84a';
    const endT = g.end ? ('0' + g.end.getHours()).slice(-2) + ':' + ('0' + g.end.getMinutes()).slice(-2) : null;
    const span = g.eps.length > 1 || endT ? g.first.time + (endT && endT !== g.first.time ? ' to ' + endT : '') : g.first.time;
    const meta = g.ongoing ? 'ongoing' : g.cut ? 'until the app stopped' : (g.peak ? 'peak ' + g.peak.v + ' ' + g.peak.u : '') + (g.dur ? (g.peak ? ', ' : '') + fmtDur(g.dur) : '');
    const many = g.eps.length > 1;
    hh += '<div class="wrow' + (many ? ' wgrp' : '') + '" data-g="' + gi + '"><span class="wchev">' + (many ? '&#9656;' : '') + '</span><span class="wdot" style="background:' + col + '"></span>' +
      '<span class="wtime">' + span + '</span><span class="wname">' + esc(g.name) + (many ? '<span class="wcnt">' + g.eps.length + 'x</span>' : '') + '</span><span class="wmeta">' + esc(meta) + '</span></div>';
    if (many) {
      hh += '<div class="wsub" data-sub="' + gi + '">';
      for (const ep of g.eps.slice().reverse()) {
        const m2 = ep.interrupted ? (/^HWiNFO/.test(ep.cut || '') ? 'HWiNFO stopped sharing' : 'ended with the app') + (ep.end ? ', ' + fmtDur(ep.end - ep.when) : '')
          : ep.end ? fmtDur(ep.end - ep.when) + (ep.peak ? ', peak ' + ep.peak : '') : 'ongoing';
        hh += '<div class="wrow"><span class="wdot" style="background:' + (ep.level === 'RED' ? '#e5484d' : '#e6c84a') + ';width:6px;height:6px"></span><span class="wtime">' + ep.time + '</span><span class="wname">' + (ep.level === 'RED' ? 'red' : 'yellow') + ' at ' + esc(ep.redDetail || ep.detail) + '</span><span class="wmeta">' + esc(m2) + '</span></div>';
      }
      hh += '</div>';
    }
  });
  $('wlist').innerHTML = hh || '<div class="wempty ico chk">Nothing crossed a line in the last 7 days. Quiet machine.</div>';
}
$('wlist').addEventListener('click', e => { const r = e.target.closest('.wgrp'); if (!r) return; r.classList.toggle('open'); const sub = document.querySelector('.wsub[data-sub="' + r.dataset.g + '"]'); if (sub) sub.classList.toggle('open'); });

// ---------- game sessions ----------
const gmodal = $('gmodal');
let lastGameCount = 0;
$('gamesBtn').onclick = () => { gmodal.classList.add('open'); $('glist').innerHTML = '<div class="wempty">loading...</div>'; if (host) send({ t: 'games' }); else renderGames(''); };
$('gclear').onclick = () => askConfirm('Clear game sessions?', 'This wipes the game log (' + lastGameCount + (lastGameCount === 1 ? ' session' : ' sessions') + '). A copy is kept as games.log.bak first, so it can be brought back.', 'Clear sessions', () => send({ t: 'games:clear' }));
function renderGames(text) {
  const ss = [];
  for (const line of (text || '').split(/\r?\n/)) {
    try { const x = line.trim() ? JSON.parse(line) : null; if (x && typeof x === 'object' && Number.isFinite(x.start) && Number.isFinite(x.end)) { x.items = Array.isArray(x.items) ? x.items.filter(it => Array.isArray(it) && it.length >= 4) : []; ss.push(x); } } catch (e) { }
  }
  ss.sort((a, b) => b.start - a.start);
  lastGameCount = ss.length;
  const week = Date.now() / 1000 - 7 * 86400, recent = ss.filter(x => x.start >= week), per = {};
  for (const x of recent) per[x.game] = (per[x.game] || 0) + (x.end - x.start);
  const top = Object.keys(per).sort((a, b) => per[b] - per[a])[0], total = recent.reduce((p, x) => p + (x.end - x.start), 0);
  $('gsum').innerHTML = recent.length ? '<span>last 7 days:</span><span><b>' + recent.length + '</b> ' + (recent.length === 1 ? 'session' : 'sessions') + '</span><span><b>' + durTxt(total) + '</b> played</span>' + (top ? '<span>most: ' + esc(top) + ' (' + durTxt(per[top]) + ')</span>' : '') : '';
  const today = localDay(new Date()), yd = new Date(); yd.setDate(yd.getDate() - 1); const yest = localDay(yd);
  let h = '', lastDay = null;
  ss.forEach((x, i) => {
    const dk = localDay(new Date(x.start * 1000));
    if (dk !== lastDay) { lastDay = dk; h += '<div class="wday">' + (dk === today ? 'today' : dk === yest ? 'yesterday' : dk) + '</div>'; }
    const fps = x.fps != null ? '<b>' + esc(x.fps) + '</b> fps' + (x.low ? ', 1% low <b>' + esc(x.low) + '</b>' : '') : '<em>no fps reading</em>';
    h += '<div class="gsrow" data-g="' + i + '"><span class="wchev">&#9656;</span><div><div class="gn">' + esc(x.game) + '</div><div class="gt2">' + hhmm(x.start) + ' to ' + hhmm(x.end) + ', ' + durTxt(x.end - x.start) +
      (x.from - x.start > 90 ? ' (tracked from ' + hhmm(x.from) + ')' : '') + (typeof x.front === 'number' && x.secs - x.front >= 60 ? ', in front ' + durTxt(x.front) : '') + '</div></div><div class="gr">' + fps + '</div></div>';
    h += '<div class="gdet" data-d="' + i + '"><div><div class="gstats">' + (x.items || []).map(it => '<span><em>' + esc(it[0]) + '</em>avg ' + esc(it[2]) + ' ' + esc(it[1]) + ', max ' + esc(it[3]) + ' ' + esc(it[1]) + '</span>').join('') +
      '<span><em>warnings</em>' + esc(x.warns || 0) + '</span></div></div></div>';
  });
  $('glist').innerHTML = h || '<div class="wempty ico pad">No game sessions yet. They show up here when a game you played for over a minute closes.</div>';
}
$('glist').addEventListener('click', e => { const r = e.target.closest('.gsrow'); if (!r) return; r.classList.toggle('open'); const d = document.querySelector('.gdet[data-d="' + r.dataset.g + '"]'); if (d) d.classList.toggle('open'); });
function showGame() {
  $('gameDot').classList.toggle('on', !!feed.game);
  $('gamesBtn').title = feed.game ? 'Game sessions: ' + feed.game + ' running, ' + durTxt(Math.max(60, nowTs - feed.gameSince)) + (feed.front ? '' : ' (in the background)') : 'Game sessions';
}

// ---------- settings ----------
const setmodal = $('setmodal');
function renderSettings() {
  $('setbody').innerHTML =
    '<div class="setrow"><div>Start with Windows<small>Opens in the tray when you sign in.</small></div><button class="tog2' + (feed.autostart ? ' on' : '') + '" id="sAuto" aria-pressed="' + feed.autostart + '" title="Start with Windows"></button></div>' +
    '<div class="setrow"><div>Animations<small>' + ({ full: 'Rolling numbers, smoothly spinning fans, gliding graphs.', reduced: 'Lighter: quicker number rolls, fans turn in small steps, graphs move a few times a second.', minimal: 'Nothing keeps moving: numbers just change, fans stand still, graphs step. Popups and views still slide.', off: 'Nothing moves at all.' })[motionMode()] +
      (!MOTIONS.includes(S.motion) && reducedMotion.matches ? ' (Windows asks apps for less motion.)' : '') + '</small></div><span class="seg seg3" id="sMotion">' +
      [['full', 'Full'], ['reduced', 'Reduced'], ['minimal', 'Minimal'], ['off', 'Off']].map(([v, t]) => '<button data-m="' + v + '" class="' + (motionMode() === v ? 'on' : '') + '">' + t + '</button>').join('') + '</span></div>' +
    '<div class="setrow"><div>HWiNFO<small' + (feed.hwinfo ? ' class="k">' + esc(feed.hwinfo) : '>Not seen running yet') + '</small><small>The free version turns its shared memory off after 12 hours; a restart turns it back on (Windows asks for permission).</small></div><button class="btn" id="sRestart"' + (feed.fake ? ' disabled' : '') + '>Restart HWiNFO</button></div>' +
    '<div class="setrow"><div>Your files<small class="k">' + esc(feed.dataDir) + '</small><small>Layouts, slots, the logs and 7 days of history.</small></div><button class="btn" id="sData">Open</button></div>' +
    '<div class="setrow" style="display:block"><div style="margin-bottom:8px">Keys</div><div class="keys2">' +
      [['E', 'edit layout on or off'], ['1 2 3', 'Tiles, Overview, Grid'], ['Enter', 'open (or select) the cell in focus'], ['Ctrl+S', 'save to the loaded slot'], ['Ctrl+Z, Ctrl+Shift+Z', 'undo, redo'],
       ['Alt + arrows', 'move the selected cell'], ['Del', 'remove the selected cell'], ['Esc', 'close a popup']].map(k => '<span class="kbd">' + k[0] + '</span><span>' + k[1] + '</span>').join('') + '</div></div>' +
    '<div class="setrow"><div>HW Deck ' + esc(feed.version) + '<small>Reads HWiNFO\'s shared memory; nothing leaves this PC.</small></div></div>';
}
$('setBtn').onclick = () => { renderSettings(); setmodal.classList.add('open'); };
$('setbody').addEventListener('click', e => {
  if (e.target.closest('#sAuto')) { feed.autostart = !feed.autostart; send({ t: 'autostart', on: feed.autostart }); renderSettings(); }
  const mb = e.target.closest('#sMotion button');
  if (mb && mb.dataset.m !== motionMode()) { S.motion = mb.dataset.m; applyMotion(); saveState(); renderSettings(); renderView(false); }
  if (e.target.closest('#sRestart')) send({ t: 'restartHwinfo' });
  if (e.target.closest('#sData')) send({ t: 'openData' });
});
$('bannerBtn').onclick = () => send({ t: 'restartHwinfo' });

// ---------- toast ----------
let toastT = 0, toastDepth = -1;
function toast(msg, withUndo, ms) {
  setText($('toastTxt'), msg); $('toastUndo').hidden = !withUndo;
  toastDepth = withUndo ? undoStack.length : -1;
  const t = $('toast'); t.classList.add('show'); clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove('show'); $('toastUndo').hidden = true; toastDepth = -1; }, ms || (withUndo ? 8000 : msg.length > 60 ? 5000 : 2600));
}
// another change after the toast: its Undo would undo that one instead, so it goes
function toastStale() { if (toastDepth >= 0 && undoStack.length !== toastDepth) retireToastUndo(); }
function retireToastUndo() { $('toastUndo').hidden = true; toastDepth = -1; }

// ---------- keys ----------
document.addEventListener('keydown', ev => {
  if (drag && drag.started) { if (ev.key === 'Escape') endDrag(true); ev.preventDefault(); return; }   // nothing else mid-drag
  // fields that take typing (a checkbox doesn't; a select takes letters and digits for its options)
  const typing = ev.target.closest && ev.target.closest('textarea, select, input:not([type=checkbox]):not([type=radio])');
  const ctrl = ev.ctrlKey || ev.metaKey, k = (ev.key || '').toLowerCase();
  if (ctrl && k === 's') { ev.preventDefault(); if (!cmodal.classList.contains('open')) onSave(); return; }
  if (ev.key === 'Escape') {
    if (drag) { endDrag(true); return; }
    if (cmodal.classList.contains('open')) { closeConfirm(); return; }
    if (smenu) { closeSmenu(); return; }
    if (modalCid) { closeDetail(); return; }
    for (const id of ['wmodal', 'gmodal', 'smodal', 'setmodal']) if ($(id).classList.contains('open')) { $(id).classList.remove('open'); return; }
    if (relinkFor) { endRelink(); renderView(false); }
    return;
  }
  if (typing) return;
  if (ctrl && (k === 'z' || k === 'y')) { ev.preventDefault(); if (cmodal.classList.contains('open')) return; k === 'y' || ev.shiftKey ? redo() : undo(); return; }
  if (anyModalOpen() || ctrl) return;
  const dc = ev.target.matches && ev.target.matches('#view .dc') ? ev.target : null;
  if (dc && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); if (S.edit) selectCell(dc.dataset.cid); else openDetail(dc.dataset.cid); return; }
  if (ev.key === 'e' || ev.key === 'E') { setEdit(!S.edit); return; }
  if (!ev.altKey && ['1', '2', '3'].includes(ev.key)) { const s = ['tiles', 'overview', 'grid'][+ev.key - 1]; if (s !== S.screen) showScreen(s); return; }
  if (!S.edit || !sel) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeCell(sel); return; }
  if (ev.altKey && ev.key.startsWith('Arrow')) {
    ev.preventDefault();
    const cat = catOf(sel), ci = S.L.cats.indexOf(cat), i = cat.cells.indexOf(sel), id = sel;
    const back = ev.key === 'ArrowLeft' || (S.screen !== 'tiles' && ev.key === 'ArrowUp'), fwd = ev.key === 'ArrowRight' || (S.screen !== 'tiles' && ev.key === 'ArrowDown');
    mutate(() => {
      if (back && i > 0) { cat.cells.splice(i, 1); cat.cells.splice(i - 1, 0, id); }
      else if (fwd && i < cat.cells.length - 1) { cat.cells.splice(i, 1); cat.cells.splice(i + 1, 0, id); }
      else if ((ev.key === 'ArrowUp' || back) && ci > 0) { cat.cells.splice(i, 1); S.L.cats[ci - 1].cells.push(id); S.L.cats[ci - 1].collapsed = false; }
      else if ((ev.key === 'ArrowDown' || fwd) && ci < S.L.cats.length - 1) { cat.cells.splice(i, 1); S.L.cats[ci + 1].cells.unshift(id); S.L.cats[ci + 1].collapsed = false; }
    });
    const el = document.querySelector('#view .dc[data-cid="' + id + '"]'); if (el) el.focus();
  }
});
window.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });   // the fit owns the scale

// ---------- window chrome: the title bar is the caption, the edges resize ----------
$('wmin').onclick = () => send({ t: 'win', a: 'min' });
$('wmax').onclick = () => send({ t: 'win', a: 'max' });
$('wclose').onclick = () => send({ t: 'win', a: 'close' });
const EDGE = 6;
function edgeZone(x, y) {
  const w = innerWidth, h = innerHeight, l = x < EDGE, r = x > w - EDGE, t = y < EDGE, b = y > h - EDGE;
  if (t && l) return 'tl'; if (t && r) return 'tr'; if (b && l) return 'bl'; if (b && r) return 'br';
  return l ? 'l' : r ? 'r' : t ? 't' : b ? 'b' : null;
}
const CURSORS = { l: 'ew-resize', r: 'ew-resize', t: 'ns-resize', b: 'ns-resize', tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize' };
function onScrollbar(e) {
  for (let n = e.target; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1 && n.clientWidth) { const r = n.getBoundingClientRect(); if (e.clientX >= r.left + n.clientLeft + n.clientWidth && e.clientX <= r.right) return true; }
  }
  return false;
}
const zoneAt = e => { const z = edgeZone(e.clientX, e.clientY); return z && (z === 'r' || z === 'tr' || z === 'br') && onScrollbar(e) ? null : z; };
document.addEventListener('mousemove', e => { if (host && !drag) document.body.style.cursor = CURSORS[zoneAt(e)] || ''; });
document.addEventListener('mousedown', e => { if (!host || e.button !== 0) return; const z = zoneAt(e); if (z) { e.preventDefault(); e.stopPropagation(); send({ t: 'win', a: 'resize:' + z }); } }, true);
// an older WebView2 can't make the title bar a caption: then the page asks the host to drag the window
$('titlebar').addEventListener('mousedown', e => { if (host && !feed.nonClient && e.button === 0 && !e.target.closest('button, nav')) send({ t: 'drag' }); });

// ---------- the host ----------
const agoTxt = s => {
  const m = Math.round(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return s < 60 ? 'less than a minute ago' : m < 60 ? m + ' min ago' : d ? plural(d, 'day') + (h % 24 ? ' ' + (h % 24) + ' h' : '') + ' ago' : h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') + ' ago';
};
function showFeed() {
  const dot = $('dot'), ban = $('banner'), was = ban.hidden;
  app.classList.toggle('noreadings', !READ.length && !feed.fake);
  if (feed.fake) { dot.className = 'dot fake'; dot.title = 'Demo data: ' + READ.length.toLocaleString('en-US') + ' made-up readings'; ban.hidden = true; }
  else if (feed.status === 'ok') { dot.className = 'dot ok'; dot.title = 'HWiNFO: ' + READ.length.toLocaleString('en-US') + ' readings, polled ' + (feed.age < 2 ? 'just now' : feed.age + ' s ago'); ban.hidden = true; }
  else {
    dot.className = 'dot bad';
    dot.title = feed.status === 'stale' ? 'HWiNFO stopped updating' : 'HWiNFO not found';
    ban.hidden = !feed.got || (!READ.length && !S.L.cats.length);   // the setup screen says it all when there is nothing yet
    setText($('bannerTxt'), feed.status === 'stale' ? 'HWiNFO stopped updating its shared memory ' + agoTxt(feed.age) + '.' + (feed.age >= 60 ? ' The free version does this after 12 hours.' : '')
      : READ.length ? 'HWiNFO\'s shared memory is gone. Start HWiNFO with Shared Memory Support on; the values come back by themselves.'
      : 'HWiNFO isn\'t running, or its Shared Memory Support is off. Start it (or restart it); the values come back by themselves.');
  }
  if (ban.hidden !== was) { clearTimeout(fitTimer); fitTimer = setTimeout(() => { autofit(); updateView(true); }, 30); }   // the banner takes room: fit again
}
function onHost(m) {
  if (m.t === 'state') {
    feed.fake = !!m.fake; feed.dataDir = m.dataDir || ''; feed.version = m.version || ''; feed.nonClient = m.nonClient !== false;
    S.slots = (m.slots || []).slice(0, 5).map(cleanSlot);
    while (S.slots.length < 5) S.slots.push(null);
    const st = m.state;
    if (st && st.L && Array.isArray(st.L.cats)) { S.L = cleanLayout(st.L); S.active = Number.isInteger(st.active) && st.active >= 0 && st.active < 5 && S.slots[st.active] ? st.active : null; S.edit = st.edit !== false; S.screen = ['tiles', 'overview', 'grid'].includes(st.screen) ? st.screen : 'tiles'; S.motion = st.motion === false ? 'off' : MOTIONS.includes(st.motion) ? st.motion : undefined; }
    else { S.L = emptyLayout(); S.active = null; S.edit = true; S.screen = 'tiles'; }   // first run: nothing, edit mode on
    applyMotion();
    undoStack = []; redoStack = []; sel = null;
    app.classList.toggle('editing', S.edit); $('editBtn').classList.toggle('on', S.edit);
    for (const b of document.querySelectorAll('#screens button[data-s]')) b.classList.toggle('active', b.dataset.s === S.screen);
    placeTabInd(true);
    lastSub = ''; subscribe(); enterNext = true; renderView(false); renderStorage(); renderInsp(); syncUndo(); syncSaves();
  } else if (m.t === 'settings') {
    feed.autostart = !!m.autostart; feed.hwinfo = m.hwinfo || null;
    if (setmodal.classList.contains('open')) renderSettings();
  } else if (m.t === 'catalog') {
    const sameKeys = READ.length === m.readings.length && m.readings.every((x, i) => READ[i].key === x[2]);
    setCatalog(m);
    lastSub = ''; subscribe();
    // the same readings with new names (a rename in HWiNFO): no rebuild under someone typing in a field
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#insp input, #insp select, #insp textarea, .cn-in');
    if (sameKeys && typing) { for (const [cid, r] of E) { const c = S.L.cells[cid], n = r.root.querySelector('.tn > span, .nm > span, .gname > span'); if (c && n) setText(n, cellName(c)); } renderStorage(); }
    else { renderView(false); renderStorage(); renderInsp(); }
    showFeed();
  } else if (m.t === 'spark') {
    for (const k in m.keys) ringFill(k, m.ts, m.keys[k]);
    if (m.ts > nowTs) nowTs = m.ts;
    if (curveWait && m.keys[curveWait.src]) {
      const c = S.L.cells[curveWait.cid], s2 = series(curveWait.src, 30).filter(x => isFinite(x)), src = BYKEY.get(curveWait.src);
      if (c && c.curve && c.curve.src === curveWait.src && s2.length) { c.curve.pts = startCurve(BYKEY.get(c.key), { v: s2[s2.length - 1], unit: src ? src.unit : '' }); saveState(); if (sel === curveWait.cid) renderInsp(); }
      curveWait = null;
    }
    updateView(true);
  } else if (m.t === 'tick') {
    const was = feed.status, first = !feed.got;
    feed.status = m.status; feed.age = m.age; feed.got = true; feed.game = m.game; feed.front = m.front; feed.gameSince = m.gameSince; feed.pm = !!m.pm;
    if (lastTick && m.ts - lastTick > 2) for (const k in holdSince) delete holdSince[k];   // seconds we didn't see (hidden): holds start again
    nowTs = lastTick = m.ts;
    for (let j = 0; j < m.i.length; j++) { const r = READ[m.i[j]]; if (!r) continue; r.v = m.v[j]; if (m.mn[j] != null) { r.mn = m.mn[j]; r.mx = m.mx[j]; r.av = m.av[j]; } }
    const live = m.status === 'ok';
    for (const k of cellKeys()) { const r = BYKEY.get(k); ringPut(k, m.ts, live && r ? r.v : null); }
    showFeed(); showGame();
    if ((first || was !== m.status) && (!READ.length || !S.L.cats.length)) renderView(false);
    if (!drag || !drag.started) { updateView(false); tickInsp(); if (!dragPt) drawRows(); }
    if (modalCid) { refreshModal(); if (bigRange !== '15m' && Date.now() - histAsked > 60000) askHist(); }
    if (HP.shown) { if (anyModalOpen() || !S.L.cells[HP.cid]) hidePrev(); else { fillPrev(); if (!HP.rev0) drawPrev(); } }
  } else if (m.t === 'hist') {
    bigHist = m;
    if (modalCid && histReady()) { bigRev0 = motionOn() ? performance.now() : 0; refreshModal(); bigLoop(); }
  } else if (m.t === 'alerts') renderWarnings(m.log);
  else if (m.t === 'games') renderGames(m.log);
  else if (m.t === 'toast') toast(m.text, false, m.ms);
  else if (m.t === 'imported') {
    const d = cleanSlot(m.data), i = m.slot;
    if (!d || !(i >= 0 && i < 5)) { toast('That file is not an HW Deck layout'); return; }
    if (!d.name) d.name = 'Imported';
    S.slots[i] = d; saveSlot(i); syncSaves(); renderSaves();
    toast('Imported into slot ' + (m.slot + 1) + ': load it to use it');
  }
}
if (host) { host.addEventListener('message', e => onHost(e.data)); send({ t: 'ready' }); }
else { feed.got = true; renderView(true); renderInsp(); syncUndo(); showFeed(); }   // opened outside the app: the empty first-run view
document.fonts && document.fonts.ready.then(() => placeTabInd(true));
