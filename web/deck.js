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
// hover texts: always the page's own tips (see "tooltips" below), never Windows' (11-02: a title Windows got to first,
// one on a parent, or one on a row drawn again under a still pointer showed its own). So a title never stays a title:
// el.title reads and writes data-tip, and a title in new html, or set as an attribute, is moved to data-tip before
// anything can show it (a MutationObserver runs before the next input and the next frame)
// (and a control with no text of its own, an icon button, a switch, a field, keeps the hint as its name for a screen
// reader: moved away, it was read as just "button", 11-06. One given its own aria-label keeps that)
const tipName = (el, t) => { if (el.textContent.trim() || (el.hasAttribute('aria-label') && !el._tipLab)) return; if (t) { el.setAttribute('aria-label', t); el._tipLab = true; } else if (el._tipLab) { el.removeAttribute('aria-label'); el._tipLab = false; } };
Object.defineProperty(HTMLElement.prototype, 'title', { configurable: true,
  get() { return this.getAttribute('data-tip') || ''; },
  set(v) { const s = v == null ? '' : String(v); if (s) this.setAttribute('data-tip', s); else this.removeAttribute('data-tip'); tipName(this, s); } });
const untitle = el => { const t = el.getAttribute('title'); el.removeAttribute('title'); if (t) el.setAttribute('data-tip', t); else el.removeAttribute('data-tip'); tipName(el, t); };
for (const el of document.querySelectorAll('[title]')) untitle(el);
new MutationObserver(ms => {
  for (const m of ms) {
    if (m.type === 'attributes') { if (m.target.hasAttribute('title')) untitle(m.target); continue; }
    for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.hasAttribute('title')) untitle(n); if (n.firstElementChild) for (const x of n.querySelectorAll('[title]')) untitle(x); }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
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
const xBody = (cid, r, where) => { const xk = xkOf(r), h = xk && xk.body ? xk.body(cid, r, where) : null; return h != null ? '<div class="xb" data-x="1">' + h + '</div>' : null; };   // (null for a view: the cell's own graph there)
// a control in a cell's own body (an extra's button, a field, a link): a click there is the control's; anywhere else in
// the body (the pins' bars, a strip) it opens the cell as anywhere on it
const inCtl = t => !!(t && t.closest && t.closest('[data-x] button, [data-x] input, [data-x] select, [data-x] textarea, [data-x] a, [data-x] [role=button]'));
// HW Deck's own 12V-2x6 connector (a GPU that reports its pins): its most loaded pin as the value, with lines like any
// cell (9.2 / 9.5 A to start with), the pins as bars and the pin table in its popup coloured by those lines, and yellow
// when a pin carries 1.5x its share for 3 s (the host keeps that in the warning log too)
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
// a pin's colour by its cell's own lines, as the cell's: 'r' past red, 'y' past yellow, '' under them or with no lines
// the pins' colour: the tile's own graph colour (its category's under Spectrum, the graphs' grey otherwise; his 11-09)
const pinCol = (cid, e) => e && (e.col === 'grey' || e.col === 'past') ? sparkColor(e, false) : cellTint(cid) || '#7c7c7c';   // (a dimmed tile's pins dim with its graph, 11-09)
const pinLvl = (v, cid) => { const c = S.L.cells[cid], gl = gateLines(c && c.gates); return v == null || gl.below ? '' : gl.r !== undefined && v >= gl.r ? 'r' : gl.y !== undefined && v >= gl.y ? 'y' : ''; };
EXT.kinds['12v'] = {
  body: () => '<span class="xpins">' + '<i><b></b></i>'.repeat(Math.max(1, feed.c12keys ? feed.c12keys[0].length : 6)) + '</span>',
  update(root, rd, e, cid) {
    const a = pinVals(0);
    root.querySelectorAll('.xb .xpins b').forEach((b, i) => { const v = a[i]; b.style.height = (v == null ? 0 : Math.min(100, v / 9.5 * 100)) + '%'; b.className = pinLvl(v, cid); });
    const sp = root.querySelector('.xb .xpins'), pc = pinCol(cid, e); if (sp && sp._pc !== pc) { sp._pc = pc; sp.style.setProperty('--pc', pc); }   // (the tile's own graph colour, 11-09)
  },
  after(out) {
    if (feed.status !== 'ok') return;   // (a stalled feed judges nothing: the cell stays grey)
    const c = feed.c12, a = pinVals(0), hot = c ? c[1] : -1;   // (the pin rule itself steps once a second: stepPins)
    if (out.lvl && hot >= 0 && a[hot] != null) out.sub = 'pin ' + (hot + 1) + ' at ' + fmt(a[hot], 1) + ' A';
    else if (c12Ep.on) { out.lvl = Math.max(out.lvl, 1); out.col = out.lvl === 2 ? 'red' : 'yellow'; out.warm = 0; out.sub = c12Ep.words; }
  },
  desc: () => 'The GPU\'s 12V-2x6 power connector, by its pins: the value is the most loaded one. A pin is rated 9.5 A, and a healthy connector at a 600 W limit peaks near 9.1 A. A pin carrying 1.5x its share of the load, from 15 A up, is the early sign of a bad contact: the cell turns yellow and the warning history keeps it.',
  detail(box, cid, r, e, full) {
    if (full || !box.querySelector('.mpinwrap')) box.innerHTML = '<div class="msec">the pins</div><div class="mpinwrap"></div>';
    const a = pinVals(0), w = pinVals(1);
    let h = '';
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      h += '<div class="mpin"><span class="lbl">pin ' + (i + 1) + '</span><span class="trk"><span style="width:' + (v == null ? 0 : Math.min(100, v / 9.5 * 100)) + '%;background:' +
        ({ r: COLORS.red, y: COLORS.yellow }[pinLvl(v, cid)] || pinCol(cid, e)) + '"></span></span><span class="num">' + (v == null ? '--' : v.toFixed(2)) + ' A</span><span class="num">' + (w[i] == null ? '--' : w[i].toFixed(1)) + ' W</span></div>';
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
      // (two drives of the same model: their letters, 11-06; both read "Samsung SSD 990 PRO 2TB")
      else if (same.length > 1) { const ls = same.map(sn => (/\[([A-Z]):\]\s*$/.exec(sn.name) || [])[1]); if (ls.every(l => l != null) && new Set(ls).size === ls.length) same.forEach((sn, i) => { sn.short = k2 + ' ' + ls[i] + ':'; }); }
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
// (the most of it first, none left out at 0%: "CPU 87%, GPU 10%, capped 3%", 2.1)
const bnSplit = b => b.split.filter(q => q[1] > 0).slice().sort((x, y) => y[1] - x[1]).map(q => (q[0] === 'capped' ? q[0] : q[0].toUpperCase()) + ' ' + q[1] + '%').join(', ');
// the game's frame rate readings (HW Deck's own count, or HWiNFO's PresentMon): 'fps', 'low' (its 1% low) or null, and a
// 1% low's fps beside it
const gfKind = r => !r ? null : r.key === 'hwdeck.0/fps' || (isPM(r) && /^Framerate( Presented)?( \(avg\))?$/.test(r.label)) ? 'fps' : r.key === 'hwdeck.0/fps1' || (isPM(r) && /1% low/i.test(r.label)) ? 'low' : null;
const fpsOf = r => r.key === 'hwdeck.0/fps1' ? BYKEY.get('hwdeck.0/fps') : READ.find(x => x.s === r.s && /^Framerate( Presented)?( \(avg\))?$/.test(x.label));   // (a 1% low's fps reading)
function gfPair(r) {
  const f = fpsOf(r);
  if (!f) return 0;
  const xs = series(f.key, 10).filter(x => x != null && x > 0);   // (the last 10 s, as the 1% low)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.isFinite(f.v) ? f.v : 0;
}
// the last game session while no game runs (the host's "lastGame", 2.1): the Game cells show it in a softer grey
const lastG = () => !feed.game && feed.lg && feed.lg.end > 0 && typeof feed.lg.game === 'string' ? feed.lg : null;
// a Game cell (2.1): when a game ends they wait for its summary (feed.lgWait, at most 1.5 s), so the session before
// it never flashes in between (the motion audit 11-04)
const isGameCell = c => { const r = c.key ? BYKEY.get(c.key) : null; return isBneck(c) || c.key === GTIME || !!gfKind(r) || (!!r && r.kind === 'gametime'); };
// how long ago it ended, short: "4h 02m ago", "2 days ago"
const agoShort = s => s < 60 ? 'just now' : s < 86400 ? durTxt(s) + ' ago' : plural(Math.floor(s / 86400), 'day') + ' ago';
// its time played in the last 24 h (a session that began before them counts its share), "6h 37m in 24 h"; none: ''
function dayPlay(L) {
  let s = 0; const from = nowTs - 86400;
  for (const d of Array.isArray(L.day) ? L.day : []) if (Array.isArray(d) && d[1] > from) s += d[0] >= from ? d[2] : d[2] * (d[1] - from) / Math.max(1, d[1] - d[0]);
  return s >= 60 ? durTxt(s) + ' in 24 h' : '';
}
// (2.1.1, his "no graph under game tile cell" 11-04: no game, Game time's graph is the last 24 h, Yes a minute a session
// ran, as his dashboard's; one array while the minute and the sessions are the same, so it is drawn once a minute)
const PLAYDAY = { k: '', lv: null };
function playDay(L) {
  const m0 = Math.floor(nowTs / 60) - 1440, day = Array.isArray(L.day) ? L.day.filter(d => Array.isArray(d) && d[1] > d[0]) : [];
  const k = m0 + '|' + day.map(d => d[0] + '-' + d[1]).join();
  if (PLAYDAY.k === k) return PLAYDAY.lv;
  const lv = new Array(1440).fill(0);
  for (const d of day) for (let m = Math.max(0, Math.floor(d[0] / 60) - m0); m < Math.min(1440, Math.ceil(d[1] / 60) - m0); m++) lv[m] = 1;
  PLAYDAY.k = k; PLAYDAY.lv = lv;
  return lv;
}
// its calls as a strip over its own minutes (tb: a letter a minute, g gpu, c cpu, f capped), each call's share from
// its seconds (g, c, f), and the call that held most of them (0 none)
function lgStrip(L) {
  const tb = typeof L.tb === 'string' ? L.tb : '', k = { g: 1, c: 2, f: 3 }, segs = [];
  for (let a = 0, i = 1; i <= tb.length; i++) if (i === tb.length || tb[i] !== tb[a]) { if (k[tb[a]]) segs.push([a, i, BN[k[tb[a]]][2]]); a = i; }
  const n = [0, +L.g || 0, +L.c || 0, +L.f || 0], tot = n[1] + n[2] + n[3];
  return { segs, span: Math.max(1, tb.length), tot, split: tot ? [1, 2, 3].map(q => [BN[q][3], Math.round(n[q] * 100 / tot), BN[q][2]]) : [],
           call: !tot ? 0 : n[1] >= n[2] && n[1] >= n[3] ? 1 : n[2] >= n[3] ? 2 : 3 };
}
// its calls as a graph (11-04, his "for EVERY bar in the app replace with a graph ... even the bottleneck"): a level per
// call, GPU bound at the top (3), CPU bound in the middle (2), capped at the bottom (1); no game, a gap
const bnLv = k => BN[k] ? 4 - k : null;
const BN_LV = ['capped', 'CPU', 'GPU'];
// the last 15 min in the cells' 6 s buckets, each its most common call (the graph in a tile, a row, a card)
function bnState() {
  const s = series(BNECK, HLEN), start = nowTs - HLEN + 1, pts = [], b0 = Math.floor(start / BUCKET), b1 = Math.floor(nowTs / BUCKET);
  for (let b = b0; b <= b1; b++) {
    const n = [0, 0, 0, 0];
    for (let t = Math.max(start, b * BUCKET); t <= Math.min(nowTs, b * BUCKET + BUCKET - 1); t++) { const x = s[t - start]; if (BN[x]) n[x]++; }
    const k = n[1] + n[2] + n[3] === 0 ? 0 : n[1] >= n[2] && n[1] >= n[3] ? 1 : n[2] >= n[3] ? 2 : 3;
    if (k) pts.push({ s: b, v: bnLv(k), x: b === b1 ? (nowTs + 1) / BUCKET : b + 0.5 });
  }
  if (pts.length < 2) return null;
  return { pts, end: (nowTs + 1) / BUCKET, span: NB, lo: 1, hi: 3, step: true, map: new Map(pts.map(q => [q.s, q])) };
}
// the last session's minutes as levels (one array while it is the same session, so its graph is drawn once)
const BNPC = { tb: null, lv: null };
function bnPast(L) {
  const tb = typeof L.tb === 'string' ? L.tb : '', k = { g: 3, c: 2, f: 1 };
  if (BNPC.tb !== tb) { BNPC.tb = tb; BNPC.lv = [...tb].map(ch => k[ch] || null); }
  return BNPC.lv;
}
// a popup's or the hover's graph of the calls: a level per column, a step where the call changes, its names on the left
const BN_PADL = 50;
function drawLevels(cv, lv, rev, col) {
  const { ctx, w, h, dpr } = graphCtx(cv);
  if (!w || !h) return;
  const padL = BN_PADL * dpr, padR = 4 * dpr, padT = 9 * dpr, padB = 7 * dpr, n = Math.max(1, lv.length);
  const xL = i => padL + i / n * (w - padL - padR), Y = v => padT + (3 - v) / 2 * (h - padT - padB);   // (a column's left edge; its right is the next one's)
  ctx.font = (11 * dpr) + 'px Segoe UI'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 1; v <= 3; v++) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = gv('#1e1e1e'); ctx.lineWidth = dpr; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.fillText(BN_LV[v - 1], padL - 8 * dpr, y);
  }
  const runs = []; let cur = null;
  lv.forEach((v, i) => { if (v == null) { cur = null; return; } if (!cur) runs.push(cur = []); cur.push(i); });
  const trace = run => { for (const i of run) { ctx.lineTo(xL(i), Y(lv[i])); ctx.lineTo(xL(i + 1), Y(lv[i])); } };
  ctx.save();
  if (rev < 1) { ctx.beginPath(); ctx.rect(0, 0, padL + (w - padL - padR) * rev, h); ctx.clip(); }
  ctx.beginPath();
  for (const run of runs) { ctx.moveTo(xL(run[0]), h - padB); trace(run); ctx.lineTo(xL(run[run.length - 1] + 1), h - padB); ctx.closePath(); }
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB); grad.addColorStop(0, hexA(col, 0.16)); grad.addColorStop(1, hexA(col, 0));
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  for (const run of runs) { ctx.moveTo(xL(run[0]), Y(lv[run[0]])); trace(run); }
  ctx.strokeStyle = col; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
  ctx.fillStyle = col;   // (a call on its own between gaps, a short game over 7 days, still shows: a dot)
  for (const run of runs) if (xL(run[run.length - 1] + 1) - xL(run[0]) < 3 * dpr) { ctx.beginPath(); ctx.arc((xL(run[0]) + xL(run[run.length - 1] + 1)) / 2, Y(lv[run[0]]), 2 * dpr, 0, 7); ctx.fill(); }
  ctx.restore();
}
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
  return 'It reads ' + nm(feed.bnIn[0]) + ', ' + (feed.bnIn[1] ? nm(feed.bnIn[1]) : 'the busiest of ' + feed.bnIn[2] + ' CPU thread usages') + (feed.fpsState === 'on' ? ' and the pace of the game\'s frames.' : '. It isn\'t counting the game\'s frames now (Accurate game fps), so only a cap at the screen\'s refresh rate shows.');
}
const bnLegend = b => b.split.map(q => '<span><i class="lg ' + q[2] + '"></i><em>' + q[0] + '</em>' + q[1] + '%</span>').join('');
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
function ringFill(key, ts, arr) { const g = ring(key), n = Math.min(HLEN, arr.length); for (let i = 0; i < n; i++) { const s = ts - n + 1 + i, k = s % HLEN; g.v[k] = arr[i] == null ? NaN : arr[i]; g.at[k] = s; } }   // (fewer than 15 min: the newest seconds, ending at ts, 2.1)
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
// a value that rounds to zero loses its sign: -0.03 with 1 decimal is 0.0, not -0.0
const noNeg0 = s => s[0] === '-' && !/[1-9]/.test(s) ? s.slice(1) : s;
function fmt(v, dec) { return v == null || !isFinite(v) ? '--' : noNeg0((NF[dec] || NF[0]).format(+v)); }
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
const fmtL = (x, dec) => noNeg0((NFL[dec == null ? 1 : dec] || NFL[1]).format(+x));
// a line's value; a Yes/No one in words: the state that crosses it (above, a line over 0 is crossed by Yes; below, a line
// under 1 by No)
const lnTxt = (x, dec, r, below) => isYN(r) ? (below ? (x < 1 ? 'No' : 'Yes') : (x > 0 ? 'Yes' : 'No')) : fmtL(x, dec);
// a curve's points go by temperature, a tie by rpm (two points at one temperature: a step)
const ptOrd = (a, b) => a[0] - b[0] || a[1] - b[1];
function interp(pts, x) {
  if (!pts || !pts.length || x == null || !isFinite(x)) return null;
  const p = pts.slice().sort(ptOrd);
  if (x <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) if (x <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1); }
  return p[p.length - 1][1];
}
const mixHex = (a, b, w) => '#' + [1, 3, 5].map(i => Math.max(0, Math.min(255, Math.round(parseInt(a.substr(i, 2), 16) * (1 - w) + parseInt(b.substr(i, 2), 16) * w))).toString(16).padStart(2, '0')).join('');   // (each channel kept in 0 to 255: an overshoot made a colour the canvas refused, 11-09)
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
    out.cats.push(Object.assign({ id, name: str(cat.name, 200) && cat.name.trim() ? str(cat.name, 200) : 'Category', collapsed: false, cells: list }, isHex(cat.col) ? { col: cat.col.toLowerCase() } : {}));   // (col: its colour under Spectrum, when you picked one)
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
//   looks    category: tiles { size: short, title: hide, lead } (per: tiles per row, before 2.2: read as shares, see TILE_MIN), overview { style: small|list|
//            band, title: hide, lead }, grid { lead } (lead: the cell shown first); cell: tiles { size: wide|tall|big,
//            name }, overview and grid { name } (name: its name in that view only)
//   Grid has exactly one row: its columns are the tables
const VIEWS = ['tiles', 'overview', 'grid'], VNAME = { tiles: 'Tiles', overview: 'Overview', grid: 'Grid' };
const MAXC = { tiles: 6, overview: 6, grid: 3 }, MAXS = { tiles: 6, overview: 6, grid: 99 };
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const share = x => typeof x === 'number' && isFinite(x) && x > 0 ? Math.min(6, Math.max(0.5, Math.round(x * 2) / 2)) : undefined;
const sid = s => typeof s === 'string' ? s : s.id;
// (his 11-07 "move it to stay next to memory but still side by side": a column's categories can sit side by side, a
// line of them. An entry { id, b: 1 } sits beside the one before it; a column's first never does. Versions before
// read it as stacked)
const isBeside = s => !!s && typeof s === 'object' && s.b === 1, MAXB = 4;
const lineShare = cat => cat && !cat.collapsed ? cellsOf(cat).length || 2 : 1;   // (a member's share of its line: its cells; collapsed, a title only; empty (edit mode), two tiles' room to drop into, 11-07 audit)
function stackLines(stack) { const out = []; for (const s of stack) { if (isBeside(s) && out.length) out[out.length - 1].push(s); else out.push([s]); } return out; }
const lineAt = (st, k) => { let a = k, b = k; while (a > 0 && isBeside(st[a])) a--; while (b + 1 < st.length && isBeside(st[b + 1])) b++; return [a, b]; };
// where an entry is: its line in the column (li of n) and its place in the line (j of m)
function linePos(st, k) { const L = stackLines(st); let i = 0; for (let li = 0; li < L.length; li++) { if (k < i + L[li].length) return { li, n: L.length, j: k - i, m: L[li].length }; i += L[li].length; } return { li: 0, n: 1, j: 0, m: 1 }; }
const stackTxt = (st, k) => { const q = linePos(st, k); return (q.n > 1 ? ', stacked ' + (q.li + 1) + ' of ' + q.n : '') + (q.m > 1 ? ', beside ' + (q.j + 1) + ' of ' + q.m : ''); };
const clone = x => JSON.parse(JSON.stringify(x));
// a tile's size in Tiles: w and h in tiles (a normal tile is 1 x 1), each 0.25 to 2 (quarter steps and thirds, 2.1). The sizes that have a name keep it
// (wide 2 x 1, tall 1 x 2, big 2 x 2), so an older HW Deck still draws those; it draws any other size as a normal tile
const SZ = { wide: [2, 1], tall: [1, 2], big: [2, 2] };
// 2.2 (his ask 11-04: "the pixel measurement in the app is goofy ... the scalling .25 or 1/3 ... is a bit redundant, so
// we need a better system"): a tile you size in Tiles is a share of its row (f, 0.05 to 1, shown as a %) and h rows tall
// (1 = a normal tile), the same at any window size and text size; one you haven't sized is a normal tile its category
// places (Auto). No tile is drawn narrower than TILE_MIN (rem): where a row is too narrow for that, its tiles take fewer
// a line, in even lines (his pick: 200 px at his text size). Tiles per row went: a category with it set gets its tiles as
// shares of its row, as it drew them (cleanViews). PCTS: the widths a drag snaps to, RQ: the heights to pick from
const TILE_MIN = 11.6, PCTS = [25, 100 / 3, 50, 200 / 3, 75, 100], RQ = [0.5, 0.75, 1, 1.5, 2];
const SPIN_UD = '<span class="ud" aria-hidden="true"><b data-step="1"><svg viewBox="0 0 10 6"><path d="M1.5 5L5 1.5 8.5 5"/></svg></b><b data-step="-1"><svg viewBox="0 0 10 6"><path d="M1.5 1L5 4.5 8.5 1"/></svg></b></span>';   // (Settings' up and down arrows, its number boxes' and the edit panel's: built early, the panel can draw before Settings' code runs)
const fNum = x => { if (typeof x !== 'number' || !isFinite(x) || x <= 0) return null; const f = Math.min(1, Math.max(0.05, x)), q = PCTS.find(p => Math.abs(p / 100 - f) < 0.0015); return Math.round((q ? q / 100 : f) * 1e4) / 1e4; };
const pctTxt = f => Math.round(f * 100) + '%';
// (a size a hair off a quarter step or a third, a third of a pixel or less, from a snap or a px step, is that step: 0.9999
// is 1, so four tiles of 0.75 and one of 1 still fill a row of 4; 1.3333 is 4/3, so three of them fill it too)
const SNAPQ = 0.002;
// (where a tile's pitch is known, a third of a pixel at that pitch: a 1 px step on a big tile is kept; a size read from a
// file only loses float noise, it was snapped when it was made)
const szNum = (x, tol = SNAPQ) => { if (typeof x !== 'number' || !isFinite(x)) return 1; const v = Math.round(x * 1e4) / 1e4, q = Math.round(v * 4) / 4, t = Math.round(v * 3) / 3; return Math.min(2, Math.max(0.25, Math.abs(v - q) < tol ? q : Math.abs(v - t) < tol ? t : v)); };
const snapAt = G => G && G.p > 0 ? Math.min(SNAPQ, 0.33 / G.p) : SNAPQ;
const isSz = k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(SZ, k);
function sizeLook(w, h, tol, tolH) {
  w = szNum(w, tol); h = szNum(h, tolH === undefined ? tol : tolH);
  for (const k of Object.keys(SZ)) if (SZ[k][0] === w && SZ[k][1] === h) return { size: k };
  return w === 1 && h === 1 ? {} : { w, h };
}
const cleanSize = x => {
  const f = fNum(x.f);
  if (f) { const e = { f }, h = typeof x.h === 'number' ? szNum(x.h, 1.5e-4) : 1; if (h !== 1) e.h = h; if (x.fx === true) e.fx = true; return e; }   // (2.2: a share of its row; fx: set by hand)
  return typeof x.w === 'number' || typeof x.h === 'number' ? sizeLook(x.w, x.h, 1.5e-4) : isSz(x.size) ? { size: x.size } : {};
};
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
          let lost = false, inLine = 0;   // (lost: the line's first was dropped, so the next one leads it, 11-07 audit)
          for (const it of c.stack) {
            if (stack.length >= MAXS[vn]) break;
            const raw = typeof it === 'string' ? it : isObj(it) && typeof it.id === 'string' ? it.id : null, id = raw === null ? undefined : catIds.get(raw), bb = isObj(it) && it.b === 1;
            if (!id || placed.has(id)) { if (!bb) lost = true; continue; }
            placed.add(id);
            const side = bb && stack.length && !lost && inLine < MAXB; lost = false; inLine = side ? inLine + 1 : 1;
            stack.push(side ? { id, b: 1 } : id);   // (1.2 betas kept a height share here: every category now keeps its own height; b: beside the one before it, 11-07)
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
    // (Fill the window: the view's, so Automatic keeps it, set only by the view's Height. A row of yours fills on its own
    // and keeps its Fill, even when every row left fills: rows added later fit, 11-08 audit; a move made the view fill)
    if (vn === 'tiles' && v.fill === true) { o.fill = true; if (o.rows) for (const r of o.rows) delete r.h; }
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
    if (vn === 'tiles' && o.cat) {   // (2.2: tiles per row went; its tiles keep the widths they had, as shares of the row)
      for (const cid of Object.keys(o.cat)) {
        const per = o.cat[cid].per; if (!per) continue;
        const cat = L.cats.find(c => c.id === cid);
        for (const x of cat ? cat.cells : []) {
          const e = (o.cell || (o.cell = {}))[x] || {}, z = isSz(e.size) ? { w: SZ[e.size][0], h: SZ[e.size][1] } : { w: e.f ? null : e.w || 1, h: e.h || 1 };
          if (z.w === null) continue;
          delete e.size; delete e.w; delete e.h; e.f = fNum(Math.min(z.w, per) / per); if (z.h !== 1) e.h = z.h;
          o.cell[x] = e;
        }
        delete o.cat[cid].per; if (!Object.keys(o.cat[cid]).length) delete o.cat[cid];
      }
      if (!Object.keys(o.cat).length) delete o.cat;
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
const S = { L: emptyLayout(), slots: [null, null, null, null, null], active: null, edit: true, screen: 'tiles', motion: undefined, title: undefined, clock: true, look: { theme: 'classic', changed: false, base: '#0d0d0d', fades: [], cell: '#151515', op: 100, line: true, corners: 'normal', tint: 'none', acc: '#ffffff', pal: 'muted', pops: 'cells' }, listFilt: { g: false, w: false }, lookSaved: [] };   // (listFilt: the period chart's window filters the list under it, Sessions g, Warning history w; off by default, his 11-09)
// the title bar: your title (this PC's name when there is none), the feed's dot and the time of the last reading
function renderTitle() {
  setText($('title'), (S.title && S.title.trim()) || feed.pc || feed.brand || 'HW Deck');
  $('clock').hidden = !S.clock;
  titleFit();
}
// animations, in Settings: Full (all of it), Minimal (nothing keeps moving: numbers just change, fans stand still,
// graphs step; popups and views still slide), Off (nothing moves). Not chosen yet: Full, or Off when Windows asks apps
// for less motion. (Reduced, before 1.4.2, moved everything at 10 steps a second and looked choppy: a view saved with it
// opens in Full, which costs less than it did)
const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const MOTIONS = ['full', 'minimal', 'off'];
try { if (matchMedia('(prefers-reduced-motion: reduce)').matches && !document.documentElement.dataset.motion) document.documentElement.dataset.motion = 'off'; } catch (e) { }   // (until the saved choice comes, 2.1)
const motionPicked = () => MOTIONS.includes(S.motion) ? S.motion : reducedMotion.matches ? 'off' : 'full';
// Full calms down to Minimal while a game is in front, or a session you started records (his call 11-04) (Settings, on
// unless turned off), and comes back after
const recNow = () => Array.isArray(feed.rec) && feed.rec.length > 0;
const gameCalmNow = () => S.gameCalm !== false && ((!!feed.game && !!feed.front) || recNow());
const motionMode = () => { const m = motionPicked(); return m === 'full' && gameCalmNow() ? 'minimal' : m; };
const motionOn = () => motionMode() === 'full';   // the moving parts: spins, rolls, glides, draw-ins
function applyMotion() { document.documentElement.dataset.motion = motionMode(); }
// the look, in Settings (11-02; the theme rework 11-05, his "ember and graphite are just ways to control the bg color
// ... a person can choose the bg AND fade colors in ANY edge", then "cells opacity", "change the cells color as well
// and add some defaults", "remove oled and soft", "reintegrate the current system or else using spectrum with this new
// theme system might look horrendous"): a theme to start from, then all of it yours: the background (a base colour and
// a fade on any edge or corner: its colour, size, strength), the cells (fill, opacity, outline, corners) and where
// colour goes (Mono: greys only, Accent: one colour on what you pick, Spectrum: each category a colour, its part's or
// yours, from a palette; Match makes that palette from the background's fades, so it always fits). Warnings stay
// yellow and red. The page sets the tokens from the look (--bg, --tile, --pop, ...); deck.css only reads them
const THEMES = { tint: ['none', 'accent', 'spectrum'], corners: ['sharp', 'normal', 'round'] };
const ACC0 = '#ffffff', ACC_OLD = { classic: '#7fa6e8', oled: '#9cb0f4' }, isHex = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const FADE_AT = { tl: [0, 0, 'Top left'], t: [50, 0, 'Top'], tr: [100, 0, 'Top right'], r: [100, 50, 'Right'], br: [100, 100, 'Bottom right'], b: [50, 100, 'Bottom'], bl: [0, 100, 'Bottom left'], l: [0, 50, 'Left'] };
// the themes to start from. Classic is the look of before (Standard's greys exactly); OLED and Soft the cards of those
// names, now themes
// the themes (11-09, the final 107 from the theme swarm, his yes: ten families, each theme with its own palette, t_<id>
// in PALETTES; Classic keeps Muted). fam: its family, for the Look page to come. Classic and OLED white accents (his
// 11-09 "classic and greys with this blueish accent color to have a white ffffff"; were #7fa6e8 and #9cb0f4)
const THEME_PRESETS = {
  classic: { name: 'Classic', fam: 'Greys', base: '#0d0d0d', fades: [], cell: '#151515', op: 100, line: true, corners: 'normal', tint: 'none', acc: ACC0, pal: 'muted' },
  oled: { name: 'OLED', fam: 'Greys', base: '#000000', fades: [], cell: '#000000', op: 0, line: true, corners: 'normal', tint: 'none', acc: '#ffffff', pal: 't_oled' },
  carbon: { name: 'Carbon', fam: 'Greys', base: '#050505', fades: [], cell: '#0e0e0e', op: 100, line: true, corners: 'sharp', tint: 'accent', acc: '#d8d8d8', pal: 't_carbon' },
  soft: { name: 'Soft', fam: 'Greys', base: '#080808', fades: [], cell: '#151515', op: 100, line: false, corners: 'round', tint: 'none', acc: '#c4a8b8', pal: 't_soft' },
  steel: { name: 'Steel', fam: 'Greys', base: '#0d1013', fades: [], cell: '#10151a', op: 100, line: true, corners: 'sharp', tint: 'accent', acc: '#8aa4be', pal: 't_steel' },
  smoke: { name: 'Smoke', fam: 'Greys', base: '#0b0b0c', fades: [{ at: 'b', c: '#9a9a9a', size: 100, a: 12 }, { at: 'tl', c: '#6a6a6a', size: 60, a: 10 }], cell: '#141415', op: 70, line: true, corners: 'round', tint: 'spectrum', acc: '#c6c6cc', pal: 't_smoke' },
  stone: { name: 'Stone', fam: 'Greys', base: '#100f0e', fades: [{ at: 'tl', c: '#6b625a', size: 80, a: 16 }], cell: '#161413', op: 100, line: true, corners: 'round', tint: 'none', acc: '#c2b6a8', pal: 't_stone' },
  graphite: { name: 'Graphite', fam: 'Greys', base: '#0e0f11', fades: [{ at: 't', c: '#5a6370', size: 90, a: 14 }], cell: '#131518', op: 100, line: true, corners: 'normal', tint: 'none', acc: '#9aa5b4', pal: 't_graphite' },
  chrome: { name: 'Chrome', fam: 'Greys', base: '#08090a', fades: [{ at: 't', c: '#e8ecf0', size: 100, a: 14 }, { at: 'b', c: '#e8ecf0', size: 60, a: 8 }], cell: '#121314', op: 55, line: true, corners: 'round', tint: 'accent', acc: '#c2d0e2', pal: 't_chrome' },
  halftone: { name: 'Halftone', fam: 'Greys', base: '#0e0e0e', fades: [{ at: 'tl', c: '#7a8a9c', size: 100, a: 16 }, { at: 'br', c: '#8a7a6a', size: 100, a: 16 }], cell: '#171717', op: 65, line: true, corners: 'normal', tint: 'spectrum', acc: '#a8b8cc', pal: 't_halftone' },
  leather: { name: 'Leather', fam: 'Browns', base: '#0d0705', fades: [{ at: 'tl', c: '#6a2e1a', size: 95, a: 38 }, { at: 'br', c: '#3a1810', size: 75, a: 34 }], cell: '#1b0f0b', op: 85, line: true, corners: 'sharp', tint: 'spectrum', acc: '#d86a7e', pal: 't_leather' },
  saddle: { name: 'Saddle', fam: 'Browns', base: '#0f0806', fades: [{ at: 'bl', c: '#8a4a28', size: 90, a: 32 }, { at: 'tr', c: '#4a2014', size: 80, a: 36 }], cell: '#1e110c', op: 55, line: true, corners: 'round', tint: 'spectrum', acc: '#f4a06a', pal: 't_saddle' },
  mocha: { name: 'Mocha', fam: 'Browns', base: '#120c0a', fades: [{ at: 'tr', c: '#7a4a3a', size: 80, a: 30 }], cell: '#1c1410', op: 80, line: true, corners: 'normal', tint: 'spectrum', acc: '#e8a684', pal: 't_mocha' },
  fireside: { name: 'Fireside', fam: 'Browns', base: '#0e0806', fades: [{ at: 'b', c: '#a04a20', size: 70, a: 30 }, { at: 'bl', c: '#5a2a14', size: 80, a: 26 }], cell: '#1c110c', op: 68, line: true, corners: 'round', tint: 'spectrum', acc: '#eaa580', pal: 't_fireside' },
  copper: { name: 'Copper', fam: 'Browns', base: '#0f0b09', fades: [{ at: 'tl', c: '#b0603a', size: 75, a: 26 }, { at: 'br', c: '#5a3a2a', size: 70, a: 26 }], cell: '#1d1612', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#f09a64', pal: 't_copper' },
  cognac: { name: 'Cognac', fam: 'Browns', base: '#0f0805', fades: [{ at: 't', c: '#a0581e', size: 90, a: 26 }, { at: 'b', c: '#3a1a0c', size: 80, a: 30 }], cell: '#1d120b', op: 65, line: true, corners: 'normal', tint: 'spectrum', acc: '#f6aa68', pal: 't_cognac' },
  espresso: { name: 'Espresso', fam: 'Browns', base: '#0f0a07', fades: [{ at: 'b', c: '#7a4424', size: 95, a: 40 }, { at: 'tl', c: '#4a2a18', size: 75, a: 34 }], cell: '#22170f', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#e2a468', pal: 't_espresso' },
  timber: { name: 'Timber', fam: 'Browns', base: '#0d0a07', fades: [{ at: 'l', c: '#5a3c22', size: 70, a: 34 }, { at: 'r', c: '#3e2a18', size: 70, a: 30 }], cell: '#1b150e', op: 82, line: true, corners: 'sharp', tint: 'accent', acc: '#d2a06a', pal: 't_timber' },
  latte: { name: 'Latte', fam: 'Browns', base: '#15110d', fades: [{ at: 't', c: '#c9a27a', size: 90, a: 16 }, { at: 'br', c: '#8a6a4a', size: 70, a: 20 }], cell: '#1a1510', op: 76, line: true, corners: 'round', tint: 'spectrum', acc: '#f0cfa4', pal: 't_latte' },
  sand: { name: 'Sand', fam: 'Browns', base: '#13110d', fades: [{ at: 't', c: '#b8a27a', size: 85, a: 16 }], cell: '#17140f', op: 85, line: true, corners: 'round', tint: 'spectrum', acc: '#d9c49a', pal: 't_sand' },
  garnet: { name: 'Garnet', fam: 'Reds and oranges', base: '#0e0408', fades: [{ at: 't', c: '#a01040', size: 90, a: 34 }], cell: '#1b0c10', op: 72, line: true, corners: 'normal', tint: 'spectrum', acc: '#f25a84', pal: 't_garnet' },
  ruby: { name: 'Ruby', fam: 'Reds and oranges', base: '#0b0406', fades: [{ at: 'tl', c: '#c01a3a', size: 75, a: 34 }, { at: 'br', c: '#7a0e22', size: 70, a: 26 }], cell: '#190b0e', op: 64, line: true, corners: 'round', tint: 'spectrum', acc: '#ff5c8a', pal: 't_ruby' },
  carmine: { name: 'Carmine', fam: 'Reds and oranges', base: '#0e0507', fades: [{ at: 'l', c: '#b8104a', size: 90, a: 34 }], cell: '#1c0b0e', op: 64, line: true, corners: 'normal', tint: 'spectrum', acc: '#ff80b4', pal: 't_carmine' },
  velvet: { name: 'Velvet', fam: 'Reds and oranges', base: '#0e0607', fades: [{ at: 'b', c: '#8a1a2a', size: 100, a: 36 }], cell: '#1b0f11', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#ff6a98', pal: 't_velvet' },
  coral: { name: 'Coral', fam: 'Reds and oranges', base: '#110807', fades: [{ at: 'bl', c: '#e0604a', size: 85, a: 38 }, { at: 'tr', c: '#b04a3a', size: 60, a: 24 }], cell: '#1f1210', op: 62, line: true, corners: 'round', tint: 'spectrum', acc: '#ff8a70', pal: 't_coral' },
  lava: { name: 'Lava', fam: 'Reds and oranges', base: '#0a0505', fades: [{ at: 'b', c: '#ff3a10', size: 100, a: 34 }, { at: 'tl', c: '#8a1a0a', size: 60, a: 26 }], cell: '#1a0e0b', op: 55, line: true, corners: 'sharp', tint: 'spectrum', acc: '#ff7a20', pal: 't_lava' },
  ember: { name: 'Ember', fam: 'Reds and oranges', base: '#0d0807', fades: [{ at: 'b', c: '#c4351c', size: 100, a: 36 }], cell: '#1c1210', op: 60, line: true, corners: 'normal', tint: 'spectrum', acc: '#ff6a3d', pal: 't_ember' },
  rust: { name: 'Rust', fam: 'Reds and oranges', base: '#100907', fades: [{ at: 'r', c: '#9a3a1a', size: 80, a: 30 }], cell: '#1d1310', op: 70, line: true, corners: 'sharp', tint: 'spectrum', acc: '#ff7f3a', pal: 't_rust' },
  martian: { name: 'Martian', fam: 'Reds and oranges', base: '#0f0806', fades: [{ at: 'tr', c: '#c0502a', size: 90, a: 34 }], cell: '#1e130f', op: 68, line: true, corners: 'round', tint: 'spectrum', acc: '#ffa070', pal: 't_martian' },
  saffron: { name: 'Saffron', fam: 'Golds and yellows', base: '#120a04', fades: [{ at: 'br', c: '#e0801a', size: 80, a: 30 }, { at: 'tl', c: '#b08a20', size: 70, a: 22 }], cell: '#211508', op: 66, line: true, corners: 'normal', tint: 'spectrum', acc: '#ff9f40', pal: 't_saffron' },
  caramel: { name: 'Caramel', fam: 'Golds and yellows', base: '#120d07', fades: [{ at: 'bl', c: '#c07a2a', size: 85, a: 28 }], cell: '#1f170d', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#f8a040', pal: 't_caramel' },
  honeycomb: { name: 'Honeycomb', fam: 'Golds and yellows', base: '#110c05', fades: [{ at: 'b', c: '#d89020', size: 95, a: 30 }, { at: 'tl', c: '#8a5a10', size: 60, a: 20 }], cell: '#20170a', op: 68, line: true, corners: 'round', tint: 'spectrum', acc: '#f5a742', pal: 't_honeycomb' },
  sunflower: { name: 'Sunflower', fam: 'Golds and yellows', base: '#100c03', fades: [{ at: 't', c: '#f0b020', size: 90, a: 24 }, { at: 'b', c: '#6a4a10', size: 80, a: 24 }], cell: '#1e1807', op: 70, line: true, corners: 'round', tint: 'spectrum', acc: '#f0a020', pal: 't_sunflower' },
  midas: { name: 'Midas', fam: 'Golds and yellows', base: '#0d0a04', fades: [{ at: 't', c: '#e8b830', size: 100, a: 26 }, { at: 'bl', c: '#c88a20', size: 80, a: 22 }, { at: 'br', c: '#c88a20', size: 80, a: 22 }], cell: '#1c1607', op: 80, line: true, corners: 'normal', tint: 'spectrum', acc: '#f0a828', pal: 't_midas' },
  brushedgold: { name: 'Brushed Gold', fam: 'Golds and yellows', base: '#120e05', fades: [{ at: 'l', c: '#d0a038', size: 100, a: 24 }, { at: 'r', c: '#d0a038', size: 100, a: 24 }], cell: '#1c1505', op: 86, line: true, corners: 'sharp', tint: 'accent', acc: '#e8a030', pal: 't_brushedgold' },
  gilded: { name: 'Gilded', fam: 'Golds and yellows', base: '#0d0b06', fades: [{ at: 'tr', c: '#c8a030', size: 80, a: 24 }], cell: '#1a170e', op: 80, line: true, corners: 'sharp', tint: 'spectrum', acc: '#e3ae51', pal: 't_gilded' },
  goldleaf: { name: 'Gold Leaf', fam: 'Golds and yellows', base: '#0b0a06', fades: [{ at: 'tl', c: '#d0a838', size: 70, a: 30 }, { at: 'br', c: '#a07820', size: 70, a: 24 }], cell: '#18160d', op: 82, line: true, corners: 'sharp', tint: 'spectrum', acc: '#f4b048', pal: 't_goldleaf' },
  citrine: { name: 'Citrine', fam: 'Golds and yellows', base: '#0f0c02', fades: [{ at: 'tl', c: '#f0c020', size: 75, a: 28 }, { at: 'br', c: '#f09010', size: 70, a: 22 }], cell: '#1d1806', op: 72, line: true, corners: 'normal', tint: 'spectrum', acc: '#f5a000', pal: 't_citrine' },
  moss: { name: 'Moss', fam: 'Greens', base: '#0c0d08', fades: [{ at: 'tl', c: '#6a7a2a', size: 85, a: 28 }], cell: '#14170f', op: 75, line: true, corners: 'round', tint: 'spectrum', acc: '#a8c060', pal: 't_moss' },
  nettle: { name: 'Nettle', fam: 'Greens', base: '#060906', fades: [{ at: 'tl', c: '#4a8a2a', size: 80, a: 24 }], cell: '#10160e', op: 82, line: true, corners: 'sharp', tint: 'spectrum', acc: '#7ad030', pal: 't_nettle' },
  grove: { name: 'Grove', fam: 'Greens', base: '#050906', fades: [{ at: 'bl', c: '#2a7a36', size: 90, a: 32 }, { at: 'br', c: '#2a7a36', size: 90, a: 32 }], cell: '#0d170e', op: 42, line: true, corners: 'sharp', tint: 'spectrum', acc: '#62c46a', pal: 't_grove' },
  sage: { name: 'Sage', fam: 'Greens', base: '#0a100b', fades: [{ at: 'b', c: '#6a9a72', size: 90, a: 20 }], cell: '#0e1610', op: 85, line: true, corners: 'round', tint: 'spectrum', acc: '#78e47f', pal: 't_sage' },
  clover: { name: 'Clover', fam: 'Greens', base: '#060c07', fades: [{ at: 'l', c: '#45a63a', size: 70, a: 26 }, { at: 'r', c: '#45a63a', size: 70, a: 26 }], cell: '#101a12', op: 66, line: true, corners: 'round', tint: 'spectrum', acc: '#2fe472', pal: 't_clover' },
  matrix: { name: 'Matrix', fam: 'Greens', base: '#000000', fades: [{ at: 't', c: '#00a040', size: 90, a: 22 }], cell: '#000000', op: 0, line: true, corners: 'sharp', tint: 'spectrum', acc: '#2aff6a', pal: 't_matrix' },
  pinewood: { name: 'Pinewood', fam: 'Greens', base: '#040a07', fades: [{ at: 't', c: '#1d5a36', size: 100, a: 38 }, { at: 'bl', c: '#0e3a24', size: 60, a: 20 }], cell: '#0b1a11', op: 80, line: true, corners: 'sharp', tint: 'spectrum', acc: '#10b870', pal: 't_pinewood' },
  evergreen: { name: 'Evergreen', fam: 'Greens', base: '#070d09', fades: [{ at: 'b', c: '#1f7a4a', size: 95, a: 32 }, { at: 'tl', c: '#2a5a3a', size: 70, a: 24 }], cell: '#111a14', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#4fd08a', pal: 't_evergreen' },
  malachite: { name: 'Malachite', fam: 'Greens', base: '#040a07', fades: [{ at: 'tl', c: '#0e8a5a', size: 60, a: 24 }, { at: 'r', c: '#1aa070', size: 55, a: 20 }, { at: 'bl', c: '#0a6a48', size: 60, a: 24 }], cell: '#0b1712', op: 45, line: true, corners: 'normal', tint: 'spectrum', acc: '#1ceca7', pal: 't_malachite' },
  ivy: { name: 'Ivy', fam: 'Greens', base: '#050a07', fades: [{ at: 'tr', c: '#167a5c', size: 95, a: 30 }, { at: 'bl', c: '#0c4a3a', size: 70, a: 22 }], cell: '#0d170f', op: 66, line: true, corners: 'round', tint: 'spectrum', acc: '#1ec97a', pal: 't_ivy' },
  cypress: { name: 'Cypress', fam: 'Greens', base: '#04090a', fades: [{ at: 'b', c: '#1e6a50', size: 100, a: 34 }], cell: '#0b1714', op: 88, line: false, corners: 'normal', tint: 'spectrum', acc: '#04cca8', pal: 't_cypress' },
  jade: { name: 'Jade', fam: 'Teals', base: '#05100a', fades: [{ at: 'l', c: '#0d8a4c', size: 90, a: 32 }, { at: 'br', c: '#0a6a40', size: 70, a: 26 }], cell: '#0f1d18', op: 60, line: true, corners: 'normal', tint: 'spectrum', acc: '#08e092', pal: 't_jade' },
  mint: { name: 'Mint', fam: 'Teals', base: '#08100e', fades: [{ at: 'tr', c: '#3ad0a0', size: 100, a: 19 }, { at: 'bl', c: '#1a8a6a', size: 75, a: 16 }], cell: '#12201c', op: 65, line: true, corners: 'round', tint: 'spectrum', acc: '#1ef4bb', pal: 't_mint' },
  spiral: { name: 'Spiral', fam: 'Teals', base: '#071012', fades: [{ at: 'br', c: '#20a090', size: 100, a: 24 }, { at: 'tl', c: '#1c4a7a', size: 80, a: 22 }, { at: 'tr', c: '#0e6a6a', size: 40, a: 14 }], cell: '#0f1c1e', op: 55, line: true, corners: 'round', tint: 'spectrum', acc: '#10e2cf', pal: 't_spiral' },
  offshore: { name: 'Offshore', fam: 'Teals', base: '#0a1a1c', fades: [{ at: 'r', c: '#0f6a7a', size: 100, a: 30 }], cell: '#0c1c1e', op: 85, line: false, corners: 'round', tint: 'spectrum', acc: '#16c8e0', pal: 't_offshore' },
  'pier-lights': { name: 'Pier lights', fam: 'Teals', base: '#050b0d', fades: [{ at: 'b', c: '#148a90', size: 70, a: 26 }, { at: 'tl', c: '#b06a30', size: 45, a: 12 }], cell: '#0e171a', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#0bd1db', pal: 't_pier-lights' },
  'cyan-line': { name: 'Cyan line', fam: 'Teals', base: '#080c0e', fades: [{ at: 't', c: '#126a78', size: 100, a: 16 }], cell: '#0b1c20', op: 100, line: true, corners: 'sharp', tint: 'accent', acc: '#2ad4e0', pal: 't_cyan-line' },
  'dusk-tide': { name: 'Dusk tide', fam: 'Teals', base: '#060c10', fades: [{ at: 'b', c: '#0f8a88', size: 90, a: 30 }, { at: 'tr', c: '#5a3a90', size: 45, a: 14 }], cell: '#0e171c', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#13ddd4', pal: 't_dusk-tide' },
  deepsea: { name: 'Deep sea', fam: 'Teals', base: '#061012', fades: [{ at: 'bl', c: '#0f6a7a', size: 90, a: 34 }, { at: 'tr', c: '#1a3a7a', size: 70, a: 26 }], cell: '#0f1c20', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#15d8eb', pal: 't_deepsea' },
  frostwater: { name: 'Frostwater', fam: 'Teals', base: '#0a1215', fades: [{ at: 'tl', c: '#5ad8e0', size: 70, a: 12 }, { at: 'br', c: '#2a90b0', size: 60, a: 16 }], cell: '#0f2228', op: 65, line: true, corners: 'normal', tint: 'spectrum', acc: '#8cd8e4', pal: 't_frostwater' },
  'night-lagoon': { name: 'Night lagoon', fam: 'Teals', base: '#050a10', fades: [{ at: 'b', c: '#127a8a', size: 90, a: 26 }, { at: 'tl', c: '#22306a', size: 70, a: 22 }], cell: '#0d1520', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#00b4cc', pal: 't_night-lagoon' },
  arctic: { name: 'Arctic', fam: 'Blues', base: '#0b1014', fades: [{ at: 'tr', c: '#7ad0f0', size: 80, a: 11 }], cell: '#0f171f', op: 70, line: true, corners: 'round', tint: 'spectrum', acc: '#94d3fd', pal: 't_arctic' },
  slate: { name: 'Slate', fam: 'Blues', base: '#0c0e11', fades: [{ at: 't', c: '#4a6a94', size: 85, a: 34 }], cell: '#11161c', op: 85, line: true, corners: 'normal', tint: 'accent', acc: '#7aa2d6', pal: 't_slate' },
  navy: { name: 'Navy', fam: 'Blues', base: '#050a18', fades: [{ at: 'b', c: '#10265a', size: 100, a: 30 }], cell: '#0a132c', op: 100, line: true, corners: 'sharp', tint: 'accent', acc: '#8aa4d8', pal: 't_navy' },
  storm: { name: 'Storm', fam: 'Blues', base: '#0c0e12', fades: [{ at: 't', c: '#5a6a8a', size: 90, a: 26 }, { at: 'br', c: '#3a4a6a', size: 70, a: 22 }], cell: '#13171c', op: 75, line: true, corners: 'normal', tint: 'spectrum', acc: '#7a9cf0', pal: 't_storm' },
  blueprint: { name: 'Blueprint', fam: 'Blues', base: '#09152b', fades: [{ at: 'tr', c: '#2f6fd0', size: 60, a: 13 }], cell: '#081429', op: 85, line: true, corners: 'sharp', tint: 'accent', acc: '#8ec5ff', pal: 't_blueprint' },
  zenith: { name: 'Zenith', fam: 'Blues', base: '#060914', fades: [{ at: 't', c: '#2a5aff', size: 45, a: 45 }], cell: '#0f1530', op: 85, line: true, corners: 'sharp', tint: 'spectrum', acc: '#7397fe', pal: 't_zenith' },
  midnight: { name: 'Midnight', fam: 'Blues', base: '#070a14', fades: [{ at: 't', c: '#1e3a8a', size: 95, a: 34 }], cell: '#10162a', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#739fff', pal: 't_midnight' },
  cobalt: { name: 'Cobalt', fam: 'Blues', base: '#080b16', fades: [{ at: 'l', c: '#2a4ae0', size: 80, a: 30 }], cell: '#121730', op: 55, line: true, corners: 'sharp', tint: 'spectrum', acc: '#7890ea', pal: 't_cobalt' },
  sapphire: { name: 'Sapphire', fam: 'Blues', base: '#070b1c', fades: [{ at: 'tl', c: '#2546c8', size: 75, a: 32 }, { at: 'br', c: '#1a6fd6', size: 60, a: 24 }], cell: '#0f1733', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#7699fe', pal: 't_sapphire' },
  horizon: { name: 'Horizon', fam: 'Blues', base: '#080b14', fades: [{ at: 'b', c: '#3a6ae0', size: 100, a: 28 }, { at: 't', c: '#0f1a3a', size: 100, a: 30 }], cell: '#121a30', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#88adfe', pal: 't_horizon' },
  ultramarine: { name: 'Ultramarine', fam: 'Blues', base: '#06061a', fades: [{ at: 'bl', c: '#2d2fd0', size: 90, a: 38 }, { at: 'tr', c: '#1f5fe0', size: 55, a: 20 }], cell: '#12133a', op: 55, line: true, corners: 'round', tint: 'spectrum', acc: '#6a72ff', pal: 't_ultramarine' },
  'blue-hour': { name: 'Blue Hour', fam: 'Blues', base: '#090a16', fades: [{ at: 't', c: '#3a4ab8', size: 95, a: 30 }, { at: 'bl', c: '#6a3ab0', size: 55, a: 16 }], cell: '#141632', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#98b1ff', pal: 't_blue-hour' },
  cosmos: { name: 'Cosmos', fam: 'Purples', base: '#070614', fades: [{ at: 'tl', c: '#4a2ab0', size: 70, a: 34 }, { at: 'r', c: '#8a2ab0', size: 50, a: 30 }, { at: 'b', c: '#2a3ab0', size: 60, a: 20 }], cell: '#12102a', op: 44, line: true, corners: 'round', tint: 'spectrum', acc: '#a5abea', pal: 't_cosmos' },
  royalviolet: { name: 'Royal Violet', fam: 'Purples', base: '#0a0816', fades: [{ at: 't', c: '#5a2ac0', size: 100, a: 34 }, { at: 'b', c: '#3a1a8a', size: 80, a: 22 }], cell: '#16112a', op: 60, line: true, corners: 'normal', tint: 'spectrum', acc: '#835ff2', pal: 't_royalviolet' },
  lavender: { name: 'Lavender', fam: 'Purples', base: '#0e0d14', fades: [{ at: 'tl', c: '#8a7ad8', size: 85, a: 26 }], cell: '#181620', op: 74, line: true, corners: 'round', tint: 'spectrum', acc: '#aea7ed', pal: 't_lavender' },
  nebula: { name: 'Nebula', fam: 'Purples', base: '#09081a', fades: [{ at: 'tl', c: '#6a2ad0', size: 80, a: 34 }, { at: 'br', c: '#d02a8a', size: 75, a: 28 }, { at: 'tr', c: '#2a6ad0', size: 50, a: 20 }], cell: '#16132a', op: 45, line: true, corners: 'round', tint: 'spectrum', acc: '#ab85f4', pal: 't_nebula' },
  grape: { name: 'Grape', fam: 'Purples', base: '#0e0816', fades: [{ at: 'r', c: '#7a30c0', size: 100, a: 40 }, { at: 'bl', c: '#4a1a8a', size: 60, a: 22 }], cell: '#1e1430', op: 62, line: true, corners: 'normal', tint: 'accent', acc: '#a67df2', pal: 't_grape' },
  orchid: { name: 'Orchid', fam: 'Purples', base: '#0f0a12', fades: [{ at: 't', c: '#b04ad0', size: 90, a: 30 }], cell: '#1b1420', op: 65, line: true, corners: 'round', tint: 'spectrum', acc: '#ca7ce8', pal: 't_orchid' },
  purpurite: { name: 'Purpurite', fam: 'Purples', base: '#0e0612', fades: [{ at: 'tr', c: '#9a1ab0', size: 70, a: 34 }], cell: '#1c0d22', op: 62, line: true, corners: 'sharp', tint: 'spectrum', acc: '#c671fe', pal: 't_purpurite' },
  aubergine: { name: 'Aubergine', fam: 'Purples', base: '#0c070e', fades: [{ at: 'bl', c: '#6e2a7a', size: 95, a: 40 }], cell: '#1a0f1c', op: 82, line: false, corners: 'normal', tint: 'accent', acc: '#ba7bd2', pal: 't_aubergine' },
  byzantium: { name: 'Byzantium', fam: 'Purples', base: '#110614', fades: [{ at: 'l', c: '#902a90', size: 85, a: 34 }], cell: '#200e24', op: 72, line: true, corners: 'sharp', tint: 'accent', acc: '#cf6bd3', pal: 't_byzantium' },
  plum: { name: 'Plum', fam: 'Purples', base: '#0f080d', fades: [{ at: 'bl', c: '#7a2a6a', size: 90, a: 34 }], cell: '#1c1119', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#cb6ab2', pal: 't_plum' },
  mulberry: { name: 'Mulberry', fam: 'Purples', base: '#10070f', fades: [{ at: 'b', c: '#902a60', size: 95, a: 32 }, { at: 'tr', c: '#4a2a9a', size: 50, a: 18 }], cell: '#1e1020', op: 70, line: true, corners: 'normal', tint: 'spectrum', acc: '#df67ae', pal: 't_mulberry' },
  'fuchsia-night': { name: 'Fuchsia Night', fam: 'Pinks', base: '#0e070c', fades: [{ at: 'b', c: '#c21d8a', size: 100, a: 26 }], cell: '#1d0f19', op: 55, line: true, corners: 'normal', tint: 'spectrum', acc: '#ed4fd1', pal: 't_fuchsia-night' },
  'pink-line': { name: 'Pink Line', fam: 'Pinks', base: '#12080e', fades: [{ at: 'bl', c: '#d0508a', size: 90, a: 24 }], cell: '#20101a', op: 60, line: true, corners: 'sharp', tint: 'accent', acc: '#e987b2', pal: 't_pink-line' },
  'pink-glass': { name: 'Pink Glass', fam: 'Pinks', base: '#0f080d', fades: [{ at: 'b', c: '#e04a96', size: 100, a: 22 }, { at: 'tl', c: '#a03a7a', size: 70, a: 18 }], cell: '#1e1219', op: 35, line: true, corners: 'round', tint: 'spectrum', acc: '#fe76c2', pal: 't_pink-glass' },
  blossom: { name: 'Blossom', fam: 'Pinks', base: '#110a0e', fades: [{ at: 'tl', c: '#e05a9a', size: 85, a: 30 }, { at: 'br', c: '#a03a7a', size: 75, a: 24 }], cell: '#1e1419', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#df94c3', pal: 't_blossom' },
  azalea: { name: 'Azalea', fam: 'Pinks', base: '#12080e', fades: [{ at: 'tr', c: '#e83c9a', size: 85, a: 28 }, { at: 'b', c: '#8a2a6a', size: 90, a: 22 }, { at: 'l', c: '#ff7ab8', size: 40, a: 10 }], cell: '#200f19', op: 66, line: true, corners: 'round', tint: 'spectrum', acc: '#fe5fb7', pal: 't_azalea' },
  sakura: { name: 'Sakura', fam: 'Pinks', base: '#120d10', fades: [{ at: 'tr', c: '#f0a0c0', size: 80, a: 20 }, { at: 'bl', c: '#c07090', size: 70, a: 18 }], cell: '#1f161b', op: 65, line: true, corners: 'round', tint: 'spectrum', acc: '#fcb1cc', pal: 't_sakura' },
  'rose-inlay': { name: 'Rose Inlay', fam: 'Pinks', base: '#26131d', fades: [{ at: 't', c: '#e0609a', size: 100, a: 12 }], cell: '#12080d', op: 92, line: true, corners: 'normal', tint: 'spectrum', acc: '#f381b4', pal: 't_rose-inlay' },
  'dusk-bloom': { name: 'Dusk Bloom', fam: 'Pinks', base: '#0e080c', fades: [{ at: 'b', c: '#ff5a78', size: 100, a: 30 }, { at: 'tr', c: '#a03ab0', size: 60, a: 24 }], cell: '#1c1218', op: 58, line: true, corners: 'normal', tint: 'spectrum', acc: '#ff7191', pal: 't_dusk-bloom' },
  camellia: { name: 'Camellia', fam: 'Pinks', base: '#110a0d', fades: [{ at: 't', c: '#e0507a', size: 100, a: 22 }], cell: '#23121a', op: 80, line: true, corners: 'sharp', tint: 'spectrum', acc: '#ff6692', pal: 't_camellia' },
  rose: { name: 'Rose', fam: 'Pinks', base: '#120c0d', fades: [{ at: 'b', c: '#b85a6a', size: 95, a: 26 }], cell: '#1c1314', op: 75, line: true, corners: 'round', tint: 'spectrum', acc: '#df8797', pal: 't_rose' },
  flamingo: { name: 'Flamingo', fam: 'Pinks', base: '#120a0c', fades: [{ at: 'tl', c: '#ff5a8a', size: 80, a: 30 }, { at: 'br', c: '#ff9a4a', size: 75, a: 26 }], cell: '#1f1416', op: 60, line: true, corners: 'normal', tint: 'spectrum', acc: '#ff4994', pal: 't_flamingo' },
  toxic: { name: 'Toxic', fam: 'Mixes', base: '#070a05', fades: [{ at: 'bl', c: '#7ad010', size: 85, a: 26 }, { at: 'tr', c: '#d0d010', size: 60, a: 18 }], cell: '#10170a', op: 60, line: true, corners: 'sharp', tint: 'spectrum', acc: '#a5e212', pal: 't_toxic' },
  circuit: { name: 'Circuit', fam: 'Mixes', base: '#09090b', fades: [{ at: 'l', c: '#f0e010', size: 60, a: 18 }, { at: 'r', c: '#10e0f0', size: 60, a: 18 }], cell: '#121519', op: 70, line: true, corners: 'sharp', tint: 'spectrum', acc: '#dbec18', pal: 't_circuit' },
  tropical: { name: 'Tropical', fam: 'Mixes', base: '#071010', fades: [{ at: 'bl', c: '#10b0a0', size: 85, a: 28 }, { at: 'tr', c: '#ff8a3a', size: 70, a: 24 }], cell: '#0c1918', op: 58, line: true, corners: 'normal', tint: 'spectrum', acc: '#ffa04a', pal: 't_tropical' },
  inkwell: { name: 'Inkwell', fam: 'Mixes', base: '#070a14', fades: [{ at: 'tl', c: '#2a3a9a', size: 80, a: 26 }], cell: '#200e18', op: 60, line: true, corners: 'sharp', tint: 'spectrum', acc: '#fd90c2', pal: 't_inkwell' },
  mosaic: { name: 'Mosaic', fam: 'Mixes', base: '#07080f', fades: [{ at: 'tl', c: '#2a4ad0', size: 75, a: 30 }, { at: 'br', c: '#c8902a', size: 70, a: 22 }], cell: '#0e1226', op: 62, line: true, corners: 'sharp', tint: 'spectrum', acc: '#91acfd', pal: 't_mosaic' },
  peacock: { name: 'Peacock', fam: 'Mixes', base: '#070c10', fades: [{ at: 'tl', c: '#1a8a9a', size: 80, a: 30 }, { at: 'br', c: '#6a3ac0', size: 75, a: 28 }], cell: '#0e1722', op: 60, line: true, corners: 'round', tint: 'spectrum', acc: '#9a5cf0', pal: 't_peacock' },
  prism: { name: 'Prism', fam: 'Mixes', base: '#0a0a10', fades: [{ at: 'tl', c: '#ff5a5a', size: 60, a: 22 }, { at: 'tr', c: '#5aff9a', size: 60, a: 18 }, { at: 'b', c: '#5a8aff', size: 80, a: 24 }], cell: '#15151f', op: 50, line: true, corners: 'round', tint: 'spectrum', acc: '#c0b0ff', pal: 't_prism' },
  twilight: { name: 'Twilight', fam: 'Mixes', base: '#0d0a12', fades: [{ at: 'b', c: '#d0703a', size: 80, a: 22 }, { at: 't', c: '#3a3a9a', size: 85, a: 30 }], cell: '#18142a', op: 55, line: true, corners: 'normal', tint: 'spectrum', acc: '#f0a060', pal: 't_twilight' },
  aurora: { name: 'Aurora', fam: 'Mixes', base: '#0a0b14', fades: [{ at: 'tl', c: '#7052e0', size: 75, a: 38 }, { at: 'br', c: '#1ca8be', size: 80, a: 30 }], cell: '#121326', op: 55, line: true, corners: 'round', tint: 'spectrum', acc: '#9d8cff', pal: 't_aurora' },
  neon: { name: 'Neon', fam: 'Mixes', base: '#0b0c10', fades: [{ at: 'l', c: '#2f6fe0', size: 60, a: 30 }, { at: 'r', c: '#e0407a', size: 60, a: 26 }], cell: '#14151c', op: 55, line: true, corners: 'sharp', tint: 'spectrum', acc: '#93b4fd', pal: 't_neon' },
  plasma: { name: 'Plasma', fam: 'Mixes', base: '#0c060c', fades: [{ at: 'tl', c: '#4a3af0', size: 70, a: 26 }, { at: 'b', c: '#f03a8a', size: 70, a: 24 }, { at: 'r', c: '#f0703a', size: 45, a: 16 }], cell: '#170c1a', op: 58, line: true, corners: 'sharp', tint: 'spectrum', acc: '#ff5aa0', pal: 't_plasma' },
  vapor: { name: 'Vapor', fam: 'Mixes', base: '#0e0a14', fades: [{ at: 'tl', c: '#ff6ad0', size: 75, a: 26 }, { at: 'br', c: '#6ae0ff', size: 75, a: 24 }], cell: '#120d1c', op: 56, line: true, corners: 'round', tint: 'spectrum', acc: '#ffa9e6', pal: 't_vapor' },
  synthwave: { name: 'Synthwave', fam: 'Mixes', base: '#0c0814', fades: [{ at: 'b', c: '#ff3a9a', size: 90, a: 32 }, { at: 't', c: '#2ac0e0', size: 70, a: 22 }], cell: '#18122a', op: 50, line: true, corners: 'sharp', tint: 'spectrum', acc: '#ff4fae', pal: 't_synthwave' },
  sunset: { name: 'Sunset', fam: 'Mixes', base: '#0d0a0a', fades: [{ at: 'b', c: '#d9572b', size: 95, a: 30 }, { at: 'tr', c: '#7a34b8', size: 55, a: 22 }], cell: '#1c1515', op: 60, line: true, corners: 'normal', tint: 'spectrum', acc: '#ff8c42', pal: 't_sunset' },
};
const lcHex = c => c.toLowerCase(), clampN = (v, lo, hi, d) => v !== null && v !== '' && Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d;
const cleanFade = f => f && FADE_AT[f.at] && isHex(f.c) ? { at: f.at, c: lcHex(f.c), size: clampN(f.size, 20, 100, 70), a: clampN(f.a, 5, 80, 30) } : null;
// a saved look made whole. One from before 11-05 (cards and a colour) opens as its theme with the colour it had:
// Standard as Classic, OLED (and Outline, the first afternoon of 11-02) as OLED, Soft as Soft
const THEME_GONE = { warm: 'caramel', ingot: 'classic', chestnut: 'classic', berry: 'classic', pomegranate: 'classic', fudge: 'classic', merlot: 'classic', 'berry-dusk': 'classic', tanzanite: 'classic', canopy: 'classic', drizzle: 'classic', bullion: 'classic', scarlet: 'classic', inlet: 'classic' };   // (themes taken out, 11-09: Warm's nearest is Caramel; the 13 the swarm cut, and anything else unknown, Classic)
function cleanLook(o) {
  o = o && typeof o === 'object' ? o : {};
  if (o.theme && !THEME_PRESETS[o.theme] && !o.cards) { const to = THEME_GONE[o.theme] || 'classic'; o = o.changed === true ? Object.assign({}, o, { theme: to }) : Object.assign(JSON.parse(JSON.stringify(THEME_PRESETS[to])), { theme: to, changed: false, pops: o.pops }); }   // (a theme taken out: its nearest, as it came or with your changes, 11-09)
  const theme = THEME_PRESETS[o.theme] ? o.theme : o.cards === 'oled' || o.cards === 'outline' ? 'oled' : o.cards === 'soft' ? 'soft' : 'classic', P = THEME_PRESETS[theme];
  const own = isHex(o.base) && isHex(o.cell);   // (a look of 11-05 on: its own background and cells)
  const seen = new Set(), fades = own && Array.isArray(o.fades) ? o.fades.map(cleanFade).filter(f => f && !seen.has(f.at) && seen.add(f.at)) : P.fades.map(f => Object.assign({}, f));
  const r = { theme, changed: own && o.changed === true, base: own ? lcHex(o.base) : P.base, fades, cell: own ? lcHex(o.cell) : P.cell, op: own ? clampN(o.op, 0, 100, P.op) : P.op, line: own ? o.line !== false : P.line,
    corners: own && THEMES.corners.includes(o.corners) ? o.corners : P.corners, tint: THEMES.tint.includes(o.tint) ? o.tint : 'none', acc: isHex(o.acc) ? lcHex(o.acc) : ACC0,
    pal: Object.prototype.hasOwnProperty.call(PALETTES, o.pal) ? o.pal : 'muted', pops: o.pops === 'view' ? 'view' : 'cells' };   // (popups: Cells unless View was picked, his 11-09)
  // (11-09, the Look page: corners in px and the outline's strength from its sliders, kept only when set; the saved look it came from)
  const rad = own ? clampN(o.rad, 0, 24, null) : null, la = own ? clampN(o.lineA, 10, 200, 100) : 100;
  if (rad != null) r.rad = rad; if (la !== 100) r.lineA = la; if (typeof o.from === 'string' && o.from) r.from = o.from.slice(0, 32);
  return r;
}
// a saved look (11-09): its id, name, the look (as cleanLook makes it, not its popups) and its categories' own colours
const cleanSaved = a => { const seen = new Set(); return (Array.isArray(a) ? a : []).filter(x => x && typeof x === 'object' && typeof x.id === 'string' && x.id && x.look && typeof x.look === 'object' && !seen.has(x.id) && seen.add(x.id)).slice(0, 12).map(x => {
  const l = cleanLook(Object.assign({}, x.look, { changed: true })); l.changed = false; delete l.from; delete l.pops;
  const cols = x.cols && typeof x.cols === 'object' ? Object.fromEntries(Object.entries(x.cols).filter(([k, v]) => k && isHex(v)).slice(0, 64).map(([k, v]) => [k, v.toLowerCase()])) : {};
  return { id: x.id.slice(0, 32), name: (typeof x.name === 'string' && x.name.trim() ? x.name.trim() : 'Saved').slice(0, 40), look: l, cols }; }); };
// (11-09, white accents: a saved state's Classic or OLED look still on the old blue its theme or palette gave it takes the
// white, once, as it loads; a look from a save or any other theme keeps its colour. 2.4.3's OLED came with Muted, which
// shows nowhere under Mono: its own palette then, so it isn't "changed")
const lookUp = o => {
  if (!o || typeof o !== 'object' || o.from) return o;
  const th = o.theme || (o.cards === 'oled' || o.cards === 'outline' ? 'oled' : o.cards === 'soft' ? 'soft' : 'classic');
  if (!ACC_OLD[th]) return o;
  o = Object.assign({}, o);
  if (isHex(o.acc) && Object.values(ACC_OLD).includes(o.acc.toLowerCase()) && (o.pal == null || ['muted', 't_oled', 't_classic'].includes(o.pal))) o.acc = ACC0;
  if (th === 'oled' && o.pal === 'muted' && (o.tint == null || o.tint === 'none')) o.pal = 't_oled';
  return o;
};
const lookPlain = () => S.look.theme === 'classic' && !S.look.changed && S.look.tint === 'none' && S.look.acc === ACC0 && S.look.pal === 'muted' && S.look.pops !== 'view' && S.look.rad == null && S.look.lineA == null && !S.look.from;
// colours: a hex mixed toward another (t of b), as rgba, its hue, and one made from a hue
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
// (edit mode's lines and outlines are the accent, lifted toward white when it is too dark to see on the dark view: its
// light at least 0.18; Classic's white is far above it, 11-09)
const relLum = h => { const [r, g, b] = hexRgb(h).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const editCol = h => { if (!/^#[0-9a-f]{6}$/i.test(h || '')) return ACC0; let c = h; for (let i = 0; i < 12 && relLum(c) < 0.18; i++) c = mixHex(c, '#ffffff', 0.12); return c; };
// (Mono shows the accent nowhere, his 11-10 "the accent color should not display when it's on mono": edit mode's colour
// is the plain white there; the look keeps its accent for Accent and Spectrum)
const editOf = L => editCol(L.tint === 'none' ? ACC0 : L.acc);
const rgbaOf = (h, a) => 'rgba(' + hexRgb(h).join(', ') + ', ' + a + ')';
function hueOf(h) { const [r, g, b] = hexRgb(h).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return [0, 0]; const l = (mx + mn) / 2; return [(mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60, (l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)) * 100]; }
function lookHsl(h, s, l) { h = ((h % 360) + 360) % 360; s /= 100; l /= 100; const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); }
// Match: each part's colour spread between the fades' hues (one fade: around its hue; none: around the base's, or
// Muted's when the base is a grey), light enough to read on the cells; its accent the first fade's hue
function palMatch(L) {
  let hs = L.fades.map(f => hueOf(f.c)).filter(x => x[1] >= 15).map(x => x[0]);   // (a grey or white fade has no hue: it read as red, 11-06)
  if (!hs.length) { const [h, s] = hueOf(L.base); if (s < 15) return [Object.assign({}, PALETTES.muted[1]), PALETTES.muted[2]]; hs = [h]; }
  const d = hs.length > 1 ? ((hs[1] - hs[0] + 540) % 360) - 180 : 0;
  const pts = hs.length > 1 ? [-0.15, 0.12, 0.38, 0.62, 0.88, 1.15].map(t => hs[0] + d * t) : [-60, -30, 0, 30, 60, 90].map(x => hs[0] + x);
  const o = {}; ['game', 'gpu', 'mem', 'drive', 'cpu', 'fan'].forEach((k, i) => { o[k] = lookHsl(pts[i], 65, 70); });
  return [o, lookHsl(hs[0], 70, 72)];
}
// the background (its fades over the base), a cell's fill (see-through below 100%), its line
const bgiOf = L => L.fades.map(f => { const [x, y] = FADE_AT[f.at], w = f.size * (y === 50 ? 0.9 : 1.15), h = f.size * (x === 50 ? 0.9 : 1.25);
  return 'radial-gradient(' + w + '% ' + h + '% at ' + x + '% ' + y + '%, ' + rgbaOf(f.c, f.a / 100) + ', transparent 72%)'; }).concat([L.base]).join(', ');
const tileOf = L => L.op >= 100 ? L.cell : rgbaOf(L.cell, L.op / 100);
const solidOf = L => mixHex(L.base, L.cell, L.op / 100);   // (a see-through cell over the base)
const lineOf = L => L.line ? mixHex(solidOf(L), '#ffffff', Math.min(1, (0.0655 + (1 - L.op / 100) * 0.0835) * (L.lineA || 100) / 100)) : 'transparent';   // (the less cell, the brighter its line: OLED's still shows)
// the tokens: the popups, drawers, fields and Settings in the cells' colour. Classic gives the greys of before exactly
function lookVars(L) {
  const solid = solidOf(L), line = lineOf(L), tile = tileOf(L), R = L.rad != null ? [(L.rad / 13).toFixed(3) + 'rem', (L.rad / 13 + 0.15).toFixed(3) + 'rem'] : { sharp: ['0.25rem', '0.35rem'], normal: ['0.77rem', '0.92rem'], round: ['1.05rem', '1.2rem'] }[L.corners], up = t => mixHex(solid, '#ffffff', t);
  return { '--bg': L.base, '--bgi': bgiOf(L), '--tile': tile, '--tile-solid': solid, '--tile-line': line, '--card-line': L.line ? mixHex(solid, '#ffffff', Math.min(1, (0.0611 + (1 - L.op / 100) * 0.0879) * (L.lineA || 100) / 100)) : 'transparent',   // (a step under the tile's: Classic #232323, OLED #262626, as before)
    '--nav': tile, '--nav-line': line,
    '--rule': L.line ? up(0.0556 + (1 - L.op / 100) * 0.045) : 'transparent', '--tile-sh': L.line ? 'none' : '0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 6px 18px rgba(0, 0, 0, 0.35)',
    '--tile-r': R[0], '--card-r': R[1], '--side': mixHex(L.base, solid, 0.25), '--panel': solid, '--raise': up(0.028), '--line': up(0.0655), '--line2': up(0.1282),
    '--pop': solid, '--pop-line': up(0.1), '--pop2': up(0.0043), '--pop2-line': up(0.106), '--box': up(0.017), ...gToks(L) };
}
// every grey a surface had, made the look's (11-09, his "if a theme is choosen you need to stick to the theme, cant go for any
// gray/black things anywhere"): the same step from the cells' colour as from Classic's #151515, toward white or black, so
// Classic keeps its greys exactly. deck.css reads them as var(--gNN, #nnnnnn); gv() gives one to what the page draws
const G_LV = ['0f', '10', '12', '14', '15', '16', '17', '18', '19', '1a', '1b', '1c', '1d', '1e', '1f', '20', '21', '22', '23', '24', '25', '26', '28', '2a', '2b', '2c', '2e', '30', '33', '34', '36', '3a', '44', '47', '4a', '55', '6a', '8a'];
// (OLED, his pick C 11-09: cells darker than a near-black floor step their greys from the floor, so popups, menus and
// panels keep their rows and lines on a black view; the view's own colours are the look's, not these)
const G_FLOOR = '#0d0d0d', G_FLUM = relLum(G_FLOOR);
const gBase = L => { const s = solidOf(L); if (relLum(s) >= G_FLUM) return s; const c = hexRgb(s); for (let k = 1; k <= 13; k++) { const h = '#' + c.map(v => Math.min(255, v + k).toString(16).padStart(2, '0')).join(''); if (relLum(h) >= G_FLUM) return h; } return G_FLOOR; };   // (lifted by the same step on each channel: a near-black's tint kept; black becomes #0d0d0d)
const gOf = (L, v) => { const s = gBase(L); return v >= 0x15 ? mixHex(s, '#ffffff', (v - 0x15) / 234) : mixHex(s, '#000000', (0x15 - v) / 0x15); };
const gToks = L => { const o = {}; for (const h of G_LV) o['--g' + h] = gOf(L, parseInt(h, 16)); return o; };
const GV = new Map(), gv = h => { let c = GV.get(h); if (c === undefined) { c = gOf(S.look, parseInt(h.slice(1, 3), 16)); GV.set(h, c); } return c; };
function applyLook() {
  const d = document.documentElement, L = S.look, m = palMatch(L);
  d.classList.add('lk-now'); requestAnimationFrame(() => requestAnimationFrame(() => d.classList.remove('lk-now')));   // (a new look all at once: tiles faded over 300 ms behind the rest, 11-06)
  PALETTES.match[1] = m[0]; PALETTES.match[2] = m[1];   // (Match always the current background's: its dots in Colours too)
  delete d.dataset.cards; d.dataset.tint = L.tint; d.dataset.pops = L.pops; d.style.setProperty('--acc', L.acc); d.style.setProperty('--edit', editOf(L)); GV.clear();
  const v = lookVars(L); for (const k in v) d.style.setProperty(k, v[k]);
  TINT.clear(); paintGc();
}
// Spectrum: a category takes the colour you gave it (cat.col, saved with the layout), else the colour of the part most
// of its cells read (more than half of those that tell); a mix, or readings of nothing in particular (the board, the
// network, your own), stay grey
// (the palettes: [name, a colour per part, the accent]. 11-02, his "all too similar": each one a family of its own or a
// set of clearly different hues; Dusk is the one he set by hand on his dashboard, Fire his ask)
const PALETTES = {
  match: ['Match', { game: '#a99bdc', gpu: '#74c69d', cpu: '#7fa6e8', mem: '#4fb8ad', drive: '#8fa0c8', fan: '#6cc8d8' }, '#ffffff'],   // (the background's: applyLook sets it)
  muted: ['Muted', { game: '#a99bdc', gpu: '#74c69d', cpu: '#7fa6e8', mem: '#4fb8ad', drive: '#8fa0c8', fan: '#6cc8d8' }, '#ffffff'],   // (Classic's: its white accent, 11-09)
  dusk: ['Dusk', { game: '#8fa0c8', gpu: '#d98aa8', cpu: '#c79ad6', mem: '#a99bdc', drive: '#4fb8ad', fan: '#74c69d' }, '#c79ad6'],
  fire: ['Fire', { game: '#ff7a5c', gpu: '#ff9f43', cpu: '#ffc15e', mem: '#f6d06f', drive: '#e8735a', fan: '#ff5d73' }, '#ff9f43'],
  ocean: ['Ocean', { game: '#8c9bff', gpu: '#4cc9f0', cpu: '#4895ef', mem: '#56cfe1', drive: '#6c6fd8', fan: '#64dfdf' }, '#4895ef'],
  forest: ['Forest', { game: '#b5c95a', gpu: '#52b788', cpu: '#95d5b2', mem: '#40a378', drive: '#b7b7a4', fan: '#74c69d' }, '#52b788'],
  sunset: ['Sunset', { game: '#a66cff', gpu: '#ff8c42', cpu: '#ff6b8b', mem: '#ffb05c', drive: '#c77dff', fan: '#f45b9a' }, '#ff8c42'],
  rainbow: ['Rainbow', { game: '#b392f0', gpu: '#85e89d', cpu: '#79b8ff', mem: '#ffab70', drive: '#f97583', fan: '#ffea7f' }, '#79b8ff'],
  candy: ['Candy', { game: '#cdb4db', gpu: '#b9e4a0', cpu: '#a2d2ff', mem: '#ffc8dd', drive: '#ffafcc', fan: '#bde0fe' }, '#a2d2ff'],
  neon: ['Neon', { game: '#c77dff', gpu: '#00f5a0', cpu: '#00bbf9', mem: '#fee440', drive: '#f15bb5', fan: '#00f5d4' }, '#00bbf9'],
  rose: ['Rose', { game: '#c77dff', gpu: '#ff7ab8', cpu: '#ff9ac0', mem: '#f6b0d0', drive: '#e06a9a', fan: '#ffb3c7' }, '#ff7ab8'],
  coffee: ['Coffee', { game: '#c8915f', gpu: '#e3b07a', cpu: '#d29a7a', mem: '#e8cfa8', drive: '#a87a5a', fan: '#c8a878' }, '#c8915f'],
  // (each theme's own, 11-09: t_<its id>)
  't_oled': ['OLED', { game: '#9cb0f4', gpu: '#d8b0f0', cpu: '#7fdcd6', mem: '#c4ccdc', drive: '#8c94e8', fan: '#b4e8f0' }, '#ffffff'],
  't_halftone': ['Halftone', { game: '#4ab8e0', gpu: '#e070b0', cpu: '#d8d098', mem: '#b4a490', drive: '#8a9cc0', fan: '#e88a70' }, '#a8b8cc'],
  't_graphite': ['Graphite', { game: '#9eadc4', gpu: '#b9a6dc', cpu: '#78b2dc', mem: '#d6dde8', drive: '#88c3c4', fan: '#a7c4a2' }, '#9aa5b4'],
  't_smoke': ['Smoke', { game: '#9c94c0', gpu: '#e89a70', cpu: '#7fb0b8', mem: '#c8b8a8', drive: '#b884a8', fan: '#c0b890' }, '#c6c6cc'],
  't_chrome': ['Chrome', { game: '#c2d0e2', gpu: '#dcaab0', cpu: '#a7bcb2', mem: '#ece0c4', drive: '#e0a988', fan: '#94acd4' }, '#c2d0e2'],
  't_classic': ['Classic', { game: '#9aaed4', gpu: '#b6a2d0', cpu: '#8ec8c4', mem: '#e6dcc6', drive: '#b2c68e', fan: '#d6a88a' }, '#ffffff'],
  't_stone': ['Stone', { game: '#d4b48c', gpu: '#c88470', cpu: '#a8a49c', mem: '#e4d8c4', drive: '#a68ea0', fan: '#a07858' }, '#c2b6a8'],
  't_steel': ['Steel', { game: '#8aa4be', gpu: '#c8b48c', cpu: '#9a8fc0', mem: '#c0ccd8', drive: '#a8846e', fan: '#7fa6a8' }, '#8aa4be'],
  't_soft': ['Soft', { game: '#c4a8b8', gpu: '#b0aed4', cpu: '#a8c4ac', mem: '#ece4dc', drive: '#92bcd0', fan: '#d8b898' }, '#c4a8b8'],
  't_carbon': ['Carbon', { game: '#b0c0d8', gpu: '#e8a878', cpu: '#7fa8e0', mem: '#b8a0d0', drive: '#9cd0b8', fan: '#d898a0' }, '#d8d8d8'],
  't_espresso': ['Espresso', { game: '#eda967', gpu: '#f5764b', cpu: '#d9a6c8', mem: '#bb896f', drive: '#c1b795', fan: '#c6675d' }, '#e2a468'],
  't_latte': ['Latte', { game: '#f5c180', gpu: '#f0a070', cpu: '#c08a8a', mem: '#dcc0a0', drive: '#b19dc8', fan: '#8c7458' }, '#f0cfa4'],
  't_saddle': ['Saddle', { game: '#f58e4f', gpu: '#d2616c', cpu: '#f3c9a1', mem: '#fff7e2', drive: '#c5a55c', fan: '#a86f57' }, '#f4a06a'],
  't_leather': ['Leather', { game: '#be4e70', gpu: '#e4a279', cpu: '#a86e88', mem: '#f0d8c8', drive: '#935f44', fan: '#c86a40' }, '#d86a7e'],
  't_fireside': ['Fireside', { game: '#fca47b', gpu: '#b36b61', cpu: '#ccb498', mem: '#f6e8dc', drive: '#837255', fan: '#8da285' }, '#eaa580'],
  't_timber': ['Timber', { game: '#cf9c61', gpu: '#c8714e', cpu: '#d9a7a0', mem: '#8c6d3f', drive: '#ac9a82', fan: '#8ea46f' }, '#d2a06a'],
  't_cognac': ['Cognac', { game: '#f39a4a', gpu: '#f0c080', cpu: '#c8a0c0', mem: '#fbe6cc', drive: '#c07a50', fan: '#946474' }, '#f6aa68'],
  't_copper': ['Copper', { game: '#ee8044', gpu: '#efa390', cpu: '#6ec3ab', mem: '#ffe9df', drive: '#b48659', fan: '#c7b098' }, '#f09a64'],
  't_mocha': ['Mocha', { game: '#eb9e72', gpu: '#ee9aa5', cpu: '#f5d7c3', mem: '#aa8d87', drive: '#c3a0c2', fan: '#a3724f' }, '#e8a684'],
  't_sand': ['Sand', { game: '#e8c792', gpu: '#de7f5e', cpu: '#9cb98d', mem: '#fbf0d6', drive: '#a48a67', fan: '#b38f94' }, '#d9c49a'],
  't_ember': ['Ember', { game: '#ff7a42', gpu: '#ffb35a', cpu: '#ff8fa3', mem: '#ffd4b0', drive: '#d4b2a4', fan: '#a99bbd' }, '#ff6a3d'],
  't_ruby': ['Ruby', { game: '#ff3f6e', gpu: '#ff7e5a', cpu: '#a99cff', mem: '#ffb8cc', drive: '#e85ab0', fan: '#9fa8d8' }, '#ff5c8a'],
  't_garnet': ['Garnet', { game: '#f2507e', gpu: '#ffa090', cpu: '#c46aa8', mem: '#ffd0dc', drive: '#b88aa8', fan: '#d8a088' }, '#f25a84'],
  't_rust': ['Rust', { game: '#ff7a2a', gpu: '#f8b090', cpu: '#c05040', mem: '#b8a090', drive: '#e08a50', fan: '#e8d0b0' }, '#ff7f3a'],
  't_carmine': ['Carmine', { game: '#ff5ca8', gpu: '#ff8466', cpu: '#f4c8a0', mem: '#ffb8d4', drive: '#c87ab0', fan: '#e0a070' }, '#ff80b4'],
  't_coral': ['Coral', { game: '#ff8a6e', gpu: '#ffb48a', cpu: '#c0aef0', mem: '#ffd8c8', drive: '#ff9cb4', fan: '#e0b890' }, '#ff8a70'],
  't_martian': ['Martian', { game: '#ff8a50', gpu: '#ffc890', cpu: '#e08c8c', mem: '#e8c0a8', drive: '#c87050', fan: '#c8a0b0' }, '#ffa070'],
  't_velvet': ['Velvet', { game: '#ff4f86', gpu: '#e8b878', cpu: '#e08aa0', mem: '#ffe0d0', drive: '#b07868', fan: '#ff9a7a' }, '#ff6a98'],
  't_lava': ['Lava', { game: '#ff6418', gpu: '#ff9a00', cpu: '#ff4f8a', mem: '#ffc070', drive: '#d86a60', fan: '#b07868' }, '#ff7a20'],
  't_sunflower': ['Sunflower', { game: '#f0a81e', gpu: '#e8722c', cpu: '#f6c48c', mem: '#ecd89a', drive: '#b9c26a', fan: '#a87848' }, '#f0a020'],
  't_brushedgold': ['Brushed Gold', { game: '#e8a030', gpu: '#98b0d8', cpu: '#c87848', mem: '#e6d2a0', drive: '#e8808a', fan: '#9cc8b0' }, '#e8a030'],
  't_midas': ['Midas', { game: '#f0a828', gpu: '#ff9850', cpu: '#ffd8b0', mem: '#c88a50', drive: '#e8b4a0', fan: '#d07850' }, '#f0a828'],
  't_citrine': ['Citrine', { game: '#f5a800', gpu: '#ff8a3d', cpu: '#ff7f9e', mem: '#f8dc8a', drive: '#c4581a', fan: '#8fd04a' }, '#f5a000'],
  't_gilded': ['Gilded', { game: '#f2b048', gpu: '#d9844a', cpu: '#e3a0b4', mem: '#f0dcc0', drive: '#8fcfb8', fan: '#b8946a' }, '#e3ae51'],
  't_caramel': ['Caramel', { game: '#f8a848', gpu: '#ff7088', cpu: '#ffd4a0', mem: '#a87458', drive: '#e8885a', fan: '#d8b0a0' }, '#f8a040'],
  't_goldleaf': ['Gold Leaf', { game: '#f8b444', gpu: '#d87a8a', cpu: '#f4e0b8', mem: '#c8a878', drive: '#b06048', fan: '#e8987a' }, '#f4b048'],
  't_honeycomb': ['Honeycomb', { game: '#ffb030', gpu: '#ff8466', cpu: '#e0a8e8', mem: '#ffe6b8', drive: '#d88a3a', fan: '#ffd890' }, '#f5a742'],
  't_saffron': ['Saffron', { game: '#ffa040', gpu: '#f59ab8', cpu: '#ff7652', mem: '#ffe0bc', drive: '#b4a0ff', fan: '#a6d38a' }, '#ff9f40'],
  't_evergreen': ['Evergreen', { game: '#4fd08a', gpu: '#b5e36a', cpu: '#4cc3d6', mem: '#e4f2df', drive: '#2f9f68', fan: '#8fc9a6' }, '#4fd08a'],
  't_grove': ['Grove', { game: '#62c46a', gpu: '#e8d8a0', cpu: '#4fc8a0', mem: '#c8ecc0', drive: '#2e8c46', fan: '#b89a78' }, '#62c46a'],
  't_cypress': ['Cypress', { game: '#04cca8', gpu: '#7fe0a0', cpu: '#3fb8e0', mem: '#c8f0ea', drive: '#1f9f8a', fan: '#8fb8f0' }, '#04cca8'],
  't_clover': ['Clover', { game: '#2fe472', gpu: '#a0e8c0', cpu: '#3fa060', mem: '#e0f0c0', drive: '#e0a0d0', fan: '#88c070' }, '#2fe472'],
  't_ivy': ['Ivy', { game: '#1ec97a', gpu: '#7fd860', cpu: '#3aa8a0', mem: '#c0e8b0', drive: '#5a9a50', fan: '#c8c888' }, '#1ec97a'],
  't_pinewood': ['Pinewood', { game: '#10b870', gpu: '#d08848', cpu: '#2aa8a0', mem: '#c0e8c8', drive: '#1f8a50', fan: '#e8c8a0' }, '#10b870'],
  't_matrix': ['Matrix', { game: '#c4ff6a', gpu: '#2af06a', cpu: '#8affd0', mem: '#40c8f0', drive: '#c8d4c8', fan: '#e0f0a0' }, '#2aff6a'],
  't_malachite': ['Malachite', { game: '#1ceca7', gpu: '#8ae070', cpu: '#4ac8c0', mem: '#b7f6e2', drive: '#12a07a', fan: '#c8e8a0' }, '#1ceca7'],
  't_nettle': ['Nettle', { game: '#7ad030', gpu: '#c0e848', cpu: '#3fb0b0', mem: '#c8eab0', drive: '#3f9a40', fan: '#80a860' }, '#7ad030'],
  't_moss': ['Moss', { game: '#a8c060', gpu: '#c8a070', cpu: '#7fc0a8', mem: '#e0e8c8', drive: '#6f8a3c', fan: '#9fd890' }, '#a8c060'],
  't_sage': ['Sage', { game: '#8fca98', gpu: '#c8d890', cpu: '#5aa8a8', mem: '#d0e8c0', drive: '#4f9070', fan: '#98b8a8' }, '#78e47f'],
  't_deepsea': ['Deep sea', { game: '#15d8eb', gpu: '#5b8cff', cpu: '#3cf0c4', mem: '#c2f2fa', drive: '#a88cff', fan: '#1ea4c4' }, '#15d8eb'],
  't_jade': ['Jade', { game: '#08e092', gpu: '#a8d8b0', cpu: '#2ab8b8', mem: '#e8f0c8', drive: '#5aa880', fan: '#88e8e0' }, '#08e092'],
  't_offshore': ['Offshore', { game: '#16c8e0', gpu: '#9cc870', cpu: '#5a8ce8', mem: '#d0f4f4', drive: '#58e0a8', fan: '#2a8cb8' }, '#16c8e0'],
  't_cyan-line': ['Cyan line', { game: '#2ad4e0', gpu: '#8af0f8', cpu: '#12a0b0', mem: '#7ad8c0', drive: '#4ab8f0', fan: '#a0c8d0' }, '#2ad4e0'],
  't_pier-lights': ['Pier lights', { game: '#24f3ff', gpu: '#ffb860', cpu: '#4ab8d0', mem: '#d0a070', drive: '#e8805a', fan: '#2cc8a8' }, '#0bd1db'],
  't_spiral': ['Spiral', { game: '#10e2cf', gpu: '#6a9cdc', cpu: '#7ef0b0', mem: '#f0dcea', drive: '#3cb8d8', fan: '#b4a8f0' }, '#10e2cf'],
  't_dusk-tide': ['Dusk tide', { game: '#13ddd4', gpu: '#b48cff', cpu: '#4ab0e8', mem: '#d8c8ff', drive: '#e890d8', fan: '#6ce8b0' }, '#13ddd4'],
  't_night-lagoon': ['Night lagoon', { game: '#00b4cc', gpu: '#6a74ff', cpu: '#00cca8', mem: '#a8c0ff', drive: '#a868f0', fan: '#2a7cc0' }, '#00b4cc'],
  't_frostwater': ['Frostwater', { game: '#8cd8e4', gpu: '#8ab4f4', cpu: '#90e8b8', mem: '#b8f0e0', drive: '#48bcb8', fan: '#4f80b8' }, '#8cd8e4'],
  't_mint': ['Mint', { game: '#1ef4bb', gpu: '#4ad8f0', cpu: '#a8ec84', mem: '#d0f8ec', drive: '#7ab8ff', fan: '#3aa888' }, '#1ef4bb'],
  't_blue-hour': ['Blue Hour', { game: '#8c9cff', gpu: '#c08cff', cpu: '#62b6ff', mem: '#dcd8ff', drive: '#e89ad6', fan: '#86d2f2' }, '#98b1ff'],
  't_ultramarine': ['Ultramarine', { game: '#7479ff', gpu: '#4caeff', cpu: '#b07aff', mem: '#ccd3ff', drive: '#33d4e6', fan: '#5f8cf0' }, '#6a72ff'],
  't_sapphire': ['Sapphire', { game: '#3a70f8', gpu: '#b098ff', cpu: '#40c8f0', mem: '#dcd0ff', drive: '#6a8ce0', fan: '#90e8e8' }, '#7699fe'],
  't_blueprint': ['Blueprint', { game: '#6fb0ff', gpu: '#2f7bff', cpu: '#b8d4f4', mem: '#7f9cc8', drive: '#8a8cff', fan: '#4fd0ff' }, '#8ec5ff'],
  't_horizon': ['Horizon', { game: '#6f9cff', gpu: '#78dcff', cpu: '#5a6cf0', mem: '#a9c4ff', drive: '#3cbcf0', fan: '#6ae0c0' }, '#88adfe'],
  't_zenith': ['Zenith', { game: '#5c86ff', gpu: '#8ae8ff', cpu: '#4a64ff', mem: '#b8c8ff', drive: '#e0b0ff', fan: '#2ab8ff' }, '#7397fe'],
  't_cobalt': ['Cobalt', { game: '#5a78e8', gpu: '#98d0dc', cpu: '#9cb4f4', mem: '#d8c0f0', drive: '#9a88e0', fan: '#4f9ad8' }, '#7890ea'],
  't_navy': ['Navy', { game: '#7a9ad4', gpu: '#6cc4b4', cpu: '#5cc0f0', mem: '#ece8e0', drive: '#a09ad8', fan: '#78acc8' }, '#8aa4d8'],
  't_midnight': ['Midnight', { game: '#6c94ff', gpu: '#aec4ff', cpu: '#9a7cf8', mem: '#74c0f0', drive: '#5a6cf0', fan: '#b8a0f0' }, '#739fff'],
  't_storm': ['Storm', { game: '#6a8ce8', gpu: '#c4b8ff', cpu: '#3cb0d0', mem: '#b0bccc', drive: '#8a7ee0', fan: '#50b8a0' }, '#7a9cf0'],
  't_arctic': ['Arctic', { game: '#5cc8ff', gpu: '#8fe8f0', cpu: '#a8b4ff', mem: '#c0ecff', drive: '#5ee0c0', fan: '#5f8ce0' }, '#94d3fd'],
  't_slate': ['Slate', { game: '#7aa2d6', gpu: '#5cb8e0', cpu: '#9a94e0', mem: '#c8d8ec', drive: '#5a7ed0', fan: '#8ec8d0' }, '#7aa2d6'],
  't_nebula': ['Nebula', { game: '#c39bff', gpu: '#6d7dff', cpu: '#f28ae0', mem: '#ffc8e8', drive: '#4fb0f0', fan: '#e05aa0' }, '#ab85f4'],
  't_royalviolet': ['Royal Violet', { game: '#7a4bee', gpu: '#c162f4', cpu: '#4d79f3', mem: '#cbbcfc', drive: '#74acfe', fan: '#dd40bb' }, '#835ff2'],
  't_cosmos': ['Cosmos', { game: '#9fa5e3', gpu: '#c68bd3', cpu: '#94c7f1', mem: '#e5f0fc', drive: '#8a70b8', fan: '#6ed6ea' }, '#a5abea'],
  't_byzantium': ['Byzantium', { game: '#d86edd', gpu: '#e3b45a', cpu: '#6f8ee8', mem: '#f5dcf2', drive: '#8f62dc', fan: '#deace9' }, '#cf6bd3'],
  't_purpurite': ['Purpurite', { game: '#bf58fd', gpu: '#fb51bc', cpu: '#806bf6', mem: '#efdcfe', drive: '#e99aeb', fan: '#a3aede' }, '#c671fe'],
  't_aubergine': ['Aubergine', { game: '#c084d0', gpu: '#9468f0', cpu: '#dcc4d8', mem: '#b8a0c0', drive: '#e070b0', fan: '#8c8cc8' }, '#ba7bd2'],
  't_grape': ['Grape', { game: '#b471e9', gpu: '#da4786', cpu: '#737ade', mem: '#dedaf7', drive: '#b63caa', fan: '#a2c1e4' }, '#a67df2'],
  't_plum': ['Plum', { game: '#da76bb', gpu: '#e7809e', cpu: '#839fd1', mem: '#f8dbc4', drive: '#a549a9', fan: '#d2acee' }, '#cb6ab2'],
  't_orchid': ['Orchid', { game: '#cd7feb', gpu: '#f070d0', cpu: '#e8c0f4', mem: '#b090f8', drive: '#9a50d0', fan: '#f0a0c8' }, '#ca7ce8'],
  't_lavender': ['Lavender', { game: '#a19cf0', gpu: '#d9a2ef', cpu: '#5593e6', mem: '#e7e5fb', drive: '#a4ccf3', fan: '#a06dbe' }, '#aea7ed'],
  't_mulberry': ['Mulberry', { game: '#ea609c', gpu: '#f8869a', cpu: '#8d75eb', mem: '#fbdae8', drive: '#ac4abb', fan: '#dcadeb' }, '#df67ae'],
  't_blossom': ['Blossom', { game: '#ed9ec7', gpu: '#a798d1', cpu: '#f5b8a8', mem: '#f7e6f0', drive: '#ac77a9', fan: '#e4d6b9' }, '#df94c3'],
  't_dusk-bloom': ['Dusk Bloom', { game: '#ff7499', gpu: '#a584e7', cpu: '#ff9ccb', mem: '#e9d6f2', drive: '#c25ab3', fan: '#e4adf8' }, '#ff7191'],
  't_flamingo': ['Flamingo', { game: '#ff529e', gpu: '#fa9046', cpu: '#c570d5', mem: '#f8c2bf', drive: '#ff9f85', fan: '#e9b87b' }, '#ff4994'],
  't_rose-inlay': ['Rose Inlay', { game: '#f282b0', gpu: '#eac69e', cpu: '#ae88bc', mem: '#f6e4e0', drive: '#e39179', fan: '#c5596e' }, '#f381b4'],
  't_pink-glass': ['Pink Glass', { game: '#fe77be', gpu: '#ad9be6', cpu: '#ffaaa1', mem: '#f1e8f2', drive: '#fec2d2', fan: '#ca5e7c' }, '#fe76c2'],
  't_fuchsia-night': ['Fuchsia Night', { game: '#eb52d0', gpu: '#9b75ef', cpu: '#ff6192', mem: '#ffc6e6', drive: '#ff9dc9', fan: '#dc95f8' }, '#ed4fd1'],
  't_rose': ['Rose', { game: '#e58d9c', gpu: '#b8a3cd', cpu: '#e39983', mem: '#f4dad6', drive: '#e5c09d', fan: '#aa6888' }, '#df8797'],
  't_pink-line': ['Pink Line', { game: '#f070a0', gpu: '#ffb0d0', cpu: '#c050c0', mem: '#ff9a9a', drive: '#e8a0e8', fan: '#d07890' }, '#e987b2'],
  't_azalea': ['Azalea', { game: '#fe5fb7', gpu: '#a77ed7', cpu: '#ff9b76', mem: '#f6ebf1', drive: '#ffaab1', fan: '#bb57a7' }, '#fe5fb7'],
  't_camellia': ['Camellia', { game: '#ff6692', gpu: '#ce6dc4', cpu: '#fbada3', mem: '#fadfe2', drive: '#f3bc84', fan: '#ca5c86' }, '#ff6692'],
  't_sakura': ['Sakura', { game: '#fb96cd', gpu: '#e86a8a', cpu: '#f8d0e0', mem: '#c07090', drive: '#ffb4a8', fan: '#b080a8' }, '#fcb1cc'],
  't_sunset': ['Sunset', { game: '#ff7eb3', gpu: '#ffa064', cpu: '#b993ff', mem: '#ffd9bd', drive: '#e58cf0', fan: '#ff8f8f' }, '#ff8c42'],
  't_aurora': ['Aurora', { game: '#a98bff', gpu: '#5fe3a1', cpu: '#4fd2e6', mem: '#d4f7ec', drive: '#e08af0', fan: '#7aa8ff' }, '#9d8cff'],
  't_twilight': ['Twilight', { game: '#f2a86a', gpu: '#ef8fa8', cpu: '#8f9fff', mem: '#fbe8cf', drive: '#7fc4e8', fan: '#c98fd0' }, '#f0a060'],
  't_synthwave': ['Synthwave', { game: '#ff4fae', gpu: '#c86bff', cpu: '#2ad4f0', mem: '#e6f0ff', drive: '#ff8a5c', fan: '#6a8cff' }, '#ff4fae'],
  't_tropical': ['Tropical', { game: '#1ad3c1', gpu: '#ffa04a', cpu: '#4cb4ff', mem: '#fbe3c0', drive: '#ff86b4', fan: '#7ed96a' }, '#ffa04a'],
  't_peacock': ['Peacock', { game: '#1cb8c8', gpu: '#e8854a', cpu: '#4d6fff', mem: '#a8f0e0', drive: '#9a5cf0', fan: '#20c070' }, '#9a5cf0'],
  't_inkwell': ['Inkwell', { game: '#9ab5fd', gpu: '#f78cb5', cpu: '#6a7cff', mem: '#ffdbe8', drive: '#c48cf0', fan: '#5ec8e0' }, '#fd90c2'],
  't_neon': ['Neon', { game: '#7aa6ff', gpu: '#ff6aa8', cpu: '#c27cff', mem: '#dce8ff', drive: '#4fd8f0', fan: '#ff9ad8' }, '#93b4fd'],
  't_plasma': ['Plasma', { game: '#9a7cff', gpu: '#ff5aa8', cpu: '#5fa8ff', mem: '#ffb8d8', drive: '#ff8a4a', fan: '#e070f0' }, '#ff5aa0'],
  't_mosaic': ['Mosaic', { game: '#e8a848', gpu: '#4a6cf0', cpu: '#e07a5a', mem: '#f4e6c8', drive: '#40c0c0', fan: '#91acfd' }, '#91acfd'],
  't_vapor': ['Vapor', { game: '#ff8ad8', gpu: '#6ae0ff', cpu: '#b89cff', mem: '#ffd8c8', drive: '#7ff0c8', fan: '#8cb4ff' }, '#ffa9e6'],
  't_prism': ['Prism', { game: '#a8a0ff', gpu: '#ff8a7a', cpu: '#6af0a0', mem: '#8ab0ff', drive: '#ffb070', fan: '#60d8f0' }, '#c0b0ff'],
  't_circuit': ['Circuit', { game: '#10e0f0', gpu: '#a8e010', cpu: '#5a9cff', mem: '#e0eaea', drive: '#f09a5a', fan: '#3fdc7a' }, '#dbec18'],
  't_toxic': ['Toxic', { game: '#8ae020', gpu: '#b8f000', cpu: '#30e0c8', mem: '#e0ffc0', drive: '#6ab020', fan: '#40f070' }, '#a5e212'],
};
function partOf(c) {
  if (!c) return null;
  if (c.pred) return 'fan';   // (a fan's speed from its curve)
  const k = c.key || '';
  if (k === CONN) return 'gpu';
  if (k.startsWith('hwdeck.')) return 'game';
  const r = BYKEY.get(k); if (!r) return null;
  const s = SENS[r.s] ? SENS[r.s].name : '', l = r.label || '';
  if (isPM(r) || /^RTSS\b/.test(s) || /\b(framerate|fps|frame ?time)\b/i.test(l)) return 'game';
  if (r.unit === 'RPM' || /\b(fan|pump)\b/i.test(l)) return 'fan';
  if (/^[di]?GPU\b/.test(s)) return 'gpu';
  if (/^CPU\b/.test(s)) return 'cpu';
  if (/DIMM|^Memory\b|\bSPD\b/i.test(s) || /^System\b/.test(s) && /memory|page file/i.test(l)) return 'mem';
  if (/^(S\.M\.A\.R\.T\.|Drive\b)/.test(s)) return 'drive';   // ("S.M.A.R.T.: ...": no word edge after its dot)
  if (/\b(CPU|Tctl|Tdie|CCD)\b/.test(l)) return 'cpu';   // (the board's CPU readings)
  return null;
}
const TINT = new Map();   // category id: its part's colour ('' grey); emptied when the view is drawn again and when the look changes
const catTint = cat => cat.col || autoTint(cat);
function autoTint(cat) {
  if (TINT.has(cat.id)) return TINT.get(cat.id);
  const n = {}, wait = READ.length === 0; let told = 0;
  for (const cid of cat.cells) { const c = S.L.cells[cid]; const p = partOf(c); if (p) { n[p] = (n[p] || 0) + 1; told++; } }
  let top = null; for (const p in n) if (!top || n[p] > n[top]) top = p;
  const col = top && n[top] * 2 > told ? (PALETTES[S.look.pal] || PALETTES.muted)[1][top] : '';   // (more than half: an even split is a mix)
  if (!wait) TINT.set(cat.id, col);   // (readings not in yet: asked again next time)
  return col;
}
// Spectrum beyond the view (11-02, his "colours don't carry over to popups, hovers, sessions, warnings"): a cell's colour
// (its category's), a reading's (the category of the view's cell that reads it), and a colour with some alpha
const cellTint = cid => { if (S.look.tint !== 'spectrum' || cid == null || !S.L.cells[cid]) return null; const cat = catOf(cid); return cat ? catTint(cat) || null : null; };
const keyTint = key => { if (S.look.tint !== 'spectrum' || !key) return null; for (const id in S.L.cells) if (S.L.cells[id].key === key) { const t = cellTint(id); if (t) return t; } return null; };
// (the game's: HW Deck's own fps cell's, else any cell that reads the game, a PresentMon or RTSS fps)
const gameTint = () => { if (S.look.tint !== 'spectrum') return null; const t = keyTint('hwdeck.0/fps'); if (t) return t; for (const id in S.L.cells) if (partOf(S.L.cells[id]) === 'game') { const c = cellTint(id); if (c) return c; } return null; };
const hexA = (hx, a) => 'rgba(' + parseInt(hx.slice(1, 3), 16) + ',' + parseInt(hx.slice(3, 5), 16) + ',' + parseInt(hx.slice(5, 7), 16) + ',' + a + ')';
// each category's colour as --cc on it (the CSS colours its name and icons with it under Spectrum)
// the popups' graphs (his pick D, 11-09): Spectrum draws them in the game's colour (the GPU's and the CPU's for what
// limited it), Accent in the accent and two tones of it; Mono sets nothing, the CSS's greys stay (--gc, --gc-gpu, --gc-cpu)
function paintGc() {
  const L = S.look, d = document.documentElement;
  let v = null;
  if (L.tint === 'spectrum') { const pal = (PALETTES[L.pal] || PALETTES.muted)[1]; v = [gameTint() || pal.game, pal.gpu, pal.cpu]; }
  else if (L.tint === 'accent') { const lt = relLum(L.acc) > 0.65, s = solidOf(L);   // (a light accent: its tones toward the cells, white + white is white, 11-09)
    v = [L.acc, lt ? mixHex(L.acc, s, 0.25) : mixHex(L.acc, '#ffffff', 0.3), mixHex(L.acc, s, lt ? 0.55 : 0.45)]; if (lt) v.push(mixHex(L.acc, s, 0.4)); }
  const k = v ? v.join() : ''; if (paintGc.k === k) return; paintGc.k = k;
  ['--gc', '--gc-gpu', '--gc-cpu', '--gc-lo'].forEach((n, i) => { if (v && v[i]) d.style.setProperty(n, v[i]); else d.style.removeProperty(n); });   // (--gc-lo: the FPS chart's 1% low, a light accent's only)
}
// (a cell's popup: its range bar's window in the cell's own colour under Spectrum, 11-09)
function paintMc() { const m = document.getElementById('modal'), t = modalCid != null ? cellTint(modalCid) : null; if (m._mc === t) return; m._mc = t; if (t) m.style.setProperty('--mc', t); else m.style.removeProperty('--mc'); }
function paintTint() {
  const on = S.look.tint === 'spectrum';
  if (!on && !paintTint.was) return;
  paintTint.was = on;
  for (const el of document.querySelectorAll('#view .dcat')) {
    const cat = on ? S.L.cats.find(c => c.id === el.dataset.cat) : null, col = cat ? catTint(cat) : '';
    if (el._cc !== col) { el._cc = col; if (col) el.style.setProperty('--cc', col); else el.style.removeProperty('--cc'); }
  }
}
applyLook();
if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', () => { applyMotion(); if (feed.got) calmSettle(); });
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
function saveState() { clearTimeout(saveT); saveT = setTimeout(() => { dropGone(); send({ t: 'save', file: 'state', gen: stateGen, data: { v: 1, L: S.L, active: S.active, edit: S.edit, screen: S.screen, motion: S.motion, gameCalm: S.gameCalm !== false, pins: [DR.L.pinned, DR.R.pinned], sides: [DR.L.side, DR.R.side], rPlaced: DR.R.placed || undefined, title: S.title, clock: S.clock, look: lookPlain() ? undefined : S.look, lookSaved: S.lookSaved.length ? S.lookSaved : undefined, hide: S.hide, listFilt: S.listFilt.g || S.listFilt.w ? { g: S.listFilt.g, w: S.listFilt.w } : undefined, starter: S.starterSeen === true || undefined, starterNoted: S.starterNoted === true || undefined } }); }, 300); }
function saveSlot(i) { send({ t: 'save', file: 'slots/slot' + (i + 1), data: S.slots[i] }); }
// undo steps hold the layout and which slot it came from, so Clear then Undo is exactly where you were
let undoStack = [], redoStack = [];
// (each step also remembers the view it was made in and what was selected: undo and redo go back there and select it
// again, so what they change is seen; the panel audit 11-06, an undo in a view out of sight looked like it did nothing)
const stepMeta = new Map();
const snapOf = () => {   // (the look too: a colour, a palette, the cards undo like any change, 11-02)
  const s = JSON.stringify({ L: S.L, active: S.active, look: S.look });
  stepMeta.delete(s); stepMeta.set(s, { screen: S.screen, sel, selCat }); if (stepMeta.size > 24) stepMeta.delete(stepMeta.keys().next().value);
  return s;
};
const atStep = (s, at) => at && typeof s === 'string' && s.startsWith('{"L":') && s.endsWith('}') ? s.slice(0, -1) + ',"__at":' + JSON.stringify(at) + '}' : s;
const stepAt = e => { const i = typeof e === 'string' ? e.lastIndexOf(',"__at":{') : -1; if (i < 0) return null; try { return JSON.parse(e.slice(i + 8, -1)); } catch (x) { return null; } };
const bareStep = e => { const i = typeof e === 'string' ? e.lastIndexOf(',"__at":{') : -1; return i < 0 ? e : e.slice(0, i) + '}'; };
function goAt(at) {
  if (!at) return;
  if (S.edit) { sel = at.sel && S.L.cells[at.sel] ? at.sel : null; selCat = !sel && at.selCat && S.L.cats.some(c => c.id === at.selCat) ? at.selCat : null; }
  if (at.screen && at.screen !== S.screen && VIEWS.includes(at.screen)) showScreen(at.screen);   // (out of edit mode too: the title bar's Undo changed a view out of sight, 11-08 audit)
}
// folding a category is how you look at it, not a change: undo keeps the folds as they are
function restore(json) {
  const o = JSON.parse(json), was = new Map(S.L.cats.map(c => [c.id, c.collapsed]));
  S.L = o.L; S.active = Number.isInteger(o.active) && S.slots[o.active] ? o.active : null;
  if (o.look) { S.look = cleanLook(o.look); lkFromCheck(); applyLook(); if (setmodal.classList.contains('open')) renderSettings(); }
  for (const c of S.L.cats) if (was.has(c.id)) c.collapsed = was.get(c.id);
}
let undoSeq = 0;   // (counts every step: the stack's length stops changing at its cap)
// (each step keeps the size the view was fitted at then: undo and redo put that very size back, fitPin)
// (11-10: a stricter pin was tried and taken out again. It put the size back only on the layout and in the room the
// size had been FITTED for. But the view a step is taken from is often not freshly fitted: a window resized with the
// refit still to come, a scrollbar that came with the fit, a second draw. Undo then fitted afresh and came back at
// another size or with the tiles placed another way: the stress test at seeds 7112 and 7113. So, as in 2.4.4: the size
// a step had goes back when the view, the text size asked for and the room are as they were when the step was taken)
const fitOf = new Map(); let fitPin = null, fitOkNow = true;
const fitNow = () => ({ fs: parseFloat(document.documentElement.style.fontSize) || 0, ok: fitOkNow, w: sectionsEl.clientWidth, h: sectionsEl.clientHeight, screen: S.screen, target: cssScale() });
function fitKeep(st, s) { st.push(s); fitOf.set(s, fitNow()); if (fitOf.size > 400) fitOf.delete(fitOf.keys().next().value); }
function pushUndo(before) { fitKeep(undoStack, atStep(before, stepMeta.get(before))); undoSeq++; if (undoStack.length > 80) undoStack.shift(); redoStack = []; toastStale(); }
function snap() { pushUndo(snapOf()); }
// a change that changes nothing (Alt+arrow at the end of a list) leaves no undo step
function mutate(fn, msg) { if (nudge) flushNudge(); const before = snapOf(); fn(); tidyViews(S.L); if (snapOf() === before) { syncUndo(); renderInsp(); return; } pushUndo(before); flipNext = true; afterChange(); if (msg) toast(msg, true); }
// every tile measured again (a build's cells got their bodies): once things settle, never under a drag
const xSeen = new Set(); let rmT = 0, rmGlide = false;
let entEnd = 0;   // (when the entrance under way ends: a remeasure waits for it, 11-06, it cut the wave mid-way)
function remeasureSoon(ms, glide) { clearTimeout(rmT); if (glide !== undefined) rmGlide = glide; rmT = setTimeout(() => { if ((drag && drag.started) || rs) { remeasureSoon(); return; } const w = entEnd - performance.now(); if (w > 0) { remeasureSoon(w + 20); return; } packMemo.clear(); if (rmGlide) flipNext = flipNext || 'live'; rmGlide = false; renderView(false); }, ms == null ? 400 : ms); }   // (glide: a build's first data moves what is there, 11-08; back from the tray: one cut)
// a start: the view stays out of sight until what it shows is in (the readings, their values, a build's extras.js and
// its first data), then it is measured and comes in; before, it drew placeholders first and jumped once they filled
// in (a Smart Life tile without its bar). In the tray the page gets none of it, so this waits for the window to open;
// whatever is still missing 2.5 s after the page shows, it comes in anyway
const boot = { cat: false, tick: false, x: false, t: 0 };
function bootCheck(force) {
  if (!app.classList.contains('boot')) return;
  if (!force && !(boot.cat && boot.tick && (!feed.ext || (EXT.ready && boot.x)))) return;
  clearTimeout(boot.t); clearTimeout(rmT); app.classList.remove('boot'); packMemo.clear(); renderView(true);   // (the boot draw measures the filled bodies: no remeasure after it, 11-06)
}
function bootArm() { if (app.classList.contains('boot') && !document.hidden && !boot.t) boot.t = setTimeout(() => bootCheck(true), 2500); }
document.addEventListener('visibilitychange', bootArm);
let onLayout = null;   // (the sessions popup: Customize and the open sessions drawn again)
function afterChange() { preview = null; tidyViews(S.L); fixSel(); if (relinkFor && !S.L.cells[relinkFor]) endRelink(true); saveState(); subscribe(); renderView(false); renderStorage(); renderInsp(); syncUndo(); syncSaves(); if (onLayout) onLayout(); }
// (a step the host does, a Restore in Settings: undone and redone by the host, its log, not the layout: 11-02)
const hostStep = e => { if (e[2] !== 'h') return null; try { const o = JSON.parse(e); return o.host ? o : null; } catch (x) { return null; } };
function undo() { if (nudge) flushNudge(); keyStep.t = 0; if (!undoStack.length) return; retireToastUndo(); const e = undoStack.pop(), h = hostStep(e); if (h) { redoStack.push(JSON.stringify({ host: h.redo, redo: h.host })); send(typeof h.host === 'string' ? { t: h.host } : h.host); syncUndo(); return; } const at = stepAt(e); fitKeep(redoStack, atStep(snapOf(), at)); fitPin = fitOf.get(e) || null; restore(e); fixSel(); goAt(at); flipNext = true; afterChange(); }   // (it glides back the way it went)
function redo() { if (nudge) flushNudge(); keyStep.t = 0; if (!redoStack.length) return; retireToastUndo(); const e = redoStack.pop(), h = hostStep(e); if (h) { undoStack.push(JSON.stringify({ host: h.redo, redo: h.host })); undoSeq++; send(typeof h.host === 'string' ? { t: h.host } : h.host); syncUndo(); return; } const at = stepAt(e); fitKeep(undoStack, atStep(snapOf(), at)); fitPin = fitOf.get(e) || null; restore(e); fixSel(); goAt(at); flipNext = true; afterChange(); }
function syncUndo() { $('undo').disabled = $('undoE').disabled = !undoStack.length; $('redo').disabled = $('redoE').disabled = !redoStack.length; }   // (the title bar's and the editing strip's)
function fixSel() { if (sel && !S.L.cells[sel]) sel = null; if (selCat && !S.L.cats.some(c => c.id === selCat)) selCat = null; }
const layoutSig = L => JSON.stringify(L, (k, v) => k === 'collapsed' ? undefined : v);
// (the slot as the view would be after the same Yes/No line fix, so that fix alone isn't a change)
const ynFixed = L => { if (!L || !L.cells || !Object.values(L.cells).some(c => c.key && isYN(BYKEY.get(c.key)))) return L; const C = JSON.parse(JSON.stringify(L)); for (const id in C.cells) { const c = C.cells[id]; if (c.key && isYN(BYKEY.get(c.key))) ynFixLines(c.gates); } return C; };
const isDirty = () => S.active != null && layoutSig(ynFixed(S.L)) !== layoutSig(ynFixed(S.slots[S.active] ? S.slots[S.active].layout : emptyLayout()));   // (both sides: a line typed past it too)
function inView() { const set = new Set(); for (const c of Object.values(S.L.cells)) if (c.key) set.add(c.key); return set; }
const catOf = cid => S.L.cats.find(c => c.cells.includes(cid));
const slotName = i => S.slots[i] ? (S.slots[i].name || 'Slot ' + (i + 1)) : 'Slot ' + (i + 1);
function syncSaves() {
  const d = isDirty();
  $('saveDot').classList.toggle('on', d);   // (unsaved changes: the dot on Save, his call 11-04; it was on Saves)
  $('savesBtn').title = 'Saves' + (S.active != null ? ': ' + slotName(S.active) : '');
  $('qsaveBtn').title = (S.active != null ? 'Save to ' + slotName(S.active) + (d ? ', unsaved changes' : '') : 'Save to a free slot') + ', Ctrl+S';
  if ($('smodal').classList.contains('open')) renderSaves();
}

// ---------- what the host streams: every cell reading and curve source, plus the Storage rows in sight ----------
let rowKeys = [], subT = 0, lastSub = '', lastTick = 0;
function cellKeys() {
  const set = new Set();
  for (const c of Object.values(S.L.cells)) {
    if (c.key) set.add(c.key); if (c.curve && c.curve.src) set.add(c.curve.src);
    const mp = c.key && memPair(BYKEY.get(c.key)); if (mp) set.add(mp.key);   // (its "% of" caption)
    const lr = c.key && BYKEY.get(c.key), fp = gfKind(lr) === 'low' && fpsOf(lr); if (fp) set.add(fp.key);   // (a 1% low's "% of the fps": the live fps, 11-06)
    if (c.key === CONN && feed.c12keys) for (const k of feed.c12keys[0].concat(feed.c12keys[1])) set.add(k);   // its pins
  }
  if (EXT.keys) for (const k of EXT.keys()) set.add(k);
  if (modalCid && TCELL[modalCid]) set.add(TCELL[modalCid].key);   // (a popup with no cell: its reading too, while it is open)
  return [...set];
}
function subscribe() {
  clearTimeout(subT);
  subT = setTimeout(() => {
    const cells = cellKeys(), rows = gzKeys.length ? [...new Set(rowKeys.concat(gzKeys))] : rowKeys, m = JSON.stringify([cells, rows]);   // (Storage's rows in sight, and Customize's)
    dropRings(new Set(cells));
    lastvAsk(cells);
    if (m === lastSub) return; lastSub = m;
    send({ t: 'sub', cells, rows });
  }, 60);
}

// ---------- a cell's value and state: gates (with their hold), fan curve, warming toward yellow ----------
const moreOpen = new Map();   // (a cell's Hold, fade, also bad fold, opened or shut by hand this session)
let dselOpen = null;   // (a settings list's open menu: { s: the select, b: its button, m: the menu }; see dselShow)
let sel = null, selCat = null, relinkFor = null;   // the selected cell, or the selected category (never both)
let nmOnly = null;   // (Only <view> picked for a name, nothing typed yet: { cid, vn }, 11-08 audit)
let inspCatLater = false;   // (new readings came while a settings field was typed in: see inspCatFlush, 11-08 audit)
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
  return { y: g.y, r: g.mode === 'yr' && Number.isFinite(g.r) ? g.r : undefined, y2: o ? o.y : undefined, r2: o ? o.r : undefined, below: g.dir === 'below' };
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
    // (no game: the last session's call, its split and its minutes as the strip, 2.1; none, --)
    const L = lastG();
    if (L && bnInputs()) {
      const b = lgStrip(L);
      out.txt = b.call ? BN[b.call][0] : '--'; out.utxt = b.call ? BN[b.call][1] : ''; out.strip = b; out.past = bnPast(L); out.col = 'past'; out.tag = 'last session';
      out.tsub = b.tot ? bnSplit(b) : 'no calls in ' + L.game; out.sub = b.tot ? 'last session: ' + bnSplit(b) : 'last session: ' + out.tsub;
      out.tsubS = b.tot ? bnSplit(b).split(', ').slice(0, 2).join(', ') : 'no calls';   // (a narrow tile: its two biggest, as a game shows them; "last: " didn't fit, 2.1.1)
      out.subS = { of: out.sub, s: out.tsubS };   // (anywhere its caption is cut, 2.2)
      return out;
    }
    const b = bnStrip(), w = BN[v] ? BN[bnNow() || v] : null, lw = !w && feed.game && BN[feed.bnl] ? BN[feed.bnl] : null;
    out.txt = w ? w[0] : lw ? lw[0] : '--'; out.utxt = w ? w[1] : lw ? lw[1] : ''; out.strip = b;
    out.col = (w || lw) && live ? 'white' : 'grey';
    out.sub = w ? (feed.bnb === 1 && v !== 3 ? 'only vsync caps show in this game' : feed.bnb === 2 ? 'can\'t see fps caps in this game' : bnSplit(b)) : !bnInputs() ? 'needs GPU usage and CPU thread usage' : feed.game && !live ? 'waiting for HWiNFO' : 'no game running';
    // (a narrow tile: the two biggest shares, shorter words; his "make the little subtitle under it fit", 11-04)
    out.tsub = out.sub;
    out.tsubS = w ? (feed.bnb === 1 && v !== 3 ? 'vsync caps only' : feed.bnb === 2 ? 'fps caps unseen' : bnSplit(b).split(', ').slice(0, 2).join(', ')) : !bnInputs() ? 'needs GPU and CPU usage' : out.sub;
    out.subS = { of: out.sub, s: out.tsubS };
    return out;
  }
  // the game session so far, as a length (its lines in minutes, like the host's); with no game: --
  const gt = c.key === GTIME, gtSub = () => feed.game ? feed.game + (feed.front ? '' : ', in the background') : 'no game running';
  if (gt && v == null) {
    if (!peek) calmGone(cid);
    const L = lastG();
    if (L) {   // (no game: the last session's length, what it was and when it ended; the 24 h's play in the corner)
      const ago = agoShort(Math.max(0, nowTs - L.end)), day = dayPlay(L);
      out.txt = durTxt(L.secs > 0 ? (typeof L.front === 'number' ? Math.min(L.front, L.secs) : L.secs) : L.end - L.start); out.utxt = ''; out.col = 'past'; out.tag = day || 'last session'; out.tagS = 'last session';   // (its play: the time in front, 11-07)
      out.tsub = L.game + ', ended ' + ago; out.tsubS = 'ended ' + ago; out.sub = out.tsub + (day ? ', ' + day : ''); out.subS = { of: out.sub, s: out.tsubS };   // (a narrow tile: when it ended; "Deadlock, 1h 04m ago" was cut, 2.1.1)
      out.past = playDay(L); out.pspan = 86400; out.yn = true;   // (its graph: the 24 h, Yes / No a minute, 2.1.1)
      return out;
    }
    out.txt = '--'; out.utxt = ''; out.sub = gtSub(); out.col = 'grey'; return out;
  }
  // (no game: the game's fps and its 1% low, with no value, are the last session's averages, its minutes as the graph;
  // HWiNFO's, which follow what is in front, stay as they are)
  const gk = gfKind(r), L = gk && !c.pred && v == null ? lastG() : null;
  if (L) {
    if (!peek) calmGone(cid);
    const x = gk === 'fps' ? L.fps : L.low, has = typeof x === 'number' && isFinite(x);
    out.txt = has ? fmt(x, 0) : '--'; out.utxt = unitOf(r); out.col = 'past'; out.tag = 'last session'; out.past = gk === 'fps' ? L.tf : L.tl;
    const pc = gk === 'low' && has && L.fps > 0 ? Math.min(100, Math.round(x / L.fps * 100)) + '% of the fps' : '';
    out.tsub = !has ? 'no fps counted in ' + L.game : gk === 'fps' ? 'avg, ' + L.game : 'avg' + (pc ? ', ' + pc : '');
    out.tsubS = !has ? 'no fps counted' : gk === 'fps' ? 'last avg, ' + L.game : 'last avg' + (pc ? ', ' + pc.replace(' of the fps', ' of fps') : '');   // (a narrow tile: "last" here, no corner note)
    out.sub = !has ? 'last session: ' + out.tsub : 'last session avg, ' + (gk === 'fps' ? L.game : pc || L.game);
    out.subS = { of: out.sub, s: out.tsubS };
    return out;
  }
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
      const pd = decFor(r);   // (the reading's own precision, not the decimals shown: a V cell at 1 decimal faded over 3 V, 11-06)
      const span = Number.isFinite(g.fade) ? g.fade : Math.max(Math.abs(x) * 0.12, pd > 1 ? 3 * Math.pow(10, -pd) : 3), d = up ? x - v : v - x;
      return span > 0 && d >= 0 && d < span ? Math.round((1 - d / span) * 20) / 20 : 0;
    };
    if (!raw && !isYN(r)) out.warm = Math.max(fadeTo(g.y, above), o ? fadeTo(o.y !== undefined ? o.y : o.r, !o.below) : 0);
    else if (raw === 1 && !isYN(r)) out.warmR = side ? (o && o.y !== undefined ? fadeTo(o.r, !o.below) : 0) : g.mode === 'yr' ? fadeTo(g.r, above) : 0;
    hold = g.hold || 0;
  }
  if (c.curve && !c.pred) {
    const src = BYKEY.get(c.curve.src), exp = src ? interp(c.curve.pts, src.v) : null;
    if (exp != null) {
      const dev = exp > 0 ? (v - exp) / exp * 100 : v > 100 ? 100 : 0;   // (11-06: expected at 0 rpm and spinning: off it)
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
  if (raw === 2 && out.lvl === 1 && !isYN(r)) out.warmR = 1;   // (shown yellow, already past red, waiting out its hold: as close to red as it gets, 11-06)
  const dec = dec0, k = gbK(r), fl = (x, bl) => isYN(r) ? lnTxt(x, dec, r, bl) : fmt(x * k, dec);   // (a Yes/No line in words)
  if (calm) out.sub = ep.sub;
  else if (pmOff && gatesOn(g) && !out.curve) out.sub = 'lines count while a game is in front';
  else if (out.lvl && side) out.sub = (o.below ? 'under ' : 'over ') + (out.lvl === 2 || o.y === undefined ? 'red ' + fl(o.r, o.below) : 'yellow ' + fl(o.y, o.below));   // (a side with a red line only: its words)
  else if (out.lvl === 2) out.sub = (g.dir === 'below' ? 'under red ' : 'over red ') + fl(g.r, g.dir === 'below');
  else if (out.lvl === 1 && !out.offCurve) out.sub = (g.dir === 'below' ? 'under yellow ' : 'over yellow ') + fl(g.y, g.dir === 'below');
  else if (out.curve) {
    const d = Math.round(out.curve.dev);
    out.sub = Math.abs(out.curve.dev) <= c.curve.tol ? 'on curve, expects ' + fmt(out.curve.exp, 0) : Math.abs(d) + '% ' + (d < 0 ? 'under' : 'over') + ' its curve';
    if (/^on curve, /.test(out.sub)) out.subS = { of: out.sub, s: 'on curve' };
  } else if (c.pred) {
    const src = BYKEY.get(c.curve.src);
    out.sub = src ? 'from ' + src.label + ' ' + fmt(src.v, decFor(src)) + (src.unit ? ' ' + src.unit : '') : 'its temperature is missing';
    if (src) out.subS = { of: out.sub, s: 'from ' + fmt(src.v, decFor(src)) + (src.unit ? ' ' + src.unit : '') };   // (where cut, 2.2)
  } else if (memPair(r) && memPair(r).v != null && v > 0) {   // memory: how much of it is in use
    const size = memSize((v + memPair(r).v) / 1024);
    out.sub = Math.round(v / 1024 / size * 100) + '% of ' + size + ' GB';
  } else if (r && !quick && gfKind(r) === 'fps' && feed.game && feed.sf && gxN(feed.sf[0]) !== null) {
    out.sub = 'avg ' + fmt(gxN(feed.sf[0]), 0) + ' this session';   // (the game's fps: its average this session, 2.1)
  } else if (r && !quick && gfKind(r) === 'low') {
    // (its 1% low: how far under the fps of the same 10 s it sits, and its lowest of the last 15 min)
    const f = gfPair(r), pc = f > 0 ? Math.min(100, Math.round(v / f * 100)) : null; let lo = Infinity; for (const x of series(r.key, HLEN)) if (x != null && x > 0 && x < lo) lo = x;
    out.sub = [pc !== null ? pc + '% of the fps' : '', isFinite(lo) ? '15 min low ' + fmt(lo, 0) : ''].filter(Boolean).join(', ');
    out.tsub = out.sub; out.tsubS = [pc !== null ? pc + '% of fps' : '', isFinite(lo) ? 'low ' + fmt(lo, 0) : ''].filter(Boolean).join(', '); out.subS = { of: out.sub, s: out.tsubS };   // (a narrow tile: "14% of the fps, 15 min low 10" was cut, 2.1.1)
  } else if (r && !quick && !isYN(r)) {
    let mx = -Infinity; for (const x of series(r.key, HLEN)) if (x > mx) mx = x;
    out.sub = isFinite(mx) ? '15 min max ' + fl(mx) + (unitOf(r) ? ' ' + unitOf(r) : '') : '';
    if (isFinite(mx)) out.subS = { of: out.sub, s: 'max ' + fl(mx) + (unitOf(r) ? ' ' + unitOf(r) : '') };   // (a tile too narrow for it, 2.1.2)
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
// (tc: its category's colour under Spectrum, in place of the grey)
const sparkColor = (e, hero, tc) => e.col === 'yellow' ? COLORS.yellow : e.col === 'red' ? COLORS.red : e.col === 'grey' ? '#3a3a3a' : e.col === 'past' ? '#5a5a5a' : tc || (hero ? '#8f8f8f' : '#7c7c7c');
const graphCol = (e, hero, tc) => { const base = sparkColor(e, hero, tc); return e.warm ? mixHex(base, COLORS.yellow, e.warm * 0.75) : e.warmR ? mixHex(base, COLORS.red, e.warmR * 0.75) : base; };

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
let catchUp = false;   // (this draw brings minutes the page missed, back from the tray: shown at once, 2.1)
function odo(el, s, due, cut) {   // (cut: a different number, not a change of this one: shown at once, never rolled)
  if (!el) return;
  if (cut) due = true;
  s = s === null || s === undefined ? '' : String(s);
  const built = !!el._ocells && el._t === el._ot;
  if (built && el._ot === s) { if (el._pend != null) { el._pend = null; odoWait.delete(el); } return; }
  const now = performance.now();
  // a number replacing "--" (start, HWiNFO back) shows at once; a number replacing a number waits its turn ("--" for a
  // number: at once too, 11-06)
  if (!due && built && /[0-9]/.test(el._ot) && /[0-9]/.test(s) && now - (el._at || 0) < ODO_HOLD) {
    el._pend = s; odoWait.add(el);
    if (!odoT) odoT = setTimeout(odoFlush, ODO_HOLD - (now - el._at));
    return;
  }
  odoWait.delete(el); el._pend = null; el._at = now;
  const old = built ? el._ot : null, num = x => { const n = parseFloat(String(x).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const a = num(old), b = num(s), up = a === null || b === null || Math.abs(b) >= Math.abs(a), roll = motionOn() && !cut && !stillUnder(el);   // the digits show the size: -5 to -7 rolls up
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

// a popup is open: the view under its blur holds still (no spins, rolls or slides; its values still change every second),
// the popup itself moves as usual (2.1, the motion audit 11-04)
let modalUp = false;
// a popup opened by a click grows out of what was clicked (a tile, a title bar button), in Full; Minimal and Off as before
// (2.2, his autopilot list 11-05: "popups grow from the click")
let lastPress = null;
document.addEventListener('pointerdown', e => { lastPress = { el: e.target, t: performance.now(), x: e.clientX, y: e.clientY }; }, true);
document.addEventListener('keydown', () => { lastPress = null; }, true);   // (a popup a key opened grows as before, not out of the last click)
// (11-09, his "on the controls pop up it looks kinda odd ... when you exit the pop up it just fades away, try a zoom in
// into the button"): the card is solid from its first frames (it came in see-through, the view's numbers showing
// through it all the way from the corner: its own opacity from 0.2 and the popup's 280 ms fade), only the dim and blur
// fade in under it; it starts slow and settles long (no first-frame jump); and it goes back INTO what opened it on the
// way out, the open played backwards and quicker, the dim fading under it. Full only, as the grow. Every step starts from
// where the card and the dim are that frame, so a quick close, or a reopen on the way home, never jumps
const POP_IN = 380, POP_OUT = 230, POP_EASE_IN = 'cubic-bezier(0.2, 0, 0, 1)', POP_EASE_OUT = 'cubic-bezier(0.3, 0, 0.8, 0.15)', POP_DIM_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const popCard = m => m.querySelector(':scope > .mcard, :scope > .mwrap');   // (.mwrap: a card with a panel docked beside it, both grow as one: the dashboard's Controls and its TV remote, 11-05)
// the transform that puts the card (open, its transform aside) on a rect: centred on it, its size
function popAt(card, r) {
  const w = card.offsetWidth, h = card.offsetHeight; if (!w || !h) return null;
  const cx = card.offsetLeft + w / 2, cy = card.offsetTop + h / 2, s = Math.max(0.05, Math.min(0.9, Math.max(r.width / w, r.height / h)));
  return 'translate(' + (r.left + r.width / 2 - cx).toFixed(1) + 'px, ' + (r.top + r.height / 2 - cy).toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
}
// what opened it, where it is NOW (it may have moved, or been drawn again: found by its cell or id), or null: gone,
// hidden, or out of the window (then it leaves as before)
function popSrc(m) {
  let el = m._src; if (!el) return null;
  if (!el.isConnected && m._srcKey) el = [...document.querySelectorAll(m._srcKey)].find(e => !e.closest('.modal:not(.open)') && e.getClientRects().length) || null;
  if (!el || !el.isConnected || el.closest('.modal:not(.open)') || m.contains(el)) return null;
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight ? el : null;
}
function popHome(m) { const el = popSrc(m); return el ? el.getBoundingClientRect() : null; }
// the card and the dim as drawn this frame (read before any of their animations is cancelled: a cancelled one no longer counts)
function popNow(m) {
  const card = popCard(m); if (!card) return null;
  const c = getComputedStyle(card), d = getComputedStyle(m);
  return { card, tf: c.transform === 'none' ? 'none' : c.transform, op: +c.opacity, bg: d.backgroundColor, bf: d.backdropFilter === 'none' ? 'blur(0px)' : d.backdropFilter };
}
const popStop = m => { for (const k of ['_grow', '_dimIn', '_zout', '_dimOut', '_fade']) if (m[k]) { const a = m[k]; m[k] = null; a.cancel(); } };
const popDimIn = (m, bg, bf) => { m._dimIn = m.animate([{ opacity: 1, backgroundColor: bg, backdropFilter: bf }, { opacity: 1 }], { duration: 280, easing: POP_DIM_EASE }); };
// ---- the morph (11-09, his pick after the mocks: "instead of fading from or into black fade from or into the cell
// preview"): a popup's card IS what was clicked, grown. Its box goes from that thing's exact box and corners to the
// card's own, and back: the card is scaled to cover the box and clipped to it, a shell behind it carries the border
// and the shadow. A copy of the clicked cell rides on top, scaled with the box's width: it fades into the popup's
// content on the way up, and the content fades back into it on the way home, where it lands on the cell itself, so
// the box is never empty. A button has no picture worth growing: its popup's content comes in early instead. The dim
// comes and goes with the card. Every morph starts from where the box and each fade are that frame (a close while it
// opens, a reopen on its way home). A card with a panel beside it (.mwrap) and a popup with nothing to come from keep
// the plain motion (growPlain, shrinkPlain, popBack without a morph) ----
const PM_IN = 380, PM_OUT = 280, PM_N = 24, PM_SRC = '.dc, .tile, .row, .bcell, .gx-row, .card, button, .ib', PM_CELL = '.dc, .tile, .row, .bcell, .gx-row';
// where a morph is when it is turned around (0: the source's box, 1: the card's): the eased progress of the card's own
// flight, which is what is drawn (a clock kept here would run a frame or two ahead of the screen)
const pmAt = pm => { const p = pm.a.effect ? pm.a.effect.getComputedTiming().progress : null; return pm.ta + (pm.tb - pm.ta) * (p == null ? 1 : p); };
const pmRad = el => { const v = parseFloat(getComputedStyle(el).borderTopLeftRadius); return isFinite(v) ? v : 0; };
const pmOp = el => el ? +getComputedStyle(el).opacity : 0;
// the frame at t (0: the source's box, 1: the card's): the box, the card scaled to cover it (centred across, from its top
// down) and clipped to it, 1 px inside where it cuts the card (the shell's border is the edge there)
function pmFrame(g, R, rs, t) {
  const l = R.left + (g.L - R.left) * t, tp = R.top + (g.T - R.top) * t, w = R.width + (g.W - R.width) * t, h = R.height + (g.H - R.height) * t, r = rs + (g.r - rs) * t;
  const s = Math.max(w / g.W, h / g.H), cw = g.W * s, ch = g.H * s, x = l + (w - cw) / 2;
  let side = (cw - w) / 2 / s, bot = (ch - h) / s; side = side > 0.01 ? side + 1 / s : 0; bot = bot > 0.01 ? bot + 1 / s : 0;
  return { l, t: tp, w, h, r, tf: 'translate(' + (x - g.L).toFixed(2) + 'px, ' + (tp - g.T).toFixed(2) + 'px) scale(' + s.toFixed(4) + ')',
    clip: 'inset(0px ' + side.toFixed(2) + 'px ' + bot.toFixed(2) + 'px ' + side.toFixed(2) + 'px round ' + (r / s).toFixed(2) + 'px)' };
}
// a cell's picture: a copy of it as it is drawn this frame (every element's computed style written onto its copy, so it
// looks the same outside its view, and each graph's pixels drawn over), in a box of its own that the morph moves. Null:
// not a cell (a button, a table's row: it has no box of its own outside its table) or it can't be copied
// (what it writes: on the cell itself every property; on an element inside it only what differs from a bare element of
// its kind or from its parent, the rest comes out the same by itself: about a quarter of the time of writing them all)
let pmNames = null, pmHold = null;
const pmBare = new Map();
function pmBareOf(el) {
  const key = el.namespaceURI + ' ' + el.localName; let v = pmBare.get(key);
  if (!v) {
    if (!pmHold) { pmHold = document.createElement('i'); pmHold.style.display = 'none'; pmHold.setAttribute('aria-hidden', 'true'); document.documentElement.appendChild(pmHold); }
    const e = pmHold.appendChild(document.createElementNS(el.namespaceURI, el.localName)), cs = getComputedStyle(e);
    v = pmNames.map(n => cs.getPropertyValue(n)); e.remove(); pmBare.set(key, v);
  }
  return v;
}
function pmCopy(src) {
  if (!src.matches(PM_CELL) || src.tagName === 'TR' || !src.offsetWidth) return null;
  try {
    const g = src.cloneNode(true), a = [src, ...src.querySelectorAll('*')], b = [g, ...g.querySelectorAll('*')];
    if (a.length !== b.length || a.length > 300) return null;
    if (!pmNames) pmNames = [...getComputedStyle(document.documentElement)];
    const at = new Map(), vals = [], n = pmNames.length;
    for (let i = 0; i < a.length; i++) {
      const cs = getComputedStyle(a[i]), el = b[i], v = new Array(n), up = i ? vals[at.get(a[i].parentNode)] : null, bare = up ? pmBareOf(a[i]) : null, odd = [];
      let css = '';
      for (let j = 0; j < n; j++) {
        const x = v[j] = cs.getPropertyValue(pmNames[j]);
        if (up && x === bare[j] && x === up[j]) continue;
        if (x.indexOf(';') >= 0) odd.push(j); else css += pmNames[j] + ':' + x + ';';
      }
      at.set(a[i], i); vals.push(v);
      el.style.cssText = css + 'transition:none;animation:none;pointer-events:none';   // (a picture: it holds still, and a click goes through it to the card)
      for (const j of odd) el.style.setProperty(pmNames[j], v[j]);
      for (const k of ['id', 'class', 'data-cid', 'title', 'tabindex']) el.removeAttribute(k);
      if (a[i].tagName === 'CANVAS' && a[i].width && a[i].height) { const x = el.getContext('2d'); if (x) x.drawImage(a[i], 0, 0); }
    }
    g.style.position = 'absolute'; g.style.left = g.style.top = '0'; g.style.margin = '0'; g.style.transform = 'none'; g.style.transformOrigin = '0 0';
    const box = document.createElement('i'); box.className = 'pm-ghost'; box.setAttribute('aria-hidden', 'true'); box._w = src.offsetWidth;
    box.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;overflow:hidden;z-index:9;display:block';
    box.appendChild(g);
    return box;
  }
  catch (e) { return null; }
}
// ends a morph's own pieces (popStop has the card's flight and the dim); keep: its picture stays, for the next morph
function pmStop(m, keep) {
  const pm = m._pm; if (!pm) return null; m._pm = null;
  for (const a of pm.anims) a.cancel(); pm.shell.remove();
  if (pm.ghost && !keep) pm.ghost.remove();
  return keep ? pm.ghost : null;
}
// one morph from ta to tb (open: up to 1, close: down to 0). from: the content's, the box's and the picture's opacity
// now; ghost: the clicked cell's picture (null: none)
function pmRun(m, card, R, rs, ta, tb, dur, from, ghost) {
  const c = getComputedStyle(card), g = { L: card.offsetLeft, T: card.offsetTop, W: card.offsetWidth, H: card.offsetHeight, r: parseFloat(c.borderTopLeftRadius) || 14 };
  const ks = [], ss = [], gs = [];
  for (let i = 0; i <= PM_N; i++) {
    const f = pmFrame(g, R, rs, ta + (tb - ta) * i / PM_N);
    ks.push({ offset: i / PM_N, transform: f.tf, clipPath: f.clip, transformOrigin: '0 0', boxShadow: 'none' });
    ss.push({ offset: i / PM_N, left: f.l + 'px', top: f.t + 'px', width: f.w + 'px', height: f.h + 'px', borderRadius: f.r + 'px' });
    if (ghost) gs.push({ offset: i / PM_N, transform: 'scale(' + (f.w / ghost._w).toFixed(4) + ')' });
  }
  const shell = document.createElement('i'); shell.className = 'pm-shell'; shell.setAttribute('aria-hidden', 'true');
  shell.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;display:block;background:' + c.backgroundColor + ';border:1px solid ' + c.borderTopColor + ';box-shadow:' + c.boxShadow;
  m.insertBefore(shell, m.firstChild);
  const open = tb > ta, o = { duration: dur, easing: POP_EASE_IN, fill: 'forwards' }, lin = { duration: dur, easing: 'linear', fill: 'forwards' };
  const a = card.animate(ks, o), anims = [shell.animate(ss, o)];
  let bo, ko;
  if (ghost) {
    if (ghost.parentNode !== m) m.appendChild(ghost);
    anims.push(ghost.animate(ss, o), ghost.firstChild.animate(gs, o));
    // the picture: out between 12 and 62 % of the way up (the content is under it by then); in between 25 and 72 % of the
    // way home, whole from there until it has landed
    anims.push(ghost.animate(open ? [{ opacity: from.gh }, { opacity: from.gh, offset: 0.12 }, { opacity: 0, offset: 0.62 }, { opacity: 0 }]
                                  : [{ opacity: from.gh }, { opacity: from.gh, offset: 0.25 }, { opacity: 1, offset: 0.72 }, { opacity: 1 }], lin));
    // the box (the card's ground, its border and shadow): there at once on the way up (the picture covers it), gone over
    // the last fifth of the way home (the picture is the cell again by then). The content: in under the picture over the
    // first 45 %, and on the way home it stays until the picture is half in
    bo = open ? [{ opacity: from.box }, { opacity: 1, offset: 0.1 }, { opacity: 1 }] : [{ opacity: from.box }, { opacity: from.box, offset: 0.8 }, { opacity: 0 }];
    ko = open ? [{ opacity: from.kid }, { opacity: 1, offset: 0.45 }, { opacity: 1 }] : [{ opacity: from.kid }, { opacity: from.kid, offset: 0.45 }, { opacity: 0, offset: 0.85 }, { opacity: 0 }];
  }
  else {
    // no picture (a button): the box in over the first tenth and out over the last half of the way home; the content
    // in early (from 5 to 45 %) and out over the first half of the way home
    bo = open ? [{ opacity: from.box }, { opacity: 1, offset: 0.1 }, { opacity: 1 }] : [{ opacity: from.box }, { opacity: from.box, offset: 0.5 }, { opacity: 0 }];
    ko = open ? [{ opacity: from.kid }, { opacity: from.kid, offset: 0.05 }, { opacity: 1, offset: 0.45 }, { opacity: 1 }] : [{ opacity: from.kid }, { opacity: 0, offset: 0.5 }, { opacity: 0 }];
  }
  anims.push(card.animate(bo, lin), shell.animate(bo, lin));
  for (const k of card.children) anims.push(k.animate(ko, lin));
  m._pm = { anims, shell, ghost: ghost || null, a, ta, tb, R, rs };
  return a;
}
// where a morph under way is: for the next one to start from (its picture stays)
function pmTake(m, card) {
  const pm = m._pm; if (!pm) return null;
  const st = { t: pmAt(pm), R: pm.R, rs: pm.rs, from: { kid: pmOp(card.firstElementChild) || 0, box: pmOp(card), gh: pmOp(pm.ghost) } };
  st.ghost = pmStop(m, true);
  return st;
}
// open all the way: the morph's pieces go (the card as the page draws it, its own shadow where the shell's was)
const pmLanded = (m, a) => { a.onfinish = () => { if (m._grow !== a) return; a.cancel(); m._grow = null; pmStop(m); }; };
function growPlain(m, card) {
  const src = lastPress.el.closest('.tile, .row, .bcell, .gx-row, .card, button, .ib') || lastPress.el, br = src.getBoundingClientRect();
  const has = br.width > 0 && br.height > 0, r = has ? br : { left: lastPress.x - 16, top: lastPress.y - 16, width: 32, height: 32 };
  const from = popAt(card, r); if (!from) return;
  if (has) { m._src = src; m._srcKey = src.dataset.cid ? '[data-cid="' + CSS.escape(src.dataset.cid) + '"]' : src.id ? '#' + CSS.escape(src.id) : null; }
  m._grow = card.animate([{ transform: from, opacity: 0 }, { opacity: 1, offset: 0.12 }, { transform: 'none', opacity: 1 }], { duration: POP_IN, easing: POP_EASE_IN });
  popDimIn(m, 'rgba(0, 0, 0, 0)', 'blur(0px)');
}
function growFrom(m) {
  const card = popCard(m); m._src = m._srcKey = null; pmStop(m);
  if (!card || !motionOn() || !lastPress || performance.now() - lastPress.t > 700 || m.contains(lastPress.el) || !lastPress.el.isConnected) return;
  if (card.classList.contains('mwrap')) return growPlain(m, card);
  const src = lastPress.el.closest(PM_SRC) || lastPress.el, br = src.getBoundingClientRect();
  if (!(br.width > 0 && br.height > 0) || !card.offsetWidth) return growPlain(m, card);
  m._src = src; m._srcKey = src.dataset.cid ? '[data-cid="' + CSS.escape(src.dataset.cid) + '"]' : src.id ? '#' + CSS.escape(src.id) : null; m._srcR = pmRad(src);
  pmLanded(m, m._grow = pmRun(m, card, br, m._srcR, 0, 1, PM_IN, { kid: 0, box: 0, gh: 1 }, pmCopy(src)));
  popDimIn(m, 'rgba(0, 0, 0, 0)', 'blur(0px)');
}
// opened again on its way home: back out from where it got to, dim and all (st: where its morph was, null: a plain flight)
function popBack(m, now, st) {
  if (st) pmLanded(m, m._grow = pmRun(m, now.card, st.R, st.rs, st.t, 1, Math.max(160, PM_IN * (1 - st.t)), st.from, st.ghost));
  else m._grow = now.card.animate([{ transform: now.tf, opacity: now.op }, { transform: 'none', opacity: 1 }], { duration: POP_IN, easing: POP_EASE_IN });
  popDimIn(m, now.bg, now.bf);
}
// closing: back into what opened it, from wherever the card is now
function shrinkHome(m, busy) {
  const card = popCard(m), el = card && !card.classList.contains('mwrap') && !busy && motionOn() ? popSrc(m) : null;
  if (!el) {
    // nothing to go home to (what opened it is gone, or another popup is taking over): the plain way out. From a morph
    // still on its way up, the box holds where it is and the whole popup fades (the plain flight would take the
    // morph's transform for one around the card's centre, and jump)
    if (m._pm && m._grow) {
      m._grow.pause(); for (const x of m._pm.anims) x.pause();
      const d = m._dimOut = m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
      d.onfinish = () => { if (m._dimOut === d) { popStop(m); pmStop(m); } };
      return;
    }
    pmStop(m); return shrinkPlain(m, busy);
  }
  const now = popNow(m), r = el.getBoundingClientRect();
  // (from a morph still on its way up: where it is, its picture kept; from the open card: a new picture of the cell)
  const st = pmTake(m, card) || { t: 1, from: { kid: 1, box: 1, gh: 0 }, ghost: pmCopy(el) };
  popStop(m);
  m.classList.add('zout'); m.inert = true;   // (drawn while it goes home; nothing on it takes a click or a key meanwhile)
  const dur = Math.max(140, PM_OUT * st.t);
  m._dimOut = m.animate([{ backgroundColor: now.bg, backdropFilter: now.bf }, { backgroundColor: 'rgba(0, 0, 0, 0)', backdropFilter: 'blur(0px)' }], { duration: dur, easing: POP_EASE_IN, fill: 'forwards' });
  const a = m._zout = pmRun(m, card, r, pmRad(el), st.t, 0, dur, st.from, st.ghost);
  a.onfinish = () => { if (m._zout !== a) return; m.style.transition = 'none'; m.classList.remove('zout'); m.inert = false; void m.offsetWidth; m.style.transition = ''; popStop(m); pmStop(m); };
}
function shrinkPlain(m, busy) {
  const now = popNow(m), r = !busy && now && motionOn() ? popHome(m) : null, to = r ? popAt(now.card, r) : null;
  const coming = !!(m._dimIn || m._grow);   // (closed before it had come all the way in)
  popStop(m);
  if (!to) {   // the fade, as before; from where it had got to when it was still coming in (no snap to full dim first)
    if (now && coming) {
      const d = m._dimOut = m.animate([{ opacity: 1, backgroundColor: now.bg, backdropFilter: now.bf }, { opacity: 0, backgroundColor: now.bg, backdropFilter: now.bf }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
      m._fade = now.card.animate([{ transform: now.tf, opacity: now.op }, { transform: 'translateY(26px) scale(0.94)', opacity: now.op }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
      d.onfinish = () => { if (m._dimOut === d) popStop(m); };
    }
    return;
  }
  m.classList.add('zout'); m.inert = true;   // (drawn while it goes home; nothing on it takes a click or a key meanwhile)
  m._dimOut = m.animate([{ backgroundColor: now.bg, backdropFilter: now.bf }, { backgroundColor: 'rgba(0, 0, 0, 0)', backdropFilter: 'blur(0px)' }], { duration: 200, easing: 'ease-out', fill: 'forwards' });
  const a = m._zout = now.card.animate([{ transform: now.tf, opacity: now.op }, { opacity: now.op, offset: 0.62 }, { transform: to, opacity: 0 }], { duration: POP_OUT, easing: POP_EASE_OUT, fill: 'forwards' });
  a.onfinish = () => { if (m._zout !== a) return; m.style.transition = 'none'; m.classList.remove('zout'); m.inert = false; void m.offsetWidth; m.style.transition = ''; popStop(m); };
}
// popups over popups (Controls, then a device's own; 2.2): the one on top has a light dim and no second blur, the ones
// under it step back (deck.css .modal.over / .under). On top: the highest, then the one opened last
const modalZ = m => parseInt(getComputedStyle(m).zIndex, 10) || 0;
function topModal(open) { let top = null; for (const m of open || document.querySelectorAll('.modal.open')) if (!top || modalZ(m) > modalZ(top) || (modalZ(m) === modalZ(top) && (m._openAt || 0) > (top._openAt || 0))) top = m; return top; }
function stackModals() {
  const open = [...document.querySelectorAll('.modal.open')], top = topModal(open);
  // (the lowest keeps the full dim; every one above it the light one, so a middle one never changes its backdrop when a
  // third opens or goes, 11-06)
  let low = null; for (const m of open) if (!low || modalZ(m) < modalZ(low) || (modalZ(m) === modalZ(low) && (m._openAt || 0) < (low._openAt || 0))) low = m;
  for (const m of document.querySelectorAll('.modal')) {
    const on = open.length > 1 && m.classList.contains('open');
    // (one closing from on top keeps its light dim while it fades, 150 ms, so the one under doesn't flash darker)
    if (!m.classList.contains('open') && m.classList.contains('over')) { clearTimeout(m._overT); m._overT = setTimeout(() => { if (!m.classList.contains('open')) m.classList.remove('over'); }, 200); }
    else m.classList.toggle('over', on && m !== low);
    m.classList.toggle('under', on && m !== top);
  }
}
// (Saves, Settings, Sessions and Warning history: the focus into the card on open, back to what had it on close, as the
// cell popup and the question do, 11-07 audit: a screen reader stayed outside them, Enter pressed the title bar button)
const FOCUS_M = ['wmodal', 'gmodal', 'smodal', 'setmodal'];
function modalFocus(m, open) {
  const ae = document.activeElement;
  if (open) { if (!m.contains(ae)) m._opener = ae && ae !== document.body ? ae : null; const c = m.querySelector('.mcard'); if (c && !c.contains(ae)) c.focus({ preventScroll: true }); return; }
  const o = m._opener; m._opener = null;
  if (ae && ae !== document.body && !m.contains(ae)) return;   // (it went on to another popup already)
  const t = topModal(), c = o && o.isConnected && !o.closest('.modal:not(.open)') ? o : t ? t.querySelector('.mcard') : null;
  if (c) c.focus({ preventScroll: true }); else if (ae && m.contains(ae)) ae.blur();
}
const modalObs = new MutationObserver(rs => {
  const was = modalUp; modalUp = !!document.querySelector('.modal.open');
  const firstOf = new Map(); for (const r of rs) if (!firstOf.has(r.target)) firstOf.set(r.target, r);   // (one look per popup: a class changed just before its open made two "opened" records, a double grow and its opener lost, 11-07 audit)
  const opening = [...firstOf.values()].some(r => r.target.classList.contains('open') && !/(^|\s)open(\s|$)/.test(r.oldValue || ''));
  for (const r of firstOf.values()) {
    const m = r.target, wasOpen = /(^|\s)open(\s|$)/.test(r.oldValue || '');
    if (m.classList.contains('open') && !wasOpen) {
      // (opened again on its way home, 11-09: back out from where it is. Not when something else was clicked meanwhile,
      // another cell while this one's popup closes: that is a new popup, from the new cell)
      const press = lastPress && performance.now() - lastPress.t <= 700 && lastPress.el.isConnected && !m.contains(lastPress.el) ? lastPress.el.closest(PM_SRC) || lastPress.el : null;
      const back = m._zout && motionOn() && !(press && press !== m._src) ? popNow(m) : null;
      const st = back ? pmTake(m, back.card) : null;   // (where its morph was, its picture kept)
      popStop(m); m.classList.remove('zout'); m.inert = false; m._openAt = performance.now();
      if (back) popBack(m, back, st); else growFrom(m);
    }
    else if (!m.classList.contains('open') && wasOpen) shrinkHome(m, opening);   // (one closing as another opens, a swap: it fades as before, two flights at once were busy)
    if (FOCUS_M.includes(m.id) && m.classList.contains('open') !== wasOpen) modalFocus(m, !wasOpen);
  }
  stackModals();
  if (was && !modalUp && motionOn()) { if (feed.got) updateView(false, true); motionRun(); }   // (closed: the fans turn again at once, in Full only; their rates set again first, 11-06)
});
const watchModal = m => modalObs.observe(m, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
for (const m of document.querySelectorAll('.modal')) watchModal(m);
// (a build's own popup, made after the page: Controls in the fork's extras.js; the motion audit 11-04 found the view kept
// moving under it, and Full stuck still after a popup over it closed first)
new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('modal')) { watchModal(n); modalObs.takeRecords(); modalUp = !!document.querySelector('.modal.open'); } })
  .observe(document.body, { childList: true });
const stillUnder = el => modalUp && !!el && !el.closest('.modal, #hprev');
// ---------- fan icons turn with their fan: one turn a second at 1500 rpm ----------
function spinWrap(svg) {
  let w = svg.parentNode;
  if (w.className !== 'spw') { w = document.createElement('i'); w.className = 'spw'; svg.replaceWith(w); w.appendChild(svg); spinSeen.observe(w); }
  return w;
}
// a fan out of sight (scrolled away, in a folded category) doesn't keep the clock going
const spinSeen = new IntersectionObserver(es => { for (const e of es) { const svg = e.target.firstChild; if (!svg) continue; svg._seen = e.isIntersecting; if (e.isIntersecting && svg._srate) motionRun(); } });
// (one still in the view keeps its angle: it stops where it is and turns on from there, 11-06; it snapped upright)
const unstep = svg => { stepped.delete(svg); if (svg.parentNode) { if (!svg.isConnected) svg.parentNode.style.transform = ''; spinSeen.unobserve(svg.parentNode); } };
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
  if (document.hidden) { clearInterval(motionT); motionT = 0; return; }   // (hidden: stopped, back on the show below, 11-06)
  for (const svg of stepped) if (turning(svg)) { svg._ang = (svg._ang + svg._srate * 360 / motionAt) % 360; svg.parentNode.style.transform = 'rotate(' + svg._ang.toFixed(1) + 'deg)'; }
  rollStep(now);
  if (graphMore) { graphMore = false; kickGraphs(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && ([...stepped].some(s => s._srate) || rolling.size || graphMore)) motionRun(); });
function spinIcon(svg, rpm) {
  if (!svg) return;
  const rate = motionOn() && rpm > 0 && feed.status === 'ok' && !stillUnder(svg) ? Math.min(2.5, Math.max(0.05, Math.round(rpm / 1500 * 20) / 20)) : 0;   // (2.5 turns a second at most: faster, the four blades looked to turn backwards, 11-06)
  if (!rate && !stepped.has(svg)) return;
  const w = spinWrap(svg);
  if (!stepped.has(svg)) spinSeen.observe(w);   // (again after a stop that kept its wrapper: Minimal, then Full)
  svg._srate = rate; if (svg._ang == null) svg._ang = 0;
  stepped.add(svg);
  if (rate) motionRun();
}
const pauseSpin = svg => { if (svg) svg._srate = 0; };
// Full and Minimal swapped (a game came to the front or left it, a session of yours started or stopped): what moves
// settles where it is now; nothing is drawn again. Back to Full, the next tick turns the fans and rolls the digits
// again. (Before 2.1 the whole view was rebuilt, right as the game took the front: the motion audit 11-04)
function calmSettle() {
  if (motionOn()) { motionRun(); return; }
  for (const svg of [...stepped]) unstep(svg);
  for (const rl of [...rolling]) { rolling.delete(rl); rl._p = rl._to; settleReel(rl); }
  for (const G of graphs.values()) if (G.t0 || G.rev0 || G.colT0) { G.cur = G.from = G.to; G.t0 = 0; G.rev0 = 0; G.colT0 = 0; G.dirty = true; }
  kickGraphs();
}
function sweepSpins() { for (const s of stepped) if (!s.isConnected) unstep(s); }
function glow(r, lvl) {
  const mm = motionMode(); if (mm === 'off' || stillUnder(r.root)) return;   // (behind a popup's blur nobody sees it, 11-08)
  // (a tile: a tinted layer under its content whose opacity fades, on the compositor, so the tile isn't painted again
  // every frame; 1.8 s in Full, 0.9 s in Minimal, which is the mode while a game is in front. Other rows keep the inset
  // shadow, in Full only. 2.1, the motion audit 11-04)
  if (r.kind === 'tile') {   // (a tile is always positioned: no style read mid-write, the motion audit 11-04)
    const o = document.createElement('i'); o.className = 'glw ' + (lvl === 2 ? 'r' : 'y'); r.root.appendChild(o);
    o.animate([{ opacity: 1 }, { opacity: 0 }], { duration: mm === 'full' ? 1800 : 900, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }).finished.then(() => o.remove(), () => o.remove());
    return;
  }
  if (mm !== 'full') return;
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
  if (isBneck(c)) return bnState();
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
// a past session's minutes as a graph (2.1: a Game cell while no game runs): its whole length, a missing minute a gap
function pastState(a, c) {
  const pts = [];
  a.forEach((v, i) => { if (typeof v === 'number' && isFinite(v)) pts.push({ s: 2 * i, v, x: 2 * i + 1 }); });   // (2 apart: a missing minute leaves 4, a gap)
  if (pts.length < 2) return null;
  let lo = Infinity;
  for (const q of pts) if (q.v < lo) lo = q.v;
  const r = BYKEY.get(c.key), u = r && r.unit;
  let hi = scaleTop(pts.map(q => q.v), u).top;
  const minSpan = Math.max(minSpanOf(u), 1, Math.abs(hi) * 0.04);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; if (lo < 0) { hi -= lo; lo = 0; } }
  if (isBneck(c)) { lo = 1; hi = 3; }   // (its calls' levels)
  const yn = c.key === GTIME;   // (Game time's past is its day of play, Yes / No: 2.1.1)
  if (yn) { lo = 0; hi = 1; }
  return { pts, end: 2 * a.length, span: 2 * a.length, lo, hi, past: true, step: isBneck(c) || yn, map: new Map(pts.map(q => [q.s, q])) };
}
function lerpState(a, b, p) {
  if (!a || !b) return b;
  const e = easeInOut(p);
  const pts = b.pts.map(q => { const o = a.map.get(q.s); return o ? { s: q.s, v: o.v + (q.v - o.v) * e, x: o.x + (q.x - o.x) * p } : q; });
  return { pts, end: a.end + (b.end - a.end) * p, span: a.span + (b.span - a.span) * p, lo: a.lo + (b.lo - a.lo) * e, hi: a.hi + (b.hi - a.hi) * e, map: new Map(pts.map(q => [q.s, q])) };
}
function graphFeed(cv, c, col, past) {
  const now = performance.now();
  let G = graphs.get(cv);
  if (!G) { G = { cur: null, from: null, to: null, t0: 0, rev0: cv._enter && now - cv._enter < 1000 && motionOn() ? now : 0, last: 0 }; graphs.set(cv, G); cv._enter = 0; }   // (scrolled to later: no sweep then)
  const same = G.col === col;
  if (G.col && !same && motionOn() && /^#[0-9a-f]{6}$/i.test(G.col) && /^#[0-9a-f]{6}$/i.test(col)) { G.colFrom = G.drawCol || G.col; G.colT0 = now; }   // (2.1: 300 ms, as the text)
  G.col = col;
  // (2.1, the perf review 11-04: a past session's minutes don't change: drawn once, not every second)
  if (Array.isArray(past) && same && G.pastRef === past && G.to && G.to.past && !G.t0 && !G.colT0) return;
  G.pastRef = Array.isArray(past) ? past : null;
  const st = Array.isArray(past) ? pastState(past, c) : graphState(c);   // (past: a session's minutes, see pastState)
  if (!st) { G.cur = G.from = G.to = null; G.dirty = true; kickGraphs(); return; }
  // (a slide too small to see isn't played, just drawn once: most seconds a steady reading moves under a pixel, and those
  // slides were most of Full's cost, 27% of a core with 40 cells against 19% without them, 10-13)
  // (2.1: nothing a pixel would show, the last drawing stays; the change adds up until it shows, then it is drawn. Most
  // seconds a steady reading's line moves under a pixel)
  const shows = !G.to || !!G.to.past !== !!st.past || !same || seenMove(G.cur || G.to, st, G);
  if (!shows && !G.t0 && !G.colT0 && !G.rev0) return;
  if (st.step || !G.to || !motionOn() || catchUp || stillUnder(cv) || !!G.to.past !== !!st.past || !shows) { G.cur = G.from = G.to = st; G.t0 = 0; }   // (a step graph, the bottleneck's calls: never slid)
  else { G.from = G.cur || G.to; G.to = st; G.t0 = now; }
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
    const p = G.t0 ? Math.max(0, Math.min(1, (now - G.t0) / GDUR)) : 1, rv = G.rev0 ? Math.max(0, Math.min(1, (now - G.rev0) / 800)) : 1, cp = G.colT0 ? Math.max(0, Math.min(1, (now - G.colT0) / 300)) : 1;   // (a frame stamped before its start: 0, not below, 11-09)
    G.drawCol = cp < 1 ? mixHex(G.colFrom, G.col, cp) : G.col; if (cp >= 1) G.colT0 = 0;
    const moving = p < 1 || rv < 1 || cp < 1;
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
  const st = G.cur, col = G.drawCol || G.col;   // (mid-blend: the colour on its way, 2.1; the motion audit 11-04 found it never drawn)
  if (!st || st.pts.length < 2) return;
  const pad = 5 * dpr, x0 = st.end - st.span, X = x => 1 + (x - x0) / st.span * (w - 1 - pad), Y = v => h - 3 * dpr - (Math.min(st.hi, Math.max(st.lo, v)) - st.lo) / (st.hi - st.lo) * (h - 3 * dpr - pad);   // (a cut spike at the top edge)
  ctx.save();
  if (rev < 1) { ctx.beginPath(); ctx.rect(0, 0, w * rev, h); ctx.clip(); }
  // a stretch with no readings (HWiNFO away) is a gap, not a straight line across it
  const segs = [];
  st.pts.forEach((q, i) => { if (!i || q.s - st.pts[i - 1].s > 2) segs.push([]); segs[segs.length - 1].push(q); });
  // (a step graph, the bottleneck's calls: level, then the step, 2.1)
  const trace = sg => sg.forEach((q, i) => { if (!i) { ctx.moveTo(X(q.x), Y(q.v)); return; } if (st.step) ctx.lineTo(X(q.x), Y(sg[i - 1].v)); ctx.lineTo(X(q.x), Y(q.v)); });
  ctx.beginPath();
  for (const sg of segs) trace(sg);
  ctx.strokeStyle = col; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.4 * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();
  ctx.fillStyle = col;   // a reading on its own between gaps (a line needs two) still shows, as a dot
  for (const sg of segs) if (sg.length === 1) { ctx.beginPath(); ctx.arc(X(sg[0].x), Y(sg[0].v), 1.1 * dpr, 0, 7); ctx.fill(); }
  const tip = st.pts[st.pts.length - 1];
  ctx.beginPath();
  for (const sg of segs) { trace(sg); ctx.lineTo(X(sg[sg.length - 1].x), h); ctx.lineTo(X(sg[0].x), h); ctx.closePath(); }
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, col + '2e'); grad.addColorStop(1, col + '00');
  ctx.globalAlpha = 1; ctx.fillStyle = grad; ctx.fill();
  if (rev >= 1) {
    ctx.fillStyle = col + '38'; ctx.beginPath(); ctx.arc(X(tip.x), Y(tip.v), 4.2 * dpr, 0, 7); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(tip.x), Y(tip.v), 1.9 * dpr, 0, 7); ctx.fill();
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
const sensorHere = c => (!READ.length && !feed.fake) || (!!c.key && SENS.some(sn => c.key.startsWith(sn.key + '/')));   // (no readings at all yet, HWiNFO off: not sharing, not "not on this PC", 11-06)
// a missing reading whose sensor is still here comes and goes (the battery's time left while plugged in, his pick E
// 11-08): "not available now" outside edit mode, no Re-link. One the history has had no value for in 7 days (HWiNFO
// renamed it) is gone: Re-link back. LASTV: key, when it last had a value (unix s, 0: never), from the host; lastvSince:
// when the history starts. HW Deck's own readings and an extras build's are never renamed: always a pause
const LASTV = new Map(), WEEK_S = 7 * 86400;
let lastvSince = 0, lastvAsked = '', lastvAt = 0;
const quietGone = c => { const at = c.key && !/^(hwdeck|x)\./.test(c.key) ? LASTV.get(c.key) : undefined, now = Date.now() / 1000; return at === undefined ? false : at > 0 ? now - at >= WEEK_S : lastvSince > 0 && now - lastvSince >= WEEK_S; };   // (never a value in a history of a week or more: gone at once; in a younger one, a fresh install, a pause yet, the suite 11-08)   // (never a value here: gone at once, a reading of another PC's sensor with the same key, review 11-08)
const neverHere = c => LASTV.get(c.key) === 0;
const isPause = c => sensorHere(c) && !quietGone(c);
const missingTxt = c => !sensorHere(c) ? 'not on this PC: ' + (c.match ? c.match.split('|')[0] : c.key) : !S.edit ? 'not available now' : isPause(c) ? 'HWiNFO isn\'t sharing this right now' : neverHere(c) ? 'never shared on this PC' : 'not shared by HWiNFO for 7 days';
const missingShort = c => !sensorHere(c) ? 'not on this PC' : !S.edit ? 'not available now' : isPause(c) ? 'not shared by HWiNFO' : neverHere(c) ? 'never shared here' : 'not shared for 7 days';   // (where those are cut, 2.2)
// (the missing readings whose sensor is here: when each last had a value, asked when that set changes, or after an hour, 11-08)
function lastvAsk(cells) {
  const ks = READ.length ? cells.filter(k => !BYKEY.has(k) && !/^(hwdeck|x)\./.test(k) && SENS.some(sn => k.startsWith(sn.key + '/'))).sort() : [], s = ks.join('\n');
  if (!ks.length || (s === lastvAsked && Date.now() - lastvAt < 3600000)) return;
  lastvAsked = s; lastvAt = Date.now(); send({ t: 'lastval', keys: ks });
}
const isFanCell = c => c.pred || isFanR(BYKEY.get(c.key));
function catHead(cat, inner) {
  return '<span class="grip" title="Drag to move the category: onto another one\'s edge to put them side by side or stack them">' + ICONS.grip + '</span>' + (inner || '') +   // (no collapse button: categories always show, his call 11-02)
    '<span class="cn"' + (S.edit ? ' title="Click to select, double-click to rename"' : '') + '>' + esc(cat.name) + '</span><span class="cnt">' + cat.cells.length + '</span>' +
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
const cellSize = id => { const l = cellLook(id, 'tiles'), f = fNum(l.f); return isSz(l.size) ? { w: SZ[l.size][0], h: SZ[l.size][1], f: null } : { w: f ? 1 : l.w || 1, h: l.h || 1, f, fx: !!(f && l.fx) }; };
// a category's cells in this view: its lead (the reading it shows first) moves to the front
function idsIn(cat) {
  const ids = cellsOf(cat), lead = catLook(cat.id).lead, i = lead ? ids.indexOf(lead) : -1;
  return i > 0 ? [lead].concat(ids.slice(0, i), ids.slice(i + 1)) : ids;
}
// a popup for a reading with no cell in the layout (an extras build opens one from its own menu, 2.1): its cell is
// kept aside here, never in the layout or saved
const TCELL = {};
const cellAt = cid => S.L.cells[cid] || TCELL[cid];
function openReading(key, name, rng) { const cid = 't:' + key; if (!TCELL[cid]) TCELL[cid] = { key, name: name || '' }; openDetail(cid, rng); subscribe(); }   // (its last 15 min come with the subscription)
const nameIn = cid => cellLook(cid).name || cellName(cellAt(cid));
const headTab = () => S.edit ? ' tabindex="0"' : '';
function tileHtml(cid, lk, pre) {
  const c = S.L.cells[cid], r = c.key ? BYKEY.get(c.key) : null, miss = isMissing(c), short = !!lk && lk.size === 'short', z = cellSize(cid), nm = nameIn(cid);
  const xb = miss ? null : xBody(cid, r, short ? 'short' : 'tile');
  // (a short tile has no graph, but the bottleneck and an extras reading that asks for one keep a small one, 11-04)
  const xk = xkOf(r), sg = isBneck(c) || !!(xk && xk.shortGraph);
  const graph = xb != null ? xb : c.graph === false ? '' : short ? (sg ? '<canvas class="sg"></canvas>' : '') : '<canvas></canvas>';
  const nog = xb == null && (miss || c.graph === false || (short && !sg));
  return '<div class="tile dc' + (c.pred ? ' pred' : '') + (short ? ' short' : '') + (miss ? ' missing' : '') + (nog ? ' nog' : '') + (isBneck(c) ? ' bn' : '') + (cid === sel ? ' sel' : '') + (pre ? pre[1] : '') + anim() + (pre ? ';' + pre[0] : '') + '" data-cid="' + esc(cid) + '" data-k="tile" tabindex="0"' +
    (z.f ? ' data-f="' + z.f + '"' + (z.fx ? ' data-fx="1"' : '') : z.w !== 1 ? ' data-w="' + z.w + '"' : '') + (z.h !== 1 ? ' data-h="' + z.h + '"' : '') + (cellLook(cid, 'tiles').nl ? ' data-nl="1"' : '') + '>' +
    '<div class="tn">' + iconOf(c, r) + '<span data-full="1">' + esc(nm) + '</span><span class="tq"></span></div>' +   // (a name cut short shows whole on hover: see the tips)
    '<div class="tv"><span class="v"></span><small class="u">' + esc(c.pred ? 'RPM' : unitOf(r)) + '</small></div><div class="tc"></div>' +
    (miss ? (S.edit && !isPause(c) ? '<button class="btn rl">Re-link</button>' : '') : graph) + (S.edit ? '<span class="corner" title="Drag to size it, double-click for a normal tile">' + ICONS.corner + '</span>' : '') + '</div>';
}
// Tiles: a block per category, a tile per cell (auto: blocks past 6 cells take the whole width)
function blkHtml(cat, inRows) {
  const ids = idsIn(cat), lk = catLook(cat.id), pm = packMemo.get(cat.id), pre = pm && pm.cids === ids.join('|') && pm.edit === S.edit && pm.sig === packSig(cat) ? pm : null;
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
          (b.xb != null ? b.xb : b.on ? '<canvas class="rsp"></canvas>' : b.miss && S.edit && !isPause(b.c) ? rl : '<span class="gph"></span>') + '</div>';
      }).join('') + '</div></section>';
  const hero = lk.style !== 'list';
  return '<section class="card ' + cls + (lk.style === 'small' ? ' small' : '') + (lk.style === 'list' ? ' list' : '') + anim() + '" data-cat="' + esc(cat.id) + '"><div class="ch dch"' + headTab() + '>' + catHead(cat, icon) + '<span class="tag"></span></div>' +
    '<div class="dgrid vert">' + ids.map((cid, i) => {
      const b = bits(cid);
      if (i === 0 && hero) return '<div class="hero dc' + b.cls + '" data-cid="' + esc(cid) + '" data-k="hero" tabindex="0"><div><div class="nm">' + iconOf(b.c, b.r) + '<span>' + esc(nameIn(cid)) + '</span></div>' +
        '<div class="hv"><span class="v"></span><small class="u">' + b.u + '</small></div><div class="hc"></div>' + (b.miss && S.edit && !isPause(b.c) ? rl : '') + '</div>' +
        (b.xb != null ? xBody(cid, b.r, 'hero') : b.on ? '<canvas></canvas>' : '<span></span>') + '</div>';
      const mid = b.xb != null ? b.xb : b.on ? '<canvas class="rsp"></canvas>' : b.miss && S.edit && !isPause(b.c) ? rl : '';
      return '<div class="row dc' + b.cls + (mid ? '' : ' nog') + '" data-cid="' + esc(cid) + '" data-k="row" tabindex="0"><span class="lbl">' + b.nm + '<i></i></span>' + mid + val(b.u) + '</div>';
    }).join('') + '</div></section>';
}
// what a view's rows hold right now: outside edit mode an empty category isn't shown, so it takes no room
function visRows(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const cols = [];
    r.cols.forEach((c, j) => {
      const stack = [];
      for (const ln of stackLines(c.stack)) ln.filter(s => { const cat = catById(sid(s)); return cat && (S.edit || cellsOf(cat).length); }).forEach((s, k) => stack.push(k ? { id: sid(s), b: 1 } : sid(s)));   // (a line's first hidden: the next one leads it)
      if (stack.length) cols.push({ w: c.w, stack, i: j });
    });
    if (cols.length) out.push({ h: r.h, cols, i });
  });
  return out;
}
// the narrowest a column can be before its row folds (in rem): one tile (Auto), its tiles per row, or a card
const gapSp = () => { const v = viewOf(S.screen); return v && v.gap === 'tight' ? 0.6 : v && v.gap === 'roomy' ? 1.5 : 1; };
// one category's narrowest (rem): one tile (Auto), its tiles per row, or a card. Beside others in a line: collapsed, its
// title; empty, nothing (it isn't drawn outside edit mode, nor while edit mode fits, 11-07 audit)
function catMin(cat, inLine, withOthers, sp) {   // (withOthers: a mate with cells beside it, as drawn outside edit mode)
  const lk = catLook(cat.id), n = cellsOf(cat).length;
  if (inLine && !n) return 0;
  if (withOthers && cat.collapsed) return 10;
  if (S.screen === 'tiles') { if (lk.per) { const k = Math.max(1, Math.min(lk.per, n || 1)); return k * 8.5 + (k - 1) * 0.62 * sp; } return lk.size === 'short' ? 15 : TILE_MIN; }
  return 22;   // a card, a list, a band (it wraps its cells when narrow)
}
function colMin(c) {
  const sp = gapSp();
  let m = 0;
  for (const ln of stackLines(c.stack)) { const nr = ln.filter(s => cellsOf(catById(sid(s))).length).length, ms = ln.map(s => catMin(catById(sid(s)), ln.length > 1, nr > 1, sp)), k = ms.filter(x => x > 0).length; m = Math.max(m, ms.reduce((a, b) => a + b, 0) + Math.max(0, k - 1) * (S.screen === 'tiles' ? 1.7 : 0.92) * sp); }   // (a line: its members side by side with the gaps between)
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
    h += '<div class="lrow" data-r="' + r.i + '"' + (manual ? ' data-w="' + r.cols.map(c => c.w).join(',') + '"' : ' data-auto="1"') + (tiles && (r.h || fillAll('tiles')) ? ' data-fill="1"' : '') + ' style="--cols:' + colTracks(manual ? r.cols : r.cols.map(() => ({}))) + '">';
    for (const c of r.cols) h += '<div class="lcol" data-c="' + c.i + '" data-min="' + colMin(c) + '">' + stackLines(c.stack).map(ln => ln.length < 2 ? block(catById(sid(ln[0])), true) : '<div class="lsub" data-min="' + colMin({ stack: ln }) + '" data-mine="' + (S.edit ? ln.filter(x => !cellsOf(catById(sid(x))).length).length * (TILE_MIN + (S.screen === 'tiles' ? 1.7 : 0.92) * gapSp()) : 0) + '" style="' + ln.map((s, j) => '--s' + (j + 1) + ':' + lineShare(catById(sid(s))) + ';--m' + (j + 1) + ':' + catMin(catById(sid(s)), true, ln.filter(x => cellsOf(catById(sid(x))).length).length > 1, gapSp()) + 'rem').join(';') + '">' + ln.map(s => block(catById(sid(s)), true)).join('') + '</div>').join('') + '</div>';
    if (S.edit && !auto) {   // (Automatic has no handles: a drop makes it your own first)
      for (let k = 0; k < r.cols.length - 1; k++) h += '<span class="ldiv" data-k="' + k + '" title="Drag to change the widths, double-click to let them follow what each column holds"></span>';
      if (tiles) h += '<span class="lrs" title="Fill: drag down to let its tiles grow into spare room. Fit: drag up to keep them as they are"></span>';
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
  // (no stack past what a column holds, MAXS, nor a row past MAXC: what Automatic shows comes through cleanViews as it
  // is, so making it your own moves nothing; it moved the 7th category of a column to the bottom, 11-06)
  const rows = [];
  const put = id => { let r = rows[rows.length - 1], c = r && r.cols[r.cols.length - 1]; if (!c || c.stack.length >= MAXS[vn]) { if (r && r.cols.length < MAXC[vn]) r.cols.push(c = { stack: [] }); else rows.push(r = { cols: [c = { stack: [] }] }); } c.stack.push(id); };
  if (!cats.length) { for (const c of S.L.cats) put(c.id); return rows; }
  const v = viewOf(vn), sp = v && v.gap === 'tight' ? 0.6 : v && v.gap === 'roomy' ? 1.5 : 1, fs = cssScale();
  const W = Math.max(1, sectionsEl.clientWidth - 36) / fs, gap = (vn === 'tiles' ? 1.7 : 0.92) * sp, min = vn === 'tiles' ? 30 : 27;
  const n = Math.max(1, Math.min(MAXC[vn], cats.length, Math.floor((W + gap) / (min + gap) + 1e-6))), colW = (W - (n - 1) * gap) / n, g = 0.62 * sp;
  // how tall a category comes out in a column that wide (rem, roughly: it only decides where categories go)
  const tall = cat => {
    if (cat.collapsed) return 2.4;
    const ids = cellsOf(cat), lk = catLook(cat.id, vn);
    if (vn === 'tiles') {
      const short = lk.size === 'short', k = Math.max(1, lk.per ? Math.min(lk.per, Math.floor((colW + g) / (8.5 + g))) : Math.floor((colW + g) / ((short ? 15 : TILE_MIN) + g)));
      const area = ids.reduce((a, id) => { const z = cellSize(id); return a + Math.min(z.f ? z.f * k : z.w, k) * z.h; }, 0);
      return 2.2 + Math.max(1, Math.ceil(area / k - 1e-6)) * ((short ? 3.4 : 8.6) + g);
    }
    if (lk.style === 'band') return 5;
    return 4.2 + (lk.style === 'list' ? 0 : lk.style === 'small' ? 4.6 : 7.3) + Math.max(0, ids.length - (lk.style === 'list' ? 0 : 1)) * 2.9;
  };
  // the biggest first, each into the column that is shortest so far (the columns come out about level); then each
  // column in your order, and the columns in the order of their first category
  // (more categories than n full columns hold: the next ones in a row under, in your order)
  const at = new Map(cats.map((c, i) => [c.id, i])), per = n * MAXS[vn];
  for (let s = 0; s < cats.length; s += per) {
    const cols = Array.from({ length: n }, () => ({ stack: [], h: 0 }));
    for (const c of cats.slice(s, s + per).map(c => [c, tall(c)]).sort((a, b) => b[1] - a[1] || at.get(a[0].id) - at.get(b[0].id))) {
      const col = cols.filter(x => x.stack.length < MAXS[vn]).reduce((a, b) => b.h < a.h - 0.01 ? b : a); col.stack.push(c[0].id); col.h += c[1] + gap;
    }
    for (const c of cols) c.stack.sort((a, b) => at.get(a) - at.get(b));
    rows.push({ cols: cols.filter(c => c.stack.length).sort((a, b) => at.get(a.stack[0]) - at.get(b.stack[0])).map(c => ({ stack: c.stack })) });
  }
  for (const c of S.L.cats) if (!cats.includes(c)) put(c.id);   // (empty ones, hidden outside edit mode)
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
        return '<tr class="dc' + (miss ? ' missing' : '') + (isBneck(c) ? ' bn' : '') + (cid === sel ? ' sel' : '') + '" data-cid="' + esc(cid) + '" data-k="grow" tabindex="0"><td class="gname">' + iconOf(c, r) + '<span>' + esc(nameIn(cid)) + '</span>' + (miss && S.edit && !isPause(c) ? '<button class="btn rl">Re-link</button>' : '') + '</td>' +
          '<td class="gval"><span class="v"></span><span class="u gu">' + esc(c.pred ? 'RPM' : unitOf(r)) + '</span></td>' +
          (xb != null ? '<td class="gstrip" colspan="3">' + xb + '</td>' : isBneck(c) && !miss ? '<td class="gstrip" colspan="3">' + (c.graph !== false ? '<canvas></canvas>' : '') + '</td>' : '<td class="gn"></td><td class="gn"></td><td class="gn"></td>') + '<td class="glines"></td><td class="ginfo"></td></tr>';
      }).join('') + '</tbody>').join('') + '</table></div>';
  const v = viewOf('grid');
  if (v && v.rows) {   // your tables: each column of the one row is a table
    const r = visRows(v.rows)[0], cols = r ? r.cols : [];
    return '<div class="gsplit arr" id="view" style="--gt:repeat(' + Math.max(1, cols.length) + ', minmax(0, 1fr))">' +
      cols.map(c => table(c.stack.map(s => ({ cat: catById(sid(s)) })))).join('') + '</div>';
  }
  // two tables side by side when there is room, cut at the middle line (gridCut)
  const [t1, t2] = gridCut(gridItems(), gridTwo());
  return '<div class="gsplit" id="view">' + (t1.length ? table(t1) : '') + (t2.length ? table(t2) : '') + '</div>';
}
function setupHtml() {
  return '<div class="setup" id="view"><h2>HWiNFO isn\'t sharing its sensors yet</h2><span>' + esc(feed.brand || 'HW Deck') + ' shows what HWiNFO measures. Set HWiNFO up once:</span><ol>' +
    '<li>Install HWiNFO from hwinfo.com and start it with <b>Sensors-only</b> ticked.</li><li>In its sensors window, click <b>Config</b>, then <b>Main Settings</b>.</li>' +
    '<li>On the <b>General / User Interface</b> tab, tick <b>Shared Memory Support</b>, then OK.</li>' +
    '<li>Keep HWiNFO running. The free version stops sharing after 12 hours. ' + (feed.keep ? esc(feed.brand || 'HW Deck') + ' restarts it before that (<b>Keep HWiNFO sharing</b> in Settings).' : 'Optional: turn on <b>Keep HWiNFO sharing</b> in Settings and ' + esc(feed.brand || 'HW Deck') + ' restarts it for you, so it never runs out.') + '</li></ol>' +
    '<span>This screen goes away by itself once the readings arrive. Already set up, and still nothing?</span>' +
    '<span><button class="btn" id="setupRestart"' + (feed.fake ? ' disabled' : '') + '>Restart HWiNFO</button></span></div>';
}
function emptyHtml() {
  return '<div class="empty" id="view">' + ICONS.pad + '<b>No cells yet</b><span>' + (S.edit ? 'Drag readings from Storage here, or press + on a row.<br>Drop one on the box below to make a category.'
    : 'Turn on Edit layout with the pencil or E to add readings.') + '</span>' +
    (!feed.ext && READ.some(r => !r.key.startsWith('hwdeck.')) ? '<span>Or start from a layout built from this PC\'s sensors: <button class="btn" id="starterBtn">Starter layout</button></span>' : '') + '</div>';
}
function buildView() {
  // a category rename in progress keeps what was typed (without a second render in the middle of this one)
  const ren = document.querySelector('#view .cn-in');
  if (ren && ren._commit) ren._commit(true, true);
  ro.disconnect();
  animI = 0;
  if (sectionsEl._slide) { sectionsEl._slide.cancel(); sectionsEl._slide = null; }
  sectionsEl.classList.remove('sliding');
  const angs = new Map(); for (const [cid, r] of E) if (r.fan && r.fan._ang) angs.set(cid, r.fan._ang);   // (a fan keeps its angle across a rebuild, as when it stops: it snapped upright, 11-08)
  const old = $('view');
  // (the cell or category header that had the focus gets it back in the new view, 11-06: it fell to the page)
  const fa = document.activeElement, fq = fa && fa.matches && fa.matches('#view .dc[data-cid]') ? '.dc[data-cid="' + CSS.escape(fa.dataset.cid) + '"]' : fa && fa.matches && fa.matches('#view .dch') && fa.closest('.dcat') ? '.dcat[data-cat="' + CSS.escape(fa.closest('.dcat').dataset.cat) + '"] .dch' : null;
  for (const cv of old.querySelectorAll('canvas')) { cv.width = 0; cv.height = 0; }   // their memory goes now, not at some later collection
  const none = !S.L.cats.length || (!S.edit && !S.L.cats.some(c => cellsOf(c).length));   // (categories with no cells, out of edit mode: the empty state, not a blank view, 11-06)
  const html = none ? (feed.got && !READ.length && feed.status === 'missing' && !feed.fake ? setupHtml() : emptyHtml())
    : S.screen === 'grid' ? buildGrid() : S.screen === 'overview' ? buildOverview() : buildTiles();
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  old.replaceWith(tmp.firstChild);
  if (fq) { const n = document.querySelector('#view ' + fq); if (n) n.focus({ preventScroll: true }); }
  sweepSpins();   // (after: the old view's fans are out of the page now, 11-06; before, it kept them and the view alive)
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
    const r = { root: el, cid, kind: el.dataset.k, v: q('.v'), u: q('.u'), vbox: q('.tv, .hv, .val, .gval'), cap: q('.tc, .hc, .lbl i, .ginfo'), tq: q('.tq'), canvas: q('canvas') || el.querySelector('.xb canvas.xg'), strip: q('.strip'), lines: q('.glines'), xb: el.querySelector('.xb') };
    if (r.kind === 'grow') r.td = el.children;
    if (c && isFanCell(c)) r.fan = q('.tn svg, .nm svg, .gname svg');
    if (r.fan && angs.has(cid)) { r.fan._ang = angs.get(cid); const w = document.createElement('i'); w.className = 'spw'; r.fan.replaceWith(w); w.appendChild(r.fan); w.style.transform = 'rotate(' + r.fan._ang.toFixed(1) + 'deg)'; }   // (wrapped and turned at once; spinIcon observes it when it turns)
    if (r.canvas) { r.canvas._enter = enterNext ? performance.now() : 0; ro.observe(r.canvas); }   // (when the view arrived)
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
  entEnd = performance.now() + (dir ? 400 : 650);
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
  const was = flipNext && !enter && !enterNext && (flipNext !== 'live' || (motionOn() && !modalUp && !document.hidden)) ? catRects() : null;   // an edit: the categories and cells glide from where they were; a reading that comes or goes too ('live': Full only, not under a popup, it is no click, 11-08)
  flipNext = false;
  TINT.clear();   // (cells may have moved between categories)
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
  const b = S.edit && sel ? document.querySelector('#insp input[data-sz="f"]') : null; if (!b) return;
  const pct = cellPct(sel); if (pct == null) return;   // (the panel's own readout: field and chips agree, 11-06 audit)
  if (b !== document.activeElement) b.value = Math.round(pct * 10) / 10;
  const z = cellSize(sel), au = !z.f && z.w === 1;
  const off = cfOff(sel);
  for (const x of document.querySelectorAll('#insp [data-lay="cf"] button')) { const on = x.dataset.v === 'auto' ? au : !au && Math.abs(+x.dataset.v - pct) < 0.5; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); if (x.dataset.v !== 'auto') x.disabled = off(+x.dataset.v); }   // (greyed as the width now allows, 11-08)
}
// a tile's width as the panel shows it, in % of its row: the share it is drawn at (a row of tiles you haven't sized spreads
// out to fill its width, three of 25% drawn at a third each, his 11-06 "showing 25% but it should show 33%"; one you sized
// is drawn as set), else its own; null when it isn't drawn
function cellPct(cid) {
  const z = cellSize(cid), G = tileGeo(tileEl(cid)), own = z.f ? z.f * 100 : G ? Math.min(G.s.w, G.k) / G.k * 100 : null;
  const drawn = G && G.tw > 0 ? Math.min(100, (G.r.width + G.g) / (G.tw + G.g) * 100) : null;
  return drawn == null ? own : own != null && Math.abs(drawn - own) < 1 ? own : (PCTS.find(q => Math.abs(q - drawn) < 1) || drawn);
}
// the widths a tile can't be drawn at in its category as it is now (under the minimum, or a row that can't hold it as
// set): their chips greyed, so a chip never does nothing or something else (his 11-08 "if u click 33% nothing happens
// but if u click 25% it allows but puts 33%")
function cfOff(cid) {
  const G = tileGeo(tileEl(cid)); if (!G) return () => false;
  return x => { const w = x / 100 * G.k; return w < G.k - PE && Math.abs(G.at(w, G.s.h).w - w) > 0.012 * G.k; };
}
let flipNext = false;
// (a drop: the cell or category glides from where it was let go, not from its old slot, still there under the ghost)
let flipFrom = null;
// (a category's key here: Grid cuts one over its two tables, and the part that goes on is its own, 11-08 review)
const flipKey = el => el.dataset.cat + (el.classList.contains('cont') ? '|cont' : '');
function catRects() {
  const m = new Map(); m.cells = new Map();   // (Grid too: its rows glide, 11-08)
  m.fs = parseFloat(document.documentElement.style.fontSize) || 0;   // (the size it was fitted at: see playFlip)
  // (a hidden one, an empty category outside edit mode, has no box to glide from: it just comes)
  for (const el of document.querySelectorAll('#view .dcat')) { const r = el.getBoundingClientRect(); if (r.width || r.height) { r.el = el; m.set(flipKey(el), r); } }   // (el: one that goes fades where it was, flipGhost)
  for (const el of document.querySelectorAll('#view .dc[data-cid]')) { const r = el.getBoundingClientRect(); if (r.width || r.height) { r.el = el; m.cells.set(el.dataset.cid, r); } }   // (and the cells: an edit's neighbours glide aside)
  if (flipFrom && performance.now() - flipFrom.t < 500) { const r = flipFrom.r; r.drop = true; (flipFrom.kind === 'cat' ? m : m.cells).set(flipFrom.id, r); }   // (the ghost's box: a glide from it, see playFlip)
  flipFrom = null;
  return m;
}
function playFlip(was) {
  // (Minimal: a short glide, where it goes only, no fades: an edit is a reply to a click, as drawers and toggles are;
  // his autopilot list 11-05, "edits glide in Minimal", 2.2. Off: none)
  const mode = motionMode(), full = mode === 'full', dur = full ? 280 : mode === 'minimal' ? 180 : 0;
  if (!dur) return;
  const grid = S.screen === 'grid';   // (Grid's rows glide through their cells, 11-08: it snapped)
  const half = full ? 0.5 : 1;   // (a new size, from its old middle: half seen in Full, whole in Minimal)
  const moved = new Set();   // (the categories that glide: their cells go with them)
  // (the old sizes at the new fitted size: a refit alone, a few % smaller, is a glide; it faded every category to half,
  // 11-06)
  const fs1 = parseFloat(document.documentElement.style.fontSize) || 0, k = was.fs && fs1 ? fs1 / was.fs : 1;
  for (const el of document.querySelectorAll('#view .dcat')) {
    const a = was.get(flipKey(el));
    if (!a) { if (full && was.size && el.getClientRects().length) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' }); continue; }   // (one that comes: an empty one as E shows it, 11-08 review)
    const b = el.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
    // (let go: from the ghost's middle to its place, whole, 11-06; the ghost is a small label, never its size)
    if (a.drop) { moved.add(el); el.animate([{ transform: 'translate(' + (a.left + a.width / 2 - b.left - b.width / 2) + 'px, ' + (a.top + a.height / 2 - b.top - b.height / 2) + 'px)' }, { transform: 'none' }], { duration: dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); continue; }
    // (a new width or height: from its old middle, half seen, so its tiles packed anew never show mid-jump; 11-02)
    if (Math.abs(a.width * k - b.width) > 8 || Math.abs(a.height * k - b.height) > 8) { moved.add(el); el.animate([{ transform: 'translate(' + (a.left + a.width / 2 - b.left - b.width / 2) + 'px, ' + (a.top + a.height / 2 - b.top - b.height / 2) + 'px)', opacity: half }, { transform: 'none', opacity: 1 }], { duration: dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); }
    else if (Math.abs(dx) + Math.abs(dy) > 1) { moved.add(el); el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); }
  }
  // (one an edit took away: a copy fades where it was as its neighbours close the gap, as a new one comes in; Full,
  // 11-08: it vanished)
  if (full) {
    const here = s => document.querySelector('#view ' + s) !== null, shown = s => { const e = document.querySelector('#view ' + s); return !!e && e.getClientRects().length > 0; }, gone = [];
    for (const [, a] of was) if (a.el && a.el.dataset.cat && !shown('.dcat' + (a.el.classList.contains('cont') ? '.cont' : '') + '[data-cat="' + CSS.escape(a.el.dataset.cat) + '"]')) gone.push(a);
    if (was.cells) for (const [id, a] of was.cells) if (a.el && a.el.tagName !== 'TR' && !here('.dc[data-cid="' + CSS.escape(id) + '"]') && !gone.some(g => g.el.contains(a.el))) gone.push(a);
    for (const a of gone) flipGhost(a);
  }
  // (the selection gliding: the settings look again where it ends, 11-06; they read it mid-glide and stayed over it)
  const se = sel ? document.querySelector('#view .dc[data-cid="' + sel + '"]') : selCat ? document.querySelector('#view .dcat[data-cat="' + selCat + '"]') : null;
  if (se && S.edit) setTimeout(() => { const an = se.getAnimations().concat(se.closest('.dcat') ? se.closest('.dcat').getAnimations() : []); if (an.length) Promise.allSettled(an.map(a => a.finished)).then(() => syncDrawers()); }, 0);
  // the cells an edit moved glide from where they were, a new one comes in; not those whose category glides with them
  if (!was.cells) return;
  for (const el of document.querySelectorAll('#view .dc[data-cid]')) {
    const c = el.closest('.dcat'); if (c && moved.has(c)) continue;
    if (grid && el.tagName === 'TR') {   // (a row: its cells move, translate only; a new one fades in in Full, 11-08)
      const a = was.cells.get(el.dataset.cid), tds = [...el.children];
      if (!a) { if (full) for (const td of tds) td.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' }); continue; }
      const b = el.getBoundingClientRect(), dx = a.drop ? a.left + a.width / 2 - b.left - b.width / 2 : a.left - b.left, dy = a.drop ? a.top + a.height / 2 - b.top - b.height / 2 : a.top - b.top;
      if (Math.abs(dx) + Math.abs(dy) > 1) for (const td of tds) td.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: full ? 240 : dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      continue;
    }
    const a = was.cells.get(el.dataset.cid);
    if (!a) { if (full) el.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' }); continue; }
    const b = el.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
    if (a.drop) { el.animate([{ transform: 'translate(' + (a.left + a.width / 2 - b.left - b.width / 2) + 'px, ' + (a.top + a.height / 2 - b.top - b.height / 2) + 'px)' }, { transform: 'none' }], { duration: full ? 240 : dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); continue; }   // (let go: from the ghost, whole)
    // (a new size, a size button or a wider row: from its old middle, half seen, as a category; it snapped while its
    // neighbours glided: the motion audit 11-04)
    if (Math.abs(a.width * k - b.width) > 8 || Math.abs(a.height * k - b.height) > 8) { el.animate([{ transform: 'translate(' + (a.left + a.width / 2 - b.left - b.width / 2) + 'px, ' + (a.top + a.height / 2 - b.top - b.height / 2) + 'px)', opacity: half }, { transform: 'none', opacity: 1 }], { duration: full ? 240 : dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); continue; }
    if (Math.abs(dx) + Math.abs(dy) > 1) el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: full ? 240 : dur, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}

// a cell or category an edit removed: a copy of it fades where it was, outside #view so nothing that reads the view
// (fit, catRects, a check) sees it (11-08, the motion audit: it vanished while its neighbours glided into the gap)
function flipGhost(a) {
  if (a.el.tagName === 'TBODY' || a.el.tagName === 'TR') return;   // (Grid: outside its table it draws as bare rows: it just goes, 11-08 review)
  const v = $('view'), g = a.el.cloneNode(true);
  { const oc = a.el.querySelectorAll('canvas'), gc = g.querySelectorAll('canvas'); gc.forEach((c, i) => { try { if (oc[i] && oc[i].width && oc[i].height) c.getContext('2d').drawImage(oc[i], 0, 0); } catch (e) { /* nothing to copy */ } }); }   // (a copy has no picture: its graph, 11-08 review)
  for (const x of [g, ...g.querySelectorAll('[id], [data-cid], [data-cat], [tabindex]')]) { x.removeAttribute('id'); x.removeAttribute('data-cid'); x.removeAttribute('data-cat'); x.removeAttribute('tabindex'); }
  g.classList.remove('sel', 'csel', 'dragging'); g.classList.add('flipghost'); g.setAttribute('aria-hidden', 'true'); g.inert = true;
  Object.assign(g.style, { position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: '0', pointerEvents: 'none', zIndex: '5', boxSizing: 'border-box' });
  v.parentNode.appendChild(g);
  const r = g.getBoundingClientRect(); if (Math.abs(r.left - a.left) + Math.abs(r.top - a.top) > 0.5) { g.style.left = 2 * a.left - r.left + 'px'; g.style.top = 2 * a.top - r.top + 'px'; }   // (a parent that holds fixed boxes: where it was all the same)
  const an = g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 200, easing: 'ease-out' });
  an.onfinish = an.oncancel = () => g.remove();
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
// which cells are on screen (their graphs are drawn): read at the top of a tick, before it writes anything, so the
// second lays the page out once (2.1, the perf review 11-04)
let sightPre = null;
// a tile's caption with shorter words (e.subS, for the caption it was made with): its own when they fit, else the
// shorter ones. Measured (is it cut?) only when its text or its size changes, all of a second's at once after its
// writes; a ResizeObserver says when the size changed (2.1.2)
const capRO = new ResizeObserver(es => { for (const e of es) e.target._fit = null; });
let capQ = [];
function capSet(el, full, short) {
  if (!short || short === full) { if (el) el._fit = null; setText(el, full); return; }   // (no measure kept of a caption it had before: capRefit would put that one back)
  if (!el._capRO) { el._capRO = true; capRO.observe(el); }
  const f = el._fit;
  if (f && f.full === full && f.short === short) { setText(el, f.cut ? short : full); return; }
  setText(el, full); capQ.push([el, full, short]);
}
// (cut: its text wider than its box, both unrounded: "15 min max 516 RPM" ran 1.1 px over, which the whole-pixel
// scrollWidth and clientWidth didn't show, and still got its "...")
const capRange = document.createRange();
function capCut(el) {
  if (!el.isConnected || !el.firstChild) return false;
  const cs = getComputedStyle(el), w = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);   // (its text's room: a Grid cell has padding, 2.2)
  if (!(w > 0)) return false;
  capRange.selectNodeContents(el); return capRange.getBoundingClientRect().width > w + 0.05;
}
function capMeasure() {
  if (!capQ.length) return;
  const q = capQ; capQ = [];
  const cut = q.map(([el]) => capCut(el));
  q.forEach(([el, full, short], i) => { el._fit = { full, short, cut: cut[i] }; if (cut[i]) setText(el, short); });
}
// a cut caption's shorter words: the ones written for where it is cut (subS), else a tile's narrow wording, when that
// one IS shorter. (A last session's fps says "avg, <game>" on a wide tile, "last session" in its corner, and "last avg,
// <game>" on a narrow one, which has no corner note: cut on the wide tile, a very long game name, it took the narrow
// wording and cut ten letters more of the name, 11-10)
const capShort = (e, full, tile) => e.subS && e.subS.of === full ? e.subS.s : tile && e.tsubS && full === e.tsub && e.tsubS.length < full.length ? e.tsubS : null;
// after a fit: a view drawn again (an undo, a drop, a view picked) had its captions measured before it was fitted, at the
// text size and in the boxes it had until then, so they showed their shorter words for up to a second and then the whole
// ones again (11-10, his recording). Measured again here, at the size and in the boxes the view is drawn with
// (only on a page that is laid out: measured right after growPass, with its growth still to lay out, the browser left
// every category of a Fill row at its height without the growth and its last row of tiles stuck out under it, for good;
// reading a caption's style inside a tile sized by its own box did it, the tile looks test 11-10)
function capRefit() {
  const q = [];
  for (const r of E.values()) { const el = r.cap, f = el && el._fit; if (f && el.isConnected) q.push([el, f.full, f.short]); }
  if (!q.length) return;
  for (const [el, full] of q) setText(el, full);
  const cut = q.map(([el]) => capCut(el));
  q.forEach(([el, full, short], i) => { el._fit = { full, short, cut: cut[i] }; if (cut[i]) setText(el, short); });
}
function readSight() {
  const sr = sectionsEl.getBoundingClientRect(), m = new Map();
  for (const [cid, r] of E) { const b = r.root.getBoundingClientRect(); m.set(cid, b.bottom > sr.top - 60 && b.top < sr.bottom + 60 && b.height > 0); }
  return m;
}
function updateView(all, peek) {   // (peek: a redraw between seconds, a spark's, judges nothing)
  paintTint(); paintGc(); paintMc();   // (write only when a colour changed: readings that just came in, a new view; the popups' graphs, 11-09)
  // seen: gets its number this time (all of them after a rebuild); sight: its graph is drawn (only what is on screen)
  let pre = sightPre; sightPre = null;
  if (pre) for (const cid of E.keys()) if (!pre.has(cid)) { pre = null; break; }   // (the view drawn again since: read now)
  const vis = pre || readSight(), seen = new Map(), sight = new Map();
  for (const cid of E.keys()) { const on = !!vis.get(cid); sight.set(cid, on); seen.set(cid, all || on); }
  const cardLvl = {};
  let fresh = null;
  let catAt = null;
  for (const [cid, r] of E) {
    const c = S.L.cells[cid]; if (!c) continue;
    if (feed.lgWait && isGameCell(c)) { if (performance.now() - feed.lgWait < 1500) continue; feed.lgWait = 0; }   // (as they were, until the summary of the game that just ended is in)
    const rd = c.key ? BYKEY.get(c.key) : null, vis = seen.get(cid);
    if (isMissing(c)) { if (!peek) calmGone(cid); odo(r.v, '--'); capSet(r.cap, missingTxt(c), missingShort(c)); continue; }
    const e = evalCell(cid, c, !!peek, !vis);
    if (!catAt) { catAt = new Map(); for (const ct of S.L.cats) for (const x of ct.cells) catAt.set(x, ct); }   // (once a pass: catOf scanned every category for every cell, 11-06)
    const cat = catAt.get(cid); if (cat) cardLvl[cat.id] = Math.max(cardLvl[cat.id] || 0, e.lvl);
    const dec = decOfCell(c, rd);
    // (a Game cell between a live game and its last session: a different number, not a change of it: shown at once, the
    // cell fading in once; 2.1, the motion audit 11-04)
    const gm = e.col === 'past' ? 'past' : 'live', flip = r._gm !== undefined && r._gm !== gm && isGameCell(c); r._gm = gm;
    if (vis) odo(r.v, e.txt != null ? e.txt : fmtV(e.v, dec, rd), flip || catchUp || (r._lvl !== undefined && e.lvl !== r._lvl), flip || catchUp);   // (a new level: its digits with its colour, 11-06)
    if (flip && vis && motionMode() !== 'off' && !catchUp && !stillUnder(r.root)) for (const el of [r.vbox, r.cap, r.tq, r.canvas, r.strip]) if (el) el.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: motionOn() ? 320 : 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    if (e.txt != null) setText(r.u, e.utxt);
    const colCls = e.col === 'white' ? '' : e.col;
    // (a number drawn for the first time, a new view or one drawn again (Height, a resize), takes its colour at once, not
    // through the 300 ms of a change: his 11-06 "flashes the numbers on the game cells", the last session's grey faded in from white)
    // (and its caption and tile, warning or warm: drawn again, they faded in from the calm look, 11-06)
    if ((r._lvl === undefined && (e.lvl || e.warm || e.warmR)) || catchUp) for (const el of [r.cap, r.kind === 'tile' ? r.root : null]) if (el) { el.style.transition = 'none'; (fresh || (fresh = [])).push(el); }
    if (r.vbox) { if (r._col === undefined && colCls) { r.vbox.style.transition = 'none'; (fresh || (fresh = [])).push(r.vbox); } r._col = colCls; for (const k of ['yellow', 'red', 'grey', 'past']) r.vbox.classList.toggle(k, colCls === k); }
    // (a tile's caption can be shorter, what it leaves out in the name's corner: tsub and tag; a narrow tile's shorter
    // still: tsubS and tagS, 2.1)
    const nq = r.kind === 'tile' && r.root.classList.contains('nq');
    if (r.cap) {
      const full = r.kind === 'tile' && e.tsub != null ? (nq && e.tsubS ? e.tsubS : e.tsub) : e.sub;
      capSet(r.cap, full, capShort(e, full, r.kind === 'tile'));   // (cut: its shorter words; 2.1.2 tiles, 2.2 everywhere)
      r.cap.classList.toggle('y', e.lvl === 1); r.cap.classList.toggle('r', e.lvl === 2);
    }
    if (r.tq) setText(r.tq, e.tsub != null && e.tag && !nq ? e.tag : '');   // (a narrow tile: none, its name keeps the room; his ask 11-04)
    if (r.kind === 'tile') {
      r.root.classList.toggle('yellow', e.lvl === 1); r.root.classList.toggle('red', e.lvl === 2); r.root.classList.toggle('warm', e.warm > 0 || e.warmR > 0);
      // (prettify 11-02: a tile that just went yellow, or yellow to red, also pulses a ring out, with the glow below; not
      // as the view is drawn, and only with Full animations. r._lvl moves on below, after the glow)
      if (r._lvl !== undefined && e.lvl > r._lvl && motionMode() === 'full' && !catchUp && !stillUnder(r.root)) { r.root.classList.remove('flare'); const fr = r.root; requestAnimationFrame(() => fr.classList.add('flare')); clearTimeout(r._fl); r._fl = setTimeout(() => r.root.classList.remove('flare'), 1000); }
      const wk = e.warm ? 'y' + e.warm : e.warmR ? 'r' + e.warmR : '';   // (the border fades toward yellow before it, toward red past it)
      if (r._w !== wk) { r._w = wk; r.root.style.setProperty('--wb', e.warm ? mixHex(S.look.line ? lineOf(S.look) : solidOf(S.look), '#5c4f1d', e.warm * 0.85) : e.warmR ? mixHex('#5c4f1d', '#6b2020', e.warmR * 0.85) : ''); }
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
        setText(r.td[4], c.pred || !rd || rd.av == null ? '' : isYN(rd) ? Math.round(rd.av * 100) + '% yes' : f(rd.av));
        for (const i of [2, 3, 4]) if (r.td[i].title !== r.td[i]._t) r.td[i].title = r.td[i]._t || '';
      }
      const cur = fmtV(e.v, dec, rd) + (unitOf(rd) && e.v != null ? ' ' + unitOf(rd) : c.pred && e.v != null ? ' RPM' : '');
      if (r.td[1].title !== cur) r.td[1].title = cur;
      if (r.cap && r.cap.title !== (e.sub || '')) r.cap.title = e.sub || '';
      const g = c.gates, gl = gateLines(g), two = gl.y2 !== undefined || gl.r2 !== undefined, gk = gbK(rd), ln = (y, r, bl) => (y !== undefined ? '<span class="y">' + lnTxt(y * gk, dec, rd, bl) + '</span>' : '') + (r !== undefined ? (y !== undefined ? '&nbsp; ' : '') + '<span class="r">' + lnTxt(r * gk, dec, rd, bl) + '</span>' : '');
      const lh = gatesOn(g) ? (two ? (g.dir === 'below' ? 'under ' : 'over ') : '') + ln(gl.y, gl.r, g.dir === 'below') + (two ? ', ' + (g.dir === 'below' ? 'over ' : 'under ') + ln(gl.y2, gl.r2, g.dir !== 'below') : '') : '';
      if (r.lines._h !== lh) { r.lines.innerHTML = lh; r.lines._h = lh; }
    }
    if (r.fan) spinIcon(r.fan, e.v);
    const xk = xkOf(rd); if (xk && xk.update) xk.update(r.root, rd, e, cid);
    if (r._lvl !== undefined && e.lvl > r._lvl && !catchUp) { glow(r, e.lvl); wPeekRise(); live.textContent = nameIn(cid) + (e.sub ? ', ' + e.sub : ''); }   // (said too, 11-06)
    r._lvl = e.lvl;
    if (r.canvas && sight.get(cid)) graphFeed(r.canvas, c, graphCol(e, r.kind === 'hero', cat && S.look.tint === 'spectrum' ? catTint(cat) : ''), e.past);
  }
  if (fresh) { for (const b of fresh) getComputedStyle(b).color; for (const b of fresh) b.style.transition = ''; }   // (their colour set with no transition, then the transition back)
  let cf = null;   // (cards drawn for the first time: their warning colour at once, 11-06)
  for (const k of CARDS) {
    const cat = S.L.cats.find(c => c.id === k.cat); if (!cat) continue;
    const ids = cellsOf(cat), lv = cardLvl[cat.id] || 0;
    const miss = ids.filter(id => isMissing(S.L.cells[id])).length;   // (every reading missing: no "all normal", 11-06)
    let n = 0; for (const id of ids) { const r = E.get(id); if (r && r._lvl && !isMissing(S.L.cells[id])) n++; }
    const fans = ids.length && ids.every(id => isFanCell(S.L.cells[id]));
    const own = !n && EXT.tag ? EXT.tag(cat, ids, n) : null;
    const txt = own != null ? own : n ? plural(n, 'warning') : ids.length && miss === ids.length ? '' : fans ? ids.filter(id => (cellValue(S.L.cells[id]) || 0) > 100).length + ' spinning' : 'all normal';
    if (k._lv === undefined && lv) for (const el of [k.el, k.tag]) if (el) { el.style.transition = 'none'; (cf || (cf = [])).push(el); }
    k._lv = lv;
    if (k.tag) { setText(k.tag, txt); k.tag.className = 'tag' + (lv === 2 ? ' r' : lv === 1 ? ' y' : ''); }
    k.el.classList.toggle('warn-y', lv === 1); k.el.classList.toggle('warn-r', lv === 2);
  }
  if (cf) { for (const b of cf) getComputedStyle(b).color; for (const b of cf) b.style.transition = ''; }
  capMeasure();   // (captions whose text or size changed: cut ones take their shorter words, after every write above)
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
// (2.2: a share of its row, f, is f x k places; auto: a normal tile you haven't sized, which the category places)
const szOf = (t, k) => { const f = +t.dataset.f || 0; k = k || 1; return { w: f ? Math.min(k, f * k) : +t.dataset.w || 1, h: +t.dataset.h || 1, nl: t.dataset.nl === '1', f, fx: !!f && t.dataset.fx === '1', auto: !f && !t.dataset.w }; };
const tileKids = tg => [...tg.children].filter(x => x.classList.contains('tile'));
const tileArea = (tiles, k) => tiles.reduce((a, t) => { const s = szOf(t, k); return a + Math.min(s.w, k) * s.h; }, 0);
// the minimum (TILE_MIN): a tile that would be drawn narrower, and the tiles sharing its rows with it (beside it, or
// beside a taller one there), split those rows evenly over fewer a line: four of 25% where three fit go two and two,
// 58% two rows high beside two of 42% go half and half where only two fit, so no hole is left. W, g in px
function floorSz(sz, k, W, g, fs, short) {
  if (!(W > 0)) return sz;
  const min = (short ? 15 : TILE_MIN) * fs, p = (W + g) / k, kmax = Math.max(1, Math.floor((W + g) / (min + g) + 1e-6));   // (short tiles: their name and value side by side, 15rem as in Auto)
  const low = sz.map(s => !s.auto && Math.min(s.w, k) * p - g < min - 0.5);
  if (!low.some(Boolean)) return sz;
  const up = PCTS.map(q => q / 100 * k).find(u => u * p - g >= min - 0.5) || k;   // (the smallest share drawn whole, 11-08 audit)
  const { pos } = packTiles(sz, k), out = sz.map(s => Object.assign({}, s)), done = new Set();
  sz.forEach((s, i) => {
    if (!low[i] || done.has(i)) return;
    const grp = new Set([i]); let y0 = pos[i].y, y1 = pos[i].y + pos[i].h, grew = true;
    while (grew) { grew = false; pos.forEach((q, j) => { if (!grp.has(j) && q.y < y1 - PE && q.y + q.h > y0 + PE) { grp.add(j); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y + q.h); grew = true; } }); }   // (normal tiles there too: the order stays)
    // (sizes that differ: only the ones too narrow go up, to the smallest share drawn whole, and a share beside them is
    // drawn as set; it was held at the even split, 67% or 75% drawn 50%, 11-08 audit)
    // (only while they still fit in the rows they had: past that they wrapped and left a hole beside a taller share, so
    // the group splits evenly as before, the suite 11-08: 58% beside two of 42%)
    if (![...grp].every(j => Math.abs(sz[j].w - s.w) < 1e-6 && Math.abs(sz[j].h - s.h) < 1e-6)) {
      const t = out.map(o => Object.assign({}, o)); for (const j of grp) if (low[j]) t[j].w = Math.max(sz[j].w, up);
      if (packTiles(t, k).H <= packTiles(sz, k).H + PE) { for (const j of grp) { out[j].w = t[j].w; done.add(j); } return; }
    }
    const cols = new Set([...grp].map(j => Math.round(pos[j].x * 1000))).size, per = Math.min(kmax, Math.ceil(cols / Math.ceil(cols / kmax)));
    for (const j of grp) { out[j].w = k / per; done.add(j); }
  });
  return out;
}
// a category's tiles, k places to a row: each goes to the highest, then leftmost, spot where it fits, so a hole left
// (a tile that starts a new row (nl) goes under all the tiles before it, and the ones after it stay there too)
// beside a bigger tile takes a later one that fits it (all normal tiles: a plain grid in reading order). Sizes and
// spots in tiles, a tile's gap included; a tile wider than the row is as wide as the row. Gives the spots and the height
const PE = 1e-6, inRect = (a, b) => a.x >= b.x - PE && a.y >= b.y - PE && a.x + a.w <= b.x + b.w + PE && a.y + a.h <= b.y + b.h + PE;
function packTiles(sz, k) {
  let free = [{ x: 0, y: 0, w: k, h: Infinity }], H = 0;
  const pos = [], mw = Math.min(0.25, ...sz.map(s => Math.min(s.w, k))), tq = SNAPQ * Math.max(1, k / 2);   // (a share can be under a quarter place; shares kept to 4 decimals add up a hair over the row: six of 16.67%, 2.2)
  for (const s of sz) {
    const w = Math.min(s.w, k), h = s.h;
    if (s.nl && H > PE) free = free.map(f => f.y >= H - PE ? f : f.y + f.h > H + PE ? { x: f.x, y: H, w: f.w, h: f.y + f.h - H } : null).filter(Boolean);
    let b = null;
    for (const f of free) if (w <= f.w + tq && h <= f.h + SNAPQ && (!b || f.y < b.y - PE || (f.y <= b.y + PE && f.x < b.x))) b = f;
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
    const big = nf.filter(f => f.w >= mw - PE && f.h >= 0.25 - PE);   // (no tile is narrower than the narrowest here, or under 0.25 high)
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
  const need = tgs.filter(t => { if (t.closest('.dcat.collapsed')) return false; const u = unitH.get(t); return !u || u.narrow !== t.classList.contains('narrow') || (exactUnits && Math.abs(u.fs - fs) > (S.edit ? 1e-4 : 0.01)); });
  if (!need.length) return;
  for (const t of need) { t.classList.remove('pk'); t.classList.add('meas'); }
  const hs = need.map(t => tileKids(t).map(x => x.offsetHeight));
  if (window.__natDbg) need.forEach(t => tileKids(t).forEach(x => { if (x.dataset.cid) window.__natDbg[x.dataset.cid] = [fs, x.offsetHeight, x.offsetWidth, [...x.children].map(c => (String(c.className).split(' ')[0] || c.tagName) + ':' + c.offsetHeight).join(' '), app.className.split(' ').filter(k => !/^(boot)$/.test(k)).join('.'), t.className]; }));   // (the stress test's debug: what a tile's own height was read from)
  need.forEach((t, i) => {
    if (!hs[i].some(Boolean)) return;
    const short = t.classList.contains('shorts');
    // a tile at the 8.6rem floor (most) is 8.6 whatever the rounding of its px: its placing stays as it was
    tileKids(t).forEach((x, j) => { if (hs[i][j]) x._nat = short ? hs[i][j] / fs : hs[i][j] <= 8.6 * fs + 1 ? 8.6 : hs[i][j] / fs; });
    unitH.set(t, { narrow: t.classList.contains('narrow'), fs });
  });
}
// a row of normal tiles (1 x 1, none sized by you) that leaves room at its end shares it out, once another row of the
// category fills the width (his call 11-04: four tiles over three look as a category of four over one of three per row
// did). Drawn wider (dx, dw); placed as they are (x, w: what a drag, a size and the heights go by)
function fillRows(sz, pos, k) {
  const tq = SNAPQ * Math.max(1, k / 2), um = Math.min(1, ...sz.map(s => Math.min(s.w, k)));
  if (!pos.some(p => p.x + p.w > k - um + tq)) return;   // (a row with no room left for one more tile counts as full: 33% and two Autos of four, the fourth fills its row, 11-08)
  const grid = sz.length > 0 && sz.every(s => s.auto === false && Math.abs(s.w - sz[0].w) < 1e-6);   // (every tile one share)
  // (each row by its own tiles: they all start on it and no other tile reaches into it, whatever their heights, so a
  // height alone never changes the widths; it took one height for all, 11-08 audit)
  const ys = [...new Set(pos.map(p => Math.round(p.y * 1e6) / 1e6))];
  for (const y0 of ys) {
    const ids = []; let ok = true;
    pos.forEach((p, i) => { if (Math.abs(p.y - y0) < PE) { if (sz[i].fx || !(grid || (sz[i].auto !== false && sz[i].w === 1))) ok = false; ids.push(i); } });   // (a tile sized by hand: its row as set)
    if (!ok || !ids.length) continue;
    const y1 = Math.max(...ids.map(i => pos[i].y + pos[i].h));
    if (pos.some((p, i) => !ids.includes(i) && p.y < y1 - PE && p.y + p.h > y0 + PE)) continue;   // (a tile of another row reaches into it)
    ids.sort((a, b) => pos[a].x - pos[b].x);
    // (all one width u: normal tiles, or a category whose tiles are all one share, as its tiles per row became in 2.2, so
    // 4 x 25% over 3 x 25% draws the 3 as it did; from the left with no hole, room at the end)
    const u = sz[ids[0]].w;
    if (!ids.every((i, j) => Math.abs(sz[i].w - u) < 1e-6 && Math.abs(pos[i].x - j * u) < PE) || ids.length * u >= k - tq) continue;
    const f = k / ids.length;
    ids.forEach((i, j) => { pos[i].dx = j * f; pos[i].dw = f; });
  }
}
const drawnX = p => p.dx != null ? p.dx : p.x, drawnW = p => p.dw != null ? p.dw : p.w;
// the packed tiles in rem: one tile high is a row, as tall as the tallest normal-height tile that starts in it (like a
// grid row; at least the shortest tile of the category); any other height takes its share of the rows it spans. G: the
// gap in rem; even (a Fill row): every row as tall as the tallest. Gives each tile's top and height (ty, th) and the
// height of them all (TH)
function placeTiles(sz, nat, k, G, even) {
  const { pos, H } = packTiles(sz, k), nb = Math.max(1, Math.ceil(H - PE)), bh = Array(nb).fill(Math.min(...nat));
  fillRows(sz, pos, k);
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
  const short = t.classList.contains('shorts'), G = 0.62 * spOf($('view')), nat = tiles.map(x => natOf(x, short)), even = !short && fillEven(t);
  const fs = parseFloat(document.documentElement.style.fontSize) || 13, sz = floorSz(tiles.map(x => szOf(x, k)), k, t._tw || t.clientWidth, G * fs, fs, short);
  const key = k + ':' + G + ':' + even + ':' + sz.map((z, j) => Math.round(z.w * 1e4) / 1e4 + 'x' + z.h + (z.nl ? '/' : '') + (z.fx ? '!' : '') + '@' + nat[j].toFixed(3)).join(',');
  if (t._pk !== key) {
    const L = placeTiles(sz, nat, k, G, even);
    tiles.forEach((x, j) => {
      const s = x.style, p = L.pos[j];
      s.setProperty('--x', drawnX(p)); s.setProperty('--w', drawnW(p)); s.setProperty('--y', p.y); s.setProperty('--h', p.h);
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
const FITS = ['l0', 'l1', 'ns', 'ng', 'nc', 'ph', 'pw', 'nu', 'cq', 'nq'];   // (nq: narrow for the long corner note and caption, see tsubS)
function tileFit(t, W, k, g, fs, gr) {
  if (!t._L) return;
  t._tw = W;
  const short = t.classList.contains('shorts'), pw = (W + g) / k;
  tileKids(t).forEach((x, j) => {
    const p = t._L.pos[j]; if (!p) return;
    const w = (drawnW(p) * pw - g) / fs, h = p.th + (gr ? p.h * gr / fs : 0);   // (a row that fills: as wide as it is drawn)
    const c = (short ? (h < 1.9 || w < 4 ? 'l0 ng nc ph' : h < 2.9 ? 'ng nc ph' : '')
      : w < 4.5 ? (h >= 5.3 ? 'ns ng nc' : 'l0 ng nc ph') : h < 2.6 ? (w >= 9 ? 'l1 ng nc ph' : 'l0 ng nc ph') : h < 5.3 ? (w >= 7 ? 'l1 ng nc ph' : 'l0 ng nc ph') : h < 6.9 ? 'ng nc' : h < 7.9 ? 'ng' : '') + (w < 8 ? ' pw' : '') + (w < 4.5 ? ' nu' : '');
    // (cq: sized by its own box, for a tile that isn't 1 x 1, shows less, or grows in a Fill row; a plain tile needn't)
    const cq = (c || Math.abs(p.w - 1) > PE || Math.abs(p.h - 1) > PE || gr ? c + ' cq' : c) + (w < 18.5 ? ' nq' : '');   // (18.5rem: measured 11-04, "Game time" and "6h 33m in 24 h" are cut at 16)
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
// the members of a line side by side, each at least the room for its tiles in as few rows as the line holds (R rows: n
// tiles get ceil(n / R) a row; the shares share out the rest): two equal members always get the same tiles a row (his
// laptop 11-08: Iris Xe two a row beside Memory one a row, 2 px narrower), a small member never takes a big one's room.
// it: { n tiles, u one tile in px } or { fix px } (collapsed, tiles per row set, a card, an empty one); av: the line less
// its gaps; gives each member's px
function lineMins(it, av, g) {
  const room = (m, k) => m.fix != null ? m.fix : Math.min(k, m.n) * m.u + (Math.min(k, m.n) - 1) * g, N = Math.max(1, ...it.map(m => m.fix != null ? 1 : m.n));
  for (let R = 1; R < N; R++) { const r = it.map(m => room(m, m.fix != null ? 1 : Math.ceil(m.n / R))); if (r.reduce((a, b) => a + b, 0) + 0.2 * it.length <= av) return r; }
  return it.map(m => room(m, 1));
}
function balanceRow(row, cols, W, cg, fs, g, nat) {
  const C = cols.length, rg = parseFloat(getComputedStyle(cols[0]).rowGap) || 0;
  // (an empty category, shown only in edit mode, takes no part: edit mode shows the view as it is, 2.2)
  const one = b => {
    const tg = b.querySelector('.tg'), dg = b.querySelector('.dgrid');
    const tiles = tg ? tileKids(tg) : [];
    const short = !!tg && tg.classList.contains('shorts');
    return { tg, tiles, nat: tiles.map(x => natOf(x, short)), packs: new Map(), collapsed: b.classList.contains('collapsed'), short: !!tg && tg.classList.contains('shorts'),
      per: tg && tg.classList.contains('per') ? +tg.style.getPropertyValue('--per') || 0 : 0, band: b.classList.contains('band'), hero: !!b.querySelector('.hero'),
      rows: b.querySelectorAll('.dgrid > .row').length, n: dg ? dg.children.length : 0 };
  };
  // (a line side by side: one entry, its members at their shares of the column, 11-07 audit: it was left out, its column balanced as empty)
  const real = e => e.classList.contains('dcat') && !e.classList.contains('isempty');
  const desc = cols.map(c => [...c.children].map(e => {
    if (real(e)) return one(e);
    if (!e.classList.contains('lsub')) return null;
    const ms = [...e.children].filter(real);
    if (!ms.length) return null;
    const line = ms.map(one), tl = S.screen === 'tiles';
    return { line, fr: ms.map(x => lineShare(catById(x.dataset.cat))), it: ms.map((x, j) => !tl || line[j].collapsed || line[j].per || !line[j].tiles.length ? { fix: catMin(catById(x.dataset.cat), true, ms.length > 1, gapSp()) * fs } : { n: line[j].tiles.length, u: (line[j].short ? 15 : TILE_MIN) * fs }) };   // (its members' narrowest as layoutPass draws them: their tiles in as few rows as it holds, 11-08)
  }).filter(Boolean));
  const lineW = (d, w) => {
    const av = w - (d.line.length - 1) * cg, mn = lineMins(d.it, av, g), out = d.fr.map(() => 0), fix = d.fr.map(() => false);
    for (let it = 0; it < 5; it++) {
      const fr = d.fr.reduce((a, f, j) => fix[j] ? a : a + f, 0), left = av - out.reduce((a, x, j) => fix[j] ? a + x : a, 0);
      d.fr.forEach((f, j) => { if (!fix[j]) out[j] = fr ? left * f / fr : 0; });
      let again = false; d.fr.forEach((f, j) => { if (!fix[j] && out[j] < mn[j]) { out[j] = mn[j]; fix[j] = again = true; } });
      if (!again) break;
    }
    return out;
  };
  const stackH = (i, f) => desc[i].reduce((a, d) => a + f(d), 0) + (desc[i].length - 1) * rg;
  if (S.screen === 'tiles') {
    // (the tracks counted at the full text size, so a fit only scales the split: an edit anywhere that fits the text a
    // little smaller moved an untouched row's line by up to 176 px, 11-08 audit 0201. Wm: the row at that size, in px of now)
    const m0 = TILE_MIN * fs, q = Math.max(1, cssScale() / fs), Kq = Math.floor((W / q - (C - 1) * cg + C * g) / (m0 + g) + 1e-6);
    const Wm = Kq >= C ? W / q : W, K0 = Kq >= C ? Kq : Math.floor((W - (C - 1) * cg + C * g) / (m0 + g) + 1e-6);
    if (K0 < C) return false;
    // tracks of at least m wide: each column starts at what its categories need (short tiles want two tracks), then
    // the tallest that gets shorter within the next 3 tracks takes them; gives the tracks and the tallest column
    const lined = desc.some(ds => ds.some(d => d.line));   // (a row with a line side by side: judged at real track widths, 11-08 audit)
    const alloc = (K, m) => {
      const tU = U => Math.max(m, (Wm - (C - 1) * cg - (U - C) * g) / U);   // (the track width when U tracks are used: a line's members are judged at it, 11-07 audit)
      const catH = (d, n, w0, U) => {
        if (d.line) return Math.max(...lineW(d, n * tU(U || K) + (n - 1) * g).map((wj, j) => catH(d.line[j], Math.max(1, Math.floor((wj + g) / (m0 + g) + 1e-6)), wj)));
        if (d.collapsed) return nat.H;
        if (!d.tiles.length) return nat.H + 5 * fs;   // an empty category (edit mode)
        const w = w0 != null ? w0 : n * (U && lined ? tU(U) : m) + (n - 1) * g, kk = d.per ? Math.max(1, Math.min(d.per, Math.floor((w + g) / (8.5 * fs + g)))) : d.short ? Math.max(1, Math.floor((w + g) / (15 * fs + g))) : n;
        const pk = kk + '@' + Math.round(w);
        if (!d.packs.has(pk)) d.packs.set(pk, placeTiles(floorSz(d.tiles.map(t => szOf(t, kk)), kk, w, g, fs, d.short), d.nat, kk, g / fs, !d.short && fillEven(row)).TH);
        return nat.H + d.packs.get(pk) * fs;
      };
      const colH = (i, n, U) => stackH(i, d => catH(d, n, undefined, U));   // (U: the tracks used; none, all K: a line judged at its narrowest)
      const k = cols.map(c => Math.max(1, Math.ceil(((+c.dataset.min || 0) * fs + g) / (m + g) - 1e-6)));
      // (a share set on a tile keeps the tracks it needs to be drawn as set, a third three, a quarter four, smallest
      // first while the row has them: a 33% picked dropped its column to two tracks, too narrow to draw it, 11-08 audit)
      const sn = desc.map((ds, i) => Math.max(k[i], ...ds.filter(d => !d.line && d.tg && !d.per && !d.short).flatMap(d => d.tiles.map(t => +t.dataset.f > 0 ? Math.ceil(1 / +t.dataset.f - 0.02) : 1))));
      let ks = k.reduce((a, b) => a + b, 0);
      for (const [dn, i] of sn.map((n, i) => [n - k[i], i]).filter(x => x[0] > 0).sort((a, b) => a[0] - b[0])) if (ks + dn <= K) { k[i] += dn; ks += dn; }
      const need = k.slice();
      let rem = K - k.reduce((a, b) => a + b, 0);
      if (rem < 0) return null;
      // (a row with a line side by side, three columns at most: every split of the tracks is tried, its lines judged at
      // the track width that split really ends with; the lowest tallest column wins, then fewer tracks (wider tiles, no
      // empty slots). 11-08 audit, rounds 6 to 9: the greedy split below, judging a line at one guessed width, wasted
      // tracks or squeezed a column around it, whichever width it guessed)
      if (C <= 3 && desc.some(ds => ds.some(d => d.line))) {
        const memo = new Map(), H = (i, n, U) => { const key = i + ',' + n + ',' + U; let v = memo.get(key); if (v === undefined) { v = colH(i, n, U); memo.set(key, v); } return v; };
        const rest = i => need.slice(i).reduce((a, b) => a + b, 0), cur = [];
        let best = null;
        const walk = (i, s) => {
          if (i === C) { let tp = 0; for (let j = 0; j < C; j++) tp = Math.max(tp, H(j, cur[j], s)); if (!best || tp < best.top - 0.5 || (tp <= best.top + 0.5 && s < best.U)) best = { k: cur.slice(), top: tp, U: s }; return; }
          for (let n = need[i]; s + n + rest(i + 1) <= K; n++) { cur[i] = n; walk(i + 1, s + n); }
        };
        walk(0, 0);
        return best && { k: best.k, top: best.top };
      }
      while (rem > 0) {
        let best = -1, bh = -1, bj = 0;
        for (let i = 0; i < C; i++) { const a = colH(i, k[i]); for (let j = 1; j <= Math.min(3, rem); j++) if (colH(i, k[i] + j) < a - 0.5) { if (a > bh) { bh = a; best = i; bj = j; } break; } }
        if (best < 0) break;
        k[best] += bj; rem -= bj;
      }
      // (a line judged at all K tracks can take one it doesn't need, his Core column a 5th, 11-07 audit: one less, the
      // others wider, kept when no column ends lower)
      const used = () => k.reduce((a, b) => a + b, 0), top = U => Math.max(...k.map((n, i) => colH(i, n, U)));
      for (let i = 0; i < C; i++) if (k[i] > need[i] && desc[i].some(d => d.line)) { const t0 = top(used()); k[i]--; if (top(used()) > t0 + 0.5) k[i]++; }
      return { k, top: top(used()) };
    };
    // the tracks rarely split evenly (8 for three equal columns = 3 3 2): one more, a little narrower (never under
    // 9.5rem), is taken when it leaves the tallest column shorter
    let a = alloc(K0, m0);
    if (!a) return false;
    const m1 = (Wm - (C - 1) * cg - (K0 + 1 - C) * g) / (K0 + 1);
    if (m1 >= TILE_MIN * fs) { const b = alloc(K0 + 1, m1); if (b && b.top < a.top - 0.5) a = b; }   // (2.2: never tracks under the minimum)
    const k = a.k;
    const used = k.reduce((a, b) => a + b, 0), t = (W - (C - 1) * cg - (used - C) * g) / used;
    row.style.setProperty('--cols', k.map(n => 'minmax(0, ' + (n * t + (n - 1) * g).toFixed(1) + 'fr)').join(' '));
    desc.forEach((ds, i) => { for (const d of ds) if (!d.line && d.tg && !d.per && !d.short) { d.tg.dataset.ktrack = '1'; d.tg.classList.add('kset'); d.tg.style.setProperty('--k', k[i]); } });
    row.dataset.ks = k.join(',');
    return true;
  }
  const unit = (W - (C - 1) * cg) / 12;
  if (unit <= 0) return false;
  const mins = cols.map(c => Math.max(1, Math.ceil(((+c.dataset.min || 0) * fs - 1) / unit)));
  if (mins.reduce((a, b) => a + b, 0) > 12) return false;
  const cardH = (d, w) => {
    if (d.line) return Math.max(...lineW(d, w).map((wj, j) => cardH(d.line[j], wj)));
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
  const tiles = tileKids(tg), min = (tg.classList.contains('shorts') ? 15 : TILE_MIN) * fs;
  // (a tile with a share counts as one place: its width is a share of the row whatever k is, so sizing one tile never
  // changes how many Auto tiles go to a row; it counted f x kmax, 50% on one of four Autos made the three 33%, 11-08 audit)
  const kmax = Math.max(1, Math.floor((W + g) / (min + g) + 1e-6)), sz = tiles.map(t => szOf(t, kmax)), one = s => s.f ? 1 : Math.min(s.w, kmax);
  const a = sz.reduce((x, s) => x + (s.f ? 1 : one(s) * s.h), 0), rows = Math.max(1, Math.ceil(a / kmax - PE));   // (a share: one place, one row high, its height doesn't change k either)
  let k = Math.min(kmax, Math.max(1, Math.ceil(a / rows - PE)));
  const mw = sz.reduce((m, s) => s.f ? m : Math.max(m, s.w), 1);   // a wide tile gets its width where there is room
  if (kmax > 1 && mw > 1) k = Math.max(k, Math.min(kmax, Math.ceil(mw - PE)));
  if (sz.some((s, i) => i && s.nl)) { let run = 0, most = 0; sz.forEach((s, i) => { if (i && s.nl) run = 0; run += one(s); most = Math.max(most, run); }); k = Math.max(1, Math.min(k, Math.ceil(most - PE))); }   // (New row: no more a row than its longest run, so its rows are shared out, not half empty, 11-08 audit)
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
// a name (a tile's, a row's, a category's) cut in its place gets a little smaller text, down to 85%, so it fits whole
// (his ask 11-04: "a limit to tittle, maybe smaller text, dont keep ... not 2lines"); all put back, then all read, then
// all set, after every layout
const NAMESEL = '#view .tn > span[data-full], #view .row .nm > span, #view td.gname > span, #view .dch .cn, #view .ch .cn';
const NAME_MAX = 24;   // (a name you type: his longest, "GPU fans: centre + rear", is 23)
let nameFitQ = 0;
const nameFitSoon = () => { if (!nameFitQ) nameFitQ = requestAnimationFrame(() => { nameFitQ = 0; nameFit(); }); };   // (once a frame: a fit tries several layouts)
function nameFit() {
  const els = [...document.querySelectorAll(NAMESEL)];
  for (const e of els) if (e.style.fontSize) e.style.fontSize = '';
  const rg = document.createRange(), ks = els.map(e => {
    if (!e.firstChild || !e.isConnected) return 1;
    const w = e.getBoundingClientRect().width; if (!(w > 0)) return 1;
    rg.selectNodeContents(e); const need = rg.getBoundingClientRect().width;
    return need > w + 0.05 ? Math.max(0.85, Math.floor(w / need * 100) / 100) : 1;
  });
  const f0 = els.map((e, i) => ks[i] < 1 ? parseFloat(getComputedStyle(e).fontSize) : 0);
  els.forEach((e, i) => { if (ks[i] < 1) e.style.fontSize = (f0[i] * ks[i]).toFixed(2) + 'px'; });
  titleFit();
}
// the PC's name in the title bar: a little smaller too, or not shown where even that doesn't fit (the smallest window,
// edit mode's buttons); again whenever it changes
function titleFit() {
  const tt = document.getElementById('title'), rg = document.createRange();
  if (tt) {
    tt.style.fontSize = ''; tt.style.visibility = '';
    const w = tt.getBoundingClientRect().width; rg.selectNodeContents(tt); const need = rg.getBoundingClientRect().width;
    if (tt.firstChild && need > w + 0.05) { const k = w / need; if (k >= 0.85) tt.style.fontSize = (parseFloat(getComputedStyle(tt).fontSize) * Math.floor(k * 100) / 100).toFixed(2) + 'px'; else tt.style.visibility = 'hidden'; }
  }
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
    const ws = row.dataset.w ? row.dataset.w.split(',').map(Number) : null, T = ws ? ws.reduce((a, b) => a + b, 0) : 0, av = W - cg * (cols.length - 1);
    const fold = row.dataset.auto ? !balanceRow(row, cols, W, cg, fs, g, nat) : av + 1 < cols.reduce((a, c) => a + (+c.dataset.min || 0) * fs, 0) || (!!ws && ws.length === cols.length && cols.some((c, i) => ws[i] / T * av + 1 < (+c.dataset.min || 0) * fs));   // (a row of yours: one under the other when any column would be drawn under its narrowest, 11-08 audit 0202; it drew one 95 px wide)
    row.classList.toggle('fold', fold);
    if (fold) for (const t of row.querySelectorAll('.tg[data-ktrack]')) delete t.dataset.ktrack;
  }
  // (a line side by side too narrow for its members: one under the other, 11-07 audit; it squeezed them under a tile's width)
  const fitting = app.classList.contains('fitting');   // (while edit mode fits, an empty member isn't drawn: it adds nothing; otherwise it needs a tile's room, 11-07 audit)
  for (const s of view.querySelectorAll('.lsub')) s.classList.toggle('fold', s.clientWidth + 1 < ((+s.dataset.min || 0) + (fitting ? 0 : +s.dataset.mine || 0)) * fs);
  // (each member of a line the room for its tiles in as few rows as the line holds: two equal members always get the same
  // tiles a row, his laptop 11-08: Iris Xe two a row beside Memory one a row at 2 px less)
  for (const s of view.querySelectorAll('.lsub:not(.fold)')) {
    const kids = [...s.children], on = kids.filter(e => e.classList.contains('dcat') && e.getClientRects().length), cgL = parseFloat(getComputedStyle(s).columnGap) || 0, full = on.filter(e => !e.classList.contains('isempty')).length;
    const it = on.map(e => { const cat = catById(e.dataset.cat), tg = e.querySelector('.tg'); if (e.classList.contains('isempty')) return { fix: TILE_MIN * fs }; if (!cat || !tg || S.screen !== 'tiles' || e.classList.contains('collapsed') || tg.classList.contains('per')) return { fix: (cat ? catMin(cat, true, full > 1, gapSp()) : 0) * fs }; return { n: Math.max(1, tileKids(tg).length), u: (tg.classList.contains('shorts') ? 15 : TILE_MIN) * fs }; });
    const r = lineMins(it, s.clientWidth - (on.length - 1) * cgL, g);
    on.forEach((e, i) => s.style.setProperty('--m' + (kids.indexOf(e) + 1), (Math.ceil(r[i] * 10 + 1) / 10) + 'px'));
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
    t._tw = tw[i];   // (the minimum goes by its width)
    packTg(t, k);
    tileFit(t, tw[i], k, g, fs);
  });
  if (flipped.length) {
    measureUnits(flipped.map(f => f[0]), fs);
    // (their own heights changed with it, and so may one tile high: the pass again from there, once. It was kept as read
    // before the turn, so the same layout drew a little differently after an undo than before it, 11-08 stress test)
    const u0 = tileUnit; setTileUnit(tgs);
    if (Math.abs(tileUnit - u0) > 1e-3 && !layoutPass.again) { layoutPass.again = true; try { layoutPass(); } finally { layoutPass.again = false; } return; }
    for (const [t, k, w] of flipped) { t._tw = w; packTg(t, k); tileFit(t, w, k, g, fs); }
  }
  vs.forEach((d, i) => {
    const n = d.querySelectorAll(':scope > .row').length, sc = subCols(vw[i], n, fs);
    d.classList.toggle('sub', sc > 1);
    if (sc > 1) { d.classList.toggle('nohero', !d.querySelector(':scope > .hero')); d.style.setProperty('--sc', sc); d.style.setProperty('--sr', Math.ceil(n / sc)); }
  });
  bands.forEach((b, i) => { const n = b.querySelectorAll('.bcell').length; b.classList.toggle('bfold', bw[i] + 1 < (8.5 + Math.max(1, n) * 10.5) * fs); });   // a band cell needs about 10.5rem
  placeDividers(view);
  nameFitSoon();
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
    const kids = [...c.children].filter(x => x.classList.contains('dcat') || x.classList.contains('lsub')), gap = parseFloat(getComputedStyle(c).rowGap) || 0;
    let n = 0;
    for (const k of kids) { let nk = 0; const sum = k.classList.contains('fold'); for (const b of k.classList.contains('lsub') ? [...k.children] : [k]) { if (b.classList.contains('collapsed')) continue; const tg = b.querySelector('.tg.pk:not(.shorts)'); if (tg) { nk = sum ? nk + (tg._H || 0) : Math.max(nk, tg._H || 0); T = Math.max(T, Math.min(...tileKids(tg).map(x => natOf(x))) * fs); } } n += nk; }   // (side by side: they grow together, by the tallest one's rows)
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
// (what else changes a category's tile heights: Short tiles, a reading missing or back; 11-06, a memo of normal tiles
// was taken for Short ones)
const packSig = cat => (catLook(cat.id).size || '') + '|' + idsIn(cat).map(id => isMissing(S.L.cells[id]) ? 1 : 0).join('');
function rememberPacks() {
  for (const t of document.querySelectorAll('#view .tg.pk')) {
    const cat = t.parentElement.dataset.cat, kids = tileKids(t); if (!t._L || !cat) continue;
    const co = catById(cat); if (!co) continue;
    const st = t.style, v = k => st.getPropertyValue(k);
    const u = unitH.get(t); if (!u) continue;
    packMemo.set(cat, { cids: kids.map(x => x.dataset.cid).join('|'), edit: S.edit, sig: packSig(co), key: t._pk, H: t._H, L: t._L, tw: t._tw, fs: u.fs,
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
  const room = cols.map(c => { const ks = [...c.children].filter(e => e.classList.contains('dcat') || e.classList.contains('lsub')); return ks.length ? c.getBoundingClientRect().bottom - ks[ks.length - 1].getBoundingClientRect().bottom : 0; });
  cols.forEach((c, i) => c.classList.toggle('slot', room[i] >= 3 * fs));
}
// the size that fit, per view as it looks now (window, categories, its arrangement and looks; edit mode fits as outside it, so both share it): switching
// back to a view tries that one size instead of searching again
// kept in this window's own storage too (a convenience: lost storage just means one search), so the first switch after
// a restart is quick as well
const lastFit = {}, fitMemo = (() => { try { return JSON.parse(localStorage.getItem('hwdeck.fit') || '{}') || {}; } catch (e) { return {}; } })();
const hashKey = t => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return 'f' + (h >>> 0).toString(36); };   // (a letter first: keys that look like numbers would lose their order)
let fitSaveT = 0;
const noFit = new Set();   // (fit keys at which nothing fit, even the smallest size: see autofit)
function rememberFit(key, f) {
  delete fitMemo[key]; fitMemo[key] = f;
  const ks = Object.keys(fitMemo); for (let i = 0; i < ks.length - 60; i++) delete fitMemo[ks[i]];
  clearTimeout(fitSaveT); fitSaveT = setTimeout(() => { try { localStorage.setItem('hwdeck.fit', JSON.stringify(fitMemo)); } catch (e) { /* no storage: fine */ } }, 2000);
}
// Fill's rows, all as tall as the tallest (11-06, his "it does nothing but changed and distorted the current view": they
// made the view taller than it fit, so the text was fitted a step smaller and Fill drew everything smaller than All fit).
// The text is now fitted without them, so Fill and All fit get the same size; they are kept only if they still fit
let fitNoEven = false;
const fillEven = el => !fitNoEven && !!el && !!el.closest('.lrow[data-fill]');
const fitView = v => { if (!v) return v; const o = Object.assign({}, v); delete o.fill; if (Array.isArray(v.rows)) o.rows = v.rows.map(r => { const x = Object.assign({}, r); delete x.h; return x; }); return o; };   // (Fill or not: one size)
// (the cells too: a name, a graph turned on or off, a missing reading change what fits)
// (and their order in a category: tiles pack into rows by it. The key had only how many, so every order of the same cells
// shared one remembered size: a move that needed three rows left the two-row orders at its smaller size, a blank band
// under the view after an undo or a drop, kept across restarts, 11-10 his recording. Grid keeps the count: its rows sit
// one under the other in any order, and Automatic Grid decides its tables per key)
const fitKey = target => hashKey(JSON.stringify([S.screen, target, !!EXT.ready, sectionsEl.clientWidth, sectionsEl.clientHeight, S.L.cats.map(c => [c.id, S.screen === 'grid' ? cellsOf(c).length : cellsOf(c), c.collapsed]),
  fitView(viewOf(S.screen)), S.L.cells, Object.keys(S.L.cells).filter(id => isMissing(S.L.cells[id]))]));
function autofit() {
  if (document.hidden) drawnHidden = true;   // (measured in the tray: again when the window shows)
  const root = document.documentElement, v = $('view');
  if (!S.L.cats.length || v.classList.contains('empty') || v.classList.contains('setup')) { root.style.fontSize = '13px'; fitRatio = 1; layoutPass(); return; }
  fitNoEven = true;   // (fitted as All fit: see fillEven)
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
  // (the remembered size is still tried: live values can change what fits. With the tiles' heights read at that size:
  // read at the size the view had before (the step an undo goes back from, say) they could turn down the very size it
  // fit at, and undo or redo then fitted another size than the one it went back to, 11-08 stress test)
  // (an undo or redo: the size this step had, when the window and the view are as they were then)
  const pin = fitPin; fitPin = null;
  const pinned = !!pin && pin.fs > 0 && pin.screen === S.screen && Math.abs(pin.target - target) < 0.001 && pin.w === sectionsEl.clientWidth && pin.h === sectionsEl.clientHeight;
  let memoOk = false, fb = 'walk'; if (memo && !pinned) { exactUnits = true; memoOk = at(memo); exactUnits = false; }
  if (pinned) { lo = pin.fs; ok = pin.ok; fb = 'pin'; root.style.fontSize = lo + 'px'; }
  else if (memoOk) { lo = memo; fb = 'memo'; }
  else if (memo !== target && at(target)) { lo = target; fb = 'target'; }
  // (fit nowhere last time, at this key: the smallest size once, then scrolling at the full size, 11-06; it walked
  // about 20 sizes again on every view switch and resize)
  else if (noFit.has(mkey) && !at(floor)) { lo = target; ok = false; fb = 'nofit'; }
  // edit mode, redrawn on every change: far too much to ever fit (3 windows tall) scrolls at once, no more tries
  else if (S.edit && sectionsEl.scrollHeight > sectionsEl.clientHeight * 3) { lo = target; ok = false; fb = 'edit3x:' + sectionsEl.scrollHeight + '/' + sectionsEl.clientHeight; }
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
      if (!found && !S.edit) { noFit.add(mkey); if (noFit.size > 200) noFit.delete(noFit.values().next().value); }
    }
  }
  // the tiles' heights read again at the size kept; a size that fit and no longer does goes down a little
  root.style.fontSize = lo + 'px';
  const stale = [...v.querySelectorAll('.tg')].some(t => { const u = unitH.get(t); return u && Math.abs(u.fs - lo) > (S.edit ? 1e-4 : 0.01); });   // (edit mode: read at the very size kept, 0.003 off moved a tile a px and undo came back a px off, the stress test 11-08; outside it, 0.01 as before: a redraw of 200 cells took 370 ms)
  exactUnits = stale; const still = stale ? fits() : true; exactUnits = false;
  // (each step down with the heights read at that size, so the size kept is drawn as an undo back to it draws it; and
  // nothing fitting down to the smallest size scrolls at the full size, as the walk does: it stopped at the smallest
  // size here and at the full size there, so an undo or redo of the same layout came back at the other one, 11-08)
  if (ok && !still && !pinned) {
    let got = false; exactUnits = true;
    for (let i = 0; i < 40 && lo > floor; i++) { lo = Math.max(floor, lo - 0.25); if (at(lo)) { got = true; break; } }
    if (!got) { lo = target; ok = false; at(lo); }
    exactUnits = false;
  }
  fitOkNow = ok;
  if (window.__fitLog) __fitLog.push({ k: mkey, memo: memo || 0, memoOk, fb, lo: +lo.toFixed(3), ok, still });   // (the stress test reads how each fit went)
  lastFit[S.screen] = lo / target;
  if (ok) noFit.delete(mkey);
  // (a step's size put back is remembered like any fit, as in 2.4.4: a second draw of the same view, which comes
  // without the pin, has to land on it again. Left out for a few hours on 11-10, that draw fitted afresh and an undo
  // came back a size off: 14.949 before a click, 16.12 after its undo, the stress test at seed 7113)
  rememberFit(mkey, lo);
  app.classList.remove('fitting'); fitNoEven = false; layoutPass();
  if (v.querySelector('.lrow[data-fill]') && sectionsEl.scrollHeight > sectionsEl.clientHeight) { fitNoEven = true; layoutPass(); }   // (even rows don't fit: as All fit)
  growPass(); markSlots(); rememberPacks();
  const sbw = sectionsEl.offsetWidth - sectionsEl.clientWidth;   // (read before the captions are measured: it lays the page out with the Fill rows' growth, see capRefit)
  capRefit();
  document.querySelector('.panes').style.setProperty('--sbw', sbw + 'px');   // the right tab sits left of the scrollbar
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
// after the arrangement changed: a category's or the view's settings drawn again, or once a field there being typed in is left
let inspFitLater = false;
function inspAfterFit() {
  if (!S.edit || sel) return;
  const a = document.activeElement;
  if (a && insp.contains(a) && a.matches('input:not([type=checkbox]):not([type=radio]), textarea')) { inspFitLater = true; return; }
  renderInsp();
}
// new readings came while a field in the settings was typed in or a list there was open: the settings are drawn again
// once it is left (11-08 audit: a charger plugged in mid-name wiped the name)
function inspCatFlush() {
  if (!inspCatLater) return;
  setTimeout(() => { if (!inspCatLater) return; const a = document.activeElement; if (dselOpen || (a && a.closest && a.closest('#insp input, #insp select, #insp textarea'))) return; inspCatLater = false; renderInsp(); }, 0);
}
function refit() {
  if ((drag && drag.started) || rs) { refitLater = true; return; }   // (a rebuild would move the view under the drag)
  if (S.screen !== 'grid' && !isCustom(S.screen) && lastAuto[S.screen] && JSON.stringify(autoRows(S.screen)) !== JSON.stringify(lastAuto[S.screen])) { renderView(false); inspAfterFit(); return; }   // (a category's or the view's settings follow the new arrangement)
  if (S.screen === 'grid' && !isCustom('grid') && $('view') && gridN[fitKey(cssScale())] !== ($('view').querySelectorAll('.gtable').length > 1 ? 2 : 1)) { renderView(false); inspAfterFit(); return; }
  autofit(); updateView(true, true); pxFresh(); inspAfterFit();   // (a category's Column width and Level, or the view's outline, follow the new split, 11-08 audit 0204)
}
window.addEventListener('resize', () => {
  layGen++;
  if (S.L.cats.length) document.documentElement.style.fontSize = (cssScale() * fitRatio) + 'px';
  clearTimeout(fitTimer); fitTimer = setTimeout(refit, 250);
  if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; placeTabInd(true); drawRows(); });   // (once a frame, after the size: two layouts an event before, 11-06)
});
let resizeRaf = 0;

// ---------- views: Tiles, Overview, Grid ----------
let slotWanted = null;
let gzDragCancel = null;   // (a Customize row being dragged: how to drop it nowhere)
let stateGen = 0;   // (which view the host sent last: a save says it, so one made before a newer view is dropped)
let heldSlots = new Set();   // (the slots another program held when the page asked: shown empty, not free)   // the slot state.json links the view to, held when the page started (null: none)
let wantScreen = null, screenRaf = 0;   // a view asked for by a click, drawn on the next frame (requestScreen)
// where a sliding pill goes to sit exactly on its button, as translateX and width for the pill: to the fraction of a
// pixel (offsetLeft and offsetWidth round to whole ones, a screen pixel or more off at 2x), as laid out (a box growing
// open, a button's press scale aside), the pill's own CSS left taken off (11-07, his "visual bug, look at the sliders")
function pillTo(ind, b) {
  const c = b.offsetParent, w = parseFloat(getComputedStyle(b).width) || b.offsetWidth;
  if (!c) return { x: b.offsetLeft, w };
  const cs = getComputedStyle(c), cr = c.getBoundingClientRect(), r = b.getBoundingClientRect(), k = cr.width / (parseFloat(cs.width) || c.offsetWidth) || 1;
  return { x: ((r.left + r.right) / 2 - cr.left) / k - (parseFloat(cs.borderLeftWidth) || 0) - w / 2 - (parseFloat(getComputedStyle(ind).left) || 0), w };
}
function pillPut(ind, b) { const P = pillTo(ind, b); ind.style.width = P.w + 'px'; ind.style.transform = 'translateX(' + P.x + 'px)'; return P; }
function placeTabInd(still, to) {
  for (const x of document.querySelectorAll('#screens button[data-s]')) x.setAttribute('aria-current', x.classList.contains('active') ? 'page' : 'false');   // (11-06)
  const b = document.querySelector('#screens button[data-s="' + (to || wantScreen || S.screen) + '"]'), ind = $('tabind');
  if (!b) return;
  ind.classList.toggle('still', !!still); pillPut(ind, b);
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
  if (!screenRaf) screenRaf = requestAnimationFrame(() => setTimeout(() => { screenRaf = 0; const t = wantScreen; wantScreen = null; if (t && t !== S.screen) showScreen(t); }, 0));   // (built once the click's frame is painted: the pill glides at once, not after the build, 11-08)
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
let storGlide = null;   // (a fold or a type chip: drawRows glides the rows, 11-08)
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
function drawRows(pre) {   // (pre: its scroll read already, before the tick wrote anything)
  if (!S.edit) return;
  const vl = $('vlist'), sp = $('vspace');
  const top = pre ? pre.top : vl.scrollTop, hgt = (pre ? pre.h : vl.clientHeight) || 400;
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
      html += '<div class="vrow g' + (collapsedGroups.has(sn.key) ? ' collapsed' : '') + '" style="top:' + i * ROWH + 'px" data-gs="' + row.s + '"><button class="tw" title="' + (collapsedGroups.has(sn.key) ? 'Expand' : 'Collapse') + '" aria-expanded="' + !collapsedGroups.has(sn.key) + '">' + ICONS.chev + '</button><span class="gn" title="' + esc(sn.name) + '">' + esc(sn.name) + '</span><span class="gc">' + row.n + '</span>' + (relinkFor ? '' : typeFilter === 'hidden' ? '<button class="hid on" data-act="unhides" title="Show this sensor in Storage again" aria-label="Show ' + esc(sn.name) + '">' + ICONS.eye + '</button>' : '<button class="hid" data-act="hides" title="Hide this sensor from Storage" aria-label="Hide ' + esc(sn.name) + '">' + ICONS.eyeOff + '</button><button class="addall" title="Add these as a new category" aria-label="Add all of ' + esc(sn.name) + '">+ all</button>') + '</div>';
    } else {
      const r = row.r, has = iv.has(r.key);
      keys.push(r.key);
      html += '<div class="vrow r" style="top:' + i * ROWH + 'px" data-key="' + esc(r.key) + '"><span class="ti t-' + r.t + '"></span><span class="lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="val"></span>' +
        (relinkFor ? '<button class="add link" data-act="link" aria-label="Link ' + esc(r.label) + '">Link</button>' : (typeFilter === 'hidden' ? '<button class="hid on" data-act="unhide" title="Show it in Storage again" aria-label="Show ' + esc(r.label) + '">' + ICONS.eye + '</button>' : '<button class="hid" data-act="hide" title="Hide it from Storage" aria-label="Hide ' + esc(r.label) + '">' + ICONS.eyeOff + '</button>') + (has ? '<span class="inv" title="In the view" role="img" aria-label="In the view">' + ICONS.check + '</span>' : '<button class="add" data-act="add" title="Add to the view" aria-label="Add ' + esc(r.label) + '">+</button>')) + '</div>';
    }
  }
  // the same rows as last time stay the same elements (a click that spans a tick still lands); only values change
  // (a fold or a type chip: the rows glide from their old tops, new ones fade in in Full, the group's chevron turns;
  // far ones just come. Every other redraw stays as it is, 11-08: they jumped)
  const gl = storGlide; storGlide = null;
  const old = gl && sp._h !== html && motionMode() !== 'off' ? new Map([...sp.children].map(el => [el.dataset.key || 'g' + el.dataset.gs, parseFloat(el.style.top)])) : null;
  if (sp._h !== html) { sp.innerHTML = html; sp._h = html; }
  if (old) {
    const full = motionOn(), far = vl.clientHeight || 400;
    for (const el of sp.children) {
      const t0 = old.get(el.dataset.key || 'g' + el.dataset.gs), t1 = parseFloat(el.style.top);
      if (t0 === undefined || Math.abs(t0 - t1) > far) { if (full) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' }); }
      else if (Math.abs(t0 - t1) > 0.5) el.animate([{ transform: 'translateY(' + (t0 - t1) + 'px)' }, { transform: 'none' }], { duration: full ? 240 : 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
    const g = gl.gs != null ? sp.querySelector('.vrow.g[data-gs="' + gl.gs + '"]') : null; if (g) { g.classList.toggle('collapsed'); void g.offsetWidth; g.classList.toggle('collapsed'); }
  }
  for (const el of sp.children) if (el.dataset.key) setText(el.children[2], valTxt(BYKEY.get(el.dataset.key)));
  if (keys.join('\n') !== rowKeys.join('\n')) { rowKeys = keys; subscribe(); }
  const st = $('vsticky'), first = rows[Math.floor(top / ROWH)];
  if (first && !first.g && top > 0) { const sn = SENS[first.r.s], h = '<span class="gn">' + esc(sn.name) + '</span><span class="gc">' + rows[first.gi].n + '</span>'; st.hidden = false; if (st._h !== h) { st.innerHTML = h; st._h = h; } }   // (written when it changes: every scroll frame and tick before, 11-06)
  else st.hidden = true;
}
function renderChips() {
  const counts = chipCounts;
  const ts = ['all', 'temp', 'volt', 'fan', 'power', 'current', 'clock', 'usage', 'other', 'hidden'].filter(t => counts[t] || t === typeFilter), ch = $('chips');
  // (the same chips: in place, so the lit one's fade plays; one that comes or goes draws them anew, 11-08)
  if (ch._t === ts.join() && ch.children.length === ts.length) {
    ts.forEach((t, i) => { const b = ch.children[i], on = typeFilter === t, tx = (t === 'all' ? 'All' : t === 'hidden' ? 'Hidden' : TYPE_NAME[t]) + ' ' + (counts[t] || 0).toLocaleString('en-US'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); if (b.textContent !== tx) b.textContent = tx; });
    return;
  }
  ch._t = ts.join();
  ch.innerHTML = ts
    .map(t => '<button class="chip' + (t === 'hidden' ? ' hidchip' : '') + (typeFilter === t ? ' on' : '') + '" data-t="' + t + '" aria-pressed="' + (typeFilter === t) + '"' + (t === 'hidden' ? ' title="Hidden readings"' : '') + '>' + (t === 'all' ? 'All' : t === 'hidden' ? 'Hidden' : TYPE_NAME[t]) + ' ' + (counts[t] || 0).toLocaleString('en-US') + '</button>').join('');
}

// ---------- adding and removing cells ----------
function newCell(key) {
  const r = BYKEY.get(key), c = { key, match: r ? matchOf(r) : undefined, u: r ? r.unit : undefined, graph: true };
  if (key === CONN) c.gates = Object.assign({}, CONN_LINES);   // a connector is only worth a cell with its lines
  return c;
}
function addKeys(keys, catId, index, newCatName, nlFrom) {   // (nlFrom: the New row tile it goes in front of, which hands it its New row, 11-08)
  mutate(() => {
    let cat = catId && S.L.cats.find(c => c.id === catId);
    if (!cat) { cat = { id: nid('c'), name: newCatName || 'New category', collapsed: false, cells: [] }; S.L.cats.push(cat); }
    const ids = keys.map(k => { const id = nid('a'); S.L.cells[id] = newCell(k); return id; });
    cat.cells.splice(index == null ? cat.cells.length : index, 0, ...ids);
    if (nlFrom && ids.length && cat.cells.includes(nlFrom)) { setLook('cell', nlFrom, 'nl', '', 'tiles'); setLook('cell', ids[0], 'nl', true, 'tiles'); }
    if (ids.length === 1) { sel = ids[0]; selCat = null; }
  }, keys.length > 1 ? 'Added ' + keys.length + ' cells' : null);
}
function targetForAdd() {
  if (sel) { const c = catOf(sel); if (c) { const d = idsIn(c); if (catLook(c.id).lead === sel && d.length > 1) return { cat: c.id, index: c.cells.indexOf(d[1]) }; return { cat: c.id, index: c.cells.indexOf(sel) + 1 }; } }   // (the lead, drawn first: right after it, as drawn, 11-06)
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
  if (drag.kind === 'cat') { const g0 = drag.ghost && drag.ghost.querySelector('.gs'); if (g0) { setText(g0, ''); g0.classList.remove('no'); } }   // (nowhere to drop: no "Swap with" left from before, 11-06)
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
  let under = document.elementsFromPoint(x, y).find(e => !e.closest('.toast')) || null;   // (a toast over "+ New category" took the drop: what is under it counts, the suite 11-08)
  if (!under) return;
  if (under.closest('#newcat')) {
    // (a cell under the zone, the bottom row of a fitted view: it wins, every cell stays a place to drop, 11-06)
    const beneath = document.elementsFromPoint(x, y).find(e => !e.closest('#newcat') && e.closest('#view .dc'));
    if (!beneath) { nc.classList.add('over'); drag.target = { newcat: true }; return; }
    under = beneath;
  }
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
  // (the mark at the left of a New row tile, the start of its row: the dropped one starts the row, it takes the New row)
  const nl = S.screen === 'tiles' && !ma && !!before && before === mk.dataset.cid && !!cellLook(before, 'tiles').nl;
  // (tiles: packing puts a tile in the first spot it fits, which can be a hole higher up: the place that puts it
  // beside the mark, 11-08 audit: it went elsewhere and moved a tile not touched)
  if (!vertical && !nl && best.el.classList.contains('tile')) before = packedBefore(catEl, cells, mk, ma, before);
  // (before the lead, drawn first: it lands after the lead, so the mark goes there)
  if (before && before === lead) { before = front; const le = cells.find(el => el.dataset.cid === lead); if (le) { mk = le; ma = true; } }
  drag.target = { cat: catId, before, nl: nl || undefined };
  markAt(mk, ma);
}
// the "before" a tile dropped beside mk (after it: ma) needs for packing to put it there: the one asked first, else the
// nearest that does (the tiles as drawn; the dropped one at its own size, a reading 1 x 1)
function packedBefore(catEl, cells, mk, ma, def) {
  const tg = catEl.querySelector('.tg'); if (!tg) return def;
  const k = +tg.style.getPropertyValue('--k') || 1, vis = cells.map(el => el.dataset.cid), m = vis.indexOf(mk.dataset.cid), src = drag && drag.kind === 'cell' ? document.querySelector('#view .tile[data-cid="' + drag.data + '"]') : null;
  if (m < 0) return def;
  const sz = cells.map(el => szOf(el, k)), me = src ? Object.assign(szOf(src, k), { nl: false }) : { w: 1, h: 1, nl: false, f: 0, fx: false, auto: true };
  const okAt = i => { const s = sz.slice(); s.splice(i, 0, me); const { pos } = packTiles(s, k), z = pos[i], q = pos[m + (m >= i ? 1 : 0)]; return Math.abs(z.y - q.y) < 1e-6 && Math.abs(ma ? z.x - (q.x + q.w) : z.x + z.w - q.x) < 1e-6; };
  const d0 = def ? vis.indexOf(def) : vis.length; if (d0 < 0 || okAt(d0)) return def;
  let best = null;
  for (let i = 0; i <= vis.length; i++) if (okAt(i) && (best === null || Math.abs(i - d0) < Math.abs(best - d0))) best = i;
  return best === null ? def : vis[best] || null;
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
  if (d.ghost) { if (d.kind === 'cell' || d.kind === 'cat') flipFrom = { kind: d.kind, id: d.data, r: d.ghost.getBoundingClientRect(), t: performance.now() }; d.ghost.remove(); }
  syncDrawers();
  $('newcat').classList.remove('over');
  for (const el of document.querySelectorAll('#view .dragging')) el.classList.remove('dragging');
  for (const el of document.querySelectorAll('#view .dcat')) el.style.opacity = '';
  if (cancel && d.started && flipFrom && S.edit) { flipNext = true; renderView(false); }   // (let go of with Escape: back from the ghost to its place, as a drop glides, 11-08)
  if (!d.started || cancel) return;
  justDragged = true; setTimeout(() => { justDragged = false; }, 0);
  const t = d.target; if (!t) return;
  if (d.kind === 'cell' && !catOf(d.data)) return;   // removed while it was dragged
  if (d.kind === 'cat' && !S.L.cats.some(c => c.id === d.data)) return;
  if (d.kind === 'cat') dropCat(d);
  else if (d.kind === 'row') {
    const r = BYKEY.get(d.data);
    const to = !t.newcat && catById(t.cat), at = to && t.before ? to.cells.indexOf(t.before) : -1;
    if (t.newcat) addKeys([d.data], null, null, r ? SENS[r.s].short : null); else addKeys([d.data], t.cat, at >= 0 ? at : null, null, t.nl ? t.before : null);
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
      if (t.nl && t.before && to.cells.includes(t.before)) { setLook('cell', t.before, 'nl', '', 'tiles'); setLook('cell', d.data, 'nl', true, 'tiles'); }   // (at the start of a New row: the row starts with it, 11-08 audit)
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
// a tile's size: a share of its row and its rows (2.2, see TILE_MIN)
function setShare(id, f, h, tol, fx) {   // (fx: false for a height alone on a width not set by hand)
  const v = vset('tiles'), m = v.cell || (v.cell = {}), e = m[id] || (m[id] = {});
  delete e.size; delete e.w; delete e.h;
  e.f = fNum(f); if (fx === false) delete e.fx; else e.fx = true; const hh = szNum(h, tol === undefined ? SNAPQ : tol); if (hh !== 1) e.h = hh;   // (fx: set by hand, drawn as set; his 11-06 "if set to 25% they should SHOW at 25%")
}
// k given: w in places of k (a drag, Ctrl+arrows), kept as its share of the row; else in tiles (1 x 1: a normal tile
// again, its category places it)
function setSize(id, w, h, tol, k) {
  if (k) { setShare(id, w / k, h, tol); return; }
  const z = cellSize(id), keep = x => Math.abs(x) < 1e-9 ? 1.5e-4 : tol;   // (a side not changed keeps its size as stored)
  const v = vset('tiles'), m = v.cell || (v.cell = {}), e = m[id] || (m[id] = {});
  delete e.size; delete e.w; delete e.h; delete e.f; delete e.fx; Object.assign(e, sizeLook(w, h, keep(w - z.w), keep(h - z.h)));
  if (!Object.keys(e).length) delete m[id];
  if (!Object.keys(m).length) delete v.cell;
}
// an Automatic view as rows, read off the screen, so making it your own moves nothing: the categories that share a top
// are one row, left to right; Grid: each table a column
function screenRows() {
  if (S.screen === 'grid') {
    const tabs = [...document.querySelectorAll('#view .gtable')];
    let cols = tabs.map(t => ({ stack: [...t.querySelectorAll('tbody.dcat:not(.cont)')].map(b => b.dataset.cat) }));
    if (tabs.length === 2 && document.querySelector('#view .gtable tbody.dcat.cont')) {   // (a category continued in the second table, 11-08 audit)
      const order = cols[0].stack.concat(cols[1].stack), len = id => { const c = catById(id); return c ? (c.collapsed ? 0 : cellsOf(c).length) + 1 : 1; }, tot = order.reduce((a, id) => a + len(id), 0);
      let best = 1, bestM = Infinity, acc = 0;
      for (let i = 1; i < order.length; i++) { acc += len(order[i - 1]); const m = Math.max(acc, tot - acc); if (m < bestM - 1e-9) { bestM = m; best = i; } }
      cols = [{ stack: order.slice(0, best) }, { stack: order.slice(best) }];
    }
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
// at index t.at), into (Grid: the end of table t.table), beside (at the end of t.cat's line, side by side with it),
// unbeside (out of its own line, under it)
// a column added to a row of hand-set widths (twelfths): it takes an even share, the others keep their proportions in
// what is left; none past 12 columns (11-08 audit: adding one threw the row's widths away)
function widthsWith(ws, at) {
  const n = ws.length + 1; if (n > 12) return null;
  const mine = Math.max(1, Math.round(12 / n)), rest = 12 - mine, T = ws.reduce((a, b) => a + b, 0) || 1, w = ws.map(b => Math.max(1, Math.round(b / T * rest)));
  for (let diff = rest - w.reduce((a, b) => a + b, 0), g = 0, j = w.length - 1; diff && g < 200; g++, j = (j + w.length - 1) % w.length) { if (diff > 0) { w[j]++; diff--; } else if (w[j] > 1) { w[j]--; diff++; } }
  w.splice(at, 0, mine); return w;
}
function placeCat(rows, src, t) {
  const PH = '\u0000', s0 = posIn(rows, src);
  if (t.zone === 'swap') {
    const p = posIn(rows, t.cat); if (!s0 || !p) return rows;
    const e0 = s0.col.stack[s0.k], e1 = p.col.stack[p.k], ent = (id, h, b) => h || b ? Object.assign({ id }, h ? { h } : {}, b ? { b: 1 } : {}) : id;
    s0.col.stack[s0.k] = ent(t.cat, e1.h, isBeside(e0)); p.col.stack[p.k] = ent(src, e0.h, isBeside(e1));   // (side by side stays with the place, 11-07)
    return rows;
  }
  const ph = { id: PH }, wasB = !!s0 && isBeside(s0.col.stack[s0.k]); if (wasB) ph.b = 1;
  if (s0) s0.col.stack[s0.k] = ph;   // marked first and removed last, so every index below stays right (as beside as it was: lines stay whole)
  if (t.zone === 'row') rows.splice(Math.max(0, Math.min(rows.length, t.at)), 0, { cols: [{ stack: [src] }] });
  else if (t.table != null) {
    const cols = rows[0].cols;
    if (t.zone === 'into') cols[t.table].stack.push(src);
    else cols.splice(t.table + (t.zone === 'right' ? 1 : 0), 0, { stack: [src] });
  } else {
    const p = posIn(rows, t.cat);
    if (!p && t.zone !== 'unbeside') { if (s0) s0.col.stack[s0.k] = wasB ? { id: src, b: 1 } : src; return rows; }
    if (t.zone === 'unbeside') { const st = s0.col.stack, i = st.indexOf(ph), e = lineAt(st, i)[1]; st.splice(e + 1, 0, src); }   // (out of its line: under it)
    else if (t.zone === 'beside') { const e = lineAt(p.col.stack, p.k)[1]; p.col.stack.splice(e + 1, 0, { id: src, b: 1 }); }   // (the end of that one's line)
    else if (t.zone === 'above' || t.zone === 'below') { const [a, e] = lineAt(p.col.stack, p.k); p.col.stack.splice(t.zone === 'below' ? e + 1 : a, 0, src); }   // (over or under its whole line)
    else {
      const at = p.ci + (t.zone === 'right' ? 1 : 0), cs = p.row.cols, own = cs.length > 1 && cs.every(c => c.w), solo = own && !!s0 && s0.row === p.row && s0.col.stack.length === 1;
      const nw = own && !solo ? widthsWith(cs.map(c => c.w), at) : null;
      cs.splice(at, 0, solo ? { stack: [src], w: s0.col.w } : { stack: [src] });
      if (nw) cs.forEach((c, i) => { c.w = nw[i]; }); else if (!solo) for (const c of cs) delete c.w;   // (hand-set widths stay: a new column takes an even share of them, one moved within its row keeps its own, 11-08 audit)
    }
  }
  // (the first of a line it left leads the rest of it)
  if (s0 && !wasB) { const st = s0.col.stack, i = st.indexOf(ph); if (i >= 0 && isBeside(st[i + 1])) { const e = st[i + 1]; st[i + 1] = e.h ? { id: e.id, h: e.h } : e.id; } }
  for (const r of rows) for (const c of r.cols) { c.stack = c.stack.filter(s => s !== ph); if (isBeside(c.stack[0])) { const e = c.stack[0]; c.stack[0] = e.h ? { id: e.id, h: e.h } : e.id; } }
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
    const groups = [...tables[ti].querySelectorAll('tbody.dcat:not(.cont)')].filter(b => b.dataset.cat !== src);   // (not a category's continued part: its head is in the other table, 11-06)
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
    if (p.row.cols.filter(others).length >= MAXC[vn]) { mk('full', bx, box.top, 3, box.bottom - box.top); return { zone: 'full', txt: 'This row is full: ' + MAXC[vn] + ' side by side' }; }
    mk('', bx, box.top, 3, box.bottom - box.top);
    const lnL = el.closest('.lsub'), mates = lnL ? [...lnL.children].filter(e => e.dataset.cat && e.dataset.cat !== src).map(e => nm(e.dataset.cat)) : [];   // (a line: the new column goes beside all of it, 11-07 audit)
    return { zone, cat: id, txt: mates.length > 1 ? 'A column of its own, ' + zone + ' of ' + mates.join(' and ') : 'Beside ' + nm(id) + ', on the ' + zone };
  }
  if (zone === 'above' || zone === 'below') {
    const ln = el.closest('.lsub'), lr = ln ? ln.getBoundingClientRect() : r, who = ln ? [...ln.children].filter(e => e.dataset.cat && e.dataset.cat !== src).map(e => nm(e.dataset.cat)).join(' and ') : nm(id);   // (a line: over or under all of it, as the drop goes, 11-07 audit)
    const by = zone === 'above' ? lr.top - rg / 2 - 1.5 : lr.bottom + rg / 2 - 1.5;
    if (p.col.stack.filter(s => sid(s) !== src).length >= MAXS[vn]) { mk('full', lr.left, by, lr.width, 3); return { zone: 'full', txt: 'This column is full: ' + MAXS[vn] + ' stacked' }; }
    mk('', lr.left, by, lr.width, 3);
    return { zone, cat: id, txt: 'Stacked ' + (zone === 'above' ? 'over ' : 'under ') + who };
  }
  mk('box', r.left, r.top, r.width, r.height);
  return { zone: 'swap', cat: id, txt: 'Swap with ' + nm(id) };
}
function dropCat(d) {
  const t = d.target, vn = S.screen, src = d.data;
  if (!t || t.zone === 'full') return;
  // an Automatic view stays automatic when only the order changes (a swap, Grid up and down) and Automatic then draws
  // what the mark said; when it would not (it puts the biggest first in the shortest column, Grid cuts at the middle
  // line), the drop makes the view your own, as a drop on one of yours (11-08 audit: nothing moved, or it landed in the
  // other table)
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
    const cats = order.map(catById).filter(Boolean).concat(S.L.cats.filter(c => !order.includes(c.id)));
    if (sameStacks(autoFor(vn, cats), placeCat(clone(d.rows), src, t))) { layoutChange(() => { S.L.cats = cats; }); return; }
  }
  layoutChange(() => { const v = vset(vn); if (!v.rows) froze = true; v.rows = placeCat(clone(d.rows), src, t); });
}
// what Automatic draws for this order of the categories (Grid: its two tables, the categories that start in each)
function autoFor(vn, cats) {
  const was = S.L.cats; S.L.cats = cats;
  try { return vn === 'grid' ? gridAutoRows() : autoRows(vn); } finally { S.L.cats = was; }
}
function sameStacks(a, b) { const f = x => JSON.stringify(x.map(r => r.cols.map(c => c.stack.map(sid)).filter(c => c.length)).filter(r => r.length)); return f(a) === f(b); }
// Grid on Automatic: two tables side by side when there is room, cut at the middle line: a long category there goes on
// in the second table ("continued"), so the two come out about as long; only what is drawn (an empty one is hidden
// outside edit mode, 11-06)
function gridItems() { return S.L.cats.filter(cat => S.edit || cellsOf(cat).length).map(cat => ({ cat, ids: cat.collapsed ? null : idsIn(cat) })); }
function gridTwo() { return gridForce ? gridForce === 2 : gridN[fitKey(cssScale())] === 2; }   // else one under the other: one table
function gridCut(items, two) {
  const len = it => (it.ids ? it.ids.length : 0) + 1, half = Math.ceil(items.reduce((a, it) => a + len(it), 0) / 2), t1 = [], t2 = [];
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
  return [t1, t2];
}
function gridAutoRows() { const [t1, t2] = gridCut(gridItems(), gridTwo()), st = t => t.filter(it => !it.cont).map(it => it.cat.id); return [{ cols: [{ stack: st(t1) }, { stack: st(t2) }] }]; }

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
// a row's columns at their narrowest (data-min: a tile, a card, a line) in twelfths of the row as drawn, so a width set by
// hand never leaves one under it (11-08 audit 0202: 75% on three columns drew one 95 px wide); null when it isn't drawn
// side by side
function minTwelfths(ri) {
  const el = document.querySelector('#view .lrow[data-r="' + ri + '"]'); if (!el) return null;
  const cs = [...el.children].filter(e => e.classList.contains('lcol')), fs = parseFloat(document.documentElement.style.fontSize) || 13;
  const W = el.classList.contains('fold') ? el.clientWidth - (cs.length - 1) * (parseFloat(getComputedStyle(el).columnGap) || 0) : cs.reduce((a, c) => a + c.getBoundingClientRect().width, 0);   // (folded: the room its columns would share side by side, review 11-08)
  return W > 0 ? cs.map(c => Math.max(1, Math.ceil(((+c.dataset.min || 0) * fs - 1) / (W / 12) - 1e-6))) : null;   // (as layoutPass folds: a pixel's grace)
}
const sumOf = a => a.reduce((x, y) => x + y, 0);
const foldStuck = ri => { const el = document.querySelector('#view .lrow[data-r="' + ri + '"]'); if (!el || !el.classList.contains('fold')) return false; const mt = minTwelfths(ri); return !mt || sumOf(mt) > 12; };   // (folded and no widths could put it side by side again: the window is too narrow for its columns)
const heightTxt = h => h ? 'Fill' : 'Fit';
// ---- tile sizes: its corner, the numbers in its settings, Ctrl+arrows ----
// a drawn tile: its category (k tiles to a row), a spot's width p (a gap included), and at(w, h): how tall in px the
// tile and all the category's tiles would be with this tile at w x h (the others as they are)
function tileGeo(tile) {
  const tg = tile && tile.parentElement; if (!tg || !tg.classList.contains('pk') || !tg._L) return null;
  const kids = tileKids(tg), j = kids.indexOf(tile); if (j < 0) return null;
  const k = +tg.style.getPropertyValue('--k') || 1, fs = parseFloat(document.documentElement.style.fontSize) || 13, g = 0.62 * fs * spOf($('view')), short = tg.classList.contains('shorts');
  const row = tg.closest('.lrow'), grNow = () => row && row.classList.contains('grow') && !short ? parseFloat(row.style.getPropertyValue('--gr')) || 0 : 0;
  const sz = kids.map(x => szOf(x, k)), nat = kids.map(x => natOf(x, short)), tr = tg.getBoundingClientRect(), p = (tr.width + g) / k;
  const at = (w, h) => { const s = sz.slice(); s[j] = { w, h, nl: sz[j].nl, f: w / k, auto: false, fx: true }; const L = placeTiles(floorSz(s, k, tr.width, g, fs, short), nat, k, g / fs, !short && fillEven(row)), q = L.pos[j], gr = grNow(); return { th: q.th * fs + q.h * gr, TH: L.TH * fs + L.H * gr, x: q.x, y: q.y, w: drawnW(q) }; };
  // (wmin: the minimum, in places)
  const min = (short ? 15 : TILE_MIN) * fs;   // (short tiles: 15rem, as floorSz and balancedK; the corner offered 25% they drew at 50%, 11-08 audit)
  return { tg, j, k, g, fs, tw: tr.width, p, at, r: tile.getBoundingClientRect(), s: sz[j], min, wmin: Math.min(k, (min + g) / p) };
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
const lastBottom = c => { const ks = [...c.children].filter(e => e.classList.contains('dcat') || e.classList.contains('lsub')); return ks.length ? ks[ks.length - 1].getBoundingClientRect().bottom : 0; };
function colEnds(blk) {
  const ln = blk.parentElement && blk.parentElement.classList.contains('lsub') && !blk.parentElement.classList.contains('fold') ? blk.parentElement : null;
  if (ln) {   // (side by side: its column's end as if it were the tallest of its line, level with the columns beside it and its mates, 11-07 audit)
    const E = colEnds(ln), under = E.own != null ? Math.max(0, E.own - ln.getBoundingClientRect().bottom) : 0;
    const own = blk.getBoundingClientRect().bottom + under, mates = [...ln.children].filter(e => e !== blk && e.classList.contains('dcat') && e.getClientRects().length).map(e => e.getBoundingClientRect().bottom + under), mm = mates.length ? Math.max(...mates) : -Infinity;
    return { own, cols: mates.concat(mates.length ? E.cols.filter(c => c >= mm - 0.5) : E.cols), row: E.row };   // (only ends past its tallest mate move its column: under it, that mate holds the end)
  }
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
const setTileSz = (t, w, h, k, hOnly) => { if (!hOnly) { delete t.dataset.w; t.dataset.f = String(Math.round(Math.min(1, w / k) * 1e4) / 1e4); t.dataset.fx = '1'; } else { delete t.dataset.f; delete t.dataset.fx; } if (h !== 1) t.dataset.h = h; else delete t.dataset.h; };   // (hOnly: an Auto tile whose height alone moves stays Auto, its row drawn as it is, 11-08 audit)
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
// dragging the corner: its top-left stays, only its category is placed again until it is let go. Its width snaps to 25,
// 33, 50, 67, 75 and 100% of its row and to the edges of the other tiles, never under the minimum; its height to quarter
// rows and to the bottom of the columns beside it; Alt: any size
function startCorner(tile) {
  const G = tileGeo(tile); if (!G) return false;
  const xs = [], ys = [], kids = tileKids(G.tg), pos = G.tg._L ? G.tg._L.pos : [], tgL = G.tg.getBoundingClientRect().left;
  const after = new Set(kids.slice(G.j + 1));
  // (a row drawn wider, see fillRows, goes back to its placing once a size in it changes: its tiles' edges as placed)
  const placed = q => [tgL + q.x * G.p, tgL + q.x * G.p + pxW(G, q.w)];
  for (const t of document.querySelectorAll('#view .tile')) if (t !== tile && !after.has(t)) {
    const r = t.getBoundingClientRect(); if (!r.width) continue;
    const q = t.parentElement === G.tg ? pos[kids.indexOf(t)] : null;
    xs.push(...(q && q.dw != null ? placed(q) : [r.left, r.right])); ys.push(r.top, r.bottom);
  }
  xs.push(G.tg.getBoundingClientRect().right);
  guideBox = sectionsEl.getBoundingClientRect();
  // (this one drawn wider: it goes from where it is placed to its right edge as drawn, so the corner stays under the
  // pointer)
  const pd = pos[G.j];
  if (pd && pd.dw != null) { const r = G.r, left = placed(pd)[0]; G.r = { left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - left, height: r.height }; }
  const w0 = pd && pd.dw != null ? Math.min(G.k, Math.max(G.wmin, r4((G.r.width + G.g) / G.p))) : Math.min(pd ? pd.w : G.s.w, G.k), a0 = G.at(w0, G.s.h);   // (held to the minimum: from what it is drawn at)
  Object.assign(rs, G, { kind: 'corner', tile, cid: tile.dataset.cid, w0, h0: G.s.h, w: G.s.w, h: G.s.h, th0: a0.th, TH0: a0.TH, sx: a0.x, sy: a0.y, xs, ys, ends: colEnds(tile.closest('.dcat')) });
  return true;
}
function moveCorner(ev) {
  const R = rs, maxW = R.k, thr = 7, lines = [], seen = new Map(), at0 = R.at;
  R.at = (w, h) => { const key = w + '|' + h; if (!seen.has(key)) seen.set(key, at0(w, h)); return seen.get(key); };   // each size placed once per move
  try { moveCorner0(ev, R, maxW, thr, lines); } finally { R.at = at0; }
}
function moveCorner0(ev, R, maxW, thr, lines) {
  R.last = { clientX: ev.clientX, clientY: ev.clientY };
  // a side the pointer hasn't moved along keeps its size as it is (a wide tile in a one-per-row category stays wide)
  const dx = ev.clientX - R.x0, dy = ev.clientY - R.y0, mx = Math.abs(dx) >= 3, my = Math.abs(dy) >= 3;
  let w = mx ? Math.min(maxW, Math.max(R.wmin, R.w0 + dx / R.p)) : R.s.w, level = false;
  // the snap nearest to where the pointer is wins: one of the shares, another tile's edge, (height) a quarter row, a
  // column beside it ending level, which wins a near tie
  const best = cs => cs.reduce((a, c) => c && (!a || c[0] < a[0]) ? c : a, null);
  if (!ev.altKey && mx) {
    const us = PCTS.map(q => q / 100 * R.k).filter(u => u >= R.wmin - PE), wq = us.length ? us.reduce((a, u) => Math.abs(u - w) < Math.abs(a - w) ? u : a) : maxW;
    const at = R.r.left + pxW(R, w), nx = nearest(R.xs, at, thr), wx = nx === null ? null : (nx - R.r.left + R.g) / R.p;
    const c = best([[Math.abs(R.r.left + pxW(R, wq) - at), wq], wx !== null && wx >= R.wmin - PE && wx <= maxW + PE ? [Math.abs(nx - at), wx, { x: nx }] : null]);
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
  setTileSz(R.tile, R.w, R.h, R.k, R.s.auto && Math.abs(R.w - R.s.w) <= 1e-4);
  packTg(R.tg, R.k); tileFit(R.tg, R.tw, R.k, R.g, R.fs);
  if (R.tg.closest('.lrow.grow')) growPass();   // a Fill row shares its spare room again
  guides(lines);
  if (sel === R.cid) for (const [k, v] of [['f', Math.round(R.w / R.k * 1000) / 10], ['h', R.h]]) { const b = document.querySelector('#insp input[data-sz="' + k + '"]'); if (b) b.value = v; }
  pill(pctTxt(R.w / R.k) + ' x ' + fmtSz(R.h) + ' rows' + (level ? ', level with the column beside it' : '') + (full ? ', as far as it goes in its place' : ''), ev.clientX + 14, ev.clientY + 10);
}
// the numbers in a tile's settings: its width as a % of its row, its height in rows
function sizeInput(cid, which, v) {
  if (nudge) flushNudge();   // (a Ctrl+arrow just before: its side counts)
  const z = cellSize(cid), fq = 'input[data-sz="' + which + '"]', fc = which === 'f' ? 'cf' : 'ch';
  if (!isFinite(v) || v <= 0) { renderInsp(); szFlash(fq, NaN, fc); return; }
  szFlash(fq, v, fc);
  if (which === 'f') {
    const q = PCTS.find(x => Math.abs(x - v) < 0.5), G = tileGeo(tileEl(cid)), drawn = u => !G || u >= 1 - PE || Math.abs(G.at(u * G.k, z.h).w - u * G.k) <= 0.012 * G.k;
    let f = Math.min(1, (q || v) / 100); if (!drawn(f)) f = PCTS.map(x => x / 100).find(u => u > f && drawn(u)) || 1;   // (under the minimum: the smallest share it is drawn at, so the field says what is drawn, 11-08 audit)
    mutate(() => setShare(cid, f, z.h));   // (a typed 33 or 67: the third its chip gives)
  }
  else if (which === 'h') mutate(() => z.f ? setShare(cid, z.f, v, undefined, z.fx) : setSize(cid, z.w, v));
}
// a typed size the rules changed (junk, over 100, a width that can't be drawn, near a chip): the field and the chip it
// became light up in the edit colour and fade, about 0.6 s (his 11-09 pick; Minimal and Off: held, no fade). Kept as
// typed: nothing. Read once the panel is drawn again with what was set
function szFlash(q, typed, chips) {
  setTimeout(() => {
    const i = document.querySelector('#insp ' + q); if (!i) return;
    const now = parseFloat(i.value);
    if (isFinite(typed) && isFinite(now) && Math.abs(now - typed) < 0.05) return;
    const go = el => { el.classList.remove('szfl'); void el.offsetWidth; el.classList.add('szfl'); clearTimeout(el._szfl); el._szfl = setTimeout(() => el.classList.remove('szfl'), 650); };
    go(i);
    if (chips && isFinite(now)) { const c = [...document.querySelectorAll('#insp [data-lay="' + chips + '"] button[data-v]')].find(b => Math.abs(parseFloat(b.dataset.v) - now) < 0.06); if (c) go(c); }
  }, 90);
}
// Ctrl+arrows: 1% of its row wider or narrower, a pixel taller or shorter; with Shift the next share (25, 33, 50, 67,
// 75, 100%) or quarter row. Shown at once on its
// category only; kept (one undo step, the view fitted again) once the keys rest, so a held key never queues redraws
let nudge = null, nudgeT = 0;
function flushNudge() {
  clearTimeout(nudgeT);
  const n = nudge; nudge = null; lpill.classList.remove('on');
  if (!n || !S.L.cells[n.cid]) return;
  keyLayout(() => mutate(() => nudgeSet(n)));
  const inSz = !!(document.activeElement && document.activeElement.matches && document.activeElement.matches('#insp input[data-sz]'));   // (pressed in a size field: the redraw gave it back its focus, it keeps it)
  const e = tileEl(n.cid); if (e && n.cid === sel && !inSz) e.focus({ preventScroll: true });
}
// the pending nudge in as its own, earlier undo step, with no redraw (the tile already shows it): a setting changed,
// the first key typed in a field or a curve point pressed right after Ctrl+arrows takes the step after it (a redraw
// there would rebuild the field being typed in, or the point under the press)
function nudgeQuiet() {
  if (!nudge) return;
  clearTimeout(nudgeT); const n = nudge; nudge = null; lpill.classList.remove('on');
  if (!S.L.cells[n.cid]) return;
  const before = snapOf(); nudgeSet(n); tidyViews(S.L);
  if (snapOf() !== before) { pushUndo(before); saveState(); syncUndo(); syncSaves(); }
}
// (a height step alone: a share keeps its share and whether it was set by hand, so a row drawn wider stays so, 11-06)
function nudgeSet(n) { const z = cellSize(n.cid); if (!n.wd && z.f) setShare(n.cid, z.f, n.h, n.tol, z.fx); else setSize(n.cid, n.w, n.h, n.tol, n.wk ? n.k : undefined); }
function nudgeSize(cid, dx, dy, quarter) {
  if (nudge && nudge.cid !== cid) flushNudge();
  const t = tileEl(cid), G = tileGeo(t); if (!G) return;
  const z = nudge && nudge.cid === cid ? { w: nudge.w, h: nudge.h } : { w: G.s.w, h: G.s.h };   // (its own width, not the row's: a height step kept a wide tile at 1, 11-06; drawn within k below)
  const pd = (!nudge || nudge.cid !== cid) && G.tg._L ? G.tg._L.pos[G.j] : null;   // (drawn wider, or held to the minimum: a width step goes from what you see)
  const q = (v, d) => (d > 0 ? Math.floor(v * 4 + PE) + 1 : Math.ceil(v * 4 - PE) - 1) / 4, w0 = Math.min(dx && pd ? r4(drawnW(pd)) : z.w, G.k), lim = (v, mx) => r4(Math.min(mx, Math.max(0.25, v)));
  const us = PCTS.map(p => p / 100 * G.k), next = (v, d) => d > 0 ? (us.find(u => u > v + 1e-3) || G.k) : ([...us].reverse().find(u => u < v - 1e-3) || G.wmin);
  // (only the side the arrow moves changes)
  const w = !dx ? z.w : r4(Math.min(G.k, Math.max(G.wmin, quarter ? next(w0, dx) : w0 + dx * G.k / 100)));
  const h = !dy ? z.h : lim(quarter ? q(z.h, dy) : solveSize(hh => G.at(w0, hh).th, G.at(w0, z.h).th + dy, z.h), 2);
  const wd = !!dx || !!(nudge && nudge.cid === cid && nudge.wd);   // (the width stepped at all: else its share and "set by hand" stay as they were, 11-06)
  nudge = { cid, w, h, k: G.k, tol: quarter ? SNAPQ : snapAt(G), wk: !!G.s.f || !!dx || !!(nudge && nudge.cid === cid && nudge.wk), wd };   // (wk: its width set: kept as a share)
  // (its neighbours glide to where the new size puts them, from where they are seen, as with the size buttons; a held
  // key carries on mid-glide, 11-08: they jumped)
  const nb = motionMode() !== 'off' ? tileKids(G.tg).filter(x => x !== t).map(x => [x, x.getBoundingClientRect()]) : null;
  if (nb) for (const [x] of nb) for (const an of x.getAnimations()) if (an.id === 'nudge') an.cancel();
  setTileSz(t, Math.min(w, G.k), h, G.k, G.s.auto && !wd); packTg(G.tg, G.k); tileFit(G.tg, G.tw, G.k, G.g, G.fs);
  if (nb) for (const [x, a] of nb) { const b = x.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top; if (Math.abs(dx) + Math.abs(dy) > 1) x.animate([{ transform: 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px)' }, { transform: 'none' }], { duration: motionOn() ? 240 : 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', id: 'nudge' }); }
  const r = t.getBoundingClientRect(), say = pctTxt(Math.min(w, G.k) / G.k) + ' x ' + fmtSz(h) + ' rows';
  pill(say, r.right + 6, r.bottom + 6); live.textContent = say;
  clearTimeout(nudgeT);
  nudgeT = setTimeout(function later() { if (rs || dragPt || (drag && drag.started)) { nudgeT = setTimeout(later, 350); return; } flushNudge(); }, 350);   // (not under a drag: the redraw would leave it on the old tiles)
}
// a category: every tile one width or height; Line up the bottom: its tiles taller or shorter, all by the same factor, just
// enough that its column ends level with the tallest one beside it
function catSizeInput(id, which, v) {
  const cat = catById(id); if (!cat || !isFinite(v) || v <= 0) { renderInsp(); return; }
  const q = which === 'f' ? PCTS.find(x => Math.abs(x - v) < 0.5) : null;
  mutate(() => { for (const c of cellsOf(cat)) { const z = cellSize(c); if (which === 'f') setShare(c, (q || v) / 100, z.h); else if (z.f) setShare(c, z.f, v, undefined, z.fx); else setSize(c, z.w, v); } });
}
function fitRow(id) {
  const blk = document.querySelector('#view .blk[data-cat="' + CSS.escape(id) + '"]'), tg = blk && blk.querySelector('.tg.pk'), tiles = tg ? tileKids(tg) : [];
  const E = blk ? colEnds(blk) : null, G = tiles.length ? tileGeo(tiles[0]) : null;
  if (!G || !E.cols.length) { toast('Nothing beside it to line up with'); return; }
  const short = tg.classList.contains('shorts'), target = Math.max(...E.cols), base = tiles.map(x => szOf(x, G.k)), nat = tiles.map(x => natOf(x, short));
  const row = tg.closest('.lrow'), gr = row && row.classList.contains('grow') && !short ? parseFloat(row.style.getPropertyValue('--gr')) || 0 : 0;
  const hs = f => base.map(s => r4(Math.min(2, Math.max(0.25, s.h * f))));
  const TH = f => { const h = hs(f), L = placeTiles(floorSz(base.map((s, i) => Object.assign({}, s, { h: h[i] })), G.k, G.tw, G.g, G.fs, short), nat, G.k, G.g / G.fs, !short && fillEven(row)); return L.TH * G.fs + L.H * gr; };
  const TH1 = TH(1), end = f => E.own + TH(f) - TH1;
  let lo = 0.125, hi = 8;
  for (let i = 0; i < 24; i++) { const m = Math.sqrt(lo * hi); if (end(m) < target) lo = m; else hi = m; }
  const f = Math.abs(end(lo) - target) < Math.abs(end(hi) - target) ? lo : hi, miss = Math.round(Math.abs(end(f) - target)), h = hs(f);
  mutate(() => tiles.forEach((t, i) => base[i].f ? setShare(t.dataset.cid, base[i].f, h[i], undefined, base[i].fx) : setSize(t.dataset.cid, base[i].w, h[i])), miss > 1 ? 'As close as it gets: ' + miss + ' px off. A tile stays 0.25 to 2 rows tall' : 'Its column now ends level with the tallest beside it');
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
      const W = cols.reduce((a, c) => a + c.getBoundingClientRect().width, 0), T = base.reduce((a, b) => a + b, 0), fixed = row.cols.every(c => c.w);
      const fbase = fixed || rowEl.classList.contains('fold') || !W || cols.length !== base.length ? base : cols.map(c => c.getBoundingClientRect().width / W * T);   // (a row that follows its content: from where its line is drawn, the first step lands on the twelfth under the pointer, 11-08 audit 0205)
      const mt = minTwelfths(ri);
      Object.assign(rs, { kind: 'split', rowEl, ri, k: +el.dataset.k, base, fbase, mins: mt && mt.length === base.length ? mt.map(x => Math.ceil(x * T / 12 - 1e-6)) : base.map(() => 1), w: base.slice(), T, unit: W / T, fixed, auto0: rowEl.dataset.auto, cols0: rowEl.style.getPropertyValue('--cols') });
    } else { const h0 = row.h || fillAll(S.screen) ? 1 : 0; Object.assign(rs, { kind: 'rowh', ri, h0, h: h0 }); }
  }
  el.classList.add('on');
}
function moveHandle(ev) {
  if (!rs) return;
  if (!rs.moved && Math.hypot(ev.clientX - rs.x0, ev.clientY - rs.y0) < 3) return;
  rs.moved = true;
  if (rs.kind === 'split') {
    const k = rs.k, pair = rs.base[k] + rs.base[k + 1], lo = rs.mins[k], hi = pair - rs.mins[k + 1];
    const a = hi < lo || (!rs.fixed && Math.abs(ev.clientX - rs.x0) < rs.unit / 2) ? rs.base[k] : Math.max(lo, Math.min(hi, Math.round(rs.fbase[k] + (ev.clientX - rs.x0) / rs.unit))), b = pair - a;   // (a row that follows its content: under half a twelfth is a wiggle, it stays so, review 11-08)   // (each side at its narrowest at least, 11-08 audit 0202)
    rs.w = rs.base.slice(); rs.w[k] = a; rs.w[k + 1] = b;
    // (11-06: laid out again only when the split changed, not every move; back where it was, a row that follows its
    // content stays so, a wiggle froze it into twelfths)
    if (rs.lastA !== a) {
      rs.lastA = a;
      if (a === rs.base[k] && !rs.fixed) { if (rs.auto0 !== undefined) rs.rowEl.dataset.auto = rs.auto0; if (rs.cols0) rs.rowEl.style.setProperty('--cols', rs.cols0); else rs.rowEl.style.removeProperty('--cols'); }
      else { delete rs.rowEl.dataset.auto; rs.rowEl.dataset.w = rs.w.join(','); rs.rowEl.style.setProperty('--cols', colTracks(rs.w.map(w => ({ w })))); }
      layoutPass(); growPass();
    }
    pill(pctTxt(a / rs.T) + ' | ' + pctTxt(b / rs.T), ev.clientX, ev.clientY - 36);   // (in %, as the settings, 11-06)
  } else if (rs.kind === 'rowh') {
    const dy = ev.clientY - rs.y0;
    rs.h = dy > 18 ? 1 : dy < -18 ? 0 : rs.h0;
    const rowEl = document.querySelector('#view .lrow[data-r="' + rs.ri + '"]');
    if (rowEl && rs.lastH !== rs.h) { rs.lastH = rs.h; if (rs.h) rowEl.dataset.fill = '1'; else delete rowEl.dataset.fill; layoutPass(); growPass(); }
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
  if (cancel) { flipNext = true; renderView(false); renderInsp(); return; }   // (Escape: it glides back from the preview, 11-08)
  const before = snapOf();
  if (h.kind === 'split' && !h.fixed && h.w.every((w, i) => w === h.base[i])) { flipNext = true; renderView(false); renderInsp(); return; }   // (a content row left where it was: no step, 11-06; it glides back, 11-08)
  if (h.kind === 'split') mutate(() => { const row = stored(S.screen).rows[h.ri]; row.cols.forEach((c, i) => { c.w = h.w[i]; }); });
  else if (h.kind === 'rowh') mutate(() => { const row = stored(S.screen).rows[h.ri]; rowFill(S.screen, row, !!h.h); });
  else if (h.s.f && Math.abs(h.w - h.s.w) <= 1e-4) mutate(() => setShare(h.cid, h.s.f, h.h, snapAt(h), h.s.fx));   // (a height alone: its share and "set by hand" as they were, 11-06)
  else mutate(() => setSize(h.cid, h.w, h.h, snapAt(h), h.s.f || Math.abs(h.w - h.s.w) > 1e-4 ? h.k : undefined));   // (its width as it was: a normal tile stays one, 2.2)
  if (snapOf() === before) { flipNext = true; renderView(false); renderInsp(); }   // back where it started: draw it as it was (gliding, 11-08)
}
const rsOwn = ev => !rs || rs.pid == null || ev.pointerId === rs.pid;   // (only the pointer that started it)
document.addEventListener('pointermove', ev => { if (rsOwn(ev)) moveHandle(ev); });
document.addEventListener('pointerup', ev => { if (swallowUp(ev)) return; if (rsOwn(ev)) endHandle(false); });
document.addEventListener('pointercancel', ev => { if (rsOwn(ev)) endHandle(true); });
function handleDblclick(el) {
  if (el.classList.contains('corner')) { mutate(() => setSize(el.closest('.tile').dataset.cid, 1, 1)); return; }
  const v = stored(S.screen), ri = +el.closest('.lrow').dataset.r, row = v && v.rows && v.rows[ri]; if (!row) return;
  if (el.classList.contains('ldiv')) mutate(() => { for (const c of row.cols) delete c.w; });
  else mutate(() => rowFill(S.screen, row, false));
}

// ---------- moving and sizing a selected category (the buttons in its settings and the keys do the same) ----------
// Move: row = a row of its own under its row now, beside = the last column of the row above, stack = under the
// category on its left, unstack = a column of its own right of its stack
function moveOptions(id) {
  const rows = rowsNow(), p = posIn(rows, id), o = {};
  if (!p || S.screen === 'grid') return o;
  o.row = p.row.cols.length > 1 || p.col.stack.length > 1;
  const me = p.col.stack[p.k];
  if (isBeside(me)) o.beside = o.besideOn = true;
  else if (p.k > 0) { const [a, e] = lineAt(p.col.stack, p.k - 1); o.beside = e - a + 1 < MAXB; }
  else o.beside = p.ri > 0 && rows[p.ri - 1].cols.length < MAXC[S.screen];
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
    else if (how === 'beside' && isBeside(p.col.stack[p.k])) t = { zone: 'unbeside' };
    else if (how === 'beside' && p.k > 0) t = { zone: 'beside', cat: sid(p.col.stack[p.k - 1]) };
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
  const now = widthsNow(p.ri, p.row.cols), el = document.querySelector('#view .lrow[data-r="' + p.ri + '"]');
  if (el && foldStuck(p.ri)) return;   // (drawn one under the other and no width could change that, 11-08 audit 0203; one only too narrow can be widened, review)
  const m0 = minTwelfths(p.ri), mt = m0 && m0.length === now.length ? m0 : now.map(() => 1), lo = mt[p.ci], hi = 12 - mt.reduce((a, x, i) => i === p.ci ? a : a + x, 0);
  if (hi < lo) return;
  layoutChange(() => {
    const rows = ownRows(), q = posIn(rows, id), cols = q.row.cols, base = now, T = base.reduce((a, b) => a + b, 0);
    const mine = Math.max(lo, Math.min(hi, twelfths)), rest = 12 - mine, others = T - base[q.ci];   // (the others kept at their narrowest at least, 11-08 audit 0202)
    const w = base.map((b, i) => i === q.ci ? mine : Math.max(mt[i], Math.round(b / others * rest)));
    let diff = 12 - w.reduce((a, b) => a + b, 0);
    for (let i = cols.length - 1, g = 0; diff !== 0 && g < 100; g++, i = (i + cols.length - 1) % cols.length) {
      if (i === q.ci) continue;
      if (diff > 0) { w[i]++; diff--; } else if (w[i] > mt[i]) { w[i]--; diff++; }
    }
    cols.forEach((c, i) => { c.w = w[i]; });
  });
  announce(id);
}
function nudgeWidth(id, d) {
  const p = posIn(rowsNow(), id); if (!p || p.row.cols.length < 2) return;
  const now = widthsNow(p.ri, p.row.cols), el = document.querySelector('#view .lrow[data-r="' + p.ri + '"]'), m0 = minTwelfths(p.ri), tn = sumOf(now), mt = m0 && m0.length === now.length ? m0.map(x => Math.ceil(x * tn / 12 - 1e-6)) : now.map(() => 1);
  if (el && foldStuck(p.ri)) return;   // (one under the other with nothing to undo it, 11-08 audit 0203)
  { const w = now, j = p.ci < p.row.cols.length - 1 ? p.ci + 1 : p.ci - 1; if (w[p.ci] + d < mt[p.ci] || w[j] - d < mt[j]) return; }   // at the limit, a column at its narrowest (11-08 audit 0202): nothing to do
  layoutChange(() => {
    const rows = ownRows(), q = posIn(rows, id), cols = q.row.cols, w = now.slice(), j = q.ci < cols.length - 1 ? q.ci + 1 : q.ci - 1;
    if (w[q.ci] + d < mt[q.ci] || w[j] - d < mt[j]) return;
    w[q.ci] += d; w[j] -= d;
    cols.forEach((c, i) => { c.w = w[i]; });
  });
  announce(id);
}
// a Tiles row's Fill: the view's Fill the window fills every row (Automatic too); a row of yours can fill on its own while
// the view fits. A row set to fit while the whole view fills: every other row keeps filling, on its own
const fillAll = vn => vn === 'tiles' && !!(viewOf('tiles') && viewOf('tiles').fill);
function rowFill(vn, row, on) {   // (inside a change, on the stored rows)
  const t = vset(vn);
  if (t.fill) { if (on) return; delete t.fill; for (const r of t.rows || []) r.h = 1; }
  if (on) row.h = 1; else delete row.h;
}
function setRowHeight(id, h) {
  if (h ? fillAll(S.screen) : !isCustom(S.screen) && !fillAll(S.screen)) return;   // (filling already; Automatic rows already fit)
  layoutChange(() => { const rows = ownRows(), q = posIn(rows, id); if (!q) return; rowFill(S.screen, q.row, !!h); });
  announce(id);
}
// the category nearest to it on screen in a direction (for Alt+arrow)
function nearestCat(id, dx, dy) {
  for (const el of document.querySelectorAll('#view .dcat')) for (const an of el.getAnimations()) an.finish();   // (mid-glide they measure where they were: a quick second press swapped back, 11-06)
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
  const big = c => vn === 'tiles' ? cellsOf(c).length > (n === 2 ? 6 : 9) || (catLook(c.id, vn).per || 0) >= 5 || cellsOf(c).some(x => { const f = cellSize(x).f; return !!f && f <= 0.2; }) : catLook(c.id, vn).style === 'band';
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
// your Grid's tables to n, each category kept in its table (11-06 audit: a new count cut every table again by length):
// more, the longest table splits at its middle category; fewer, the last table joins the one before it
let tablesWere = null;   // (the tables before the last count change: straight back to that count gives them as they were)
function retable(cols, n) {
  const was = JSON.stringify(cols);
  if (tablesWere && tablesWere.after === was && tablesWere.n === n) return JSON.parse(tablesWere.before);
  const sz = x => { const c = catById(sid(x)); return (c ? cellsOf(c).length : 0) + 1; }, len = c => c.stack.reduce((a, x) => a + sz(x), 0);
  cols = cols.map(c => ({ stack: c.stack.slice() }));
  while (cols.length > Math.max(1, n)) {   // (the smallest table joins its smaller neighbour)
    let i = 0; cols.forEach((c, j) => { if (len(c) < len(cols[i])) i = j; });
    const j = i === 0 ? 1 : i === cols.length - 1 ? i - 1 : len(cols[i - 1]) <= len(cols[i + 1]) ? i - 1 : i + 1;
    if (j < i) cols[j].stack.push(...cols[i].stack); else cols[j].stack.unshift(...cols[i].stack);
    cols.splice(i, 1);
  }
  while (cols.length < n) {
    let i = -1; cols.forEach((c, j) => { if (c.stack.length > 1 && (i < 0 || len(c) > len(cols[i]))) i = j; }); if (i < 0) break;
    const c = cols[i], half = len(c) / 2; let acc = 0, k = 1;
    for (let j = 0; j < c.stack.length - 1; j++) { acc += sz(c.stack[j]); k = j + 1; if (acc >= half) break; }
    cols.splice(i + 1, 0, { stack: c.stack.splice(k) });
  }
  tablesWere = { before: was, after: JSON.stringify(cols), n: JSON.parse(was).length };
  return cols;
}
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
  live.textContent = cat.name + ': row ' + (p.ri + 1) + ' of ' + rows.length + ', column ' + (p.ci + 1) + ' of ' + p.row.cols.length + stackTxt(p.col.stack, p.k);
}

// ---------- events: the view ----------
function setEdit(on) {
  // (a cell, a grip or a Storage row still held, not moved yet: it lets go, and its release does nothing)
  if (drag) { cancelPid = drag.pid; endDrag(true); }
  if (rs) { cancelPid = rs.pid; endHandle(true); }
  editPress = null;
  const entering = on && !app.classList.contains('editing'), leaving = !on && app.classList.contains('editing') && motionMode() !== 'off';
  // (what edit mode adds or takes away, its empty categories and Re-link, glides; leaving, the open drawers slide out
  // instead of vanishing: "leaving" keeps them shown while they go, 11-08)
  const was = (entering || leaving) && motionMode() !== 'off' && !document.hidden ? catRects() : null;
  clearTimeout(app._lvT); app.classList.remove('leaving');
  S.edit = on; app.classList.toggle('editing', on);
  if (leaving) { app.classList.add('leaving'); app._lvT = setTimeout(() => app.classList.remove('leaving'), 320); }
  if (entering) lastvAsk(cellKeys());   // (Re-link shows in edit mode: the 7 days counted from what the host knows now, 11-08)
  // (the strip pops in as you go into edit mode, only then: a CSS animation keyed on the motion setting replayed it
  // whenever a game left the front. 11-02, the motion audit)
  if (entering && motionMode() !== 'off') $('editbar').animate([{ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  $('editBtn').classList.toggle('on', on); $('editBtn').setAttribute('aria-pressed', on);
  preview = null;
  if (!on) { sel = null; selCat = null; endRelink(true); if (rowKeys.length) { rowKeys = []; subscribe(); } }   // (Storage gone: its rows no longer streamed, 11-06)
  syncDrawers();
  hidePrev(); saveState();
  renderView(false); if (was) playFlip(was); renderStorage(); renderInsp(); placeTabInd(true);
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
for (const k of ['L', 'R']) Object.assign(DR[k], { pinned: false, hover: false, t: 0, side: k === 'L' ? 'l' : 'r', placed: false, sliding: null, ghost: false });
// (side: where you put it with its swap button, kept; 11-02, his "a pinned side bar can move left and right, pinning only
// keeps it open". The two never sit on the same side: the settings take the side Storage leaves. The settings, pinned or
// not, open away from what you selected, so they never cover it; only moved by hand (placed) they stay where you put them,
// until unpinned: his 11-02 "I can't see what I select" when the strip had pinned them)
function drawerOpen(k) {
  const d = DR[k]; if (!S.edit) return false;
  if (drag && drag.started) return d.hover;
  if (k === 'R' && dragPt) return true;   // (a fan curve point held: the drawer stays under it)
  const a = document.activeElement, typing = !!a && d.el.contains(a) && a.matches('input:not([type=checkbox]), select, textarea');
  if (d.hover || d.pinned || typing || (dselOpen && d.el.contains(dselOpen.b))) return true;   // (a list of its open)
  return k === 'L' ? !!relinkFor || (!S.L.cats.length && READ.length > 0) : d.byPick && (!!sel || !!selCat);
}
// the settings open on the side away from what you selected (pinned or from their tab: the right). His rule 11-04: the
// window cut in half down the middle; half or more of the cell (or the category) on the left, they open on the right,
// and the other way round. Before, a cell on the right half opened them on the left only if they would have covered it
function selOnRight() {
  const el = sel ? document.querySelector('#view .dc[data-cid="' + sel + '"]') : selCat ? document.querySelector('#view .dcat[data-cat="' + selCat + '"]') : null;
  if (!el) return false;
  const r = el.getBoundingClientRect(), mid = innerWidth / 2;
  const onLeft = r.width > 0 ? Math.max(0, Math.min(r.right, mid) - r.left) / r.width : r.left < mid ? 1 : 0;
  return onLeft < 0.5;
}
// a drawer that changes sides while open slides across to its new one (11-02, his ask: it jumped across, then faded in);
// one that opens or shuts comes from its edge as before
const drawerSide = k => DR[k].el.classList.contains(k === 'L' ? 'right' : 'left');
function slideDrawers(before) {
  if (motionMode() === 'off') return;
  ['L', 'R'].forEach((k, i) => {
    const b = before[i], el = DR[k].el;
    if (!b.open || !el.classList.contains('open') || b.side === drawerSide(k)) return;
    if (DR[k].sliding) DR[k].sliding.cancel();   // (mid-slide: from where it is, 11-06; it jumped back to the edge it was leaving)
    const dx = b.r.left - el.getBoundingClientRect().left;
    if (Math.abs(dx) > 2) {
      const a = el.animate([{ transform: 'translateX(' + dx + 'px)' }, { transform: 'none' }], { duration: motionOn() ? 340 : 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      // (while it slides, a pointer it passes under doesn't count; one still in it as it stops does, as a pointer come in:
      // it stopped under the pointer, or the pointer went in on the way)
      const d = DR[k], end = () => { if (d.sliding !== a) return; d.sliding = null; if (d.ghost && d.el.matches(':hover')) { d.ghost = false; clearTimeout(d.t); d.hover = true; syncDrawers(); } };
      d.sliding = a; a.finished.then(end, end);
    }
  });
}
function syncDrawers() {
  const before = ['L', 'R'].map(k => { const el = DR[k].el, open = el.classList.contains('open'); return { open, side: drawerSide(k), r: open ? el.getBoundingClientRect() : null }; });
  for (const k of ['L', 'R']) {
    const d = DR[k], key = sel || selCat || '';
    if (k === 'R' && key !== d.key) { d.byPick = !!key; d.pickT = Date.now(); }   // a new selection opens them
    const o = drawerOpen(k), was = d.el.classList.contains('open');
    const lOpen = DR.L.el.classList.contains('open') ? DR.L.side : null;   // (Storage open: its side is taken)
    const want = k === 'R' && (lOpen ? lOpen === 'r' : d.placed ? d.side === 'l' : !!key && selOnRight());
    if (k === 'R' && o && (!d.hover || !was || d.placed || (lOpen && (lOpen === 'l') === !!d.left))) d.left = want;   // (and Storage opening on their side, hovered or not, 11-06)   // re-checked whenever it isn't in use (the selection may have moved or grown), as it opens, and when moved by hand
    if (k === 'R') { d.key = key; if (!o) d.left = d.left && was; }
    // (its side changes only while it is out, or as it comes out: moved there first, unseen, it then slides in from that
    // edge; one going or gone keeps its side, so it leaves the way it came. 11-02, the motion audit)
    const cls = k === 'L' ? 'right' : 'left', side = k === 'L' ? d.side === 'r' : !!d.left;
    if (o && d.el.classList.contains(cls) !== side) {
      if (was) d.el.classList.toggle(cls, side);   // (out already: it slides across, slideDrawers)
      else { d.el.style.transition = 'none'; d.el.classList.toggle(cls, side); void d.el.offsetWidth; d.el.style.transition = ''; }
    }
    if (was && !o && d.sliding) { const a = d.sliding; d.sliding = null; a.commitStyles(); a.cancel(); void d.el.offsetWidth; d.el.style.transform = ''; }   // (shut mid-slide: out from where it is, 11-06)
    d.el.classList.toggle('open', o); d.tab.classList.toggle('on', o); $(k === 'L' ? 'ebStore' : 'ebSel').classList.toggle('on', o || (k === 'R' && S.edit && !!(sel || selCat))); $(k === 'L' ? 'ebStore' : 'ebSel').setAttribute('aria-expanded', o);   // (Selected: lit while something is, the settings out or not; 11-06 audit)
    if (d.pin) { d.pin.classList.toggle('on', d.pinned); d.pin.setAttribute('aria-pressed', d.pinned); }   // (Storage has no pin since 2.4.1: its button in the editing strip opens and shuts it, his 11-06)
  }
  slideDrawers(before);
}
for (const k of ['L', 'R']) {
  const d = DR[k];
  const inside = e => !!e.relatedTarget && (d.el.contains(e.relatedTarget) || d.tab.contains(e.relatedTarget) || !!(e.relatedTarget.closest && e.relatedTarget.closest('.dsel-m')));   // (its list's menu hangs from the page)
  // (a drawer sliding across under a pointer at rest is not the pointer going into it: 11-03, the settings passed under it
  // on their way to the other side and went away once past, as if the pointer had been in them and left. Its leave goes too)
  const enter = e => { if (d.sliding && e.currentTarget === d.el) { d.ghost = true; return; } d.ghost = false; clearTimeout(d.t); if (!d.hover) d.t = setTimeout(() => { d.hover = true; syncDrawers(); }, d.el.classList.contains('open') ? 0 : 90); };
  const leave = e => { if (inside(e)) return; if (d.ghost) { d.ghost = false; return; } clearTimeout(d.t); d.t = setTimeout(() => { d.hover = false; syncDrawers(); }, drag && drag.started ? 0 : 380); };   // (the settings stay out while something is selected, left or not: his 11-06 "remove the auto hide ... fully")
  for (const el of [d.el, d.tab]) { el.addEventListener('mouseenter', enter); el.addEventListener('mouseleave', leave); }
  d.tab.addEventListener('click', () => { d.pinned = true; d.hover = true; syncDrawers(); saveState(); });
  if (d.pin) d.pin.addEventListener('click', () => { d.pinned = !d.pinned; if (!d.pinned) d.placed = false; syncDrawers(); saveState(); unhover(d.pin); });   // (unpinned: back to opening away from the selection)
  // (to the other side: Storage there already, or the settings pinned there, trade places with it, both sliding across)
  $('swap' + k).addEventListener('click', () => {
    const o = DR[k === 'L' ? 'R' : 'L'], cur = k === 'R' ? (d.el.classList.contains('left') ? 'l' : 'r') : d.side, to = cur === 'l' ? 'r' : 'l';   // (the settings: the side they show on)
    d.side = to; if (o.side === to) o.side = to === 'l' ? 'r' : 'l';
    d.placed = true; d.pinned = true;   // (moved by hand: it stays where it was put, and out; Storage too, 11-06)
    syncDrawers(); saveState();   // (it slides across: syncDrawers)
  });
  d.el.addEventListener('focusin', syncDrawers);
  d.el.addEventListener('focusout', () => setTimeout(syncDrawers, 0));
}
$('undo').onclick = $('undoE').onclick = undo; $('redo').onclick = $('redoE').onclick = redo;
// (a click on a title bar or editing strip button leaves no focus on it, so a later Space or Enter doesn't press it
// again, the popup it opened included; Tab never walks the buttons anyway, his 11-02 call. 11-06)
$('titlebar').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
$('editDone').onclick = () => setEdit(false);
// (the editing strip opens and shuts the drawers, 11-02: the side tabs were easy to miss; open: pinned until shut)
for (const [b, k] of [['ebStore', 'L'], ['ebSel', 'R']]) $(b).onclick = () => { const d = DR[k]; d.pinned = !d.el.classList.contains('open'); d.hover = false; if (!d.pinned) { d.byPick = false; d.placed = false; } if (k === 'R' && !d.pinned && (sel || selCat)) clearSel(); syncDrawers(); saveState(); unhover($(b)); };   // (Selected switched off: nothing stays selected, his 11-06)
// (a toggle just switched off under the pointer drops its hover look until the pointer leaves: lit by the hover it looked
// still on, his 11-06 "when i toggle off ... it doesn't look" unselected)
function unhover(b) { if (!b || b.classList.contains('on')) return; b.classList.add('unhov'); b.addEventListener('mouseleave', () => b.classList.remove('unhov'), { once: true }); }
$('toastUndo').onclick = () => { if (nudge) flushNudge(); if (toastDepth >= 0 && undoSeq === toastDepth) undo(); $('toast').classList.remove('show'); retireToastUndo(); };   // (a nudge still to land is newer: the Undo is stale then)
// the clean view: a cell opens when a press that started on it is let go, by the cell it was, not by the element (a
// redraw between press and release, as when a fresh window settles, made the browser drop the click)
let press = null, openedByUp = 0, draggedUp = 0;
// editing: a cell or a category's header pressed (a typed size or name applies at the press, and its redraw can replace
// it before the release: the browser then drops the click, so the release selects it)
let editPress = null;
// a click in a popup, then a second press right there within a double-click's time with the popup gone: that press
// (and its click, double-click) does nothing to what was under the popup
let popClick = null, popEat = -1e9;
document.addEventListener('click', e => {
  if (e.detail > 1 && performance.now() - popEat < 700) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  const m = e.target.closest && (e.target.closest('.modal') || e.target.closest('#toastUndo'));   // (the toast's Undo goes with its press too)
  if (m) popClick = { at: performance.now(), x: e.clientX, y: e.clientY, m };
  else if (!(popClick && popClick.bd)) popClick = null;   // (a backdrop press's own click lands outside: it keeps the guard)
}, true);
document.addEventListener('pointerdown', e => {
  const p = popClick; popClick = null;
  if (p && e.pointerType === 'mouse' && performance.now() - p.at <= 500 && Math.abs(e.clientX - p.x) <= 6 && Math.abs(e.clientY - p.y) <= 6 &&
      !(e.target.closest && e.target.closest('.modal.open') === p.m)) { popEat = performance.now(); e.preventDefault(); e.stopImmediatePropagation(); return; }
  // (a press on a popup's backdrop closes it: its second press is caught the same way)
  if (e.target.classList && e.target.classList.contains('modal') && e.target.classList.contains('open')) popClick = { at: performance.now(), x: e.clientX, y: e.clientY, m: e.target, bd: true };
}, true);
document.addEventListener('dblclick', e => { if (performance.now() - popEat < 700) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
sectionsEl.addEventListener('pointerdown', ev => {
  if (!ev.isPrimary) return;   // (a second finger while one drags or presses)
  press = null; editPress = null;
  if (ev.button !== 0 || ev.target.closest('button,input') || (host && zoneAt(ev))) return;   // the window edge: a resize
  hidePrev();
  if (!S.edit) { const c = ev.target.closest('#view .dc'); if (c && !inCtl(ev.target)) press = { cid: c.dataset.cid, x: ev.clientX, y: ev.clientY }; return; }
  const hd = ev.target.closest('.ldiv, .lrs, .corner');
  if (hd) {
    // (a field with something typed in it: it applies first, its change redraws, so this press starts nothing and the
    // next one drags; a field that only has the focus lets go and the drag starts at once)
    const a = document.activeElement;
    if (a && a._typed && a.matches && a.matches('#insp input[data-sz], #insp input[data-csz], #insp input[data-cw], #lName')) { blurInsp(); ev.preventDefault(); return; }
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
  if (ev.target.closest('.ren') && catEl) { renameCat(catEl); return; }
  if (ev.target.closest('.del') && catEl) {
    if (ev.detail > 1) return;   // (a double-click's second press lands on the next category's x, moved up into its place)
    const c = S.L.cats.find(x => x.id === catEl.dataset.cat);
    mutate(() => { for (const id of c.cells) delete S.L.cells[id]; S.L.cats = S.L.cats.filter(x => x !== c); fixSel(); }, 'Removed "' + c.name + '"');
    return;
  }
  if (ev.target.closest('.rl')) { startRelink(ev.target.closest('.dc').dataset.cid); return; }
  if (ev.target.closest('.ldiv, .lrs, .corner')) return;
  const cell = ev.target.closest('#view .dc');
  if (!S.edit) { if (cell && !inCtl(ev.target) && performance.now() - openedByUp > 500 && performance.now() - draggedUp > 500) openDetail(cell.dataset.cid); return; }   // (already open from the release, or a drag)
  if (cell) { selectCell(cell.dataset.cid); return; }
  // a category's header (its name, its empty space) selects the category; anywhere else: the view
  if (catEl && ev.target.closest('.dch, .ghdr, .bh') && !ev.target.closest('input')) { selectCat(catEl.dataset.cat); return; }
  if (ev.target.closest('.cn-in')) return;   // (a click in a category's rename box: it is being named, nothing else)
  if (sel || selCat) clearSel();
});
function selectCell(cid) {
  if (relinkFor && relinkFor !== cid) endRelink();   // (the pick was for another cell: Link re-linked it and jumped back to it, 11-08 audit)
  nmOnly = null;
  sel = cid; selCat = null; DR.R.byPick = true; DR.R.pickT = Date.now();
  for (const el of document.querySelectorAll('#view .dc.sel, #view .dcat.csel')) el.classList.remove('sel', 'csel');
  const el = document.querySelector('#view .dc[data-cid="' + cid + '"]'); if (el) el.classList.add('sel');
  if (S.L.cells[cid]) live.textContent = nameIn(cid) + ' selected';   // (11-06)
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
  const inp = document.createElement('input'); inp.className = 'cn-in'; inp.maxLength = NAME_MAX; inp.value = c.name; inp.setAttribute('aria-label', 'Category name');
  cn.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  // quiet: the view is being rebuilt anyway (a catalog arrived mid-rename), so no render of its own
  const commit = (keep, quiet) => {
    if (done) return; done = true;
    const v = inp.value.trim().slice(0, 200);
    if (keep && v && v !== c.name) { if (quiet) { snap(); c.name = v; saveState(); syncUndo(); syncSaves(); } else mutate(() => { c.name = v; }); }
    else if (!quiet) renderView(false);
    if (!quiet && inp.matches(':focus-within, :focus') === false && document.activeElement === document.body) focusCat(c.id);   // (Enter or Escape: the focus back on its header, 11-06)
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
sectionsEl.addEventListener('scroll', () => { hidePrev(); if (!scrollT) scrollT = requestAnimationFrame(() => { scrollT = 0; if (drag && drag.started) { if (drag.px != null) hitTest(drag.px, drag.py); } else updateView(false, true); }); });   // (a drag: the target under the pointer again, 11-06; a drop went where the mark was before the scroll)

// ---------- events: Storage ----------
$('vlist').addEventListener('scroll', () => requestAnimationFrame(() => drawRows()));   // (no argument: the frame's time read as a scroll read, 11-06)
let qSayT = 0;
$('q').addEventListener('input', e => { query = e.target.value; $('vlist').scrollTop = 0; renderStorage(); clearTimeout(qSayT); qSayT = setTimeout(() => { live.textContent = plural(rows.filter(x => !x.g).length, 'reading'); }, 600); });   // (said once typing stops, 11-06)
$('chips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; typeFilter = b.dataset.t; $('vlist').scrollTop = 0; storGlide = {}; renderStorage(); });
$('hideIn').addEventListener('click', () => { hideIn = !hideIn; $('hideIn').classList.toggle('on', hideIn); $('hideIn').setAttribute('aria-pressed', hideIn); renderStorage(); });
$('vspace').addEventListener('click', e => {
  if (e.detail > 1 && e.target.closest('[data-act], .addall')) return;   // (a double-click's second press: the next row moved up under it)
  if (e.target.closest('#qClear')) { query = ''; $('q').value = ''; typeFilter = 'all'; hideIn = false; $('hideIn').classList.remove('on'); $('hideIn').setAttribute('aria-pressed', false); renderStorage(); return; }   // (and what's in the view: it alone can empty the list, 11-06)
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
      if (!keys.length) { toast('Everything there is already in the view'); return; }
      addKeys(keys, null, null, SENS[s].short + (typeFilter !== 'all' ? ' ' + TYPE_NAME[typeFilter].toLowerCase() : ''));
      return;
    }
    if (collapsedGroups.has(sk)) collapsedGroups.delete(sk); else collapsedGroups.add(sk);
    storGlide = { gs: s }; renderStorage(); return;
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
    mutate(() => { S.L.cells[cid].key = r.key; S.L.cells[cid].match = matchOf(r); S.L.cells[cid].u = r.unit; if (isYN(r)) ynFixLines(S.L.cells[cid].gates); }, 'Re-linked');
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
// a control in the settings found again after a redraw: by its id, its size field, its list or button by group
// ---------- a list to pick from, in the All Games menu's look (his 11-06 "the dropdowns in select are not using the correct
// dropdown, it should look like the dropdown in all games"): the <select> stays, hidden, with its handlers; a button shows
// its pick and opens the menu; a pick sets it and sends its change ----------
function dselClose(refocus) {
  const d = dselOpen; if (!d) return; dselOpen = null;
  d.m.remove(); d.b.classList.remove('on'); d.b.setAttribute('aria-expanded', 'false');
  if (refocus && d.b.isConnected) d.b.focus({ preventScroll: true });
  // (the pointer left the drawer through the menu, which hangs from the page: the drawer's leave never came, 11-06)
  const dr = ['L', 'R'].map(k => DR[k]).find(x => x.el.contains(d.b));
  if (dr && dr.hover && !dr.el.matches(':hover')) { clearTimeout(dr.t); dr.t = setTimeout(() => { dr.hover = false; syncDrawers(); }, 380); }
  inspCatFlush();   // (new readings came while it was open, 11-08 audit)
}
// (an option's text, and its colours as small squares when it has them: data-sq, the palettes', 11-09)
const dselLab = o => { const q = o && o.dataset.sq ? o.dataset.sq.split(',').filter(c => /^#[0-9a-f]{6}$/i.test(c)) : []; return q.length ? '<span class="dsel-t">' + esc(o.textContent) + '</span><span class="lk-sq">' + q.map(c => '<i style="--c:' + c + '"></i>').join('') + '</span>' : esc(o ? o.textContent : ''); };
function dselUp(box) {
  if (dselOpen && !dselOpen.b.isConnected) dselClose(false);
  for (const s of box.querySelectorAll('select:not(.dsel-n)')) {
    s.classList.add('dsel-n'); s.tabIndex = -1;
    const b = document.createElement('button'), o = s.options[s.selectedIndex];
    b.type = 'button'; b.className = 'dsel'; b.id = (s.id || 'ds-' + (s.dataset.lay || 'list')) + 'Dd';   // (an id: a redraw puts the focus back on it)
    const lb = s.closest('label'), ls = lb && lb.querySelector(':scope > span');   // (its field's name, for a screen reader: the hidden list had it)
    b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false'); if (ls) b.setAttribute('aria-label', ls.textContent + ', ' + (o ? o.textContent : '')); else if (s.getAttribute('aria-label')) b.setAttribute('aria-label', s.getAttribute('aria-label') + ', ' + (o ? o.textContent : ''));   // (a list named by its own label, 11-09)
    b.innerHTML = '<span>' + dselLab(o) + '</span>' + '<svg class="gx-chev" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>';
    if (s.title) b.title = s.title;
    b.disabled = s.disabled; b._sel = s; s.after(b);
  }
}
function dselShow(b) {
  const s = b._sel; if (!s || !s.isConnected || b.disabled) return;
  const same = dselOpen && dselOpen.b === b; dselClose(false); if (same) return;
  const m = document.createElement('div'); m.className = 'smenu dsel-m'; m.setAttribute('role', 'listbox');
  const it = o => '<button type="button" role="option" aria-selected="' + (o.index === s.selectedIndex) + '" data-n="' + o.index + '"' + (o.index === s.selectedIndex ? ' class="on"' : '') + (o.disabled ? ' disabled' : '') + '>' + dselLab(o) + '</button>';
  m.innerHTML = [...s.children].map(c => c.tagName === 'OPTGROUP' ? '<div class="dsel-g" role="presentation">' + esc(c.label) + '</div>' + [...c.children].map(it).join('') : it(c)).join('');   // (groups under their name, 11-09)
  document.body.appendChild(m);
  const r = b.getBoundingClientRect(), below = innerHeight - r.bottom - 10, above = r.top - 10, up = m.offsetHeight > below && above > below;
  m.style.maxHeight = Math.max(120, Math.min(330, up ? above : below)) + 'px';
  m.style.minWidth = r.width + 'px';
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (up ? r.top - 4 - m.offsetHeight : r.bottom + 4) + 'px';
  b.classList.add('on'); b.setAttribute('aria-expanded', 'true'); dselOpen = { s, b, m };
  const on = m.querySelector('.on') || m.querySelector('button:not(:disabled)'); if (on) { on.scrollIntoView({ block: 'nearest' }); on.focus({ preventScroll: true }); }
}
function dselPick(n) {
  const d = dselOpen; if (!d) return;
  const { s, b } = d; dselClose(true);
  if (n === s.selectedIndex || !s.options[n] || s.options[n].disabled) return;
  s.selectedIndex = n; b.firstChild.innerHTML = dselLab(s.options[n]);
  s._ptr = true; s.dispatchEvent(new Event('change', { bubbles: true }));   // (picked with the pointer: as a list's, see ptrPick)
}
document.addEventListener('click', e => {
  const t = e.target.closest ? e.target : e.target.parentElement; if (!t) return;
  const mb = t.closest('.dsel-m button'); if (mb) { dselPick(Number(mb.dataset.n)); return; }
  const b = t.closest('.dsel'); if (b) { e.preventDefault(); dselShow(b); }
});
document.addEventListener('pointerdown', e => { const d = dselOpen; if (d && !d.m.contains(e.target) && !d.b.contains(e.target)) dselClose(false); }, true);
document.addEventListener('keydown', e => {
  const d = dselOpen;
  if (!d) { if (/^Arrow(Down|Up)$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.classList && e.target.classList.contains('dsel')) { e.preventDefault(); dselShow(e.target); } return; }
  const items = [...d.m.querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); dselClose(true); }
  else if (e.key === 'Tab') dselClose(true);
  else if (/^Arrow(Down|Up)$|^Home$|^End$/.test(e.key)) {
    e.preventDefault(); e.stopImmediatePropagation();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (items[j]) { items[j].focus({ preventScroll: true }); items[j].scrollIntoView({ block: 'nearest' }); }
  }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); if (i >= 0) dselPick(Number(items[i].dataset.n)); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey) {   // (every other key is the menu's while it is open: a letter goes to the first option it starts)
    e.preventDefault(); e.stopImmediatePropagation();
    const ch = e.key.length === 1 ? e.key.toLowerCase() : ''; if (!ch) return;
    const order = items.slice(i + 1).concat(items.slice(0, i + 1)), hit = order.find(x => x.textContent.trim().toLowerCase().startsWith(ch));
    if (hit) { hit.focus({ preventScroll: true }); hit.scrollIntoView({ block: 'nearest' }); }
  }
}, true);
addEventListener('resize', () => dselClose(false));
document.addEventListener('scroll', e => { if (dselOpen && !dselOpen.m.contains(e.target)) dselClose(false); }, true);
// Tab and Shift+Tab: the next or last field in the settings (not their buttons: his 11-02 call); the one left applies first
function tabField(ev) {
  const f = ev.target; if (!f || !f.matches || !f.matches('#insp input:not([type=checkbox]):not([type=radio]), #insp textarea, #setbody input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])')) return;
  const box = f.closest('#setbody') || insp;   // (Settings' fields too, 11-06)
  const all = [...box.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea')].filter(x => !x.disabled && x.offsetParent);
  const n = all[all.indexOf(f) + (ev.shiftKey ? -1 : 1)]; if (!n) return;
  // (within the curve table: straight there, so the table doesn't sort its points under the next value, 11-06)
  if (f.closest('#cTab') && n.closest('#cTab')) { n.focus({ preventScroll: false }); if (n.select) n.select(); return; }
  const q = ctlSel(n, box); f.blur();
  setTimeout(() => { const m = (q && box.querySelector(q)) || (n.isConnected ? n : null); if (m) { m.focus({ preventScroll: false }); if (m.select) m.select(); } }, 0);
}
function ctlSel(a, box) {
  const grp = a.parentElement && a.parentElement.closest('[id], [data-lay]'), gq = grp && box.contains(grp) ? (grp.id ? '#' + CSS.escape(grp.id) : '[data-lay="' + CSS.escape(grp.dataset.lay) + '"]') : null;
  const q = a.id ? '#' + CSS.escape(a.id) : a.dataset.sz ? '[data-sz="' + a.dataset.sz + '"]' : a.dataset.cw ? 'input[data-cw]' : a.dataset.csz ? '[data-csz="' + a.dataset.csz + '"]' :
    a.dataset.lay ? a.tagName.toLowerCase() + '[data-lay="' + CSS.escape(a.dataset.lay) + '"]' + (a.dataset.v != null ? '[data-v="' + CSS.escape(a.dataset.v) + '"]' : '') :
    a.tagName === 'BUTTON' && a.dataset.v != null && gq ? gq + ' button[data-v="' + CSS.escape(a.dataset.v) + '"]' :
    a.dataset.i != null && a.dataset.j != null ? '#cTab input[data-i="' + CSS.escape(a.dataset.i) + '"][data-j="' + CSS.escape(a.dataset.j) + '"]' :   // (a fan curve point's field)
    a.dataset.del != null ? '[data-del="' + CSS.escape(a.dataset.del) + '"]' : null;   // (a list or a button with no id: by its group)
  return q;
}
function inspFocus(box) {
  const a = document.activeElement;
  if (!a || !box.contains(a)) return () => {};
  const q = ctlSel(a, box);
  return () => {
    let e = q && box.querySelector(q);
    if (e && e.disabled) e = [...(e.closest('.btnrow, .seg, .fld') || box).querySelectorAll('button:not(:disabled), input:not(:disabled)')][0] || $('inspClose');   // (Own row, Reset, Level: off once done, 11-06 audit)
    if (!e && q) e = (q.startsWith('[data-del') ? [...box.querySelectorAll('[data-del]')].pop() : null) || $('inspClose');   // (gone: a curve point removed, Remove cell; 11-06)
    if (e && e !== document.activeElement) e.focus({ preventScroll: true });
  };
}
// the panel's title: the item's own name (his pick 11-06: "RAM STICK 2", not "Cell"), what it is said first to a screen
// reader; a name cut short whole in its tip
function inspTitle(kind, name) {
  const t = $('inspTitle'), k = kind + '|' + name;
  if (t._k !== k) { t._k = k; t.innerHTML = (kind ? '<span class="sr">' + kind + ', </span>' : '') + esc(name); }
  t.title = t.scrollWidth > t.clientWidth + 1 ? name : '';
}
function renderInsp() {
  inspCatLater = false;
  const box = $('insp'), refocus = inspFocus(box);
  const c = sel && S.L.cells[sel], cat = !c && selCat ? catById(selCat) : null, wasOpen = DR.R.el.classList.contains('open');
  syncDrawers();
  inspTitle(c ? 'Cell' : cat ? 'Category' : '', c ? nameIn(sel) : cat ? cat.name : S.screen === 'overview' ? 'Overview' : VNAME[S.screen]);
  $('inspBack').classList.toggle('none', !c && !cat);
  if (!S.edit) return;
  // (another cell, category or the view: the new content fades in over the old, as a Game cell's flip; its own redraws
  // stay instant. Its segments' picks are pills that slide, as Settings', 11-08)
  const sk = sel || selCat || '', sw = segSnap(box);
  if (box._sk !== undefined && box._sk !== sk && wasOpen && motionMode() !== 'off') box.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: motionOn() ? 200 : 150, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  box._sk = sk;
  if (cat) { box.innerHTML = catPanel(cat); dselUp(box); segPills(box, sw); refocus(); return; }
  if (!c) { box.innerHTML = viewPanel(); dselUp(box); segPills(box, sw); refocus(); return; }
  const r = c.key ? BYKEY.get(c.key) : null, sen = r ? SENS[r.s] : null;
  const g = c.gates || { mode: 'none', dir: 'above', y: NaN, r: NaN, hold: 3 };
  const unit = c.pred ? 'RPM' : unitOf(r), lk = c.pred ? 1 : gbK(r);
  const num = x => (x == null || !isFinite(x)) ? '' : x, numL = x => (x == null || !isFinite(x)) ? '' : Math.round(x * lk * 1e4) / 1e4;   // (lines in GB for memory)
  let h = '<div class="src">' + (c.pred ? '<span>Predicted fan: no sensor, its rpm comes from the curve below.</span>'
    : r ? '<span>' + esc(sen.name) + '</span><span style="color:var(--fg)" title="' + esc(r.key) + '">' + esc(r.label) + '</span>'
    : '<span style="color:' + (isPause(c) ? 'var(--dim)' : '#e08a8d') + '">' + (isPause(c) ? 'HWiNFO isn\'t sharing this reading right now' : sensorHere(c) ? (neverHere(c) ? 'HWiNFO has never shared this reading on this PC' : 'HWiNFO hasn\'t shared this reading for 7 days') : 'Not on this PC' + (c.match ? ': ' + esc(c.match.replace('|', ', ')) : '')) + '</span><span class="k">' + esc(c.key) + '</span>') + '</div>';
  // its name: one field, for every view or for this one only (his pick 11-06: was a "Different name in" link)
  const cl = cellLook(sel), V = VNAME[S.screen], vnm = cl.name != null || (!!nmOnly && nmOnly.cid === sel && nmOnly.vn === S.screen);
  const own = VIEWS.filter(v => v !== S.screen && cellLook(sel, v).name != null);   // (other views with a name of their own: said under the field, 11-08 audit)
  h += '<div class="fld"><span>Name</span>' + (vnm ? '<input id="lvName" aria-label="Name in ' + V + '" maxlength="' + NAME_MAX + '" value="' + esc(cl.name || '') + '" placeholder="' + esc(cellName(c)) + '">'
    : '<input id="iName" aria-label="Name" maxlength="' + NAME_MAX + '" value="' + esc(c.name || '') + '" placeholder="' + esc(r ? r.label : c.pred ? 'Predicted fan' : '') + '">') +
    chipsH('nscope', [['all', 'All views'], ['one', 'Only ' + V]], x => x === 'one' ? vnm : !vnm && !own.length, '', 'Name for') + '</div>' +
    (own.length ? '<span class="hint">' + own.map(v => esc(VNAME[v] + ': ' + cellLook(sel, v).name)).join(', ') + '</span>' : '');
  h += cellLayHtml(sel, c);
  // decimals and the graph as chips (were lists); the bottleneck is a call, not a number: no decimals, no lines
  const bn = isBneck(c);
  h += '<div class="fgrp"><span class="lab">Display</span>' + (bn ? '' : segL('Decimals', 'dec', [['', 'Auto'], [0, '0'], [1, '1'], [2, '2'], [3, '3']], c.dec == null ? '' : c.dec, 'qs')) +
    segL(bn ? '15 min bar' : 'Graph', 'graph', [[1, 'Show'], [0, 'Hide']], c.graph === false ? 0 : 1) + '</div>';
  if (!c.pred && !bn) {
    h += '<div class="fgrp"><span class="lab">Lines</span><div class="seg pills" id="iMode" role="group" aria-label="Lines">' + [['none', 'None'], ['y', 'Yellow'], ['yr', 'Yellow + Red']].map(([v, t]) => '<button data-v="' + v + '" class="' + (g.mode === v ? 'on' : '') + '" aria-pressed="' + (g.mode === v) + '">' + t + '</button>').join('') + '</div>';
    if (g.mode !== 'none') {
      h += '<div class="seg pills" id="iDir" role="group" aria-label="Bad when">' + [['above', 'Bad when above'], ['below', 'Bad when below']].map(([v, t]) => '<button data-v="' + v + '" class="' + (g.dir === v ? 'on' : '') + '" aria-pressed="' + (g.dir === v) + '">' + t + '</button>').join('') + '</div>';
      const o = g.other && typeof g.other === 'object' ? g.other : null, osd = g.dir === 'below' ? 'above' : 'below', side = (d, t) => o ? (d === 'below' ? 'Low: ' + t.toLowerCase() : 'High: ' + t.toLowerCase()) : t;
      h += '<div class="two"><label class="fld gate-y"><span>' + side(g.dir, 'Yellow') + ' ' + esc(unit) + '</span><input id="iY" aria-describedby="gErr" type="number" step="any" value="' + numL(g.y) + '"></label>' +
           (g.mode === 'yr' ? '<label class="fld gate-r"><span>' + side(g.dir, 'Red') + ' ' + esc(unit) + '</span><input id="iR" aria-describedby="gErr" type="number" step="any" value="' + numL(g.r) + '"></label>' : '<span></span>') + '</div>';
      h += '<div class="err" id="gErr"></div><div class="scale" id="gScale"></div>';
      // hold, fade and the other side folded under one line (his pick 11-06); open while the other side or a fade is set
      const more = moreOpen.has(sel) ? moreOpen.get(sel) : !!o || Number.isFinite(g.fade);
      h += '<button class="more' + (more ? ' open' : '') + '" id="iMore" aria-expanded="' + more + '"' + (more ? ' aria-controls="iMoreBox"' : '') + '><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3"/></svg>Hold, fade, also bad when ' + osd + '</button>';
      if (more) {
        h += '<div class="morebox" id="iMoreBox"><label class="chk"><input type="checkbox" id="iOther"' + (o ? ' checked' : '') + '> Also bad when ' + osd + '</label>';
        if (o) h += '<div class="two"><label class="fld gate-y"><span>' + side(osd, 'Yellow') + ' ' + esc(unit) + '</span><input id="iOY" aria-describedby="gErr" type="number" step="any" placeholder="none" value="' + numL(o.y) + '"></label>' +
          '<label class="fld gate-r"><span>' + side(osd, 'Red') + ' ' + esc(unit) + '</span><input id="iOR" aria-describedby="gErr" type="number" step="any" placeholder="none" value="' + numL(o.r) + '"></label></div>';
        h += '<label class="fld"><span>Hold before it changes colour, in seconds</span><input id="iHold" type="number" min="0" step="1" value="' + num(g.hold) + '"></label>';
        h += '<label class="fld"><span>Fade in before a line ' + esc(unit) + '</span><input id="iFade" type="number" min="0" step="any" placeholder="auto" value="' + (Number.isFinite(g.fade) ? numL(g.fade) : '') + '"></label></div>';
      }
    } else if (r) {
      const pre = presetFor(r), pins = c.key === 'hwdeck.0/12v';
      if (pre || pins) h += '<span class="hint">' + (pins ? 'Only its pins\' balance turns it yellow.' + (pre ? ' ' : '') : '') + (pre ? 'Suggestion: <button class="linkbtn" id="iPreset">' + esc(pre.txt) + '</button>' : '') + '</span>';
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
      if (!cv.src) temps.unshift({ key: '', label: 'Pick a temperature', s: -1 });   // (none yet: every real one is a change, 11-06)
      const optTxt = x => x.label + (SENS[x.s] ? ' on ' + SENS[x.s].short : ''), cur = temps.find(x => x.key === cv.src);
      h += '<label class="fld"><span>Driven by</span><select id="iSrc" title="' + esc(cur ? optTxt(cur) : '') + '">' + temps.map(x => '<option value="' + esc(x.key) + '"' + (x.key === cv.src ? ' selected' : '') + '>' + esc(optTxt(x)) + '</option>').join('') + '</select></label>';
      h += '<div id="cChart"></div>';
      h += '<div class="ptab" id="cTab"><span class="h">Temp ' + tu + '</span><span class="h">RPM</span><span></span>' +
        cv.pts.map((p, i) => '<input type="number" step="any" data-i="' + i + '" data-j="0" value="' + p[0] + '" aria-label="Point ' + (i + 1) + ', temp ' + tu + '"><input type="number" step="any" data-i="' + i + '" data-j="1" value="' + p[1] + '" aria-label="Point ' + (i + 1) + ', RPM"><button class="ib" data-del="' + i + '" title="Remove point" aria-label="Remove point ' + (i + 1) + '">' + ICONS.x + '</button>').join('') + '</div>';
      h += '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><button class="linkbtn" id="cAdd">+ Add point</button><button class="linkbtn" id="cPaste">Paste points</button></div>';
      h += '<div id="cPasteBox" hidden><label class="fld"><span>Points as temp:rpm, Enter to apply</span><input id="cPasteIn" placeholder="40:500, 55:800, 65:1200"></label></div>';
      if (!c.pred) {
        const warn = cv.warn !== false;
        h += '<label class="chk"><input type="checkbox" id="cWarn"' + (warn ? ' checked' : '') + '> Warn when it is off the curve</label>';
        h += '<div class="two"><label class="fld"><span>Tolerance &plusmn;%</span><input id="cTol" type="number" min="1" step="1" value="' + cv.tol + '"></label>' +
          (warn ? '<label class="fld"><span>Hold, in seconds</span><input id="cHold" type="number" min="0" step="1" value="' + cv.hold + '"></label>' : '') + '</div>';
        h += '<span class="hint" id="cHint">' + (warn ? 'Tolerance: how far from the curve still counts as on it. Hold: how long it has to stay off before it warns, since a fan takes a few seconds to catch up with the temperature.'
          : 'Off the curve, it only shows how far off it is: it never turns yellow, goes in the warning history or counts as a session warning. Tolerance: how far from the curve still counts as on it.') + '</span>';
      }
      h += '<div class="cstat" id="cStat"></div>';
    }
    h += '</div>';
  }
  h += '<div class="fgrp"><div class="btnrow">' + (isMissing(c) && !isPause(c) ? '<button class="btn" id="iRelink">Re-link</button>' : '') +
    '<button class="btn" id="iOpen">Open graphs</button><button class="btn warn" id="iRemove" aria-keyshortcuts="Delete">Remove cell<span class="kb" aria-hidden="true">Del</span></button></div></div>';
  box.innerHTML = h;
  dselUp(box); segPills(box, sw); refocus();
  tickInsp();
}
// new lines start a little past where the value is now, on its bad side, at the cell's decimals (nothing without a value)
// Yes/No lines saved by 1.5.2 or older sat where a Yes/No reading never gets (2, 3; -1 below): moved onto its values
function ynFixLines(g) {
  if (!g || g.mode === 'none') return false;
  const up = g.dir !== 'below', off = x => Number.isFinite(x) && (up ? x > 1 : x < 0), oy = off(g.y), or = off(g.r);
  if (!oy && !or) return false;
  if (g.mode === 'yr') { g.y = 0.5; g.r = up ? 1 : 0; } else { if (oy) g.y = up ? 1 : 0; if (or) delete g.r; }   // (a Yellow cell's kept red: gone, seeded again with Yellow + Red)
  return true;
}
function ynFixAll() { let n = 0; for (const id in S.L.cells) { const c = S.L.cells[id], r = c.key ? BYKEY.get(c.key) : null; if (r && isYN(r) && ynFixLines(c.gates)) n++; } return n > 0; }
function seedLines(c, r, again) {
  const g = c.gates, gk = gbK(r), v = r && r.v != null ? r.v * gk : null;   // (in what the cell shows: GB for memory)
  if (v == null || g.mode === 'none' || (isFanR(r) && v <= 0)) return;   // nothing to go on (a fan standing still): the fields stay empty
  if (isYN(r)) {   // (a Yes/No reading is 0 or 1: a line past where it is now could never be reached)
    const up = g.dir !== 'below';
    if (g.mode === 'yr') {   // (two lines on two values: yellow halfway, red on the bad value; it goes red, never yellow)
      if (again || !Number.isFinite(g.y) || (up ? g.y >= 1 : g.y <= 0)) g.y = 0.5;
      if (again || !Number.isFinite(g.r) || gatesBad(g) || (up ? g.r > 1 : g.r < 0)) g.r = up ? 1 : 0;
    } else if (again || !Number.isFinite(g.y)) g.y = up ? 1 : 0;
    return;
  }
  const sy = again || !Number.isFinite(g.y), sr = g.mode === 'yr' && (again || !Number.isFinite(g.r));   // (what this seeds; typed lines stay)
  const dec = decOfCell(c, r), step = Math.pow(10, -dec);
  const past = (x, k) => (+(x + (g.dir === 'below' ? -1 : 1) * Math.max(Math.abs(x) * k, step)).toFixed(dec)) || 0;   // (|| 0: never -0)
  if (again || !Number.isFinite(g.y)) g.y = past(v, g.dir === 'below' ? 0.2 : 0.15) / gk;
  if (g.mode === 'yr' && (again || !Number.isFinite(g.r))) g.r = past(g.y * gk, g.dir === 'below' ? 0.3 : 0.12) / gk;
  if (r.unit === '%' && g.dir !== 'below' && v <= 100) {   // (a share that doesn't pass 100: seeded lines past it would never warn)
    if (sy && g.y > 99) g.y = g.mode === 'yr' ? 95 : 99;
    if (sr && g.r > 100 && g.y < 100) g.r = 100;
  }
  if (g.dir === 'below' && v >= 0) {   // (a reading at or over zero: a line under zero would never warn: left to be typed)
    if (sy && g.y < 0) g.y = NaN;
    if (sr && !(g.r >= 0)) g.r = NaN;
  }
}
function presetFor(r) {
  const sn = SENS[r.s] ? SENS[r.s].name : '';
  if (r.key === CONN) return { txt: 'yellow 9.2, red 9.5 A, bad when above', g: Object.assign({}, CONN_LINES) };
  if (r.t === 'temp' && /distance to tj ?max/i.test(r.label)) {   // (how far under the throttle point: lower is worse)
    const f = r && isF(r.unit) ? 9 / 5 : 1, y = Math.round(10 * f), red = Math.round(5 * f);
    return { txt: 'yellow ' + y + ', red ' + red + ', bad when below', g: { mode: 'yr', dir: 'below', y, r: red, hold: 3 } };
  }
  if (r.t === 'temp') {
    const gpu = /GPU/i.test(sn + r.label), y = cToU(gpu ? 80 : 85, r), red = cToU(gpu ? 90 : 95, r);
    return { txt: 'yellow ' + y + ', red ' + red + ', bad when above', g: { mode: 'yr', dir: 'above', y, r: red, hold: 3 } };
  }
  if (r.unit === 'FPS') return { txt: 'yellow 60, red 30, bad when below while a game is in front', g: { mode: 'yr', dir: 'below', y: 60, r: 30, hold: 2 } };
  if (r.unit === '%') return { txt: 'yellow 95, bad when above', g: { mode: 'y', dir: 'above', y: 95, r: NaN, hold: 10 } };
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
      og && !oset ? 'Set a yellow or red value for when it is too ' + (osd === 'below' ? 'low' : 'high') + '.' : oset && !otherOf(g) ? 'When it is ' + (osd === 'below' ? 'low' : 'high') + ', its lines have to be ' + (osd === 'below' ? 'under ' : 'over ') + lnTxt(g.y * gbK(c.key ? BYKEY.get(c.key) : null), decOfCell(c, c.key ? BYKEY.get(c.key) : null), c.key ? BYKEY.get(c.key) : null, g.dir === 'below') + (Number.isFinite(og.y) && Number.isFinite(og.r) ? ', with red ' + (osd === 'below' ? 'under' : 'over') + ' yellow' : '') + '.' : '';
    { const bad = $('gErr').textContent, oth = /when it is|too (low|high)/.test(bad); for (const id of ['iY', 'iR', 'iOY', 'iOR']) { const f = $(id); if (f) f.setAttribute('aria-invalid', !!bad && (id.startsWith('iO') ? oth : !oth)); } }   // (11-06)
    const s = c.key ? series(c.key, HLEN).filter(isFinite) : [];
    if (e.v != null) s.push(e.v);
    let mn = s.length ? Math.min(...s) : 0, mx = s.length ? Math.max(...s) : 1;
    const og2 = otherOf(g), marks = [g.y, g.mode === 'yr' ? g.r : NaN, og2 && og2.y !== undefined ? og2.y : NaN, og2 && og2.r !== undefined ? og2.r : NaN].filter(Number.isFinite);
    for (const x of marks) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
    const pad = (mx - mn || 1) * 0.15; mn -= pad; mx += pad;
    // (the range held while the series and the lines still fit in it, and it isn't over twice too wide: the bar and the
    // ticks stay put while the marker glides, 11-08; they jumped under it every whole percent)
    { const hk = sel + '|' + marks.join(); if (sc._hk === hk && sc._mn <= mn + pad && sc._mx >= mx - pad && sc._mx - sc._mn <= (mx - mn) * 2) { mn = sc._mn; mx = sc._mx; } else { sc._hk = hk; sc._mn = mn; sc._mx = mx; } }
    const P = x => Math.max(0, Math.min(100, (x - mn) / (mx - mn) * 100));
    // the scale in zones: normal, yellow, red, by where each stretch of it is by the lines (both sides)
    const cuts = [mn, ...marks.filter(x => x > mn && x < mx).sort((x, y) => x - y), mx], zc = ['#1f2a22', '#4d4317', '#4a1e21'];
    const bar = cuts.slice(1).map((z, i) => '<i style="width:' + Math.max(0, P(z) - P(cuts[i])) + '%;background:' + zc[gateLevel(g, (cuts[i] + z) / 2).raw] + '"></i>').join('');
    const r = c.key ? BYKEY.get(c.key) : null, dec = decOfCell(c, r);
    // (the bar and the marks drawn again only when they move by a whole percent; the "now" marker glides on its own layer,
    // 2.1: it was a new element every second, so it jumped)
    const R1 = x => Math.round(P(x));
    const stat = '<div class="bar">' + bar.replace(/width:([\d.]+)%/g, (m, w) => 'width:' + Math.round(+w) + '%') + '</div>' + (e.v != null ? '<div class="mkw"><span class="mk"></span><span class="tk now" style="left:0;top:-12px;color:var(--fg)"></span></div>' : '') +
      marks.map(x => '<span class="tk" style="left:' + R1(x) + '%">' + (isYN(r) ? lnTxt(x, dec, r, (x === g.y || (g.mode === 'yr' && x === g.r)) === (g.dir === 'below')) : fmtV(x, dec, r)) + '</span>').join('');
    const k = sel + '|' + stat;
    if (sc._k !== k) { const ow = sc.querySelector('.mkw'), ot = ow && ow.style.transform; sc._k = k; sc.innerHTML = stat; const nw = sc.querySelector('.mkw'); if (nw && ot) { nw.style.transform = ot; void nw.offsetWidth; } }   // (from where it was: it jumped on a rebuild, 11-06)
    const mw = sc.querySelector('.mkw');
    if (mw && e.v != null) { mw.style.transform = 'translateX(' + P(e.v).toFixed(2) + '%)'; setText(mw.querySelector('.tk.now'), 'now ' + fmtV(e.v, dec, r)); }
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
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" id="cSvg" role="img" aria-label="Fan curve">';
  for (let x = xmin; x <= xmax; x += xstep) s += '<line x1="' + X(x) + '" x2="' + X(x) + '" y1="' + t + '" y2="' + (H - b) + '" stroke="' + gv('#202020') + '"/><text x="' + X(x) + '" y="' + (H - 7) + '" fill="#6a6a6a" font-size="9" text-anchor="middle">' + x + '\u00b0</text>';
  for (let v = 0; v <= ymax + 1e-9; v += ax.step) s += '<line x1="' + l + '" x2="' + (W - rr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="' + gv('#202020') + '"/><text x="' + (l - 4) + '" y="' + (Y(v) + 3) + '" fill="#6a6a6a" font-size="9" text-anchor="end">' + kLabel(v) + '</text>';
  // past its first and last points a fan keeps their speed: dashed to the edges
  const p0 = pts[0], pn = pts[pts.length - 1];
  if (pts.length) s += '<path d="M' + l + ' ' + Y(p0[1]) + ' L' + X(p0[0]) + ' ' + Y(p0[1]) + ' M' + X(pn[0]) + ' ' + Y(pn[1]) + ' L' + (W - rr) + ' ' + Y(pn[1]) + '" fill="none" style="stroke: var(--edit)" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.6"/>';
  s += '<polyline points="' + pts.map(p => X(p[0]) + ',' + Y(p[1])).join(' ') + '" fill="none" style="stroke: var(--edit)" stroke-width="1.6"/>';
  const src = BYKEY.get(c.curve.src);
  // where the fan is now goes under the points, so a point on top of it can still be dragged
  if (src && src.v != null && e.v != null) {
    const off = e.curve && Math.abs(e.curve.dev) > c.curve.tol && c.curve.warn !== false;
    s += '<g pointer-events="none"><line x1="' + X(src.v) + '" x2="' + X(src.v) + '" y1="' + t + '" y2="' + (H - b) + '" stroke="' + gv('#3a3a3a') + '" stroke-dasharray="2 3"/><circle cx="' + X(src.v) + '" cy="' + Y(e.v) + '" r="4.5" fill="' + (off ? '#e6c84a' : '#e0e0e0') + '" stroke="' + gv('#0f0f0f') + '" stroke-width="1.5"/></g>';   // (a dark ring: it shows on a white curve too, 11-09)
  }
  c.curve.pts.forEach((p, i) => { s += '<circle class="pt" data-i="' + i + '" cx="' + X(p[0]) + '" cy="' + Y(p[1]) + '" r="5" fill="' + gv('#0f0f0f') + '" style="stroke: var(--edit)" stroke-width="1.6"/>'; });
  const sv = s + '</svg>'; if (box._h !== sv) { box._h = sv; box.innerHTML = sv; }   // (only when it changed: every second before, 11-06)
  box._scale = { l, t, W, H, b, rr, xmin, xmax, ymax, top };
}
const insp = $('insp');
// back: a cell's settings to its category's, a category's to the view's (his 11-06 "a back button to roam around")
$('inspBack').onclick = () => { const c = sel && catOf(sel); if (c) { selectCat(c.id); unhover($('inspBack')); } else if (selCat) { DR.R.pinned = true; clearSel(); } };   // (the view's settings it led to stay out, 11-06)
$('inspClose').onclick = () => { const d = DR.R; clearTimeout(d.t); d.hover = false; d.pinned = false; d.byPick = false; clearSel(); saveState(); };
function setCell(fn, withUndo) {
  const c = S.L.cells[sel]; if (!c) return;
  if (withUndo) nudgeQuiet();
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
  if (!editSnap && t.id !== 'cPasteIn' && t.type !== 'checkbox' && t.tagName !== 'SELECT' && !(t.dataset && (t.dataset.sz || t.dataset.lay))) { nudgeQuiet(); snap(); syncUndo(); editSnap = true; }
  else if (t.dataset && t.dataset.sz) nudgeQuiet();   // (a size takes its own step on change, from the nudged size: no redraw under the typing)
  if (t.id === 'iName') {
    setCell(c => { c.name = t.value.trim() || undefined; }); inspTitle('Cell', nameIn(sel));
    const el = document.querySelector('#view .dc[data-cid="' + sel + '"] .tn > span, #view .dc[data-cid="' + sel + '"] .nm > span, #view .dc[data-cid="' + sel + '"] .gname > span');
    if (el) { el.textContent = nameIn(sel); nameFitSoon(); }   // (fitted again, as the Only <view> field's, 11-08 audit)
  }
  const lk = c.pred ? 1 : gbK(BYKEY.get(c.key));   // (memory lines are typed in GB, kept in MB)
  if (t.id === 'iOY' || t.id === 'iOR') { setCell(c => { const o = c.gates.other || (c.gates.other = {}), k = t.id === 'iOY' ? 'y' : 'r'; if (t.value === '' || !isFinite(Number(t.value))) delete o[k]; else o[k] = Number(t.value) / lk; }); tickInsp(); updateView(false, true); }
  if (t.id === 'iFade') { setCell(c => { if (t.value === '' || !isFinite(Number(t.value))) delete c.gates.fade; else c.gates.fade = Math.max(0, Number(t.value) / lk); }); tickInsp(); updateView(false, true); }
  if (t.id === 'iY' || t.id === 'iR' || t.id === 'iHold') { setCell(c => { const k = t.id === 'iY' ? 'y' : t.id === 'iR' ? 'r' : 'hold'; c.gates[k] = t.value === '' && k !== 'hold' ? NaN : k === 'hold' ? Math.min(1e9, Math.max(0, Number(t.value) || 0)) : Number(t.value) / lk; }); tickInsp(); updateView(false, true); }
  if (t.id === 'cTol' || t.id === 'cHold') { if (t.value === '') return; setCell(c => { c.curve[t.id === 'cTol' ? 'tol' : 'hold'] = Math.max(t.id === 'cTol' ? 1 : 0, Number(t.value) || 0); }); tickInsp(); updateView(false, true); }
  if (t.dataset && t.dataset.i != null && t.closest('#cTab') && t.value !== '') { setCell(c => { c.curve.pts[Number(t.dataset.i)][Number(t.dataset.j)] = Number(t.value); }); tickInsp(); updateView(false, true); }
});
insp.addEventListener('change', e => {
  const t = e.target, c = S.L.cells[sel]; if (!c) return;
  if (t.id === 'cTol' || t.id === 'cHold') t.value = c.curve[t.id === 'cTol' ? 'tol' : 'hold'];   // what it keeps, not what was typed
  if (t.id === 'iHold' && c.gates && isFinite(c.gates.hold)) t.value = c.gates.hold;
  if (t.id === 'iSrc' && t.value) { setCell(c => { c.curve.src = t.value; }, true); subscribe(); renderInsp(); updateView(false, true); }
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
  if (pts.length >= 2) { setCell(c => { c.curve.pts = pts.sort(ptOrd); }, true); renderInsp(); updateView(false, true); toast(plural(pts.length, 'point') + ' set' + (items.length > pts.length ? ', ' + (items.length - pts.length) + ' skipped, write them as temp:rpm' : '')); }
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
      const g = c.gates, o = g.other && typeof g.other === 'object' ? g.other : null; g.dir = d.dataset.v;
      // (lines on the other side too: the two sides trade places, 11-06; the other side's were read the wrong way and
      // stopped warning)
      if (o) { const w = { y: g.y, r: g.r }; g.y = Number.isFinite(o.y) ? o.y : NaN; g.r = Number.isFinite(o.r) ? o.r : NaN; g.other = {}; if (Number.isFinite(w.y)) g.other.y = w.y; if (Number.isFinite(w.r)) g.other.r = w.r; if (!otherOf(g)) delete g.other; }
      // lines that are now on the wrong side (picked for "above" before the direction) move to the new side
      const r = BYKEY.get(c.key), v = r ? r.v : null;
      if (v != null && (gatesBad(g) || (Number.isFinite(g.y) && (g.dir === 'below' ? v <= g.y : v >= g.y)))) seedLines(c, r, true);
    }, true);
    renderInsp(); updateView(false, true);
  }
  if (e.target.closest('#iMore')) {   // (in place: its chevron turns, the box grows in or folds away, 11-08: it popped)
    const b = $('iMore'), open = b.getAttribute('aria-expanded') !== 'true', mb = $('iMoreBox'); moreOpen.set(sel, open);
    if (motionMode() === 'off') { renderInsp(); return; }
    if (!open) { b.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); b.removeAttribute('aria-controls'); if (mb) { mb.inert = true; for (const x of [mb, ...mb.querySelectorAll('[id]')]) x.removeAttribute('id'); sumFold(mb, false); } return; }
    renderInsp(); const nb = $('iMore'), nbox = $('iMoreBox');
    if (nb) { nb.classList.remove('open'); void nb.offsetWidth; nb.classList.add('open'); }
    if (nbox) sumFold(nbox, true);
    return;
  }
  if (e.target.closest('#iPreset')) { const p = presetFor(BYKEY.get(c.key)); setCell(c => { c.gates = Object.assign({}, p.g); }, true); renderInsp(); updateView(false, true); }
  if (e.target.closest('#iRemove') && e.detail < 2) { inspGoneAt = performance.now(); const c = catOf(sel); removeCell(sel); if (c && !sel && S.L.cats.includes(c)) selectCat(c.id); }
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
  if (del && c.curve.pts.length > 2 && e.detail < 2) { inspGoneAt = performance.now(); setCell(c => { c.curve.pts.splice(Number(del.dataset.del), 1); }, true); renderInsp(); updateView(false, true); }
});
insp.addEventListener('pointerdown', e => { const pt = e.target.closest('.pt'); if (!pt || !e.isPrimary || dragPt) return; blurInsp(); nudgeQuiet(); dragPt = { i: Number(pt.dataset.i), moved: false, pid: e.pointerId, x0: e.clientX }; e.preventDefault(); });
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
  tickInsp();
  if (!dragPt.vt) dragPt.vt = setTimeout(() => { if (dragPt) { dragPt.vt = 0; updateView(false, true); } }, 120);   // (the view at most every 120 ms under the drag, 11-06; the release draws it)
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
// a row of chips: one button each, the one in effect lit (and pressed, for a screen reader); lit(v) says which
const chipsH = (key, opts, lit, cls, label) => '<div class="seg' + (cls ? ' ' + cls : '') + (key === 'cf' || /\b(qs|qt|tog)\b/.test(cls || '') ? '' : ' pills') + '" data-lay="' + key + '" role="group"' + (label ? ' aria-label="' + esc(label) + '"' : '') + '>' +
  opts.map(([v, t, off]) => { const on = !!lit(v); return '<button data-v="' + v + '"' + (off ? ' disabled' : '') + ' class="' + (on ? 'on' : '') + '" aria-pressed="' + on + '">' + t + '</button>'; }).join('') + '</div>';
const segL = (label, key, opts, cur, cls) => '<div class="fld"><span>' + label + '</span>' + chipsH(key, opts, v => String(v) === String(cur), cls, label) + '</div>';
const TPLS = [['two', '2 a row', '1fr 1fr', '1fr 1fr 1fr', ['1/1', '1/2', '2/1', '2/2', '3/1/4/3']], ['three', '3 a row', '1fr 1fr 1fr', '1fr 1fr', ['1/1', '1/2', '1/3', '2/1/3/4']],
  ['one', '1 a row', '1fr', '1fr 1fr 1fr', ['1/1', '2/1', '3/1']], ['copy', 'Copy', '1fr 1fr 1fr', '1fr 0.6fr 1fr', ['1/1', '1/2', '1/3', '2/1/3/4', '3/1', '3/2', '3/3']]];
const LOOKS = [['', 'Card', [[6, 8, 40, 38], [52, 14, 42, 26], [6, 58, 88, 12], [6, 78, 88, 12]]], ['small', 'Small card', [[6, 8, 30, 24], [42, 12, 52, 16], [6, 42, 88, 12], [6, 62, 88, 12], [6, 82, 88, 12]]],
  ['list', 'List', [[6, 8, 88, 14], [6, 30, 88, 14], [6, 52, 88, 14], [6, 74, 88, 14]]], ['band', 'Band', [[4, 20, 14, 60], [22, 20, 16, 60], [41, 20, 16, 60], [60, 20, 16, 60], [79, 20, 16, 60]]]];
const LOOK_HINT = { '': 'Card: its first reading large with a graph, the rest as rows.', small: 'Small card: a card with a smaller big reading.', list: 'List: every reading as a row, none large.',
  band: 'Band: the name on the left and every reading side by side in one strip, each with a small graph. Best on a row of its own.' };
const otherView = vn => vn === 'tiles' ? 'overview' : 'tiles';
function outlineHtml(rows, vn) {
  const fa = vn === 'tiles' && fillAll('tiles');   // (a row that fills: marked, his pick 11-06)
  return '<div class="outline" role="group" aria-label="Outline">' + rows.map(r => '<div class="orow' + (vn === 'tiles' && (fa || r.h) ? ' fill' : '') + '" style="grid-template-columns:' + r.cols.map(c => (c.w || 1) + 'fr').join(' ') + '">' +
    r.cols.map(c => '<div class="ocol">' + stackLines(c.stack).map(ln => (ln.length > 1 ? '<div class="oline">' : '') + ln.map(s => { const id = sid(s), cat = catById(id); return '<button class="obox' + (id === selCat ? ' on' : '') + '"' + (id === selCat ? ' aria-current="true"' : '') + ' data-ocat="' + esc(id) + '" title="' + esc(cat ? cat.name : '') + '">' + esc(cat ? cat.name : '') + '</button>'; }).join('') + (ln.length > 1 ? '</div>' : '')).join('') + '</div>').join('') + '</div>').join('') + '</div>';
}
function viewPanel() {
  const vn = S.screen, v = stored(vn), own = !!(v && v.rows), cells = Object.values(S.L.cells);
  if (!READ.length && !S.L.cats.length) return '<div class="none"><span>Nothing to pick from yet: HWiNFO isn\'t sharing its sensors. The steps are in the middle.</span></div>';
  let h = '';
  if (S.L.cats.length) {
    // (Grid: how many tables, Auto following the window; one control for its Arrangement and Tables, his pick 11-06)
    if (vn === 'grid') {
      const n = own ? v.rows[0].cols.length : document.querySelectorAll('#view .gtable').length;
      h += segL('Tables', 'tables', [['auto', 'Auto']].concat([[1, '1'], [2, '2'], [3, '3']].slice(0, Math.max(1, n, Math.min(3, S.L.cats.length)))), own ? n : 'auto');   // (no more tables than categories)
    } else h += segL('Arrangement', 'arr', [['auto', 'Automatic'], ['own', 'Your own']], own ? 'own' : 'auto');
    h += '<span class="hint">' + (!own ? 'Follows the window.' : vn === 'grid' ? 'Drag a category onto a table edge.' : 'Drag a category by its handle.') + '</span>';
    h += '<div class="fgrp"><span class="lab">Outline</span>' + outlineHtml(own ? v.rows : rowsNow(vn), vn) + '</div>';
    if (vn !== 'grid') {
      const ov = otherView(vn), canCopy = !!(stored(ov) && stored(ov).rows);
      h += '<div class="fgrp"><span class="lab">Start from</span><div class="tpls">' + TPLS.map(([k, t, gc, gr, areas]) => '<button class="tpl" data-tpl="' + k + '"' + (k === 'copy' && !canCopy ? ' disabled title="' + VNAME[ov] + ' is automatic"' : '') + '>' +
        '<span class="pic" aria-hidden="true" style="grid-template-columns:' + gc + ';grid-template-rows:' + gr + '">' + areas.map(a => '<i style="grid-area:' + a + '"></i>').join('') + '</span>' + (k === 'copy' ? 'Copy ' + VNAME[ov] : t) + '</button>').join('') + '</div></div>';
      const hv = v && v.fill ? 'fill' : own && v.rows.some(r => r.h) ? 'some' : 'fit';   // (some rows fill, set in their categories: neither lit, the outline marks them)
      h += '<div class="fgrp">' + (vn === 'tiles' ? segL('Height', 'fill', [['fit', 'Fit'], ['fill', 'Fill']], hv) : '') + segL('Spacing', 'gap', [['tight', 'Tight'], ['', 'Normal'], ['roomy', 'Roomy']], v && v.gap || '') + '</div>';
    }
  }
  // (what is in it, one line; the help, the tip and Back to automatic went, his pick 11-06: Automatic is at the top)
  const nb = (n, one, many) => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
  h += '<div class="fgrp"><span class="foot">' + nb(S.L.cats.length, 'category', 'categories') + ', ' + nb(cells.length, 'cell', 'cells') + ', ' + cells.filter(x => gatesOn(x.gates)).length + ' with lines, ' + cells.filter(x => x.curve).length + ' on a curve</span>' +
    (S.L.cats.length ? '' : '<span class="hint">Pick a type in Storage, then <b>+ all</b> on a sensor.</span>') + '</div>';
  return h;
}
// a tile of the category with a size or a new row of yours in Tiles (what Reset its look in Tiles also takes back)
const TILE_KEYS = ['f', 'fx', 'w', 'h', 'size', 'nl'];
const tileSet = id => { const t = stored('tiles'), e = t && t.cell && t.cell[id]; return !!e && TILE_KEYS.some(k => e[k] !== undefined); };
// a category's look on every category of the view (his pick 11-06, mockup A): its style and title in Overview, its
// tiles' style and title in Tiles; not what is shown first, sizes or widths. One step, one Undo. Off when every
// category already looks like it
const LOOK_ALL = { tiles: ['size', 'title'], overview: ['style', 'title'] };
const lookAllSame = (vn, id) => { const ks = LOOK_ALL[vn], a = catLook(id, vn); return S.L.cats.every(c => ks.every(k => (catLook(c.id, vn)[k] || '') === (a[k] || ''))); };
const lookAllBtn = (vn, id) => LOOK_ALL[vn] ? '<div class="btnrow lkall"><button class="btn" data-lay="lookall"' + (lookAllSame(vn, id) ? ' disabled' : '') + '>Apply this look to all</button></div>' : '';
function catPanel(cat) {
  const vn = S.screen, V = VNAME[vn], lk = catLook(cat.id), ids = cellsOf(cat);
  const leadOpts = '<option value="">' + (ids.length ? 'The first one, ' + esc(nameIn(ids[0])) : 'The first one') + '</option>' +
    ids.slice(1).map(id => '<option value="' + esc(id) + '"' + (lk.lead === id ? ' selected' : '') + '>' + esc(nameIn(id)) + '</option>').join('');
  let h = '<label class="fld"><span>Name</span><input id="lName" maxlength="' + NAME_MAX + '" value="' + esc(cat.name) + '"></label><div class="fgrp"><span class="sub">In ' + V + '</span>';
  if (vn !== 'grid') {
    const v = stored(vn), rows = rowsNow(vn), p = posIn(rows, cat.id), alone = !p || p.row.cols.length < 2;
    if (p) h += '<span class="row3">Row ' + (p.ri + 1) + ' of ' + rows.length + (alone ? ', alone' : ', column ' + (p.ci + 1) + ' of ' + p.row.cols.length) + stackTxt(p.col.stack, p.k) + '</span>';
    // its column's width: a % field and % chips (his pick 11-06: were 1/4, 1/3...); the chips that can't fit are off
    const mine = !alone && p.row.cols.every(c => c.w), b = mine ? p.row.cols.map(c => c.w) : [1];
    const blk = document.querySelector('#view .dcat[data-cat="' + CSS.escape(cat.id) + '"]'), col = blk && blk.closest('.lcol'), row = col && col.closest('.lrow');
    const folded = !alone && !!row && row.classList.contains('fold') && (!mine || foldStuck(p.ri)), cs = row ? [...row.children].filter(e => e.classList.contains('lcol')) : [], cw = cs.reduce((a, c) => a + c.getBoundingClientRect().width, 0);   // (folded: one under the other, each the row's whole width, 11-08 audit 0203)
    const tw = alone ? '' : mine ? (folded ? '' : Math.round(b[p.ci] / b.reduce((x, y) => x + y, 0) * 1200) / 100) : 'auto';
    const mt = alone || folded ? null : minTwelfths(p.ri), ok = !!mt && mt.length === p.row.cols.length, lo = ok ? mt[p.ci] : 1, hi = ok ? 12 - mt.reduce((a, x, i) => i === p.ci ? a : a + x, 0) : alone ? 12 : 12 - (p.row.cols.length - 1);   // (only widths that leave every column at its narrowest, 11-08 audit 0202)
    const pct = alone || folded ? 100 : mine ? Math.round(b[p.ci] / b.reduce((x, y) => x + y, 0) * 1000) / 10 : col && cw ? Math.round(col.getBoundingClientRect().width / cw * 1000) / 10 : '';   // (an Auto row: its columns without the gaps, two equal ones 50, 11-08 audit 0206)
    h += '<div class="fld"><span>Column width</span><div class="szin"><label class="spin"><input type="number" data-cw="1" data-lo="' + lo + '" data-hi="' + hi + '" aria-label="Column width, %" value="' + pct + '" step="' + 100 / 12 + '" min="' + 100 / 12 + '" max="100"' + (alone || folded ? ' disabled' : '') + '><i>%</i>' + SPIN_UD + '</label></div>' +
      chipsH('width', [['auto', 'Auto'], [3, '25%'], [4, '33%'], [6, '50%'], [8, '67%'], [9, '75%']].map(([x, t]) => [x, t, alone || (x === 'auto' ? folded && !mine : folded || x < lo || x > hi)]), x => String(x) === String(tw), 'qs', 'Column width') + '</div>';
    if (vn === 'tiles') h += segL('Its row', 'rowh', [[0, 'Fit'], [1, 'Fill']], (v && v.fill) || (v && v.rows && p && p.row.h) ? 1 : 0);
    // the four moves always there, off where they can't go, each with its key (his pick 11-06: only the possible ones showed)
    const mo = moveOptions(cat.id);
    h += '<div class="fld"><span>Move</span><div class="btnrow mv">' + [['row', 'Own row', 'R'], ['beside', 'Beside above', 'B'], ['stack', 'Stack left', 'S'], ['unstack', 'Unstack', 'U']].map(m =>
      '<button class="btn' + (m[0] === 'beside' && mo.besideOn ? ' on' : '') + '" data-lay="move" data-v="' + m[0] + '" aria-keyshortcuts="' + m[2] + '"' + (m[0] === 'beside' && mo.besideOn ? ' aria-pressed="true"' : '') + (mo[m[0]] ? '' : ' disabled') + '>' + m[1] + '<span class="kb" aria-hidden="true">' + m[2] + '</span></button>').join('') + '</div></div>';
  } else {
    const rows = rowsNow('grid'), p = posIn(rows, cat.id), n = rows.length ? rows[0].cols.length : 1;
    h += segL('Table', 'table', [...Array(Math.min(3, n + 1))].map((_, i) => [i, i < n ? String(i + 1) : 'New table', i >= n && !!p && p.ci === n - 1 && p.col.stack.length === 1]), p ? p.ci : 0);   // (alone in the last table: a new one would be the same)
  }
  h += '</div>';
  if (vn === 'tiles')   // (Shown first went: a cell's own First, his pick 11-06)
    h += '<div class="fgrp"><span class="lab">Its tiles</span><div class="two">' + segL('Style', 'size', [['', 'Normal'], ['short', 'Short']], lk.size || '') + segL('Title', 'title', [['', 'Show'], ['hide', 'Hide']], lk.title || '') + '</div>' + lookAllBtn(vn, cat.id) + catSizeHtml(cat, ids) + '</div>';
  else if (vn === 'overview') {
    const st = lk.style || '';
    h += '<div class="fgrp"><span class="lab">Look in Overview</span><div class="looks" data-lay="style" role="group" aria-label="Look">' + LOOKS.map(([k, t, rects]) => '<button class="look' + (st === k ? ' on' : '') + '" data-v="' + k + '" aria-pressed="' + (st === k) + '"><span class="pic" aria-hidden="true">' +
      rects.map(q => '<i style="left:' + q[0] + '%;top:' + q[1] + '%;width:' + q[2] + '%;height:' + q[3] + '%"></i>').join('') + '</span>' + t + '</button>').join('') + '</div><span class="hint">' + LOOK_HINT[st] + '</span>' +
      '<div class="two">' + segL('Title', 'title', [['', 'Show'], ['hide', 'Hide']], lk.title || '') + '<label class="fld"><span>' + (st === '' || st === 'small' ? 'Big reading' : 'Shown first') + '</span><select data-lay="lead">' + leadOpts + '</select></label></div>' + lookAllBtn(vn, cat.id) + '</div>';
  } else h += '<div class="fgrp"><span class="lab">Look in Grid</span><label class="fld"><span>Listed first</span><select data-lay="lead">' + leadOpts + '</select></label></div>';
  h += '<div class="fgrp"><div class="btnrow"><button class="btn" data-lay="reset"' + (Object.keys(lk).length || (vn === 'tiles' && ids.some(tileSet)) ? '' : ' disabled') + '>Reset ' + V + ' look</button>' +
    '<button class="btn warn" data-lay="remove" aria-keyshortcuts="Delete">Remove category<span class="kb" aria-hidden="true">Del</span></button></div></div>';
  return h;
}
// Tiles: one width or height for every tile of a category (Auto: none set), and Level: its tiles a little taller or
// shorter, so its column ends level with the tallest beside it (his pick 11-06: chips, were two number fields)
function catSizeHtml(cat, ids) {
  if (!ids.length) return '';
  const t = stored('tiles'), le = id => (t && t.cell && t.cell[id]) || {}, zs = ids.map(cellSize), blk = document.querySelector('#view .blk[data-cat="' + CSS.escape(cat.id) + '"]');
  const pc = ids.map(cellPct), fAuto = zs.every(z => !z.f && z.w === 1), fAll = !fAuto && pc.every(x => x != null && Math.abs(x - pc[0]) < 0.5) ? pc[0] : null;   // (Auto as drawn: an old "tall" tile is Auto wide, 11-06 audit; a share as drawn, as each tile's Width says, 11-08 audit)
  const G = blk ? tileGeo(blk.querySelector('.tg.pk > .tile')) : null, awOff = x => !!G && x < 100 - PE && (x / 100 * G.k) * G.p - G.g < G.min - 0.5;   // (a share its tiles can't be drawn at here: greyed, 11-08 audit)
  const hAuto = zs.every(z => Math.abs(z.h - 1) < 0.01), hAll = !hAuto && zs.every(z => Math.abs(z.h - zs[0].h) < 0.01) ? zs[0].h : null;
  return '<div class="fld"><span>Width of all</span>' + chipsH('aw', [['auto', 'Auto']].concat(PCTS.map(x => [r4(x), Math.round(x) + '%', awOff(x)])), x => x === 'auto' ? fAuto : fAll != null && Math.abs(x - fAll) < 0.5, 'qs', 'Width of all') + '</div>' +
    '<div class="fld"><span>Height of all</span><div class="segrow">' + chipsH('ah', [['auto', 'Auto'], [1.5, '1.5'], [2, '2']], x => x === 'auto' ? hAuto : hAll != null && Math.abs(x - hAll) < 0.01, 'qs', 'Height of all') +
    '<button class="btn" data-lay="fitrow"' + (blk && colEnds(blk).cols.length ? '' : ' disabled') + '>Level</button></div></div>';
}
function cellLayHtml(cid, c) {
  const vn = S.screen, V = VNAME[vn], cl = cellLook(cid), cat = catOf(cid), lk = cat ? catLook(cat.id) : {};
  let h = '<div class="fgrp"><span class="sub">In ' + V + '</span>';
  if (vn === 'tiles') {
    // (the share it is drawn at: a row of tiles you haven't sized spreads out to fill its width, three of 25% drawn at a
    // third each, his 11-06 "showing 25% but it should show 33%"; one you size is drawn as you set it. Auto: none set)
    const z = cellSize(cid), pct = cellPct(cid), off = cfOff(cid);
    const num = (k, v, u, lab) => '<label class="spin"><input type="number" data-sz="' + k + '" aria-label="' + lab + '" value="' + v + '" step="any" min="0"><i>' + u + '</i>' + SPIN_UD + '</label>';
    h += '<div class="fld"><span>Width</span><div class="szin">' + num('f', pct == null ? '' : Math.round(pct * 10) / 10, '%', 'Width, %') + '</div>' +
      chipsH('cf', [['auto', 'Auto']].concat(PCTS.map(x => [r4(x), Math.round(x) + '%', off(x)])), x => x === 'auto' ? !z.f && z.w === 1 : !(!z.f && z.w === 1) && pct != null && Math.abs(x - pct) < 0.5, 'qs', 'Width') + '</div>' +
      '<div class="fld"><span>Height</span><div class="szin">' + num('h', r4(z.h), 'x', 'Height') + '</div>' + chipsH('ch', RQ.map(x => [x, String(x)]), x => Math.abs(x - z.h) < 0.01, 'qs', 'Height') + '</div>';
  }
  // First (the category's lead) and New row as two toggles (his pick 11-06: were a box and the category's Shown first)
  if (cat) {
    const first = idsIn(cat)[0] === cid, natural = cellsOf(cat)[0] === cid && !lk.lead, big = vn === 'overview' && lk.style !== 'list' && lk.style !== 'band', nl = !!cl.nl && !first;
    h += '<div class="seg tog" role="group" aria-label="In its category"><button data-lay="lead-me" class="' + (first ? 'on' : '') + '" aria-pressed="' + first + '"' + (first && natural ? ' disabled' : '') + '>' + (big ? 'Big reading' : 'First') + '</button>' +
      (vn === 'tiles' ? '<button data-lay="nl" class="' + (nl ? 'on' : '') + '" aria-pressed="' + nl + '"' + (first ? ' disabled' : '') + '>New row</button>' : '') + '</div>';
  }
  return h + '</div>';
}
function removeCat(id) {
  const c = catById(id); if (!c) return;
  mutate(() => { for (const x of c.cells) delete S.L.cells[x]; S.L.cats = S.L.cats.filter(x => x !== c); fixSel(); }, 'Removed "' + c.name + '"');
}
function applyTemplate(k) {
  preview = null; tplUsed = k;
  const v = templateView(k); if (!v) return;
  layoutChange(() => { const vv = vset(S.screen); if (!vv.rows) froze = true; vv.rows = v.rows; });
}
function layoutAct(key, v) {
  const vn = S.screen, id = selCat;
  if (key === 'arr' && v === 'own') layoutChange(() => ownRows());
  else if ((key === 'arr' && v === 'auto') || key === 'auto' || (key === 'tables' && v === 'auto')) { if (stored(vn) && stored(vn).rows) mutate(() => { delete vset(vn).rows; }, VNAME[vn] + ' is placed automatically again'); }
  else if (key === 'fill') {   // (the view's: an automatic view stays automatic, 11-06)
    const t = stored(vn) || {}, on = v === 'fill', some = (t.rows || []).some(r => r.h);
    if (!some && !!t.fill === on) return;
    mutate(() => { const w = vset(vn); if (on) w.fill = true; else delete w.fill; for (const r of w.rows || []) delete r.h; });
  }
  else if (key === 'gap') mutate(() => { if (v) vset(vn).gap = v; else delete vset(vn).gap; });
  else if (key === 'tables' && stored('grid') && stored('grid').rows && +v === (stored('grid').rows[0] || { cols: [] }).cols.length) return;   // (the count already lit: nothing cut again; from Auto a count makes it yours)
  else if (key === 'tables') layoutChange(() => { const g = vset('grid'); if (!g.rows) { froze = true; g.rows = gridTables(+v); } else g.rows = [{ cols: retable(g.rows[0].cols, +v) }]; });
  else if (key === 'width') setWidth(id, v === 'auto' ? 0 : +v);
  else if (key === 'rowh') setRowHeight(id, +v);
  else if (key === 'move') moveCat(id, v);
  else if (key === 'table') layoutChange(() => {
    const t = +v, p = posIn(rowsNow(vn), id); if (!p || p.ci === t) return;   // (in that table already: an automatic view stays automatic)
    const rows = ownRows();
    vset('grid').rows = placeCat(rows, id, t >= rows[0].cols.length ? { zone: 'right', table: rows[0].cols.length - 1 } : { zone: 'into', table: t });
  });
  else if (key === 'size' || key === 'title' || key === 'style') mutate(() => setLook('cat', id, key, v));
  else if (key === 'lookall') { const ks = LOOK_ALL[vn], a = Object.assign({}, catLook(id, vn)); if (ks && catById(id)) mutate(() => { for (const c of S.L.cats) for (const k of ks) setLook('cat', c.id, k, a[k], vn); }, 'Same look for all categories'); }
  else if (key === 'reset') mutate(() => { const w = vset(vn), cat = catById(id); if (w.cat) delete w.cat[id]; if (vn === 'tiles' && w.cell && cat) for (const c of cellsOf(cat)) { const e = w.cell[c]; if (!e) continue; for (const k of TILE_KEYS) delete e[k]; if (!Object.keys(e).length) delete w.cell[c]; } });
  else if (key === 'remove') removeCat(id);
  else if (key === 'cf' || key === 'ch') { if (nudge) flushNudge(); const z = cellSize(sel); mutate(() => key === 'cf' ? (v === 'auto' ? setSize(sel, 1, z.h) : setShare(sel, +v / 100, z.h)) : z.f ? setShare(sel, z.f, +v, undefined, z.fx) : setSize(sel, z.w, +v)); }   // (Auto: no width of its own)
  else if (key === 'fitrow') fitRow(id);
  else if (key === 'lead-me') { const c = catOf(sel); if (c) mutate(() => setLook('cat', c.id, 'lead', idsIn(c)[0] === sel || cellsOf(c)[0] === sel ? '' : sel)); }   // (on again: off, its first one back)
  else if (key === 'nl') mutate(() => setLook('cell', sel, 'nl', cellLook(sel).nl ? '' : true));
  else if (key === 'nscope') { const has = cellLook(sel).name != null, any = VIEWS.some(vn => cellLook(sel, vn).name != null); if (v === 'one' && !has) { nmOnly = { cid: sel, vn: S.screen }; renderInsp(); const f = $('lvName'); if (f) f.focus(); } else if (v === 'all' && any) { nmOnly = null; mutate(() => { for (const vn of VIEWS) if (cellLook(sel, vn).name != null) setLook('cell', sel, 'name', '', vn); }); } else { if (v === 'all') nmOnly = null; renderInsp(); } }   // (Only: nothing kept until a name is typed; All views: every view's own name goes, 11-08 audit)
  else if (key === 'dec') mutate(() => { const c = S.L.cells[sel]; if (!c) return; if (v === '') delete c.dec; else c.dec = +v; });
  else if (key === 'graph') mutate(() => { const c = S.L.cells[sel]; if (c) c.graph = v === '1'; });
  else if (key === 'aw' || key === 'ah') { const cat = catById(id); if (!cat) return; if (v !== 'auto') catSizeInput(id, key === 'aw' ? 'f' : 'h', +v);
    else mutate(() => { for (const c of cellsOf(cat)) { const z = cellSize(c); if (key === 'aw') setSize(c, 1, z.h); else if (z.f) setShare(c, z.f, 1, undefined, z.fx); else setSize(c, z.w, 1); } }); }
}
// the second press of a double-click on a remove button lands on the panel drawn in its place: it does nothing there
let inspGoneAt = -1e9;
insp.addEventListener('click', e => { if (e.detail > 1 && e.target.closest && e.target.closest('#insp button, #insp .pt') && !e.target.closest('.dsel')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);   // (a redraw may have put another button there)
insp.addEventListener('click', e => { if (e.detail > 1 && performance.now() - inspGoneAt < 700) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
insp.addEventListener('click', e => {
  if (!S.edit) return;
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.tpl) { applyTemplate(b.dataset.tpl); return; }
  if (b.dataset.ocat) { selectCat(b.dataset.ocat); return; }
  const grp = b.closest('[data-lay]'), key = b.dataset.lay || (grp && grp.dataset.lay);
  if (key === 'remove') inspGoneAt = performance.now();
  if (key) layoutAct(key, b.dataset.v);
});
insp.addEventListener('change', e => {
  if (!S.edit) return;
  const t = e.target;
  if (t.dataset && t.dataset.sz && sel) { const id = sel, k = t.dataset.sz, v = parseFloat(t.value); setTimeout(() => sizeInput(id, k, v), 0); return; }
  if (t.dataset && t.dataset.csz && selCat) { const id = selCat, k = t.dataset.csz, v = parseFloat(t.value); setTimeout(() => catSizeInput(id, k, v), 0); return; }
  if (t.dataset && t.dataset.cw && selCat) { const id = selCat, v = parseFloat(t.value); setTimeout(() => { if (!isFinite(v) || v <= 0) { renderInsp(); szFlash('input[data-cw]', NaN); return; } setWidth(id, Math.max(1, Math.round(v * 12 / 100))); renderInsp(); szFlash('input[data-cw]', v); }, 0); return; }   // (its column's width typed, in twelfths of the row)
  if (t.id === 'lvName' && !t.value.trim()) { nmOnly = null; renderInsp(); return; }   // (its name typed away: the panel says All views again)
  if (t.id === 'lName') {
    const cat = selCat && catById(selCat), v = t.value.trim().slice(0, 200);
    if (cat && v && v !== cat.name) mutate(() => { cat.name = v; }); else if (cat) t.value = cat.name;
    return;
  }
  if (!selCat || !t.dataset || !t.dataset.lay) return;
  if (t.dataset.lay === 'per') mutate(() => setLook('cat', selCat, 'per', t.value ? +t.value : ''));
  if (t.dataset.lay === 'lead') mutate(() => setLook('cat', selCat, 'lead', t.value));
});
insp.addEventListener('input', e => {   // a name in this view, as it's typed (the cell's own input listener took the undo step)
  const t = e.target; if (t.id !== 'lvName' || !sel || !S.L.cells[sel]) return;
  setLook('cell', sel, 'name', t.value.trim() ? t.value.slice(0, 200) : '');
  tidyViews(S.L); saveState(); syncSaves(); inspTitle('Cell', nameIn(sel));
  const el = document.querySelector('#view .dc[data-cid="' + sel + '"] .tn > span, #view .dc[data-cid="' + sel + '"] .nm > span, #view .dc[data-cid="' + sel + '"] .gname > span');
  if (el) { el.textContent = nameIn(sel); nameFitSoon(); }
});
insp.addEventListener('keydown', e => { if (e.target.id === 'lName' && e.key === 'Escape') { const cat = catById(selCat); if (cat) e.target.value = cat.name; e.target.blur(); } });
// a template shows itself while the pointer rests on it
let tplT = 0, tplUsed = null;   // (tplUsed: the one just used, not previewed again until the pointer leaves it)
insp.addEventListener('pointerdown', e => { const l = e.target.closest && e.target.closest('select'); if (l) l._ptr = true; }, true);
const listKey = e => e.altKey || /^(Arrow|Page|Home$|End$|Enter$| $|F4$)/.test(e.key || '');   // (what a list takes from the keyboard)
insp.addEventListener('keydown', e => { if (e.target.tagName === 'SELECT' && listKey(e)) e.target._ptr = false; }, true);
insp.addEventListener('focusout', e => { if (e.target.tagName === 'SELECT') e.target._ptr = false; if (inspFitLater) { inspFitLater = false; setTimeout(inspAfterFit, 0); } inspCatFlush(); });   // (reached again later with Tab: a keyboard list)
// a press in the settings while a typed name or size is still to go in: its change redraws the panel under the press
// and the browser drops the click; at the release the same control in the new panel gets it (a field: the focus)
let inspPress = null;
insp.addEventListener('pointerdown', e => {
  inspPress = null;
  const a = document.activeElement;
  if (!e.isPrimary || e.button !== 0 || !((a && a._typed && a.matches && a.matches('#lName, #insp input[data-sz], #insp input[data-csz], #insp input[data-cw]')) || inspFitLater)) return;   // (or a refit's redraw waiting for the field to be left; the main button only)
  const lb = e.target.closest && e.target.closest('label'), t = (e.target.closest && e.target.closest('button, input, select, textarea')) || (lb && lb.control);   // (a checkbox pressed on its words: its box)
  if (!t || t === a || !insp.contains(t)) return;
  const q = ctlSel(t, insp); if (q) inspPress = { el: t, q, x: e.clientX, y: e.clientY };
}, true);
document.addEventListener('pointerup', e => {
  const p = inspPress; inspPress = null;
  if (!p || e.button !== 0 || p.el.isConnected || Math.abs(e.clientX - p.x) > 6 || Math.abs(e.clientY - p.y) > 6) return;   // (still there: its own click comes)
  setTimeout(() => { const n = insp.querySelector(p.q); if (!n || n.disabled) return; if (n.matches('input:not([type=checkbox]):not([type=radio]), select, textarea')) n.focus(); else n.click(); }, 0);
}, true);
let ptrPick = false;   // (read before any handler: a redraw's focusout would clear the list's own flag first)
insp.addEventListener('change', e => { ptrPick = e.target.tagName === 'SELECT' && !!e.target._ptr; }, true);
insp.addEventListener('change', e => {   // (after the handlers above: a redraw may have put a new list in its place)
  const t = e.target; if (t.tagName !== 'SELECT' || !ptrPick) return;
  ptrPick = false; t._ptr = false; const a = document.activeElement; if (a && a.tagName === 'SELECT' && insp.contains(a)) a.blur();
});
insp.addEventListener('mouseover', e => {
  const b = e.target.closest('.tpl'); if (!b || b.disabled || (preview && preview.k === b.dataset.tpl) || (drag && drag.started) || rs || dragPt) return;   // (none under a drag, 11-06)
  if (b.dataset.tpl === tplUsed) { if (!e.relatedTarget || b.contains(e.relatedTarget)) return; tplUsed = null; }   // (the one just used, redrawn under the pointer: not again until it is entered again, 11-06)
  clearTimeout(tplT);
  tplT = setTimeout(() => { if (!b.isConnected || (drag && drag.started) || rs || dragPt) return; const v = templateView(b.dataset.tpl); if (!v) return; preview = { vn: S.screen, view: v, k: b.dataset.tpl }; flipNext = true; renderView(false); }, 180);   // (gliding into it and back, 11-08)
});
insp.addEventListener('mouseout', e => {
  const b = e.target.closest('.tpl'); if (!b || (e.relatedTarget && b.contains(e.relatedTarget))) return;
  clearTimeout(tplT); tplUsed = null;
  // (onto the next template: it takes over from this preview, no stop at the real view between them)
  const nx = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.tpl'); if (nx && !nx.disabled) return;   // (a disabled one has no preview: the view as it is, 11-06)
  if (preview) { preview = null; flipNext = true; renderView(false); }
});

// ---------- selecting: a cell, a category, or nothing (the view) ----------
function selectCat(id) {
  if (relinkFor) endRelink();
  nmOnly = null;
  sel = null; selCat = id; DR.R.byPick = true; DR.R.pickT = Date.now();   // clicking it again brings its settings back
  for (const el of document.querySelectorAll('#view .dc.sel')) el.classList.remove('sel');
  for (const el of document.querySelectorAll('#view .dcat')) el.classList.toggle('csel', el.dataset.cat === id);
  { const c = catById(id); if (c) live.textContent = c.name + ' selected'; }   // (11-06)
  renderInsp();
}
function clearSel() {
  if (relinkFor) endRelink();
  nmOnly = null;
  if (sel || selCat) live.textContent = 'Nothing selected';   // (11-06)
  sel = null; selCat = null;
  for (const el of document.querySelectorAll('#view .dc.sel, #view .dcat.csel')) el.classList.remove('sel', 'csel');
  renderInsp();
}
// repeated layout keys close together are one undo step
let keyStep = { t: 0, n: -1 };
function keyLayout(fn) {
  // (counted in steps taken: the stack's length stops changing at its cap; the same item in the same view, 11-06: a key
  // on another category, or in another view, within 800 ms merged into the step before)
  const who = sel || selCat, vn = S.screen;
  const merge = Date.now() - keyStep.t < 800 && undoSeq === keyStep.n && keyStep.n > 0 && keyStep.who === who && keyStep.vn === vn, n0 = undoSeq;
  fn();
  if (merge && undoSeq === n0 + 1) undoStack.pop();   // (the press's own step: the burst stays one)
  if (undoSeq === n0 && !merge) keyStep.t = 0;   // (a key that changed nothing starts no burst: the next one isn't merged into an earlier change)
  else keyStep = { t: Date.now(), n: undoSeq, who, vn };
  if (merge && undoStack.length && bareStep(undoStack[undoStack.length - 1]) === snapOf()) { undoStack.pop(); keyStep.t = 0; }   // (the burst came back where it started: no step that changes nothing)
  syncUndo();
}
function focusCat(id) { const h = document.querySelector('#view .dcat[data-cat="' + id + '"] .dch'); if (h) h.focus({ preventScroll: false }); }
function swapCats(a, b) { dropCat({ target: { zone: 'swap', cat: b }, data: a, auto: !isCustom(S.screen), rows: rowsNow() }); }

// ---------- a chart's window (range selector B, his design 11-07): the part of its range a chart shows, as fractions a
// to b of it. The chart is the control (the wheel zooms around the pointer, a drag moves it, a double click shows the
// whole range) and so is the bar under it (drag it to move, its ends to resize, a click on the track brings the window
// there). The bar is always shown, the whole width while the window is the whole range (his "dont keep it ALWAYS shown",
// 11-07: never hidden). The cell popup's chart, Sessions' and Warning history's period charts and a session's own chart ----
const p2 = x => ('0' + x).slice(-2), dMon = d => d.getDate() + ' ' + GX_MON[d.getMonth()];
const winTime = (d, ws) => ws >= 2 * 86400000 ? dMon(d) : p2(d.getHours()) + ':' + p2(d.getMinutes());
function mkWin(o) {   // o.min(): the narrowest window (a fraction); o.draw(): what it shows, drawn again
  const W = { a: 0, b: 1, ta: 0, tb: 1, raf: 0, t: 0, o };
  const step = t => {
    W.raf = 0;
    const dt = W.t ? Math.min(64, t - W.t) : 1000 / 60; W.t = t;
    const k = 1 - Math.pow(0.7, dt / 16.7);
    W.a += (W.ta - W.a) * k; W.b += (W.tb - W.b) * k;
    if (Math.abs(W.ta - W.a) + Math.abs(W.tb - W.b) < 2e-4) { W.a = W.ta; W.b = W.tb; } else W.raf = requestAnimationFrame(step);
    o.draw();
  };
  // (kept within the range and at least the narrowest; glide: eased there, as the wheel and a double click do)
  W.set = (a, b, glide) => {
    const w = Math.max(o.min(), Math.min(1, b - a)); a = Math.max(0, Math.min(1 - w, a));
    W.ta = a; W.tb = a + w;
    if (!glide || !motionOn()) { cancelAnimationFrame(W.raf); W.raf = 0; W.a = W.ta; W.b = W.tb; o.draw(); }
    else if (!W.raf) { W.t = 0; W.raf = requestAnimationFrame(step); }
  };
  W.reset = () => { cancelAnimationFrame(W.raf); W.raf = 0; W.a = W.ta = 0; W.b = W.tb = 1; };
  W.whole = () => W.ta <= 1e-6 && W.tb >= 1 - 1e-6;
  // the wheel at fx (0 to 1 across the plot): the moment under the pointer stays under it
  W.wheel = (fx, dy) => { const a = W.ta, w = W.tb - a, at = a + fx * w, w2 = Math.max(o.min(), Math.min(1, w * Math.pow(1.0018, dy))); W.set(at - fx * w2, at - fx * w2 + w2, true); };
  return W;
}
// a drag of a window: the chart (pan: right goes back in time), the bar (bar), one of its ends (l, r). on(true / false):
// as it starts and ends (a pan starts once the pointer has moved 3 px: a click stays a click)
let winDrag = null;
function winGrab(W, kind, x, pw, on) { winDrag = { W, kind, x, a: W.ta, b: W.tb, pw: Math.max(1, pw), moved: kind !== 'pan', on }; if (winDrag.moved && on) on(true); }
document.addEventListener('mousemove', e => {
  const D = winDrag; if (!D) return;
  if (!(e.buttons & 1)) { winDrag = null; if (D.on && D.moved) D.on(false); return; }   // (its mouseup went elsewhere)
  const dx = e.clientX - D.x;
  if (!D.moved) { if (Math.abs(dx) < 3) return; D.moved = true; if (D.on) D.on(true); }
  const f = dx / D.pw, w = D.b - D.a, m = D.W.o.min();
  if (D.kind === 'pan') D.W.set(D.a - f * w, D.b - f * w);
  else if (D.kind === 'bar') D.W.set(D.a + f, D.b + f);
  else if (D.kind === 'l') D.W.set(Math.max(0, Math.min(D.a + f, D.b - m)), D.b);
  else D.W.set(D.a, Math.min(1, Math.max(D.b + f, D.a + m)));
});
document.addEventListener('mouseup', () => { const D = winDrag; if (!D) return; winDrag = null; if (D.on && D.moved) D.on(false); });
// the bar: near an end, that end; on the window, the window; on the track, the window comes there and then drags
function winBarAt(W, bar, e) {
  const r = bar.getBoundingClientRect(), x = e.clientX - r.left, L = W.ta * r.width, R = W.tb * r.width;
  if (R - L < 18) { const m = (L + R) / 2, hw = Math.max((R - L) / 2, 4); return { r, x, kind: Math.abs(x - m) <= hw ? 'bar' : x < m && x >= m - hw - 7 ? 'l' : x > m && x <= m + hw + 7 ? 'r' : null }; }   // (11-07 audit: at the narrowest zoom it could only be resized)
  return { r, x, kind: Math.abs(x - L) <= 7 && x <= (L + R) / 2 ? 'l' : Math.abs(x - R) <= 7 ? 'r' : x > L && x < R ? 'bar' : null };
}
function winBarDown(W, bar, e, on) {
  if (e.button !== 0) return; e.preventDefault();
  const h = winBarAt(W, bar, e);
  if (!h.kind) { const w = W.tb - W.ta, c = h.x / h.r.width; W.set(c - w / 2, c + w / 2, true); h.kind = 'bar'; }
  winGrab(W, h.kind, e.clientX, h.r.width, on);
}
function winBarCursor(W, bar, e) { if (winDrag) return; const k = winBarAt(W, bar, e).kind; bar.style.cursor = k === 'l' || k === 'r' ? 'ew-resize' : k ? 'grab' : 'pointer'; }
// a bar's parts: its window, the start and end beside its ends. t0, t1: the range's (ms); fm(date, window ms); endTxt:
// what its end says while the window ends with the range (now, today)
// (map(f): the moment, in ms, of a fraction of the range, when it isn't even, as a chart in weeks)
function winBarParts(W, t0, t1, fm, endTxt, map) {
  const o = { L: (W.a * 100).toFixed(3), R: ((1 - W.b) * 100).toFixed(3), ls: '', le: '' }, M = map || (f => t0 + (t1 - t0) * f);
  if (t1 > t0) { const ws = M(W.b) - M(W.a); o.ls = fm(new Date(M(W.a)), ws); o.le = endTxt && W.b > 0.999 ? endTxt : fm(new Date(M(W.b) - 1), ws); }
  return o;
}
function winBarDraw(bar, P) {
  const i = bar.firstElementChild, ls = bar.children[1], le = bar.children[2];
  i.style.left = P.L + '%'; i.style.right = P.R + '%'; setText(ls, P.ls); setText(le, P.le);
  ls.style.right = 'calc(' + (100 - P.L) + '% + 10px)'; le.style.left = 'calc(' + (100 - P.R) + '% + 10px)';
}
const winBarHtml = (P, act) => '<span class="mbar in' + (act ? ' act' : '') + '"><i style="left:' + P.L + '%;right:' + P.R + '%"></i><span class="ls" style="right:calc(' + (100 - P.L) + '% + 10px)">' + esc(P.ls) + '</span><span class="le" style="left:calc(' + (100 - P.R) + '% + 10px)">' + esc(P.le) + '</span></span>';
// (a chart in a list that scrolls: the wheel zooms only once the list has stopped, so scrolling past a chart scrolls on)
let winScrolled = 0;
document.addEventListener('scroll', e => { if (e.target !== document && e.target.closest && e.target.closest('#gmodal, #wmodal, #modal')) winScrolled = performance.now(); }, true);
const winWheelOk = () => performance.now() - winScrolled > 450;

// ---------- the cell popup: 15 min live, 1 h to all the host keeps (a year), HWiNFO's own min / max / average ----------
const modal = $('modal'), mrng = $('mrng'), mgraph = $('mgraph'), mgsec = $('mgraphsec'), mbar = $('mbar');
let openedAt = 0, modalCid = null, bigRange = '15m', bigHist = null, histAsked = 0, bigMap = null, bigRev0 = 0, lastBig = null, modalGateInView = false;
const RANGE_S = { '15m': 900, '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400, '7d': 604800, '30d': 2592000, '90d': 7776000 };   // (All: as long as the host has it)
let bigRevMs = 700;   // (the big graph's draw-in: 700 ms as the popup opens, 450 for a range picked in it)
function bigRev() { if (!bigRev0) return 1; const p = (performance.now() - bigRev0) / bigRevMs; return p >= 1 ? 1 : easeOut(Math.max(0, p)); }
let bigRaf = 0;   // (one draw-in loop at a time: each pick started another, 11-06)
function bigLoop() { if (bigRaf) return; bigRaf = requestAnimationFrame(() => { bigRaf = 0; if (!modalCid) return;
  if (lastBig) drawBigGraph.apply(null, lastBig);
  else { const c = cellAt(modalCid), e = c && $('mextra').querySelector('.bnc') ? evalCell(modalCid, c, true, true) : null; if (!e || !e.strip) return; bnPanel($('mextra'), e, false); }   // (the bottleneck's columns draw in too, 11-08)
  if (bigRev() < 1) bigLoop(); else bigRev0 = 0; }); }
// (two groups, hours and days: the one with the range picked shows its pill there, gliding within the group; the
// other's fades; coming from the other group it appears in place)
function placeRng(still) {
  for (const g of mrng.querySelectorAll('.rng')) {
    const b = g.querySelector('button[data-r="' + bigRange + '"]'), ri = g.querySelector('.ri'), was = ri.classList.contains('off');
    ri.classList.toggle('off', !b);
    if (!b) continue;
    ri.classList.toggle('still', !!still || was); pillPut(ri, b);
    if (!still && was) requestAnimationFrame(() => ri.classList.remove('still'));
  }
}
const histKey = c => c.pred ? c.curve.src : c.key;
function askHist() { const c = cellAt(modalCid); if (!c) return; histAsked = Date.now(); send({ t: 'hist', key: histKey(c), range: bigRange }); }
function setRange(r, still) {
  bigRange = r;
  for (const b of mrng.querySelectorAll('button[data-r]')) { b.classList.toggle('on', b.dataset.r === r); b.setAttribute('aria-pressed', b.dataset.r === r); }
  bwReset(); placeRng(still);
  if (r !== '15m' && !ownDayNow()) askHist();   // (a reading's own day: the host keeps none of it, 11-06)
}
// (the range picked again: the whole of it, when zoomed or moved)
mrng.addEventListener('click', e => {
  const b = e.target.closest('button[data-r]'); if (!b) return;
  if (b.dataset.r === bigRange) { if (!BW.whole()) BW.set(0, 1, true); return; }
  pickRange(b.dataset.r);
});
// ---- the popup's window (see mkWin): the stats under the chart are the window's; a new range or a new popup starts whole ----
// (the narrowest: 10 of its points, and a minute)
function bwMin() { const L = lastBig, n = L && L[1] ? L[1].length : 0, sp = L && L[7] ? L[7] : (RANGE_S[bigRange] || 0) * 1000; return Math.min(1, Math.max(n > 1 ? 10 / (n - 1) : 0.02, sp ? 60000 / sp : 0)); }
function bwDraw() { if (modalCid && lastBig) refreshModal(false, true); }   // (light: the chart, its bar and the stats, not the extras, 11-08)
const BW = mkWin({ min: bwMin, draw: bwDraw });
const bwSet = (a, b, glide) => BW.set(a, b, glide), bwReset = () => BW.reset();
// the bar: where the window is, its start and end beside its ends (a date from 2 days on, else the time; now when it ends now)
function bwBar() {
  mbar.hidden = mgraph.hidden || !lastBig;
  if (mbar.hidden) return;
  const span = lastBig[7] || (RANGE_S[bigRange] || 0) * 1000, now = Date.now();
  winBarDraw(mbar, winBarParts(BW, now - span, now, winTime, 'now'));
}
const plotW = () => Math.max(1, mgraph.getBoundingClientRect().width - BIG_PADL - BIG_PADR);
mgraph.addEventListener('wheel', e => {
  if (!lastBig || mgraph.hidden || !winWheelOk()) return;   // (a popup taller than the window, scrolling past its graph: it scrolls on)
  e.preventDefault();
  const r = mgraph.getBoundingClientRect();
  BW.wheel(Math.max(0, Math.min(1, (e.clientX - r.left - BIG_PADL) / plotW())), e.deltaMode ? e.deltaY * 33 : e.deltaY);
}, { passive: false });
mgraph.addEventListener('mousedown', e => { if (e.button !== 0 || !lastBig) return; e.preventDefault(); winGrab(BW, 'pan', e.clientX, plotW(), on => { mgraph.classList.toggle('grab', on); if (on) { HV.on = false; kickHover(); } }); });
mgraph.addEventListener('dblclick', e => { if (!lastBig) return; e.preventDefault(); BW.set(0, 1, true); });
mbar.addEventListener('mousedown', e => { if (lastBig) winBarDown(BW, mbar, e, on => mbar.classList.toggle('act', on)); });
mbar.addEventListener('mousemove', e => winBarCursor(BW, mbar, e));
function pickRange(r) {
  setRange(r, false);
  // (one draw-in for one pick, 11-02 motion audit: now when its data is here, else when the host's answer comes, the line
  // before dimmed meanwhile; it drew in twice, the first time on a plot still waiting)
  const ready = bigRange === '15m' || histReady() || !!ownDayNow();
  bigRevMs = 450; bigRev0 = ready && motionOn() ? performance.now() : 0;
  if (modalCid) { refreshModal(); bigLoop(); }
}
// an extras reading that keeps its own day (a device's minutes on, as its hover draws it; 11-06): 1 h to 24 h come from
// that day, the host keeps no history of it
const OWN_SPAN = { '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400 };
let modalOwn = false;
const ownDay = (xk, e) => xk && e && e.pspan === 86400 && Array.isArray(e.past) && OWN_SPAN[bigRange] ? e.past.slice(-OWN_SPAN[bigRange] / 60) : null;
function ownDayNow() { const c = cellAt(modalCid), r = c && c.key ? BYKEY.get(c.key) : null, xk = xkOf(r); return xk ? ownDay(xk, evalCell(modalCid, c, true, true)) : null; }
const histReady = () => { const c = cellAt(modalCid); return c && bigHist && bigHist.key === histKey(c) && bigHist.range === bigRange; };
function histOf(c) {   // the host's long history for this cell; a predicted fan's goes through its curve
  if (!c.pred) return bigHist;
  const M = histOf.m; if (M && M.h === bigHist && M.p === c.curve.pts) return M.v;   // (kept: a glide asks every frame, 11-08)
  const f = a => a.map(x => x == null ? null : interp(c.curve.pts, x)), v = Object.assign({}, bigHist, { avg: f(bigHist.avg), max: f(bigHist.max) });
  histOf.m = { h: bigHist, p: c.curve.pts, v }; return v;
}
function openDetail(cid, rng) {   // (rng: the range it opens on, 15 min unless said)
  const c = cellAt(cid); if (!c) return;
  hidePrev(true);
  modalCid = cid; paintMc(); modal.classList.add('open'); lastBig = null; openedAt = performance.now();
  const fa = document.activeElement; mOpener = fa && fa !== document.body && !modal.contains(fa) ? fa : null; modal.querySelector('.mcard').focus({ preventScroll: true });   // (into it, and back on close, 11-06)
  const mv = $('mval'); if (mv._n) mv._n._ot = undefined; mv._gm = undefined;
  setRange(rng || '15m', true);
  refreshModal(true);
  bigRevMs = 700; bigRev0 = motionOn() ? performance.now() : 0; bigLoop();
}
let mOpener = null;
function closeDetail() {
  const back = mOpener && mOpener.isConnected ? mOpener : modalCid != null ? document.querySelector('#view .dc[data-cid="' + CSS.escape(String(modalCid)) + '"]') : null; mOpener = null;
  if (back && modal.contains(document.activeElement)) back.focus({ preventScroll: true });
  const t = modalCid != null && !!TCELL[modalCid]; modalCid = null; bigHist = null; modal.classList.remove('open'); pauseSpin(document.querySelector('#micon svg')); if (t) subscribe(); }
function refreshModal(full, light) {   // (light: a window moved, 11-08)
  const c = cellAt(modalCid); if (!c) { closeDetail(); return; }
  const r = c.key ? BYKEY.get(c.key) : null, e = evalCell(modalCid, c, true, true), dec = decOfCell(c, r), unit = c.pred ? 'RPM' : unitOf(r), xk = xkOf(r);
  const mi = $('micon'), ic = iconOf(c, r);
  if (mi._h !== ic) { mi.innerHTML = ic; mi._h = ic; sweepSpins(); }
  if (isFanCell(c)) spinIcon(mi.querySelector('svg'), e.v);
  setText($('mtitle'), nameIn(modalCid));
  const mv = $('mval');
  if (full) mv.style.transition = 'none';   // (its colour fades as the tile's, but not from the last popup's, 11-08)
  mv.style.color = e.col === 'past' ? '#a3a3a3' : COLORS[e.col] || COLORS.white;   // (the last game session: grey, as on its tile, 11-06)
  if (full) { void mv.offsetWidth; mv.style.transition = ''; }
  if (!mv._n) { mv.innerHTML = '<span></span><span class="u"></span>'; mv._n = mv.firstChild; mv._u = mv.lastChild; }
  const gm = e.col === 'past' ? 'past' : 'live', flip = mv._gm !== undefined && mv._gm !== gm; mv._gm = gm;   // (live to past: another number, cut, not rolled)
  odo(mv._n, e.txt != null ? e.txt : fmtV(e.v, dec, r), flip, flip); setText(mv._u, e.txt != null ? (e.utxt ? ' ' + e.utxt : '') : e.v == null ? '' : ' ' + unit);
  if (flip && motionMode() !== 'off') for (const el of [mv, mgraph]) el.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: motionOn() ? 320 : 200, easing: SUM_E });   // (live to past: the view's flip fade, 11-08)
  const g = c.gates, gk = gbK(r), det = gbDet(gateLines(g), gk);
  if (full) {
    let d = c.pred ? 'Predicted from ' + esc(BYKEY.get(c.curve.src) ? BYKEY.get(c.curve.src).label : 'a missing reading') + ' through its curve, as there is no fan sensor.'
      : r ? '<span title="' + esc(r.key) + '">' + esc(SENS[r.s].name) + ', ' + esc(r.label) + '.</span>' : isPause(c) ? 'Not available right now.' : sensorHere(c) ? (neverHere(c) ? 'HWiNFO has never shared this reading on this PC.' : 'HWiNFO hasn\'t shared this reading for 7 days.') : 'This reading is not on this PC.';
    if (gatesOn(g)) d += ' Lines: yellow ' + lnTxt(det.y, dec, r, det.below) + (det.r !== undefined ? ', red ' + lnTxt(det.r, dec, r, det.below) : '') + (unit && !isYN(r) ? ' ' + esc(unit) : '') + (g.dir === 'below' ? ', bad when below' : '') + (det.y2 !== undefined || det.r2 !== undefined ? ', and on the other side ' + [det.y2 !== undefined ? 'yellow ' + lnTxt(det.y2, dec, r, !det.below) : '', det.r2 !== undefined ? 'red ' + lnTxt(det.r2, dec, r, !det.below) : ''].filter(Boolean).join(', ') + (g.dir === 'below' ? ', bad when above' : ', bad when below') : '') + (g.hold ? ', after ' + fmtL(g.hold, 1) + ' s' : '') + '.';
    if (c.curve && !c.pred) d += ' Follows a fan curve driven by ' + esc(BYKEY.get(c.curve.src) ? BYKEY.get(c.curve.src).label : 'a missing reading') + ', within ' + fmtL(c.curve.tol, 1) + '%' + (c.curve.warn === false ? ', but it doesn\'t warn when off it' : '') + '.';
    if (e.strip) d = 'What\'s limiting your fps, checked every second while a game runs. GPU bound: the GPU is almost fully busy (95% or more), normal for a game without an fps limit. ' +
      'FPS capped: the GPU has time to spare and the frames come at a steady rhythm, so an fps limit, vsync or Reflex is holding them. ' +
      'CPU bound: the GPU has time to spare and the rhythm keeps changing, so the game is waiting on the CPU, even when no single core shows as busy. ' +
      'Spotting a cap needs Accurate game fps (Settings). Without it, or in a Vulkan or OpenGL game, only a cap at the screen\'s refresh rate shows. ' +
      'The cell shows the most common answer of the last 5 seconds. In the 1 h view and longer, the graph shows the main answer of each minute (10 minutes in the 7 day view, an hour from 30 days on); point at one for its split. ' + bnFrom();
    if (xk && xk.desc) d = xk.desc(modalCid, r);
    $('mdesc').innerHTML = d;
  }
  mgsec.hidden = !!(xk && xk.noGraph);
  mgraph.hidden = $('mstats').hidden = !!e.strip;   // the bottleneck: only the range tabs up here, its bar below
  if (e.strip) { lastBig = null; bwBar(); bnPanel($('mextra'), e, full); return; }
  if (xk && xk.noGraph) { lastBig = null; bwBar(); xDetail(xk, r, e, full); return; }
  const sp = gbArr(bucketArr(c, isYN(r)), gk);
  if (full) {   // the yellow line joins the scale when it is close above the data; decided once per opening
    modalGateInView = false;
    const vals = sp.filter(x => x !== null);
    if (vals.length > 1 && det.y !== undefined) { const hi = Math.max(...vals), lo = Math.min(...vals), spn = Math.max(1.2, hi - lo); modalGateInView = det.below ? det.y < lo && det.y > lo - spn * 1.2 : det.y > hi && det.y < hi + spn * 1.2; }   // (below: just under the data, 11-06)
  }
  const gu = isYN(r) ? 'Yes/No' : unit;
  const day = ownDay(xk, e); modalOwn = !!day;
  if (bigRange === '15m') lastBig = [mgraph, sp, det, dec, gu, modalGateInView, null, HLEN * 1000];
  else if (day) lastBig = [mgraph, day, det, dec, gu, modalGateInView, null, OWN_SPAN[bigRange] * 1000];
  else if (histReady()) { const H = histOf(c); lastBig = isYN(r) ? [mgraph, H.max, det, dec, gu, modalGateInView, null, H.span * 1000] : [mgraph, gbArr(H.avg, gk), det, dec, gu, modalGateInView, gbArr(H.max, gk), H.span * 1000]; }
  else lastBig = lastBig && lastBig[1] && lastBig[1].length > 1 ? [mgraph, lastBig[1], det, dec, gu, modalGateInView, lastBig[6], lastBig[7]] : [mgraph, [], det, dec, gu, modalGateInView, null, 0];   // (a range picked, its answer on its way: the line before stays, dimmed (.loading), until the new one draws in; loading... only with none before, 11-08)
  mgraph.classList.toggle('loading', bigRange !== '15m' && !day && !histReady());
  const f = x => x == null || !isFinite(x) ? '--' : fmtV(x, dec, r);
  let st, long = false;
  // (the window's part: B, 11-07)
  const inW = a => { const n = a.length, k0 = Math.max(0, Math.ceil(BW.a * (n - 1) - 1e-9)), k1 = Math.min(n - 1, Math.floor(BW.b * (n - 1) + 1e-9)); return k0 <= k1 ? a.slice(k0, k1 + 1) : a.slice(Math.max(0, k1), Math.min(n, k0 + 1)); };   // (its own points; none between two: those two)
  // 15 min from the seconds themselves (a 1 s spike counts); the long ranges only have per-minute averages and peaks
  if (day) { const v = inW(day).filter(x => x != null && isFinite(x)); st = v.length ? { mn: Math.min(...v), av: v.reduce((a, b) => a + b, 0) / v.length, mx: Math.max(...v) } : {}; }   // (the day drawn, 11-06)
  else if (bigRange === '15m' || !histReady()) { const v = inW(cellSeries(c, HLEN)).filter(x => isFinite(x)); st = v.length ? { mn: Math.min(...v), av: v.reduce((a, b) => a + b, 0) / v.length, mx: Math.max(...v) } : {}; }
  else { long = true; const H = histOf(c), a = inW(H.avg).filter(x => x !== null), m = inW(H.max).filter(x => x !== null); st = a.length ? { mn: Math.min(...a), av: a.reduce((p, q) => p + q, 0) / a.length, mx: Math.max(...m) } : {}; }
  if (bigRange === '15m' && !day && lastBig && isFinite(st.av)) lastBig[9] = st.av * gk;
  if (bigRange === '15m' && !day && lastBig && isFinite(st.mx)) lastBig[10] = st.mx * gk;   // (its cut spike's peak: that second too)   // (the line's average = the one under it, from the seconds)
  drawBigGraph.apply(null, lastBig); bwBar();
  const per = !long ? '' : bigHist.step >= 3600 ? 'hourly' : bigHist.step >= 600 ? '10-minute' : '1-minute';
  const msH = (isYN(r) ? '' : '<span' + (long ? ' title="The lowest ' + per + ' average"' : '') + '><em>' + (long ? 'lowest avg' : 'min') + '</em>' + f(st.mn) + '</span><span><em>avg</em>' + f(st.av) + '</span><span><em>max</em>' + f(st.mx) + '</span>') +
    (r && !c.pred && r.mx != null ? '<span title="HWiNFO\'s own, since it started or was reset"><em>HWiNFO min / avg / max</em>' + f(r.mn) + ' / ' + (isYN(r) ? Math.round(r.av * 100) + '% yes' : f(r.av)) + ' / ' + f(r.mx) + '</span>' : '') +
    (e.sub ? '<span class="msub" style="color:' + (e.lvl ? '#8f7c2e' : '#6a6a6a') + '">' + esc(e.sub) + '</span>' : '');
  { const ms = $('mstats'); if (ms._h !== msH) { ms.innerHTML = msH; ms._h = msH; } }   // (only when it changed: its tips stay, 11-08)
  if (light) return;
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
const BN_SPAN = { '15m': 'the last 15 minutes', '1h': 'the last hour', '6h': 'the last 6 hours', '12h': 'the last 12 hours', '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days', 'all': 'the year kept' };
const bnSpan = r => BN_SPAN[r] || '';
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
function bnSum(B) {   // each call's share of the game time in the range, like the split of the last 15 min
  const n = [0, 0, 0, 0];
  for (const v of B.cols) if (v) v.forEach((p, k) => { n[k + 1] += p; });
  const tot = n[1] + n[2] + n[3];
  return { tot, secs: tot * B.step, split: tot ? [1, 2, 3].map(k => [BN[k][3], Math.round(n[k] * 100 / tot), BN[k][2]]) : [] };
}
const bnClock = (u, sec, day) => { const d = new Date(u * 1000), p = x => ('0' + x).slice(-2); return (day ? d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' : '') + p(d.getHours()) + ':' + p(d.getMinutes()) + (sec ? ':' + p(d.getSeconds()) : ''); };
function bnTicks(B) {
  if (B.step === 1) return '<span>-15m</span><span>-10m</span><span>-5m</span><span>now</span>';
  const t0 = B.end - (B.n - 1) * B.step, wk = B.n * B.step >= 2 * 86400, mo = B.n * B.step >= 8 * 86400;   // (from 30 days: the date)
  const tk = u => mo ? dMon(new Date(u * 1000)) : bnClock(u, false, wk);
  return '<span>' + tk(t0) + '</span><span>' + tk(t0 + B.n * B.step / 2) + '</span><span>now</span>';
}
function bnPanel(box, e, full) {
  if (full || !box.querySelector('.bnp')) box.innerHTML = '<div class="bnp"><div class="bnw"><canvas class="bnc"></canvas><i class="bgd"></i><div class="btip"></div></div><div class="sticks"></div><div class="mstats"></div></div>';
  const B = BNP.B = bnCols(), cv = box.querySelector('.bnc');
  box.querySelector('.bnp').classList.toggle('loading', !B);
  if (B) {   // (drawn again only when a column or its size changed)
    const lv = B.cols.map(v => v ? 3 - v.indexOf(Math.max(v[0], v[1], v[2])) : null), k = lv.join() + '|' + cvDims(cv).join('x') + '|' + solidOf(S.look) + '|' + (cellTint(modalCid) || '');   // (a new look draws it again, 11-09)
    const p = bigRev(); if (cv._h !== k || p < 1) { drawLevels(cv, lv, p, cellTint(modalCid) || '#c9c9c9'); cv._h = p < 1 ? null : k; }   // (drawing in as the other charts do, 11-08)
  }
  const sum = B && bnSum(B);
  const lg = !B ? '<span>loading...</span>' : sum.tot ? bnLegend(sum) + (B.step > 1 ? '<span><em>game time</em>' + (sum.secs < 59.5 ? Math.round(sum.secs) + 's' : durTxt(sum.secs)) + '</span>' : '') : B.old ? '<span>The split per minute is kept from HW Deck 1.3.0 on: nothing here yet</span>' : '<span>no game in ' + bnSpan(bigRange) + '</span>';
  const el = box.querySelector('.mstats'); if (el._h !== lg) { el.innerHTML = lg; el._h = lg; }
  const tk = B ? bnTicks(B) : '', st = box.querySelector('.sticks'); if (st._h !== tk) { st.innerHTML = tk; st._h = tk; }
  bnHover(box);
}
// the read-out under the pointer: that second's call, or that minute's (block's) split and how long a game ran in it
function bnHover(box) {
  const w = box.querySelector('.bnw'); if (!w) return;
  const B = BNP.B, r = w.getBoundingClientRect(), pw = Math.max(1, r.width - BN_PADL - 4), f = BNP.x === null ? -1 : (BNP.x - r.left - BN_PADL) / pw;   // (the graph right of its names)
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
  const gx = BN_PADL + (i + 0.5) / B.n * pw, tw = tip.offsetWidth;
  w.querySelector('.bgd').style.left = gx.toFixed(1) + 'px';
  tip.style.left = (gx + 12 + tw > r.width ? gx - 12 - tw : gx + 12).toFixed(1) + 'px';
  w.classList.add('hv');
}
$('mextra').addEventListener('pointermove', ev => { const w = ev.target.closest && ev.target.closest('.bnw'); BNP.x = w ? ev.clientX : null; bnHover($('mextra')); });
$('mextra').addEventListener('pointerleave', () => { BNP.x = null; bnHover($('mextra')); });
// a press outside the popup closes it, however soon after it opened and wherever (the same spot as the cell too)
modal.addEventListener('mousedown', e => { if (e.target === modal) { e.preventDefault(); closeDetail(); } });
$('mclose').onclick = closeDetail;
const cvSize = new WeakMap();
const cvRO = new ResizeObserver(es => {
  for (const e of es) cvSize.set(e.target, [e.contentRect.width, e.contentRect.height]);
  if (modalCid && lastBig) drawBigGraph.apply(null, lastBig); if (HP.shown) drawPrev();   // (a new size: drawn again now, not at the next tick)
});
// a big graph's canvas size: kept by the observer once seen, so no draw reads it after the tick's writes (2.1)
function cvDims(cv) {
  let d = cvSize.get(cv);
  if (!d || !d[0] || !d[1]) { if (!d) cvRO.observe(cv); d = [cv.clientWidth, cv.clientHeight]; cvSize.set(cv, d); }   // (seen hidden: read again)
  return d;
}
function graphCtx(cv) {
  const [cw, ch] = cvDims(cv), dpr = window.devicePixelRatio || 1, w = Math.round(cw * dpr), h = Math.round(ch * dpr);
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}
function yCaption(ctx, dpr, text, x) { if (!text) return; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#555'; ctx.font = (10 * dpr) + 'px Segoe UI'; ctx.fillText(text, x == null ? 4 * dpr : x, 1 * dpr); }
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
// the popup's big graph (range selector B, 11-07): the part of the range its window shows (BW: all of it unless zoomed
// or moved) as a smooth line over a band from the lowest to the highest of what each point stands for (a point of its
// own on a short range: its average up to its peak), the window's average dashed, its value on the right; the gate
// lines, time along the bottom. A Yes/No graph keeps its steps; the hover preview its line over its area
const BIG_PADL = 84, BIG_PADR = 84;   // (the plot in the middle of the popup: the scale on the left, the average's label on the right; 11-07, his "it does not look centered")
function drawBigGraph(cv, data, det, dec, unit, gateInView, maxData, spanMs, preview, avOver, pkOver) {   // (avOver: the window's average when the points drawn aren't what it is of: 15 min, 6 s buckets of the seconds)
  const { ctx, w, h, dpr } = graphCtx(cv);
  const nn = x => x !== null && x !== undefined;
  data = data || [];
  const all = data.filter(nn);
  if (all.length < 2) {
    if (!preview) bigMap = null;
    ctx.fillStyle = '#555'; ctx.font = (12 * dpr) + 'px Segoe UI'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.fillText(!preview && bigRange !== '15m' && !histReady() ? 'loading...' : 'no history here yet', (preview ? 10 : BIG_PADL) * dpr, 20 * dpr);
    return;
  }
  const n = data.length, Wn = preview ? { a: 0, b: 1 } : BW, i0 = Wn.a * (n - 1), i1 = Math.max(i0 + 1e-6, Wn.b * (n - 1));
  const j0 = Math.max(0, Math.floor(i0 + 1e-9)), j1 = Math.min(n - 1, Math.ceil(i1 - 1e-9));
  // (the scale, the average and the peak: the window's own points; drawing reaches the one past each edge)
  const k0 = Math.ceil(i0 - 1e-9) <= Math.floor(i1 + 1e-9) ? Math.max(0, Math.ceil(i0 - 1e-9)) : j0, k1 = Math.ceil(i0 - 1e-9) <= Math.floor(i1 + 1e-9) ? Math.min(n - 1, Math.floor(i1 + 1e-9)) : j1;
  let vals = data.slice(k0, k1 + 1).filter(nn), pvals = (maxData || []).slice(k0, k1 + 1).filter(nn);
  const gap = !vals.length;
  if (gap) { vals = all; pvals = (maxData || []).filter(nn); }   // (a window on a gap: the whole range's scale)
  const padL = (preview ? 58 : BIG_PADL) * dpr, padR = (preview ? 8 : BIG_PADR) * dpr, padT = 10 * dpr, padB = (preview ? 36 : 26) * dpr, yn = unit === 'Yes/No';
  if (yn) data = data.map(x => nn(x) ? x : 0);   // (an empty minute of a Yes/No graph is No: the line drops to it, his 11-06 "graph still not going up and down")
  let dLo = Math.min(...vals);
  const sc = scaleTop(pvals.length ? vals.concat(pvals) : vals, unit), floor0 = dLo >= 0;
  let dHi = sc.top;
  if (yn) { dLo = 0; dHi = 1; }
  if (gateInView) { for (const x of [det.y, det.r]) if (x !== undefined) { if (det.below) dLo = Math.min(dLo, x); else dHi = Math.max(dHi, x); } }   // (a line bad below lowers the floor, 11-06)
  const mag = Math.max(Math.abs(dLo), Math.abs(dHi), 1e-6), minSpan = Math.max(minSpanOf(unit), mag * 0.06, dec ? Math.pow(10, -dec) * 4 : 2);   // a flat 0 gets -1..1, not 8 decimals
  if (dHi - dLo < minSpan) { const mid = (dLo + dHi) / 2; dLo = mid - minSpan / 2; dHi = mid + minSpan / 2; if (floor0 && dLo < 0) { dHi -= dLo; dLo = 0; } }
  const pad = (dHi - dLo) * 0.12; dLo -= pad; dHi += pad;
  if (floor0 && dLo < 0) dLo = 0;
  const rawStep = yn ? 1 : (dHi - dLo) / 3, pw = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = yn ? 1 : [1, 2, 5, 10].map(m => m * pw).find(s => s >= rawStep) || 10 * pw;
  const stepDec = step >= 1 ? 0 : Math.ceil(-Math.log10(step) - 1e-9);
  const lo = yn ? -0.25 : Math.max(floor0 ? 0 : -Infinity, Math.floor(dLo / step) * step), hi = yn ? 1.25 : Math.ceil(dHi / step) * step;
  // (a value past the scale, a cut spike, is drawn at its edge)
  const plotW = w - padL - padR, X = i => padL + (i - i0) / (i1 - i0) * plotW, Y = v => h - padB - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * (h - padT - padB);
  ctx.font = (11 * dpr) + 'px Segoe UI'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const nTicks = yn ? 1 : Math.round((hi - lo) / step);
  for (let i = 0; i <= nTicks; i++) {
    const v = yn ? i : lo + i * step, y = Y(v);
    ctx.strokeStyle = gv('#1e1e1e'); ctx.lineWidth = dpr; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.fillText(yn ? (v ? 'Yes' : 'No') : dec ? v.toFixed(Math.max(dec, stepDec)) : (step >= 1 ? Math.round(v).toLocaleString('en-US') : v.toFixed(stepDec)), padL - 6 * dpr, y);
  }
  const span = spanMs || HLEN * 1000;
  ctx.textBaseline = 'top'; ctx.fillStyle = '#666';
  if (preview) {
    const tAt = f => { const d2 = new Date(Date.now() - span * (1 - f)); const hm = p2(d2.getHours()) + ':' + p2(d2.getMinutes()); return span >= 2 * 86400000 ? d2.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + hm : hm; };
    ctx.textAlign = 'left'; ctx.fillText(tAt(0), padL + 3 * dpr, h - padB + 8 * dpr);
    ctx.textAlign = 'center'; ctx.fillText(tAt(0.5), (padL + w - padR) / 2, h - padB + 8 * dpr);
    ctx.textAlign = 'right'; ctx.fillText('now', w - padR, h - padB + 8 * dpr);
    ctx.textAlign = 'center'; ctx.fillStyle = '#555';
    ctx.fillText(span >= 2 * 86400000 ? 'last ' + Math.round(span / 86400000) + ' days' : span >= 3600000 ? 'last ' + Math.round(span / 3600000) + (span >= 5400000 ? ' hours' : ' hour') : 'last 15 minutes', (padL + w - padR) / 2, h - padB + 22 * dpr);
  } else {   // (the window's start, middle and end: a date from 2 days on, else the time; now when it ends now)
    const ws = span * (Wn.b - Wn.a), at = f => new Date(Date.now() - span * (1 - f)), lab = d => ws >= 2 * 86400000 ? dMon(d) : p2(d.getHours()) + ':' + p2(d.getMinutes());
    ctx.textAlign = 'left'; ctx.fillText(lab(at(Wn.a)), padL + 3 * dpr, h - padB + 8 * dpr);
    ctx.textAlign = 'center'; ctx.fillText(lab(at((Wn.a + Wn.b) / 2)), padL + plotW / 2, h - padB + 8 * dpr);
    ctx.textAlign = 'right'; ctx.fillText(Wn.b > 0.999 ? 'now' : lab(at(Wn.b)), w - padR, h - padB + 8 * dpr);
  }
  yCaption(ctx, dpr, yn ? '' : unit || '', padL - 54 * dpr);   // (as near its scale's numbers as before the plot was centred)
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
    ctx.fillText(yn ? lnTxt(gv, 0, { unit: 'Yes/No' }, g[0].length > 1 ? !det.below : !!det.below) : dec ? (+gv).toFixed(dec) : String(gv), w - padR - 3 * dpr, gy - 2 * dpr); ctx.globalAlpha = 1;
  }
  // the window's average, dashed across, its value on the right
  if (!preview && !yn && vals.length && !gap) {   // (a window on a gap has no average: its stats say --, 11-07 audit)
    const av = typeof avOver === 'number' && isFinite(avOver) ? avOver : vals.reduce((p, q) => p + q, 0) / vals.length, ay = Y(av);
    ctx.strokeStyle = gv('#474747'); ctx.setLineDash([5 * dpr, 5 * dpr]); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(padL, ay); ctx.lineTo(w - padR, ay); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = (11.5 * dpr) + 'px Segoe UI'; ctx.fillStyle = '#7c7c7c'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const num = noNeg0(dec ? av.toFixed(dec) : Math.round(av).toLocaleString('en-US')), room = padR - 10 * dpr;
    let t = 'avg ' + num + (unit ? ' ' + unit : ''); if (ctx.measureText(t).width > room) t = 'avg ' + num;
    ctx.fillText(t, w - padR + 8 * dpr, ay);
  }
  const rv = preview ? preview.rev : bigRev(), tc = cellTint(preview ? HP.cid : modalCid);   // (Spectrum: the cell's colour)
  ctx.save();
  { const x0 = preview ? 0 : padL - dpr, x1 = rv < 1 ? padL + plotW * rv : preview ? w : w - padR + dpr; ctx.beginPath(); ctx.rect(x0, 0, Math.max(0, x1 - x0), h); ctx.clip(); }
  let bk = null;
  if (preview || yn) {
    // runs of values; where nothing was measured the line stops (no straight line across a gap)
    const runs = arr => { const out = []; let cur = null; arr.forEach((v, i) => { if (v === null || v === undefined) { cur = null; return; } if (!cur) out.push(cur = []); cur.push(i); }); return out; };
    const path = (arr, rs) => { ctx.beginPath(); for (const run of rs) run.forEach((i, j) => j ? ctx.lineTo(X(i), Y(arr[i])) : ctx.moveTo(X(i), Y(arr[i]))); };
    if (maxData) { path(maxData, runs(maxData)); ctx.strokeStyle = tc ? hexA(tc, 0.3) : 'rgba(201,201,201,0.30)'; ctx.lineWidth = 1.2 * dpr; ctx.lineJoin = 'round'; ctx.stroke(); }
    const rs = runs(data);
    path(data, rs); ctx.strokeStyle = tc || '#c9c9c9'; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.fillStyle = tc || '#c9c9c9';   // a value on its own between gaps still shows, as a dot
    for (const run of rs) if (run.length === 1) { ctx.beginPath(); ctx.arc(X(run[0]), Y(data[run[0]]), 1.5 * dpr, 0, 7); ctx.fill(); }
    if (!maxData) {
      ctx.beginPath();
      for (const run of rs) { run.forEach((i, j) => j ? ctx.lineTo(X(i), Y(data[i])) : ctx.moveTo(X(i), Y(data[i]))); ctx.lineTo(X(run[run.length - 1]), h - padB); ctx.lineTo(X(run[0]), h - padB); ctx.closePath(); }
      const grad = ctx.createLinearGradient(0, padT, 0, h - padB); grad.addColorStop(0, tc ? hexA(tc, 0.16) : 'rgba(201,201,201,0.16)'); grad.addColorStop(1, tc ? hexA(tc, 0) : 'rgba(201,201,201,0)');
      ctx.fillStyle = grad; ctx.fill();
    }
  } else {
    // its points: one per 4 px at most, each the average of what it stands for (the line) and the lowest to the highest
    // of it and of its peaks (the band); a point of its own each on a short range. A gap stops both
    // (they stand on fixed steps of the range, so a drag moves them instead of changing their shape)
    const nb = Math.max(2, Math.floor(plotW / dpr / 4)), cnt = i1 - i0 + 1, st = cnt > nb * 1.25 ? Math.ceil(cnt / nb) : 1;
    const pts = [];
    for (let i = Math.max(0, Math.floor(j0 / st) * st); i <= j1; i += st) {
      const e = Math.min(j1 + 1, i + st); let s = 0, c = 0, l = Infinity, u = -Infinity;
      for (let k = i; k < e; k++) { const v = data[k]; if (!nn(v)) continue; s += v; c++; if (v < l) l = v; if (v > u) u = v; const m = maxData ? maxData[k] : null; if (nn(m) && m > u) u = m; }
      pts.push(c ? [(i + e - 1) / 2, s / c, l, u] : null);
    }
    if (st > 1) bk = pts;
    const runs = []; let cur = null; for (const q of pts) { if (!q) { cur = null; continue; } if (!cur) runs.push(cur = []); cur.push(q); }
    // (through them as a smooth curve, Catmull-Rom as Bezier)
    const curve = (P, start) => {
      if (start) ctx.moveTo(P[0][0], P[0][1]); else ctx.lineTo(P[0][0], P[0][1]);
      for (let k = 0; k < P.length - 1; k++) { const a = P[Math.max(0, k - 1)], b = P[k], c = P[k + 1], d = P[Math.min(P.length - 1, k + 2)];
        ctx.bezierCurveTo(b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6, c[0] - (d[0] - b[0]) / 6, c[1] - (d[1] - b[1]) / 6, c[0], c[1]); }
    };
    ctx.beginPath();
    for (const r of runs) if (r.length > 1) { curve(r.map(q => [X(q[0]), Y(q[3])]), true); curve(r.slice().reverse().map(q => [X(q[0]), Y(q[2])]), false); ctx.closePath(); }
    ctx.fillStyle = tc ? hexA(tc, 0.16) : 'rgba(255,255,255,0.13)'; ctx.fill();
    ctx.beginPath(); for (const r of runs) if (r.length > 1) curve(r.map(q => [X(q[0]), Y(q[1])]), true);
    ctx.strokeStyle = tc || '#ececec'; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.fillStyle = tc || '#ececec';
    for (const r of runs) if (r.length === 1) { ctx.beginPath(); ctx.arc(X(r[0][0]), Y(r[0][1]), 1.8 * dpr, 0, 7); ctx.fill(); }
  }
  ctx.restore();
  if (sc.cut && sc.max > hi && !yn && rv >= 1) {   // a spike cut at the top says how high it went, beside it
    const src = maxData || data; let at = -1, mv = -Infinity;
    for (let i = preview ? 0 : k0; i <= (preview ? n - 1 : k1); i++) { const v = src[i]; if (v !== null && v !== undefined && v > mv) { mv = v; at = i; } }
    if (at >= 0 && !preview && typeof pkOver === 'number' && isFinite(pkOver) && pkOver > mv) mv = pkOver;   // (15 min: the window's top second, as the max under it, not its 6 s bucket's average, 11-07 audit)
    if (at >= 0 && X(at) >= padL - 1 && X(at) <= w - padR + 1) {
      const txt = 'peak ' + (dec ? (+mv).toFixed(dec) : Math.round(mv).toLocaleString('en-US'));
      ctx.font = (11 * dpr) + 'px Segoe UI'; ctx.textBaseline = 'top'; ctx.fillStyle = '#8a8a8a';
      const x = X(at), right = x + 6 * dpr + ctx.measureText(txt).width <= w - padR;
      ctx.textAlign = right ? 'left' : 'right'; ctx.fillText(txt, right ? x + 6 * dpr : x - 6 * dpr, padT + 1 * dpr);
    }
  }
  if (preview) return;
  bigMap = { padL, padR, padT, padB, w, h, Y, n, data, maxData, span, dec, unit, rv, i0, i1, bk };
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
  for (let v = 0; v <= yMax + 1e-9; v += ax.step) { const y = Y(v); ctx.strokeStyle = gv('#1e1e1e'); ctx.lineWidth = dpr; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillStyle = '#666'; ctx.fillText(v.toLocaleString('en-US'), padL - 6 * dpr, y); }
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
// (the drawn points [index, average, lowest, highest] at index f: between the two around it; none across a gap)
function bkAt(bk, f) {
  let p = null, gap = false;
  for (const q of bk) {
    if (!q) { gap = true; continue; }
    if (q[0] >= f) return !p ? (gap ? null : q[1]) : gap ? null : p[1] + (q[1] - p[1]) * (f - p[0]) / Math.max(1e-9, q[0] - p[0]);
    p = q; gap = false;
  }
  return p && !gap ? p[1] : null;
}
function valAt(arr, f) { const i = Math.floor(f), j = Math.min(arr.length - 1, i + 1), a = arr[i], b = arr[j]; if (a === null || a === undefined) return b === null || b === undefined ? null : b; if (b === null || b === undefined) return a; return a + (b - a) * (f - i); }
function hoverStep(t) {
  HV.raf = 0;
  // (the glide was tuned on a 240 Hz screen, a frame every 4.17 ms: the same speed on any refresh rate, 2.1)
  const dt = HV.t && t ? Math.min(64, t - HV.t) : 1000 / 60; HV.t = t || 0;
  const kf = f => 1 - Math.pow(1 - f, dt / 4.17);
  const M = bigMap, dpr = window.devicePixelRatio || 1, W = mgraph.offsetWidth, Hh = mgraph.offsetHeight;
  const box = mgraph.offsetLeft + ',' + mgraph.offsetTop + ',' + W + ',' + Hh;
  if (mhover._box !== box) { mhover._box = box; mhover.style.left = mgraph.offsetLeft + 'px'; mhover.style.top = mgraph.offsetTop + 'px'; mhover.style.width = W + 'px'; mhover.style.height = Hh + 'px'; }
  if (mhover.width !== Math.round(W * dpr)) mhover.width = Math.round(W * dpr);
  if (mhover.height !== Math.round(Hh * dpr)) mhover.height = Math.round(Hh * dpr);
  const ctx = mhover.getContext('2d'); ctx.clearRect(0, 0, mhover.width, mhover.height);
  const snap = !motionOn();   // (animations off or minimal: the guide sits on the pointer, no glide or fade)
  HV.a = snap ? (HV.on && M ? 1 : 0) : HV.a + ((HV.on && M ? 1 : 0) - HV.a) * kf(0.24);
  if (!M || (!HV.on && HV.a < 0.02)) { mtip.style.opacity = 0; HV.cx = HV.on ? HV.cx : null; HV.t = 0; return; }
  const plotL = M.padL / dpr, plotR = (M.w - M.padR) / dpr, tx = Math.max(plotL, Math.min(plotL + (plotR - plotL) * (M.rv == null ? 1 : M.rv), HV.tx));   // (within the part drawn in so far, 11-06)
  HV.cx = HV.cx === null || snap ? tx : HV.cx + (tx - HV.cx) * kf(0.28);
  const yn = M.unit === 'Yes/No', f = M.i0 + (HV.cx - plotL) / Math.max(1, plotR - plotL) * (M.i1 - M.i0), v0 = M.bk ? bkAt(M.bk, f) : valAt(M.data, f), X = HV.cx * dpr;
  const v = v0 === null && yn ? 0 : v0;   // (a Yes/No graph's empty minute reads No, its dot on the No line: his 11-06)
  ctx.globalAlpha = HV.a; ctx.strokeStyle = 'rgba(232,232,232,0.28)'; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath(); ctx.moveTo(X, M.padT); ctx.lineTo(X, M.h - M.padB); ctx.stroke(); ctx.setLineDash([]);
  let tipY = M.padT / dpr + 8;
  if (M.maxData) { const pv = valAt(M.maxData, f); if (pv !== null) { ctx.fillStyle = '#8a8a8a'; ctx.beginPath(); ctx.arc(X, M.Y(pv), 2.6 * dpr, 0, 7); ctx.fill(); } }
  if (v !== null) { const Y = M.Y(v); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.beginPath(); ctx.arc(X, Y, 8 * dpr, 0, 7); ctx.fill(); ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.arc(X, Y, 3.6 * dpr, 0, 7); ctx.fill(); tipY = Y / dpr; }
  ctx.globalAlpha = 1;
  const when = new Date(Date.now() - M.span * (1 - f / Math.max(1, M.n - 1)));
  const hm = ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2), day = M.span >= 2 * 86400000 ? when.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + dMon(when) + ' ' : '';
  const fm = x => x === null ? (yn ? 'No' : '--') : yn ? (x >= 0.5 ? 'Yes' : 'No') : noNeg0(M.dec ? x.toFixed(M.dec) : Math.round(x).toLocaleString('en-US'));
  const peak = M.maxData ? valAt(M.maxData, f) : null;
  const html = '<b>' + fm(v) + '</b> ' + esc(M.unit === 'Yes/No' ? '' : M.unit || '') + (peak !== null && M.maxData ? '<em>peak ' + fm(peak) + '</em>' : '') + '<em>' + day + hm + '</em>';
  if (mtip._h !== html) { mtip.innerHTML = html; mtip._h = html; mtip._w = mtip.offsetWidth; mtip._hh = mtip.offsetHeight; }   // (its size read when it changes, not every frame)
  const tw = mtip._w, th = mtip._hh;
  let lx = mgraph.offsetLeft + HV.cx + 14; if (lx + tw > mgraph.offsetLeft + W) lx = mgraph.offsetLeft + HV.cx - tw - 14;
  const ly = mgraph.offsetTop + Math.max(0, Math.min(Hh - th, tipY - th - 10));
  mtip.style.transform = 'translate(' + lx.toFixed(1) + 'px,' + ly.toFixed(1) + 'px)'; mtip.style.opacity = HV.a > 0.5 ? 1 : 0;
  if (Math.abs(tx - HV.cx) > 0.3 || (HV.on ? HV.a < 0.99 : HV.a > 0.02)) kickHover(); else HV.t = 0;
}

// ---------- hover preview: rest the pointer on a cell (clean view) and its 15 min graph shows beside it ----------
const hprev = document.createElement('div');
hprev.id = 'hprev';
hprev.innerHTML = '<div class="ph"><span class="pi"></span><span class="pt"></span><span class="pv"></span></div><canvas></canvas>' +
  '<div class="pstrip" hidden><canvas></canvas><div class="sticks"></div></div><div class="ps"></div><div class="pc"></div>';
document.body.appendChild(hprev);
const HP = { cid: null, el: null, timer: 0, shown: false, rev0: 0, raf: 0, ext: false };
const anyModalOpen = () => [...document.querySelectorAll('.modal')].some(m => m.classList.contains('open'));
// the gap between two cells: the preview stays a moment before it goes, so the next cell's shows at once, gliding there,
// however slowly the pointer crosses (his NVIDIA clip 11-05: a slow move hid it in the gap, then the next one waited its
// 330 ms; a quick one jumped the gap and went straight on. 2.2)
let hpGrace = 0;
const hideSoon = () => { clearTimeout(hpGrace); if (!HP.shown) return; hpGrace = setTimeout(() => { if (!HP.cid) hidePrev(); }, 220); };
sectionsEl.addEventListener('pointerover', e => {
  const n = S.edit || drag ? null : e.target.closest('#view .dc');
  const cid = n && !n.classList.contains('missing') ? n.dataset.cid : null;
  if (cid === HP.cid && n === HP.el && (HP.shown || HP.timer)) return;   // (hidden by a scroll, a press or a key: again on the next move, 11-06)
  HP.cid = cid; HP.el = n; clearTimeout(HP.timer); clearTimeout(hpGrace);
  if (anyModalOpen()) { hidePrev(); return; }
  if (!cid) { hideSoon(); return; }
  if (HP.shown) showPrev(true);
  else HP.timer = setTimeout(() => { HP.timer = 0; if (HP.cid === cid && !anyModalOpen()) showPrev(false); }, 330);
});
sectionsEl.addEventListener('pointerleave', () => { HP.cid = null; clearTimeout(HP.timer); clearTimeout(hpGrace); hidePrev(); });
// an extras build's own boxes (its Controls popup's devices, 2.1) show the same preview: a box with data-prev-key, over
// the popup it sits in (a popup opened over that one hides it); a reading with no cell in the layout uses one kept
// aside (cellAt)
const prevBlocked = n => [...document.querySelectorAll('.modal.open')].some(m => !m.contains(n));
const prevOff = () => { if (HP.ext) { HP.ext = false; HP.cid = null; clearTimeout(HP.timer); clearTimeout(hpGrace); hidePrev(); } };
document.addEventListener('pointerover', e => {
  const n = S.edit || drag || !e.target.closest ? null : e.target.closest('[data-prev-key]');
  if (!n) { if (HP.ext) { HP.ext = false; HP.cid = null; clearTimeout(HP.timer); hideSoon(); } return; }   // (a gap between two boxes: as between cells)
  const key = n.dataset.prevKey;
  let cid = Object.keys(S.L.cells).find(id => S.L.cells[id].key === key);
  if (!cid) { cid = 't:' + key; if (!TCELL[cid]) TCELL[cid] = { key, name: n.dataset.prevName || '' }; }
  if (cid === HP.cid && HP.el === n) return;
  HP.cid = cid; HP.el = n; HP.ext = true; clearTimeout(HP.timer); clearTimeout(hpGrace);
  if (prevBlocked(n)) { hidePrev(); return; }
  if (HP.shown) showPrev(true);
  else HP.timer = setTimeout(() => { if (HP.cid === cid && HP.el === n && !prevBlocked(n)) showPrev(false); }, 330);
});
document.addEventListener('pointerdown', prevOff, true);   // (a press opens its popup: the preview goes)
document.documentElement.addEventListener('pointerleave', prevOff);
window.addEventListener('blur', () => { HP.cid = null; hidePrev(); });
function hidePrev(now) {   // (now: a popup opens over it, gone at once, not fading over the card growing from its tile, 11-08)
  HP.shown = false; const pv = hprev.querySelector('.pv'); if (pv) pv._cid = null;
  if (now && hprev.classList.contains('on')) { hprev.style.transition = 'none'; hprev.classList.remove('on'); void hprev.offsetWidth; hprev.style.transition = ''; } else hprev.classList.remove('on');
  pauseSpin(hprev.querySelector('.pi svg')); }
function fillPrev() {
  const c = cellAt(HP.cid); if (!c) return false;
  const r = c.key ? BYKEY.get(c.key) : null, e = evalCell(HP.cid, c, true, true), dec = decOfCell(c, r), f = x => x == null || !isFinite(x) ? '--' : fmtV(x, dec, r);
  const pi = hprev.querySelector('.pi'), ic = iconOf(c, r);
  if (pi._h !== ic) { pi.innerHTML = ic; pi._h = ic; sweepSpins(); }
  if (isFanCell(c)) spinIcon(pi.querySelector('svg'), e.v);
  setText(hprev.querySelector('.pt'), nameIn(HP.cid));
  const pv = hprev.querySelector('.pv'), vh = e.txt != null ? esc(e.txt) + '<small>' + esc(e.utxt) + '</small>' : esc(fmtV(e.v, dec, r)) + '<small>' + esc(c.pred ? 'RPM' : unitOf(r)) + '</small>';
  if (pv._h !== vh) { pv.innerHTML = vh; pv._h = vh; }
  const pc = e.col === 'past' ? '#a3a3a3' : COLORS[e.col] || COLORS.white;   // (past: the last game session, 2.1)
  if (pv._cid !== HP.cid) { pv.style.transition = 'none'; pv.style.color = pc; void pv.offsetWidth; pv.style.transition = ''; pv._cid = HP.cid; } else pv.style.color = pc;   // (fades as the tile's; another cell's comes in its own, 11-08)
  // the bottleneck shows its calls as a graph (GPU, CPU, capped) and each call's share instead of min / avg / max
  HP.e = e;
  hprev.querySelector('canvas').hidden = !!e.strip; hprev.querySelector('.pstrip').hidden = !e.strip;
  if (e.strip) {
    const L = e.col === 'past' ? lastG() : null, ck = u => bnClock(u, false, false);
    const tk = L ? '<span>' + ck(L.start) + '</span><span>' + ck((L.start + L.end) / 2) + '</span><span>' + ck(L.end) + '</span>' : '<span>-15m</span><span>-10m</span><span>-5m</span><span>now</span>';
    const st = hprev.querySelector('.pstrip .sticks'); if (st._h !== tk) { st.innerHTML = tk; st._h = tk; }
  }
  const v = e.strip ? [] : e.col === 'past' && Array.isArray(e.past) ? e.past.filter(x => x != null && isFinite(x)) : cellSeries(c, HLEN).filter(x => isFinite(x));   // (a past session: its own numbers, 11-06)
  const sh = e.strip ? bnLegend(e.strip) : v.length && !isYN(r) && !e.yn ? '<span><em>min</em>' + f(Math.min(...v)) + '</span><span><em>avg</em>' + f(v.reduce((a, b) => a + b, 0) / v.length) + '</span><span><em>max</em>' + f(Math.max(...v)) + '</span>' : '';
  const ps = hprev.querySelector('.ps'); if (ps._h !== sh) { ps.innerHTML = sh; ps._h = sh; }
  setText(hprev.querySelector('.pc'), e.strip && BN[e.v] ? '' : e.sub);   // the bottleneck's split is already above
  return true;
}
function drawPrev() {
  const c = cellAt(HP.cid); if (!c) { HP.rev0 = 0; return; }
  const p0 = HP.rev0 && motionOn() ? Math.min(1, (performance.now() - HP.rev0) / 450) : 1, more = () => { if (p0 < 1) { if (!HP.raf) HP.raf = requestAnimationFrame(() => { HP.raf = 0; if (HP.shown) drawPrev(); }); } else HP.rev0 = 0; };
  if (isBneck(c)) {   // its calls: the last session's minutes, or the last 15 min's seconds
    const e = HP.e || {}, lv = e.col === 'past' && Array.isArray(e.past) ? e.past : series(BNECK, HLEN).map(bnLv);
    drawLevels(hprev.querySelector('.pstrip canvas'), lv, easeOut(p0), e.col === 'past' ? '#a3a3a3' : cellTint(HP.cid) || '#c9c9c9');
    more(); return;
  }
  const r = c.key ? BYKEY.get(c.key) : null, g = c.gates, gk = gbK(r), det = gbDet(gateLines(g), gk);
  if (HP.e && HP.e.pspan && Array.isArray(HP.e.past)) {   // (an extras reading with a whole day, as its graph in the view)
    drawBigGraph(hprev.querySelector('canvas'), HP.e.past, HP.e.yn ? {} : det, 0, isYN(r) || HP.e.yn ? 'Yes/No' : unitOf(r), false, null, HP.e.pspan * 1000, { rev: easeOut(p0) });   // (Game time's day of play: its lines are in minutes, not on it)
    more(); return;
  }
  if (HP.e && HP.e.col === 'past' && Array.isArray(HP.e.past)) {   // (a Game cell after its game: the session, as on its tile, 11-06)
    const L = lastG(); drawBigGraph(hprev.querySelector('canvas'), HP.e.past, det, decOfCell(c, r), unitOf(r), false, null, L ? (L.end - L.start) * 1000 : HLEN * 1000, { rev: easeOut(p0) });
    more(); return;
  }
  const sp = gbArr(bucketArr(c, isYN(r)), gk), vals = sp.filter(x => x !== null);   // (a Yes/No reading: each bucket's peak, as its popup)
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
  const fresh = !glide || !HP.shown || Math.abs(H - (HP.h || H)) > 4;   // (a glide to the next tile: its graph at once, the glide the only motion; another height, the Bottleneck's: fresh, 11-06)
  HP.h = H;
  if (fresh) { hprev.style.transition = 'none'; hprev.style.transform = at + ' translateY(6px) scale(0.97)'; void hprev.offsetWidth; hprev.style.transition = ''; }
  hprev.style.transform = at; hprev.classList.add('on'); HP.shown = true; HP.rev0 = fresh ? performance.now() : 0; drawPrev();
}

// ---------- confirmations, in their own small popup ----------
const cmodal = $('cmodal');
let confirmYes = null, confirmNo = null;
// (onNo: run when it is shut any other way than its yes; icon: 'power' or 'clean' for a question that isn't a delete,
// else the bin, or calm's)
function askConfirm(title, desc, yes, onYes, calm, onNo, icon) {
  if (icon) cmodal.dataset.ci = icon; else delete cmodal.dataset.ci;
  setText($('ctitle'), title); setText($('cdesc'), desc); setText($('cyes'), yes); confirmYes = onYes; confirmNo = onNo || null;
  cmodal.classList.toggle('calm', !!calm);
  const fa = document.activeElement; cOpener = fa && fa !== document.body && !cmodal.contains(fa) ? fa : null;
  cmodal.classList.add('open'); (calm ? $('cyes') : $('cno')).focus();
}
let cOpener = null;   // (what had the focus before the question: it gets it back, 11-06; it fell to the page)
function closeConfirm() {
  const n = confirmNo; confirmYes = confirmNo = null; cmodal.classList.remove('open');
  const o = cOpener; cOpener = null;
  if (cmodal.contains(document.activeElement)) { const c = o && o.isConnected ? o : document.querySelector('.modal.open:not(#cmodal) .mcard'); if (c) c.focus({ preventScroll: true }); else document.activeElement.blur(); }
  if (n) n();
}
$('cno').onclick = closeConfirm;
$('cyes').onclick = () => { const f = confirmYes; confirmNo = null; closeConfirm(); if (f) f(); };
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
  // Starter above the five slots: built from this PC's sensors each time it loads, so it follows new parts
  const st = starterLayout(), sn = st ? Object.keys(st.cells).length : 0;
  $('sstart').hidden = !!feed.ext;   // (the fork: its extras build the first layout)
  $('sstart').innerHTML = '<div class="srow2 starter"><span class="sn"><svg viewBox="0 0 24 24"><path d="M12 3l2.4 5.6L20 9.3l-4.3 4 1.2 5.9L12 16.3 7.1 19.2l1.2-5.9-4.3-4 5.6-.7z"/></svg></span>' +
    '<div style="min-width:0"><div class="st">Starter</div><div class="sm">' + (st ? 'built from this PC\'s sensors: ' + plural(sn, 'cell') + ', ' + plural(st.cats.length, 'category', 'categories') : 'waits for HWiNFO\'s readings') + '</div></div>' +
    '<div class="sa"><button class="btn" data-a="starter"' + (st ? '' : ' disabled') + '>Load</button></div></div>';
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
$('qsaveBtn').onclick = () => { if (nudge) flushNudge(); onSave(); };   // (Ctrl+S's button, beside Saves: 11-02)
$('slist').addEventListener('click', e => {
  const row = e.target.closest('.srow2'); if (!row) return;
  const i = Number(row.dataset.slot), a = e.target.closest('[data-a]');
  if (!a) return;
  if (a.dataset.a === 'load') {
    if (isDirty() || (S.active == null && S.L.cats.length)) askConfirm('Load ' + slotName(i) + '?', 'The view you have now has changes that are not in a slot. Loading replaces it, and Undo can bring it back.', 'Load', () => loadSlot(i), true);
    else loadSlot(i);
  }
  if (a.dataset.a === 'save') {
    if (S.slots[i] && S.active !== i) askConfirm('Overwrite ' + slotName(i) + '?', 'The slot gets the view you have now. What it held is replaced.', 'Overwrite', () => saveTo(i));
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
      if (b.dataset.m === 'import' && heldSlots.has(i)) toast(slotName(i) + ' is open in another program, like a sync or a backup tool. Try again in a moment');
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
  // (11-06: a press elsewhere in Saves blurs the field on its mousedown: the name is kept at once, the list is drawn
  // again after that click, so the button pressed is still there for it)
  inp.onblur = () => {
    if (!sPress) { fin(true); return; }
    if (done) return; done = true;
    if (inp.value.trim()) { S.slots[i].name = inp.value.trim().slice(0, 80); saveSlot(i); }
    st.textContent = slotName(i);
    addEventListener('click', () => setTimeout(() => { syncSaves(); renderSaves(); }), { once: true, capture: true });
  };
}
let sPress = false;   // (a mousedown in Saves in progress)
smodal.addEventListener('mousedown', () => { sPress = true; setTimeout(() => { sPress = false; }); }, true);
function loadSlot(i) {
  snap(); slotWanted = null;   // (a load, a save, a clear or an import: the view's link is the user's now, not the one held at the start)
  S.L = JSON.parse(JSON.stringify(S.slots[i] ? S.slots[i].layout : emptyLayout()));
  S.active = i; sel = null; endRelink(true);
  const n = relinkByName(); ynFixAll();
  smodal.classList.remove('open');   // you load a slot to look at it
  enterNext = true; afterChange();
  toast('Loaded ' + slotName(i) + (n ? ', ' + plural(n, 'cell') + ' re-linked by sensor name' : ''), true);
}
function saveTo(i) {
  if (heldSlots.has(i)) { toast(slotName(i) + ' is open in another program, like a sync or a backup tool. Save again in a moment'); return; }   // (its file is there, the page just hasn't got it)
  slotWanted = null;
  const name = S.slots[i] ? S.slots[i].name : 'Slot ' + (i + 1);
  S.slots[i] = { v: 1, name, layout: JSON.parse(JSON.stringify(S.L)) };
  // (the undo steps of the slot it was go with it: an undo can't link the view back to the slot left alone on purpose)
  // (only the newest run of steps linked to it, back to the Load or Clear that started it)
  const was = S.active, move = st => { for (let k = st.length - 1; k >= 0; k--) { const o = JSON.parse(st[k]); if (o.host) continue; if (o.active !== was) break; o.active = i; st[k] = JSON.stringify(o); } };   // (a bin move is no view's: passed over)
  if (was !== i && was != null) { move(undoStack); move(redoStack); }   // (a view linked to no slot: its history isn't that slot's)
  S.active = i; saveSlot(i); saveState(); syncSaves(); toast('Saved to ' + slotName(i));
}
function onSave() {
  if (S.active != null) { saveTo(S.active); return; }
  if (slotWanted != null) { toast(slotName(slotWanted) + ' is open in another program, like a sync or a backup tool. Save again in a moment'); return; }   // (the view's own slot, held at the start)
  const free = S.slots.findIndex((s, k) => !s && !heldSlots.has(k));
  if (free >= 0) saveTo(free); else { renderSaves(); smodal.classList.add('open'); }
}
$('clearBtn').onclick = () => askConfirm('Clear the view?', 'Your slots stay as they are, and Undo brings the view back.', 'Clear view', () => {
  // (a view already empty and linked to no slot: no undo step that changes nothing, as mutate, 11-06)
  const before = snapOf(); S.L = emptyLayout(); S.active = null; slotWanted = null; sel = null; endRelink(true);
  if (snapOf() !== before) pushUndo(before); else syncUndo();
  smodal.classList.remove('open'); afterChange(); toast('View cleared', true);
});

// ---------- Starter: a first layout built from this PC's own sensors ----------
// Each cell a role, found by HWiNFO's own labels (the likeliest first: they differ by vendor); a role this PC hasn't
// got makes no cell, a category with none makes no category. What Storage hides (the CPU's own graphics beside a real
// GPU, readings only ever at 0, what you hid) is never picked. No lines: what is too hot differs from part to part
// (the 12V-2x6 connector keeps its own, as a cell of it always does). null: no readings yet
const ST_GPU = /^(dGPU|GPU|iGPU) \[#\d+\]/;
const stIntegrated = n => /^iGPU\b/.test(n) || /Intel.*(UHD|Iris|HD Graphics|Arc\(TM\) Graphics|Arc Graphics)|Radeon\(TM\) Graphics|Radeon Graphics\b|Radeon \d{3}M\b/i.test(n);
// a sensor's part name: "CPU [#0]: AMD Ryzen 7 9800X3D: Enhanced" is "Ryzen 7 9800X3D", "GPU [#0]: NVIDIA GeForce RTX 5090" is "GeForce RTX 5090"
const stPart = n => ((n.split(': ')[1] || '').replace(/\((R|TM)\)/gi, '').replace(/^(NVIDIA|AMD|ATI|Intel)\s+/i, '').replace(/\s+/g, ' ').trim());
function starterLayout() {
  if (!READ.some(r => r.key && !r.key.startsWith('hwdeck.'))) return null;
  const L = emptyLayout(), used = new Set(), sn = r => SENS[r.s] ? SENS[r.s].name : '';
  // (the game's readings and a GPU's fans sit at 0 until a game runs, a 0 dB fan too: hidden by default as "only ever
  // 0", they still count; only what you hid yourself doesn't)
  const ok = r => !!r && !used.has(r.key) && !hidOf(r), live = r => !!r && !used.has(r.key) && hidOf(r) !== 1;
  const find = (res, inS, okf) => { for (const re of res) { const r = READ.find(x => re.test(x.label) && (!inS || inS(sn(x))) && (okf || ok)(x)); if (r) return r; } return null; };
  const own = k => { const r = BYKEY.get(k); return live(r) ? r : null; };
  const add = (cells, r, name) => { if (!r) return; used.add(r.key); const c = newCell(r.key); if (name) c.name = name; const id = nid('a'); L.cells[id] = c; cells.push(id); };
  const rk = new Map(), cat = (name, cells, r) => { if (!cells.length) return; const o = { id: nid('c'), name, collapsed: false, cells }; rk.set(o, r); L.cats.push(o); };
  // the graphics card: a real one before the CPU's own graphics (a laptop may only have those)
  const gpus = [...new Set(READ.map(sn))].filter(n => ST_GPU.test(n)), gn = gpus.find(n => !stIntegrated(n)) || gpus[0];
  const gtag = gn ? gn.match(ST_GPU)[0] : null, inGpu = n => !!gtag && n.startsWith(gtag);
  let c = [];
  if (gtag) {
    add(c, find([/^GPU Temperature$/], inGpu), 'GPU temperature');
    add(c, find([/^GPU Hot ?Spot Temperature$/i, /^GPU Junction Temperature$/], inGpu), 'GPU hot spot');
    add(c, find([/^GPU Memory Junction Temperature$/], inGpu), 'GPU memory');   // (its temperature, as in a session's details)
    add(c, find([/^GPU Core Load$/, /^GPU Utilization$/, /^GPU D3D Usage$/], inGpu), 'GPU usage');
    add(c, find([/^GPU Power$/, /^Total Board Power( \(TBP\))?$/, /^GPU ASIC Power$/], inGpu), 'GPU power');
    add(c, find([/^GPU Memory Allocated$/, /^GPU D3D Memory Dedicated$/, /^GPU Memory Used$/, /^GPU Memory Usage$/], inGpu), 'VRAM used');
  }
  add(c, own(CONN), '12V-2x6');   // (the connector's pins, when HWiNFO reports them; a name that fits a tile. Its pins' warnings read "12V-2x6 pins", 11-06)
  cat(gn ? stPart(gn) || 'GPU' : 'GPU', c, 1);
  // the processor
  const inCpu = n => /^CPU \[#0\]/.test(n), cn = READ.map(sn).find(inCpu);
  c = [];
  add(c, find([/^CPU \(Tctl\/Tdie\)$/, /^CPU Package$/, /^CPU \(Tctl\)$/, /^CPU Die \(average\)$/, /^Core Max$/], inCpu), 'CPU temperature');
  add(c, find([/^Total CPU Usage$/], inCpu), 'CPU usage');
  add(c, find([/^CPU Package Power$/, /^CPU PPT$/], inCpu), 'CPU power');
  add(c, find([/^Max CPU\/Thread Usage$/], inCpu), 'Busiest core');
  cat(cn ? stPart(cn) || 'CPU' : 'CPU', c, 2);
  // memory: RAM used and its load, each stick's temperature
  c = [];
  add(c, find([/^Physical Memory Used$/]), 'RAM used');
  add(c, find([/^Physical Memory Load$/]), 'RAM usage');
  const firstTemp = (n, pref) => (pref && READ.find(x => sn(x) === n && pref.test(x.label) && ok(x))) || READ.find(x => sn(x) === n && x.t === 'temp' && ok(x));
  let k = 0;
  for (const n of [...new Set(READ.map(sn))].filter(n => /DIMM/i.test(n))) { if (k >= 4) break; const r = firstTemp(n, /Temperature/); if (r) add(c, r, 'RAM stick ' + (++k)); }
  cat('Memory', c, 3);
  // the drives' temperatures, the system drive first
  c = [];
  const drives = [...new Set(READ.map(sn))].filter(n => /^(S\.M\.A\.R\.T\.|Drive): /.test(n)), letter = n => (/\[([A-Z]):\]/.exec(n) || [])[1];
  drives.sort((p, q) => (letter(p) === 'C' ? 0 : 1) - (letter(q) === 'C' ? 0 : 1));
  // (one drive by its letter once, however many sensors show it; two of the same model without letters both, numbered)
  const dk = new Set(), dn = new Set();
  for (const n of drives) {
    if (dk.size >= 3) break;
    const key = letter(n) ? 'L' + letter(n) : n; if (dk.has(key)) continue;
    const r = firstTemp(n, /^Drive Temperature$/); if (!r) continue;
    const base = 'Drive ' + (letter(n) ? letter(n) + ':' : (n.split(': ')[1] || '').replace(/\s*\([^)]*\)\s*$/, '').trim());
    let name = base; for (let j = 2; dn.has(name); j++) name = base + ' #' + j;
    dk.add(key); dn.add(name); add(c, r, name);
  }
  cat('Drives', c, 4);
  // the game: its fps (HW Deck's own count when it is on), its 1% low, what limits it, how long it has run
  c = [];
  add(c, own('hwdeck.0/fps') || find([/^Framerate( Presented)?( \(avg\))?$/], null, live), 'FPS');
  add(c, own('hwdeck.0/fps1') || find([/^Framerate( Presented)? \(1% low\)$/], null, live), '1% low FPS');
  add(c, own(BNECK)); add(c, own(GTIME));
  cat('Game', c, 0);
  // the fans: the graphics card's, then the board's (a pump and the CPU fan first); one that never spins is hidden
  c = [];
  const gf = READ.filter(x => x.t === 'fan' && inGpu(sn(x)) && live(x)).slice(0, 2);
  gf.forEach((r, i) => add(c, r, gf.length > 1 ? 'GPU fan ' + (i + 1) : 'GPU fan'));
  const board = n => !inGpu(n) && !ST_GPU.test(n) && !/^CPU \[#/.test(n) && !/DIMM|S\.M\.A\.R\.T\.|^Drive: |PresentMon|^HW Deck$/i.test(n);
  const rank = r => /pump|aio|water|liquid/i.test(r.label) ? 0 : /cpu/i.test(r.label) ? 1 : 2;
  READ.filter(x => x.t === 'fan' && board(sn(x)) && ok(x)).map((r, i) => ({ r, i })).sort((p, q) => rank(p.r) - rank(q.r) || p.i - q.i).slice(0, 4)
    .forEach(({ r }) => add(c, r, /fan|pump/i.test(r.label) ? null : r.label + ' fan'));
  cat('Fans', c, 5);
  L.cats.sort((p, q) => rk.get(p) - rk.get(q));   // (his order, 11-02: the game, the GPU, the CPU, memory, drives, fans)
  return L.cats.length ? L : null;
}
// Starter in the view: from Saves or the empty view's button, like a slot (it asks first when the view isn't in a
// slot, and Undo brings the view back)
function loadStarter() {
  const L = starterLayout(); if (!L) return;
  snap(); slotWanted = null;
  S.L = L; S.active = null; sel = null; endRelink(true);
  ynFixAll();
  smodal.classList.remove('open');
  enterNext = true; afterChange();
  if (!S.starterSeen) starterSeen();   // (loaded: its note has done its job)
  toast('Loaded Starter, built from this PC\'s sensors', true);
}
function askStarter() {
  if (isDirty() || (S.active == null && S.L.cats.length)) askConfirm('Load Starter?', 'The view you have now has changes that are not in a slot. Loading replaces it, and Undo can bring it back.', 'Load', loadStarter, true);
  else loadStarter();
}
// a new user (an empty view, Starter not seen): Starter as soon as the readings come, to look at, not to edit. Someone
// with a layout of their own: a note that stays until it is dismissed (a restart doesn't drop it). Once either
// happened (S.starterSeen, kept with the view), neither again. Tests start with --no-starter
function starterCheck() {
  if (!feed.stateIn || feed.noStarter || feed.ext || S.starterSeen) return;   // (the fork: its extras build the first layout)
  // (a view of their own, or one that isn't a new user's (emptied, set aside): the note, never Starter over it; once the
  // note showed, that stays so even after the view is emptied)
  if (S.L.cats.length || !feed.starterFresh || S.starterNoted) {
    $('notice').classList.add('show'); $('estNotice').classList.remove('show'); notesCheck();   // (the sessions' note and the update cards after this one, in its pile)
    if (!S.starterNoted) { S.starterNoted = true; saveState(); }
    return;
  }
  const L = starterLayout(); if (!L) return;   // (HWiNFO not sharing yet: when it does)
  S.L = L; S.active = null; S.starterSeen = true; sel = null;
  enterNext = true; setEdit(false); subscribe(); syncSaves();
  toast('Starter: a layout built from this PC\'s sensors. The pencil, or E, edits it', false, 7000);
}
function starterSeen() { if ($('notice').classList.contains('swap')) return; S.starterSeen = true; saveState(); pileNext($('notice'), ((feed.estNote || 0) > 0 && !estGone) || notesDue().length > 0, estCheck); }
// a card of the pile put away with another after it (the motion audit 11-08): its words fade and the next card's come up
// in the same place, as the update cards swap theirs, no drop and rise of two cards crossing. The last one drops away
// as before; Off: at once
function pileNext(el, has, then) {
  if (!has || motionMode() === 'off') { el.classList.remove('show'); then(); return; }
  el.classList.add('swap');
  setTimeout(() => {
    const cs = [$('notice'), $('estNotice'), $('upn')];
    for (const c of cs) c.style.transition = 'none';
    el.classList.remove('show', 'swap'); then();
    void el.offsetWidth; for (const c of cs) c.style.transition = '';
    const nc = cs.find(c => c !== el && c.classList.contains('show'));
    if (nc) for (const k of nc.children) k.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140 });
  }, 140);
}
// sessions from before 2.0.1 this update worked out again (2.1, the host's Games.ReestimateFiles; feed.estNote: how
// many): a note like Starter's, once, after Starter's if that one is up. Its X or Show sessions and it's gone for good
// (the host forgets the count). A new install has nothing to change, so it never shows there
let estGone = false;
function estCheck() {
  const el = $('estNotice'), n = feed.estNote || 0;
  if (!(n > 0) || estGone) { el.classList.remove('show'); notesCheck(); return; }
  estFill();
  if ($('notice').classList.contains('show')) { el.classList.remove('show'); notesCheck(); return; }   // (Starter's note first)
  el.classList.add('show'); notesCheck();
}
function estFill() { const n = feed.estNote || 0; setText($('estTxt'), 'HW Deck worked out the bottleneck of ' + n + (n === 1 ? ' game session' : ' game sessions') + ' from before 2.0.1 again. Back then a GPU that wasn\'t busy read as "FPS capped". Now only minutes whose fps held steady stay capped, and the rest count as CPU bound.'); }
function estSeen() { if ($('estNotice').classList.contains('swap')) return; estGone = true; send({ t: 'estSeen' }); pileNext($('estNotice'), notesDue().length > 0, notesCheck); }
// ---- the update notes (2.4.2, his ask 11-07): a little card for each update since the version this install ran last,
// all of them, stacked: the oldest on top, the rest peeking out behind it. Its X shows the next one, Dismiss all puts
// them all away; the host keeps the version seen (notesSeen; a new install starts at its own, so none). After Starter's
// note and the sessions note, never over them
const NOTES = [
  ['2.0.0', '2.0', ['Look, in Settings: card styles, Mono, Accent or Spectrum colour, and palettes to start from.',
    'Warning history, redone: the last 7 days at a glance, a period and a cell to look at, and a chart around each crossing.',
    'Bins for game sessions and warnings: move rows there and bring them back. Keep can be Forever.',
    'Starter: a first layout built from this PC\'s sensors, waiting in Saves.',
    'Game sessions of your own, started with the play button.',
    'The bottleneck tells an fps cap from the CPU by the pace of the game\'s frames.']],
  ['2.1.0', '2.1', ['The bottleneck spots fps caps far more often, vsync included, and is drawn as a graph like the other cells.',
    'With no game running, the game cells show your last session in grey.',
    'Game sessions from before 2.0.1 had their bottleneck worked out again.',
    'Smoother motion, and lighter on the PC: fewer process checks and much smaller history writes.',
    'The window keeps its size when you un-maximize it.']],
  ['2.2.0', '2.2', ['A tile\'s size is a share of its row and a height in rows, the same at any window size.',
    'In a narrow window, tiles split over fewer per row instead of cutting their text.',
    'Captions that don\'t fit use shorter words, and long names get slightly smaller text.']],
  ['2.3.0', '2.3', ['With Animations on Full, a popup grows out of the tile or button you clicked.',
    'A popup opened over another: the one underneath steps back.',
    'Moving from one tile to the next switches the hover preview at once.']],
  ['2.4.0', '2.4', ['Themes: eight to pick from in Settings > Look.',
    'Background: a base colour and soft fades from any edge or corner.',
    'Cells: their fill, transparency, outline and corners.',
    'Spectrum\'s new Match palette takes its colours from the background.']],
  ['2.4.1', '2.4.1', ['The settings panel is redrawn: shorter, with a back button and chips for sizes.',
    'The settings stay out while a cell or category is selected.',
    'Undo and redo go back to the view where the change was made.',
    'Yes/No graphs read No where nothing was recorded.']],
  ['2.4.2', '2.4.2', ['Play time now counts only while the game is the window in front. Time alt-tabbed no longer counts, past sessions included.',
    'Graphs go back 30 days, 90 days and a year. Zoom into any part with the wheel, or with the bar under the graph.',
    'Apply one category\'s look to all of them at once.',
    'Warning history\'s button shows a dot when there are new warnings.',
    'Game sessions: sort the games by any column, and compare two sessions side by side.',
    'Many fixes to warnings, saves, history and editing, and lighter on the PC.']],
  ['2.4.3', '2.4.3', ['Two categories side by side in one column: select the lower one and press Beside above.',
    'Update notes sit in one pile, so the X stays in place.',
    'Settings > Updates: Check now looks for an update right away.',
    'Fixes to game sessions, charts, warnings and history.']],
  ['2.4.4', '2.4.4', ['107 themes in ten colours, each with its own palette, and a new Look page: a live preview of your window, and your own saved looks.',
    'Themes reach every window; Settings > Look > Popups draws them like the cells or like the view.',
    'Game sessions: Compare has its own button beside Pick: click A, then B, swap them, compare. Back keeps them.',
    'The chart in Game sessions and Warning history filters the list only with Filter list on.',
    'Edit mode: in your accent colour, arrows on Width and Height, nothing moves as it turns on, and undo brings back exactly what was there.',
    'A reading HWiNFO isn\'t sharing right now just says so; Re-link shows only when it is really gone.']],
  ['2.4.5', '2.4.5', ['Keep HWiNFO sharing and Accurate game fps are on from the start, and Settings asks Windows for permission less often.',
    'Update now needs no hidden PowerShell script, and its Windows prompt shows Windows Installer on an administrator account.',
    'A cell\'s popup grows out of the cell you clicked.',
    'Look: the accent box folds away on Mono, and the palette list shows each palette\'s colours.',
    'Undo no longer brings the view back smaller with an empty band under it.']],
];
const verN = v => String(v || '').split('.').map(n => parseInt(n, 10) || 0).concat([0, 0, 0]).slice(0, 3);
const verNewer = (a, b) => { const x = verN(a), y = verN(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const notesDue = () => feed.notesSeen && feed.version ? NOTES.filter(n => verNewer(n[0], feed.notesSeen) && !verNewer(n[0], feed.version)) : [];
function notesDraw(due) {
  const n = due[0];
  $('upnT').textContent = 'New in ' + n[1];
  $('upnC').textContent = due.length > 1 ? (due.length - 1) + ' more' : '';
  $('upnL').innerHTML = n[2].map(t => '<li>' + esc(t) + '</li>').join('');
  $('upnA').hidden = due.length < 2;
}
function notesCheck() {
  const el = $('upn'), due = notesDue();
  if (!due.length || $('notice').classList.contains('show') || $('estNotice').classList.contains('show')) el.classList.remove('show');
  else { if (!el.classList.contains('swap')) notesDraw(due); el.classList.add('show'); }
  upLock();
}
// (his 11-07 "the popups were SUPER WEIRD": the sessions note came alone, then the update cards, each as tall as its
// own text, so every X moved the card's top and its X away from the pointer.) Starter's note, the sessions note and
// the update cards are one pile now, the next ones peeking out behind, all as tall as the tallest of them: each X sits
// where the last one was. Measured when the pile comes up (again only for a card that joins it, or a resize)
let upH = 0, upHas = new Set();
function upLock() {
  const w = $('upw'), cs = [$('notice'), $('estNotice'), $('upn')], st = cs[0].classList.contains('show'), es = (feed.estNote || 0) > 0 && !estGone, due = notesDue();
  const total = (st ? 1 : 0) + (es ? 1 : 0) + due.length, more = total > 1 ? (total - 1) + ' more' : '';
  w.dataset.n = Math.min(3, total); setText($('noticeC'), more); setText($('estC'), more);
  if (!total) { upH = 0; upHas = new Set(); w.style.height = ''; for (const c of cs) c.style.minHeight = ''; return; }
  const want = (st ? ['s'] : []).concat(es ? ['e'] : [], due.map(n => n[0]));
  if (upH && want.every(k => upHas.has(k))) return;
  for (const c of cs) c.style.minHeight = '';
  let h = 0;
  if (st) h = cs[0].offsetHeight;
  if (es) { estFill(); h = Math.max(h, cs[1].offsetHeight); }
  if (due.length && !cs[2].classList.contains('swap')) { for (let i = 0; i < due.length; i++) { notesDraw(due.slice(i)); h = Math.max(h, cs[2].offsetHeight); } notesDraw(due); }
  upH = Math.max(upH, Math.ceil(h)); want.forEach(k => upHas.add(k));
  w.style.height = upH + 'px'; for (const c of cs) c.style.minHeight = upH + 'px';
}
addEventListener('resize', () => { if (upH) { upH = 0; upHas = new Set(); upLock(); } });
// seen up to v; next: the card after it comes up in its place
function notesSeen(v, next) {
  feed.notesSeen = v; send({ t: 'notesSeen', v });
  const el = $('upn');
  if (!next || !notesDue().length) { el.classList.remove('show'); upLock(); return; }
  if (motionMode() === 'off') { notesDraw(notesDue()); upLock(); return; }   // (Off: the next card at once, not an empty one for 140 ms, 11-08)
  el.classList.add('swap'); upLock();
  setTimeout(() => { const due = notesDue(); if (due.length) notesDraw(due); else el.classList.remove('show'); el.classList.remove('swap'); upLock(); }, 140);
}
$('upnClose').onclick = () => { if ($('upn').classList.contains('swap')) return; const due = notesDue(); if (due.length) notesSeen(due[0][0], true); };   // (a quick second X waits for the card it would put away)
$('upnAll').onclick = () => { const due = notesDue(); if (due.length) notesSeen(due[due.length - 1][0], false); };
$('estClose').onclick = estSeen;
$('estShow').onclick = () => { estSeen(); $('gamesBtn').click(); };
$('noticeClose').onclick = starterSeen;
$('noticeShow').onclick = () => {
  starterSeen(); renderSaves(); smodal.classList.add('open');
  const row = document.querySelector('#sstart .srow2'); if (row) { row.classList.add('hl'); setTimeout(() => row.classList.remove('hl'), 2600); }
};
$('sstart').addEventListener('click', e => { if (e.target.closest('[data-a="starter"]')) askStarter(); });
document.addEventListener('click', e => { if (e.target.closest('#starterBtn')) loadStarter(); });

// ---------- the warning log: merged episodes from alerts.log, last 7 days ----------
const wmodal = $('wmodal');
let lastLogCount = 0;
// a dot on the history button for crossings that started since it was last opened (his pick 11-06: a dot only), red
// when one of them went red. The page reads the log for it at its start, when the window shows again and a few seconds
// after a reading crosses a line (the host writes the log every second); when it was last opened stays in the page's
// own storage
const WSEEN = 'hwdeck.warnSeen', wStore = () => host && host.demo ? sessionStorage : localStorage;   // (the browser demo keeps nothing past its tab)
let wSeen = (() => { try { return +wStore().getItem(WSEEN) || 0; } catch (e) { return 0; } })(), wPeekT = 0, wRiseT = 0, wRiseT2 = 0, wPeek = false;
function wDot(lv) { const d = $('logDot'); if (!d) return; d.classList.toggle('on', !!lv); d.classList.toggle('r', lv === 'RED'); }
function wSeenNow() { wSeen = Date.now(); try { wStore().setItem(WSEEN, String(wSeen)); } catch (e) { } wDot(null); }
function wPeekSoon(ms) { if (!host) return; clearTimeout(wPeekT); wPeekT = setTimeout(() => { if (wmodal.classList.contains('open')) return; wPeek = true; send({ t: 'alerts' }); }, ms); }
// (5 s after a rise and again at 35 s, a line with a hold logs its crossing only once it held; a reading that keeps
// crossing doesn't push them back)
function wPeekRise() { if (!wRiseT) wRiseT = setTimeout(() => { wRiseT = 0; wPeekSoon(0); }, 5000); if (!wRiseT2) wRiseT2 = setTimeout(() => { wRiseT2 = 0; wPeekSoon(0); }, 35000); }
function wPeekRead(log) {
  wPeek = false;
  if (!wSeen) { wSeenNow(); return; }   // (the first start: what the log already holds isn't new)
  const eps = wxParse(log).filter(ep => ep.when.getTime() > wSeen || (ep.redAt && ep.redAt.getTime() > wSeen));   // (a yellow already seen that went red since counts again)
  wDot(eps.some(ep => ep.level === 'RED') ? 'RED' : eps.length ? 'YELLOW' : null);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) wPeekSoon(1500); });
setTimeout(() => wPeekSoon(0), 6000);
setInterval(() => { if (!document.hidden) wPeekSoon(0); }, 120000);   // (and every 2 minutes while it shows: a build's own checks have no cell to rise)
$('logBtn').onclick = () => { WX.W.reset(); WX.wkey = null; wSeenNow(); pkMode('w', null, true); wmodal.classList.add('open'); wShow = 300; WX.open = false; WX.cell = null; WX.menu = false; wxWait.clear(); $('wsum').innerHTML = ''; $('wlist').innerHTML = '<div class="wempty">loading...</div>'; if (host) send({ t: 'alerts' }); else renderWarnings(''); };
function fmtDur(ms) { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's'; const m = Math.round(s / 60); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
// ---- the warning history in the Sessions popup's design (11-02): a summary bar (the last 7 days, the red ones, the
// cell that warned most, a week strip split yellow and red) that opens like Sessions' to a period, one cell or all, a
// bar a day and each cell's share; under it a header per day and a block per row (a cell's crossings close together)
// that opens to each crossing and, when the page can get it, the reading around them with its lines. While the bar is
// open the list shows its period and cell; shut, all of the days kept ----
const fltSw = k => '<span class="gx-flt">Filter list<button class="tog2' + (S.listFilt[k] ? ' on' : '') + '" data-flt="' + k + '" aria-pressed="' + S.listFilt[k] + '" aria-label="Filter list"></button></span>';   // (the chart's window filters the list under it: his switch, off by default, 11-09)
const fltBack = (m, had) => { const n = m.querySelector('[data-flt]'); if (!n) return; if (motionMode() !== 'off') { const on = n.classList.contains('on'); n.classList.toggle('on', !on); void n.offsetWidth; n.classList.toggle('on', on); } if (had) n.focus({ preventScroll: true }); };   // (drawn again with its header: it slides from where it was, and keeps the focus a key gave it, 11-09)
const WX = { open: false, period: 7, cell: null, menu: false, slide: null, ws: 0, we: 0 };   // (slide: a pick's direction, -1 / 1, while it is drawn; ws, we: the window's time)
// (its window: the summary drawn again at once, the list under it once the window rests)
WX.W = mkWin({ min: () => Math.min(1, 3 / Math.max(1, WX.wn || 1)), draw: () => { if (!WX.open) return; wxSum(); if (!S.listFilt.w) return; clearTimeout(WX.lt); WX.lt = setTimeout(() => { if (WX.ws + '|' + WX.we === WX.lk) return; wShow = 300; wxList(); }, 250); } });   // (the list follows the window only with Filter list on, 11-09)   // (a press that moved nothing: the list stays, 11-08)
let wxEps = [];   // the crossings of the days kept, oldest first
const wxWait = new Map();   // a row's chart waiting for the host's history: key|range, the charts
// the log read into crossings, oldest first; each keeps its own lines (its start, red, peaks, back to normal) so a move
// to the bin or back takes exactly them (an app's start and stop marks are everyone's: they stay)
function wxParse(log, bin) {
  const open = Object.create(null), eps = [];   // (by name: a cell may be called "constructor")
  for (const line of (log || '').split(/\r?\n/)) {
    // times carry their UTC offset (so a summer-time change doesn't make durations negative); older lines don't
    const m0 = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)([+-]\d\d:\d\d)?\s+(YELLOW|RED|OK|MARK|PEAK)\s+(.+)$/);
    if (!m0) continue;
    const m = [m0[0], m0[1], m0[2], m0[4], m0[5]];
    const when = new Date(m[1] + 'T' + m[2] + (m0[3] || '')), rest = m[4].trim();
    // a MARK ends what was open: at its own time (app exit, HWiNFO stopped), or unknown (the next start after a crash)
    // (the bin: a mark of its own, set aside with the crossings it ended, goes back with them; the log's marks, read in
    // with it, stay where they are)
    if (m[3] === 'MARK') { const known = !/^app start/.test(rest), mine = bin && !(bin instanceof Set && bin.has(line)); for (const k in open) { open[k].end = known ? when : null; open[k].interrupted = true; open[k].cut = rest; if (mine) open[k].closer = line; delete open[k]; } continue; }
    if (m[3] === 'OK') {
      const name = rest.split(': back to normal')[0], ep = open[name];
      if (ep) { ep.end = when; const pk = rest.match(/peak ([^)]+)\)/); if (pk) ep.peak = pk[1]; if (!(bin instanceof Set && bin.has(line))) ep._raw.push(line); delete open[name]; }   // (the bin: the log's end of it ends it there, and stays)
      continue;
    }
    const cut = rest.lastIndexOf(': '), name = cut > 0 ? rest.slice(0, cut) : rest, detail = cut > 0 ? rest.slice(cut + 2) : '';
    // the peak so far of an episode the next MARK ends (logs from 1.0.0 have none)
    if (m[3] === 'PEAK') { if (open[name]) { open[name].peak = detail; open[name]._raw.push(line); } continue; }
    if (open[name]) { if (m[3] === 'RED') { open[name].level = 'RED'; open[name].redDetail = detail; if (!open[name].redAt) open[name].redAt = when; } open[name]._raw.push(line); continue; }
    const ep = { when, day: m[1], time: m[2].slice(0, 5), level: m[3], name, detail, end: null, peak: null, interrupted: false, _raw: [line] };
    open[name] = ep; eps.push(ep);
  }
  return eps;
}
let wxText = '';
function renderWarnings(log) {
  wxText = log || ''; if (PK.w.mode === 'bin') { if (wbText && !PK.w.wait) wbRender(wbText); return; }   // (the bin on show: the list waits for Back; the bin reads the log's marks)
  const eps = wxParse(log);
  const N = feed.warnDays, recent = N ? eps.filter(ep => ep.when.getTime() >= Date.now() - N * 86400000) : eps;   // (kept forever, or no days set: all of it)
  setText($('wdays'), N ? String(N) : 'all'); $('wlast').hidden = !N; $('wall').hidden = !!N;
  // (all of it: since its first day as the page has it, the newest 12 MB of the log)
  const w0 = eps.reduce((m, ep) => !m || ep.when < m ? ep.when : m, null);
  if (!N) setText($('wall'), w0 ? 'since ' + w0.getDate() + ' ' + GX_MON[w0.getMonth()] + (w0.getFullYear() !== new Date().getFullYear() ? ' ' + w0.getFullYear() : '') : 'since the log began');
  lastLogCount = recent.length;
  wxEps = recent; wEmptyN = N;   // (wShow kept: a move to the bin or an undo drew it back to 300 rows, 11-06; reset on open)
  if (WX.cell && !recent.some(ep => ep.name === WX.cell)) WX.cell = null;   // (its crossings all gone: all cells again)
  wxSum(true);
  wxList();
}
const wxNum = x => { const m = /^(-?[\d.]+)\s*(.*)$/.exec(x || ''); return m ? { v: parseFloat(m[1]), u: m[2].replace(/\s*\(.*$/, '') } : null; };   // (a -12V rail is negative)
// the worst of some crossings: the lowest for a line that warns below (the host marks those "(under its line)"; an older
// log is read off an episode whose peak went lower than its crossing), the furthest off for a curve, else the highest
function wxWorst(eps) {
  let pk = null;
  const low = eps.some(ep => /\(under its line\)/.test(ep.detail) || /% under its curve\)/.test(ep.detail) || (!/ fan curve$/.test(ep.name) && wxNum(ep.peak) && wxNum(ep.detail) && wxNum(ep.peak).v < wxNum(ep.detail).v));
  for (const ep of eps) { const c = wxNum(ep.peak) || wxNum(ep.redDetail) || wxNum(ep.detail); if (c && (!pk || (low ? c.v < pk.v : c.v > pk.v))) pk = c; }
  return pk;
}
// a row: one cell's crossings on one day, each within 10 minutes of the one before
function wxGroups(eps) {
  const groups = [], lastOf = Object.create(null);
  for (const ep of eps) {
    const g = lastOf[ep.name], prevEnd = g ? (g.end || g.last.when) : null;
    if (g && g.day === ep.day && ep.when - prevEnd <= 600000) { g.eps.push(ep); g.last = ep; if (ep.level === 'RED') g.level = 'RED'; g.end = ep.end; g.ongoing = !ep.end && !ep.interrupted; g.cut = ep.interrupted && !ep.end; }
    else { const ng = { name: ep.name, day: ep.day, first: ep, last: ep, eps: [ep], level: ep.level, end: ep.end, ongoing: !ep.end && !ep.interrupted, cut: ep.interrupted && !ep.end }; groups.push(ng); lastOf[ep.name] = ng; }
  }
  for (const g of groups) { g.peak = wxWorst(g.eps); g.dur = g.eps.reduce((p, ep) => p + (ep.end ? Math.max(0, ep.end - ep.when) : 0), 0); }
  return groups;
}
// a value in the warning log as words where it is a Yes/No reading (the log keeps "1 Yes/No", so peaks compare)
const wYN = x => x == null ? x : String(x).replace(/^(-?[\d.]+)\s*Yes\/No\b/, (m, v) => +v >= 0.5 ? 'Yes' : 'No');
let wGroups = [], wShow = 300, wEmptyN = 30;
// the periods (as far back as Keep warnings keeps: 7, 30 and 90 days under it, then the days kept, or all) and the
// first moment of the one picked
function wxPeriods() { const K = feed.warnDays || Infinity, o = [7, 30, 90].filter(q => q < K); o.push(K === Infinity ? 'all' : K); return o; }
function wxFrom() {
  const P = WX.period, td = new Date(), mine = WX.cell ? wxEps.filter(ep => ep.name === WX.cell) : wxEps, f0 = mine.length ? mine[0].when : td;   // (All with a cell picked: from its first, 11-07)
  return P === 'all' ? gxMid(f0.getFullYear(), f0.getMonth(), f0.getDate()) : gxMid(td.getFullYear(), td.getMonth(), td.getDate() - (P - 1));
}
// the crossings the list shows: the open bar's period and cell, or all of them
function wxShown() { if (!WX.open) return wxEps; if (!S.listFilt.w) return WX.cell ? wxEps.filter(ep => ep.name === WX.cell) : wxEps; const a = WX.ws ? WX.ws * 1000 : wxFrom() * 1000, b = WX.we ? WX.we * 1000 : Infinity; return wxEps.filter(ep => ep.when.getTime() >= a && ep.when.getTime() < b && (!WX.cell || ep.name === WX.cell)); }
// the cells in the cell list's order: all of them first, then the ones that warned most (a pick's side goes by it)
function wxCellOrder() { const n = Object.create(null); for (const ep of wxEps) n[ep.name] = (n[ep.name] || 0) + 1; return [null].concat(Object.keys(n).sort((p, q) => n[q] - n[p])); }
// the week's numbers and strip (wsum), or the bar opened
function wxSum(live) {
  const gs = $('wsum');
  if (!wxEps.length) { WX.open = false; WX.cell = null; if (gs.firstChild) gs.innerHTML = ''; return; }
  // the week: today and the 6 days before, each day's crossings split yellow and red (one that went red counts red)
  const td = new Date(), days = []; for (let i = 6; i >= 0; i--) days.push(new Date(td.getFullYear(), td.getMonth(), td.getDate() - i));
  const wk7 = wxEps.filter(ep => ep.when >= days[0]), cnt = Object.create(null), red = Object.create(null);   // (by name: a cell may be called "constructor")
  for (const ep of wk7) { cnt[ep.name] = (cnt[ep.name] || 0) + 1; if (ep.level === 'RED') red[ep.name] = (red[ep.name] || 0) + 1; }
  const top = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0], topR = Object.keys(red).sort((a, b) => red[b] - red[a])[0], nR = wk7.filter(ep => ep.level === 'RED').length;
  const per = days.map(d => { const k = localDay(d), on = wk7.filter(ep => localDay(ep.when) === k), r = on.filter(ep => ep.level === 'RED').length; return [on.length - r, r]; });
  const peak = Math.max(4, ...per.map(p => p[0] + p[1]));
  const wk = days.map((d, i) => { const [y, r] = per[i], n = y + r; return '<span class="gx-wd' + (i === 6 ? ' today' : '') + '" title="' + (n ? [y ? y + ' yellow' : '', r ? r + ' red' : ''].filter(Boolean).join(', ') : 'nothing') + '"><i' + (n ? '' : ' class="z"') + ' style="height:' + (n ? Math.max(4, Math.round(n / peak * 22)) : 2) + 'px">' +
    (y ? '<b style="flex:' + y + '"></b>' : '') + (r ? '<b class="r" style="flex:' + r + '"></b>' : '') + '</i><em>' + GX_WD[d.getDay()][0].toUpperCase() + '</em></span>'; }).join('');
  let box = gs.querySelector(':scope > .gx-sum');
  if (!box) {
    gs.innerHTML = '<div class="gx-sum"><div class="gx-srow" role="button" tabindex="-1" aria-expanded="false"></div><div class="gx-sdet"><div><div class="gx-sdin"><div class="gx-xh"></div><div class="gx-xb"></div></div></div></div></div>';
    box = gs.firstChild;
  }
  const row = GX_CHEV + '<div class="gx-sumtxt">' +
    '<div class="gx-stat"><em>last 7 days</em><b>' + wk7.length + '<small>' + (wk7.length === 1 ? 'warning' : 'warnings') + '</small></b></div>' +
    '<div class="gx-stat"><em>red</em><b>' + nR + (topR ? '<small>' + esc(topR) + '</small>' : '') + '</b></div>' +
    (top ? '<div class="gx-stat"><em>most often</em><b>' + esc(top) + '<small>' + plural(cnt[top], 'time') + '</small></b></div>' : '') +
    '</div><div class="gx-week wx-wk">' + wk + '</div>';
  // (written only when they changed, and a new log's redraw waits while text in them is picked)
  const sl = live && getSelection(), held = sl && sl.rangeCount && !sl.isCollapsed && sl.getRangeAt(0).intersectsNode(gs);
  const rw = box.firstChild;
  if (rw._h !== row && !held) { rw.innerHTML = row; rw._h = row; }
  // (a new log waits while the pointer is on what opened or its cell list is open: a list's scroll would go with it)
  const busy = live && (WX.menu || !!gs.querySelector('.gx-sdet:hover'));
  WX.sumStale = WX.open && (!!held || busy);   // (held back: drawn once the pointer leaves, 11-06)
  if (WX.open && !held && !busy) {
    const o = wxSumOpen(), hd = box.querySelector('.gx-xh'), bd = box.querySelector('.gx-xb'), det = box.querySelector('.gx-sdet');
    const slide = WX.slide && box.classList.contains('open') && motionMode() !== 'off' ? WX.slide : 0;   // (a pick in the open bar)
    if (hd._h !== o.head) {
      const i0 = hd.querySelector('.gx-per .ind'), was = i0 ? { x: i0.style.transform, w: i0.style.width } : null;
      hd.innerHTML = o.head; hd._h = o.head;
      gxPill(hd, slide ? was : null);
    }
    if (bd._h !== o.body) {
      const h0 = slide ? det.offsetHeight : 0;
      if (slide) bd.innerHTML = o.body; else sumPatch(bd, o.body, box.classList.contains('open') && motionMode() !== 'off' && (!live || motionOn()));   // (as Sessions' bar, 11-08)
      bd._h = o.body;
      if (slide) {
        const e = 'cubic-bezier(0.2, 0.8, 0.2, 1)', h1 = det.offsetHeight;
        bd.animate([{ transform: 'translateX(' + (slide * 3) + '%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: e });
        if (Math.abs(h1 - h0) > 1) det.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 300, easing: e });
      }
    }
  }
  if (box.classList.contains('open') !== WX.open) { if (WX.open) void box.offsetHeight; box.classList.toggle('open', WX.open); }
  const srw = box.querySelector('.gx-srow'); if (srw) srw.setAttribute('aria-expanded', WX.open);
}
// the bar opened: the cell list and the periods, a bar a day (a week past 120 days) split yellow and red with the
// average dashed, and each cell's part of the period (a row picks that cell; again: all cells)
function wxSumOpen() {
  const ps = wxPeriods(); if (!ps.includes(WX.period)) WX.period = ps.includes(7) ? 7 : ps[0];
  const a = wxFrom(), a0 = new Date(a * 1000), td = new Date();
  const nd = Math.max(1, Math.round((gxMid(td.getFullYear(), td.getMonth(), td.getDate() + 1) - a) / 86400));
  // the window (B): its points (days, weeks past 120 days) and its time
  const n0 = nd > 120 ? Math.ceil(nd / 7) : nd, per7 = nd > 120 ? 7 : 1;
  { const k = WX.period + '|' + a + '|' + n0; if (WX.wkey !== k) { WX.W.reset(); WX.wkey = k; } }
  WX.wn = n0;
  const tAt = f => { const k = f * n0, i = Math.min(n0 - 1, Math.floor(k)), d0 = i * per7, len = Math.min(per7, nd - d0), s0 = gxMid(a0.getFullYear(), a0.getMonth(), a0.getDate() + d0), s1 = gxMid(a0.getFullYear(), a0.getMonth(), a0.getDate() + d0 + len); return s0 + (k - i) * (s1 - s0); };   // (between midnights: a 23 or 25 hour day keeps its end)
  const wa = WX.W.a, wb = WX.W.b; WX.ws = tAt(wa); WX.we = tAt(wb);
  const inA = wxEps.filter(ep => ep.when.getTime() >= a * 1000), mine = WX.cell ? inA.filter(ep => ep.name === WX.cell) : inA;
  const inP = inA.filter(ep => ep.when.getTime() >= WX.ws * 1000 && ep.when.getTime() < WX.we * 1000);   // (the table: the window's)
  let menu = '';
  if (WX.menu) {
    const n = Object.create(null); for (const ep of wxEps) n[ep.name] = (n[ep.name] || 0) + 1;
    const cl = Object.keys(n).sort((p, q) => n[q] - n[p]);
    menu = '<div class="smenu gx-menu"><button data-cell=""' + (WX.cell ? ' aria-pressed="false"' : ' class="on" aria-pressed="true"') + '>All cells<small>' + plural(cl.length, 'cell') + '</small></button><div class="gx-msep"></div>' +
      cl.map(k => '<button data-cell="' + esc(k) + '"' + (k === WX.cell ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + esc(k) + '<small>' + plural(n[k], 'time') + '</small></button>').join('') + '</div>';
  }
  const head = perSlider(ps, WX.period) + fltSw('w') +
    '<span class="gx-ddw"><button class="gx-dd' + (WX.menu ? ' on' : '') + '" title="Show one cell" aria-haspopup="true" aria-expanded="' + !!WX.menu + '">' + (WX.cell ? esc(WX.cell) : 'All cells') + GX_CHEV + '</button>' + menu + '</span>';   // (as Sessions', 11-07)
  // the chart: crossings a day (a week past 120 days), yellow under red, the count on the left, the average on the right
  const keyAt = {}, days = [];
  for (let i = 0; i < nd; i++) { const d = new Date(a0.getFullYear(), a0.getMonth(), a0.getDate() + i); keyAt[localDay(d)] = i; days.push({ d, y: 0, r: 0 }); }
  for (const ep of mine) { const i = keyAt[localDay(ep.when)]; if (i !== undefined) days[i][ep.level === 'RED' ? 'r' : 'y']++; }
  let pts = days.map(o => Object.assign({ w: 0 }, o));
  if (nd > 120) { pts = []; for (let i = 0; i < nd; i += 7) { const wk = days.slice(i, i + 7); pts.push({ d: wk[0].d, w: wk.length, y: wk.reduce((p, o) => p + o.y, 0), r: wk.reduce((p, o) => p + o.r, 0) }); } }
  const n = pts.length, j0 = Math.max(0, Math.floor(wa * n + 1e-9)), j1 = Math.min(n - 1, Math.ceil(wb * n - 1e-9) - 1), vis = pts.slice(j0, j1 + 1), nv = vis.length;
  const H = 120, mx = Math.max(...vis.map(o => o.y + o.r)), ymT = Math.max(2, Math.ceil(mx / 2) * 2), ymax = sumYm(WX, WX.wkey, ymT, () => { if (WX.open) wxSum(true); }), Y = v => +(H - v / ymax * H).toFixed(1), X = i => +(((i + 0.5) / n - wa) / (wb - wa) * 100).toFixed(3);
  const avg = vis.reduce((p, o) => p + o.y + o.r, 0) / Math.max(1, nv);
  const lab = o => o.w ? 'week of ' + o.d.getDate() + ' ' + GX_MON[o.d.getMonth()] : GX_WD[o.d.getDay()] + ' ' + o.d.getDate() + ' ' + GX_MON[o.d.getMonth()];
  const bars = pts.map(o => { const t = o.y + o.r; return '<div class="wx-b' + (t ? '' : ' z') + '"' + (t ? ' style="height:' + (t / ymax * 100).toFixed(2) + '%"' : '') + ' title="' + lab(o) + ': ' + (t ? [o.y ? o.y + ' yellow' : '', o.r ? o.r + ' red' : ''].filter(Boolean).join(', ') : 'nothing') + '">' +
    (o.y ? '<b style="flex:' + o.y + '"></b>' : '') + (o.r ? '<b class="r" style="flex:' + o.r + '"></b>' : '') + '</div>'; }).join('');
  let h = '<div class="gx-lc"><div class="gx-lcg"><div class="gx-lcy" style="height:' + H + 'px">' + [0, ymT / 2, ymT].map((v, i) => '<span style="top:' + (H - i * H / 2) + 'px">' + v + '</span>').join('') + '</div>' +
    '<div class="wx-plot" style="height:' + H + 'px"><div class="wx-clip"><div class="wx-bars" style="--n:' + n + ';width:' + (100 / (wb - wa)).toFixed(3) + '%;left:' + (-wa / (wb - wa) * 100).toFixed(3) + '%">' + bars + '</div></div>' +
    (avg ? '<i class="wx-av" style="top:' + Y(avg) + 'px"></i><span class="gx-lca" style="top:' + Y(avg) + 'px">avg ' + (Math.round(avg * 10) / 10) + (nd > 120 ? '/wk' : '') + '</span>' : '') + '</div><span></span></div>';
  const end = wb > 0.999 && nv > 7 && !pts[n - 1].w, xl = (o, i) => nv <= 7 ? GX_WD[o.d.getDay()].slice(0, 3) : o.w ? (o.d.getDate() <= 7 && (!end || i < j1 - 1) ? GX_MON[o.d.getMonth()] : '') : (o.d.getDay() === 1 && (!end || i < j1 - 3) ? o.d.getDate() + ' ' + GX_MON[o.d.getMonth()] : '');
  h += '<div class="gx-lcg"><span></span><div class="gx-lcx">' + vis.map((o, k) => { const i = j0 + k, t = xl(o, i), x = X(i); return t && x >= -0.01 && x <= 100.01 ? '<span style="left:' + x + '%">' + t + '</span>' : ''; }).join('') + (end ? '<span class="e">today</span>' : '') + '</div><span></span></div>' +
    '<div class="gx-lcg"><span></span>' + winBarHtml(winBarParts(WX.W, a * 1000, tAt(1) * 1000, d => dMon(d), 'today', f => tAt(f) * 1000), winDrag && winDrag.W === WX.W && winDrag.kind !== 'pan') + '<span></span></div></div>';
  // each cell's part of the window, most first: its crossings, the red ones, its worst, its last
  const per = Object.create(null);
  for (const ep of inP) { const o = per[ep.name] || (per[ep.name] = { eps: [], r: 0, last: ep.when }); o.eps.push(ep); if (ep.level === 'RED') o.r++; if (ep.when > o.last) o.last = ep.when; }
  const names = sumHold(WX, Object.keys(per).sort((p, q) => per[q].eps.length - per[p].eps.length)), sum = inP.length || 1;
  const ago = d => { const k = Math.round((gxMid(td.getFullYear(), td.getMonth(), td.getDate()) - gxMid(d.getFullYear(), d.getMonth(), d.getDate())) / 86400); return k <= 0 ? 'today' : k === 1 ? 'yesterday' : k + ' days ago'; };
  if (names.length) h += '<div class="gx-gtab"><div class="gx-gh"><span>cell</span><span>share of the warnings</span><span class="gx-r">times</span><span class="gx-r">red</span><span class="gx-r">worst</span><span class="gx-r">last</span></div>' +
    names.map(k => { const o = per[k], pk = wxWorst(o.eps); return '<div class="gx-gr' + (k === WX.cell ? ' on' : '') + '" data-cell="' + esc(k) + '" role="button" tabindex="-1" aria-pressed="' + (k === WX.cell) + '"><span class="gx-gnm">' + esc(k) + '</span><span class="gx-gbar"><span style="width:' + (o.eps.length / sum * 100).toFixed(1) + '%' + wxBarTint(k) + '"></span></span>' +
      '<span class="gx-r">' + o.eps.length + '</span><span class="gx-r">' + (o.r || '--') + '</span><span class="gx-r">' + (pk ? esc(wYN(pk.v + ' ' + pk.u)) : '--') + '</span><span class="gx-r gx-ago">' + ago(o.last) + '</span></div>'; }).join('') + '</div>';
  return { head, body: h };
}
// the bar opened or shut, a period, a cell: the summary drawn again and the list with it; a pick slides in from its
// side (a later period or cell from the right, an earlier one from the left)
function wxSet(o) {
  const c0 = WX.cell, p0 = WX.period, w0 = WX.ws + '|' + WX.we, was = WX.open; Object.assign(WX, o); if (!WX.open) { WX.cell = null; WX.menu = false; }
  if (was && WX.open) {
    const ps = wxPeriods(), order = wxCellOrder();
    WX.slide = WX.period !== p0 ? Math.sign(ps.indexOf(WX.period) - ps.indexOf(p0)) || 1 : WX.cell !== c0 ? Math.sign(order.indexOf(WX.cell) - order.indexOf(c0)) || 1 : null;
  }
  try {
    flipHold++; wxSum();
    if (S.listFilt.w ? WX.open !== was || WX.cell !== c0 || (WX.open && WX.period !== p0) : WX.cell !== c0) {   // (Filter list off: only a cell picked changes the list)
      wShow = 300; wxList();
      if (WX.slide && motionMode() !== 'off') $('wlist').animate([{ transform: 'translateX(' + (WX.slide * 3) + '%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      else if (WX.open !== was && motionMode() !== 'off') $('wlist').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: SUM_E });   // (the bar opened or shut: the list fades to what it shows now, 11-08)
    }
  } finally { flipHold--; WX.slide = null; }
}
// the list drawn again from the crossings shown (rows that were open stay open)
function wxList() {
  WX.lk = WX.ws + '|' + WX.we;
  const keep = new Set([...$('wlist').querySelectorAll('.gx-sess.open')].map(el => el.dataset.k));
  wGroups = wxGroups(wxShown()).reverse();   // (newest first)
  drawWarnList(keep);
}
// the cell a row is about, in the view: by the name the log has (a fan's curve adds " fan curve", the 12V-2x6
// connector's uneven pins " pins"); null when the view has no cell by that name
let wxCellAt = null;
function wxCell(name) {
  // (the cells that warn, with lines or a curve, first; a name two of them share could be either: none. Then any cell,
  // for one whose lines went since)
  if (!wxCellAt) {
    wxCellAt = new Map(); const any = new Map();
    for (const id in S.L.cells) { const c = S.L.cells[id], n = cellName(c); if (gatesOn(c.gates) || c.curve) wxCellAt.set(n, wxCellAt.has(n) ? null : id); else if (!any.has(n)) any.set(n, id); }
    for (const [n, id] of any) if (!wxCellAt.has(n)) wxCellAt.set(n, id);
  }
  const at = n => wxCellAt.get(n);
  if (at(name)) return { cid: at(name) };
  if (/ fan curve$/.test(name) && at(name.slice(0, -10))) return { cid: at(name.slice(0, -10)), curve: true };
  if (/ pins$/.test(name) && at(name.slice(0, -5))) return { cid: at(name.slice(0, -5)), pins: true };
  return null;
}
// the lines a row crossed: its cell's as they are now, on the side it crossed; else what the log says
function wxLines(g, w) {
  if (w && w.curve) return 'its fan curve';
  if (w && w.pins) return 'a pin over 1.5x its share';
  const c = w && S.L.cells[w.cid], r = c && c.key ? BYKEY.get(c.key) : null, under = g.eps.some(ep => /\(under its line\)/.test(ep.detail));
  if (c && gatesOn(c.gates)) {
    const gl = gateLines(c.gates), main = gl.below === under, y = main ? gl.y : gl.y2, rr = main ? gl.r : gl.r2;   // (the side it crossed: the main lines, or the other side's)
    const k = gbK(r), dec = decOfCell(c, r), u = unitOf(r), v = x => lnTxt(x * k, dec, r, under) + (u ? ' ' + u : '');
    const t = [y !== undefined ? 'yellow ' + v(y) : '', rr !== undefined ? 'red ' + v(rr) : ''].filter(Boolean).join(', ');
    if (t) return (under ? 'under ' : '') + t;
  }
  const at = String(g.first.detail || '').replace(/\s*\(.*$/, '');
  return at ? 'crossed at ' + wYN(at) : '--';
}
// a day's header: its name and date, and how many crossings it had (shown or further down)
function wxDayHd(dk, n, today, yest, unit) {
  const [yy, mm, dd] = dk.split('-').map(Number), d = new Date(yy, mm - 1, dd);
  const name = dk === today ? 'today' : dk === yest ? 'yesterday' : Date.now() / 1000 - d.getTime() / 1000 < 6 * 86400 ? GX_WD[d.getDay()] : '';
  const date = (name && name !== 'today' && name !== 'yesterday' ? '' : GX_WD[d.getDay()].slice(0, 3) + ' ') + d.getDate() + ' ' + GX_MON[d.getMonth()];   // "thursday 8 oct", "yesterday sat 10 oct"
  return '<div class="gx-day"><div>' + (name ? name + '<span>' + date + '</span>' : date) + '</div><div class="gx-tot">' + plural(n, unit || 'warning') + '</div></div>';
}
// a row: the cell, from when to when, its peak in its level's colour, how long it lasted, how many times, the lines it
// crossed, its level; what opens under it is drawn the first time it opens (a big log had 100,000+ hidden rows)
function wxRow(g, gi, bin) {
  const lv = g.level === 'RED' ? 'r' : 'y', w = wxCell(g.name), many = g.eps.length > 1;
  const hm = d => ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2), endT = g.end ? hm(g.end) : null;
  const when = g.first.time + (g.ongoing ? ' to now' : endT && endT !== g.first.time ? ' to ' + endT : '');
  const lasted = g.ongoing ? 'ongoing' : g.dur ? fmtDur(g.dur) : '--', lt = g.cut ? ' title="Until the app stopped"' : '';
  const tc = w ? cellTint(w.cid) : null;   // (Spectrum: a dot in its cell's colour)
  return '<div class="gx-sess" data-g="' + gi + '" data-k="' + esc(g.name + '|' + g.first.when.getTime()) + '"' + (tc ? ' style="--cc:' + tc + '"' : '') + '><div class="gx-row" role="button" tabindex="-1" aria-expanded="false">' + GX_CHEV +
    '<span class="gx-gm"><span class="gx-gn">' + esc(g.name) + '</span><span class="gx-sub">' + when + '</span></span>' +
    '<span class="gx-c gx-num"><span class="wx-pk ' + lv + '">' + (g.peak ? esc(wYN(g.peak.v + ' ' + g.peak.u)) : '--') + '</span></span>' +
    '<span class="gx-c gx-num"' + lt + '>' + lasted + '</span><span class="gx-c gx-num wx-x">' + (many ? g.eps.length + 'x' : '1') + '</span>' +
    '<span class="gx-c"><span class="wx-ln">' + esc(wxLines(g, w)) + '</span></span>' +
    '<span class="gx-c gx-st"><span class="wx-lv' + (lv === 'r' ? ' r' : '') + '"><i></i>' + (lv === 'r' ? 'red' : 'yellow') + '</span></span>' + (bin ? PK_PURGE : '') + '</div>' +
    '<div class="gx-det"><div><div class="gx-in"></div></div></div></div>';
}
function drawWarnList(keep) {
  wxCellAt = null;   // (the view's cells as they are now)
  const today = localDay(new Date()), y = new Date(); y.setDate(y.getDate() - 1); const yest = localDay(y);
  const byDay = {}; for (const g of wGroups) byDay[g.day] = (byDay[g.day] || 0) + g.eps.length;
  let hh = '', lastDay = null;
  wGroups.slice(0, wShow).forEach((g, gi) => { if (g.day !== lastDay) { lastDay = g.day; hh += wxDayHd(g.day, byDay[g.day], today, yest); } hh += wxRow(g, gi); });
  if (wGroups.length > wShow) hh += '<button class="linkbtn wmore" id="wMore">Show ' + plural(wGroups.length - wShow, 'older row') + '</button>';
  // (an open row's chart goes with it into the new list, 11-08: no lost chart, no jump, no second ask)
  const carry = new Map(); for (const el of $('wlist').querySelectorAll('.gx-sess.open')) { const c = el.querySelector('.wx-ch'); if (c && keep && keep.has(el.dataset.k) && c.querySelector('.wx-tl')) carry.set(el.dataset.k, c); }
  const kept = new Set([...carry.values()].map(c => String(c._wx)));
  for (const k in WXC) if (!kept.has(k)) delete WXC[k];   // (the charts of the list it replaces: they stayed for the whole run, 11-06)
  const lf = WX.open && S.listFilt.w, list = $('wlist'), nd = lf ? (WX.period === 'all' ? 0 : WX.period) : wEmptyN, win = lf && !WX.W.whole() && WX.we > WX.ws;   // (a window of the period: its dates, B)
  const fl = listTops(list);
  list.innerHTML = hh ? '<div class="gx-cols"><span></span><span>warning</span><span class="gx-r">peak</span><span class="gx-r">lasted</span><span class="gx-r">times</span><span>its lines</span><span class="gx-r">level</span></div>' + hh
                      : '<div class="wempty ico chk">Nothing crossed a line' + (win ? ' from ' + dMon(new Date(WX.ws * 1000)) + ' to ' + dMon(new Date(WX.we * 1000 - 1)) : nd ? ' in the last ' + nd + ' days' : '') + (WX.open && WX.cell ? ' for ' + esc(WX.cell) : '') + '. Quiet machine.</div>';
  if (keep && keep.size) {   // (drawn again: what was open stays open, at once)
    list.classList.add('still');
    for (const el of list.querySelectorAll('.gx-sess')) if (keep.has(el.dataset.k)) { wxFill(el, wGroups[+el.dataset.g], carry.get(el.dataset.k)); el.classList.add('open'); const rw = el.querySelector('.gx-row'); if (rw) rw.setAttribute('aria-expanded', 'true'); }
    void list.offsetHeight; list.classList.remove('still');
  }
  listGlide(list, fl); pkMark('w');
}
// what opens under a row: the reading around it (when its cell is in the view and the history reaches that far), then
// each crossing: when, its level, what it crossed at, how long, how it ended, its peak
function wxFill(el, g, old) {
  if (!el || !g || el._f) return; el._f = true;
  const w = wxCell(g.name), c = w && !w.pins ? S.L.cells[w.cid] : null;
  const how = ep => ep.interrupted ? (/^HWiNFO/.test(ep.cut || '') ? 'HWiNFO stopped sharing' : /^PC going to sleep/.test(ep.cut || '') ? 'PC went to sleep' : 'ended with the app') : ep.end ? 'back to normal' : 'ongoing';
  const rows = g.eps.map(ep => {
    const red = ep.level === 'RED', at = String(ep.redDetail || ep.detail || '').replace(/\s*\((over|under) its line\)/, '').replace(/\s*\((\d+% (?:under|over) its curve)\)/, ', $1');
    const o = [ep.end ? fmtDur(ep.end - ep.when) : '', how(ep), ep.peak ? 'peak ' + wYN(ep.peak) : ''].filter(Boolean).join(', ');
    return '<div class="wx-ep"><span class="t">' + ep.time + '</span><span class="wx-lv' + (red ? ' r' : '') + '"><i></i>' + (red ? 'red' : 'yellow') + '</span><span class="v">' + (at ? 'at ' + esc(wYN(at)) : '') + '</span><span class="o">' + esc(o) + '</span></div>';
  }).join('');
  el.querySelector('.gx-in').innerHTML = (c && c.key && host ? '<div class="wx-ch ld"></div>' : '') + '<div class="wx-eps">' + rows + '</div>';
  const ch = el.querySelector('.wx-ch'); if (ch) { if (old) ch.replaceWith(old); else wxAsk(ch, g, w); }
}
// (the chart in: from the room held for it to its own height, eased; no chart after all: it folds away, 11-08)
function wxChEase(ch, h0) {
  const h1 = ch.offsetHeight; if (motionMode() === 'off' || !ch.offsetParent || Math.abs(h1 - h0) < 1) return;
  ch.style.overflow = 'hidden'; ch.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 300, easing: SUM_E }).onfinish = () => { ch.style.overflow = ''; };
}
function wxChGone(ch) {
  if (motionMode() === 'off' || !ch.offsetParent) { ch.remove(); return; }
  const cs = getComputedStyle(ch); ch.style.overflow = 'hidden';
  ch.animate([{ height: cs.height, minHeight: cs.minHeight, marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: 1 }, { height: '0px', minHeight: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }], { duration: 260, easing: SUM_E }).onfinish = () => ch.remove();
}
// its history from the host: the smallest range that reaches back to it (1 h, 6 h, 12 h, 24 h of minutes, 7 days of 10
// minutes); older than that, no chart
function wxAsk(ch, g, w) {
  const c = S.L.cells[w.cid], now = Date.now() / 1000, s = g.first.when.getTime() / 1000;
  const e = g.end ? g.end.getTime() / 1000 : g.ongoing ? now : g.last.when.getTime() / 1000 + 60;
  // (around it: at least 10 minutes and 8 of the range's points each side, more for a long one; 11-02, his "the time
  // window is too short, the graph looks weird": 5 minutes was 5 points of a minute, or half a point of ten)
  let range = null, a = 0, b = 0;
  for (const [rg, span, step] of [['1h', 3600, 60], ['6h', 6 * 3600, 60], ['12h', 12 * 3600, 60], ['24h', 86400, 60], ['7d', 7 * 86400, 600]]) {
    const pad = Math.max(600, (e - s) * 0.5, 8 * step);
    if (now - (s - pad) <= span) { range = rg; a = s - pad; b = Math.min(now, e + pad); break; }
  }
  if (!range) { ch.remove(); return; }
  const k = c.key + '|' + range, o = { ch, g, w, a, b }, ws = wxWait.get(k);
  if (ws) ws.push(o); else { wxWait.set(k, [o]); send({ t: 'hist', key: c.key, range }); }
}
// the host's history in (onHost's 'hist'): the charts waiting for it drawn; true when only they wanted it (the cell
// popup asking for the same key and range gets it too)
function wxTake(m) {
  const k = m.key + '|' + m.range, ws = wxWait.get(k); if (!ws) return false;
  wxWait.delete(k);
  for (const o of ws) if (o.ch.isConnected) wxChart(o, m);
  const c = modalCid != null ? cellAt(modalCid) : null;
  return !(c && histKey(c) === m.key && bigRange === m.range);
}
// a row's chart, the session chart's look (11-02, his "copy the game sessions"): its reading over the minutes around it
// (1-minute peaks, the averages for a line that warns below; 10-minute ones at 7 days), its lines dashed, the time over
// them shaded, round steps on the right, clock ticks under it, a legend, and the minute under the pointer read out
const WXC = {}; let wxN = 0, wxHz = null;
function wxChart(o, m) {
  const { ch, g, w, a, b } = o, c = S.L.cells[w.cid];
  if (!c || !Array.isArray(m.avg) || !Array.isArray(m.max)) { wxChGone(ch); return; }
  const r = BYKEY.get(c.key), under = g.eps.some(ep => /\(under its line\)/.test(ep.detail)), src = under ? m.avg : m.max, n = src.length, t0 = m.end - (n - 1) * m.step;
  const pts = [];
  for (let i = 0; i < n; i++) { const t = t0 + i * m.step; if (t + m.step <= a || t > b) continue; const v = src[i]; pts.push([t, v == null || !isFinite(v) ? null : +v]); }
  const vs = pts.filter(p => p[1] !== null); if (vs.length < 2) { wxChGone(ch); return; }
  const gl = w.curve || !gatesOn(c.gates) ? {} : gateLines(c.gates), lines = [], side = (y, rr) => { if (y !== undefined) lines.push([y, 'y']); if (rr !== undefined) lines.push([rr, 'r']); };
  if (gl.below === under) side(gl.y, gl.r); else side(gl.y2, gl.r2);
  const k = gbK(r), dec = decOfCell(c, r), u = unitOf(r), val = x => lnTxt(x * k, dec, r, under) + (u ? ' ' + u : ''), name = cellName(c);
  // (round steps, about 4 of them, like the session chart's, from a little under the lowest to a little over the highest)
  const all = vs.map(p => p[1]).concat(lines.map(l => l[0])), mn = Math.min(...all), mx = Math.max(...all), span = mx - mn || Math.abs(mx) * 0.1 || 1;
  const raw = span * 1.25 / 4, pw = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(s => s * pw).find(s => s >= raw);
  let lo = Math.floor((mn - span * 0.08) / step) * step, top = Math.ceil((mx + span * 0.08) / step) * step;
  if (mn >= 0) lo = Math.max(0, lo);
  if (top - lo < 2 * step) { top += step; if (lo - step >= 0 || mn < 0) lo -= step; }
  const N = pts.length, Wd = N * 10, H = 140, A = pts[0][0], B = A + N * m.step, now = Date.now() / 1000;
  const X = i => ((i + 0.5) * 10).toFixed(1), XT = t => ((t - A) / (B - A) * Wd).toFixed(1), Y = v => (H - (Math.max(lo, Math.min(top, v)) - lo) / (top - lo) * H).toFixed(1);
  let grid = '', yl = '';
  for (let v = lo; v <= top + 1e-9; v += step) { grid += '<line x1="0" x2="' + Wd + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/>'; yl += '<span style="top:' + (+Y(v) / H * 100).toFixed(2) + '%">' + esc(lnTxt(v * k, dec, r, false)) + '</span>'; }
  let sh = '';
  for (const ep of g.eps) { const s = Math.max(A, ep.when.getTime() / 1000), e = Math.min(B, ep.end ? ep.end.getTime() / 1000 : ep.interrupted ? s : now); if (e > s) sh += '<rect class="w' + (ep.level === 'RED' ? 'r' : 'y') + '" x="' + XT(s) + '" y="0" width="' + Math.max(2, XT(e) - XT(s)).toFixed(1) + '" height="' + H + '"/>'; }
  const lns = lines.map(([v, l]) => '<line class="w' + l + '" x1="0" x2="' + Wd + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/>').join('');
  // (runs of minutes with a value; one on its own between gaps a short dash)
  let ln = '', run = [];
  const flush = () => { if (run.length > 1) ln += '<polyline class="fp" points="' + run.map(i => X(i) + ',' + Y(pts[i][1])).join(' ') + '"/>'; else if (run.length === 1) ln += '<polyline class="fp" points="' + (+X(run[0]) - 3) + ',' + Y(pts[run[0]][1]) + ' ' + (+X(run[0]) + 3) + ',' + Y(pts[run[0]][1]) + '"/>'; run = []; };
  pts.forEach((p, i) => { if (p[1] === null) flush(); else run.push(i); }); flush();
  // (clock ticks: its ends, and the round minutes between them, as the session chart has them)
  const spanM = (B - A) / 60, every = spanM > 960 ? 180 : spanM > 480 ? 60 : spanM > 90 ? 30 : spanM > 40 ? 15 : spanM > 15 ? 5 : 1, tz = new Date(A * 1000).getTimezoneOffset() * 60;
  let tk = '<span class="e0">' + hhmm(A) + '</span>';
  for (let t = Math.ceil((A - tz) / 60 / every) * every * 60 + tz; t < B; t += every * 60) { const pc = (t - A) / (B - A) * 100; if (pc > 9 && pc < 91 && hhmm(t) !== hhmm(B)) tk += '<span style="left:' + pc.toFixed(2) + '%">' + hhmm(t) + '</span>'; }
  tk += '<span class="e1">' + hhmm(B) + '</span>';
  const h0 = ch.offsetHeight, id = ch._wx || (ch._wx = ++wxN);
  WXC[id] = { pts, step: m.step, lo, top, lines, under, val, name, yn: isYN(r) };
  const fc = cellTint(w.cid);
  ch.innerHTML = '<div class="gx-tl wx-tl" data-w="' + id + '"' + (fc ? ' style="--fc:' + fc + '"' : '') + '><div class="gx-ch">' + esc(name) + '<span>' + (m.step === 600 ? '10-minute' : '1-minute') + (under ? ' averages' : ' peaks') + ', the time over its lines shaded</span></div>' +
    '<div class="gx-hz wx-hz"><div class="gx-tr f"><span class="l">' + esc(u || 'value') + '</span><span class="gx-plot"><svg class="gx-fpsc" viewBox="0 0 ' + Wd + ' ' + H + '" preserveAspectRatio="none">' + grid + sh + lns + ln + '</svg><i class="gx-gd"></i><i class="gx-dot fp"></i></span><span class="gx-yax">' + yl + '</span></div><div class="gx-tip"></div></div>' +
    '<div class="gx-tr"><span></span><span class="gx-ticks">' + tk + '</span><span></span></div>' +
    '<div class="gx-tr"><span></span><span class="gx-leg"><span><b class="ln fp"></b>' + esc(name) + '</span>' + lines.map(([v, l]) => '<span><b class="wl ' + l + '"></b>' + (l === 'r' ? 'red' : 'yellow') + ' <i>' + esc(val(v)) + '</i></span>').join('') +
    (sh ? '<span><b class="wsh"></b>over the line</span>' : '') + '</span><span></span></div></div>';
  ch.classList.remove('ld'); wxChEase(ch, h0);
}
// the hover read-out: the minute under the pointer, its guide and dot, its value and whether it was past a line
function wxHover(hz, e) {
  if (wxHz && wxHz !== hz) wxHz.classList.remove('hv');
  wxHz = hz; if (!hz) return;
  const T = WXC[hz.closest('.wx-tl').dataset.w], plot = hz.querySelector('.gx-plot'); if (!T || !plot) return;
  const pr = plot.getBoundingClientRect(), f = (e.clientX - pr.left) / Math.max(1, pr.width);
  if (f < 0 || f > 1) { hz.classList.remove('hv'); return; }
  const N = T.pts.length, i = Math.max(0, Math.min(N - 1, Math.floor(f * N))), at = ((i + 0.5) / N * 100).toFixed(3) + '%', t = T.pts[i][0], raw = T.pts[i][1], v = raw === null && T.yn ? 0 : raw;   // (a Yes/No reading's empty minute: No; past no line, 11-06 audit)
  hz.querySelector('.gx-gd').style.left = at;
  const d = hz.querySelector('.gx-dot'); d.style.display = v === null ? 'none' : '';
  if (v !== null) { d.style.left = at; d.style.top = ((1 - (Math.max(T.lo, Math.min(T.top, v)) - T.lo) / (T.top - T.lo)) * 100).toFixed(2) + '%'; }
  const past = raw === null ? [] : T.lines.filter(([lv]) => T.under ? v <= lv : v >= lv).map(x => x[1]);
  let h = '<b>' + hhmm(t) + (T.step === 600 ? ' to ' + hhmm(t + 600) : '') + '</b>' + (v === null ? '<span>no reading</span>' : '<span>' + esc(T.name) + ' <em>' + esc(T.val(v)) + '</em></span>');
  if (past.length) { const red = past.includes('r'); h += '<span><i class="w' + (red ? 'r' : 'y') + '"></i>' + (T.under ? 'under' : 'over') + ' its ' + (red ? 'red' : 'yellow') + ' line</span>'; }
  const tip = hz.querySelector('.gx-tip');
  if (tip._h !== h) { tip.innerHTML = h; tip._h = h; }
  const hr = hz.getBoundingClientRect(), gx = pr.left - hr.left + (i + 0.5) / N * pr.width, tw = tip.offsetWidth;
  tip.style.left = (gx + 14 + tw > hr.width ? gx - 14 - tw : gx + 14).toFixed(1) + 'px';
  hz.classList.add('hv');
}
$('wlist').addEventListener('pointermove', e => wxHover(e.target.closest && e.target.closest('.wx-hz'), e));
$('wlist').addEventListener('pointerleave', () => wxHover(null));
$('wsum').addEventListener('pointerleave', () => { if (WX.sumStale) { WX.sumStale = false; wxSum(); } });
// (a row or the summary bar: Enter or Space opens it, as in Sessions; clicked, it takes the focus, Tab doesn't walk them, 11-06)
for (const id of ['wlist', 'wsum']) $(id).addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.gx-row, .gx-srow')) { e.preventDefault(); e.target.click(); } });
// (quick clicks, one after another, aren't a word picked: no click is lost)
$('wsum').addEventListener('mousedown', e => { if (e.detail > 1 && e.target.closest('.gx-srow')) e.preventDefault(); });
$('wlist').addEventListener('mousedown', e => { if (e.detail > 1 && e.target.closest('.gx-row')) e.preventDefault(); });
$('wsum').addEventListener('click', e => {
  const t = e.target, pk = gxPicked(e, $('wsum'));
  // (its row opens and shuts it, like a session's; what opened under it stays open under clicks)
  if (t.closest('.gx-srow')) { if (!pk) wxSet({ open: !WX.open }); return; }
  const mb = t.closest('.gx-menu button'); if (mb) { wxSet({ cell: mb.dataset.cell || null, menu: false }); return; }
  if (t.closest('[data-flt]')) { const had = document.activeElement === t.closest('[data-flt]'); S.listFilt.w = !S.listFilt.w; saveState(); wxSum(); wShow = 300; wxList(); fltBack(wmodal, had); if (motionMode() !== 'off') $('wlist').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: SUM_E }); return; }
  if (t.closest('.gx-dd')) { wxSet({ menu: !WX.menu }); return; }
  const pb = t.closest('.gx-per button'); if (pb) { if (perPick(pb.dataset.p) === WX.period && !WX.W.whole()) WX.W.set(0, 1, true); else wxSet({ period: perPick(pb.dataset.p), menu: false }); return; }   // (the period again: all of it)
  const gr = t.closest('.gx-gr'); if (gr && !pk) { wxSet({ cell: WX.cell === gr.dataset.cell ? null : gr.dataset.cell, menu: false }); return; }
  if (WX.menu) wxSet({ menu: false });
});
// (the cell list shuts on a click anywhere else; inside the bar its own click does it)
document.addEventListener('pointerdown', e => { if (WX.menu && !e.target.closest('#wsum')) wxSet({ menu: false }); });
$('wlist').addEventListener('click', e => {
  if (e.target.closest('#wMore')) {
    const card = $('wlist').closest('.mcard'), st = card.scrollTop, keep = new Set([...$('wlist').querySelectorAll('.gx-sess.open')].map(x => x.dataset.k));   // (the rows open before stay open)
    wShow += 300; drawWarnList(keep);
    card.scrollTop = st; return;
  }
  if (e.target.closest('#wbMore')) { const card = $('wlist').closest('.mcard'), st = card.scrollTop; wbShow += 300; wbRender(wbText); card.scrollTop = st; return; }
  const pg = e.target.closest('.gx-purge'); if (pg) { pkPurge('w', pg.closest('.gx-sess')); return; }   // (a bin row's own button: not a pick)
  if (PK.w.mode) { const s = e.target.closest('.gx-sess'); if (s) pkToggle('w', s); return; }   // (picking: a click picks)
  const r = e.target.closest('.gx-row'); if (!r) return;
  const el = r.parentNode; wxFill(el, wGroups[+el.dataset.g]);
  el.classList.toggle('open'); r.setAttribute('aria-expanded', el.classList.contains('open'));
  if (el.classList.contains('open')) centreOpen(el);   // (to the middle, like a session)
});

// ---- picking rows, and the bins (11-02, his "a bin of sessions and logs, batch selection to restore and delete, delete
// goes into the bin"): Select puts a box on every row (not the session in progress) and a bar at the bottom: pick all,
// Cancel, Move to the bin. The bin icon shows what Delete, Keep or a move set aside, the same rows each with its
// box: pick all, Back, Restore. A move is the rows' exact lines between the log and its bin; undo takes it back ----
const PK = { g: { mode: null, pick: new Set(), bin: [] }, w: { mode: null, pick: new Set(), bin: [] } };
const pkEls = k => k === 'g' ? { modal: $('gmodal'), list: $('glist'), bar: PK.g.mode === 'cmp' ? $('gcbar') : $('gbar'), sel: $('gselBtn'), bin: $('gbinBtn') } : { modal: wmodal, list: $('wlist'), bar: $('wbar'), sel: $('wselBtn'), bin: $('wbinBtn') };   // (Compare: a bar of its own, 11-09)
// Compare (his 11-09 "it should use the select feature somehow, just not share the same thing"): a mode of its own
// beside Pick, Pick's squares on the rows; the first one clicked is A, the next B (a click on A or B again lets it go,
// another one with both set takes B's place); its own bar: A, the swap, B, Cancel, Compare. Back from the comparison
// comes back to it with A and B kept
const CQ = { a: null, b: null };   // (gxKey of A and of B)
let wbText = '', wbShow = 300;   // (the warnings' bin: its text, how many rows drawn)
// (a row that can be picked: a session in the log, not the one in progress; a warning that ended; in the bin, one within
// the days you keep: an older one, back in the log, would be set aside again at once and not shown)
const pkOld = (k, x) => { const N = k === 'g' ? feed.gameDays : feed.warnDays; if (!N) return false; const cut = Date.now() - N * 86400000; return k === 'g' ? x.end * 1000 < cut : x.first.when.getTime() < cut; };
const pkCan = (k, x) => !!x && (PK[k].mode === 'bin' ? !pkOld(k, x) : k === 'g' ? !!x._raw && !x.live : !x.ongoing);
const pkAll = k => k === 'g' ? (PK.g.mode === 'bin' ? PK.g.bin : gxSs) : (PK.w.mode === 'bin' ? PK.w.bin : wGroups);   // (the rows on show)
const pkItems = k => pkAll(k).filter(x => pkCan(k, x));   // (the ones that can be picked)
const pkKey = (k, x) => k === 'g' ? x._raw : x.name + '|' + x.first.when.getTime();
const pkLines = (k, x) => k === 'g' ? (x._raw ? [x._raw] : []) : x.eps.flatMap(ep => (ep._raw || []).concat(ep.closer ? [ep.closer] : []));   // (closer: the bin's mark that ended it)
const pkItemOf = (k, el) => pkAll(k)[+el.dataset.g];
const pkWhat = (k, n) => k === 'g' ? plural(n, 'session') : plural(n, 'row');
// (to the bin and back, 11-02, the motion audit: it blinked. The list stays until the bin's rows come, "loading..." only
// if they take a while, then they slide in from the right; Back slides the log in from the left, as a period picked
// does. Only on the switch: never on Show older rows or a list drawn again)
const pkSlide = (k, dir, sum) => {   // (sum: the bar above it (and REC) come back with it, in the same move, 11-08)
  if (motionMode() === 'off') return;
  const kf = [{ transform: 'translateX(' + (dir * 3) + '%)', opacity: 0 }, { transform: 'none', opacity: 1 }], o = { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
  pkEls(k).list.animate(kf, o);
  if (sum) for (const id of k === 'g' ? ['gsum', 'grun'] : ['wsum']) { const s = $(id); if (s && s.offsetParent) s.animate(kf, o); }
};
// (the bin's rows came: whether the list was waiting for them, the switch's one slide)
const pkArrived = k => { const P = PK[k], w = !!P.wait; clearTimeout(P.waitT); P.wait = false; pkEls(k).list.classList.remove('pkwait'); return w; };
function pkMode(k, mode, quiet) {
  if (k === 'g' && gxCmp && mode) { gxCmp = null; gmodal.classList.remove('cmp'); if (mode !== 'bin') renderGames(gxText); }   // (picking or the bin: the comparison ends, 11-06)
  const P = PK[k], E = pkEls(k), was = P.mode;
  P.mode = mode; P.pick.clear(); pkArrived(k);
  if (k === 'g' && (was === 'cmp') !== (mode === 'cmp')) { const o = E.bar; o._h = null; pkSink(o, () => pkEls('g').bar !== o || !PK.g.mode || PK.g.wait); }   // (Pick's bar and Compare's: the one it leaves sinks, 11-09)
  E.modal.classList.toggle('binning', mode === 'bin' && (quiet || was === 'bin'));   // (into the bin: the bar goes when its rows come, gbRender / wbRender, 11-08)
  E.modal.classList.toggle('pking', !!mode); E.sel.classList.toggle('on', mode === 'sel'); E.bin.classList.toggle('on', mode === 'bin'); E.sel.setAttribute('aria-pressed', mode === 'sel'); E.bin.setAttribute('aria-pressed', mode === 'bin');
  if (k === 'g') { const c = $('gcmpBtn'); c.classList.toggle('on', mode === 'cmp'); c.setAttribute('aria-pressed', mode === 'cmp'); }
  if (!quiet) {
    if (mode === 'bin') {
      if (k === 'w') wbShow = 300;
      // (the old rows stay, out of reach, until the bin's come)
      P.wait = true; E.list.classList.add('pkwait'); for (const el of E.list.querySelectorAll('.gx-sess.pk, .gx-sess.cqa, .gx-sess.cqb')) el.classList.remove('pk', 'cqa', 'cqb'); E.list.classList.remove('cqmode');   // (from Compare too: its A and B go with it)
      { const o = E.bar; pkSink(o, () => pkEls(k).bar !== o || !PK[k].mode || PK[k].wait); } E.bar._h = null;   // (judged by the mode as it is when it has sunk: a quick second switch left it up, 11-09)   // (its buttons too: they would act on the bin's rows before they are here; it rises in with them)
      P.waitT = setTimeout(() => { if (P.wait) E.list.innerHTML = '<div class="wempty">loading...</div>'; }, 150);
      send({ t: k === 'g' ? 'games:bin' : 'alerts:bin' });
    }
    else if (was === 'bin') { flipHold++; try { if (k === 'g') renderGames(gxText); else renderWarnings(wxText); } finally { flipHold--; } pkSlide(k, -1, true); }   // (back: the list as it is now)
  }
  if (!P.wait) { pkMark(k); pkBar(k); }   // (waiting: the bin's rows mark them)
}
function pkMark(k) {
  const P = PK[k], E = pkEls(k), cq = P.mode === 'cmp'; E.list.classList.toggle('picking', !!P.mode); E.list.classList.toggle('cqmode', cq);
  if (!P.mode) { for (const el of E.list.querySelectorAll('.gx-sess.pk, .gx-sess.nopk, .gx-sess.cqa, .gx-sess.cqb, .gx-sess[aria-checked]')) { el.classList.remove('pk', 'nopk', 'cqa', 'cqb'); delete el.dataset.tip; el.removeAttribute('role'); el.removeAttribute('aria-checked'); el.removeAttribute('aria-disabled'); } return; }
  // (picks the list no longer shows go: a period or a game picked meanwhile, a session renamed; the bar follows)
  const ok = new Set(pkItems(k).map(x => pkKey(k, x))); for (const key of [...P.pick]) if (!ok.has(key)) P.pick.delete(key);
  if (cq) { const okG = new Set(pkItems(k).map(gxKey)); for (const s of ['a', 'b']) if (CQ[s] && !okG.has(CQ[s])) CQ[s] = null; }   // (A or B gone from the list: its slot empties)
  const old = P.mode === 'bin' ? 'Older than the ' + (k === 'g' ? feed.gameDays : feed.warnDays) + ' days you keep: keep more days to bring it back' : null;
  for (const el of E.list.querySelectorAll('.gx-sess')) {
    const x = pkItemOf(k, el), can = pkCan(k, x), ab = cq && can ? (gxKey(x) === CQ.a ? 'a' : gxKey(x) === CQ.b ? 'b' : '') : '', on = cq ? !!ab : can && P.pick.has(pkKey(k, x));
    el.classList.toggle('nopk', !can); el.classList.toggle('pk', !cq && on); el.classList.toggle('cqa', ab === 'a'); el.classList.toggle('cqb', ab === 'b');
    el.setAttribute('role', 'checkbox'); el.setAttribute('aria-checked', on); if (can) el.removeAttribute('aria-disabled'); else el.setAttribute('aria-disabled', 'true');   // (11-06)
    if (old && x && !can) el.dataset.tip = old; else if (el.dataset.tip) delete el.dataset.tip;
  }
  pkBar(k);
}
function pkToggle(k, el) {
  const x = pkItemOf(k, el); if (!pkCan(k, x)) return;   // (the session in progress, a warning going on, a bin row too old: they stay)
  const P = PK[k], key = pkKey(k, x);
  if (P.mode === 'cmp') { const g = gxKey(x); if (CQ.a === g) CQ.a = null; else if (CQ.b === g) CQ.b = null; else if (!CQ.a) CQ.a = g; else CQ.b = g; pkMark(k); return; }   // (A first, then B; with both, B's place)
  if (P.pick.has(key)) P.pick.delete(key); else P.pick.add(key);
  el.classList.toggle('pk', P.pick.has(key)); el.setAttribute('aria-checked', P.pick.has(key)); pkBar(k);
}
// (the selection bar sinks out as it rose in, 11-08: out of reach at once, then hidden unless it was asked back)
function pkSink(bar, still) {
  if (bar.hidden || bar._out) return;
  if (motionMode() === 'off' || !bar.offsetParent) { bar.hidden = true; return; }
  bar._out = true; bar.style.pointerEvents = 'none';
  bar.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 8px' }], { duration: 150, easing: 'cubic-bezier(0.4, 0, 1, 1)' }).onfinish = () => { if (!bar._out) return; bar._out = false; bar.style.pointerEvents = ''; if (still()) bar.hidden = true; };
}
function pkBar(k) {
  const P = PK[k], E = pkEls(k), n = P.pick.size, all = pkItems(k).length, bin = P.mode === 'bin', tot = bin ? pkAll(k).length : all;
  const shown = !E.bar.hidden && !E.bar._out;
  if (!P.mode) { E.bar._h = null; pkSink(E.bar, () => !PK[k].mode); return; }
  if (E.bar._out) { E.bar._out = false; E.bar.style.pointerEvents = ''; for (const a of E.bar.getAnimations()) a.cancel(); }
  E.bar.hidden = false;
  // (it rises in as it shows, only then: a CSS animation keyed on the motion setting replayed it. 11-02, the motion audit)
  if (!shown && motionMode() !== 'off') E.bar.animate([{ opacity: 0, translate: '0 8px' }, { opacity: 1, translate: '0 0' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  // (written only when it changed: a list drawn again under the pointer doesn't take a button from under a click)
  if (P.mode === 'cmp') {
    const A = CQ.a && gxSs.find(x => gxKey(x) === CQ.a), B = CQ.b && gxSs.find(x => gxKey(x) === CQ.b);
    const slot = (x, s) => '<span class="cq-s ' + s + (x ? ' full' : '') + '"><i>' + s.toUpperCase() + '</i>' + (x ? '<b>' + esc(x.game) + '</b> ' + gxLab(x) : s === 'a' ? 'pick a session' : 'then another') + '</span>';
    const hc = '<span class="gb-n">Compare</span>' + slot(A, 'a') + '<button class="cq-sw" data-pk="swap" title="Swap"' + (A || B ? '' : ' disabled') + '>' + GX_SWAPI + '</button>' + slot(B, 'b') + '<span class="sp"></span>' +
      '<button class="btn pk-q" data-pk="back">Cancel</button><button class="btn pk-go" data-pk="cmpgo"' + (A && B ? '' : ' disabled') + '>Compare</button>';
    if (E.bar._h !== hc) { E.bar.innerHTML = hc; E.bar._h = hc; }
    return;
  }
  const h = '<span class="gb-n">' + (bin ? 'The bin: <b>' + pkWhat(k, tot) + '</b>' + (tot > all ? ', ' + (tot - all) + ' older than the days you keep' : '') + (n ? ', ' + n + ' picked' : '') : n ? '<b>' + n + '</b> picked' : 'Pick the ' + (k === 'g' ? 'sessions' : 'rows') + ' to move to the bin') + '</span><span class="sp"></span>' +
    (all ? '<button class="btn pk-q" data-pk="all">' + (n && n === all ? 'Pick none' : 'Pick all') + '</button>' : '') +
    '<button class="btn pk-q" data-pk="back">' + (bin ? 'Back' : 'Cancel') + '</button>' +
    '<button class="btn' + (bin ? ' pk-go' : ' warn') + '" data-pk="' + (bin ? 'restore' : 'del') + '"' + (n ? '' : ' disabled') + '>' + (bin ? 'Restore' : 'Move to the bin') + (n ? ' ' + n : '') + '</button>';
  if (E.bar._h !== h) { E.bar.innerHTML = h; E.bar._h = h; }
}
let pkStep = null;   // (the last move's undo step: the host's answer says whether anything moved)
function pkAct(k, a) {
  const P = PK[k], items = pkItems(k);
  if (a === 'all') { if (P.pick.size && P.pick.size === items.length) P.pick.clear(); else for (const x of items) P.pick.add(pkKey(k, x)); pkMark(k); pkBar(k); return; }
  if (a === 'back') { pkMode(k, null); return; }
  if (a === 'swap') { const had = !!document.activeElement && !!document.activeElement.closest && !!document.activeElement.closest('#gcbar .cq-sw'); [CQ.a, CQ.b] = [CQ.b, CQ.a]; pkMark(k); if (had) { const w = $('gcbar').querySelector('.cq-sw'); if (w) w.focus({ preventScroll: true }); } const s = $('gcbar').querySelector('.cq-sw svg'); if (s && motionMode() !== 'off') s.animate([{ transform: 'rotate(180deg)' }, { transform: 'none' }], { duration: 300, easing: SUM_E }); return; }
  if (a === 'cmpgo') { const had = $('gcbar').contains(document.activeElement), A = gxSs.find(x => gxKey(x) === CQ.a), B = gxSs.find(x => gxKey(x) === CQ.b); if (A && B) { gxCmpStart([A, B], true); const f = had && document.querySelector('#glist .gx-cmpb'); if (f) f.focus({ preventScroll: true }); } return; }   // (the focus a key gave the bar goes to the comparison's Back, 11-09)
  const lines = [...new Set(items.filter(x => P.pick.has(pkKey(k, x))).flatMap(x => pkLines(k, x)))]; if (!lines.length) return;   // (once each: a mark can end crossings of several rows)
  const log = k === 'g' ? 'games' : 'alerts', to = a === 'restore' ? 'log' : 'bak';
  pkStep = JSON.stringify({ host: { t: 'log:move', log, to: to === 'log' ? 'bak' : 'log', lines, quiet: true }, redo: { t: 'log:move', log, to, lines, quiet: true } });
  pushUndo(pkStep); syncUndo();
  send({ t: 'log:move', log, to, lines, n: k === 'g' ? lines.length : items.filter(x => P.pick.has(pkKey(k, x))).reduce((s, g) => s + g.eps.length, 0) });   // (n: how many, as the rows count them)
  if (a === 'del') pkMode(k, null, true); else { P.pick.clear(); pkBar(k); }   // (the host's new log and bin draw the rows again)
}
// a row deleted permanently from its bin (11-03, his "in the bin a button in each row to delete it permanently, like it was
// before"): its exact lines leave the bin's file, after a confirm, no undo. A mark the bin set aside with the crossings
// it ended stays while another row there ends at it. Any row, an old one too (it can't come back, it can still go)
const PK_PURGE = '<button class="gx-purge" data-tip="Delete permanently" aria-label="Delete permanently"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>';
function pkPurge(k, el) {
  const x = el && PK[k].mode === 'bin' ? pkItemOf(k, el) : null; if (!x) return;
  const others = k === 'w' ? new Set(PK.w.bin.filter(g => g !== x).flatMap(g => g.eps.map(ep => ep.closer).filter(Boolean))) : null;
  const lines = [...new Set(pkLines(k, x))].filter(l => !others || !others.has(l)); if (!lines.length) return;
  const what = k === 'g' ? x.game + ', ' + localDay(new Date(x.start * 1000)) + ' ' + hhmm(x.start) + ' to ' + hhmm(x.end)
    : x.name + ', ' + x.day + ' ' + x.first.time + (x.eps.length > 1 ? ', ' + x.eps.length + ' times' : '');
  askConfirm(k === 'g' ? 'Delete this session permanently?' : 'Delete this row permanently?', what + '. It leaves the bin and can\'t be brought back.', 'Delete permanently',
    () => send({ t: 'log:purge', log: k === 'g' ? 'games' : 'alerts', lines, n: k === 'g' ? 1 : x.eps.length }));
}
// (what the host deleted, added up since the page opened: a step that brings back from the bin only lines deleted for
// good has nothing left to move, so it goes; a step out of the log stays, the log keeps its lines)
const pkGone = new Set();
function pkForget(gone) {
  for (const l of gone) pkGone.add(l);
  const dead = s => { if (!s.startsWith('{"host":')) return false; try { const o = JSON.parse(s); return !!(o.host && o.host.t === 'log:move' && o.host.to === 'log' && Array.isArray(o.host.lines) && o.host.lines.every(l => pkGone.has(l))); } catch (e) { return false; } };
  const n = undoStack.length + redoStack.length; undoStack = undoStack.filter(s => !dead(s)); redoStack = redoStack.filter(s => !dead(s));
  if (undoStack.length + redoStack.length !== n) { if (pkStep && !undoStack.includes(pkStep)) pkStep = null; syncUndo(); }
}
// the bins on show: sessions', warnings' (the same rows; a crossing the bin has without its end shows no "now")
function gbRender(text) {
  if (PK.g.mode !== 'bin' || !$('gmodal').classList.contains('open')) return;   // (shut: it let go of its list)
  const slide = pkArrived('g'); $('gmodal').classList.add('binning');   // (the bar goes now, as the bin's rows slide in, 11-08)
  const ss = [];
  for (const line of (text || '').split(/\r?\n/)) { try { const x = line.trim() ? JSON.parse(line) : null; if (x && typeof x === 'object' && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start) { x._raw = line; ss.push(x); } } catch (e) { } }
  ss.sort((a, b) => b.start - a.start); PK.g.bin = ss;
  const today = localDay(new Date()), y = new Date(); y.setDate(y.getDate() - 1); const yest = localDay(y), dk = u => localDay(new Date(u * 1000)), per = {};
  for (const x of ss) per[dk(x.start)] = (per[dk(x.start)] || 0) + 1;
  let h = '', last = null;
  ss.forEach((x, i) => { const d = dk(x.start); if (d !== last) { last = d; h += wxDayHd(d, per[d], today, yest, 'session'); } h += gxSessHtml(x, i, false, true); });
  const fl = slide ? null : listTops($('glist'));
  $('glist').innerHTML = h ? '<div class="gx-cols"><span></span><span>session</span><span class="gx-r">length</span><span class="gx-r">fps</span><span class="gx-r">1% low</span><span>limited by</span><span class="gx-r">warnings</span></div>' + h
    : '<div class="wempty ico pad">The bin is empty: what Delete, Keep or a move sets aside waits here.</div>';
  listGlide($('glist'), fl); pkMark('g'); pkBar('g'); if (slide) pkSlide('g', 1);
}
function wbRender(text) {
  if (PK.w.mode !== 'bin' || !wmodal.classList.contains('open')) return;   // (shut: it let go of its list)
  const slide = pkArrived('w'); wmodal.classList.add('binning');
  wbText = text || '';
  // (in time order: the bin gets its lines as they were set aside; with the log's marks, an app's exit or start, HWiNFO
  // stopping, which stay in the log: a crossing one ended ends there as in the log, and doesn't take in the next one of
  // its cell. A mark is no crossing's line, so nothing moves with it)
  const at = l => { const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)([+-]\d\d:\d\d)?/.exec(l); return m ? new Date(m[1] + 'T' + m[2] + (m[3] || '')).getTime() || 0 : 0; };
  const marks = wxText.split(/\r?\n/).filter(l => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:[+-]\d\d:\d\d)?\s+(MARK|OK)\s/.test(l));   // (and its ends: a crossing Keep cut at midnight has its end in the log)
  const lines = wbText.split(/\r?\n/).concat(marks).filter(l => l.trim()).map((l, i) => [at(l), i, l]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
  const groups = wxGroups(wxParse(lines.join('\n'), new Set(marks))).reverse(); for (const g of groups) g.ongoing = false;
  PK.w.bin = groups;
  const today = localDay(new Date()), y = new Date(); y.setDate(y.getDate() - 1); const yest = localDay(y), per = {};
  for (const g of groups) per[g.day] = (per[g.day] || 0) + g.eps.length;
  wxCellAt = null;
  let h = '', last = null;
  groups.slice(0, wbShow).forEach((g, gi) => { if (g.day !== last) { last = g.day; h += wxDayHd(g.day, per[g.day], today, yest); } h += wxRow(g, gi, true); });
  if (groups.length > wbShow) h += '<button class="linkbtn wmore" id="wbMore">Show ' + plural(groups.length - wbShow, 'older row') + '</button>';
  const fl = slide ? null : listTops($('wlist'));
  $('wlist').innerHTML = h ? '<div class="gx-cols"><span></span><span>warning</span><span class="gx-r">peak</span><span class="gx-r">lasted</span><span class="gx-r">times</span><span>its lines</span><span class="gx-r">level</span></div>' + h
    : '<div class="wempty ico pad">The bin is empty: what Keep or a move sets aside waits here.</div>';
  listGlide($('wlist'), fl); pkMark('w'); pkBar('w'); if (slide) pkSlide('w', 1);
}
for (const k of ['g', 'w']) {
  const E = pkEls(k);
  E.sel.onclick = () => pkMode(k, PK[k].mode === 'sel' ? null : 'sel');
  E.bin.onclick = () => pkMode(k, PK[k].mode === 'bin' ? null : 'bin');
  E.bar.addEventListener('click', e => { const b = e.target.closest('[data-pk]'); if (b && !b.disabled) pkAct(k, b.dataset.pk); });
}
$('gcbar').addEventListener('click', e => { const b = e.target.closest('[data-pk]'); if (b && !b.disabled) pkAct('g', b.dataset.pk); });
$('gcmpBtn').onclick = () => {   // (on in the comparison too: a click there ends both)
  if (PK.g.mode === 'cmp') { pkMode('g', null); return; }
  if (gxCmp && gxCmp.cq) { gxCmp.cq = false; gxCmpEnd(); return; }
  CQ.a = CQ.b = null; pkMode('g', 'cmp');
};
// ---------- game sessions ----------
const gmodal = $('gmodal');
// a closed popup lets go of its list (thousands of rows stayed in the page all day) and of Customize (its readings
// stayed subscribed)
// (after the fade: emptied as it starts to close, the card shrank and jumped while it faded)
const afterFade = (el, fn) => setTimeout(() => { if (!el.classList.contains('open')) fn(); }, 250);
const wxBarTint = k => { const w = wxCell(k), c = w ? cellTint(w.cid) : null; return c ? ';--cc:' + c : ''; };   // (a cell's share bar in its colour under Spectrum, 11-09)
// a day's band stuck at the top of Sessions or Warning history (11-09, his "you can see a line where it's NOT supposed to
// be one"): marked, so a fade under it lets the sessions slide away under it instead of being cut by a straight line
function dayStuck(card) { if (!card.isConnected) return; const ct = card.getBoundingClientRect().top + card.clientTop, up = card.scrollTop > 0, days = [...card.querySelectorAll('.gx-day')]; let top = null; if (up) for (const el of days) if (Math.abs(el.getBoundingClientRect().top - ct) < 1.5) top = el; for (const el of days) el.classList.toggle('stuck', el === top); }   // (the days passed all sit stuck under the last one: only that one, on top, gets the fade)
for (const id of ['gmodal', 'wmodal']) {
  const card = $(id).querySelector('.mcard'), list = card.querySelector('#glist, #wlist') || card; let q = 0;
  const go = () => { if (!q) q = requestAnimationFrame(() => { q = 0; dayStuck(card); }); };
  card.addEventListener('scroll', go, { passive: true }); new MutationObserver(go).observe(list, { childList: true, subtree: true });   // (scrolled, or the list drawn again)
}
new MutationObserver(() => {
  if (gmodal.classList.contains('open')) return;
  if (gxLive.on !== false && host) { gxLive.on = false; send({ t: 'gamesLive', on: false }); }   // (no more Now playing until it opens again)
  gxNow = null;   // (what was playing then: a game under a minute that ends meanwhile writes no line, and came back as a ghost, 11-06)
  afterFade(gmodal, () => {
    gxCmp = null; gmodal.classList.remove('cmp');
    if ($('glist').firstChild) { $('glist').innerHTML = ''; gxSs = []; gxTl.length = 0; }
    gxText = '';
    if (GZ.on) { GZ.on = false; renderGz(); }
  });
}).observe(gmodal, { attributes: true, attributeFilter: ['class'] });
new MutationObserver(() => { if (!$('wmodal').classList.contains('open')) afterFade($('wmodal'), () => { if ($('wlist').firstChild) { $('wlist').innerHTML = ''; wGroups = []; for (const k in WXC) delete WXC[k]; } }); }).observe($('wmodal'), { attributes: true, attributeFilter: ['class'] });
let lastGameCount = 0;
$('gamesBtn').onclick = () => { gxTlW.clear(); GX.W.reset(); GX.wkey = null; gxCmp = null; gmodal.classList.remove('cmp'); pkMode('g', null, true); gmodal.classList.add('open'); $('glist').innerHTML = '<div class="wempty">loading...</div>'; recKey = null; gxLoaded = false; renderRec(); if (host) { send({ t: 'games' }); gxLive.on = true; send({ t: 'gamesLive', on: true }); } else renderGames(''); };
let gxLoaded = false;   // the log is in since the popup opened (Start names the next "Session n" from it)
// ---- sessions of your own: Start records one (the host follows it like a game's, beside any game), each running one
// shows on top with its name (change it there), its time so far and Stop ----
let recKey = null, recHold = 0;
const recClock = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2); };
function renderRec() {
  const box = $('grun'), rs = feed.rec || [], k = rs.map(x => x[0]).join();
  if (k !== recKey) {   // (drawn again only when one starts or stops: a name being typed stays)
    const an = recKey !== null && motionMode() !== 'off' && $('gmodal').classList.contains('open'), h0 = !an ? -1 : box.hidden ? 0 : box.offsetHeight;
    recKey = k;
    // (11-02: a REC badge, its name with a pencil (click to rename), since when, a large clock, Stop)
    if (rs.length || h0 < 0) box.innerHTML = rs.map(x => '<div class="gx-rec" data-start="' + x[0] + '"><span class="gx-recb"><span class="rdot"></span>REC</span>' +
      '<label class="gx-rnw"><input class="gx-rn" value="' + esc(x[1]) + '" maxlength="60" spellcheck="false" title="Rename">' + ICONS.pen + '</label>' +
      '<span class="gx-rs">since ' + hhmm(x[0]) + '</span><span class="gx-rt"></span><button class="btn gx-stop" data-rec="stop"><i></i>Stop</button></div>').join('');
    recFold(box, h0, rs.length, k);
  }
  for (const el of box.children) setText(el.querySelector('.gx-rt'), recClock(Math.max(0, nowTs - +el.dataset.start)));
  $('grec').disabled = rs.length >= 8 || Date.now() < recHold || !gxLoaded;
}
// (the REC strip unfolds as a recording starts and folds away as the last one stops, the details' way, 11-08; h0 -1:
// at once)
function recFold(box, h0, n, k) {
  if (h0 < 0) { box.hidden = !n; return; }
  for (const a of box.getAnimations()) a.cancel();
  box.hidden = false;
  const cs = getComputedStyle(box), vis = h => ({ height: h + 'px', marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: 1 }), zero = { height: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 };
  const h1 = n ? box.offsetHeight : 0;
  if (Math.abs(h1 - h0) < 1) { if (!n) { box.hidden = true; box.innerHTML = ''; } return; }
  box.style.overflow = 'hidden';
  box.animate([h0 ? vis(h0) : zero, n ? vis(h1) : zero], { duration: 300, easing: SUM_E }).onfinish = () => { box.style.overflow = ''; if (!n && recKey === k) { box.hidden = true; box.innerHTML = ''; } };
}
// the next free 'Session n'
function recName() {
  let n = 0;
  for (const nm of gxAll.filter(x => x.custom).map(x => x.game).concat((feed.rec || []).map(x => x[1]))) { const m = /^Session (\d+)$/.exec(nm || ''); if (m) n = Math.max(n, +m[1]); }
  return 'Session ' + (n + 1);
}
// (asked first, 11-02: a click by mistake would record until Stop)
$('grec').onclick = () => {
  const nm = recName();
  askConfirm('Start a session?', 'It records how this PC runs until you press Stop, the way a game\'s session does: fps when a game is in front, temperatures, power, what limits it. It starts as "' + nm + '": rename it any time.', 'Start recording', () => {
    if (PK.g.mode === 'bin') pkMode('g', null);   // (its strip shows in the list, not over the bin)
    send({ t: 'rec', act: 'start', name: recName() }); recHold = Date.now() + 2000; $('grec').disabled = true; setTimeout(renderRec, 2050);   // (back on when the hold ends, not at the next tick)
  }, true);
};
$('grun').addEventListener('click', e => { const b = e.target.closest('[data-rec="stop"]'); if (!b) return; b.disabled = true; send({ t: 'rec', act: 'stop', start: +b.closest('.gx-rec').dataset.start }); });
$('grun').addEventListener('change', e => {
  if (!e.target.matches('.gx-rn')) return;
  const v = e.target.value.trim(), start = +e.target.closest('.gx-rec').dataset.start;
  if (v) send({ t: 'rec', act: 'name', start, name: v.slice(0, 60) });
  else { const r = (feed.rec || []).find(x => x[0] === start); if (r) e.target.value = r[1]; }   // (left empty: its name back)
});
$('grun').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.gx-rn')) e.target.blur(); });
// layout A, the tailored dashboard's popup: a week strip, columns that line up down the list, a session opens into
// avg / max bars against its lines and a minute by minute timeline
const GX_CHEV = '<svg class="gx-chev" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>';
const GX_WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GX_MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const gxN = v => typeof v === 'number' && isFinite(v) ? v : null;
const gxF = (v, d) => gxN(v) === null ? '--' : fmt(v, d);
// a warning in a report: its reading, worst value and unit (a Yes/No one says Yes)
const gxT = (v, d) => gxN(v) === null ? '--' : noNeg0((NFL[d] || NFL[1]).format(+v));   // (decimals as kept, no trailing zeros)
// a report item that is Intel's Distance to TjMAX (lower is worse), by its name or, renamed, its HWiNFO label
const gxTj = it => { const tj = /distance to tj ?max/i, r = it.key ? BYKEY.get(it.key) : null; return !!it.tj || tj.test(it.n) || (!!r && tj.test(r.label || '')); };   // (it.tj: marked by the host)
const gxWarn = w => { const u = typeof w[2] === 'string' ? w[2] : ''; return String(w[0]) + ' ' + (u === 'Yes/No' ? (gxN(w[1]) === null ? '--' : gxN(w[1]) >= 0.5 ? 'Yes' : 'No') : (gxT(w[1], u === 'MB' ? 0 : decFor({ unit: u })) + (u ? ' ' + u : ''))); };
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
// a reading's row: its average and its max, the max coloured by the lines it passed (no bar since 11-02, his ask)
function gxRow(label, lo, hi, avg, max, y, r, unit, dec, peakOnly, below, sc, yn) {
  const A = gxN(avg), M = gxN(max);
  const lvl = below || M === null ? 0 : gxN(r) !== null && M >= r ? 2 : gxN(y) !== null && M >= y ? 1 : 0, lc = lvl === 2 ? ' r' : lvl === 1 ? ' y' : '';
  // (yn: a Yes/No reading, its average a share of Yes and its peak Yes or No)
  const av = peakOnly ? (sc ? 'of ' + sc : 'peak') : yn ? (A === null ? '--' : Math.round(A * 100) + '% yes') : gxF(A, dec);
  return '<div class="gx-rw"><span class="n" title="' + label + '">' + label + '</span><span class="a">' + av + '</span><span class="m' + lc + '">' + (yn ? (M === null ? '--' : M >= 0.5 ? 'Yes' : 'No') : gxF(M, dec) + '<u>' + unit + '</u>') + '</span></div>';
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
    a: gxN(it[2]), m: gxN(it[3]), y: gxN(it[4]), r: gxN(it[5]), main: it.length > 6 ? it[6] === 1 : !!GX_MAIN[it[0]], hi: gxN(it[7]), below: it[8] === 1, key: typeof it[9] === 'string' ? it[9] : null, tj: it[10] === 1, p: Number.isFinite(x.p) ? x.p : 1 }));   // (p: the decimals the line kept)
}
const gxTop = v => { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => s * p >= v) * p; };
function gxItemRow(it, label, spec) {
  if (!it) return '<div class="gx-rw nil" title="Not recorded in this session: a reading you add is recorded from your next session on"><span class="n">' + label + '</span><span class="a"></span><span class="m">--</span></div>';
  let { a, m, y, r, hi, u } = it;
  if (u === 'MB') { [a, m, y, r, hi] = [a, m, y, r, hi].map(v => v === null ? null : v / 1024); u = 'GB'; }   // (memory in GB, like the cells)
  const F = /°F/.test(u), deg = c => F ? Math.round(c * 9 / 5 + 32) : c;
  const base = a !== null ? a : m, lo = /°/.test(u) ? Math.max(0, Math.min(deg(30), Math.floor((base === null ? deg(40) : base) / 10) * 10 - 10)) : 0;
  // the bar ends a little past the red line (both lines show as ticks), else at a typical limit, the scale, or the values
  let top = !it.below && r !== null && r > lo ? r + (r - lo) * 0.12 : spec && spec[2] ? (spec[1] === 30 ? deg(spec[2]) : spec[2]) : hi !== null ? hi : u === '%' ? 100 : gxTop(Math.max(m || 0, y || 0, a || 0) * 1.15);
  if (y !== null && !it.below && y >= top) top = y + (y - lo) * 0.12;
  if (!(top > lo)) top = lo + 1;
  const peak = !!(spec && spec[4]) || (hi !== null && a === null);
  const h = gxRow(label, lo, top, a, m, y, r, esc(u), Math.min(spec ? spec[3] : decFor({ unit: u }), it.p != null ? it.p : 1), peak, it.below, hi !== null ? fmt(hi, u === 'GB' ? 0 : decFor({ unit: u })) : '', u === 'Yes/No');
  const tc = keyTint(it.key);   // (Spectrum: a dot in its category's colour)
  return tc ? h.replace('<div class="gx-rw">', '<div class="gx-rw" style="--cc:' + tc + '">') : h;
}
// minute by minute: fps and its 1% low, and what limited it as each minute's share of the time in front (gpu, cpu,
// capped); gaps are minutes the game wasn't in front. Sessions before 1.3.0 only kept the call that held most of each
// minute: those minutes show that call alone
const GX_BN = [['gpu', 'gpu-bound'], ['cpu', 'cpu-bound'], ['cap', 'capped']];
const gxTl = [];   // per session in the list: its minutes, for the hover read-out
// (each session's chart window (B), by its start and game, so a redraw keeps it; the narrowest: 10 minutes)
const gxTlW = new Map();
function gxTlWin(key, N) {
  let W = gxTlW.get(key);
  if (!W) { W = mkWin({ min: () => Math.min(1, 10 / Math.max(1, W.N || 1)), draw: () => gxTlDraw(key) }); gxTlW.set(key, W); }
  if (W.N && W.N !== N && !W.whole()) {   // (a live session grew: the same minutes; a window at its end stays at the end)
    const r = W.N / N, end = W.tb >= 0.999, w = (W.tb - W.ta) * r;
    W.ta = end ? 1 - w : W.ta * r; W.tb = end ? 1 : W.tb * r; W.a = W.ta; W.b = W.tb;
  }
  W.N = N; return W;
}
// clock ticks under a session's chart for its window: start and end, and the round half hours (quarters, fives) between
// them; none that would read the same as the end (a long one gets hours apart; most of a day long: which day each end is)
function gxTicks(t0, t1, t2) {
  const N = (t1 - t0) / 60, every = N > 960 ? 180 : N > 480 ? 60 : N > 90 ? 30 : N > 40 ? 15 : N > 15 ? 5 : 1;
  const day = u => GX_WD[new Date(u * 1000).getDay()].slice(0, 3) + ' ', long = t2 - t0 >= 16 * 3600;
  let tk = '<span class="e0">' + (long ? day(t0) : '') + hhmm(t0) + '</span>';
  const tz = new Date(t0 * 1000).getTimezoneOffset() * 60;   // (rounded on the local clock: UTC minus local, in seconds)
  for (let u = Math.ceil((t0 - tz) / 60 / every) * every * 60 + tz; u < t2; u += every * 60) {
    const pc = (u - t0) / (t1 - t0) * 100;
    if (pc > 9 && pc < 91 && hhmm(u) !== hhmm(t2)) tk += '<span style="left:' + pc.toFixed(2) + '%">' + hhmm(u) + '</span>';
  }
  return tk + '<span class="e1">' + (long ? day(t2) : '') + hhmm(t2) + '</span>';
}
// the window drawn on every chart of that session (the list, the compare view): the charts' view boxes, the ticks, the bar
function gxTlDraw(key) {
  for (const tl of document.querySelectorAll('#glist .gx-tl')) {
    const T = gxTl[+tl.dataset.g]; if (!T || T.key !== key) continue;
    const W = T.W, N = T.N;
    for (const [sel, h] of [['svg.gx-fpsc', 140], ['svg.gx-bnc', 40]]) { const sv = tl.querySelector(sel); if (sv) sv.setAttribute('viewBox', (W.a * N * 10).toFixed(2) + ' 0 ' + ((W.b - W.a) * N * 10).toFixed(2) + ' ' + h); }
    const t0 = T.start + W.a * N * 60, t1 = T.start + W.b * N * 60, tk = tl.querySelector('.gx-ticks');
    if (tk) { const h = gxTicks(t0, t1, Math.min(t1, T.end)); if (tk._h !== h) { tk.innerHTML = h; tk._h = h; } }
    const bar = tl.querySelector('.mbar'); if (bar) winBarDraw(bar, winBarParts(W, T.start * 1000, (T.start + N * 60) * 1000, d => hhmm(d.getTime() / 1000), '', f => Math.min(T.start + f * N * 60, T.end) * 1000 + 1));   // (+1 ms: winBarParts takes 1 ms off the end, for the day charts' midnight; a session's end second is its own, 11-07 audit)
    if (gxHz && tl.contains(gxHz)) gxHz.classList.remove('hv');
  }
}
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
  const key = x.start + '|' + (x.game || ''), Wn = gxTlWin(key, N);
  const T = gxTl[gi] = Object.assign({ start: x.start, end: x.end, key, W: Wn, custom: !!x.custom, gaps: Array.isArray(x.gaps) ? x.gaps.filter(g => Array.isArray(g) && g.length >= 2) : [] }, D);
  const vb = h => (Wn.a * N * 10).toFixed(2) + ' 0 ' + ((Wn.b - Wn.a) * N * 10).toFixed(2) + ' ' + h;   // (its window: B)
  const cut = x.end - x.start > N * 60 + 90;   // (the host keeps 24 hours of minutes)
  const fc = gameTint();   // (Spectrum: the fps line in the game's colour)
  let h = '<div class="gx-tl" data-g="' + gi + '"' + (fc ? ' style="--fc:' + fc + '"' : '') + '><div class="gx-ch">over time<span>' + (cut ? 'the first 24 hours, ' : '') + (x.custom ? 'per minute' : 'per minute, a gap is time the game was closed or not in front, or HW Deck was closed') + '</span></div><div class="gx-hz">';
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
    h += '<div class="gx-tr f"><span class="l">fps</span><span class="gx-plot"><svg class="gx-fpsc" viewBox="' + vb(H) + '" preserveAspectRatio="none">' + grid + band + line(D.lv, 'lo') + line(D.fv, 'fp') + '</svg>' +
         '<i class="gx-gd"></i><i class="gx-dot lo"></i><i class="gx-dot fp"></i></span><span class="gx-yax">' + yl + '</span></div>';
  }
  if (D.sh.some(Boolean)) {
    // each minute's main call as a level, a step where it changes: GPU at the top, CPU in the middle, capped at the
    // bottom, their names on the right (11-04, his "for EVERY bar in the app replace with a graph"; its split per
    // minute stays in the tip)
    const H2 = 40, Yl = v => 6 + (3 - v) * 14, lv = D.sh.map(s => s ? 3 - s.indexOf(Math.max(s[0], s[1], s[2])) : null), M = lv.length;
    let d = '', fl = '';
    for (let m = 0; m < M; m++) {
      if (lv[m] == null) continue;
      if (!m || lv[m - 1] == null) { d += 'M' + m * 10 + ' ' + Yl(lv[m]); fl += 'M' + m * 10 + ' ' + H2 + 'V' + Yl(lv[m]); }
      else if (lv[m] !== lv[m - 1]) { d += 'V' + Yl(lv[m]); fl += 'V' + Yl(lv[m]); }
      d += 'H' + (m + 1) * 10; fl += 'H' + (m + 1) * 10;
      if (m === M - 1 || lv[m + 1] == null) fl += 'V' + H2 + 'Z';
    }
    const gl = [3, 2, 1].map(v => '<line class="g" x1="0" x2="' + N * 10 + '" y1="' + Yl(v) + '" y2="' + Yl(v) + '"/>').join('');
    h += '<div class="gx-tr s"><span class="l">limited by</span><span class="gx-plot"><svg class="gx-bnc" viewBox="' + vb(H2) + '" preserveAspectRatio="none">' + gl + '<path class="bf" d="' + fl + '"/><path class="bl" d="' + d + '"/></svg><i class="gx-gd"></i></span>' +
         '<span class="gx-bny">' + [3, 2, 1].map(v => '<span style="top:' + (Yl(v) / H2 * 100).toFixed(1) + '%">' + BN_LV[v - 1] + '</span>').join('') + '</span></div>';
  }
  h += '<div class="gx-tip"></div></div>';
  // clock ticks for its window (none past the end, which a last minute cut short leaves before the right edge), then the
  // bar of its window (B, his 11-07 "we can add the bar on game session graphs too")
  const t0 = x.start + Wn.a * N * 60, t1 = x.start + Wn.b * N * 60;
  h += '<div class="gx-tr"><span></span><span class="gx-ticks">' + gxTicks(t0, t1, Math.min(t1, x.end)) + '</span><span></span></div>';
  h += '<div class="gx-tr"><span></span>' + winBarHtml(winBarParts(Wn, x.start * 1000, (x.start + N * 60) * 1000, d => hhmm(d.getTime() / 1000), '', f => Math.min(x.start + f * N * 60, x.end) * 1000 + 1), false) + '<span></span></div>';
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
  const pr = plot.getBoundingClientRect(), hr = hz.getBoundingClientRect(), f = (e.clientX - pr.left) / Math.max(1, pr.width);   // (read before any write, 11-06)
  if (f < 0 || f > 1) { hz.classList.remove('hv'); return; }
  const wa = T.W ? T.W.a : 0, wb = T.W ? T.W.b : 1, m = Math.max(0, Math.min(T.N - 1, Math.floor((wa + f * (wb - wa)) * T.N))), at = (((m + 0.5) / T.N - wa) / (wb - wa) * 100).toFixed(3) + '%';
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
  if (tip._h !== h) { tip.innerHTML = h; tip._h = h; tip._w = tip.offsetWidth; }
  const gx = pr.left - hr.left + parseFloat(at) / 100 * pr.width, tw = tip._w || tip.offsetWidth;
  tip.style.left = (gx + 14 + tw > hr.width ? gx - 14 - tw : gx + 14).toFixed(1) + 'px';
  hz.classList.add('hv');
}
$('glist').addEventListener('pointermove', e => { gxPtAt(e); gxHover(!winDrag && e.target.closest && e.target.closest('.gx-hz'), e); });
// a session's chart window (B): the wheel, a drag and a double click on its plots, its bar
{
  const gl = $('glist'), tOf = el => { const tl = el.closest('.gx-tl'); return tl ? gxTl[+tl.dataset.g] : null; }, on = v => { gl.classList.toggle('wdrag', v); if (v) gxHover(null); };
  gl.addEventListener('wheel', e => {
    const pl = e.target.closest && e.target.closest('.gx-tl .gx-plot'), T = pl && tOf(pl); if (!T || !T.W || !winWheelOk()) return;
    e.preventDefault(); const r = pl.getBoundingClientRect(); T.W.wheel(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), e.deltaMode ? e.deltaY * 33 : e.deltaY);
  }, { passive: false });
  gl.addEventListener('mousedown', e => {
    if (e.button !== 0 || !e.target.closest) return;
    const bar = e.target.closest('.gx-tl .mbar'), T0 = bar && tOf(bar); if (T0 && T0.W) { winBarDown(T0.W, bar, e, v => bar.classList.toggle('act', v)); return; }
    const pl = e.target.closest('.gx-tl .gx-plot'), T = pl && tOf(pl); if (!T || !T.W) return;
    e.preventDefault(); winGrab(T.W, 'pan', e.clientX, pl.getBoundingClientRect().width, on);
  });
  gl.addEventListener('dblclick', e => { const pl = e.target.closest && e.target.closest('.gx-tl .gx-plot'), T = pl && tOf(pl); if (T && T.W) { e.preventDefault(); T.W.set(0, 1, true); } });
  gl.addEventListener('mousemove', e => { const bar = e.target.closest && e.target.closest('.gx-tl .mbar'), T = bar && tOf(bar); if (T && T.W) winBarCursor(T.W, bar, e); });
}
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
  const hot = items.filter(it => /°/.test(it.u) && it.m !== null && !gxTj(it)).reduce((a, b) => !a || b.m > a.m ? b : a, null);
  const hl = hot && !hot.below ? (hot.r !== null && hot.m >= hot.r ? 'r' : hot.y !== null && hot.m >= hot.y ? 'y' : '') : '';
  const wn = Math.max(0, +x.warns || 0), wl = Array.isArray(x.wl) ? x.wl.filter(w => Array.isArray(w) && w.length >= 3) : [];
  const split = sp.n ? GX_BN.map(([k], j) => '<span><i class="b-' + k + '"></i>' + ['gpu', 'cpu', 'capped'][j] + ' <b>' + sp.pc(sp[['g', 'c', 'f'][j]]) + '%</b></span>').join('') : '';
  return '<div class="gx-s5">' +
    '<div><em>average fps</em><b>' + gxF(x.fps) + '</b><span>1% low <i>' + gxF(x.low) + '</i></span></div>' +
    (x.custom ? '<div><em>length</em><b>' + durS(x.end - x.start) + '</b><span>' + hhmm(x.start) + ' to ' + hhmm(x.end) + '</span></div>'
      : '<div><em>played</em><b>' + durTxt(gxPlay(x)) + '</b><span>' + (away >= 60 ? durTxt(away) + ' not in front' : 'all of it in front') + '</span></div>') +
    '<div><em>hottest</em><b class="' + hl + '">' + (hot ? gxF(hot.m, 1) + '<small>' + esc(hot.u) + '</small>' : '--') + '</b><span>' + (hot ? esc(hot.main && GX_MAIN[hot.n] ? GX_MAIN[hot.n][0] : hot.n) : '') + '</span></div>' +
    '<div class="w2"><em>limited by</em>' + (sp.n ? gxNbar(sp) + '<span class="gx-split">' + split + '</span>' : '<b>--</b>') + '</div>' +
    '<div><em>warnings</em><b>' + wn + '</b><span>' + (wl.length ? esc(gxWarn(wl[0])) : wn ? '' : 'none') + '</span></div></div>';
}
// (lazy: the chart gets a place, drawn when the session first opens)
function gxDetail(x, sp, gi, lazy, foot) {
  const items = gxItems(x), G = gxLayout(), D = gxMinutes(x);
  if (!items.length && !gxHasTl(D)) return '<div class="gx-in"><div class="gx-nil">No readings were recorded for this session.</div>' + (foot || '') + '</div>';
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
      h += '<div class="vrow g' + (GZ.shut.has(sn.key) ? ' collapsed' : '') + '" style="top:' + i * GZROW + 'px" data-gz="tw" data-sk="' + esc(sn.key) + '"><button class="tw" title="' + (GZ.shut.has(sn.key) ? 'Expand' : 'Collapse') + '" aria-expanded="' + !GZ.shut.has(sn.key) + '">' + ICONS.chev + '</button><span class="gn" title="' + esc(sn.name) + '">' + esc(sn.name) + '</span><span class="gc">' + row.n + '</span></div>';
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
// (Customize, 11-08: its categories and readings glide to their new places and a new one fades in, as the game table's
// rows do; the panel unfolds and folds as the details do. Off: at once)
const gzKey = el => el.classList.contains('gz-s') ? 's|' + el.dataset.id : 'c|' + ((el.querySelector('.x') || {}).textContent || '');
function gzTops(box) { if (box.hidden || box._out || motionMode() === 'off') return null; const m = new Map(); for (const el of box.querySelectorAll('.gz-s, .gz-c')) m.set(gzKey(el), el.getBoundingClientRect().top); return m; }
function gzGlide(box, at) {
  if (!at) return;
  for (const el of box.querySelectorAll('.gz-s, .gz-c')) {
    const t0 = at.get(gzKey(el)), t = el.getBoundingClientRect().top;
    if (t0 === undefined) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: SUM_E });
    else if (Math.abs(t0 - t) >= 1) el.animate([{ transform: 'translateY(' + (t0 - t).toFixed(1) + 'px)' }, { transform: 'none' }], { duration: 240, easing: SUM_E });
  }
}
function gzFold(box, inn) {
  if (!inn && (box.hidden || box._out)) return;
  if (motionMode() === 'off' || !box.offsetParent || !gmodal.classList.contains('open')) { if (!inn) { box.hidden = true; box.innerHTML = ''; } return; }   // (Sessions closing: it goes with them, at once; it stayed for its fold, the suite 11-08)
  const cs = getComputedStyle(box), full = { height: cs.height, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1 },
    zero = { height: '0px', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 };
  box._out = !inn; box.style.overflow = 'hidden';
  box.animate(inn ? [zero, full] : [full, zero], { duration: 300, easing: SUM_E }).onfinish = () => { box.style.overflow = ''; if (box._out && !GZ.on) { box._out = false; box.hidden = true; box.innerHTML = ''; } };
}
function renderGz() {
  const box = $('gcz');
  if (!GZ.on) { gzFold(box, false); $('gcustom').classList.remove('on'); if (gzKeys.length) { gzKeys = []; subscribe(); } return; }
  $('gcustom').classList.add('on');
  const secs = gxLayout().secs, lists = secs.filter(s => s.kind === 'list');
  if (!lists.some(s => s.id === GZ.sel)) GZ.sel = lists.length ? lists[0].id : null;
  const info = s => s.kind === 'summary' ? 'fps, played, hottest, limited by, warnings' : s.kind === 'time' ? 'the chart, minute by minute' : plural(s.cells.length, 'reading');
  let h = '<div class="gz-head"><span>Every session\'s details, top to bottom</span><span class="sp"></span><button class="btn" data-gz="reset">Reset to the default</button><button class="btn gz-done" data-gz="done">Done</button></div><div class="gz">';
  h += '<div class="gz-secs" data-list="secs"><div class="gx-ch">categories<span>drag to move</span></div>' + secs.map((s, i) => '<div class="gz-s' + (s.id === GZ.sel ? ' on' : '') + (s.hide ? ' off' : '') + '" data-i="' + i + '" data-id="' + esc(s.id) + '"><span class="grip" title="Drag to move it"></span>' +
    (s.kind === 'list' ? '<input class="gz-name" data-gz="name" value="' + esc(s.name) + '" maxlength="40" spellcheck="false" title="Rename">' : '<span class="nm">' + esc(gxSecName(s)) + '</span>') +
    '<span class="x">' + esc(info(s)) + '</span><button class="tog2' + (s.hide ? '' : ' on') + '" data-gz="hide" title="Show or hide it in the details"></button>' +
    (s.kind === 'list' ? '<button class="ib" data-gz="del" title="Remove the category">' + ICONS.x + '</button>' : '<span class="gz-ph"></span>') + '</div>').join('') +
    '<button class="linkbtn" data-gz="addsec">+ New category</button></div>';
  const s = secs.find(x => x.id === GZ.sel);
  h += '<div class="gz-cells">';
  if (s) {
    h += '<div class="gx-ch">' + esc(s.name) + ': its readings<span>' + s.cells.length + ' of ' + GX_MAX + '</span></div><div data-list="cells">' +
      s.cells.map((c, j) => '<div class="gz-c" data-i="' + j + '"><span class="grip" title="Drag to move it"></span><input class="gz-name" data-gz="cname" value="' + esc(gxCellName(c)) + '" maxlength="40" spellcheck="false" title="Its name in the details">' +
        '<span class="x">' + esc(gxCellFrom(c)) + '</span><button class="ib" data-gz="cdel" title="Take it out">' + ICONS.x + '</button></div>').join('') + '</div>';
    if (s.cells.length >= GX_MAX) h += '<div class="gz-note">A category takes ' + GX_MAX + ' readings at most: take one out, or start a new category.</div>';
  } else h += '<div class="gz-note">Add a category on the left to put readings in.</div>';
  h += '<div class="gz-note">A reading you add is recorded from your next session on: the sessions before it have no value for it.</div></div>';
  h += '<div class="gz-add"><div class="gx-ch">readings<span>' + (s ? '+ adds to ' + esc(s.name) : '') + '</span></div><div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>' +
    '<input id="gzQ" type="search" placeholder="Search sensors, labels, units" autocomplete="off" spellcheck="false" value="' + esc(GZ.q) + '"></div><div class="chips"></div><div class="vlist gz-list"><div class="vspace"></div></div></div></div>';
  const ae = document.activeElement, f = ae && ae.id === 'gzQ' ? [ae.selectionStart] : null, old = box.querySelector('.gz-list'), st = old ? old.scrollTop : 0;
  const tw = togSnap(box), gt = gzTops(box), was = box.hidden || box._out;
  for (const a of box.getAnimations()) a.cancel(); box._out = false; box.style.overflow = '';
  box.innerHTML = h; box.hidden = false;
  togSlide(box, tw); if (was) gzFold(box, true); else gzGlide(box, gt);
  const vl = box.querySelector('.gz-list'); vl.addEventListener('scroll', gzDraw);
  gzCompute(); gzChips(); gzDraw(); vl.scrollTop = st; gzDraw();
  if (f) { const q = $('gzQ'); if (q) { q.focus(); q.setSelectionRange(f[0], f[0]); } }
}
$('gcustom').onclick = () => { if (PK.g.mode === 'bin') pkMode('g', null); GZ.on = !GZ.on; GZ.q = ''; GZ.t = 'all'; renderGz(); };
$('gcz').addEventListener('click', e => {
  const b = e.target.closest('[data-gz]'), row = e.target.closest('.gz-s');
  if (!b) { if (row && !e.target.closest('input') && row.querySelector('.gz-name')) { GZ.sel = row.dataset.id; renderGz(); } return; }
  const k = b.dataset.gz, i = row ? +row.dataset.i : -1, ci = e.target.closest('.gz-c') ? +e.target.closest('.gz-c').dataset.i : -1, rk = (e.target.closest('#gcz .vrow.r') || { dataset: {} }).dataset.key;
  if (e.detail > 1 && (k === 'del' || k === 'cdel' || k === 'out' || k === 'add')) return;   // (a double-click's second press: the next row moved up under it)
  if (k === 'tw') { const sk = b.dataset.sk; if (GZ.shut.has(sk)) GZ.shut.delete(sk); else GZ.shut.add(sk); gzCompute(); gzDraw(); return; }
  if (k === 'chip') { GZ.t = b.dataset.t; gzCompute(); gzChips(); document.querySelector('#gcz .gz-list').scrollTop = 0; gzDraw(); return; }
  if (k === 'qclear') { GZ.q = ''; GZ.t = 'all'; renderGz(); return; }
  if (k === 'done') { GZ.on = false; renderGz(); }
  else if (k === 'reset') { GZ.sel = null; gzApply(() => { delete S.L.games; }); }
  else if (k === 'hide') gzEdit(G => { G.secs[i].hide = !G.secs[i].hide; if (!G.secs[i].hide) delete G.secs[i].hide; });
  else if (k === 'del') gzEdit(G => { G.secs.splice(i, 1); });
  else if (k === 'addsec' && gxLayout().secs.length >= 16) toast('A session\'s details take 16 categories at most');   // (what a file keeps)
  else if (k === 'addsec') { const id = nid('g'); GZ.sel = id; gzEdit(G => { G.secs.push({ id, kind: 'list', name: 'New category', cells: [] }); }); const n = document.querySelector('#gcz .gz-s.on .gz-name'); if (n) { n.focus(); n.select(); } }
  else if (k === 'add' && rk) gzEdit(G => { const s = G.secs.find(x => x.id === GZ.sel); if (s && s.cells.length < GX_MAX && !s.cells.some(c => c.key === rk)) s.cells.push({ key: rk }); });
  else if (k === 'out' && rk) gzEdit(G => { const s = G.secs.find(x => x.id === GZ.sel), j = s ? s.cells.findIndex(c => c.key === rk) : -1; if (j >= 0) s.cells.splice(j, 1); });
  else if (k === 'cdel') gzEdit(G => { G.secs.find(x => x.id === GZ.sel).cells.splice(ci, 1); });
});
// the keyboard reaching a category's name field picks that category (as a click on its row does), the field kept
$('gcz').addEventListener('focusin', e => {
  const f = e.target, row = f.closest && f.closest('.gz-s');
  if (!row || !f.matches('.gz-name') || !row.dataset.id || GZ.sel === row.dataset.id) return;
  const id = row.dataset.id, a = f.selectionStart, b = f.selectionEnd;
  GZ.sel = id; renderGz();
  const n = document.querySelector('#gcz .gz-s[data-id="' + CSS.escape(id) + '"] .gz-name'); if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(a, b); } catch (x) { } }
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
// a session's breaks (the game closed and started again within Settings' Same game again: one session) aren't play
const gxGap = x => Array.isArray(x.gaps) ? x.gaps.reduce((p, g) => p + (Array.isArray(g) && g.length >= 2 ? Math.max(0, g[1] - g[0]) : 0), 0) : 0;
// (play is the time its game was the window in front, his rule 11-07: alt-tabbed isn't play. A game's session keeps its
// seconds in front; that share of the time it ran is its play, spread evenly over it. Yours, and a line from before
// front was kept: the whole time)
const gxFr = x => { if (x.custom || typeof x.front !== 'number') return 1; const w = x.end - x.start - gxGap(x), f = typeof x.secs === 'number' ? Math.min(x.front, x.secs) : x.front; return w > 0 ? Math.max(0, Math.min(1, f / w)) : 1; };   // (11-07 audit: front over its length, so a sleep inside it isn't play, as Game time counts it)
const gxPlay = x => Math.max(0, x.end - x.start - gxGap(x)) * gxFr(x);
// its play between two moments (b: Infinity for to now), breaks left out: a session over midnight counts on each day
const gxPlayIn = (x, a, b) => { const o = (s, e) => Math.max(0, Math.min(e, b) - Math.max(s, a)); return Math.max(0, o(x.start, x.end) - (Array.isArray(x.gaps) ? x.gaps.reduce((p, g) => p + (Array.isArray(g) && g.length >= 2 ? o(g[0], g[1]) : 0), 0) : 0)) * gxFr(x); };
// a day's start (midnight, or the first hour where a clock change skips it), from its date: the next one is the date + 1,
// not +24 h (a clock change day is 23 or 25 h)
const gxMid = (y, m, d) => new Date(y, m, d).getTime() / 1000;
// each day's count and length, for the day headers: the sessions that started on it, whole
function gxByDay(ss) {
  const byDay = {};
  for (const x of ss) { const k = localDay(new Date(x.start * 1000)), d = byDay[k] || (byDay[k] = { n: 0, t: 0 }); d.n++; d.t += gxPlay(x); }
  return byDay;
}
// the summary bar opened (a click on it): a period, one game or all, their numbers, a bar a day (a week over long
// spans) and each game's share. The periods go as far back as Keep sessions keeps: 7, 30 and 90 days under it, then the
// days kept, or "all" when they are kept forever; one alone (5 days kept, or 7): no switch. The list under it shows the
// picked game's sessions; closing the bar shows them all again
const GX = { open: false, period: 7, game: null, menu: false, slide: null, sort: { k: 't', d: -1 }, ws: 0, we: 0 };   // (days: Days' own, 11-07)   // (slide: a pick's direction, -1 / 1, while it is drawn)
GX.W = mkWin({ min: () => Math.min(1, 3 / Math.max(1, GX.wn || 1)), draw: () => { if (!GX.open) return; gxSum(gxAll); if (!S.listFilt.g) return; clearTimeout(GX.lt); GX.lt = setTimeout(() => { if (GX.ws + '|' + GX.we === GX.lk) return; renderGames(gxText, gxOpen()); }, 250); } });   // (its window, B)
let gxLc = null;   // the opened bar's chart: its points and scale, for the read-out
let gxAll = [];   // every session (the list: gxSs, the picked game's)
// ---- a number box with arrows (his pick 11-07, mock round 4): Settings' box, its style and size, with an up and a down
// arrow in it. The arrows step it by one within data-min / data-max; a box with data-idle commits once they stop
// (Settings: a few presses are one change, one question), the others at once. Up and Down do the same from the keys
const spinBox = (attrs, v, ph) => '<span class="setin spin"><input ' + attrs + ' inputmode="numeric" maxlength="4" spellcheck="false" autocomplete="off" placeholder="' + ph + '" value="' + v + '">' + SPIN_UD + '</span>';
function spinStep(i, d) {
  const lo = Number.isFinite(+i.dataset.min) ? +i.dataset.min : 0, hi = +i.dataset.max || 9999, t = i.value.trim();
  const v = /^\d+$/.test(t) ? +t : (+i.placeholder || lo), n = Math.max(lo, Math.min(hi, v + d));
  if (String(n) === t) return;
  i.value = n; i.dataset.dirty = 1;
  clearTimeout(i._st); i._st = setTimeout(() => { if (i.isConnected && i.dataset.dirty) { delete i.dataset.dirty; i.dispatchEvent(new Event('change', { bubbles: true })); } }, +i.dataset.idle || 0);
}
// (pressed, not clicked: the box keeps the focus it has, and a press doesn't take it from the field being typed in)
document.addEventListener('mousedown', e => { const b = e.target.closest('.spin .ud b'); if (!b || e.button !== 0) return; e.preventDefault(); const i = b.closest('.spin').querySelector('input'); if (i) (i.closest('.szin') ? szStep : spinStep)(i, +b.dataset.step); });
document.addEventListener('keydown', e => {
  const i = e.target; if (!i.closest || !i.closest('.spin') || i.tagName !== 'INPUT') return;
  if (i.closest('.szin') && (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return;   // (Ctrl+arrows in a size box nudge the tile, as before)
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); (i.closest('.szin') ? szStep : spinStep)(i, e.key === 'ArrowUp' ? 1 : -1); }
}, true);
// the edit panel's size boxes (his 11-09: Settings' arrows on them): Width to the next or the last share it is drawn at (the
// chips not greyed), Height a quarter row, a column a twelfth, within what it can take; each step goes in as a typed number
function szStep(i, d) {
  if (i.disabled) return;
  const t = parseFloat(i.value); let n = null;
  if (i.dataset.sz === 'f') { if (!isFinite(t)) return; const off = sel ? cfOff(sel) : () => false, ok = PCTS.filter(x => !off(x)), x = d > 0 ? ok.find(x => x > t + 0.5) : [...ok].reverse().find(x => x < t - 0.5); if (x != null) n = Math.round(x * 10) / 10; }
  else if (i.dataset.sz === 'h') { const cur = isFinite(t) ? t : 1, x = Math.min(2, Math.max(0.25, (d > 0 ? Math.floor(cur * 4 + PE) + 1 : Math.ceil(cur * 4 - PE) - 1) / 4)); if (Math.abs(x - cur) > 1e-9) n = x; }
  else if (i.dataset.cw) { const cur = isFinite(t) ? Math.round(t * 12 / 100) : 12, w = Math.max(+i.dataset.lo || 1, Math.min(+i.dataset.hi || 12, cur + d)); if (w !== cur) n = Math.round(w * 10000 / 12) / 100; }
  if (n == null) return;
  i.value = n; i.dispatchEvent(new Event('change', { bubbles: true }));
}
// the period slider of Sessions and Warning history: its periods on the left of the bar, the game or cell list on the
// right (a window of any length within one: the chart's, range selector B, 11-07; Days and its box gone)
function perSlider(ps, on) {
  if (ps.length < 2) return '';   // (one period, kept fewer than 7 days: no switch, the list alone, as before)
  return '<span class="gx-pl"><span class="seg seg3 gx-per" role="group" aria-label="Period"><i class="ind"></i>' + ps.map(q => '<button data-p="' + q + '"' + (q === on ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + (q === 'all' ? 'All' : q + ' days') + '</button>').join('') + '</span></span>';
}
const perPick = p => p === 'all' ? p : +p;
const daysIn = (v, K) => Math.max(1, Math.min(K || 3650, Math.round(+v) || 14));   // (1 to the days kept, or 10 years)
function gxPeriods() { const K = feed.gameDays || Infinity, o = [7, 30, 90].filter(q => q < K); o.push(K === Infinity ? 'all' : K); return o; }
function gxSumOpen(all) {
  const ps = gxPeriods(); if (!ps.includes(GX.period)) GX.period = ps.includes(7) ? 7 : ps[0];
  const games = all.filter(x => !x.custom), mine = GX.game ? games.filter(x => x.game === GX.game) : games;   // (games', like the week's)
  const P = GX.period, td = new Date(), f0 = mine.length ? new Date(Math.min(...mine.map(x => x.start)) * 1000) : td;   // (All with a game picked: from its first session, 11-07)
  const a = P === 'all' ? gxMid(f0.getFullYear(), f0.getMonth(), f0.getDate()) : gxMid(td.getFullYear(), td.getMonth(), td.getDate() - (P - 1));
  const a0 = new Date(a * 1000), nd = Math.max(1, Math.round((gxMid(td.getFullYear(), td.getMonth(), td.getDate() + 1) - a) / 86400));
  const rec = mine.filter(x => x.end > a);
  const days = [];
  for (let i = 0; i < nd; i++) { const s = gxMid(a0.getFullYear(), a0.getMonth(), a0.getDate() + i), e = gxMid(a0.getFullYear(), a0.getMonth(), a0.getDate() + i + 1); days.push([rec.reduce((p, x) => p + gxPlayIn(x, s, e), 0), new Date(s * 1000)]); }
  // the window (B): its points (days, weeks past 120 days) and its time; the table is the window's
  const n0 = nd > 120 ? Math.ceil(nd / 7) : nd, per7 = nd > 120 ? 7 : 1;
  { const k = GX.period + '|' + a + '|' + n0; if (GX.wkey !== k) { GX.W.reset(); GX.wkey = k; } }
  GX.wn = n0;
  const tAt = f => { const k = f * n0, i = Math.min(n0 - 1, Math.floor(k)), d0 = i * per7, len = Math.min(per7, nd - d0), s0 = gxMid(a0.getFullYear(), a0.getMonth(), a0.getDate() + d0), s1 = gxMid(a0.getFullYear(), a0.getMonth(), a0.getDate() + d0 + len); return s0 + (k - i) * (s1 - s0); };   // (between midnights: a 23 or 25 hour day keeps its end)
  const wa = GX.W.a, wb = GX.W.b, ws = tAt(wa), we = tAt(wb); GX.ws = ws; GX.we = we;
  const per = Object.create(null);
  for (const x of games) { if (x.end <= ws || x.start >= we) continue; const o = per[x.game] || (per[x.game] = { t: 0, n: 0, fs: 0, fn: 0, last: 0 }); o.t += gxPlayIn(x, ws, we); o.n++; if (x.fps > 0) { o.fs += x.fps; o.fn++; } o.last = Math.max(o.last, Math.min(x.end, we)); }
  // the games in the order of the column picked (his pick 11-06): most played first until then; a game with no fps
  // last, whichever way
  const sv = { game: k => k.toLowerCase(), t: k => per[k].t, share: k => per[k].t, n: k => per[k].n, avg: k => per[k].t / per[k].n, fps: k => per[k].fn ? per[k].fs / per[k].fn : null, last: k => per[k].last }[GX.sort.k] || (k => per[k].t);
  const names = sumHold(GX, Object.keys(per).sort((p, q) => { const a = sv(p), b = sv(q); if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1; return (a < b ? -1 : a > b ? 1 : 0) * GX.sort.d || per[q].t - per[p].t; }));
  // the games to pick from: every game in the log, most played first
  let menu = '';
  if (GX.menu) {
    const allG = Object.create(null); for (const x of games) allG[x.game] = (allG[x.game] || 0) + gxPlay(x);
    const gl = Object.keys(allG).sort((p, q) => allG[q] - allG[p]);
    menu = '<div class="smenu gx-menu"><button data-game=""' + (GX.game ? '' : ' class="on"') + '>All Games<small>' + gl.length + (gl.length === 1 ? ' game' : ' games') + '</small></button><div class="gx-msep"></div>' +
      gl.map(k => '<button data-game="' + esc(k) + '"' + (k === GX.game ? ' class="on"' : '') + '>' + esc(k) + '<small>' + durTxt(allG[k]) + '</small></button>').join('') + '</div>';
  }
  // (the game list and the periods, a pill that glides to the one picked, like the view tabs; nothing the row above
  // already says: no title, no totals)
  const head = perSlider(ps, GX.period) + fltSw('g') +
    '<span class="gx-ddw"><button class="gx-dd' + (GX.menu ? ' on' : '') + '" title="Show one game" aria-haspopup="true" aria-expanded="' + !!GX.menu + '">' + (GX.game ? esc(GX.game) : 'All Games') + GX_CHEV + '</button>' + menu + '</span>';   // (the periods on the left, the game list on the right, 11-07)
  let h = '';
  // the chart: hours played a day (a week past 120 days) as a line, like a session's fps; the average dashed, hours on
  // the left; the pointer on it reads a day out (gxLcHover). Labels: the days of a week, Mondays, or the months
  let pts = days.map(([t, d]) => ({ t, d, w: 0 }));
  if (nd > 120) { pts = []; for (let i = 0; i < nd; i += 7) pts.push({ t: days.slice(i, i + 7).reduce((p, d) => p + d[0], 0), d: days[i][1], w: Math.min(7, nd - i) }); }
  for (const o of pts) { const s = o.d.getTime() / 1000, e = gxMid(o.d.getFullYear(), o.d.getMonth(), o.d.getDate() + (o.w || 1)); o.n = rec.filter(x => gxPlayIn(x, s, e) > 0).length; }
  const n = pts.length, j0 = Math.max(0, Math.floor(wa * n + 1e-9)), j1 = Math.min(n - 1, Math.ceil(wb * n - 1e-9) - 1), vis = pts.slice(j0, j1 + 1), nv = vis.length;
  const H = 120, ymT = Math.max(2, Math.ceil(Math.max(...vis.map(o => o.t)) / 3600 / 2) * 2) * 3600, ymax = sumYm(GX, GX.wkey, ymT, () => { if (GX.open) gxSum(gxAll, true); }), Y = v => +(H - v / ymax * H).toFixed(1), X = i => +(((i + 0.5) / n - wa) / (wb - wa) * 100).toFixed(3);
  const avg = vis.reduce((p, o) => p + o.t, 0) / Math.max(1, nv), line = pts.map((o, i) => X(i) + ',' + Y(o.t)).join(' ');
  gxLc = { pts, n, Y, wa, wb };
  h += '<div class="gx-lc"><div class="gx-lcg"><div class="gx-lcy" style="height:' + H + 'px">' + [0, ymT / 2, ymT].map((v, i) => '<span style="top:' + (H - i * H / 2) + 'px">' + (v / 3600) + 'h</span>').join('') + '</div>' +
    '<div class="gx-lcp gx-hz" style="height:' + H + 'px"><div class="gx-lcclip"><svg viewBox="0 0 100 ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px">' +
    [0, ymax / 2, ymax].map(v => '<line class="g" x1="0" x2="100" y1="' + Y(v) + '" y2="' + Y(v) + '"/>').join('') +
    (avg ? '<line class="av" x1="0" x2="100" y1="' + Y(avg) + '" y2="' + Y(avg) + '"/>' : '') +
    '<polygon points="' + X(0) + ',' + H + ' ' + line + ' ' + X(n - 1) + ',' + H + '"/><polyline points="' + line + '"/></svg></div>' +
    (nv <= 7 ? vis.map((o, k) => { const x = X(j0 + k); return x < -0.01 || x > 100.01 ? '' : '<i class="gx-lcd" style="left:' + x + '%;top:' + Y(o.t) + 'px"></i>'; }).join('') : '') +
    (avg ? '<span class="gx-lca" style="top:' + Y(avg) + 'px">avg ' + durTxt(avg) + (nd > 120 ? '/wk' : '') + '</span>' : '') +
    '<div class="gx-gd"></div><div class="gx-dot fp"></div><div class="gx-tip"></div></div><span></span></div>';
  const end = wb > 0.999 && nv > 7 && !pts[n - 1].w, xl = (o, i) => nv <= 7 ? GX_WD[o.d.getDay()].slice(0, 3) : o.w ? (o.d.getDate() <= 7 && (!end || i < j1 - 1) ? GX_MON[o.d.getMonth()] : '') : (o.d.getDay() === 1 && (!end || i < j1 - 3) ? o.d.getDate() + ' ' + GX_MON[o.d.getMonth()] : '');
  h += '<div class="gx-lcg"><span></span><div class="gx-lcx">' + vis.map((o, k) => { const i = j0 + k, t = xl(o, i), x = X(i); return t && x >= -0.01 && x <= 100.01 ? '<span style="left:' + x + '%">' + t + '</span>' : ''; }).join('') + (end ? '<span class="e">today</span>' : '') + '</div><span></span></div>' +
    '<div class="gx-lcg"><span></span>' + winBarHtml(winBarParts(GX.W, a * 1000, tAt(1) * 1000, d => dMon(d), 'today', f => tAt(f) * 1000), winDrag && winDrag.W === GX.W && winDrag.kind !== 'pan') + '<span></span></div></div>';
  // each game's part of the window; a row picks that game (again: all games)
  const sum = names.reduce((p, k) => p + per[k].t, 0) || 1, ago = u => { const k = Math.round((gxMid(td.getFullYear(), td.getMonth(), td.getDate()) - gxMid(new Date(u * 1000).getFullYear(), new Date(u * 1000).getMonth(), new Date(u * 1000).getDate())) / 86400); return k <= 0 ? 'today' : k === 1 ? 'yesterday' : k + ' days ago'; };
  const sh = (k, t, r) => '<span class="gx-sk' + (r ? ' gx-r' : '') + (GX.sort.k === k ? ' on' : '') + '" data-sort="' + k + '" tabindex="0" role="columnheader" aria-sort="' + (GX.sort.k === k ? (GX.sort.d > 0 ? 'ascending' : 'descending') : 'none') + '">' + t + (GX.sort.k === k ? '<svg viewBox="0 0 10 10"><path d="' + (GX.sort.d > 0 ? 'M2 6.5l3-3 3 3' : 'M2 3.5l3 3 3-3') + '"/></svg>' : '') + '</span>';
  if (!names.length) h += '<div class="wempty">Nothing played from ' + dMon(new Date(ws * 1000)) + ' to ' + dMon(new Date(we * 1000 - 1)) + (GX.game ? ' in ' + esc(GX.game) : '') + '.</div>';
  if (names.length) h += '<div class="gx-gtab"><div class="gx-gh">' + sh('game', 'game') + sh('share', 'share of the time') + sh('t', 'played', 1) + sh('n', 'sessions', 1) + sh('avg', 'average', 1) + sh('fps', 'fps', 1) + sh('last', 'last played', 1) + '</div>' +
    names.map(k => { const o = per[k]; return '<div class="gx-gr' + (k === GX.game ? ' on' : '') + '" data-game="' + esc(k) + '" tabindex="0" role="button" aria-pressed="' + (k === GX.game) + '"><span class="gx-gnm">' + esc(k) + '</span><span class="gx-gbar"><span style="width:' + (o.t / sum * 100).toFixed(1) + '%"></span></span><span class="gx-r">' + durTxt(o.t) + '</span><span class="gx-r">' + o.n + '</span><span class="gx-r">' + durTxt(o.t / o.n) + '</span><span class="gx-r">' + (o.fn ? Math.round(o.fs / o.fn) : '--') + '</span><span class="gx-r gx-ago">' + ago(o.last) + '</span></div>'; }).join('') + '</div>';
  return { head, body: h };
}
// the week's numbers and strip (gsum), or the bar opened
function gxSum(ss, live) {
  // the week: today and the 6 days before, from the first bar's midnight, as the strip draws them
  const days = [], td = new Date();
  for (let i = 6; i >= 0; i--) days.push(new Date(td.getFullYear(), td.getMonth(), td.getDate() - i));
  const now = Date.now() / 1000, week = days[0].getTime() / 1000, recent = ss.filter(x => x.end > week && !x.custom), per = Object.create(null);   // (the week's numbers are games', the part of each played in it)
  for (const x of recent) per[x.game] = (per[x.game] || 0) + gxPlayIn(x, week, Infinity);
  const top = Object.keys(per).sort((a, b) => per[b] - per[a])[0];
  const total = recent.reduce((p, x) => p + gxPlayIn(x, week, Infinity), 0);
  // the week strip: minutes played on each of the last 7 days, today last
  let wk = '';
  const dayMins = days.map(d => { const a = d.getTime() / 1000, e = gxMid(d.getFullYear(), d.getMonth(), d.getDate() + 1); return recent.reduce((p, x) => p + gxPlayIn(x, a, e) / 60, 0); });
  const peak = Math.max(60, ...dayMins);
  days.forEach((d, i) => { const v = dayMins[i]; wk += '<span class="gx-wd' + (i === 6 ? ' today' : '') + '" title="' + (v ? durTxt(v * 60) : 'nothing') + '"><i' + (v ? '' : ' class="z"') + ' style="height:' + (v ? Math.max(3, Math.round(v / peak * 22)) : 2) + 'px"></i><em>' + GX_WD[d.getDay()][0].toUpperCase() + '</em></span>'; });
  const has = ss.some(x => !x.custom); if (!has) GX.open = false;
  const gs = $('gsum');
  if (!has) { if (gs.firstChild) gs.innerHTML = ''; return; }
  // the bar: its row (the week, as it always shows) and under it what opens, like a session's details. Both stay in
  // place: opening, shutting and a pick move them instead of drawing them anew
  let box = gs.querySelector(':scope > .gx-sum');
  if (!box) {
    gs.innerHTML = '<div class="gx-sum"><div class="gx-srow" tabindex="0" role="button" aria-expanded="false"></div><div class="gx-sdet"><div><div class="gx-sdin"><div class="gx-xh"></div><div class="gx-xb"></div></div></div></div></div>';
    box = gs.firstChild;
  }
  const row = GX_CHEV + '<div class="gx-sumtxt">' +
    '<div class="gx-stat"><em>last 7 days</em><b>' + recent.length + '<small>' + (recent.length === 1 ? 'session' : 'sessions') + '</small></b></div>' +
    '<div class="gx-stat"><em>played</em><b>' + (total ? durTxt(total) : '0m') + '</b></div>' +
    (top ? '<div class="gx-stat"><em>most played</em><b>' + esc(top) + '<small>' + durTxt(per[top]) + '</small></b></div>' : '') +
    '</div><div class="gx-week">' + wk + '</div>';
  // (written only when they changed, and the live row's updates wait while text in them is picked)
  const sl = live && getSelection(), held = sl && sl.rangeCount && !sl.isCollapsed && sl.getRangeAt(0).intersectsNode(gs);
  const rw = box.firstChild;   // (no hover text: his call 11-02)
  if (rw._h !== row && !held) { rw.innerHTML = row; rw._h = row; }
  // (a live update waits while the pointer is on what opened, the focus is in the bar or its game list is open: a
  // read-out, a row in focus or the list's scroll would go with the redraw; the next update after)
  const busy = live && (GX.menu || gs.contains(document.activeElement) || !!gs.querySelector('.gx-sdet:hover'));
  if (GX.open && !held && !busy) {
    const o = gxSumOpen(ss), hd = box.querySelector('.gx-xh'), bd = box.querySelector('.gx-xb'), det = box.querySelector('.gx-sdet');
    const slide = GX.slide && box.classList.contains('open') && motionMode() !== 'off' ? GX.slide : 0;   // (a pick in the open bar)
    if (hd._h !== o.head) {
      // (the period's pill glides from where it was to the one picked)
      const i0 = hd.querySelector('.gx-per .ind'), was = i0 ? { x: i0.style.transform, w: i0.style.width } : null;
      hd.innerHTML = o.head; hd._h = o.head;
      gxPill(hd, slide ? was : null);
    }
    if (bd._h !== o.body) {
      const h0 = slide ? det.offsetHeight : 0;
      if (slide) bd.innerHTML = o.body; else sumPatch(bd, o.body, box.classList.contains('open') && motionMode() !== 'off' && (!live || motionOn()));   // (the window dragged, a sort, a live update: in place, 11-08; a live one moves in Full only, the review)
      bd._h = o.body;
      if (slide) {
        // (like Tiles to Overview: the new numbers come in from the side of the pick; the bar eases to their height)
        const e = 'cubic-bezier(0.2, 0.8, 0.2, 1)', h1 = det.offsetHeight;
        bd.animate([{ transform: 'translateX(' + (slide * 3) + '%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: e });
        if (Math.abs(h1 - h0) > 1) det.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 300, easing: e });
      }
    }
  }
  // (shutting keeps what it showed, so it folds away instead of vanishing; the open state goes on once the details
  // are in, so they unfold from nothing)
  if (box.classList.contains('open') !== GX.open) { if (GX.open) void box.offsetHeight; box.classList.toggle('open', GX.open); }
  { const s = box.querySelector('.gx-srow'); if (s) s.setAttribute('aria-expanded', GX.open); }
}
// the period pill under the picked period: moved at once (a new bar), or from where it was (a pick)
function gxPill(hd, was) {
  const ind = hd.querySelector('.gx-per .ind'), b = hd.querySelector('.gx-per button.on'); if (!ind || !b) return;
  const to = () => pillPut(ind, b);
  ind.classList.add('still');
  if (was && was.w) { ind.style.transform = was.x; ind.style.width = was.w; void ind.offsetWidth; ind.classList.remove('still'); to(); }
  else { to(); void ind.offsetWidth; ind.classList.remove('still'); }
}
// the bar opened or shut, a period, a game: the summary drawn again; a game picked (or dropped) draws the list too,
// and a pick slides in from its side (a later period or game from the right, an earlier one from the left)
function gxSet(o) {
  const g = GX.game, p0 = GX.period, was = GX.open, s0 = GX.sort; Object.assign(GX, o); if (!GX.open) { GX.game = null; GX.menu = false; }
  if (was && GX.open) {
    const ps = gxPeriods(), order = gxGameOrder();
    GX.slide = GX.period !== p0 ? Math.sign(ps.indexOf(GX.period) - ps.indexOf(p0)) || 1 : GX.game !== g ? Math.sign(order.indexOf(GX.game) - order.indexOf(g)) || 1 : null;
  }
  // (the focus stays on what was picked: the redraw makes new buttons, the keyboard carries on from the same one)
  const ae = document.activeElement, gs = $('gsum'), q = !ae || !gs.contains(ae) ? null : ae.matches('.gx-per button') ? '.gx-per button[data-p="' + ae.dataset.p + '"]'
    : ae.matches('.gx-gr') ? '.gx-gr[data-game="' + CSS.escape(ae.dataset.game) + '"]' : ae.matches('.gx-dd, .gx-menu button') ? '.gx-dd' : ae.matches('.gx-srow') ? '.gx-srow' : ae.matches('.gx-sk') ? '.gx-sk[data-sort="' + ae.dataset.sort + '"]' : null;
  try {
    flipHold++;
    if (GX.game !== g || (S.listFilt.g && (GX.open !== was || GX.period !== p0))) {   // (Filter list on: a period or the bar shut changes the list too)
      renderGames(gxText, $('glist').querySelector('.gx-sess') ? gxOpen() : undefined);
      if (GX.slide && motionMode() !== 'off') $('glist').animate([{ transform: 'translateX(' + (GX.slide * 3) + '%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      else if (GX.open !== was && motionMode() !== 'off') $('glist').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: SUM_E });   // (the bar shut with a game picked: all games again, faded in, 11-08)
    } else {
      const at = o.sort && motionMode() !== 'off' ? gxRowTops() : null;   // (a column picked: the rows glide to their new places, 11-07)
      gxSum(gxAll);
      if (at) gxRowGlide(at, o.sort.k === s0.k && o.sort.d !== s0.d);
    }
  } finally { flipHold--; GX.slide = null; }
  const n = q && gs.querySelector(q); if (n && n !== document.activeElement) n.focus({ preventScroll: true });
}
// the game table sorted again (his ask 11-06, "add animations to the game sort"): each game's row glides from where it
// was to its new place, and the arrow of a column picked again turns over. Motion off: it just changes
function gxRowTops() { const m = new Map(); for (const r of $('gsum').querySelectorAll('.gx-gr:not(.gx-out)')) m.set(r.dataset.game, r.getBoundingClientRect().top); return m; }
function gxRowGlide(at, flip) {
  for (const r of $('gsum').querySelectorAll('.gx-gr:not(.gx-out)')) {
    const t0 = at.get(r.dataset.game); if (t0 === undefined) continue;
    const dy = t0 - r.getBoundingClientRect().top; if (Math.abs(dy) >= 1) rowGlide(r, dy);   // (sumPatch already glides them: then nothing is left to move)
  }
  const a = flip && $('gsum').querySelector('.gx-sk.on svg'); if (a) a.animate([{ transform: 'rotate(180deg)' }, { transform: 'none' }], { duration: 240, easing: SUM_E });
}
function rowGlide(r, dy) {
  const k = [{ transform: 'translateY(' + dy.toFixed(1) + 'px)' }, { transform: 'none' }]; if (dy < 0) k.splice(1, 0, { opacity: 0.25, offset: 0.4 });   // (one going down fades as it passes: the one going up reads over it)
  r.animate(k, { duration: 340, easing: SUM_E, id: 'glide' });
}
// the open bar's body drawn again in place, not anew (his 11-08 "they snap in instead of having a smooth animation"):
// the chart and the other parts as before, the table kept. Its rows go by their game (a cell in Warning history): one
// that comes grows in, one that goes folds away (and opens again from where it is if it comes back first), one that
// changes place glides there as a sort does, its numbers change in place and its share bar eases to its width. The
// table itself, or the "nothing played" line, grows in and folds away the same. anim false (motion off, the bar shut):
// drawn anew at once
const SUM_E = 'cubic-bezier(0.2, 0.8, 0.2, 1)', SUM_FOLD = ['height', 'minHeight', 'marginTop', 'paddingTop', 'paddingBottom', 'opacity'];
// the table's order while its window is dragged or gliding: as it was (a new row after them), so a row whose share keeps
// crossing another's doesn't flip places on every move; let go, the sorted order (his recording 11-09: a row hung over
// another for seconds, each move starting a new glide to a place already gone)
function sumHold(X, names) {
  const moving = (winDrag && winDrag.W === X.W) || !!X.W.raf;
  if (moving && X.ord) { const pos = new Map(X.ord.map((k, i) => [k, i])); names = names.slice().sort((p, q) => (pos.has(p) ? pos.get(p) : 1e9) - (pos.has(q) ? pos.get(q) : 1e9)); }
  X.ord = names; return names;
}
function sumPatch(bd, html, anim) {
  if (!anim || !bd.firstElementChild) { bd.innerHTML = html; return; }
  const tp = document.createElement('template'); tp.innerHTML = html;
  const kind = e => e.className.split(' ')[0], olds = [...bd.children], used = new Set();
  let at = null;
  for (const n of [...tp.content.children]) {
    const o = olds.find(e => !used.has(e) && kind(e) === kind(n)); let el = n;
    if (o) {
      used.add(o); el = o;
      const out = o.classList.contains('gx-out');
      if (o.classList.contains('gx-gtab')) sumRows(o, n); else if (o.innerHTML !== n.innerHTML) sumKids(o, n);
      if (out) { o.classList.remove('gx-out'); sumFold(o, true); }
    }
    if (at ? at.nextElementSibling !== el : bd.firstElementChild !== el) { if (at) at.after(el); else bd.prepend(el); }
    if (!o) sumFold(el, true);
    at = el;
  }
  for (const o of olds) if (!used.has(o) && !o.classList.contains('gx-out')) { o.classList.add('gx-out'); sumFold(o, false); }
}
// a part or a row growing in from nothing (inn) or folding away into nothing (then gone); from where it is when it was
// already on its way
function sumFold(el, inn) {
  const st = () => { const cs = getComputedStyle(el), o = {}; for (const k of SUM_FOLD) o[k] = cs[k]; return o; };
  const run = el.getAnimations().filter(a => a.id === 'fold'), now = run.length ? st() : null;
  run.forEach(a => a.cancel());
  const full = st(), zero = { height: '0px', minHeight: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 };
  el.style.overflow = 'hidden';
  const a = el.animate([now || (inn ? zero : full), inn ? full : zero], { duration: 260, easing: SUM_E, id: 'fold' });
  a.onfinish = () => { if (inn) el.style.overflow = ''; else el.remove(); };
}
function sumRows(ot, nt) {
  const key = r => r.dataset.game !== undefined ? r.dataset.game : r.dataset.cell;
  const oh = ot.querySelector(':scope > .gx-gh'), nh = nt.querySelector(':scope > .gx-gh');
  if (oh && nh && oh.innerHTML !== nh.innerHTML) oh.innerHTML = nh.innerHTML;
  const was = [...ot.querySelectorAll(':scope > .gx-gr')], by = new Map(), tops = new Map();
  for (const r of was) { by.set(key(r), r); if (!r.classList.contains('gx-out')) tops.set(r, r.getBoundingClientRect().top); }   // (where they are seen, mid-glide too)
  for (const r of was) for (const a of r.getAnimations()) if (a.id === 'glide') a.cancel();
  const order = [], fresh = [];
  for (const n of [...nt.querySelectorAll(':scope > .gx-gr')]) {
    let r = by.get(key(n));
    if (r) { const out = r.classList.contains('gx-out'); sumRow(r, n); if (out) sumFold(r, true); } else { r = n; fresh.push(r); }
    order.push(r);
  }
  // in the new order; one that goes stays after the row it was after, as it folds
  const keep = new Set(order), going = was.filter(r => !keep.has(r)), prev = new Map(was.map((r, i) => [r, was[i - 1] || null]));
  let at = oh;
  for (const r of order) { if (at ? at.nextElementSibling !== r : ot.firstElementChild !== r) { if (at) at.after(r); else ot.prepend(r); } at = r; }
  for (const r of going) { const p = prev.get(r); if (p && p.parentNode === ot) p.after(r); else if (oh) oh.after(r); else ot.prepend(r); }
  for (const r of fresh) sumFold(r, true);
  for (const r of going) if (!r.classList.contains('gx-out')) { r.classList.add('gx-out'); sumFold(r, false); }
  for (const r of order) { const t0 = tops.get(r); if (t0 === undefined) continue; const dy = t0 - r.getBoundingClientRect().top; if (Math.abs(dy) >= 1) rowGlide(r, dy); }
}
// (a part drawn again node by node: what is still there stays the same element, so its own transitions run, as the
// range bar's grab highlight, and the chart's dots fade in only as they come, 11-08)
function sumKids(o, n) {
  const oc = [...o.childNodes], nc = [...n.childNodes];
  nc.forEach((c, i) => { if (i < oc.length) sumMorph(oc[i], c); else o.appendChild(c); });
  for (let i = nc.length; i < oc.length; i++) oc[i].remove();
}
function sumMorph(o, n) {
  if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName || (o.nodeType !== 1 && o.nodeType !== 3)) { o.replaceWith(n); return; }
  if (o.nodeType === 3) { if (o.data !== n.data) o.data = n.data; return; }
  for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of [...n.attributes]) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  if (o.innerHTML !== n.innerHTML) sumKids(o, n);
}
// (a period chart's top eases to its new one as a tall day comes into the window or leaves it, with the window's own
// step, 11-08; a new period, Minimal and Off: at once. The labels say the new top at once)
function sumYm(X, key, to, redraw) {
  if (!motionOn() || X.ymK !== key || !(X.ym > 0)) { cancelAnimationFrame(X.ymR); X.ymR = 0; X.ymT = 0; X.ymK = key; return X.ym = to; }
  if (X.ym === to) return to;
  const t = performance.now(), dt = X.ymT ? Math.min(64, t - X.ymT) : 1000 / 60; X.ymT = t;
  X.ym += (to - X.ym) * (1 - Math.pow(0.7, dt / 16.7));
  if (Math.abs(to - X.ym) < to * 0.003) { X.ym = to; X.ymT = 0; }
  else if (!X.ymR) X.ymR = requestAnimationFrame(() => { X.ymR = 0; redraw(); });
  return X.ym;
}
// (a list drawn again as the log changed: a move to the bin, a restore, an undo, a game starting, 11-08. Its rows and
// day headers that stay glide from where they were; a new one fades in. Full; Minimal only right after a click or a
// key, the change being the reply; Off, or a slide or a pick on its way (flipHold): at once)
let flipHold = 0, userAt = 0;
document.addEventListener('pointerdown', () => { userAt = performance.now(); }, true);
document.addEventListener('keydown', () => { userAt = performance.now(); }, true);
const listRowKey = el => el.dataset.k || (el.classList.contains('gx-day') ? 'd|' + (el.dataset.day || (el.firstElementChild ? el.firstElementChild.textContent : '')) : '');
function listTops(list) {
  const m = motionMode(); if (flipHold || m === 'off' || (m === 'minimal' && performance.now() - userAt > 2500) || !list.offsetParent) return null;
  const t0 = list.getBoundingClientRect().top, at = new Map();
  for (const el of list.querySelectorAll(':scope > .gx-sess, :scope > .gx-day')) { const k = listRowKey(el); if (k) at.set(k, el.getBoundingClientRect().top - t0); }
  return at.size ? at : null;
}
function listGlide(list, at) {
  if (!at) return;
  const t0 = list.getBoundingClientRect().top, vh = innerHeight;
  for (const el of list.querySelectorAll(':scope > .gx-sess, :scope > .gx-day')) {
    const k = listRowKey(el), r = el.getBoundingClientRect(); if (!k || r.bottom < -200 || r.top > vh + 200) continue;   // (out of sight: nothing to see)
    const y0 = at.get(k);
    if (y0 === undefined) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: SUM_E }); continue; }
    const dy = y0 - (r.top - t0); if (Math.abs(dy) >= 1 && Math.abs(dy) < vh) el.animate([{ transform: 'translateY(' + dy.toFixed(1) + 'px)' }, { transform: 'none' }], { duration: 300, easing: SUM_E });
  }
}
// a row kept: what changed in it, in place (the share bar's width eases, deck.css)
function sumRow(r, n) {
  if (r.className !== n.className) r.className = n.className;
  for (const a of ['aria-pressed', 'tabindex', 'role']) if (r.getAttribute(a) !== n.getAttribute(a)) { if (n.hasAttribute(a)) r.setAttribute(a, n.getAttribute(a)); else r.removeAttribute(a); }
  const oc = r.children, nc = [...n.children];
  if (oc.length !== nc.length) { r.replaceChildren(...nc); return; }
  nc.forEach((c, i) => {
    const o = oc[i]; if (o.outerHTML === c.outerHTML) return;
    if (o.className === c.className && o.classList.contains('gx-gbar') && o.children.length === c.children.length) { [...c.children].forEach((s, j) => { if (o.children[j].style.cssText !== s.style.cssText) o.children[j].style.cssText = s.style.cssText; }); return; }
    o.replaceWith(c);
  });
}
// the games in the game list's order: all of them first, then the most played (a pick's side goes by it)
function gxGameOrder() { const t = Object.create(null); for (const x of gxAll) if (!x.custom) t[x.game] = (t[x.game] || 0) + gxPlay(x); return [null].concat(Object.keys(t).sort((p, q) => t[q] - t[p])); }
// (quick clicks, one after another: a word picked by the second one is not text picked, so no click is lost; text
// dragged over in the bar is, and holds it as it is)
const gxPicked = (e, el) => { const sl = getSelection(); return e.detail < 2 && sl && sl.rangeCount > 0 && !sl.isCollapsed && sl.getRangeAt(0).intersectsNode(el); };
$('gsum').addEventListener('mousedown', e => { if (e.detail > 1 && e.target.closest('.gx-srow')) e.preventDefault(); });
// Days' box: a number of days, kept within the days kept (anything else: as it was); Enter takes it too
$('glist').addEventListener('mousedown', e => { if (e.detail > 1 && e.target.closest('.gx-row')) e.preventDefault(); });
$('gsum').addEventListener('click', e => {
  const t = e.target, pk = gxPicked(e, $('gsum'));
  // (its row opens and shuts it, like a session's; what opened under it stays open under clicks)
  if (t.closest('.gx-srow')) { if (!pk) gxSet({ open: !GX.open }); return; }
  const mb = t.closest('.gx-menu button'); if (mb) { gxSet({ game: mb.dataset.game || null, menu: false }); return; }
  if (t.closest('[data-flt]')) { const had = document.activeElement === t.closest('[data-flt]'); S.listFilt.g = !S.listFilt.g; saveState(); gxSum(gxAll); renderGames(gxText, gxOpen()); fltBack(gmodal, had); if (motionMode() !== 'off') $('glist').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: SUM_E }); return; }
  if (t.closest('.gx-dd')) { gxSet({ menu: !GX.menu }); return; }
  const pb = t.closest('.gx-per button'); if (pb) { if (perPick(pb.dataset.p) === GX.period && !GX.W.whole()) GX.W.set(0, 1, true); else gxSet({ period: perPick(pb.dataset.p), menu: false }); return; }   // (the period again: all of it)
  const sk = t.closest('.gx-sk'); if (sk) { const k = sk.dataset.sort; gxSet({ sort: { k, d: GX.sort.k === k ? -GX.sort.d : k === 'game' ? 1 : -1 }, menu: false }); return; }   // (a column again: the other way, 11-06)
  const gr = t.closest('.gx-gr'); if (gr && !pk) { gxSet({ game: GX.game === gr.dataset.game ? null : gr.dataset.game, menu: false }); return; }
  if (GX.menu) gxSet({ menu: false });
});
// the chart's read-out: the day (or week) under the pointer, its time and sessions, on the side that has room
function gxLcHover(pl, e) {
  const on = $('gsum').querySelector('.gx-lcp.hv');
  if (!pl || !gxLc || !gxLc.n) { if (on) on.classList.remove('hv'); return; }
  const L = gxLc, r = pl.getBoundingClientRect(), wa = L.wa || 0, wb = L.wb || 1, X = k => ((k + 0.5) / L.n - wa) / (wb - wa) * 100;
  let i = Math.max(0, Math.min(L.n - 1, Math.floor((wa + (e.clientX - r.left) / r.width * (wb - wa)) * L.n)));
  while (i < L.n - 1 && X(i) < -0.01) i++; while (i > 0 && X(i) > 100.01) i--;   // (the nearest day drawn, its middle in the window as its dot's, 11-07 audit)
  if (X(i) < -0.01 || X(i) > 100.01) { if (on) on.classList.remove('hv'); return; }
  const o = L.pts[i], x = X(i);
  pl.querySelector('.gx-gd').style.left = x + '%';
  const d = pl.querySelector('.gx-dot'); d.style.left = x + '%'; d.style.top = L.Y(o.t) + 'px';
  const tip = pl.querySelector('.gx-tip');
  tip.innerHTML = '<b>' + (o.w ? 'week of ' + o.d.getDate() + ' ' + GX_MON[o.d.getMonth()] : GX_WD[o.d.getDay()] + ' ' + o.d.getDate() + ' ' + GX_MON[o.d.getMonth()]) + '</b><span>' + (o.t ? durTxt(o.t) + ' played, ' + o.n + (o.n === 1 ? ' session' : ' sessions') : 'nothing played') + '</span>';
  const px = x / 100 * r.width, w = tip.offsetWidth;
  tip.style.left = (px + 14 + w > r.width ? px - 14 - w : px + 14) + 'px'; tip.style.top = '-6px';
  pl.classList.add('hv');
}
$('gsum').addEventListener('pointermove', e => gxLcHover(!winDrag && e.target.closest && e.target.closest('.gx-lcp'), e));
// the period charts' windows (B): the chart and the bar under it, in Sessions and in Warning history
for (const [id, X, plotSel] of [['gsum', GX, '.gx-lcp'], ['wsum', WX, '.wx-plot']]) {
  const box = $(id), on = v => box.classList.toggle('wdrag', v);
  box.addEventListener('wheel', e => {
    const pl = e.target.closest && e.target.closest(plotSel); if (!pl || !winWheelOk()) return;
    e.preventDefault(); const r = pl.getBoundingClientRect(); X.W.wheel(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), e.deltaMode ? e.deltaY * 33 : e.deltaY);
  }, { passive: false });
  box.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const bar = e.target.closest('.mbar'); if (bar) { winBarDown(X.W, bar, e, v => { on(v); X.W.o.draw(); }); return; }
    const pl = e.target.closest(plotSel); if (!pl) return;
    e.preventDefault(); winGrab(X.W, 'pan', e.clientX, pl.getBoundingClientRect().width, v => { on(v); if (v && id === 'gsum') gxLcHover(null); if (!v) X.W.o.draw(); });   // (let go: drawn again, the rows to their sorted places, 11-09)
  });
  box.addEventListener('dblclick', e => { if (e.target.closest(plotSel)) { e.preventDefault(); X.W.set(0, 1, true); } });
  box.addEventListener('mousemove', e => { const bar = e.target.closest && e.target.closest('.mbar'); if (bar) winBarCursor(X.W, bar, e); });
}
$('gsum').addEventListener('pointerleave', () => gxLcHover(null));
$('gsum').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.gx-srow, .gx-gr, .gx-sk')) { e.preventDefault(); e.target.click(); } });
// (the game list shuts on a click anywhere else)
document.addEventListener('pointerdown', e => { if (GX.menu && !e.target.closest('#gsum')) gxSet({ menu: false }); });   // (inside the bar its own click does it)
const gxDayTot = same => same.n + (same.n === 1 ? ' session, ' : ' sessions, ') + durS(same.t);
function renderGames(text, keep) {
  // a session's name being typed stays through the redraw: its value, caret and focus, on the same session's field
  const nf = document.activeElement, nx = nf && nf.matches && nf.matches('#glist .gx-nm') ? gxSs[+nf.dataset.g] : null;
  const nk = nx ? { start: nx.start, game: nx.game, v: nf.value, a: nf.selectionStart, b: nf.selectionEnd, typed: nf.value !== nx.game || !!nf._nmKeep } : null;
  if (nx) nf._nmKeep = 0;   // (the old field goes: nothing saved from it on its way out)
  gxText = text || ''; gxLoaded = true; renderRec();
  if (PK.g.mode === 'bin') return;   // (the bin on show: the list waits for Back)
  let ss = [];
  for (const line of (text || '').split(/\r?\n/)) {
    try { const x = line.trim() ? JSON.parse(line) : null; if (x && typeof x === 'object' && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start) { x._raw = line; ss.push(x); } } catch (e) { }   // (_raw: its line, for a move to the bin)
  }
  // (the session in progress: Now playing. A log line with its start is its earlier part while a merge's old line
  // waits to come out, or the line written at its end, which ends as late or later)
  if (gxNow) { const j = ss.findIndex(x => x.start === gxNow.start && x.game === gxNow.game); if (j < 0) ss.push(gxNow); else if (feed.game === gxNow.game && ss[j].end < gxNow.end) ss[j] = gxNow; }
  const keepCut = feed.gameDays ? Date.now() / 1000 - feed.gameDays * 86400 : -Infinity;   // (no days set after a damaged settings file: nothing is cut)
  for (let i = ss.length - 1; i >= 0; i--) if (ss[i].end < keepCut) ss.splice(i, 1);   // (older than the days kept: going at the next trim)
  ss.sort((a, b) => b.start - a.start);
  lastGameCount = ss.filter(x => !x.live).length; gxTl.length = 0; gxAll = ss.slice();   // (Clear's count: the log's, not the one in progress)
  if (GX.game && !ss.some(x => x.game === GX.game)) GX.game = null;   // (its sessions all gone: all games again)
  gxSum(ss);
  if (GX.game) ss = ss.filter(x => x.game === GX.game);   // (the picked game's sessions; the headers count its time)
  const gw = S.listFilt.g && GX.open && GX.we > GX.ws; GX.lk = GX.ws + '|' + GX.we;
  if (gw) ss = ss.filter(x => x.end > GX.ws && x.start < GX.we);   // (Filter list on: the sessions in the chart's window, 11-09)
  gxSs = ss;
  if (gxCmp) { gxCmpDraw(); return; }   // (two compared: they stay on show, 11-06)
  const byDay = gxByDay(ss), now = Date.now() / 1000, dayKey = u => localDay(new Date(u * 1000));
  const today = localDay(new Date()), yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yest = localDay(yd);
  // a day's header: its sessions and their time (the week strip and the chart count a session past midnight on both days)
  const dayHd = dk => {
    const [yy, mm, dd] = dk.split('-').map(Number), d = new Date(yy, mm - 1, dd);
    const name = dk === today ? 'today' : dk === yest ? 'yesterday' : now - d.getTime() / 1000 < 6 * 86400 ? GX_WD[d.getDay()] : '';
    const date = (name && name !== 'today' && name !== 'yesterday' ? '' : GX_WD[d.getDay()].slice(0, 3) + ' ') + d.getDate() + ' ' + GX_MON[d.getMonth()];   // "thursday 8 oct", "yesterday sat 10 oct"
    return '<div class="gx-day" data-day="' + dk + '"><div>' + (name ? name + '<span>' + date + '</span>' : date) + '</div><div class="gx-tot">' + gxDayTot(byDay[dk]) + '</div></div>';
  };
  // each day: its header, the sessions that started on it (a session past midnight stays whole under its first day)
  let h = '', last = null;
  ss.forEach((x, i) => { const dk = dayKey(x.start); if (dk !== last) { last = dk; h += dayHd(dk); } h += gxSessHtml(x, i, false); });
  const list = $('glist'), fl = listTops(list);
  list.innerHTML = h ? '<div class="gx-cols"><span></span><span>session</span><span class="gx-r">length</span><span class="gx-r">fps</span><span class="gx-r">1% low</span><span>limited by</span><span class="gx-r">warnings</span></div>' + h
                     : gw && gxAll.length ? '<div class="wempty ico pad">Nothing played from ' + dMon(new Date(GX.ws * 1000)) + ' to ' + dMon(new Date(GX.we * 1000 - 1)) + (GX.game ? ' in ' + esc(GX.game) : '') + '.</div>'
                     : '<div class="wempty ico pad">No sessions yet. A game shows up here while you play it, and stays once you have played it for over a minute. Start session records one of your own.</div>';
  if (Array.isArray(keep)) {   // (drawn again: what was open stays open, at once; the popup itself opens with every session shut)
    list.classList.add('still');
    for (const el of list.querySelectorAll('.gx-sess')) { const x = gxSs[+el.dataset.g]; if (!x || !keep.includes(x.start)) continue; gxOpenSess(el, x); }
    requestAnimationFrame(() => requestAnimationFrame(() => list.classList.remove('still')));
  }
  listGlide(list, fl); pkMark('g');
  if (nk) {
    const j = gxSs.findIndex(x => x.start === nk.start && x.game === nk.game), el = j >= 0 && list.querySelector('.gx-nm[data-g="' + j + '"]');
    if (el) {
      if (nk.typed) { el.value = nk.v; el._nmKeep = 1; }   // (a value the page put back: leaving the field saves it, no change event comes for it)
      el.focus({ preventScroll: true }); try { el.setSelectionRange(nk.a, nk.b); } catch (e) { }
    }
  }
}
// a session opened: its details built, its timeline drawn
function gxOpenSess(el, x) { gxFill(el); const z = el.querySelector('.gx-tlz'); if (z && x) z.outerHTML = gxTimeline(x, gxSplit(x), +z.dataset.g); el.classList.add('open'); const rw = el.querySelector('.gx-row'); if (rw) rw.setAttribute('aria-expanded', 'true'); }
// a session: its line in the list and its details (full: built now, else when it opens); the one in progress goes "to now"
function gxSessHtml(x, i, full, bin) {
    const sp = gxSplit(x), away = typeof x.front === 'number' && typeof x.secs === 'number' ? x.secs - x.front : 0, nb = Array.isArray(x.gaps) ? x.gaps.length : 0;
    const wn = Math.max(0, +x.warns || 0), wl = Array.isArray(x.wl) ? x.wl.filter(w => Array.isArray(w) && w.length >= 3) : [];
    const wt = wl.length ? ' title="' + esc(wl.map(gxWarn).join(', ')) + '"' : '', wv = wn ? '<span class="gx-wv"' + wt + '>' + wn + (wn === 1 ? ' warning' : ' warnings') + '</span>' : '<span class="gx-ok">none</span>';
    const when = hhmm(x.start) + ' to ' + (x.live ? 'now' : hhmm(x.end)) + (!x.custom && x.from - x.start > 90 ? ', tracked from ' + hhmm(x.from) : '')   /* (a session of your own says nothing more: his call 11-02) */ + (nb ? ', ' + (nb === 1 ? '1 break' : nb + ' breaks') : '');
    const len = durS(gxPlay(x)), lenT = x.live ? ' title="so far"' : !x.custom && away >= 60 ? ' title="' + durTxt(away) + ' not in front"' : '';
    const nm = '<span class="gx-gn' + (x.live ? ' lv"><span class="gx-gt">' + esc(x.game) + '</span><span class="gx-now">now playing</span>' : '">' + esc(x.game)) + '</span>';
    const lim = sp.n ? gxNbar(sp) + '<span class="gx-sub">' + sp.top[0] + ' ' + sp.top[1] + '%</span>' : '<span class="gx-sub">--</span>';
    return '<div class="gx-sess' + (x.custom ? ' cust' : '') + (x.live ? ' live' : '') + '" data-g="' + i + '" data-k="' + esc(x.start + '|' + x.game) + '"><div class="gx-row" tabindex="0" role="button" aria-expanded="false">' + GX_CHEV +
         '<span class="gx-gm">' + nm + '<span class="gx-sub">' + when + '</span></span>' +
         '<span class="gx-c gx-num"' + lenT + '>' + len + '</span><span class="gx-c gx-num gx-fps">' + gxF(x.fps) + '</span><span class="gx-c gx-num gx-lo">' + gxF(x.low) + '</span>' +
         '<span class="gx-c gx-lb">' + lim + '</span><span class="gx-c gx-st">' + wv + '</span>' + (bin ? PK_PURGE : '') + '</div>' +
         '<div class="gx-det"><div>' + (full ? gxDetail(x, sp, i, false, gxActs(x, i)) : '<div class="gx-lz" data-g="' + i + '"></div>') + '</div></div></div>';
}
// the session in progress from the host (every 5 s while the popup is open; null: none): its row drawn again in place,
// open as it was; one that came or went redraws the list
let gxNow = null;
function gxLive(s) {
  gxNow = s && typeof s === 'object' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start ? s : null;
  if (!gmodal.classList.contains('open') || !gxLoaded || PK.g.mode === 'bin' || gxCmp) return;
  const list = $('glist'), i = gxSs.findIndex(x => x.live);
  if (!gxNow) { if (i >= 0 && !gxSs[i].start) return; if (i >= 0) renderGames(gxText, gxOpen()); return; }   // (no game, or it just ended: the log that comes with its end draws the list again; one too short for a line, here, 11-06)
  // (another game than the one picked: not in the list, only in the numbers)
  if (GX.game && gxNow.game !== GX.game) { const j = gxAll.findIndex(x => x.live); if (j >= 0 && gxAll[j].start === gxNow.start) gxAll[j] = gxNow; else renderGames(gxText, gxOpen()); gxSum(gxAll, true); return; }
  { const j = gxAll.findIndex(x => x.live); if (j >= 0) gxAll[j] = gxNow; }
  if (i < 0 && S.listFilt.g && GX.open && GX.we > GX.ws && !(gxNow.end > GX.ws && gxNow.start < GX.we) && gxAll.some(x => x.live && x.start === gxNow.start && x.game === gxNow.game)) { gxSum(gxAll, true); return; }   // (Filter list on and it is outside the window: only the numbers, not the whole list each update, 11-09)
  if (i < 0 || gxSs[i].start !== gxNow.start || gxSs[i].game !== gxNow.game) { renderGames(gxText, list.querySelector('.gx-sess') ? gxOpen() : undefined); return; }
  const el = list.querySelector('.gx-sess[data-g="' + i + '"]'); if (!el || el.contains(document.activeElement)) return;   // (focused: kept, Enter and Space go on working, 11-06)
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
  if (PK.g.mode) pkMark('g');   // (picking: it stays out)
  // (its days' totals and the week's numbers follow it; past midnight its new day gets a header: drawn again)
  gxSum(gxAll, true);
  const byDay = gxByDay(gxSs), hds = [...list.querySelectorAll('.gx-day')], have = new Set(hds.map(hd => hd.dataset.day));
  if (Object.keys(byDay).some(k => !have.has(k))) { renderGames(gxText, gxOpen()); return; }
  for (const hd of hds) { const d = byDay[hd.dataset.day]; if (d) setText(hd.querySelector('.gx-tot'), gxDayTot(d)); }
}
let gxSs = [];   // the sessions as listed, for the timelines drawn when they open
// a session's details, built the first time it opens (all of them up front made a big log slow and heavy)
function gxFill(sess) { const z = sess && sess.querySelector('.gx-lz'); if (!z) return; const i = +z.dataset.g, x = gxSs[i]; if (x) z.outerHTML = gxDetail(x, gxSplit(x), i, false, gxActs(x, i)); }
// under a session's details: its name (one of your own) and Delete
const gxActs = (x, i) => x.live ? '' : '<div class="gx-acts">' + (x.custom ? '<label class="gx-nmf"><em>name</em><input class="gx-nm" data-g="' + i + '" value="' + esc(x.game) + '" maxlength="60" spellcheck="false" title="Rename"></label>' : '') +
  '<span class="sp"></span><button class="wclear gx-del" data-g="' + i + '" title="Move this session to the bin, where it can be brought back">Delete session</button></div>';
const gxOpen = () => [...document.querySelectorAll('#glist .gx-sess.open')].map(s => gxSs[+s.dataset.g] && gxSs[+s.dataset.g].start);
// ---- two sessions side by side (his pick 11-06): two picked, Compare shows the newer one's summary with the older
// one's under each number, one chart with the older one's fps dashed (both from their start), and both maxima of each
// reading with the change; worse past a step in yellow (fps 8% lower, 4 °C hotter). Back, Esc or the popup closing
// end it ----
let gxCmp = null;   // { a, b, cq }: the two by start and game (a the older, or as picked in Compare: cq)
const gxCmpOf = q => gxAll.find(x => x.start === q.start && x.game === q.game) || null;
function gxCmpStart(xs, cq) {   // (cq: from Compare, A and B as picked; Back goes back to it)
  const [a, b] = cq ? xs : xs.slice().sort((p, q) => p.start - q.start);
  gxCmp = { a: { start: a.start, game: a.game }, b: { start: b.start, game: b.game }, cq: !!cq };
  pkMode('g', null, true); GX.menu = false; gmodal.classList.add('cmp'); $('gcmpBtn').classList.toggle('on', !!cq); $('gcmpBtn').setAttribute('aria-pressed', !!cq);
  gxCmpDraw(); const c = $('glist').closest('.mcard'); if (c) c.scrollTop = 0;
  if (gxCmp) pkSlide('g', 1);   // (in as the bin's switch comes in, 11-08)
}
// ---- the comparison's header (11-09): Back, A and B, the arrows between that swap them ----
const GX_SWAPI = '<svg viewBox="0 0 24 24"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/></svg>';
const gxKey = x => x.start + '|' + x.game;
const gxLab = x => { const d = new Date(x.start * 1000), cap = w => w.charAt(0).toUpperCase() + w.slice(1); return cap(GX_WD[d.getDay()].slice(0, 3)) + ' ' + d.getDate() + ' ' + cap(GX_MON[d.getMonth()]) + ' ' + hhmm(x.start); };
const gxChip = (x, k) => '<span class="gx-chip" data-side="' + k + '"><span class="gx-ab' + (k === 'b' ? ' b' : '') + '">' + k.toUpperCase() + '</span><b>' + esc(x.game) + '</b>' + gxLab(x) + '</span>';
// (A and B trade places: each session's button glides to the other's place, the arrows turn over)
function gxCmpSwap() {
  if (!gxCmp) return;
  const r0 = [...document.querySelectorAll('#glist .gx-chip')].map(c => c.getBoundingClientRect());
  gxCmp = { a: gxCmp.b, b: gxCmp.a, cq: gxCmp.cq }; gxCmpDraw();
  const sw = document.querySelector('#glist .gx-swap'); if (sw) sw.focus({ preventScroll: true });
  if (motionMode() === 'off' || r0.length !== 2) return;
  const cs = [...document.querySelectorAll('#glist .gx-chip')]; if (cs.length !== 2) return;
  cs.forEach((c, i) => { const b = c.getBoundingClientRect(); c.animate([{ transform: 'translateX(' + (r0[1 - i].left - b.left).toFixed(1) + 'px)' }, { transform: 'none' }], { duration: 300, easing: SUM_E }); });
  const a = sw && sw.querySelector('svg'); if (a) a.animate([{ transform: 'rotate(180deg)' }, { transform: 'none' }], { duration: 300, easing: SUM_E });
  const inn = document.querySelector('#glist .gx-cmp .gx-in'); if (inn) inn.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
}
function gxCmpEnd() {   // (from Compare: back to it, A and B as they are now)
  const back = gxCmp && gxCmp.cq ? gxCmp : null, had = $('glist').contains(document.activeElement); gxCmp = null; gmodal.classList.remove('cmp'); if (back) { CQ.a = gxKey(back.a); CQ.b = gxKey(back.b); }
  flipHold++; try { renderGames(gxText); } finally { flipHold--; }
  if (back) pkMode('g', 'cmp', true); else { $('gcmpBtn').classList.remove('on'); $('gcmpBtn').setAttribute('aria-pressed', false); }
  if (had) { const f = back ? $('gcbar').querySelector('[data-pk="cmpgo"]') : $('gcmpBtn'); if (f && !f.disabled) f.focus({ preventScroll: true }); }   // (Back from the keyboard: the focus to Compare again, 11-09)
  pkSlide('g', -1, true);
}
function gxCmpDraw() {
  const A = gxCmpOf(gxCmp.a), B = gxCmpOf(gxCmp.b);
  if (!A || !B) { gxCmpEnd(); return; }   // (one of them went to the bin meanwhile, 11-06)
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1), lab = x => { const d = new Date(x.start * 1000); return cap(GX_WD[d.getDay()].slice(0, 3)) + ' ' + d.getDate() + ' ' + cap(GX_MON[d.getMonth()]) + ' ' + hhmm(x.start); };
  const sg = n => (n > 0 ? '+' : n < 0 ? '\u2212' : '\u00b1') + Math.abs(n);
  // the two rows as the list draws them, A and B where the chevron was, nothing to open
  const row = (x, t) => { const n = document.createElement('div'); n.innerHTML = gxSessHtml(x, -1, false); const r = n.firstChild, ch = r.querySelector('.gx-row > svg'), det = r.querySelector('.gx-det'), rw = r.querySelector('.gx-row');
    if (ch) ch.outerHTML = '<span class="gx-ab' + (t === 'B' ? ' b' : '') + '">' + t + '</span>'; if (det) det.remove(); rw.removeAttribute('tabindex'); rw.removeAttribute('role'); return r.outerHTML; };
  // the summary: B's, with A's under each number and the change
  const sA = gxSplit(A), sB = gxSplit(B), itA = gxItems(A), itB = gxItems(B);
  const tmp = document.createElement('div'); tmp.innerHTML = gxSummary(B, sB, itB); const s5 = tmp.firstChild, d = [...s5.children];
  const hot = its => its.filter(t => /°/.test(t.u) && t.m !== null && !gxTj(t)).reduce((p, q) => !p || q.m > p.m ? q : p, null), hA = hot(itA), hB = hot(itB);
  const sub = (el, txt, y) => { if (el) el.insertAdjacentHTML('beforeend', '<span class="gx-d' + (y ? ' y' : '') + '">' + txt + '</span>'); };   // (under B's own lines, 11-06)
  if (A.fps > 0 && B.fps > 0) sub(d[0], 'A ' + gxF(A.fps) + ', ' + sg(Math.round((B.fps - A.fps) / A.fps * 100)) + '%', B.fps < A.fps * 0.92); else sub(d[0], 'A ' + gxF(A.fps));
  sub(d[1], 'A ' + (A.custom ? durS(A.end - A.start) : durTxt(gxPlay(A))));
  if (hA && hB) sub(d[2], 'A ' + gxF(hA.m, 1) + ' ' + esc(hA.u) + ', ' + sg(Math.round((hB.m - hA.m) * 10) / 10) + ' ' + esc(hB.u), hB.m - hA.m >= 4);
  if (sA.n) sub(d[3], 'A ' + sA.top[0] + ' ' + sA.top[1] + '%');
  sub(d[4], 'A ' + Math.max(0, +A.warns || 0));
  // the chart: B's, A's fps dashed over it on one scale (cut at B's length)
  const gi = gxTl.length, w = document.createElement('div'); w.innerHTML = gxTimeline(B, sB, gi); const tl = w.firstChild;
  const DB = gxMinutes(B), DA = gxMinutes(A), N = DB.N, af = DA.fv.slice(0, N), svg = tl && tl.querySelector('svg.gx-fpsc');
  if (svg) {
    const all = DB.fv.concat(DB.lv, af).filter(v => v !== null), mn = Math.min(...all), mx = Math.max(...all), sp0 = Math.max(1, mx - mn);
    const raw = Math.max(5, sp0 * 1.25 / 4), pw = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(s => s * pw).find(s => s >= raw);
    let lo = Math.max(0, Math.floor((mn - sp0 * 0.08) / step) * step), top = Math.ceil((mx + sp0 * 0.08) / step) * step;
    if (top - lo < 2 * step) { top += step; lo = Math.max(0, lo - step); }
    gxTl[gi].lo = lo; gxTl[gi].top = top;   // (its read-out's dots on the same scale, 11-06)
    const H = 140, X = m => ((m + 0.5) * 10).toFixed(1), Y = v => (H - (Math.max(lo, Math.min(top, v)) - lo) / (top - lo) * H).toFixed(1);
    const runs = arr => { const out = []; let cur = null; arr.forEach((v, m) => { if (v === null) { cur = null; return; } if (!cur) out.push(cur = []); cur.push(m); }); return out; };
    const line = (arr, cls) => runs(arr).map(r => '<polyline class="' + cls + '" points="' + (r.length > 1 ? r.map(m => X(m) + ',' + Y(arr[m])).join(' ') : (+X(r[0]) - 3) + ',' + Y(arr[r[0]]) + ' ' + (+X(r[0]) + 3) + ',' + Y(arr[r[0]])) + '"/>').join('');
    let grid = '', yl = '', band = '';
    for (let v = lo; v <= top + 1e-9; v += step) { grid += '<line x1="0" x2="' + N * 10 + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/>'; yl += '<span style="top:' + (+Y(v) / H * 100).toFixed(2) + '%">' + +v.toFixed(1) + '</span>'; }
    for (const r of runs(DB.fv)) if (r.length > 1 && r.every(m => DB.lv[m] !== null)) band += '<polygon points="' + r.map(m => X(m) + ',' + Y(DB.fv[m])).join(' ') + ' ' + r.slice().reverse().map(m => X(m) + ',' + Y(DB.lv[m])).join(' ') + '"/>';
    svg.innerHTML = grid + band + line(DB.lv, 'lo') + line(af, 'ca') + line(DB.fv, 'fp');
    const ya = tl.querySelector('.gx-tr.f .gx-yax'); if (ya) ya.innerHTML = yl;
    const leg = tl.querySelector('.gx-leg'), f = leg && leg.querySelector('b.ln.fp');
    if (f) { f.parentElement.lastChild.textContent = 'fps B'; f.parentElement.insertAdjacentHTML('beforebegin', '<span><b class="ln ca"></b>fps A</span>'); }
  }
  if (tl) { const ch = tl.querySelector(':scope > .gx-ch span'); if (ch) ch.textContent = ''; }
  // the readings: A's max, B's max, the change
  let grp = '';
  for (const s of gxLayout().secs) {
    if (s.hide || s.kind !== 'list') continue;
    const rows = s.cells.map(c => {
      const a = gxFind(itA, c), b = gxFind(itB, c); if (!a || !b || a.m === null || b.m === null) return '';
      const gb = b.u === 'MB', cv = v => gb ? v / 1024 : v, u = gb ? 'GB' : b.u, k = /°/.test(u) || gb ? 1 : 0, dv = Math.round((cv(b.m) - cv(a.m)) * (k ? 10 : 1)) / (k ? 10 : 1);
      return '<div class="gx-rw"><span class="n">' + esc(gxCellName(c)) + '</span><span class="a">' + gxF(cv(a.m), k) + '</span><span class="m">' + gxF(cv(b.m), k) + '<u>' + esc(u) + '</u></span><span class="d' + (/°/.test(u) && dv >= 4 ? ' y' : '') + '">' + sg(dv) + '</span></div>';
    }).join('');
    if (rows) grp += '<div class="gx-grp"><div class="gx-ch gx-ch4"><i>' + esc(s.name) + '</i><span>A max</span><span>B max</span><span>change</span></div>' + rows + '</div>';
  }
  $('glist').innerHTML = '<div class="gx-cmp"><div class="gx-cmph"><button class="gxh-b gx-cmpb" title="Back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>' + gxChip(A, 'a') + '<button class="gxh-b gx-swap" title="Swap A and B">' + GX_SWAPI + '</button>' + gxChip(B, 'b') + '</div>' +
    row(A, 'A') + row(B, 'B') + '<div class="gx-in">' + s5.outerHTML + (tl ? tl.outerHTML : '') + (grp ? '<div class="gx-groups">' + grp + '</div>' : '') + '</div></div>';
}
// a custom session's new name: saved when the field changes, or when it is left with a name a redraw put back
function gxName(el) {
  el._nmKeep = 0;
  const x = gxSs[+el.dataset.g], v = el.value.trim().slice(0, 60);
  if (x && v && v !== x.game) send({ t: 'gedit', act: 'name', start: x.start, end: x.end, game: x.game, name: v }); else if (x) el.value = x.game;
}
$('glist').addEventListener('change', e => { if (e.target.matches('.gx-nm')) gxName(e.target); });
$('glist').addEventListener('focusout', e => { if (e.target.matches('.gx-nm') && e.target._nmKeep) gxName(e.target); });
$('glist').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.gx-nm')) e.target.blur();
  else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.gx-row')) { e.preventDefault(); e.target.click(); }   // (a session opened from the keyboard)
});
$('glist').addEventListener('click', e => {
  if (e.target.closest('.gx-cmpb')) { gxCmpEnd(); return; }
  if (e.target.closest('.gx-swap')) { gxCmpSwap(); return; }
  const pg = e.target.closest('.gx-purge'); if (pg) { pkPurge('g', pg.closest('.gx-sess')); return; }   // (a bin row's own button: not a pick)
  if (PK.g.mode) { const s = e.target.closest('.gx-sess'); if (s) pkToggle('g', s); return; }   // (picking: a click picks)
  const d = e.target.closest('.gx-del');
  if (d) { const x = gxSs[+d.dataset.g]; if (x) askConfirm('Delete this session?', x.game + ', ' + localDay(new Date(x.start * 1000)) + ' ' + hhmm(x.start) + ' to ' + hhmm(x.end) + '. It goes to the bin, where it can be brought back.', 'Delete session', () => { const y = gxSs.find(s => s.start === x.start && s.end === x.end) || x; send({ t: 'gedit', act: 'del', start: y.start, end: y.end, game: y.game }); }); return; }
  const r = e.target.closest('.gx-row'); if (!r) return;
  gxFill(r.parentNode);
  const z = r.parentNode.querySelector('.gx-tlz'), x = z && gxSs[+z.dataset.g];
  if (x) z.outerHTML = gxTimeline(x, gxSplit(x), +z.dataset.g);
  r.parentNode.classList.toggle('open'); r.setAttribute('aria-expanded', r.parentNode.classList.contains('open'));
  if (r.parentNode.classList.contains('open')) centreOpen(r.parentNode);
});
// a session or a warning just opened: its popup glides so it sits in the middle, by its height once open (its details
// grow over 300 ms: their content's height is known now); taller than the popup, its top just under the day's header
// (11-02, his ask)
function centreOpen(el, again) {
  const card = el.closest('.mcard'); if (!card || !el.isConnected || !el.classList.contains('open')) return;
  const det = el.querySelector('.gx-det > div'), cr = card.getBoundingClientRect(), r = el.getBoundingClientRect();
  const grow = det ? det.scrollHeight - det.clientHeight : 0, h = r.height + grow, top = r.top - cr.top + card.scrollTop, view = card.clientHeight;
  // (taller than the popup: right under its own day's header, which then sits on top, over the day before's: 11-02, his
  // "put saturday on top, not yesterday")
  let hd = el.previousElementSibling; while (hd && !hd.classList.contains('gx-day')) hd = hd.previousElementSibling;
  const hh = hd ? hd.offsetHeight : 0;
  // (centred, its own header would sit just under the one on top, two headers stacked: its own goes on top instead)
  let want = h + hh + 40 > view ? top - hh - 1 : top - (view - h) / 2;
  if (hd && top - hh - want < hh * 2) want = top - hh - 1;
  want = Math.max(0, want);
  // (one glide, 11-02 motion audit: near the bottom the list is padded for what is still to grow, so the scroll goes all
  // the way at once instead of stopping short and going on later; the padding goes once the details fill it)
  // (the correction below is for this row only: another opened, or the list scrolled by hand, and it lets go)
  if (!again) { card._centre = el; if (!card._wheel) { card._wheel = 1; card.addEventListener('wheel', () => { card._centre = null; }, { passive: true }); } }
  else if (card._centre !== el) return;
  if (!again && grow > 0) {
    clearTimeout(card._padT); card.style.paddingBottom = '';
    card.style.paddingBottom = (parseFloat(getComputedStyle(card).paddingBottom) + grow) + 'px';
    card._padT = setTimeout(() => { card.style.paddingBottom = ''; }, 340);
  }
  if (Math.abs(card.scrollTop - want) > (again ? 24 : 4)) card.scrollTo({ top: want, behavior: motionMode() === 'off' ? 'auto' : 'smooth' });
  // (once it is open: a correction, only when it ended up well off)
  if (!again) setTimeout(() => centreOpen(el, true), 360);
}
function showGame() {
  const rs = feed.rec || [];
  $('gameDot').classList.toggle('on', !!feed.game || rs.length > 0);
  $('gamesBtn').title = 'Sessions' + (feed.game ? ': ' + feed.game + ' running, ' + durTxt(Math.max(60, nowTs - feed.gameSince - (feed.gameGap || 0))) + (feed.front ? '' : ', in the background') : '') + (rs.length ? (feed.game ? ', ' : ': ') + 'recording ' + rs.map(x => x[1]).join(', ') : '');
  if (gmodal.classList.contains('open')) renderRec();
}

// ---------- settings ----------
const setmodal = $('setmodal');
// (what Settings shows from the host: drawn again only when it changed, 11-06)
const setSigOf = () => JSON.stringify([feed.autostart, feed.hwinfo, feed.keepBusy, feed.keepWait, feed.keep, feed.keepNote, feed.fpsBusy, feed.fpsWait, feed.fps, feed.fpsState, feed.updates, feed.latest, feed.canUpdate, feed.estNote, feed.gameDays, feed.warnDays, feed.gameMerge]);
// (a slider of the look let go by a redraw or a pick, not by the pointer: its change kept as one step and saved first, so a
// theme or a saved look picked right after isn't marked changed by it, 11-09)
function lkFlush() { clearTimeout(lkIdle); if (lkDrag == null) return; const b = lkDrag; lkDrag = null; if (snapOf() !== b) { S.look.changed = true; pushUndo(b); saveState(); syncUndo(); } }
function renderSettings() {
  // (a slider of the look let go by a redraw, not by the pointer: its change kept as one step and saved, the review 11-05)
  lkFlush();
  // (a field being typed in keeps what was typed, and its focus)
  const fa = document.activeElement, typing = fa && fa.tagName === 'INPUT' && fa.type !== 'range' && fa.id && $('setbody').contains(fa) ? { id: fa.id, v: fa.value, a: fa.selectionStart, b: fa.selectionEnd } : null;
  const rng = fa && fa.type === 'range' && fa.id && $('setbody').contains(fa) ? fa.id : null;   // (a slider in focus keeps it, its value as drawn)
  const tw = togSnap($('setbody')), sw = setmodal.classList.contains('open') ? segSnap($('setbody')) : null, pw = sw && pickSnap($('setbody')), aw = sw ? accSnap($('setbody')) : null, spT = spinAt();
  if (lkPick === 'acc' && S.look.tint === 'none') lkPick = null;   // (Mono by an undo or a look picked with the accent's editor open: no box to hang it on)
  const fa0 = document.activeElement, fk = fa0 && fa0.closest && fa0.closest('#setbody [data-lk]') && fa0.matches(':focus-visible') ? [fa0.dataset.lk, fa0.dataset.k || ''] : null;   // (a key on a pick: the focus comes back to it, 11-09 review)
  const pvEl = $('lkPv'), thL = $('lkThL'), hadSave = !!$('setbody').querySelector('.lk-save'); if (thL && setmodal.classList.contains('open')) lkThTop = thL.scrollTop;   // (the Look page, 11-09: a list from the last time it was open says nothing)
  renderSettings0(); feed.setSig = setSigOf();
  togSlide($('setbody'), tw); segPills($('setbody'), sw); pickSlide($('setbody'), pw); accSlide($('setbody'), aw); spinOn(spT); dselUp($('setbody')); lkAfter(pvEl, hadSave); lkPopAnchor();
  if (fk) { const b0 = $('setbody').querySelector('[data-lk="' + fk[0] + '"]' + (fk[1] ? '[data-k="' + CSS.escape(fk[1]) + '"]' : '')), b = b0 && b0.disabled ? $('setbody').querySelector('#sTint button.on') : b0; if (b) b.focus({ preventScroll: true }); }   // (the accent's box folded away under Mono: the control beside it, not the page, 11-10)
  if (rng && $(rng)) $(rng).focus({ preventScroll: true });
  const fi = typing && $(typing.id);
  if (fi) { if (fi.value !== typing.v) fi.dataset.dirty = '1'; fi.value = typing.v; fi.focus(); try { fi.setSelectionRange(typing.a, typing.b); } catch (e) { } }
}
// a pick drawn again (a theme, a palette, a colour chip or tone, a fade's spot): put back as it was for a frame, then
// moved, so its ring and fill fade over as their CSS says (Settings is drawn anew on each pick; the motion audit 11-08).
// Switches and pills have their own (togSlide, segPills). Not with animations Off
const pickKey = x => [x.dataset.lk, x.dataset.k, x.dataset.at, x.dataset.v, x.dataset.c].join('|');
const pickSnap = root => { const m = new Map(); for (const x of root.querySelectorAll('[data-lk]:not(.tog2)')) if (!x.closest('.seg3')) m.set(pickKey(x), x.classList.contains('on')); return m; };
function pickSlide(root, was) {
  if (!was || motionMode() === 'off') return;
  const moved = [...root.querySelectorAll('[data-lk]:not(.tog2)')].filter(x => !x.closest('.seg3') && was.has(pickKey(x)) && was.get(pickKey(x)) !== x.classList.contains('on'));
  if (!moved.length) return;
  for (const x of moved) x.classList.toggle('on'); void root.offsetWidth; for (const x of moved) x.classList.toggle('on');
}
// the accent's box folds away under Mono and comes back with Accent or Spectrum (11-10): Settings is drawn again on the
// pick, so the new box is put back where the last one was, then let go, and slides to its place as its CSS says. Not
// with animations Off, nor as Settings opens. (Put back with its transition off: the pills before it have the page
// styled already, so the way back would itself start a slide, and letting go then turned that one around at its start:
// nothing moved. And where it was, not at an end: drawn again mid-slide, by a second pick or any other control, it goes
// on from where it had got to instead of jumping to an end first, the review 11-10)
const ACC_AT = ['width', 'marginRight', 'opacity', 'borderLeftWidth', 'borderRightWidth'];
const accSnap = root => { const a = root.querySelector('.lk-acc'); if (!a) return null; const cs = getComputedStyle(a), o = {}; for (const k of ACC_AT) o[k] = cs[k]; return o; };
function accSlide(root, was) {
  const a = root.querySelector('.lk-acc');
  if (!a || !was || motionMode() === 'off') return;
  const cs = getComputedStyle(a), st = a.style;
  if (ACC_AT.every(k => Math.abs(parseFloat(was[k]) - parseFloat(cs[k])) < 0.01)) return;   // (where it ends already)
  st.transition = 'none'; for (const k of ACC_AT) st[k] = was[k]; st.visibility = 'visible';   // (seen on its way: folded it is hidden)
  void a.offsetWidth;
  st.transition = ''; for (const k of ACC_AT) st[k] = ''; st.visibility = '';
}
// the Check now arrow keeps turning through a redraw, and ends its turn when the answer comes (11-08)
const spinAt = () => { const v = $('sUpdNow') && $('sUpdNow').querySelector('svg'), a = v && v.getAnimations()[0]; if (!a) return null;
  if (a.id === 'spinEnd') { const ct = a.effect.getComputedTiming(), a0 = a._a0 || 0; return { end: a0 + (360 - a0) * (ct.progress || 0), left: Math.max(0, (ct.endTime || 0) - (a.currentTime || 0)) }; }   // (its last turn: where it is, what is left, 11-08 review)
  return a.currentTime; };
function spinOn(t) {
  if (t == null) return;
  const v = $('sUpdNow') && $('sUpdNow').querySelector('svg'); if (!v) return;
  const a = v.getAnimations()[0];
  if (typeof t === 'object') { if (a || !motionOn() || t.left < 16) return; const e = v.animate([{ transform: 'rotate(' + t.end.toFixed(1) + 'deg)' }, { transform: 'rotate(360deg)' }], { duration: t.left, easing: 'ease-out', id: 'spinEnd' }); e._a0 = t.end; return; }
  if (a) { a.currentTime = t; return; }
  if (!motionOn()) return;
  const P = 1100, f = (t % P) / P;
  const e = v.animate([{ transform: 'rotate(' + (f * 360).toFixed(1) + 'deg)' }, { transform: 'rotate(360deg)' }], { duration: Math.max(160, (1 - f) * P), easing: SUM_E, id: 'spinEnd' }); e._a0 = f * 360;
}
// a switch drawn again in its new state (Settings and Customize draw their rows again on a change, so CSS alone would
// show it jump): put back in its old state for a frame, then switched, so it slides there. Not with animations Off
const togSnap = root => [...root.querySelectorAll('.tog2')].map(t => t.classList.contains('on'));
function togSlide(root, was) {
  if (motionMode() === 'off') return;   // (a reply to a click: Minimal slides too, 11-02)
  const now = [...root.querySelectorAll('.tog2')]; if (now.length !== was.length) return;
  const moved = now.filter((t, i) => t.classList.contains('on') !== was[i]); if (!moved.length) return;
  for (const t of moved) t.classList.toggle('on');
  void root.offsetWidth;
  for (const t of moved) t.classList.toggle('on');
}
// a segment's pick (Animations, Cards, Colour, Keep's Days or Forever) is a pill that slides over to it, like the view
// tabs': Settings is drawn again on every pick, so the new pill starts where the last pick was (11-02, the motion audit).
// Not with animations Off
const segKey = s => s.id || (s.dataset.keep ? 'keep:' + s.dataset.keep : '') || (s.dataset.lay ? 'lay:' + s.dataset.lay : '');   // (lay: the edit panel's, 11-08)
// (where each pill is now: mid-slide, from where it has got to, so a redraw then doesn't jump it to its end)
const segSnap = root => { const o = {}; for (const s of root.querySelectorAll('.seg.seg3, .seg.pills')) { const k = segKey(s), b = s.querySelector(':scope > button.on'), ind = s.querySelector(':scope > .ind'); if (!k || !b) continue; if (ind && ind.offsetWidth) { const sr = s.getBoundingClientRect(), ir = ind.getBoundingClientRect(), cs = getComputedStyle(s), kk = sr.width / (parseFloat(cs.width) || s.offsetWidth) || 1; o[k] = { x: (ir.left - sr.left) / kk - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(getComputedStyle(ind).left) || 0), w: ir.width / kk }; } else o[k] = ind ? pillTo(ind, b) : { x: b.offsetLeft - 2, w: b.offsetWidth }; const bs = [...s.querySelectorAll(':scope > button')]; o[k].i = bs.indexOf(b); o[k].n = bs.length; } return o; };   // (i, n: the pick, for the labels' cross, 11-09)
const segX = new Map();   // (a seg's labels crossing over: from, to, when; by its key)
function segPills(root, was) {
  for (const s of root.querySelectorAll('.seg.seg3, .seg.pills')) {
    const k = segKey(s); if (!k) continue;
    const bs = s.querySelectorAll(':scope > button');
    if (s.classList.contains('pills') && bs.length && bs[0].offsetTop !== bs[bs.length - 1].offsetTop) { s.classList.remove('pills', 'pill'); const i0 = s.querySelector(':scope > .ind'); if (i0) i0.remove(); continue; }   // (chips on two rows: their own highlight, 11-08)
    const b = s.querySelector(':scope > button.on'), ind = s.querySelector(':scope > .ind') || s.insertBefore(document.createElement('i'), s.firstChild);
    ind.className = 'ind still'; s.classList.add('pill');
    if (!b) { ind.style.width = '0px'; continue; }
    const w = was && was[k], P = pillTo(ind, b);
    if (w && motionMode() !== 'off' && (Math.abs(w.x - P.x) > 0.1 || Math.abs(w.w - P.w) > 0.1)) { ind.style.transform = 'translateX(' + w.x + 'px)'; ind.style.width = w.w + 'px'; void ind.offsetWidth; ind.classList.remove('still'); }
    ind.style.transform = 'translateX(' + P.x + 'px)'; ind.style.width = P.w + 'px';
    if (ind.classList.contains('still')) { void ind.offsetWidth; ind.classList.remove('still'); }
    // (11-09, his recording: drawn again, the picked button had its own fill until the pill took over, and that fill
    // faded out: a second highlight under the sliding pill and a flash on every control's pick at each redraw. Its fade
    // ends at once: the pill is the only highlight)
    for (const x of bs) { getComputedStyle(x).backgroundColor; for (const a of x.getAnimations()) if (a.transitionProperty === 'background-color') a.finish(); }
    // (the labels cross over as the pill goes, with its glide, 11-09: only when the pick changed; drawn again mid-cross
    // (another control, a message), the cross carries on where it was, nothing lights or dims twice)
    const bi = [...bs].indexOf(b), now = performance.now(); let x = segX.get(k);
    if (w && w.n === bs.length && w.i >= 0 && w.i !== bi && motionMode() !== 'off') { x = { from: w.i, to: bi, t0: now }; segX.set(k, x); }
    else if (x && (!w || x.to !== bi || now - x.t0 >= 300 || motionMode() === 'off')) { segX.delete(k); x = null; }
    const old = x && bs[x.from], ref = old && (old.disabled ? [...bs].find(y => y !== b && !y.disabled) : old);
    if (old && old !== b && ref) { const on = getComputedStyle(b).color, dim = getComputedStyle(ref).color, own = getComputedStyle(old).color, o = { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
      b.animate([{ color: dim }, { color: on }], o).currentTime = now - x.t0; old.animate([{ color: on }, { color: own }], o).currentTime = now - x.t0; }
  }
}
// a section of Settings: its header, then its rows in one block
// the Look's colours (11-02, his pick of the mockups): a palette to start from, then each colour on a chip that opens a
// grid of tones (8 hues, light, mid and deep, all muted enough for the greys), any hex, the full picker, and for a
// category Auto (its part's, from the palette). Folded until opened; one chip open at a time
let lkPick = null, lkBg = false, lkCells = false, bgSel = null, lkDrag = null;
// a chip's tones open and shut as the folds beside them glide (the motion audit 11-08): Settings drawn again with the
// pick, the one that was open folds away from where it was (a copy of it, inert), the new one unfolds. Off: at once
function lkPickSet(k) {
  const fo = document.querySelector('#setbody .lk-fl:not(.lk-gh)'), fg = fo && motionMode() !== 'off' ? fo.cloneNode(true) : null, fin = fo && (fo.parentNode.classList.contains('lk-rows') ? '.lk-rows' : '.lk-colr');
  const old = lkPick && LK_OWN.has(lkPick) && document.querySelector('#setbody .lk-pop:not([aria-hidden])'), ok = lkPick, ghost = old && motionMode() !== 'off' ? old.cloneNode(true) : null;
  lkPick = k; renderSettings();
  if (fg) { const pa = document.querySelector('#setbody ' + fin); if (pa) { fg.querySelectorAll('[id]').forEach(x => x.removeAttribute('id')); fg.classList.add('lk-gh'); fg.inert = true; pa.append(fg); fg.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 140, easing: 'ease-out' }).onfinish = () => fg.remove(); } }
  const nf = k && !LK_OWN.has(k) && document.querySelector('#setbody .lk-fl:not(.lk-gh)'); if (nf && motionMode() !== 'off') nf.animate([{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 140, easing: 'ease-out' });   // (the floating editor: a fade and a small scale from its swatch, 11-09)
  if (ghost) {
    const ch = document.querySelector('#setbody .lk-chip[data-k="' + CSS.escape(ok) + '"]'), row = ch && ch.closest('.lk-row');
    if (row) { ghost.querySelectorAll('[id]').forEach(x => x.removeAttribute('id')); row.after(ghost); lkPopIO(ghost, false); }
  }
  const nw = k && LK_OWN.has(k) && document.querySelector('#setbody .lk-pop:not([aria-hidden])'); if (nw) lkPopIO(nw, true);
}
// the floating editor (11-09): over the rows under the one it opened from, at its right; its scale from that swatch
function lkPopAnchor() {
  const fl = document.querySelector('#setbody .lk-fl:not(.lk-gh)'); if (!fl) return;
  const k = fl.dataset.for, row = k !== 'acc' && fl.parentNode.querySelector('.lk-cr[data-k="' + CSS.escape(k) + '"]');
  if (row) fl.style.top = (row.offsetTop + row.offsetHeight + 4) + 'px';
  const sw = k === 'acc' ? document.querySelector('#setbody .lk-acc i') : row && row.querySelector('.lk-hx i'); if (!sw) return;
  const a = sw.getBoundingClientRect(), b = fl.getBoundingClientRect(); fl.style.transformOrigin = Math.round(a.left + a.width / 2 - b.left) + 'px ' + Math.round(a.top + a.height / 2 - b.top) + 'px';
}
function lkPopIO(el, inn) {
  if (!inn) { el.setAttribute('aria-hidden', 'true'); el.inert = true; }
  if (motionMode() === 'off') { if (!inn) el.remove(); return; }
  const cs = getComputedStyle(el), full = { opacity: 1 }, zero = { opacity: 0 };
  for (const p of ['height', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth']) { full[p] = cs[p]; zero[p] = '0px'; }
  el.style.overflow = 'hidden';
  const a = el.animate(inn ? [zero, full] : [full, zero], { duration: 300, easing: SUM_E });
  a.onfinish = () => { if (inn) el.style.overflow = ''; else el.remove(); };
}
const hslHex = (h, s, l) => { s /= 100; l /= 100; const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); };
const TONES = [[78, 55], [68, 50], [56, 45]].map(([l, s]) => [250, 215, 190, 170, 145, 95, 35, 330].map(h => hslHex(h, s, l)));
// (a background's base and a cell's fill: dark ones, greys first, then the tones' hues deep)
const DARK = [['#000000', '#0b0b0b', '#101010', '#151515', '#1a1a1a', '#202020', '#262626', '#2e2e2e']].concat([[9, 32], [13, 26]].map(([l, s]) => [250, 215, 190, 170, 145, 95, 35, 330].map(h => hslHex(h, s, l))));
const LK_OWN = new Set(['base', 'cell', 'fade']), LK_DARK = new Set(['base', 'cell']);
// a colour's chip (its dot, and its hex beside a name, or the name alone in a row of chips) and, open, its tones
const lkBtn = (key, cur, name, txt, cls) => '<button class="lk-chip' + (cls ? ' ' + cls : '') + (lkPick === key ? ' on' : '') + '" data-lk="chip" data-k="' + esc(key) + '" aria-label="' + esc(name) + ', ' + (cur || 'grey') + '" aria-expanded="' + (lkPick === key) + '" style="--c:' + (cur || '#5a5a5a') + '"><i></i>' + esc(txt) + '</button>';
const lkPop = (key, cur) =>
  (lkPick === key ? '<div class="lk-pop"><div class="lk-g">' + (LK_DARK.has(key) ? DARK : TONES).flat().map(c => '<button data-lk="c" data-k="' + esc(key) + '" data-c="' + c + '" style="--c:' + c + '" aria-label="' + c + '" aria-pressed="' + (c === cur) + '"' + (c === cur ? ' class="on"' : '') + '></button>').join('') + '</div>' +
    '<div class="lk-f"><input class="lk-hex" id="lkHex" data-k="' + esc(key) + '" value="' + (cur || '') + '" maxlength="7" spellcheck="false" placeholder="#rrggbb" title="Hex" aria-label="Hex">' +
    '<label class="lk-any" title="Any colour"><input type="color" id="lkAny" data-k="' + esc(key) + '" value="' + (isHex(cur) ? cur : ACC0) + '" aria-label="Any colour"></label>' +
    (key !== 'acc' && !LK_OWN.has(key) ? '<button class="lk-auto' + (S.L.cats.some(c => c.id === key && !c.col) ? ' on' : '') + '" data-lk="c" data-k="' + esc(key) + '" data-c="" title="Part\'s colour">Auto</button>' : '') + '</div></div>' : '');
const lkChip = (key, cur, name, tag) => '<div class="lk-row"><span class="lk-name">' + esc(name) + '</span><span class="lk-tag">' + tag + '</span><span class="sp"></span>' + lkBtn(key, cur, name, cur || 'grey') + '</div>' + lkPop(key, cur);
// ---- the theme, the background and the cells (11-05) ----
const lkFold = (f, open, name, small, dots) => '<div class="setrow lk-head' + (open ? ' open' : '') + '" data-lk="fold" data-f="' + f + '" role="button" aria-expanded="' + !!open + '"><div>' + name + '<small>' + small + '</small></div><span class="lk-prev">' +
  dots.map(c => '<i class="dk" style="--c:' + c + '"></i>').join('') + '<svg class="lk-chev" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg></span></div>';
const lkRange = (k, name, v, lo, hi) => '<div class="lk-row"><span class="lk-name">' + name + '</span><span class="sp"></span><input type="range" class="lk-rng" id="lkr-' + k + '" data-k="' + k + '" aria-label="' + name + '" aria-valuetext="' + v + '%" min="' + lo + '" max="' + hi + '" step="1" value="' + v + '" style="--v:' + ((v - lo) / (hi - lo) * 100) + '%"><span class="lk-v">' + v + '%</span></div>';
// ---- the Look page (11-09, his OK 04:55 of the round 5 mockups): a live miniature of his window on the left, every theme
// on the right by colour (Saved first) as tall as it, a dropdown that jumps to a colour, Save; the accent's box beside the
// colour control; under Spectrum a palette dropdown and his categories, the colour editor floating over them ----
const THEME_FAMS = ['Greys', 'Browns', 'Reds and oranges', 'Golds and yellows', 'Greens', 'Teals', 'Blues', 'Purples', 'Pinks', 'Mixes'];
const LK_RAD = { sharp: 3, normal: 10, round: 14 };   // (the old corners in px at the base size: the slider's detents)
const famsOn = () => THEME_FAMS.filter(f => Object.values(THEME_PRESETS).some(t => (t.fam || 'Mixes') === f));
const themeFam = id => (THEME_PRESETS[id] && THEME_PRESETS[id].fam) || 'Mixes';
const LK_PLUS = '<svg viewBox="0 0 12 12"><path d="M6 2v8M2 6h8"/></svg>', LK_X = '<svg viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>';
let lkJf = null, lkThTop = null, lkThGo = null, lkJumpAt = 0, lkJumpTo = null, lkHov = null;   // (the colour the list is at, where it was scrolled, a glide asked for, a hovered tile)
// a category's part (more than half of the cells that tell read it), as autoTint counts it
const catPart = cat => { const n = {}; let told = 0; for (const cid of cat.cells) { const p = partOf(S.L.cells[cid]); if (p) { n[p] = (n[p] || 0) + 1; told++; } } let top = null; for (const p in n) if (!top || n[p] > n[top]) top = p; return top && n[top] * 2 > told ? top : null; };
const lkCats = () => S.L.cats.filter(c => c.cells && c.cells.length);
const palCol = (k, cat) => { const p = catPart(cat); return p ? (PALETTES[k] || PALETTES.muted)[1][p] : '#5a5a5a'; };
const lkCols = () => { const o = {}; for (const c of S.L.cats) if (c.col) o[c.id] = c.col; return o; };
const lkSaved = () => S.look.from ? S.lookSaved.find(x => x.id === S.look.from) || null : null;
// (Save shows when the look is not the theme or the saved look it came from: changed, or its categories' own colours)
const lkCore = L => { const o = cleanLook(Object.assign({}, L, { changed: true })); delete o.changed; delete o.from; delete o.pops; return JSON.stringify(o); };
const lkColsKey = cols => S.look.tint === 'spectrum' ? JSON.stringify(Object.entries(cols || {}).sort()) : '';
const lookDirty = () => { const sv = lkSaved(); return lkCore(S.look) !== lkCore(sv ? sv.look : lkPreset(S.look.theme)) || lkColsKey(lkCols()) !== lkColsKey(sv ? sv.cols : {}); };   // (by what it is, not a flag: an undo after a Save shows it changed again, 11-09 review)
// (a saved look gone from under its look (deleted, then an undo; a state file): no longer from it, changed)
function lkFromCheck() { if (S.look.from && !S.lookSaved.some(x => x.id === S.look.from)) { delete S.look.from; S.look.changed = true; } }
const lkPreset = id => cleanLook(Object.assign({ theme: id }, THEME_PRESETS[id]));
// a tile's swatch: the look's background, three short graph lines in its palette's colours when it is Spectrum
const lkSw = L => { const pal = (PALETTES[L.pal] || PALETTES.muted)[1], sp = L.tint === 'spectrum';
  return '<span class="lk-sw" style="background:' + bgiOf(L) + '"><span class="lk-ln">' + ['gpu', 'cpu', 'fan'].map(k => '<i style="background:' + (sp ? pal[k] : '#8f8f8f') + '"></i>').join('') + '</span></span>'; };
const lkThemeTile = id => { const on = S.look.theme === id && !S.look.from;
  return '<button class="lk-t' + (on ? ' on' : '') + '" data-lk="theme" data-k="' + esc(id) + '" aria-pressed="' + on + '">' + lkSw(lkPreset(id)) + '<span class="lk-tn">' + esc(THEME_PRESETS[id].name) + '</span></button>'; };
const lkSavedTile = sv => { const on = S.look.from === sv.id;
  return '<div class="lk-t lk-sv' + (on ? ' on' : '') + '"><button class="lk-tb" data-lk="saved" data-k="' + esc(sv.id) + '" aria-pressed="' + on + '" aria-label="' + esc(sv.name) + '">' + lkSw(sv.look) + '</button>' +
    '<span class="lk-tn" data-k="' + esc(sv.id) + '">' + esc(sv.name) + '</span><button class="lk-x" data-lk="savex" data-k="' + esc(sv.id) + '" title="Delete" aria-label="Delete ' + esc(sv.name) + '">' + LK_X + '</button></div>'; };
const lkSec = (f, tiles) => '<section data-f="' + esc(f) + '"><div class="lk-fh">' + esc(f) + '</div><div class="lk-tg">' + tiles + '</div></section>';
function lookTheme() {
  const L = S.look, sv = lkSaved(), dirty = lookDirty(), fams = famsOn();
  if (!lkJf || (lkJf !== 'Saved' && !fams.includes(lkJf))) lkJf = sv ? 'Saved' : themeFam(L.theme);
  return '<div class="setrow th-row lk-th"><div class="lk-th-h"><div>Theme<small>' + esc(sv ? sv.name : THEME_PRESETS[L.theme].name) + (dirty ? ', changed' : '') + '</small></div><span class="lk-th-r">' +
    (dirty && (sv || S.lookSaved.length < 12) ? '<button class="btn lk-save" data-lk="save">Save</button>' : '') +
    '<span class="lk-dd"><select id="lkJump" aria-label="Theme colours">' + ['Saved'].concat(fams).map(f => '<option value="' + esc(f) + '"' + (f === lkJf ? ' selected' : '') + '>' + esc(f) + '</option>').join('') + '</select></span></span></div>' +
    '<div class="lk-th-w"><div class="lk-pv" id="lkPv" aria-hidden="true" style="aspect-ratio:' + innerWidth + ' / ' + innerHeight + '"></div><div class="lk-th-rc"><div class="lk-th-l" id="lkThL">' +
    lkSec('Saved', S.lookSaved.map(lkSavedTile).join('') + (S.lookSaved.length < 12 ? '<button class="lk-t lk-add" data-lk="saveadd" title="Save" aria-label="Save the look"><span class="lk-sw lk-es">' + LK_PLUS + '</span><span class="lk-tn">&nbsp;</span></button>' : '')) +
    fams.map(f => lkSec(f, Object.keys(THEME_PRESETS).filter(id => themeFam(id) === f).map(lkThemeTile).join(''))).join('') + '</div></div></div></div>';
}
// the accent's box, beside the control under Accent and Spectrum; its editor floats under the row. Under Mono, where the
// accent shows nowhere, it is folded away behind the control (off: no width, not seen, not for the keys; 11-10)
const lkAccBox = () => { const off = S.look.tint === 'none';
  return '<button class="lk-acc' + (off ? ' off' : '') + (lkPick === 'acc' ? ' on' : '') + '" data-lk="chip" data-k="acc" title="Accent" aria-label="Accent, ' + S.look.acc + '" aria-expanded="' + (lkPick === 'acc') + '"' + (off ? ' disabled aria-hidden="true" tabindex="-1"' : '') + '><i style="--c:' + S.look.acc + '"></i></button>'; };
// a category's sample line (the same for it each time)
const lkSpark = seed => { let s = 7; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) % 9973; const p = []; for (let i = 0; i <= 14; i++) { s = (s * 7919 + 13) % 9973; p.push((i / 14 * 100).toFixed(1) + ' ' + (3 + s / 9973 * 12).toFixed(1)); } return 'M' + p.join(' L'); };
const lkCatRow = c => { const col = catTint(c) || '#7a7a7a', on = lkPick === c.id;
  return '<div class="lk-cr' + (on ? ' on' : '') + '" data-k="' + esc(c.id) + '"><span class="lk-cn" style="--c:' + col + '">' + esc(c.name) + '</span><span class="lk-cl"><svg viewBox="0 0 100 18" preserveAspectRatio="none"><path style="stroke:' + col + '" d="' + lkSpark(c.id) + '"/></svg></span>' +
    '<button class="lk-hx" data-lk="chip" data-k="' + esc(c.id) + '" aria-expanded="' + on + '" aria-label="' + esc(c.name) + ', ' + col + '"><i style="--c:' + col + '"></i>' + col.toUpperCase() + '</button></div>'; };
// the palette (Spectrum): the theme's own first, then every theme's by colour, then the others; once a category's colour is
// your own, Custom (from the one it was). Its categories under it, a row each
function lookPalette() {
  const L = S.look, cats = lkCats(), own = 't_' + L.theme, custom = Object.keys(lkCols()).length > 0, sq = k => cats.map(c => palCol(k, c)).join(',');
  const nm = k => k === own ? THEME_PRESETS[L.theme].name + '\'s own' : k.startsWith('t_') && THEME_PRESETS[k.slice(2)] ? THEME_PRESETS[k.slice(2)].name : PALETTES[k][0];
  const opt = k => '<option value="' + esc(k) + '" data-sq="' + sq(k) + '"' + (!custom && k === L.pal ? ' selected' : '') + '>' + esc(nm(k)) + '</option>';
  let o = custom ? '<option value="__custom" data-sq="' + cats.map(c => catTint(c) || '#5a5a5a').join(',') + '" selected>Custom</option>' : '';
  if (PALETTES[own]) o += opt(own);
  for (const f of famsOn()) { const ks = Object.keys(THEME_PRESETS).filter(id => themeFam(id) === f && 't_' + id !== own && PALETTES['t_' + id]).map(id => 't_' + id); if (ks.length) o += '<optgroup label="' + esc(f) + '">' + ks.map(opt).join('') + '</optgroup>'; }
  o += '<optgroup label="Others">' + Object.keys(PALETTES).filter(k => !k.startsWith('t_')).map(opt).join('') + '</optgroup>';
  const ed = lkPick && lkPick !== 'acc' && cats.find(c => c.id === lkPick);
  return '<div class="setrow lk-palh"><div>Palette<small' + (custom ? '>Custom, from ' + esc(nm(L.pal)) : ' class="lk-ph">&nbsp;') + '</small></div><span class="lk-dd"><select id="lkPal" aria-label="Palette">' + o + '</select></span></div>' +
    '<div class="lk-rows">' + cats.map(lkCatRow).join('') + (ed ? '<div class="lk-fl" data-for="' + esc(ed.id) + '">' + lkPop(ed.id, catTint(ed)) + '</div>' : '') + '</div>';
}
// ---- the preview: his window as it is now, in the look pointed at (a tile under the pointer or the keys), else his own.
// Drawn only then: a copy of the view in a shadow root (its own ids: nothing of the page finds it) with deck.css read for
// it (its :root the copy's box), its graphs copied over in that look's colours. A 120 ms cross-fade ----
let pvSheetP = null, pvKey = '', pvT = 0, pvWant = null;
const PV_CSS = '.pvr { position: absolute; left: 0; top: 0; overflow: hidden; transform-origin: 0 0; background: var(--bgi, var(--bg)); color: var(--fg); font-family: var(--f-body); line-height: 1.4; pointer-events: none; } .pvr *, .pvr *::before, .pvr *::after { animation: none !important; transition: none !important; } .pvr * { -webkit-app-region: none !important; app-region: none !important; }';
const pvSheet = () => pvSheetP || (pvSheetP = fetch('deck.css').then(r => r.text()).then(t => { const s = new CSSStyleSheet(); s.replaceSync(t.replace(/@font-face\s*\{[^}]*\}/g, '').replace(/:root/g, '.pvr') + PV_CSS); return s; }).catch(() => { pvSheetP = null; return null; }));
const lkLookOf = (lk, k) => { if (lk === 'saved') { const sv = S.lookSaved.find(x => x.id === k); return sv ? Object.assign(JSON.parse(JSON.stringify(sv.look)), { pops: S.look.pops, _cols: sv.cols || {} }) : null; } return THEME_PRESETS[k] ? Object.assign(lkPreset(k), { pops: S.look.pops }) : null; };
const lkHovLook = () => lkHov && lkLookOf(lkHov.lk, lkHov.k);
function lkPvAsk(L) { pvWant = L; clearTimeout(pvT); pvT = setTimeout(() => lkPvDraw(pvWant), 60); }
// (each category's colour in a look: Spectrum's from its palette, a colour of your own kept; asked of the look for a moment)
function lkTintsFor(L) { const m = new Map(); if (L.tint !== 'spectrum') return m; const was = S.look, keep = L._cols ? S.L.cats.map(c => [c, c.col]) : null; S.look = L; TINT.clear();
  if (keep) for (const c of S.L.cats) { if (L._cols[c.id]) c.col = L._cols[c.id]; else delete c.col; }   // (a saved look's own colours, for a moment)
  try { for (const c of S.L.cats) { const t = catTint(c); if (t) m.set(c.id, t); } } finally { S.look = was; if (keep) for (const [c, col] of keep) { if (col) c.col = col; else delete c.col; } TINT.clear(); } return m; }
// (a graph copied; a cell's own graph recoloured from his look's colour to that look's: a warning keeps its colours)
function pvCanvas(s, d, L, tints) {
  if (!s.width || !s.height) return;
  d.width = s.width; d.height = s.height; const x = d.getContext('2d'); if (!x) return;
  try { x.drawImage(s, 0, 0); } catch (e) { return; }
  const tile = s.closest('[data-cid]'); if (!tile || s.closest('.xb') || tile.matches('.yellow, .red, .warm')) return;
  const cat = catOf(tile.dataset.cid), grey = s.closest('.hero') ? '#8f8f8f' : '#7c7c7c';
  const now = S.look.tint === 'spectrum' && cat ? catTint(cat) || grey : grey, want = L.tint === 'spectrum' && cat ? tints.get(cat.id) || grey : grey;
  if (now === want) return;
  x.globalCompositeOperation = 'source-in'; x.fillStyle = want; x.fillRect(0, 0, d.width, d.height);
}
async function lkPvDraw(L) {
  const box = $('lkPv'), sm = document.getElementById('setmodal'); if (!L || !box || !sm.classList.contains('open') || !box.clientWidth) return;
  const key = JSON.stringify(L) + JSON.stringify(lkCols()) + '|' + innerWidth + 'x' + innerHeight + '|' + box.clientWidth; if (key === pvKey && box.querySelector('.lk-pvh')) return;
  const sheet = await pvSheet(); if (!sheet || !box.isConnected || pvWant !== L || !sm.classList.contains('open')) return;
  pvKey = key;
  const app = $('app'), W = innerWidth, H = innerHeight;
  const host = document.createElement('div'); host.className = 'lk-pvh';
  const sr = host.attachShadow({ mode: 'open' }); sr.adoptedStyleSheets = [sheet];
  const root = document.createElement('div'); root.className = 'pvr'; root.dataset.tint = L.tint; root.dataset.pops = L.pops; root.dataset.motion = 'off';
  root.style.width = W + 'px'; root.style.height = H + 'px'; root.style.transform = 'scale(' + (box.clientWidth / W) + ')';
  const v = lookVars(L); for (const n in v) root.style.setProperty(n, v[n]);
  root.style.setProperty('--acc', L.acc); root.style.setProperty('--edit', editOf(L));
  const cl = app.cloneNode(true); cl.inert = true; root.append(cl); sr.append(root);
  const tints = lkTintsFor(L);
  for (const d of cl.querySelectorAll('.dcat[data-cat]')) { const t = tints.get(d.dataset.cat); if (t) d.style.setProperty('--cc', t); else d.style.removeProperty('--cc'); }
  const src = app.querySelectorAll('canvas'), dst = cl.querySelectorAll('canvas');
  for (let i = 0; i < src.length && i < dst.length; i++) pvCanvas(src[i], dst[i], L, tints);
  // (the 12V-2x6 connector's pins are drawn in their tile's graph colour, written on them by their update: the copy kept
  // HIS look's, so a Mono theme pointed at showed the pins in his Spectrum colour, 11-10 his "preview bug on the 12v
  // pin". That look's colour, as a graph gets in pvCanvas; a dimmed tile's pins stay as they are)
  for (const sp of cl.querySelectorAll('.xpins')) {
    const tile = sp.closest('[data-cid]'), cat = tile && catOf(tile.dataset.cid), grey = '#7c7c7c';
    const now = S.look.tint === 'spectrum' && cat ? catTint(cat) || grey : grey, want = L.tint === 'spectrum' && cat ? tints.get(cat.id) || grey : grey;
    if (now !== want && sp.style.getPropertyValue('--pc') === now) sp.style.setProperty('--pc', want);
  }
  const old = [...box.querySelectorAll('.lk-pvh')];
  box.append(host);
  if (motionMode() === 'off' || !old.length) { old.forEach(x => x.remove()); return; }
  host.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' }).onfinish = () => old.forEach(x => x.remove());
}
// (Settings shut: the preview goes once it has faded, nothing kept, nothing drawn while closed)
new MutationObserver(() => { const sm = document.getElementById('setmodal'); if (sm.classList.contains('open')) { if (!pvKey) lkPvAsk(lkHovLook() || S.look); requestAnimationFrame(() => { const l = $('lkThL'); if (l && sm.classList.contains('open')) lkThHome(l); }); return; } clearTimeout(pvT); pvWant = null; pvKey = ''; lkThTop = null; lkJf = null; lkHov = null;
  setTimeout(() => { if (!sm.classList.contains('open')) { const b = $('lkPv'); if (b) b.querySelectorAll('.lk-pvh').forEach(x => x.remove()); } }, 450); }).observe(document.getElementById('setmodal'), { attributes: true, attributeFilter: ['class'] });
addEventListener('resize', () => { if (!document.getElementById('setmodal').classList.contains('open')) return; const b = $('lkPv'); if (b) b.style.aspectRatio = innerWidth + ' / ' + innerHeight; lkPvAsk(lkHovLook() || S.look); });   // (the window's new shape, 11-09 review)
// ---- after Settings is drawn: the preview kept (a copy of it is costly), the list where it was, Save's fade ----
function lkAfter(pvEl, hadSave) {
  const nb = $('lkPv'); if (pvEl && nb && pvEl !== nb) { pvEl.style.aspectRatio = nb.style.aspectRatio; nb.replaceWith(pvEl); }
  const l = $('lkThL');
  if (l) {
    if (lkThTop != null) l.scrollTop = lkThTop; else lkThHome(l);
    if (lkThGo) { const s = l.querySelector('section[data-f="' + CSS.escape(lkThGo) + '"]'); lkThGo = null; if (s) lkThTo(l, s); }
    lkMore(l);
  }
  const sv = $('setbody').querySelector('.lk-save'); if (sv && !hadSave && motionMode() !== 'off') sv.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });   // (Save comes in: a fade, nothing moves)
  if (document.getElementById('setmodal').classList.contains('open')) lkPvAsk(lkHovLook() || S.look);
}
// (at his theme's colour, his theme in view: at Settings' opening, and on the first drawing)
function lkThHome(l) { lkJf = lkSaved() ? 'Saved' : themeFam(S.look.theme); lkJumpShow(); const s = l.querySelector('section[data-f="' + CSS.escape(lkJf) + '"]'); l.scrollTop = s ? s.offsetTop : 0;
  const on = l.querySelector('.lk-t.on'); if (on) { const d = on.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom; if (d > 0) l.scrollTop += d + 10; } lkThTop = l.scrollTop; lkMore(l); }
// the list to a colour: it glides there (at once with animations Off); the dropdown says that colour
function lkThTo(l, s) { lkJf = s.dataset.f; lkJumpAt = performance.now(); lkJumpTo = Math.min(s.offsetTop, l.scrollHeight - l.clientHeight); lkJumpShow(); l.scrollTo({ top: s.offsetTop, behavior: motionMode() === 'off' ? 'auto' : 'smooth' }); }
function lkJumpShow() { const s = $('lkJump'); if (!s || s.value === lkJf) return; s.value = lkJf; const b = s.nextElementSibling; if (b && b.classList.contains('dsel')) b.firstChild.innerHTML = dselLab(s.options[s.selectedIndex]); }
// (scrolled by the wheel: the dropdown follows the colour at the top; at the end, the last one in view)
const lkMore = l => l.classList.toggle('lk-more', l.scrollTop + l.clientHeight < l.scrollHeight - 1);   // (more below: its bottom edge fades)
function lkThScroll(l) {
  if (!document.getElementById('setmodal').classList.contains('open')) return;   // (shut, or not yet open: its scroll says nothing)
  lkThTop = l.scrollTop; lkMore(l); if (lkJumpTo != null) { if (Math.abs(l.scrollTop - lkJumpTo) > 1.5 && performance.now() - lkJumpAt < 2000) return; lkJumpTo = null; return; }   // (a jump gliding there: the colour picked stays shown until the list is there)
  let f = null; const end = l.scrollTop + l.clientHeight >= l.scrollHeight - 2;
  for (const s of l.querySelectorAll('section')) if (s.offsetTop <= l.scrollTop + 4 || (end && s.offsetTop < l.scrollTop + l.clientHeight)) f = s.dataset.f;
  if (f && f !== lkJf) { lkJf = f; lkJumpShow(); }
}
$('setbody').addEventListener('scroll', e => { if (e.target.id === 'lkThL') lkThScroll(e.target); }, true);
$('setbody').addEventListener('change', e => {
  if (e.target.id === 'lkJump') { const l = $('lkThL'), s = l && l.querySelector('section[data-f="' + CSS.escape(e.target.value) + '"]'); if (s) lkThTo(l, s); }
  else if (e.target.id === 'lkPal' && e.target.value !== '__custom') pickPalette(e.target.value);
});
const LK_TILE = '#lkThL [data-lk="theme"], #lkThL [data-lk="saved"]';
const lkTileOf = el => { if (!el || !el.closest) return null; const t = el.closest(LK_TILE); if (t) return t; const s = el.closest('#lkThL .lk-sv'); return s ? s.querySelector('.lk-tb') : null; };   // (a saved look's name and x are its tile too)
$('setbody').addEventListener('pointerover', e => { const t = lkTileOf(e.target); if (!t) return; lkHov = { lk: t.dataset.lk, k: t.dataset.k }; const L = lkHovLook(); if (L) lkPvAsk(L); });
$('setbody').addEventListener('pointerout', e => { if (!(e.target.closest && e.target.closest('#lkThL'))) return; if (lkTileOf(e.relatedTarget)) return; lkHov = null; lkPvAsk(S.look); });
$('setbody').addEventListener('focusin', e => { const t = e.target.closest && e.target.closest(LK_TILE); if (t && t.matches(':focus-visible')) { const L = lkLookOf(t.dataset.lk, t.dataset.k); if (L) lkPvAsk(L); } });
// ---- your own looks: Save keeps the look (and its categories' own colours) as a new one, or the one it came from again;
// the + slot always a new one; up to 12. A tile picks it; its x asks first; a double-click on its name renames it ----
function lookSave(asNew) {
  lkFlush();
  const sv0 = lkSaved(), look = Object.assign(JSON.parse(JSON.stringify(S.look)), { changed: false }); delete look.from; delete look.pops;
  let sv = asNew ? null : sv0;
  if (sv) { sv.look = look; sv.cols = lkCols(); }
  else {
    if (S.lookSaved.length >= 12) return;
    const base = sv0 ? sv0.name : THEME_PRESETS[S.look.theme].name, names = new Set(S.lookSaved.map(x => x.name)); let name = base, n = 2; while (names.has(name)) name = base + ' ' + n++;
    let id; do id = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); while (S.lookSaved.some(x => x.id === id));
    sv = { id, name: name.slice(0, 40), look, cols: lkCols() }; S.lookSaved.push(sv); lkThGo = 'Saved';
  }
  S.look = Object.assign({}, S.look, { changed: false, from: sv.id }); saveState(); renderSettings();
}
function lookApplySaved(id) {
  lkFlush(); const sv = S.lookSaved.find(x => x.id === id); if (!sv || (S.look.from === id && !lookDirty())) return;   // (the one on, as saved: nothing)
  const before = snapOf();
  S.look = cleanLook(Object.assign(JSON.parse(JSON.stringify(sv.look)), { from: id, changed: false, pops: S.look.pops }));
  for (const c of S.L.cats) { if (sv.cols && sv.cols[c.id]) c.col = sv.cols[c.id]; else delete c.col; }
  pushUndo(before); bgSel = null; lkPick = null; applyLook(); afterChange(); renderSettings(); if (feed.got) updateView(true, true);
}
function lookAskDelete(id) {
  const sv = S.lookSaved.find(x => x.id === id); if (!sv) return;
  askConfirm('Delete ' + sv.name + '?', '', 'Delete', () => {
    S.lookSaved = S.lookSaved.filter(x => x !== sv);
    if (S.look.from === id) { S.look = Object.assign({}, S.look, { changed: true }); delete S.look.from; }   // (its look stays on, now "changed")
    saveState(); if (document.getElementById('setmodal').classList.contains('open')) renderSettings();
  });
}
$('setbody').addEventListener('dblclick', e => {
  const n = e.target.closest && e.target.closest('.lk-sv .lk-tn'); if (!n) return; clearTimeout(lkNmT);
  const sv = S.lookSaved.find(x => x.id === n.dataset.k); if (!sv) return;
  e.preventDefault();
  const i = document.createElement('input'); i.className = 'lk-rn'; i.maxLength = 40; i.value = sv.name; i.spellcheck = false; i.setAttribute('aria-label', 'Name');
  n.replaceWith(i); i.focus(); i.select();
  let done = false; const end = keep => { if (done) return; done = true; const v = i.value.trim(); if (keep && v && v !== sv.name) { sv.name = v.slice(0, 40); saveState(); } renderSettings(); };
  i.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); end(true); } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } });   // (Enter keeps it, Escape leaves it as it was)
  i.addEventListener('blur', () => end(true));
});
let lkNmT = 0, lkRadPtr = false;
$('setbody').addEventListener('pointerdown', e => { if (e.target.id === 'lkr-rad') lkRadPtr = true; }); document.addEventListener('pointerup', () => { lkRadPtr = false; }, true);   // (the corners slider held by the pointer: its detents)
$('setbody').addEventListener('click', e => { const n = e.target.closest && e.target.closest('.lk-sv .lk-tn'); if (!n || e.detail !== 1) return; const k = n.dataset.k; clearTimeout(lkNmT); lkNmT = setTimeout(() => lookApplySaved(k), 260); });   // (its name picks it too, after a double-click's time: a double-click renames it and picks nothing, 11-09 review)
// the background: a small screen of it with a point on each edge and corner (a + where there is no fade, the fade's
// colour where there is), its base, and the fade picked: its colour, size and strength
function lookBg() {
  const L = S.look; if (!L.fades.some(f => f.at === bgSel)) bgSel = L.fades.length ? L.fades[0].at : null;
  const f = L.fades.find(x => x.at === bgSel), PLUS = '<svg viewBox="0 0 8 8"><path d="M4 1v6M1 4h6"/></svg>';
  return lkFold('bg', lkBg, 'Background', L.base + (L.fades.length ? ', ' + L.fades.length + (L.fades.length > 1 ? ' fades' : ' fade') : ''), [L.base].concat(L.fades.map(x => x.c))) +
    '<div class="lk-body' + (lkBg ? ' open' : '') + '"><div><div class="lk-in"><div class="bg-ed"><div class="bg-fr"><div class="bg-mini" style="background:' + bgiOf(L) + '"><span class="bg-tb"></span><span class="bg-gh" style="--t:' + tileOf(L) + ';--l:' + (L.line ? lineOf(L) : 'transparent') + '">' + '<i></i>'.repeat(12) + '</span>' +
    Object.keys(FADE_AT).map(k => { const g = L.fades.find(x => x.at === k); return '<button class="bg-h' + (g ? ' f' : '') + (k === bgSel ? ' on' : '') + '" data-lk="fade" data-at="' + k + '" title="' + FADE_AT[k][2] + '" style="left:' + FADE_AT[k][0] + '%;top:' + FADE_AT[k][1] + '%' + (g ? ';--c:' + g.c : '') + '">' + (g ? '' : PLUS) + '</button>'; }).join('') +
    '</div></div><div class="bg-side">' + lkChip('base', L.base, 'Base', '') +
    (f ? '<div class="bg-fh"><i style="--c:' + f.c + '"></i><span class="lk-name">' + FADE_AT[f.at][2] + '</span><button class="bg-x" data-lk="fadex" title="Remove"><svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg></button></div>' +
      lkChip('fade', f.c, 'Colour', '') + lkRange('size', 'Size', f.size, 20, 100) + lkRange('a', 'Strength', f.a, 5, 80) : '') + '</div></div></div></div></div>';
}
function lookCells() {
  const L = S.look;
  const rd = L.rad != null ? L.rad : LK_RAD[L.corners];
  return lkFold('cells', lkCells, 'Cells', L.cell + ', ' + L.op + '% opacity' + (L.line ? ', outline' + (L.lineA ? ' ' + L.lineA + '%' : '') : '') + ', ' + (L.rad != null ? L.rad + ' px' : L.corners) + ' corners', [L.cell]) +
    '<div class="lk-body' + (lkCells ? ' open' : '') + '"><div><div class="lk-in ce-in">' + lkChip('cell', L.cell, 'Fill', '') + lkRange('op', 'Opacity', L.op, 0, 100) +
    '<div class="lk-row"><span class="lk-name">Outline</span><span class="sp"></span><button class="tog2' + (L.line ? ' on' : '') + '" data-lk="line" aria-pressed="' + L.line + '"></button></div>' +
    (L.line ? lkRange('lineA', 'Strength', L.lineA || 100, 10, 200) : '') +
    '<div class="lk-row"><span class="lk-name">Corners</span><span class="sp"></span><input type="range" class="lk-rng" id="lkr-rad" data-k="rad" data-u="px" aria-label="Corners" aria-valuetext="' + rd + ' px" min="0" max="24" step="1" value="' + rd + '" style="--v:' + (rd / 24 * 100) + '%"><span class="lk-v">' + rd + ' px</span></div></div></div></div>';   // (a slider in px, 11-09: its detents the old Sharp, Normal and Round)
}
// a theme picked: all of it, undone like any change
function pickTheme(id) {
  if (!THEME_PRESETS[id]) return;
  lkFlush();
  const before = snapOf();
  S.look = cleanLook(Object.assign(JSON.parse(JSON.stringify(THEME_PRESETS[id])), { theme: id, changed: false, pops: S.look.pops }));
  if (snapOf() === before) { renderSettings(); return; }
  pushUndo(before); bgSel = null; lkPick = null; applyLook(); saveState(); syncUndo(); renderSettings(); if (feed.got) updateView(true, true);
}
// a change to the background or the cells: undone like any change, the theme now "changed". A Match palette follows
// the background, and so does its accent while it is Match's
function lookEdit(fn) {
  lkFlush();
  const before = snapOf(), m0 = PALETTES.match[2], L = JSON.parse(JSON.stringify(S.look));
  fn(L);
  const nl = cleanLook(Object.assign(L, { changed: S.look.changed }));
  if (JSON.stringify(nl) === JSON.stringify(S.look)) return;   // (nothing changed, the tone already on picked: no step, the theme not "changed", the review 11-05)
  nl.changed = true; S.look = nl;
  if (S.look.pal === 'match' && S.look.acc === m0) { applyLook(); S.look.acc = PALETTES.match[2]; }
  pushUndo(before); applyLook(); saveState(); syncUndo(); renderSettings(); if (feed.got) updateView(true, true);
}
// a new fade's colour: the accent when the look has colour, else a violet
const newFade = () => S.look.tint !== 'none' && hueOf(S.look.acc)[1] >= 15 ? S.look.acc : '#6c5ce0';   // (a white or grey accent: the violet, not a white haze, 11-09)
// a colour picked: the accent's ('acc'), the look's own (the base, the fill, the fade picked), or a category's ('' its
// part's again: undo takes it back like any change)
function pickColour(key, c) {
  lkFlush();
  if (LK_OWN.has(key)) { if (!isHex(c)) return; c = c.toLowerCase(); lookEdit(L => { if (key === 'fade') { const f = L.fades.find(x => x.at === bgSel); if (f) f.c = c; } else L[key] = c; }); return; }
  if (key === 'acc') { if (!isHex(c) || S.look.acc === c.toLowerCase()) return; snap(); S.look = Object.assign({}, S.look, { acc: c.toLowerCase(), changed: true }); applyLook(); saveState(); syncUndo(); }
  else {
    const cat = S.L.cats.find(x => x.id === key), v = isHex(c) ? c.toLowerCase() : undefined; if (!cat || cat.col === v) return;
    snap(); if (v) cat.col = v; else delete cat.col; afterChange();
  }
  renderSettings(); if (feed.got) updateView(true, true);
}
// a palette: every category back to its part's colour from it, and its accent (undo brings the categories' own back)
function pickPalette(k) {
  if (!PALETTES[k]) return;
  lkFlush();
  const before = snapOf();
  for (const c of S.L.cats) delete c.col;
  S.look = Object.assign({}, S.look, { pal: k, acc: PALETTES[k][2] }, S.look.pal !== k || S.look.acc !== PALETTES[k][2] ? { changed: true } : {});
  if (snapOf() === before) { renderSettings(); return; }   // (the one in use, nothing of yours on it: no step)
  pushUndo(before); applyLook();
  afterChange();
  renderSettings(); if (feed.got) updateView(true, true);
}
// (11-05: Settings stays as it is while the look is changed. The see-through when the pointer rested, the eye that held
// the view and Settings moving aside were all tried and all removed, his "just remove it, it's just worse")
$('setbody').addEventListener('mousedown', e => { if (e.target.closest('.lk-pop button')) e.preventDefault(); });
$('setbody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.lk-hex')) e.target.blur(); });   // (Enter uses the hex, as its tip says: the blur's change applies it)   // (a typed hex keeps its focus: the tone's click isn't lost to a redraw)
const setSec = (name, rows) => '<section class="setsec"><h3>' + name + '</h3><div class="setbox">' + rows + '</div></section>';
function renderSettings0() {
  $('setbody').innerHTML =
    setSec('Window',
    '<div class="setrow"><div>Title<small>Shown in the title bar. Empty: the name of this PC' + (feed.pc ? ', ' + esc(feed.pc) : '') + '.</small></div><input class="setin" id="sTitle" maxlength="60" spellcheck="false" placeholder="' + esc(feed.pc || 'HW Deck') + '" value="' + esc(S.title || '') + '"></div>' +
    '<div class="setrow"><div>Clock<small>The time of the last reading, next to the title.</small></div><button class="tog2' + (S.clock ? ' on' : '') + '" id="sClock" aria-pressed="' + S.clock + '" title="Show the clock"></button></div>' +
    '<div class="setrow"><div>Animations<small>' + ({ full: 'Rolling numbers, smoothly spinning fans, gliding graphs.', minimal: 'Nothing keeps moving: numbers just change, fans stand still, graphs step. Popups and views still slide.', off: 'Nothing moves at all.' })[motionPicked()] +
      (!MOTIONS.includes(S.motion) && reducedMotion.matches ? ' Windows asks apps for less motion.' : '') + (motionMode() !== motionPicked() ? (feed.game && feed.front ? ' Minimal for now: a game is in front.' : ' Minimal for now: your session is recording.') : '') + '</small></div><span class="seg seg3" id="sMotion">' +
      [['full', 'Full'], ['minimal', 'Minimal'], ['off', 'Off']].map(([v, t]) => '<button data-m="' + v + '" class="' + (motionPicked() === v ? 'on' : '') + '">' + t + '</button>').join('') + '</span></div>' +
    '<div class="setrow"><div>Calmer during games<small>Full animations switch to Minimal while a game is in front or a session you started records, and back after. Saves CPU for the game.</small></div><button class="tog2' + (S.gameCalm !== false ? ' on' : '') + '" id="sCalm" aria-pressed="' + (S.gameCalm !== false) + '" title="Minimal animations while a game is in front"></button></div>') +
    setSec('Look',
    lookTheme() + lookBg() + lookCells() +
    '<div class="setrow lk-colr"><div>Colour<small>' + ({ none: 'Greys only: colour is kept for warnings.', accent: 'One colour on what you pick.', spectrum: 'A colour for each category, and the accent.' })[S.look.tint] + '</small></div><span class="lk-cw">' + lkAccBox() + '<span class="seg seg3" id="sTint">' +
      [['none', 'Mono'], ['accent', 'Accent'], ['spectrum', 'Spectrum']].map(([v, t]) => '<button data-v="' + v + '" class="' + (S.look.tint === v ? 'on' : '') + '">' + t + '</button>').join('') + '</span></span>' + (lkPick === 'acc' && S.look.tint !== 'none' ? '<div class="lk-fl" data-for="acc">' + lkPop('acc', S.look.acc) + '</div>' : '') + '</div>' +
    (S.look.tint === 'spectrum' ? lookPalette() : '') +
    '<div class="setrow"><div>Popups</div><span class="seg seg3" id="sPops">' +
      [['view', 'View'], ['cells', 'Cells']].map(([v, t]) => '<button data-v="' + v + '" class="' + (S.look.pops === v ? 'on' : '') + '">' + t + '</button>').join('') + '</span></div>') +
    setSec('Startup',
    '<div class="setrow"><div>Start with Windows<small>Opens in the tray when you sign in.</small></div><button class="tog2' + (feed.autostart ? ' on' : '') + '" id="sAuto" aria-pressed="' + feed.autostart + '" title="Start with Windows"></button></div>' +
    (feed.updatable === false ? '' : '<div class="setrow"><div>Updates<small>' + (feed.latest ? 'HW Deck ' + esc(feed.latest) + ' is out.' : 'Asks GitHub if there is a new version when HW Deck starts, then once a day. Nothing else is sent.') + '</small></div>' +
      '<span style="display:flex;gap:10px;align-items:center">' + (feed.latest ? '<button class="btn" id="sGet">' + (feed.canUpdate ? 'Update now' : 'Get it') + '</button>' : '') + (feed.updates ? '<button class="ib' + (feed.updBusy ? ' spin' : '') + '" id="sUpdNow" title="Check now"' + (feed.updBusy ? ' aria-busy="true"' : '') + '><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/></svg></button>' : '') + '<button class="tog2' + (feed.updates ? ' on' : '') + '" id="sUpd" aria-pressed="' + feed.updates + '" title="Check for new versions"></button></span></div>')) +
    setSec('HWiNFO',
    '<div class="setrow"><div>HWiNFO<small' + (feed.hwinfo ? ' class="k">' + esc(feed.hwinfo) : '>Not seen running yet') + '</small><small>A restart turns its sharing back on.</small></div><button class="btn" id="sRestart"' + (feed.fake ? ' disabled' : '') + '>Restart HWiNFO</button></div>' +
    '<div class="setrow"><div>Keep HWiNFO sharing<small>The free HWiNFO stops sharing after 12 hours. With this on, a Windows task restarts it with sharing on after about 11 hours of running, with a few seconds without readings. It turns HWiNFO\'s welcome screen off and starts it in Sensors-only mode, so it comes back by itself.</small>' +
      (feed.keep && feed.keepNote && !feed.keepWait ? '<small class="y">' + esc(feed.keepNote) + '</small>' : '') + '</div>' +
      '<button class="tog2' + (feed.keep ? ' on' : '') + '" id="sKeep" aria-pressed="' + feed.keep + '" title="Keep HWiNFO sharing"' + (feed.fake || feed.keepBusy || feed.keepWait ? ' disabled' : '') + '></button></div>') +
    setSec('Games',
    '<div class="setrow"><div>Accurate game fps<small>HWiNFO\'s fps can be another app\'s: a browser, Discord, a game\'s launcher. With this on, ' + esc(feed.brand || 'HW Deck') + ' counts the game\'s own frames in DirectX games.</small>' + fpsNote() + '</div>' +
      '<button class="tog2' + (feed.fps ? ' on' : '') + '" id="sFps" aria-pressed="' + feed.fps + '" title="Accurate game fps"' + (feed.fake || feed.fpsBusy || feed.fpsWait ? ' disabled' : '') + '></button></div>' +
    '<div class="setrow"><div>Same game again<small>A game started again within this many minutes of closing goes on with its session. The break shows in its chart but doesn\'t count as play. 0: always a new session.</small></div><span class="setdays">' + spinBox('id="sGameMerge" data-min="0" data-max="240" data-idle="600" maxlength="3"', Number.isFinite(feed.gameMerge) ? feed.gameMerge : 30, '30') + '<i>min</i></span></div>') +
    setSec('Data',
    keepRow('sGameDays', 'gameDays', 'Keep sessions', 'Older sessions, games and your own, go to the bin. Its icon in Sessions brings them back.') +
    keepRow('sWarnDays', 'warnDays', 'Keep warnings', 'Older warnings go to the bin. Its icon in Warning history brings them back.') +
    '<div class="setrow"><div>Your files<small class="k">' + esc(feed.dataDir) + '</small><small>Layouts, slots, the logs and 7 days of history.</small></div><button class="btn" id="sData">Open</button></div>') +
    setSec('Keys',
    '<div class="setrow" style="display:block"><div class="keys2">' +
      [['E', 'edit layout on or off'], ['1 2 3', 'Tiles, Overview, Grid'], ['Enter', 'open or select the cell in focus'], ['Ctrl+S', 'save to the loaded slot'], ['Ctrl+Z, Ctrl+Shift+Z', 'undo, redo'],
       ['Alt + arrows', 'move the selected cell, or swap the selected category with its neighbour'], ['Shift + Alt + arrows', 'the selected category: wider, narrower, its row taller, shorter'],
       ['R  B  S  U', 'the selected category: own row, beside the row above, stack under the left one, unstack'], ['Del', 'remove the selected cell or category'], ['Esc', 'close a popup, then select nothing']].map(k => '<span class="kbd">' + k[0] + '</span><span>' + k[1] + '</span>').join('') + '</div></div>') +
    setSec('About',
    '<div class="setrow"><div>' + (feed.brand && feed.brand !== 'HW Deck' ? esc(feed.brand) + ', built on HW Deck ' : 'HW Deck ') + esc(feed.version) + '<small>Reads HWiNFO\'s shared memory on this PC.</small></div></div>');
}
$('setBtn').onclick = () => { lkPick = null; keepPend.gameDays = keepPend.warnDays = false; feed.setSig = null; renderSettings(); setmodal.classList.add('open'); send({ t: 'getSettings' });
  // (an update waiting: its row in sight, what the dot on the gear was about; else from the top, 11-06)
  if (feed.latest && $('sGet')) $('sGet').scrollIntoView({ block: 'nearest' }); else setmodal.querySelector('.mcard').scrollTop = 0; };   // (the host's answer: Start with Windows and the task as they are now)
function syncUpd() { const d = $('setDot'); d.classList.toggle('on', !!feed.latest); $('setBtn').title = feed.latest ? 'Settings: HW Deck ' + feed.latest + ' is out' : 'Settings'; }
$('setbody').addEventListener('click', e => {
  if (e.target.closest('#sAuto')) { feed.autostart = !feed.autostart; send({ t: 'autostart', on: feed.autostart }); renderSettings(); }
  const mb = e.target.closest('#sMotion button');
  if (mb && mb.dataset.m !== S.motion) { S.motion = mb.dataset.m; applyMotion(); calmSettle(); saveState(); renderSettings(); }   // (2.1: settled in place, no rebuild: the motion audit 11-04)   // the one already on too: picked by hand, it stops following Windows
  if (e.target.closest('#sRestart')) restartHwinfo();
  // (it shows what was asked while Windows asks for permission; the host's answer to it (keepDone) says how it really is)
  if (e.target.closest('#sKeep') && !feed.fake && !feed.keepBusy && !feed.keepWait) { feed.keep = !feed.keep; feed.keepWait = true; send({ t: 'keepSharing', on: feed.keep }); renderSettings(); }
  if (e.target.closest('#sFps') && !feed.fake && !feed.fpsBusy && !feed.fpsWait) { feed.fps = !feed.fps; feed.fpsWait = true; send({ t: 'gameFps', on: feed.fps }); renderSettings(); }
  if (e.target.closest('#sData')) send({ t: 'openData' });
  if (e.target.closest('#sUpdNow') && !feed.updBusy) { feed.updBusy = true; send({ t: 'updCheck' }); renderSettings(); clearTimeout(feed.updT); feed.updT = setTimeout(() => { if (feed.updBusy) { feed.updBusy = false; if (setmodal.classList.contains('open')) renderSettings(); } }, 40000); }   // (his 11-07: a check on demand; no answer in 40 s, it lets go)
  if (e.target.closest('#sUpd')) { feed.updates = !feed.updates; if (!feed.updates) feed.latest = null; send({ t: 'updates', on: feed.updates }); syncUpd(); renderSettings(); }
  if (e.target.closest('#sGet')) send({ t: feed.canUpdate ? 'updateNow' : 'openRelease' });
  if (e.target.closest('#sClock')) { S.clock = !S.clock; renderTitle(); saveState(); renderSettings(); }
  if (e.target.closest('#sCalm')) { S.gameCalm = S.gameCalm === false; applyMotion(); calmSettle(); saveState(); renderSettings(); }
  const pb = e.target.closest('#sPops button');   // (how the popups look: not the theme's, so the theme stays as picked)
  if (pb && S.look.pops !== pb.dataset.v) { lkFlush(); snap(); S.look = Object.assign({}, S.look, { pops: pb.dataset.v }); applyLook(); saveState(); syncUndo(); renderSettings(); }
  const lb = e.target.closest('#sTint button'), lk = lb && 'tint';
  if (lb && S.look[lk] !== lb.dataset.v) { lkFlush(); snap(); S.look = Object.assign({}, S.look, { [lk]: lb.dataset.v, changed: true }); lkPick = null; applyLook(); saveState(); syncUndo(); renderSettings(); if (feed.got) updateView(true, true); }   // (seen at once behind Settings: the graphs take their colour as they are fed)
  const lq = e.target.closest('[data-lk]'), lw = lq && lq.dataset.lk;
  if (lw === 'fold') { const f = lq.dataset.f, open = f === 'bg' ? (lkBg = !lkBg) : (lkCells = !lkCells);
    if (lkPick && !LK_OWN.has(lkPick)) { lkPickSet(null); return; }   // (a floating editor open: it fades as it shuts, the fold drawn at its new state, 11-09 review)
    // (an open chip shuts, in place: drawn again, the fold wouldn't glide)
    if (lkPick) { lkPick = null; document.querySelectorAll('#setbody .lk-pop:not([aria-hidden])').forEach(x => lkPopIO(x, false)); document.querySelectorAll('#setbody .lk-chip.on').forEach(x => x.classList.remove('on')); }
    lq.classList.toggle('open', open); lq.setAttribute('aria-expanded', open); lq.nextElementSibling.classList.toggle('open', open); return; }   // (folds in place: it glides)
  if (lw === 'theme') { pickTheme(lq.dataset.k); return; }
  if (lw === 'saved') { lookApplySaved(lq.dataset.k); return; }   // (the Saved group, 11-09)
  if (lw === 'save') { lookSave(false); return; }
  if (lw === 'saveadd') { lookSave(true); return; }
  if (lw === 'savex') { lookAskDelete(lq.dataset.k); return; }
  if (lw === 'fade') { const at = lq.dataset.at; lkPick = null; if (S.look.fades.some(f => f.at === at)) { bgSel = at; renderSettings(); } else { bgSel = at; lookEdit(L => { L.fades.push({ at, c: newFade(), size: 70, a: 30 }); }); } return; }
  if (lw === 'fadex') { if (e.detail > 1) return; const at = bgSel;   // (a double click: one fade, 11-06)
    lkPick = null; lookEdit(L => { L.fades = L.fades.filter(f => f.at !== at); }); bgSel = null; renderSettings(); return; }
  if (lw === 'line') { lookEdit(L => { L.line = !L.line; }); return; }
  if (lw === 'chip') { lkPickSet(lkPick === lq.dataset.k ? null : lq.dataset.k); return; }
  if (lw === 'c') { pickColour(lq.dataset.k, lq.dataset.c); return; }
  if (lw === 'pal') { pickPalette(lq.dataset.k); return; }
  if (lkPick && !e.target.closest('.lk-pop') && !e.target.closest('.dsel')) lkPickSet(null);   // (a click anywhere else closes the open chip; a dropdown's opens its menu)
});
let lkUpAt = 0, lkIdle = 0, setPress = false;   // (a pointer let go in Settings, when; a press in it under way)
document.addEventListener('pointerup', () => { lkUpAt = performance.now(); }, true);
setmodal.addEventListener('mousedown', () => { setPress = true; setTimeout(() => { setPress = false; }); }, true);
// (a slider of the look: seen at once while dragged, one undo step and a save when let go)
$('setbody').addEventListener('input', e => {
  const r = e.target.closest('.lk-rng'); if (!r) return;
  if (lkDrag == null) lkDrag = snapOf();
  const v = +r.value, k = r.dataset.k;
  if (k === 'op') S.look.op = v; else if (k === 'rad') { const d = lkRadPtr && Object.values(LK_RAD).find(x => Math.abs(x - v) <= 1); if (d != null && d !== false && d !== v) { r.value = d; return r.dispatchEvent(new Event('input', { bubbles: true })); } S.look.rad = v; } else if (k === 'lineA') { if (v === 100) delete S.look.lineA; else S.look.lineA = v; } else { const f = S.look.fades.find(x => x.at === bgSel); if (!f) return; f[k] = v; }   // (corners: held at the old presets within 1 px, 11-09)
  r.style.setProperty('--v', ((v - +r.min) / (+r.max - +r.min) * 100) + '%'); if (r.nextElementSibling) r.nextElementSibling.textContent = v + (r.dataset.u === 'px' ? ' px' : '%'); r.setAttribute('aria-valuetext', v + (r.dataset.u === 'px' ? ' px' : '%'));
  applyLook();
  // (the small screen in Settings too, the one look seen while it is dragged, 11-06)
  const mi = $('setbody').querySelector('.bg-mini'); if (mi) { mi.style.background = bgiOf(S.look); const gh = mi.querySelector('.bg-gh'); if (gh) { gh.style.setProperty('--t', tileOf(S.look)); gh.style.setProperty('--l', S.look.line ? lineOf(S.look) : 'transparent'); } }
});
$('setbody').addEventListener('change', e => {
  if (e.target.matches('.lk-rng')) {
    // (by the keys, a change each press: one step once they stop, 11-06; let go of by the pointer: now)
    if (performance.now() - lkUpAt > 150) { clearTimeout(lkIdle); lkIdle = setTimeout(() => { if (lkDrag == null) return; if (setmodal.classList.contains('open')) renderSettings(); else { const b = lkDrag; lkDrag = null; if (snapOf() !== b) { S.look.changed = true; pushUndo(b); saveState(); syncUndo(); } } }, 600); return; }
    const b = lkDrag; lkDrag = null; if (b != null && snapOf() !== b) { S.look.changed = true; pushUndo(b); saveState(); syncUndo(); } renderSettings(); return;
  }
  // (a colour left by a press on another button: that click lands first, then the colour, 11-06)
  if (e.target.matches('.lk-any input, .lk-hex')) { const v = e.target.value.trim(), c = /^#?[0-9a-f]{6}$/i.test(v) ? (v[0] === '#' ? v : '#' + v) : null; if (c) { const k = e.target.dataset.k, go = () => pickColour(k, c); if (setPress) addEventListener('click', () => setTimeout(go), { once: true, capture: true }); else go(); } else if (e.target.matches('.lk-hex')) renderSettings(); return; }   // (any colour: the picker closed on one, or a hex typed; not a colour: as it was)
  const id = e.target.id;
  if (id === 'sGameMerge') {   // (0 to 240 minutes; empty or not a number: as it was)
    delete e.target.dataset.dirty;
    const old = Number.isFinite(feed.gameMerge) ? feed.gameMerge : 30, n = Math.round(Number(e.target.value));
    const v = e.target.value.trim() === '' || !Number.isFinite(n) ? old : Math.max(0, Math.min(240, n));
    e.target.value = v; if (v !== old) { feed.gameMerge = v; send({ t: 'gameMerge', min: v }); }
    return;
  }
  if (id !== 'sGameDays' && id !== 'sWarnDays') return;
  delete e.target.dataset.dirty;
  // (0 to 3650, 0 forever; empty or not a number ("forever" as it shows): as it was. Old null: not set since a damaged
  // settings file, so any number cuts something and asks first)
  const k = id === 'sGameDays' ? 'gameDays' : 'warnDays', old = feed[k], raw = e.target.value.trim(), pend = keepPend[k];
  const v = /^\d+$/.test(raw) ? Math.min(3650, +raw) : pend ? 0 : old;   // (a whole number of days, 0 forever; anything else: as it was, unset too, 11-06)
  if (v == null) { e.target.value = ''; return; }
  // (switched to days from forever, then nothing or 0 typed: still forever, its field goes)
  if (pend && v === 0) { keepPend[k] = false; setTimeout(() => { if (setmodal.classList.contains('open')) renderSettings(); }, 0); return; }
  e.target.value = pend ? String(v) : keepTxt(old); if (v === old) return;
  // (the field set in place: Settings drawn again here would lose the focus a Tab or click was taking; 0 typed: forever,
  // the field goes, drawn again once this event is done)
  const go = () => { keepPend[k] = false; feed[k] = v; const i = $(id); if (i) i.value = keepTxt(v); if (v === 0) setTimeout(() => { if (setmodal.classList.contains('open')) renderSettings(); }, 0); send(k === 'gameDays' ? { t: 'keep', games: v } : { t: 'keep', warns: v }); };   // (only the one changed)
  if (v === 0 || (old && v > old)) go();   // (forever, or more days: nothing goes)
  else askConfirm('Keep ' + (k === 'gameDays' ? 'sessions' : 'warnings') + ' ' + v + (v === 1 ? ' day?' : ' days?'), (k === 'gameDays' ? 'Sessions' : 'Warnings') + ' older than that go to the bin now, where they can be brought back.', 'Move to the bin', go, false,
    pend ? () => { keepPend[k] = false; if (setmodal.classList.contains('open')) renderSettings(); } : null);   // (no from forever: still forever)
});
// a days field's text: the days, empty while not set (its placeholder says 30)
const keepTxt = d => d ? String(d) : '';
// Keep sessions / warnings: days or forever; the number only for days (0 typed in it: forever too). keepPend: a row just
// switched from forever to days, its number not typed yet (nothing changes, nothing is asked, until it is)
const keepPend = {};
function keepRow(id, k, name, txt) {
  const fv = feed[k] === 0 && !keepPend[k];
  return '<div class="setrow"><div>' + name + '<small>' + txt + '</small></div><span class="setkeep">' +
    (fv ? '' : spinBox('id="' + id + '" data-min="1" data-max="3650" data-idle="800" title="Days"', keepTxt(feed[k]), '30')) +
    '<span class="seg seg3" data-keep="' + k + '"><button data-v="days"' + (fv ? '' : ' class="on"') + '>Days</button><button data-v="forever"' + (fv ? ' class="on"' : '') + '>Forever</button></span></span></div>';
}
// days or forever picked: forever goes at once (nothing is deleted); days from forever shows the empty field, and the
// question about what goes comes once a number is typed (the change above)
$('setbody').addEventListener('click', e => {
  const b = e.target.closest('.setkeep .seg button'); if (!b) return;
  const k = b.parentNode.dataset.keep, fv = b.dataset.v === 'forever', isF = feed[k] === 0 && !keepPend[k];
  if (fv === isF) return;
  if (fv) { if (!keepPend[k]) send(k === 'gameDays' ? { t: 'keep', games: 0 } : { t: 'keep', warns: 0 }); keepPend[k] = false; feed[k] = 0; renderSettings(); return; }
  keepPend[k] = true; renderSettings();
  const i = $(k === 'gameDays' ? 'sGameDays' : 'sWarnDays'); if (i) i.focus();
});
// (a days value put back after Settings redrew under it: left without another key, it still counts; a field switched
// to days and left empty goes back to forever)
$('setbody').addEventListener('focusout', e => {
  const t = e.target; if (t.dataset && t.dataset.dirty) setTimeout(() => { if (t.dataset.dirty) { delete t.dataset.dirty; t.dispatchEvent(new Event('change', { bubbles: true })); } }, 0);
  const k = t.id === 'sGameDays' ? 'gameDays' : t.id === 'sWarnDays' ? 'warnDays' : null;
  if (k && keepPend[k] && !t.value.trim()) setTimeout(() => { const a = document.activeElement, row = t.closest('.setkeep') || $('setbody').querySelector('.setkeep .seg[data-keep="' + k + '"]').parentNode; if (keepPend[k] && a !== t && !cmodal.classList.contains('open') && !(a && a.closest && a.closest('.setkeep') === row)) { keepPend[k] = false; if (setmodal.classList.contains('open')) renderSettings(); } }, 120);
});
$('setbody').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.target.id === 'sGameDays' || e.target.id === 'sWarnDays' || e.target.id === 'sGameMerge')) { e.preventDefault(); const t = e.target; setTimeout(() => t.blur(), 0); } });   // (later: the same Enter pressed Cancel on the question it opened)
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
  if (feed.fake || b.classList.contains('spin')) { toast(feed.fake ? 'Demo data: there is no HWiNFO to restart' : 'HWiNFO is restarting already'); return; }
  send({ t: 'restartHwinfo' });
  b.classList.add('spin'); b.disabled = true; b.title = 'Restarting HWiNFO...';
  clearTimeout(restartT); restartT = setTimeout(restartDone, 95000);   // the host gives up after 90 s (11-06: it was 70 here)
}
function restartDone() {
  clearTimeout(restartT);
  const b = $('rstBtn'); b.classList.remove('spin'); b.disabled = feed.fake; b.title = 'Restart HWiNFO to turn its shared memory back on';
}
$('rstBtn').onclick = restartHwinfo;

// ---------- toast ----------
let toastT = 0, toastDepth = -1;
function toast(msg, withUndo, ms) {
  setText($('toastTxt'), msg); $('toastUndo').hidden = !withUndo; $('toastUndo').disabled = false; $('toastUndo').getAnimations().forEach(a => a.cancel());
  toastDepth = withUndo ? undoSeq : -1;
  const t = $('toast'), was = t.classList.contains('show'); t.classList.add('show'); clearTimeout(toastT);
  if (was && motionMode() !== 'off') t.animate([{ opacity: 0.4, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });   // (a new message, not the old one changing; 2.1)
  toastT = setTimeout(() => { t.classList.remove('show'); toastDepth = -1; setTimeout(() => { if (!t.classList.contains('show')) { setText($('toastTxt'), ''); $('toastUndo').hidden = true; } }, 300); }, ms || (withUndo ? 8000 : msg.length > 60 ? 5000 : 2600));   // (its Undo goes with its text, after the fade: no narrower box while it fades, 11-08)
}
// ---------- tooltips: the page's own instead of Windows' (prettify 11-02) ----------
// A hint (data-tip: every title becomes one, see the top) under the pointer shows as a tip in the app's greys after a
// short wait; a press, a key or a scroll puts it away until the pointer goes somewhere else
const tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl);
let tipFor = null, tipT = 0;
// (a hint the page changes while its tip is up, a live row's every second: the tip says the new one)
const tipObs = new MutationObserver(() => {
  if (!tipFor || !tipEl.classList.contains('show')) return;
  const t = tipFor.getAttribute('data-tip'); if (!t) { tipHide(); return; }
  tipEl.textContent = t; tipPlace(tipFor);
});
let tipLast = 0;   // (when a tip last went away: the next one within 700 ms shows at once, 2.1)
function tipHide() { clearTimeout(tipT); tipObs.disconnect(); tipFor = null; if (tipEl.classList.contains('show')) tipLast = performance.now(); tipEl.classList.remove('show'); }
function tipPlace(el) {
  const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)), below = r.bottom + 8 + h <= innerHeight - 8;
  tipEl.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(below ? r.bottom + 8 : Math.max(8, r.top - 8 - h)) + 'px)';
}
document.addEventListener('pointerover', e => {
  // (a name that may be cut short, a tile's: its whole name as its tip, only when it is cut)
  const fu = e.target.closest && e.target.closest('[data-full]');
  if (fu) { if (fu.scrollWidth > fu.clientWidth + 1) fu.setAttribute('data-tip', fu.textContent); else fu.removeAttribute('data-tip'); }
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (tipGone) { if (el === tipGone) return; tipGone = null; }   // (put away by a press: not again on the same button, 11-06)
  if (el === tipFor) return;
  // (its element drawn again under the pointer, a live row's: the new one's tip at once, no second wait)
  const again = tipEl.classList.contains('show') && !!tipFor && !tipFor.isConnected;
  tipHide(); if (!el) return;
  tipFor = el; tipObs.observe(el, { attributes: true, attributeFilter: ['data-tip'] });
  const warm = performance.now() - tipLast < 700;
  const show = () => { const t = el.getAttribute('data-tip'); if (tipFor !== el || !el.isConnected || !t || !t.trim()) return; tipEl.textContent = t; tipPlace(el); tipEl.classList.toggle('warm', warm || again); tipEl.classList.add('show'); };
  if (again) show(); else tipT = setTimeout(show, warm ? 60 : 450);
});
document.addEventListener('pointerout', e => { if (tipFor && !(e.relatedTarget && tipFor.contains(e.relatedTarget))) tipHide(); });
let tipGone = null;   // (the element whose tip a press put away)
for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, () => { if (tipFor) tipGone = tipFor; tipHide(); }, true);
document.addEventListener('scroll', tipHide, true);
// another change after the toast: its Undo would undo that one instead, so it goes
function toastStale() { if (toastDepth >= 0 && undoSeq !== toastDepth) retireToastUndo(); }
function retireToastUndo() {   // (no width jump, 11-08: while the toast fades out the button goes with it; while it stays, the button fades first)
  const b = $('toastUndo'), t = $('toast'); toastDepth = -1; if (b.hidden) return;
  if (motionMode() === 'off') { b.hidden = true; return; }
  b.disabled = true;
  const end = () => { b.disabled = false; if (toastDepth < 0) b.hidden = true; };
  if (!t.classList.contains('show')) { setTimeout(end, 300); return; }
  const a = b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }); a.onfinish = () => { a.cancel(); end(); };
}

// ---------- keys ----------
// a curve point or a Customize row held: keys wait (Escape lets go), before any field's own handler gets them
document.addEventListener('keydown', ev => {
  if (!dragPt && !gzDragCancel) return;
  if (ev.key === 'Escape') { if (dragPt) ptCancel(); else gzDragCancel(); }
  ev.preventDefault(); ev.stopPropagation();
}, true);
document.addEventListener('keydown', ev => {
  if (ev.key === 'Tab') { ev.preventDefault(); tabField(ev); return; }   // (Tab doesn't walk the buttons: his call 11-02; the settings' fields, yes)
  if (drag && drag.started) { if (ev.key === 'Escape') { cancelPid = drag.pid; endDrag(true); editPress = null; } ev.preventDefault(); return; }   // nothing else mid-drag
  if (rs) {
    if (ev.key === 'Escape') { cancelPid = rs.pid; endHandle(true); }
    else if (ev.key === 'Alt' && rs.kind === 'corner' && rs.last) moveCorner(Object.assign({ altKey: true }, rs.last));   // Alt: any size, at once
    ev.preventDefault(); return;
  }
  // a list opened with the mouse and closed without a pick still has the focus: a key that isn't for a list lets go of it
  // and is the page's (1 2 3 switch the view, not its option)
  let tgt = ev.target;
  if (tgt.tagName === 'SELECT' && tgt._ptr && !ev.ctrlKey && !ev.metaKey && !listKey(ev) && !['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(ev.key)) { tgt._ptr = false; tgt.blur(); ev.preventDefault(); tgt = document.body; }
  // fields that take typing (a checkbox doesn't; a select takes letters and digits for its options)
  const typing = tgt.closest && tgt.closest('textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])');   // (a slider or colour well isn't typed in, 11-06)
  const ctrl = ev.ctrlKey || ev.metaKey, k = (ev.key || '').toLowerCase();
  // (a name or a size still being typed goes in first: those apply when the field is left)
  if (ctrl && k === 's') { ev.preventDefault(); if (cmodal.classList.contains('open')) return; if (nudge) flushNudge(); const a = document.activeElement; if (a && a.matches && a.matches('#lName, #insp input[data-sz], #insp input[data-csz], #insp input[data-cw], #gcz .gz-name, #cTab input')) { a.blur(); if (a.isConnected && !a.closest('#cTab')) a.focus(); } setTimeout(() => { if (!cmodal.classList.contains('open')) onSave(); }, 0); return; }   // (a layout field still being typed: left and taken back, which applies it if it changed)
  if (ev.key === 'Escape') {
    if (drag) { cancelPid = drag.pid; endDrag(true); editPress = null; return; }   // (a held press let go: its release does nothing)
    if (cmodal.classList.contains('open')) { closeConfirm(); return; }
    if (smenu) { closeSmenu(); return; }
    // (the one on top first: Saves over a cell popup closed the popup under it, 11-06)
    const tm = topModal();
    if (tm === setmodal && lkPick) { lkPickSet(null); return; }   // (an open colour chip first, 11-06; it folds away, 11-08)
    // (the log's cell list, or picking in the log or Sessions: a step back first, 11-06; it closed the popup)
    if (tm === wmodal && WX.menu) { wxSet({ menu: false }); return; }
    if (tm === gmodal && GX.menu) { gxSet({ menu: false }); return; }   // (Sessions' game list the same way, and a field being typed in: before Compare or Pick, 11-09)
    if (tm === gmodal && typing && gmodal.contains(ev.target)) { ev.target.blur(); return; }
    for (const pk of ['w', 'g']) { const m = pk === 'w' ? wmodal : gmodal; if (tm === m && (PK[pk].mode === 'sel' || PK[pk].mode === 'cmp')) { pkMode(pk, null); return; } }   // (picking or Compare only: with the bin on show, Escape shuts the popup as before)
    if (tm === gmodal) {
      if (GZ.on) { GZ.on = false; renderGz(); return; }
      if (gxCmp) { gxCmpEnd(); return; }   // (two compared: back to the list, 11-06)
    }
    if (tm && tm.id === 'modal' && modalCid) { closeDetail(); return; }
    if (tm && ['wmodal', 'gmodal', 'smodal', 'setmodal'].includes(tm.id)) { tm.classList.remove('open'); return; }
    if (modalCid) { closeDetail(); return; }
    for (const id of ['wmodal', 'gmodal', 'smodal', 'setmodal']) if ($(id).classList.contains('open')) { $(id).classList.remove('open'); return; }
    if (typing && ev.target.closest('#insp') && !ev.target.matches('#lName, select')) { ev.target.blur(); return; }   // (a settings field: left, what was typed goes in; the next Escape clears the selection, 11-06)
    if (relinkFor) { endRelink(); renderView(false); }
    else if (S.edit && (!typing || ev.target.tagName === 'SELECT' || (ev.target.id === 'q' && !ev.target.value))) {
      if (ev.target.id === 'q') ev.target.blur();   // (its text already cleared: the field is left too, 11-06)   // (a closed list has no Escape of its own) Esc: nothing selected, and the drawers that aren't pinned tuck away (even under the pointer)
      for (const d of [DR.L, DR.R]) { clearTimeout(d.t); d.hover = false; d.byPick = false; }
      if (sel || selCat) clearSel(); else syncDrawers();
    }
    return;
  }
  // (a list keeps the focus after a pick, for its arrows and letters; it has no undo of its own, so Ctrl+Z / Ctrl+Y go through)
  if (typing && !(ctrl && ev.key.startsWith('Arrow') && ev.target.dataset && ev.target.dataset.sz) && !(ctrl && (k === 'z' || k === 'y') && ev.target.tagName === 'SELECT') && !(ctrl && (k === 'z' || k === 'y') && !ev.target._typed && ev.target.closest('#insp'))) return;   // (a settings field with nothing typed: the layout's undo)
  if (ctrl && (k === 'z' || k === 'y')) {
    ev.preventDefault(); if (cmodal.classList.contains('open') || modalCid != null) return;   // (a cell popup has nothing of its own to undo: not the layout behind it, 11-06)
    // (the warning log or Sessions: only their own steps, a bin move or a restore; a layout step waits for them to close)
    if (wmodal.classList.contains('open') || gmodal.classList.contains('open')) { const st = k === 'y' || ev.shiftKey ? redoStack : undoStack; if (!st.length || !hostStep(st[st.length - 1])) return; }
    k === 'y' || ev.shiftKey ? redo() : undo(); return;
  }
  if (ctrl && S.edit && sel && S.screen === 'tiles' && !preview && !anyModalOpen() && ev.key.startsWith('Arrow')) {
    ev.preventDefault();
    const dx = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0, dy = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0, big = ev.shiftKey;
    // a size typed in the field and not applied yet goes in first (left and taken back, as Ctrl+S does; its change
    // applies it on a 0 ms timer, so the nudge waits one behind it)
    const a = ev.target;
    if (a._typed && a.dataset && a.dataset.sz) { a.blur(); if (a.isConnected) a.focus(); const id = sel; setTimeout(() => { if (sel === id) nudgeSize(id, dx, dy, big); }, 0); return; }
    nudgeSize(sel, dx, dy, big);
    return;
  }
  if (anyModalOpen() || ctrl) return;
  const dc = ev.target.matches && ev.target.matches('#view .dc') ? ev.target : null;
  if (dc && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); if (S.edit) { if (sel === dc.dataset.cid && ev.key === 'Enter') openDetail(sel); else selectCell(dc.dataset.cid); } else openDetail(dc.dataset.cid); return; }   // (Enter again: its popup, 11-06)
  const dh = S.edit && ev.target.matches && ev.target.matches('#view .dch') ? ev.target : null;
  if (dh && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); selectCat(dh.closest('.dcat').dataset.cat); return; }
  if (ev.key === 'e' || ev.key === 'E') { setEdit(!S.edit); return; }
  if (!ev.altKey && ['1', '2', '3'].includes(ev.key)) { requestScreen(['tiles', 'overview', 'grid'][+ev.key - 1]); return; }
  if (S.edit && selCat && !sel && preview) { preview = null; renderView(false); }   // keys act on yours, not on a template being previewed
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && ev.target.closest && ev.target.closest('#insp, .dsel-m')) return;   // (a key on a settings button never removes what is selected: 11-06 audit)
  if (S.edit && selCat && !sel) {   // a selected category: arrows with Alt move it, with Shift+Alt size it, R B S U place it
    const id = selCat, k = ev.key, dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
    if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); removeCat(id); return; }
    if (k === 'F2') { ev.preventDefault(); renameCat(document.querySelector('#view .dcat[data-cat="' + id + '"]')); return; }
    if ((dx || dy) && ev.altKey && ev.shiftKey) {
      ev.preventDefault();
      if (S.screen === 'grid') return;   // (no category sizes in Grid: nothing, 11-06; it moved the category)
      keyLayout(() => {
        if (dx) nudgeWidth(id, dx);
        else if (S.screen === 'tiles') setRowHeight(id, dy > 0 ? 1 : 0);
      });
      focusCat(id); return;
    }
    if ((dx || dy) && ev.altKey) { ev.preventDefault(); const o = nearestCat(id, dx, dy); if (o) { keyLayout(() => swapCats(id, o)); announce(id); } focusCat(id); return; }
    const how = !ev.altKey && S.screen !== 'grid' ? { r: 'row', b: 'beside', s: 'stack', u: 'unstack' }[k.toLowerCase()] : null;
    if (how) { ev.preventDefault(); moveCat(id, how); focusCat(id); return; }
    return;
  }
  if (!S.edit || !sel) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeCell(sel); return; }
  if (ev.altKey && ev.key.startsWith('Arrow')) {
    ev.preventDefault();
    const cat = catOf(sel), ci = S.L.cats.indexOf(cat), id = sel, lead = catLook(cat.id).lead;
    // (out of its category: into the one drawn that way, as a category's Alt+arrows go; Left or Right with none beside
    // it: the one above or below; Grid's tables read in list order. 11-08 audit: it went by list order, across the view)
    const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[ev.key] || [0, 0], near = S.screen === 'grid' ? null : nearestCat(cat.id, dir[0], dir[1]) || (dir[0] ? nearestCat(cat.id, 0, dir[0]) : null);
    const upTo = S.screen === 'grid' ? S.L.cats[ci - 1] : near && dir[0] + dir[1] < 0 ? catById(near) : null, downTo = S.screen === 'grid' ? S.L.cats[ci + 1] : near && dir[0] + dir[1] > 0 ? catById(near) : null;
    const back = ev.key === 'ArrowLeft' || (S.screen !== 'tiles' && ev.key === 'ArrowUp'), fwd = ev.key === 'ArrowRight' || (S.screen !== 'tiles' && ev.key === 'ArrowDown');
    // within the category it moves among the others as drawn; the lead (drawn first) keeps its place
    const leadAt = lead && lead !== id ? cat.cells.indexOf(lead) : -1, rest = cat.cells.filter(x => x !== lead || x === id), i = rest.indexOf(id);
    mutate(() => {
      if (id !== lead && back && i > 0) { rest.splice(i, 1); rest.splice(i - 1, 0, id); if (leadAt >= 0) rest.splice(leadAt, 0, lead); cat.cells = rest; }
      else if (id !== lead && fwd && i < rest.length - 1) { rest.splice(i, 1); rest.splice(i + 1, 0, id); if (leadAt >= 0) rest.splice(leadAt, 0, lead); cat.cells = rest; }
      // (the lead, drawn first, keeps its place on a step forward, 11-06: it left its category; one that leaves takes its
      // lead setting with it)
      else if (id === lead && fwd && ev.key !== 'ArrowDown' && cat.cells.length > 1) return;
      else if ((ev.key === 'ArrowUp' || back) && upTo) { if (id === lead) setLook('cat', cat.id, 'lead', ''); cat.cells.splice(cat.cells.indexOf(id), 1); upTo.cells.push(id); upTo.collapsed = false; }
      else if ((ev.key === 'ArrowDown' || fwd) && downTo) { if (id === lead) setLook('cat', cat.id, 'lead', ''); cat.cells.splice(cat.cells.indexOf(id), 1); downTo.cells.unshift(id); downTo.collapsed = false; }
    });
    const el = document.querySelector('#view .dc[data-cid="' + id + '"]'); if (el) el.focus();
    const now = catOf(id); if (now) { const ids = idsIn(now); live.textContent = nameIn(id) + ': ' + now.name + ', ' + (ids.indexOf(id) + 1) + ' of ' + ids.length; }   // (said where it went, 11-06)
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
// (on and working says nothing more, his call 11-02: the row stays two lines; only what needs you shows)
const fpsNote = () => !feed.fps || feed.fpsWait || feed.fpsState === 'on' ? '' : '<small class="' + (feed.fpsState === 'on' ? '' : 'y') + '">' + ({ on: 'On: ' + esc(feed.brand || 'HW Deck') + ' counts the game\'s own frames.', signin: 'Almost: sign out of Windows and back in to finish.',
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
      : READ.length ? 'HWiNFO stopped sharing. Restart HWiNFO turns sharing back on, and the values come back by themselves.' + keepTip()
      : 'HWiNFO isn\'t sharing its readings. Restart HWiNFO turns sharing back on. Never set it up? In HWiNFO: Config, Main Settings, tick Shared Memory Support.');
  }
  // (shown, and taller or shorter than when the view was fitted: its text grew a line, a stall past a minute: fitted
  // again, 11-06; the view scrolled until the next resize)
  if (!ban.hidden && ban.hidden === was && ban._fitH && ban.offsetHeight !== ban._fitH) { clearTimeout(fitTimer); fitTimer = setTimeout(refit, 30); }
  ban._fitH = ban.hidden ? 0 : ban.offsetHeight;
  if (ban.hidden !== was) {   // the banner takes room: fit again at once, eased in (2.1: before, it pushed the view down and the fit came a frame later)
    clearTimeout(fitTimer);
    if (S.L.cats.length && $('view')) refit(); else fitTimer = setTimeout(refit, 30);
    if (motionMode() !== 'off' && !ban.hidden) ban.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}
function onHost(m) {
  if (m.t === 'state') {
    feed.fake = !!m.fake; feed.dataDir = m.dataDir || ''; feed.version = m.version || ''; feed.nonClient = m.nonClient !== false; feed.pc = typeof m.pc === 'string' ? m.pc : '';
    feed.brand = typeof m.brand === 'string' && m.brand ? m.brand : 'HW Deck'; feed.updatable = m.updatable !== false; document.title = feed.brand;
    // a build with extras: its cell kinds come with extras.js, the view is drawn again once they are in
    // (a build's extras.js comes after the first drawing: its cells' bodies, a bar or a switch, change their tiles'
    // heights, so those are measured again and a size that fit without them is not the one to start from)
    feed.ext = !!m.ext;
    if (m.ext && !EXT.loaded) { EXT.loaded = true; const sc = document.createElement('script'); sc.src = 'extras.js'; sc.onload = () => { EXT.ready = true; packMemo.clear(); if (!app.classList.contains('boot')) renderView(false); renderStorage(); renderInsp(); bootCheck(); }; document.head.appendChild(sc); }
    S.slots = (m.slots || []).slice(0, 5).map(cleanSlot);
    stateGen = Number.isFinite(m.gen) ? m.gen : 0;
    heldSlots = new Set(Array.isArray(m.held) ? m.held : []);
    while (S.slots.length < 5) S.slots.push(null);
    const st = m.state;
    // (a slot another program held at the start comes in later: the view is linked to it again then, see 'slots'; a
    // missing or damaged one never comes, so only a held one waits)
    slotWanted = st && Number.isInteger(st.active) && st.active >= 0 && st.active < 5 && !S.slots[st.active] && Array.isArray(m.held) && m.held.includes(st.active) ? st.active : null;
    if (st && st.L && Array.isArray(st.L.cats)) { S.L = cleanLayout(st.L); S.active = Number.isInteger(st.active) && st.active >= 0 && st.active < 5 && S.slots[st.active] ? st.active : null; S.edit = st.edit !== false; S.screen = ['tiles', 'overview', 'grid'].includes(st.screen) ? st.screen : 'tiles'; S.motion = st.motion === false ? 'off' : st.motion === 'reduced' ? 'full' : MOTIONS.includes(st.motion) ? st.motion : undefined; S.look = cleanLook(lookUp(st.look)); applyLook(); }
    else { S.L = emptyLayout(); S.active = null; S.edit = true; S.screen = 'tiles'; }   // first run: nothing, edit mode on
    S.gameCalm = !st || st.gameCalm !== false;
    S.lookSaved = cleanSaved(st && st.lookSaved); lkFromCheck();   // (your own looks, the Look page's Saved, 11-09)
    { const f = st && st.listFilt && typeof st.listFilt === 'object' ? st.listFilt : {}; S.listFilt = { g: f.g === true, w: f.w === true }; }
    // (a view that came in late, state.json held at the start: the readings are known already, so its cells are linked
    // by sensor name here, as a Load does, 11-06)
    if (READ.length) { const n = relinkByName(); if (ynFixAll()) saveState(); if (n) toast('Re-linked ' + plural(n, 'cell') + ' by sensor name'); }
    applyMotion();
    if (st && Array.isArray(st.pins)) { DR.L.pinned = st.pins[0] === true; DR.R.pinned = st.pins[1] === true; }
    // (placed only when its swap button put it there, a flag of its own: 11-02, the first version saved its side every
    // time, which read as placed and kept it on the right over what he selected)
    if (st && Array.isArray(st.sides)) { DR.L.side = st.sides[0] === 'r' ? 'r' : 'l'; DR.R.placed = st.rPlaced === true; DR.R.side = st.sides[1] === 'l' ? 'l' : 'r'; if (DR.R.placed && DR.L.side === DR.R.side) DR.R.side = DR.L.side === 'l' ? 'r' : 'l'; }
    S.title = st && typeof st.title === 'string' && st.title.trim() ? st.title.slice(0, 60) : undefined; S.clock = !st || st.clock !== false;
    S.hide = cleanHide(st && st.hide); hideSets();
    feed.noStarter = !!m.noStarter; S.starterSeen = !!(st && st.starter === true); S.starterNoted = !!(st && st.starterNoted === true); feed.stateIn = !m.stateHeld;
    // (a new user: the view came with nothing in it. A view set aside as unreadable, or one emptied later, is not)
    feed.starterFresh = !m.stateBad && !(st && st.L && Array.isArray(st.L.cats) && st.L.cats.length);
    renderTitle(); $('rstBtn').disabled = feed.fake; if (feed.fake) $('rstBtn').title = 'Demo data: there is no HWiNFO to restart';
    undoStack = []; redoStack = []; keyStep.t = 0; sel = null; selCat = null; preview = null; if (dragPt) dragPt.before = null;   // (a point held takes no step from the view it was in)
    app.classList.toggle('editing', S.edit); $('editBtn').classList.toggle('on', S.edit); $('editBtn').setAttribute('aria-pressed', S.edit);
    for (const b of document.querySelectorAll('#screens button[data-s]')) b.classList.toggle('active', b.dataset.s === S.screen);
    placeTabInd(true);
    lastSub = ''; subscribe(); enterNext = true; if (!app.classList.contains('boot')) renderView(false); renderStorage(); renderInsp(); syncUndo(); syncSaves();   // (at a start, bootCheck builds the view once, 11-06)
    starterCheck();
  } else if (m.t === 'updDone') {   // (Settings' check now: how it went)
    feed.updBusy = false; clearTimeout(feed.updT);
    toast(m.ok ? (m.latest && verNewer(m.latest, feed.version) ? 'HW Deck ' + m.latest + ' is out' : 'HW Deck is up to date') : m.why === 'test' ? 'Test copy: no update check' : m.why === 'off' ? 'Update checks are off' : m.why === 'answer' ? 'GitHub gave no version: try again in a while' : 'Couldn\'t reach GitHub', false);
    if (setmodal.classList.contains('open')) renderSettings();
  } else if (m.t === 'settings') {
    feed.autostart = !!m.autostart; feed.hwinfo = m.hwinfo || null; feed.keepBusy = !!m.keepBusy; if (m.keepDone) feed.keepWait = false; if (!feed.keepBusy && !feed.keepWait) feed.keep = !!m.keep; feed.keepNote = typeof m.keepNote === 'string' ? m.keepNote : '';
    feed.fpsBusy = !!m.fpsBusy; if (m.fpsDone) feed.fpsWait = false; if (!feed.fpsBusy && !feed.fpsWait) feed.fps = !!m.fps; feed.fpsState = typeof m.fpsState === 'string' ? m.fpsState : 'off'; feed.updates = m.updates !== false; feed.latest = m.latest || null; feed.canUpdate = !!m.canUpdate; syncUpd();
    feed.estNote = Math.max(0, +m.estNote || 0); feed.notesSeen = typeof m.notesSeen === 'string' ? m.notesSeen : null; estCheck();
    const wd0 = feed.warnDays;
    feed.gameDays = Number.isFinite(m.gameDays) ? m.gameDays : null; feed.warnDays = Number.isFinite(m.warnDays) ? m.warnDays : null;   // (0: kept forever; null: not set since a damaged settings file. Neither cuts anything)
    feed.gameMerge = Number.isFinite(m.gameMerge) ? m.gameMerge : 30;
    if ($('wmodal').classList.contains('open') && feed.warnDays !== wd0) send({ t: 'alerts' });   // (its days changed: what it keeps)
    // (only when something it shows changed: the host's echo of a switch just clicked cut its slide, 11-06)
    if (setmodal.classList.contains('open') && setSigOf() !== feed.setSig) renderSettings();
  } else if (m.t === 'catalog') {
    const sameKeys = READ.length === m.readings.length && m.readings.every((x, i) => READ[i].key === x[2]);
    setCatalog(m);
    if (ynFixAll()) saveState();   // (old Yes/No lines that could never warn, now that the readings are known)
    feed.bnIn = Array.isArray(m.bneck) ? m.bneck : [null, null, 0];
    feed.c12keys = Array.isArray(m.c12) && m.c12.length === 2 ? m.c12 : null;
    feed.zero = new Set(Array.isArray(m.zero) ? m.zero : []);   // (HWiNFO readings only ever at 0: hidden from Storage by default)
    lastSub = ''; subscribe();
    // the same readings with new names (a rename in HWiNFO): no rebuild under someone typing in a field
    const typing = dselOpen || (document.activeElement && document.activeElement.closest && document.activeElement.closest('#insp input, #insp select, #insp textarea, .cn-in'));   // (and a list open: its menu, 11-06)
    if (sameKeys && typing) { for (const [cid, r] of E) { const c = S.L.cells[cid], n = r.root.querySelector('.tn > span, .nm > span, .gname > span'); if (c && n) { setText(n, nameIn(cid)); if (n.title) n.title = nameIn(cid); } } renderStorage(); }
    else if (typing) { if (!app.classList.contains('boot')) { flipNext = flipNext || 'live'; renderView(false); } renderStorage(); if (document.activeElement.closest('#insp') || dselOpen) inspCatLater = true; else renderInsp(); }   // (the rename box in the view: the settings now, nothing of theirs is being typed, review 11-08)   // (new readings: the settings wait for the field or list to be left, 11-08 audit)
    else { if (!app.classList.contains('boot')) { flipNext = flipNext || 'live'; renderView(false); } renderStorage(); renderInsp(); }   // (a reading gone or back: its neighbours glide, 11-08)   // (at a start, bootCheck builds the view once, 11-06)
    if (GZ.on) { if (document.activeElement && document.activeElement.matches('#gcz .gz-name')) { gzCompute(); gzChips(); gzDraw(); } else renderGz(); }   // (a name being typed stays: only the readings list is new)
    showFeed();
    starterCheck();   // (a new user's readings came: Starter now)
    boot.cat = true; bootCheck();
  } else if (m.t === 'lastval') {
    const goneNow = () => Object.values(S.L.cells).filter(c => isMissing(c)).map(c => c.key + (isPause(c) ? '' : ':' + missingTxt(c))).join('\n'), g0 = goneNow();   // (what each says too: never shared, or not for 7 days, the suite 11-08)
    LASTV.clear(); for (const k in (m.at || {})) LASTV.set(k, +m.at[k] || 0); lastvSince = +m.since || 0;
    if (goneNow() !== g0 && !app.classList.contains('boot')) { if (S.edit) { flipNext = flipNext || 'live'; redrawView(); } if (sel && S.L.cells[sel] && isMissing(S.L.cells[sel])) renderInsp(); }   // (Re-link comes or goes: the tiles and its panel again, 11-08)
  } else if (m.t === 'spark') {
    for (const k in m.keys) ringFill(k, m.ts, m.keys[k]);
    if (m.ts - nowTs > 2) { if (lastTick && m.ts - lastTick > 2) resetSeen(); nowTs = m.ts; catchUp = true; }   // (only after a gap, a show from the tray: else the second moves at its tick, with its values)
    if (curveWait && m.keys[curveWait.src]) {
      const c = S.L.cells[curveWait.cid], s2 = series(curveWait.src, 30).filter(x => isFinite(x)), src = BYKEY.get(curveWait.src);
      if (c && c.curve && c.curve.src === curveWait.src && s2.length) { c.curve.pts = startCurve(BYKEY.get(c.key), { v: s2[s2.length - 1], unit: src ? src.unit : '' }); saveState(); if (sel === curveWait.cid) renderInsp(); }
      curveWait = null;
    }
    updateView(true, true);   // (the second is judged at its tick, as the host does)
    catchUp = false;
  } else if (m.t === 'tick') {
    const was = feed.status, first = !feed.got;
    sightPre = readSight();   // (before this second writes anything: its layout read once, 2.1)
    const vlPre = S.edit && drawerOpen('L') ? { top: $('vlist').scrollTop, h: $('vlist').clientHeight } : null;   // (Storage's too, 11-06)
    const calmWas = motionMode();
    if (feed.game && !m.game) feed.lgWait = performance.now();   // (a game ended: its summary is a moment away)
    feed.status = m.status; feed.age = m.age; feed.got = true; feed.game = m.game; feed.front = m.front; feed.gameSince = m.gameSince; feed.pm = !!m.pm;
    feed.rec = Array.isArray(m.rec) ? m.rec.filter(x => Array.isArray(x) && x.length >= 2) : [];   // your own sessions running: [start, name]
    if (motionMode() !== calmWas) { applyMotion(); calmSettle(); if (setmodal.classList.contains('open')) renderSettings(); }   // a game came to the front or left it (2.1: in place, no rebuild)
    feed.c12 = Array.isArray(m.c12) ? m.c12 : null;
    feed.gameGap = Number.isFinite(m.gameGap) ? m.gameGap : 0;   // (the session's breaks: not play)
    feed.gs = m.gs && typeof m.gs === 'object' ? m.gs : null;   // this game session's min, average, max of the game's own readings
    feed.sf = Array.isArray(m.sf) ? m.sf : null;   // this game session's average fps and 1% low so far
    feed.bnl = m.bnl;   // the bottleneck's call this second, game or not
    feed.bnb = +m.bnb || 0;   // (a game in front whose frames aren't counted: 1 only vsync caps show, 2 none)
    if (lastTick && m.ts - lastTick > 2) resetSeen();   // seconds we didn't see (hidden): holds and episodes start again
    // as the log: HWiNFO not sharing for 10 s ends every hold and episode (its Mark); a shorter stall's seconds don't
    // count as calm ones (the log counts calm seconds, the page their times: moved on by the stall)
    if (m.status !== 'ok') { if (!notOkAt) notOkAt = m.ts; if (!notOkMarked && m.ts - notOkAt >= 10) { notOkMarked = true; for (const k in holdSince) delete holdSince[k]; for (const k in cellEp) delete cellEp[k]; c12Since = 0; c12Ep.on = false; c12Ep.calm = 0; } }
    else if (notOkAt) { const gap = m.ts - notOkAt; for (const k in cellEp) if (cellEp[k].calmTs) cellEp[k].calmTs += gap; if (c12Ep.calm) c12Ep.calm += gap; notOkAt = 0; notOkMarked = false; }
    if (lastTick && m.ts < lastTick - 1) {   // the clock set back (a time sync): a hold or a calm spell keeps the time it has run
      const d = m.ts - lastTick;
      for (const k in holdSince) holdSince[k] += d;
      for (const k in cellEp) if (cellEp[k].calmTs) cellEp[k].calmTs += d;
      if (c12Since) c12Since += d; if (c12Ep.calm) c12Ep.calm += d; if (notOkAt) notOkAt += d; if (feed.liveAt) feed.liveAt += d;
    }
    const sameSec = m.ts === lastTick;   // (a forced tick repeats the second: drawn, not judged again, as on the host)
    nowTs = lastTick = m.ts;
    if (!sameSec) stepPins();
    if (S.clock) setText($('clock'), hhmmss(m.ts));
    for (let j = 0; j < m.i.length; j++) { const r = READ[m.i[j]]; if (!r) continue; r.v = m.v[j]; r.at = m.ts; if (m.mn[j] != null) { r.mn = m.mn[j]; r.mx = m.mx[j]; r.av = m.av[j]; } }
    const live = m.status === 'ok';
    for (const k of cellKeys()) { const r = BYKEY.get(k); ringPut(k, m.ts, live && r ? r.v : null); }
    showFeed(); showGame();
    if ((first || was !== m.status) && (!READ.length || !S.L.cats.length)) renderView(false);
    if (!drag || !drag.started) { updateView(false, sameSec); tickInsp(); if (!dragPt && drawerOpen('L')) drawRows(vlPre); }
    if (!sameSec) judgeRest(!drag || !drag.started);   // (the cells not drawn, or all of them under a drag: judged each second as the host does)
    if (GZ.on && gmodal.classList.contains('open')) gzDraw();
    if (!boot.tick) { boot.tick = true; if (m.status !== 'ok') boot.cat = boot.x = true; bootCheck(m.status !== 'ok' && !READ.length); }   // (no HWiNFO: nothing more to wait for)
    if (modalCid) { refreshModal(); if (bigRange !== '15m' && !modalOwn && Date.now() - histAsked > 60000) askHist(); }
    if (HP.shown) { if ((HP.ext ? prevBlocked(HP.el) : anyModalOpen()) || !cellAt(HP.cid)) hidePrev(); else { fillPrev(); if (!HP.rev0) drawPrev(); } }
  } else if (m.t === 'hist' && !wxTake(m)) {   // (a warning row's chart asked for it: only it, unless the cell popup asked for the same)
    { const c0 = modalCid != null && cellAt(modalCid); if (!c0 || m.range !== bigRange || m.key !== histKey(c0)) return; }   // (for a range or cell no longer shown: dropped, 11-06)
    const again = bigHist && bigHist.key === m.key && bigHist.range === m.range;   // (the same graph a minute on: no new draw-in, one under way goes on)
    bigHist = m;
    if (modalCid && histReady()) { if (!again && !modalOwn) { bigRevMs = 450; bigRev0 = motionOn() ? performance.now() : 0; } refreshModal(); if (bigRev0 && !again) bigLoop(); }
  } else if (m.t === 'alerts') { if (wmodal.classList.contains('open')) { wSeenNow(); renderWarnings(m.log); } else if (wPeek) wPeekRead(m.log); }   // (one that comes in after a close isn't drawn)
  else if (m.t === 'gamesBin') gbRender(m.log);
  else if (m.t === 'alertsBin') wbRender(m.log);
  else if (m.t === 'lastGame') { feed.lg = m.s || null; if (feed.lgWait) { feed.lgWait = 0; if (feed.got) updateView(true, true); } }   // (the last game session, for the Game cells while no game runs; one that just ended is drawn at once)
  else if (m.t === 'games') { if (gmodal.classList.contains('open')) renderGames(m.log, $('glist').querySelector('.gx-sess') ? gxOpen() : undefined); }   // (an edit: what was open stays open; one after a close isn't kept)
  else if (m.t === 'toast') {
    // (a move that moved nothing, or failed: its undo step goes, if nothing came after it)
    if (m.moved === 0 && pkStep && undoStack[undoStack.length - 1] === pkStep) { undoStack.pop(); syncUndo(); }
    if (m.moved !== undefined) pkStep = null;
    if (Array.isArray(m.gone) && m.gone.length) pkForget(m.gone);   // (rows deleted permanently)
    toast(m.text, !!m.undo, m.ms);
  }   // (undo: a step on the undo stack, a Restore's)
  else if (m.t === 'saveView') saveState();
  else if (m.t === 'gameNow') gxLive(m.s);
  else if (m.t === 'winMax') feed.winMax = !!m.max;   // (the view's file was set aside: the one shown is written)
  else if (m.t === 'zero') { feed.zero = new Set(Array.isArray(m.keys) ? m.keys : []); renderStorage(); if (GZ.on) { gzCompute(); gzChips(); gzDraw(); } }
  // the window just came up (from the tray, a cold start, or minimized): what was measured while it was hidden came
  // out short (a Smart Life tile without its bar), so every tile is measured again on screen
  else if (m.t === 'shown') { if (drawnHidden) { drawnHidden = false; requestAnimationFrame(() => remeasureSoon(0, false)); } }
  else if (m.t === 'restarted') restartDone();
  else if (typeof m.t === 'string' && m.t.startsWith('x.')) {
    if (EXT.msg) EXT.msg(m);
    // the first of each of a build's own messages fills its cells' bodies (a bar, a switch): their tiles are measured
    // again, or a cold start keeps the heights they had empty
    // (a build names the message that fills its bodies, EXT.bootMsg, and the ones that fill none, EXT.quiet: the view
    // comes in on the first, measured once, 11-06)
    if (!xSeen.has(m.t) && !(EXT.quiet && EXT.quiet.includes(m.t))) { xSeen.add(m.t); remeasureSoon(null, true); }
    if (!boot.x && (!EXT.bootMsg || m.t === EXT.bootMsg)) { boot.x = true; bootCheck(); }
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
      const w = slotWanted, relink = js => { const o = JSON.parse(js); if (o.active != null || o.host) return js; o.active = w; return JSON.stringify(o); };
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
    toast('Imported into ' + slotName(i) + ': load it to use it');
  }
}
if (host) { app.classList.add('boot'); bootArm(); host.addEventListener('message', e => onHost(e.data)); send({ t: 'ready' }); }
else { feed.got = true; renderView(true); renderInsp(); syncUndo(); showFeed(); }   // opened outside the app: the empty first-run view
document.fonts && document.fonts.ready.then(() => placeTabInd(true));
