// Layouts (1.2): arranging categories in rows, columns and stacks, the looks, the handles, the right panel, the keys.
// Start a fresh copy first (an EMPTY data folder):
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9238
//   HWDeck.exe --fake 300 --data test\data-lay
// then: node test/e2e-layout.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9238);
const data = process.argv[3] || 'test/data-lay';
const out = 'test/out'; mkdirSync(out, { recursive: true });
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const J = x => E('JSON.stringify(' + x + ')').then(s => s === undefined ? undefined : JSON.parse(s));
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(250); };
const rect = sel => E(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const grip = id => `#view .dcat[data-cat="${id}"] .grip`;
// a category dragged by its grip, step by step; returns where it was aimed when the button came up
const mouse = (type, x, y, buttons = 0) => p.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
async function dragCat(a, b) {
  const under = await E(`(() => { const e = document.elementFromPoint(${a.x}, ${a.y}); return e ? (e.closest('[id]') || {}).id + ' ' + (e.closest('[class]') || {}).className : 'nothing'; })()`);
  await mouse('mouseMoved', a.x, a.y); await mouse('mousePressed', a.x, a.y, 1);
  for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12, 1); await p.sleep(16); }
  await p.sleep(80);
  const t = await E('JSON.stringify(drag && drag.target)') + ' started ' + await E('!!(drag && drag.started)') + ' under ' + under + ' drawers ' + await E('document.querySelector(".storage").className + "/" + document.querySelector(".insp").className');
  await mouse('mouseReleased', b.x, b.y, 0); await p.sleep(450);
  return t;
}
const cat = id => `#view .dcat[data-cat="${id}"]`;
const rows = vn => J(`(S.L.views && S.L.views.${vn} && S.L.views.${vn}.rows || null)`);
const flat = r => r ? r.map(x => x.cols.map(c => c.stack.map(s => typeof s === 'string' ? s : s.id).join('+')).join(' | ')).join(' / ') : null;

ok('catalog arrives', await until('READ.length > 200 && feed.got'), await E('READ.length'));
// the same room on every screen: a 1600 x 1000 view (the window itself stays as it is)
const VIEWPORT = { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false };
await p.cmd('Emulation.setDeviceMetricsOverride', VIEWPORT); await p.sleep(400); await E('window.dispatchEvent(new Event("resize"))'); await p.sleep(500);

// ---- the layout the checks work on: seven categories like the tailored dashboard's, all Automatic ----
const BUILD = `(() => {
  const temps = READ.filter(r => r.t === 'temp').map(r => r.key), fans = READ.filter(r => r.t === 'fan').map(r => r.key), pw = READ.filter(r => r.t === 'power').map(r => r.key), use = READ.filter(r => r.t === 'usage').map(r => r.key);
  const L = { v: 1, cats: [], cells: {} };
  const add = (id, name, keys) => L.cats.push({ id, name, collapsed: false, cells: keys.map((k, i) => { L.cells[id + i] = { key: k, graph: true }; return id + i; }) });
  add('gpu', 'GPU', [temps[0], temps[1], temps[2], pw[0], use[0], use[1]]);
  add('cpu', 'CPU', [temps[3], temps[4], temps[5], pw[1], use[2], 'hwdeck.0/bneck']);
  add('sys', 'Memory', [temps[6], temps[7], use[3], temps[8], temps[9], temps[10]]);
  add('fans', 'Fans', fans.slice(0, 5));
  add('game', 'Game', [use[4], use[5], temps[11]]);
  add('disp', 'Screens', [temps[12], temps[13], temps[14]]);
  add('home', 'Home', [pw[2], pw[3], pw[4], pw[5]]);
  return L;
})()`;
await E(`(() => { S.L = cleanLayout(${BUILD}); sel = null; selCat = null; undoStack = []; redoStack = []; showScreen('tiles', true); setEdit(true); saveState(); })()`);
await p.sleep(600);

// ---- cleanLayout ----
ok('an old layout (no views) comes back unchanged, with no views', await E(`(() => { const a = cleanLayout(${BUILD}); return !('views' in a) && JSON.stringify(cleanLayout(a)) === JSON.stringify(a); })()`));
ok('views that are not an object, or unknown views, are dropped', await E(`(() => { const L = ${BUILD}; L.views = 5; const a = cleanLayout(L); L.views = { foo: {}, tiles: 'x', grid: [] }; const b = cleanLayout(L); return !a.views && !b.views; })()`));
let cl = await J(`cleanLayout(Object.assign(${BUILD}, { views: { tiles: { rows: [
  { h: 1.3, cols: [{ w: 8, stack: ['gpu', 'nope'] }, { stack: ['cpu', 'gpu'] }] },
  { h: -2, cols: [{ w: 13, stack: ['sys'] }] },
  { cols: [{ stack: [] }] },
  { h: 9, cols: [1, 2, 3, 4, 5, 6, 7].map(i => ({ stack: [['fans', 'game', 'disp', 'home', 'x', 'y', 'z'][i - 1]] })) }
] } } }))`);
ok('unknown and repeated categories go, a row with a partial width set loses its widths, a height means Fill (h 1)', flat(cl.views.tiles.rows).startsWith('gpu | cpu / sys') && cl.views.tiles.rows[0].h === 1 && cl.views.tiles.rows[0].cols.every(c => c.w === undefined), flat(cl.views.tiles.rows));
ok('a height of zero or less fits, any other is Fill, a width out of range is dropped', cl.views.tiles.rows[1].h === undefined && cl.views.tiles.rows[1].cols[0].w === undefined && cl.views.tiles.rows[2].h === 1, JSON.stringify(cl.views.tiles.rows.slice(1, 3)));
ok('heights inside a stack and Overview / Grid row heights are gone (1.2 betas had them)', await E(`(() => { const a = cleanLayout(Object.assign(${BUILD}, { views: { tiles: { rows: [{ cols: [{ stack: [{ id: 'gpu', h: 2 }, 'cpu'] }] }] }, overview: { rows: [{ h: 2, cols: [{ stack: ['gpu'] }] }] } } })); return a.views.tiles.rows[0].cols[0].stack[0] === 'gpu' && a.views.overview.rows[0].h === undefined; })()`));
ok('every category is placed exactly once', JSON.stringify(cl.views.tiles.rows.flatMap(r => r.cols.flatMap(c => c.stack))).split('"').filter(x => /^[a-z]+$/.test(x)).sort().join() === 'cpu,disp,fans,game,gpu,home,sys');
cl = await J(`cleanLayout(Object.assign(${BUILD}, { views: { grid: { rows: [{ cols: [{ stack: ['gpu'] }, { stack: ['cpu'] }, { stack: ['sys'] }, { stack: ['fans'] }] }, { cols: [{ stack: ['game'] }] }] } } }))`);
ok('Grid: at most 3 tables and one row, the rest goes into the last table', cl.views.grid.rows.length === 1 && cl.views.grid.rows[0].cols.length === 3 && flat(cl.views.grid.rows) === 'gpu | cpu | sys+fans+game+disp+home', flat(cl.views.grid.rows));
cl = await J(`cleanLayout(Object.assign(${BUILD}, { views: {
  tiles: { gap: 'huge', cat: { gpu: { per: 0, size: 'short', title: 'hide', lead: 'cpu0', style: 'band' }, cpu: { per: 3, lead: 'cpu2' } }, cell: { gpu0: { size: 'huge', name: '  ' }, gpu1: { size: 'wide', name: 'Hot' }, gone: { name: 'x' } } },
  overview: { gap: 'tight', cat: { fans: { style: 'band', size: 'short', per: 4 } } } } }))`);
ok('looks: per out of range, a lead from another category, a style in Tiles and a bad gap are dropped; tiles per row read as shares (2.2)', !cl.views.tiles.gap && JSON.stringify(cl.views.tiles.cat) === '{"gpu":{"size":"short","title":"hide"},"cpu":{"lead":"cpu2"}}', JSON.stringify(cl.views.tiles.cat));
const cc = cl.views.tiles.cell, cpuIds = Object.keys(cc).filter(k => k !== 'gpu1');
ok('cell looks: a bad size, a blank name and a missing cell are dropped; 3 per row = each 33.33% of its row', JSON.stringify(cc.gpu1) === '{"size":"wide","name":"Hot"}' && cpuIds.length > 0 && cpuIds.every(k => /^cpu/.test(k) && JSON.stringify(cc[k]) === '{"f":0.3333}'), JSON.stringify(cc));
ok('Overview keeps only its own looks', JSON.stringify(cl.views.overview) === '{"gap":"tight","cat":{"fans":{"style":"band"}}}', JSON.stringify(cl.views.overview));
cl = await J(`(() => { const L = ${BUILD}; L.cats[0].id = 'bad id!'; L.views = { tiles: { rows: [{ cols: [{ stack: ['cpu'] }, { stack: ['bad id!'] }] }], cat: { 'bad id!': { per: 2 } } } }; return cleanLayout(L); })()`);
ok('a category with an unsafe id gets a new one and the views follow it (its 2 per row: each tile 50%)', /^c/.test(cl.cats[0].id) && cl.views.tiles.rows[0].cols[1].stack[0] === cl.cats[0].id && cl.cats[0].cells.every(x => cl.views.tiles.cell[x] && cl.views.tiles.cell[x].f === 0.5), cl.cats[0].id);

// ---- Automatic stays exactly as before ----
ok('Automatic Tiles: balanced columns, nothing of its own kept, no handles', !(await rows('tiles')) && await E('!!document.querySelector("#view.arr.auto") && document.querySelectorAll("#view .lcol > .blk").length === 7 && !document.querySelector("#view .ldiv, #view .lrs")'));

// ---- making the view your own by dropping on an edge ----
let a = await p.center(grip('game')), b = await rect(cat('disp'));
await p.drag(a, { x: b.x, y: b.b - 6 }); await p.sleep(450);
let r = await rows('tiles');
ok('dropping on the bottom edge of an Automatic category makes Tiles your own and stacks it', r && flat(r).includes('disp+game'), flat(r));
ok('the toast says Tiles uses your own arrangement now', (await E('$("toastTxt").textContent')).includes('your own arrangement'), await E('$("toastTxt").textContent'));
ok('the view is drawn in rows now', await E('document.querySelectorAll("#view.arr .lrow").length') === r.length);
await E('undo()'); await p.sleep(300);
ok('Undo: Automatic again', !(await rows('tiles')) && await E('!!document.querySelector("#view.arr.auto")'));

// a swap in Automatic: the two trade the places drawn; Automatic is kept when it draws them traded, else the view
// becomes your own (11-08 audit: only the list order changed, so often nothing moved)
const order0 = await J('S.L.cats.map(c => c.id)'), placesOf = () => J(`['home', 'gpu'].map(id => { const q = posIn(rowsNow('tiles'), id); return q && [q.ri, q.ci, q.k]; })`), pl0 = await placesOf();
a = await p.center(grip('home')); b = await rect(cat('gpu'));
await p.drag(a, { x: b.x, y: b.y }); await p.sleep(450);
const pl1 = await placesOf();
ok('dropping on the middle of another category in Automatic: the two trade places', JSON.stringify(pl1) === JSON.stringify([pl0[1], pl0[0]]), JSON.stringify([pl0, pl1, (await rows('tiles')) ? 'your own' : 'automatic']));
await E('undo()'); await p.sleep(300);
ok('Undo restores the order and Automatic', JSON.stringify(await J('S.L.cats.map(c => c.id)')) === JSON.stringify(order0) && !(await rows('tiles')));

// ---- the owner's Tiles arrangement, then editing it ----
await E(`(() => { mutate(() => { S.L.views = { tiles: { gap: 'tight', rows: [
  { h: 2, cols: [{ stack: ['gpu'] }, { stack: ['cpu'] }] }, { h: 2, cols: [{ stack: ['sys'] }, { stack: ['disp', 'game'] }] }, { h: 1, cols: [{ stack: ['fans'] }] }, { cols: [{ stack: ['home'] }] }],
  cat: { gpu: { per: 3 }, cpu: { per: 3 }, sys: { per: 3 }, disp: { per: 3 }, game: { per: 3 }, fans: { per: 5 }, home: { per: 4, size: 'short' } }, cell: { fans0: { name: 'Fan sides' }, gpu3: { size: 'wide' } } } }; }); })()`);
await p.sleep(500);
ok('rows, columns and the stack are drawn', await E('document.querySelectorAll("#view .lrow").length === 4 && document.querySelectorAll("#view .lrow")[1].querySelectorAll(".lcol")[1].querySelectorAll(".blk").length === 2'));
ok('the rows are Fill Fill Fill Fit', (await E('[...document.querySelectorAll("#view > .lrow")].map(r => r.dataset.fill ? "fill" : "fit").join(" ")')) === 'fill fill fill fit', await E('[...document.querySelectorAll("#view > .lrow")].map(r => r.dataset.fill ? "fill" : "fit").join(" ")'));
const cols = await E(`(() => { const ts = [...document.querySelectorAll('${cat('fans')} .tile')].map(t => t.getBoundingClientRect().top); return ts.filter(t => Math.abs(t - ts[0]) < 1).length; })()`);
ok('Fans: 5 tiles per row', cols === 5, cols);
ok('Home: short tiles without graphs', await E(`(() => { const t = [...document.querySelectorAll('${cat('home')} .tile')]; return t.length === 4 && t.every(x => x.classList.contains('short') && !x.querySelector('canvas')); })()`));
ok('a name in this view only', await E(`document.querySelector('#view .dc[data-cid="fans0"] .tn span').textContent === 'Fan sides'`));
const wide = await E(`(() => { const t = document.querySelector('#view .dc[data-cid="gpu3"]').getBoundingClientRect(), o = document.querySelector('#view .dc[data-cid="gpu4"]').getBoundingClientRect(); return t.width / o.width; })()`);
ok('a wide tile is two tiles wide', wide > 1.9 && wide < 2.3, wide);
ok('nothing stretches: the tiles of a row are all one height', await E(`(() => { const hs = [...document.querySelectorAll('#view .lrow[data-r="1"] .tile:not(.short):not(.sz-tall):not(.sz-big)')].map(t => t.offsetHeight); return hs.length > 1 && Math.max(...hs) - Math.min(...hs) <= 1; })()`));
ok('every category ends at its content (a shorter column leaves the room below it)', await E(`(() => [...document.querySelectorAll('#view .lrow .blk')].every(b => { const h = b.querySelector('.dch'), t = b.querySelector('.tg'); return Math.abs(b.offsetHeight - (h.offsetHeight + parseFloat(getComputedStyle(h).marginBottom) + t.offsetHeight)) <= 2; }))()`));
await p.shot(join(out, 'layout-tiles-edit.png'));

// selecting a category
await click(`${cat('cpu')} .cn`);
ok('clicking a category\'s name selects it: the panel says its name, a category to a screen reader', await E(`selCat === "cpu" && $("inspTitle").querySelector(".sr").textContent === "Category, " && $("inspTitle").textContent === "Category, " + catById("cpu").name && document.querySelector(${JSON.stringify(cat('cpu'))}).classList.contains("csel")`));
ok('its place is described', (await E('document.querySelector("#insp .row3").textContent')).startsWith('Row 1 of 4, column 2 of 2'), await E('document.querySelector("#insp .row3").textContent'));
await click('#insp .seg[data-lay="width"] button[data-v="4"]');
r = await rows('tiles');
ok('Width 1/3: its column gets 4 of 12, the other 8', JSON.stringify(r[0].cols.map(c => c.w)) === '[8,4]', JSON.stringify(r[0].cols));
// the line between the columns
const dv = await rect('#view .lrow[data-r="0"] .ldiv');
const unit = (await rect('#view .lrow[data-r="0"]')).w / 12;
await p.drag({ x: dv.x, y: dv.y }, { x: dv.x - unit * 2.1, y: dv.y }); await p.sleep(400);
r = await rows('tiles');
ok('dragging the line between two columns trades twelfths', JSON.stringify(r[0].cols.map(c => c.w)) === '[6,6]', JSON.stringify(r[0].cols.map(c => c.w)));
const dv2 = await p.center('#view .lrow[data-r="0"] .ldiv');
await p.drag(dv2, { x: dv2.x + unit * 3, y: dv2.y }); await p.sleep(400);
await p.dblclick(dv2.x + unit * 3, dv2.y); await p.sleep(400);
r = await rows('tiles');
ok('double-click on the line: equal widths again', r[0].cols.every(c => c.w === undefined), JSON.stringify(r[0].cols));
// the strip under a row
await E("document.querySelectorAll('.toast.show').forEach(t => t.classList.remove('show'))"); await p.sleep(300);   // a toast from the last step would sit over the bottom strip
const st = await rect('#view .lrow[data-r="3"] .lrs');
await p.drag({ x: st.x, y: st.y }, { x: st.x, y: st.y + 60 }); await p.sleep(400);
r = await rows('tiles');
ok('dragging the strip under a row down: Fill (the last row of four: every row fills, so the view is Fill the window)', r[3].h === 1 || (await J('S.L.views.tiles.fill')) === true, JSON.stringify(r[3]) + ' strip ' + JSON.stringify(st) + ' hit ' + await E(`(() => { const e = document.elementFromPoint(${st.x}, ${st.y}); return e ? e.className : 'none'; })()`) + ' sections ' + await E('[sectionsEl.scrollTop, sectionsEl.scrollHeight, sectionsEl.clientHeight, sectionsEl.getBoundingClientRect().bottom]'));
await p.dblclick(st.x, (await rect('#view .lrow[data-r="3"] .lrs')).y); await p.sleep(400);
ok('double-click on the strip: the row fits again', (await rows('tiles'))[3].h === undefined);
// widths that follow content: the column with more tiles gets more tracks, and the tiles in both are one width
const bs = await J(`(() => { const c = S.L.cats.filter(x => cellsOf(x).length > 1).sort((a, b) => cellsOf(b).length - cellsOf(a).length); return [c[0].id, c[c.length - 1].id, cellsOf(c[0]).length, cellsOf(c[c.length - 1]).length]; })()`);
await E(`mutate(() => { S.L.views.tiles = { rows: [{ cols: [{ stack: ['${bs[1]}'] }, { stack: ['${bs[0]}'] }] }] }; })`); await p.sleep(600);
const aw = await E(`(() => [...document.querySelectorAll('#view .lrow')[0].querySelectorAll(':scope > .lcol')].map(c => [Math.round(c.getBoundingClientRect().width), Math.round(c.querySelector('.tile').getBoundingClientRect().width)]))()`);
// (his pick 11-08, "stable split": the tracks are counted at the full text size, so the column with more tiles no longer
// has to be the wider one; a row's split doesn't move when an edit elsewhere fits the text a little smaller)
ok('Auto widths: the tiles in both columns are one width (the split counted at the full text size)', Math.abs(aw[0][1] - aw[1][1]) <= 2 && aw[1][0] >= aw[0][0] - 2, JSON.stringify(bs) + ' ' + JSON.stringify(aw));
await E('undo()'); await p.sleep(500);

// drops on a custom arrangement (nothing selected first: the settings stay out while something is, his 11-06, and would
// cover the categories these drag)
await p.key('Escape', 'Escape', 27); await p.sleep(500);
a = await p.center(grip('home')); b = await rect(cat('fans'));
await p.drag(a, { x: b.r - 8, y: b.y }); await p.sleep(450);
ok('drop on the right edge: beside it in its row', flat(await rows('tiles')).includes('fans | home'), flat(await rows('tiles')));
a = await p.center(grip('home')); b = await rect(cat('gpu'));
await p.drag(a, { x: b.x, y: b.t + 8 }); await p.sleep(450);
ok('drop on the top edge: stacked over it', flat(await rows('tiles')).startsWith('home+gpu'), flat(await rows('tiles')));
a = await p.center(grip('home')); const r0 = await rect('#view .lrow[data-r="0"]'), r1 = await rect('#view .lrow[data-r="1"]');
let aim = await dragCat(a, { x: r0.x, y: (r0.b + r1.t) / 2 });
aim += ' r0 ' + JSON.stringify([r0.t, r0.b, r0.x]) + ' r1 ' + JSON.stringify([r1.t, r1.b]) + ' now ' + await E(`(() => { drag = { kind: 'cat', data: 'home', started: true, rows: rowsNow(), auto: !isCustom('tiles'), ghost: null }; try { return JSON.stringify(catTarget(${r0.x}, ${(r0.b + r1.t) / 2}, null)) + ' ' + JSON.stringify(rowBoxes(drag.rows).map(b => b && [Math.round(b.top), Math.round(b.bottom)])); } catch (e) { return 'ERR ' + e.message; } finally { drag = null; dropmark.style.display = 'none'; } })()`);
ok('drop in the gap between two rows: a row of its own', (await rows('tiles')).some(x => x.cols.length === 1 && x.cols[0].stack.length === 1 && x.cols[0].stack[0] === 'home'), flat(await rows('tiles')) + ' aimed ' + aim + ' from ' + JSON.stringify(a));
a = await p.center(grip('cpu')); b = await rect(cat('sys'));
await p.drag(a, { x: b.x, y: b.y }); await p.sleep(450);
ok('drop on the middle: the two swap places', flat(await rows('tiles')).startsWith('gpu | sys'), flat(await rows('tiles')));
ok('no drop mark is left behind', await E('getComputedStyle(dropmark).display === "none"'));

// keys on a selected category
await click(`${cat('fans')} .cn`);
await p.key('b', 'KeyB', 66); await p.sleep(400);
let f = flat(await rows('tiles'));
ok('B: beside the row above', /disp\+game \| fans|game \| fans/.test(f) || f.split(' / ')[1].endsWith('fans'), f);
await p.key('r', 'KeyR', 82); await p.sleep(400);
ok('R: a row of its own again', (await rows('tiles')).some(x => x.cols.length === 1 && x.cols[0].stack[0] === 'fans'), flat(await rows('tiles')));
await p.key('Escape', 'Escape', 27); await p.sleep(400);   // the settings (open for Fans) go, so nothing covers GPU
ok('Esc tucks the settings away even with the pointer on them', await E('!document.querySelector(".insp").classList.contains("open")'));
await click(`${cat('gpu')} .cn`);
const w0 = (await rows('tiles'))[0].cols.map(c => c.w);
await p.key('ArrowRight', 'ArrowRight', 39, 1 | 8); await p.sleep(350);
await p.key('ArrowRight', 'ArrowRight', 39, 1 | 8); await p.sleep(350);
const w1 = (await rows('tiles'))[0].cols.map(c => c.w);
ok('Shift+Alt+Right twice: two twelfths wider', JSON.stringify(w1) === '[8,4]', JSON.stringify(w0) + ' then ' + JSON.stringify(w1));
await E('undo()'); await p.sleep(300);
ok('two quick key presses are one undo step', JSON.stringify((await rows('tiles'))[0].cols.map(c => c.w ?? null)) === JSON.stringify(w0.map(x => x ?? null)), JSON.stringify((await rows('tiles'))[0].cols));
await p.key('ArrowRight', 'ArrowRight', 39, 1); await p.sleep(400);
ok('Alt+Right swaps it with the category on its right', flat(await rows('tiles')).startsWith('sys | gpu'), flat(await rows('tiles')));
// (his 11-07 "move it to stay next to memory but still side by side") B on a stacked category: beside the one above it
// in its column, on one line; B again: back under it
{
  const f0 = flat(await rows('tiles'));
  await p.key('s', 'KeyS', 83); await p.sleep(500);
  const f1 = flat(await rows('tiles'));
  ok('S: GPU stacked under the column on its left', /sys\+gpu/.test(f1), f1);
  await p.key('b', 'KeyB', 66); await p.sleep(600);
  const col = (await rows('tiles')).flatMap(x => x.cols).find(c => c.stack.some(x => (typeof x === 'string' ? x : x.id) === 'gpu'));
  ok('B: GPU beside the one above it, kept as beside, one line drawn', !!col && col.stack.some(x => x && x.id === 'gpu' && x.b === 1) && await E(`!!document.querySelector('#view .lcol > .lsub > .dcat[data-cat="gpu"]')`), JSON.stringify(col));
  ok('the two side by side: tops level, GPU on the right, neither past the column', await E(`(() => { const s = document.querySelector('#view .lsub'), c = s && s.closest('.lcol').getBoundingClientRect(), a = s && s.children[0].getBoundingClientRect(), b = s && s.children[1].getBoundingClientRect(); return !!s && Math.abs(a.top - b.top) < 2 && b.left >= a.right - 1 && s.children[1].dataset.cat === 'gpu' && a.left >= c.left - 1 && b.right <= c.right + 1; })()`));
  ok('its settings: Beside above pressed, and where it is says beside', await E(`(() => { const b = document.querySelector('#insp [data-lay=move][data-v=beside]'), t = document.querySelector('#insp .row3'); return !!b && b.classList.contains('on') && !b.disabled && !!t && / beside 2 of 2/.test(t.textContent); })()`), await E(`(document.querySelector('#insp .row3') || {}).textContent`));
  ok('the outline draws the line too', await E(`(() => { const d = document.createElement('div'); d.innerHTML = outlineHtml(rowsNow('tiles'), 'tiles'); return !!d.querySelector('.oline [data-ocat="gpu"]') && !!d.querySelector('.oline [data-ocat="sys"]'); })()`));   // (no outline on the page while a category is selected: its drawing, 11-07 audit)
  await p.key('b', 'KeyB', 66); await p.sleep(600);
  const r3 = await rows('tiles');
  ok('B again: back under it, no line left', flat(r3) === f1 && !r3.flatMap(x => x.cols).some(c => c.stack.some(x => x && x.b)) && await E(`!document.querySelector('#view .lsub')`), flat(r3));
  for (let i = 0; i < 3; i++) { await E('undo()'); await p.sleep(350); }
  ok('three undos: as it was', flat(await rows('tiles')) === f0, [f0, flat(await rows('tiles'))]);
}

// looks in the panel
await click(`${cat('gpu')} .cn`);
// (GPU moved to the right: the settings slide across to the left, under the pointer resting on GPU's name, and stay;
// 11-03, they went away once past it, as if the pointer had been in them and left)
await p.sleep(800);
ok('the settings slide across under a pointer at rest and stay open', await E('DR.R.el.classList.contains("open") && DR.R.el.classList.contains("left")'), await E('DR.R.el.className'));
ok('no Tiles per row in the panel (2.2: a tile\'s width is a share of its row); Width of all as chips (11-06)', await E('!document.querySelector("#insp select[data-lay=per]") && !!document.querySelector("#insp [data-lay=aw]") && !!document.querySelector("#insp [data-lay=ah]")'));
await click('#insp .seg[data-lay="size"] button[data-v="short"]');
ok('Tile style Short from the panel', await until('!!S.L.views.tiles.cat && !!S.L.views.tiles.cat.gpu && S.L.views.tiles.cat.gpu.size === "short"', 3000) && await until(`document.querySelector('${cat('gpu')} .tile').classList.contains('short')`, 3000));
await click('#insp .seg[data-lay="title"] button[data-v="hide"]');
const gpuSz = await E('JSON.stringify(cellsOf(catById("gpu")).map(id => [id, S.L.views.tiles.cell && S.L.views.tiles.cell[id] || null]))');
await click('#insp button[data-lay="reset"]');
ok('Reset its look', await until('!(S.L.views.tiles.cat && S.L.views.tiles.cat.gpu)', 3000));
// (11-06: it also takes back the sizes of its tiles, shown in the same group; put back after, for the steps below)
ok('Reset its look in Tiles: its tiles back to their own size too', /"f"/.test(gpuSz) && await E('cellsOf(catById("gpu")).every(id => { const e = S.L.views.tiles.cell && S.L.views.tiles.cell[id]; return !e || (e.f === undefined && e.size === undefined && e.h === undefined); })'), gpuSz);
await E(`(() => { const v = S.L.views.tiles, c = v.cell || (v.cell = {}); for (const [id, e] of ${gpuSz}) if (e) c[id] = e; renderView(false); return 1; })()`); await p.sleep(400);
// a tile's size and its corner
await click('#view .dc[data-cid="gpu1"]');
await click('#insp .seg[data-lay="cf"] button[data-v="50"]'); await click('#insp .seg[data-lay="ch"] button[data-v="2"]');
const cz = await J('S.L.views.tiles.cell.gpu1');
ok('a cell\'s size from its settings: 50% of its row, 2 rows', cz.f === 0.5 && cz.h === 2, JSON.stringify(cz));
await click('#view .dc[data-cid="gpu1"]');
const cn = await rect('#view .dc[data-cid="gpu1"] .corner'), tile = await rect('#view .dc[data-cid="gpu1"]');
await p.drag({ x: cn.x, y: cn.y }, { x: cn.x, y: cn.y - tile.h * 0.5 }); await p.sleep(400);
if ((await J('S.L.views.tiles.cell.gpu1')).f !== 0.5) console.log('corner debug', JSON.stringify({ cn, tile, sel: await E('sel'), hit: await E(`(() => { const e = document.elementFromPoint(${cn.x}, ${cn.y}); return e && (e.className.baseVal !== undefined ? 'svg ' + e.closest('[class]').className : e.className); })()`) }));
// (Wide, or as tall as ends level with a column beside it, which wins a near tie: which one depends on the window's
// size, so on the screen the test runs on)
const c1 = await J('S.L.views.tiles.cell.gpu1');
ok('dragging a tile\'s corner up: its width stays 50%, about a row less tall (or level with the column beside it)', c1.f === 0.5 && (c1.h || 1) >= 0.9 && (c1.h || 1) <= 1.1, JSON.stringify(c1));
await click('#view .dc[data-cid="gpu1"]');   // clicking it again brings its settings back
await click('#insp .seg[data-lay="nscope"] button[data-v="one"]');
await E(`(() => { const i = $('lvName'); i.value = 'Hot spot'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await p.sleep(200);
ok('Name, Only Tiles: typed in the panel, shown on the tile', (await J('S.L.views.tiles.cell.gpu1')).name === 'Hot spot' && await E(`document.querySelector('#view .dc[data-cid="gpu1"] .tn span').textContent === 'Hot spot'`));

// the view's settings: templates, height, back to automatic (the settings drawer pinned open)
await E('clearSel()'); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 }); await p.sleep(700);
ok('nothing selected and the pointer away: the settings drawer is tucked away', await E('!document.querySelector(".insp").classList.contains("open")'));
await click('#ebSel');
ok('Selected on the editing strip keeps it open (pinned)', await E('DR.R.pinned && document.querySelector(".insp").classList.contains("open")'));
ok('nothing selected: the panel shows the view\'s settings', (await E('$("inspTitle").textContent')) === 'Tiles' && await E('!!document.querySelector("#insp .seg[data-lay=arr]")'));
const before = flat(await rows('tiles')), undos = await E('undoStack.length');
const tp = await p.center('#insp .tpl[data-tpl="three"]');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp.x, y: tp.y }); await p.sleep(400);
ok('resting on "3 columns" shows it on the view, without keeping it', await E('preview && preview.k === "three"') && await E('document.querySelectorAll("#view .lrow")[0].querySelectorAll(".lcol").length') === 3 && flat(await rows('tiles')) === before && await E('undoStack.length') === undos);
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300 }); await p.sleep(400);
ok('moving away puts yours back', await E('!preview') && await E('document.querySelectorAll("#view .lrow").length') === (await rows('tiles')).length);
await click('#insp .tpl[data-tpl="two"]');
r = await rows('tiles');
ok('clicking "2 columns" uses it (one undo step)', r.every(x => x.cols.length <= 2) && await E('undoStack.length') === undos + 1, flat(r));
await click('#insp .seg[data-lay="fill"] button[data-v="fill"]');
r = await rows('tiles');
ok('Height: Fill the window is the view setting (kept in Automatic), every row Fill', (await J('S.L.views.tiles.fill')) === true && r.every(x => !x.h) && await E('[...document.querySelectorAll("#view > .lrow")].every(r => r.dataset.fill)'), JSON.stringify(r.map(x => x.h)));
const gaps = () => E(`(() => { const r = document.querySelector('#view .lrow:not(.fold)'), t = document.querySelector('#view .tg'); return [parseFloat(getComputedStyle(r).columnGap), parseFloat(getComputedStyle(t).columnGap)]; })()`);
await click('#insp .seg[data-lay="gap"] button[data-v="tight"]');
const gt = await gaps();
await click('#insp .seg[data-lay="gap"] button[data-v="roomy"]');
const gr = await gaps();
ok('Spacing: Roomy', (await J('S.L.views.tiles.gap')) === 'roomy' && await E('$("view").classList.contains("gap-roomy")'));
ok('Spacing changes the gaps between columns and between tiles too, not just between rows', gr[0] > gt[0] * 2 && gr[1] > gt[1] * 2, JSON.stringify([gt, gr]));
ok('the outline shows every category', await E('document.querySelectorAll("#insp .obox").length') === 7);
await click('#insp .obox[data-ocat="fans"]');
ok('a box in the outline selects that category', await E('selCat === "fans"'));

// the arrangement follows removed and added categories
await click('#insp button[data-lay="remove"]');
ok('removing a category takes it out of the arrangement', !flat(await rows('tiles')).includes('fans') && !(await J('S.L.views.tiles.cat && S.L.views.tiles.cat.fans')));
await click('#addCat');
await p.key('Escape', 'Escape', 27); await p.sleep(300);
r = await rows('tiles');
const nc = await E('S.L.cats[S.L.cats.length - 1].id');
ok('a new category gets a row of its own at the bottom', flat(r).endsWith(nc), flat(r));

await click('#ebSel'); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 }); await p.sleep(600);
ok('Selected again: not pinned any more', await E('!DR.R.pinned'));

// ---- Overview: looks ----
await E(`(() => { mutate(() => { Object.assign(vset('overview'), { rows: [
  { h: 1, cols: [{ stack: ['gpu'] }, { stack: ['cpu'] }, { stack: ['sys'] }] }, { cols: [{ stack: ['home'] }] }, { cols: [{ stack: ['game'] }, { stack: ['disp'] }] }],
  cat: { sys: { lead: 'sys2' }, home: { style: 'band' }, game: { style: 'small' }, disp: { style: 'list' } } }); }); showScreen('overview'); })()`);
await p.sleep(800);
ok('Overview: a band with a cell per reading', await E(`document.querySelectorAll('${cat('home')}.band .bcell').length === 4`));
ok('a small card and a list (no big reading)', await E(`document.querySelector('${cat('game')}').classList.contains('small') && !document.querySelector('${cat('disp')} .hero')`));
ok('the lead is the big reading', await E(`document.querySelector('${cat('sys')} .hero').dataset.cid === 'sys2'`));
await p.sleep(1500);
ok('band cells get their values', await E(`[...document.querySelectorAll('${cat('home')} .bcell .v')].some(v => /\\d/.test(v.textContent))`), await E(`[...document.querySelectorAll('${cat('home')} .bcell .v')].map(v => v.textContent).join()`));
await click(`${cat('disp')} .cn`);
await click('#insp .looks button[data-v="band"]');
ok('picking Band in the panel', (await J('S.L.views.overview.cat.disp')).style === 'band' && await E(`document.querySelector('${cat('disp')}').classList.contains('band')`));
await p.key('Escape', 'Escape', 27); await p.sleep(400);
await click('#view .dc[data-cid="sys3"]');
ok('a cell selected on the right: its settings open on the left, clear of it', await E('document.querySelector(".insp").classList.contains("left") && document.querySelector(".insp").classList.contains("open")'));
await click('#insp button[data-lay="lead-me"]');
ok('"Make it the big reading" on a cell', (await J('S.L.views.overview.cat.sys')).lead === 'sys3');
ok('Tiles keeps its own name for the cell', await E(`(() => { const v = S.L.views.tiles.cell.gpu1; return v.name === 'Hot spot'; })()`) && await E(`document.querySelector('#view .dc[data-cid="gpu1"] .nm span').textContent !== 'Hot spot'`));
await p.shot(join(out, 'layout-overview-edit.png'));

// ---- out of edit mode: fill, hidden titles, folding on a narrow window ----
await E(`mutate(() => { setLook('cat', 'gpu', 'title', 'hide', 'overview'); })`);
await E('setEdit(false)'); await p.sleep(900);
ok('Overview: every card ends at what it holds (its rows keep their own height)', await E(`(() => [...document.querySelectorAll('#view .lrow[data-r="0"] .card')].every(c => { const last = [...c.querySelectorAll('.dgrid > *')].pop(); return c.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom < 30; }))()`));
ok('Overview: the rows of a card are all one height', await E(`(() => { const hs = [...document.querySelectorAll('#view .card:not(.band) .dgrid > .row')].map(r => r.offsetHeight); return hs.length > 2 && Math.max(...hs) - Math.min(...hs) <= 2; })()`));
ok('a hidden title is hidden outside edit mode (it keeps its height, so the next card lines up)', await E(`getComputedStyle(document.querySelector('${cat('gpu')} .ch')).visibility === 'hidden'`));
await p.shot(join(out, 'layout-overview.png'));
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 1, mobile: false }); await p.sleep(900);
await E('window.dispatchEvent(new Event("resize"))'); await p.sleep(700);
ok('a narrow window folds a row that doesn\'t fit (and keeps the arrangement)', await E('document.querySelector("#view .lrow").classList.contains("fold")') && (await rows('overview'))[0].cols.length === 3);
await p.cmd('Emulation.setDeviceMetricsOverride', VIEWPORT); await p.sleep(600);
await E('window.dispatchEvent(new Event("resize"))'); await p.sleep(700);
ok('wide again: side by side again', await E('!document.querySelector("#view .lrow").classList.contains("fold")'));

// ---- Grid: your tables ----
await E(`(() => { setEdit(true); showScreen('grid'); })()`); await p.sleep(700);
await E('clearSel()'); await p.sleep(200);
await E('(() => { DR.R.pinned = true; syncDrawers(); return 1; })()'); await p.sleep(900);   // the settings pinned open for the Grid checks (slid all the way in: its Tables row has 4 chips since 11-06)
await click('#insp .seg[data-lay="tables"] button[data-v="3"]');
r = await rows('grid');
ok('Grid: Tables 3 cuts the categories into three tables', r && r[0].cols.length === 3 && await E('document.querySelectorAll("#view .gtable").length') === 3, flat(r));
await click(`${cat('gpu')} .dch .cn`);
await click('#insp .seg[data-lay="table"] button[data-v="2"]');
r = await rows('grid');
ok('a category moved to table 3 from its settings', r[0].cols[2].stack.map(s => typeof s === 'string' ? s : s.id).includes('gpu'), flat(r));

// ---- slots, saved state ----
const L1 = await E('JSON.stringify(S.L)');
ok('a slot keeps the arrangement exactly', await E('JSON.stringify(cleanSlot({ name: "x", layout: S.L }).layout) === JSON.stringify(cleanLayout(S.L))') && await E('JSON.stringify(cleanLayout(S.L))') === L1);
let saved = {};
for (let i = 0; i < 20; i++) { await p.sleep(250); try { saved = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')); } catch (e) { } if (saved.L && saved.L.views && saved.L.views.grid) break; }
ok('state.json has the views', !!(saved.L && saved.L.views && saved.L.views.grid && saved.L.views.tiles), Object.keys(saved.L.views || {}).join());
await click('#screens button[data-s="tiles"]'); await until('S.screen === "tiles"', 3000); await p.sleep(400);
await E('clearSel()'); await p.sleep(300);
await click('#insp .seg[data-lay="arr"] button[data-v="auto"]');
ok('Arrangement Automatic: back to automatic', !(await rows('tiles')) && await E('!!document.querySelector("#view.arr.auto")') && !!(await J('S.L.views.tiles.cell')));

// ---- edit mode shows the view at its real size: Storage and the settings are drawers over it ----
await E(`(() => { setEdit(false); showScreen('tiles'); })()`); await p.sleep(900);
const real = await E('[...document.querySelectorAll("#view .dcat")].filter(e => e.offsetWidth).map(e => { const r = e.getBoundingClientRect(); return [e.dataset.cat, Math.round(r.left), Math.round(r.width)]; })');
await E('setEdit(true)'); await p.sleep(900);
const inEdit = await E('[...document.querySelectorAll("#view .dcat:not(.isempty)")].map(e => { const r = e.getBoundingClientRect(); return [e.dataset.cat, Math.round(r.left), Math.round(r.width)]; })');
ok('the categories sit at the same places and widths in edit mode as outside it', JSON.stringify(real) === JSON.stringify(inEdit), JSON.stringify(real.slice(0, 3)) + ' vs ' + JSON.stringify(inEdit.slice(0, 3)));
await click('#ebSel'); await E('clearSel()'); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 }); await p.sleep(700);
ok('unpinned and nothing selected: both drawers are tucked away', await E('!document.querySelector(".storage").classList.contains("open") && !document.querySelector(".insp").classList.contains("open")'));
await click('#ebStore'); await p.sleep(400);
ok('Storage on the editing strip slides Storage out', await E('document.querySelector(".storage").classList.contains("open") && $("ebStore").classList.contains("on")'));
const row = await p.centerOf('[...document.querySelectorAll("#vspace .vrow.r")][4]'), dest = await rect(cat('home'));
const nCells = await E('Object.keys(S.L.cells).length');
await p.drag({ x: row.x - 40, y: row.y }, { x: dest.x, y: dest.y }, 20); await p.sleep(600);
ok('a reading dragged out of Storage drops into the view under where Storage was', await E('Object.keys(S.L.cells).length') === nCells + 1);
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 300 }); await p.sleep(900);
ok('opened from the strip, Storage stays out after the drop', await E('document.querySelector(".storage").classList.contains("open")'));
await click('#ebStore'); await p.sleep(500);
ok('and its button on the strip tucks it away', await E('!document.querySelector(".storage").classList.contains("open") && !$("ebStore").classList.contains("on")'));
// the drawers' swap: Storage to the right, the settings then take the left; the settings moved by hand stay there until
// unpinned (nothing selected first: a selection opens the settings, and Selected then shuts them)
await E('clearSel()'); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 }); await p.sleep(700);
await click('#ebStore'); await p.sleep(400);
const slid = await E('(() => { $("swapL").click(); const a = document.querySelector(".storage").getAnimations().find(x => x.effect && x.effect.getKeyframes().some(f => /translateX/.test(f.transform || ""))); return motionMode() === "off" ? "off" : a ? Math.round(parseFloat(/translateX\\((-?[\\d.]+)px/.exec(a.effect.getKeyframes()[0].transform)[1])) : 0; })()'); await p.sleep(500);
ok('Storage\'s swap moves it to the right, sliding across from the left', await E('document.querySelector(".storage").classList.contains("right") && DR.L.side === "r"') && (slid === 'off' || slid < -200), String(slid));
await click('#ebSel'); await p.sleep(400);
ok('the settings, open beside it, take the left', await E('document.querySelector(".insp").classList.contains("open") && document.querySelector(".insp").classList.contains("left")'));
await click('#ebSel'); await p.sleep(300);
await click('#swapL'); await p.sleep(400);
await click('#ebStore'); await p.sleep(400);
ok('swapped back: Storage on the left, both shut', await E('DR.L.side === "l" && !document.querySelector(".storage").classList.contains("open") && !document.querySelector(".insp").classList.contains("open")'));
await click('#ebSel'); await p.sleep(400);
await click('#swapR'); await p.sleep(400);
ok('the settings\' swap moves them to the left, pinned, kept there', await E('document.querySelector(".insp").classList.contains("left") && DR.R.placed && DR.R.pinned'));
await click('#ebSel'); await p.sleep(300);   // (Selected off unpins them: the settings' own pin went 11-06, his pick)
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 300 }); await p.sleep(900);   // (the pointer on them keeps them out)
ok('unpinned: the side set by hand ends, they tuck away once the pointer leaves', await E('!DR.R.placed && !DR.R.pinned && !document.querySelector(".insp").classList.contains("open")'));
await E('(() => { DR.L.side = "l"; DR.R.side = "r"; syncDrawers(); saveState(); return 1; })()'); await p.sleep(300);   // (the sides as they were, for what follows)
await click(`${cat('cpu')} .cn`);
ok('selecting something opens the settings drawer', await E('document.querySelector(".insp").classList.contains("open")'));
await p.key('Escape', 'Escape', 27); await p.sleep(500);
ok('Esc: nothing selected, the drawer goes', await E('!selCat && !document.querySelector(".insp").classList.contains("open")'));
// the settings sliding across to stop under a pointer at rest (11-03): a pointer still in them as they stop counts as come
// in, so once it leaves they go, the selection kept (the pointer waits where they will stop; the swap clicked from the page)
await click(`${cat('cpu')} .cn`); await p.sleep(500);
const landX = await E('document.querySelector(".insp").classList.contains("left") ? innerWidth - 150 : 150');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: landX, y: 500 }); await p.sleep(500);
await E('$("swapR").click()'); await p.sleep(800);
ok('the settings stopping under a pointer at rest: it counts as in them', await E('document.querySelector(".insp").classList.contains("open") && DR.R.hover === true && !DR.R.ghost'), await E('JSON.stringify({ cls: DR.R.el.className, hover: DR.R.hover, ghost: DR.R.ghost })'));
await E('$("ebSel").click()'); await p.sleep(300);   // (no pin since 11-06: Selected off shuts them and selects nothing)
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 300 }); await p.sleep(900);
ok('Selected off: once the pointer leaves they go, nothing selected', await E('!document.querySelector(".insp").classList.contains("open") && !selCat && !DR.R.pinned'), await E('DR.R.el.className + " " + selCat'));
await p.key('Escape', 'Escape', 27); await p.sleep(400);
await E('(() => { DR.L.side = "l"; DR.R.side = "r"; syncDrawers(); saveState(); return 1; })()'); await p.sleep(300);

// ---- edit mode moves nothing (his 11-09: "the edit mode changes position of stuff (by pixels) making them off
// centered"): every tile and every category's name, in each view, before and after edit mode turns on. (Empty
// categories show in edit mode on purpose, room to drop into: measured on the layout without them)
{ const L0 = await E('JSON.stringify(S.L)');
  await E(`(() => { const L = JSON.parse(JSON.stringify(S.L)); L.cats = L.cats.filter(c => c.cells && c.cells.length); S.L = cleanLayout(L); sel = null; selCat = null; return 1; })()`);
  const at = `(() => { const o = {}; for (const e of document.querySelectorAll('#view .dc[data-cid], #view .dch .cn')) { const c = e.closest('[data-cat]'), k = e.dataset.cid || ('name ' + (c ? c.dataset.cat : '?')); const r = e.getBoundingClientRect(); if (r.width) o[k] = [r.left, r.top, r.width, r.height]; } return JSON.stringify(o); })()`;
  for (const scr of ['tiles', 'overview', 'grid']) {
    await E(`(() => { setEdit(false); showScreen('${scr}', true); return 1; })()`); await p.sleep(1400);
    const A = JSON.parse(await E(at));
    await E('setEdit(true)'); await p.sleep(1400);
    const B = JSON.parse(await E(at));
    const moved = Object.keys(A).filter(k => B[k] && A[k].some((v, i) => Math.abs(v - B[k][i]) > 0.5));
    ok('edit mode moves nothing in ' + scr + ': every tile and category name within 0.5 px', Object.keys(A).length > 3 && moved.length === 0,
      Object.keys(A).length + ' measured; ' + moved.slice(0, 4).map(k => k + ' ' + A[k].map(x => x.toFixed(1)).join(',') + ' > ' + B[k].map(x => x.toFixed(1)).join(',')).join(' | '));
  }
  await E(`(() => { S.L = cleanLayout(${L0}); sel = null; selCat = null; setEdit(true); showScreen('tiles', true); return 1; })()`); await p.sleep(700); }

// ---- a move inside a category is fitted for itself (11-10, his recording: the remembered size was kept per count of
// cells, so a move that needed another row left every other order of the same cells at its smaller size: a blank band
// under the view after a drop or an undo, kept across restarts). Four 25% tiles and three 33% ones in a view whose
// height sets the text size: in two rows, in three, in two again ----
{ const L0 = await E('JSON.stringify(S.L)');
  const made = await E(`(() => {
    const keys = READ.slice(0, 60).map(r => r.key); if (keys.length < 40) return 'too few readings';
    const L = { v: 1, cats: [], cells: {}, views: { tiles: { rows: [], cell: {} } } }; let n = 0;
    const cat = (id, name, sizes) => { const c = { id, name, collapsed: false, cells: [] };
      for (const [f, fx] of sizes) { const cid = 'fo' + n; L.cells[cid] = { key: keys[n++], graph: true }; c.cells.push(cid); L.views.tiles.cell[cid] = fx ? { f, fx: true } : { f }; }
      L.cats.push(c); L.views.tiles.rows.push({ cols: [{ stack: [id] }] }); };
    cat('foT', 'Order', [[0.25], [0.25], [0.25], [0.25], [0.3333, true], [0.3333, true], [0.3333, true]]);
    for (let i = 0; i < 3; i++) cat('foF' + i, 'Fill ' + i, Array.from({ length: 8 }, () => [0.25]));
    S.L = cleanLayout(L); sel = null; selCat = null; undoStack = []; redoStack = []; setEdit(false); showScreen('tiles', true); renderView(false); syncUndo(); return 'ok';
  })()`);
  await p.sleep(1300);
  const at = () => J(`({ fs: parseFloat(document.documentElement.style.fontSize), target: cssScale(), band: sectionsEl.clientHeight - $('view').offsetHeight,
    rows: [...new Set([...document.querySelectorAll('#view .dcat[data-cat="foT"] .tile')].map(t => Math.round(t.getBoundingClientRect().top)))].length,
    tiles: [...document.querySelectorAll('#view .dcat[data-cat="foT"] .tile')].map(t => { const r = t.getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }).join(' | ') })`);
  const move = async (from, to) => { await E(`(mutate(() => { const c = S.L.cats.find(c => c.id === 'foT'), x = c.cells.splice(${from}, 1)[0]; c.cells.splice(${to}, 0, x); }), 1)`); await p.sleep(900); return at(); };
  const a = await at();
  ok('seven tiles, four of 25% and three of 33%, sit in two rows, and the window\'s height sets the text size', made === 'ok' && a.rows === 2 && a.fs < a.target - 0.3, made + ' ' + JSON.stringify(a));
  await E('setEdit(true)'); await p.sleep(900);
  const b1 = await move(2, 6), b2 = await move(2, 6);   // (25, 25, 33, 33, 33, 25, 25: three rows)
  ok('a 25% one moved behind the 33% ones: three rows, at a smaller text size', b2.rows === 3 && b2.fs < a.fs - 0.8, JSON.stringify([b1, b2]));
  const c = await move(5, 2);   // (25, 25, 25, 33, 33, 33, 25: two rows again, the last 25% one fills the first)
  ok('moved back in front: two rows, fitted for this order (not kept at the three-row size)', c.rows === 2 && Math.abs(c.fs - a.fs) < 0.35, JSON.stringify(c) + ' start ' + a.fs.toFixed(3) + ' three rows ' + b2.fs.toFixed(3));
  await E('setEdit(false)'); await p.sleep(1100);
  const d = await at();
  ok('edit mode off: still that size, no blank band under the view', Math.abs(d.fs - a.fs) < 0.35 && d.band < a.band + 25, JSON.stringify(d) + ' start band ' + a.band);
  for (let i = 0; i < 2; i++) { await E('($("undo").click(), 1)'); await p.sleep(350); }
  // the last undo and, before a frame or a second's readings can measure again, each caption that has shorter words:
  // does it show the ones its box calls for now that the view is fitted (they were measured before the fit, and changed
  // twice within a second)
  const cap = JSON.parse(await E(`(() => { $('undo').click(); let bad = 0, had = 0; const which = [];
    for (const r of E.values()) { const el = r.cap, f = el && el._fit; if (!f || !el.isConnected) continue; had++;
      const shown = el._t; setText(el, f.full); const cut = capCut(el); setText(el, shown); if ((shown === f.short) !== cut) { bad++; which.push(shown); } }
    return JSON.stringify({ bad, had, which: which.slice(0, 4) }); })()`));
  await p.sleep(1200);
  const u = await at();
  ok('undone from the title bar, not in edit mode: the first order back at its own size', u.rows === 2 && Math.abs(u.fs - a.fs) < 0.35 && u.band < a.band + 25 && await E('undoStack.length') === 0, JSON.stringify(u) + ' start ' + JSON.stringify(a));
  ok('right after that draw every caption shows the words its fitted box calls for', cap.bad === 0 && cap.had > 0, JSON.stringify(cap));
  // (11-10, the stress test at seeds 7112 and 7113) a step's size put back by an undo holds through a second draw of the
  // same view, which comes without the pin: the size is remembered for it, also when a fresh fit would give another.
  // And it goes back when the room is as it was when the step was taken, whatever room the last fit started in
  const two = JSON.parse(await E(`(() => { const n0 = fitNow(), small = +(n0.fs - 0.9).toFixed(3), fsNow = () => parseFloat(document.documentElement.style.fontSize), k0 = fitKey(cssScale());
    fitPin = Object.assign({}, n0, { fs: small }); renderView(false); const f1 = fsNow();
    renderView(false); const f2 = fsNow();
    fitPin = Object.assign({}, n0, { fs: small, w: n0.w + 40 }); delete fitMemo[k0]; renderView(false); const f3 = fsNow();   // (another room: not put back, fitted)
    return JSON.stringify({ start: n0.fs, small, f1, f2, f3 }); })()`));
  ok('a size put back by an undo holds through a second draw of the view; a step taken in another room is fitted afresh', Math.abs(two.f1 - two.small) < 0.001 && Math.abs(two.f2 - two.small) < 0.001 && Math.abs(two.f3 - two.start) < 0.35, JSON.stringify(two));
  await E(`(() => { S.L = cleanLayout(${L0}); sel = null; selCat = null; undoStack = []; redoStack = []; setEdit(true); showScreen('tiles', true); syncUndo(); saveState(); subscribe(); return 1; })()`); await p.sleep(700); }

// ---- the title bar: this PC's name (or your title), the clock, Restart HWiNFO ----
const pc = await E('feed.pc');
ok('the title is the name of this PC', pc.length > 0 && await E('$("title").textContent') === pc, pc);
ok('the clock shows the time of the last reading', /^\d\d:\d\d:\d\d$/.test(await E('$("clock").textContent')), await E('$("clock").textContent'));
await click('#setBtn');
await E(`(() => { const i = $('sTitle'); i.value = 'My rig'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await p.sleep(200);
ok('a title typed in Settings shows at once', await E('$("title").textContent') === 'My rig' && await E('S.title') === 'My rig');
await click('#sClock');
ok('the clock can be hidden', await E('$("clock").hidden && S.clock === false'));
await click('#sClock');
await E(`(() => { const i = $('sTitle'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); $('setmodal').classList.remove('open'); })()`); await p.sleep(200);
ok('an empty title goes back to the name of this PC', await E('$("title").textContent') === pc);
ok('Restart HWiNFO is off on made-up data', await E('$("rstBtn").disabled'));
await E('send({ t: "restartHwinfo" })'); await p.sleep(600);
ok('the host answers a restart with "restarted"', await E('!$("rstBtn").classList.contains("spin")'));

await p.cmd('Emulation.clearDeviceMetricsOverride');
ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(done() ? '\nALL PASS' : '\nSOME FAILED');
p.close(); process.exit(0);
