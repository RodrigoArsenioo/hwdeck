// Checks for the release fixes, on a data folder run-all.ps1 prepares (test\data-h): a fan cell with a curve it can't
// meet, a cell whose lines were left empty, and a game session the last run left open.
//   node test/e2e-hardening.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9232);
const data = process.argv[3] || 'test/data-h';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const untilFile = async (f, re, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (existsSync(f) && re.test(readFileSync(f, 'utf8'))) return true; await p.sleep(250); } return false; };
const text = f => existsSync(f) ? readFileSync(f, 'utf8') : '';
const prep = JSON.parse(readFileSync(join(data, 'prep.json'), 'utf8').replace(/^﻿/, ''));

ok('catalog arrives', await until('READ.length === 300 && feed.got'));

// ---- the host ----
ok('a fan curve is checked from the start, before the page ever saves', await untilFile(join(data, 'alerts.log'), /YELLOW\s+Rear fan fan curve: /), text(join(data, 'alerts.log')).split('\n').slice(-3).join(' | '));
ok('log times carry their offset and use one fixed format', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d  MARK    app start/m.test(text(join(data, 'alerts.log'))));
await E(`(() => { const c = S.L.cells.fan1; c.curve.tol = 100000; saveState(); })()`);
ok('its episode ends under the same name', await untilFile(join(data, 'alerts.log'), /OK\s+Rear fan fan curve: back to normal/), text(join(data, 'alerts.log')).split('\n').slice(-2).join(' | '));
const g = text(join(data, 'games.log')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).find(x => x.game === 'Test Game');
ok('a session the last run left open ends when it was last seen, not at this start', g && g.end === prep.last, g ? `end ${g.end}, last seen ${prep.last}` : 'no line');

// ---- empty lines stay empty ----
ok('a line left empty (null on disk) is not a line at 0', await E('(() => { const e = evalCell("t1", S.L.cells.t1, true, true); return e.lvl === 0 && !gatesOn(S.L.cells.t1.gates); })()'));
await E('selectCell("t1")'); await p.sleep(150);
ok('its settings ask for the value', await E('$("gErr").textContent === "Set the yellow value."'), await E('$("gErr").textContent'));

// ---- layouts from files ----
const title0 = await E('document.title');
await E(`onHost({ t: 'imported', slot: 4, data: { name: 'x', layout: { v: 1, cats: [{ id: '"><img src=x onerror="document.title=\\'pwned\\'">', name: '<b>bold</b>', cells: ['a"b', 'p1'] }],
  cells: { 'a"b': { key: 'zz.0/1', graph: true, gates: { mode: 'y', y: '1);alert(1', hold: '<i>' } }, p1: { pred: true, curve: { src: 'x', pts: [[1, 2]], tol: '<b>' } } } } } })`);
await E('loadSlot(4)'); await p.sleep(600);
ok('a crafted layout file runs nothing', (await E('document.title')) === title0 && (await E('document.querySelectorAll("#view img, #view b").length')) === 0, await E('document.title'));
ok('its ids and numbers are cleaned', await E('/^[A-Za-z0-9_-]+$/.test(S.L.cats[0].id) && S.L.cats[0].cells.length === 1 && !Number.isFinite(Object.values(S.L.cells)[0].gates.y) && Object.values(S.L.cells)[0].gates.hold === 0'), await E('JSON.stringify(S.L)'));
await E(`onHost({ t: 'imported', slot: 3, data: { layout: { cats: [{ id: 'c', name: 'n' }, null, 5] } } })`);
await E('loadSlot(3)'); await p.sleep(400);
ok('a layout missing its cells loads as an empty category', await E('S.L.cats.length === 1 && S.L.cats[0].cells.length === 0 && Object.keys(S.L.cells).length === 0'));
await E('undo(); undo()'); await p.sleep(300);
ok('undo brings the working view back', await E('!!S.L.cells.fan1 && !!S.L.cells.t1'));

// ---- an app, not a browser ----
await E(`setTimeout(() => { location.href = 'https://example.com/'; }, 10), 1`); await p.sleep(1500);
ok('nothing navigates the page away', (await E('location.host')) === 'hwdeck.example');
ok('no popup windows', (await E('window.open("https://example.com/") === null')));

// ---- Storage: a click that spans a tick still lands ----
await E('showScreen("tiles"); typeFilter = "all"; query = ""; renderStorage()'); await p.sleep(300);
const n0 = await E('Object.keys(S.L.cells).length');
const btn = await E(`(() => { const vl = $('vlist').getBoundingClientRect(); const b = [...document.querySelectorAll('#vspace .vrow.r .add')].find(x => { const r = x.getBoundingClientRect(); return r.top > vl.top && r.bottom < vl.bottom; }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const ts0 = await E('nowTs');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', buttons: 1, clickCount: 1 });
await until(`nowTs > ${ts0}`, 3000); await p.sleep(80);
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', buttons: 0, clickCount: 1 });
await p.sleep(400);
ok('a + pressed across a tick adds the cell', (await E('Object.keys(S.L.cells).length')) === n0 + 1, `${n0} to ${await E('Object.keys(S.L.cells).length')}`);

// ---- small things ----
ok('a number replacing "--" shows at once', await E(`(() => { const el = document.createElement('span'); document.body.appendChild(el); odo(el, '--'); odo(el, '42'); const r = el._ot; el.remove(); return r === '42'; })()`));
ok('Yes/No readings read Yes and No', await E(`fmtV(1, 0, { unit: 'Yes/No' }) === 'Yes' && fmtV(0, 0, { unit: 'Yes/No' }) === 'No'`));
ok('numbers with decimals get thousands separators too', await E(`fmt(1234.5, 1) === '1,234.5'`));
await E(`renderWarnings(['2026-10-25 01:50:00+01:00  YELLOW  CPU: 88 \\u00b0C', '2026-10-25 01:05:00+00:00  OK      CPU: back to normal (peak 90 \\u00b0C)',
  '2026-10-25 02:00:00+00:00  YELLOW  GPU: 80 \\u00b0C', '2026-10-25 02:00:30+00:00  MARK    app exit'].join('\\n'))`);
ok('the warning log survives a summer time change and an exit (15 min, not a negative duration)', await E('[...document.querySelectorAll("#wlist .wrow")].some(r => r.textContent.includes("CPU") && /\\b15m\\b/.test(r.textContent)) && !/(^|[ ,])-\\d/.test([...document.querySelectorAll("#wlist .wmeta")].map(x => x.textContent).join(" "))'), await E('$("wlist").textContent'));
await E(`removeCell(Object.keys(S.L.cells).pop())`); await p.sleep(100);
ok('a toast offers Undo for what it names', await E('!$("toastUndo").hidden'));
await E(`mutate(() => { S.L.cats[0].name = 'Renamed'; })`); await p.sleep(100);
ok('after another change its Undo goes', await E('$("toastUndo").hidden'));
await E(`(() => { const c = S.L.cats[0]; c.collapsed = !c.collapsed; saveState(); syncSaves(); })()`);
await E(`saveTo(0); S.L.cats[0].collapsed = !S.L.cats[0].collapsed`);
ok('folding a category is not an unsaved change', await E('!isDirty()'));

// ---- animations: Full / Reduced / Off from Settings ----
await E('setEdit(false); showScreen("tiles")'); await p.sleep(600);
const spins = () => E('document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.classList.contains("spw") && a.playState === "running").length');
const pick = async m => { await E(`$("setBtn").click()`); await p.sleep(250); await E(`document.querySelector('#sMotion button[data-m="${m}"]').click()`); await p.sleep(900); await E(`$("setmodal").classList.remove("open")`); };
await pick('full');
ok('Full: the fans spin', (await spins()) > 0 && (await E('document.documentElement.dataset.motion')) === 'full', String(await spins()));
await pick('reduced');
ok('Reduced: lighter (fans turned by the 10 Hz timer, not per frame; quick digit rolls)', (await spins()) === 0 && (await E('document.documentElement.dataset.motion')) === 'reduced' && (await E('stepped.size > 0 && !!stepT')) && (await E('(() => { const o = document.createElement("span"); o.className = "od"; o.appendChild(document.createElement("span")).className = "odr"; $("view").appendChild(o); const d = getComputedStyle(o.firstChild).transitionDuration; o.remove(); return d; })()')) === '0.25s', String(await E('stepped.size')));
await pick('minimal');
ok('Minimal: nothing keeps moving (no spins, digits just change), popups still slide', (await spins()) === 0 && (await E('document.documentElement.dataset.motion')) === 'minimal' && (await E('stepped.size === 0 && !stepT')) && (await E('(() => { const o = document.createElement("span"); o.className = "od"; o.appendChild(document.createElement("span")).className = "odr"; $("view").appendChild(o); const d = getComputedStyle(o.firstChild).transitionDuration; o.remove(); return d; })()')) === '0s' && (await E('getComputedStyle(document.querySelector(".modal")).transitionDuration')) !== '0s');
await pick('off');
ok('Off: no transitions at all, and the fans stand still', (await E('document.documentElement.dataset.motion')) === 'off' && (await E('getComputedStyle(document.querySelector(".modal")).transitionDuration')) === '0s' && (await spins()) === 0 && (await E('stepped.size === 0 && !stepT')));
await pick('full');
await p.sleep(500);
ok('the choice is saved with the view', JSON.parse(readFileSync(join(data, 'state.json'), 'utf8').replace(/^﻿/, '')).motion === 'full');
await E('setEdit(true)'); await p.sleep(300);

// ---- HWiNFO gone ----
// (each in one go: the next real tick would put the feed back before a second call could look)
const ban = await E(`(() => { feed.fake = false; onHost({ t: 'tick', ver: 1, status: 'missing', age: 0, ts: nowTs + 1, i: [], v: [], mn: [], mx: [], av: [], game: null, front: false, gameSince: 0 }); return !$("banner").hidden && $("bannerTxt").textContent; })()`);
ok('with a layout and no HWiNFO, the banner says so', !!ban && /gone|isn.t running/.test(ban), ban);
const setup = await E(`(() => { feed.fake = false; onHost({ t: 'catalog', ver: 99, sensors: [], readings: [] }); feed.status = 'missing'; S.L = emptyLayout(); renderView(false); return !!document.querySelector("#view.setup #setupRestart"); })()`);
ok('with nothing at all, the setup screen (with Restart HWiNFO) shows', setup);
await E(`send({ t: 'ready' })`);
ok('the real feed comes back', await until('READ.length === 300 && feed.fake', 6000));
ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
