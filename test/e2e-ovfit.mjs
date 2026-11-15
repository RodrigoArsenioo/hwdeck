// Overview at any window size (11-13, his "make the overview properly scalable with window resizes and avoid scrollable
// (just like in cells)"): it never scrolls, it fills the window to its bottom (its rows and graphs take the spare
// room), its graphs always stay (as in Tiles), the PC's name stays whole in the title bar at any width, and a drag of
// the window's edge is fitted at each frame, with nothing jumping once it stops.
//   (Starter layout)  HWDeck.exe --fake 300 --data test\data-ovfit
// then: node test/e2e-ovfit.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9238);
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x), J = async x => JSON.parse(await ev(`JSON.stringify(${x})`));
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };

ok('the Starter layout is in', await until('feed.got && READ.length > 100 && S.L.cats.some(c => cellsOf(c).length > 3)', 20000), await ev('S.L.cats.length'));
await ev(`(() => { if (S.edit) setEdit(false); showScreen('overview'); return 1; })()`); await p.sleep(1500);
const at = async (w, h) => {
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1.5, mobile: false });
  await p.sleep(2400);
  return J(`(() => { const v = $('view'), pb = parseFloat(getComputedStyle(sectionsEl).paddingBottom) || 0; return { scroll: sectionsEl.scrollHeight - sectionsEl.clientHeight, left: sectionsEl.clientHeight - (v.offsetTop + v.offsetHeight) - pb, ovc: v.classList.contains('ovc'), fs: parseFloat(document.documentElement.style.fontSize) }; })()`);
};
for (const [w, h] of [[1405, 860], [1920, 1080], [1405, 600], [1100, 700], [900, 620]]) {
  const m = await at(w, h);
  ok(`${w} x ${h}: no scrolling, the view down to the window's bottom (within 30 px)`, m.scroll <= 0 && m.left <= 30, m);
}
const small = await at(700, 500);
ok('700 x 500: its graphs still there (no compact cards: "tiles dont do that")', !small.ovc && await ev(`[...document.querySelectorAll('#view .card .hero > canvas')].every(c => c.offsetHeight > 10)`), small);
ok('700 x 500: the PC\'s name still in the title bar', await ev(`(() => { const n = document.querySelector('.tbar .name'); return !!n && n.getBoundingClientRect().width >= 40; })()`));
const back = await at(1405, 860);
ok('grown back to 1405 x 860: no scrolling, down to the bottom', back.scroll <= 0 && back.left <= 30, back);
// the PC's name whole in the title bar at every width (his 11-13 "while resizing the name gets hidden and gets a ...":
// the bar's steps came at fixed widths, a bar with a button more ran out of room between them)
const nameWhole = `(() => { const t = $('title'), rg = document.createRange(); rg.selectNodeContents(t); return getComputedStyle(t).visibility === 'visible' && t.getBoundingClientRect().width >= rg.getBoundingClientRect().width - 0.5; })()`;
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false }); await p.sleep(1500);
const cutAt = [];
for (let w = 1400; w >= 720; w -= 20) { await p.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: false }); await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); if (!await ev(nameWhole)) cutAt.push(w); }
ok("the PC's name whole and shown at every width from 1400 to 720 px, at every frame of the way", cutAt.length === 0, cutAt);
await ev(`(() => { const b = document.createElement('button'); b.className = 'ib'; b.id = 'tbExtra'; b.innerHTML = '<svg viewBox="0 0 24 24"></svg>'; $('setBtn').before(b); return 1; })()`);
const cutAt2 = [];
for (const w of [1000, 980, 961, 860, 820, 761]) { await p.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: false }); await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); if (!await ev(nameWhole)) cutAt2.push(w); }
ok('with a button more in the bar (as his dashboard has): the name still whole where it was hidden (961 to 1000, 761 to 860 px)', cutAt2.length === 0, cutAt2);
// edit mode the same way (its steps came at 1240, 960 and 800 px: the name cut from 961 to 1300, the window's buttons off
// the right edge at 720); the name goes there only where nothing else makes room
const inBar = `(() => { const b = document.querySelector('.tbar'), k = [...b.children].filter(e => e.getClientRects().length), r = b.getBoundingClientRect().right - parseFloat(getComputedStyle(b).paddingRight); return k[k.length - 1].getBoundingClientRect().right <= r + 0.5; })()`;
await ev(`(() => { setEdit(true); return 1; })()`); await p.sleep(800);
const cutE = [], outE = [];
for (const w of [1300, 1241, 1100, 1000, 961, 960, 900, 800, 720]) { await p.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: false }); await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); if (w >= 900 && !await ev(nameWhole)) cutE.push(w); if (!await ev(inBar)) outE.push(w); }
ok('edit mode, a button more in the bar: the name whole from 1300 down to 900 px, the window buttons inside the bar down to 720', !cutE.length && !outE.length, { cutE, outE });
// edit mode's bar follows the window's edge too (his 11-13 "yes"): in a drag the words of the edit buttons shrink away
// over many frames, not in one step, the name whole and the window buttons inside the bar at every frame of it
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1500, height: 860, deviceScaleFactor: 1, mobile: false }); await p.sleep(700);
const ew = { mid: 0, cut: 0, out: 0, open: await ev(`getComputedStyle(document.querySelector('.ebb')).fontSize`) };
for (let w = 1496; w >= 1100; w -= 8) { await p.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: false }); await ev('new Promise(r => requestAnimationFrame(r))'); const f = parseFloat(await ev(`getComputedStyle(document.querySelector('.ebb')).fontSize`)); if (f > 0.5 && f < 11.5) ew.mid++; if (!await ev(nameWhole)) ew.cut++; if (!await ev(inBar)) ew.out++; }
await p.sleep(400); ew.end = await ev(`getComputedStyle(document.querySelector('.ebb')).fontSize`);
ok('edit mode, a drag from 1496 to 1100 px: the words of the edit buttons shrink over many frames, gone at the end, the name whole and the window buttons inside the bar at every frame', ew.open === '12px' && ew.mid >= 4 && ew.end === '0px' && !ew.cut && !ew.out, ew);
await ev(`(() => { setEdit(false); return 1; })()`); await p.sleep(800);
// the bar's steps move while the window's edge is dragged (his 11-13 "the clock just disappears ... just make smooth
// animations"): the time fades and closes over some frames, the name whole all the way; a jump takes them at once
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1060, height: 860, deviceScaleFactor: 1, mobile: false }); await p.sleep(700);
const fade = { mid: 0, cut: 0, open: await ev(`getComputedStyle($('clock')).opacity`) };
for (let w = 1056; w >= 940; w -= 4) { await p.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: false }); await ev('new Promise(r => requestAnimationFrame(r))'); const o = +await ev(`getComputedStyle($('clock')).opacity`); if (o > 0.02 && o < 0.98) fade.mid++; if (!await ev(nameWhole)) fade.cut++; }
await p.sleep(400); fade.end = await ev(`getComputedStyle($('clock')).opacity + ' ' + Math.round($('clock').getBoundingClientRect().width)`);
ok('a drag from 1056 to 940 px: the time fades over some frames (not gone in one), closed at the end, the name whole at every frame', fade.open === '1' && fade.mid >= 2 && fade.cut === 0 && fade.end === '0 0', fade);
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1300, height: 860, deviceScaleFactor: 1, mobile: false }); await p.sleep(500);
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 900, height: 860, deviceScaleFactor: 1, mobile: false }); await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
ok('a jump from 1300 to 900 px: the time gone at once, the name whole', await ev(`getComputedStyle($('clock')).opacity === '0' && Math.round($('clock').getBoundingClientRect().width) === 0`) && await ev(nameWhole), await ev(`getComputedStyle($('clock')).opacity`));
await ev(`($('tbExtra').remove(), 1)`);
// a drag of the window's edge (a size every 16 ms): fitted at each frame, the name never cut, and once it stops the
// view moves only a little (his 11-13 "stuff also snaps": it was fitted only 250 ms after the last move, and jumped)
// (where things are laid out, not where a glide still running draws them: a jump that has to be, other columns say,
// glides for 280 ms, and one begun in the drag's last frames is not a move the stop makes)
const boxes = `JSON.stringify([...document.querySelectorAll('#view .dcat, #view .card')].slice(0, 12).map(e => { const v = $('view'), k = v.offsetWidth ? v.getBoundingClientRect().width / v.offsetWidth : 1; let x = 0, y = 0, n = e; for (; n && n !== v && n !== sectionsEl; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; } if (n === v) { x = v.offsetLeft + x * k; y = v.offsetTop + y * k; } return [x, y, e.offsetWidth * k, e.offsetHeight * k].map(Math.round); }))`;   // (k: a drag draws the view scaled, its layout that much wider or narrower)
for (const scr of ['tiles', 'overview']) {
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1300, height: 780, deviceScaleFactor: 1, mobile: false });
  await ev(`(() => { showScreen('${scr}'); return 1; })()`); await p.sleep(2500);
  let cut = 0, over = 0;
  for (let i = 1; i <= 50; i++) {
    await p.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(1300 + 500 * i / 50), height: Math.round(780 + 220 * i / 50), deviceScaleFactor: 1, mobile: false });
    await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    if (!await ev(nameWhole)) cut++;
    if (await ev(`(() => { const v = $('view'), pb = parseFloat(getComputedStyle(sectionsEl).paddingBottom) || 0; return sectionsEl.clientHeight - v.offsetTop - pb - v.getBoundingClientRect().height < -2; })()`)) over++;
  }
  const a = JSON.parse(await ev(boxes)); await p.sleep(1200); const b = JSON.parse(await ev(boxes));
  const mv = Math.max(0, ...a.map((r, i) => b[i] ? Math.max(...r.map((x, k) => Math.abs(x - b[i][k]))) : 99));
  const fin = await J(`(() => ({ scroll: sectionsEl.scrollHeight - sectionsEl.clientHeight, wdrag: app.classList.contains('wdrag') }))()`);
  ok(`${scr}: a drag from 1300 x 780 to 1800 x 1000, the name never cut, the view never over the window's bottom, under 30 px of move once it stops, no scrolling after`, !cut && !over && mv < 30 && fin.scroll <= 0 && !fin.wdrag, { cut, over, mv, fin });
}
await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1405, height: 860, deviceScaleFactor: 1.5, mobile: false }); await p.sleep(1500);
// Tiles as before
await ev(`(() => { showScreen('tiles'); return 1; })()`); await p.sleep(2000);
ok('Tiles: nothing of Overview on its view', await ev(`!$('view').classList.contains('ovc') && !$('view').style.getPropertyValue('--ovx')`));
ok('no page errors', errs.length === 0, errs);
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
p.close(); process.exit(0);
