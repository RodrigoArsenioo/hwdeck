// End-to-end check of a fresh HW Deck on made-up data. Start it first:
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9230
//   HWDeck.exe --fake 300 --data test\data1          (an EMPTY data folder: the test expects a first run)
// then: node test/e2e.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9230);
const data = process.argv[3] || 'test/data1';
const out = 'test/out'; mkdirSync(out, { recursive: true });
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(220); };
// Storage and the settings are drawers over the view in edit mode: this test opens Storage when it uses it and shuts both
// when it works in the view (the drawers themselves are checked in e2e-layout.mjs)
const storage = async on => { await E(`(() => { DR.L.pinned = ${on}; DR.L.hover = false; if (!${on}) { DR.R.hover = false; DR.R.byPick = false; } syncDrawers(); })()`); await p.sleep(260); };

// ---- first run ----
ok('catalog arrives', await until('READ.length === 301 && feed.got'), await E('READ.length'));   // 300 made up and HW Deck's own bottleneck
ok('first run is empty, edit mode on', await E('S.L.cats.length === 0 && S.edit && !!document.querySelector("#view.empty")'));
ok('5 empty slots', await E('S.slots.every(s => !s)'));
ok('no extras in HW Deck itself: no extras.js, its own title, its readings have no kind', await E(`!EXT.loaded && !document.querySelector('script[src="extras.js"]') && document.title === "HW Deck" && READ.every(r => r.kind === null)`));
ok('the status is only a dot (its tooltip says demo data)', (await E('$("dot").title')).includes('Demo data') && !(await E('!!document.getElementById("stat")')), await E('$("dot").title'));
ok('Storage draws only the rows in sight', await E('document.querySelectorAll("#vspace .vrow").length < 50 && rows.length > 300'), await E('[document.querySelectorAll("#vspace .vrow").length, rows.length]'));
ok('the type filters wrap instead of hiding (Other is visible)', await E('(() => { const b = [...document.querySelectorAll(".chip")].pop(), r = b.getBoundingClientRect(), s = document.querySelector(".storage").getBoundingClientRect(); return r.right <= s.right && b.textContent.startsWith("Other"); })()'));

// ---- adding ----
await storage(true);
await click('#vspace .vrow.r .add');
ok('+ on a row makes a category named after the sensor', await E('S.L.cats.length === 1 && S.L.cats[0].cells.length === 1 && S.L.cats[0].name.startsWith("CPU")'), await E('S.L.cats.map(c => c.name + ":" + c.cells.length)'));
ok('the new cell gets values', await until('/\\d/.test(document.querySelector("#view .dc .v").textContent)', 5000), await E('document.querySelector("#view .dc .v").textContent'));
await click('.chip[data-t="temp"]');
let c = await p.centerOf('[...document.querySelectorAll("#vspace .vrow.g")].find(g => SENS[+g.dataset.gs].name.startsWith("dGPU")).querySelector(".addall")');
await p.click(c.x, c.y); await p.sleep(250);
ok('Temp filter + "+ all" adds that sensor\'s temperatures as one category', await E('S.L.cats[1].name === "dGPU temp" && S.L.cats[1].cells.every(id => BYKEY.get(S.L.cells[id].key).t === "temp")'), await E('S.L.cats.map(c => c.name + ":" + c.cells.length)'));
await click('.chip[data-t="all"]');
for (let i = 0; i < 3; i++) await E(`addKeys([READ[${40 + i}].key], S.L.cats[0].id, null)`);
await storage(false);

// ---- dragging in Tiles ----
const cat0 = await E('S.L.cats[0].id'), cat1 = await E('S.L.cats[1].id');
const moving = await E('S.L.cats[1].cells[0]');
// both ends measured after one scroll to the top (measuring the second one with a scroll left the first one stale)
await E('sectionsEl.scrollTop = 0'); await p.sleep(150);
const at = sel => E(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
let a = await at(`#view .dc[data-cid="${moving}"]`), b = await at(`#view .dcat[data-cat="${cat0}"] .dc`);
await p.drag(a, { x: b.x - b.w / 2 + 6, y: b.y }); await p.sleep(300);
ok('Tiles: a cell dragged into another category, before its first cell', await E(`S.L.cats[0].cells[0] === "${moving}"`), await E('S.L.cats.map(c => c.cells.length)'));
ok('the dragged cell stays selected, but its settings don\'t open (a drag isn\'t a click)', await E(`sel === "${moving}" && !document.querySelector(".insp").classList.contains("open") && !$("modal").classList.contains("open")`),
  await E('JSON.stringify([sel, DR.R.byPick, document.querySelector(".insp").className])'));
a = await at(`#view .dc[data-cid="${moving}"]`);
await p.click(a.x, a.y); await p.sleep(400);
ok('a click on it then opens its settings', await E(`sel === "${moving}" && document.querySelector(".insp").classList.contains("open")`));
// out of edit mode: a press dragged across a cell and let go on it opens nothing; a plain click opens its popup
await E('(() => { clearSel(); setEdit(false); return 1; })()'); await p.sleep(400);
a = await at(`#view .dc[data-cid="${moving}"]`);
await p.drag({ x: a.x - a.w / 4, y: a.y }, { x: a.x + a.w / 4, y: a.y }); await p.sleep(700);
ok('not editing: a drag across a cell opens no popup', await E('!$("modal").classList.contains("open")'));
await p.click(a.x, a.y); await p.sleep(500);
ok('not editing: a click on it still opens its popup', await E('$("modal").classList.contains("open")'));
await E('(() => { closeDetail(); setEdit(true); return 1; })()'); await p.sleep(400);
await storage(true);
a = await p.centerOf('[...document.querySelectorAll("#vspace .vrow.r")][5]');
const rowKey = await E('[...document.querySelectorAll("#vspace .vrow.r")][5].dataset.key');
b = await p.centerOf(`[...document.querySelectorAll('#view .dcat[data-cat="${cat0}"] .dc')].pop()`);
await p.drag({ x: a.x - 60, y: a.y }, { x: b.x + b.w / 2 - 4, y: b.y }); await p.sleep(300);
await storage(false);
ok('Tiles: a Storage row dragged to the end of a category', await E(`S.L.cells[S.L.cats[0].cells[S.L.cats[0].cells.length - 1]].key === ${JSON.stringify(rowKey)}`));
a = await p.center(`#view .dcat[data-cat="${cat1}"] .grip`); b = await p.center(`#view .dcat[data-cat="${cat0}"]`);
await p.drag(a, { x: b.x, y: b.y }); await p.sleep(300);
ok('Tiles: a category dropped on the middle of another swaps them (the view stays automatic)', await E(`S.L.cats[0].id === "${cat1}" && !(S.L.views && S.L.views.tiles && S.L.views.tiles.rows)`), await E('S.L.cats.map(c => c.name)'));
// "+ New category" shows up over the bottom of the view while a reading is dragged (Storage open for it)
await storage(true);
a = await p.centerOf('[...document.querySelectorAll("#vspace .vrow.r")][8]'); b = await E('(() => { const r = document.querySelector(".viewwrap").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 40 }; })()');
await p.drag({ x: a.x - 60, y: a.y }, b); await p.sleep(300);
ok('a row dropped on "New category" makes one', await E('S.L.cats.length === 3'), await E('S.L.cats.map(c => c.name)'));
await storage(false);

// ---- the other views: the same cells, and dragging goes up and down there ----
for (const v of ['overview', 'grid']) {
  await E(`showScreen('${v}')`); await p.sleep(700);
  await storage(false);   // no drawer over the view
  ok(v + ': every cell is drawn', await E('document.querySelectorAll("#view .dc").length === Object.keys(S.L.cells).length'), await E('document.querySelectorAll("#view .dc").length'));
  const bc = await E('S.L.cats.find(c => c.cells.length >= 3).id');
  const first = await E(`S.L.cats.find(c => c.id === "${bc}").cells[0]`), third = await E(`S.L.cats.find(c => c.id === "${bc}").cells[2]`);
  a = await p.center(`#view .dc[data-cid="${first}"]`); b = await p.center(`#view .dc[data-cid="${third}"]`);
  await p.drag({ x: a.x - a.w / 3, y: a.y }, { x: b.x - b.w / 3, y: b.y + b.h / 2 - 2 }); await p.sleep(300);
  ok(v + ': a cell dragged down below another', await E(`S.L.cats.find(c => c.id === "${bc}").cells.indexOf("${first}") === 2`), await E(`S.L.cats.find(c => c.id === "${bc}").cells.indexOf("${first}")`));
}
await E(`showScreen('tiles')`); await p.sleep(600);
await storage(false);   // the settings of the last dropped cell go

// ---- renaming, keyboard ----
c = await p.center(`#view .dcat[data-cat="${cat1}"] .cn`);
await p.dblclick(c.x, c.y); await p.sleep(150);
await p.key('a', 'KeyA', 65, 2); await p.type('My GPU'); await p.key('Enter', 'Enter', 13); await p.sleep(250);
ok('double-click renames a category', await E(`S.L.cats.find(c => c.id === "${cat1}").name === "My GPU"`), await E('S.L.cats.map(c => c.name)'));
const busy = await E('S.L.cats.find(c => c.cells.length >= 2).id');
const k1 = await E(`S.L.cats.find(c => c.id === "${busy}").cells[0]`);
await storage(false);   // the renamed category's settings may have opened over the cell (on the side away from it)
c = await p.center(`#view .dc[data-cid="${k1}"]`); await p.click(c.x, c.y); await p.sleep(150);
await p.key('ArrowRight', 'ArrowRight', 39, 1); await p.sleep(200);
ok('Alt+Right moves the selected cell one place', await E(`S.L.cats.find(c => c.id === "${busy}").cells[1] === "${k1}"`));

// ---- gates, and the warning log they write ----
await E(`selectCell("${k1}")`); await p.sleep(150);
await click('#iMode button[data-v="yr"]');
ok('Yellow + Red shows both fields', await E('!!$("iY") && !!$("iR")'));
const v = await E(`BYKEY.get(S.L.cells["${k1}"].key).v`);
const setv = (id, x) => E(`(() => { const e = $('${id}'); e.value = ${x}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await setv('iY', Math.floor(v) + 50); await setv('iR', Math.floor(v) + 40);
ok('red on the wrong side of yellow is refused', (await E('$("gErr").textContent')).includes('above yellow'), await E('$("gErr").textContent'));
const m = Math.max(20, Math.round(Math.abs(v) * 0.2));   // made-up readings wander (a clock moves 100+ MHz a second)
await setv('iY', Math.floor(v) - 2 * m); await setv('iR', Math.floor(v) + 2 * m); await setv('iHold', 1);
ok('past yellow (after the hold) the cell turns yellow', await until(`document.querySelector('#view .dc[data-cid="${k1}"]').classList.contains('yellow')`, 5000));
await setv('iR', Math.floor(v) - m);
ok('past red it turns red', await until(`document.querySelector('#view .dc[data-cid="${k1}"]').classList.contains('red')`, 5000));
await p.sleep(2500);
ok('the host logged it in alerts.log (even with no popup open)', /RED\s+.+: [\d.]+/.test(readFileSync(join(data, 'alerts.log'), 'utf8')));
await click('#logBtn');
ok('the warning log shows it', await until('document.querySelectorAll("#wlist .wrow").length > 0', 4000), await E('$("wsum").textContent'));
await E('$("wmodal").classList.remove("open")');

// ---- fan curve, predicted fan ----
await storage(true);
await click('.chip[data-t="fan"]');
await click('#vspace .vrow.r .add'); await p.sleep(150);
const fanCid = await E('sel');
ok('a fan cell offers the curve', await E('!!$("iCurveOn")'));
await click('#iCurveOn'); await p.sleep(200);
ok('turning it on makes a curve driven by a temperature', await E(`!!S.L.cells["${fanCid}"].curve && BYKEY.get(S.L.cells["${fanCid}"].curve.src).t === "temp"`));
ok('the status line compares rpm to the curve', await until('/curve expects|Waiting/.test($("cStat").textContent)', 3000), await E('$("cStat").textContent'));
const pt0 = await E(`JSON.stringify(S.L.cells["${fanCid}"].curve.pts[1])`);
a = await p.center('#cSvg .pt[data-i="1"]');
await p.drag(a, { x: a.x + 20, y: a.y - 25 }, 8); await p.sleep(200);
ok('dragging a curve point moves it', await E(`JSON.stringify(S.L.cells["${fanCid}"].curve.pts[1])`) !== pt0);
// the points go in order (by temperature, a tie by rpm) once you leave the table, not while you type; the line follows them
const n0 = await E(`S.L.cells["${fanCid}"].curve.pts.length`);
await E(`(() => { const ins = document.querySelectorAll('#cTab input[data-j="0"]'), last = ins[ins.length - 1]; last.focus(); last.value = '10'; last.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
ok('while you type in the points the rows stay where they are', await E(`S.L.cells["${fanCid}"].curve.pts[${n0 - 1}][0] === 10`));
await E('document.activeElement.blur()'); await p.sleep(250);
ok('leaving the table puts the points in order, the lowest temperature first', await E(`(() => { const q = S.L.cells["${fanCid}"].curve.pts; return q[0][0] === 10 && q.every((x, i) => !i || x[0] >= q[i - 1][0]) && +document.querySelector('#cTab input[data-i="0"][data-j="0"]').value === 10; })()`),
  await E(`JSON.stringify(S.L.cells["${fanCid}"].curve.pts)`));
await E(`(() => { const c = S.L.cells["${fanCid}"]; c.curve.pts = [[50, 1200], [30, 600], [50, 400]]; saveState(); renderInsp(); const i = document.querySelector('#cTab input'); i.focus(); i.blur(); return 1; })()`); await p.sleep(250);
ok('a tie in temperature goes by rpm, the lower first', await E(`JSON.stringify(S.L.cells["${fanCid}"].curve.pts) === '[[30,600],[50,400],[50,1200]]'`), await E(`JSON.stringify(S.L.cells["${fanCid}"].curve.pts)`));
ok('the line runs through the points in that order (a step up at 50)', await E(`(() => { const pl = document.querySelector('#cSvg polyline').getAttribute('points').trim().split(/\\s+/).map(s => s.split(',').map(Number)); return pl.length === 3 && pl[1][0] === pl[2][0] && pl[1][1] > pl[2][1]; })()`),
  await E(`document.querySelector('#cSvg polyline').getAttribute('points')`));
ok('and what the fan should do follows the step (400 at 50, 1200 past it)', await E('interp([[30, 600], [50, 400], [50, 1200]], 50) === 400 && interp([[30, 600], [50, 400], [50, 1200]], 51) === 1200 && interp([[50, 1200], [30, 600], [50, 400]], 50) === 400'));
ok('a layout read back has its points in that order', await E(`(() => { const L = JSON.parse(JSON.stringify(S.L)); L.cells["${fanCid}"].curve.pts = [[50, 1200], [30, 600], [50, 400]]; const c = cleanLayout(L).cells["${fanCid}"]; return !!c && JSON.stringify(c.curve.pts) === "[[30,600],[50,400],[50,1200]]"; })()`));
await click('.chip[data-t="all"]');
await click('#addPred'); await p.sleep(200);
ok('a predicted fan gets its rpm from the curve', await until('(() => { const c = S.L.cells[sel]; return c && c.pred && cellValue(c) > 0; })()', 3000));
await storage(false);

// ---- the popup and the hover preview ----
await E(`openDetail("${fanCid}")`); await p.sleep(600);
ok('the popup opens with the 15 min graph and the fan curve', await E('$("modal").classList.contains("open") && !!document.querySelector("#mcurve") && /min/.test($("mstats").textContent)'));
await E(`document.querySelector('#mrng button[data-r="1h"]').click()`);
ok('1 h comes from the host', await until('bigHist && bigHist.range === "1h" && bigHist.avg.length === 60', 3000));
await E(`document.querySelector('#mrng button[data-r="7d"]').click()`);
ok('7 days comes from the host', await until('bigHist && bigHist.range === "7d" && bigHist.avg.length === 1008', 3000));
await p.key('Escape', 'Escape', 27); await p.sleep(200);
ok('Esc closes it', await E('!$("modal").classList.contains("open")'));
await click('#editBtn');
ok('pencil off: Storage and the settings go, the view fits itself', await E('!S.edit && getComputedStyle(document.querySelector(".storage")).display === "none" && parseFloat(document.documentElement.style.fontSize) > 9'));
await p.sleep(700);   // (the view settles first: a cell redrawn under a still pointer gets no hover until it moves)
c = await p.center('#view .dc'); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await p.sleep(800);
ok('resting on a cell shows the hover preview', await E('HP.shown && $("hprev").classList.contains("on")'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300 }); await p.sleep(250);
// clicks on cells and out of the popup, fast ones too (mouse events with click counts, as a real mouse sends them)
const press = (type, x, y, n = 1) => p.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: n });
const open = () => E('$("modal").classList.contains("open")');
const outside = await E('(() => { const r = document.querySelector("#modal .mcard").getBoundingClientRect(); return { x: Math.max(4, r.left / 2), y: Math.max(4, innerHeight - 8) }; })()');
c = await p.center('#view .dc');
await press('mousePressed', c.x, c.y); await press('mouseReleased', c.x, c.y); await p.sleep(120);
ok('a click on a cell opens its popup', await open());
await press('mousePressed', outside.x, outside.y); await press('mouseReleased', outside.x, outside.y); await p.sleep(250);
ok('a click outside it right away (0.1 s) closes it', !(await open()));
c = await p.center('#view .dc'); await p.sleep(300);
await press('mousePressed', c.x, c.y); await press('mouseReleased', c.x, c.y); await p.sleep(80);
ok('(it opened)', await open());
await press('mousePressed', c.x, c.y, 2); await press('mouseReleased', c.x, c.y, 2); await p.sleep(300);
ok('a second press right away on the same spot (as his video: open, then click again where the cell was) closes it', !(await open()));
c = await p.center('#view .dc'); await p.sleep(300);
await press('mousePressed', c.x, c.y); await E('renderView(false)'); await p.sleep(50); await press('mouseReleased', c.x, c.y); await p.sleep(200);
ok('a cell redrawn between the press and the release still opens (a fresh window redraws while it settles)', await open() && await E('modalCid !== null'));
await p.key('Escape', 'Escape', 27); await p.sleep(400);
await p.shot(join(out, 'live.png'));
await click('#editBtn');

// ---- saves ----
await p.key('s', 'KeyS', 83, 2); await p.sleep(500);
ok('Ctrl+S saves into the first empty slot', await E('S.active === 0 && !!S.slots[0]') && existsSync(join(data, 'slots', 'slot1.json')));
await click('#savesBtn');
c = await p.center('#slist .srow2[data-slot="0"] .st'); await p.dblclick(c.x, c.y); await p.sleep(150);
await p.key('a', 'KeyA', 65, 2); await p.type('Gaming'); await p.key('Enter', 'Enter', 13); await p.sleep(300);
ok('double-click renames a slot', await E('S.slots[0].name === "Gaming"') && JSON.parse(readFileSync(join(data, 'slots', 'slot1.json'), 'utf8')).name === 'Gaming');
await click('#slist .srow2[data-slot="1"] [data-a="save"]');
ok('Save here on an empty slot', await E('S.active === 1 && !!S.slots[1]'));
const cellsBefore = await E('Object.keys(S.L.cells).length');
await click('#clearBtn'); await click('#cyes');
ok('Clear view (after its confirmation) empties the view', await E('S.L.cats.length === 0 && S.active === null && !!document.querySelector("#view.empty")'));
await p.key('z', 'KeyZ', 90, 2); await p.sleep(300);
ok('Ctrl+Z brings it back, slot and all', await E(`Object.keys(S.L.cells).length === ${cellsBefore} && S.active === 1 && !isDirty()`));
await E('removeCell(S.L.cats.find(c => c.cells.length).cells[0])'); await p.sleep(200);
ok('a change puts the dot on the saves button', await E('$("savesDot").classList.contains("on")'));
await click('#savesBtn'); await click('#slist .srow2[data-slot="0"] [data-a="load"]');
ok('loading over unsaved changes asks first', await E('$("cmodal").classList.contains("open")'));
await click('#cyes'); await p.sleep(200);
ok('then loads the slot', await E(`S.active === 0 && Object.keys(S.L.cells).length === ${cellsBefore} && !isDirty()`));
await E('$("smodal").classList.remove("open")');

// ---- a layout from another PC, for the restart test ----
const real = await E('(() => { const r = READ[5]; return { key: r.key, match: matchOf(r) }; })()');
writeFileSync(join(data, 'slots', 'slot3.json'), JSON.stringify({ v: 1, name: 'Other PC', layout: { v: 1, cats: [{ id: 'cx', name: 'Imported', collapsed: false, cells: ['m1', 'm2'] }],
  cells: { m1: { key: 'deadbeef.0/01000000', match: real.match, graph: true }, m2: { key: 'deadbeef.0/01000001', match: 'Some Other Board|VRM', name: 'VRM', graph: true } } } }));
await click('#setBtn');
ok('settings open, with the files folder', await E('$("setmodal").classList.contains("open") && $("setbody").textContent.includes("data1")'));
await E('$("setmodal").classList.remove("open")');
await p.shot(join(out, 'edit.png'));
await p.sleep(600);
const st = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
ok('the working layout is on disk', st.L && st.L.cats.length === (await E('S.L.cats.length')) && st.active === 0);
ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
