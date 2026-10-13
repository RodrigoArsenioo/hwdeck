// What came after 1.4.0: memory in GB (the "% of" caption, lines typed in GB and kept in MB), hiding readings and
// sensors from Storage (the Hidden chip, the default hiding, Customize's list), the sessions and warnings popups
// (details built on opening, lists let go on closing, warnings shown 300 at a time), Customize edits that leave the
// dashboard alone, the cold-start re-measure only after a hidden draw, layout files of either shape, and on the
// host: warnings in GB and one episode for a value that hovers on its line. Start it on an empty data folder, with
// made-up fans at 0 rpm:
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9240
//   set HWDECK_FAKEZERO=1
//   HWDeck.exe --fake 300 --data test\data-14x
// then: node test/e2e-14x.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9240);
const data = process.argv[3] || 'test/data-14x';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const text = f => existsSync(f) ? readFileSync(f, 'utf8') : '';
const host = m => E(`send(${JSON.stringify(m)})`);

ok('catalog arrives', await until('READ.length === 301 && feed.got'));
await host({ t: 'fakeGame', game: null });
const ramKey = await E('(READ.find(r => r.label === "Physical Memory Used") || {}).key');
const availKey = await E('(READ.find(r => r.label === "Physical Memory Available") || {}).key');
ok('made-up data has RAM used and available, in MB', !!ramKey && !!availKey && await E(`BYKEY.get(${JSON.stringify(ramKey)}).unit === 'MB'`));

// ---- B: memory in GB ----
await E(`(() => { addKeys([${JSON.stringify(ramKey)}], null, null, 'Mem'); setEdit(false); return 1; })()`);
const rcid = await E(`Object.keys(S.L.cells).find(id => S.L.cells[id].key === ${JSON.stringify(ramKey)})`);
const cellEl = `document.querySelector('#view .dc[data-cid="${rcid}"]')`;
ok('a memory cell shows GB, a tenth at a time', await until(`(() => { const el = ${cellEl}; return !!el && el.querySelector('.u').textContent === 'GB' && /^\\d+\\.\\d$/.test(el.querySelector('.v')._ot || ''); })()`, 6000),
  await E(`(() => { const el = ${cellEl}; return el && (el.querySelector('.v')._ot + ' ' + el.querySelector('.u').textContent); })()`));
ok('the value is the MB one over 1024', await E(`(() => { const r = BYKEY.get(${JSON.stringify(ramKey)}), el = ${cellEl}; return Math.abs(parseFloat(el.querySelector('.v')._ot) - r.v / 1024) < 0.06; })()`));
ok('its caption: how much of it is in use, of the size installed', await until(`(() => { const r = BYKEY.get(${JSON.stringify(ramKey)}), a = BYKEY.get(${JSON.stringify(availKey)}); if (r.v == null || a.v == null) return false; const size = memSize((r.v + a.v) / 1024), want = Math.round(r.v / 1024 / size * 100) + '% of ' + size + ' GB'; return ${cellEl}.querySelector('.tc').textContent === want; })()`, 6000),
  await E(`${cellEl}.querySelector('.tc').textContent`));
ok('the size is the one on the box: 64 GB of RAM (Windows can use 61.7), a 32 GB card (31.8), 11 GB stays 11', await E('memSize(61.65) === 64 && memSize(31.84) === 32 && memSize(10.99) === 11 && memSize(16) === 16'));
ok('Storage shows it in GB too', await E(`/ GB$/.test(valTxt(BYKEY.get(${JSON.stringify(ramKey)})))`), await E(`valTxt(BYKEY.get(${JSON.stringify(ramKey)}))`));
await E(`(() => { setEdit(true); selectCell(${JSON.stringify(rcid)}); return 1; })()`); await p.sleep(300);
await E(`document.querySelector('#iMode button[data-v="y"]').click()`); await p.sleep(250);
ok('its lines are typed in GB', await E(`/GB/.test(document.querySelector('.gate-y span').textContent)`), await E(`document.querySelector('.gate-y span').textContent`));
await E(`(() => { const i = $('iY'); i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`); await p.sleep(200);
ok('and kept in MB, as the host reads them (1 GB = 1024 MB)', await E(`S.L.cells[${JSON.stringify(rcid)}].gates.y === 1024`), await E(`S.L.cells[${JSON.stringify(rcid)}].gates.y`));
ok('the scale under the lines reads GB', await E(`[...document.querySelectorAll('#gScale .tk')].some(t => t.textContent === '1.0')`), await E(`$('gScale').textContent`));
ok('over its line, the caption says so in GB', await until(`/^over yellow 1\\.0$/.test(${cellEl}.querySelector('.tc').textContent)`, 8000), await E(`${cellEl}.querySelector('.tc').textContent`));
const mbLine = await (async () => { let t0 = Date.now(); while (Date.now() - t0 < 9000) { const m = text(join(data, 'alerts.log')).match(/YELLOW\s+Physical Memory Used: ([\d.]+) GB/); if (m) return m; await p.sleep(300); } return null; })();
ok('the warning log has it in GB too', !!mbLine, text(join(data, 'alerts.log')).trim().split('\n').slice(-2).join(' | '));
await E(`(() => { const i = $('iY'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#iMode button[data-v="none"]').click(); return 1; })()`); await p.sleep(200);

// ---- G1 / G2: hidden from Storage ----
await E('(() => { DR.L.pinned = true; syncDrawers(); query = ""; $("q").value = ""; typeFilter = "all"; renderStorage(); return 1; })()'); await p.sleep(300);
const k1 = await E('rows.find(x => !x.g).r.key');
await E(`(() => { const b = document.querySelector('#vspace .vrow.r[data-key="${k1}"] [data-act="hide"]'); b.click(); return 1; })()`); await p.sleep(250);
ok('the eye on a row hides it from Storage', await E(`!rows.some(x => !x.g && x.r.key === ${JSON.stringify(k1)}) && S.hide.r.includes(${JSON.stringify(k1)})`));
// (with what's hidden by default too: the made-up board fan at 0 rpm, once the host has seen it)
const autoN = await E('READ.filter(r => hidOf(r) === 2).length');
ok('a Hidden chip counts what is hidden', await E(`!!document.querySelector(".chip.hidchip") && new RegExp("Hidden " + (1 + ${autoN}) + "\\\\b").test(document.querySelector(".chip.hidchip").textContent)`), await E('document.querySelector(".chip.hidchip") && document.querySelector(".chip.hidchip").textContent') + ' (' + autoN + ' by default)');
await E('document.querySelector(".chip.hidchip").click()'); await p.sleep(250);
ok('the Hidden chip lists it, with an eye to bring it back', await E(`rows.filter(x => !x.g).length === 1 + ${autoN} && !!document.querySelector('#vspace .vrow.r[data-key="${k1}"] [data-act="unhide"]')`));
await E(`document.querySelector('#vspace .vrow.r[data-key="${k1}"] [data-act="unhide"]').click()`); await p.sleep(250);
ok('the eye brings it back', await E(`!S.hide.r.includes(${JSON.stringify(k1)}) && !hidOf(BYKEY.get(${JSON.stringify(k1)}))`));
await E('(() => { typeFilter = "all"; renderStorage(); return 1; })()'); await p.sleep(200);
const s0 = await E('rows.find(x => x.g).s');
await E(`document.querySelector('#vspace .vrow.g[data-gs="${s0}"] [data-act="hides"]').click()`); await p.sleep(250);
ok('a whole sensor hides from its row', await E(`!rows.some(x => x.g && x.s === ${s0}) && S.hide.s.includes(SENS[${s0}].key)`));
await E(`(() => { typeFilter = "hidden"; renderStorage(); return 1; })()`); await p.sleep(200);
await E(`document.querySelector('#vspace .vrow.g[data-gs="${s0}"] [data-act="unhides"]').click()`); await p.sleep(250);
ok('and comes back the same way', await E(`!S.hide.s.includes(SENS[${s0}].key) && READ.filter(r => r.s === ${s0}).every(r => !hidOf(r))`));
// by default: what HWiNFO has only ever seen at 0, and an integrated GPU next to a discrete one. The host's own
// numbers first (HWDECK_FAKEZERO: a board fan and a GPU fan at 0 rpm all along)
ok('the host finds a board fan at 0 rpm all along: hidden by default', await until('!!feed.zero && [...feed.zero].some(k => { const r = BYKEY.get(k); return !!r && r.unit === "RPM" && /^Fake Motherboard/.test(SENS[r.s].name) && hidOf(r) === 2; })', 15000),
  await E('JSON.stringify([...(feed.zero || [])])'));
ok('a GPU fan at 0 rpm (stopped at idle on purpose) stays in sight', await E('(() => { const g = READ.find(r => r.label === "GPU Fan1" && /^dGPU/.test(SENS[r.s].name)); return !!g && !feed.zero.has(g.key) && hidOf(g) === 0; })()'));
await E(`(() => { feed.zero = new Set([${JSON.stringify(k1)}]); typeFilter = 'all'; renderStorage(); return 1; })()`); await p.sleep(200);
ok('a reading only ever at 0 is hidden by default, under Hidden', await E(`hidOf(BYKEY.get(${JSON.stringify(k1)})) === 2 && !rows.some(x => !x.g && x.r.key === ${JSON.stringify(k1)})`));
await E(`(() => { typeFilter = 'hidden'; renderStorage(); document.querySelector('#vspace .vrow.r[data-key="${k1}"] [data-act="unhide"]').click(); return 1; })()`); await p.sleep(250);
ok('shown again on asking, it stays shown', await E(`hidOf(BYKEY.get(${JSON.stringify(k1)})) === 0 && S.hide.show.includes(${JSON.stringify(k1)})`));
ok('an integrated GPU hides next to a discrete one', await E(`(() => { const was = SENS; SENS = was.concat([{ key: 'ig.0', name: 'iGPU [#1]: Fake Radeon', short: 'iGPU' }]); const r = { key: 'ig.0/x', s: SENS.length - 1, t: 'temp', label: 'GPU Temperature' }; const v = hidOf(r) === 2; SENS = was; igpuOf = null; return v; })()`));
const hideSaved = await (async () => { let t0 = Date.now(); while (Date.now() - t0 < 4000) { try { const st = JSON.parse(text(join(data, 'state.json')).replace(/^﻿/, '')); if (st.hide && st.hide.show.includes(k1)) return true; } catch (e) { } await p.sleep(250); } return false; })();
ok('what is hidden is kept with this PC\'s view (state.json), not in layouts', hideSaved && await E('!("hide" in S.L)'));
await E('(() => { feed.zero = new Set(); S.hide = cleanHide({}); hideSets(); typeFilter = "all"; renderStorage(); saveState(); return 1; })()');

// ---- 6: a Customize change leaves the dashboard as it is ----
await E('(() => { window.__rv = 0; const f = renderView; renderView = function (...a) { window.__rv++; return f.apply(this, a); }; return 1; })()');
await E('$("gamesBtn").click()'); await p.sleep(500);
await E('$("gcustom").click()'); await p.sleep(300);
const rv0 = await E('window.__rv');
await E('document.querySelector("#gcz [data-gz=addsec]").click()'); await p.sleep(300);
ok('a Customize change is saved and undoable without drawing the dashboard again', await E(`window.__rv === ${rv0} && gxLayout().secs.length === 6 && undoStack.length > 0`), await E('window.__rv'));
await E('$("gmodal").classList.remove("open")'); await p.sleep(450);
ok('closing the popup closes Customize (its readings no longer streamed)', await E('!GZ.on && gzKeys.length === 0 && $("gcz").hidden'));
await E('(() => { undo(); return 1; })()');

// ---- 2: the sessions and warnings popups ----
const now = Math.floor(Date.now() / 1000);
const many = [];
for (let i = 0; i < 40; i++) { const st = now - 3600 * (i + 2); many.push(JSON.stringify({ game: 'Game ' + i, start: st, end: st + 1800, from: st, secs: 1800, front: 1800, fps: 100 + i, low: 80, items: [['GPU temp', '°C', 60, 70, 80, 88, 1, null, 0]], warns: 0 })); }
writeFileSync(join(data, 'games.log'), many.join('\r\n') + '\r\n');
await E('$("gamesBtn").click()');
ok('the sessions popup opens with the newest session built, the others waiting to be opened', await until('document.querySelectorAll("#glist .gx-sess").length === 40', 6000) &&
  await E('!!document.querySelector("#glist .gx-sess.open .gx-in") && document.querySelectorAll("#glist .gx-lz").length === 39'), await E('document.querySelectorAll("#glist .gx-lz").length'));
await E('[...document.querySelectorAll("#glist .gx-sess")][5].querySelector(".gx-row").click()'); await p.sleep(300);
ok('a session builds its details when it opens', await E('(() => { const s = [...document.querySelectorAll("#glist .gx-sess")][5]; return s.classList.contains("open") && !s.querySelector(".gx-lz") && !!s.querySelector(".gx-in .gx-acts"); })()'));
await E('$("gmodal").classList.remove("open")'); await p.sleep(60);
ok('it keeps its list while it fades out (the card doesn\'t shrink and jump)', await E('!!$("glist").firstChild'));
await p.sleep(400);
ok('closing it lets the list and the log text go', await E('!$("glist").firstChild && gxSs.length === 0 && gxText === ""'));
await E('(() => { window.__games = 0; const f = onHost; onHost = m => { if (m && m.t === "games") window.__games++; return f(m); }; return 1; })()');
await host({ t: 'keep', games: 30, warns: 30 });
ok('the host answers with the log while it is closed', await until('window.__games > 0', 4000));
await p.sleep(200);
ok('an answer while it is closed is neither drawn nor kept', await E('!$("glist").firstChild && gxText === ""'));
ok('the list keeps only the days kept', await E(`(() => { renderGames(${JSON.stringify(JSON.stringify({ game: 'Ancient', start: now - 40 * 86400, end: now - 40 * 86400 + 600, from: now - 40 * 86400, secs: 600, front: 600, items: [], warns: 0 }))}); const n = gxSs.length; $('glist').innerHTML = ''; gxSs = []; return n === 0; })()`));
const day = 24 * 3600, tf = Array.from({ length: 1440 }, () => 120);
ok('a session over 24 h says its chart is the first 24 hours, with the days on its ends', await E(`(() => { const x = { game: 'Long', custom: 1, start: ${now - 30 * 3600}, end: ${now}, from: ${now - 30 * 3600}, secs: ${30 * 3600}, front: 0, fps: 120, low: 90, items: [], warns: 0, g: 100, c: 0, f: 0, tf: ${JSON.stringify(tf)}, tl: ${JSON.stringify(tf.map(() => 90))}, tb: 'g'.repeat(1440), tc: [] }; const h = gxTimeline(x, gxSplit(x), 0); return /the first 24 hours/.test(h) && /class="e0">(sun|mon|tue|wed|thu|fri|sat) /.test(h); })()`));
// warnings: 700 episodes, shown 300 at a time
const L = [];
for (let i = 0; i < 700; i++) { const t = new Date(Date.now() - (700 - i) * 60000), p2 = n => ('0' + n).slice(-2), st = t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate()) + ' ' + p2(t.getHours()) + ':' + p2(t.getMinutes()) + ':' + p2(t.getSeconds()); L.push(st + '  YELLOW  Cell ' + i + ': 1', st.slice(0, 17) + p2((t.getSeconds() + 5) % 60) + '  OK      Cell ' + i + ': back to normal (peak 1)'); }
await E(`(() => { $('wmodal').classList.add('open'); renderWarnings(${JSON.stringify(L.join('\n'))}); return 1; })()`);
ok('the warnings popup shows the newest 300 rows and a button for the rest', await E('document.querySelectorAll("#wlist > .wrow").length === 300 && /Show older \\(400 more rows\\)/.test($("wMore").textContent)'), await E('[document.querySelectorAll("#wlist > .wrow").length, $("wMore") && $("wMore").textContent]'));
await E('$("wMore").click()'); await p.sleep(200);
ok('the button adds 300 more', await E('document.querySelectorAll("#wlist > .wrow").length === 600'));
// a row of several episodes draws them when it opens; a line that warns below gives the row its lowest peak
{
  const d0 = new Date(); d0.setHours(0, 1, 0, 0);
  const base = Math.max(d0.getTime(), Date.now() - 30 * 60000), p2 = n => ('0' + n).slice(-2);
  const f = ms => { const t = new Date(ms); return t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate()) + ' ' + p2(t.getHours()) + ':' + p2(t.getMinutes()) + ':' + p2(t.getSeconds()); };
  const Lw = [];
  [[0, 950, 900], [120000, 400, 380], [240000, 700, 690]].forEach(([d, at, pk]) => Lw.push(f(base + d) + '  YELLOW  Pump: ' + at + ' RPM (under its line)', f(base + d + 30000) + '  OK      Pump: back to normal (peak ' + pk + ' RPM)'));
  await E(`(() => { renderWarnings(${JSON.stringify(Lw.join('\n'))}); return 1; })()`);
  ok('a row for a line that warns below shows its lowest peak', await E('/^peak 380 RPM/.test(document.querySelector("#wlist .wgrp .wmeta").textContent)'), await E('document.querySelector("#wlist .wgrp") && document.querySelector("#wlist .wgrp .wmeta").textContent'));
  ok('its episodes are drawn when it opens, not before', await E('!document.querySelector("#wlist .wsub").firstChild') &&
    await E('(() => { document.querySelector("#wlist .wgrp").click(); return document.querySelectorAll("#wlist .wsub.open .wrow").length === 3; })()'));
}
await E('$("wmodal").classList.remove("open")'); await p.sleep(450);
ok('closing it lets the list go', await E('!$("wlist").firstChild && wGroups.length === 0'));

// ---- 7: shown again without a hidden draw: nothing is drawn again; a real minimize with a draw while hidden: once ----
await E('(() => { setEdit(false); window.__rv = 0; drawnHidden = false; return 1; })()'); await p.sleep(300);
await E('(() => { onHost({ t: "shown" }); return 1; })()'); await p.sleep(400);
ok('the window coming back from the taskbar does not rebuild a view drawn on screen', await E('window.__rv === 0'), await E('window.__rv'));
await E('(() => { window.__shown = 0; const f = onHost; onHost = m => { if (m && m.t === "shown") window.__shown++; return f(m); }; send({ t: "win", a: "min" }); return 1; })()');
const hid = await until('document.hidden', 4000);
await E('(() => { renderView(false); return 1; })()');   // (a change drawn while minimized)
ok('minimized through the host, a view drawn then is marked to measure again', hid && await E('drawnHidden === true'), await E('JSON.stringify([document.hidden, drawnHidden])'));
await E('(() => { window.__rv = 0; send({ t: "win", a: "max" }); return 1; })()');   // (a test copy comes back as it was, never activated)
const back = await until('!document.hidden && window.__shown > 0', 5000);
await p.sleep(500);
ok('back on screen, the host says so and it is measured again once', back && await E('window.__rv >= 1 && !drawnHidden'), await E('JSON.stringify([document.hidden, window.__shown, window.__rv, drawnHidden])'));

// ---- 8: a layout file of either shape imports ----
const slot = { v: 1, name: 'From the demo', layout: JSON.parse(await E('JSON.stringify(S.L)')) };
await E(`onHost({ t: 'imported', slot: 3, data: ${JSON.stringify({ hwdeck: 1, slot })} })`); await p.sleep(200);
await E(`onHost({ t: 'imported', slot: 4, data: ${JSON.stringify(slot)} })`); await p.sleep(200);
ok('the app\'s file and a bare slot both import', await E('!!S.slots[3] && !!S.slots[4] && S.slots[3].name === "From the demo" && S.slots[4].name === "From the demo"'));

// ---- 4: a value hovering on its line is one episode ----
const tKey = await E('(READ.find(r => r.label === "CPU (Tctl/Tdie)") || {}).key');
await E(`(() => { addKeys([${JSON.stringify(tKey)}], null, null, 'Hover'); const id = Object.keys(S.L.cells).find(i => S.L.cells[i].key === ${JSON.stringify(tKey)}); mutate(() => { S.L.cells[id].name = 'Hover test'; S.L.cells[id].gates = { mode: 'y', dir: 'above', y: 60, r: NaN, hold: 3 }; }); return 1; })()`);
// (4 s over the line after each calm second: the old rule restarted the 3 s hold, counted those seconds as calm and
// logged OK, then YELLOW again; one-second runs never reached the hold, so they passed on the old rule too)
await host({ t: 'fakePin', key: tKey, v: 61 }); await p.sleep(5000);
for (let i = 0; i < 3; i++) { await host({ t: 'fakePin', key: tKey, v: 59 }); await p.sleep(1000); await host({ t: 'fakePin', key: tKey, v: 61 }); await p.sleep(4000); }
const lastHot = Math.floor(Date.now() / 1000);
await host({ t: 'fakePin', key: tKey, v: 50 }); await p.sleep(5500);
const hv = text(join(data, 'alerts.log')).split('\n').filter(l => /Hover test/.test(l));
const okAt = (hv.find(l => /\sOK\s/.test(l)) || '').slice(0, 25), okT = okAt ? new Date(okAt.replace(' ', 'T')).getTime() / 1000 : 0;
ok('a value hovering on its line is one episode (one YELLOW, one OK after the last time over it)', hv.filter(l => /YELLOW/.test(l)).length === 1 && hv.filter(l => /\sOK\s/.test(l)).length === 1 && okT >= lastHot, hv.map(l => l.slice(11, 70)).join(' | '));
await host({ t: 'fakePin', key: tKey, v: null });

// ---- graph scales: a far spike cut at the top, never below zero, a sensible span for the unit ----
ok('a far spike is cut at the top, a short temperature peak and a percentage burst are not', await E(`(() => { const fps = Array.from({ length: 120 }, (_, i) => 220 + (i % 7) * 10); fps[50] = 1702;
  const t = Array.from({ length: 900 }, (_, i) => 50 + (i % 5)); t[400] = 70; const ld = Array.from({ length: 900 }, (_, i) => i % 300 < 10 ? 99 : 15);
  const f = scaleTop(fps, 'FPS'); return f.cut && f.top < 400 && f.max === 1702 && !scaleTop(t, ${JSON.stringify('°C')}).cut && !scaleTop(ld, '%').cut; })()`));
const bigTry = (d, pk, unit, dec) => E(`(() => { const cv = document.createElement('canvas'); cv.style.cssText = 'width:600px;height:240px;position:fixed;left:-9999px;top:0'; document.body.appendChild(cv);
  const was = bigMap; drawBigGraph(cv, ${JSON.stringify(d)}, {}, ${dec}, ${JSON.stringify(unit)}, false, ${JSON.stringify(pk)}, 3600000, null); const m = bigMap; bigMap = was; cv.remove();
  return { bottom: m.h - m.padB, top: m.padT, plot: m.h - m.padT - m.padB, at: ${JSON.stringify([0, 52, 53, 250, 1702])}.map(v => m.Y(v)) }; })()`);
{
  const d = Array.from({ length: 60 }, (_, i) => 220 + (i % 7) * 10), pk = d.map(x => x + 30); pk[40] = 1702;
  const g = await bigTry(d, pk, 'FPS', 0);
  ok('FPS in the popup: nothing below 0, the line has room (the scale follows it, not the spike), the spike sits at the top edge', g.at[0] >= g.bottom - 0.5 && g.at[3] < g.bottom - g.plot * 0.2 && Math.abs(g.at[4] - g.top) < 0.5, JSON.stringify(g));
  const s = await bigTry(Array.from({ length: 60 }, (_, i) => i < 50 ? 53 : 52), null, '°C', 1);
  ok('a steady temperature keeps at least a 10 degree scale (a 1 degree step stays small)', s.at[1] - s.at[2] < s.plot * 0.12, JSON.stringify(s));
}
// ---- the fade toward a line, per cell ----
ok('a cell keeps its fade (0 or more), anything else is dropped', await E(`(() => { const L = cleanLayout({ v: 1, cats: [{ id: 'a', name: 'A', cells: ['x', 'y', 'z'] }], cells: { x: { key: READ[0].key, gates: { mode: 'y', dir: 'above', y: 90, hold: 0, fade: 5 } }, y: { key: READ[1].key, gates: { mode: 'y', dir: 'above', y: 90, hold: 0, fade: -1 } }, z: { key: READ[2].key, gates: { mode: 'y', dir: 'above', y: 90, hold: 0, fade: 0 } } } });
  return L.cells.x.gates.fade === 5 && !('fade' in L.cells.y.gates) && L.cells.z.gates.fade === 0; })()`));
await E(`(() => { addKeys([${JSON.stringify(tKey)}], null, null, 'Fade'); const id = Object.keys(S.L.cells).filter(i => S.L.cells[i].key === ${JSON.stringify(tKey)}).pop(); window.__fid = id; mutate(() => { S.L.cells[id].name = 'Fade test'; S.L.cells[id].gates = { mode: 'yr', dir: 'above', y: 60, r: 70, hold: 0 }; }); setEdit(false); return 1; })()`);
const fe = () => E('(() => { const e = evalCell(__fid, S.L.cells[__fid], true, true); return { lvl: e.lvl, warm: e.warm, warmR: e.warmR }; })()');
const setFade = f => E(`(() => { mutate(() => { if (${f === undefined}) delete S.L.cells[__fid].gates.fade; else S.L.cells[__fid].gates.fade = ${f === undefined ? 0 : f}; }); return 1; })()`);
await host({ t: 'fakePin', key: tKey, v: 57 }); await p.sleep(1800);
let fx = await fe();
ok('3 under yellow: it fades in by default (the last 12%, 7.2 here)', fx.lvl === 0 && fx.warm >= 0.5 && fx.warm <= 0.65, JSON.stringify(fx));
await setFade(2); await p.sleep(300); fx = await fe();
ok('its own fade of 2: not yet', fx.warm === 0, JSON.stringify(fx));
await setFade(5); await p.sleep(300); fx = await fe();
ok('a fade of 5: 40% of the way', Math.abs(fx.warm - 0.4) < 0.06, JSON.stringify(fx));
await setFade(0); await p.sleep(300); fx = await fe();
ok('a fade of 0: no fade at all', fx.warm === 0, JSON.stringify(fx));
await setFade(undefined); await host({ t: 'fakePin', key: tKey, v: 66 }); await p.sleep(1800); fx = await fe();
ok('past yellow, 4 under red: yellow, fading toward red', fx.lvl === 1 && fx.warmR >= 0.4 && fx.warmR <= 0.6, JSON.stringify(fx));
await setFade(0); await p.sleep(300); fx = await fe();
ok('and no fade toward red with 0', fx.lvl === 1 && fx.warmR === 0, JSON.stringify(fx));
await E('(() => { setEdit(true); selectCell(__fid); return 1; })()'); await p.sleep(300);
ok('the setting is in the cell\'s Lines, typed in its unit', await E('!!$("iFade") && $("iFade").placeholder === "auto" && $("iFade").value === "0"'));
await E('(() => { setEdit(false); return 1; })()');
await host({ t: 'fakePin', key: tKey, v: null });

// ---- calmer during games: Full is Minimal while a game is in front, back after; a setting (on by default) turns it off ----
const mode = () => E('document.documentElement.dataset.motion');
await E(`(() => { S.motion = 'full'; S.gameCalm = true; applyMotion(); saveState(); return 1; })()`);
await host({ t: 'fakeGame', game: 'Calm Game', front: true });
ok('a game in front: Full turns Minimal, the pick stays Full', await until('document.documentElement.dataset.motion === "minimal" && motionPicked() === "full" && !motionOn()', 5000), await mode());
await E('$("setBtn").click()'); await p.sleep(250);
ok('Settings shows Full picked and says why it is Minimal now', await E('document.querySelector("#sMotion button.on").dataset.m === "full" && /a game is in front/.test($("setbody").textContent) && $("sCalm").classList.contains("on")'));
await E('$("sCalm").click()'); await p.sleep(700);
ok('"Calmer during games" off: Full again at once, and saved', (await mode()) === 'full' && JSON.parse(text(join(data, 'state.json')).replace(/^﻿/, '')).gameCalm === false, await mode());
await E('$("sCalm").click()'); await p.sleep(700); await E('$("setmodal").classList.remove("open")');
ok('back on: Minimal again while the game is in front, and saved', (await mode()) === 'minimal' && JSON.parse(text(join(data, 'state.json')).replace(/^﻿/, '')).gameCalm === true, await mode());
await host({ t: 'fakeGame', game: 'Calm Game', front: false });
ok('the game in the background: Full again', await until('document.documentElement.dataset.motion === "full"', 5000), await mode());
await host({ t: 'fakeGame', game: null });
await E(`(() => { S.motion = 'minimal'; applyMotion(); return 1; })()`); await host({ t: 'fakeGame', game: 'Calm Game', front: true });
ok('Minimal or Off picked by hand stay as they are during a game', await until('feed.front === true', 5000) && (await mode()) === 'minimal');
await host({ t: 'fakeGame', game: null });
await E(`(() => { S.motion = 'full'; applyMotion(); saveState(); return 1; })()`);

ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
