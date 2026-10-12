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

ok('catalog arrives', await until('READ.length === 301 && feed.got'));

// ---- the host ----
ok('a fan curve is checked from the start, before the page ever saves', await untilFile(join(data, 'alerts.log'), /YELLOW\s+Rear fan fan curve: /), text(join(data, 'alerts.log')).split('\n').slice(-3).join(' | '));
ok('log times carry their offset and use one fixed format', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d  MARK    app start/m.test(text(join(data, 'alerts.log'))));
await E(`(() => { const c = S.L.cells.fan1; c.curve.tol = 100000; saveState(); })()`);
ok('its episode ends under the same name', await untilFile(join(data, 'alerts.log'), /OK\s+Rear fan fan curve: back to normal/), text(join(data, 'alerts.log')).split('\n').slice(-2).join(' | '));

// ---- a curve that doesn't warn: off it, no yellow and nothing logged; it still says how far off it is ----
const fanYs = () => (text(join(data, 'alerts.log')).match(/YELLOW\s+Rear fan fan curve: /g) || []).length, fy0 = fanYs();
await E(`(() => { const c = S.L.cells.fan1; c.curve.tol = 15; c.curve.warn = false; saveState(); return 1; })()`);
await p.sleep(4000);   // (its hold is 1 s)
ok('a curve set not to warn: off it, the cell stays white and nothing is logged, it says how far off it is', fanYs() === fy0 && await E('(() => { const e = evalCell("fan1", S.L.cells.fan1, true, true); return e.lvl === 0 && !e.offCurve && /% (under|over) its curve$/.test(e.sub); })()'),
  fanYs() + ' vs ' + fy0 + ', ' + await E('JSON.stringify(evalCell("fan1", S.L.cells.fan1, true, true).sub)'));
ok('it stays that way when the layout is loaded again', await E('Object.values(cleanLayout(JSON.parse(JSON.stringify(S.L))).cells).find(c => c.name === "Rear fan").curve.warn === false'));
await E('selectCell("fan1")'); await p.sleep(250);
ok('its settings: the box unticked, no hold, a line on what that means', await E('!!$("cWarn") && !$("cWarn").checked && !$("cHold") && !!$("cTol") && /never turns yellow/.test($("cHint").textContent) && !$("cStat").classList.contains("y")'),
  await E('$("cHint") && $("cHint").textContent'));
await E('(() => { const b = $("cWarn"); b.checked = true; b.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
ok('ticked again: its hold is back with what tolerance and hold mean', await E('S.L.cells.fan1.curve.warn === undefined && !!$("cHold") && /Hold: how long/.test($("cHint").textContent)'));
for (const t0 = Date.now(); fanYs() === fy0 && Date.now() - t0 < 10000;) await p.sleep(250);
ok('and it warns again', fanYs() > fy0 && await E('evalCell("fan1", S.L.cells.fan1, true, true).lvl === 1'), text(join(data, 'alerts.log')).split('\n').slice(-2).join(' | '));
await E(`(() => { S.L.cells.fan1.curve.tol = 100000; saveState(); clearSel(); return 1; })()`);
await untilFile(join(data, 'alerts.log'), /OK\s+Rear fan fan curve: back to normal[^]*OK\s+Rear fan fan curve: back to normal/);
const g = text(join(data, 'games.log')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).find(x => x.game === 'Test Game');
ok('a session the last run left open ends when it was last seen, not at this start', g && g.end === prep.last, g ? `end ${g.end}, last seen ${prep.last}` : 'no line');
ok('its report from 1.0.0 (no bottleneck, timeline or warning list) is written with them empty', !!g && g.g === 0 && g.c === 0 && g.f === 0 && g.tb === '' && Array.isArray(g.tf) && g.tf.length === 0 && Array.isArray(g.tl) && Array.isArray(g.wl) && g.wl.length === 0,
  g ? JSON.stringify({ g: g.g, c: g.c, f: g.f, tf: g.tf, tl: g.tl, tb: g.tb, wl: g.wl }) : 'no line');
const badHist = readdirSync(data).find(f => /^hist\.bin\.bad-\d{8}-\d{6}$/.test(f));
ok('a damaged history file is moved aside (hist.bin.bad-<time>), not saved over', !!badHist && text(join(data, badHist)).startsWith('not a history file') && !existsSync(join(data, 'hist.bin')), readdirSync(data).join(', '));

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
await E('DR.L.pinned = true; syncDrawers()'); await p.sleep(300);   // Storage is a drawer in edit mode: kept open here
const n0 = await E('Object.keys(S.L.cells).length');
const btn = await E(`(() => { const vl = $('vlist').getBoundingClientRect(); const b = [...document.querySelectorAll('#vspace .vrow.r .add')].find(x => { const r = x.getBoundingClientRect(); return r.top > vl.top && r.bottom < vl.bottom; }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const ts0 = await E('nowTs');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', buttons: 1, clickCount: 1 });
await until(`nowTs > ${ts0}`, 3000); await p.sleep(80);
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', buttons: 0, clickCount: 1 });
await p.sleep(400);
ok('a + pressed across a tick adds the cell', (await E('Object.keys(S.L.cells).length')) === n0 + 1, `${n0} to ${await E('Object.keys(S.L.cells).length')}`);
await E('DR.L.pinned = false; syncDrawers()');

// ---- small things ----
ok('a number replacing "--" shows at once', await E(`(() => { const el = document.createElement('span'); document.body.appendChild(el); odo(el, '--'); odo(el, '42'); const r = el._ot; el.remove(); return r === '42'; })()`));
ok('Yes/No readings read Yes and No', await E(`fmtV(1, 0, { unit: 'Yes/No' }) === 'Yes' && fmtV(0, 0, { unit: 'Yes/No' }) === 'No'`));
ok('numbers with decimals get thousands separators too', await E(`fmt(1234.5, 1) === '1,234.5'`));
ok('a reading on its own between two gaps shows as a dot (small graph and popup graph)', await E(`(() => {
  const dpr = window.devicePixelRatio || 1, mk = () => { const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:150px'; document.body.appendChild(c); return c; };
  const lit = (c, x, y0, y1) => { const d = c.getContext('2d').getImageData(Math.floor(x) - 1, 0, 3, c.height).data; for (let y = Math.ceil(y0); y < y1; y++) for (let k = 0; k < 3; k++) { const i = (y * 3 + k) * 4; if (d[i] > 100 && d[i + 3] > 150) return true; } return false; };
  const a = mk(), b = mk(), pts = [0, 1, 2, 10, 18, 19].map(s => ({ s, v: s === 10 ? 5 : 3 + s % 2, x: s + 0.5 }));
  drawGraph(a, { cw: 300, ch: 150, col: '#7c7c7c', cur: { pts, end: 20, span: 20, lo: 2, hi: 6 } }, 1);
  drawBigGraph(b, [3, 4, 3, null, null, 6, null, null, 4, 5], {}, 0, '', false, null, null, { rev: 1 });
  const r = lit(a, 1 + 10.5 / 20 * (a.width - 1 - 5 * dpr), 0, a.height) && lit(b, 58 * dpr + 5 / 9 * (b.width - 66 * dpr), 10 * dpr, b.height - 36 * dpr);
  a.remove(); b.remove(); return r;
})()`));
await E(`renderWarnings(['2026-10-25 01:50:00+01:00  YELLOW  CPU: 88 \\u00b0C', '2026-10-25 01:05:00+00:00  OK      CPU: back to normal (peak 90 \\u00b0C)',
  '2026-10-25 02:00:00+00:00  YELLOW  GPU: 80 \\u00b0C', '2026-10-25 02:00:30+00:00  MARK    app exit'].join('\\n'))`);
ok('the warning log survives a summer time change and an exit (15 min, not a negative duration)', await E('[...document.querySelectorAll("#wlist .wrow")].some(r => r.textContent.includes("CPU") && /\\b15m\\b/.test(r.textContent)) && !/(^|[ ,])-\\d/.test([...document.querySelectorAll("#wlist .wmeta")].map(x => x.textContent).join(" "))'), await E('$("wlist").textContent'));
// a PEAK line gives a warning the next MARK ends its real peak; INFO lines end nothing; a crash-cut warning merges from its start
await E(`(() => { const d0 = new Date(); d0.setHours(1, 0, 0, 0); const p2 = n => String(n).padStart(2, '0');
  const at = (m, s) => { const d = new Date(d0.getTime() + m * 60000), o = -d.getTimezoneOffset(); return localDay(d) + ' ' + hhmm(d / 1000) + ':00' + (o < 0 ? '-' : '+') + p2(Math.abs(o) / 60 | 0) + ':' + p2(Math.abs(o) % 60) + '  ' + s; };
  renderWarnings([at(0, 'YELLOW  CPU: 80 \\u00b0C'), at(1, 'OK      CPU: back to normal (peak 85 \\u00b0C)'), at(3, 'YELLOW  CPU: 81 \\u00b0C'), at(4, 'RED     CPU: 95 \\u00b0C'), at(5, 'PEAK    CPU: 99 \\u00b0C'), at(5, 'MARK    app exit'),
    at(13, 'YELLOW  VRM: 90 \\u00b0C'), at(14, 'INFO    HWiNFO back, warnings on'), at(16, 'OK      VRM: back to normal (peak 97 \\u00b0C)'),
    at(20, 'YELLOW  SSD: 60 \\u00b0C'), at(200, 'MARK    app start'), at(202, 'YELLOW  SSD: 61 \\u00b0C')].join('\\n')); })()`);
await E('(() => { document.querySelectorAll("#wlist .wgrp").forEach(r => r.click()); return 1; })()');   // (a row draws its episodes when it opens)
const wrows = await E('[...document.querySelectorAll("#wlist > .wrow")].map(r => r.textContent)'), wsubs = await E('[...document.querySelectorAll("#wlist .wsub .wrow")].map(r => r.textContent)');
ok('a warning ended by an exit shows the peak from its PEAK line, not its red line', wrows.some(r => r.includes('CPU') && r.includes('peak 99')) && wsubs.some(r => r.includes('ended with the app') && r.includes('peak 99')), wrows.concat(wsubs).join(' | '));
ok('"HWiNFO back" (INFO) does not end a warning', wrows.some(r => r.includes('VRM') && r.includes('peak 97') && /\b3m\b/.test(r)), wrows.join(' | '));
ok('a warning cut by a crash merges from its start and never runs "to" the next start', wrows.filter(r => r.includes('SSD')).length === 2 && wrows.some(r => r.includes('SSD') && r.includes('until the app stopped') && !r.includes(' to ')), wrows.join(' | '));
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
ok('Full: the fans turn on the 30 a second motion clock (no endless animation drawing at the screen rate)', (await spins()) === 0 && (await E('document.documentElement.dataset.motion')) === 'full' && (await E('stepped.size > 0 && !!motionT && motionAt === 30')), String(await E('[stepped.size, motionAt]')));
ok('Full: a digit rolls on the clock, no CSS transition', await E('(() => { const o = document.createElement("span"); o.className = "od"; o.appendChild(document.createElement("span")).className = "odr"; $("view").appendChild(o); const d = getComputedStyle(o.firstChild).transitionDuration; o.remove(); return d === "0s"; })()'));
ok('Full: a roll goes 600 ms in steps and ends on its digit', await E(`new Promise(res => { const el = document.createElement('span'); $('view').appendChild(el); odo(el, '12', true); odo(el, '19', true); const c = el._ocells[1]; setTimeout(() => { const mid = rolling.has(c.rl) && c.rl._p > 12 && c.rl._p < 19; setTimeout(() => { const done = !rolling.has(c.rl) && c.rl._p === 19 && !c.rl.parentNode.classList.contains('roll'); el.remove(); res(mid && done); }, 600); }, 250); })`));
await pick('reduced');
ok('Reduced: lighter (the motion clock at 10 a second; quick digit rolls)', (await spins()) === 0 && (await E('document.documentElement.dataset.motion')) === 'reduced' && (await E('stepped.size > 0 && !!motionT && motionAt === 10 && ROLL_MS() === 250')), String(await E('[stepped.size, motionAt]')));
await pick('minimal');
ok('Minimal: nothing keeps moving (no spins, digits just change), popups still slide', (await spins()) === 0 && (await E('document.documentElement.dataset.motion')) === 'minimal' && (await E('stepped.size === 0 && !motionT && !motionSome()')) && (await E('getComputedStyle(document.querySelector(".modal")).transitionDuration')) !== '0s');
await pick('off');
ok('Off: no transitions at all, and the fans stand still', (await E('document.documentElement.dataset.motion')) === 'off' && (await E('getComputedStyle(document.querySelector(".modal")).transitionDuration')) === '0s' && (await spins()) === 0 && (await E('stepped.size === 0 && !motionT')));
await pick('full');
await p.sleep(500);
ok('the choice is saved with the view', JSON.parse(readFileSync(join(data, 'state.json'), 'utf8').replace(/^﻿/, '')).motion === 'full');
ok('negative numbers roll their digits the way the size goes (-5 to -7 up, back down)', await E(`(() => { const el = document.createElement('span'); $('view').appendChild(el); odo(el, '-5'); odo(el, '-7', true); const up = el._ocells[1].rl._to; odo(el, '-5', true); const down = el._ocells[1].rl._to; el.remove(); return up === 17 && down === 15; })()`));
await p.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await E('S.motion = undefined; applyMotion(); saveState()'); await p.sleep(600);
const winMode = await E('motionMode()');
await pick('off');
ok('picking the mode Windows asked for (less motion) saves it too', winMode === 'off' && JSON.parse(readFileSync(join(data, 'state.json'), 'utf8').replace(/^﻿/, '')).motion === 'off', winMode);
await p.cmd('Emulation.setEmulatedMedia', { features: [] });
await pick('full');

// ---- new version notice (the host asks GitHub once a day; here the page is told directly) ----
await E(`(() => { window.__sent = []; const w = window.chrome.webview, f = w.postMessage.bind(w); w.postMessage = m => { window.__sent.push(m && m.t); if (!m || m.t !== 'openRelease') f(m); }; return 1; })()`);
ok('no new version: no dot on the gear', await E('!$("setDot").classList.contains("on")'));
await E(`onHost({ t: 'settings', autostart: false, hwinfo: null, updates: true, latest: '9.9.9' })`);
ok('a new version puts a dot on the gear', await E('$("setDot").classList.contains("on") && $("setBtn").title.includes("9.9.9")'));
await E(`$('setBtn').click()`); await p.sleep(250);
ok('Settings says it is out, with a Get it button', await E('$("setbody").textContent.includes("HW Deck 9.9.9 is out") && !!$("sGet")'));
await E(`$('sGet').click()`);
ok('Get it asks the host to open the releases page', await E('window.__sent.includes("openRelease")'));
await E(`$('sUpd').click()`); await p.sleep(250);
ok('switching checks off hides the notice and tells the host', await E('!$("setDot").classList.contains("on") && !$("sGet") && !$("sUpd").classList.contains("on") && window.__sent.includes("updates")'));
await p.sleep(600);
ok('the switch is saved in settings.json', JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8').replace(/^﻿/, '')).updates === false);
await E(`$('sUpd').click()`); await p.sleep(250); await E(`$('setmodal').classList.remove('open')`);
await E('setEdit(true)'); await p.sleep(300);

// ---- a stalled feed: frozen values turn nothing and leave gaps in the graphs (in one go, like below) ----
const stalled = await E(`(() => {
  const k = S.L.cells.t1.key, g = h => ({ key: k, gates: { mode: 'y', dir: 'above', y: -1e9, r: null, hold: h } }), real = Date.now;
  const lv = () => evalCell('zz5', g(5), false, true).lvl + 10 * evalCell('zz0', g(0), false, true).lvl;
  delete holdSince.zz5; delete holdSince.zz0;
  const before = lv();   // live: a 5 s hold starts, a line with no hold turns at once
  onHost({ t: 'tick', ver: 1, status: 'stale', age: 30, ts: lastTick + 1, i: [], v: [], mn: [], mx: [], av: [], game: null, front: false, gameSince: 0 });
  const gap = Number.isNaN(series(k, 1)[0]);
  Date.now = () => real() + 10000;   // 10 s on, still stalled
  let after; try { after = lv(); } finally { Date.now = real; }
  delete holdSince.zz5; delete holdSince.zz0;
  return { before, gap, after };
})()`);
ok('a stalled feed leaves a gap in the graphs, not its frozen value', stalled.gap, stalled);
ok('a hold that runs out while the feed is stalled turns nothing (a cell already yellow stays)', stalled.before === 10 && stalled.after === 10, stalled);

// ---- the warning log and game log popups: the host's own answer, and Clear (the old log kept as .bak) ----
const logClick = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(300); };
await logClick('#logBtn');
ok('the warning log button gets the host\'s log, not "loading..."', await until('$("wlist").textContent.includes("Rear fan fan curve")', 5000), await E('$("wlist").textContent.slice(0, 100)'));
await logClick('#wclear'); await logClick('#cyes');
ok('Clear empties the warning log and keeps the old one as alerts.log.bak', await until('/Nothing crossed a line/.test($("wlist").textContent)', 5000) && /YELLOW\s+Rear fan fan curve/.test(text(join(data, 'alerts.log.bak'))), await E('$("wlist").textContent.slice(0, 100)'));
await E('$("wmodal").classList.remove("open")'); await p.sleep(300);
await logClick('#logBtn');
ok('opened again, the cleared warning log comes back empty', await until('/Nothing crossed a line/.test($("wlist").textContent)', 5000) && !/Rear fan/.test(text(join(data, 'alerts.log'))), text(join(data, 'alerts.log')).slice(0, 200));
await E('$("wmodal").classList.remove("open")'); await p.sleep(300);
await logClick('#gamesBtn');
ok('the game log button gets the host\'s log: a row in the sessions table', await until('[...document.querySelectorAll("#glist .gx-sess .gx-gn")].map(x => x.textContent).join() === "Test Game" && !!document.querySelector("#glist .gx-cols")', 5000), await E('$("glist").textContent.slice(0, 100)'));
const tg = await E('document.querySelector("#glist .gx-sess .gx-row").textContent');
ok('that session (10 min, 8 in front, nothing recorded) reads "--" for fps, 1% low and what limited it', /^Test Game\d\d:\d\d to \d\d:\d\d10m8m in front------none$/.test(tg), tg);
ok('it opens with the popup and says nothing was recorded (no bars, no timeline)', await E('(() => { const s = document.querySelector("#glist .gx-sess"); return s.classList.contains("open") && !!s.querySelector(".gx-nil") && !s.querySelector(".gx-rr, .gx-tl"); })()'), await E('document.querySelector("#glist .gx-det").textContent'));
ok('the summary counts it', /last 7 days\s*1\s*session/.test(await E('$("gsum").textContent')), await E('$("gsum").textContent'));
await logClick('#glist .gx-row');
ok('a click on its row shuts it', await E('!document.querySelector("#glist .gx-sess").classList.contains("open")'));
await logClick('#gclear');
ok('Clear asks first, naming how many sessions go', await E('$("cmodal").classList.contains("open") && $("cdesc").textContent.includes("(1 session)")'), await E('$("cdesc").textContent'));
await logClick('#cyes');
ok('Clear empties the game log and keeps the old one as games.log.bak', await until('/No sessions yet/.test($("glist").textContent) && !document.querySelector("#glist .gx-sess") && $("gsum").textContent === ""', 5000) && /"game":"Test Game"/.test(text(join(data, 'games.log.bak'))), await E('$("glist").textContent.slice(0, 100)'));
await E('$("gmodal").classList.remove("open")'); await p.sleep(300);
await logClick('#gamesBtn');
ok('opened again, the cleared game log comes back empty', await until('/No sessions yet/.test($("glist").textContent) && !document.querySelector("#glist .gx-cols")', 5000) && text(join(data, 'games.log')).trim() === '', text(join(data, 'games.log')).slice(0, 200));
await E('$("gmodal").classList.remove("open")'); await p.sleep(300);

// ---- HWiNFO gone ----
// (each in one go: the next real tick would put the feed back before a second call could look)
const ban = await E(`(() => { feed.fake = false; onHost({ t: 'tick', ver: 1, status: 'missing', age: 0, ts: nowTs + 1, i: [], v: [], mn: [], mx: [], av: [], game: null, front: false, gameSince: 0 }); return !$("banner").hidden && $("bannerTxt").textContent; })()`);
ok('with a layout and no HWiNFO, the banner says so', !!ban && /gone|isn.t running/.test(ban), ban);
const setup = await E(`(() => { feed.fake = false; onHost({ t: 'catalog', ver: 99, sensors: [], readings: [] }); feed.status = 'missing'; S.L = emptyLayout(); renderView(false); return !!document.querySelector("#view.setup #setupRestart"); })()`);
ok('with nothing at all, the setup screen (with Restart HWiNFO) shows', setup);
await E(`send({ t: 'ready' })`);
ok('the real feed comes back', await until('READ.length === 301 && feed.fake', 6000));

// ---- the window: minimized from maximized it is saved as maximized; a second start shows it, unless it asked for the tray ----
const wf = join(data, 'window.json');
await E(`send({ t: 'win', a: 'max' })`); await p.sleep(800);
await E(`send({ t: 'win', a: 'min' })`); await p.sleep(800);
await E(`send({ t: 'win', a: 'close' })`); await p.sleep(1500);
ok('a window minimized from maximized is saved as maximized', existsSync(wf) && JSON.parse(text(wf)).max === true, text(wf));
const { spawnSync } = await import('node:child_process'), { resolve } = await import('node:path');
const again = (...a) => spawnSync(resolve('HWDeck.exe'), [...a, '--fake', '300', '--data', resolve(data)], { timeout: 20000 });
const ts1 = await E('nowTs');
again('-min'); await p.sleep(3000);
ok('a second start with -min leaves the window in the tray', (await E('nowTs')) === ts1, `${ts1} to ${await E('nowTs')}`);
again();
ok('a second start without -min brings the window back', await until(`nowTs > ${ts1}`, 6000));
ok('no page errors', errs.length === 0, errs.join(' | '));

// ---- quitting with a warning open: the host writes its peak before the MARK (last: this quits the app) ----
const fanY = () => (text(join(data, 'alerts.log')).match(/YELLOW\s+Rear fan fan curve: /g) || []).length, y0 = fanY();
await E(`(() => { S.L.cells.fan1.curve.tol = 15; saveState(); })()`);
for (const t0 = Date.now(); fanY() === y0 && Date.now() - t0 < 10000;) await p.sleep(250);
p.evaluate(`send({ t: 'exit' })`).catch(() => {});
ok('quitting writes the open warning\'s peak just before its MARK', await untilFile(join(data, 'alerts.log'), /  PEAK    Rear fan fan curve: [\d.]+ RPM\r?\n\S+ \S+  MARK    app exit/), text(join(data, 'alerts.log')).trim().split('\n').slice(-3).join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
