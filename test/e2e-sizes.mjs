// Tile sizes (1.3): any width and height from 0.25 to 2 tiles, the packing, the corner (snaps and Alt), the numbers in
// the panel (tiles and px), Ctrl+arrows, a category's size, Fit the row, undo, saving, the look of very small tiles.
// Start a fresh copy first (an EMPTY data folder):
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9238
//   HWDeck.exe --fake 300 --data test\data-sz
// then: node test/e2e-sizes.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9238);
const data = process.argv[3] || 'test/data-sz';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const J = x => E('JSON.stringify(' + x + ')').then(s => s === undefined ? undefined : JSON.parse(s));
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(300); };
const box = cid => E(`(() => { const e = document.querySelector('#view .tile[data-cid="${cid}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
const mouse = (type, x, y, buttons = 0, modifiers = 0) => p.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers });
const look = cid => J(`(S.L.views && S.L.views.tiles && S.L.views.tiles.cell && S.L.views.tiles.cell[${JSON.stringify(cid)}] || {})`);
const near = (a, b, d = 1) => Math.abs(a - b) <= d;
const colBottoms = () => E(`[...document.querySelectorAll('#view .lrow[data-r="0"] > .lcol')].map(c => { const ks = [...c.children].filter(e => e.classList.contains('dcat')); return Math.round(ks[ks.length - 1].getBoundingClientRect().bottom * 10) / 10; })`);
// a corner dragged by dx, dy in steps (Alt held when asked); returns the size shown while dragging, and the snap lines
async function dragCorner(cid, dx, dy, alt) {
  await click(`#view .tile[data-cid="${cid}"]`);
  const c = await p.center(`#view .tile[data-cid="${cid}"] .corner`);
  const m = alt ? 1 : 0;
  await mouse('mouseMoved', c.x, c.y, 0, m); await mouse('mousePressed', c.x, c.y, 1, m);
  for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', c.x + dx * i / 10, c.y + dy * i / 10, 1, m); await p.sleep(16); }
  await p.sleep(120);
  const seen = await E(`({ pill: document.querySelector('.lpill').textContent, lines: [...document.querySelectorAll('.sguide.on')].length })`);
  await mouse('mouseReleased', c.x + dx, c.y + dy, 0, m); await p.sleep(700);
  return seen;
}

ok('catalog arrives', await until('READ.length > 200 && feed.got'), await E('READ.length'));
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }); await p.sleep(400);
await E('window.dispatchEvent(new Event("resize"))'); await p.sleep(500);

// ---- the data: sizes in tiles, the named ones kept by name, anything else dropped ----
const cl = await J(`cleanLayout({ v: 1, cats: [{ id: 'a', name: 'A', cells: ['x', 'y', 'z', 'q', 'r'] }], cells: { x: { key: READ[0].key }, y: { key: READ[1].key }, z: { key: READ[2].key }, q: { key: READ[3].key }, r: { key: READ[4].key } },
  views: { tiles: { cell: { x: { w: 1.5, h: 0.70004 }, y: { w: 2, h: 1 }, z: { w: 1, h: 1 }, q: { w: 5, h: -1 }, r: { w: 'x', size: 'huge' } } }, overview: { cell: { x: { w: 2 } } } } }).views`);
ok('sizes: any size kept (4 decimals), a named one by its name, 1 x 1 and junk dropped, out of range clamped',
  JSON.stringify(cl.tiles.cell) === '{"x":{"w":1.5,"h":0.7},"y":{"size":"wide"},"q":{"w":2,"h":0.25}}', JSON.stringify(cl.tiles.cell));
ok('sizes only in Tiles', !cl.overview, JSON.stringify(cl.overview));
ok('a size a hair off a quarter step (a snap or a px step) is that step: 0.9999 is 1, 0.7501 is 0.75; 0.7525 stays', await E('szNum(0.9999) === 1 && szNum(0.7501) === 0.75 && szNum(1.2498) === 1.25 && szNum(0.7525) === 0.7525'));
ok('so four tiles of 0.75 (one saved as 0.7501 x 0.9999) and one of 1 still fill a row of 4', await E(`(() => { const L = packTiles([[0.75, 0.9999], [0.75, 1], [0.75, 1], [0.7501, 0.9999], [1, 1]].map(([w, h]) => ({ w: szNum(w), h: szNum(h) })), 4); return L.pos[4].x === 3 && L.pos[4].y === 0 && L.H === 1; })()`));
ok('a tile that starts a new row goes under the ones before it, and the ones after it too (no filling the hole above)', await E(`(() => { const L = packTiles([{ w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 1, h: 1, nl: true }, { w: 1, h: 1 }, { w: 1, h: 1 }], 4);
  return L.pos.slice(4).map(p => p.x + ',' + p.y).join(' ') === '0,1 1,1 2,1' && L.H === 2; })()`));
ok('without it the next tile fills the end of the row', await E('packTiles([{ w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 1, h: 1 }], 4).pos[4].y === 0'));
ok('and the packing takes a tile a hair too big for a spot (no hole, no tile pushed down)', await E('(() => { const L = packTiles([{ w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.7501, h: 1 }, { w: 1, h: 1 }], 4); return L.pos[4].y === 0 && L.H === 1; })()'));

// ---- a layout: Left (6 tiles, 3 a row) beside Right (2 tiles, 2 a row), then Low (3 tiles, 3 a row) ----
await E(`(() => {
  const t = READ.filter(r => r.t === 'temp').map(r => r.key), L = { v: 1, cats: [], cells: {} };
  const mk = (id, n, from) => { const ids = []; for (let i = 0; i < n; i++) { L.cells[id + i] = { key: t[from + i], graph: true }; ids.push(id + i); } L.cats.push({ id, name: id === 'a' ? 'Left' : id === 'b' ? 'Right' : 'Low', collapsed: false, cells: ids }); };
  mk('a', 6, 0); mk('b', 2, 6); mk('c', 3, 8);
  L.views = { tiles: { rows: [{ cols: [{ w: 6, stack: ['a'] }, { w: 6, stack: ['b'] }] }, { cols: [{ stack: ['c'] }] }], cat: { a: { per: 3 }, b: { per: 2 }, c: { per: 3 } } } };
  S.L = cleanLayout(L); S.edit = true; app.classList.add('editing'); sel = null; selCat = null; showScreen('tiles', true); afterChange();
})()`);
await p.sleep(1500);

// ---- one tile high is the same in every category: the height most tiles have; a tile that holds more makes its row taller ----
const unit = await J(`(() => {
  const tg = c => document.querySelector('#view .dcat[data-cat="' + c + '"] .tg'), h = c => tileKids(tg(c)).map(x => Math.round(x.getBoundingClientRect().height * 10) / 10);
  for (const c of ['a', 'b']) for (const x of tileKids(tg(c))) x._nat = 9.3;   // (as if read: these hold a caption and a graph)
  for (const x of tileKids(tg('c'))) x._nat = 8.6;                              // (these hold less)
  layoutPass(); const same = { unit: tileUnit, a: h('a'), c: h('c') };
  tileKids(tg('a'))[0]._nat = 10.4; layoutPass(); const tall = { unit: tileUnit, a: h('a'), c: h('c') };
  for (const c of ['a', 'b', 'c']) { for (const x of tileKids(tg(c))) delete x._nat; unitH.delete(tg(c)); }
  layoutPass(); return { same, tall };
})()`);
ok('a category whose tiles hold less is not shorter: one tile high is the same everywhere (the height most tiles have)', unit.same.unit === 9.3 && unit.same.a.concat(unit.same.c).every(v => near(v, unit.same.a[0], 0.6)), JSON.stringify(unit.same));
ok('a tile that holds more still makes its own row taller, and only that row', unit.tall.unit === 9.3 && unit.tall.a[0] > unit.same.a[0] + 5 && near(unit.tall.a[3], unit.same.a[0], 0.6) && unit.tall.c.every(v => near(v, unit.same.a[0], 0.6)), JSON.stringify(unit.tall));

// ---- all at 1 x 1: a plain grid, every tile one place wide and one tile high ----
const g0 = await E(`(() => { const tg = document.querySelector('#view .dcat[data-cat="a"] .tg'), b = tg.getBoundingClientRect(), k = +tg.style.getPropertyValue('--k'), g = 0.62 * parseFloat(document.documentElement.style.fontSize);
  const ts = [...tg.children].map(t => t.getBoundingClientRect()), p = (b.width + g) / k, q = ts[0].height + g;
  return { k, packed: tg.classList.contains('pk'), bad: ts.filter((r, i) => Math.abs(r.left - b.left - (i % k) * p) > 0.6 || Math.abs(r.top - b.top - Math.floor(i / k) * q) > 0.6 || Math.abs(r.width - (p - g)) > 0.6).length }; })()`);
ok('1 x 1 tiles: a plain grid in reading order', g0.packed && g0.k === 3 && g0.bad === 0, JSON.stringify(g0));

// ---- the panel: width and height in tiles, and in px ----
await click('#view .tile[data-cid="a0"]');
const a0 = await box('a0');
await E(`(() => { const i = document.querySelector('#insp input[data-sz="w"]'); i.value = '1.5'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await p.sleep(600);
let a0b = await box('a0');
ok('width 1.5 from the panel', (await look('a0')).w === 1.5 && near(a0b.w, 1.5 * (a0.w + 9.1) - 9.1, 1.5), JSON.stringify({ look: await look('a0'), was: a0.w, now: a0b.w }));
const g = await E('0.62 * parseFloat(document.documentElement.style.fontSize)');
ok('width 1.5: drawn as one and a half places', near(a0b.w, 1.5 * (a0.w + g) - g, 1), a0b.w + ' vs ' + (1.5 * (a0.w + g) - g));
await E(`(() => { const i = document.querySelector('#insp input[data-sz="ph"]'); i.value = '90'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await p.sleep(600);
a0b = await box('a0');
ok('height in px from the panel: exactly that tall', near(a0b.h, 90, 0.6), a0b.h);
ok('the panel shows the px it has', await E(`document.querySelector('#insp input[data-sz="ph"]').value`) === '90');
await E(`(() => { const i = document.querySelector('#insp input[data-sz="pw"]'); i.value = '201'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await p.sleep(600);
a0b = await box('a0');
ok('width in px from the panel: exactly that wide', near(a0b.w, 201, 0.6), a0b.w);

// ---- Ctrl+arrows: a pixel; with Shift a quarter step ----
await click('#view .tile[data-cid="a0"]');
let b1 = await box('a0');
await p.key('ArrowRight', 'ArrowRight', 39, 2); await p.sleep(700);
let b2 = await box('a0');
ok('Ctrl+Right: one pixel wider', near(b2.w - b1.w, 1, 0.3), (b2.w - b1.w).toFixed(2));
await p.key('ArrowUp', 'ArrowUp', 38, 2); await p.sleep(700);
const b3 = await box('a0');
ok('Ctrl+Up: one pixel shorter', near(b2.h - b3.h, 1, 0.3), (b2.h - b3.h).toFixed(2));
await p.key('ArrowDown', 'ArrowDown', 40, 10); await p.sleep(700);
ok('Ctrl+Shift+Down: to the next quarter step', (await look('a0')).h === 0.75, JSON.stringify(await look('a0')));
const undoN = await E('undoStack.length');
await p.key('ArrowDown', 'ArrowDown', 40, 10); await p.sleep(100);
const held = await E(`(() => { const t = document.querySelector('#view .tile[data-cid="a0"]'); return t.dataset.h || '1'; })()`);
ok('a held key shows at once, before it is kept', held === '1' && await E('undoStack.length') === undoN, held);
await p.sleep(700);
ok('quick repeats are one undo step', await E('undoStack.length') === undoN, (await E('undoStack.length')) + ' vs ' + undoN);
ok('Ctrl+Shift+Down again: one tile tall', (await J('cellSize("a0")')).h === 1, JSON.stringify(await look('a0')));
await E('undo()'); await p.sleep(500);
ok('undo brings the size back', (await look('a0')).h !== undefined, JSON.stringify(await look('a0')));

// ---- quick sizes: width and height in quarter steps, smaller and bigger ----
ok('quick sizes: a width and a height row, 0.25 to 2 in quarter steps', await E(`[...document.querySelectorAll('#insp .seg.qs[data-lay="cw"] button')].map(b => b.textContent).join(' ') === '.25 .5 .75 1 1.25 1.5 1.75 2' && document.querySelectorAll('#insp .seg.qs[data-lay="ch"] button').length === 8`));
await click('#insp .seg[data-lay="cw"] button[data-v="1"]'); await click('#insp .seg[data-lay="ch"] button[data-v="0.75"]');
ok('one click each: 1 by 0.75', JSON.stringify(await J('cellSize("a0")')) === '{"w":1,"h":0.75}' && await E(`document.querySelector('#insp .seg[data-lay="ch"] button.on').dataset.v === '0.75'`), JSON.stringify(await look('a0')));
await click('#insp .seg[data-lay="ch"] button[data-v="1.25"]');
ok('and 1 by 1.25', JSON.stringify(await J('cellSize("a0")')) === '{"w":1,"h":1.25}', JSON.stringify(await look('a0')));
await click('#insp .seg[data-lay="ch"] button[data-v="1"]');
ok('1 by 1: a normal tile again (nothing kept)', !(await look('a0')).w && !(await look('a0')).h, JSON.stringify(await look('a0')));

// ---- the corner: quarter steps, Alt for any size ----
const one = await box('a0');
let seen = await dragCorner('a0', Math.round(one.w * 0.3), 0);
ok('the corner snaps to a quarter step (1.3 wide becomes 1.25)', (await look('a0')).w === 1.25, JSON.stringify(await look('a0')) + ' ' + seen.pill);
ok('the size shows while dragging', /1\.25 x 1 tiles/.test(seen.pill), seen.pill);
const s0 = await box('a0');
seen = await dragCorner('a0', 37, 23, true);
const s1 = await box('a0');
ok('Alt: any size, to the pixel', near(s1.w - s0.w, 37, 1) && near(s1.h - s0.h, 23, 1), (s1.w - s0.w).toFixed(1) + ' x ' + (s1.h - s0.h).toFixed(1) + ' ' + JSON.stringify(await look('a0')));
ok('Alt: nothing snapped', seen.lines === 0, JSON.stringify(seen));
await click('#insp .seg[data-lay="cw"] button[data-v="1"]'); await click('#insp .seg[data-lay="ch"] button[data-v="1"]');

// ---- level with the column beside it: Right (one row) is shorter than Left (two rows) ----
let cb = await colBottoms();
ok('Right ends higher than Left to start with', cb[1] < cb[0] - 50, JSON.stringify(cb));
const r0 = await box('b0');
seen = await dragCorner('b0', 0, Math.round(cb[0] - cb[1] - 4));   // 4 px short of level
cb = await colBottoms();
ok('the corner snaps the column level with the one beside it', near(cb[0], cb[1], 1), JSON.stringify(cb) + ' ' + seen.pill);
ok('a line shows what it snapped to', seen.lines >= 1 && /level with the column beside it/.test(seen.pill), JSON.stringify(seen));
await E('undo()'); await p.sleep(500);
cb = await colBottoms();
ok('undo: the column back where it was', cb[1] < cb[0] - 50, JSON.stringify(cb));

// ---- a category: all its tiles at once, and Fit the row ----
await click('#view .dcat[data-cat="b"] .cn');
await E(`(() => { const i = document.querySelector('#insp input[data-csz="h"]'); i.value = '0.8'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await p.sleep(600);
ok('height 0.8 for all its tiles', (await look('b0')).h === 0.8 && (await look('b1')).h === 0.8, JSON.stringify([await look('b0'), await look('b1')]));
await click('#view .dcat[data-cat="b"] .cn');
await click('#insp button[data-lay="fitrow"]'); await p.sleep(500);
cb = await colBottoms();
ok('Fit the row: Right now ends level with Left', near(cb[0], cb[1], 1), JSON.stringify(cb) + ' ' + JSON.stringify(await look('b0')));
const fb = await J('[cellSize("b0"), cellSize("b1")]');
ok('Fit the row: its tiles got taller, the same for both', fb[0].h > 1 && fb[0].h === fb[1].h, JSON.stringify(fb));

// ---- a tall tile in the last row is two tiles tall (it used to be one and a bit) ----
const c1 = await box('c1');
await E(`mutate(() => setSize('c2', 1, 2))`); await p.sleep(600);
const c2 = await box('c2');
ok('Tall in the last row: two tiles and a gap', near(c2.h, 2 * c1.h + g, 1), c2.h + ' vs ' + (2 * c1.h + g));

// ---- packing: no tile over another, all inside their category ----
await E(`mutate(() => { setSize('a1', 0.5, 0.5); setSize('a2', 0.5, 0.5); setSize('a3', 2, 1.3); setSize('a4', 0.75, 1.75); })`); await p.sleep(700);
const over = await E(`(() => { let n = 0; for (const tg of document.querySelectorAll('#view .tg')) { const b = tg.getBoundingClientRect(), ts = [...tg.children].map(t => t.getBoundingClientRect());
  for (let i = 0; i < ts.length; i++) { const a = ts[i]; if (a.left < b.left - 0.5 || a.right > b.right + 0.5 || a.top < b.top - 0.5 || a.bottom > b.bottom + 0.5) n++;
    for (let j = i + 1; j < ts.length; j++) { const c = ts[j]; if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) n++; } } } return n; })()`);
ok('mixed sizes: no tile over another, all inside their category', over === 0, over);
const hole = await E(`(() => { const a = document.querySelector('#view .tile[data-cid="a1"]').getBoundingClientRect(), b = document.querySelector('#view .tile[data-cid="a2"]').getBoundingClientRect(); return Math.abs(a.top - b.top) < 1 || Math.abs(a.left - b.left) < 1; })()`);
ok('two half tiles share one place', hole);

// ---- a very small tile shows its value, nothing sticks out ----
await E(`mutate(() => setSize('a5', 0.25, 0.25))`); await p.sleep(700);
const tiny = await E(`(() => { const t = document.querySelector('#view .tile[data-cid="a5"]'), r = t.getBoundingClientRect(), v = t.querySelector('.tv').getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), only: t.classList.contains('l0'), inside: v.width > 0 && v.left >= r.left - 0.5 && v.right <= r.right + 0.5 && v.top >= r.top - 0.5 && v.bottom <= r.bottom + 0.5 }; })()`);
ok('a 0.25 x 0.25 tile shows just its value, inside the tile', tiny.only && tiny.inside, JSON.stringify(tiny));
const mid = await E(`(() => { mutate(() => setSize('a5', 1, 0.6)); return 1; })()`); await p.sleep(700);
const m = await E(`(() => { const t = document.querySelector('#view .tile[data-cid="a5"]'); return { cls: t._fit, graph: getComputedStyle(t.querySelector('canvas')).display, over: t.scrollHeight > t.clientHeight + 1 }; })()`);
ok('a short tile (0.6 tall): name and value on one line, no graph, nothing cut', /l1/.test(m.cls) && m.graph === 'none' && !m.over, JSON.stringify(m));

// ---- the same sizes out of edit mode; Overview and Grid as they were ----
const ed = await box('a3');
await E('setEdit(false)'); await p.sleep(900);
const vw = await box('a3');
ok('out of edit mode: the same size', near(ed.w, vw.w, 1) && near(ed.h / ed.w, vw.h / vw.w, 0.02), JSON.stringify([ed, vw]));
await E(`showScreen('overview')`); await p.sleep(800);
ok('Overview: no tile sizes', await E(`!document.querySelector('#view .tg')`));
await E(`showScreen('tiles')`); await p.sleep(800);

// ---- saved ----
await p.sleep(800);
const st = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
ok('saved: the sizes are in state.json', st.L.views.tiles.cell.a3.w === 2 && st.L.views.tiles.cell.a3.h === 1.3, JSON.stringify(st.L.views.tiles.cell.a3));

// ---- Starts a new row, from a tile's settings: kept, drawn, undone ----
await E(`(() => { setEdit(true); showScreen('tiles', true); return 1; })()`); await p.sleep(900); await E('selectCell("a3")'); await p.sleep(400);
await E(`(() => { const b = document.querySelector('#insp input[data-lay="nl"]'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await p.sleep(600);
ok('Starts a new row: kept in the layout, the tile marked, saved through a reload of the layout', (await look('a3')).nl === true && await E(`document.querySelector('#view .tile[data-cid="a3"]').dataset.nl === '1' && cleanLayout(JSON.parse(JSON.stringify(S.L))).views.tiles.cell.a3.nl === true`), JSON.stringify(await look('a3')));
ok('it goes under the tiles before it', await E(`(() => { const t = id => document.querySelector('#view .tile[data-cid="' + id + '"]').getBoundingClientRect(); return t('a3').top >= Math.max(t('a0').bottom, t('a1').bottom, t('a2').bottom) - 1 && Math.abs(t('a3').left - t('a0').left) < 2; })()`));
await E('undo()'); await p.sleep(500);
ok('undo takes it away', !(await look('a3')).nl && await E(`!document.querySelector('#view .tile[data-cid="a3"]').dataset.nl`), JSON.stringify(await look('a3')));
ok('no page errors', errs.length === 0, JSON.stringify(errs));
await p.cmd('Emulation.clearDeviceMetricsOverride');
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
p.close(); process.exit(0);
