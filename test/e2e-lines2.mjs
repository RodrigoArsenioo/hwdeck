// Lines on both sides (1.3): a cell bad above one value and below another (a pump: yellow over 2,600, red under 300).
// The cell's colour and caption, Grid's lines column, the popup's graph, the panel, the host's warning log.
// Start a fresh copy first (an EMPTY data folder):
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9238
//   HWDeck.exe --fake 300 --data test\data-l2
// then: node test/e2e-lines2.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9238);
const data = process.argv[3] || 'test/data-l2';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const log = () => existsSync(join(data, 'alerts.log')) ? readFileSync(join(data, 'alerts.log'), 'utf8') : '';

ok('catalog arrives', await until('READ.length > 200 && feed.got'), await E('READ.length'));
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }); await p.sleep(400);

// the data: kept as given, numbers only
const cl = await E(`JSON.stringify(cleanLayout({ v: 1, cats: [{ id: 'a', name: 'A', cells: ['x', 'y'] }], cells: { x: { key: READ[0].key, gates: { mode: 'y', dir: 'above', y: 90, hold: 0, other: { r: 20, y: 'no' } } }, y: { key: READ[1].key, gates: { mode: 'y', dir: 'above', y: 90, other: 5 } } } }).cells)`);
ok('the other side kept as numbers, anything else dropped', /"x":\{[^}]*"other":\{"r":20\}/.test(cl) && !/"y":\{[^}]*"other"/.test(cl.replace(/"x":\{.*?\}\}/, '')), cl);

// a temperature: bad above its value + 60 (never), and on the other side red under its value + 30 (so: red now)
const v0 = await E(`(() => { const r = READ.find(x => x.t === 'temp' && x.v != null); window.T2 = r; return r.v; })()`);
await E(`(() => {
  const L = { v: 1, cats: [{ id: 'p', name: 'Pump', cells: ['pump'] }], cells: { pump: { key: T2.key, name: 'Two sided', graph: true, gates: { mode: 'y', dir: 'above', y: ${v0 + 60}, hold: 0, other: { r: ${v0 + 30} } } } } };
  S.L = cleanLayout(L); S.edit = false; app.classList.remove('editing'); sel = null; selCat = null; showScreen('tiles', true); afterChange(); return 1;
})()`);
await p.sleep(2500);
const st = () => E(`(() => { const t = document.querySelector('#view .tile[data-cid="pump"]'); return { red: t.classList.contains('red'), yellow: t.classList.contains('yellow'), cap: t.querySelector('.tc').textContent }; })()`);
let s = await st();
ok('red on the other side: the cell is red', s.red, JSON.stringify(s));
ok('its caption says under red', /^under red /.test(s.cap), s.cap);
ok('the host logs it in alerts.log', await (async () => { for (let i = 0; i < 20; i++) { if (/RED\s+Two sided: /.test(log())) return true; await p.sleep(300); } return false; })(), log().split('\n').slice(-3).join(' | '));

// Grid: both sides in the lines column
await E(`showScreen('grid')`); await p.sleep(1500);
const gl = await E(`document.querySelector('#view tr.dc[data-cid="pump"] .glines').textContent`);
ok('Grid shows both sides', /^over .+, under /.test(gl), gl);
await E(`showScreen('tiles')`); await p.sleep(800);

// the popup's graph gets the other side's line
await E(`openDetail('pump')`); await p.sleep(1200);
ok('the popup knows the other side', /on the other side red/.test(await E(`document.getElementById('mdesc') ? document.getElementById('mdesc').textContent : document.querySelector('#modal, .modal').textContent`)), await E(`(document.getElementById('mdesc') || {}).textContent`));
await E(`closeDetail()`); await p.sleep(500);

// yellow only on the other side; then the other side out of reach: normal
await E(`(() => { S.L.cells.pump.gates.other = { y: ${v0 + 30} }; afterChange(); return 1; })()`); await p.sleep(2200);
s = await st();
ok('yellow on the other side: yellow, under yellow', s.yellow && !s.red && /^under yellow /.test(s.cap), JSON.stringify(s));
await E(`(() => { S.L.cells.pump.gates.other = { y: ${v0 - 60}, r: ${v0 - 80} }; afterChange(); return 1; })()`); await p.sleep(2200);
s = await st();
ok('the value between the two sides: normal', !s.yellow && !s.red, JSON.stringify(s));
ok('the host logs it back to normal', await (async () => { for (let i = 0; i < 20; i++) { if (/OK\s+Two sided: back to normal/.test(log())) return true; await p.sleep(300); } return false; })(), log().split('\n').slice(-3).join(' | '));
// a line on the wrong side counts for nothing (and the panel says why)
await E(`(() => { S.L.cells.pump.gates.other = { r: ${v0 + 90} }; afterChange(); return 1; })()`); await p.sleep(1500);
s = await st();
ok('the other side past its own line: ignored', !s.yellow && !s.red, JSON.stringify(s));
await E(`(() => { setEdit(true); selectCell('pump'); return 1; })()`); await p.sleep(900);
ok('the panel has the other side and says what is wrong', await E(`!!document.getElementById('iOther') && document.getElementById('iOther').checked`) && /have to be under/.test(await E(`document.getElementById('gErr').textContent`)), await E(`document.getElementById('gErr').textContent`));
// switching it off in the panel
await E(`(() => { const c = document.getElementById('iOther'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await p.sleep(700);
ok('Also bad when below, off: gone from the cell', await E(`!S.L.cells.pump.gates.other`));
ok('no page errors', errs.length === 0, JSON.stringify(errs));
await p.cmd('Emulation.clearDeviceMetricsOverride');
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
p.close(); process.exit(0);
