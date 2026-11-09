// Edit mode under stress (11-08, his "so many bugs editing ... HARDCORE test the edit mode"): layouts like his (his
// laptop: Drives at 50% in the left column; Core over Iris Xe beside Memory on the right), the Starter, a category of
// mixed sizes and a row of three columns with a line, each at many window widths; every width chip clicked on several
// tiles; then a long run of random edits (seeded: the same seed, the same run) with undo and redo after each. After every
// step the rules a user sees are checked:
//   - no tile outside its category, none over another, none narrower than the minimum (TILE_MIN, short 15rem)
//   - a size you set is drawn as set when it fits, never narrower
//   - the members of a line side by side with the same share and only Auto tiles get the same tiles per row
//   - no category wider than its column
//   - the panel: one width chip lit, the field and the lit chip saying what is drawn
//   - a width chip you click either gives that width or was greyed out (then nothing changes)
//   - undo puts back exactly what was there (the layout and every tile's place), redo exactly what was done
// Start a fresh copy first (an EMPTY data folder):
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9241
//   HWDeck.exe --fake 300 --data test\data-es
// then: node test/e2e-edit-stress.mjs [port] [seed] [steps]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9241);
const SEED = Number(process.argv[3] || 1108), STEPS = Number(process.argv[4] || 260), ONLY = process.argv[5] || '';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const J = x => E('JSON.stringify(' + x + ')').then(s => s === undefined ? undefined : JSON.parse(s));
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
let rnd = SEED >>> 0;
const rng = () => { rnd = (rnd + 0x6D2B79F5) >>> 0; let t = rnd; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rng() * a.length)];
let W = 1600;
const size = async w => { W = w; await p.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false }); await p.sleep(450); };
const settle = (ms = 420) => p.sleep(ms);

// ---- the rules, in the page: a list of what is wrong now ----
await until('READ.length > 200 && feed.got');
await size(1600);
await E(`window.__inv = () => {
  const out = [], fs = parseFloat(document.documentElement.style.fontSize) || 13, view = document.getElementById('view');
  if (!view.querySelector('.lrow, .dcat')) return out;
  const g = 0.62 * fs * spOf(view), nm = el => { const c = el && el.dataset.cid && S.L.cells[el.dataset.cid]; return c ? nameIn(el.dataset.cid) : el && el.dataset.cat ? (S.L.cats.find(x => x.id === el.dataset.cat) || {}).name : '?'; };
  const line = {};
  for (const cat of view.querySelectorAll('.dcat')) {
    if (cat.classList.contains('collapsed')) continue;
    const tg = cat.querySelector('.tg'); if (!tg) continue;
    const tr = tg.getBoundingClientRect(); if (!tr.width) continue;
    const short = tg.classList.contains('shorts') && !tg.classList.contains('narrow'), min = (short ? 15 : TILE_MIN) * fs;
    const tiles = [...tg.children].filter(t => t.classList.contains('tile')), rs = tiles.map(t => t.getBoundingClientRect());
    tiles.forEach((t, i) => {
      const r = rs[i];
      if (r.left < tr.left - 1.5 || r.right > tr.right + 1.5) out.push('outside: ' + nm(t) + ' sticks out of ' + nm(cat) + ' (' + Math.round(r.left - tr.left) + '..' + Math.round(r.right - tr.left) + ' of ' + Math.round(tr.width) + ')');
      if (r.width < Math.min(min, tr.width) - 1.5) out.push('narrow: ' + nm(t) + ' ' + Math.round(r.width) + ' px, under the minimum ' + Math.round(min));
      for (let j = 0; j < i; j++) { const q = rs[j]; if (Math.min(r.right, q.right) - Math.max(r.left, q.left) > 1.5 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 1.5) out.push('overlap: ' + nm(t) + ' over ' + nm(tiles[j])); }
      const f = +t.dataset.f;
      if (f && t.dataset.fx === '1' && !tg.classList.contains('shorts')) {
        const fits = f * (tr.width + g) - g >= min - 0.5, drawn = (r.width + g) / (tr.width + g);
        // (his pick 11-08, "50/50, no gap": a tile in its rows too narrow at its own share splits them evenly, so a share
        // beside one is drawn evenly too)
        const lowNear = tiles.some((u, j) => { if (j === i) return false; const fu = +u.dataset.f, q = rs[j]; return fu > 0 && u.dataset.fx === '1' && fu * (tr.width + g) - g < min - 0.5 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 1.5; });
        const even = Math.abs(drawn - 1 / Math.max(1, Math.round(1 / drawn))) < 0.012, lowAny = tiles.some((u, j) => j !== i && +u.dataset.f > 0 && u.dataset.fx === '1' && +u.dataset.f * (tr.width + g) - g < min - 0.5);   // (the even split may be one to a row, 100%)
        if (fits && !lowNear && !(lowAny && even) && Math.abs(drawn - f) > 0.012) out.push('share: ' + nm(t) + ' set ' + Math.round(f * 100) + '%, drawn ' + Math.round(drawn * 100) + '% though it fits');
        if (!fits && drawn < f - 0.012) out.push('share: ' + nm(t) + ' set ' + Math.round(f * 100) + '%, drawn narrower ' + Math.round(drawn * 100) + '%');
      }
    });
    const col = cat.closest('.lcol'); if (col) { const cr = col.getBoundingClientRect(), kr = cat.getBoundingClientRect(); if (kr.left < cr.left - 1.5 || kr.right > cr.right + 1.5) out.push('column: ' + nm(cat) + ' wider than its column'); }
    const ln = cat.parentElement && cat.parentElement.classList.contains('lsub') && !cat.parentElement.classList.contains('fold') ? cat.parentElement : null;
    if (ln && tiles.length && tiles.every(t => !t.dataset.f && !t.dataset.w && !t.dataset.h)) { (line[ln.dataset.k || 'x'] = line[ln.dataset.k || 'x'] || { el: ln, m: [] }).m.push({ cat, n: tiles.length, k: +tg.style.getPropertyValue('--k') || 1, share: S.L.cats.find(x => x.id === cat.dataset.cat) }); }
  }
  for (const ln of view.querySelectorAll('.lsub:not(.fold)')) {
    const ms = [...ln.children].filter(c => c.classList.contains('dcat') && !c.classList.contains('collapsed'));
    const sig = ms.map(c => { const tg = c.querySelector('.tg'), ts = tg ? [...tg.children].filter(t => t.classList.contains('tile')) : []; if (!ts.length || tg.classList.contains('shorts') || tg.classList.contains('per')) return null; const sh = S.L.cats.find(x => x.id === c.dataset.cat); return { c, s: ts.map(t => (t.dataset.f || 'a') + (t.dataset.fx || '') + '/' + (t.dataset.w || 1) + '/' + (t.dataset.h || 1) + (t.dataset.nl || '')).join(' ') + '|' + lineShare(sh), k: +tg.style.getPropertyValue('--k') || 1, w: ts.map(t => Math.round(t.getBoundingClientRect().width)), W: c.getBoundingClientRect().width }; });
    for (let i = 0; i < sig.length; i++) for (let j = 0; j < i; j++) { const a = sig[i], b = sig[j]; if (a && b && a.s === b.s && Math.abs(a.W - b.W) < 6 && (a.k !== b.k || a.w.some((x, q) => Math.abs(x - b.w[q]) > 3))) out.push('line: ' + nm(a.c) + ' and ' + nm(b.c) + ' side by side, set up the same, drawn differently (' + a.k + ' vs ' + b.k + ' a row, tiles ' + a.w.join('/') + ' vs ' + b.w.join('/') + ')'); }
  }
  if (S.edit && sel) {
    const t = document.querySelector('#view .tile[data-cid="' + sel + '"]'), fld = document.querySelector('#insp input[data-sz="f"]'), chips = [...document.querySelectorAll('#insp [data-lay="cf"] button')];
    if (t && fld && chips.length) {
      const tg = t.parentElement, tr = tg.getBoundingClientRect(), r = t.getBoundingClientRect(), drawn = Math.min(100, (r.width + g) / (tr.width + g) * 100), lit = chips.filter(b => b.classList.contains('on'));
      const auto = !t.dataset.f && !t.dataset.w, match = chips.find(b => b.dataset.v !== 'auto' && Math.abs(+b.dataset.v - drawn) < 0.8);
      if (lit.length > 1) out.push('panel: ' + lit.length + ' width chips lit for ' + nm(t));
      if (auto && !(lit[0] && lit[0].dataset.v === 'auto')) out.push('panel: ' + nm(t) + ' is Auto, Auto not lit');
      if (!auto && match && lit[0] !== match) out.push('panel: ' + nm(t) + ' drawn at ' + drawn.toFixed(1) + '%, chip ' + match.textContent + ' not lit');
      if (fld !== document.activeElement && fld.value !== '' && Math.abs(+fld.value - drawn) > 0.8) out.push('panel: the width field says ' + fld.value + '%, ' + nm(t) + ' is drawn at ' + drawn.toFixed(1) + '%');
      const l = lit[0]; if (l && l.dataset.v !== 'auto' && Math.abs(+l.dataset.v - drawn) > 0.8) out.push('panel: chip ' + l.textContent + ' lit, ' + nm(t) + ' drawn at ' + drawn.toFixed(1) + '%');
    }
  }
  return out;
}; 1`);
// the layout as saved, and every tile's and category's place: what undo has to bring back
// (taken once the view is still: nothing in it moving for 300 ms. A snapshot taken mid-glide, a resize still settling, was
// not a state an undo could ever go back to, 11-08)
const quiet = async () => { let calm = 0; for (let i = 0; i < 40 && calm < 3; i++) { const n = await E(`document.getAnimations().filter(a => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#view')).length`); calm = n ? 0 : calm + 1; await p.sleep(100); } };
const snap = async () => { await quiet(); return E(`JSON.stringify({ L: JSON.parse(layoutSig(S.L)), places: (() => { const ve = document.getElementById('view'), v = ve.getBoundingClientRect(), sy = ve.scrollTop; return ['~fs:' + (parseFloat(document.documentElement.style.fontSize) || 0).toFixed(3) + ',0,0,0'].concat([...document.querySelectorAll('#view .tile, #view .dcat')].map(e => { const r = e.getBoundingClientRect(); return (e.dataset.cid || e.dataset.cat) + ':' + Math.round(r.left - v.left) + ',' + Math.round(r.top - v.top + sy) + ',' + Math.round(r.width) + ',' + Math.round(r.height); })).sort(); })(), D: { nd: window.__natDbg || {}, an: document.getAnimations().filter(a => a.playState === 'running').map(a => { const t = a.effect && a.effect.target; return t ? (t.dataset && (t.dataset.cid || t.dataset.cat) ? 'id' : String(t.className).split(' ')[0]) + ':' + Math.round(a.currentTime || 0) + '/' + Math.round((a.effect.getComputedTiming().endTime) || 0) : '?'; }).slice(0, 4).join(' '), tu: tileUnit, n: Object.fromEntries([...document.querySelectorAll('#view .tile')].map(t => { const u = unitH.get(t.closest('.tg')); return [t.dataset.cid, [+(t._nat || 0).toFixed(3), u ? +u.fs.toFixed(3) : 0]]; })) } })`); };
const sameSnap = (a, b) => { const x = JSON.parse(a), y = JSON.parse(b); if (JSON.stringify(x.L) !== JSON.stringify(y.L)) return 'layout differs'; const pa = new Map(x.places.map(s => s.split(':'))), d = []; for (const s of y.places) { const [id, v] = s.split(':'), u = pa.get(id); if (!u) { d.push(id + ' new'); continue; } const A = u.split(',').map(Number), B = v.split(',').map(Number); if (id === '~fs' ? u !== v : A.some((n, i) => Math.abs(n - B[i]) > 2)) d.push(id + ' ' + u + ' now ' + v); } d.sort((p, q) => q.startsWith('~fs') - p.startsWith('~fs')); if (d.length && x.D && y.D) { const ids = d.map(e => e.split(' ')[0]).filter(i => i !== '~fs').slice(0, 2); d.push('[running: ' + (x.D.an || '-') + ' now ' + (y.D.an || '-') + '; fit by: unit ' + x.D.tu + ' now ' + y.D.tu + (() => { const nd = Object.keys(y.D.n).filter(i => x.D.n[i] && JSON.stringify(x.D.n[i]) !== JSON.stringify(y.D.n[i])); return '; ' + nd.length + ' tiles read differently' + (nd[0] ? ' {read ' + JSON.stringify(x.D.nd[nd[0]]) + ' now ' + JSON.stringify(y.D.nd[nd[0]]) + '}' : '') + nd.slice(0, 3).map(i => ', ' + i.slice(-4) + ' ' + JSON.stringify(x.D.n[i]) + ' now ' + JSON.stringify(y.D.n[i])).join(''); })() + ']'); } return d.length ? d.slice(0, 3).join('; ') + (d.length > 3 ? ' (+' + (d.length - 3) + ')' : '') + (d[d.length - 1].startsWith('[running') && d.length > 3 ? ' ' + d[d.length - 1] : '') : ''; };   // (the text size first: a fit that differs moves everything a little)
// failures: each kind counted, the first few of each printed with the step that made them
const fails = new Map(), seenMsg = new Set();
let stepName = '';
const note = (kind, msg) => { const n = (fails.get(kind) || 0) + 1; fails.set(kind, n); const key = kind + '|' + msg.replace(/[0-9.]+/g, '#'); if (n <= 6 && !seenMsg.has(key)) { seenMsg.add(key); console.log('  FAIL [' + kind + '] ' + msg + '   (at ' + stepName + ', window ' + W + ')'); } };
const check = async () => { const bad = await J('__inv()'); for (const b of bad) note(b.split(':')[0], b); return bad.length; };

// ---- the layouts ----
const FIX = {
  laptop: `(() => { loadStarter(); const by = n => S.L.cats.find(c => c.name.startsWith(n)); const g = by('Game'), gpu = by('Fake GeForce'), cpu = by('Fake Ryzen'), mem = by('Memory'), dr = by('Drives'), fa = by('Fans');
    const keep = (cat, n) => { for (const id of cat.cells.slice(n)) delete S.L.cells[id]; cat.cells = cat.cells.slice(0, n); };
    cpu.name = 'Core i7-1360P'; gpu.name = 'Iris Xe Graphics'; dr.cells = dr.cells.concat(fa.cells.splice(0, 3)); keep(dr, 4); keep(mem, 2); keep(gpu, 2); keep(cpu, 4); keep(g, 4); keep(fa, 0);
    S.L.cats = S.L.cats.filter(c => c !== fa); S.L.views = S.L.views || {}; S.L.views.tiles = { rows: [{ cols: [{ stack: [g.id, dr.id] }, { stack: [cpu.id, gpu.id, { id: mem.id, b: 1 }] }] }] };
    const v = vset('tiles'), m = v.cell = {}; for (const id of dr.cells) m[id] = { f: 0.5, fx: true }; renderView(false); return 1; })()`,
  laptop2: `(() => { loadStarter(); const by = n => S.L.cats.find(c => c.name.startsWith(n)); const g = by('Game'), gpu = by('Fake GeForce'), cpu = by('Fake Ryzen'), mem = by('Memory'), dr = by('Drives'), fa = by('Fans');
    const keep = (cat, n) => { for (const id of cat.cells.slice(n)) delete S.L.cells[id]; cat.cells = cat.cells.slice(0, n); };
    cpu.name = 'Core i7-1360P'; gpu.name = 'Iris Xe Graphics'; dr.cells = dr.cells.concat(fa.cells.splice(0, 3)); keep(dr, 3); keep(mem, 2); keep(gpu, 2); keep(cpu, 4); keep(g, 4); keep(fa, 0);
    S.L.cats = S.L.cats.filter(c => c !== fa); S.L.views = S.L.views || {}; S.L.views.tiles = { rows: [{ cols: [{ stack: [g.id, dr.id] }, { stack: [cpu.id, gpu.id, { id: mem.id, b: 1 }] }] }] };
    const v = vset('tiles'), m = v.cell = {}; for (const id of dr.cells) m[id] = { f: 0.5, fx: true }; m[mem.cells[1]] = { f: 0.5, fx: true }; m[gpu.cells[1]] = { f: 0.5, fx: true }; renderView(false); return 1; })()`,
  starter: `(() => { loadStarter(); return 1; })()`,
  mixed: `(() => { loadStarter(); const all = S.L.cats.flatMap(c => c.cells), mx = S.L.cats[0]; for (const c of S.L.cats) c.cells = c.cells.filter(x => !all.slice(0, 9).includes(x)); mx.cells = all.slice(0, 9); mx.name = 'Mixed';
    const v = vset('tiles'), m = v.cell = {}; [[0.25], [1 / 3], [0.5, 1.5], [2 / 3], [0.75, 0.75], [1], [], [0.5, 2], [0.25, 0.5]].forEach(([f, h], i) => { if (f) m[mx.cells[i]] = Object.assign({ f: fNum(f), fx: true }, h && h !== 1 ? { h } : {}); }); S.L.cats = S.L.cats.filter(c => c.cells.length || c === mx); renderView(false); return 1; })()`,
  three: `(() => { loadStarter(); const c = S.L.cats; S.L.views = S.L.views || {}; S.L.views.tiles = { rows: [{ cols: [{ stack: [c[0].id] }, { stack: [c[1].id, { id: c[3].id, b: 1 }, { id: c[4].id, b: 1 }] }, { stack: [c[2].id, c[5].id] }] }] }; renderView(false); return 1; })()`,
};
const load = async name => { await E(`(() => { setEdit(false); selCat = null; sel = null; ${'const r = '}${FIX[name]}; undoStack.length = 0; redoStack.length = 0; afterChange(); return 1; })()`); await settle(700); };
const WIDTHS = [720, 820, 960, 1100, 1280, 1440, 1656, 1920, 2560];

// ---- 1. every layout at every width, in and out of edit mode ----
if (!ONLY) for (const name of Object.keys(FIX)) {
  await load(name);
  let before = [...fails.values()].reduce((a, b) => a + b, 0);
  for (const w of WIDTHS) for (const ed of [false, true]) { stepName = 'sweep ' + name + (ed ? ' (edit)' : ''); await size(w); await E(`setEdit(${ed})`); await settle(350); await check(); }
  ok('sweep: ' + name + ' at ' + WIDTHS.length + ' widths, in and out of edit mode', [...fails.values()].reduce((a, b) => a + b, 0) === before);
}

if (!ONLY) for (const name of ['laptop', 'laptop2']) {
  await load(name);
  const before = [...fails.values()].reduce((a, b) => a + b, 0);
  for (let w = 1100; w <= 1720; w += 6) { stepName = 'fine sweep ' + name; await size(w); await settle(220); await check(); }
  ok('fine sweep: ' + name + ' from 1100 to 1720 px every 6 px', [...fails.values()].reduce((a, b) => a + b, 0) === before);
}

// ---- 2. every width chip on his tiles: it gives that width or it is greyed out; undo puts it back ----
const selCell = async cid => { await E(`(() => { if (!S.edit) setEdit(true); return 1; })()`); await settle(250); const c = await p.centerOf(`document.querySelector('#view .tile[data-cid="${cid}"] .tn')`); if (!c) return false;
  const free = await E(`(() => { const e = document.elementFromPoint(${c.x}, ${c.y}); return !!e && !!e.closest('#view .tile[data-cid="${cid}"]'); })()`);
  if (free) { await p.click(c.x, c.y); await settle(350); } else { await E(`selectCell(${JSON.stringify(cid)})`); await settle(350); }   // (under the open panel: as a click on it once the panel moved, his way)
  return await E(`sel === ${JSON.stringify(cid)}`); };
await load('laptop');
const chipTiles = await J(`(() => { const by = n => S.L.cats.find(c => c.name.startsWith(n)); return [by('Drives').cells[1], by('Drives').cells[3], by('Iris').cells[0], by('Memory').cells[1], by('Core').cells[2]]; })()`);
let chipBad = 0, chipN = 0;
for (const w of ONLY ? [] : [960, 1100, 1440, 1656, 1920]) {
  await size(w);
  for (const cid of chipTiles) {
    for (const v of ['auto', '25', '33.3333', '50', '66.6667', '75', '100']) {
      if (!(await selCell(cid))) { note('select', 'could not select ' + cid); continue; }
      stepName = 'chip ' + v + ' on ' + await E(`nameIn(${JSON.stringify(cid)})`);
      const b = await J(`(() => { const b = [...document.querySelectorAll('#insp [data-lay="cf"] button')].find(x => Math.abs((+x.dataset.v || 0) - ${v === 'auto' ? 0 : +v}) < 0.01 || (x.dataset.v === 'auto' && ${v === 'auto'})); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, off: b.disabled || b.getAttribute('aria-disabled') === 'true' }; })()`);
      if (!b) { note('chip', 'no ' + v + ' chip'); continue; }
      const s0 = await snap(), tw0 = await E(`Math.round(document.querySelector('#view .tile[data-cid="${cid}"]').parentElement.getBoundingClientRect().width)`);
      await p.click(b.x, b.y); await settle(); chipN++;
      const got = await J(`(() => { const t = document.querySelector('#view .tile[data-cid="${cid}"]'), tg = t.parentElement, fs = parseFloat(document.documentElement.style.fontSize) || 13, g = 0.62 * fs * spOf(document.getElementById('view')); return { drawn: (t.getBoundingClientRect().width + g) / (tg.getBoundingClientRect().width + g) * 100, tw: Math.round(tg.getBoundingClientRect().width), k: +tg.style.getPropertyValue('--k') || 1 }; })()`);
      if (b.off) { const d = sameSnap(s0, await snap()); if (d) { chipBad++; note('chip', 'greyed chip ' + v + ' still changed the layout: ' + d); } }
      else if (v !== 'auto' && Math.abs(got.drawn - +v) > 1.2) { chipBad++; note('chip', 'chip ' + Math.round(+v) + '% on ' + await E(`nameIn(${JSON.stringify(cid)})`) + ': drawn ' + got.drawn.toFixed(1) + '% (its category ' + tw0 + ' px, now ' + got.tw + ' px)'); }
      await check();
      if (!b.off) { await E('undo()'); await settle(900); const d = sameSnap(s0, await snap()); if (d) { chipBad++; note('undo', 'undo after chip ' + v + ': ' + d); } }
    }
  }
}
ok('width chips: each gives its width or is greyed out, and undo puts it back (' + chipN + ' clicks)', chipBad === 0, chipBad + ' wrong');

// ---- 3. random edits, each followed by undo and redo ----
const CHIPS = { cf: ['auto', 25, 33.3333, 50, 66.6667, 75, 100], ch: [0.5, 0.75, 1, 1.5, 2], aw: ['auto', 25, 33.3333, 50, 100], ah: ['auto', 1, 1.5, 2], width: ['auto', 3, 4, 6, 8, 9] };
const clickChip = async (lay, v) => { const b = await J(`(() => { const b = [...document.querySelectorAll('#insp [data-lay="${lay}"] button')].find(x => x.dataset.v === String(${JSON.stringify(String(v))}) || Math.abs(+x.dataset.v - ${typeof v === 'number' ? v : -99}) < 0.01); if (!b || b.disabled) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); if (!b) return false; await p.click(b.x, b.y); await settle(); return true; };
const ids = async () => J(`({ cells: [...document.querySelectorAll('#view .tile')].map(t => t.dataset.cid), cats: [...document.querySelectorAll('#view .dcat')].map(c => c.dataset.cat) })`);
const selCat2 = async id => { await E(`(() => { if (!S.edit) setEdit(true); return 1; })()`); await settle(200); const c = await p.centerOf(`document.querySelector('#view .dcat[data-cat="${id}"] .cn')`); if (!c) return false; await p.click(c.x, c.y); await settle(350); return await E(`selCat === ${JSON.stringify(id)}`); };
const key = async (k, code, kc, mod = 0) => { await p.key(k, code, kc, mod); await settle(); };
const dragFrom = async (a, b) => { await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y }); await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 }); for (let i = 1; i <= 12; i++) { await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * i / 12, y: a.y + (b.y - a.y) * i / 12, button: 'left', buttons: 1 }); await p.sleep(16); } await p.sleep(150); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 }); await settle(650); };
const OPS = [
  ['cell width chip', async ({ cells }) => { const c = pick(cells); return await selCell(c) && clickChip('cf', pick(CHIPS.cf)); }],
  ['cell height chip', async ({ cells }) => { const c = pick(cells); return await selCell(c) && clickChip('ch', pick(CHIPS.ch)); }],
  ['typed width', async ({ cells }) => { const c = pick(cells); if (!(await selCell(c))) return false; const v = pick([20, 30, 40, 45, 55, 60, 80, 90]); await E(`(() => { const i = document.querySelector('#insp input[data-sz="f"]'); i.focus(); i.value = '${v}'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.blur(); return 1; })()`); await settle(); return true; }],
  ['Ctrl+arrow', async ({ cells }) => { const c = pick(cells); if (!(await selCell(c))) return false; const [k, code, kc] = pick([['ArrowRight', 'ArrowRight', 39], ['ArrowLeft', 'ArrowLeft', 37], ['ArrowDown', 'ArrowDown', 40], ['ArrowUp', 'ArrowUp', 38]]); await key(k, code, kc, pick([2, 2 | 8])); await settle(900); return true; }],
  ['corner drag', async ({ cells }) => { const c = pick(cells); if (!(await selCell(c))) return false; const a = await p.centerOf(`document.querySelector('#view .tile[data-cid="${c}"] .corner')`); if (!a) return false; await dragFrom(a, { x: a.x + pick([-160, -90, -40, 40, 90, 160]), y: a.y + pick([-60, 0, 0, 50, 120]) }); return true; }],
  ['width of all', async ({ cats }) => await selCat2(pick(cats)) && clickChip('aw', pick(CHIPS.aw))],
  ['height of all', async ({ cats }) => await selCat2(pick(cats)) && clickChip('ah', pick(CHIPS.ah))],
  ['column width', async ({ cats }) => await selCat2(pick(cats)) && clickChip('width', pick(CHIPS.width))],
  ['move key', async ({ cats }) => { if (!(await selCat2(pick(cats)))) return false; const [k, code, kc] = pick([['r', 'KeyR', 82], ['b', 'KeyB', 66], ['s', 'KeyS', 83], ['u', 'KeyU', 85]]); await key(k, code, kc); return true; }],
  ['drag category', async ({ cats }) => { await E(`(() => { if (!S.edit) setEdit(true); return 1; })()`); await key('Escape', 'Escape', 27); const a = await p.centerOf(`document.querySelector('#view .dcat[data-cat="${pick(cats)}"] .grip')`), t = await J(`(() => { const r = document.querySelector('#view .dcat[data-cat="${pick(cats)}"]').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })()`); if (!a || !t) return false; const spot = pick([[t.l + 8, (t.t + t.b) / 2], [t.r - 8, (t.t + t.b) / 2], [(t.l + t.r) / 2, t.t + 8], [(t.l + t.r) / 2, t.b - 8], [(t.l + t.r) / 2, (t.t + t.b) / 2]]); await dragFrom(a, { x: spot[0], y: spot[1] }); return true; }],
  ['drag cell', async ({ cells, cats }) => { await E(`(() => { if (!S.edit) setEdit(true); return 1; })()`); await key('Escape', 'Escape', 27); const a = await p.centerOf(`document.querySelector('#view .tile[data-cid="${pick(cells)}"] .tn')`), t = await p.centerOf(`document.querySelector('#view .dcat[data-cat="${pick(cats)}"] .tg')`); if (!a || !t) return false; await dragFrom(a, t); return true; }],
  ['new row', async ({ cells }) => { const c = pick(cells); if (!(await selCell(c))) return false; const b = await p.centerOf(`[...document.querySelectorAll('#insp button')].find(x => x.textContent.trim() === 'New row' && !x.disabled)`); if (!b) return false; await p.click(b.x, b.y); await settle(); return true; }],
];
let undoBad = 0, ran = 0;
const fl = j => JSON.parse(j || '[]').slice(-3).map(e => e.k.slice(0, 5) + ' memo ' + e.memo + (e.memoOk ? ' ok' : '') + ' ' + e.fb + ' lo ' + e.lo + (e.ok ? '' : ' scroll') + (e.still ? '' : ' !still')).join(', ');   // (how the fits went: the stress test's debug, 11-08)
for (const name of (process.env.ES_LAYOUTS || 'laptop,laptop2,starter,mixed,three').split(',')) {
  await load(name); await E('(window.__natDbg = {}, 1)'); await E('setEdit(true)'); await settle();
  for (let i = 0; i < Math.ceil(STEPS / 5); i++) {
    if (rng() < 0.12) { await size(pick(WIDTHS)); }
    const [opName, op] = pick(OPS), have = await ids();
    if (!have.cells.length || !have.cats.length) break;
    const preLog = await E('JSON.stringify(window.__fitLog || [])'); await E('(window.__fitLog = [], 1)');
    const s0 = await snap(), u0 = await E('undoStack.length');
    stepName = name + ' #' + i + ' ' + opName;
    let did = false; try { did = await op(have); } catch (e) { note('op', opName + ' threw: ' + e.message); }
    ran++;
    await check();
    const opLog = await E('JSON.stringify(window.__fitLog)');
    const u1 = await E('undoStack.length');
    if (did && u1 > u0) {
      const s1 = await snap();
      await E('(window.__fitLog = [], 1)'); await E('undo()'); await settle(900);
      let d = sameSnap(s0, await snap()); if (d) { undoBad++; note('undo', opName + ': undo did not put it back: ' + d + ' {fits before ' + fl(preLog) + ' | op ' + fl(opLog) + ' | undo ' + fl(await E('JSON.stringify(window.__fitLog)')) + '}'); }
      await E('(window.__fitLog = [], 1)'); await E('redo()'); await settle(900);
      d = sameSnap(s1, await snap()); if (d) { undoBad++; note('undo', opName + ': redo did not do it again: ' + d + ' {fits op ' + fl(opLog) + ' | redo ' + fl(await E('JSON.stringify(window.__fitLog)')) + '}'); }
      await check();
    }
    if (rng() < 0.15) { await key('Escape', 'Escape', 27); }
  }
}
ok('random edits (' + ran + ' steps, seed ' + SEED + '): undo and redo exact', undoBad === 0, undoBad + ' wrong');
for (const [kind, n] of fails) ok('rule "' + kind + '" never broken', false, n + ' times');
if (!fails.size) ok('every rule held at every step', true);
ok('no page errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
await p.cmd('Emulation.clearDeviceMetricsOverride');
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
p.close(); process.exit(0);
