// The internet (2.4.8): HW Deck's own two readings (download and upload now, from Windows' counters), the Internet
// cell and its popup, the speed test's switch in Settings (off to start) and its Test every, the same setting in the
// popup and in Settings, a test (a --fake copy plays a made-up one and sends nothing), the Starter's "Network".
// Start it on an EMPTY data folder:
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9242
//   HWDeck.exe --fake 300 --data test\data-net --no-starter
// then: node test/e2e-net.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9242);
const data = process.argv[3] || 'test/data-net';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x), J = async x => JSON.parse(await ev(`JSON.stringify(${x})`));
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(350); };

ok('catalog arrives, with the internet\'s two readings under HW Deck', await until('feed.got && BYKEY.has(NETD) && BYKEY.has(NETU)', 15000), await ev('READ.length'));
const rd = await J(`[NETD, NETU].map(k => { const r = BYKEY.get(k); return [r.label, r.unit, r.kind || null, SENS[r.s].name]; })`);
ok('"Download now" (kind net) and "Upload now", Mbit/s, sensor "HW Deck"', JSON.stringify(rd) === JSON.stringify([['Download now', 'Mbit/s', 'net', 'HW Deck'], ['Upload now', 'Mbit/s', null, 'HW Deck']]), rd);
ok('the speed test is off to start, and the host says so every second', await until('!!feed.net && feed.net.on === false && feed.net.every === 8', 5000), await ev('JSON.stringify(feed.net)'));
ok('Storage\'s value: one decimal under 100, whole above', await ev(`valTxt({ unit: 'Mbit/s', v: 3.24, key: NETD }) === '3.2 Mbit/s' && valTxt({ unit: 'Mbit/s', v: 938.4, key: NETD }) === '938 Mbit/s'`));
ok('its part: none (no game colour under Spectrum)', await ev(`partOf({ key: NETD }) === null && partOf({ key: NETU }) === null`));

// the cell
await ev('(() => { addKeys([NETD], null, null, "Network"); setEdit(false); showScreen("tiles"); S.motion = "off"; applyMotion(); return 1; })()');
await p.sleep(2500);
const cid = await ev(`Object.keys(S.L.cells).find(id => S.L.cells[id].key === NETD)`);
const el = `document.querySelector('#view .tile[data-cid="${cid}"]')`;
ok('a new cell of it is named "Internet"', await ev(`S.L.cells["${cid}"].name === 'Internet'`), await ev(`JSON.stringify(S.L.cells["${cid}"])`));
ok('its tile: download now in Mbit/s, "upload N" under it (no arrows, his 11-12 "revert to the previous")', await until(`/^Internet [0-9.]+ ?Mbit\\/s upload [0-9.]+( Mbit\\/s)?$/.test(${el}.innerText.replace(/\\s+/g, ' ').trim())`, 6000), await ev(`${el}.innerText.replace(/\\s+/g, ' ').trim()`));
ok('its upload is streamed with it', await ev(`cellKeys().includes(NETU) || [...cellKeys()].includes(NETU)`));

// the popup, the test off: nothing of the speed test
await ev(`(() => { openDetail("${cid}"); return 1; })()`); await p.sleep(1500);
const pop = () => J(`(() => { const x = document.querySelector('#mextra .xn-st'), b = x && x.querySelector('[data-net]'), bar = x && x.querySelector('.xn-bar i'); return { st: !!x, link: (document.querySelector('#mdesc .xn-d') || {}).textContent || '', btn: b ? b.textContent.trim() : null, dis: b ? b.disabled : null,
  boxes: x ? [...x.querySelectorAll('.xn-box3 b')].map(e => e.innerText.replace(/\\s+/g, '')) : [], lines: x ? [...x.querySelectorAll('.xn-bl')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()) : [], bar: bar ? String(100 * (new DOMMatrix(getComputedStyle(bar).transform).a)) : null,
  every: x ? (x.querySelector('[data-net-every].on') || {}).textContent : null, rows: [...document.querySelectorAll('#mextra .xn-tests .wrow')].map(e => [...e.children].map(c => (c.querySelector('svg') ? (c.querySelector('svg').getAttribute('aria-label') === 'download' ? 'D' : 'U') : '') + c.textContent.trim()).join('|')) }; })()`);
let s0 = await pop();
ok('the popup with the test off: the adapter in its description, no speed test part', !s0.st && s0.link.length > 0, s0);
await ev('closeDetail()'); await p.sleep(500);

// Settings: "Internet" between Games and Data, the switch, Test every
await click('#setBtn'); await p.sleep(800);
const secs = await J(`[...document.querySelectorAll('#setbody .setsec h3')].map(h => h.textContent)`);
ok('Settings: a section "Internet" between Games and Data', secs.indexOf('Internet') === secs.indexOf('Games') + 1 && secs.indexOf('Data') === secs.indexOf('Internet') + 1, secs);
ok('its switch off, no Test every row', await ev(`!$('sNet').classList.contains('on') && !document.querySelector('#setbody [data-net-every]')`));
await click('#sNet'); await p.sleep(400);
ok('on: the host takes it (settings.json and the tick), Test every shows 8h', await until(`feed.net.on === true && document.querySelector('#setbody [data-net-every].on') && document.querySelector('#setbody [data-net-every].on').textContent === '8h'`, 4000));
ok('settings.json has the switch on', (() => { try { return JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).netTest === true; } catch (e) { return false; } })());
await ev(`(() => { $('setmodal').classList.remove('open'); return 1; })()`); await p.sleep(400);

// the popup with the test on
await ev(`(() => { openDetail("${cid}"); return 1; })()`); await p.sleep(1500);
s0 = await pop();
ok('the popup with the test on: Test now, three empty boxes, "no test yet", Test every 8h', s0.st && s0.btn === 'Test now' && !s0.dis && JSON.stringify(s0.boxes) === '["--","--","--"]' && /^no test yet/.test(s0.lines[0] || '') && s0.every === '8h', s0);
// one setting in both places: the popup's 4h shows in Settings, Settings' 12h in the popup
await click('#mextra [data-net-every="4"]');
ok('Test every 4h in the popup: the host has it', await until('feed.net.every === 4', 4000), await ev('JSON.stringify(feed.net)'));
await ev('closeDetail()'); await p.sleep(400);
await click('#setBtn'); await p.sleep(800);
ok('and Settings shows 4h', await ev(`(document.querySelector('#setbody [data-net-every].on') || {}).textContent === '4h'`));
await click('#setbody [data-net-every="12"]');
ok('12h in Settings: the host has it', await until('feed.net.every === 12', 4000));
await ev(`(() => { $('setmodal').classList.remove('open'); return 1; })()`); await p.sleep(400);
await ev(`(() => { openDetail("${cid}"); return 1; })()`); await p.sleep(1500);
ok('and the popup shows 12h', (await pop()).every === '12h');

// a test (made up in a --fake copy)
await click('#mextra [data-net="test"]');
const seen = [];
for (let i = 0; i < 26; i++) { await p.sleep(500); const s = await pop(), t = await ev(`${el} ? ${el}.innerText.replace(/\\s+/g, ' ').trim() : ''`); seen.push({ s, t }); if (i > 4 && s.btn === 'Test now') break; }
const runs = seen.filter(x => x.s.btn === 'Testing');
ok('while it runs: Testing, off; testing ping, download, upload', runs.length >= 6 && runs.every(x => x.s.dis) && ['ping', 'download', 'upload'].every(w => runs.some(x => new RegExp('testing ' + w).test(x.s.lines[0] || ''))), runs.length ? runs.map(x => x.s.lines[0]) : seen.slice(0, 2));
const pcts = runs.map(x => parseFloat(x.s.bar)).filter(v => !isNaN(v));
ok('the bar only grows', pcts.length >= 4 && pcts.every((v, i) => !i || v >= pcts[i - 1] - 0.01), pcts);
ok('the cell says "speed test, N s left"', runs.some(x => /speed test, \d+ s left/.test(x.t)), runs.map(x => x.t).slice(0, 3));
ok('the list\'s top row reads running', runs.some(x => /\|running$/.test(x.s.rows[0] || '')), runs.map(x => x.s.rows[0]).slice(0, 3));
await p.sleep(1200);
const after = await pop();
ok('after: Test now, three numbers, "last today HH:MM", the result on top of the list', after.btn === 'Test now' && after.boxes.every(v => /^\d+(Mbit\/s|ms)$/.test(v)) && /^last today \d\d:\d\d/.test(after.lines[0] || '') && /^today \d\d:\d\d\|made up\|\d+ms\|D\d+Mbit\/s\|U\d+Mbit\/s$/.test(after.rows[0] || ''), after);
ok('net.json keeps it: every 12, the result', (() => { try { const n = JSON.parse(readFileSync(join(data, 'net.json'), 'utf8')); return n.every === 12 && n.tests.length === 1 && /down/.test(n.tests[0][1]); } catch (e) { return false; } })());

// off again: nothing of it in the popup
await ev('closeDetail()'); await p.sleep(400);
await click('#setBtn'); await p.sleep(800); await click('#sNet'); await p.sleep(600);
ok('off again: the host has it, Test every gone from Settings', await until(`feed.net.on === false && !document.querySelector('#setbody [data-net-every]')`, 4000));
await ev(`(() => { $('setmodal').classList.remove('open'); return 1; })()`); await p.sleep(400);
await ev(`(() => { openDetail("${cid}"); return 1; })()`); await p.sleep(1200);
ok('and the popup has no speed test part', !(await pop()).st);
await ev('closeDetail()'); await p.sleep(400);

// Overview and Grid
await ev('(() => { showScreen("overview"); return 1; })()'); await p.sleep(1500);
ok('Overview: its category\'s card', await ev(`!!document.querySelector('#view .dc[data-cid="${cid}"]')`));
await ev('(() => { showScreen("grid"); return 1; })()'); await p.sleep(1500);
ok('Grid: its row, download and upload', await ev(`(() => { const r = document.querySelector('#view [data-cid="${cid}"]'); return !!r && (r.innerText.match(/Mbit\\/s/g) || []).length >= 2; })()`), await ev(`(() => { const r = document.querySelector('#view [data-cid="${cid}"]'); return r ? r.innerText.replace(/\\s+/g, ' ') : null; })()`));
await ev('(() => { showScreen("tiles"); return 1; })()'); await p.sleep(800);

// the Starter
const st = await J(`(() => { const L = starterLayout(); if (!L) return null; const c = L.cats.find(c => c.name === 'Network'); return c ? c.cells.map(id => [L.cells[id].key, L.cells[id].name]) : 'no Network'; })()`);
ok('the Starter: a category "Network" with the Internet cell', JSON.stringify(st) === JSON.stringify([['hwdeck.0/netdown', 'Internet']]), st);
ok('no page errors', errs.length === 0, JSON.stringify(errs));
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
p.close(); process.exit(0);
