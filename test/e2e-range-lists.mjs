// Range selector B on the lists' charts (2.4.2, his 11-07 "the same way" and "the bar on game session graphs too"):
// Sessions' and Warning history's period charts (no Days pill; the chart and its bar set a window of the period, the
// table and the warnings list follow it) and a session's own chart (its plots and its bar, the times at its ends).
// Real pointer events. On a folder with sessions that have minutes and some warnings:
//   node test/e2e-range-lists.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9363);
const p = await connect(port), ev = p.evaluate, sleep = p.sleep;
const errs = await p.errors();
const { ok, done } = checks();
const mouse = (type, x, y, extra = {}) => p.cmd('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none', clickCount: 1 }, extra));
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;
const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, y: r.top + r.height / 2 }; })()`);
const wheel = async (R, fx, dy) => { const x = R.l + R.w * fx; await mouse('mouseMoved', x, R.y); await sleep(600); await mouse('mouseWheel', x, R.y, { deltaX: 0, deltaY: dy }); await sleep(700); };

await ev(`(closeDetail(), document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')), 1)`); await sleep(300);
// ---- Sessions ----
await ev(`$('gamesBtn').click(), 1`);
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#glist .gx-sess')`)); i++) await sleep(250);
await ev(`(() => { if (!GX.open) document.querySelector('#gsum .gx-srow').click(); return 1; })()`); await sleep(700);
await ev(`document.querySelector('#gsum .gx-per button[data-p="30"]').click(), 1`); await sleep(700);
ok('Sessions: 7, 30, 90 days and All, no Days and no box', await ev(`[...document.querySelectorAll('#gsum .gx-per button')].map(b => b.textContent).join()`) === '7 days,30 days,90 days,All' && await ev(`!document.querySelector('#gsum .gx-days')`), await ev(`[...document.querySelectorAll('#gsum .gx-per button')].map(b => b.textContent).join()`));
ok('Sessions: the bar under its chart, whole: a date on its left, today on its right', await ev(`(() => { const b = document.querySelector('#gsum .mbar'); return !!b && b.offsetWidth > 100 && parseFloat(b.firstChild.style.left) === 0 && parseFloat(b.firstChild.style.right) === 0 && /^\\d{1,2} [a-z]{3}$/.test(b.children[1].textContent) && b.children[2].textContent === 'today'; })()`), await ev(`(document.querySelector('#gsum .mbar') || {}).outerHTML`));
const tab0 = await ev(`[...document.querySelectorAll('#gsum .gx-gr')].map(r => r.textContent).join('|')`);
let R = await rect('#gsum .gx-lcp');
await wheel(R, 0.8, -400);
let W = await ev('({ a: GX.W.a, b: GX.W.b })');
ok('Sessions: the wheel zooms the chart in around the pointer', W.b - W.a < 0.7 && near(W.a + 0.8 * (W.b - W.a), 0.8, 0.02), W);
ok('Sessions: the games table is the window\'s', await ev(`[...document.querySelectorAll('#gsum .gx-gr')].map(r => r.textContent).join('|')`) !== tab0);
ok('Sessions: its bar shows the window, a date at each end', await ev(`(() => { const b = document.querySelector('#gsum .mbar'); return Math.abs(parseFloat(b.firstChild.style.left) - GX.W.a * 100) < 0.01 && /^\\d{1,2} [a-z]{3}$/.test(b.children[2].textContent); })()`));
// (round 2's fix 2, 11-07 audit) a window whose edges cut a day: the hover at either edge reads a day drawn in it
{ const Wz = await ev('({ a: GX.W.a, b: GX.W.b })'); await ev(`(GX.W.set(0.06, 0.45), 1)`); await sleep(500);
  const Rz = await rect('#gsum .gx-lcp');
  for (const fx of [0.003, 0.997]) {
    await mouse('mouseMoved', Rz.l + Rz.w * fx, Rz.y); await sleep(350);
    const g = await ev(`(() => { const pl = document.querySelector('#gsum .gx-lcp'); return { hv: pl.classList.contains('hv'), x: parseFloat(pl.querySelector('.gx-gd').style.left) }; })()`);
    ok('Sessions zoomed: the hover at the ' + (fx < 0.5 ? 'left' : 'right') + ' edge is on a day inside the plot', g.hv && g.x >= -0.01 && g.x <= 100.01, g);
  }
  await mouse('mouseMoved', 4, 4); await ev(`(GX.W.set(${Wz.a}, ${Wz.b}), 1)`); await sleep(500); }
R = await rect('#gsum .gx-lcp'); W = await ev('({ a: GX.W.a, b: GX.W.b })');
await p.drag({ x: R.l + R.w * 0.5, y: R.y }, { x: R.l + R.w * 0.5 + 80, y: R.y }, 10); await sleep(400);
let W2 = await ev('({ a: GX.W.a, b: GX.W.b })');
ok('Sessions: a drag to the right goes back in time', W2.a < W.a && near(W2.b - W2.a, W.b - W.a, 0.002), [W, W2]);
let B = await rect('#gsum .mbar'); W = W2;
await p.drag({ x: B.l + B.w * (W.a + W.b) / 2, y: B.y }, { x: B.l + B.w * (W.a + W.b) / 2 + 50, y: B.y }, 8); await sleep(400);
W2 = await ev('({ a: GX.W.a, b: GX.W.b })');
ok('Sessions: the bar dragged moves the window', near(W2.a - W.a, 50 / B.w, 0.01), [W2.a - W.a, 50 / B.w]);
B = await rect('#gsum .mbar'); W = W2;
await p.drag({ x: B.l + B.w * W.b - 1, y: B.y }, { x: B.l + B.w * W.b + 40, y: B.y }, 8); await sleep(400);
W2 = await ev('({ a: GX.W.a, b: GX.W.b })');
ok('Sessions: its right end dragged: only the end moves', W2.b > W.b && near(W2.a, W.a, 0.002), [W, W2]);
R = await rect('#gsum .gx-lcp'); await p.dblclick(R.l + R.w / 2, R.y); await sleep(800);
ok('Sessions: a double click: the whole period', near(await ev('GX.W.a'), 0, 0.002) && near(await ev('GX.W.b'), 1, 0.002));
await ev(`(GX.W.set(0.2, 0.5), 1)`); await sleep(200);
await ev(`document.querySelector('#gsum .gx-per button[data-p="30"]').click(), 1`); await sleep(800);
ok('Sessions: the period picked again: all of it', near(await ev('GX.W.a'), 0, 0.002) && near(await ev('GX.W.b'), 1, 0.002));
await ev(`(GX.W.set(0.2, 0.5), 1)`); await ev(`document.querySelector('#gsum .gx-per button[data-p="90"]').click(), 1`); await sleep(800);
ok('Sessions: another period starts whole', await ev('GX.W.a === 0 && GX.W.b === 1'));
// a session's own chart
const has = await ev(`(() => { const s = [...document.querySelectorAll('#glist .gx-sess')].find(el => { const x = gxSs[+el.dataset.g]; return x && typeof x.tb === 'string' && x.tb.length > 30; }); if (!s) return false; s.querySelector('.gx-row').click(); s.dataset.t = 1; return true; })()`);
ok('a session with minutes to open', has);
await sleep(1200);
const tl = '#glist .gx-sess[data-t="1"] .gx-tl';
ok('its chart has the bar, the times at its ends', await ev(`(() => { const b = document.querySelector('${tl} .mbar'); return !!b && b.offsetWidth > 100 && /^\\d\\d:\\d\\d$/.test(b.children[1].textContent) && /^\\d\\d:\\d\\d$/.test(b.children[2].textContent); })()`), await ev(`(document.querySelector('${tl} .mbar') || {}).outerHTML`));
ok('a session opens whole', (await ev(`document.querySelector('${tl} svg.gx-fpsc').getAttribute('viewBox')`)).startsWith('0.00 0 '));
// (round 2's fix 3, 11-07 audit) a session that ends on a whole minute: its bar's end reads that minute, as its ticks do
await ev(`(() => { const s = document.querySelector('#glist .gx-sess[data-t="1"]'), x = gxSs[+s.dataset.g]; x.end = Math.max(x.start + 120, Math.floor(x.end / 60) * 60); s.querySelector('.gx-row').click(); return 1; })()`); await sleep(700);
await ev(`(document.querySelector('#glist .gx-sess[data-t="1"] .gx-row').click(), 1)`); await sleep(1200);
{ const e = await ev(`(() => { const s = document.querySelector('#glist .gx-sess[data-t="1"]'), x = gxSs[+s.dataset.g], b = document.querySelector('${tl} .mbar'), t = document.querySelector('${tl} .gx-ticks .e1'); return { bar: b && b.children[2].textContent, tick: t && t.textContent, want: hhmm(x.end), whole: x.end % 60 === 0 }; })()`);
  ok('a session ending on a whole minute: its bar ends at that minute, as its ticks do', e.whole && e.bar === e.want && !!e.tick && e.tick.endsWith(e.want), e); }
const vb0 = await ev(`document.querySelector('${tl} svg.gx-fpsc').getAttribute('viewBox')`), tk0 = await ev(`document.querySelector('${tl} .gx-ticks').textContent`);
R = await rect(tl + ' .gx-tr.f .gx-plot');
await wheel(R, 0.5, -500);
const vb1 = await ev(`document.querySelector('${tl} svg.gx-fpsc').getAttribute('viewBox')`), vbs = await ev(`(document.querySelector('${tl} svg.gx-bnc') || { getAttribute: () => '' }).getAttribute('viewBox')`);
ok('the wheel zooms its fps chart', vb1 !== vb0 && +vb1.split(' ')[2] < +vb0.split(' ')[2] * 0.7, [vb0, vb1]);
ok('and its limited-by strip with it', !vbs || vbs.split(' ')[0] === vb1.split(' ')[0] && vbs.split(' ')[2] === vb1.split(' ')[2], [vb1, vbs]);
ok('its clock ticks are the window\'s', await ev(`document.querySelector('${tl} .gx-ticks').textContent`) !== tk0);
R = await rect(tl + ' .gx-tr.f .gx-plot'); const k0 = +vb1.split(' ')[0];
await p.drag({ x: R.l + R.w * 0.5, y: R.y }, { x: R.l + R.w * 0.5 - 60, y: R.y }, 8); await sleep(400);
ok('a drag to the left goes on in time', +(await ev(`document.querySelector('${tl} svg.gx-fpsc').getAttribute('viewBox')`)).split(' ')[0] > k0);
await mouse('mouseMoved', R.l + R.w * 0.3, R.y); await sleep(300);
ok('the hover reads a minute of the window', await ev(`(() => { const hz = document.querySelector('${tl} .gx-hz'); return hz.classList.contains('hv') && /\\d\\d:\\d\\d/.test(hz.querySelector('.gx-tip').textContent); })()`));
R = await rect(tl + ' .gx-tr.f .gx-plot'); await p.dblclick(R.l + R.w / 2, R.y); await sleep(800);
ok('a double click: the whole session', await ev(`(() => { const v = document.querySelector('${tl} svg.gx-fpsc').getAttribute('viewBox').split(' '); return +v[0] === 0 && +v[2] === gxTl[+document.querySelector('${tl}').dataset.g].N * 10; })()`), await ev(`document.querySelector('${tl} svg.gx-fpsc').getAttribute('viewBox')`));
B = await rect(tl + ' .mbar');
await p.drag({ x: B.l + 2, y: B.y }, { x: B.l + B.w * 0.4, y: B.y }, 8); await sleep(400);
ok('its bar\'s left end dragged: the chart starts later', +(await ev(`document.querySelector('${tl} svg.gx-fpsc').getAttribute('viewBox')`)).split(' ')[0] > 0);
await ev(`document.querySelector('#gmodal .mclose').click(), 1`); await sleep(500);

// ---- Warning history ----
await ev(`$('logBtn').click(), 1`);
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#wsum .gx-srow')`)); i++) await sleep(250);
ok('Warning history: its log is in, with warnings', await ev(`!!document.querySelector('#wsum .gx-srow') && wxEps.length > 0`), await ev('wxEps.length'));
await ev(`(() => { if (!WX.open) document.querySelector('#wsum .gx-srow').click(); return 1; })()`); await sleep(700);
await ev(`document.querySelector('#wsum .gx-per button[data-p="' + (wxPeriods().includes(90) ? 90 : wxPeriods()[0]) + '"]').click(), 1`); await sleep(700);
ok('Warning history: no Days, the bar under its chart', await ev(`![...document.querySelectorAll('#wsum .gx-per button')].some(b => b.dataset.p === 'days') && !!document.querySelector('#wsum .mbar')`));
const rows0 = await ev(`document.querySelectorAll('#wlist .gx-sess').length`), tb0 = await ev(`(document.querySelector('#wsum .gx-gtab') || {}).textContent || ''`);
R = await rect('#wsum .wx-plot');
await wheel(R, 0.9, -500); await sleep(500);
ok('Warning history: the wheel zooms its chart (the bars widen)', await ev('WX.W.b - WX.W.a < 0.7') && await ev(`parseFloat(document.querySelector('#wsum .wx-bars').style.width) > 140`), await ev(`[WX.W.a, WX.W.b, document.querySelector('#wsum .wx-bars').style.width]`));
// (a window after the newest warning: none in it)
await ev(`(() => { const last = Math.max(...wxEps.map(e => e.when.getTime())) / 1000, f = (last - WX.ws) / (WX.we - WX.ws) * (WX.W.b - WX.W.a) + WX.W.a; WX.W.set(Math.min(0.99, f + 0.01), 1); return 1; })()`); await sleep(800);
ok('Warning history: the list under it is the window\'s (a window after the newest: none)', await ev(`document.querySelectorAll('#wlist .gx-sess').length`) === 0 && rows0 > 0, [rows0, await ev(`document.querySelectorAll('#wlist .gx-sess').length`)]);
ok('Warning history: so is the table, and the note says the window', (await ev(`(document.querySelector('#wsum .gx-gtab') || {}).textContent || ''`)) !== tb0 && /from \d{1,2} [a-z]{3} to \d{1,2} [a-z]{3}/.test(await ev(`$('wlist').textContent`)), await ev(`$('wlist').textContent`));
R = await rect('#wsum .wx-plot'); await p.dblclick(R.l + R.w / 2, R.y); await sleep(900);
ok('Warning history: a double click: the whole period, the list whole again', near(await ev('WX.W.a'), 0, 0.002) && near(await ev('WX.W.b'), 1, 0.002) && await ev(`document.querySelectorAll('#wlist .gx-sess').length`) === rows0);
await ev(`document.querySelector('#wmodal .mclose').click(), 1`);
ok('no page errors', errs.length === 0, errs);
{ const all = done(); console.log(all ? 'ALL PASS' : 'SOME FAILED'); process.exit(all ? 0 : 1); }
