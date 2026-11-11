// Tile sizes (1.3; 2.2: a tile's width is a share of its row, shown as a %, its height in rows; tiles per row went; no
// tile drawn under TILE_MIN): the data, the packing, the minimum, the corner (snaps and Alt), the numbers in the panel
// (a % and rows, no px), Ctrl+arrows, a category's size, Fit the row, undo, saving, small tiles, names and captions that
// fit. Start a fresh copy first (an EMPTY data folder):
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
const field = (k, v) => E(`(() => { const i = document.querySelector('#insp input[data-sz="${k}"]'); i.value = '${v}'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const colBottoms = () => E(`[...document.querySelectorAll('#view .lrow[data-r="0"] > .lcol')].map(c => { const ks = [...c.children].filter(e => e.classList.contains('dcat')); return Math.round(ks[ks.length - 1].getBoundingClientRect().bottom * 10) / 10; })`);
const tgW = c => E(`document.querySelector('#view .dcat[data-cat="${c}"] .tg').getBoundingClientRect().width`);
// a corner dragged by dx, dy in steps (Alt held when asked); returns the size shown while dragging, and the snap lines
async function dragCorner(cid, dx, dy, alt) {
  await click(`#view .tile[data-cid="${cid}"]`);
  const c = await p.center(`#view .tile[data-cid="${cid}"] .corner`);
  const insp0 = await E(`document.querySelector('.insp').classList.contains('open')`);
  const m = alt ? 1 : 0;
  await mouse('mouseMoved', c.x, c.y, 0, m); await mouse('mousePressed', c.x, c.y, 1, m);
  for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', c.x + dx * i / 10, c.y + dy * i / 10, 1, m); await p.sleep(16); }
  await p.sleep(120);
  const seen = await E(`({ pill: document.querySelector('.lpill').textContent, lines: [...document.querySelectorAll('.sguide.on')].length, insp: document.querySelector('.insp').classList.contains('open') })`);
  await mouse('mouseReleased', c.x + dx, c.y + dy, 0, m); await p.sleep(700);
  seen.insp0 = insp0; seen.insp1 = await E(`document.querySelector('.insp').classList.contains('open')`);
  return seen;
}

ok('catalog arrives', await until('READ.length > 200 && feed.got'), await E('READ.length'));
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }); await p.sleep(400);
await E('window.dispatchEvent(new Event("resize"))'); await p.sleep(500);

// ---- the data: a share of its row (2.2), older sizes in tiles kept, the named ones by name, anything else dropped ----
const cl = await J(`cleanLayout({ v: 1, cats: [{ id: 'a', name: 'A', cells: ['x', 'y', 'z', 'q', 'r', 's', 't', 'u'] }], cells: Object.fromEntries(['x', 'y', 'z', 'q', 'r', 's', 't', 'u'].map((k, i) => [k, { key: READ[i].key }])),
  views: { tiles: { cell: { x: { w: 1.5, h: 0.70004 }, y: { w: 2, h: 1 }, z: { w: 1, h: 1 }, q: { w: 5, h: -1 }, r: { w: 'x', size: 'huge' }, s: { f: 0.33334, h: 2 }, t: { f: 7 }, u: { f: -1 } } }, overview: { cell: { x: { w: 2 } } } } }).views`);
ok('sizes: a share kept (33.33% snapped, over 100% is 100%, a bad one dropped), an older size in tiles kept, a named one by its name, 1 x 1 and junk dropped',
  JSON.stringify(cl.tiles.cell) === '{"x":{"w":1.5,"h":0.7},"y":{"size":"wide"},"q":{"w":2,"h":0.25},"s":{"f":0.3333,"h":2},"t":{"f":1}}', JSON.stringify(cl.tiles.cell));
ok('sizes only in Tiles', !cl.overview, JSON.stringify(cl.overview));
ok('a size a hair off a quarter step (a snap or a px step) is that step: 0.9999 is 1, 0.7501 is 0.75; 0.7525 stays', await E('szNum(0.9999) === 1 && szNum(0.7501) === 0.75 && szNum(1.2498) === 1.25 && szNum(0.7525) === 0.7525'));
ok('so four tiles of 0.75 (one saved as 0.7501 x 0.9999) and one of 1 still fill a row of 4', await E(`(() => { const L = packTiles([[0.75, 0.9999], [0.75, 1], [0.75, 1], [0.7501, 0.9999], [1, 1]].map(([w, h]) => ({ w: szNum(w), h: szNum(h) })), 4); return L.pos[4].x === 3 && L.pos[4].y === 0 && L.H === 1; })()`));
ok('a tile that starts a new row goes under the ones before it, and the ones after it too (no filling the hole above)', await E(`(() => { const L = packTiles([{ w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 1, h: 1, nl: true }, { w: 1, h: 1 }, { w: 1, h: 1 }], 4);
  return L.pos.slice(4).map(p => p.x + ',' + p.y).join(' ') === '0,1 1,1 2,1' && L.H === 2; })()`));
ok('without it the next tile fills the end of the row', await E('packTiles([{ w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 1, h: 1 }], 4).pos[4].y === 0'));
ok('a share under a quarter place still packs into a hole its size (2.2)', await E('(() => { const L = packTiles([{ w: 0.8, h: 1 }, { w: 3, h: 1 }, { w: 0.2, h: 1 }], 4); return L.pos[2].x === 3.8 && L.pos[2].y === 0 && L.H === 1; })()'));
// ---- 2.1: a row of normal tiles (2.2: or of one share each) that leaves room at its end shares it out ----
const N = n => Array.from({ length: n }, () => ({ w: 1, h: 1 }));
ok('seven normal tiles, four to a row: the three under them are drawn 4/3 wide, side by side (placed as they are)', await E(`(() => { const L = placeTiles(${JSON.stringify(N(7))}, Array(7).fill(8.6), 4, 0.62); const q = L.pos.slice(4); return L.pos.slice(0, 4).every(p => p.dw == null) && q.every((p, i) => Math.abs(p.dw - 4 / 3) < 1e-9 && Math.abs(p.dx - i * 4 / 3) < 1e-9 && p.x === i && p.w === 1); })()`));
ok('seven tiles of 25% (a category of 4 per row before 2.2): the same', await E(`(() => { const s = Array.from({ length: 7 }, () => ({ w: 1.5, h: 1, f: 0.25, auto: false })); const L = placeTiles(s, Array(7).fill(8.6), 6, 0.62); return L.pos.slice(4).every((p, i) => Math.abs(p.dw - 2) < 1e-9 && Math.abs(p.dx - i * 2) < 1e-9); })()`));
ok('five: the one under them takes the whole row', await E(`(() => { const L = placeTiles(${JSON.stringify(N(5))}, Array(5).fill(8.6), 4, 0.62); return L.pos[4].dw === 4 && L.pos[4].dx === 0; })()`));
ok('a category of one row with room left stays as it is (no row fills the width to go by)', await E(`placeTiles(${JSON.stringify(N(3))}, Array(3).fill(8.6), 4, 0.62).pos.every(p => p.dw == null)`));
ok('a row with a tile of its own size stays as you set it', await E(`(() => { const s = ${JSON.stringify(N(6))}; s[5] = { w: 0.75, h: 1 }; const L = placeTiles(s, Array(6).fill(8.6), 4, 0.62); return L.pos.every(p => p.dw == null); })()`));
ok('a row a taller tile reaches into stays as it is', await E(`(() => { const s = ${JSON.stringify(N(7))}; s[0] = { w: 1, h: 2 }; const L = placeTiles(s, Array(7).fill(8.6), 4, 0.62); return L.pos.filter(p => p.y >= 1 - 1e-6).every(p => p.dw == null); })()`));
ok('sizes in thirds: 1.3333 is 4/3 and 0.6667 is 2/3 (three of 4/3 fill a row of 4), 0.34 stays', await E('szNum(1.3333) === 4 / 3 && szNum(0.6667) === 2 / 3 && szNum(0.34) === 0.34 && packTiles([{ w: 4 / 3, h: 1 }, { w: 4 / 3, h: 1 }, { w: 4 / 3, h: 1 }, { w: 1, h: 1 }], 4).pos[3].y === 1'));
ok('and the packing takes a tile a hair too big for a spot (no hole, no tile pushed down)', await E('(() => { const L = packTiles([{ w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.75, h: 1 }, { w: 0.7501, h: 1 }, { w: 1, h: 1 }], 4); return L.pos[4].y === 0 && L.H === 1; })()'));
// ---- the minimum (2.2): a tile that would be drawn narrower, and those sharing its rows, split them evenly ----
const F4 = Array.from({ length: 4 }, () => ({ w: 1, h: 1, f: 0.25, auto: false }));
ok('the minimum: four of 25% where two fit go two and two', await E(`floorSz(${JSON.stringify(F4)}, 4, 330, 8, 13).map(s => s.w).join() === '2,2,2,2'`), await E(`floorSz(${JSON.stringify(F4)}, 4, 330, 8, 13).map(s => s.w).join()`));
ok('where they fit, as they are', await E(`floorSz(${JSON.stringify(F4)}, 4, 700, 8, 13).map(s => s.w).join() === '1,1,1,1'`));
const BAND = [{ w: 7 / 3, h: 2, f: 0.5833, auto: false }, { w: 5 / 3, h: 1, f: 0.4167, auto: false }, { w: 5 / 3, h: 1, f: 0.4167, auto: false }];
ok('58% two rows high beside two of 42%: half and half where two fit (no hole), the whole row where one fits', await E(`floorSz(${JSON.stringify(BAND)}, 4, 330, 8, 13).map(s => s.w).join() === '2,2,2' && floorSz(${JSON.stringify(BAND)}, 4, 300, 8, 13).map(s => s.w).join() === '4,4,4'`));
ok('normal tiles are their category\'s to place: not changed', await E(`floorSz(${JSON.stringify(N(4).map(s => Object.assign(s, { auto: true })))}, 4, 330, 8, 13).map(s => s.w).join() === '1,1,1,1'`));
// (the review before 2.2: a row you sized among normal ones is not stretched; a too narrow tile among normal ones keeps
// the order; shares kept to 4 decimals still fill a row)
ok('a row of 25% tiles with one you sized by hand (25% too) is drawn as set, not spread out', await E(`(() => { const s = Array.from({ length: 7 }, () => ({ w: 1, h: 1, f: 0.25, auto: false })); s[6].fx = true; const L = placeTiles(s, Array(7).fill(8.6), 4, 0.62); return L.pos.slice(4).every(p => p.dw == null) && placeTiles(s.map(x => Object.assign({}, x, { fx: false })), Array(7).fill(8.6), 4, 0.62).pos[4].dw > 1; })()`));
ok('a last row you sized yourself is drawn as you sized it (not stretched)', await E(`(() => { const s = [{ w: 1, h: 1 }, { w: 1, h: 1 }, { w: 1, h: 1 }, { w: 1, h: 1, f: 0.3333, auto: false }]; return placeTiles(s, Array(4).fill(8.6), 3, 0.62).pos[3].dw == null; })()`));
ok('a too narrow tile among normal ones: those rows split evenly with it, the order kept', await E(`(() => { const a = () => ({ w: 1, h: 1, auto: true }), s = [a(), a(), { w: 0.75, h: 1, f: 0.25, auto: false }, a(), a()], o = floorSz(s, 3, 520, 8, 13), L = packTiles(o, 3); return o.map(x => x.w).join() === '1,1,1,1,1' && L.pos[2].y === 0 && L.pos[3].y === 1; })()`));
ok('six of 16.67% and seven of 14.29% fill one row at any number of places (shares kept to 4 decimals)', await E(`[6, 12, 24].every(k => packTiles(Array.from({ length: 6 }, () => ({ w: 0.1667 * k, h: 1 })), k).H === 1) && [7, 14].every(k => packTiles(Array.from({ length: 7 }, () => ({ w: 0.1429 * k, h: 1 })), k).H === 1)`));

// ---- a layout: Left (6 tiles, 3 a row) beside Right (2 tiles, 2 a row), then Low (3 tiles, 3 a row): tiles per row,
// as before 2.2, read as shares ----
await E(`(() => {
  const t = READ.filter(r => r.t === 'temp').map(r => r.key), L = { v: 1, cats: [], cells: {} };
  const mk = (id, n, from) => { const ids = []; for (let i = 0; i < n; i++) { L.cells[id + i] = { key: t[from + i], graph: true }; ids.push(id + i); } L.cats.push({ id, name: id === 'a' ? 'Left' : id === 'b' ? 'Right' : 'Low', collapsed: false, cells: ids }); };
  mk('a', 6, 0); mk('b', 2, 6); mk('c', 3, 8);
  L.views = { tiles: { rows: [{ cols: [{ w: 6, stack: ['a'] }, { w: 6, stack: ['b'] }] }, { cols: [{ stack: ['c'] }] }], cat: { a: { per: 3 }, b: { per: 2 }, c: { per: 3 } } } };
  S.L = cleanLayout(L); S.edit = true; app.classList.add('editing'); sel = null; selCat = null; showScreen('tiles', true); afterChange();
})()`);
await p.sleep(1500);
ok('tiles per row read as shares: Left 33.33%, Right 50%, Low 33.33%, and no tiles per row kept (2.2)', JSON.stringify(await J('[cellSize("a0").f, cellSize("a5").f, cellSize("b1").f, cellSize("c2").f]')) === '[0.3333,0.3333,0.5,0.3333]' && !(await J('S.L.views.tiles.cat')), JSON.stringify(await J('S.L.views.tiles')));

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

// ---- six tiles of 33.33%: a plain grid, three a row, each a third of the row and one tile high ----
const g0 = await E(`(() => { const tg = document.querySelector('#view .dcat[data-cat="a"] .tg'), b = tg.getBoundingClientRect(), g = 0.62 * parseFloat(document.documentElement.style.fontSize);
  const ts = [...tg.children].map(t => t.getBoundingClientRect()), p = (b.width + g) / 3, q = ts[0].height + g;
  return { packed: tg.classList.contains('pk'), bad: ts.filter((r, i) => Math.abs(r.left - b.left - (i % 3) * p) > 0.6 || Math.abs(r.top - b.top - Math.floor(i / 3) * q) > 0.6 || Math.abs(r.width - (p - g)) > 0.6).length }; })()`);
ok('33.33% tiles: three a row, a plain grid in reading order', g0.packed && g0.bad === 0, JSON.stringify(g0));

// ---- the panel: its width as a % of its row, its height in rows; no px ----
await click('#view .tile[data-cid="a0"]');
const g = await E('0.62 * parseFloat(document.documentElement.style.fontSize)'), aw = await tgW('a');
ok('its settings: a width in % (33.3) and a height in rows, no px', await E(`!!document.querySelector('#insp input[data-sz="h"]') && !document.querySelector('#insp input[data-sz="pw"], #insp input[data-sz="ph"]')`) && await E(`document.querySelector('#insp input[data-sz="f"]').value`) === '33.3', await E(`document.querySelector('#insp input[data-sz="f"]').value`));
await field('f', '50'); await p.sleep(600);
let a0b = await box('a0');
ok('width 50% from the panel: half its row', (await look('a0')).f === 0.5 && near(a0b.w, 0.5 * (aw + g) - g, 1), JSON.stringify({ look: await look('a0'), now: a0b.w, want: 0.5 * (aw + g) - g }));
await field('h', '1.5'); await p.sleep(600);
ok('height 1.5 rows from the panel', (await look('a0')).h === 1.5 && (await box('a0')).h > (await box('a1')).h * 1.3, JSON.stringify(await look('a0')));
await field('f', '120'); await p.sleep(250);
ok('a typed 120: 100%, the field and the 100% chip flash', await E(`(() => { const i = document.querySelector('#insp input[data-sz="f"]'), c = [...document.querySelectorAll('#insp [data-lay="cf"] button.szfl')]; return i.value === '100' && i.classList.contains('szfl') && c.length === 1 && c[0].dataset.v === '100'; })()`),
  await E(`document.querySelector('#insp input[data-sz="f"]').value + ' ' + document.querySelector('#insp input[data-sz="f"]').className + ' ' + [...document.querySelectorAll('#insp .szfl')].length`));
await p.sleep(900);
ok('the flash goes', await E(`!document.querySelector('#insp .szfl')`));
await field('f', '50'); await p.sleep(250);
ok('a typed 50, kept as typed: no flash', await E(`(() => { const i = document.querySelector('#insp input[data-sz="f"]'); return i.value === '50' && !document.querySelector('#insp .szfl'); })()`), await E(`document.querySelector('#insp input[data-sz="f"]').value`));
await p.sleep(600);

// ---- Ctrl+arrows: 1% of its row; with Shift the next share; a pixel taller or shorter, with Shift a quarter row ----
await click('#view .tile[data-cid="a0"]');
let b1 = await box('a0');
await p.key('ArrowRight', 'ArrowRight', 39, 2); await p.sleep(700);
let b2 = await box('a0');
ok('Ctrl+Right: 1% of its row wider', near((await look('a0')).f, 0.51, 0.0002) && near(b2.w - b1.w, 0.01 * (aw + g), 0.6), JSON.stringify(await look('a0')) + ' ' + (b2.w - b1.w).toFixed(2));
await p.key('ArrowRight', 'ArrowRight', 39, 10); await p.sleep(700);
ok('Ctrl+Shift+Right: the next share, 67%', (await look('a0')).f === 0.6667, JSON.stringify(await look('a0')));
await p.key('ArrowLeft', 'ArrowLeft', 37, 10); await p.sleep(700);
ok('Ctrl+Shift+Left: back to 50%', (await look('a0')).f === 0.5, JSON.stringify(await look('a0')));
b1 = await box('a0');
await p.key('ArrowUp', 'ArrowUp', 38, 2); await p.sleep(700);
const b3 = await box('a0');
ok('Ctrl+Up: one pixel shorter', near(b1.h - b3.h, 1, 0.3), (b1.h - b3.h).toFixed(2));
await p.key('ArrowDown', 'ArrowDown', 40, 10); await p.sleep(700);
ok('Ctrl+Shift+Down: to the next quarter row', (await look('a0')).h === 1.5, JSON.stringify(await look('a0')));
const undoN = await E('undoStack.length');
await p.key('ArrowDown', 'ArrowDown', 40, 10); await p.sleep(100);
const held = await E(`document.querySelector('#view .tile[data-cid="a0"]').dataset.h`);
ok('a held key shows at once, before it is kept', held === '1.75' && await E('undoStack.length') === undoN, held);
await p.sleep(700);
ok('quick repeats are one undo step', await E('undoStack.length') === undoN + 1, (await E('undoStack.length')) + ' vs ' + undoN);
ok('Ctrl+Shift+Down again: 1.75 rows', (await look('a0')).h === 1.75, JSON.stringify(await look('a0')));
await E('undo()'); await p.sleep(500);
ok('undo brings the size back', (await look('a0')).h === 1.5, JSON.stringify(await look('a0')));

// ---- quick sizes: the shares and the heights in rows ----
await click('#view .tile[data-cid="a0"]');
ok('quick sizes: Auto 25 33 50 67 75 100% and 0.5 0.75 1 1.5 2 (11-06: Auto and 0.75 added)', await E(`[...document.querySelectorAll('#insp .seg.qs[data-lay="cf"] button')].map(b => b.textContent).join(' ') === 'Auto 25% 33% 50% 67% 75% 100%' && [...document.querySelectorAll('#insp .seg.qs[data-lay="ch"] button')].map(b => b.textContent).join(' ') === '0.5 0.75 1 1.5 2' && document.querySelector('#insp .seg[data-lay="cf"] button.on').dataset.v === '50'`));
await click('#insp .seg[data-lay="cf"] button[data-v="25"]'); await click('#insp .seg[data-lay="ch"] button[data-v="0.5"]');
ok('one click each: 25% by 0.5 rows, its buttons on', JSON.stringify(await look('a0')) === '{"f":0.25,"h":0.5,"fx":true}' && await E(`document.querySelector('#insp .seg[data-lay="ch"] button.on').dataset.v === '0.5' && document.querySelector('#insp .seg[data-lay="cf"] button.on').dataset.v === '25'`), JSON.stringify(await look('a0')));
await click('#insp .seg[data-lay="ch"] button[data-v="1"]');
ok('1 row: no height kept, its share stays', JSON.stringify(await look('a0')) === '{"f":0.25,"fx":true}', JSON.stringify(await look('a0')));
await E(`handleDblclick(document.querySelector('#view .tile[data-cid="a0"] .corner'))`); await p.sleep(500);
ok('a double-click on its corner: a normal tile again (nothing kept)', JSON.stringify(await look('a0')) === '{}', JSON.stringify(await look('a0')));
await E(`selectCell('a0')`); await p.sleep(300);
await click('#insp .seg[data-lay="cf"] button[data-v="33.3333"]');
ok('33%: exactly a third (33.33%), as its neighbours', (await look('a0')).f === 0.3333, JSON.stringify(await look('a0')));

// ---- the corner: the shares, Alt for any size ----
const one = await box('a0');
let seen = await dragCorner('a0', Math.round((aw + g) * 0.13), 0);
ok('the corner snaps to a share (46% becomes 50%)', (await look('a0')).f === 0.5, JSON.stringify(await look('a0')) + ' ' + seen.pill);
ok('the size shows while dragging, as a % and rows', /^50% x 1 rows/.test(seen.pill), seen.pill);
// (11-10, his "the menu should also hide when resizing a cell")
ok('the tile\'s settings are out before, away while its corner is held, and back when it is let go', seen.insp0 === true && seen.insp === false && seen.insp1 === true, JSON.stringify([seen.insp0, seen.insp, seen.insp1]));
// (and Storage, pinned out: away too while a corner is held, back after; his 11-11 "it should hide storage too,
// obviously since move hides it". A tile clear of both drawers: Storage on the left, the settings on the other side)
{
  const pin0 = await E('DR.L.pinned'), snap0 = await E('snapOf()');
  await E(`(() => { DR.L.pinned = true; syncDrawers(); return 1; })()`); await p.sleep(450);
  const q = await J(`(() => { const sr = document.querySelector('.storage').getBoundingClientRect(), lo = sr.right + 12, hi = innerWidth - 330; for (const t of document.querySelectorAll('#view .tile')) { const r = t.getBoundingClientRect(); if (sr.left < innerWidth / 2 && r.left > lo && r.right < hi && r.top > 60 && r.bottom < innerHeight - 20) return { cid: t.dataset.cid, x: r.left + r.width / 2, y: r.top + r.height / 2 }; } return null; })()`);
  if (!q) ok('a tile clear of Storage and of the settings, for the corner held with Storage out', false, JSON.stringify(await J(`[innerWidth, document.querySelector('.storage').getBoundingClientRect().right, [...document.querySelectorAll('#view .tile')].map(t => Math.round(t.getBoundingClientRect().left) + '-' + Math.round(t.getBoundingClientRect().right))]`)));
  else {
    await p.click(q.x, q.y); await p.sleep(450);
    const c = await p.center(`#view .tile[data-cid="${q.cid}"] .corner`);
    const both = () => J(`[document.querySelector('.storage').classList.contains('open'), document.querySelector('.insp').classList.contains('open')]`);
    const b0 = await both();
    await mouse('mouseMoved', c.x, c.y, 0); await mouse('mousePressed', c.x, c.y, 1);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', c.x + 4 * i, c.y, 1); await p.sleep(16); }
    await p.sleep(150); const b1 = await both();
    await mouse('mouseReleased', c.x + 24, c.y, 0); await p.sleep(700); const b2 = await both();
    ok('Storage pinned out and the tile\'s settings: both away while its corner is held, both back when it is let go', JSON.stringify([b0, b1, b2]) === '[[true,true],[false,false],[true,true]]', JSON.stringify([b0, b1, b2]));
    await E('(() => { while (snapOf() !== ' + JSON.stringify(snap0) + ' && undoStack.length) undo(); return 1; })()'); await p.sleep(300);   // (the size it got: back, the checks after this count on the layout)
  }
  await E(`(() => { DR.L.pinned = ${pin0 ? 'true' : 'false'}; DR.L.hover = false; syncDrawers(); return 1; })()`); await p.sleep(450);
}
// (11-11, his "all cells move to adapt the window but only when I'm done dragging": the view was fitted only when the
// corner was let go. It is fitted while the corner is held; letting go moves nothing more; Undo goes back to the size
// the view had before, Redo to the one it was let go at)
{
  const now = () => J(`(() => { const t = document.querySelector('#view .tile[data-cid="a0"]'), r = t.getBoundingClientRect(); return { fs: parseFloat(document.documentElement.style.fontSize), fits: sectionsEl.scrollHeight <= sectionsEl.clientHeight, h: +(t.dataset.h || 1), box: [Math.round(r.top), Math.round(r.bottom), Math.round(r.right)] }; })()`);
  const snap0 = await E('snapOf()');
  await click(`#view .tile[data-cid="a0"]`);
  const c = await p.center(`#view .tile[data-cid="a0"] .corner`), was = await now();
  await mouse('mouseMoved', c.x, c.y, 0); await mouse('mousePressed', c.x, c.y, 1);
  for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', c.x, c.y + 20 * i, 1); await p.sleep(16); }
  await p.sleep(200);
  const held = await now();
  await mouse('mouseReleased', c.x, c.y + 240, 0); await p.sleep(800);
  const after = await now();
  ok('a corner pulled down 240 px: the tile is taller, and the view is fitted while it is held (nothing under the window, the text no larger than before)', held.h > was.h && held.fits && held.fs <= was.fs + 1e-6, JSON.stringify([was, held]));
  ok('letting it go moves nothing: the same text size, the tile where it was while held', Math.abs(after.fs - held.fs) < 1e-6 && after.fits && JSON.stringify(after.box) === JSON.stringify(held.box) && after.h === held.h, JSON.stringify([held, after]));
  await E('undo()'); await p.sleep(700);
  const un = await now();
  ok('Undo: the view as it was, at the very size it had before the corner was held', await E('snapOf()') === snap0 && Math.abs(un.fs - was.fs) < 1e-6 && JSON.stringify(un.box) === JSON.stringify(was.box), JSON.stringify([was, un]));
  await E('redo()'); await p.sleep(700);
  const re = await now();
  ok('Redo: the size and the place it was let go at', Math.abs(re.fs - after.fs) < 1e-6 && JSON.stringify(re.box) === JSON.stringify(after.box), JSON.stringify([after, re]));
  await E('undo()'); await p.sleep(700);
}
const s0 = await box('a0');
seen = await dragCorner('a0', 37, 23, true);
const s1 = await box('a0');
ok('Alt: any size, to the pixel', near(s1.w - s0.w, 37, 1) && near(s1.h - s0.h, 23, 1), (s1.w - s0.w).toFixed(1) + ' x ' + (s1.h - s0.h).toFixed(1) + ' ' + JSON.stringify(await look('a0')));
ok('Alt: nothing snapped', seen.lines === 0, JSON.stringify(seen));
seen = await dragCorner('a0', -Math.round(aw), 0);
ok('never narrower than the minimum', (await box('a0')).w >= 11.6 * (await E('parseFloat(document.documentElement.style.fontSize)')) - 1, JSON.stringify(await box('a0')) + ' ' + seen.pill);
await E(`selectCell('a0')`); await p.sleep(300);
await click('#insp .seg[data-lay="cf"] button[data-v="33.3333"]'); await click('#insp .seg[data-lay="ch"] button[data-v="1"]');

// ---- level with the column beside it: Right (one row) is shorter than Left (two rows) ----
let cb = await colBottoms();
ok('Right ends higher than Left to start with', cb[1] < cb[0] - 50, JSON.stringify(cb));
seen = await dragCorner('b0', 0, Math.round(cb[0] - cb[1] - 4));   // 4 px short of level
cb = await colBottoms();
ok('the corner snaps the column level with the one beside it', near(cb[0], cb[1], 1), JSON.stringify(cb) + ' ' + seen.pill);
ok('a line shows what it snapped to', seen.lines >= 1 && /level with the column beside it/.test(seen.pill), JSON.stringify(seen));
ok('its width stays (a drag up or down only)', (await look('b0')).f === 0.5, JSON.stringify(await look('b0')));
await E('undo()'); await p.sleep(500);
cb = await colBottoms();
ok('undo: the column back where it was', cb[1] < cb[0] - 50, JSON.stringify(cb));

// ---- a category: all its tiles at once, and Fit the row ----
await click('#view .dcat[data-cat="b"] .cn');
ok('a category: no tiles per row, Width of all 50% lit, Height of all Auto lit (chips, 11-06)', await E(`!document.querySelector('#insp select[data-lay="per"]') && document.querySelector('#insp [data-lay="aw"] button[data-v="50"]').classList.contains('on') && document.querySelector('#insp [data-lay="ah"] button[data-v="auto"]').classList.contains('on')`));
await click('#insp .seg[data-lay="ah"] button[data-v="1.5"]'); await p.sleep(400);
ok('Height of all 1.5: each tile, its share kept', JSON.stringify(await look('b0')) === '{"f":0.5,"h":1.5}' && JSON.stringify(await look('b1')) === '{"f":0.5,"h":1.5}' && await E(`document.querySelector('#insp [data-lay="ah"] button[data-v="1.5"]').classList.contains('on')`), JSON.stringify([await look('b0'), await look('b1')]));
await E('undo()'); await p.sleep(500);
await E(`catSizeInput('b', 'h', 0.8)`); await p.sleep(600);
ok('height 0.8 for all its tiles, their share kept (and whether it was set by hand: a height alone pins no width, 11-06)', JSON.stringify(await look('b0')) === '{"f":0.5,"h":0.8}' && JSON.stringify(await look('b1')) === '{"f":0.5,"h":0.8}', JSON.stringify([await look('b0'), await look('b1')]));
await click('#view .dcat[data-cat="b"] .cn');
await click('#insp button[data-lay="fitrow"]'); await p.sleep(500);
cb = await colBottoms();
ok('Fit the row: Right now ends level with Left', near(cb[0], cb[1], 1), JSON.stringify(cb) + ' ' + JSON.stringify(await look('b0')));
const fb = await J('[cellSize("b0"), cellSize("b1")]');
ok('Fit the row: its tiles got taller, the same for both, their share kept', fb[0].h > 1 && fb[0].h === fb[1].h && fb[0].f === 0.5, JSON.stringify(fb));
await click('#view .dcat[data-cat="b"] .cn');
await click('#insp .seg[data-lay="aw"] button[data-v="100"]'); await p.sleep(600);
ok('width 100% for all its tiles: one under the other', (await look('b0')).f === 1 && (await look('b1')).f === 1 && near((await box('b0')).l, (await box('b1')).l, 1), JSON.stringify([await look('b0'), await look('b1')]));
await E('undo()'); await p.sleep(500);

// ---- a tall tile in the last row is two tiles tall (it used to be one and a bit) ----
const c1 = await box('c1');
await E(`mutate(() => setShare('c2', 1 / 3, 2))`); await p.sleep(600);
const c2 = await box('c2');
ok('Tall in the last row: two tiles and a gap', near(c2.h, 2 * c1.h + g, 1), c2.h + ' vs ' + (2 * c1.h + g));

// ---- packing: no tile over another, all inside their category ----
await E(`mutate(() => { setShare('a1', 1 / 3, 0.5); setShare('a2', 1 / 3, 0.5); setShare('a3', 2 / 3, 1.3); setShare('a4', 1 / 3, 1.75); })`); await p.sleep(700);
const over = await E(`(() => { let n = 0; for (const tg of document.querySelectorAll('#view .tg')) { const b = tg.getBoundingClientRect(), ts = [...tg.children].map(t => t.getBoundingClientRect());
  for (let i = 0; i < ts.length; i++) { const a = ts[i]; if (a.left < b.left - 0.5 || a.right > b.right + 0.5 || a.top < b.top - 0.5 || a.bottom > b.bottom + 0.5) n++;
    for (let j = i + 1; j < ts.length; j++) { const c = ts[j]; if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) n++; } } } return n; })()`);
ok('mixed sizes: no tile over another, all inside their category', over === 0, over);
const hole = await E(`(() => { const a = document.querySelector('#view .tile[data-cid="a1"]').getBoundingClientRect(), b = document.querySelector('#view .tile[data-cid="a2"]').getBoundingClientRect(); return Math.abs(a.top - b.top) < 1 || Math.abs(a.left - b.left) < 1; })()`);
ok('two half-row tiles share one place', hole);

// ---- a very short tile shows its name and value on one line, nothing sticks out ----
await E(`mutate(() => setShare('a5', 1 / 3, 0.25))`); await p.sleep(700);
const tiny = await E(`(() => { const t = document.querySelector('#view .tile[data-cid="a5"]'), r = t.getBoundingClientRect(), v = t.querySelector('.tv').getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), cls: t._fit, inside: v.width > 0 && v.left >= r.left - 0.5 && v.right <= r.right + 0.5 && v.top >= r.top - 0.5 && v.bottom <= r.bottom + 0.5 }; })()`);
ok('a 0.25 rows tall tile shows its value (with its name beside it), inside the tile', /l[01]/.test(tiny.cls) && tiny.inside, JSON.stringify(tiny));
await E(`mutate(() => setShare('a5', 1 / 3, 0.6))`); await p.sleep(700);
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
ok('saved: the sizes are in state.json as shares and rows', st.L.views.tiles.cell.a3.f === 0.6667 && st.L.views.tiles.cell.a3.h === 1.3, JSON.stringify(st.L.views.tiles.cell.a3));

// ---- New row, from a tile's settings (a toggle since 11-06): kept, drawn, undone ----
await E(`(() => { setEdit(true); showScreen('tiles', true); return 1; })()`); await p.sleep(900); await E('selectCell("a3")'); await p.sleep(400);
await click('#insp button[data-lay="nl"]'); await p.sleep(300);
await mouse('mouseMoved', await E('innerWidth / 2'), 12); await p.sleep(600);   // (the pointer off the settings, so they tuck away for what follows)
ok('New row: kept in the layout, the tile marked, saved through a reload of the layout', (await look('a3')).nl === true && await E(`document.querySelector('#view .tile[data-cid="a3"]').dataset.nl === '1' && cleanLayout(JSON.parse(JSON.stringify(S.L))).views.tiles.cell.a3.nl === true`), JSON.stringify(await look('a3')));
ok('it goes under the tiles before it', await E(`(() => { const t = id => document.querySelector('#view .tile[data-cid="' + id + '"]').getBoundingClientRect(); return t('a3').top >= Math.max(t('a0').bottom, t('a1').bottom, t('a2').bottom) - 1 && Math.abs(t('a3').left - t('a0').left) < 2; })()`));
await E('undo()'); await p.sleep(500);
ok('undo takes it away', !(await look('a3')).nl && await E(`!document.querySelector('#view .tile[data-cid="a3"]').dataset.nl`), JSON.stringify(await look('a3')));

// ---- 2.1: a category of 4 per row with 7 tiles (2.2: 25% each): the three under them fill the row; its corner and
// Ctrl+arrows go from what you see ----
await E(`(() => { const t = READ.filter(r => r.t === 'temp').map(r => r.key), L = { v: 1, cats: [{ id: 'f', name: 'Fill', collapsed: false, cells: [] }], cells: {} };
  for (let i = 0; i < 7; i++) { L.cells['f' + i] = { key: t[i], graph: true }; L.cats[0].cells.push('f' + i); }
  L.views = { tiles: { rows: [{ cols: [{ stack: ['f'] }] }], cat: { f: { per: 4 } } } };
  S.L = cleanLayout(L); S.edit = true; app.classList.add('editing'); sel = null; selCat = null; showScreen('tiles', true); afterChange(); return 1; })()`);
await p.sleep(1500);
const fw = await J(`['f0', 'f3', 'f4', 'f5', 'f6'].map(id => { const r = document.querySelector('#view .tile[data-cid="' + id + '"]').getBoundingClientRect(); return [r.left, r.right, r.width]; })`);
ok('seven tiles of 25%: the three under them fill the row, side by side (2.1)', (await look('f6')).f === 0.25 && near(fw[4][1], fw[1][1], 1) && near(fw[2][0], fw[0][0], 1) && near(fw[2][2], fw[3][2], 1) && fw[2][2] > fw[0][2] * 1.25, JSON.stringify(fw.map(x => x.map(Math.round))));
seen = await dragCorner('f6', -30, 0, true);
const f6 = await box('f6'), fwW = await tgW('f');
ok('the corner of the last one, dragged 30 px left: its right edge follows the pointer (not a share off)', near(f6.r, fw[4][1] - 30, 3) && (await look('f6')).f > 0.3, JSON.stringify({ was: Math.round(fw[4][1]), now: Math.round(f6.r), look: await look('f6') }) + ' ' + seen.pill);
await E('undo()'); await p.sleep(700);
ok('undo: drawn wider again', near((await box('f6')).r, fw[4][1], 1), JSON.stringify(await box('f6')));
await click('#view .tile[data-cid="f5"]');
await p.key('ArrowRight', 'ArrowRight', 39, 2); await p.sleep(900);
ok('Ctrl+Right on one drawn a third of the row wide: 1% wider than that, not narrower', (await look('f5')).f > 0.3333 && (await look('f5')).f < 0.36, JSON.stringify(await look('f5')));
await E('undo()'); await p.sleep(500);

// ---- the minimum on a small window: no tile drawn under it, a row of 25% two and two ----
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 470, height: 900, deviceScaleFactor: 1, mobile: false }); await p.sleep(400);
await E('window.dispatchEvent(new Event("resize"))'); await p.sleep(1500);
const small = await E(`(() => { const fs = parseFloat(document.documentElement.style.fontSize), tg = document.querySelector('#view .tg'), W = tg.getBoundingClientRect().width, g = 0.62 * fs, ts = [...document.querySelectorAll('#view .tile')].map(t => t.getBoundingClientRect());
  return { fs, W, quarter: ((W + g) / 4 - g) / fs, narrow: Math.min(...ts.map(r => r.width)) / fs, tops: [...new Set(ts.slice(0, 4).map(r => Math.round(r.top)))].length }; })()`);
ok('a small window where 25% would be under the minimum: no tile narrower than it (11.6rem), the first four two and two', small.quarter < 11.6 && small.narrow >= 11.6 - 0.05 && small.tops === 2, JSON.stringify(small));
ok('its sizes kept as you set them (25%)', (await look('f0')).f === 0.25, JSON.stringify(await look('f0')));
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }); await p.sleep(400);
await E('window.dispatchEvent(new Event("resize"))'); await p.sleep(1200);

// ---- a normal tile made taller with Ctrl+Shift+Down stays a normal tile (its width not pinned as a share, 2.2) ----
await E(`mutate(() => setSize('f2', 1, 1))`); await p.sleep(500);
await E(`(() => { selectCell('f2'); nudgeSize('f2', 0, 1, true); flushNudge(); return 1; })()`); await p.sleep(600);
const f2 = await look('f2');
ok('Ctrl+Shift+Down on a normal tile: taller, still a normal tile (no share, a normal width)', !f2.f && (f2.w || 1) === 1 && f2.h === 1.25 && await E(`!document.querySelector('#view .tile[data-cid="f2"]').dataset.f`), JSON.stringify(f2));

// ---- names: a little smaller where cut (down to 85%), never two lines; one you type: 24 characters at most ----
const nf = await E(`(() => { const sp = document.querySelector('#view .tile[data-cid="f0"] .tn > span'), rg = document.createRange(), K = () => sp.style.fontSize ? parseFloat(sp.style.fontSize) / parseFloat(getComputedStyle(sp.parentElement).fontSize) : 1;
  sp.textContent = 'x'.repeat(300); nameFit(); sp.style.fontSize = ''; const room = sp.getBoundingClientRect().width; rg.selectNodeContents(sp); const cw = rg.getBoundingClientRect().width / 300;   // (the room it has: a name far too long fills it)
  sp.textContent = 'x'.repeat(Math.ceil(room * 1.08 / cw)); nameFit(); rg.selectNodeContents(sp); const a = { k: K(), cut: rg.getBoundingClientRect().width > sp.getBoundingClientRect().width + 0.05 };
  sp.textContent = 'x'.repeat(300); nameFit(); const b = { k: K() };
  sp.textContent = 'Fan'; nameFit(); return { room, a, b, back: sp.style.fontSize }; })()`);
ok('a name 8% too long: a little smaller and whole', nf.a.k > 0.85 && nf.a.k < 1 && !nf.a.cut, JSON.stringify(nf));
ok('a name far too long: no smaller than 85%', near(nf.b.k, 0.85, 0.011), JSON.stringify(nf));
ok('a name that fits: its own size', nf.back === '', JSON.stringify(nf));
await E(`selectCell('f0')`); await p.sleep(300);
ok('a reading\'s name you type: 24 characters at most', await E(`document.querySelector('#insp #iName').maxLength === 24`));

// ---- captions: the shorter words wherever one is cut (2.1.2 tiles, 2.2 everywhere) ----
const capT = await E(`(() => {
  const el = document.createElement('div'); el.className = 'tc'; el.style.width = '60px'; document.body.appendChild(el);
  const F = '15 min max 1,049 RPM', Sh = 'max 1,049 RPM', out = [];
  capSet(el, F, Sh); capMeasure(); out.push(el.textContent);
  capSet(el, F, Sh); out.push(el.textContent);   // (the next second: no measuring, the same words)
  el.style.width = '400px'; el._fit = null; capSet(el, F, Sh); capMeasure(); out.push(el.textContent);
  el.remove(); return out; })()`);
ok('a cut caption takes its shorter words, keeps them without measuring again, and its own when it fits (2.1.2)', capT[0] === 'max 1,049 RPM' && capT[1] === 'max 1,049 RPM' && capT[2] === '15 min max 1,049 RPM', JSON.stringify(capT));
const padT = await E(`(() => { const el = document.createElement('div'); el.style.cssText = 'display:inline-block;white-space:nowrap;padding:0 6px;font:13px sans-serif'; el.textContent = 'from GPU Temperature 62.4 C'; document.body.appendChild(el);
  const r = el.getBoundingClientRect().width; el.style.width = (r - 4) + 'px'; el.style.boxSizing = 'border-box'; el.style.overflow = 'hidden'; const cut = capCut(el); el.remove(); return cut; })()`);
ok('a caption in a cell with padding (a Grid cell): cut when its text is wider than the room inside (2.2)', padT === true);
const subS = await E(`(() => { for (const id in S.L.cells) { const c = S.L.cells[id], r = c.key ? BYKEY.get(c.key) : null; if (!r || isBneck(c) || c.key === GTIME || gfKind(r) || isYN(r) || c.curve || c.pred) continue; const e = evalCell(id, c, true, false); if (/^15 min max /.test(e.sub || '')) return [e.sub, e.subS && e.subS.of, e.subS && e.subS.s]; } return null; })()`);
ok('a reading\'s "15 min max" caption carries its shorter words, "max ..." (2.1.2)', !!subS && subS[1] === subS[0] && subS[2] === subS[0].replace(/^15 min /, ''), JSON.stringify(subS));
ok('a missing reading\'s words have shorter ones (2.2)', await E(`missingShort({ key: 'x.none/none' }).length < 20`));
// (11-10) a tile's narrow wording stands in for a cut caption only when it is shorter: a last session's fps says "avg,
// <game>" on a wide tile and "last avg, <game>" on a narrow one, so a long game name cut on the wide tile keeps "avg, "
const capS = await E(`(() => { const g = 'The Elder Scrolls V: Skyrim Special Edition', fps = { tsub: 'avg, ' + g, tsubS: 'last avg, ' + g, sub: 'last session avg, ' + g }; fps.subS = { of: fps.sub, s: fps.tsubS };
  const gt = { tsub: g + ', ended 2h ago', tsubS: 'ended 2h ago', sub: g + ', ended 2h ago, 3h in 24 h' }; gt.subS = { of: gt.sub, s: gt.tsubS };
  return [capShort(fps, fps.tsub, true), capShort(fps, fps.tsubS, true), capShort(fps, fps.sub, false), capShort(gt, gt.tsub, true), capShort({ sub: 'x' }, 'x', true)]; })()`);
ok('a cut caption\'s stand-in is never longer than it: the fps of a last session keeps "avg, <game>" on a wide tile, Game time drops the name, a list row takes the short line', capS[0] === null && capS[1] === null && capS[2] === 'last avg, The Elder Scrolls V: Skyrim Special Edition' && capS[3] === 'ended 2h ago' && capS[4] === null, JSON.stringify(capS));
await p.sleep(1200);
const cutNow = await E(`[...document.querySelectorAll('#view .tile .tc')].filter(c => c.offsetParent && /^15 min max /.test(c.textContent) && capCut(c)).length`);
ok('no "15 min max" caption left cut in the view', cutNow === 0, String(cutNow));
ok('no page errors', errs.length === 0, JSON.stringify(errs));
await p.cmd('Emulation.clearDeviceMetricsOverride');
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
p.close(); process.exit(0);
