// Range selector B in the cell popup (2.4.2, his design 11-07): the hours and days pills, the chart as the control (the
// wheel zooms around the pointer, a drag moves it, a double click shows the whole range), the bar under it (always
// shown; drag it, drag its ends, a click on the track brings the window there), its start and end beside its ends, the
// stats of the window, and 30d / 90d / All from the host's hours. Real pointer events. Start it on a data folder whose
// copy has some days of hours (local\demo\gen-hours.py writes 120):
//   node test/e2e-range.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9362);
const p = await connect(port), ev = p.evaluate, sleep = p.sleep;
const errs = await p.errors();
const { ok, done } = checks();
const mouse = (type, x, y, extra = {}) => p.cmd('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: type === 'mouseMoved' && !extra.buttons ? 'none' : 'left', clickCount: 1 }, extra));
const BW = () => ev('({ a: BW.a, b: BW.b, ta: BW.ta, tb: BW.tb })');
const pick = async r => { await ev(`document.querySelector('#mrng button[data-r="${r}"]').click()`); for (let i = 0; i < 50; i++) { if (await ev(`'${r}' === '15m' || !!(bigHist && bigHist.range === '${r}')`)) break; await sleep(100); } await sleep(500); };
const plot = () => ev(`(() => { const r = mgraph.getBoundingClientRect(); return { l: r.left + BIG_PADL, r: r.right - BIG_PADR, y: r.top + r.height * 0.45 }; })()`);
const bar = () => ev(`(() => { const r = mbar.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, y: r.top + r.height / 2 }; })()`);
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;
const settle = () => sleep(700);

await ev(`(() => { closeDetail(); document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); const cid = Object.keys(S.L.cells).find(k => /CPU temp/i.test(S.L.cells[k].name || '')) || Object.keys(S.L.cells)[1]; openDetail(cid); return 1; })()`);
await sleep(900);
ok('two pill groups: 15m 1h 6h 12h 24h, then 7d 30d 90d All; 15m picked', await ev(`[...mrng.querySelectorAll('.rng')].map(g => [...g.querySelectorAll('button')].map(b => b.textContent).join(' ')).join('|')`) === '15m 1h 6h 12h 24h|7d 30d 90d All' && await ev(`mrng.querySelector('.on').dataset.r`) === '15m');
ok('no Days pill or box left', await ev(`!document.querySelector('#mrng [data-r="days"]') && !document.getElementById('mdays')`));
ok('the bar is there with the whole range: start on its left, now on its right', await ev(`!mbar.hidden && mbar.offsetWidth > 100 && parseFloat(mbar.firstChild.style.left) === 0 && parseFloat(mbar.firstChild.style.right) === 0 && mbar.children[2].textContent === 'now' && /^\\d\\d:\\d\\d$/.test(mbar.children[1].textContent)`), await ev(`mbar.outerHTML.slice(0, 300)`));

for (const [r, step, len] of [['7d', 600, 1008], ['30d', 3600, 720], ['90d', 3600, 2160]]) {
  await pick(r);
  ok(r + ': from the host, ' + len + ' points of ' + step + ' s', await ev(`bigHist.range === '${r}' && bigHist.step === ${step} && bigHist.avg.length === ${len}`), await ev(`[bigHist.range, bigHist.step, bigHist.avg.length]`));
}
ok('90d has its 120 days in it (the hours kept)', await ev(`bigHist.avg.filter(x => x !== null).length > 1000`), await ev(`bigHist.avg.filter(x => x !== null).length`));
await pick('all');
ok('All: from its first hour (about 120 days)', await ev(`bigHist.range === 'all' && bigHist.step === 3600 && bigHist.avg.length >= 118 * 24 && bigHist.avg.length <= 122 * 24 && bigHist.avg[0] !== null`), await ev(`[bigHist.avg.length, bigHist.avg[0]]`));
ok('the days group shows the pill, the hours group none', await ev(`!mrng.querySelectorAll('.rng')[1].querySelector('.ri').classList.contains('off') && mrng.querySelectorAll('.rng')[0].querySelector('.ri').classList.contains('off')`));
ok('a date at the bar\'s start from 2 days on', await ev(`/^\\d{1,2} [a-z]{3}$/.test(mbar.children[1].textContent)`), await ev('mbar.children[1].textContent'));

await pick('30d');
const st0 = await ev(`$('mstats').textContent`);
// the wheel: in, around the pointer
let P = await plot(); const fx = 0.75, x = P.l + (P.r - P.l) * fx;
let w0 = await BW(); const at0 = w0.a + fx * (w0.b - w0.a);
await mouse('mouseMoved', x, P.y); await mouse('mouseWheel', x, P.y, { deltaX: 0, deltaY: -300, button: 'none' }); await settle();
let w1 = await BW();
ok('the wheel zooms in', w1.b - w1.a < 0.7 && w1.b - w1.a > 0.3, w1);
ok('the moment under the pointer stays under it', near(w1.a + fx * (w1.b - w1.a), at0, 0.01), [w1.a + fx * (w1.b - w1.a), at0]);
ok('the stats are the window\'s', await ev(`$('mstats').textContent`) !== st0);
ok('the bar is as wide as the window', await ev(`Math.abs(parseFloat(mbar.firstChild.style.right) - (1 - BW.b) * 100) < 0.01 && Math.abs(parseFloat(mbar.firstChild.style.left) - BW.a * 100) < 0.01`));
ok('its end dates follow (not now when it ends before now)', await ev(`mbar.children[2].textContent !== 'now' || BW.b > 0.999`));
await mouse('mouseWheel', x, P.y, { deltaX: 0, deltaY: 600, button: 'none' }); await settle();
ok('the wheel out: never past the whole range', near((await BW()).a, 0) && near((await BW()).b, 1), await BW());
// a drag of the chart: right is back in time
await mouse('mouseWheel', x, P.y, { deltaX: 0, deltaY: -400, button: 'none' }); await settle();
w0 = await BW();
await p.drag({ x: P.l + 200, y: P.y }, { x: P.l + 300, y: P.y }, 10); await settle();
w1 = await BW();
ok('a drag to the right goes back in time, the width kept', w1.a < w0.a && near(w1.b - w1.a, w0.b - w0.a, 0.002), [w0, w1]);
ok('by the dragged share of the window', near(w0.a - w1.a, 100 / (P.r - P.l) * (w0.b - w0.a), 0.01), [w0.a - w1.a, 100 / (P.r - P.l) * (w0.b - w0.a)]);
ok('no grab cursor left after it', await ev(`!mgraph.classList.contains('grab')`));
await p.drag({ x: P.l + 100, y: P.y }, { x: P.l + 2000, y: P.y }, 10); await settle();
ok('dragged far: stops at the range\'s start', near((await BW()).a, 0), await BW());
// a double click: the whole range
await p.dblclick(x, P.y); await settle();
ok('a double click shows the whole range again', near((await BW()).a, 0, 0.002) && near((await BW()).b, 1, 0.002), await BW());
// the bar
await ev('(bwSet(0.3, 0.5), 1)'); await sleep(100);
let B = await bar(); w0 = await BW();
await p.drag({ x: B.l + B.w * 0.4, y: B.y }, { x: B.l + B.w * 0.4 + 60, y: B.y }, 8); await sleep(200);
w1 = await BW();
ok('the bar dragged: the window moves by as much, its width kept', near(w1.a - w0.a, 60 / B.w, 0.006) && near(w1.b - w1.a, 0.2, 0.002), [w1.a - w0.a, 60 / B.w]);
w0 = w1;
await p.drag({ x: B.l + B.w * w0.a + 1, y: B.y }, { x: B.l + B.w * w0.a - 50, y: B.y }, 8); await sleep(200);
w1 = await BW();
ok('its left end dragged: only the start moves', w1.a < w0.a - 0.03 && near(w1.b, w0.b, 0.002), [w0, w1]);
w0 = w1;
await p.drag({ x: B.l + B.w * w0.b - 1, y: B.y }, { x: B.l + B.w * w0.b + 40, y: B.y }, 8); await sleep(200);
w1 = await BW();
ok('its right end dragged: only the end moves', w1.b > w0.b + 0.02 && near(w1.a, w0.a, 0.002), [w0, w1]);
await p.drag({ x: B.l + B.w * w1.b - 1, y: B.y }, { x: B.l - 400, y: B.y }, 8); await sleep(200);
w1 = await BW();
ok('an end dragged past the other: the narrowest window, not crossed', w1.b > w1.a && w1.b - w1.a <= 0.016 + 1e-6, w1);
await ev('(bwSet(0.1, 0.2), 1)'); await sleep(100);
await p.click(B.l + B.w * 0.8, B.y); await settle();
w1 = await BW();
ok('a click on the track brings the window there', near((w1.a + w1.b) / 2, 0.8, 0.01) && near(w1.b - w1.a, 0.1, 0.002), w1);
ok('the bar lights up only while held', await ev(`!mbar.classList.contains('act')`));
// a pill picked again: the whole range; another pill: whole too
await ev(`document.querySelector('#mrng button[data-r="30d"]').click()`); await settle();
ok('the range picked again shows all of it', near((await BW()).a, 0, 0.002) && near((await BW()).b, 1, 0.002), await BW());
await ev('(bwSet(0.5, 0.6), 1)');
await pick('24h');
ok('another range starts whole', (await BW()).a === 0 && (await BW()).b === 1);
await pick('15m');
ok('15m: the bar still there, whole', await ev(`!mbar.hidden && parseFloat(mbar.firstChild.style.left) === 0 && parseFloat(mbar.firstChild.style.right) === 0`));
// the window's hover reads the window
await ev('(bwSet(0, 1), 1)'); await pick('30d'); await ev('(bwSet(0.5, 0.6), 1)'); await sleep(200);
P = await plot(); await mouse('mouseMoved', P.l + 5, P.y); await sleep(600);
// (where the guide is, through the window, and the time its tip reads: the window's first moment, half the range back)
const hv = await ev(`(() => { const M = bigMap, d = devicePixelRatio || 1, pl = M.padL / d, pr = (M.w - M.padR) / d, f = M.i0 + (HV.cx - pl) / (pr - pl) * (M.i1 - M.i0), when = new Date(Date.now() - M.span * (1 - f / (M.n - 1))); return { f, n: M.n, hm: p2(when.getHours()) + ':' + p2(when.getMinutes()), day: dMon(when), tip: mtip.textContent }; })()`);
ok('the hover at the window\'s left reads its first moment, not the range\'s', Math.abs(hv.f - 0.5 * (hv.n - 1)) < 2 && hv.tip.includes(hv.hm) && hv.tip.includes(hv.day), hv);
await mouse('mouseMoved', P.l - 200, P.y - 300);
// the bottleneck: no chart, no bar
ok('a Yes/No or bottleneck popup with no chart has no bar', await ev(`(() => { closeDetail(); const k = Object.keys(S.L.cells).find(id => { const c = S.L.cells[id]; return c.key && /bneck|bottleneck/i.test(c.key + (c.name || '')); }); if (!k) return true; openDetail(k); const r = mbar.hidden; closeDetail(); return r; })()`));
ok('no page errors', errs.length === 0, errs);
await ev('closeDetail(), 1');
{ const all = done(); console.log(all ? 'ALL PASS' : 'SOME FAILED'); process.exit(all ? 0 : 1); }
