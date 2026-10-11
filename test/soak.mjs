// A window left open: 40 cells with values changing every second for a few minutes. The page's own timers must stay
// few and on time, and its memory flat (a dashboard sits open all day).
//   node test/soak.mjs [port] [seconds]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9234);
const secs = Number(process.argv[3] || 150);
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };

ok('catalog arrives', await until('READ.length > 0 && feed.got'));
await E(`(() => { addKeys(READ.slice(0, 40).map(r => r.key), null, null, 'Soak'); setEdit(false); return 1; })()`);
await E(`(() => { window.__of = 0; const f = odoFlush; odoFlush = function () { window.__of++; return f(); }; return 1; })()`);
await p.cmd('HeapProfiler.collectGarbage');
const heap0 = (await p.cmd('Runtime.getHeapUsage')).result.usedSize;
await p.sleep((secs - 30) * 1000);
const n0 = await E('window.__of');
await p.sleep(30000);
const rate = ((await E('window.__of')) - n0) / 30;
ok('the number timer runs a few times a second, not more and more', rate < 6, rate.toFixed(1) + ' calls/s after ' + secs + ' s');
const late = await E(`new Promise(res => { const t = performance.now(); setTimeout(() => res(performance.now() - t), 100); })`);
ok('a 100 ms timer still fires on time', late < 400, Math.round(late) + ' ms');
await p.cmd('HeapProfiler.collectGarbage');
const heap1 = (await p.cmd('Runtime.getHeapUsage')).result.usedSize;
ok('the page memory stays flat', heap1 < heap0 * 2 + 4e6, (heap0 / 1e6).toFixed(1) + ' MB to ' + (heap1 / 1e6).toFixed(1) + ' MB');
ok('numbers keep changing', await E(`(() => { const a = document.querySelector('#view .dc .v')._ot; return new Promise(res => setTimeout(() => res(document.querySelector('#view .dc .v')._ot !== a), 4000)); })()`));
ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
