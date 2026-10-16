'use strict';
// HW Deck page. The host (app.cs) sends the catalog of HWiNFO readings, a tick of values once a second and the saved
// files; this page owns the layout and draws it three ways (Tiles, Overview, Grid).
//   layout   { v, cats: [{ id, name, collapsed, cells: [cellId] }], cells: { cellId: cell }, views? }
//   cell     { key, match, name, dec, graph, gates: { mode none|y|yr, dir above|below, y, r, hold, other?: { y?, r? } },
//              (other: lines on the other side too, e.g. bad above 2,600 and below 300)
//              curve: { src, pts: [[temp, rpm]], tol, hold }, pred }   (pred: a predicted fan, no key)
//   views    how each view is arranged and how its categories look (see "arrangements" below)

const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const send = m => { if (host) host.postMessage(m); };
// a build's own cell kinds and messages, from its web/extras.js (loaded only when the host says there is one; HW Deck
// itself has none). EXT.kinds[kind] = { eval(out, r, c): fills the value, words, caption, level (true: that's all, no
// lines), body(cid, r, where): html in place of the graph (where: tile, hero, row, band, grid), update(root, r, e, cid):
// on every tick, detail(box, cid, r, e, full): its own section in the popup (full: just opened), desc(cid, r): the
// popup's description, noGraph: the popup shows no graph, after(out, r, c, cid): changes the words once the lines had
// their say, icon(r, c): its icon (an svg, 24 x 24 strokes like ICONS) }. EXT.kindOf(r): a kind for a reading that has none of its own (one of HWiNFO's); EXT.after(out, r, c,
// cid): the same as a kind's after, for every cell; EXT.head(cat): html at the end of a category's header (its own
// buttons); EXT.tag(cat, ids, n): an Overview card's tag instead of "all normal" (null: as usual, '': none).
// EXT.msg(m) gets the host's "x.*" messages; the page sends its own with send({ t: 'x.something' }). EXT.keys(): more
// readings to stream than the cells hold (what its captions read)
const EXT = window.EXT = { kinds: {}, msg: null, loaded: false, kindOf: null, after: null, head: null, tag: null, keys: null };
const xkOf = r => { if (!r) return null; const k = r.kind || (EXT.kindOf ? EXT.kindOf(r) : null); return k ? EXT.kinds[k] || null : null; };
const xBody = (cid, r, where) => { const xk = xkOf(r); return xk && xk.body ? '<div class="xb" data-x="1">' + xk.body(cid, r, where) + '</div>' : null; };
// HW Deck's own 12V-2x6 connector (a GPU that reports its pins): its most loaded pin as the value, with lines like any
// cell (9.2 / 9.5 A to start with), the pins as bars, the pin table in its popup, and yellow when a pin carries 1.5x its
// share for 3 s (the host keeps that in the warning log too)
const CONN = 'hwdeck.0/12v';
// the pin rule's hold and episode, in the host's seconds like the lines': lopsided for 3 s turns it, and an episode goes
// on through a calm second or two (it ends on the 3rd), as the warning log has it
let c12Since = 0;
let notOkAt = 0, notOkMarked = false;
function resetSeen() { for (const k in holdSince) delete holdSince[k]; for (const k in cellEp) delete cellEp[k]; c12Since = 0; c12Ep.on = false; c12Ep.calm = 0; }
// the pin rule, once a second in the tick as the host judges it: drawn or not, its readings there or not (gone, the
// seconds are calm ones); only while a connector cell is in the view, as the host's rule
function stepPins() {
  if (feed.status !== 'ok' || !Object.values(S.L.cells).some(c => c && c.key === CONN)) return;
  const c = feed.c12, now = nowTs, hot = c ? c[1] : -1, lop = !!(c && c[0]);
  if (lop) { if (!c12Since) c12Since = now; c12Ep.calm = 0; if (now - c12Since >= 3 || c12Ep.on) { c12Ep.on = true; c12Ep.words = 'pin ' + (hot + 1) + ' carrying ' + c[2] + 'x its share'; } }
  else { c12Since = 0; if (c12Ep.on && !c12Ep.calm) c12Ep.calm = now; if (c12Ep.on && now - c12Ep.calm >= 2) { c12Ep.on = false; c12Ep.calm = 0; } }
}   // (the feed not ok since: host seconds, 0 = ok; the 10 s Mark done)
const c12Ep = { on: false, calm: 0, words: '' };
const pinVals = i => (feed.c12keys && feed.c12keys[i] || []).map(k => { const r = BYKEY.get(k); return r && r.v != null ? r.v : null; });
const CONN_LINES = { mode: 'yr', dir: 'above', y: 9.2, r: 9.5, hold: 0 };
EXT.kinds['12v'] = {
  body: () => '<span class="xpins">' + '<i><b></b></i>'.repeat(Math.max(1, feed.c12keys ? feed.c12keys[0].length : 6)) + '</span>',
  update(root) {
    const a = pinVals(0);
    root.querySelectorAll('.xb .xpins b').forEach((b, i) => { const v = a[i]; b.style.height = (v == null ? 0 : Math.min(100, v / 9.5 * 100)) + '%'; b.className = v >= 9.5 ? 'r' : v >= 9.2 ? 'y' : ''; });
  },
  after(out) {
    if (feed.status !== 'ok') return;   // (a stalled feed judges nothing: the cell stays grey)
    const c = feed.c12, a = pinVals(0), hot = c ? c[1] : -1;   // (the pin rule itself steps once a second: stepPins)
    if (out.lvl && hot >= 0 && a[hot] != null) out.sub = 'pin ' + (hot + 1) + ' at ' + fmt(a[hot], 1) + ' A';
    else if (c12Ep.on) { out.lvl = Math.max(out.lvl, 1); out.col = out.lvl === 2 ? 'red' : 'yellow'; out.warm = 0; out.sub = c12Ep.words; }
  },
  desc: () => 'The GPU\'s 12V-2x6 power connector, by its pins: the value is the most loaded one. A pin is rated 9.5 A (a healthy connector at a 600 W limit peaks near 9.1 A). A pin carrying 1.5x its share of the load, from 15 A up, is the early sign of a bad contact: the cell turns yellow and the warning history keeps it.',
  detail(box, cid, r, e, full) {
    if (full || !box.querySelector('.mpinwrap')) box.innerHTML = '<div class="msec">the pins</div><div class="mpinwrap"></div>';
    const a = pinVals(0), w = pinVals(1);
    let h = '';
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      h += '<div class="mpin"><span class="lbl">pin ' + (i + 1) + '</span><span class="trk"><span style="width:' + (v == null ? 0 : Math.min(100, v / 9.5 * 100)) + '%;background:' +
        (v >= 9.5 ? COLORS.red : v >= 9.2 ? COLORS.yellow : '#6f6f6f') + '"></span></span><span class="num">' + (v == null ? '--' : v.toFixed(2)) + ' A</span><span class="num">' + (w[i] == null ? '--' : w[i].toFixed(1)) + ' W</span></div>';
    }
    const el = box.querySelector('.mpinwrap'); if (el._h !== h) { el.innerHTML = h; el._h = h; }
  }
};
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
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.1M6.6 6.6A17 17 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.4-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  corner: '<svg viewBox="0 0 14 14"><path d="M12 5v7H5M12 12L7 7"/></svg>',
  neck: '<svg viewBox="0 0 24 24"><path d="M5 6h14l-5 6v6l-4 2v-8z"/></svg>',
  pad: '<svg viewBox="0 0 64 64"><rect x="8" y="12" width="20" height="16" rx="3"/><rect x="36" y="12" width="20" height="16" rx="3"/><rect x="8" y="36" width="20" height="16" rx="3"/><rect x="36" y="36" width="20" height="16" rx="3" stroke-dasharray="3 3"/></svg>'
};
const COLORS = { white: '#e8e8e8', yellow: '#e6c84a', red: '#e5484d', grey: '#555555' };

// ---------- the catalog: every reading HWiNFO shares ----------
const TYPES = ['none', 'temp', 'volt', 'fan', 'current', 'power', 'clock', 'usage', 'other'];
const TYPE_NAME = { temp: 'Temp', volt: 'Volt', fan: 'Fan', power: 'Power', current: 'Current', clock: 'Clock', usage: 'Usage', other: 'Other' };
let SENS = [], READ = [], BYKEY = new Map(), BYMATCH = new Map();
const feed = { bnIn: [null, null, 0], status: 'missing', age: 0, fake: false, dataDir: '', version: '', pc: '', got: false, game: null, front: false, gameSince: 0, hwinfo: null, autostart: false, keep: false, keepBusy: false, keepWait: false, fps: false, fpsState: 'off', fpsBusy: false, fpsWait: false, updates: true, latest: null, pm: false, nonClient: true };

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
  READ = m.readings.map(([s, t, key, label, unit, kind], idx) => {
    if (!SENS[s]) { if (unknown < 0) { unknown = SENS.length; SENS.push({ key: 'unknown.0', name: 'Unknown sensor', short: 'Unknown' }); } s = unknown; }
    const r = { idx, key, s, t: TYPES[t] || 'other', label, unit, kind: kind || null, v: null, mn: null, mx: null, av: null };
    const o = old.get(key); if (o) { r.v = o.v; r.mn = o.mn; r.mx = o.mx; r.av = o.av; }
    r.hay = ((SENS[s] ? SENS[s].name : '') + ' ' + label + ' ' + (inGB(r) ? 'GB' : unit) + ' ' + r.t).toLowerCase();   // (the unit it shows)
    return r;
  });
  BYKEY = new Map(READ.map(r => [r.key, r]));
  nOwn = READ.filter(isOwn).length;
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
// HW Deck's own readings come after HWiNFO's, under its own sensor; the dot counts only HWiNFO's
const isOwn = r => !!r && /^hwdeck\./.test(r.key);
let nOwn = 0;
const hwCount = () => READ.length - nOwn;
// the bottleneck, one of them: what limits the fps while a game runs, as 1 gpu, 2 cpu, 3 capped (none: no game)
const BNECK = 'hwdeck.0/bneck', GTIME = 'hwdeck.0/gtime';
const isBneck = c => !!c && !c.pred && c.key === BNECK;
const BN = { 1: ['GPU', 'bound', 'b-gpu', 'gpu'], 2: ['CPU', 'bound', 'b-cpu', 'cpu'], 3: ['FPS', 'capped', 'b-cap', 'capped'] };
// the last 15 min of calls: runs of one call as strip segments [from, to, shade] on 0..900, and each call's share
function bnStrip() {
  const s = series(BNECK, HLEN).map(x => BN[x] ? x : 0), segs = [], n = [0, 0, 0, 0];
  for (let a = 0, i = 1; i <= HLEN; i++) if (i === HLEN || s[i] !== s[a]) { if (s[a]) { segs.push([a, i, BN[s[a]][2]]); n[s[a]] += i - a; } a = i; }
  const tot = n[1] + n[2] + n[3];
  return { segs, tot, split: tot ? [1, 2, 3].map(k => [BN[k][3], Math.round(n[k] * 100 / tot), BN[k][2]]) : [] };
}
const bnSplit = b => b.split.map(q => q[0] + ' ' + q[1] + '%').join(', ');
// what the cell shows: the most common call of the last 5 s, so one odd second can't flip it
function bnNow() {
  const n = [0, 0, 0, 0];
  for (const x of series(BNECK, 5)) if (BN[x]) n[x]++;
  return n[1] + n[2] + n[3] === 0 ? 0 : n[1] >= n[2] && n[1] >= n[3] ? 1 : n[2] >= n[3] ? 2 : 3;
}
// what the host goes by: [GPU usage key, Max CPU/Thread Usage key, how many per-thread usages]
const bnInputs = () => !!feed.bnIn[0] && (!!feed.bnIn[1] || feed.bnIn[2] > 0);
function bnFrom() {
  const nm = k => { const r = BYKEY.get(k); return r ? esc(r.label) + ' (' + esc(SENS[r.s].short) + ')' : ''; };
  if (!bnInputs()) return 'HWiNFO shares no GPU core load or CPU thread usage on this PC, so there is nothing to go by.';
  return 'It goes by ' + nm(feed.bnIn[0]) + ' and ' + (feed.bnIn[1] ? nm(feed.bnIn[1]) : 'the busiest of ' + feed.bnIn[2] + ' CPU thread usages') + '.';
}
const bnLegend = b => b.split.map(q => '<span><i class="lg ' + q[2] + '"></i><em>' + q[0] + '</em>' + q[1] + '%</span>').join('');
function renderStrip(track, segs, span) {
  let h = '';
  for (const g of segs) h += '<span class="' + g[2] + '" style="left:' + (g[0] / span * 100) + '%;width:' + Math.max(0.3, (g[1] - g[0]) / span * 100) + '%"></span>';
  if (track._h !== h) { track.innerHTML = h; track._h = h; }
}
const isFanR = r => !!r && (r.t === 'fan' || r.unit === 'RPM');
const isF = u => /\u00b0F/.test(u || '');   // HWiNFO can show temperatures in Fahrenheit
const tempUnit = r => r && isF(r.unit) ? '\u00b0F' : '\u00b0C';
const cToU = (c, r) => r && isF(r.unit) ? Math.round(c * 9 / 5 + 32) : c;
function iconOf(c, r) {
  if (c && c.pred) return ICONS.fan;
  const xk = xkOf(r), xi = xk && xk.icon ? xk.icon(r, c) : null;
  if (xi) return xi;
  if (isBneck(c) || (r && r.key === BNECK)) return ICONS.neck;
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
  if (u.indexOf('\u00b0') >= 0 || ['W', 'ms', 'GT/s', 'GB', 'MB', 'MB/s', 'KB/s', 'GB/s'].includes(u)) return 1;   // (MB shows in GB)
  return 0;
}
const decOfCell = (c, r) => c.dec != null ? c.dec : r ? decFor(r) : 0;
const NF = [0, 1, 2, 3].map(d => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const NFL = [0, 1, 2, 3].map(d => new Intl.NumberFormat('en-US', { maximumFractionDigits: d }));
function fmt(v, dec) { return v == null || !isFinite(v) ? '--' : (NF[dec] || NF[0]).format(+v); }
const isYN = r => !!r && r.unit === 'Yes/No';
// a value as the cell shows it: Yes/No readings in words, the rest with their decimals
// HWiNFO gives memory sizes in MB: they show in GB, and their lines are typed in GB (kept in MB, as the host reads
// them). gbK: what a value in the reading's own unit is multiplied by to show
const inGB = r => !!r && r.unit === 'MB';
const gbK = r => inGB(r) ? 1 / 1024 : 1;
const fmtV = (v, dec, r) => isYN(r) ? (v == null || !isFinite(v) ? '--' : v >= 0.5 ? 'Yes' : 'No') : fmt(v == null ? v : v * gbK(r), dec);
const unitOf = r => !r || r.unit === 'Yes/No' ? '' : inGB(r) ? 'GB' : r.unit;
function valTxt(r) { if (!r || r.v == null) return '--'; if (r.key === BNECK) return BN[r.v] ? BN[r.v][0] + ' ' + BN[r.v][1] : '--'; return isYN(r) ? fmtV(r.v, 0, r) : fmtV(r.v, decFor(r), r) + (r.unit ? ' ' + unitOf(r) : ''); }
// a memory reading's partner: the same sensor's "... Memory Available" (used + available = what there is), for the
// "34% of 64 GB" caption; worked out once per catalog
let memPairs = null, memPairsOf = null;
function memPair(r) {
  if (!inGB(r) || /Available$/.test(r.label)) return null;
  if (memPairsOf !== READ) {
    memPairsOf = READ; memPairs = new Map();
    for (const x of READ) if (x.unit === 'MB' && /^(Physical|GPU) Memory Available$/.test(x.label)) memPairs.set(x.s, x);
  }
  return /Used|Allocated/.test(r.label) ? memPairs.get(r.s) || null : null;   // (not D3D Dedicated: its total isn't used + available)
}
// what's installed, from what Windows can use (used + available leaves out what the hardware keeps: 64 GB of RAM
// reads 62.x): the memory size it rounds up to, so the caption says the size on the box
const MEM_SIZES = [1, 2, 3, 4, 6, 8, 10, 11, 12, 16, 18, 20, 24, 32, 36, 40, 48, 64, 72, 80, 96, 128, 160, 192, 256, 384, 512, 768, 1024, 1536, 2048];   // (36 and 72: 32 or 64 plus memory soldered on)
const memSize = gb => MEM_SIZES.find(s => s >= gb - 0.3) || Math.ceil(gb);
const fmtL = (x, dec) => (NFL[dec == null ? 1 : dec] || NFL[1]).format(+x);
// a curve's points go by temperature, a tie by rpm (two points at one temperature: a step)
const ptOrd = (a, b) => a[0] - b[0] || a[1] - b[1];
function interp(pts, x) {
  if (!pts || !pts.length || x == null || !isFinite(x)) return null;
  const p = pts.slice().sort(ptOrd);
  if (x <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) if (x <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1); }
  return p[p.length - 1][1];
}
const mixHex = (a, b, w) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.substr(i, 2), 16) * (1 - w) + parseInt(b.substr(i, 2), 16) * w).toString(16).padStart(2, '0')).join('');
const durTxt = sec => { const m = Math.max(0, Math.round(sec / 60)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm'; };
const durS = sec => sec < 59.5 ? Math.max(0, Math.round(sec)) + 's' : durTxt(sec);   // (a session of your own can be under a minute)
const plural = (n, one, many) => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many || one + 's');
const hhmm = u => { const d = new Date(u * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
const hhmmss = u => hhmm(u) + ':' + ('0' + new Date(u * 1000).getSeconds()).slice(-2);
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
    if (g && typeof g === 'object') {
      cell.gates = { mode: ['y', 'yr'].includes(g.mode) ? g.mode : 'none', dir: g.dir === 'below' ? 'below' : 'above', y: fin(g.y), r: fin(g.r), hold: Math.min(1e9, Math.max(0, fin(g.hold) || 0)) };
      if (g.other && typeof g.other === 'object') { const o = {}; if (isFinite(fin(g.other.y))) o.y = fin(g.other.y); if (isFinite(fin(g.other.r))) o.r = fin(g.other.r); cell.gates.other = o; }
      if (isFinite(fin(g.fade)) && g.fade >= 0) cell.gates.fade = Math.min(1e9, g.fade);   // (none: the automatic fade)
    }
    const curveOf = cv => {
      const pts = cv && typeof cv === 'object' && Array.isArray(cv.pts) ? cv.pts.filter(p => Array.isArray(p) && p.length >= 2 && isFinite(fin(p[0])) && isFinite(fin(p[1]))).map(p => [p[0], p[1]]).sort(ptOrd) : [];
      return pts.length >= 2 ? Object.assign({ src: str(cv.src, 200) || '', pts, tol: Math.max(1, isFinite(fin(cv.tol)) ? cv.tol : 15), hold: Math.min(1e9, Math.max(0, isFinite(fin(cv.hold)) ? cv.hold : 10)) }, cv.warn === false ? { warn: false } : {}) : null;
    };
    const cv = curveOf(c.curve), off = curveOf(c.curveOff);
    if (cv) cell.curve = cv; else if (cell.pred) continue;   // a predicted fan is nothing without its curve
    if (off && !cv) cell.curveOff = off;
    const nid2 = idOk(id) && !used.has(id) ? id : nid('a');
    used.add(nid2); ids.set(id, nid2); out.cells[nid2] = cell;
  }
  const catIds = new Map();   // a category's id in the file -> its id here (views refer to categories by id)
  for (const cat of L && Array.isArray(L.cats) ? L.cats : []) {
    if (!cat || typeof cat !== 'object') continue;
    const id = idOk(cat.id) && !used.has(cat.id) ? cat.id : nid('c');
    if (typeof cat.id === 'string' && !catIds.has(cat.id)) catIds.set(cat.id, id);
    used.add(id);
    const list = [];
    for (const x of Array.isArray(cat.cells) ? cat.cells : []) { const m = typeof x === 'string' ? ids.get(x) : null; if (m && !listed.has(m)) { listed.add(m); list.push(m); } }
    out.cats.push({ id, name: str(cat.name, 200) && cat.name.trim() ? str(cat.name, 200) : 'Category', collapsed: cat.collapsed === true, cells: list });
  }
  for (const id of Object.keys(out.cells)) if (!listed.has(id)) delete out.cells[id];
  const views = cleanViews(L && L.views, out, ids, catIds);
  if (views) out.views = views;
  const gm = cleanGames(L && L.games);
  if (gm) out.games = gm;
  return out;
}
// a game report's setup (see gxLayout): its categories in order, the built-in ones (summary, time, lines) at most once,
// up to 16, each list with up to GX_MAX readings: a main one by its name (head) or any by its key
const GX_HEADS = ['GPU temp', 'GPU hotspot', 'GPU memory', 'GPU power', 'GPU usage', 'CPU temp', 'CPU power', 'CPU usage', 'VRAM', 'RAM'], GX_MAX = 8;
function cleanGames(g) {
  if (!g || typeof g !== 'object' || !Array.isArray(g.secs)) return undefined;
  const secs = [], seen = new Set();
  for (const s of g.secs.slice(0, 16)) {
    if (!s || typeof s !== 'object' || !['summary', 'time', 'list'].includes(s.kind)) continue;   // (1.4's 'lines' is gone)
    const id = s.kind !== 'list' ? s.kind : idOk(s.id) && !['summary', 'time', 'lines'].includes(s.id) ? s.id : nid('g');
    if (seen.has(id)) continue; seen.add(id);
    const o = { id, kind: s.kind }, name = typeof s.name === 'string' ? s.name.trim().slice(0, 40) : '';
    if (name && s.kind === 'list') o.name = name;
    if (s.kind === 'list') {
      if (!o.name) o.name = 'Category';
      o.cells = (Array.isArray(s.cells) ? s.cells : []).filter(c => c && typeof c === 'object' && (GX_HEADS.includes(c.head) || (typeof c.key === 'string' && c.key && c.key.length <= 200))).slice(0, GX_MAX)
        .map(c => { const x = GX_HEADS.includes(c.head) ? { head: c.head } : { key: c.key }; if (typeof c.name === 'string' && c.name.trim()) x.name = c.name.trim().slice(0, 40); return x; });
    }
    if (s.hide === true) o.hide = true;
    secs.push(o);
  }
  return secs.length ? { secs } : undefined;
}
// ---------- arrangements (1.2): per view, rows of columns, each column a stack of categories; plus looks ----------
//   views    { tiles?, overview?, grid? }: a view that isn't there is Automatic (placed as HW Deck always did)
//   view     { rows?: [{ h?, cols: [{ w?, stack: [catId | { id, h }] }] }], gap?: tight|roomy, cat?: { catId: look },
//              cell?: { cellId: look } }   (no rows: Automatic placement, the looks still apply)
//   h        a row's share of the window height, 0.5 to 6 (none: the row fits its content); in a stack, the
//            category's share of its column
//   w        a column's share of its row, 1 to 12 (none on every column: equal widths)
//   looks    category: tiles { per: 1-8 tiles per row, size: short, title: hide, lead }, overview { style: small|list|
//            band, title: hide, lead }, grid { lead } (lead: the cell shown first); cell: tiles { size: wide|tall|big,
//            name }, overview and grid { name } (name: its name in that view only)
//   Grid has exactly one row: its columns are the tables
const VIEWS = ['tiles', 'overview', 'grid'], VNAME = { tiles: 'Tiles', overview: 'Overview', grid: 'Grid' };
const MAXC = { tiles: 6, overview: 6, grid: 3 }, MAXS = { tiles: 6, overview: 6, grid: 99 };
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const share = x => typeof x === 'number' && isFinite(x) && x > 0 ? Math.min(6, Math.max(0.5, Math.round(x * 2) / 2)) : undefined;
const sid = s => typeof s === 'string' ? s : s.id;
const clone = x => JSON.parse(JSON.stringify(x));
// a tile's size in Tiles: w and h in tiles (a normal tile is 1 x 1), each 0.25 to 2. The sizes that have a name keep it
// (wide 2 x 1, tall 1 x 2, big 2 x 2), so an older HW Deck still draws those; it draws any other size as a normal tile
const SZ = { wide: [2, 1], tall: [1, 2], big: [2, 2] };
// (a size a hair off a quarter step, a third of a pixel or less, from a snap or a px step, is that step: 0.9999 is 1, so four
// tiles of 0.75 and one of 1 still fill a row of 4)
const SNAPQ = 0.002;
// (where a tile's pitch is known, a third of a pixel at that pitch: a 1 px step on a big tile is kept; a size read from a
// file only loses float noise, it was snapped when it was made)
const szNum = (x, tol = SNAPQ) => { if (typeof x !== 'number' || !isFinite(x)) return 1; const v = Math.round(x * 1e4) / 1e4, q = Math.round(v * 4) / 4; return Math.min(2, Math.max(0.25, Math.abs(v - q) < tol ? q : v)); };
const snapAt = G => G && G.p > 0 ? Math.min(SNAPQ, 0.33 / G.p) : SNAPQ;
const isSz = k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(SZ, k);
function sizeLook(w, h, tol, tolH) {
  w = szNum(w, tol); h = szNum(h, tolH === undefined ? tol : tolH);
  for (const k of Object.keys(SZ)) if (SZ[k][0] === w && SZ[k][1] === h) return { size: k };
  return w === 1 && h === 1 ? {} : { w, h };
}
const cleanSize = x => typeof x.w === 'number' || typeof x.h === 'number' ? sizeLook(x.w, x.h, 1.5e-4) : isSz(x.size) ? { size: x.size } : {};
// ids and catIds map what the file calls a cell or a category to what it is called here; anything that points at
// nothing, or is out of range, goes; a category no row places gets a row of its own at the bottom (Grid: the last table)
function cleanViews(V, L, ids, catIds) {
  if (!isObj(V)) return null;
  const inCat = new Map();
  for (const c of L.cats) for (const x of c.cells) inCat.set(x, c.id);
  const out = {};
  for (const vn of VIEWS) {
    const v = V[vn]; if (!isObj(v)) continue;
    const o = {};
    if (Array.isArray(v.rows)) {
      const placed = new Set(), rows = [];
      for (const r of v.rows.slice(0, 500)) {
        if (!isObj(r) || !Array.isArray(r.cols)) continue;
        const cols = [];
        for (const c of r.cols) {
          if (cols.length >= MAXC[vn]) break;
          if (!isObj(c) || !Array.isArray(c.stack)) continue;
          const stack = [];
          for (const it of c.stack) {
            if (stack.length >= MAXS[vn]) break;
            const raw = typeof it === 'string' ? it : isObj(it) && typeof it.id === 'string' ? it.id : null, id = raw === null ? undefined : catIds.get(raw);
            if (!id || placed.has(id)) continue;
            placed.add(id);
            stack.push(id);   // (1.2 betas kept a height share here: every category now keeps its own height)
          }
          if (!stack.length) continue;
          const col = { stack };
          if (Number.isInteger(c.w) && c.w >= 1 && c.w <= 12) col.w = c.w;
          cols.push(col);
        }
        if (!cols.length) continue;
        if (cols.length < 2 || cols.some(c => c.w === undefined)) for (const c of cols) delete c.w;
        const row = {};
        if (vn === 'tiles' && share(r.h) !== undefined) row.h = 1;   // Fill: its tiles may grow into spare room
        row.cols = cols;
        rows.push(row);
        if (vn === 'grid') break;
      }
      if (rows.length) {
        for (const c of L.cats) if (!placed.has(c.id)) {
          if (vn === 'grid') { const cs = rows[0].cols; cs[cs.length - 1].stack.push(c.id); }
          else rows.push({ cols: [{ stack: [c.id] }] });
        }
        o.rows = rows;
      }
    }
    if (vn !== 'grid' && (v.gap === 'tight' || v.gap === 'roomy')) o.gap = v.gap;
    if (isObj(v.cat)) {
      const cat = {};
      for (const k of Object.keys(v.cat)) {
        const id = catIds.get(k), x = v.cat[k];
        if (!id || !isObj(x)) continue;
        const e = {};
        if (vn === 'tiles' && Number.isInteger(x.per) && x.per >= 1 && x.per <= 8) e.per = x.per;
        if (vn === 'tiles' && x.size === 'short') e.size = 'short';
        if (vn === 'overview' && ['small', 'list', 'band'].includes(x.style)) e.style = x.style;
        if (vn !== 'grid' && x.title === 'hide') e.title = 'hide';
        if (typeof x.lead === 'string') { const m = ids.get(x.lead); if (m && inCat.get(m) === id) e.lead = m; }
        if (Object.keys(e).length) cat[id] = e;
      }
      if (Object.keys(cat).length) o.cat = cat;
    }
    if (isObj(v.cell)) {
      const cell = {};
      for (const k of Object.keys(v.cell)) {
        const id = ids.get(k), x = v.cell[k];
        if (!id || !inCat.has(id) || !isObj(x)) continue;
        const e = vn === 'tiles' ? cleanSize(x) : {};
        if (vn === 'tiles' && x.nl === true) e.nl = true;   // it starts a new row of tiles
        if (typeof x.name === 'string' && x.name.trim()) e.name = x.name.slice(0, 200);
        if (Object.keys(e).length) cell[id] = e;
      }
      if (Object.keys(cell).length) o.cell = cell;
    }
    if (Object.keys(o).length) out[vn] = o;
  }
  return Object.keys(out).length ? out : null;
}
// after every change: what points at a removed category or cell goes, a new category gets its own row
function tidyViews(L) {
  if (!L.views) return;
  const ids = new Map(Object.keys(L.cells).map(k => [k, k])), catIds = new Map(L.cats.map(c => [c.id, c.id]));
  const v = cleanViews(L.views, L, ids, catIds);
  if (v) L.views = v; else delete L.views;
}
const cleanSlot = s => s && typeof s === 'object' && s.layout && Array.isArray(s.layout.cats)
  ? { v: 1, name: typeof s.name === 'string' ? s.name.trim().slice(0, 80) : '', layout: cleanLayout(s.layout) } : null;
const S = { L: emptyLayout(), slots: [null, null, null, null, null], active: null, edit: true, screen: 'tiles', motion: undefined, title: undefined, clock: true };
// the title bar: your title (this PC's name when there is none), the feed's dot and the time of the last reading
function renderTitle() {
  setText($('title'), (S.title && S.title.trim()) || feed.pc || feed.brand || 'HW Deck');
  $('clock').hidden = !S.clock;
}
// animations, in Settings: Full (all of it), Minimal (nothing keeps moving: numbers just change, fans stand still,
// graphs step; popups and views still slide), Off (nothing moves). Not chosen yet: Full, or Off when Windows asks apps
// for less motion. (Reduced, before 1.4.2, moved everything at 10 steps a second and looked choppy: a view saved with it
// opens in Full, which costs less than it did)
const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const MOTIONS = ['full', 'minimal', 'off'];
const motionPicked = () => MOTIONS.includes(S.motion) ? S.motion : reducedMotion.matches ? 'off' : 'full';
// Full calms down to Minimal while a game is in front (Settings, on unless turned off), and comes back after
const gameCalmNow = () => S.gameCalm !== false && !!feed.game && !!feed.front;
const motionMode = () => { const m = motionPicked(); return m === 'full' && gameCalmNow() ? 'minimal' : m; };
const motionOn = () => motionMode() === 'full';   // the moving parts: spins, rolls, glides, draw-ins
function applyMotion() { document.documentElement.dataset.motion = motionMode(); }
if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', () => { applyMotion(); if (feed.got) redrawView(); });
// the view drawn again for the motion, but not under a held cell or handle (it would move away under it, or lose the
// click): when it's let go
let viewLater = false;
function redrawView() { if (drag || rs) { viewLater = true; return; } renderView(false); }
let saveT = 0;
// cells gone from the view: their hold and episode end when the view is saved, as the host's do when it gets the save
function dropGone() {
  // (and a cell left with no line or curve, as the host's SetLayout drops its rule: app.cs, the cells loop)
  const ruled = c => !!c && !!c.key && !c.pred && !isBneck(c) && (!!(c.gates && (c.gates.mode === 'y' || c.gates.mode === 'yr')) || !!c.curve);
  for (const k in cellEp) if (!ruled(S.L.cells[k])) delete cellEp[k];
  for (const k in holdSince) if (!ruled(S.L.cells[k])) delete holdSince[k];
  if (!Object.values(S.L.cells).some(c => c && c.key === 'hwdeck.0/12v')) { c12Since = 0; c12Ep.on = false; c12Ep.calm = 0; }   // (no connector cell left: its pin episode ends)
}
function saveState() { clearTimeout(saveT); saveT = setTimeout(() => { dropGone(); send({ t: 'save', file: 'state', gen: stateGen, data: { v: 1, L: S.L, active: S.active, edit: S.edit, screen: S.screen, motion: S.motion, gameCalm: S.gameCalm !== false, pins: [DR.L.pinned, DR.R.pinned], title: S.title, clock: S.clock, hide: S.hide } }); }, 300); }
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
let undoSeq = 0;   // (counts every step: the stack's length stops changing at its cap)
function pushUndo(before) { undoStack.push(before); undoSeq++; if (undoStack.length > 80) undoStack.shift(); redoStack = []; toastStale(); }
function snap() { pushUndo(snapOf()); }
// a change that changes nothing (Alt+arrow at the end of a list) leaves no undo step
function mutate(fn, msg) { if (nudge) flushNudge(); const before = snapOf(); fn(); tidyViews(S.L); if (snapOf() === before) { syncUndo(); renderInsp(); return; } pushUndo(before); afterChange(); if (msg) toast(msg, true); }
// every tile measured again (a build's cells got their bodies): once things settle, never under a drag
const xSeen = new Set(); let rmT = 0;
function remeasureSoon(ms) { clearTimeout(rmT); rmT = setTimeout(() => { if ((drag && drag.started) || rs) { remeasureSoon(); return; } packMemo.clear(); renderView(false); }, ms == null ? 400 : ms); }
// a start: the view stays out of sight until what it shows is in (the readings, their values, a build's extras.js and
// its first data), then it is measured and comes in; before, it drew placeholders first and jumped once they filled
// in (a Smart Life tile without its bar). In the tray the page gets none of it, so this waits for the window to open;
// whatever is still missing 2.5 s after the page shows, it comes in anyway
const boot = { cat: false, tick: false, x: false, t: 0 };
function bootCheck(force) {
  if (!app.classList.contains('boot')) return;
  if (!force && !(boot.cat && boot.tick && (!feed.ext || (EXT.ready && boot.x)))) return;
  clearTimeout(boot.t); app.classList.remove('boot'); packMemo.clear(); renderView(true);
}
function bootArm() { if (app.classList.contains('boot') && !document.hidden && !boot.t) boot.t = setTimeout(() => bootCheck(true), 2500); }
document.addEventListener('visibilitychange', bootArm);
let onLayout = null;   // (the sessions popup: Customize and the open sessions drawn again)
function afterChange() { tidyViews(S.L); fixSel(); if (relinkFor && !S.L.cells[relinkFor]) endRelink(true); saveState(); subscribe(); renderView(false); renderStorage(); renderInsp(); syncUndo(); syncSaves(); if (onLayout) onLayout(); }
function undo() { if (nudge) flushNudge(); keyStep.t = 0; if (!undoStack.length) return; retireToastUndo(); redoStack.push(snapOf()); restore(undoStack.pop()); fixSel(); afterChange(); }
function redo() { if (nudge) flushNudge(); keyStep.t = 0; if (!redoStack.length) return; retireToastUndo(); undoStack.push(snapOf()); restore(redoStack.pop()); fixSel(); afterChange(); }
function syncUndo() { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; }
function fixSel() { if (sel && !S.L.cells[sel]) sel = null; if (selCat && !S.L.cats.some(c => c.id === selCat)) selCat = null; }
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
  for (const c of Object.values(S.L.cells)) {
    if (c.key) set.add(c.key); if (c.curve && c.curve.src) set.add(c.curve.src);
    const mp = c.key && memPair(BYKEY.get(c.key)); if (mp) set.add(mp.key);   // (its "% of" caption)
    if (c.key === CONN && feed.c12keys) for (const k of feed.c12keys[0].concat(feed.c12keys[1])) set.add(k);   // its pins
  }
  if (EXT.keys) for (const k of EXT.keys()) set.add(k);
  return [...set];
}
function subscribe() {
  clearTimeout(subT);
  subT = setTimeout(() => {
    const cells = cellKeys(), rows = gzKeys.length ? [...new Set(rowKeys.concat(gzKeys))] : rowKeys, m = JSON.stringify([cells, rows]);   // (Storage's rows in sight, and Customize's)
    dropRings(new Set(cells));
    if (m === lastSub) return; lastSub = m;
    send({ t: 'sub', cells, rows });
  }, 60);
}

// ---------- a cell's value and state: gates (with their hold), fan curve, warming toward yellow ----------
let sel = null, selCat = null, relinkFor = null;   // the selected cell, or the selected category (never both)
const holdSince = {}, cellEp = {};
// a second with no value (or a reading gone): a calm one for the cell's episode, as the log counts it, and the end of a
// hold (never a second the page didn't look, like a drag's)
function calmGone(cid) { if (feed.status !== 'ok') return; const ep = cellEp[cid]; if (ep && ep.lvl) { if (!ep.calmTs) ep.calmTs = nowTs; else if (nowTs - ep.calmTs >= 2) { ep.lvl = ep.peak = 0; ep.calmTs = 0; } } delete holdSince[cid]; }   // (the 3rd ends it)
function cellValue(c) {
  if (c.pred) { const src = BYKEY.get(c.curve && c.curve.src); return src ? interp(c.curve.pts, src.v) : null; }
  const r = BYKEY.get(c.key); return r ? r.v : null;
}
const gatesBad = g => g.mode === 'yr' && Number.isFinite(g.r) && Number.isFinite(g.y) && (g.dir === 'below' ? g.r >= g.y : g.r <= g.y);
const gatesOn = g => !!g && g.mode !== 'none' && Number.isFinite(g.y) && !gatesBad(g);
// the lines on the other side (none when there are none or they don't make sense: past its own yellow, red before yellow)
function otherOf(g) {
  if (!gatesOn(g) || !g.other || typeof g.other !== 'object') return null;
  const below = g.dir !== 'below', y = Number.isFinite(g.other.y) ? g.other.y : undefined, r = Number.isFinite(g.other.r) ? g.other.r : undefined;
  const beyond = x => x === undefined || (below ? x < g.y : x > g.y);
  if ((y === undefined && r === undefined) || !beyond(y) || !beyond(r) || (y !== undefined && r !== undefined && (below ? r > y : r < y))) return null;
  return { y, r, below };
}
// where a value is by a cell's lines: 0, 1 (yellow) or 2 (red), and on which side (0 its own, 1 the other)
function gateLevel(g, v) {
  if (!gatesOn(g) || v == null) return { raw: 0, side: 0 };
  const past = x => g.dir !== 'below' ? v >= x : v <= x;
  if (g.mode === 'yr' && Number.isFinite(g.r) && past(g.r)) return { raw: 2, side: 0 };
  if (past(g.y)) return { raw: 1, side: 0 };
  const o = otherOf(g), po = x => x !== undefined && (o.below ? v <= x : v >= x);
  if (o && po(o.r)) return { raw: 2, side: 1 };
  if (o && po(o.y)) return { raw: 1, side: 1 };
  return { raw: 0, side: 0 };
}
// a cell's lines for the graphs: y and r, and the other side's as y2 and r2
// a graph's values and its lines as the cell shows them (GB for memory)
const gbArr = (a, k) => k === 1 || !a ? a : a.map(x => x == null ? x : x * k);
const gbDet = (d, k) => { if (k === 1) return d; const o = {}; for (const n in d) o[n] = typeof d[n] === 'number' ? d[n] * k : d[n]; return o; };
function gateLines(g) {
  if (!gatesOn(g)) return {};
  const o = otherOf(g);
  return { y: g.y, r: g.mode === 'yr' && Number.isFinite(g.r) ? g.r : undefined, y2: o ? o.y : undefined, r2: o ? o.r : undefined };
}
function evalCell(cid, c, peek, quick) {
  const out = evalCell0(cid, c, peek, quick), r = c.key ? BYKEY.get(c.key) : null, xk = xkOf(r);
  if (xk && xk.after) xk.after(out, r, c, cid);
  if (EXT.after) EXT.after(out, r, c, cid);
  if (!peek && out.lvl && !out.calm && cellEp[cid]) cellEp[cid].sub = out.sub;   // (a warning second's words as shown, a build's own included: its calm seconds say them)
  return out;
}
function evalCell0(cid, c, peek, quick) {
  const r = c.key ? BYKEY.get(c.key) : null, live = feed.status === 'ok';
  if (!peek && r && r.at !== nowTs) peek = true;   // (a value that didn't come with this second's tick, a key just subscribed or one left from before: judged at the tick that brings it)
  const v = cellValue(c);
  const out = { v, lvl: 0, warm: 0, warmR: 0, sub: '', curve: null, col: 'white' };
  const xk = xkOf(r);
  if (xk && xk.eval && xk.eval(out, r, c)) return out;
  if (isBneck(c)) {   // a call in words, no lines; its caption is the split of the last 15 min
    // (no game: what the GPU and CPU say right now, the strip and the history stay a game's)
    const b = bnStrip(), w = BN[v] ? BN[bnNow() || v] : null, lw = !w && BN[feed.bnl] ? BN[feed.bnl] : null;
    out.txt = w ? w[0] : lw ? lw[0] : '--'; out.utxt = w ? w[1] : lw ? lw[1] : ''; out.strip = b;
    out.col = (w || lw) && live ? 'white' : 'grey';
    out.sub = w ? bnSplit(b) : !bnInputs() ? 'needs GPU usage and CPU thread usage' : feed.game && !live ? 'waiting for HWiNFO' : 'no game running';
    return out;
  }
  // the game session so far, as a length (its lines in minutes, like the host's); with no game: --
  const gt = c.key === GTIME, gtSub = () => feed.game ? feed.game + (feed.front ? '' : ' (in the background)') : 'no game running';
  if (gt && v == null) { if (!peek) calmGone(cid); out.txt = '--'; out.utxt = ''; out.sub = gtSub(); out.col = 'grey'; return out; }
  if (v == null) {
    if (!peek) calmGone(cid);
    out.col = 'grey';
    if (c.pred && !BYKEY.get(c.curve && c.curve.src)) out.sub = 'its temperature is missing';
    return out;
  }
  let raw = 0, hold = 0, side = 0;
  const g = c.gates, dec0 = decOfCell(c, r), pmOff = isPM(r) && !feed.pm, o = otherOf(g);
  if (gatesOn(g) && !pmOff) {
    const above = g.dir !== 'below';
    ({ raw, side } = gateLevel(g, v));
    // closing in on a line: border and graph fade toward its colour, in steps, over the cell's fade (gates.fade, in the
    // reading's own units; 0 none) or by default the last 12% (at least 3 steps of the cell's precision: 3 degrees,
    // 0.003 V); toward yellow before it, toward red past yellow. A yes/no reading is yes or no, nothing in between
    const fadeTo = (x, up) => {
      if (x === undefined || !Number.isFinite(x)) return 0;
      const span = Number.isFinite(g.fade) ? g.fade : Math.max(Math.abs(x) * 0.12, dec0 > 1 ? 3 * Math.pow(10, -dec0) : 3), d = up ? x - v : v - x;
      return span > 0 && d >= 0 && d < span ? Math.round((1 - d / span) * 20) / 20 : 0;
    };
    if (!raw && !isYN(r)) out.warm = Math.max(fadeTo(g.y, above), o ? fadeTo(o.y !== undefined ? o.y : o.r, !o.below) : 0);
    else if (raw === 1 && !isYN(r)) out.warmR = side ? (o && o.y !== undefined ? fadeTo(o.r, !o.below) : 0) : g.mode === 'yr' ? fadeTo(g.r, above) : 0;
    hold = g.hold || 0;
  }
  if (c.curve && !c.pred) {
    const src = BYKEY.get(c.curve.src), exp = src ? interp(c.curve.pts, src.v) : null;
    if (exp != null) {
      const dev = exp > 0 ? (v - exp) / exp * 100 : 0;
      out.curve = { exp, dev, src };
      // (a curve that doesn't warn only says how far off it is)
      if (Math.abs(dev) > c.curve.tol && raw < 1 && c.curve.warn !== false) { raw = 1; hold = c.curve.hold || 0; out.offCurve = true; }
    }
  }
  // a gate only turns after the value stayed past it for the hold time; while the feed isn't live (HWiNFO stalled or
  // gone) the clock stops at its last live moment, so a frozen value turns nothing
  const now = live ? (feed.liveAt = nowTs) : feed.liveAt || 0;   // (the host's seconds, as the log counts the hold)
  // like the warning log: an episode going on keeps its colour through a calm second or two (it ends on the 3rd calm
  // second, counted in the host's seconds as the log counts them), so a value hovering on its line doesn't turn the cell
  // white for the whole hold after each dip. A calm second shows the last warning second as it was (its level and its
  // words, ep.lvl and ep.sub); back past its line within the episode, it is capped by the episode's worst (ep.peak).
  // Seconds with no value (no game for Game time, a reading gone) are calm ones too (calmGone)
  const ep = cellEp[cid] || (cellEp[cid] = { lvl: 0, peak: 0, calmTs: 0, off: false, sub: '' });
  // (while the feed isn't live the log judges nothing: no hold starts or ends, no calm second counts, see 'tick')
  if (!peek && live) { if (raw) { if (!holdSince[cid]) holdSince[cid] = now; } else delete holdSince[cid]; }
  if (!peek && live) { if (raw) ep.calmTs = 0; else if (ep.lvl && !ep.calmTs) ep.calmTs = nowTs; if (ep.lvl && ep.calmTs && nowTs - ep.calmTs >= 2) { ep.lvl = ep.peak = 0; ep.calmTs = 0; } }
  // (only while what warned is still there: the lines, or the curve)
  const keep = ep.lvl && (ep.off ? !!out.curve : gatesOn(g) && !pmOff);
  out.lvl = raw && holdSince[cid] && now - holdSince[cid] >= hold ? raw : keep ? (raw ? Math.min(raw, ep.peak) : ep.lvl) : 0;
  const calm = out.calm = !!out.lvl && !raw;   // (out.calm: for a build's own words too)
  if (calm && ep.off) out.offCurve = true;
  out.col = !live ? 'grey' : out.lvl === 2 ? 'red' : out.lvl === 1 ? 'yellow' : 'white';
  if (out.lvl) out.warm = 0;
  if (out.lvl !== 1) out.warmR = 0;   // (toward red only once it shows yellow)
  if (raw && !out.lvl && !out.offCurve && !isYN(r)) out.warm = 1;   // (past the line, waiting out the hold: as close as it gets)
  const dec = dec0, k = gbK(r), fl = x => fmt(x * k, dec);
  if (calm) out.sub = ep.sub;
  else if (pmOff && gatesOn(g) && !out.curve) out.sub = 'lines count while a game is in front';
  else if (out.lvl && side) out.sub = (o.below ? 'under ' : 'over ') + (out.lvl === 2 || o.y === undefined ? 'red ' + fl(o.r) : 'yellow ' + fl(o.y));   // (a side with a red line only: its words)
  else if (out.lvl === 2) out.sub = (g.dir === 'below' ? 'under red ' : 'over red ') + fl(g.r);
  else if (out.lvl === 1 && !out.offCurve) out.sub = (g.dir === 'below' ? 'under yellow ' : 'over yellow ') + fl(g.y);
  else if (out.curve) {
    const d = Math.round(out.curve.dev);
    out.sub = Math.abs(out.curve.dev) <= c.curve.tol ? 'on curve, expects ' + fmt(out.curve.exp, 0) : Math.abs(d) + '% ' + (d < 0 ? 'under' : 'over') + ' its curve';
  } else if (c.pred) {
    const src = BYKEY.get(c.curve.src);
    out.sub = src ? 'from ' + src.label + ' ' + fmt(src.v, decFor(src)) + (src.unit ? ' ' + src.unit : '') : 'its temperature is missing';
  } else if (memPair(r) && memPair(r).v != null && v > 0) {   // memory: how much of it is in use
    const size = memSize((v + memPair(r).v) / 1024);
    out.sub = Math.round(v / 1024 / size * 100) + '% of ' + size + ' GB';
  } else if (r && !quick && !isYN(r)) {
    let mx = -Infinity; for (const x of series(r.key, HLEN)) if (x > mx) mx = x;
    out.sub = isFinite(mx) ? '15 min max ' + fl(mx) + (unitOf(r) ? ' ' + unitOf(r) : '') : '';
  }
  if (gt) {
    out.txt = durTxt(v * 60); out.utxt = '';
    if (calm) out.sub = ep.sub;
    else if (!out.lvl) out.sub = gtSub();
    else { const ln = side ? o : g, below = side ? o.below : g.dir === 'below'; out.sub = (below ? 'under ' : 'over ') + (out.lvl === 2 || ln.y === undefined ? 'red ' + durTxt(ln.r * 60) : 'yellow ' + durTxt(ln.y * 60)); }
  }
  if (!peek && out.lvl && raw) { ep.lvl = out.lvl; ep.peak = Math.max(ep.peak, out.lvl); ep.off = !!out.offCurve; ep.sub = out.sub; }   // (a warning second: what its calm seconds show)
  return out;
}
const sparkColor = (e, hero) => e.col === 'yellow' ? COLORS.yellow : e.col === 'red' ? COLORS.red : e.col === 'grey' ? '#3a3a3a' : hero ? '#8f8f8f' : '#7c7c7c';
const graphCol = (e, hero) => { const base = sparkColor(e, hero); return e.warm ? mixHex(base, COLORS.yellow, e.warm * 0.75) : e.warmR ? mixHex(base, COLORS.red, e.warmR * 0.75) : base; };

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
  const a = num(old), b = num(s), up = a === null || b === null || Math.abs(b) >= Math.abs(a), roll = motionOn();   // the digits show the size: -5 to -7 rolls up
  const shape = x => x.replace(/[0-9]/g, '0');
  el._t = el._ot = s;
  if (!built || shape(old) !== shape(s)) {
    // a new shape (987 to 1,012, -1 to 0) has no digit-for-digit roll that reads right: it just shows
    let h = '';
    for (const ch of s) h += ch >= '0' && ch <= '9' ? '<span class="od"><span class="odh">' + ch + '</span><span class="odr" aria-hidden="true">' + REEL + '</span></span>' : '<span>' + esc(ch) + '</span>';
    el.innerHTML = h;
    const cells = [...el.children].map((sp, i) => ({ d: +s[i], rl: sp.className === 'od' ? sp.lastChild : null, h: sp.className === 'od' ? sp.firstChild : null }));
    for (const c of cells) if (c.rl) reelAt(c.rl, c.d + 10);
    el._ocells = cells;
    return;
  }
  const cells = el._ocells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]; if (!c.rl) continue;
    const d = +s[i]; if (d === c.d) continue;
    c.d = d; c.h.textContent = s[i];
    if (roll) rollTo(c, d, up); else { rolling.delete(c.rl); c.rl.parentNode.classList.remove('roll'); reelAt(c.rl, d + 10); }
  }
}
// a digit rolls to its place on the motion clock (no CSS transition: that one ran at the screen's refresh rate)
// (the browser animating these itself was measured on 10-13: on a 240 Hz screen it redraws 240 times a second and cost
// more, 48% of a core against 27%)
const rolling = new Set();
const ROLL_MS = 600;
const rollEase = p => 1 - Math.pow(1 - p, 3);
function rollTo(c, d, up) {
  const rl = c.rl;
  // where it is now (mid-roll: its place this step), back on the middle turn of the reel
  let p = rl._p; if (rolling.has(rl)) { rolling.delete(rl); p = rl._to; }
  if (p < 10 || p > 19) p = p % 10 + 10;
  let t = null;
  for (let k = 0; k < 3; k++) { const q = d + 10 * k; if (up ? q >= p && (t === null || q < t) : q <= p && (t === null || q > t)) t = q; }
  if (t === null) t = d + 10;
  if (t === p) { reelAt(rl, p); return; }
  rl.parentNode.classList.add('roll');
  rl._from = p; rl._to = t; rl._r0 = performance.now(); rl._dur = ROLL_MS;
  reelAt(rl, p); rolling.add(rl); motionRun();
}
function rollStep(now) {
  for (const rl of rolling) {
    if (!rl.isConnected) { rolling.delete(rl); continue; }
    const q = Math.min(1, (now - rl._r0) / rl._dur);
    reelAt(rl, rl._from + (rl._to - rl._from) * rollEase(q));
    if (q >= 1) { rolling.delete(rl); rl._p = rl._to; settleReel(rl); }
  }
}
function settleReel(rl) {
  const home = Math.round(rl._p) % 10 + 10;
  if (rl._p !== home) reelAt(rl, home);
  rl.parentNode.classList.remove('roll');
}

// ---------- fan icons turn with their fan: one turn a second at 1500 rpm ----------
function spinWrap(svg) {
  let w = svg.parentNode;
  if (w.className !== 'spw') { w = document.createElement('i'); w.className = 'spw'; svg.replaceWith(w); w.appendChild(svg); spinSeen.observe(w); }
  return w;
}
// a fan out of sight (scrolled away, in a folded category) doesn't keep the clock going
const spinSeen = new IntersectionObserver(es => { for (const e of es) { const svg = e.target.firstChild; if (!svg) continue; svg._seen = e.isIntersecting; if (e.isIntersecting && svg._srate) motionRun(); } });
const unstep = svg => { stepped.delete(svg); if (svg.parentNode) { svg.parentNode.style.transform = ''; spinSeen.unobserve(svg.parentNode); } };
// the motion clock: one timer for all that moves, 30 steps a second in Full; it stops when nothing moves
const MOTION_HZ = 30;
const stepped = new Set();
let motionT = 0, motionAt = 0, graphMore = false;
function motionRun() { if (motionT) return; motionAt = MOTION_HZ; motionT = setInterval(motionTick, 1000 / MOTION_HZ); }
function motionTick() {
  const now = performance.now(), spin = motionOn();
  for (const svg of stepped) if (!svg.isConnected || !spin) unstep(svg);
  const turning = s => s._srate && s._seen !== false;
  const fans = [...stepped].some(turning);
  if (!fans && !rolling.size && !graphMore) { clearInterval(motionT); motionT = 0; return; }
  if (document.hidden) return;
  for (const svg of stepped) if (turning(svg)) { svg._ang = (svg._ang + svg._srate * 360 / motionAt) % 360; svg.parentNode.style.transform = 'rotate(' + svg._ang.toFixed(1) + 'deg)'; }
  rollStep(now);
  if (graphMore) { graphMore = false; kickGraphs(); }
}
function spinIcon(svg, rpm) {
  if (!svg) return;
  const rate = motionOn() && rpm > 0 && feed.status === 'ok' ? Math.max(0.05, Math.round(rpm / 1500 * 20) / 20) : 0;
  if (!rate && !stepped.has(svg)) return;
  const w = spinWrap(svg);
  if (!stepped.has(svg)) spinSeen.observe(w);   // (again after a stop that kept its wrapper: Minimal, then Full)
  svg._srate = rate; if (svg._ang == null) svg._ang = 0;
  stepped.add(svg);
  if (rate) motionRun();
}
const pauseSpin = svg => { if (svg) svg._srate = 0; };
function sweepSpins() { for (const s of stepped) if (!s.isConnected) unstep(s); }
function glow(r, lvl) {
  if (motionMode() === 'off') return;
  const c = lvl === 2 ? '229,72,77' : '230,200,74';
  const kf = [{ boxShadow: 'inset 0 0 0 999px rgba(' + c + ',0.16)' }, { boxShadow: 'inset 0 0 0 999px rgba(' + c + ',0)' }];
  for (const el of r.root.tagName === 'TR' ? [...r.root.children] : [r.root]) el.animate(kf, { duration: 1800, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
}

// ---------- graphs: 15 min that scroll with time; each new second the line morphs into the new one ----------
const GDUR = 500;
const graphs = new Map();
let graphRaf = 0;
const easeOut = p => 1 - Math.pow(1 - p, 3);
const easeInOut = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
function graphState(c) {
  const bs = buckets(c), pts = [];
  for (let i = 0; i < bs.length; i++) { if (bs[i].v === null) continue; pts.push({ s: bs[i].b, v: bs[i].v, x: i === bs.length - 1 ? (nowTs + 1) / BUCKET : bs[i].b + 0.5 }); }
  if (pts.length < 2) return null;
  let lo = Infinity;
  for (const q of pts) if (q.v < lo) lo = q.v;
  const r = BYKEY.get(c.key), sc = scaleTop(pts.map(q => q.v), c.pred ? 'RPM' : r && r.unit), floor0 = lo >= 0;   // (see scaleTop: the span for its unit, a spike cut at the top)
  let hi = sc.top;
  const dec = c.pred ? 0 : decOfCell(c, r);
  const minSpan = Math.max(minSpanOf(c.pred ? 'RPM' : r && r.unit), dec > 1 ? Math.pow(10, 1 - dec) : 1, Math.abs(hi) * 0.04);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; if (floor0 && lo < 0) { hi -= lo; lo = 0; } }
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
  // (a slide too small to see isn't played, just drawn once: most seconds a steady reading moves under a pixel, and those
  // slides were most of Full's cost, 27% of a core with 40 cells against 19% without them, 10-13)
  if (!G.to || !motionOn() || !seenMove(G.cur || G.to, st, G)) { G.cur = G.from = G.to = st; G.t0 = 0; } else { G.from = G.cur || G.to; G.to = st; G.t0 = now; }
  G.dirty = true; kickGraphs();
}
// would a slide from a to b show? The line's scroll, its span and each point's height, in pixels on this canvas
function seenMove(a, b, G) {
  if (!a || !b) return true;
  const w = G.cw || 300, h = G.ch || 60, px = 0.75;
  if (Math.abs(b.end - a.end) / b.span * w >= px || Math.abs(b.span - a.span) / b.span * w >= px) return true;
  const ya = v => (v - a.lo) / (a.hi - a.lo) * h, yb = v => (v - b.lo) / (b.hi - b.lo) * h;
  for (const q of b.pts) { const o = a.map.get(q.s); if (!o || Math.abs(yb(q.v) - ya(o.v)) >= px) return true; }
  return false;
}
function kickGraphs() { if (!graphRaf) graphRaf = requestAnimationFrame(graphLoop); }
function graphLoop(now) {
  graphRaf = 0;
  let more = false;
  const todo = [];
  for (const [cv, G] of graphs) {
    if (!cv.isConnected) { graphs.delete(cv); continue; }
    const p = G.t0 ? Math.min(1, (now - G.t0) / GDUR) : 1, rv = G.rev0 ? Math.min(1, (now - G.rev0) / 800) : 1;
    const moving = p < 1 || rv < 1;
    if (!moving && !G.dirty) continue;
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
  if (more) { graphMore = true; motionRun(); }   // (the next step on the motion clock, 30 a second)
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
  const pad = 5 * dpr, x0 = st.end - st.span, X = x => 1 + (x - x0) / st.span * (w - 1 - pad), Y = v => h - 3 * dpr - (Math.min(st.hi, Math.max(st.lo, v)) - st.lo) / (st.hi - st.lo) * (h - 3 * dpr - pad);   // (a cut spike at the top edge)
  ctx.save();
  if (rev < 1) { ctx.beginPath(); ctx.rect(0, 0, w * rev, h); ctx.clip(); }
  // a stretch with no readings (HWiNFO away) is a gap, not a straight line across it
  const segs = [];
  st.pts.forEach((q, i) => { if (!i || q.s - st.pts[i - 1].s > 2) segs.push([]); segs[segs.length - 1].push(q); });
  ctx.beginPath();
  for (const sg of segs) sg.forEach((q, i) => i ? ctx.lineTo(X(q.x), Y(q.v)) : ctx.moveTo(X(q.x), Y(q.v)));
  ctx.strokeStyle = G.col; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.4 * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();
  ctx.fillStyle = G.col;   // a reading on its own between gaps (a line needs two) still shows, as a dot
  for (const sg of segs) if (sg.length === 1) { ctx.beginPath(); ctx.arc(X(sg[0].x), Y(sg[0].v), 1.1 * dpr, 0, 7); ctx.fill(); }
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
  return '<span class="grip" title="Drag to move the category: onto another one\'s edge to put them side by side or stack them">' + ICONS.grip + '</span><button class="ib chev" title="Collapse">' + ICONS.chev + '</button>' + (inner || '') +
    '<span class="cn" title="Click to select, double-click to rename">' + esc(cat.name) + '</span><span class="cnt">' + cat.cells.length + '</span>' +
    '<span class="acts"><button class="ib ren" title="Rename">' + ICONS.pen + '</button><button class="ib del" title="Remove the category and its cells">' + ICONS.x + '</button></span>' +
    (EXT.head ? xHead(cat) : '');
}
const xHead = cat => { const h = EXT.head(cat); return h ? '<span class="xh" data-x="1">' + h + '</span>' : ''; };
const catCls = cat => 'dcat' + (cat.collapsed ? ' collapsed' : '') + (cat.cells.length ? '' : ' isempty') + (cat.id === selCat ? ' csel' : '');
const cellsOf = cat => cat.cells.filter(id => S.L.cells[id]);
const catById = id => S.L.cats.find(c => c.id === id);
// the view being drawn: a "Start from" template shows itself while the pointer rests on it, without being kept
let preview = null;   // { vn, view }
const viewOf = vn => preview && preview.vn === vn ? preview.view : S.L.views && S.L.views[vn] || null;
const stored = vn => S.L.views && S.L.views[vn] || null;
const isCustom = vn => { const v = viewOf(vn); return !!(v && v.rows); };
const catLook = (id, vn) => { const v = viewOf(vn || S.screen); return v && v.cat && v.cat[id] || {}; };
const cellLook = (id, vn) => { const v = viewOf(vn || S.screen); return v && v.cell && v.cell[id] || {}; };
const cellSize = id => { const l = cellLook(id, 'tiles'); return isSz(l.size) ? { w: SZ[l.size][0], h: SZ[l.size][1] } : { w: l.w || 1, h: l.h || 1 }; };
// a category's cells in this view: its lead (the reading it shows first) moves to the front
function idsIn(cat) {
  const ids = cellsOf(cat), lead = catLook(cat.id).lead, i = lead ? ids.indexOf(lead) : -1;
  return i > 0 ? [lead].concat(ids.slice(0, i), ids.slice(i + 1)) : ids;
}
const nameIn = cid => cellLook(cid).name || cellName(S.L.cells[cid]);
const headTab = () => S.edit ? ' tabindex="0"' : '';
function tileHtml(cid, lk, pre) {
  const c = S.L.cells[cid], r = c.key ? BYKEY.get(c.key) : null, miss = isMissing(c), short = !!lk && lk.size === 'short', z = cellSize(cid), nm = nameIn(cid);
  const xb = miss ? null : xBody(cid, r, short ? 'short' : 'tile');
  const graph = xb != null ? xb : c.graph === false ? '' : isBneck(c) ? '<span class="strip"></span>' : short ? '' : '<canvas></canvas>';
  const nog = xb == null && (miss || c.graph === false || (short && !isBneck(c)));
  return '<div class="tile dc' + (c.pred ? ' pred' : '') + (short ? ' short' : '') + (miss ? ' missing' : '') + (nog ? ' nog' : '') + (isBneck(c) ? ' bn' : '') + (cid === sel ? ' sel' : '') + (pre ? pre[1] : '') + anim() + (pre ? ';' + pre[0] : '') + '" data-cid="' + esc(cid) + '" data-k="tile" tabindex="0"' +
    (z.w !== 1 ? ' data-w="' + z.w + '"' : '') + (z.h !== 1 ? ' data-h="' + z.h + '"' : '') + (cellLook(cid, 'tiles').nl ? ' data-nl="1"' : '') + '>' +
    '<div class="tn">' + iconOf(c, r) + '<span>' + esc(nm) + '</span></div>' +
    '<div class="tv"><span class="v"></span><small class="u">' + esc(c.pred ? 'RPM' : unitOf(r)) + '</small></div><div class="tc"></div>' +
    (miss ? (S.edit ? '<button class="btn rl">Re-link</button>' : '') : graph) + (S.edit ? '<span class="corner" title="Drag to size it: it snaps to quarter steps, to the edges of other tiles and to the bottom of the columns beside it. Hold Alt for any size, double-click for a normal tile">' + ICONS.corner + '</span>' : '') + '</div>';
}
// Tiles: a block per category, a tile per cell (auto: blocks past 6 cells take the whole width)
function blkHtml(cat, inRows) {
  const ids = idsIn(cat), lk = catLook(cat.id), pm = packMemo.get(cat.id), pre = pm && pm.cids === ids.join('|') && pm.edit === S.edit ? pm : null;
  const tgStyle = (lk.per ? '--per:' + lk.per + ';' : '') + (pre ? pre.tgStyle : '');
  return '<section class="blk ' + catCls(cat) + (!inRows && ids.length > 6 ? ' wide' : '') + (lk.title === 'hide' ? ' notitle' : '') + '" data-cat="' + esc(cat.id) + '"><h2 class="dch"' + headTab() + '>' + catHead(cat) + '</h2>' +
    '<div class="tg dgrid' + (lk.size === 'short' ? ' shorts' : '') + (lk.per ? ' per' : '') + (pre ? ' pk' + pre.tgCls : '') + '"' + (tgStyle ? ' style="' + tgStyle + '"' : '') + '>' +
    ids.map((id, j) => tileHtml(id, lk, pre ? pre.tiles[j] : null)).join('') + '</div></section>';
}
// Overview: a card per category (its first cell large, the rest rows with a 15 min graph), a small card, a list
// (rows only) or a band (the name on the left, every cell side by side)
function cardHtml(cat) {
  const ids = idsIn(cat), lk = catLook(cat.id), first = ids.length ? S.L.cells[ids[0]] : null;
  const icon = first ? iconOf(first, first.key ? BYKEY.get(first.key) : null) : ICONS.mem;
  const cls = catCls(cat) + (lk.title === 'hide' ? ' notitle' : '');
  const bits = cid => {
    const c = S.L.cells[cid], r = c.key ? BYKEY.get(c.key) : null, miss = isMissing(c);
    return { c, r, miss, u: esc(c.pred ? 'RPM' : unitOf(r)), cls: (miss ? ' missing' : '') + (cid === sel ? ' sel' : ''), on: c.graph !== false && !miss, bn: isBneck(c), xb: miss ? null : xBody(cid, r, lk.style === 'band' ? 'band' : 'row'), nm: '<span class="nm">' + iconOf(c, r) + '<span>' + esc(nameIn(cid)) + '</span></span>' };
  };
  const val = u => '<span class="val"><span class="v"></span><small class="u">' + u + '</small></span>';
  const rl = '<button class="btn rl">Re-link</button>';
  if (lk.style === 'band')
    return '<section class="card band ' + cls + anim() + ';--n:' + Math.max(1, ids.length) + '" data-cat="' + esc(cat.id) + '"><div class="bh"><div class="ch dch"' + headTab() + '>' + catHead(cat, icon) + '</div><span class="tag"></span></div>' +
      '<div class="dgrid bcells">' + ids.map(cid => {
        const b = bits(cid);
        return '<div class="bcell dc' + b.cls + '" data-cid="' + esc(cid) + '" data-k="row" tabindex="0"><div class="bl"><span class="lbl">' + b.nm + '<i></i></span>' + val(b.u) + '</div>' +
          (b.xb != null ? b.xb : b.on ? (b.bn ? '<span class="strip rsp"></span>' : '<canvas class="rsp"></canvas>') : b.miss && S.edit ? rl : '<span class="gph"></span>') + '</div>';
      }).join('') + '</div></section>';
  const hero = lk.style !== 'list';
  return '<section class="card ' + cls + (lk.style === 'small' ? ' small' : '') + (lk.style === 'list' ? ' list' : '') + anim() + '" data-cat="' + esc(cat.id) + '"><div class="ch dch"' + headTab() + '>' + catHead(cat, icon) + '<span class="tag"></span></div>' +
    '<div class="dgrid vert">' + ids.map((cid, i) => {
      const b = bits(cid);
      if (i === 0 && hero) return '<div class="hero dc' + b.cls + '" data-cid="' + esc(cid) + '" data-k="hero" tabindex="0"><div><div class="nm">' + iconOf(b.c, b.r) + '<span>' + esc(nameIn(cid)) + '</span></div>' +
        '<div class="hv"><span class="v"></span><small class="u">' + b.u + '</small></div><div class="hc"></div>' + (b.miss && S.edit ? rl : '') + '</div>' +
        (b.xb != null ? xBody(cid, b.r, 'hero') : b.on ? (b.bn ? '<span class="strip"></span>' : '<canvas></canvas>') : '<span></span>') + '</div>';
      const mid = b.xb != null ? b.xb : b.on ? (b.bn ? '<span class="strip rsp"></span>' : '<canvas class="rsp"></canvas>') : b.miss && S.edit ? rl : '';
      return '<div class="row dc' + b.cls + (mid ? '' : ' nog') + '" data-cid="' + esc(cid) + '" data-k="row" tabindex="0"><span class="lbl">' + b.nm + '<i></i></span>' + mid + val(b.u) + '</div>';
    }).join('') + '</div></section>';
}
// what a view's rows hold right now: outside edit mode an empty category isn't shown, so it takes no room
function visRows(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const cols = [];
    r.cols.forEach((c, j) => {
      const stack = c.stack.filter(s => { const cat = catById(sid(s)); return cat && (S.edit || cellsOf(cat).length); });
      if (stack.length) cols.push({ w: c.w, stack, i: j });
    });
    if (cols.length) out.push({ h: r.h, cols, i });
  });
  return out;
}
// the narrowest a column can be before its row folds (in rem): one tile (Auto), its tiles per row, or a card
function colMin(c) {
  const v = viewOf(S.screen), sp = v && v.gap === 'tight' ? 0.6 : v && v.gap === 'roomy' ? 1.5 : 1;
  let m = 0;
  for (const s of c.stack) {
    const cat = catById(sid(s)), lk = catLook(cat.id), n = cellsOf(cat).length;
    let b;
    if (S.screen === 'tiles') { if (lk.per) { const k = Math.max(1, Math.min(lk.per, n || 1)); b = k * 8.5 + (k - 1) * 0.62 * sp; } else b = lk.size === 'short' ? 15 : 10.5; }
    else b = 22;   // a card, a list, a band (it wraps its cells when narrow)
    m = Math.max(m, b);
  }
  return Math.round(m * 10) / 10;
}
const colTracks = cols => cols.map(c => 'minmax(0, ' + (c.w || 1) + 'fr)').join(' ');
const manualRow = r => r.cols.length > 1 && r.cols.every(c => c.w);
// your own arrangement: rows of columns, a column a stack of categories, each as tall as what it holds. A row without
// widths of yours gets widths that follow its content (layoutPass); in edit mode the lines between columns and the
// strip under a Tiles row are handles
function arrHtml(cls, v, block, auto) {
  const rows = visRows(v.rows), tiles = S.screen === 'tiles';
  let h = '';
  for (const r of rows) {
    const manual = manualRow(r);
    h += '<div class="lrow" data-r="' + r.i + '"' + (manual ? '' : ' data-auto="1"') + (tiles && r.h ? ' data-fill="1"' : '') + ' style="--cols:' + colTracks(manual ? r.cols : r.cols.map(() => ({}))) + '">';
    for (const c of r.cols) h += '<div class="lcol" data-c="' + c.i + '" data-min="' + colMin(c) + '">' + c.stack.map(s => block(catById(sid(s)), true)).join('') + '</div>';
    if (S.edit && !auto) {   // (Automatic has no handles: a drop makes it your own first)
      for (let k = 0; k < r.cols.length - 1; k++) h += '<span class="ldiv" data-k="' + k + '" title="Drag to change the widths, double-click to let them follow what each column holds"></span>';
      if (tiles) h += '<span class="lrs" title="Drag down to let its tiles grow into spare room (Fill), up to keep them as they are (Fit)"></span>';
    }
    h += '</div>';
  }
  return '<div class="' + cls + ' arr' + (auto ? ' auto' : '') + (v.gap ? ' gap-' + v.gap : '') + '" id="view">' + h + '</div>';
}
// Automatic: the categories in balanced columns (see below), in as many columns as the
// window has room for (30rem each in Tiles, 27rem in Overview); the widths then follow what each column holds, as in a
// row of your own, so the columns end about level. Making it your own starts from exactly this (lastAuto)
const lastAuto = {};
function autoRows(vn) {
  // (empty categories, shown only in edit mode, go at the end: the others sit where they do outside edit mode)
  const cats = S.L.cats.filter(c => cellsOf(c).length);
  if (!cats.length) return S.L.cats.length ? [{ cols: [{ stack: S.L.cats.map(c => c.id) }] }] : [];
  const v = viewOf(vn), sp = v && v.gap === 'tight' ? 0.6 : v && v.gap === 'roomy' ? 1.5 : 1, fs = cssScale();
  const W = Math.max(1, sectionsEl.clientWidth - 36) / fs, gap = (vn === 'tiles' ? 1.7 : 0.92) * sp, min = vn === 'tiles' ? 30 : 27;
  const n = Math.max(1, Math.min(MAXC[vn], cats.length, Math.floor((W + gap) / (min + gap) + 1e-6))), colW = (W - (n - 1) * gap) / n, g = 0.62 * sp;
  // how tall a category comes out in a column that wide (rem, roughly: it only decides where categories go)
  const tall = cat => {
    if (cat.collapsed) return 2.4;
    const ids = cellsOf(cat), lk = catLook(cat.id, vn);
    if (vn === 'tiles') {
      const short = lk.size === 'short', k = Math.max(1, lk.per ? Math.min(lk.per, Math.floor((colW + g) / (8.5 + g))) : Math.floor((colW + g) / ((short ? 15 : 10.5) + g)));
      const area = ids.reduce((a, id) => { const z = cellSize(id); return a + Math.min(z.w, k) * z.h; }, 0);
      return 2.2 + Math.max(1, Math.ceil(area / k - 1e-6)) * ((short ? 3.4 : 8.6) + g);
    }
    if (lk.style === 'band') return 5;
    return 4.2 + (lk.style === 'list' ? 0 : lk.style === 'small' ? 4.6 : 7.3) + Math.max(0, ids.length - (lk.style === 'list' ? 0 : 1)) * 2.9;
  };
  // the biggest first, each into the column that is shortest so far (the columns come out about level); then each
  // column in your order, and the columns in the order of their first category
  const cols = Array.from({ length: n }, () => ({ stack: [], h: 0 })), at = new Map(cats.map((c, i) => [c.id, i]));
  for (const c of cats.map(c => [c, tall(c)]).sort((a, b) => b[1] - a[1] || at.get(a[0].id) - at.get(b[0].id))) {
    const col = cols.reduce((a, b) => b.h < a.h - 0.01 ? b : a); col.stack.push(c[0].id); col.h += c[1] + gap;
  }
  for (const c of cols) c.stack.sort((a, b) => at.get(a) - at.get(b));
  const rows = [{ cols: cols.filter(c => c.stack.length).sort((a, b) => at.get(a.stack[0]) - at.get(b.stack[0])).map(c => ({ stack: c.stack })) }];
  for (const c of S.L.cats) if (!cats.includes(c)) rows[0].cols[rows[0].cols.length - 1].stack.push(c.id);   // (empty ones, hidden outside edit mode)
  return rows;
}
function buildTiles() {
  const v = viewOf('tiles');
  if (v && v.rows) return arrHtml('tl', v, blkHtml);
  lastAuto.tiles = autoRows('tiles');
  return arrHtml('tl', { gap: v && v.gap, rows: lastAuto.tiles }, blkHtml, true);
}
function buildOverview() {
  const v = viewOf('overview');
  if (v && v.rows) return arrHtml('ov', v, cardHtml);
  lastAuto.overview = autoRows('overview');
  return arrHtml('ov', { gap: v && v.gap, rows: lastAuto.overview }, cardHtml, true);
}
// Automatic Grid: one table, or two side by side when one table would have to go under the size two can have (set by the
// width: #sections' padding and the gap, 1 px to spare). autofit works it out and keeps it per window and content
// (gridN), so it never hangs on the size the view before it left
const gridN = {}; let gridForce = 0;
const gridLim = () => (sectionsEl.clientWidth - 37) / (2 * 44 + 0.92);
function buildGrid() {
  const table = list => '<div class="gtable' + anim() + '"><table class="gt"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c6"><col class="c7"></colgroup>' +
    '<thead><tr><th class="l">sensor</th><th>current</th><th title="HWiNFO\'s own, since it started or was reset">min</th><th title="HWiNFO\'s own, since it started or was reset">max</th><th title="HWiNFO\'s own, since it started or was reset">average</th><th>lines</th><th class="l">info</th></tr></thead>' +
    list.map(({ cat, ids, cont }) => '<tbody class="' + catCls(cat) + (cont ? ' cont' : '') + '" data-cat="' + esc(cat.id) + '"><tr class="ghdr"><td colspan="7">' +
      (cont ? '<span class="dchw"><span class="cn">' + esc(cat.name) + '</span><span class="contd">continued</span></span>' : '<span class="dchw dch"' + headTab() + '>' + catHead(cat) + '</span>') + '</td></tr>' +
      (ids || idsIn(cat)).map(cid => {
        const c = S.L.cells[cid], r = c.key ? BYKEY.get(c.key) : null, miss = isMissing(c), xb = miss ? null : xBody(cid, r, 'grid');
        return '<tr class="dc' + (miss ? ' missing' : '') + (isBneck(c) ? ' bn' : '') + (cid === sel ? ' sel' : '') + '" data-cid="' + esc(cid) + '" data-k="grow" tabindex="0"><td class="gname">' + iconOf(c, r) + '<span>' + esc(nameIn(cid)) + '</span>' + (miss && S.edit ? '<button class="btn rl">Re-link</button>' : '') + '</td>' +
          '<td class="gval"><span class="v"></span><span class="u gu">' + esc(c.pred ? 'RPM' : unitOf(r)) + '</span></td>' +
          (xb != null ? '<td class="gstrip" colspan="3">' + xb + '</td>' : isBneck(c) && !miss ? '<td class="gstrip" colspan="3">' + (c.graph !== false ? '<span class="strip"></span>' : '') + '</td>' : '<td class="gn"></td><td class="gn"></td><td class="gn"></td>') + '<td class="glines"></td><td class="ginfo"></td></tr>';
      }).join('') + '</tbody>').join('') + '</table></div>';
  const v = viewOf('grid');
  if (v && v.rows) {   // your tables: each column of the one row is a table
    const r = visRows(v.rows)[0], cols = r ? r.cols : [];
    return '<div class="gsplit arr" id="view" style="--gt:repeat(' + Math.max(1, cols.length) + ', minmax(0, 1fr))">' +
      cols.map(c => table(c.stack.map(s => ({ cat: catById(sid(s)) })))).join('') + '</div>';
  }
  // two tables side by side when there is room, cut at the middle line: a long category there goes on in the second
  // table ("continued"), so the two come out about as long
  const items = S.L.cats.map(cat => ({ cat, ids: cat.collapsed ? null : idsIn(cat) })), len = it => (it.ids ? it.ids.length : 0) + 1;
  const half = Math.ceil(items.reduce((a, it) => a + len(it), 0) / 2), t1 = [], t2 = [];
  const two = gridForce ? gridForce === 2 : gridN[fitKey(cssScale())] === 2;   // else one under the other: one table
  let acc = two ? 0 : Infinity;
  if (!two) t1.push(...items);
  else for (const it of items) {
    if (t2.length || acc >= half) { t2.push(it); continue; }
    if (acc + len(it) <= half) { t1.push(it); acc += len(it); continue; }
    const k = half - acc - 1;   // its cells that still fit in the first table
    if (it.ids && k >= 3 && it.ids.length - k >= 3) { t1.push({ cat: it.cat, ids: it.ids.slice(0, k) }); t2.push({ cat: it.cat, ids: it.ids.slice(k), cont: true }); acc = half; }
    else if (!t1.length || acc + len(it) / 2 <= half) { t1.push(it); acc += len(it); }
    else t2.push(it);
  }
  return '<div class="gsplit" id="view">' + (t1.length ? table(t1) : '') + (t2.length ? table(t2) : '') + '</div>';
}
function setupHtml() {
  return '<div class="setup" id="view"><h2>HWiNFO isn\'t sharing its sensors yet</h2><span>' + esc(feed.brand || 'HW Deck') + ' shows what HWiNFO measures. Set HWiNFO up once:</span><ol>' +
    '<li>Install HWiNFO (hwinfo.com) and start it with <b>Sensors-only</b> ticked.</li><li>In its sensors window, click <b>Config</b>, then <b>Main Settings</b>.</li>' +
    '<li>On the <b>General / User Interface</b> tab, tick <b>Shared Memory Support</b>, then OK.</li>' +
    '<li>Keep HWiNFO running. The free version stops sharing after 12 hours. Optional: turn on <b>Keep HWiNFO sharing</b> in Settings and ' + esc(feed.brand || 'HW Deck') + ' restarts it for you, so it never runs out.</li></ol>' +
    '<span>This screen goes away by itself once the readings arrive. Already set up, and still nothing?</span>' +
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
  app.classList.toggle('nocats', !S.L.cats.length && READ.length > 0);
  for (const t of document.querySelectorAll('#view .tg.pk')) {
    const pm = packMemo.get(t.parentElement.dataset.cat); if (!pm) continue;
    t._pk = pm.key; t._H = pm.H; t._L = pm.L; t._tw = pm.tw; unitH.set(t, { narrow: t.classList.contains('narrow'), fs: pm.fs });   // the same tiles: their heights as read last time
    tileKids(t).forEach((x, j) => { x._fit = pm.tiles[j][2]; x._nat = pm.tiles[j][3]; });
  }
  E = new Map();
  for (const el of document.querySelectorAll('#view .dc')) {
    // (never inside a build's own body, .xb: that is extras.js's to fill)
    const q = s => { for (const x of el.querySelectorAll(s)) if (!x.closest('.xb')) return x; return null; }, cid = el.dataset.cid, c = S.L.cells[cid];
    const r = { root: el, cid, kind: el.dataset.k, v: q('.v'), u: q('.u'), vbox: q('.tv, .hv, .val, .gval'), cap: q('.tc, .hc, .lbl i, .ginfo'), canvas: q('canvas'), strip: q('.strip'), lines: q('.glines'), xb: el.querySelector('.xb') };
    if (r.kind === 'grow') r.td = el.children;
    if (c && isFanCell(c)) r.fan = q('.tn svg, .nm svg, .gname svg');
    if (r.canvas) { r.canvas._enter = enterNext; ro.observe(r.canvas); }
    E.set(cid, r);
  }
  CARDS = [...document.querySelectorAll('#view .card')].map(el => ({ el, cat: el.dataset.cat, tag: el.querySelector('.tag') }));
  const view = $('view');
  const mm = motionMode();
  if (mm === 'off' || (mm === 'minimal' && !(enterNext && slideDir))) entrance = null;   // Minimal keeps the view slide, not the wave
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
let drawnHidden = false;   // (a view drawn in the tray: measured again when the window shows)
function renderView(enter) {
  if (enter) enterNext = true;
  if (document.hidden) drawnHidden = true;
  const was = flipNext && !enter ? catRects() : null;   // a layout change: the categories glide from where they were
  flipNext = false;
  buildView();
  updateView(true, true);
  autofit();
  playEntrance();
  if (was) playFlip(was);
  pxFresh();
}
// the selected tile's px size fields follow its drawn size (a resize, the banner, a remeasure): in place, not the
// field being typed in (a whole renderInsp would drop a paste box, the scroll, half-typed curve cells)
function pxFresh() {
  if (!S.edit || !sel || !document.querySelector('#insp input[data-sz="pw"]')) return;
  const z = cellSize(sel), G = tileGeo(tileEl(sel)); if (!G) return;
  const px = { pw: Math.round(pxW(G, z.w)), ph: Math.round(G.at(Math.min(z.w, G.k), z.h).th) };
  for (const k of ['pw', 'ph']) { const b = document.querySelector('#insp input[data-sz="' + k + '"]'); if (b && b !== document.activeElement) b.value = px[k]; }
}
let flipNext = false;
function catRects() { const m = new Map(); if (S.screen !== 'grid') for (const el of document.querySelectorAll('#view .dcat')) m.set(el.dataset.cat, el.getBoundingClientRect()); return m; }
function playFlip(was) {
  const dur = motionOn() ? 280 : 0;
  if (!dur || S.screen === 'grid') return;
  for (const el of document.querySelectorAll('#view .dcat')) {
    const a = was.get(el.dataset.cat); if (!a) continue;
    const b = el.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) + Math.abs(dy) > 1) el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}

// every tick: numbers, colours, captions, graphs; reads first (which cells are in sight), then writes
// a second judged for the cells updateView didn't draw (skipDrawn), or for all of them while a drag holds the redraws
function judgeRest(skipDrawn) {
  for (const cid in S.L.cells) {
    if (skipDrawn && E.has(cid)) continue;
    const c = S.L.cells[cid]; if (!c) continue;
    if (isMissing(c)) calmGone(cid); else evalCell(cid, c, false, true);
  }
}
function updateView(all, peek) {   // (peek: a redraw between seconds, a spark's, judges nothing)
  // seen: gets its number this time (all of them after a rebuild); sight: its graph is drawn (only what is on screen)
  const sr = sectionsEl.getBoundingClientRect(), seen = new Map(), sight = new Map();
  for (const [cid, r] of E) { const b = r.root.getBoundingClientRect(), on = b.bottom > sr.top - 60 && b.top < sr.bottom + 60 && b.height > 0; sight.set(cid, on); seen.set(cid, all || on); }
  const cardLvl = {};
  for (const [cid, r] of E) {
    const c = S.L.cells[cid]; if (!c) continue;
    const rd = c.key ? BYKEY.get(c.key) : null, vis = seen.get(cid);
    if (isMissing(c)) { if (!peek) calmGone(cid); odo(r.v, '--'); setText(r.cap, missingTxt(c)); continue; }
    const e = evalCell(cid, c, !!peek, !vis);
    const cat = catOf(cid); if (cat) cardLvl[cat.id] = Math.max(cardLvl[cat.id] || 0, e.lvl);
    const dec = decOfCell(c, rd);
    if (vis) odo(r.v, e.txt != null ? e.txt : fmtV(e.v, dec, rd));
    if (e.txt != null) setText(r.u, e.utxt);
    const colCls = e.col === 'white' ? '' : e.col;
    if (r.vbox) { for (const k of ['yellow', 'red', 'grey']) r.vbox.classList.toggle(k, colCls === k); }
    if (r.cap) { setText(r.cap, e.sub); r.cap.classList.toggle('y', e.lvl === 1); r.cap.classList.toggle('r', e.lvl === 2); }
    if (r.kind === 'tile') {
      r.root.classList.toggle('yellow', e.lvl === 1); r.root.classList.toggle('red', e.lvl === 2); r.root.classList.toggle('warm', e.warm > 0 || e.warmR > 0);
      const wk = e.warm ? 'y' + e.warm : e.warmR ? 'r' + e.warmR : '';   // (the border fades toward yellow before it, toward red past it)
      if (r._w !== wk) { r._w = wk; r.root.style.setProperty('--wb', e.warm ? mixHex('#242424', '#5c4f1d', e.warm * 0.85) : e.warmR ? mixHex('#5c4f1d', '#6b2020', e.warmR * 0.85) : ''); }
    }
    if (r.kind === 'grow' && e.strip) { if (r.cap.title !== e.sub) r.cap.title = e.sub; if (r.td[1].title !== e.txt + ' ' + e.utxt) r.td[1].title = (e.txt + ' ' + e.utxt).trim(); }
    else if (r.kind === 'grow') {
      const f = x => x == null ? '' : fmtV(x, dec, rd);
      if (!r.xb && isPM(rd)) {   // a game's own readings: HWiNFO's since it started mean nothing (0 and 3,258 fps), so this game session's
        const gs = feed.gs && Array.isArray(feed.gs[c.key]) ? feed.gs[c.key] : null;
        setText(r.td[2], gs ? f(gs[0]) : ''); setText(r.td[3], gs ? f(gs[2]) : ''); setText(r.td[4], gs ? f(gs[1]) : '');
        const tt = gs ? 'This game session, while the game was in front' : 'Shown for a game session, while the game is in front';
        for (const i of [2, 3, 4]) if (r.td[i].title !== tt) r.td[i].title = tt;
      }
      if (!r.xb && !isPM(rd)) {   // (a build's own body sits where min, max and average go)
        setText(r.td[2], c.pred ? '' : f(rd && rd.mn)); setText(r.td[3], c.pred ? '' : f(rd && rd.mx));
        setText(r.td[4], c.pred || !rd || rd.av == null ? '' : isYN(rd) ? Math.round(rd.av) + '% yes' : f(rd.av));
        for (const i of [2, 3, 4]) if (r.td[i].title !== r.td[i]._t) r.td[i].title = r.td[i]._t || '';
      }
      const cur = fmtV(e.v, dec, rd) + (unitOf(rd) && e.v != null ? ' ' + unitOf(rd) : c.pred && e.v != null ? ' RPM' : '');
      if (r.td[1].title !== cur) r.td[1].title = cur;
      if (r.cap && r.cap.title !== (e.sub || '')) r.cap.title = e.sub || '';
      const g = c.gates, gl = gateLines(g), two = gl.y2 !== undefined || gl.r2 !== undefined, gk = gbK(rd), ln = (y, r) => (y !== undefined ? '<span class="y">' + fmtL(y * gk, dec) + '</span>' : '') + (r !== undefined ? (y !== undefined ? '&nbsp; ' : '') + '<span class="r">' + fmtL(r * gk, dec) + '</span>' : '');
      const lh = gatesOn(g) ? (two ? (g.dir === 'below' ? 'under ' : 'over ') : '') + ln(gl.y, gl.r) + (two ? ', ' + (g.dir === 'below' ? 'over ' : 'under ') + ln(gl.y2, gl.r2) : '') : '';
      if (r.lines._h !== lh) { r.lines.innerHTML = lh; r.lines._h = lh; }
    }
    if (r.fan) spinIcon(r.fan, e.v);
    const xk = xkOf(rd); if (xk && xk.update) xk.update(r.root, rd, e, cid);
    if (r._lvl !== undefined && e.lvl > r._lvl) glow(r, e.lvl);
    r._lvl = e.lvl;
    if (r.canvas && sight.get(cid)) graphFeed(r.canvas, c, graphCol(e, r.kind === 'hero'));
    if (r.strip && e.strip && sight.get(cid)) renderStrip(r.strip, e.strip.segs, HLEN);
  }
  for (const k of CARDS) {
    const cat = S.L.cats.find(c => c.id === k.cat); if (!cat) continue;
    const ids = cellsOf(cat), lv = cardLvl[cat.id] || 0;
    let n = 0; for (const id of ids) { const r = E.get(id); if (r && r._lvl) n++; }
    const fans = ids.length && ids.every(id => isFanCell(S.L.cells[id]));
    const own = !n && EXT.tag ? EXT.tag(cat, ids, n) : null;
    const txt = own != null ? own : n ? plural(n, 'warning') : fans ? ids.filter(id => (cellValue(S.L.cells[id]) || 0) > 100).length + ' spinning' : 'all normal';
    if (k.tag) { setText(k.tag, txt); k.tag.className = 'tag' + (lv === 2 ? ' r' : lv === 1 ? ' y' : ''); }
    k.el.classList.toggle('warn-y', lv === 1); k.el.classList.toggle('warn-r', lv === 2);
  }
}

// ---------- fit: in the clean view, the largest scale at which nothing scrolls (it scrolls past 60%) ----------
let fitRatio = 1, fitTimer = 0;
const cssScale = () => Math.min(22, Math.max(12, 0.0048 * Math.min(innerWidth, innerHeight * 1.9) + 7));
// the view has the same room in edit mode (Storage and the settings are drawers over it), so it fits the same way
const fits = () => { layoutPass(); return sectionsEl.scrollHeight <= sectionsEl.clientHeight; };
// what depends on the room at this size (worked out on every fit try): widths that follow content, tiles per row,
// rows too narrow for their columns fold (one under the other, never saved), long Overview cards flow into
// sub-columns, a band too narrow for its cells wraps them, a wide tile in a single column stays one wide
const spOf = v => v.classList.contains('gap-tight') ? 0.6 : v.classList.contains('gap-roomy') ? 1.5 : 1;
// a tile's size as drawn (see SZ), and how many tile places some tiles take at k per row
const szOf = t => ({ w: +t.dataset.w || 1, h: +t.dataset.h || 1, nl: t.dataset.nl === '1' });
const tileKids = tg => [...tg.children].filter(x => x.classList.contains('tile'));
const tileArea = (tiles, k) => tiles.reduce((a, t) => { const s = szOf(t); return a + Math.min(s.w, k) * s.h; }, 0);
// a category's tiles, k places to a row: each goes to the highest, then leftmost, spot where it fits, so a hole left
// (a tile that starts a new row (nl) goes under all the tiles before it, and the ones after it stay there too)
// beside a bigger tile takes a later one that fits it (all normal tiles: a plain grid in reading order). Sizes and
// spots in tiles, a tile's gap included; a tile wider than the row is as wide as the row. Gives the spots and the height
const PE = 1e-6, inRect = (a, b) => a.x >= b.x - PE && a.y >= b.y - PE && a.x + a.w <= b.x + b.w + PE && a.y + a.h <= b.y + b.h + PE;
function packTiles(sz, k) {
  let free = [{ x: 0, y: 0, w: k, h: Infinity }], H = 0;
  const pos = [];
  for (const s of sz) {
    const w = Math.min(s.w, k), h = s.h;
    if (s.nl && H > PE) free = free.map(f => f.y >= H - PE ? f : f.y + f.h > H + PE ? { x: f.x, y: H, w: f.w, h: f.y + f.h - H } : null).filter(Boolean);
    let b = null;
    for (const f of free) if (w <= f.w + SNAPQ && h <= f.h + SNAPQ && (!b || f.y < b.y - PE || (f.y <= b.y + PE && f.x < b.x))) b = f;
    const p = { x: b.x, y: b.y, w, h };
    pos.push(p); H = Math.max(H, p.y + h);
    // the free room it takes splits into what is left around it; room inside other room goes
    const nf = [];
    for (const f of free) {
      if (p.x >= f.x + f.w - PE || p.x + w <= f.x + PE || p.y >= f.y + f.h - PE || p.y + h <= f.y + PE) { nf.push(f); continue; }
      if (p.x > f.x + PE) nf.push({ x: f.x, y: f.y, w: p.x - f.x, h: f.h });
      if (p.x + w < f.x + f.w - PE) nf.push({ x: p.x + w, y: f.y, w: f.x + f.w - p.x - w, h: f.h });
      if (p.y > f.y + PE) nf.push({ x: f.x, y: f.y, w: f.w, h: p.y - f.y });
      if (p.y + h < f.y + f.h - PE) nf.push({ x: f.x, y: p.y + h, w: f.w, h: f.y + f.h - p.y - h });
    }
    const big = nf.filter(f => f.w >= 0.25 - PE && f.h >= 0.25 - PE);   // (no tile is smaller than 0.25 x 0.25)
    free = big.filter((a, i) => !big.some((c, j) => j !== i && inRect(a, c) && (!inRect(c, a) || j < i)));
  }
  return { pos, H: Math.round(H * 1e6) / 1e6 };
}
// each tile's own height (rem) as it is on its own, at least the 8.6rem of a normal tile; read once per drawn view,
// before the tiles are placed (a short category again when it turns narrow: its tiles stack and get taller). (Text
// heights don't scale quite evenly with the text size: the fit tries sizes with what it read first, and the size it
// keeps is read again, exactUnits)
const unitH = new WeakMap();
let exactUnits = false;
// one tile high is the same everywhere in the view: at least the height most normal tiles have (the median of their
// own heights), so a category whose tiles hold less (no caption, no graph) isn't a little shorter than the rest; a tile
// that holds more still makes its row taller
let tileUnit = 8.6;
const natOf = (x, short) => short ? x._nat || 3.4 : Math.max(x._nat || 8.6, tileUnit);
function setTileUnit(tgs) {
  const n = [];
  for (const t of tgs) if (!t.classList.contains('shorts') && !t.closest('.dcat.collapsed')) for (const x of tileKids(t)) n.push(x._nat || 8.6);
  n.sort((a, b) => a - b);
  tileUnit = n.length ? Math.max(8.6, Math.round(n[(n.length - 1) >> 1] * 1000) / 1000) : 8.6;
}
function measureUnits(tgs, fs) {
  const need = tgs.filter(t => { if (t.closest('.dcat.collapsed')) return false; const u = unitH.get(t); return !u || u.narrow !== t.classList.contains('narrow') || (exactUnits && Math.abs(u.fs - fs) > 0.01); });
  if (!need.length) return;
  for (const t of need) { t.classList.remove('pk'); t.classList.add('meas'); }
  const hs = need.map(t => tileKids(t).map(x => x.offsetHeight));
  need.forEach((t, i) => {
    if (!hs[i].some(Boolean)) return;
    const short = t.classList.contains('shorts');
    // a tile at the 8.6rem floor (most) is 8.6 whatever the rounding of its px: its placing stays as it was
    tileKids(t).forEach((x, j) => { if (hs[i][j]) x._nat = short ? hs[i][j] / fs : hs[i][j] <= 8.6 * fs + 1 ? 8.6 : hs[i][j] / fs; });
    unitH.set(t, { narrow: t.classList.contains('narrow'), fs });
  });
}
// the packed tiles in rem: one tile high is a row, as tall as the tallest normal-height tile that starts in it (like a
// grid row; at least the shortest tile of the category); any other height takes its share of the rows it spans. G: the
// gap in rem; even (a Fill row): every row as tall as the tallest. Gives each tile's top and height (ty, th) and the
// height of them all (TH)
function placeTiles(sz, nat, k, G, even) {
  const { pos, H } = packTiles(sz, k), nb = Math.max(1, Math.ceil(H - PE)), bh = Array(nb).fill(Math.min(...nat));
  // (a tile 1 high or more starting on a row needs its own height over the rows it covers: smoothly less per row as it
  // gets taller, so 1.001 high is no jump from 1)
  pos.forEach((p, i) => { const r = Math.round(p.y); if (p.h >= 1 - PE && Math.abs(p.y - r) < PE) { const need = (nat[i] + G) / p.h - G; for (let b = r; b < Math.min(nb, r + Math.floor(p.h + PE)); b++) bh[b] = Math.max(bh[b], need); } });
  if (even) bh.fill(Math.max(...bh));
  const acc = [0]; for (let r = 0; r < nb; r++) acc.push(acc[r] + bh[r] + G);
  const Y = u => { const r = Math.max(0, Math.min(nb - 1, Math.floor(u + PE))); return acc[r] + Math.max(0, u - r) * (bh[r] + G); };
  for (const p of pos) { p.ty = Y(p.y); p.th = Y(p.y + p.h) - p.ty - G; }
  return { pos, H, TH: Y(H) - G };
}
// the tiles of a category placed (CSS draws them from these numbers: a spot is (width + gap) / k wide; tops and heights
// in rem, so they follow the text size and the width without being placed again; Fill adds --gr per tile high)
function packTg(t, k) {
  const tiles = tileKids(t);
  if (!tiles.length) { t.classList.remove('pk'); t._H = 0; t._L = null; return 0; }
  const short = t.classList.contains('shorts'), G = 0.62 * spOf($('view')), nat = tiles.map(x => natOf(x, short)), even = !short && !!t.closest('.lrow[data-fill]');
  const key = k + ':' + G + ':' + even + ':' + tiles.map((x, j) => (x.dataset.w || 1) + 'x' + (x.dataset.h || 1) + (x.dataset.nl ? '/' : '') + '@' + nat[j].toFixed(3)).join(',');
  if (t._pk !== key) {
    const L = placeTiles(tiles.map(szOf), nat, k, G, even);
    tiles.forEach((x, j) => {
      const s = x.style, p = L.pos[j];
      s.setProperty('--x', p.x); s.setProperty('--w', p.w); s.setProperty('--y', p.y); s.setProperty('--h', p.h);
      s.setProperty('--ty', p.ty.toFixed(3)); s.setProperty('--th', p.th.toFixed(3));
      x.classList.toggle('hx', p.h > 1 + PE);
    });
    t.style.setProperty('--H', L.H); t.style.setProperty('--TH', L.TH.toFixed(3)); t._pk = key; t._H = L.H; t._L = L;
  }
  if (t.style.getPropertyValue('--k') !== String(k)) t.style.setProperty('--k', k);
  t.classList.add('pk'); t.classList.remove('meas');
  return t._H;
}
// what each tile shows at the size it has now (W wide, the gap g, in px; see .tg.pk in deck.css): everything; no graph;
// no caption; the name beside the value on one line; the value alone. Small tiles get tight padding
const FITS = ['l0', 'l1', 'ns', 'ng', 'nc', 'ph', 'pw', 'nu', 'cq'];
function tileFit(t, W, k, g, fs, gr) {
  if (!t._L) return;
  t._tw = W;
  const short = t.classList.contains('shorts'), pw = (W + g) / k;
  tileKids(t).forEach((x, j) => {
    const p = t._L.pos[j]; if (!p) return;
    const w = (p.w * pw - g) / fs, h = p.th + (gr ? p.h * gr / fs : 0);
    const c = (short ? (h < 1.9 || w < 4 ? 'l0 ng nc ph' : h < 2.9 ? 'ng nc ph' : '')
      : w < 4.5 ? (h >= 5.3 ? 'ns ng nc' : 'l0 ng nc ph') : h < 2.6 ? (w >= 9 ? 'l1 ng nc ph' : 'l0 ng nc ph') : h < 5.3 ? (w >= 7 ? 'l1 ng nc ph' : 'l0 ng nc ph') : h < 6.9 ? 'ng nc' : h < 7.9 ? 'ng' : '') + (w < 8 ? ' pw' : '') + (w < 4.5 ? ' nu' : '');
    // (cq: sized by its own box, for a tile that isn't 1 x 1, shows less, or grows in a Fill row; a plain tile needn't)
    const cq = c || Math.abs(p.w - 1) > PE || Math.abs(p.h - 1) > PE || gr ? c + ' cq' : c;
    if (x._fit === cq) return;
    x._fit = cq; const on = cq.split(' ');
    for (const f of FITS) x.classList.toggle(f, on.includes(f));
  });
}
// Overview: rows flow into this many sub-columns (each about 26rem, and 3 rows or more)
const subCols = (w, rows, fs) => Math.max(1, Math.min(Math.floor((w + 2.2 * fs) / (28.2 * fs)), Math.floor(rows / 3)));
// natural sizes, read off the view (nothing in it stretches)
function naturals(view, fs) {
  const q = s => view.querySelector(s), hgt = e => e ? e.offsetHeight : 0, mb = e => e ? parseFloat(getComputedStyle(e).marginBottom) || 0 : 0;   // layout sizes: an animation's transform doesn't count
  const h2 = q('.blk:not(.notitle) > .dch'), ch = q('.card:not(.band):not(.notitle) > .ch'), card = q('.card:not(.band)');
  let pad = 0; if (card) { const cs = getComputedStyle(card); pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2; }
  const withMb = e => hgt(e) ? hgt(e) + mb(e) : 0;
  return { H: withMb(h2) || 2.2 * fs,
    rowH: hgt(q('.card .dgrid > .row')) || 2.9 * fs, heroH: hgt(q('.card .hero')) || 7.3 * fs, chH: withMb(ch) || 2.4 * fs, pad: pad || 1.8 * fs, bandH: hgt(q('.card.band:not(.bfold)')) || 5 * fs };
}
// a row of your own whose widths follow content. Tiles: the row is a run of equal tile tracks; each column gets whole
// tracks, one at a time to the tallest column that gets shorter by it (others then spread into what is left), and its
// Auto categories use exactly those tracks, so tiles line up across columns. Overview: the twelfths split with the
// lowest tallest column. Returns false when the row has to fold
function balanceRow(row, cols, W, cg, fs, g, nat) {
  const C = cols.length, rg = parseFloat(getComputedStyle(cols[0]).rowGap) || 0;
  const desc = cols.map(c => [...c.children].filter(e => e.classList.contains('dcat')).map(b => {
    const tg = b.querySelector('.tg'), dg = b.querySelector('.dgrid');
    const tiles = tg ? tileKids(tg) : [];
    const short = !!tg && tg.classList.contains('shorts');
    return { tg, tiles, sz: tiles.map(szOf), nat: tiles.map(x => natOf(x, short)), packs: new Map(), collapsed: b.classList.contains('collapsed'), short: !!tg && tg.classList.contains('shorts'),
      per: tg && tg.classList.contains('per') ? +tg.style.getPropertyValue('--per') || 0 : 0, band: b.classList.contains('band'), hero: !!b.querySelector('.hero'),
      rows: b.querySelectorAll('.dgrid > .row').length, n: dg ? dg.children.length : 0 };
  }));
  const stackH = (i, f) => desc[i].reduce((a, d) => a + f(d), 0) + (desc[i].length - 1) * rg;
  if (S.screen === 'tiles') {
    const m0 = 10.5 * fs, K0 = Math.floor((W - (C - 1) * cg + C * g) / (m0 + g) + 1e-6);
    if (K0 < C) return false;
    // tracks of at least m wide: each column starts at what its categories need (short tiles want two tracks), then
    // the tallest that gets shorter within the next 3 tracks takes them; gives the tracks and the tallest column
    const alloc = (K, m) => {
      const catH = (d, n) => {
        if (d.collapsed) return nat.H;
        if (!d.tiles.length) return nat.H + 5 * fs;   // an empty category (edit mode)
        const w = n * m + (n - 1) * g, kk = d.per ? Math.max(1, Math.min(d.per, Math.floor((w + g) / (8.5 * fs + g)))) : d.short ? Math.max(1, Math.floor((w + g) / (15 * fs + g))) : n;
        if (!d.packs.has(kk)) d.packs.set(kk, placeTiles(d.sz, d.nat, kk, g / fs, !d.short && !!row.dataset.fill).TH);
        return nat.H + d.packs.get(kk) * fs;
      };
      const colH = (i, n) => stackH(i, d => catH(d, n));
      const k = cols.map(c => Math.max(1, Math.ceil(((+c.dataset.min || 0) * fs + g) / (m + g) - 1e-6)));
      let rem = K - k.reduce((a, b) => a + b, 0);
      if (rem < 0) return null;
      while (rem > 0) {
        let best = -1, bh = -1, bj = 0;
        for (let i = 0; i < C; i++) { const a = colH(i, k[i]); for (let j = 1; j <= Math.min(3, rem); j++) if (colH(i, k[i] + j) < a - 0.5) { if (a > bh) { bh = a; best = i; bj = j; } break; } }
        if (best < 0) break;
        k[best] += bj; rem -= bj;
      }
      return { k, top: Math.max(...k.map((n, i) => colH(i, n))) };
    };
    // the tracks rarely split evenly (8 for three equal columns = 3 3 2): one more, a little narrower (never under
    // 9.5rem), is taken when it leaves the tallest column shorter
    let a = alloc(K0, m0);
    if (!a) return false;
    const m1 = (W - (C - 1) * cg - (K0 + 1 - C) * g) / (K0 + 1);
    if (m1 >= 9.5 * fs) { const b = alloc(K0 + 1, m1); if (b && b.top < a.top - 0.5) a = b; }
    const k = a.k;
    const used = k.reduce((a, b) => a + b, 0), t = (W - (C - 1) * cg - (used - C) * g) / used;
    row.style.setProperty('--cols', k.map(n => 'minmax(0, ' + (n * t + (n - 1) * g).toFixed(1) + 'fr)').join(' '));
    desc.forEach((ds, i) => { for (const d of ds) if (d.tg && !d.per && !d.short) { d.tg.dataset.ktrack = '1'; d.tg.classList.add('kset'); d.tg.style.setProperty('--k', k[i]); } });
    row.dataset.ks = k.join(',');
    return true;
  }
  const unit = (W - (C - 1) * cg) / 12;
  if (unit <= 0) return false;
  const mins = cols.map(c => Math.max(1, Math.ceil(((+c.dataset.min || 0) * fs - 1) / unit)));
  if (mins.reduce((a, b) => a + b, 0) > 12) return false;
  const cardH = (d, w) => {
    if (d.collapsed) return nat.pad + nat.chH;
    if (d.band) { const per = Math.max(1, Math.floor((w - 2.5 * fs) / (10.5 * fs))); return w >= (8.5 + Math.max(1, d.n) * 10.5) * fs ? nat.bandH : nat.bandH + (Math.ceil(d.n / per) - 1) * 3.6 * fs; }
    const n = subCols(w - 2.6 * fs, d.rows, fs);
    return nat.pad + nat.chH + (d.hero ? nat.heroH : 0) + Math.ceil(d.rows / n) * nat.rowH;
  };
  let best = null, bs = Infinity;
  const ws = Array(C).fill(0), eq = 12 / C;
  (function walk(i, left) {
    if (i === C - 1) {
      if (left < mins[i]) return;
      ws[i] = left;
      const top = Math.max(...ws.map((w, j) => stackH(j, d => cardH(d, w * unit)))), score = top * 1000 + ws.reduce((a, w) => a + (w - eq) * (w - eq), 0);
      if (score < bs) { bs = score; best = ws.slice(); }
      return;
    }
    for (let w = mins[i]; w <= left - mins.slice(i + 1).reduce((a, b) => a + b, 0); w++) { ws[i] = w; walk(i + 1, left - w); }
  })(0, 12);
  if (!best) return false;
  row.style.setProperty('--cols', colTracks(best.map(w => ({ w }))));
  row.dataset.ks = best.join(',');
  return true;
}
// Tiles per row, Auto: as many as fit, evened out over the rows (3 tiles where 5 fit = 3 wider ones, no empty places)
function balancedK(tg, W, fs, g) {
  const tiles = tileKids(tg), min = (tg.classList.contains('shorts') ? 15 : 10.5) * fs;
  const kmax = Math.max(1, Math.floor((W + g) / (min + g) + 1e-6)), a = tileArea(tiles, kmax), rows = Math.max(1, Math.ceil(a / kmax - PE));
  let k = Math.min(kmax, Math.max(1, Math.ceil(a / rows - PE)));
  const mw = tiles.reduce((m, t) => Math.max(m, szOf(t).w), 1);   // a wide tile gets its width where there is room
  if (kmax > 1 && mw > 1) k = Math.max(k, Math.min(kmax, Math.ceil(mw - PE)));
  return k;
}
// a fit tries several text sizes: the natural sizes scale with it and a row's width doesn't change, so both are read
// once per drawn view (a resize or a redraw starts again)
let layGen = 0, natMemo = null;
const rowW = new WeakMap();
function naturalsNow(view, fs) {
  const fit = app.classList.contains('fitting');
  if (natMemo && natMemo.view === view && natMemo.gen === layGen && natMemo.fit === fit) { const k = fs / natMemo.fs, o = {}; for (const x in natMemo.n) o[x] = natMemo.n[x] * k; return o; }
  const n = naturals(view, fs); natMemo = { view, gen: layGen, fit, fs, n }; return n;
}
function layoutPass() {
  const fs = parseFloat(document.documentElement.style.fontSize) || 13, view = $('view');
  if (!view) return;
  for (const r of view.querySelectorAll('.lrow.grow')) r.classList.remove('grow');
  for (const t of view.querySelectorAll('.tg[data-ktrack]')) delete t.dataset.ktrack;
  const g = 0.62 * fs * spOf(view), nat = naturalsNow(view, fs), tgs = [...view.querySelectorAll('.tg')];
  measureUnits(tgs, fs); setTileUnit(tgs);
  // rows of your own: their widths first (rows don't change each other's width), then the widths and folds they get
  const rows = [...view.querySelectorAll(':scope > .lrow')].map(row => ({ row, cols: [...row.children].filter(e => e.classList.contains('lcol')) }));
  for (const r of rows) { const m = rowW.get(r.row); r.W = m && m[0] === layGen ? m[1] : r.row.clientWidth; rowW.set(r.row, [layGen, r.W]); r.cg = parseFloat(getComputedStyle(r.row).columnGap) || 0; }
  for (const { row, cols, W, cg } of rows) {
    if (cols.length < 2) { row.classList.remove('fold'); continue; }
    const fold = row.dataset.auto ? !balanceRow(row, cols, W, cg, fs, g, nat) : W + 1 < cols.reduce((a, c) => a + (+c.dataset.min || 0) * fs, 0) + cg * (cols.length - 1);
    row.classList.toggle('fold', fold);
    if (fold) for (const t of row.querySelectorAll('.tg[data-ktrack]')) delete t.dataset.ktrack;
  }
  // then every width the rest depends on, read in one go
  const gs = document.querySelector('#view.gsplit.arr'), gw = gs ? gs.clientWidth : 0;
  const tw = tgs.map(t => t.clientWidth);
  const vs = [...view.querySelectorAll('.card:not(.band) > .dgrid.vert')], vw = vs.map(d => d.clientWidth);
  const bands = [...view.querySelectorAll('.card.band')], bw = bands.map(b => b.clientWidth);
  if (gs) { const n = gs.children.length; gs.classList.toggle('fold', n > 1 && gw + 1 < (n * 30 + (n - 1) * 0.92) * fs); }
  const flipped = [];   // short categories that turned narrow (or back): read again together after the others
  // tiles per row: Auto evened out (unless the row's tracks set it); short tiles too narrow for the name and the
  // value side by side stack them; then the tiles are placed by their sizes
  tgs.forEach((t, i) => {
    if (!tw[i]) return;   // not drawn (a folded category)
    let k;
    if (t.classList.contains('per')) k = Math.max(1, Math.min(+t.style.getPropertyValue('--per') || 1, Math.floor((tw[i] + g) / (8.5 * fs + g) + 1e-6)));
    else if (t.dataset.ktrack) k = +t.style.getPropertyValue('--k') || 1;
    else { k = balancedK(t, tw[i], fs, g); t.classList.add('kset'); }
    if (t.classList.contains('shorts')) {
      const nw = (tw[i] - (k - 1) * g) / k < 12 * fs;
      if (nw !== t.classList.contains('narrow')) { t.classList.toggle('narrow', nw); flipped.push([t, k, tw[i]]); return; }
    }
    packTg(t, k);
    tileFit(t, tw[i], k, g, fs);
  });
  if (flipped.length) { measureUnits(flipped.map(f => f[0]), fs); for (const [t, k, w] of flipped) { packTg(t, k); tileFit(t, w, k, g, fs); } }
  vs.forEach((d, i) => {
    const n = d.querySelectorAll(':scope > .row').length, sc = subCols(vw[i], n, fs);
    d.classList.toggle('sub', sc > 1);
    if (sc > 1) { d.classList.toggle('nohero', !d.querySelector(':scope > .hero')); d.style.setProperty('--sc', sc); d.style.setProperty('--sr', Math.ceil(n / sc)); }
  });
  bands.forEach((b, i) => { const n = b.querySelectorAll('.bcell').length; b.classList.toggle('bfold', bw[i] + 1 < (8.5 + Math.max(1, n) * 10.5) * fs); });   // a band cell needs about 10.5rem
  placeDividers(view);
}
// the handles between columns sit in the middle of the gap, wherever the widths came from
function placeDividers(view) {
  const rows = [...view.querySelectorAll(':scope > .lrow')].filter(r => r.querySelector(':scope > .ldiv'));
  const pos = rows.map(r => { const x0 = r.getBoundingClientRect().left, cs = [...r.children].filter(e => e.classList.contains('lcol')).map(c => c.getBoundingClientRect()); return cs.slice(1).map((c, k) => (cs[k].right + c.left) / 2 - x0); });
  rows.forEach((r, i) => r.querySelectorAll(':scope > .ldiv').forEach(d => { const x = pos[i][+d.dataset.k]; if (x !== undefined) d.style.left = x.toFixed(1) + 'px'; }));
}
// Fill rows (Tiles): the room left under the view goes to their tiles, all of a row one height, at most twice their own
function growPass() {
  const view = $('view');
  if (!view || !view.classList.contains('tl') || !view.classList.contains('arr')) return;
  const rows = [...view.querySelectorAll(':scope > .lrow[data-fill]')];
  if (!rows.length) return;
  const fs = parseFloat(document.documentElement.style.fontSize) || 13;
  const spare = sectionsEl.clientHeight - (view.offsetTop + view.offsetHeight) - (parseFloat(getComputedStyle(sectionsEl).paddingBottom) || 0) - 2;
  if (spare < 6) return;
  // each column: how tall its content is now, and how many tiles high its growing tiles are (T: a normal tile's height,
  // the largest category's shortest; tiles grow by T at most)
  let T = 0;
  const info = rows.map(r => [...r.children].filter(e => e.classList.contains('lcol')).map(c => {
    const kids = [...c.children].filter(x => x.classList.contains('dcat')), gap = parseFloat(getComputedStyle(c).rowGap) || 0;
    let n = 0;
    for (const b of kids) { if (b.classList.contains('collapsed')) continue; const tg = b.querySelector('.tg.pk:not(.shorts)'); if (tg) { n += tg._H || 0; T = Math.max(T, Math.min(...tileKids(tg).map(x => natOf(x))) * fs); } }
    return { h: kids.reduce((a, b) => a + b.offsetHeight, 0) + Math.max(0, kids.length - 1) * gap, n };
  })).map((cs, i) => {   // a folded row: its columns one under the other, so they grow together
    if (!rows[i].classList.contains('fold') || cs.length < 2) return cs;
    const gap = parseFloat(getComputedStyle(rows[i]).rowGap) || 0;
    return [{ h: cs.reduce((a, c) => a + c.h, 0) + (cs.length - 1) * gap, n: cs.reduce((a, c) => a + c.n, 0) }];
  });
  if (!T) return;
  const extra = d => info.reduce((a, cs) => a + Math.max(...cs.map(c => c.h + c.n * d)) - Math.max(...cs.map(c => c.h)), 0);
  let lo = 0, hi = T;
  if (extra(hi) > spare) for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (extra(mid) <= spare) lo = mid; else hi = mid; }
  else lo = hi;
  if (lo < 2) return;
  for (const r of rows) { r.classList.add('grow'); r.style.setProperty('--gr', lo.toFixed(1) + 'px'); r.style.setProperty('--gv', (1 + 0.3 * lo / T).toFixed(3)); }
  const g = 0.62 * fs * spOf(view);
  for (const r of rows) for (const t of r.querySelectorAll('.tg.pk:not(.shorts)')) tileFit(t, t._tw, +t.style.getPropertyValue('--k') || 1, g, fs, +lo.toFixed(1));
}
// how each category's tiles were placed (their numbers and looks): the next drawing of the same tiles starts there, so
// it needs one layout instead of two (placing checks it all again and changes only what differs)
const packMemo = new Map();
function rememberPacks() {
  for (const t of document.querySelectorAll('#view .tg.pk')) {
    const cat = t.parentElement.dataset.cat, kids = tileKids(t); if (!t._L || !cat) continue;
    const st = t.style, v = k => st.getPropertyValue(k);
    const u = unitH.get(t); if (!u) continue;
    packMemo.set(cat, { cids: kids.map(x => x.dataset.cid).join('|'), edit: S.edit, key: t._pk, H: t._H, L: t._L, tw: t._tw, fs: u.fs,
      tgStyle: '--k:' + v('--k') + ';--H:' + v('--H') + ';--TH:' + v('--TH'), tgCls: t.classList.contains('narrow') ? ' narrow' : '',
      tiles: kids.map(x => { const s = x.style, f = k => s.getPropertyValue(k); return ['--x:' + f('--x') + ';--w:' + f('--w') + ';--y:' + f('--y') + ';--h:' + f('--h') + ';--ty:' + f('--ty') + ';--th:' + f('--th'),
        (x.classList.contains('hx') ? ' hx' : '') + (x._fit ? ' ' + x._fit : ''), x._fit, x._nat]; }) });
  }
  if (packMemo.size > 400) packMemo.clear();
}
// edit mode: the room under a column's categories shows as a soft slot, only where there is real room (3 lines or
// more: a thin one looked like a stray bar)
function markSlots() {
  if (!S.edit) return;
  const fs = parseFloat(document.documentElement.style.fontSize) || 13, cols = [...document.querySelectorAll('#view .lrow:not(.fold) > .lcol')];
  const room = cols.map(c => { const ks = [...c.children].filter(e => e.classList.contains('dcat')); return ks.length ? c.getBoundingClientRect().bottom - ks[ks.length - 1].getBoundingClientRect().bottom : 0; });
  cols.forEach((c, i) => c.classList.toggle('slot', room[i] >= 3 * fs));
}
// the size that fit, per view as it looks now (window, categories, its arrangement and looks; edit mode fits as outside it, so both share it): switching
// back to a view tries that one size instead of searching again
// kept in this window's own storage too (a convenience: lost storage just means one search), so the first switch after
// a restart is quick as well
const lastFit = {}, fitMemo = (() => { try { return JSON.parse(localStorage.getItem('hwdeck.fit') || '{}') || {}; } catch (e) { return {}; } })();
const hashKey = t => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return 'f' + (h >>> 0).toString(36); };   // (a letter first: keys that look like numbers would lose their order)
let fitSaveT = 0;
function rememberFit(key, f) {
  delete fitMemo[key]; fitMemo[key] = f;
  const ks = Object.keys(fitMemo); for (let i = 0; i < ks.length - 60; i++) delete fitMemo[ks[i]];
  clearTimeout(fitSaveT); fitSaveT = setTimeout(() => { try { localStorage.setItem('hwdeck.fit', JSON.stringify(fitMemo)); } catch (e) { /* no storage: fine */ } }, 2000);
}
// (the cells too: a name, a graph turned on or off, a missing reading change what fits)
const fitKey = target => hashKey(JSON.stringify([S.screen, target, !!EXT.ready, sectionsEl.clientWidth, sectionsEl.clientHeight, S.L.cats.map(c => [c.id, cellsOf(c).length, c.collapsed]),
  viewOf(S.screen), S.L.cells, Object.keys(S.L.cells).filter(id => isMissing(S.L.cells[id]))]));
function autofit() {
  if (document.hidden) drawnHidden = true;   // (measured in the tray: again when the window shows)
  const root = document.documentElement, v = $('view');
  if (!S.L.cats.length || v.classList.contains('empty') || v.classList.contains('setup')) { root.style.fontSize = '13px'; fitRatio = 1; layoutPass(); return; }
  const target = cssScale(), key = fitKey(target), floor = Math.max(9, target * 0.6);
  // (Automatic Grid: a size per table count)
  const ag = S.screen === 'grid' && !isCustom('grid'), nOn = ag && v.querySelectorAll('.gtable').length > 1 ? 2 : 1, mkey = ag ? key + '/' + nOn : key, memo = fitMemo[mkey];
  app.classList.toggle('fitting', S.edit);   // edit mode fits like the normal view: empty categories (hidden there) don't count
  const at = f => { root.style.fontSize = f + 'px'; return fits(); };
  // the largest size that fits between lo (fits) and hi (doesn't), to 0.2 px
  const search = (lo, hi) => { while (hi - lo > 0.2) { const mid = (lo + hi) / 2; if (at(mid)) lo = mid; else hi = mid; } return lo; };
  // then a few more tries, so the margin left at the bottom is about the one at the sides, not a size step more
  const refine = (lo, hi) => { for (let i = 0; i < 3 && hi - lo > 0.06; i++) { const mid = (lo + hi) / 2; if (at(mid)) lo = mid; else hi = mid; } return lo; };
  let lo, ok = true;
  // (the remembered size is still tried: live values can change what fits)
  if (memo && at(memo)) lo = memo;
  else if (memo !== target && at(target)) lo = target;
  // edit mode, redrawn on every change: far too much to ever fit (3 windows tall) scrolls at once, no more tries
  else if (S.edit && sectionsEl.scrollHeight > sectionsEl.clientHeight * 3) { lo = target; ok = false; }
  else {
    // from where this view fit last (an edit, a resize: usually close), else from how much of it fits at the full size,
    // each try steers by how much of the window the content fills (text and tiles scale together); halves the gap
    // once it has a size that fits and one that doesn't
    const avail = sectionsEl.clientHeight - 20, H = () => Math.max(1, $('view').offsetHeight);
    let good = 0, bad = target, est = target, f = lastFit[S.screen] ? target * lastFit[S.screen] : target * avail / H();
    for (let i = 0; i < 6 && bad - good > 0.3; i++) {
      f = Math.min(bad - 0.1, Math.max(floor, f));
      if (f <= good) break;
      if (at(f)) { good = f; const g2 = est = f * avail / H(); f = g2 - good < 0.25 ? bad : Math.min(g2, (good + bad) / 2 + 0.6); if (g2 - good < 0.25) break; }
      else { bad = f; f = good ? (good + bad) / 2 : f * avail / H(); if (f <= floor && !good) break; }
    }
    if (good) lo = refine(good, Math.min(bad, Math.max(good + 0.07, est + 0.05)));   // (no further than the content says fits)
    else if (at(floor)) { lo = search(floor, bad); lo = refine(lo, Math.min(bad, lo + 0.2)); }
    else {
      // the smallest size didn't fit (tiles reflow, so a size between may): the largest that does, else scrolling at
      // the full size. Edit mode, redrawn on every change, skips the walk: so much that it scrolls anyway
      let found = 0;
      if (!S.edit) for (let fs = target - 0.5; fs > floor; fs -= 0.5) if (at(fs)) { found = fs; break; }
      lo = found || target; ok = !!found;
    }
  }
  // the tiles' heights read again at the size kept; a size that fit and no longer does goes down a little
  root.style.fontSize = lo + 'px';
  const stale = [...v.querySelectorAll('.tg')].some(t => { const u = unitH.get(t); return u && Math.abs(u.fs - lo) > 0.01; });
  exactUnits = stale; const still = stale ? fits() : true; exactUnits = false;
  if (ok && !still) for (let i = 0; i < 8; i++) { lo = Math.max(floor, lo - 0.25); if (at(lo) || lo === floor) break; }
  lastFit[S.screen] = lo / target;
  rememberFit(mkey, lo);
  app.classList.remove('fitting'); layoutPass(); growPass(); markSlots(); rememberPacks();
  document.querySelector('.panes').style.setProperty('--sbw', (sectionsEl.offsetWidth - sectionsEl.clientWidth) + 'px');   // the right tab sits left of the scrollbar
  fitRatio = lo / target;
  // Automatic Grid, decided from one table: one that had to go under the size two can have (or that doesn't fit at all)
  // gives two, fitted again. Two on screen with nothing decided for this window: left undecided, the next draw starts
  // from one (refit after a resize or the banner)
  if (ag && !gridForce && !gridN[key] && nOn === 1) {
    const ks = Object.keys(gridN); if (ks.length > 200) delete gridN[ks[0]];
    gridN[key] = (!ok && gridLim() >= floor) || lo < gridLim() - 0.05 ? 2 : 1;   // (one that fits nowhere: two only if they sit side by side at the smallest size)
    if (gridN[key] === 2) { const en = entrance; enterNext = en !== null; slideDir = en || 0; gridForce = 2; try { buildView(); updateView(true, true); autofit(); } finally { gridForce = 0; } }   // (an entrance still to play plays on the two)
  }
}
// a window that changed size (or the banner coming or going): an automatic view with room for more or fewer columns, or
// Automatic Grid with a table count for the new size other than the one on screen, is drawn again; else fitted again
let refitLater = false;   // (a refit asked for during a drag: done at the drop)
function refit() {
  if ((drag && drag.started) || rs) { refitLater = true; return; }   // (a rebuild would move the view under the drag)
  if (S.screen !== 'grid' && !isCustom(S.screen) && lastAuto[S.screen] && JSON.stringify(autoRows(S.screen)) !== JSON.stringify(lastAuto[S.screen])) { renderView(false); return; }
  if (S.screen === 'grid' && !isCustom('grid') && $('view') && gridN[fitKey(cssScale())] !== ($('view').querySelectorAll('.gtable').length > 1 ? 2 : 1)) { renderView(false); return; }
  autofit(); updateView(true, true); pxFresh();
}
window.addEventListener('resize', () => {
  layGen++;
  if (S.L.cats.length) document.documentElement.style.fontSize = (cssScale() * fitRatio) + 'px';
  clearTimeout(fitTimer); fitTimer = setTimeout(refit, 250);
  placeTabInd(true); drawRows();
});

// ---------- views: Tiles, Overview, Grid ----------
let slotWanted = null;
let gzDragCancel = null;   // (a Customize row being dragged: how to drop it nowhere)
let stateGen = 0;   // (which view the host sent last: a save says it, so one made before a newer view is dropped)
let heldSlots = new Set();   // (the slots another program held when the page asked: shown empty, not free)   // the slot state.json links the view to, held when the page started (null: none)
let wantScreen = null, screenRaf = 0;   // a view asked for by a click, drawn on the next frame (requestScreen)
function placeTabInd(still, to) {
  const b = document.querySelector('#screens button[data-s="' + (to || wantScreen || S.screen) + '"]'), ind = $('tabind');
  if (!b) return;
  ind.classList.toggle('still', !!still); ind.style.width = b.offsetWidth + 'px'; ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
}
function showScreen(s, first) {
  const order = ['tiles', 'overview', 'grid'];
  slideDir = first ? 0 : Math.sign(order.indexOf(s) - order.indexOf(S.screen));
  S.screen = s; preview = null;
  for (const b of document.querySelectorAll('#screens button[data-s]')) b.classList.toggle('active', b.dataset.s === s);
  placeTabInd(!!first);
  if (!first) saveState();
  hidePrev();
  renderView(true);
  if (S.edit) renderInsp();   // the settings of the view (or of a category) in this view
}
// a click (or 1 2 3) moves the tab at once and draws that view on the next frame: clicks faster than a view draws
// don't queue a drawing each, only the view they end on is drawn
function requestScreen(s) {
  wantScreen = s;
  for (const b of document.querySelectorAll('#screens button[data-s]')) b.classList.toggle('active', b.dataset.s === s);
  placeTabInd(false, s);
  if (!screenRaf) screenRaf = requestAnimationFrame(() => { screenRaf = 0; const t = wantScreen; wantScreen = null; if (t && t !== S.screen) showScreen(t); });
}
$('screens').addEventListener('click', e => { const b = e.target.closest('button[data-s]'); if (b) requestScreen(b.dataset.s); });

// ---------- Storage: a virtual list, only the rows in sight exist ----------
const ROWH = 30;
let rows = [], typeFilter = 'all', query = '', hideIn = false;
// ---- hidden from Storage (and from Customize's list), kept per PC in state.json: readings or whole sensors you hid
// (r, s), and by default the iGPU when there is a discrete GPU and readings HWiNFO has only ever seen at 0 (an empty fan
// header, a dead voltage input; the host's 'zero' list); show / showS bring back what was hidden by default. A
// reading's own choice wins over its sensor's, its sensor's over the default ----
S.hide = { r: [], s: [], show: [], showS: [] };
function cleanHide(h) {
  const arr = a => Array.isArray(a) ? [...new Set(a.filter(x => typeof x === 'string' && x.length && x.length <= 200))].slice(0, 2000) : [];
  return { r: arr(h && h.r), s: arr(h && h.s), show: arr(h && h.show), showS: arr(h && h.showS) };
}
let HS = { r: new Set(), s: new Set(), show: new Set(), showS: new Set() }, igpuOf = null, igpu = new Set();
function hideSets() { HS = { r: new Set(S.hide.r), s: new Set(S.hide.s), show: new Set(S.hide.show), showS: new Set(S.hide.showS) }; }
const autoHid = r => { if (igpuOf !== SENS) { igpuOf = SENS; igpu = new Set(); const dgpu = SENS.some(x => /^(dGPU|GPU) \[#/.test(x.name)); if (dgpu) SENS.forEach((x, i) => { if (/^iGPU\b/.test(x.name)) igpu.add(i); }); } return igpu.has(r.s) || (!!feed.zero && feed.zero.has(r.key)); };
// 0 shown, 1 hidden by you, 2 hidden by default
function hidOf(r) {
  if (HS.show.has(r.key)) return 0; if (HS.r.has(r.key)) return 1;
  const sk = SENS[r.s] ? SENS[r.s].key : '';
  if (HS.showS.has(sk)) return 0; if (HS.s.has(sk)) return 1;
  return autoHid(r) ? 2 : 0;
}
function setHide(fn) { fn(S.hide); S.hide = cleanHide(S.hide); hideSets(); saveState(); renderStorage(); if (GZ.on) { gzCompute(); gzChips(); gzDraw(); } }
const without = (a, x) => a.filter(y => y !== x);
const collapsedGroups = new Set();
function passes(r, toks, iv) {
  if (typeFilter === 'hidden' ? !hidOf(r) : hidOf(r)) return false;
  if (typeFilter !== 'all' && typeFilter !== 'hidden' && r.t !== typeFilter) return false;
  if (hideIn && iv.has(r.key)) return false;
  for (const t of toks) if (!r.hay.includes(t)) return false;
  return true;
}
let chipCounts = {};
function computeRows() {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean), iv = inView();
  const counts = new Map(), hits = [];
  chipCounts = { all: 0, hidden: 0 };
  for (const r of READ) {
    if ((hideIn && iv.has(r.key)) || toks.some(t => !r.hay.includes(t))) continue;   // the chips count what the search leaves
    if (hidOf(r)) { chipCounts.hidden++; if (typeFilter === 'hidden') { hits.push(r); counts.set(r.s, (counts.get(r.s) || 0) + 1); } continue; }
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
    const h = '<div class="vempty">No readings match' + (query ? ' "' + esc(query) + '"' : typeFilter !== 'all' ? ' this type' : '') + '. ' +
      (typeFilter !== 'hidden' && chipCounts.hidden ? plural(chipCounts.hidden, 'hidden one does', 'hidden ones do') + ': <button class="linkbtn" id="qHidden">Show hidden</button>' : '<button class="linkbtn" id="qClear">Show all</button>') + '</div>';
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
      html += '<div class="vrow g' + (collapsedGroups.has(sn.key) ? ' collapsed' : '') + '" style="top:' + i * ROWH + 'px" data-gs="' + row.s + '"><button class="tw" title="Collapse">' + ICONS.chev + '</button><span class="gn" title="' + esc(sn.name) + '">' + esc(sn.name) + '</span><span class="gc">' + row.n + '</span>' + (relinkFor ? '' : typeFilter === 'hidden' ? '<button class="hid on" data-act="unhides" title="Show this sensor in Storage again">' + ICONS.eye + '</button>' : '<button class="hid" data-act="hides" title="Hide this sensor from Storage">' + ICONS.eyeOff + '</button><button class="addall" title="Add these as a new category">+ all</button>') + '</div>';
    } else {
      const r = row.r, has = iv.has(r.key);
      keys.push(r.key);
      html += '<div class="vrow r" style="top:' + i * ROWH + 'px" data-key="' + esc(r.key) + '"><span class="ti t-' + r.t + '"></span><span class="lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="val"></span>' +
        (relinkFor ? '<button class="add link" data-act="link">Link</button>' : (typeFilter === 'hidden' ? '<button class="hid on" data-act="unhide" title="Show it in Storage again">' + ICONS.eye + '</button>' : '<button class="hid" data-act="hide" title="Hide it from Storage">' + ICONS.eyeOff + '</button>') + (has ? '<span class="inv" title="In the view">' + ICONS.check + '</span>' : '<button class="add" data-act="add" title="Add to the view">+</button>')) + '</div>';
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
  $('chips').innerHTML = ['all', 'temp', 'volt', 'fan', 'power', 'current', 'clock', 'usage', 'other', 'hidden'].filter(t => counts[t] || t === typeFilter)
    .map(t => '<button class="chip' + (t === 'hidden' ? ' hidchip' : '') + (typeFilter === t ? ' on' : '') + '" data-t="' + t + '"' + (t === 'hidden' ? ' title="What you hid, the integrated GPU and readings that have only ever been 0: bring them back from here"' : '') + '>' + (t === 'all' ? 'All' : t === 'hidden' ? 'Hidden' : TYPE_NAME[t]) + ' ' + (counts[t] || 0).toLocaleString('en-US') + '</button>').join('');
}

// ---------- adding and removing cells ----------
function newCell(key) {
  const r = BYKEY.get(key), c = { key, match: r ? matchOf(r) : undefined, u: r ? r.unit : undefined, graph: true };
  if (key === CONN) c.gates = Object.assign({}, CONN_LINES);   // a connector is only worth a cell with its lines
  return c;
}
function addKeys(keys, catId, index, newCatName) {
  mutate(() => {
    let cat = catId && S.L.cats.find(c => c.id === catId);
    if (!cat) { cat = { id: nid('c'), name: newCatName || 'New category', collapsed: false, cells: [] }; S.L.cats.push(cat); }
    const ids = keys.map(k => { const id = nid('a'); S.L.cells[id] = newCell(k); return id; });
    cat.cells.splice(index == null ? cat.cells.length : index, 0, ...ids);
    if (ids.length === 1) { sel = ids[0]; selCat = null; }
  }, keys.length > 1 ? 'Added ' + keys.length + ' cells' : null);
}
function targetForAdd() {
  if (sel) { const c = catOf(sel); if (c) return { cat: c.id, index: c.cells.indexOf(sel) + 1 }; }
  if (selCat && catById(selCat)) return { cat: selCat, index: null };
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
// a drag or a handle let go with Escape: the release of its button still to come is no click
let cancelPid = null;
const swallowUp = ev => { if (cancelPid == null || ev.pointerId !== cancelPid) return false; cancelPid = null; justDragged = true; setTimeout(() => { justDragged = false; }, 0); return true; };
document.addEventListener('pointerdown', () => { cancelPid = null; }, true);   // (a release that never came: the next press starts clean)
document.addEventListener('pointercancel', ev => { if (ev.pointerId === cancelPid) cancelPid = null; });
// a press that starts a drag lets a settings field go first: what was typed there is applied (its change), not lost
// a field you typed in (not one the page wrote) that applies on its change: a size, a category's name
document.addEventListener('input', e => { if (e.target && e.target.closest && e.target.closest('#insp')) e.target._typed = true; }, true);
document.addEventListener('change', e => { if (e.target) e.target._typed = false; }, true);
document.addEventListener('focusout', e => { if (e.target) e.target._typed = false; }, true);   // (typed back or reverted: no change, nothing pending)
function blurInsp() { const a = document.activeElement; if (a && a.closest && a.closest('#insp')) a.blur(); }
function startDrag(ev, kind, data, label, val) {
  if (drag && drag.ghost) drag.ghost.remove();   // (a drag a new press replaces leaves nothing behind)
  drag = { kind, data, x0: ev.clientX, y0: ev.clientY, started: false, label, val, target: null, pid: ev.pointerId };
}
const dragOwn = ev => !drag || drag.pid == null || ev.pointerId === drag.pid;   // (only the pointer that started it moves or drops it)
function beginDrag() {
  drag.started = true;
  if (drag.kind !== 'cat') app.classList.add('dragging');   // the "+ New category" drop zone shows up
  // a drawer the drag didn't start on goes at once (one still sliding shut would hide where it drops)
  // and a reading dragged out of Storage sends Storage away, so every spot in the view can take it (pinned: back after)
  for (const d of [DR.L, DR.R]) { const r = d.el.getBoundingClientRect(); if ((d === DR.L && drag.kind === 'row') || !d.el.classList.contains('open') || drag.x0 < r.left || drag.x0 > r.right || drag.y0 < r.top || drag.y0 > r.bottom) { clearTimeout(d.t); d.hover = false; } }
  syncDrawers();
  const gh = document.createElement('div'); gh.className = 'ghost';
  gh.innerHTML = '<span>' + esc(drag.label) + '</span>' + (drag.val ? '<span class="val">' + esc(drag.val) + '</span>' : '');
  document.body.appendChild(gh); drag.ghost = gh;
  if (drag.kind === 'cell') { const el = document.querySelector('#view .dc[data-cid="' + drag.data + '"]'); if (el) el.classList.add('dragging'); }
  if (drag.kind === 'cat') {
    for (const el of document.querySelectorAll('#view .dcat[data-cat="' + drag.data + '"]')) el.style.opacity = '0.4';
    // the arrangement it is dropped into: your own, or the Automatic one as it is on screen (made yours by an edge drop)
    drag.auto = !isCustom(S.screen); drag.rows = rowsNow();
    gh.classList.add('g2'); gh.insertAdjacentHTML('beforeend', '<span class="gs"></span>');
  }
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
  const prev = drag.target;
  drag.target = null; dropmark.style.display = 'none'; dropmark.className = 'dropmark';
  const nc = $('newcat'); nc.classList.remove('over');
  const vr = sectionsEl.getBoundingClientRect();
  if (x < vr.left || x > vr.right || y < vr.top || y > vr.bottom) return;
  const over = document.elementFromPoint(x, y);
  if (over && over.closest('.storage.open, .insp.open, .dtab')) return;   // over an open drawer: letting go there drops nothing (one sliding shut doesn't count)
  const cats = [...document.querySelectorAll('#view .dcat')];
  if (drag.kind === 'cat') {
    const t = catTarget(x, y, prev);
    drag.target = t;
    if (!t) dropmark.style.display = 'none';
    const gs = drag.ghost && drag.ghost.querySelector('.gs');
    if (gs) { setText(gs, t ? t.txt : ''); gs.classList.toggle('no', !!t && t.zone === 'full'); }
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
  // where it lands is "before this cell" (null: at the end); the view draws the lead first, so "before the lead" means
  // the front of the rest
  const lead = catLook(catId).lead, front = cat.cells.find(id => S.L.cells[id] && id !== lead && !(drag.kind === 'cell' && id === drag.data)) || null;
  if (catEl.classList.contains('collapsed') || under.closest('.dch, .ghdr')) {
    // on the header: first, where the mark is; on a folded category: last
    drag.target = { cat: catId, before: catEl.classList.contains('collapsed') ? null : front };
    // (a lead, drawn first: the cell lands after it, so the mark goes there)
    const le = !catEl.classList.contains('collapsed') && lead && !(drag.kind === 'cell' && drag.data === lead) && S.L.cells[lead] && document.querySelector('#view .dcat[data-cat="' + catId + '"] .dc[data-cid="' + lead + '"]');
    if (le) { markAt(le, true); return; }
    // (Grid's "continued" header, in the second table: the mark goes under the category's own header, where it lands)
    const hdr = catEl.classList.contains('cont') ? document.querySelector('#view .dcat[data-cat="' + catId + '"]:not(.cont)') || catEl : catEl;
    const rr = vrect(hdr.querySelector('.dch, .ghdr')); showMark(rr.x, rr.y + rr.h, rr.w, 3); return;
  }
  const cells = [...document.querySelectorAll('#view .dcat[data-cat="' + catId + '"] .dc')].filter(el => !(drag.kind === 'cell' && el.dataset.cid === drag.data));
  if (!cells.length) {
    drag.target = { cat: catId, before: null };
    const g = catEl.querySelector('.dgrid') || catEl.querySelector('.ghdr'); const rr = vrect(g);
    showMark(rr.x + 2, rr.y + rr.h - 3, Math.max(rr.w - 4, 40), 3); return;
  }
  // the nearest cell, then before or after it: by side in a grid of tiles, by half in a list (Overview, Grid)
  let best = null, bd = Infinity;
  for (const el of cells) {
    const r = el.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy * 4; if (d < bd) { bd = d; best = { el, r }; }
  }
  const vertical = !best.el.classList.contains('tile') && !best.el.classList.contains('bcell');   // tiles and band cells sit side by side
  const after = vertical ? y > best.r.top + best.r.height / 2 : x > best.r.left + best.r.width / 2;
  const vis = cells.map(el => el.dataset.cid);
  let before = vis[vis.indexOf(best.el.dataset.cid) + (after ? 1 : 0)] || null, mk = best.el, ma = after;
  // (before the lead, drawn first: it lands after the lead, so the mark goes there)
  if (before && before === lead) { before = front; const le = cells.find(el => el.dataset.cid === lead); if (le) { mk = le; ma = true; } }
  drag.target = { cat: catId, before };
  markAt(mk, ma);
}
// the drop mark before or after a cell, as the cells sit: side by side (tiles, band cells) or one under another
function markAt(el, after) {
  const vertical = !el.classList.contains('tile') && !el.classList.contains('bcell'), rr = vrect(el.tagName === 'TR' ? el.children[0] : el);
  if (vertical) { const w = el.tagName === 'TR' ? vrect(el.closest('table')).w : rr.w; showMark(rr.x, after ? rr.y + rr.h - 1 : rr.y - 2, w, 3); }
  else showMark(after ? rr.x + rr.w + 3 : rr.x - 6, rr.y, 3, rr.h);
}
function endDrag(cancel) {
  if (!drag) return;
  const d = drag; drag = null;
  if (refitLater) { refitLater = false; setTimeout(refit, 0); }
  if (viewLater) { viewLater = false; setTimeout(() => renderView(false), 0); }
  dropmark.style.display = 'none'; app.classList.remove('dragging');
  if (d.ghost) d.ghost.remove();
  syncDrawers();
  $('newcat').classList.remove('over');
  for (const el of document.querySelectorAll('#view .dragging')) el.classList.remove('dragging');
  for (const el of document.querySelectorAll('#view .dcat')) el.style.opacity = '';
  if (!d.started || cancel) return;
  justDragged = true; setTimeout(() => { justDragged = false; }, 0);
  const t = d.target; if (!t) return;
  if (d.kind === 'cell' && !catOf(d.data)) return;   // removed while it was dragged
  if (d.kind === 'cat' && !S.L.cats.some(c => c.id === d.data)) return;
  if (d.kind === 'cat') dropCat(d);
  else if (d.kind === 'row') {
    const r = BYKEY.get(d.data);
    const to = !t.newcat && catById(t.cat), at = to && t.before ? to.cells.indexOf(t.before) : -1;
    if (t.newcat) addKeys([d.data], null, null, r ? SENS[r.s].short : null); else addKeys([d.data], t.cat, at >= 0 ? at : null);
  } else if (d.kind === 'cell') {
    if (nudge) flushNudge();   // (its own step first, so n0 tells whether the drop changed anything)
    const n0 = undoSeq;
    mutate(() => {
      const from = catOf(d.data); from.cells.splice(from.cells.indexOf(d.data), 1);
      // the lead (drawn first) let go in its own category anywhere but the front: drawn where the mark was, so not first
      if (!t.newcat && from.id === t.cat && catLook(t.cat).lead === d.data && t.before !== (from.cells.find(id => S.L.cells[id]) || null)) setLook('cat', t.cat, 'lead', '');
      let to = t.newcat ? null : S.L.cats.find(c => c.id === t.cat);
      if (!to) { to = { id: nid('c'), name: 'New category', collapsed: false, cells: [] }; S.L.cats.push(to); }
      const at = t.before ? to.cells.indexOf(t.before) : -1;
      to.cells.splice(at >= 0 ? at : to.cells.length, 0, d.data);
      // the selection follows the cell, but a drag doesn't open its settings (a click does): another cell's go away
      if (sel !== d.data) { DR.R.key = d.data; DR.R.byPick = false; }
      sel = d.data; selCat = null;
    });
    if (undoSeq === n0) renderView(false);   // (let go where it was: nothing changed, but the selection moved to it)
  }
}
function autoScroll() {
  if (!drag || !drag.started) return;
  const vr = sectionsEl.getBoundingClientRect(), y = drag.py;
  if (y != null && drag.px >= vr.left && drag.px <= vr.right && (y < vr.top + 40 || y > vr.bottom - 40)) { sectionsEl.scrollTop += y < vr.top + 40 ? -12 : 12; hitTest(drag.px, drag.py); }
  requestAnimationFrame(autoScroll);
}

// ---------- arranging (edit mode): dropping a category on another, the handles, the arrangement as data ----------
function vset(vn) { if (!S.L.views) S.L.views = {}; return S.L.views[vn] || (S.L.views[vn] = {}); }
// a look in the view on screen (kind cat or cell); an empty value takes it away
function setLook(kind, id, key, val, vn) {
  const v = vset(vn || S.screen), m = v[kind] || (v[kind] = {}), e = m[id] || (m[id] = {});
  if (val === undefined || val === '' || val === null) delete e[key]; else e[key] = val;
  if (!Object.keys(e).length) delete m[id];
  if (!Object.keys(m).length) delete v[kind];
}
// a tile's size (in tiles, see SZ); 1 x 1 takes it away
function setSize(id, w, h, tol) {
  const z = cellSize(id), keep = x => Math.abs(x) < 1e-9 ? 1.5e-4 : tol;   // (a side not changed keeps its size as stored)
  const v = vset('tiles'), m = v.cell || (v.cell = {}), e = m[id] || (m[id] = {});
  delete e.size; delete e.w; delete e.h; Object.assign(e, sizeLook(w, h, keep(w - z.w), keep(h - z.h)));
  if (!Object.keys(e).length) delete m[id];
  if (!Object.keys(m).length) delete v.cell;
}
// an Automatic view as rows, read off the screen, so making it your own moves nothing: the categories that share a top
// are one row, left to right; Grid: each table a column
function screenRows() {
  if (S.screen === 'grid') {
    const cols = [...document.querySelectorAll('#view .gtable')].map(t => ({ stack: [...t.querySelectorAll('tbody.dcat:not(.cont)')].map(b => b.dataset.cat) }));
    return cols.some(c => c.stack.length) ? [{ cols }] : [];   // (an empty table goes when the view is tidied)
  }
  if (lastAuto[S.screen] && !isCustom(S.screen)) return clone(lastAuto[S.screen]);
  const rows = [];
  for (const el of document.querySelectorAll('#view > .dcat')) {
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    let row = rows.find(q => Math.abs(q.top - r.top) < 4);
    if (!row) rows.push(row = { top: r.top, items: [] });
    row.items.push({ id: el.dataset.cat, left: r.left });
  }
  rows.sort((a, b) => a.top - b.top);
  const out = rows.map(q => ({ cols: q.items.sort((a, b) => a.left - b.left).map(it => ({ stack: [it.id] })) }));
  const seen = new Set(out.flatMap(r => r.cols.map(c => c.stack[0])));
  for (const c of S.L.cats) if (!seen.has(c.id)) out.push({ cols: [{ stack: [c.id] }] });
  return out;
}
const rowsNow = vn => { const v = stored(vn || S.screen); return v && v.rows ? clone(v.rows) : screenRows(); };
// makes the view on screen your own if it isn't yet (inside a mutate, before anything else changes the screen)
function ownRows(vn) { vn = vn || S.screen; const v = vset(vn); if (!v.rows) { v.rows = screenRows(); froze = true; } return v.rows; }
let froze = false;   // set when a change made a view your own: the toast says so (with Undo)
function layoutChange(fn) {
  if (nudge) flushNudge();   // (a Ctrl+arrow just before is its own, earlier step)
  froze = false; flipNext = true;
  const before = snapOf(); fn(); tidyViews(S.L);
  if (snapOf() === before) { flipNext = false; syncUndo(); renderInsp(); return false; }
  pushUndo(before); afterChange(); flipNext = false;
  if (froze) toast(VNAME[S.screen] + ' now uses your own arrangement', true);
  return true;
}
function posIn(rows, id) {
  for (let ri = 0; ri < rows.length; ri++) for (let ci = 0; ci < rows[ri].cols.length; ci++) {
    const k = rows[ri].cols[ci].stack.findIndex(s => sid(s) === id);
    if (k >= 0) return { ri, ci, k, row: rows[ri], col: rows[ri].cols[ci] };
  }
  return null;
}
// moves a category: t.zone left / right (a column of its own beside t.cat; Grid: a table beside table t.table), above /
// below (stacked over or under t.cat), swap (the two trade places, each keeps the slot's height), row (a row of its own
// at index t.at), into (Grid: the end of table t.table)
function placeCat(rows, src, t) {
  const PH = '\u0000', s0 = posIn(rows, src);
  if (t.zone === 'swap') {
    const p = posIn(rows, t.cat); if (!s0 || !p) return rows;
    const hs = s0.col.stack[s0.k].h, ht = p.col.stack[p.k].h;
    s0.col.stack[s0.k] = ht ? { id: t.cat, h: ht } : t.cat; p.col.stack[p.k] = hs ? { id: src, h: hs } : src;
    return rows;
  }
  if (s0) s0.col.stack[s0.k] = PH;   // marked first and removed last, so every index below stays right
  if (t.zone === 'row') rows.splice(Math.max(0, Math.min(rows.length, t.at)), 0, { cols: [{ stack: [src] }] });
  else if (t.table != null) {
    const cols = rows[0].cols;
    if (t.zone === 'into') cols[t.table].stack.push(src);
    else cols.splice(t.table + (t.zone === 'right' ? 1 : 0), 0, { stack: [src] });
  } else {
    const p = posIn(rows, t.cat);
    if (!p) { if (s0) s0.col.stack[s0.k] = src; return rows; }
    if (t.zone === 'above' || t.zone === 'below') p.col.stack.splice(p.k + (t.zone === 'below' ? 1 : 0), 0, src);
    else { p.row.cols.splice(p.ci + (t.zone === 'right' ? 1 : 0), 0, { stack: [src] }); for (const c of p.row.cols) delete c.w; }
  }
  for (const r of rows) for (const c of r.cols) c.stack = c.stack.filter(s => s !== PH);
  for (const r of rows) r.cols = r.cols.filter(c => c.stack.length);
  const out = rows.filter(r => r.cols.length);
  for (const r of out) if (r.cols.length < 2) for (const c of r.cols) delete c.w;
  return out;
}
// the rows of the arrangement being dragged over, as boxes on screen (from the categories they hold)
function rowBoxes(rows) {
  return rows.map(r => {
    let b = null;
    for (const c of r.cols) for (const s of c.stack) {
      const el = document.querySelector('#view .dcat[data-cat="' + sid(s) + '"]'); if (!el) continue;
      const q = el.getBoundingClientRect(); if (!q.width) continue;
      b = b ? { left: Math.min(b.left, q.left), top: Math.min(b.top, q.top), right: Math.max(b.right, q.right), bottom: Math.max(b.bottom, q.bottom) } : { left: q.left, top: q.top, right: q.right, bottom: q.bottom };
    }
    return b;
  });
}
// where a dragged category would land, with the mark and the sentence that say it
function catTarget(x, y, prev) {
  const src = drag.data, vn = S.screen, rows = drag.rows, nm = id => (catById(id) || {}).name || '';
  const fs = parseFloat(document.documentElement.style.fontSize) || 13, sv = sectionsEl.getBoundingClientRect();
  const mk = (cls, l, t, w, h) => { dropmark.className = 'dropmark' + (cls ? ' ' + cls : ''); Object.assign(dropmark.style, { display: 'block', left: (l - sv.left + sectionsEl.scrollLeft) + 'px', top: (t - sv.top + sectionsEl.scrollTop) + 'px', width: w + 'px', height: h + 'px' }); };
  const others = c => !(c.stack.length === 1 && sid(c.stack[0]) === src);
  let t = null;
  const edgeZone = (r, id, side) => {
    const keep = prev && prev.cat === id ? prev.zone : null;
    const ew = Math.min(120, Math.max(24, r.width * 0.25)) + (keep === 'left' || keep === 'right' ? 6 : keep === 'swap' ? -6 : 0);
    const eh = Math.max(20, r.height * 0.3) + (keep === 'above' || keep === 'below' ? 6 : keep === 'swap' ? -6 : 0);
    return side || (x < r.left + ew ? 'left' : x > r.right - ew ? 'right' : y < r.top + eh ? 'above' : y > r.bottom - eh ? 'below' : 'swap');
  };
  if (vn === 'grid') {
    const tables = [...document.querySelectorAll('#view .gtable')];
    if (!tables.length) return null;
    let ti = -1, bd = Infinity;
    tables.forEach((tb, i) => { const r = tb.getBoundingClientRect(), dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0, d = dx * dx + dy * dy; if (d < bd) { bd = d; ti = i; } });
    const r = tables[ti].getBoundingClientRect(), keepSide = prev && prev.table === ti && (prev.zone === 'left' || prev.zone === 'right');
    const ew = Math.min(70, Math.max(24, r.width * 0.08)) + (keepSide ? 6 : 0);
    if (x < r.left + ew || x > r.right - ew) {
      const side = x < r.left + ew ? 'left' : 'right';
      if (rows[0].cols.filter(others).length >= MAXC.grid) { t = { zone: 'full', txt: 'Three tables at most' }; mk('full', side === 'left' ? r.left - 6 : r.right + 3, r.top, 3, r.height); }
      else { t = { zone: side, table: ti, txt: 'A new table on the ' + side }; mk('', side === 'left' ? r.left - 6 : r.right + 3, r.top, 3, r.height); }
      return t;
    }
    const groups = [...tables[ti].querySelectorAll('tbody.dcat')].filter(b => b.dataset.cat !== src);
    if (!groups.length) { mk('box', r.left, r.top, r.width, r.height); return { zone: 'into', table: ti, txt: 'Into this table' }; }
    let g = groups.find(b => { const q = b.getBoundingClientRect(); return y >= q.top && y <= q.bottom; });
    if (!g) g = y < groups[0].getBoundingClientRect().top ? groups[0] : groups[groups.length - 1];
    const q = g.getBoundingClientRect(), id = g.dataset.cat, keep = prev && prev.cat === id ? prev.zone : null;
    const eh = Math.max(12, q.height * 0.3) + (keep === 'above' || keep === 'below' ? 6 : keep === 'swap' ? -6 : 0);
    const z = y < q.top + eh ? 'above' : y > q.bottom - eh ? 'below' : 'swap';
    if (z === 'swap') mk('box', q.left, q.top, q.width, q.height); else mk('', r.left + 8, z === 'above' ? q.top - 2 : q.bottom - 1, r.width - 16, 3);
    return { zone: z, cat: id, txt: z === 'swap' ? 'Swap with ' + nm(id) : (z === 'above' ? 'Over ' : 'Under ') + nm(id) };
  }
  const els = [...document.querySelectorAll('#view .dcat')].filter(el => el.dataset.cat !== src && el.getClientRects().length);
  const boxes = rowBoxes(rows), rg = 0.92 * fs, cg = (vn === 'tiles' ? 1.7 : 0.92) * fs;
  let el = els.find(e => { const r = e.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }), side = null;
  if (!el) {
    // not on a category: beside the nearest one in this row, else between two rows (a row of its own)
    const ri = boxes.findIndex(b => b && y >= b.top && y <= b.bottom);
    const inRow = ri < 0 ? [] : els.filter(e => { const p = posIn(rows, e.dataset.cat); return p && p.ri === ri; });
    if (inRow.length) {
      let bd = Infinity;
      for (const e of inRow) { const r = e.getBoundingClientRect(), d = x < r.left ? r.left - x : x > r.right ? x - r.right : Math.abs(y - (r.top + r.bottom) / 2) / 4; if (d < bd) { bd = d; el = e; } }
      const r = el.getBoundingClientRect();
      side = x < r.left ? 'left' : x > r.right ? 'right' : y > r.bottom ? 'below' : 'above';
    } else {
      const at = ri >= 0 ? ri : boxes.filter(b => b && b.bottom < y).length;
      const above = boxes[at - 1], below = boxes[at], my = above && below ? (above.bottom + below.top) / 2 : below ? below.top - rg / 2 : above ? above.bottom + rg / 2 : y;
      const vr = $('view').getBoundingClientRect();
      mk('', vr.left, my - 1.5, vr.width, 3);
      return { zone: 'row', at, txt: 'A row of its own, full width' };
    }
  }
  const r = el.getBoundingClientRect(), id = el.dataset.cat, p = posIn(rows, id), zone = edgeZone(r, id, side);
  if (zone === 'left' || zone === 'right') {
    const box = boxes[p.ri] || r, col = (el.closest('.lcol') || el).getBoundingClientRect();
    const bx = zone === 'left' ? col.left - cg / 2 - 1.5 : col.right + cg / 2 - 1.5;
    if (p.row.cols.filter(others).length >= MAXC[vn]) { mk('full', bx, box.top, 3, box.bottom - box.top); return { zone: 'full', txt: 'This row is full (' + MAXC[vn] + ' side by side)' }; }
    mk('', bx, box.top, 3, box.bottom - box.top);
    return { zone, cat: id, txt: 'Beside ' + nm(id) + ', on the ' + zone };
  }
  if (zone === 'above' || zone === 'below') {
    const by = zone === 'above' ? r.top - rg / 2 - 1.5 : r.bottom + rg / 2 - 1.5;
    if (p.col.stack.filter(s => sid(s) !== src).length >= MAXS[vn]) { mk('full', r.left, by, r.width, 3); return { zone: 'full', txt: 'This column is full (' + MAXS[vn] + ' stacked)' }; }
    mk('', r.left, by, r.width, 3);
    return { zone, cat: id, txt: 'Stacked ' + (zone === 'above' ? 'over ' : 'under ') + nm(id) };
  }
  mk('box', r.left, r.top, r.width, r.height);
  return { zone: 'swap', cat: id, txt: 'Swap with ' + nm(id) };
}
function dropCat(d) {
  const t = d.target, vn = S.screen, src = d.data;
  if (!t || t.zone === 'full') return;
  // an Automatic view stays automatic when only the order changes: a swap, a row of its own, Grid up and down
  if (d.auto && (t.zone === 'swap' || (vn === 'grid' && (t.zone === 'above' || t.zone === 'below')))) {
    const order = S.L.cats.map(c => c.id);   // (your order: Automatic columns read top to bottom, not in it)
    if (t.zone === 'swap') { const i = order.indexOf(src), j = order.indexOf(t.cat); order[i] = t.cat; order[j] = src; }
    else {
      const ref = t.zone === 'row' ? (t.at < d.rows.length ? sid(d.rows[t.at].cols[0].stack[0]) : null) : t.cat;
      if (ref === src) return;
      order.splice(order.indexOf(src), 1);
      const j = ref ? order.indexOf(ref) + (t.zone === 'below' ? 1 : 0) : order.length;
      order.splice(j, 0, src);
    }
    layoutChange(() => { S.L.cats = order.map(catById).filter(Boolean).concat(S.L.cats.filter(c => !order.includes(c.id))); });
    return;
  }
  layoutChange(() => { const v = vset(vn); if (!v.rows) froze = true; v.rows = placeCat(clone(d.rows), src, t); });
}

// ---------- the handles: the line between two columns (widths), the strip under a row (height), a tile's corner ----------
let rs = null;
const lpill = document.createElement('div'); lpill.className = 'lpill'; document.body.appendChild(lpill);
function pill(txt, x, y) { lpill.textContent = txt; lpill.style.left = x + 'px'; lpill.style.top = y + 'px'; lpill.classList.add('on'); }
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const frac = (a, t) => { const g = gcd(a, t) || 1; return a / g + '/' + t / g; };
const baseWidths = cols => { const n = cols.length; return cols.every(c => c.w) ? cols.map(c => c.w) : Array(n).fill(12 % n ? 2 : 12 / n); };
// a row's widths in twelfths: yours, or (following content) what the screen shows now
function widthsNow(ri, cols) {
  if (cols.every(c => c.w)) return cols.map(c => c.w);
  const el = document.querySelector('#view .lrow[data-r="' + ri + '"]'), cs = el ? [...el.children].filter(e => e.classList.contains('lcol')) : [];
  if (cs.length !== cols.length || el.classList.contains('fold')) return baseWidths(cols);
  const px = cs.map(c => c.getBoundingClientRect().width), tot = px.reduce((a, b) => a + b, 0) || 1, w = px.map(x => Math.max(1, Math.round(x / tot * 12)));
  for (let diff = 12 - w.reduce((a, b) => a + b, 0), i = 0; diff && i < 50; i++) { const j = w.indexOf(diff > 0 ? Math.min(...w) : Math.max(...w)); if (diff < 0 && w[j] <= 1) break; w[j] += Math.sign(diff); diff -= Math.sign(diff); }
  return w;
}
const heightTxt = h => h ? 'Fill' : 'Fit';
// ---- tile sizes: its corner, the numbers in its settings, Ctrl+arrows ----
// a drawn tile: its category (k tiles to a row), a spot's width p (a gap included), and at(w, h): how tall in px the
// tile and all the category's tiles would be with this tile at w x h (the others as they are)
function tileGeo(tile) {
  const tg = tile && tile.parentElement; if (!tg || !tg.classList.contains('pk') || !tg._L) return null;
  const kids = tileKids(tg), j = kids.indexOf(tile); if (j < 0) return null;
  const k = +tg.style.getPropertyValue('--k') || 1, fs = parseFloat(document.documentElement.style.fontSize) || 13, g = 0.62 * fs * spOf($('view')), short = tg.classList.contains('shorts');
  const row = tg.closest('.lrow'), grNow = () => row && row.classList.contains('grow') && !short ? parseFloat(row.style.getPropertyValue('--gr')) || 0 : 0;
  const sz = kids.map(szOf), nat = kids.map(x => natOf(x, short)), tr = tg.getBoundingClientRect();
  const at = (w, h) => { const s = sz.slice(); s[j] = { w, h, nl: sz[j].nl }; const L = placeTiles(s, nat, k, g / fs, !short && !!row && !!row.dataset.fill), p = L.pos[j], gr = grNow(); return { th: p.th * fs + p.h * gr, TH: L.TH * fs + L.H * gr, x: p.x, y: p.y }; };
  return { tg, j, k, g, fs, tw: tr.width, p: (tr.width + g) / k, at, r: tile.getBoundingClientRect(), s: sz[j] };
}
const tileEl = cid => document.querySelector('#view .tile[data-cid="' + CSS.escape(cid) + '"]');
const pxW = (G, w) => Math.min(w, G.k) * G.p - G.g;
// the height (0.25 to 2) at which f (rising with it) comes closest to the target (cur: the size it has, kept when it is
// already within half a pixel)
function solveSize(f, target, cur) {
  if (cur !== undefined && Math.abs(f(cur) - target) <= 0.5) return cur;
  let lo = 0.25, hi = 2;
  if (f(lo) >= target) return lo;
  if (f(hi) <= target) return hi;
  for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (f(m) < target) lo = m; else hi = m; }   // (to 0.0001 of a tile)
  return Math.abs(f(lo) - target) < Math.abs(f(hi) - target) ? lo : hi;
}
// where a category's column ends, and where the columns beside it end (Automatic: the categories that start level with
// it); a folded row has nothing beside it
const lastBottom = c => { const ks = [...c.children].filter(e => e.classList.contains('dcat')); return ks.length ? ks[ks.length - 1].getBoundingClientRect().bottom : 0; };
function colEnds(blk) {
  const col = blk.closest('.lcol'), cols = [];
  let own = null, row = null;
  if (col) {
    row = col.parentElement;
    if (!row.classList.contains('fold')) for (const c of row.children) if (c.classList.contains('lcol')) { const b = lastBottom(c); if (c === col) own = b; else if (b) cols.push(b); }
  } else {
    const r = blk.getBoundingClientRect(); own = r.bottom;
    for (const b of document.querySelectorAll('#view > .dcat')) if (b !== blk) { const q = b.getBoundingClientRect(); if (q.width && Math.abs(q.top - r.top) < 4) cols.push(q.bottom); }
  }
  return { own, cols, row };
}
const nearest = (xs, v, thr) => { let b = null; for (const x of xs) if (Math.abs(x - v) <= thr && (b === null || Math.abs(x - v) < Math.abs(b - v))) b = x; return b; };
const setTileSz = (t, w, h) => { if (w !== 1) t.dataset.w = w; else delete t.dataset.w; if (h !== 1) t.dataset.h = h; else delete t.dataset.h; };
const fmtSz = n => String(Math.round(n * 100) / 100);
const r4 = n => Math.round(n * 1e4) / 1e4;
// the lines a size snapped to
const gdiv = [0, 1].map(() => { const d = document.createElement('div'); d.className = 'sguide'; document.body.appendChild(d); return d; });
let guideBox = null;   // the view's box, read when a drag starts (no layout read on every move)
function guides(lines) {
  if (!lines || !lines.length) { for (const d of gdiv) d.classList.remove('on'); return; }
  const vr = guideBox || sectionsEl.getBoundingClientRect();
  gdiv.forEach((d, i) => {
    const l = lines && lines[i]; d.classList.toggle('on', !!l); if (!l) return;
    if (l.x != null) Object.assign(d.style, { left: Math.round(l.x) + 'px', top: vr.top + 'px', width: '1px', height: vr.height + 'px' });
    else { const a = l.from != null ? l.from : vr.left, b = l.to != null ? l.to : vr.right; Object.assign(d.style, { left: a + 'px', top: Math.round(l.y) + 'px', width: (b - a) + 'px', height: '1px' }); }
  });
}
// dragging the corner: its top-left stays, only its category is placed again until it is let go. Snaps to quarter
// steps, to the edges of the other tiles and to the bottom of the columns beside it; Alt: any size, to the pixel
function startCorner(tile) {
  const G = tileGeo(tile); if (!G) return false;
  const xs = [], ys = [];
  const after = new Set(tileKids(G.tg).slice(G.j + 1));
  for (const t of document.querySelectorAll('#view .tile')) if (t !== tile && !after.has(t)) { const r = t.getBoundingClientRect(); if (r.width) { xs.push(r.left, r.right); ys.push(r.top, r.bottom); } }
  xs.push(G.tg.getBoundingClientRect().right);
  guideBox = sectionsEl.getBoundingClientRect();
  const w0 = Math.min(G.s.w, G.k), a0 = G.at(w0, G.s.h);
  Object.assign(rs, G, { kind: 'corner', tile, cid: tile.dataset.cid, w0, h0: G.s.h, w: G.s.w, h: G.s.h, th0: a0.th, TH0: a0.TH, sx: a0.x, sy: a0.y, xs, ys, ends: colEnds(tile.closest('.dcat')) });
  return true;
}
function moveCorner(ev) {
  const R = rs, maxW = Math.min(2, R.k), thr = 7, lines = [], seen = new Map(), at0 = R.at;
  R.at = (w, h) => { const key = w + '|' + h; if (!seen.has(key)) seen.set(key, at0(w, h)); return seen.get(key); };   // each size placed once per move
  try { moveCorner0(ev, R, maxW, thr, lines); } finally { R.at = at0; }
}
function moveCorner0(ev, R, maxW, thr, lines) {
  R.last = { clientX: ev.clientX, clientY: ev.clientY };
  // a side the pointer hasn't moved along keeps its size as it is (a wide tile in a one-per-row category stays wide)
  const dx = ev.clientX - R.x0, dy = ev.clientY - R.y0, mx = Math.abs(dx) >= 3, my = Math.abs(dy) >= 3;
  let w = mx ? Math.min(maxW, Math.max(0.25, R.w0 + dx / R.p)) : R.s.w, level = false;
  // the snap nearest to where the pointer is wins: a quarter step, another tile's edge, (height) a column beside it
  // ending level, which wins a near tie
  const best = cs => cs.reduce((a, c) => c && (!a || c[0] < a[0]) ? c : a, null);
  if (!ev.altKey && mx) {
    const at = R.r.left + pxW(R, w), wq = Math.min(maxW, Math.max(0.25, Math.round(w * 4) / 4)), nx = nearest(R.xs, at, thr), wx = nx === null ? null : (nx - R.r.left + R.g) / R.p;
    const c = best([[Math.abs(R.r.left + pxW(R, wq) - at), wq], wx !== null && wx >= 0.25 - PE && wx <= maxW + PE ? [Math.abs(nx - at), wx, { x: nx }] : null]);
    w = c[1]; if (c[2]) lines.push(c[2]);
  }
  if (w >= maxW - PE && R.s.w > maxW) w = R.s.w;   // (a wide tile held to the row's width keeps its own)
  const th = hh => R.at(w, hh).th, col = hh => R.ends.own + R.at(w, hh).TH - R.TH0;
  let h = my ? solveSize(th, R.th0 + dy, R.h0) : R.h0;
  if (!ev.altKey && my) {
    const bottom = R.r.top + th(h), hq = Math.min(2, Math.max(0.25, Math.round(h * 4) / 4)), cs = [[Math.abs(R.r.top + th(hq) - bottom), hq]];
    const ny = nearest(R.ys, bottom, thr), hy = ny === null ? null : solveSize(th, ny - R.r.top);
    if (hy !== null && Math.abs(R.r.top + th(hy) - ny) < 0.6) cs.push([Math.abs(ny - bottom), hy, { y: ny }]);
    // level with a column beside it, when this tile sets where its column ends
    const E = R.ends;
    if (E.own !== null && E.cols.length && col(Math.min(2, h + 0.05)) - col(Math.max(0.25, h - 0.05)) > 0.5) {
      const c = nearest(E.cols, col(h), thr), hc = c === null ? null : solveSize(col, c);
      if (hc !== null && Math.abs(col(hc) - c) < 0.6) { const rr = E.row ? E.row.getBoundingClientRect() : null; cs.push([Math.abs(c - col(h)) - 3, hc, { y: c, from: rr ? rr.left : null, to: rr ? rr.right : null }, true]); }
    }
    const c = best(cs);
    h = c[1]; if (c[2]) lines.push(c[2]); level = !!c[3];
  }
  // it keeps its place under the pointer: growing into the room the next tiles take, or shrinking into a hole further
  // up, would move it away; it goes as far as it can where it is (a size typed in its settings can move it)
  const stays = (ww, hh) => { const a = R.at(ww, hh); return Math.abs(a.x - R.sx) < PE && Math.abs(a.y - R.sy) < PE; };
  const edge = (a, b, ok) => { let lo = a, hi = b; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; } return a < b ? Math.floor(lo * 1e4) / 1e4 : Math.ceil(lo * 1e4) / 1e4; };
  let full = false;
  if (!stays(w, h)) {
    full = true;
    if (stays(w, R.h0)) h = edge(R.h0, h, hh => stays(w, hh));
    else if (stays(R.s.w, h)) w = edge(R.s.w, w, ww => stays(ww, h));
    else { w = R.s.w; h = R.h0; }
  }
  R.w = r4(w); R.h = r4(h);
  setTileSz(R.tile, R.w, R.h);
  packTg(R.tg, R.k); tileFit(R.tg, R.tw, R.k, R.g, R.fs);
  if (R.tg.closest('.lrow.grow')) growPass();   // a Fill row shares its spare room again
  guides(lines);
  const pw = Math.round(pxW(R, R.w)), ph = Math.round(th(R.h));
  if (sel === R.cid) for (const [k, v] of [['w', R.w], ['h', R.h], ['pw', pw], ['ph', ph]]) { const b = document.querySelector('#insp input[data-sz="' + k + '"]'); if (b) b.value = v; }
  pill(fmtSz(R.w) + ' x ' + fmtSz(R.h) + ' tiles, ' + pw + ' x ' + ph + ' px' + (level ? ', level with the column beside it' : '') + (full ? ', as far as it goes in its place' : ''), ev.clientX + 14, ev.clientY + 10);
}
// the numbers in a tile's settings: in tiles, or in px at this window size
function sizeInput(cid, which, v) {
  if (nudge) flushNudge();   // (a Ctrl+arrow just before: its side counts)
  const z = cellSize(cid);
  if (!isFinite(v) || v <= 0) { renderInsp(); return; }
  let w = z.w, h = z.h, tol = SNAPQ;
  if (which === 'w') w = v; else if (which === 'h') h = v;
  else {
    const G = tileGeo(tileEl(cid)); if (!G) return;
    tol = snapAt(G);
    if (which === 'pw') w = (v + G.g) / G.p; else h = solveSize(hh => G.at(Math.min(w, G.k), hh).th, v);
  }
  const off = x => x < 0.25 - 1e-3 || x > 2 + 1e-3;
  if (off(w) || off(h)) toast('A tile is 0.25 to 2 tiles each way: this one is as close as it gets');
  mutate(() => setSize(cid, w, h, tol));
  if (which === 'pw' || which === 'ph') exactPx(cid, which, v);
}
// a size typed in px: the view may find a new text size for it (a taller tile can make everything a little smaller),
// so it is measured again and set once or twice more, in the same undo step
function exactPx(cid, which, v) {
  for (let i = 0; i < 2; i++) {
    const G = tileGeo(tileEl(cid)), z = cellSize(cid); if (!G) return;
    const now = which === 'pw' ? pxW(G, z.w) : G.at(Math.min(z.w, G.k), z.h).th;
    if (Math.abs(now - v) <= 0.5) return;
    const w = which === 'pw' ? (v + G.g) / G.p : z.w, h = which === 'ph' ? solveSize(hh => G.at(Math.min(w, G.k), hh).th, v) : z.h, tol = snapAt(G), was = JSON.stringify(sizeLook(z.w, z.h, tol));
    if (JSON.stringify(sizeLook(w, h, tol)) === was) return;
    setSize(cid, w, h, tol); afterChange();
  }
}
// Ctrl+arrows: a pixel wider, narrower, taller or shorter; with Shift to the next quarter step. Shown at once on its
// category only; kept (one undo step, the view fitted again) once the keys rest, so a held key never queues redraws
let nudge = null, nudgeT = 0;
function flushNudge() {
  clearTimeout(nudgeT);
  const n = nudge; nudge = null; lpill.classList.remove('on');
  if (!n || !S.L.cells[n.cid]) return;
  keyLayout(() => mutate(() => setSize(n.cid, n.w, n.h, n.tol)));
  const inSz = !!(document.activeElement && document.activeElement.matches && document.activeElement.matches('#insp input[data-sz]'));   // (pressed in a size field: the redraw gave it back its focus, it keeps it)
  const e = tileEl(n.cid); if (e && n.cid === sel && !inSz) e.focus({ preventScroll: true });
}
function nudgeSize(cid, dx, dy, quarter) {
  if (nudge && nudge.cid !== cid) flushNudge();
  const t = tileEl(cid), G = tileGeo(t); if (!G) return;
  const z = nudge && nudge.cid === cid ? { w: nudge.w, h: nudge.h } : cellSize(cid);
  const q = (v, d) => (d > 0 ? Math.floor(v * 4 + PE) + 1 : Math.ceil(v * 4 - PE) - 1) / 4, w0 = Math.min(z.w, G.k), lim = (v, mx) => r4(Math.min(mx, Math.max(0.25, v)));
  // (only the side the arrow moves changes: a wide tile in a one-per-row category stays wide)
  const w = !dx || (dx > 0 && z.w >= G.k - PE) ? z.w : lim(quarter ? q(w0, dx) : (pxW(G, w0) + dx + G.g) / G.p, Math.min(2, G.k));   // (a wide tile held to the row stays wide)
  const h = !dy ? z.h : lim(quarter ? q(z.h, dy) : solveSize(hh => G.at(w0, hh).th, G.at(w0, z.h).th + dy, z.h), 2);
  nudge = { cid, w, h, tol: quarter ? SNAPQ : snapAt(G) };
  setTileSz(t, w, h); packTg(G.tg, G.k); tileFit(G.tg, G.tw, G.k, G.g, G.fs);
  const r = t.getBoundingClientRect();
  pill(fmtSz(w) + ' x ' + fmtSz(h) + ' tiles, ' + Math.round(r.width) + ' x ' + Math.round(r.height) + ' px', r.right + 6, r.bottom + 6);
  clearTimeout(nudgeT);
  nudgeT = setTimeout(function later() { if (rs || dragPt || (drag && drag.started)) { nudgeT = setTimeout(later, 350); return; } flushNudge(); }, 350);   // (not under a drag: the redraw would leave it on the old tiles)
}
// a category: every tile one width or height; Line up the bottom: its tiles taller or shorter, all by the same factor, just
// enough that its column ends level with the tallest one beside it
function catSizeInput(id, which, v) {
  const cat = catById(id); if (!cat || !isFinite(v) || v <= 0) { renderInsp(); return; }
  if (v < 0.25 - 1e-3 || v > 2 + 1e-3) toast('A tile is 0.25 to 2 tiles each way: these are as close as it gets');
  mutate(() => { for (const c of cellsOf(cat)) { const z = cellSize(c); setSize(c, which === 'w' ? v : z.w, which === 'h' ? v : z.h); } });
}
function fitRow(id) {
  const blk = document.querySelector('#view .blk[data-cat="' + CSS.escape(id) + '"]'), tg = blk && blk.querySelector('.tg.pk'), tiles = tg ? tileKids(tg) : [];
  const E = blk ? colEnds(blk) : null, G = tiles.length ? tileGeo(tiles[0]) : null;
  if (!G || !E.cols.length) { toast('Nothing beside it to line up with'); return; }
  const short = tg.classList.contains('shorts'), target = Math.max(...E.cols), base = tiles.map(szOf), nat = tiles.map(x => natOf(x, short));
  const row = tg.closest('.lrow'), gr = row && row.classList.contains('grow') && !short ? parseFloat(row.style.getPropertyValue('--gr')) || 0 : 0;
  const hs = f => base.map(s => r4(Math.min(2, Math.max(0.25, s.h * f))));
  const TH = f => { const h = hs(f), L = placeTiles(base.map((s, i) => ({ w: s.w, h: h[i], nl: s.nl })), nat, G.k, G.g / G.fs, !short && !!row && !!row.dataset.fill); return L.TH * G.fs + L.H * gr; };
  const TH1 = TH(1), end = f => E.own + TH(f) - TH1;
  let lo = 0.125, hi = 8;
  for (let i = 0; i < 24; i++) { const m = Math.sqrt(lo * hi); if (end(m) < target) lo = m; else hi = m; }
  const f = Math.abs(end(lo) - target) < Math.abs(end(hi) - target) ? lo : hi, miss = Math.round(Math.abs(end(f) - target)), h = hs(f);
  mutate(() => tiles.forEach((t, i) => setSize(t.dataset.cid, base[i].w, h[i])), miss > 1 ? 'As close as it gets: ' + miss + ' px off (a tile stays between 0.25 and 2 tiles tall)' : 'Its column now ends level with the tallest beside it');
}
function startHandle(ev, el) {
  const v = stored(S.screen);
  rs = { el, x0: ev.clientX, y0: ev.clientY, moved: false, pid: ev.pointerId };
  if (el.classList.contains('corner')) { if (!startCorner(el.closest('.tile'))) { rs = null; return; } }
  else {
    const rowEl = el.closest('.lrow'), ri = +rowEl.dataset.r, row = v && v.rows && v.rows[ri];
    if (!row) { rs = null; return; }
    if (el.classList.contains('ldiv')) {
      const base = widthsNow(ri, row.cols), cols = [...rowEl.children].filter(c => c.classList.contains('lcol'));
      const W = cols.reduce((a, c) => a + c.getBoundingClientRect().width, 0), T = base.reduce((a, b) => a + b, 0);
      Object.assign(rs, { kind: 'split', rowEl, ri, k: +el.dataset.k, base, w: base.slice(), T, unit: W / T });
    } else Object.assign(rs, { kind: 'rowh', ri, h0: row.h || 0, h: row.h || 0 });
  }
  el.classList.add('on');
}
function moveHandle(ev) {
  if (!rs) return;
  if (!rs.moved && Math.hypot(ev.clientX - rs.x0, ev.clientY - rs.y0) < 3) return;
  rs.moved = true;
  if (rs.kind === 'split') {
    const k = rs.k, d = Math.round((ev.clientX - rs.x0) / rs.unit);
    let a = rs.base[k] + d, b = rs.base[k + 1] - d;
    if (a < 1) { b -= 1 - a; a = 1; } if (b < 1) { a -= 1 - b; b = 1; }
    rs.w = rs.base.slice(); rs.w[k] = a; rs.w[k + 1] = b;
    delete rs.rowEl.dataset.auto;
    rs.rowEl.style.setProperty('--cols', colTracks(rs.w.map(w => ({ w }))));
    layoutPass(); growPass();
    pill(frac(a, rs.T) + ' | ' + frac(b, rs.T), ev.clientX, ev.clientY - 36);
  } else if (rs.kind === 'rowh') {
    const dy = ev.clientY - rs.y0;
    rs.h = dy > 18 ? 1 : dy < -18 ? 0 : rs.h0;
    const rowEl = document.querySelector('#view .lrow[data-r="' + rs.ri + '"]');
    if (rowEl) { if (rs.h) rowEl.dataset.fill = '1'; else delete rowEl.dataset.fill; layoutPass(); growPass(); }
    pill(heightTxt(rs.h), ev.clientX, ev.clientY - 36);
  } else moveCorner(ev);
}
function endHandle(cancel) {
  if (!rs) return;
  const h = rs; rs = null;
  if (refitLater) { refitLater = false; setTimeout(refit, 0); }
  if (viewLater) { viewLater = false; setTimeout(() => renderView(false), 0); }
  lpill.classList.remove('on'); h.el.classList.remove('on'); guides();
  justDragged = true; setTimeout(() => { justDragged = false; }, 0);
  if (!h.moved) return;
  if (cancel) { renderView(false); renderInsp(); return; }
  const before = snapOf();
  if (h.kind === 'split') mutate(() => { const row = stored(S.screen).rows[h.ri]; row.cols.forEach((c, i) => { c.w = h.w[i]; }); });
  else if (h.kind === 'rowh') mutate(() => { const row = stored(S.screen).rows[h.ri]; if (h.h) row.h = 1; else delete row.h; });
  else mutate(() => setSize(h.cid, h.w, h.h, snapAt(h)));
  if (snapOf() === before) { renderView(false); renderInsp(); }   // back where it started: draw it as it was
}
const rsOwn = ev => !rs || rs.pid == null || ev.pointerId === rs.pid;   // (only the pointer that started it)
document.addEventListener('pointermove', ev => { if (rsOwn(ev)) moveHandle(ev); });
document.addEventListener('pointerup', ev => { if (swallowUp(ev)) return; if (rsOwn(ev)) endHandle(false); });
document.addEventListener('pointercancel', ev => { if (rsOwn(ev)) endHandle(true); });
function handleDblclick(el) {
  if (el.classList.contains('corner')) { mutate(() => setSize(el.closest('.tile').dataset.cid, 1, 1)); return; }
  const v = stored(S.screen), ri = +el.closest('.lrow').dataset.r, row = v && v.rows && v.rows[ri]; if (!row) return;
  if (el.classList.contains('ldiv')) mutate(() => { for (const c of row.cols) delete c.w; });
  else mutate(() => { delete row.h; });
}

// ---------- moving and sizing a selected category (the buttons in its settings and the keys do the same) ----------
// Move: row = a row of its own under its row now, beside = the last column of the row above, stack = under the
// category on its left, unstack = a column of its own right of its stack
function moveOptions(id) {
  const rows = rowsNow(), p = posIn(rows, id), o = {};
  if (!p || S.screen === 'grid') return o;
  o.row = p.row.cols.length > 1 || p.col.stack.length > 1;
  o.beside = p.ri > 0 && rows[p.ri - 1].cols.length < MAXC[S.screen];
  o.stack = p.ci > 0 && p.row.cols[p.ci - 1].stack.length < MAXS[S.screen];
  o.unstack = p.col.stack.length > 1 && p.row.cols.length < MAXC[S.screen];
  return o;
}
function moveCat(id, how) {
  if (!moveOptions(id)[how]) return false;
  layoutChange(() => {
    const rows = ownRows(), p = posIn(rows, id);
    let t;
    if (how === 'row') t = { zone: 'row', at: p.ri + 1 };
    else if (how === 'beside') { const up = rows[p.ri - 1], last = up.cols[up.cols.length - 1]; t = { zone: 'right', cat: sid(last.stack[0]) }; }
    else if (how === 'stack') { const left = p.row.cols[p.ci - 1]; t = { zone: 'below', cat: sid(left.stack[left.stack.length - 1]) }; }
    else t = { zone: 'right', cat: sid(p.col.stack.find(s => sid(s) !== id)) };
    vset(S.screen).rows = placeCat(rows, id, t);
  });
  announce(id);
  return true;
}
// its column's width as twelfths of the row (the others keep their shares of what is left); 0 = Auto: the widths
// follow what each column holds
function setWidth(id, twelfths) {
  const p = posIn(rowsNow(), id); if (!p || p.row.cols.length < 2) return;
  if (!twelfths) { if (p.row.cols.every(c => c.w)) layoutChange(() => { const q = posIn(ownRows(), id); for (const c of q.row.cols) delete c.w; }); announce(id); return; }
  const now = widthsNow(p.ri, p.row.cols);
  layoutChange(() => {
    const rows = ownRows(), q = posIn(rows, id), cols = q.row.cols, base = now, T = base.reduce((a, b) => a + b, 0);
    const mine = Math.max(1, Math.min(12 - (cols.length - 1), twelfths)), rest = 12 - mine, others = T - base[q.ci];
    const w = base.map((b, i) => i === q.ci ? mine : Math.max(1, Math.round(b / others * rest)));
    let diff = 12 - w.reduce((a, b) => a + b, 0);
    for (let i = cols.length - 1, g = 0; diff !== 0 && g < 100; g++, i = (i + cols.length - 1) % cols.length) {
      if (i === q.ci) continue;
      if (diff > 0) { w[i]++; diff--; } else if (w[i] > 1) { w[i]--; diff++; }
    }
    cols.forEach((c, i) => { c.w = w[i]; });
  });
  announce(id);
}
function nudgeWidth(id, d) {
  const p = posIn(rowsNow(), id); if (!p || p.row.cols.length < 2) return;
  const now = widthsNow(p.ri, p.row.cols);
  { const w = now, j = p.ci < p.row.cols.length - 1 ? p.ci + 1 : p.ci - 1; if (w[p.ci] + d < 1 || w[j] - d < 1) return; }   // at the limit: nothing to do
  layoutChange(() => {
    const rows = ownRows(), q = posIn(rows, id), cols = q.row.cols, w = now.slice(), j = q.ci < cols.length - 1 ? q.ci + 1 : q.ci - 1;
    if (w[q.ci] + d < 1 || w[j] - d < 1) return;
    w[q.ci] += d; w[j] -= d;
    cols.forEach((c, i) => { c.w = w[i]; });
  });
  announce(id);
}
function setRowHeight(id, h) {
  if (!h && !isCustom(S.screen)) return;   // Automatic rows already fit
  layoutChange(() => { const rows = ownRows(), q = posIn(rows, id); if (!q) return; if (h) q.row.h = 1; else delete q.row.h; });
  announce(id);
}
// the category nearest to it on screen in a direction (for Alt+arrow)
function nearestCat(id, dx, dy) {
  const a = document.querySelector('#view .dcat[data-cat="' + id + '"]'); if (!a) return null;
  const ra = a.getBoundingClientRect(), ax = (ra.left + ra.right) / 2, ay = (ra.top + ra.bottom) / 2;
  let best = null, bd = Infinity;
  for (const el of document.querySelectorAll('#view .dcat')) {
    if (el === a || el.dataset.cat === id) continue;
    const r = el.getBoundingClientRect(), x = (r.left + r.right) / 2 - ax, y = (r.top + r.bottom) / 2 - ay, along = x * dx + y * dy;
    if (along <= 4) continue;
    const beside = dx ? r.top < ra.bottom - 1 && r.bottom > ra.top + 1 : r.left < ra.right - 1 && r.right > ra.left + 1;   // in its row (or column)
    const d = along + Math.abs(dx ? y : x) * 2 + (beside ? 0 : 1e5);
    if (d < bd) { bd = d; best = el.dataset.cat; }
  }
  return best;
}
// "Height: Fill the window" (Tiles): every row's tiles may grow into the room left under the view
function autoHeights(vn, rows) { for (const r of rows) { if (vn === 'tiles') r.h = 1; else delete r.h; } }
// "Start from": 2 or 3 categories a row (big ones get a row of their own), one a row, or a copy of the other view's rows
function templateRows(kind) {
  const vn = S.screen;
  if (kind === 'copy') { const o = stored(vn === 'tiles' ? 'overview' : 'tiles'); return o && o.rows ? clone(o.rows) : null; }
  const n = kind === 'two' ? 2 : kind === 'three' ? 3 : 1, rows = [];
  const big = c => vn === 'tiles' ? cellsOf(c).length > (n === 2 ? 6 : 9) || (catLook(c.id, vn).per || 0) >= 5 : catLook(c.id, vn).style === 'band';
  let cur = null;
  for (const c of S.L.cats) {
    if (n === 1 || big(c)) { rows.push({ cols: [{ stack: [c.id] }] }); cur = null; continue; }
    if (!cur || cur.cols.length >= n) rows.push(cur = { cols: [] });
    cur.cols.push({ stack: [c.id] });
  }
  return rows;
}
function templateView(kind) {
  const rows = templateRows(kind); if (!rows) return null;
  const v = clone(stored(S.screen) || {});
  if (v.rows && v.rows.length && v.rows.every(r => r.h)) autoHeights(S.screen, rows);   // (Fill the window: every row filled, not a mix)
  v.rows = rows;
  return v;
}
// Grid: the categories in reading order cut into n tables of about the same length
function gridTables(n) {
  const order = rowsNow('grid').flatMap(r => r.cols.flatMap(c => c.stack.map(sid))), len = id => cellsOf(catById(id)).length + 1;
  const total = order.reduce((a, id) => a + len(id), 0), cols = [];
  // each category by its middle; no table left empty, and a category kept for each table still to come
  let acc = 0;
  order.forEach((id, i) => {
    let k = Math.min(n - 1, Math.floor((acc + len(id) / 2) / total * n + 1e-9));
    k = Math.min(Math.max(k, n - (order.length - i), cols.length ? cols.length - 1 : 0), cols.length);
    while (cols.length <= k) cols.push({ stack: [] });
    cols[k].stack.push(id); acc += len(id);
  });
  return [{ cols: cols.filter(c => c.stack.length) }];
}
const live = $('live');
function announce(id) {
  const rows = rowsNow(), p = posIn(rows, id), cat = catById(id); if (!p || !cat) return;
  live.textContent = cat.name + ': row ' + (p.ri + 1) + ' of ' + rows.length + ', column ' + (p.ci + 1) + ' of ' + p.row.cols.length + (p.col.stack.length > 1 ? ', stacked ' + (p.k + 1) + ' of ' + p.col.stack.length : '');
}

// ---------- events: the view ----------
function setEdit(on) {
  // (a cell, a grip or a Storage row still held, not moved yet: it lets go, and its release does nothing)
  if (drag) { cancelPid = drag.pid; endDrag(true); }
  if (rs) { cancelPid = rs.pid; endHandle(true); }
  editPress = null;
  S.edit = on; app.classList.toggle('editing', on);
  $('editBtn').classList.toggle('on', on);
  preview = null;
  if (!on) { sel = null; selCat = null; endRelink(true); }
  syncDrawers();
  hidePrev(); saveState();
  renderView(false); renderStorage(); renderInsp(); placeTabInd(true);
}
$('editBtn').onclick = () => setEdit(!S.edit);
function newCategory() {
  mutate(() => S.L.cats.push({ id: nid('c'), name: 'New category', collapsed: false, cells: [] }));
  const all = document.querySelectorAll('#view .dcat'), el = all[all.length - 1];
  if (el) { el.scrollIntoView({ block: 'nearest' }); renameCat(el); }
}
$('newcat').onclick = newCategory; $('addCat').onclick = newCategory;
// ---------- edit mode: Storage (left) and the settings (right) are drawers over the view, so the view keeps the size it
// has outside edit mode. A drawer opens while the pointer rests on its tab or on it, and stays while pinned or while
// you type in it; Storage also while you pick a reading for a cell or the view is empty. The settings open when you
// select something and go once the pointer has been in them and left (the selection stays: their tab brings them back).
// While you drag, a drawer stays only as long as the pointer is on it (so the view under it takes the drop) ----------
const DR = { L: { el: document.querySelector('.storage'), tab: $('tabL'), pin: $('pinL') }, R: { el: document.querySelector('.insp'), tab: $('tabR'), pin: $('pinR') } };
for (const k of ['L', 'R']) Object.assign(DR[k], { pinned: false, hover: false, t: 0 });
function drawerOpen(k) {
  const d = DR[k]; if (!S.edit) return false;
  if (drag && drag.started) return d.hover;
  if (k === 'R' && dragPt) return true;   // (a fan curve point held: the drawer stays under it)
  const a = document.activeElement, typing = !!a && d.el.contains(a) && a.matches('input:not([type=checkbox]), select, textarea');
  if (d.hover || d.pinned || typing) return true;
  return k === 'L' ? !!relinkFor || (!S.L.cats.length && READ.length > 0) : d.byPick && (!!sel || !!selCat);
}
// the settings open on the side away from what you selected, so they never cover it (pinned or from their tab: the right)
function selOnRight() {
  const el = sel ? document.querySelector('#view .dc[data-cid="' + sel + '"]') : selCat ? document.querySelector('#view .dcat[data-cat="' + selCat + '"]') : null;
  if (!el) return false;
  const r = el.getBoundingClientRect(), v = sectionsEl.getBoundingClientRect();
  return r.right > v.right - DR.R.el.offsetWidth - 20 && r.left + r.width / 2 > v.left + v.width / 2;
}
function syncDrawers() {
  for (const k of ['L', 'R']) {
    const d = DR[k], key = sel || selCat || '';
    if (k === 'R' && key !== d.key) { d.byPick = !!key; d.pickT = Date.now(); }   // a new selection opens them
    const o = drawerOpen(k), was = d.el.classList.contains('open');
    if (k === 'R' && o && !d.pinned && !d.hover) d.left = !!key && selOnRight() && !DR.L.el.classList.contains('open');   // re-checked whenever it isn't in use (the selection may have moved or grown)
    else if (k === 'R' && o && !was && d.hover && !d.byPick) d.left = false;   // opened from its tab: by the tab
    if (k === 'R') { d.key = key; if (!o) d.left = d.left && was; if (d.pinned) d.left = false; d.el.classList.toggle('left', !!d.left && (o || was)); }   // pinned: always on the right
    d.el.classList.toggle('open', o); d.tab.classList.toggle('on', o);
    d.pin.classList.toggle('on', d.pinned); d.pin.setAttribute('aria-pressed', d.pinned);
  }
}
for (const k of ['L', 'R']) {
  const d = DR[k];
  const inside = e => !!e.relatedTarget && (d.el.contains(e.relatedTarget) || d.tab.contains(e.relatedTarget));
  const enter = () => { clearTimeout(d.t); if (!d.hover) d.t = setTimeout(() => { d.hover = true; syncDrawers(); }, d.el.classList.contains('open') ? 0 : 90); };
  const leave = e => { if (inside(e)) return; clearTimeout(d.t); d.t = setTimeout(() => { if (d.hover) d.byPick = false; d.hover = false; syncDrawers(); }, drag && drag.started ? 0 : 380); };
  for (const el of [d.el, d.tab]) { el.addEventListener('mouseenter', enter); el.addEventListener('mouseleave', leave); }
  d.tab.addEventListener('click', () => { d.pinned = true; d.hover = true; syncDrawers(); saveState(); });
  d.pin.addEventListener('click', () => { d.pinned = !d.pinned; syncDrawers(); saveState(); });
  d.el.addEventListener('focusin', syncDrawers);
  // settings opened by a selection and not touched while the pointer keeps working in the view: they slide away
  if (k === 'R') sectionsEl.addEventListener('pointermove', () => { if (d.byPick && !d.hover && !d.pinned && Date.now() - (d.pickT || 0) > 2000 && d.el.classList.contains('open')) { d.byPick = false; syncDrawers(); } });
  d.el.addEventListener('focusout', () => setTimeout(syncDrawers, 0));
}
$('undo').onclick = undo; $('redo').onclick = redo;
$('toastUndo').onclick = () => { if (nudge) flushNudge(); if (toastDepth >= 0 && undoSeq === toastDepth) undo(); $('toast').classList.remove('show'); retireToastUndo(); };   // (a nudge still to land is newer: the Undo is stale then)
// the clean view: a cell opens when a press that started on it is let go, by the cell it was, not by the element (a
// redraw between press and release, as when a fresh window settles, made the browser drop the click)
let press = null, openedByUp = 0, draggedUp = 0;
// editing: a cell or a category's header pressed (a typed size or name applies at the press, and its redraw can replace
// it before the release: the browser then drops the click, so the release selects it)
let editPress = null;
sectionsEl.addEventListener('pointerdown', ev => {
  if (!ev.isPrimary) return;   // (a second finger while one drags or presses)
  press = null; editPress = null;
  if (ev.button !== 0 || ev.target.closest('button,input') || (host && zoneAt(ev))) return;   // the window edge: a resize
  hidePrev();
  if (!S.edit) { const c = ev.target.closest('#view .dc'); if (c && !ev.target.closest('[data-x]')) press = { cid: c.dataset.cid, x: ev.clientX, y: ev.clientY }; return; }
  const hd = ev.target.closest('.ldiv, .lrs, .corner');
  if (hd) {
    // (a field with something typed in it: it applies first, its change redraws, so this press starts nothing and the
    // next one drags; a field that only has the focus lets go and the drag starts at once)
    const a = document.activeElement;
    if (a && a._typed && a.matches && a.matches('#insp input[data-sz], #insp input[data-csz], #lName')) { blurInsp(); ev.preventDefault(); return; }
    blurInsp();
    startHandle(ev, hd); ev.preventDefault(); return;
  }
  const g = ev.target.closest('.dch .grip');
  if (g) { const cat = g.closest('.dcat').dataset.cat; startDrag(ev, 'cat', cat, S.L.cats.find(c => c.id === cat).name); blurInsp(); ev.preventDefault(); return; }
  const cell = ev.target.closest('#view .dc'), hcat = !cell && ev.target.closest('#view .dcat');
  if (hcat && ev.target.closest('.dch, .ghdr, .bh')) editPress = { cat: hcat.dataset.cat, el: hcat, x: ev.clientX, y: ev.clientY };
  if (cell) {
    editPress = { cid: cell.dataset.cid, el: cell, x: ev.clientX, y: ev.clientY };
    const c = S.L.cells[cell.dataset.cid], r = c.key && BYKEY.get(c.key);
    startDrag(ev, 'cell', cell.dataset.cid, nameIn(cell.dataset.cid), r ? valTxt(r) : '');
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#insp')) document.activeElement.blur();
    ev.preventDefault(); cell.focus({ preventScroll: true });   // no text selection painted across the view while dragging
  }
});
sectionsEl.addEventListener('pointerup', ev => {
  const ep = editPress; editPress = null;
  if (ep && S.edit && ev.isPrimary && ev.button === 0 && !ep.el.isConnected && !(drag && drag.started) && Math.hypot(ev.clientX - ep.x, ev.clientY - ep.y) <= 8) {
    const at = document.elementFromPoint(ev.clientX, ev.clientY);
    const c = at && at.closest('#view .dc'), ce = at && at.closest('#view .dcat');
    let done = false;
    if (ep.cid && c && c.dataset.cid === ep.cid && S.L.cells[ep.cid]) { selectCell(ep.cid); done = true; }
    else if (ep.cat && !c && ce && ce.dataset.cat === ep.cat && at.closest('.dch, .ghdr, .bh') && !at.closest('button, input') && S.L.cats.some(x => x.id === ep.cat)) { selectCat(ep.cat); done = true; }
    if (done) { justDragged = true; setTimeout(() => { justDragged = false; }, 0); }   // (a click the browser still sends: not a second one)
  }
  const p = press; press = null;
  if (p && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 8) { draggedUp = performance.now(); return; }   // a drag, not a click: nothing opens
  if (!p || S.edit || ev.button !== 0 || !S.L.cells[p.cid]) return;
  const at = document.elementFromPoint(ev.clientX, ev.clientY), cell = at && at.closest('#view .dc');
  if (cell && cell.dataset.cid !== p.cid) return;   // (let go over another cell)
  openedByUp = performance.now(); openDetail(p.cid);
});
sectionsEl.addEventListener('click', ev => {
  if (justDragged) return;
  if (ev.target.closest('#setupRestart')) { restartHwinfo(); return; }
  const catEl = ev.target.closest('.dcat');
  if (ev.target.closest('.chev') && catEl) { const c = S.L.cats.find(x => x.id === catEl.dataset.cat); c.collapsed = !c.collapsed; saveState(); syncSaves(); renderView(false); return; }
  if (ev.target.closest('.ren') && catEl) { renameCat(catEl); return; }
  if (ev.target.closest('.del') && catEl) {
    const c = S.L.cats.find(x => x.id === catEl.dataset.cat);
    mutate(() => { for (const id of c.cells) delete S.L.cells[id]; S.L.cats = S.L.cats.filter(x => x !== c); fixSel(); }, 'Removed "' + c.name + '"');
    return;
  }
  if (ev.target.closest('.rl')) { startRelink(ev.target.closest('.dc').dataset.cid); return; }
  if (ev.target.closest('.ldiv, .lrs, .corner')) return;
  const cell = ev.target.closest('#view .dc');
  if (!S.edit) { if (cell && !ev.target.closest('[data-x]') && performance.now() - openedByUp > 500 && performance.now() - draggedUp > 500) openDetail(cell.dataset.cid); return; }   // (already open from the release, or a drag)
  if (cell) { selectCell(cell.dataset.cid); return; }
  // a category's header (its name, its empty space) selects the category; anywhere else: the view
  if (catEl && ev.target.closest('.dch, .ghdr, .bh') && !ev.target.closest('input')) { selectCat(catEl.dataset.cat); return; }
  if (ev.target.closest('.cn-in')) return;   // (a click in a category's rename box: it is being named, nothing else)
  if (sel || selCat) clearSel();
});
function selectCell(cid) {
  sel = cid; selCat = null; DR.R.byPick = true; DR.R.pickT = Date.now();
  for (const el of document.querySelectorAll('#view .dc.sel, #view .dcat.csel')) el.classList.remove('sel', 'csel');
  const el = document.querySelector('#view .dc[data-cid="' + cid + '"]'); if (el) el.classList.add('sel');
  renderInsp();
}
sectionsEl.addEventListener('dblclick', ev => {
  const hd = ev.target.closest('.ldiv, .lrs, .corner');
  if (hd && S.edit) { handleDblclick(hd); return; }
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
document.addEventListener('pointermove', ev => { if (dragOwn(ev)) moveDrag(ev); });
document.addEventListener('pointerup', ev => { if (swallowUp(ev)) return; if (dragOwn(ev)) endDrag(false); });
document.addEventListener('pointercancel', ev => { if (dragOwn(ev)) endDrag(true); });
// the spotlight under the pointer
let spotEl = null, spotX = 0, spotY = 0, spotRaf = 0;
sectionsEl.addEventListener('pointermove', e => {
  spotEl = e.target.closest('.tile, .card, .gtable'); spotX = e.clientX; spotY = e.clientY;
  if (!spotRaf) spotRaf = requestAnimationFrame(() => { spotRaf = 0; if (!spotEl) return; const b = spotEl.getBoundingClientRect(); spotEl.style.setProperty('--mx', Math.round(spotX - b.left) + 'px'); spotEl.style.setProperty('--my', Math.round(spotY - b.top) + 'px'); });
});
let scrollT = 0;
sectionsEl.addEventListener('scroll', () => { hidePrev(); if (!scrollT) scrollT = requestAnimationFrame(() => { scrollT = 0; if (!drag || !drag.started) updateView(false, true); }); });

// ---------- events: Storage ----------
$('vlist').addEventListener('scroll', () => requestAnimationFrame(drawRows));
$('q').addEventListener('input', e => { query = e.target.value; $('vlist').scrollTop = 0; renderStorage(); });
$('chips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; typeFilter = b.dataset.t; $('vlist').scrollTop = 0; renderStorage(); });
$('hideIn').addEventListener('click', () => { hideIn = !hideIn; $('hideIn').classList.toggle('on', hideIn); $('hideIn').setAttribute('aria-pressed', hideIn); renderStorage(); });
$('vspace').addEventListener('click', e => {
  if (e.target.closest('#qClear')) { query = ''; $('q').value = ''; typeFilter = 'all'; renderStorage(); return; }
  if (e.target.closest('#qHidden')) { typeFilter = 'hidden'; $('vlist').scrollTop = 0; renderStorage(); return; }
  const g = e.target.closest('.vrow.g');
  if (g) {
    const s = Number(g.dataset.gs), sk = SENS[s].key;
    const ha = e.target.closest('[data-act="hides"], [data-act="unhides"]');
    if (ha) {
      const keys = READ.filter(r => r.s === s).map(r => r.key), hide = ha.dataset.act === 'hides';
      setHide(h => { h.r = h.r.filter(k => !keys.includes(k)); h.show = h.show.filter(k => !keys.includes(k)); h.s = without(h.s, sk); h.showS = without(h.showS, sk);
        if (hide) h.s.push(sk); else if (READ.some(r => r.s === s && autoHid(r))) h.showS.push(sk); });
      toast(hide ? SENS[s].short + ' hidden from Storage: the Hidden chip brings it back' : SENS[s].short + ' is back in Storage');
      return;
    }
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
  if (act && (act.dataset.act === 'hide' || act.dataset.act === 'unhide')) {
    const k = row.dataset.key, r = BYKEY.get(k), hide = act.dataset.act === 'hide';
    // (shown again: an exception kept only while its sensor, or the default, would still hide it)
    setHide(h => { h.r = without(h.r, k); h.show = without(h.show, k); const sk = r && SENS[r.s] ? SENS[r.s].key : '';
      if (hide) h.r.push(k); else if (r && !h.showS.includes(sk) && (h.s.includes(sk) || autoHid(r))) h.show.push(k); });
    if (hide) toast((r ? r.label : 'It') + ' hidden from Storage: the Hidden chip brings it back');
    return;
  }
  if (act && act.dataset.act === 'add') { const t = targetForAdd(), r = BYKEY.get(row.dataset.key); addKeys([row.dataset.key], t.cat, t.index, r ? SENS[r.s].short : null); }
  if (act && act.dataset.act === 'link' && relinkFor) {
    const cid = relinkFor, r = BYKEY.get(row.dataset.key);
    if (!S.L.cells[cid] || !r) { endRelink(); renderView(false); return; }   // the cell went while picking
    mutate(() => { S.L.cells[cid].key = r.key; S.L.cells[cid].match = matchOf(r); S.L.cells[cid].u = r.unit; }, 'Re-linked');
    endRelink(); sel = cid; selCat = null; renderView(false); renderInsp();
  }
});
$('vspace').addEventListener('pointerdown', e => {
  if (!S.edit || !e.isPrimary || e.button !== 0 || e.target.closest('button') || relinkFor || (host && zoneAt(e))) return;
  const row = e.target.closest('.vrow.r'); if (!row) return;
  const r = BYKEY.get(row.dataset.key); if (!r) return;
  startDrag(e, 'row', r.key, r.label, valTxt(r)); blurInsp(); e.preventDefault();
});
$('addPred').onclick = () => {
  const t = targetForAdd(), src = guessTemp(null);
  mutate(() => {
    let cat = t.cat && S.L.cats.find(c => c.id === t.cat);
    if (!cat) { cat = { id: nid('c'), name: 'Fans', collapsed: false, cells: [] }; S.L.cats.push(cat); }
    const id = nid('a');
    S.L.cells[id] = { pred: true, name: 'Predicted fan', graph: true, curve: { src: src ? src.key : '', pts: [[30, 500], [50, 800], [70, 1300], [85, 1800]].map(p => [cToU(p[0], src), p[1]]), tol: 15, hold: 10 } };
    cat.cells.splice(t.index == null ? cat.cells.length : t.index, 0, id); sel = id; selCat = null;
  });
};
function startRelink(cid) {
  if (!S.edit) setEdit(true);
  relinkFor = cid; sel = cid; selCat = null; const c = S.L.cells[cid];
  const lbl = c.match ? c.match.split('|')[1] : '';
  $('relinkBar').hidden = false; $('relinkTxt').textContent = 'Pick the reading for "' + (c.name || lbl || 'this cell') + '"';
  // the search starts with the label; if this PC calls it something else, the list says so and offers everything
  query = lbl; $('q').value = lbl; typeFilter = 'all'; renderStorage(); renderView(false); renderInsp();
}
function endRelink(quiet) { if (!relinkFor && quiet) return; relinkFor = null; $('relinkBar').hidden = true; query = ''; $('q').value = ''; if (!quiet) renderStorage(); syncDrawers(); }
$('relinkCancel').onclick = () => { endRelink(); renderView(false); };

// ---------- the right panel: a cell's settings, a category's, or the view's ----------
// the field that had the focus gets it back after the panel is drawn again (a size typed, then Tab or the arrows)
function inspFocus(box) {
  const a = document.activeElement;
  if (!a || !box.contains(a)) return () => {};
  const q = a.id ? '#' + CSS.escape(a.id) : a.dataset.sz ? '[data-sz="' + a.dataset.sz + '"]' : a.dataset.csz ? '[data-csz="' + a.dataset.csz + '"]' : null;
  return () => { const e = q && box.querySelector(q); if (e && e !== document.activeElement) e.focus({ preventScroll: true }); };
}
function renderInsp() {
  const box = $('insp'), refocus = inspFocus(box);
  const c = sel && S.L.cells[sel], cat = !c && selCat ? catById(selCat) : null;
  syncDrawers();
  setText($('inspTitle'), c ? 'Cell' : cat ? 'Category' : S.screen === 'overview' ? 'Overview' : VNAME[S.screen] + ' view');
  if (!S.edit) return;
  if (cat) { box.innerHTML = catPanel(cat); refocus(); return; }
  if (!c) { box.innerHTML = viewPanel(); refocus(); return; }
  const r = c.key ? BYKEY.get(c.key) : null, sen = r ? SENS[r.s] : null;
  const g = c.gates || { mode: 'none', dir: 'above', y: NaN, r: NaN, hold: 3 };
  const unit = c.pred ? 'RPM' : unitOf(r), lk = c.pred ? 1 : gbK(r);
  const num = x => (x == null || !isFinite(x)) ? '' : x, numL = x => (x == null || !isFinite(x)) ? '' : Math.round(x * lk * 1e4) / 1e4;   // (lines in GB for memory)
  let h = '<div class="src">' + (c.pred ? '<span>Predicted fan: no sensor, its rpm comes from the curve below.</span>'
    : r ? '<span>' + esc(sen.name) + '</span><span style="color:var(--fg)" title="' + esc(r.key) + '">' + esc(r.label) + '</span>'
    : '<span style="color:#e08a8d">' + (sensorHere(c) ? 'HWiNFO isn\'t sharing this reading right now' : 'Not on this PC' + (c.match ? ': ' + esc(c.match.replace('|', ', ')) : '')) + '</span><span class="k">' + esc(c.key) + '</span>') + '</div>';
  h += '<label class="fld"><span>Name</span><input id="iName" value="' + esc(c.name || '') + '" placeholder="' + esc(r ? r.label : c.pred ? 'Predicted fan' : '') + '"></label>';
  h += cellLayHtml(sel, c);
  const bn = isBneck(c), gsel = '<select id="iGraph"><option value="1"' + (c.graph !== false ? ' selected' : '') + '>Show</option><option value="0"' + (c.graph === false ? ' selected' : '') + '>Hide</option></select>';
  // the bottleneck is a call, not a number: no decimals, no lines
  if (bn) h += '<div class="two"><label class="fld"><span>15 min bar</span>' + gsel + '</label><span></span></div>' +
    '<div class="fgrp"><span class="hint">Worked out by ' + esc(feed.brand || 'HW Deck') + ' once a second while a game runs, from GPU usage and the busiest CPU thread. GPU bound: the GPU at 95% or more. CPU bound: the GPU under 85% with a thread at 80% or more. FPS capped: neither, so an fps limit or vsync sets the pace.</span></div>';
  else h += '<div class="two"><label class="fld"><span>Decimals</span><select id="iDec">' + [0, 1, 2, 3].map(d => '<option' + (decOfCell(c, r) === d ? ' selected' : '') + '>' + d + '</option>').join('') + '</select></label>' +
       '<label class="fld"><span>Graph</span>' + gsel + '</label></div>';
  if (!c.pred && !bn) {
    h += '<div class="fgrp"><span class="lab">Lines</span><div class="seg" id="iMode">' + [['none', 'None'], ['y', 'Yellow'], ['yr', 'Yellow + Red']].map(([v, t]) => '<button data-v="' + v + '" class="' + (g.mode === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
    if (g.mode !== 'none') {
      h += '<div class="seg" id="iDir">' + [['above', 'Bad when above'], ['below', 'Bad when below']].map(([v, t]) => '<button data-v="' + v + '" class="' + (g.dir === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
      const o = g.other && typeof g.other === 'object' ? g.other : null, osd = g.dir === 'below' ? 'above' : 'below', side = (d, t) => o ? (d === 'below' ? 'Low: ' + t.toLowerCase() : 'High: ' + t.toLowerCase()) : t;
      h += '<div class="two"><label class="fld gate-y"><span>' + side(g.dir, 'Yellow') + ' ' + esc(unit) + '</span><input id="iY" type="number" step="any" value="' + numL(g.y) + '"></label>' +
           (g.mode === 'yr' ? '<label class="fld gate-r"><span>' + side(g.dir, 'Red') + ' ' + esc(unit) + '</span><input id="iR" type="number" step="any" value="' + numL(g.r) + '"></label>' : '<span></span>') + '</div>';
      h += '<label class="chk"><input type="checkbox" id="iOther"' + (o ? ' checked' : '') + '> Also bad when ' + osd + '</label>';
      if (o) h += '<div class="two"><label class="fld gate-y"><span>' + side(osd, 'Yellow') + ' ' + esc(unit) + '</span><input id="iOY" type="number" step="any" placeholder="none" value="' + numL(o.y) + '"></label>' +
        '<label class="fld gate-r"><span>' + side(osd, 'Red') + ' ' + esc(unit) + '</span><input id="iOR" type="number" step="any" placeholder="none" value="' + numL(o.r) + '"></label></div>';
      h += '<label class="fld"><span>Hold before it turns (s)</span><input id="iHold" type="number" min="0" step="1" value="' + num(g.hold) + '"></label>';
      h += '<label class="fld"><span>Fade in before a line ' + esc(unit) + '</span><input id="iFade" type="number" min="0" step="any" placeholder="auto" value="' + (Number.isFinite(g.fade) ? numL(g.fade) : '') + '"></label>' +
           '<span class="hint">How far before its yellow (and its red) line the cell starts to take on that colour. Empty: the last 12%. 0: no fade.</span>';
      h += '<div class="err" id="gErr"></div><div class="scale" id="gScale"></div>';
    } else if (r) {
      const pre = presetFor(r);
      h += '<span class="hint">' + (c.key === 'hwdeck.0/12v' ? 'No lines: only its pins\' balance turns it yellow.' : 'No lines: the cell never turns yellow or red.') + (pre ? ' Suggestion: <button class="linkbtn" id="iPreset">' + esc(pre.txt) + '</button>' : '') + '</span>';
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
      if (!c.pred) {
        const warn = cv.warn !== false;
        h += '<label class="chk"><input type="checkbox" id="cWarn"' + (warn ? ' checked' : '') + '> Warn when it is off the curve</label>';
        h += '<div class="two"><label class="fld"><span>Tolerance &plusmn;%</span><input id="cTol" type="number" min="1" step="1" value="' + cv.tol + '"></label>' +
          (warn ? '<label class="fld"><span>Hold (s)</span><input id="cHold" type="number" min="0" step="1" value="' + cv.hold + '"></label>' : '') + '</div>';
        h += '<span class="hint" id="cHint">' + (warn ? 'Tolerance: how far from the curve still counts as on it. Hold: how long it has to stay off before it warns (a fan takes a few seconds to catch up with the temperature).'
          : 'Off the curve it never turns yellow, goes in the warning log or counts as a game session warning: it only says how far off it is. Tolerance: how far from the curve still counts as on it.') + '</span>';
      }
      h += '<div class="cstat" id="cStat"></div>';
    }
    h += '</div>';
  }
  h += '<div class="fgrp"><div style="display:flex;gap:8px;flex-wrap:wrap">' + (isMissing(c) ? '<button class="btn" id="iRelink">Re-link</button>' : '') +
    '<button class="btn" id="iOpen">Open graphs</button><button class="btn warn" id="iRemove">Remove from view</button></div></div>';
  box.innerHTML = h;
  refocus();
  tickInsp();
}
// new lines start a little past where the value is now, on its bad side, at the cell's decimals (nothing without a value)
function seedLines(c, r, again) {
  const g = c.gates, gk = gbK(r), v = r && r.v != null ? r.v * gk : null;   // (in what the cell shows: GB for memory)
  if (v == null || g.mode === 'none' || (isFanR(r) && v <= 0)) return;   // nothing to go on (a fan standing still): the fields stay empty
  const dec = decOfCell(c, r), step = Math.pow(10, -dec);
  const past = (x, k) => +(x + (g.dir === 'below' ? -1 : 1) * Math.max(Math.abs(x) * k, step)).toFixed(dec);
  if (again || !Number.isFinite(g.y)) g.y = past(v, g.dir === 'below' ? 0.2 : 0.15) / gk;
  if (g.mode === 'yr' && (again || !Number.isFinite(g.r))) g.r = past(g.y * gk, g.dir === 'below' ? 0.3 : 0.12) / gk;
}
function presetFor(r) {
  const sn = SENS[r.s] ? SENS[r.s].name : '';
  if (r.key === CONN) return { txt: 'yellow 9.2, red 9.5 A (above)', g: Object.assign({}, CONN_LINES) };
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
    const og = g.other && typeof g.other === 'object' ? g.other : null, oset = og && (Number.isFinite(og.y) || Number.isFinite(og.r)), osd = g.dir === 'below' ? 'above' : 'below';
    $('gErr').textContent = !Number.isFinite(g.y) ? 'Set the yellow value.' : gatesBad(g) ? 'Red has to be ' + (g.dir === 'below' ? 'below' : 'above') + ' yellow.' : (g.mode === 'yr' && !Number.isFinite(g.r)) ? 'Set the red value.' :
      og && !oset ? 'Set a yellow or red value for when it is too ' + (osd === 'below' ? 'low' : 'high') + '.' : oset && !otherOf(g) ? 'When it is ' + (osd === 'below' ? 'low' : 'high') + ', its lines have to be ' + (osd === 'below' ? 'under ' : 'over ') + fmtL(g.y * gbK(c.key ? BYKEY.get(c.key) : null), decOfCell(c, c.key ? BYKEY.get(c.key) : null)) + (Number.isFinite(og.y) && Number.isFinite(og.r) ? ', with red ' + (osd === 'below' ? 'under' : 'over') + ' yellow' : '') + '.' : '';
    const s = c.key ? series(c.key, HLEN).filter(isFinite) : [];
    if (e.v != null) s.push(e.v);
    let mn = s.length ? Math.min(...s) : 0, mx = s.length ? Math.max(...s) : 1;
    const og2 = otherOf(g), marks = [g.y, g.mode === 'yr' ? g.r : NaN, og2 && og2.y !== undefined ? og2.y : NaN, og2 && og2.r !== undefined ? og2.r : NaN].filter(Number.isFinite);
    for (const x of marks) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
    const pad = (mx - mn || 1) * 0.15; mn -= pad; mx += pad;
    const P = x => Math.max(0, Math.min(100, (x - mn) / (mx - mn) * 100));
    // the scale in zones: normal, yellow, red, by where each stretch of it is by the lines (both sides)
    const cuts = [mn, ...marks.filter(x => x > mn && x < mx).sort((x, y) => x - y), mx], zc = ['#1f2a22', '#4d4317', '#4a1e21'];
    const bar = cuts.slice(1).map((z, i) => '<i style="width:' + Math.max(0, P(z) - P(cuts[i])) + '%;background:' + zc[gateLevel(g, (cuts[i] + z) / 2).raw] + '"></i>').join('');
    const r = c.key ? BYKEY.get(c.key) : null, dec = decOfCell(c, r);
    sc.innerHTML = '<div class="bar">' + bar + '</div>' + (e.v != null ? '<span class="mk" style="left:' + P(e.v) + '%"></span><span class="tk" style="left:' + P(e.v) + '%;top:-12px;color:var(--fg)">now ' + fmtV(e.v, dec, r) + '</span>' : '') +
      marks.map(x => '<span class="tk" style="left:' + P(x) + '%">' + fmtV(x, dec, r) + '</span>').join('');
  }
  if ($('cChart') && c.curve) drawCurveSvg(c, e);
  const st = $('cStat');
  if (st && c.curve) {
    const src = BYKEY.get(c.curve.src);
    if (c.pred) { st.className = 'cstat'; st.textContent = !src ? 'Its temperature reading is not on this PC: pick another one above' : src.v != null ? 'At ' + fmt(src.v, 0) + ' ' + tempUnit(src) + ' the curve gives ' + fmt(e.v, 0) + ' rpm' : 'Its temperature reading has no value yet'; }
    else if (e.curve) {
      const off = Math.abs(e.curve.dev) > c.curve.tol;
      st.className = 'cstat' + (off && c.curve.warn !== false ? ' y' : '');
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
  const pts = c.curve.pts.slice().sort(ptOrd);
  const src0 = BYKEY.get(c.curve.src), fh = isF(src0 && src0.unit), xmin = fh ? 68 : 20, xmax = fh ? 212 : 100, xstep = fh ? 36 : 20;
  // (while a point is dragged, the scale it started with: one drawn from the point just set ran away under the pointer)
  const top = dragPt && dragPt.top != null ? dragPt.top : Math.max(500, Math.max(...pts.map(p => p[1]), e.v || 0) * 1.15);
  const ax = niceAxis(top, 4), ymax = ax.max;
  const X = v => l + (Math.max(xmin, Math.min(xmax, v)) - xmin) / (xmax - xmin) * (W - l - rr), Y = v => t + (1 - v / ymax) * (H - t - b);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" id="cSvg">';
  for (let x = xmin; x <= xmax; x += xstep) s += '<line x1="' + X(x) + '" x2="' + X(x) + '" y1="' + t + '" y2="' + (H - b) + '" stroke="#202020"/><text x="' + X(x) + '" y="' + (H - 7) + '" fill="#6a6a6a" font-size="9" text-anchor="middle">' + x + '\u00b0</text>';
  for (let v = 0; v <= ymax + 1e-9; v += ax.step) s += '<line x1="' + l + '" x2="' + (W - rr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="#202020"/><text x="' + (l - 4) + '" y="' + (Y(v) + 3) + '" fill="#6a6a6a" font-size="9" text-anchor="end">' + kLabel(v) + '</text>';
  // past its first and last points a fan keeps their speed: dashed to the edges
  const p0 = pts[0], pn = pts[pts.length - 1];
  if (pts.length) s += '<path d="M' + l + ' ' + Y(p0[1]) + ' L' + X(p0[0]) + ' ' + Y(p0[1]) + ' M' + X(pn[0]) + ' ' + Y(pn[1]) + ' L' + (W - rr) + ' ' + Y(pn[1]) + '" fill="none" stroke="#7fa6e8" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.6"/>';
  s += '<polyline points="' + pts.map(p => X(p[0]) + ',' + Y(p[1])).join(' ') + '" fill="none" stroke="#7fa6e8" stroke-width="1.6"/>';
  const src = BYKEY.get(c.curve.src);
  // where the fan is now goes under the points, so a point on top of it can still be dragged
  if (src && src.v != null && e.v != null) {
    const off = e.curve && Math.abs(e.curve.dev) > c.curve.tol && c.curve.warn !== false;
    s += '<g pointer-events="none"><line x1="' + X(src.v) + '" x2="' + X(src.v) + '" y1="' + t + '" y2="' + (H - b) + '" stroke="#3a3a3a" stroke-dasharray="2 3"/><circle cx="' + X(src.v) + '" cy="' + Y(e.v) + '" r="4.5" fill="' + (off ? '#e6c84a' : '#e0e0e0') + '" stroke="none"/></g>';
  }
  c.curve.pts.forEach((p, i) => { s += '<circle class="pt" data-i="' + i + '" cx="' + X(p[0]) + '" cy="' + Y(p[1]) + '" r="5" fill="#0f0f0f" stroke="#7fa6e8" stroke-width="1.6"/>'; });
  box.innerHTML = s + '</svg>';
  box._scale = { l, t, W, H, b, rr, xmin, xmax, ymax, top };
}
const insp = $('insp');
$('inspClose').onclick = () => { const d = DR.R; clearTimeout(d.t); d.hover = false; d.pinned = false; d.byPick = false; clearSel(); saveState(); };
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
  // (only for what is typed: a box, a list or a size takes its own step when it changes)
  if (!editSnap && t.id !== 'cPasteIn' && t.type !== 'checkbox' && t.tagName !== 'SELECT' && !(t.dataset && (t.dataset.sz || t.dataset.lay))) { snap(); syncUndo(); editSnap = true; }
  if (t.id === 'iName') {
    setCell(c => { c.name = t.value.trim() || undefined; });
    const el = document.querySelector('#view .dc[data-cid="' + sel + '"] .tn > span, #view .dc[data-cid="' + sel + '"] .nm > span, #view .dc[data-cid="' + sel + '"] .gname > span');
    if (el) el.textContent = nameIn(sel);
  }
  const lk = c.pred ? 1 : gbK(BYKEY.get(c.key));   // (memory lines are typed in GB, kept in MB)
  if (t.id === 'iOY' || t.id === 'iOR') { setCell(c => { const o = c.gates.other || (c.gates.other = {}), k = t.id === 'iOY' ? 'y' : 'r'; if (t.value === '' || !isFinite(Number(t.value))) delete o[k]; else o[k] = Number(t.value) / lk; }); tickInsp(); updateView(false, true); }
  if (t.id === 'iFade') { setCell(c => { if (t.value === '' || !isFinite(Number(t.value))) delete c.gates.fade; else c.gates.fade = Math.max(0, Number(t.value) / lk); }); tickInsp(); updateView(false, true); }
  if (t.id === 'iY' || t.id === 'iR' || t.id === 'iHold') { setCell(c => { const k = t.id === 'iY' ? 'y' : t.id === 'iR' ? 'r' : 'hold'; c.gates[k] = t.value === '' ? NaN : k === 'hold' ? Math.min(1e9, Math.max(0, Number(t.value) || 0)) : Number(t.value) / lk; }); tickInsp(); updateView(false, true); }
  if (t.id === 'cTol' || t.id === 'cHold') { if (t.value === '') return; setCell(c => { c.curve[t.id === 'cTol' ? 'tol' : 'hold'] = Math.max(t.id === 'cTol' ? 1 : 0, Number(t.value) || 0); }); tickInsp(); updateView(false, true); }
  if (t.dataset && t.dataset.i != null && t.closest('#cTab') && t.value !== '') { setCell(c => { c.curve.pts[Number(t.dataset.i)][Number(t.dataset.j)] = Number(t.value); }); tickInsp(); updateView(false, true); }
});
insp.addEventListener('change', e => {
  const t = e.target, c = S.L.cells[sel]; if (!c) return;
  if (t.id === 'cTol' || t.id === 'cHold') t.value = c.curve[t.id === 'cTol' ? 'tol' : 'hold'];   // what it keeps, not what was typed
  if (t.id === 'iDec') { setCell(c => { c.dec = Number(t.value); }, true); updateView(false, true); t.blur(); }
  if (t.id === 'iGraph') { setCell(c => { c.graph = t.value === '1'; }, true); renderView(false); t.blur(); }
  if (t.id === 'iSrc') { setCell(c => { c.curve.src = t.value; }, true); subscribe(); renderInsp(); updateView(false, true); }
  if (t.id === 'cWarn') { setCell(c => { if (t.checked) delete c.curve.warn; else c.curve.warn = false; }, true); renderInsp(); updateView(false, true); }
  if (t.id === 'iOther') { setCell(c => { if (t.checked) c.gates.other = c.gates.other || {}; else delete c.gates.other; }, true); renderInsp(); updateView(false, true); }
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
  if (pts.length >= 2) { setCell(c => { c.curve.pts = pts.sort(ptOrd); }, true); renderInsp(); updateView(false, true); toast(plural(pts.length, 'point') + ' set' + (items.length > pts.length ? ', ' + (items.length - pts.length) + ' skipped (write them as temp:rpm)' : '')); }
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
    renderInsp(); updateView(false, true);
  }
  if (d && !(c.gates && c.gates.dir === d.dataset.v)) {   // (the one already on: nothing changes)
    setCell(c => {
      const g = c.gates; g.dir = d.dataset.v;
      // lines that are now on the wrong side (picked for "above" before the direction) move to the new side
      const r = BYKEY.get(c.key), v = r ? r.v : null;
      if (v != null && (gatesBad(g) || (Number.isFinite(g.y) && (g.dir === 'below' ? v <= g.y : v >= g.y)))) seedLines(c, r, true);
    }, true);
    renderInsp(); updateView(false, true);
  }
  if (e.target.closest('#iPreset')) { const p = presetFor(BYKEY.get(c.key)); setCell(c => { c.gates = Object.assign({}, p.g); }, true); renderInsp(); updateView(false, true); }
  if (e.target.closest('#iRemove')) removeCell(sel);
  if (e.target.closest('#iRelink')) startRelink(sel);
  if (e.target.closest('#iOpen')) openDetail(sel);
  if (e.target.closest('#cAdd')) {
    // a new point goes into the widest gap, or past the last one while there is room on the chart
    const pts = c.curve.pts.slice().sort(ptOrd), top = curveRange(BYKEY.get(c.curve.src)).max;
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
  if (del && c.curve.pts.length > 2) { setCell(c => { c.curve.pts.splice(Number(del.dataset.del), 1); }, true); renderInsp(); updateView(false, true); }
});
insp.addEventListener('pointerdown', e => { const pt = e.target.closest('.pt'); if (!pt || !e.isPrimary || dragPt) return; blurInsp(); dragPt = { i: Number(pt.dataset.i), moved: false, pid: e.pointerId, x0: e.clientX }; e.preventDefault(); });
document.addEventListener('pointermove', e => {
  if (!dragPt || e.pointerId !== dragPt.pid) return;
  const c = S.L.cells[sel], box = $('cChart'), svg = $('cSvg'); if (!c || !svg) return;
  if (!c.curve || !c.curve.pts[dragPt.i]) return;   // (its points changed under the drag)
  if (!dragPt.moved) { dragPt.moved = true; dragPt.pts0 = JSON.parse(JSON.stringify(c.curve.pts)); dragPt.before = snapOf(); dragPt.top = box._scale.top; dragPt.ymax = box._scale.ymax; }   // (its undo step at the release)   // a click on a point is no undo step
  const sc = box._scale, r = svg.getBoundingClientRect(), k = sc.W / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
  const tv = Math.round(sc.xmin + (x - sc.l) / (sc.W - sc.l - sc.rr) * (sc.xmax - sc.xmin));
  const rv = Math.round((1 - (y - sc.t) / (sc.H - sc.t - sc.b)) * sc.ymax / 10) * 10;
  // (its temperature stays until the pointer moves sideways: one outside the chart's range jumped to its edge)
  if (!dragPt.side && Math.abs(e.clientX - dragPt.x0) >= 3) dragPt.side = true;
  c.curve.pts[dragPt.i] = [dragPt.side ? Math.max(sc.xmin, Math.min(sc.xmax, tv)) : dragPt.pts0[dragPt.i][0], Math.max(0, Math.min(dragPt.ymax, rv))];
  tickInsp(); updateView(false, true);
  const ins = $('cTab').querySelectorAll('input[data-i="' + dragPt.i + '"]'); if (ins.length === 2) { ins[0].value = c.curve.pts[dragPt.i][0]; ins[1].value = c.curve.pts[dragPt.i][1]; }
});
// a curve point let go with Escape: the points as they were, and the step its first move took goes too
function ptCancel() {
  const c = S.L.cells[sel], d = dragPt; dragPt = null;
  if (d && d.moved && d.pts0 && c && c.curve) { c.curve.pts = d.pts0; saveState(); syncSaves(); }   // (back as it was, on disk too: a save may have gone out mid-drag; no step was taken)
  syncDrawers(); renderInsp(); updateView(false, true);
}
const ptUp = e => {   // (a cancelled pointer ends it too: no point left following the next move)
  if (!dragPt || e.pointerId !== dragPt.pid) return;
  const moved = dragPt.moved, before = dragPt.before, c = S.L.cells[sel], was = c && c.curve ? JSON.stringify(c.curve.pts) : '';
  dragPt = null; syncDrawers(); if (c && c.curve) c.curve.pts.sort(ptOrd);
  if (moved && before && before !== snapOf()) { pushUndo(before); syncUndo(); }   // (the drag's one step)   // (also a point only clicked: the table may have been left unsorted under it)
  if (moved || (c && c.curve && JSON.stringify(c.curve.pts) !== was)) { saveState(); syncSaves(); renderInsp(); }
};
document.addEventListener('pointerup', ptUp); document.addEventListener('pointercancel', ptUp);
// the points table goes back in order once you leave it (not while you type in it: rows would jump under you)
insp.addEventListener('focusout', e => {
  if (!e.target.closest('#cTab') || (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#cTab'))) return;
  setTimeout(() => {
    const c = S.L.cells[sel]; if (!c || !c.curve || dragPt || document.activeElement && document.activeElement.closest && document.activeElement.closest('#cTab')) return;
    const was = JSON.stringify(c.curve.pts), now = c.curve.pts.slice().sort(ptOrd);
    if (JSON.stringify(now) === was) return;
    c.curve.pts = now; saveState(); syncSaves();
    for (const el of document.querySelectorAll('#cTab input[data-i]')) { const q = now[+el.dataset.i]; if (q) el.value = q[+el.dataset.j]; }
    tickInsp(); updateView(false, true);
  }, 0);
});
insp.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest && e.target.closest('#cTab')) e.target.blur(); });

// ---------- the right panel for a category, for the view, and the layout bits of a cell ----------
const segL = (label, key, opts, cur) => '<div class="fld"><span>' + label + '</span><div class="seg" data-lay="' + key + '">' +
  opts.map(([v, t, off]) => '<button data-v="' + v + '"' + (off ? ' disabled' : '') + ' class="' + (String(v) === String(cur) ? 'on' : '') + '">' + t + '</button>').join('') + '</div></div>';
const TPLS = [['two', '2 columns', '1fr 1fr', '1fr 1fr 1fr', ['1/1', '1/2', '2/1', '2/2', '3/1/4/3']], ['three', '3 columns', '1fr 1fr 1fr', '1fr 1fr', ['1/1', '1/2', '1/3', '2/1/3/4']],
  ['one', 'One per row', '1fr', '1fr 1fr 1fr', ['1/1', '2/1', '3/1']], ['copy', 'Copy', '1fr 1fr 1fr', '1fr 0.6fr 1fr', ['1/1', '1/2', '1/3', '2/1/3/4', '3/1', '3/2', '3/3']]];
const LOOKS = [['', 'Card', [[6, 8, 40, 38], [52, 14, 42, 26], [6, 58, 88, 12], [6, 78, 88, 12]]], ['small', 'Small card', [[6, 8, 30, 24], [42, 12, 52, 16], [6, 42, 88, 12], [6, 62, 88, 12], [6, 82, 88, 12]]],
  ['list', 'List', [[6, 8, 88, 14], [6, 30, 88, 14], [6, 52, 88, 14], [6, 74, 88, 14]]], ['band', 'Band', [[4, 20, 14, 60], [22, 20, 16, 60], [41, 20, 16, 60], [60, 20, 16, 60], [79, 20, 16, 60]]]];
const LOOK_HINT = { '': 'Card: its first reading large with a graph, the rest as rows.', small: 'Small card: a card with a smaller big reading.', list: 'List: every reading as a row, none large.',
  band: 'Band: the name on the left and every reading side by side in one strip, each with a small graph. Best on a row of its own.' };
const otherView = vn => vn === 'tiles' ? 'overview' : 'tiles';
function outlineHtml(rows) {
  return '<div class="outline">' + rows.map(r => '<div class="orow" style="grid-template-columns:' + r.cols.map(c => (c.w || 1) + 'fr').join(' ') + '">' +
    r.cols.map(c => '<div class="ocol">' + c.stack.map(s => { const id = sid(s), cat = catById(id); return '<button class="obox' + (id === selCat ? ' on' : '') + '" data-ocat="' + esc(id) + '" title="' + esc(cat ? cat.name : '') + '">' + esc(cat ? cat.name : '') + '</button>'; }).join('') + '</div>').join('') + '</div>').join('') + '</div>';
}
function viewPanel() {
  const vn = S.screen, v = stored(vn), own = !!(v && v.rows), cells = Object.values(S.L.cells);
  const nb = (n, one, many) => '<b>' + n + '</b> ' + (n === 1 ? one : many);
  if (!READ.length) return '<div class="none"><span>Nothing to pick from yet: HWiNFO isn\'t sharing its sensors. The steps are in the middle.</span></div>';
  let h = '';
  if (S.L.cats.length) {
    h += segL('Arrangement', 'arr', [['auto', 'Automatic'], ['own', 'Your own']], own ? 'own' : 'auto') + '<span class="hint">' + (own
      ? 'Your rows and columns. Drag a category by its handle onto the edge of another one; drag the line between two columns to change their widths.'
      : esc(feed.brand || 'HW Deck') + ' places the categories for you. Drop a category on the edge of another one, or pick a start below, to arrange them yourself.') + '</span>';
    if (vn !== 'grid') {
      const ov = otherView(vn), canCopy = !!(stored(ov) && stored(ov).rows);
      h += '<div class="fgrp"><span class="lab">Start from</span><div class="tpls">' + TPLS.map(([k, t, gc, gr, areas]) => '<button class="tpl" data-tpl="' + k + '"' + (k === 'copy' && !canCopy ? ' disabled title="' + VNAME[ov] + ' is placed automatically: there is nothing to copy"' : '') + '>' +
        '<span class="pic" style="grid-template-columns:' + gc + ';grid-template-rows:' + gr + '">' + areas.map(a => '<i style="grid-area:' + a + '"></i>').join('') + '</span>' + (k === 'copy' ? 'Copy from ' + VNAME[ov] : t) + '</button>').join('') + '</div>' +
        '<span class="hint">Rest the pointer on one to see it with your categories, click to use it. Undo brings yours back.</span></div>';
      h += '<div class="fgrp">' + (vn === 'tiles' ? segL('Height', 'fill', [['fit', 'All fit'], ['fill', 'Fill the window']], !own || !v.rows.some(r => r.h) ? 'fit' : v.rows.every(r => r.h) ? 'fill' : '') +
        '<span class="hint">Fill the window: room left under the tiles makes them taller (bigger graphs), up to twice their size.</span>' : '') +
        segL('Spacing', 'gap', [['tight', 'Tight'], ['', 'Normal'], ['roomy', 'Roomy']], v && v.gap || '') + '<span class="hint">The gaps between categories and between their ' + (vn === 'tiles' ? 'tiles' : 'rows') + '.</span></div>';
    } else {
      const n = own ? v.rows[0].cols.length : document.querySelectorAll('#view .gtable').length;
      h += '<div class="fgrp">' + segL('Tables', 'tables', [[1, 'One'], [2, 'Two'], [3, 'Three']], n) + '</div>';
    }
    if (own) h += '<div class="fgrp"><span class="lab">Outline</span>' + outlineHtml(v.rows) + '<span class="hint">Click a box to select that category.</span></div>';
  }
  h += '<div class="fgrp"><div class="none"><span>Select a cell to set its name, decimals, lines and fan curve, or a category (click its name) to set where it goes and how it looks. Double-click a cell for its graphs (outside edit mode, one click).</span>' +
    '<span>' + nb(S.L.cats.length, 'category', 'categories') + ', ' + nb(cells.length, 'cell', 'cells') + ', ' + nb(cells.filter(x => gatesOn(x.gates)).length, 'with lines', 'with lines') + ', ' + nb(cells.filter(x => x.curve).length, 'on a fan curve', 'on a fan curve') + '.</span>' +
    '<span>Tip: pick a type in Storage (Temp, Fan...), then <b>+ all</b> on a sensor to add all of those readings as one category.</span>' +
    (own ? '<span><button class="linkbtn" data-lay="auto">Back to automatic</button></span>' : '') + '</div></div>';
  return h;
}
function catPanel(cat) {
  const vn = S.screen, V = VNAME[vn], lk = catLook(cat.id), v = stored(vn), own = !!(v && v.rows), ids = cellsOf(cat);
  const leadOpts = '<option value="">' + (ids.length ? 'The first one (' + esc(nameIn(ids[0])) + ')' : 'The first one') + '</option>' +
    ids.slice(1).map(id => '<option value="' + esc(id) + '"' + (lk.lead === id ? ' selected' : '') + '>' + esc(nameIn(id)) + '</option>').join('');
  let h = '<label class="fld"><span>Name</span><input id="lName" value="' + esc(cat.name) + '"></label><div class="fgrp"><span class="sub">In ' + V + '</span>';
  if (vn !== 'grid') {
    const rows = rowsNow(vn), p = posIn(rows, cat.id), alone = !p || p.row.cols.length < 2;
    h += '<span class="row3">' + (own && p ? 'Row ' + (p.ri + 1) + ' of ' + rows.length + (alone ? ', alone in its row (full width)' : ', column ' + (p.ci + 1) + ' of ' + p.row.cols.length) + (p.col.stack.length > 1 ? ', stacked ' + (p.k + 1) + ' of ' + p.col.stack.length : '')
      : 'Placed automatically. Changing where it goes or how wide it is gives ' + V + ' your own arrangement, starting from what you see.') + '</span>';
    const mine = !alone && p.row.cols.every(c => c.w), b = mine ? p.row.cols.map(c => c.w) : [1], tw = alone ? '' : mine ? Math.round(b[p.ci] / b.reduce((x, y) => x + y, 0) * 1200) / 100 : 'auto';
    h += segL('Width in row', 'width', [['auto', 'Auto', alone], [3, '1/4', alone], [4, '1/3', alone], [6, '1/2', alone], [8, '2/3', alone], [9, '3/4', alone]], tw);
    h += '<span class="hint">' + (alone ? 'Alone in its row, so it takes the whole width. Put another category beside it to share the row.'
      : tw === 'auto' ? 'Auto: the widths follow what each column holds, so the columns end about together.' : 'Yours. Auto (or a double-click on the line between columns) lets them follow the content again.') + '</span>';
    if (vn === 'tiles') h += segL('Row height', 'rowh', [[0, 'Fit'], [1, 'Fill']], own && p && p.row.h ? 1 : 0) + '<span class="hint">Fill: when the view leaves room below, this row\'s tiles grow taller to use it.</span>';
    const mo = moveOptions(cat.id), mb = [['row', 'Own row', 'R'], ['beside', 'Beside the row above', 'B'], ['stack', 'Stack under the left one', 'S'], ['unstack', 'Unstack', 'U']].filter(m => mo[m[0]]);
    if (mb.length) h += '<div class="fld"><span>Move</span><div class="btnrow">' + mb.map(m => '<button class="btn" data-lay="move" data-v="' + m[0] + '">' + m[1] + '<span class="kb">' + m[2] + '</span></button>').join('') + '</div></div>';
  } else {
    const rows = rowsNow('grid'), p = posIn(rows, cat.id), n = rows.length ? rows[0].cols.length : 1;
    h += segL('Table', 'table', [...Array(Math.min(3, n + 1))].map((_, i) => [i, i < n ? String(i + 1) : 'New table']), p ? p.ci : 0);
  }
  h += '</div>';
  if (vn === 'tiles')
    h += '<div class="fgrp"><span class="lab">Look in Tiles</span><div class="two"><label class="fld"><span>Tiles per row</span><select data-lay="per"><option value="">Auto</option>' +
      [1, 2, 3, 4, 5, 6, 7, 8].map(n => '<option' + (lk.per === n ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' + segL('Tile style', 'size', [['', 'Normal'], ['short', 'Short']], lk.size || '') + '</div>' +
      '<span class="hint">Short: no graph; the name over its 15 min max on the left, the value on the right. Wider tiles, so fewer to a row.</span><div class="two">' + segL('Title', 'title', [['', 'Show'], ['hide', 'Hide']], lk.title || '') +
      '<label class="fld"><span>Shown first</span><select data-lay="lead">' + leadOpts + '</select></label></div>' + catSizeHtml(cat, ids) + '</div>';
  else if (vn === 'overview') {
    const st = lk.style || '';
    h += '<div class="fgrp"><span class="lab">Look in Overview</span><div class="looks" data-lay="style">' + LOOKS.map(([k, t, rects]) => '<button class="look' + (st === k ? ' on' : '') + '" data-v="' + k + '"><span class="pic">' +
      rects.map(q => '<i style="left:' + q[0] + '%;top:' + q[1] + '%;width:' + q[2] + '%;height:' + q[3] + '%"></i>').join('') + '</span>' + t + '</button>').join('') + '</div><span class="hint">' + LOOK_HINT[st] + '</span>' +
      '<div class="two">' + segL('Title', 'title', [['', 'Show'], ['hide', 'Hide']], lk.title || '') + '<label class="fld"><span>' + (st === '' || st === 'small' ? 'Big reading' : 'Shown first') + '</span><select data-lay="lead">' + leadOpts + '</select></label></div></div>';
  } else h += '<div class="fgrp"><span class="lab">Look in Grid</span><label class="fld"><span>Listed first</span><select data-lay="lead">' + leadOpts + '</select></label></div>';
  h += '<div class="fgrp"><div class="btnrow"><button class="btn" data-lay="reset"' + (Object.keys(lk).length ? '' : ' disabled') + '>Reset its look in ' + V + '</button><button class="btn warn" data-lay="remove">Remove category</button></div>' +
    '<span class="hint">' + (vn === 'grid' ? 'Drag its handle onto the left or right edge of a table for a new table there, or over and under other categories.'
      : 'Drag its handle onto another category: the left or right edge puts them side by side, the top or bottom stacks them, the middle swaps them, the gap between two rows gives it a row of its own.') + '</span></div>';
  return h;
}
// Tiles: the size of every tile in a category at once (empty when they differ), and Line up the bottom
function catSizeHtml(cat, ids) {
  if (!ids.length) return '';
  const zs = ids.map(cellSize), same = k => zs.every(z => z[k] === zs[0][k]) ? zs[0][k] : '', blk = document.querySelector('#view .blk[data-cat="' + CSS.escape(cat.id) + '"]');
  const num = k => '<label><input type="number" data-csz="' + k + '" value="' + same(k) + '" placeholder="mixed" min="0.25" max="2" step="0.05"><i>' + (k === 'w' ? 'wide' : 'tall') + '</i></label>';
  return '<div class="fld"><span>Size of all its tiles</span><div class="szin">' + num('w') + num('h') + '</div></div>' +
    '<div class="btnrow"><button class="btn" data-lay="fitrow"' + (blk && colEnds(blk).cols.length ? '' : ' disabled') + '>Line up the bottom</button></div>' +
    '<span class="hint">Its tiles get a little taller or shorter, so its column ends level with the tallest column beside it.</span>';
}
// a tile's width or height in one click: quarter steps from 0.25 to 2 (no wider than its row of tiles)
const QSZ = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const qsizes = (label, key, cur, per) => '<div class="fld"><span>' + label + '</span><div class="seg qs" data-lay="' + key + '">' +
  QSZ.map(v => '<button data-v="' + v + '"' + (per && v > per ? ' disabled' : '') + ' class="' + (v === cur ? 'on' : '') + '">' + String(v).replace(/^0\./, '.') + '</button>').join('') + '</div></div>';
function cellLayHtml(cid, c) {
  const vn = S.screen, V = VNAME[vn], cl = cellLook(cid), cat = catOf(cid), lk = cat ? catLook(cat.id) : {};
  let h = '<div class="fgrp"><span class="sub">In ' + V + '</span>';
  h += cl.name != null ? '<div class="fld"><span>Name in ' + V + '</span><div class="vname"><input id="lvName" value="' + esc(cl.name) + '" placeholder="' + esc(cellName(c)) + '"><button class="ib" data-lay="vname-x" title="The same name as in the other views">' + ICONS.x + '</button></div></div>'
    : '<button class="linkbtn" data-lay="vname-on" style="align-self:flex-start">Different name in ' + V + '</button>';
  if (vn === 'tiles') {
    const z = cellSize(cid), G = tileGeo(tileEl(cid)), px = G ? [Math.round(pxW(G, z.w)), Math.round(G.at(Math.min(z.w, G.k), z.h).th)] : null, num = (k, v, min, max, step, u) => '<label><input type="number" data-sz="' + k + '" value="' + v + '"' +
      (min != null ? ' min="' + min + '" max="' + max + '"' : ' title="At this window size"') + ' step="' + step + '"><i>' + u + '</i></label>';
    h += '<div class="fld"><span>Size (a normal tile is 1 x 1)</span><div class="szin">' + num('w', z.w, 0.25, 2, 'any', 'wide') + num('h', z.h, 0.25, 2, 'any', 'tall') + '</div>' +
      (px ? '<div class="szin">' + num('pw', px[0], null, null, 1, 'px') + num('ph', px[1], null, null, 1, 'px') + '</div>' : '') + '</div>' +
      qsizes('Width', 'cw', z.w, lk.per) + qsizes('Height', 'ch', z.h) +
      '<label class="chk"><input type="checkbox" data-lay="nl"' + (cl.nl ? ' checked' : '') + '> Starts a new row</label>' +
      '<span class="hint">It and the tiles after it go under the ones before it, so a row ends early (say, four tiles of 0.75, then the next ones together on their own row).</span>' +
      '<span class="hint">Or drag its corner: it snaps to quarter steps and to other tiles; hold Alt for any size. Ctrl+arrows: 1 px; with Shift: a quarter step.' +
      (lk.per === 1 ? ' One tile per row: it can\'t be wider than the row.' : '') + '</span>';
  } else if (cat) {
    const first = idsIn(cat)[0] === cid, big = vn === 'overview' && lk.style !== 'list' && lk.style !== 'band';
    h += '<button class="btn" data-lay="lead-me" style="align-self:flex-start"' + (first ? ' disabled' : '') + '>' + (first ? (big ? 'This is the big reading' : 'It is shown first') : big ? 'Make it the big reading' : vn === 'grid' ? 'List it first' : 'Show it first') + '</button>';
  }
  return h + '</div>';
}
function removeCat(id) {
  const c = catById(id); if (!c) return;
  mutate(() => { for (const x of c.cells) delete S.L.cells[x]; S.L.cats = S.L.cats.filter(x => x !== c); fixSel(); }, 'Removed "' + c.name + '"');
}
function applyTemplate(k) {
  preview = null;
  const v = templateView(k); if (!v) return;
  layoutChange(() => { const vv = vset(S.screen); if (!vv.rows) froze = true; vv.rows = v.rows; });
}
function layoutAct(key, v) {
  const vn = S.screen, id = selCat;
  if (key === 'arr' && v === 'own') layoutChange(() => ownRows());
  else if ((key === 'arr' && v === 'auto') || key === 'auto') { if (stored(vn) && stored(vn).rows) mutate(() => { delete vset(vn).rows; }, VNAME[vn] + ' is placed automatically again'); }
  else if (key === 'fill' && v !== 'fill' && !(stored(vn) && stored(vn).rows && stored(vn).rows.some(r => r.h))) return;   // (All fit already: an automatic view stays automatic)
  else if (key === 'fill') layoutChange(() => { const rows = ownRows(); if (v === 'fill') autoHeights(vn, rows); else for (const r of rows) delete r.h; });
  else if (key === 'gap') mutate(() => { if (v) vset(vn).gap = v; else delete vset(vn).gap; });
  else if (key === 'tables' && +v === (stored('grid') && stored('grid').rows ? (stored('grid').rows[0] || { cols: [] }).cols.length : document.querySelectorAll('#view .gtable').length)) return;   // (the count already lit: nothing cut again)
  else if (key === 'tables') layoutChange(() => { const g = vset('grid'); if (!g.rows) froze = true; g.rows = gridTables(+v); });
  else if (key === 'width') setWidth(id, v === 'auto' ? 0 : +v);
  else if (key === 'rowh') setRowHeight(id, +v);
  else if (key === 'move') moveCat(id, v);
  else if (key === 'table') layoutChange(() => {
    const t = +v, p = posIn(rowsNow(vn), id); if (!p || p.ci === t) return;   // (in that table already: an automatic view stays automatic)
    const rows = ownRows();
    vset('grid').rows = placeCat(rows, id, t >= rows[0].cols.length ? { zone: 'right', table: rows[0].cols.length - 1 } : { zone: 'into', table: t });
  });
  else if (key === 'size' || key === 'title' || key === 'style') mutate(() => setLook('cat', id, key, v));
  else if (key === 'reset') mutate(() => { const w = vset(vn); if (w.cat) delete w.cat[id]; });
  else if (key === 'remove') removeCat(id);
  else if (key === 'cw' || key === 'ch') { if (nudge) flushNudge(); const z = cellSize(sel); mutate(() => setSize(sel, key === 'cw' ? +v : z.w, key === 'ch' ? +v : z.h)); }
  else if (key === 'fitrow') fitRow(id);
  else if (key === 'vname-on') { mutate(() => setLook('cell', sel, 'name', cellName(S.L.cells[sel]))); const f = $('lvName'); if (f) { f.focus(); f.select(); } }
  else if (key === 'vname-x') mutate(() => setLook('cell', sel, 'name', ''));
  else if (key === 'lead-me') { const c = catOf(sel); if (c) mutate(() => setLook('cat', c.id, 'lead', cellsOf(c)[0] === sel ? '' : sel)); }
}
insp.addEventListener('click', e => {
  if (!S.edit) return;
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.tpl) { applyTemplate(b.dataset.tpl); return; }
  if (b.dataset.ocat) { selectCat(b.dataset.ocat); return; }
  const grp = b.closest('[data-lay]'), key = b.dataset.lay || (grp && grp.dataset.lay);
  if (key) layoutAct(key, b.dataset.v);
});
insp.addEventListener('change', e => {
  if (!S.edit) return;
  const t = e.target;
  if (t.dataset && t.dataset.sz && sel) { const id = sel, k = t.dataset.sz, v = parseFloat(t.value); setTimeout(() => sizeInput(id, k, v), 0); return; }
  if (t.dataset && t.dataset.csz && selCat) { const id = selCat, k = t.dataset.csz, v = parseFloat(t.value); setTimeout(() => catSizeInput(id, k, v), 0); return; }
  if (t.id === 'lName') {
    const cat = selCat && catById(selCat), v = t.value.trim().slice(0, 200);
    if (cat && v && v !== cat.name) mutate(() => { cat.name = v; }); else if (cat) t.value = cat.name;
    return;
  }
  if (t.dataset && t.dataset.lay === 'nl' && sel) { mutate(() => setLook('cell', sel, 'nl', t.checked || '')); return; }
  if (!selCat || !t.dataset || !t.dataset.lay) return;
  if (t.dataset.lay === 'per') mutate(() => setLook('cat', selCat, 'per', t.value ? +t.value : ''));
  if (t.dataset.lay === 'lead') mutate(() => setLook('cat', selCat, 'lead', t.value));
});
insp.addEventListener('input', e => {   // a name in this view, as it's typed (the cell's own input listener took the undo step)
  const t = e.target; if (t.id !== 'lvName' || !sel || !S.L.cells[sel]) return;
  setLook('cell', sel, 'name', t.value.trim() ? t.value.slice(0, 200) : '');
  tidyViews(S.L); saveState(); syncSaves();
  const el = document.querySelector('#view .dc[data-cid="' + sel + '"] .tn > span, #view .dc[data-cid="' + sel + '"] .nm > span, #view .dc[data-cid="' + sel + '"] .gname > span');
  if (el) el.textContent = nameIn(sel);
});
insp.addEventListener('keydown', e => { if (e.target.id === 'lName' && e.key === 'Escape') { const cat = catById(selCat); if (cat) e.target.value = cat.name; e.target.blur(); } });
// a template shows itself while the pointer rests on it
let tplT = 0;
insp.addEventListener('mouseover', e => {
  const b = e.target.closest('.tpl'); if (!b || b.disabled || (preview && preview.k === b.dataset.tpl)) return;
  clearTimeout(tplT);
  tplT = setTimeout(() => { if (!b.isConnected) return; const v = templateView(b.dataset.tpl); if (!v) return; preview = { vn: S.screen, view: v, k: b.dataset.tpl }; renderView(false); }, 180);
});
insp.addEventListener('mouseout', e => {
  const b = e.target.closest('.tpl'); if (!b || (e.relatedTarget && b.contains(e.relatedTarget))) return;
  clearTimeout(tplT);
  // (onto the next template: it takes over from this preview, no stop at the real view between them)
  if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.tpl')) return;
  if (preview) { preview = null; renderView(false); }
});

// ---------- selecting: a cell, a category, or nothing (the view) ----------
function selectCat(id) {
  sel = null; selCat = id; DR.R.byPick = true; DR.R.pickT = Date.now();   // clicking it again brings its settings back
  for (const el of document.querySelectorAll('#view .dc.sel')) el.classList.remove('sel');
  for (const el of document.querySelectorAll('#view .dcat')) el.classList.toggle('csel', el.dataset.cat === id);
  renderInsp();
}
function clearSel() {
  sel = null; selCat = null;
  for (const el of document.querySelectorAll('#view .dc.sel, #view .dcat.csel')) el.classList.remove('sel', 'csel');
  renderInsp();
}
// repeated layout keys close together are one undo step
let keyStep = { t: 0, n: -1 };
function keyLayout(fn) {
  // (counted in steps taken: the stack's length stops changing at its cap)
  const merge = Date.now() - keyStep.t < 800 && undoSeq === keyStep.n && keyStep.n > 0, n0 = undoSeq;
  fn();
  if (merge && undoSeq === n0 + 1) undoStack.pop();   // (the press's own step: the burst stays one)
  if (undoSeq === n0 && !merge) keyStep.t = 0;   // (a key that changed nothing starts no burst: the next one isn't merged into an earlier change)
  else keyStep = { t: Date.now(), n: undoSeq };
  if (merge && undoStack.length && undoStack[undoStack.length - 1] === snapOf()) { undoStack.pop(); keyStep.t = 0; }   // (the burst came back where it started: no step that changes nothing)
  syncUndo();
}
function focusCat(id) { const h = document.querySelector('#view .dcat[data-cat="' + id + '"] .dch'); if (h) h.focus({ preventScroll: false }); }
function swapCats(a, b) { dropCat({ target: { zone: 'swap', cat: b }, data: a, auto: !isCustom(S.screen), rows: rowsNow() }); }

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
function closeDetail() { modalCid = null; bigHist = null; modal.classList.remove('open'); pauseSpin(document.querySelector('#micon svg')); }
function refreshModal(full) {
  const c = S.L.cells[modalCid]; if (!c) { closeDetail(); return; }
  const r = c.key ? BYKEY.get(c.key) : null, e = evalCell(modalCid, c, true, true), dec = decOfCell(c, r), unit = c.pred ? 'RPM' : unitOf(r), xk = xkOf(r);
  const mi = $('micon'), ic = iconOf(c, r);
  if (mi._h !== ic) { mi.innerHTML = ic; mi._h = ic; sweepSpins(); }
  if (isFanCell(c)) spinIcon(mi.querySelector('svg'), e.v);
  setText($('mtitle'), nameIn(modalCid));
  const mv = $('mval');
  mv.style.color = COLORS[e.col] || COLORS.white;
  if (!mv._n) { mv.innerHTML = '<span></span><span class="u"></span>'; mv._n = mv.firstChild; mv._u = mv.lastChild; }
  odo(mv._n, e.txt != null ? e.txt : fmtV(e.v, dec, r)); setText(mv._u, e.txt != null ? (e.utxt ? ' ' + e.utxt : '') : e.v == null ? '' : ' ' + unit);
  const g = c.gates, gk = gbK(r), det = gbDet(gateLines(g), gk);
  if (full) {
    let d = c.pred ? 'Predicted from ' + esc(BYKEY.get(c.curve.src) ? BYKEY.get(c.curve.src).label : 'a missing reading') + ' through its curve; there is no fan sensor.'
      : r ? '<span title="' + esc(r.key) + '">' + esc(SENS[r.s].name) + ', ' + esc(r.label) + '.</span>' : sensorHere(c) ? 'HWiNFO isn\'t sharing this reading right now.' : 'This reading is not on this PC.';
    if (gatesOn(g)) d += ' Lines: yellow ' + fmtL(det.y, dec) + (det.r !== undefined ? ', red ' + fmtL(det.r, dec) : '') + ' ' + esc(unit) + (g.dir === 'below' ? ' (bad when below)' : '') + (det.y2 !== undefined || det.r2 !== undefined ? ', and on the other side ' + [det.y2 !== undefined ? 'yellow ' + fmtL(det.y2, dec) : '', det.r2 !== undefined ? 'red ' + fmtL(det.r2, dec) : ''].filter(Boolean).join(', ') + (g.dir === 'below' ? ' (bad when above)' : ' (bad when below)') : '') + (g.hold ? ', after ' + fmtL(g.hold, 1) + ' s' : '') + '.';
    if (c.curve && !c.pred) d += ' Follows a fan curve on ' + esc(BYKEY.get(c.curve.src) ? BYKEY.get(c.curve.src).label : 'a missing reading') + ', within ' + fmtL(c.curve.tol, 1) + '%' + (c.curve.warn === false ? ' (it doesn\'t warn when off it)' : '') + '.';
    if (e.strip) d = 'What limits your fps while a game runs, worked out once a second from GPU usage and the busiest CPU thread. GPU bound: the GPU at 95% or more, ' +
      'normal for a game without an fps limit. CPU bound: the GPU under 85% with a CPU thread at 80% or more. FPS capped: neither is the limit, so an fps cap or vsync sets the pace. ' +
      'The cell shows the most common call of the last 5 seconds. Over an hour or more the bar has a column per minute (10 minutes over 7 days), as tall as the time a game ran in it. ' + bnFrom();
    if (xk && xk.desc) d = xk.desc(modalCid, r);
    $('mdesc').innerHTML = d;
  }
  mgsec.hidden = !!(xk && xk.noGraph);
  mgraph.hidden = $('mstats').hidden = !!e.strip;   // the bottleneck: only the range tabs up here, its bar below
  if (e.strip) { lastBig = null; bnPanel($('mextra'), e, full); return; }
  if (xk && xk.noGraph) { lastBig = null; xDetail(xk, r, e, full); return; }
  const sp = gbArr(bucketArr(c, isYN(r)), gk);
  if (full) {   // the yellow line joins the scale when it is close above the data; decided once per opening
    modalGateInView = false;
    const vals = sp.filter(x => x !== null);
    if (vals.length > 1 && det.y !== undefined) { const hi = Math.max(...vals), spn = Math.max(1.2, hi - Math.min(...vals)); modalGateInView = det.y > hi && det.y < hi + spn * 1.2; }
  }
  const gu = isYN(r) ? 'Yes/No' : unit;
  if (bigRange === '15m') lastBig = [mgraph, sp, det, dec, gu, modalGateInView, null, HLEN * 1000];
  else if (histReady()) { const H = histOf(c); lastBig = isYN(r) ? [mgraph, H.max, det, dec, gu, modalGateInView, null, H.span * 1000] : [mgraph, gbArr(H.avg, gk), det, dec, gu, modalGateInView, gbArr(H.max, gk), H.span * 1000]; }
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
  } else if (xk && xk.detail) xDetail(xk, r, e, full);
  else if (full) extra.innerHTML = '';
}
// a build's own section in the popup (see EXT): its box is made when the popup opens, filled on every refresh
function xDetail(xk, r, e, full) {
  const extra = $('mextra');
  if (full || !extra.querySelector(':scope > .xd')) extra.innerHTML = '<div class="xd" data-x="1"></div>';
  if (xk.detail) xk.detail(extra.firstChild, modalCid, r, e, full);
}
// the bottleneck has no graph: its popup shows the calls as a bar and each call's share. The last 15 min second by
// second; the longer ranges (the host's history) a column per minute, per 10 minutes over 7 days, as tall as the time
// a game ran in it and split into the calls (gpu at the bottom, then cpu, capped on top)
const BN_SPAN = { '15m': 'the last 15 minutes', '1h': 'the last hour', '6h': 'the last 6 hours', '12h': 'the last 12 hours', '24h': 'the last 24 hours', '7d': 'the last 7 days' };
const BNP = { B: null, x: null, hist: null };
function bnCols() {   // per column [gpu, cpu, capped] as parts of it (null: no game), and the seconds a column stands for
  if (bigRange === '15m') return { n: HLEN, step: 1, end: nowTs, cols: series(BNECK, HLEN).map(x => BN[x] ? [x === 1 ? 1 : 0, x === 2 ? 1 : 0, x === 3 ? 1 : 0] : null) };
  if (!histReady() || !Array.isArray(bigHist.sg)) return null;
  if (BNP.hist === bigHist && BNP.B && BNP.B.step > 1) return BNP.B;   // (the same answer: nothing to work out again)
  // each is that call's part of the whole minute (block); the one in progress, of it so far
  const H = bigHist, n = H.sg.length, end = Number.isFinite(H.end) ? H.end : Math.floor(Date.now() / 1000 / H.step) * H.step;
  const at = (a, i) => Array.isArray(a) && typeof a[i] === 'number' && a[i] > 0 ? Math.min(1, a[i]) : 0;
  BNP.hist = H;
  return { n, step: H.step, end, old: H.sg.every(x => x == null) && Array.isArray(H.avg) && H.avg.some(x => x != null),
    cols: H.sg.map((x, i) => { const v = [at(H.sg, i), at(H.sc, i), at(H.sf, i)]; return v[0] + v[1] + v[2] > 0 ? v : null; }) };
}
function bnSvg(B) {
  const W = B.n * 10, H = 60, gap = B.step > 1 && B.n <= 120 ? 1.6 : 0;
  let h = '<line x1="0" x2="' + W + '" y1="' + H + '" y2="' + H + '"/>';
  for (let i = 0; i < B.n;) {
    const v = B.cols[i]; let j = i + 1;
    if (B.step === 1) while (j < B.n && String(B.cols[j]) === String(v)) j++;   // seconds: a run of one call is one block
    if (v) { let y = H; v.forEach((p, k) => { if (p <= 0) return; const hh = p * H; y -= hh; h += '<rect class="' + BN[k + 1][2] + '" x="' + (i * 10 + gap / 2).toFixed(1) + '" y="' + y.toFixed(2) + '" width="' + ((j - i) * 10 - gap).toFixed(1) + '" height="' + hh.toFixed(2) + '"/>'; }); }
    i = j;
  }
  return { vb: '0 0 ' + W + ' ' + H, h };
}
function bnSum(B) {   // each call's share of the game time in the range, like the split of the last 15 min
  const n = [0, 0, 0, 0];
  for (const v of B.cols) if (v) v.forEach((p, k) => { n[k + 1] += p; });
  const tot = n[1] + n[2] + n[3];
  return { tot, secs: tot * B.step, split: tot ? [1, 2, 3].map(k => [BN[k][3], Math.round(n[k] * 100 / tot), BN[k][2]]) : [] };
}
const bnClock = (u, sec, day) => { const d = new Date(u * 1000), p = x => ('0' + x).slice(-2); return (day ? d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' : '') + p(d.getHours()) + ':' + p(d.getMinutes()) + (sec ? ':' + p(d.getSeconds()) : ''); };
function bnTicks(B) {
  if (B.step === 1) return '<span>-15m</span><span>-10m</span><span>-5m</span><span>now</span>';
  const t0 = B.end - (B.n - 1) * B.step, wk = B.n * B.step >= 2 * 86400;
  return '<span>' + bnClock(t0, false, wk) + '</span><span>' + bnClock(t0 + B.n * B.step / 2, false, wk) + '</span><span>now</span>';
}
function bnPanel(box, e, full) {
  if (full || !box.querySelector('.bnp')) box.innerHTML = '<div class="bnp"><div class="bnw"><svg class="bnc" preserveAspectRatio="none"></svg><i class="bgd"></i><div class="btip"></div></div><div class="sticks"></div><div class="mstats"></div></div>';
  const B = BNP.B = bnCols(), svg = box.querySelector('.bnc');
  box.querySelector('.bnp').classList.toggle('loading', !B);
  if (B) { const d = bnSvg(B); if (svg._h !== d.h) { svg.setAttribute('viewBox', d.vb); svg.innerHTML = d.h; svg._h = d.h; } }
  const sum = B && bnSum(B);
  const lg = !B ? '<span>loading...</span>' : sum.tot ? bnLegend(sum) + (B.step > 1 ? '<span><em>game time</em>' + (sum.secs < 59.5 ? Math.round(sum.secs) + 's' : durTxt(sum.secs)) + '</span>' : '') : B.old ? '<span>The split per minute is kept from HW Deck 1.3.0 on: nothing here yet</span>' : '<span>no game in ' + BN_SPAN[bigRange] + '</span>';
  const el = box.querySelector('.mstats'); if (el._h !== lg) { el.innerHTML = lg; el._h = lg; }
  const tk = B ? bnTicks(B) : '', st = box.querySelector('.sticks'); if (st._h !== tk) { st.innerHTML = tk; st._h = tk; }
  bnHover(box);
}
// the read-out under the pointer: that second's call, or that minute's (block's) split and how long a game ran in it
function bnHover(box) {
  const w = box.querySelector('.bnw'); if (!w) return;
  const B = BNP.B, r = w.getBoundingClientRect(), f = BNP.x === null ? -1 : (BNP.x - r.left) / Math.max(1, r.width);
  if (!B || f < 0 || f > 1) { w.classList.remove('hv'); return; }
  const i = Math.max(0, Math.min(B.n - 1, Math.floor(f * B.n))), v = B.cols[i], at = B.end - (B.n - 1 - i) * B.step;
  let h = '<b>' + bnClock(at, B.step === 1, B.n * B.step >= 2 * 86400) + '</b>';
  if (!v) h += '<span>no game</span>';
  else if (B.step === 1) { const k = v.indexOf(1) + 1; h += '<span><i class="' + BN[k][2] + '"></i>' + BN[k][0] + ' ' + BN[k][1] + '</span>'; }
  else {
    const tot = v[0] + v[1] + v[2], s = Math.round(tot * B.step);
    h += v.map((p, k) => p > 0 ? '<span><i class="' + BN[k + 1][2] + '"></i>' + BN[k + 1][3] + ' <em>' + Math.round(p / tot * 100) + '%</em></span>' : '').join('') +
         '<span>a game for ' + (s >= 60 ? Math.round(s / 60) + ' min' : s + ' s') + '</span>';
  }
  const tip = w.querySelector('.btip'); if (tip._h !== h) { tip.innerHTML = h; tip._h = h; }
  const gx = (i + 0.5) / B.n * r.width, tw = tip.offsetWidth;
  w.querySelector('.bgd').style.left = gx.toFixed(1) + 'px';
  tip.style.left = (gx + 12 + tw > r.width ? gx - 12 - tw : gx + 12).toFixed(1) + 'px';
  w.classList.add('hv');
}
$('mextra').addEventListener('pointermove', ev => { const w = ev.target.closest && ev.target.closest('.bnw'); BNP.x = w ? ev.clientX : null; bnHover($('mextra')); });
$('mextra').addEventListener('pointerleave', () => { BNP.x = null; bnHover($('mextra')); });
// a press outside the popup closes it, however soon after it opened and wherever (the same spot as the cell too)
modal.addEventListener('mousedown', e => { if (e.target === modal) closeDetail(); });
$('mclose').onclick = closeDetail;
function graphCtx(cv) {
  const dpr = window.devicePixelRatio || 1, w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}
function yCaption(ctx, dpr, text) { if (!text) return; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#555'; ctx.font = (10 * dpr) + 'px Segoe UI'; ctx.fillText(text, 4 * dpr, 1 * dpr); }
// the popup's big graph: the line and its area, the peaks as a faint line on the long ranges, the gate lines, time along the bottom
// a graph's scale (the popup's and the tiles'): at least a sensible span for its unit, so a steady reading's one-step
// change stays a small step (52 to 53 C filled the whole graph); its top at its highest value, unless a few spikes stand
// far above the rest (a second at 1,702 fps over a line at 230): then it follows the rest and the spikes are cut at the
// top; and never below zero for a reading that never is
const MIN_SPAN = { '°C': 10, '°F': 18, '%': 10, 'RPM': 200, 'W': 20, 'V': 0.1, 'A': 2, 'MHz': 200, 'FPS': 20, 'GB': 1, 'MB': 1024, 'ms': 5 };
const minSpanOf = u => MIN_SPAN[u] || 0;
function scaleTop(vals, unit) {
  let max = -Infinity; for (const v of vals) if (v > max) max = v;
  if (vals.length < 20 || unit === '%' || unit === 'Yes/No') return { top: max, cut: false, max };   // (0 to 100 is a scale already)
  // cut only far spikes, more than half again over the usual top: a temperature's short peak or a burst stays whole,
  // and so does every burst of a reading that sits at 0, give or take a little noise (a drive's rate, a fan stopped
  // at idle): its usual top is next to nothing of the range. A steady line (a capped fps) still has its far spike cut
  const s = vals.slice().sort((a, b) => a - b), p = s[Math.floor(s.length * 0.95)], lo = s[0];
  // (at 0 within its own noise: never cut; and a spike is one or two points far up, a glitch, where bursts are more)
  const floor = Math.abs(lo) <= p - lo && Math.abs(p) <= (max - lo) * 0.01, far = vals.filter(v => v > p + (max - p) / 2).length;
  return !floor && far <= 2 && max - p > Math.max(p - lo, Math.abs(p) * 0.5) ? { top: p, cut: true, max } : { top: max, cut: false, max };
}
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
  let dLo = Math.min(...vals);
  const sc = scaleTop(pvals.length ? vals.concat(pvals) : vals, unit), floor0 = dLo >= 0;
  let dHi = sc.top;
  if (yn) { dLo = 0; dHi = 1; }
  if (gateInView) { if (det.y !== undefined) dHi = Math.max(dHi, det.y); if (det.r !== undefined) dHi = Math.max(dHi, det.r); }
  const mag = Math.max(Math.abs(dLo), Math.abs(dHi), 1e-6), minSpan = Math.max(minSpanOf(unit), mag * 0.06, dec ? Math.pow(10, -dec) * 4 : 2);   // a flat 0 gets -1..1, not 8 decimals
  if (dHi - dLo < minSpan) { const mid = (dLo + dHi) / 2; dLo = mid - minSpan / 2; dHi = mid + minSpan / 2; if (floor0 && dLo < 0) { dHi -= dLo; dLo = 0; } }
  const pad = (dHi - dLo) * 0.12; dLo -= pad; dHi += pad;
  if (floor0 && dLo < 0) dLo = 0;
  const rawStep = yn ? 1 : (dHi - dLo) / 3, pw = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = yn ? 1 : [1, 2, 5, 10].map(m => m * pw).find(s => s >= rawStep) || 10 * pw;
  const stepDec = step >= 1 ? 0 : Math.ceil(-Math.log10(step) - 1e-9);
  const lo = yn ? -0.25 : Math.max(floor0 ? 0 : -Infinity, Math.floor(dLo / step) * step), hi = yn ? 1.25 : Math.ceil(dHi / step) * step;
  // (a value past the scale, a cut spike, is drawn at its edge)
  const X = i => padL + i / (data.length - 1) * (w - padL - padR), Y = v => h - padB - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * (h - padT - padB);
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
  for (const g of [['y', '#e6c84a'], ['r', '#e5484d'], ['y2', '#e6c84a'], ['r2', '#e5484d']]) {
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
  ctx.fillStyle = '#c9c9c9';   // a value on its own between gaps still shows, as a dot
  for (const run of rs) if (run.length === 1) { ctx.beginPath(); ctx.arc(X(run[0]), Y(data[run[0]]), 1.5 * dpr, 0, 7); ctx.fill(); }
  if (!maxData) {
    ctx.beginPath();
    for (const run of rs) { run.forEach((i, j) => j ? ctx.lineTo(X(i), Y(data[i])) : ctx.moveTo(X(i), Y(data[i]))); ctx.lineTo(X(run[run.length - 1]), h - padB); ctx.lineTo(X(run[0]), h - padB); ctx.closePath(); }
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB); grad.addColorStop(0, 'rgba(201,201,201,0.16)'); grad.addColorStop(1, 'rgba(201,201,201,0)');
    ctx.fillStyle = grad; ctx.fill();
  }
  ctx.restore();
  if (sc.cut && sc.max > hi && !yn && rv >= 1) {   // a spike cut at the top says how high it went, beside it
    const src = maxData || data; let at = -1, mv = -Infinity;
    src.forEach((v, i) => { if (v !== null && v !== undefined && v > mv) { mv = v; at = i; } });
    if (at >= 0) {
      const txt = 'peak ' + (dec ? (+mv).toFixed(dec) : Math.round(mv).toLocaleString('en-US'));
      ctx.font = (11 * dpr) + 'px Segoe UI'; ctx.textBaseline = 'top'; ctx.fillStyle = '#8a8a8a';
      const x = X(at), right = x + 6 * dpr + ctx.measureText(txt).width <= w - padR;
      ctx.textAlign = right ? 'left' : 'right'; ctx.fillText(txt, right ? x + 6 * dpr : x - 6 * dpr, padT + 1 * dpr);
    }
  }
  if (preview) return;
  bigMap = { padL, padR, padT, padB, w, h, Y, n: data.length, data, maxData, span, dec, unit };
  if (HV.on) kickHover();
}
// a fan's curve in the popup: temperature 0-100 along the bottom, the live point on it
function drawCurveChart(cv, c, e) {
  const { ctx, w, h, dpr } = graphCtx(cv);
  const padL = 58 * dpr, padR = 10 * dpr, padT = 12 * dpr, padB = 38 * dpr;
  const pts = c.curve.pts.slice().sort(ptOrd);
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
  // (the tolerance isn't drawn: it only decides whether the fan is on its curve)
  // past its first and last points a fan keeps their speed: dashed to the edges of the graph
  const p0 = pts[0], pn = pts[pts.length - 1], x0 = X(p0[0]), xn = X(pn[0]);
  ctx.beginPath();
  if (x0 > padL) { ctx.moveTo(padL, Y(p0[1])); ctx.lineTo(x0, Y(p0[1])); }
  if (xn < w - padR) { ctx.moveTo(xn, Y(pn[1])); ctx.lineTo(w - padR, Y(pn[1])); }
  ctx.strokeStyle = '#8f8f8f'; ctx.globalAlpha = 0.65; ctx.lineWidth = 1.4 * dpr; ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
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
hprev.innerHTML = '<div class="ph"><span class="pi"></span><span class="pt"></span><span class="pv"></span></div><canvas></canvas>' +
  '<div class="pstrip" hidden><div class="strip big"></div><div class="sticks"><span>-15m</span><span>-10m</span><span>-5m</span><span>now</span></div></div><div class="ps"></div><div class="pc"></div>';
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
  const r = c.key ? BYKEY.get(c.key) : null, e = evalCell(HP.cid, c, true, true), dec = decOfCell(c, r), f = x => x == null || !isFinite(x) ? '--' : fmtV(x, dec, r);
  const pi = hprev.querySelector('.pi'), ic = iconOf(c, r);
  if (pi._h !== ic) { pi.innerHTML = ic; pi._h = ic; sweepSpins(); }
  if (isFanCell(c)) spinIcon(pi.querySelector('svg'), e.v);
  setText(hprev.querySelector('.pt'), nameIn(HP.cid));
  const pv = hprev.querySelector('.pv'), vh = e.txt != null ? esc(e.txt) + '<small>' + esc(e.utxt) + '</small>' : esc(fmtV(e.v, dec, r)) + '<small>' + esc(c.pred ? 'RPM' : unitOf(r)) + '</small>';
  if (pv._h !== vh) { pv.innerHTML = vh; pv._h = vh; }
  pv.style.color = COLORS[e.col] || COLORS.white;
  // the bottleneck shows its bar and each call's share instead of a graph and min / avg / max
  hprev.querySelector('canvas').hidden = !!e.strip; hprev.querySelector('.pstrip').hidden = !e.strip;
  if (e.strip) renderStrip(hprev.querySelector('.pstrip .strip'), e.strip.segs, HLEN);
  const v = e.strip ? [] : cellSeries(c, HLEN).filter(x => isFinite(x));
  const sh = e.strip ? bnLegend(e.strip) : v.length && !isYN(r) ? '<span><em>min</em>' + f(Math.min(...v)) + '</span><span><em>avg</em>' + f(v.reduce((a, b) => a + b, 0) / v.length) + '</span><span><em>max</em>' + f(Math.max(...v)) + '</span>' : '';
  const ps = hprev.querySelector('.ps'); if (ps._h !== sh) { ps.innerHTML = sh; ps._h = sh; }
  setText(hprev.querySelector('.pc'), e.strip && BN[e.v] ? '' : e.sub);   // the bottleneck's split is already above
  return true;
}
function drawPrev() {
  const c = S.L.cells[HP.cid]; if (!c || isBneck(c)) { HP.rev0 = 0; return; }
  const r = c.key ? BYKEY.get(c.key) : null, g = c.gates, gk = gbK(r), det = gbDet(gateLines(g), gk);
  const sp = gbArr(bucketArr(c), gk), vals = sp.filter(x => x !== null);
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
      if (b.dataset.m === 'import' && heldSlots.has(i)) toast(slotName(i) + ' is open in another program (a sync or a backup tool): try again in a moment');
      else if (b.dataset.m === 'import') { if (s) askConfirm('Import into ' + slotName(i) + '?', 'The layout from the file replaces what the slot holds.', 'Import', () => send({ t: 'import', slot: i })); else send({ t: 'import', slot: i }); }
      if (b.dataset.m === 'empty') askConfirm('Empty ' + slotName(i) + '?', 'The slot forgets its layout. The view you have now stays.', 'Empty slot', () => {
        S.slots[i] = null; if (S.active === i) S.active = null;
        const unslot = js => { const o = JSON.parse(js); if (o.active !== i) return js; o.active = null; return JSON.stringify(o); };   // (an undo can't link the view to it again)
        undoStack = undoStack.map(unslot); redoStack = redoStack.map(unslot); if (dragPt && dragPt.before) dragPt.before = unslot(dragPt.before);
        saveSlot(i); saveState(); syncSaves(); renderSaves();
      });
    };
  }
});
$('slist').addEventListener('dblclick', e => { const row = e.target.closest('.srow2'); if (row && e.target.closest('.st') && S.slots[Number(row.dataset.slot)]) renameSlot(Number(row.dataset.slot)); });
smodal.addEventListener('mousedown', e => { if (smenu && !smenu.contains(e.target) && !e.target.closest('[data-a="more"]')) closeSmenu(); });
function renameSlot(i) {
  const st = $('slist').querySelector('.srow2[data-slot="' + i + '"] .st'); if (!st) return;
  const inp = document.createElement('input'); inp.value = slotName(i); inp.maxLength = 80; inp.setAttribute('aria-label', 'Slot name');
  st.innerHTML = ''; st.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const fin = keep => { if (done) return; done = true; if (keep && inp.value.trim()) { S.slots[i].name = inp.value.trim().slice(0, 80); saveSlot(i); } syncSaves(); renderSaves(); };   // (80: what a slot file keeps)
  inp.onkeydown = ev => {
    ev.stopPropagation();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); fin(true); onSave(); return; }
    if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false);
  };
  inp.onblur = () => fin(true);
}
function loadSlot(i) {
  snap(); slotWanted = null;   // (a load, a save, a clear or an import: the view's link is the user's now, not the one held at the start)
  S.L = JSON.parse(JSON.stringify(S.slots[i] ? S.slots[i].layout : emptyLayout()));
  S.active = i; sel = null; endRelink(true);
  const n = relinkByName();
  smodal.classList.remove('open');   // you load a slot to look at it
  enterNext = true; afterChange();
  toast('Loaded ' + slotName(i) + (n ? ', ' + plural(n, 'cell') + ' re-linked by sensor name' : ''), true);
}
function saveTo(i) {
  if (heldSlots.has(i)) { toast(slotName(i) + ' is open in another program (a sync or a backup tool): save again in a moment'); return; }   // (its file is there, the page just hasn't got it)
  slotWanted = null;
  const name = S.slots[i] ? S.slots[i].name : 'Slot ' + (i + 1);
  S.slots[i] = { v: 1, name, layout: JSON.parse(JSON.stringify(S.L)) };
  // (the undo steps of the slot it was go with it: an undo can't link the view back to the slot left alone on purpose)
  // (only the newest run of steps linked to it, back to the Load or Clear that started it)
  const was = S.active, move = st => { for (let k = st.length - 1; k >= 0; k--) { const o = JSON.parse(st[k]); if (o.active !== was) break; o.active = i; st[k] = JSON.stringify(o); } };
  if (was !== i && was != null) { move(undoStack); move(redoStack); }   // (a view linked to no slot: its history isn't that slot's)
  S.active = i; saveSlot(i); saveState(); syncSaves(); toast('Saved to ' + slotName(i));
}
function onSave() {
  if (S.active != null) { saveTo(S.active); return; }
  if (slotWanted != null) { toast(slotName(slotWanted) + ' is open in another program (a sync or a backup tool): save again in a moment'); return; }   // (the view's own slot, held at the start)
  const free = S.slots.findIndex((s, k) => !s && !heldSlots.has(k));
  if (free >= 0) saveTo(free); else { renderSaves(); smodal.classList.add('open'); }
}
$('clearBtn').onclick = () => askConfirm('Clear the view?', 'Back to the first run: no cells. Your slots stay as they are, and Undo brings the view back.', 'Clear view', () => {
  snap(); S.L = emptyLayout(); S.active = null; slotWanted = null; sel = null; endRelink(true);
  smodal.classList.remove('open'); afterChange(); toast('View cleared', true);
});

// ---------- the warning log: merged episodes from alerts.log, last 7 days ----------
const wmodal = $('wmodal');
let lastLogCount = 0;
$('logBtn').onclick = () => { wmodal.classList.add('open'); $('wlist').innerHTML = '<div class="wempty">loading...</div>'; if (host) send({ t: 'alerts' }); else renderWarnings(''); };
$('wclear').onclick = () => askConfirm('Clear warning history?', 'This wipes the warning log (' + lastLogCount + ' crossings' + (feed.warnDays ? ' in the last ' + feed.warnDays + ' days' : '') + '). A copy goes to alerts.log.bak first.', 'Clear history', () => send({ t: 'alerts:clear' }));
function fmtDur(ms) { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's'; const m = Math.round(s / 60); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
function renderWarnings(log) {
  const open = Object.create(null), eps = [];   // (by name: a cell may be called "constructor")
  for (const line of (log || '').split(/\r?\n/)) {
    // times carry their UTC offset (so a summer-time change doesn't make durations negative); older lines don't
    const m0 = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)([+-]\d\d:\d\d)?\s+(YELLOW|RED|OK|MARK|PEAK)\s+(.+)$/);
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
    // the peak so far of an episode the next MARK ends (logs from 1.0.0 have none)
    if (m[3] === 'PEAK') { if (open[name]) open[name].peak = detail; continue; }
    if (open[name]) { if (m[3] === 'RED') { open[name].level = 'RED'; open[name].redDetail = detail; } continue; }
    const ep = { when, day: m[1], time: m[2].slice(0, 5), level: m[3], name, detail, end: null, peak: null, interrupted: false };
    open[name] = ep; eps.push(ep);
  }
  const N = feed.warnDays, recent = N ? eps.filter(ep => ep.when.getTime() >= Date.now() - N * 86400000) : eps;   // (no days set: all of it)
  setText($('wdays'), N ? String(N) : 'all');
  const groups = [], lastOf = Object.create(null);
  for (const ep of recent) {
    const g = lastOf[ep.name], prevEnd = g ? (g.end || g.last.when) : null;
    if (g && g.day === ep.day && ep.when - prevEnd <= 600000) { g.eps.push(ep); g.last = ep; if (ep.level === 'RED') g.level = 'RED'; g.end = ep.end; g.ongoing = !ep.end && !ep.interrupted; g.cut = ep.interrupted && !ep.end; }
    else { const ng = { name: ep.name, day: ep.day, first: ep, last: ep, eps: [ep], level: ep.level, end: ep.end, ongoing: !ep.end && !ep.interrupted, cut: ep.interrupted && !ep.end }; groups.push(ng); lastOf[ep.name] = ng; }
  }
  const num = x => { const m = /^(-?[\d.]+)\s*(.*)$/.exec(x || ''); return m ? { v: parseFloat(m[1]), u: m[2].replace(/\s*\(.*$/, '') } : null; };   // (a -12V rail is negative)
  // a row's peak: the worst of its episodes, the lowest for a line that warns below (the host marks those "(under its
  // line)"; an older log is read off an episode whose peak went lower than its crossing)
  for (const g of groups) {
    let pk = null, dur = 0;
    const low = g.eps.some(ep => /\(under its line\)/.test(ep.detail) || (!/ fan curve$/.test(ep.name) && num(ep.peak) && num(ep.detail) && num(ep.peak).v < num(ep.detail).v));   // (a curve's peak is the furthest off it, either way)
    for (const ep of g.eps) { const c = num(ep.peak) || num(ep.redDetail) || num(ep.detail); if (c && (!pk || (low ? c.v < pk.v : c.v > pk.v))) pk = c; if (ep.end) dur += Math.max(0, ep.end - ep.when); }
    g.peak = pk; g.dur = dur;
  }
  lastLogCount = recent.length;
  const nRed = recent.filter(ep => ep.level === 'RED').length, nYel = recent.length - nRed;
  $('wsum').innerHTML = groups.length ? '<span>crossings' + (N ? ' in the last ' + N + ' days' : '') + ':</span><span><b style="color:#e5484d">' + nRed + '</b> red</span><span><b style="color:#e6c84a">' + nYel + '</b> yellow</span><span>' + plural(groups.length, 'row') + '</span>' : '';
  // (the newest 300 rows first, more on asking: a log with thousands of crossings drew them all at once)
  wGroups = groups.reverse(); wShow = 300; wEmptyN = N;
  drawWarnList();
}
let wGroups = [], wShow = 300, wEmptyN = 30;
function drawWarnList() {
  const today = localDay(new Date()), y = new Date(); y.setDate(y.getDate() - 1); const yest = localDay(y);
  let hh = '', lastDay = null;
  wGroups.slice(0, wShow).forEach((g, gi) => {
    if (g.day !== lastDay) { lastDay = g.day; hh += '<div class="wday">' + (g.day === today ? 'today' : g.day === yest ? 'yesterday' : g.day) + '</div>'; }
    const col = g.level === 'RED' ? '#e5484d' : '#e6c84a';
    const endT = g.end ? ('0' + g.end.getHours()).slice(-2) + ':' + ('0' + g.end.getMinutes()).slice(-2) : null;
    const span = g.eps.length > 1 || endT ? g.first.time + (endT && endT !== g.first.time ? ' to ' + endT : '') : g.first.time;
    const meta = g.ongoing ? 'ongoing' : g.cut ? 'until the app stopped' : (g.peak ? 'peak ' + g.peak.v + ' ' + g.peak.u : '') + (g.dur ? (g.peak ? ', ' : '') + fmtDur(g.dur) : '');
    const many = g.eps.length > 1;
    hh += '<div class="wrow' + (many ? ' wgrp' : '') + '" data-g="' + gi + '"><span class="wchev">' + (many ? '&#9656;' : '') + '</span><span class="wdot" style="background:' + col + '"></span>' +
      '<span class="wtime">' + span + '</span><span class="wname">' + esc(g.name) + (many ? '<span class="wcnt">' + g.eps.length + 'x</span>' : '') + '</span><span class="wmeta">' + esc(meta) + '</span></div>';
    if (many) hh += '<div class="wsub" data-sub="' + gi + '"></div>';   // (its episodes drawn when it opens: a big log had 100,000+ hidden rows)
  });
  if (wGroups.length > wShow) hh += '<button class="linkbtn wmore" id="wMore">Show older (' + plural(wGroups.length - wShow, 'more row') + ')</button>';
  $('wlist').innerHTML = hh || '<div class="wempty ico chk">Nothing crossed a line' + (wEmptyN ? ' in the last ' + wEmptyN + ' days' : '') + '. Quiet machine.</div>';
}
function wSubRows(g) {
  let hh = '';
  for (const ep of g.eps.slice().reverse()) {
    const m2 = ep.interrupted ? (/^HWiNFO/.test(ep.cut || '') ? 'HWiNFO stopped sharing' : /^PC going to sleep/.test(ep.cut || '') ? 'PC went to sleep' : 'ended with the app') + (ep.end ? ', ' + fmtDur(ep.end - ep.when) : '') + (ep.peak ? ', peak ' + ep.peak : '')
      : ep.end ? fmtDur(ep.end - ep.when) + (ep.peak ? ', peak ' + ep.peak : '') : 'ongoing';
    hh += '<div class="wrow"><span class="wdot" style="background:' + (ep.level === 'RED' ? '#e5484d' : '#e6c84a') + ';width:6px;height:6px"></span><span class="wtime">' + ep.time + '</span><span class="wname">' + (ep.level === 'RED' ? 'red' : 'yellow') + ' at ' + esc(ep.redDetail || ep.detail) + '</span><span class="wmeta">' + esc(m2) + '</span></div>';
  }
  return hh;
}
$('wlist').addEventListener('click', e => {
  if (e.target.closest('#wMore')) {
    const st = $('wlist').closest('.mcard').scrollTop, open = [...document.querySelectorAll('#wlist .wgrp.open')].map(x => x.dataset.g);
    wShow += 300; drawWarnList();
    for (const gi of open) {   // (the groups open before stay open)
      const row = document.querySelector('#wlist .wgrp[data-g="' + gi + '"]'), sub = document.querySelector('#wlist .wsub[data-sub="' + gi + '"]');
      if (row && sub && wGroups[+gi]) { row.classList.add('open'); sub.innerHTML = wSubRows(wGroups[+gi]); sub.classList.add('open'); }
    }
    $('wlist').closest('.mcard').scrollTop = st; return;
  }
  const r = e.target.closest('.wgrp'); if (!r) return;
  r.classList.toggle('open');
  const sub = document.querySelector('.wsub[data-sub="' + r.dataset.g + '"]');
  if (sub) { if (!sub.firstChild && wGroups[+r.dataset.g]) sub.innerHTML = wSubRows(wGroups[+r.dataset.g]); sub.classList.toggle('open'); }
});

// ---------- game sessions ----------
const gmodal = $('gmodal');
// a closed popup lets go of its list (thousands of rows stayed in the page all day) and of Customize (its readings
// stayed subscribed)
// (after the fade: emptied as it starts to close, the card shrank and jumped while it faded)
const afterFade = (el, fn) => setTimeout(() => { if (!el.classList.contains('open')) fn(); }, 250);
new MutationObserver(() => {
  if (gmodal.classList.contains('open')) return;
  if (gxLive.on !== false && host) { gxLive.on = false; send({ t: 'gamesLive', on: false }); }   // (no more Now playing until it opens again)
  afterFade(gmodal, () => {
    if ($('glist').firstChild) { $('glist').innerHTML = ''; gxSs = []; gxTl.length = 0; }
    gxText = '';
    if (GZ.on) { GZ.on = false; renderGz(); }
  });
}).observe(gmodal, { attributes: true, attributeFilter: ['class'] });
new MutationObserver(() => { if (!$('wmodal').classList.contains('open')) afterFade($('wmodal'), () => { if ($('wlist').firstChild) { $('wlist').innerHTML = ''; wGroups = []; } }); }).observe($('wmodal'), { attributes: true, attributeFilter: ['class'] });
let lastGameCount = 0;
$('gamesBtn').onclick = () => { gmodal.classList.add('open'); $('glist').innerHTML = '<div class="wempty">loading...</div>'; recKey = null; gxLoaded = false; renderRec(); if (host) { send({ t: 'games' }); gxLive.on = true; send({ t: 'gamesLive', on: true }); } else renderGames(''); };
let gxLoaded = false;   // the log is in since the popup opened (Start names the next "Session n" from it)
// ---- sessions of your own: Start records one (the host follows it like a game's, beside any game), each running one
// shows on top with its name (change it there), its time so far and Stop ----
let recKey = null, recHold = 0;
const recClock = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2); };
function renderRec() {
  const box = $('grun'), rs = feed.rec || [], k = rs.map(x => x[0]).join();
  if (k !== recKey) {   // (drawn again only when one starts or stops: a name being typed stays)
    recKey = k; box.hidden = !rs.length;
    box.innerHTML = rs.map(x => '<div class="gx-rec" data-start="' + x[0] + '"><span class="rdot"></span><input class="gx-rn" value="' + esc(x[1]) + '" maxlength="60" spellcheck="false" title="Its name: type a new one">' +
      '<span class="gx-rs">recording since ' + hhmm(x[0]) + '</span><span class="gx-rt"></span><button class="btn" data-rec="stop">Stop</button></div>').join('');
  }
  for (const el of box.children) setText(el.querySelector('.gx-rt'), recClock(Math.max(0, nowTs - +el.dataset.start)));
  $('grec').disabled = rs.length >= 8 || Date.now() < recHold || !gxLoaded;
}
// the next free 'Session n'
function recName() {
  let n = 0;
  for (const nm of gxSs.filter(x => x.custom).map(x => x.game).concat((feed.rec || []).map(x => x[1]))) { const m = /^Session (\d+)$/.exec(nm || ''); if (m) n = Math.max(n, +m[1]); }
  return 'Session ' + (n + 1);
}
$('grec').onclick = () => { send({ t: 'rec', act: 'start', name: recName() }); recHold = Date.now() + 2000; $('grec').disabled = true; setTimeout(renderRec, 2050); };   // (back on when the hold ends, not at the next tick)
$('grun').addEventListener('click', e => { const b = e.target.closest('[data-rec="stop"]'); if (!b) return; b.disabled = true; send({ t: 'rec', act: 'stop', start: +b.closest('.gx-rec').dataset.start }); });
$('grun').addEventListener('change', e => {
  if (!e.target.matches('.gx-rn')) return;
  const v = e.target.value.trim(), start = +e.target.closest('.gx-rec').dataset.start;
  if (v) send({ t: 'rec', act: 'name', start, name: v.slice(0, 60) });
  else { const r = (feed.rec || []).find(x => x[0] === start); if (r) e.target.value = r[1]; }   // (left empty: its name back)
});
$('grun').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.gx-rn')) e.target.blur(); });
$('gclear').onclick = () => askConfirm('Clear all sessions?', 'This wipes the session log (' + lastGameCount + (lastGameCount === 1 ? ' session' : ' sessions') + '). A copy goes to games.log.bak first.', 'Clear sessions', () => send({ t: 'games:clear' }));
// layout A, the tailored dashboard's popup: a week strip, columns that line up down the list, a session opens into
// avg / max bars against its lines and a minute by minute timeline
const GX_CHEV = '<svg class="gx-chev" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>';
const GX_WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GX_MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const gxN = v => typeof v === 'number' && isFinite(v) ? v : null;
const gxF = (v, d) => gxN(v) === null ? '--' : fmt(v, d);
// gpu-bound / cpu-bound / capped seconds while the game was in front
function gxSplit(x) {
  const g = Math.max(0, +x.g || 0), c = Math.max(0, +x.c || 0), f = Math.max(0, +x.f || 0), n = g + c + f;
  const pc = v => n ? Math.round(v / n * 100) : 0;
  const top = !n ? null : c >= g && c >= f ? ['cpu-bound', pc(c)] : g >= f ? ['gpu-bound', pc(g)] : ['capped', pc(f)];
  return { g, c, f, n, pc, top };
}
function gxNbar(sp) {
  let h = '<span class="gx-nbar">', x = 0;
  for (const [k, v] of [['gpu', sp.g], ['cpu', sp.c], ['cap', sp.f]]) { if (v && sp.n) h += '<span class="b-' + k + '" style="left:' + (x / sp.n * 100).toFixed(2) + '%;width:' + (v / sp.n * 100).toFixed(2) + '%"></span>'; x += v; }
  return h + '</span>';
}
// a reading's row: avg and max as a bar, its yellow and red lines as ticks (the bar runs a little past the red line,
// so a max beyond it shows), the max coloured by the lines it passed. Lines that warn below are only ticks
function gxRow(label, lo, hi, avg, max, y, r, unit, dec, peakOnly, below, sc) {
  const A = gxN(avg), M = gxN(max), P = v => Math.max(0, Math.min(100, (v - lo) / Math.max(1e-9, hi - lo) * 100));
  const lvl = below || M === null ? 0 : gxN(r) !== null && M >= r ? 2 : gxN(y) !== null && M >= y ? 1 : 0, lc = lvl === 2 ? ' r' : lvl === 1 ? ' y' : '';
  let b = '<span class="gx-mb">';
  if (M !== null && !peakOnly && A !== null) b += '<i class="a" style="width:' + P(A).toFixed(1) + '%"></i><i class="m' + lc + '" style="left:' + P(A).toFixed(1) + '%;width:' + Math.max(0, P(M) - P(A)).toFixed(1) + '%"></i>';
  else if (M !== null) b += '<i class="m solo' + lc + '" style="left:0;width:' + P(M).toFixed(1) + '%"></i>';
  else if (A !== null && !peakOnly) b += '<i class="a solo" style="width:' + P(A).toFixed(1) + '%"></i>';
  if (gxN(y) !== null && y > lo && y < hi) b += '<i class="t ty" style="left:' + P(y).toFixed(1) + '%"></i>';
  if (gxN(r) !== null && r > lo && r < hi) b += '<i class="t tr" style="left:' + P(r).toFixed(1) + '%"></i>';
  b += '</span>';
  const av = peakOnly ? (sc ? 'of ' + sc : 'peak') : gxF(A, dec);
  return '<div class="gx-rw"><span class="n" title="' + label + '">' + label + '</span>' + b + '<span class="a">' + av + '</span><span class="m' + lc + '">' + gxF(M, dec) + '<u>' + unit + '</u></span></div>';
}
// the main readings a report finds by their HWiNFO names: their name in the details, where a bar starts, where it ends
// with no red line (0: from the session's own values), decimals, peak only (memory: its peak against what there is)
const GX_MAIN = {
  'GPU temp': ['GPU', 30, 90, 1], 'GPU hotspot': ['GPU hotspot', 30, 110, 1], 'GPU memory': ['GPU memory', 30, 110, 1],
  'GPU power': ['GPU power', 0, 0, 0], 'GPU usage': ['GPU usage', 0, 100, 0],
  'CPU temp': ['CPU', 30, 100, 1], 'CPU power': ['CPU power', 0, 0, 1], 'CPU usage': ['CPU usage', 0, 100, 0],
  'VRAM': ['VRAM', 0, 0, 1, true], 'RAM': ['RAM', 0, 0, 1, true] };
// a session's readings: name, unit, avg, max (all an older line has), then its lines, 1 for a main reading, the scale
// of VRAM / RAM, 1 for lines that warn below and (from 1.4.0) its key
function gxItems(x) {
  return (Array.isArray(x.items) ? x.items : []).filter(it => Array.isArray(it) && it.length >= 4).map(it => ({ n: String(it[0]), u: typeof it[1] === 'string' ? it[1] : '',
    a: gxN(it[2]), m: gxN(it[3]), y: gxN(it[4]), r: gxN(it[5]), main: it.length > 6 ? it[6] === 1 : !!GX_MAIN[it[0]], hi: gxN(it[7]), below: it[8] === 1, key: typeof it[9] === 'string' ? it[9] : null }));
}
const gxTop = v => { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => s * p >= v) * p; };
function gxItemRow(it, label, spec) {
  if (!it) return '<div class="gx-rw nil" title="Not recorded in this session: a reading you add is recorded from the next game on"><span class="n">' + label + '</span><span class="gx-mb"></span><span class="a"></span><span class="m">--</span></div>';
  let { a, m, y, r, hi, u } = it;
  if (u === 'MB') { [a, m, y, r, hi] = [a, m, y, r, hi].map(v => v === null ? null : v / 1024); u = 'GB'; }   // (memory in GB, like the cells)
  const F = /°F/.test(u), deg = c => F ? Math.round(c * 9 / 5 + 32) : c;
  const base = a !== null ? a : m, lo = /°/.test(u) ? Math.max(0, Math.min(deg(30), Math.floor((base === null ? deg(40) : base) / 10) * 10 - 10)) : 0;
  // the bar ends a little past the red line (both lines show as ticks), else at a typical limit, the scale, or the values
  let top = !it.below && r !== null && r > lo ? r + (r - lo) * 0.12 : spec && spec[2] ? (spec[1] === 30 ? deg(spec[2]) : spec[2]) : hi !== null ? hi : u === '%' ? 100 : gxTop(Math.max(m || 0, y || 0, a || 0) * 1.15);
  if (y !== null && !it.below && y >= top) top = y + (y - lo) * 0.12;
  if (!(top > lo)) top = lo + 1;
  const peak = !!(spec && spec[4]) || (hi !== null && a === null);
  return gxRow(label, lo, top, a, m, y, r, esc(u), spec ? spec[3] : decFor({ unit: u }), peak, it.below, hi !== null ? fmt(hi, u === 'GB' ? 0 : decFor({ unit: u })) : '');
}
// minute by minute: fps and its 1% low, and what limited it as each minute's share of the time in front (gpu, cpu,
// capped); gaps are minutes the game wasn't in front. Sessions before 1.3.0 only kept the call that held most of each
// minute: those minutes show that call alone
const GX_BN = [['gpu', 'gpu-bound'], ['cpu', 'cpu-bound'], ['cap', 'capped']];
const gxTl = [];   // per session in the list: its minutes, for the hover read-out
function gxMinutes(x) {
  const tb = typeof x.tb === 'string' ? x.tb : '', tf = Array.isArray(x.tf) ? x.tf : [], tl = Array.isArray(x.tl) ? x.tl : [], tc = Array.isArray(x.tc) ? x.tc : [];
  const N = Math.max(tb.length, tf.length, tc.length), sh = [], one = [];
  for (let m = 0; m < N; m++) {
    const c = tc[m], k = tb[m] ? 'gcf'.indexOf(tb[m]) : -1;
    let s = null;
    if (Array.isArray(c) && c.length === 3) { const a = c.map(v => Math.max(0, +v || 0)), n = a[0] + a[1] + a[2]; if (n) s = a.map(v => v / n); }
    else if (k >= 0) { s = [0, 0, 0]; s[k] = 1; one[m] = true; }
    sh.push(s);
  }
  const fv = [], lv = [];
  for (let m = 0; m < N; m++) { fv.push(gxN(tf[m])); lv.push(gxN(tl[m])); }
  return { N, fv, lv, sh, one };
}
const gxHasTl = D => D.N >= 2 && (D.sh.some(Boolean) || D.fv.some(v => v !== null));
function gxTimeline(x, sp, gi) {
  const D = gxMinutes(x), N = D.N;
  if (!gxHasTl(D)) return '';
  const T = gxTl[gi] = Object.assign({ start: x.start, custom: !!x.custom, gaps: Array.isArray(x.gaps) ? x.gaps.filter(g => Array.isArray(g) && g.length >= 2) : [] }, D);
  const cut = x.end - x.start > N * 60 + 90;   // (the host keeps 24 hours of minutes)
  let h = '<div class="gx-tl" data-g="' + gi + '"><div class="gx-ch">over time<span>' + (cut ? 'the first 24 hours, ' : '') + (x.custom ? 'per minute' : 'per minute, gaps are time the game was not in front or closed, or HW Deck was closed') + '</span></div><div class="gx-hz">';
  const have = D.fv.filter(v => v !== null);
  if (have.length) {
    // round steps, about 4 of them, from a little under the lowest 1% low to a little over the highest fps
    const all = have.concat(D.lv.filter(v => v !== null)), mn = Math.min(...all), mx = Math.max(...all), sp0 = Math.max(1, mx - mn);
    const raw = Math.max(5, sp0 * 1.25 / 4), pw = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(s => s * pw).find(s => s >= raw);
    let lo = Math.max(0, Math.floor((mn - sp0 * 0.08) / step) * step), top = Math.ceil((mx + sp0 * 0.08) / step) * step;
    if (top - lo < 2 * step) { top += step; lo = Math.max(0, lo - step); }
    T.lo = lo; T.top = top;
    const W = N * 10, H = 140, X = m => ((m + 0.5) * 10).toFixed(1), Y = v => (H - (Math.max(lo, Math.min(top, v)) - lo) / (top - lo) * H).toFixed(1);
    let grid = '', band = '', yl = '';
    for (let v = lo; v <= top + 1e-9; v += step) { grid += '<line x1="0" x2="' + W + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/>'; yl += '<span style="top:' + (+Y(v) / H * 100).toFixed(2) + '%">' + +v.toFixed(1) + '</span>'; }
    // runs of minutes with a value; a minute on its own between gaps is a short dash
    const runs = arr => { const out = []; let cur = null; arr.forEach((v, m) => { if (v === null) { cur = null; return; } if (!cur) out.push(cur = []); cur.push(m); }); return out; };
    const line = (arr, cls) => runs(arr).map(r => '<polyline class="' + cls + '" points="' + (r.length > 1 ? r.map(m => X(m) + ',' + Y(arr[m])).join(' ') : (+X(r[0]) - 3) + ',' + Y(arr[r[0]]) + ' ' + (+X(r[0]) + 3) + ',' + Y(arr[r[0]])) + '"/>').join('');
    for (const r of runs(D.fv)) if (r.length > 1 && r.every(m => D.lv[m] !== null)) band += '<polygon points="' + r.map(m => X(m) + ',' + Y(D.fv[m])).join(' ') + ' ' + r.slice().reverse().map(m => X(m) + ',' + Y(D.lv[m])).join(' ') + '"/>';
    h += '<div class="gx-tr f"><span class="l">fps</span><span class="gx-plot"><svg class="gx-fpsc" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + grid + band + line(D.lv, 'lo') + line(D.fv, 'fp') + '</svg>' +
         '<i class="gx-gd"></i><i class="gx-dot lo"></i><i class="gx-dot fp"></i></span><span class="gx-yax">' + yl + '</span></div>';
  }
  if (D.sh.some(Boolean)) {
    // a column per minute, its share of each call stacked: gpu at the bottom, then cpu, capped on top
    const H2 = 40, gap = N <= 120 ? 1.6 : 0;
    let cols = '';
    D.sh.forEach((s, m) => {
      if (!s) return;
      let y = H2;
      s.forEach((v, k) => { if (v <= 0) return; const hh = v * H2; y -= hh; cols += '<rect class="b-' + GX_BN[k][0] + '" x="' + (m * 10 + gap / 2).toFixed(1) + '" y="' + y.toFixed(2) + '" width="' + (10 - gap).toFixed(1) + '" height="' + hh.toFixed(2) + '"/>'; });
    });
    h += '<div class="gx-tr s"><span class="l">limited by</span><span class="gx-plot"><svg class="gx-bnc" viewBox="0 0 ' + N * 10 + ' ' + H2 + '" preserveAspectRatio="none"><line x1="0" x2="' + N * 10 + '" y1="' + H2 + '" y2="' + H2 + '"/>' + cols + '</svg><i class="gx-gd"></i></span><span></span></div>';
  }
  h += '<div class="gx-tip"></div></div>';
  // clock ticks: start and end, and the round half hours (quarters, fives) between them; none past the end, which a
  // last minute cut short leaves before the right edge, and none that would read the same as the end
  // (a long one gets hours apart, or its labels ran into each other past about 16 hours)
  const t0 = x.start, t1 = x.start + N * 60, t2 = Math.min(t1, x.end), every = N > 960 ? 180 : N > 480 ? 60 : N > 90 ? 30 : N > 40 ? 15 : N > 15 ? 5 : 1;
  const day = u => GX_WD[new Date(u * 1000).getDay()].slice(0, 3) + ' ', long = t2 - t0 >= 16 * 3600;   // (a chart most of a day long: which day each end is)
  let tk = '<span class="e0">' + (long ? day(t0) : '') + hhmm(t0) + '</span>';
  const tz = new Date(t0 * 1000).getTimezoneOffset() * 60;   // (rounded on the local clock: UTC minus local, in seconds)
  for (let u = Math.ceil((t0 - tz) / 60 / every) * every * 60 + tz; u < t2; u += every * 60) {
    const pc = (u - t0) / (t1 - t0) * 100;
    if (pc > 9 && pc < 91 && hhmm(u) !== hhmm(t2)) tk += '<span style="left:' + pc.toFixed(2) + '%">' + hhmm(u) + '</span>';
  }
  tk += '<span class="e1">' + (long ? day(t2) : '') + hhmm(t2) + '</span>';
  h += '<div class="gx-tr"><span></span><span class="gx-ticks">' + tk + '</span><span></span></div>';
  const away = !x.custom && typeof x.front === 'number' && typeof x.secs === 'number' ? x.secs - x.front : 0, of = { gpu: 'g', cpu: 'c', cap: 'f' };   // (yours count every second: no time away)
  h += '<div class="gx-tr"><span></span><span class="gx-leg">' + (have.length ? '<span><b class="ln fp"></b>fps</span><span><b class="ln lo"></b>1% low</span>' : '') +
       (sp.n ? GX_BN.map(([k, t]) => '<span><b class="b-' + k + '"></b>' + t + ' <i>' + sp.pc(sp[of[k]]) + '%</i></span>').join('') : '') +
       (away >= 60 ? '<span><b class="aw"></b>not in front ' + durTxt(away) + '</span>' : '') + '</span><span></span></div>';
  return h + '</div>';
}
// the hover read-out: the minute under the pointer, a guide through both charts, its fps, 1% low and split
let gxHz = null;
function gxHover(hz, e) {
  if (gxHz && gxHz !== hz) gxHz.classList.remove('hv');
  gxHz = hz;
  if (!hz) return;
  const tl = hz.closest('.gx-tl'), T = gxTl[+tl.dataset.g], plot = hz.querySelector('.gx-plot');
  if (!T || !plot) return;
  const pr = plot.getBoundingClientRect(), f = (e.clientX - pr.left) / Math.max(1, pr.width);
  if (f < 0 || f > 1) { hz.classList.remove('hv'); return; }
  const m = Math.max(0, Math.min(T.N - 1, Math.floor(f * T.N))), at = ((m + 0.5) / T.N * 100).toFixed(3) + '%';
  for (const g of hz.querySelectorAll('.gx-gd')) g.style.left = at;
  for (const [cls, arr] of [['fp', T.fv], ['lo', T.lv]]) {
    const d = hz.querySelector('.gx-dot.' + cls); if (!d) continue;
    const v = arr[m];
    d.style.display = v === null ? 'none' : '';
    if (v !== null) { d.style.left = at; d.style.top = ((1 - (Math.max(T.lo, Math.min(T.top, v)) - T.lo) / (T.top - T.lo)) * 100).toFixed(2) + '%'; }
  }
  const s = T.sh[m], fpsAt = T.fv[m] !== null || T.lv[m] !== null;
  let h = '<b>' + hhmm(T.start + m * 60) + '</b>';
  if (fpsAt) h += '<span>fps <em>' + gxF(T.fv[m]) + '</em></span><span>1% low <em>' + gxF(T.lv[m]) + '</em></span>';
  if (s && T.one[m]) { const k = s.indexOf(1); h += '<span><i class="b-' + GX_BN[k][0] + '"></i>mostly ' + GX_BN[k][1] + '</span>'; }
  else if (s) h += GX_BN.map(([k, t], j) => s[j] > 0.005 ? '<span><i class="b-' + k + '"></i>' + t + ' <em>' + Math.round(s[j] * 100) + '%</em></span>' : '').join('');
  const brk = T.gaps.some(g => T.start + m * 60 + 59 >= g[0] && T.start + m * 60 <= g[1]);
  if (!s && !fpsAt) h += '<span>' + (T.custom ? 'nothing recorded' : brk ? 'a break: the game was closed' : 'not in front, or HW Deck was closed') + '</span>';
  const tip = hz.querySelector('.gx-tip');
  if (tip._h !== h) { tip.innerHTML = h; tip._h = h; }
  const hr = hz.getBoundingClientRect(), gx = pr.left - hr.left + (m + 0.5) / T.N * pr.width, tw = tip.offsetWidth;
  tip.style.left = (gx + 14 + tw > hr.width ? gx - 14 - tw : gx + 14).toFixed(1) + 'px';
  hz.classList.add('hv');
}
$('glist').addEventListener('pointermove', e => { gxPtAt(e); gxHover(e.target.closest && e.target.closest('.gx-hz'), e); });
$('glist').addEventListener('pointerleave', () => { gxPt = null; gxHover(null); });
// the pointer on the list, for the live row to wait for: a mouse or a pen over it, a finger only while it presses (a
// touch screen keeps :hover on what was tapped last)
let gxPt = null;
const gxPtAt = e => { gxPt = { x: e.clientX, y: e.clientY, down: e.buttons > 0 || e.type === 'pointerdown', touch: e.pointerType === 'touch' }; };
$('glist').addEventListener('pointerdown', gxPtAt);
for (const ty of ['pointerup', 'pointercancel']) document.addEventListener(ty, e => { if (gxPt) { gxPt.down = false; if (e.pointerType === 'touch') gxPt = null; } }, true);
// ---- a session's details: a summary, the chart, then its readings in categories (Customize: your own categories, any
// reading, 8 to a category). The setup lives in the layout (L.games), the default is below ----
const gxDefault = () => ({ secs: [
  { id: 'summary', kind: 'summary' }, { id: 'time', kind: 'time' },
  { id: 'temps', kind: 'list', name: 'Temperatures', cells: ['GPU temp', 'GPU hotspot', 'GPU memory', 'CPU temp'].map(head => ({ head })) },
  { id: 'power', kind: 'list', name: 'Power and load', cells: ['GPU power', 'GPU usage', 'CPU power', 'CPU usage'].map(head => ({ head })) },
  { id: 'memory', kind: 'list', name: 'Memory', cells: [{ head: 'VRAM' }, { head: 'RAM' }] }] });
const gxLayout = () => S.L.games && Array.isArray(S.L.games.secs) ? S.L.games : gxDefault();
const gxSecName = s => s.kind === 'summary' ? 'Summary' : s.kind === 'time' ? 'Over time' : s.name || 'Category';
// (a reading added by its key goes by the name its cell has in your layout, else by HWiNFO's)
const gxCellName = c => { if (c.name) return c.name; if (c.head) return GX_MAIN[c.head][0]; const cid = Object.keys(S.L.cells).find(id => S.L.cells[id].key === c.key); return cid ? nameIn(cid) : BYKEY.get(c.key) ? BYKEY.get(c.key).label : c.key; };
const gxCellFrom = c => c.head ? 'found by its HWiNFO name' : BYKEY.get(c.key) ? SENS[BYKEY.get(c.key).s].short : 'not on this PC';
const gxFind = (items, c) => c.head ? items.find(it => it.main && it.n === c.head) || null : items.find(it => it.key === c.key) || null;
function gxSummary(x, sp, items) {
  const away = typeof x.front === 'number' && typeof x.secs === 'number' ? x.secs - x.front : 0;
  const hot = items.filter(it => /°/.test(it.u) && it.m !== null).reduce((a, b) => !a || b.m > a.m ? b : a, null);
  const hl = hot && !hot.below ? (hot.r !== null && hot.m >= hot.r ? 'r' : hot.y !== null && hot.m >= hot.y ? 'y' : '') : '';
  const wn = Math.max(0, +x.warns || 0), wl = Array.isArray(x.wl) ? x.wl.filter(w => Array.isArray(w) && w.length >= 3) : [];
  const split = sp.n ? GX_BN.map(([k], j) => '<span><i class="b-' + k + '"></i>' + ['gpu', 'cpu', 'capped'][j] + ' <b>' + sp.pc(sp[['g', 'c', 'f'][j]]) + '%</b></span>').join('') : '';
  return '<div class="gx-s5">' +
    '<div><em>average fps</em><b>' + gxF(x.fps) + '</b><span>1% low <i>' + gxF(x.low) + '</i></span></div>' +
    (x.custom ? '<div><em>length</em><b>' + durS(x.end - x.start) + '</b><span>' + hhmm(x.start) + ' to ' + hhmm(x.end) + '</span></div>'
      : '<div><em>played</em><b>' + durTxt(gxPlay(x)) + '</b><span>' + (away >= 60 ? durTxt(x.front) + ' in front' : 'all of it in front') + '</span></div>') +
    '<div><em>hottest</em><b class="' + hl + '">' + (hot ? gxF(hot.m, 1) + '<small>' + esc(hot.u) + '</small>' : '--') + '</b><span>' + (hot ? esc(hot.main && GX_MAIN[hot.n] ? GX_MAIN[hot.n][0] : hot.n) : '') + '</span></div>' +
    '<div class="w2"><em>limited by</em>' + (sp.n ? gxNbar(sp) + '<span class="gx-split">' + split + '</span>' : '<b>--</b>') + '</div>' +
    '<div><em>warnings</em><b class="' + (wn ? 'y' : '') + '">' + wn + '</b><span>' + (wl.length ? esc(wl[0][0]) + ' ' + esc(gxF(wl[0][1], gxN(wl[0][1]) % 1 ? 1 : 0)) + ' ' + esc(wl[0][2]) : wn ? '' : 'none') + '</span></div></div>';
}
// (lazy: the chart gets a place, drawn when the session first opens)
function gxDetail(x, sp, gi, lazy, foot) {
  const items = gxItems(x), G = gxLayout(), D = gxMinutes(x);
  if (!items.length && !gxHasTl(D)) return '<div class="gx-in"><div class="gx-nil">no readings were recorded for this session</div>' + (foot || '') + '</div>';
  let h = '', grp = '';
  const flush = () => { if (grp) { h += '<div class="gx-groups">' + grp + '</div>'; grp = ''; } };
  const group = (name, rows) => '<div class="gx-grp"><div class="gx-ch">' + esc(name) + '<span>avg &nbsp; max</span></div>' + rows + '</div>';
  for (const s of G.secs) {
    if (s.hide) continue;
    if (s.kind === 'summary') { flush(); h += gxSummary(x, sp, items); }
    else if (s.kind === 'time') {
      flush(); h += !lazy ? gxTimeline(x, sp, gi) : gxHasTl(D) ? '<div class="gx-tlz" data-g="' + gi + '"></div>' : '';
      // (a session of a minute or two has a point or so: it says why there is no chart yet)
      if (!gxHasTl(D) && D.N < 2 && (D.sh.some(Boolean) || D.fv.some(v => v !== null))) h += '<div class="gx-tl"><div class="gx-ch">over time<span>per minute</span></div><div class="gx-tln">The chart starts once a session has run for 2 minutes.</div></div>';
    }
    else if (s.kind === 'list') {
      const found = s.cells.map(c => gxFind(items, c));
      if (!found.some(Boolean)) continue;   // (none of it recorded in this session: the category stays out)
      grp += group(s.name, s.cells.map((c, j) => gxItemRow(found[j], esc(gxCellName(c)), c.head ? GX_MAIN[c.head] : null)).join(''));
    }
  }
  flush();
  if (h.includes('gx-rw')) h += '<div class="gx-key"><span><i class="sw" style="background:#555"></i>average</span><span><i class="sw" style="background:#bdbdbd"></i>max</span><span><i class="tk"></i>yellow line</span><span><i class="tk r"></i>red line</span>' +
    '<span class="end">a max past a line takes its colour</span></div>';
  return '<div class="gx-in">' + h + (foot || '') + '</div>';
}
// the list drawn again (a Customize change), the sessions that were open still open
let gxText = '';
function rerenderGames() {
  if (!gmodal.classList.contains('open')) return;
  const open = [...document.querySelectorAll('#glist .gx-sess.open')].map(s => gxSs[+s.dataset.g] && gxSs[+s.dataset.g].start);
  renderGames(gxText, open);
}

// ---- Customize: the categories (order, shown or not, names) and each one's readings, like the main layout's ----
const GZ = { on: false, sel: null, q: '', t: 'all', shut: new Set(), counts: { all: 0 } };
// a change to the sessions' setup: an undo step, saved with the layout (the host follows what it tracks), Customize
// and the open sessions drawn again; the dashboard behind is left as it is (nothing it shows changed)
function gzApply(fn) {
  const before = snapOf();
  fn();
  if (snapOf() === before) return;
  pushUndo(before); saveState(); syncUndo(); syncSaves();
  if (GZ.on) renderGz(); rerenderGames();
}
function gzEdit(fn) { gzApply(() => { const was = JSON.stringify(gxLayout()), G = JSON.parse(was); fn(G); if (JSON.stringify(G) !== was) S.L.games = G; }); }   // (nothing changed: the defaults stay the defaults)
onLayout = () => { if (GZ.on) renderGz(); rerenderGames(); };
// the readings to add: Storage's list (search by sensor, label or unit, the type chips, grouped by sensor), only
// the rows in sight drawn; + puts one in the selected category, its tick takes it out again
const GZROW = 30;
let gzRows = [], gzKeys = [];
function gzCompute() {
  const toks = GZ.q.toLowerCase().split(/\s+/).filter(Boolean), counts = new Map(), hits = [];
  GZ.counts = { all: 0 };
  for (const r of READ) {
    if (r.key === BNECK || !SENS[r.s] || hidOf(r) || toks.some(t => !r.hay.includes(t))) continue;   // (the bottleneck has its own place: the summary; hidden ones as in Storage)
    GZ.counts.all++; GZ.counts[r.t] = (GZ.counts[r.t] || 0) + 1;
    if (GZ.t === 'all' || r.t === GZ.t) { hits.push(r); counts.set(r.s, (counts.get(r.s) || 0) + 1); }
  }
  gzRows = []; let cur = -1;
  for (const r of hits) {
    if (r.s !== cur) { cur = r.s; gzRows.push({ g: true, s: r.s, n: counts.get(r.s) }); }
    if (!GZ.shut.has(SENS[r.s].key)) gzRows.push({ r });
  }
}
function gzChips() {
  const el = document.querySelector('#gcz .chips'); if (!el) return;
  el.innerHTML = ['all', 'temp', 'volt', 'fan', 'power', 'current', 'clock', 'usage', 'other'].filter(t => GZ.counts[t] || t === GZ.t)
    .map(t => '<button class="chip' + (GZ.t === t ? ' on' : '') + '" data-gz="chip" data-t="' + t + '">' + (t === 'all' ? 'All' : TYPE_NAME[t]) + ' ' + (GZ.counts[t] || 0).toLocaleString('en-US') + '</button>').join('');
}
function gzDraw() {
  const vl = document.querySelector('#gcz .gz-list'), sp = vl && vl.firstElementChild; if (!sp) return;
  const s = gxLayout().secs.find(x => x.id === GZ.sel), have = new Set(s ? s.cells.map(c => c.key) : []), full = !s || s.cells.length >= GX_MAX;
  sp.style.height = gzRows.length * GZROW + 'px';
  const top = vl.scrollTop, hgt = vl.clientHeight || 300, keys = [];
  const a = Math.max(0, Math.floor(top / GZROW) - 4), b = Math.min(gzRows.length, Math.ceil((top + hgt) / GZROW) + 4);
  let h = gzRows.length ? '' : '<div class="vempty">No readings match' + (GZ.q ? ' "' + esc(GZ.q) + '"' : ' this type') + '. <button class="linkbtn" data-gz="qclear">Show all</button></div>';
  for (let i = a; i < b; i++) {
    const row = gzRows[i];
    if (row.g) {
      const sn = SENS[row.s]; if (!sn) continue;
      h += '<div class="vrow g' + (GZ.shut.has(sn.key) ? ' collapsed' : '') + '" style="top:' + i * GZROW + 'px" data-gz="tw" data-sk="' + esc(sn.key) + '"><button class="tw" title="Collapse">' + ICONS.chev + '</button><span class="gn" title="' + esc(sn.name) + '">' + esc(sn.name) + '</span><span class="gc">' + row.n + '</span></div>';
    } else {
      const r = row.r, inIt = have.has(r.key);
      keys.push(r.key);
      h += '<div class="vrow r" style="top:' + i * GZROW + 'px" data-key="' + esc(r.key) + '"><span class="ti t-' + r.t + '"></span><span class="lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="val"></span>' +
        (inIt ? '<button class="inv" data-gz="out" title="In ' + esc(s.name) + ': click to take it out">' + ICONS.check + '</button>'
          : '<button class="add" data-gz="add"' + (full ? ' disabled title="' + (s ? esc(s.name) + ' has ' + GX_MAX + ' readings, the most a category takes' : 'Add a category first') + '"' : ' title="Add to ' + esc(s.name) + '"') + '>+</button>') + '</div>';
    }
  }
  if (sp._h !== h) { sp.innerHTML = h; sp._h = h; }
  for (const el of sp.children) if (el.dataset.key) setText(el.children[2], valTxt(BYKEY.get(el.dataset.key)));
  if (keys.join('\n') !== gzKeys.join('\n')) { gzKeys = keys; subscribe(); }
}
function renderGz() {
  const box = $('gcz');
  if (!GZ.on) { box.hidden = true; box.innerHTML = ''; $('gcustom').classList.remove('on'); if (gzKeys.length) { gzKeys = []; subscribe(); } return; }
  $('gcustom').classList.add('on');
  const secs = gxLayout().secs, lists = secs.filter(s => s.kind === 'list');
  if (!lists.some(s => s.id === GZ.sel)) GZ.sel = lists.length ? lists[0].id : null;
  const info = s => s.kind === 'summary' ? 'fps, played, hottest, limited by, warnings' : s.kind === 'time' ? 'the chart, minute by minute' : plural(s.cells.length, 'reading');
  let h = '<div class="gz-head"><span>Every session\'s details, top to bottom</span><span class="sp"></span><button class="btn" data-gz="reset">Reset to the default</button><button class="btn gz-done" data-gz="done">Done</button></div><div class="gz">';
  h += '<div class="gz-secs" data-list="secs"><div class="gx-ch">categories<span>drag to move</span></div>' + secs.map((s, i) => '<div class="gz-s' + (s.id === GZ.sel ? ' on' : '') + (s.hide ? ' off' : '') + '" data-i="' + i + '" data-id="' + esc(s.id) + '"><span class="grip" title="Drag to move it"></span>' +
    (s.kind === 'list' ? '<input class="gz-name" data-gz="name" value="' + esc(s.name) + '" maxlength="40" spellcheck="false" title="Its name">' : '<span class="nm">' + esc(gxSecName(s)) + '</span>') +
    '<span class="x">' + esc(info(s)) + '</span><button class="tog2' + (s.hide ? '' : ' on') + '" data-gz="hide" title="Show it or not"></button>' +
    (s.kind === 'list' ? '<button class="ib" data-gz="del" title="Remove the category">' + ICONS.x + '</button>' : '<span class="gz-ph"></span>') + '</div>').join('') +
    '<button class="linkbtn" data-gz="addsec">+ New category</button></div>';
  const s = secs.find(x => x.id === GZ.sel);
  h += '<div class="gz-cells">';
  if (s) {
    h += '<div class="gx-ch">' + esc(s.name) + ': its readings<span>' + s.cells.length + ' of ' + GX_MAX + '</span></div><div data-list="cells">' +
      s.cells.map((c, j) => '<div class="gz-c" data-i="' + j + '"><span class="grip" title="Drag to move it"></span><input class="gz-name" data-gz="cname" value="' + esc(gxCellName(c)) + '" maxlength="40" spellcheck="false" title="Its name in the details">' +
        '<span class="x">' + esc(gxCellFrom(c)) + '</span><button class="ib" data-gz="cdel" title="Take it out">' + ICONS.x + '</button></div>').join('') + '</div>';
    if (s.cells.length >= GX_MAX) h += '<div class="gz-note">A category takes ' + GX_MAX + ' readings at most: take one out, or start a new category.</div>';
  } else h += '<div class="gz-note">Add a category (on the left) to put readings in.</div>';
  h += '<div class="gz-note">A reading you add is recorded from your next session on: the sessions before it have no value for it.</div></div>';
  h += '<div class="gz-add"><div class="gx-ch">readings<span>' + (s ? '+ adds to ' + esc(s.name) : '') + '</span></div><div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>' +
    '<input id="gzQ" type="search" placeholder="Search sensors, labels, units" autocomplete="off" spellcheck="false" value="' + esc(GZ.q) + '"></div><div class="chips"></div><div class="vlist gz-list"><div class="vspace"></div></div></div></div>';
  const ae = document.activeElement, f = ae && ae.id === 'gzQ' ? [ae.selectionStart] : null, old = box.querySelector('.gz-list'), st = old ? old.scrollTop : 0;
  box.innerHTML = h; box.hidden = false;
  const vl = box.querySelector('.gz-list'); vl.addEventListener('scroll', gzDraw);
  gzCompute(); gzChips(); gzDraw(); vl.scrollTop = st; gzDraw();
  if (f) { const q = $('gzQ'); if (q) { q.focus(); q.setSelectionRange(f[0], f[0]); } }
}
$('gcustom').onclick = () => { GZ.on = !GZ.on; GZ.q = ''; GZ.t = 'all'; renderGz(); };
$('gcz').addEventListener('click', e => {
  const b = e.target.closest('[data-gz]'), row = e.target.closest('.gz-s');
  if (!b) { if (row && !e.target.closest('input') && row.querySelector('.gz-name')) { GZ.sel = row.dataset.id; renderGz(); } return; }
  const k = b.dataset.gz, i = row ? +row.dataset.i : -1, ci = e.target.closest('.gz-c') ? +e.target.closest('.gz-c').dataset.i : -1, rk = (e.target.closest('#gcz .vrow.r') || { dataset: {} }).dataset.key;
  if (k === 'tw') { const sk = b.dataset.sk; if (GZ.shut.has(sk)) GZ.shut.delete(sk); else GZ.shut.add(sk); gzCompute(); gzDraw(); return; }
  if (k === 'chip') { GZ.t = b.dataset.t; gzCompute(); gzChips(); document.querySelector('#gcz .gz-list').scrollTop = 0; gzDraw(); return; }
  if (k === 'qclear') { GZ.q = ''; GZ.t = 'all'; renderGz(); return; }
  if (k === 'done') { GZ.on = false; renderGz(); }
  else if (k === 'reset') { GZ.sel = null; gzApply(() => { delete S.L.games; }); }
  else if (k === 'hide') gzEdit(G => { G.secs[i].hide = !G.secs[i].hide; if (!G.secs[i].hide) delete G.secs[i].hide; });
  else if (k === 'del') gzEdit(G => { G.secs.splice(i, 1); });
  else if (k === 'addsec' && gxLayout().secs.length >= 16) toast('A report has at most 16 categories');   // (what a file keeps)
  else if (k === 'addsec') { const id = nid('g'); GZ.sel = id; gzEdit(G => { G.secs.push({ id, kind: 'list', name: 'New category', cells: [] }); }); const n = document.querySelector('#gcz .gz-s.on .gz-name'); if (n) { n.focus(); n.select(); } }
  else if (k === 'add' && rk) gzEdit(G => { const s = G.secs.find(x => x.id === GZ.sel); if (s && s.cells.length < GX_MAX && !s.cells.some(c => c.key === rk)) s.cells.push({ key: rk }); });
  else if (k === 'out' && rk) gzEdit(G => { const s = G.secs.find(x => x.id === GZ.sel), j = s ? s.cells.findIndex(c => c.key === rk) : -1; if (j >= 0) s.cells.splice(j, 1); });
  else if (k === 'cdel') gzEdit(G => { G.secs.find(x => x.id === GZ.sel).cells.splice(ci, 1); });
});
$('gcz').addEventListener('change', e => {
  const t = e.target, k = t.dataset && t.dataset.gz; if (!k) return;
  const v = t.value.trim().slice(0, 40);
  if (k === 'name') { const i = +t.closest('.gz-s').dataset.i; gzEdit(G => { if (v) G.secs[i].name = v; }); const s = gxLayout().secs[i]; if (s && t.isConnected && t.value !== gxSecName(s)) t.value = gxSecName(s); }   // (left empty: its name back)
  if (k === 'cname') { const j = +t.closest('.gz-c').dataset.i; gzEdit(G => { const c = G.secs.find(x => x.id === GZ.sel).cells[j]; delete c.name; if (v && v !== gxCellName(c)) c.name = v; }); const s = gxLayout().secs.find(x => x.id === GZ.sel), c = s && s.cells[j]; if (c && t.isConnected && t.value !== gxCellName(c)) t.value = gxCellName(c); }
});
$('gcz').addEventListener('input', e => { if (e.target.id === 'gzQ') { GZ.q = e.target.value; gzCompute(); gzChips(); document.querySelector('#gcz .gz-list').scrollTop = 0; gzDraw(); } });
// (Enter in the search adds the first reading it shows that isn't in the category yet)
$('gcz').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.gz-name')) e.target.blur(); if (e.key === 'Enter' && e.target.id === 'gzQ') { const r = document.querySelector('#gcz .vrow.r .add:not([disabled])'); if (r) r.click(); } });
// a category or a reading dragged by its grip to another place in its list
$('gcz').addEventListener('pointerdown', e => {
  let g = e.target.closest('.grip'); if (!g || e.button !== 0 || !e.isPrimary) return;
  const pid = e.pointerId;   // (only this pointer moves or drops it)
  const a = document.activeElement;
  if (a && a.matches('#gcz .gz-name')) {   // (a name still being typed: applied first, its change re-renders the rows)
    const ln = g.parentNode.parentNode.dataset.list, ri = g.parentNode.dataset.i;
    a.blur();
    if (!g.isConnected) { const l2 = document.querySelector('#gcz [data-list="' + ln + '"]'), r2 = l2 && [...l2.children].find(x => x.dataset.i === ri); g = r2 && [...r2.children].find(x => x.classList.contains('grip')); if (!g) return; }
  }
  const row = g.parentNode, list = row.parentNode, rows = [...list.children].filter(x => x.dataset.i != null), from = +row.dataset.i;
  e.preventDefault(); row.classList.add('drag');
  let to = from;
  const move = ev => {
    if (ev.pointerId !== pid) return;
    if (!list.isConnected) { cancel(); return; }   // (its list was drawn again under it: no drop)
    to = rows.findIndex(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; }); if (to < 0) to = rows.length;
    for (const r of rows) r.classList.toggle('drop', +r.dataset.i === to && to !== from && to !== from + 1);
    list.classList.toggle('dropend', to === rows.length && from !== rows.length - 1);
  };
  const up = ev => {
    if (ev.pointerId !== pid) return;
    if (!list.isConnected) { cancel(); return; }
    gzDragCancel = null;
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
    row.classList.remove('drag'); for (const r of rows) r.classList.remove('drop'); list.classList.remove('dropend');
    const at = to > from ? to - 1 : to; if (at === from) return;
    gzEdit(G => { const arr = list.dataset.list === 'secs' ? G.secs : G.secs.find(x => x.id === GZ.sel).cells; arr.splice(at, 0, arr.splice(from, 1)[0]); });
  };
  const cancel = ev => {   // (a touch the browser took as a scroll, or Escape: no drop)
    if (ev && ev.pointerId !== pid) return;
    gzDragCancel = null;
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
    row.classList.remove('drag'); for (const r of rows) r.classList.remove('drop'); list.classList.remove('dropend');
  };
  gzDragCancel = () => cancel();
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
});
// a session's breaks (the game closed and started again within 5 minutes: one session) aren't play
const gxGap = x => Array.isArray(x.gaps) ? x.gaps.reduce((p, g) => p + (Array.isArray(g) && g.length >= 2 ? Math.max(0, g[1] - g[0]) : 0), 0) : 0;
const gxPlay = x => Math.max(0, x.end - x.start - gxGap(x));
// the week's numbers and strip (gsum); returns each day's count and length, for the day headers
function gxSum(ss, live) {
  // the week: today and the 6 days before, from the first bar's midnight, as the strip draws them
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push(d); }
  const now = Date.now() / 1000, week = days[0].getTime() / 1000, recent = ss.filter(x => x.start >= week && !x.custom), per = {};   // (the week's numbers are games')
  for (const x of recent) per[x.game] = (per[x.game] || 0) + gxPlay(x);
  const top = Object.keys(per).sort((a, b) => per[b] - per[a])[0];
  const total = recent.reduce((p, x) => p + gxPlay(x), 0);
  const dayKey = u => localDay(new Date(u * 1000)), byDay = {};
  for (const x of ss) { const d = byDay[dayKey(x.start)] || (byDay[dayKey(x.start)] = { n: 0, t: 0 }); d.n++; d.t += gxPlay(x); }
  // the week strip: minutes played on each of the last 7 days, today last
  let wk = '';
  const dayMins = days.map(d => { const k = localDay(d); return recent.filter(x => dayKey(x.start) === k).reduce((p, x) => p + gxPlay(x) / 60, 0); });
  const peak = Math.max(60, ...dayMins);
  days.forEach((d, i) => { const v = dayMins[i]; wk += '<span class="gx-wd' + (i === 6 ? ' today' : '') + '" title="' + (v ? durTxt(v * 60) : 'nothing') + '"><i' + (v ? '' : ' class="z"') + ' style="height:' + (v ? Math.max(3, Math.round(v / peak * 22)) : 2) + 'px"></i><em>' + GX_WD[d.getDay()][0].toUpperCase() + '</em></span>'; });
  const gs = $('gsum'), gh = ss.some(x => !x.custom) ? '<div class="gx-sum"><div class="gx-sumtxt">' +
    '<div class="gx-stat"><em>last 7 days</em><b>' + recent.length + '<small>' + (recent.length === 1 ? 'session' : 'sessions') + '</small></b></div>' +
    '<div class="gx-stat"><em>played</em><b>' + (total ? durTxt(total) : '0m') + '</b></div>' +
    (top ? '<div class="gx-stat"><em>most played</em><b>' + esc(top) + '<small>' + durTxt(per[top]) + '</small></b></div>' : '') +
    '</div><div class="gx-week">' + wk + '</div></div>' : '';
  // (written only when they changed, and the live row's updates wait while text in them is picked)
  const sl = live && getSelection(), held = sl && sl.rangeCount && !sl.isCollapsed && sl.getRangeAt(0).intersectsNode(gs);
  if (gs._h !== gh && !held) { gs.innerHTML = gh; gs._h = gh; }
  return byDay;
}
const gxDayTot = same => same.n + (same.n === 1 ? ' session, ' : ' sessions, ') + durS(same.t);
function renderGames(text, keep) {
  // a session's name being typed stays through the redraw: its value, caret and focus, on the same session's field
  const nf = document.activeElement, nx = nf && nf.matches && nf.matches('#glist .gx-nm') ? gxSs[+nf.dataset.g] : null;
  const nk = nx ? { start: nx.start, game: nx.game, v: nf.value, a: nf.selectionStart, b: nf.selectionEnd, typed: nf.value !== nx.game || !!nf._nmKeep } : null;
  if (nx) nf._nmKeep = 0;   // (the old field goes: nothing saved from it on its way out)
  gxText = text || ''; gxLoaded = true; renderRec();
  const ss = [];
  for (const line of (text || '').split(/\r?\n/)) {
    try { const x = line.trim() ? JSON.parse(line) : null; if (x && typeof x === 'object' && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start) ss.push(x); } catch (e) { }
  }
  if (gxNow && !ss.some(x => x.start === gxNow.start && x.game === gxNow.game)) ss.push(gxNow);   // (the session in progress: Now playing)
  const keepCut = feed.gameDays ? Date.now() / 1000 - feed.gameDays * 86400 : -Infinity;   // (no days set after a damaged settings file: nothing is cut)
  for (let i = ss.length - 1; i >= 0; i--) if (ss[i].end < keepCut) ss.splice(i, 1);   // (older than the days kept: going at the next trim)
  ss.sort((a, b) => b.start - a.start);
  lastGameCount = ss.filter(x => !x.live).length; gxTl.length = 0; gxSs = ss;   // (Clear's count: the log's, not the one in progress)
  const byDay = gxSum(ss), now = Date.now() / 1000, dayKey = u => localDay(new Date(u * 1000));
  const today = localDay(new Date()), yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yest = localDay(yd);
  let h = '', lastDay = null;
  ss.forEach((x, i) => {
    const dk = dayKey(x.start);
    if (dk !== lastDay) {
      lastDay = dk;
      const d = new Date(x.start * 1000), same = byDay[dk];
      const name = dk === today ? 'today' : dk === yest ? 'yesterday' : now - x.start < 6 * 86400 ? GX_WD[d.getDay()] : '';
      const date = (name && name !== 'today' && name !== 'yesterday' ? '' : GX_WD[d.getDay()].slice(0, 3) + ' ') + d.getDate() + ' ' + GX_MON[d.getMonth()];   // "thursday 8 oct", "yesterday sat 10 oct"
      h += '<div class="gx-day"><div>' + (name ? name + '<span>' + date + '</span>' : date) + '</div><div class="gx-tot">' + gxDayTot(same) + '</div></div>';
    }
    h += gxSessHtml(x, i, i === 0 && !Array.isArray(keep));
  });
  const list = $('glist');
  list.innerHTML = h ? '<div class="gx-cols"><span></span><span>session</span><span class="gx-r">length</span><span class="gx-r">fps</span><span class="gx-r">1% low</span><span>limited by</span><span class="gx-r">warnings</span></div>' + h
                     : '<div class="wempty ico pad">No sessions yet. A game shows up here while you play it, and stays once you played it for over a minute; Start session records one of your own.</div>';
  const first = list.querySelector('.gx-sess');
  if (Array.isArray(keep)) {   // (drawn again: what was open stays open, at once)
    list.classList.add('still');
    for (const el of list.querySelectorAll('.gx-sess')) { const x = gxSs[+el.dataset.g]; if (!x || !keep.includes(x.start)) continue; gxFill(el); const z = el.querySelector('.gx-tlz'); if (z) z.outerHTML = gxTimeline(x, gxSplit(x), +z.dataset.g); el.classList.add('open'); }
    requestAnimationFrame(() => requestAnimationFrame(() => list.classList.remove('still')));
  } else if (first) first.classList.add('open');   // the newest session opens with the popup
  if (nk) {
    const j = gxSs.findIndex(x => x.start === nk.start && x.game === nk.game), el = j >= 0 && list.querySelector('.gx-nm[data-g="' + j + '"]');
    if (el) {
      if (nk.typed) { el.value = nk.v; el._nmKeep = 1; }   // (a value the page put back: leaving the field saves it, no change event comes for it)
      el.focus({ preventScroll: true }); try { el.setSelectionRange(nk.a, nk.b); } catch (e) { }
    }
  }
}
// a session's row and its details (full: built now, else when it opens); the one in progress says so and goes "to now"
function gxSessHtml(x, i, full) {
    const sp = gxSplit(x), away = typeof x.front === 'number' && typeof x.secs === 'number' ? x.secs - x.front : 0, nb = Array.isArray(x.gaps) ? x.gaps.length : 0;
    const wn = Math.max(0, +x.warns || 0), wl = Array.isArray(x.wl) ? x.wl.filter(w => Array.isArray(w) && w.length >= 3) : [];
    const st = wn ? '<span class="gx-wv">' + wn + (wn === 1 ? ' warning' : ' warnings') + '</span>' + (wl.length ? '<span class="gx-sub" title="' + esc(wl.map(w => w[0] + ' ' + gxF(w[1], gxN(w[1]) % 1 ? 1 : 0) + ' ' + w[2]).join(', ')) + '">' + esc(wl[0][0]) + ' ' + esc(gxF(wl[0][1], gxN(wl[0][1]) % 1 ? 1 : 0)) + ' ' + esc(wl[0][2]) + '</span>' : '') : '<span class="gx-ok">none</span>';
    return '<div class="gx-sess' + (x.custom ? ' cust' : '') + (x.live ? ' live' : '') + '" data-g="' + i + '"><div class="gx-row">' + GX_CHEV +
         '<span class="gx-gm"><span class="gx-gn' + (x.live ? ' lv"><span class="gx-gt">' + esc(x.game) + '</span><span class="gx-now">now playing</span>' : '">' + esc(x.game)) + '</span><span class="gx-sub">' + hhmm(x.start) + ' to ' + (x.live ? 'now' : hhmm(x.end)) + (x.custom ? ', started by you' : x.from - x.start > 90 ? ', tracked from ' + hhmm(x.from) : '') + (nb ? ', ' + (nb === 1 ? '1 break' : nb + ' breaks') : '') + '</span></span>' +
         '<span class="gx-c gx-num"><span>' + durS(gxPlay(x)) + '</span>' + (x.live ? '<span class="gx-sub">so far</span>' : x.custom ? '' : away >= 60 ? '<span class="gx-sub">' + durTxt(x.front) + ' in front</span>' : '') + '</span>' +
         '<span class="gx-c gx-num gx-fps">' + gxF(x.fps) + '</span><span class="gx-c gx-num gx-lo">' + gxF(x.low) + '</span>' +
         '<span class="gx-c">' + (sp.n ? gxNbar(sp) + '<span class="gx-sub">' + sp.top[0] + ' ' + sp.top[1] + '%</span>' : '<span class="gx-sub">--</span>') + '</span>' +
         '<span class="gx-c gx-st">' + st + '</span></div>' +
         '<div class="gx-det"><div>' + (full ? gxDetail(x, sp, i, false, gxActs(x, i)) : '<div class="gx-lz" data-g="' + i + '"></div>') + '</div></div></div>';
}
// the session in progress from the host (every 5 s while the popup is open; null: none): its row drawn again in place,
// open as it was; one that came or went redraws the list
let gxNow = null;
function gxLive(s) {
  gxNow = s && typeof s === 'object' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start ? s : null;
  if (!gmodal.classList.contains('open') || !gxLoaded) return;
  const list = $('glist'), i = gxSs.findIndex(x => x.live);
  if (!gxNow) return;   // (no game, or it just ended: the log that comes with its end draws the list again)
  if (i < 0 || gxSs[i].start !== gxNow.start || gxSs[i].game !== gxNow.game) { renderGames(gxText, list.querySelector('.gx-sess') ? gxOpen() : undefined); return; }
  const el = list.querySelector('.gx-sess[data-g="' + i + '"]'); if (!el) return;
  // (the pointer on it, or text picked in it: not drawn again under the hover read-out, a click or the selection; the
  // next update after)
  const sl = getSelection(), r = gxPt && (!gxPt.touch || gxPt.down) ? el.getBoundingClientRect() : null;
  if ((r && gxPt.x >= r.left && gxPt.x < r.right && gxPt.y >= r.top && gxPt.y < r.bottom) || (sl && sl.rangeCount && !sl.isCollapsed && sl.getRangeAt(0).intersectsNode(el))) return;
  gxSs[i] = gxNow;
  const open = el.classList.contains('open'), tmp = document.createElement('div');
  tmp.innerHTML = gxSessHtml(gxNow, i, open);
  const ne = tmp.firstChild;
  if (open) { const z = ne.querySelector('.gx-tlz'); if (z) z.outerHTML = gxTimeline(gxNow, gxSplit(gxNow), i); list.classList.add('still'); ne.classList.add('open'); requestAnimationFrame(() => requestAnimationFrame(() => list.classList.remove('still'))); }
  el.replaceWith(ne);
  // (its day's total and the week's numbers follow it)
  const byDay = gxSum(gxSs, true), d = byDay[localDay(new Date(gxNow.start * 1000))];
  let hd = ne.previousElementSibling; while (hd && !hd.classList.contains('gx-day')) hd = hd.previousElementSibling;
  if (hd && d) setText(hd.querySelector('.gx-tot'), gxDayTot(d));
}
let gxSs = [];   // the sessions as listed, for the timelines drawn when they open
// a session's details, built the first time it opens (all of them up front made a big log slow and heavy)
function gxFill(sess) { const z = sess && sess.querySelector('.gx-lz'); if (!z) return; const i = +z.dataset.g, x = gxSs[i]; if (x) z.outerHTML = gxDetail(x, gxSplit(x), i, false, gxActs(x, i)); }
// under a session's details: its name (one of your own) and Delete
const gxActs = (x, i) => x.live ? '' : '<div class="gx-acts">' + (x.custom ? '<label class="gx-nmf"><em>name</em><input class="gx-nm" data-g="' + i + '" value="' + esc(x.game) + '" maxlength="60" spellcheck="false" title="Its name: type a new one, Enter to keep it"></label>' : '') +
  '<span class="sp"></span><button class="wclear gx-del" data-g="' + i + '" title="Delete this session (a copy is kept in games.log.bak)">Delete session</button></div>';
const gxOpen = () => [...document.querySelectorAll('#glist .gx-sess.open')].map(s => gxSs[+s.dataset.g] && gxSs[+s.dataset.g].start);
// a custom session's new name: saved when the field changes, or when it is left with a name a redraw put back
function gxName(el) {
  el._nmKeep = 0;
  const x = gxSs[+el.dataset.g], v = el.value.trim().slice(0, 60);
  if (x && v && v !== x.game) send({ t: 'gedit', act: 'name', start: x.start, end: x.end, game: x.game, name: v }); else if (x) el.value = x.game;
}
$('glist').addEventListener('change', e => { if (e.target.matches('.gx-nm')) gxName(e.target); });
$('glist').addEventListener('focusout', e => { if (e.target.matches('.gx-nm') && e.target._nmKeep) gxName(e.target); });
$('glist').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.gx-nm')) e.target.blur(); });
$('glist').addEventListener('click', e => {
  const d = e.target.closest('.gx-del');
  if (d) { const x = gxSs[+d.dataset.g]; if (x) askConfirm('Delete this session?', x.game + ', ' + localDay(new Date(x.start * 1000)) + ' ' + hhmm(x.start) + ' to ' + hhmm(x.end) + '. A copy goes to games.log.bak.', 'Delete', () => { const y = gxSs.find(s => s.start === x.start && s.end === x.end) || x; send({ t: 'gedit', act: 'del', start: y.start, end: y.end, game: y.game }); }); return; }
  const r = e.target.closest('.gx-row'); if (!r) return;
  gxFill(r.parentNode);
  const z = r.parentNode.querySelector('.gx-tlz'), x = z && gxSs[+z.dataset.g];
  if (x) z.outerHTML = gxTimeline(x, gxSplit(x), +z.dataset.g);
  r.parentNode.classList.toggle('open');
});
function showGame() {
  const rs = feed.rec || [];
  $('gameDot').classList.toggle('on', !!feed.game || rs.length > 0);
  $('gamesBtn').title = 'Sessions' + (feed.game ? ': ' + feed.game + ' running, ' + durTxt(Math.max(60, nowTs - feed.gameSince - (feed.gameGap || 0))) + (feed.front ? '' : ' (in the background)') : '') + (rs.length ? (feed.game ? ', ' : ': ') + 'recording ' + rs.map(x => x[1]).join(', ') : '');
  if (gmodal.classList.contains('open')) renderRec();
}

// ---------- settings ----------
const setmodal = $('setmodal');
function renderSettings() {
  // (a field being typed in keeps what was typed, and its focus)
  const fa = document.activeElement, typing = fa && fa.tagName === 'INPUT' && fa.id && $('setbody').contains(fa) ? { id: fa.id, v: fa.value, a: fa.selectionStart, b: fa.selectionEnd } : null;
  renderSettings0();
  const fi = typing && $(typing.id);
  if (fi) { if (fi.value !== typing.v) fi.dataset.dirty = '1'; fi.value = typing.v; fi.focus(); try { fi.setSelectionRange(typing.a, typing.b); } catch (e) { } }
}
function renderSettings0() {
  $('setbody').innerHTML =
    '<div class="setrow"><div>Title<small>Shown in the title bar. Empty: the name of this PC' + (feed.pc ? ' (' + esc(feed.pc) + ')' : '') + '.</small></div><input class="setin" id="sTitle" maxlength="60" spellcheck="false" placeholder="' + esc(feed.pc || 'HW Deck') + '" value="' + esc(S.title || '') + '"></div>' +
    '<div class="setrow"><div>Clock<small>The time of the last reading, next to the title.</small></div><button class="tog2' + (S.clock ? ' on' : '') + '" id="sClock" aria-pressed="' + S.clock + '" title="Show the clock"></button></div>' +
    '<div class="setrow"><div>Start with Windows<small>Opens in the tray when you sign in.</small></div><button class="tog2' + (feed.autostart ? ' on' : '') + '" id="sAuto" aria-pressed="' + feed.autostart + '" title="Start with Windows"></button></div>' +
    '<div class="setrow"><div>Animations<small>' + ({ full: 'Rolling numbers, smoothly spinning fans, gliding graphs.', minimal: 'Nothing keeps moving: numbers just change, fans stand still, graphs step. Popups and views still slide.', off: 'Nothing moves at all.' })[motionPicked()] +
      (!MOTIONS.includes(S.motion) && reducedMotion.matches ? ' (Windows asks apps for less motion.)' : '') + (motionMode() !== motionPicked() ? ' Minimal for now: a game is in front.' : '') + '</small></div><span class="seg seg3" id="sMotion">' +
      [['full', 'Full'], ['minimal', 'Minimal'], ['off', 'Off']].map(([v, t]) => '<button data-m="' + v + '" class="' + (motionPicked() === v ? 'on' : '') + '">' + t + '</button>').join('') + '</span></div>' +
    '<div class="setrow"><div>Calmer during games<small>Full animations switch to Minimal while a game is in front, and back after. Saves CPU for the game.</small></div><button class="tog2' + (S.gameCalm !== false ? ' on' : '') + '" id="sCalm" aria-pressed="' + (S.gameCalm !== false) + '" title="Minimal animations while a game is in front"></button></div>' +
    '<div class="setrow"><div>HWiNFO<small' + (feed.hwinfo ? ' class="k">' + esc(feed.hwinfo) : '>Not seen running yet') + '</small><small>The free version turns its shared memory off after 12 hours; a restart turns it back on (Windows asks for permission).</small></div><button class="btn" id="sRestart"' + (feed.fake ? ' disabled' : '') + '>Restart HWiNFO</button></div>' +
    '<div class="setrow"><div>Keep HWiNFO sharing<small>The free HWiNFO stops sharing after 12 hours. With this on, a Windows task restarts it once it has run about 11 hours, with sharing on (a few seconds without readings). So it starts by itself, HWiNFO\'s welcome screen goes off and it opens in Sensors-only mode. Windows asks for permission once.</small>' +
      (feed.keep && feed.keepNote && !feed.keepWait ? '<small class="y">' + esc(feed.keepNote) + '</small>' : '') + '</div>' +
      '<button class="tog2' + (feed.keep ? ' on' : '') + '" id="sKeep" aria-pressed="' + feed.keep + '" title="Keep HWiNFO sharing"' + (feed.fake || feed.keepBusy || feed.keepWait ? ' disabled' : '') + '></button></div>' +
    '<div class="setrow"><div>Accurate game fps<small>HWiNFO\'s fps can be another app\'s (a browser, Discord, a game\'s launcher). With this on, ' + esc(feed.brand || 'HW Deck') + ' counts the game\'s own frames (DirectX games). Windows asks for permission once, then you sign out and back in.</small>' + fpsNote() + '</div>' +
      '<button class="tog2' + (feed.fps ? ' on' : '') + '" id="sFps" aria-pressed="' + feed.fps + '" title="Accurate game fps"' + (feed.fake || feed.fpsBusy || feed.fpsWait ? ' disabled' : '') + '></button></div>' +
    (feed.updatable === false ? '' : '<div class="setrow"><div>Updates<small>' + (feed.latest ? 'HW Deck ' + esc(feed.latest) + ' is out.' : 'Asks GitHub if there is a new version when HW Deck starts, then once a day. Nothing else is sent.') + '</small></div>' +
      '<span style="display:flex;gap:10px;align-items:center">' + (feed.latest ? '<button class="btn" id="sGet">' + (feed.canUpdate ? 'Update now' : 'Get it') + '</button>' : '') + '<button class="tog2' + (feed.updates ? ' on' : '') + '" id="sUpd" aria-pressed="' + feed.updates + '" title="Check for new versions"></button></span></div>') +
    '<div class="setrow"><div>Keep sessions<small>Game sessions and your own older than this are deleted (a copy goes to games.log.bak).</small></div><span class="setdays"><input class="setin" id="sGameDays" inputmode="numeric" maxlength="4" spellcheck="false" placeholder="30" value="' + (feed.gameDays || '') + '"><i>days</i></span></div>' +
    '<div class="setrow"><div>Keep warnings<small>The warning history keeps this many days.</small></div><span class="setdays"><input class="setin" id="sWarnDays" inputmode="numeric" maxlength="4" spellcheck="false" placeholder="30" value="' + (feed.warnDays || '') + '"><i>days</i></span></div>' +
    '<div class="setrow"><div>Your files<small class="k">' + esc(feed.dataDir) + '</small><small>Layouts, slots, the logs and 7 days of history.</small></div><button class="btn" id="sData">Open</button></div>' +
    '<div class="setrow" style="display:block"><div style="margin-bottom:8px">Keys</div><div class="keys2">' +
      [['E', 'edit layout on or off'], ['1 2 3', 'Tiles, Overview, Grid'], ['Enter', 'open (or select) the cell in focus'], ['Ctrl+S', 'save to the loaded slot'], ['Ctrl+Z, Ctrl+Shift+Z', 'undo, redo'],
       ['Alt + arrows', 'move the selected cell, or swap the selected category with its neighbour'], ['Shift + Alt + arrows', 'the selected category: wider, narrower, its row taller, shorter'],
       ['R  B  S  U', 'the selected category: own row, beside the row above, stack under the left one, unstack'], ['Del', 'remove the selected cell or category'], ['Esc', 'close a popup, then select nothing']].map(k => '<span class="kbd">' + k[0] + '</span><span>' + k[1] + '</span>').join('') + '</div></div>' +
    '<div class="setrow"><div>' + (feed.brand && feed.brand !== 'HW Deck' ? esc(feed.brand) + ', built on HW Deck ' : 'HW Deck ') + esc(feed.version) + '<small>Reads HWiNFO\'s shared memory on this PC.</small></div></div>';
}
$('setBtn').onclick = () => { renderSettings(); setmodal.classList.add('open'); send({ t: 'getSettings' }); };   // (the host's answer: Start with Windows and the task as they are now)
function syncUpd() { const d = $('setDot'); d.classList.toggle('on', !!feed.latest); $('setBtn').title = feed.latest ? 'Settings (HW Deck ' + feed.latest + ' is out)' : 'Settings'; }
$('setbody').addEventListener('click', e => {
  if (e.target.closest('#sAuto')) { feed.autostart = !feed.autostart; send({ t: 'autostart', on: feed.autostart }); renderSettings(); }
  const mb = e.target.closest('#sMotion button');
  if (mb && mb.dataset.m !== S.motion) { S.motion = mb.dataset.m; applyMotion(); saveState(); renderSettings(); renderView(false); }   // the one already on too: picked by hand, it stops following Windows
  if (e.target.closest('#sRestart')) restartHwinfo();
  // (it shows what was asked while Windows asks for permission; the host's answer to it (keepDone) says how it really is)
  if (e.target.closest('#sKeep') && !feed.fake && !feed.keepBusy && !feed.keepWait) { feed.keep = !feed.keep; feed.keepWait = true; send({ t: 'keepSharing', on: feed.keep }); renderSettings(); }
  if (e.target.closest('#sFps') && !feed.fake && !feed.fpsBusy && !feed.fpsWait) { feed.fps = !feed.fps; feed.fpsWait = true; send({ t: 'gameFps', on: feed.fps }); renderSettings(); }
  if (e.target.closest('#sData')) send({ t: 'openData' });
  if (e.target.closest('#sUpd')) { feed.updates = !feed.updates; if (!feed.updates) feed.latest = null; send({ t: 'updates', on: feed.updates }); syncUpd(); renderSettings(); }
  if (e.target.closest('#sGet')) send({ t: feed.canUpdate ? 'updateNow' : 'openRelease' });
  if (e.target.closest('#sClock')) { S.clock = !S.clock; renderTitle(); saveState(); renderSettings(); }
  if (e.target.closest('#sCalm')) { S.gameCalm = S.gameCalm === false; applyMotion(); saveState(); renderSettings(); renderView(false); }
});
$('setbody').addEventListener('change', e => {
  const id = e.target.id; if (id !== 'sGameDays' && id !== 'sWarnDays') return;
  delete e.target.dataset.dirty;
  // (old 0: not set since a damaged settings file, so any number cuts something and asks first)
  const k = id === 'sGameDays' ? 'gameDays' : 'warnDays', old = feed[k] || 0, v = Math.max(1, Math.min(3650, Math.round(Number(e.target.value)) || old || 30));
  e.target.value = old || ''; if (v === old) return;
  const go = () => { feed[k] = v; const i = $(id); if (i) i.value = v; send(k === 'gameDays' ? { t: 'keep', games: v } : { t: 'keep', warns: v }); };   // (only the one changed)
  if (old && v > old) go();
  else askConfirm('Keep ' + (k === 'gameDays' ? 'sessions' : 'warnings') + ' ' + v + (v === 1 ? ' day?' : ' days?'), (k === 'gameDays' ? 'Sessions' : 'Warnings') + ' older than that are deleted now. A copy goes to ' + (k === 'gameDays' ? 'games.log.bak' : 'alerts.log.bak') + '.', 'Delete older', go);
});
// (a days value put back after Settings redrew under it: left without another key, it still counts)
$('setbody').addEventListener('focusout', e => { const t = e.target; if (t.dataset && t.dataset.dirty) setTimeout(() => { if (t.dataset.dirty) { delete t.dataset.dirty; t.dispatchEvent(new Event('change', { bubbles: true })); } }, 0); });
$('setbody').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.target.id === 'sGameDays' || e.target.id === 'sWarnDays')) { e.preventDefault(); const t = e.target; setTimeout(() => t.blur(), 0); } });   // (later: the same Enter pressed Cancel on the question it opened)
$('setbody').addEventListener('input', e => {
  if (e.target.id !== 'sTitle') return;
  S.title = e.target.value.trim() ? e.target.value.slice(0, 60) : undefined; renderTitle(); saveState();
});
$('bannerBtn').onclick = () => restartHwinfo();
// Restart HWiNFO (the button by the views, the banner, the setup screen, Settings): the host restarts it as admin after
// checking it is signed by its maker; the button turns until the host says how it went (the result is a toast)
let restartT = 0;
function restartHwinfo() {
  const b = $('rstBtn');
  if (feed.fake || b.classList.contains('spin')) { if (feed.fake) toast('Demo data: there is no HWiNFO to restart'); return; }
  send({ t: 'restartHwinfo' });
  b.classList.add('spin'); b.disabled = true; b.title = 'Restarting HWiNFO...';
  clearTimeout(restartT); restartT = setTimeout(restartDone, 70000);   // the host gives up after a minute
}
function restartDone() {
  clearTimeout(restartT);
  const b = $('rstBtn'); b.classList.remove('spin'); b.disabled = feed.fake; b.title = 'Restart HWiNFO (turns its shared memory back on)';
}
$('rstBtn').onclick = restartHwinfo;

// ---------- toast ----------
let toastT = 0, toastDepth = -1;
function toast(msg, withUndo, ms) {
  setText($('toastTxt'), msg); $('toastUndo').hidden = !withUndo;
  toastDepth = withUndo ? undoSeq : -1;
  const t = $('toast'); t.classList.add('show'); clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove('show'); $('toastUndo').hidden = true; toastDepth = -1; }, ms || (withUndo ? 8000 : msg.length > 60 ? 5000 : 2600));
}
// another change after the toast: its Undo would undo that one instead, so it goes
function toastStale() { if (toastDepth >= 0 && undoSeq !== toastDepth) retireToastUndo(); }
function retireToastUndo() { $('toastUndo').hidden = true; toastDepth = -1; }

// ---------- keys ----------
// a curve point or a Customize row held: keys wait (Escape lets go), before any field's own handler gets them
document.addEventListener('keydown', ev => {
  if (!dragPt && !gzDragCancel) return;
  if (ev.key === 'Escape') { if (dragPt) ptCancel(); else gzDragCancel(); }
  ev.preventDefault(); ev.stopPropagation();
}, true);
document.addEventListener('keydown', ev => {
  if (drag && drag.started) { if (ev.key === 'Escape') { cancelPid = drag.pid; endDrag(true); editPress = null; } ev.preventDefault(); return; }   // nothing else mid-drag
  if (rs) {
    if (ev.key === 'Escape') { cancelPid = rs.pid; endHandle(true); }
    else if (ev.key === 'Alt' && rs.kind === 'corner' && rs.last) moveCorner(Object.assign({ altKey: true }, rs.last));   // Alt: any size, at once
    ev.preventDefault(); return;
  }
  // fields that take typing (a checkbox doesn't; a select takes letters and digits for its options)
  const typing = ev.target.closest && ev.target.closest('textarea, select, input:not([type=checkbox]):not([type=radio])');
  const ctrl = ev.ctrlKey || ev.metaKey, k = (ev.key || '').toLowerCase();
  // (a name or a size still being typed goes in first: those apply when the field is left)
  if (ctrl && k === 's') { ev.preventDefault(); if (cmodal.classList.contains('open')) return; if (nudge) flushNudge(); const a = document.activeElement; if (a && a.matches && a.matches('#lName, #insp input[data-sz], #insp input[data-csz], #gcz .gz-name, #cTab input')) { a.blur(); if (a.isConnected && !a.closest('#cTab')) a.focus(); } setTimeout(() => { if (!cmodal.classList.contains('open')) onSave(); }, 0); return; }   // (a layout field still being typed: left and taken back, which applies it if it changed)
  if (ev.key === 'Escape') {
    if (drag) { cancelPid = drag.pid; endDrag(true); editPress = null; return; }   // (a held press let go: its release does nothing)
    if (cmodal.classList.contains('open')) { closeConfirm(); return; }
    if (smenu) { closeSmenu(); return; }
    if (modalCid) { closeDetail(); return; }
    for (const id of ['wmodal', 'gmodal', 'smodal', 'setmodal']) if ($(id).classList.contains('open')) { $(id).classList.remove('open'); return; }
    if (relinkFor) { endRelink(); renderView(false); }
    else if (S.edit && !typing) {   // Esc: nothing selected, and the drawers that aren't pinned tuck away (even under the pointer)
      for (const d of [DR.L, DR.R]) { clearTimeout(d.t); d.hover = false; d.byPick = false; }
      if (sel || selCat) clearSel(); else syncDrawers();
    }
    return;
  }
  if (typing && !(ctrl && ev.key.startsWith('Arrow') && ev.target.dataset && ev.target.dataset.sz)) return;
  if (ctrl && (k === 'z' || k === 'y')) { ev.preventDefault(); if (cmodal.classList.contains('open')) return; k === 'y' || ev.shiftKey ? redo() : undo(); return; }
  if (ctrl && S.edit && sel && S.screen === 'tiles' && !preview && !anyModalOpen() && ev.key.startsWith('Arrow')) {
    ev.preventDefault();
    nudgeSize(sel, ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0, ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0, ev.shiftKey);
    return;
  }
  if (anyModalOpen() || ctrl) return;
  const dc = ev.target.matches && ev.target.matches('#view .dc') ? ev.target : null;
  if (dc && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); if (S.edit) selectCell(dc.dataset.cid); else openDetail(dc.dataset.cid); return; }
  const dh = S.edit && ev.target.matches && ev.target.matches('#view .dch') ? ev.target : null;
  if (dh && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); selectCat(dh.closest('.dcat').dataset.cat); return; }
  if (ev.key === 'e' || ev.key === 'E') { setEdit(!S.edit); return; }
  if (!ev.altKey && ['1', '2', '3'].includes(ev.key)) { requestScreen(['tiles', 'overview', 'grid'][+ev.key - 1]); return; }
  if (S.edit && selCat && !sel && preview) { preview = null; renderView(false); }   // keys act on yours, not on a template being previewed
  if (S.edit && selCat && !sel) {   // a selected category: arrows with Alt move it, with Shift+Alt size it, R B S U place it
    const id = selCat, k = ev.key, dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
    if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); removeCat(id); return; }
    if (k === 'F2') { ev.preventDefault(); renameCat(document.querySelector('#view .dcat[data-cat="' + id + '"]')); return; }
    if ((dx || dy) && ev.altKey && ev.shiftKey && S.screen !== 'grid') {
      ev.preventDefault();
      keyLayout(() => {
        if (dx) nudgeWidth(id, dx);
        else if (S.screen === 'tiles') setRowHeight(id, dy > 0 ? 1 : 0);
      });
      focusCat(id); return;
    }
    if ((dx || dy) && ev.altKey) { ev.preventDefault(); const o = nearestCat(id, dx, dy); if (o) keyLayout(() => swapCats(id, o)); focusCat(id); return; }
    const how = !ev.altKey && S.screen !== 'grid' ? { r: 'row', b: 'beside', s: 'stack', u: 'unstack' }[k.toLowerCase()] : null;
    if (how) { ev.preventDefault(); moveCat(id, how); focusCat(id); return; }
    return;
  }
  if (!S.edit || !sel) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeCell(sel); return; }
  if (ev.altKey && ev.key.startsWith('Arrow')) {
    ev.preventDefault();
    const cat = catOf(sel), ci = S.L.cats.indexOf(cat), id = sel, lead = catLook(cat.id).lead;
    const back = ev.key === 'ArrowLeft' || (S.screen !== 'tiles' && ev.key === 'ArrowUp'), fwd = ev.key === 'ArrowRight' || (S.screen !== 'tiles' && ev.key === 'ArrowDown');
    // within the category it moves among the others as drawn; the lead (drawn first) keeps its place
    const leadAt = lead && lead !== id ? cat.cells.indexOf(lead) : -1, rest = cat.cells.filter(x => x !== lead || x === id), i = rest.indexOf(id);
    mutate(() => {
      if (id !== lead && back && i > 0) { rest.splice(i, 1); rest.splice(i - 1, 0, id); if (leadAt >= 0) rest.splice(leadAt, 0, lead); cat.cells = rest; }
      else if (id !== lead && fwd && i < rest.length - 1) { rest.splice(i, 1); rest.splice(i + 1, 0, id); if (leadAt >= 0) rest.splice(leadAt, 0, lead); cat.cells = rest; }
      else if ((ev.key === 'ArrowUp' || back) && ci > 0) { cat.cells.splice(cat.cells.indexOf(id), 1); S.L.cats[ci - 1].cells.push(id); S.L.cats[ci - 1].collapsed = false; }
      else if ((ev.key === 'ArrowDown' || fwd) && ci < S.L.cats.length - 1) { cat.cells.splice(cat.cells.indexOf(id), 1); S.L.cats[ci + 1].cells.unshift(id); S.L.cats[ci + 1].collapsed = false; }
    });
    const el = document.querySelector('#view .dc[data-cid="' + id + '"]'); if (el) el.focus();
  }
});
document.addEventListener('keyup', ev => { if (ev.key === 'Alt' && rs && rs.kind === 'corner' && rs.last) { ev.preventDefault(); moveCorner(Object.assign({ altKey: false }, rs.last)); } });
window.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });   // the fit owns the scale

// ---------- window chrome: the title bar is the caption, the edges resize ----------
$('wmin').onclick = () => send({ t: 'win', a: 'min' });
$('wmax').onclick = () => send({ t: 'win', a: 'max' });
$('wclose').onclick = () => send({ t: 'win', a: 'close' });
const EDGE = 6;
function edgeZone(x, y) {
  if (feed.winMax) return null;   // (maximized: nothing to resize, the top edge drags the title bar)
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
// Accurate game fps: how it stands, under its text (nothing while it is off)
const fpsNote = () => !feed.fps || feed.fpsWait ? '' : '<small class="' + (feed.fpsState === 'on' ? '' : 'y') + '">' + ({ on: 'On: ' + esc(feed.brand || 'HW Deck') + ' counts the game\'s own frames.', signin: 'Almost: sign out of Windows and back in to finish.',
  denied: 'Windows doesn\'t let this account count frames: turn this off and on to ask again.', failed: 'Couldn\'t start counting frames.' }[feed.fpsState] || '') + '</small>';
const keepTip = () => feed.keep ? '' : ' Keep HWiNFO sharing in Settings restarts it before that happens.';
function showFeed() {
  const dot = $('dot'), ban = $('banner'), was = ban.hidden;
  app.classList.toggle('noreadings', !READ.length && !feed.fake);
  if (feed.fake) { dot.className = 'dot fake'; dot.title = 'Demo data: ' + hwCount().toLocaleString('en-US') + ' made-up readings'; ban.hidden = true; }
  else if (feed.status === 'ok') { dot.className = 'dot ok'; dot.title = 'HWiNFO: ' + hwCount().toLocaleString('en-US') + ' readings, polled ' + (feed.age < 2 ? 'just now' : feed.age + ' s ago'); ban.hidden = true; }
  else {
    dot.className = 'dot bad';
    dot.title = feed.status === 'stale' ? 'HWiNFO stopped updating' : 'HWiNFO not found';
    ban.hidden = !feed.got || (!READ.length && !S.L.cats.length);   // the setup screen says it all when there is nothing yet
    setText($('bannerTxt'), feed.status === 'stale' ? 'HWiNFO stopped updating its shared memory ' + agoTxt(feed.age) + '.' + (feed.age >= 60 ? ' The free version does this after 12 hours: Restart HWiNFO turns it back on.' + keepTip() : '')
      : READ.length ? 'HWiNFO stopped sharing. Restart HWiNFO turns sharing back on; the values come back by themselves.' + keepTip()
      : 'HWiNFO isn\'t sharing its readings. Restart HWiNFO turns sharing back on. Never set it up? In HWiNFO: Config, Main Settings, tick Shared Memory Support.');
  }
  if (ban.hidden !== was) { clearTimeout(fitTimer); fitTimer = setTimeout(refit, 30); }   // the banner takes room: fit again
}
function onHost(m) {
  if (m.t === 'state') {
    feed.fake = !!m.fake; feed.dataDir = m.dataDir || ''; feed.version = m.version || ''; feed.nonClient = m.nonClient !== false; feed.pc = typeof m.pc === 'string' ? m.pc : '';
    feed.brand = typeof m.brand === 'string' && m.brand ? m.brand : 'HW Deck'; feed.updatable = m.updatable !== false; document.title = feed.brand;
    // a build with extras: its cell kinds come with extras.js, the view is drawn again once they are in
    // (a build's extras.js comes after the first drawing: its cells' bodies, a bar or a switch, change their tiles'
    // heights, so those are measured again and a size that fit without them is not the one to start from)
    feed.ext = !!m.ext;
    if (m.ext && !EXT.loaded) { EXT.loaded = true; const sc = document.createElement('script'); sc.src = 'extras.js'; sc.onload = () => { EXT.ready = true; packMemo.clear(); renderView(false); renderStorage(); renderInsp(); bootCheck(); }; document.head.appendChild(sc); }
    S.slots = (m.slots || []).slice(0, 5).map(cleanSlot);
    stateGen = Number.isFinite(m.gen) ? m.gen : 0;
    heldSlots = new Set(Array.isArray(m.held) ? m.held : []);
    while (S.slots.length < 5) S.slots.push(null);
    const st = m.state;
    // (a slot another program held at the start comes in later: the view is linked to it again then, see 'slots'; a
    // missing or damaged one never comes, so only a held one waits)
    slotWanted = st && Number.isInteger(st.active) && st.active >= 0 && st.active < 5 && !S.slots[st.active] && Array.isArray(m.held) && m.held.includes(st.active) ? st.active : null;
    if (st && st.L && Array.isArray(st.L.cats)) { S.L = cleanLayout(st.L); S.active = Number.isInteger(st.active) && st.active >= 0 && st.active < 5 && S.slots[st.active] ? st.active : null; S.edit = st.edit !== false; S.screen = ['tiles', 'overview', 'grid'].includes(st.screen) ? st.screen : 'tiles'; S.motion = st.motion === false ? 'off' : st.motion === 'reduced' ? 'full' : MOTIONS.includes(st.motion) ? st.motion : undefined; }
    else { S.L = emptyLayout(); S.active = null; S.edit = true; S.screen = 'tiles'; }   // first run: nothing, edit mode on
    S.gameCalm = !st || st.gameCalm !== false;
    applyMotion();
    if (st && Array.isArray(st.pins)) { DR.L.pinned = st.pins[0] === true; DR.R.pinned = st.pins[1] === true; }
    S.title = st && typeof st.title === 'string' && st.title.trim() ? st.title.slice(0, 60) : undefined; S.clock = !st || st.clock !== false;
    S.hide = cleanHide(st && st.hide); hideSets();
    renderTitle(); $('rstBtn').disabled = feed.fake; if (feed.fake) $('rstBtn').title = 'Demo data: there is no HWiNFO to restart';
    undoStack = []; redoStack = []; keyStep.t = 0; sel = null; selCat = null; preview = null; if (dragPt) dragPt.before = null;   // (a point held takes no step from the view it was in)
    app.classList.toggle('editing', S.edit); $('editBtn').classList.toggle('on', S.edit);
    for (const b of document.querySelectorAll('#screens button[data-s]')) b.classList.toggle('active', b.dataset.s === S.screen);
    placeTabInd(true);
    lastSub = ''; subscribe(); enterNext = true; renderView(false); renderStorage(); renderInsp(); syncUndo(); syncSaves();
  } else if (m.t === 'settings') {
    feed.autostart = !!m.autostart; feed.hwinfo = m.hwinfo || null; feed.keepBusy = !!m.keepBusy; if (m.keepDone) feed.keepWait = false; if (!feed.keepBusy && !feed.keepWait) feed.keep = !!m.keep; feed.keepNote = typeof m.keepNote === 'string' ? m.keepNote : '';
    feed.fpsBusy = !!m.fpsBusy; if (m.fpsDone) feed.fpsWait = false; if (!feed.fpsBusy && !feed.fpsWait) feed.fps = !!m.fps; feed.fpsState = typeof m.fpsState === 'string' ? m.fpsState : 'off'; feed.updates = m.updates !== false; feed.latest = m.latest || null; feed.canUpdate = !!m.canUpdate; syncUpd();
    feed.gameDays = m.gameDays || 0; feed.warnDays = m.warnDays || 0;   // (0: not set since a damaged settings file, nothing cut)
    if ($('wmodal').classList.contains('open')) send({ t: 'alerts' });
    if (setmodal.classList.contains('open')) renderSettings();
  } else if (m.t === 'catalog') {
    const sameKeys = READ.length === m.readings.length && m.readings.every((x, i) => READ[i].key === x[2]);
    setCatalog(m);
    feed.bnIn = Array.isArray(m.bneck) ? m.bneck : [null, null, 0];
    feed.c12keys = Array.isArray(m.c12) && m.c12.length === 2 ? m.c12 : null;
    feed.zero = new Set(Array.isArray(m.zero) ? m.zero : []);   // (HWiNFO readings only ever at 0: hidden from Storage by default)
    lastSub = ''; subscribe();
    // the same readings with new names (a rename in HWiNFO): no rebuild under someone typing in a field
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#insp input, #insp select, #insp textarea, .cn-in');
    if (sameKeys && typing) { for (const [cid, r] of E) { const c = S.L.cells[cid], n = r.root.querySelector('.tn > span, .nm > span, .gname > span'); if (c && n) setText(n, nameIn(cid)); } renderStorage(); }
    else { renderView(false); renderStorage(); renderInsp(); }
    if (GZ.on) { if (document.activeElement && document.activeElement.matches('#gcz .gz-name')) { gzCompute(); gzChips(); gzDraw(); } else renderGz(); }   // (a name being typed stays: only the readings list is new)
    showFeed();
    boot.cat = true; bootCheck();
  } else if (m.t === 'spark') {
    for (const k in m.keys) ringFill(k, m.ts, m.keys[k]);
    if (m.ts - nowTs > 2) { if (lastTick && m.ts - lastTick > 2) resetSeen(); nowTs = m.ts; }   // (only after a gap, a show from the tray: else the second moves at its tick, with its values)
    if (curveWait && m.keys[curveWait.src]) {
      const c = S.L.cells[curveWait.cid], s2 = series(curveWait.src, 30).filter(x => isFinite(x)), src = BYKEY.get(curveWait.src);
      if (c && c.curve && c.curve.src === curveWait.src && s2.length) { c.curve.pts = startCurve(BYKEY.get(c.key), { v: s2[s2.length - 1], unit: src ? src.unit : '' }); saveState(); if (sel === curveWait.cid) renderInsp(); }
      curveWait = null;
    }
    updateView(true, true);   // (the second is judged at its tick, as the host does)
  } else if (m.t === 'tick') {
    const was = feed.status, first = !feed.got;
    const calmWas = motionMode();
    feed.status = m.status; feed.age = m.age; feed.got = true; feed.game = m.game; feed.front = m.front; feed.gameSince = m.gameSince; feed.pm = !!m.pm;
    if (motionMode() !== calmWas) { applyMotion(); if (setmodal.classList.contains('open')) renderSettings(); if (!first) redrawView(); }   // a game came to the front or left it
    feed.c12 = Array.isArray(m.c12) ? m.c12 : null;
    feed.gameGap = Number.isFinite(m.gameGap) ? m.gameGap : 0;   // (the session's breaks: not play)
    feed.gs = m.gs && typeof m.gs === 'object' ? m.gs : null;   // this game session's min, average, max of the game's own readings
    feed.bnl = m.bnl;   // the bottleneck's call this second, game or not
    feed.rec = Array.isArray(m.rec) ? m.rec.filter(x => Array.isArray(x) && x.length >= 2) : [];   // your own sessions running: [start, name]
    if (lastTick && m.ts - lastTick > 2) resetSeen();   // seconds we didn't see (hidden): holds and episodes start again
    // as the log: HWiNFO not sharing for 10 s ends every hold and episode (its Mark); a shorter stall's seconds don't
    // count as calm ones (the log counts calm seconds, the page their times: moved on by the stall)
    if (m.status !== 'ok') { if (!notOkAt) notOkAt = m.ts; if (!notOkMarked && m.ts - notOkAt >= 10) { notOkMarked = true; for (const k in holdSince) delete holdSince[k]; for (const k in cellEp) delete cellEp[k]; c12Since = 0; c12Ep.on = false; c12Ep.calm = 0; } }
    else if (notOkAt) { const gap = m.ts - notOkAt; for (const k in cellEp) if (cellEp[k].calmTs) cellEp[k].calmTs += gap; if (c12Ep.calm) c12Ep.calm += gap; notOkAt = 0; notOkMarked = false; }
    const sameSec = m.ts === lastTick;   // (a forced tick repeats the second: drawn, not judged again, as on the host)
    nowTs = lastTick = m.ts;
    if (!sameSec) stepPins();
    if (S.clock) setText($('clock'), hhmmss(m.ts));
    for (let j = 0; j < m.i.length; j++) { const r = READ[m.i[j]]; if (!r) continue; r.v = m.v[j]; r.at = m.ts; if (m.mn[j] != null) { r.mn = m.mn[j]; r.mx = m.mx[j]; r.av = m.av[j]; } }
    const live = m.status === 'ok';
    for (const k of cellKeys()) { const r = BYKEY.get(k); ringPut(k, m.ts, live && r ? r.v : null); }
    showFeed(); showGame();
    if ((first || was !== m.status) && (!READ.length || !S.L.cats.length)) renderView(false);
    if (!drag || !drag.started) { updateView(false, sameSec); tickInsp(); if (!dragPt && drawerOpen('L')) drawRows(); }
    if (!sameSec) judgeRest(!drag || !drag.started);   // (the cells not drawn, or all of them under a drag: judged each second as the host does)
    if (GZ.on && gmodal.classList.contains('open')) gzDraw();
    if (!boot.tick) { boot.tick = true; if (m.status !== 'ok') boot.cat = boot.x = true; bootCheck(m.status !== 'ok' && !READ.length); }   // (no HWiNFO: nothing more to wait for)
    if (modalCid) { refreshModal(); if (bigRange !== '15m' && Date.now() - histAsked > 60000) askHist(); }
    if (HP.shown) { if (anyModalOpen() || !S.L.cells[HP.cid]) hidePrev(); else { fillPrev(); if (!HP.rev0) drawPrev(); } }
  } else if (m.t === 'hist') {
    const again = bigHist && bigHist.key === m.key && bigHist.range === m.range;   // (the same graph a minute on: no new draw-in, one under way goes on)
    bigHist = m;
    if (modalCid && histReady()) { if (!again) bigRev0 = motionOn() ? performance.now() : 0; refreshModal(); if (bigRev0 && !again) bigLoop(); }
  } else if (m.t === 'alerts') { if (wmodal.classList.contains('open')) renderWarnings(m.log); }   // (one that comes in after a close isn't drawn)
  else if (m.t === 'games') { if (gmodal.classList.contains('open')) renderGames(m.log, $('glist').querySelector('.gx-sess') ? gxOpen() : undefined); }   // (an edit: what was open stays open; one after a close isn't kept)
  else if (m.t === 'toast') toast(m.text, false, m.ms);
  else if (m.t === 'saveView') saveState();
  else if (m.t === 'gameNow') gxLive(m.s);
  else if (m.t === 'winMax') feed.winMax = !!m.max;   // (the view's file was set aside: the one shown is written)
  else if (m.t === 'zero') { feed.zero = new Set(Array.isArray(m.keys) ? m.keys : []); renderStorage(); if (GZ.on) { gzCompute(); gzChips(); gzDraw(); } }
  // the window just came up (from the tray, a cold start, or minimized): what was measured while it was hidden came
  // out short (a Smart Life tile without its bar), so every tile is measured again on screen
  else if (m.t === 'shown') { if (drawnHidden) { drawnHidden = false; requestAnimationFrame(() => remeasureSoon(0)); } }
  else if (m.t === 'restarted') restartDone();
  else if (typeof m.t === 'string' && m.t.startsWith('x.')) {
    if (EXT.msg) EXT.msg(m);
    // the first of each of a build's own messages fills its cells' bodies (a bar, a switch): their tiles are measured
    // again, or a cold start keeps the heights they had empty
    if (!xSeen.has(m.t)) { xSeen.add(m.t); remeasureSoon(); }
    if (!boot.x) { boot.x = true; bootCheck(); }
  }
  else if (m.t === 'slots') {   // (slots that another program held at the start, free now: the view stays as it is)
    const sent = Object.keys(m.slots || {}).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < 5);
    const sl = S.slots.slice(); for (const i of sent) sl[i] = cleanSlot(m.slots[i]);   // (only the ones sent)
    // (the loaded slot back other than the page had it, a save the host refused: the view is no longer that slot, so
    // Ctrl+S can't go over a layout never seen)
    // (and every undo step linked to a slot that came back different: an undo can't link the view back to it either)
    const same = (a, b) => !!a && !!b && a.name === b.name && layoutSig(cleanLayout(a.layout)) === layoutSig(b.layout);   // (b was cleaned as it came in)
    const changed = new Set(); for (const i of sent) if (S.slots[i] && !same(S.slots[i], sl[i])) changed.add(i);
    if (changed.size) {
      const unslot = js => { const o = JSON.parse(js); if (!changed.has(o.active)) return js; o.active = null; return JSON.stringify(o); };
      undoStack = undoStack.map(unslot); redoStack = redoStack.map(unslot); if (dragPt && dragPt.before) dragPt.before = unslot(dragPt.before);
      if (changed.has(S.active)) { S.active = null; saveState(); }
    }
    for (const k of sent) heldSlots.delete(k);
    S.slots = sl;
    if (slotWanted != null && sent.includes(slotWanted) && sl[slotWanted] && S.active == null) {   // (the slot the view was linked to, held at the start)
      // (its undo steps since the start are that view's too: no Load, Clear, Save or Import came between, or slotWanted would be gone)
      const w = slotWanted, relink = js => { const o = JSON.parse(js); if (o.active != null) return js; o.active = w; return JSON.stringify(o); };
      undoStack = undoStack.map(relink); redoStack = redoStack.map(relink); if (dragPt && dragPt.before) dragPt.before = relink(dragPt.before);
      S.active = w; saveState();
    }
    if (slotWanted != null && sent.includes(slotWanted)) slotWanted = null;
    syncSaves(); renderSaves();
  }
  else if (m.t === 'imported') {
    const d = cleanSlot(m.data && typeof m.data === 'object' && m.data.hwdeck && m.data.slot ? m.data.slot : m.data), i = m.slot;   // (the app's file, or a bare slot)
    if (!d || !(i >= 0 && i < 5)) { toast('That file is not an HW Deck layout'); return; }
    if (!d.name) d.name = 'Imported';
    S.slots[i] = d; saveSlot(i); if (slotWanted === i) slotWanted = null;
    if (S.active === i) { S.active = null; saveState(); }   // (the view is no longer what that slot holds: Ctrl+S won't put it over the import)
    // (nor can an undo step make the view that slot again)
    const unslot = js => { const o = JSON.parse(js); if (o.active !== i) return js; o.active = null; return JSON.stringify(o); };
    undoStack = undoStack.map(unslot); redoStack = redoStack.map(unslot); if (dragPt && dragPt.before) dragPt.before = unslot(dragPt.before);
    syncSaves(); renderSaves();
    toast('Imported into slot ' + (m.slot + 1) + ': load it to use it');
  }
}
if (host) { app.classList.add('boot'); bootArm(); host.addEventListener('message', e => onHost(e.data)); send({ t: 'ready' }); }
else { feed.got = true; renderView(true); renderInsp(); syncUndo(); showFeed(); }   // opened outside the app: the empty first-run view
document.fonts && document.fonts.ready.then(() => placeTabInd(true));
