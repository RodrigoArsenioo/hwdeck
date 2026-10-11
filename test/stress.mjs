// Scale check: run HW Deck with --fake 3000 (own --data folder), then: node test/stress.mjs [port]
// Measures what the page spends per tick with 200 cells, a drag hit test, a Storage search, and the DOM it keeps.
import { connect, checks } from './cdp.mjs';
const p = await connect(Number(process.argv[2] || 9231));
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(200); } return false; };
ok('3,000 readings arrive', await until('READ.length === 3000'), await E('READ.length'));
ok('Storage keeps about 30 rows in the page', await E('document.querySelectorAll("#vspace .vrow").length < 50'), await E('document.querySelectorAll("#vspace .vrow").length'));
const ms = await E(`(() => { const t = performance.now(); for (let i = 0; i < 20; i++) { query = 'temperature ' + (i % 9); computeRows(); } query = ''; computeRows(); return (performance.now() - t) / 21; })()`);
ok('a Storage search over 3,000 readings takes under 5 ms', ms < 5, ms.toFixed(2) + ' ms');
await E('addKeys(READ.filter((r, i) => i % 15 === 0).slice(0, 200).map(r => r.key), null, null, "Big")');
ok('200 cells in the view', await E('document.querySelectorAll("#view .dc").length === 200'));
await E(`window.__t = []; { const o = onHost; onHost = function (m) { const t = performance.now(); o(m); if (m.t === 'tick') __t.push(performance.now() - t); }; } 1`);
await p.sleep(6500);
const ticks = await E('__t.slice()');
const avg = ticks.reduce((a, b) => a + b, 0) / Math.max(1, ticks.length), mx = Math.max(...ticks);
ok('a tick with 200 cells takes under 30 ms in the page', ticks.length >= 4 && avg < 30, `${ticks.length} ticks, avg ${avg.toFixed(1)} ms, max ${mx.toFixed(1)} ms`);
const hit = await E(`(() => { const cells = document.querySelectorAll('#view .dc'); const a = cells[0].getBoundingClientRect(); drag = { kind: 'row', data: READ[1].key, started: true, ghost: document.createElement('div') };
  const t = performance.now(); for (let i = 0; i < 50; i++) hitTest(a.left + 40 + i * 7, a.top + 40 + (i % 5) * 30); const d = (performance.now() - t) / 50; drag = null; dropmark.style.display = 'none'; return d; })()`);
ok('a drag hit test with 200 cells takes under 4 ms', hit < 4, hit.toFixed(2) + ' ms');
const full = await E('(() => { const t = performance.now(); renderView(); return performance.now() - t; })()');
ok('a full redraw of 200 cells takes under 120 ms', full < 120, full.toFixed(1) + ' ms');
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
