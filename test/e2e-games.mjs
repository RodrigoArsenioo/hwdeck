// The game sessions popup (layout A: a table, a session opening into avg / max bars and a minute by minute
// timeline) on lines this test writes, old ones included, and a made-up game session (the --fake hooks fakeGame and
// fakePin) whose report carries the lines, the warnings with their peaks and the timeline. Start it on a data folder
// with a state.json run-all.ps1 writes (a CPU temp cell with lines, a fan cell that warns below):
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9237
//   HWDeck.exe --fake 300 --data test\data-g
// then: node test/e2e-games.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9237);
const data = process.argv[3] || 'test/data-g';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const text = f => existsSync(f) ? readFileSync(f, 'utf8') : '';
const host = m => ev(`send(${JSON.stringify(m)})`);
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(400); };
const T = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent : null; })()`);

ok('catalog arrives', await until('READ.length === 301 && feed.got'));
await host({ t: 'fakeGame', game: null });   // whatever runs on this PC: from here on the test says what plays
const cpuKey = 'f0000501.0/01000000';
await host({ t: 'fakePin', key: cpuKey, v: 40 });   // under its lines until the made-up session below

// ---- lines on disk: one of this version's, one from 1.0.0 (no lines, bottleneck or timeline) ----
const now = Math.floor(Date.now() / 1000), d0 = new Date(); d0.setHours(0, 0, 0, 0);
const at = (daysAgo, h, m) => Math.floor(d0.getTime() / 1000) - daysAgo * 86400 + h * 3600 + m * 60;
const s1 = Math.min(at(1, 18, 51), now - 3 * 3600), mins = 88;
const tf = [], tl = []; let tb = '';
for (let m = 0; m < mins; m++) { const away = m >= 33 && m < 56; tf.push(away ? null : 150 + Math.round(30 * Math.sin(m / 4))); tl.push(away ? null : 70 + (m % 5)); tb += away ? '-' : m % 9 < 5 ? 'c' : m % 9 < 8 ? 'g' : 'f'; }
const full = { game: 'Marvel Rivals', start: s1, end: s1 + mins * 60, from: s1, secs: mins * 60, front: 65 * 60, fps: 161, low: 72,
  items: [['GPU temp', '\u00b0C', 64, 70.6, 80, 88, 1, null, 0], ['GPU hotspot', '\u00b0C', 72.3, 79.4, 90, null, 1, null, 0], ['GPU memory', '\u00b0C', 71, 78, null, null, 1, null, 0],
    ['GPU power', 'W', 314, 447, 400, 600, 1, null, 0], ['GPU usage', '%', 77, 99, null, null, 1, null, 0], ['CPU temp', '\u00b0C', 58.4, 66.1, 85, 95, 1, null, 0],
    ['CPU power', 'W', 84.6, 121.9, null, null, 1, null, 0], ['CPU usage', '%', 71, 100, null, null, 1, null, 0], ['VRAM', 'MB', 12000, 15155, null, null, 1, 32607, 0],
    ['RAM', 'MB', 40000, 44544, null, null, 1, 65459, 0], ['Rear fan', 'RPM', 1200, 1450, 500, null, 0, null, 1]],
  warns: 1, g: 1400, c: 2340, f: 160, wl: [['GPU power', 583, 'W']], tf, tl, tb };
const old = { game: 'Old Game', start: s1 - 86400, end: s1 - 86400 + 3600, from: s1 - 86400, secs: 3600, front: 3600, fps: 120, low: 90,
  items: [['GPU temp', '\u00b0C', 60, 70], ['Temperature 9', '\u00b0C', 50, 61]], warns: 0 };
writeFileSync(join(data, 'games.log'), JSON.stringify(old) + '\r\n' + JSON.stringify(full) + '\r\n' + 'not json\r\n');

await click('#gamesBtn');
ok('the popup gets the host\'s log: a table of sessions, newest first', await until('document.querySelectorAll("#glist .gx-sess").length === 2', 5000) &&
  await ev('[...document.querySelectorAll("#glist .gx-gn")].map(x => x.textContent).join() === "Marvel Rivals,Old Game"'), await ev('$("glist").textContent.slice(0, 120)'));
ok('the table has its columns (game, length, fps, 1% low, limited by, warnings)', await ev('[...document.querySelectorAll("#glist .gx-cols span")].map(x => x.textContent.trim()).filter(Boolean).join() === "game,length,fps,1% low,limited by,warnings"'));
ok('the summary: sessions, time played, most played, a 7 day strip', /last 7 days\s*2\s*sessions/.test(await T('#gsum')) && /most playedMarvel Rivals/.test(await T('#gsum')) && await ev('document.querySelectorAll("#gsum .gx-wd").length === 7'), await T('#gsum'));
const row = i => ev(`[...document.querySelectorAll("#glist .gx-sess")][${i}].querySelector(".gx-row").textContent`);
ok('a row: name, times, length and time in front, fps, 1% low, what limited it, warnings', /Marvel Rivals\d\d:\d\d to \d\d:\d\d1h 28m1h 05m in front16172cpu-bound 60%1 warningGPU power 583 W/.test(await row(0)), await row(0));
ok('the newest session opens with the popup, the others stay shut', await ev('(() => { const s = [...document.querySelectorAll("#glist .gx-sess")]; return s[0].classList.contains("open") && !s[1].classList.contains("open"); })()'));
const det = '#glist .gx-sess.open .gx-det';
const rr = await ev(`[...document.querySelectorAll("${det} .gx-in > .gx-rd > div")].map(c => c.querySelector(".gx-ch").textContent + ": " + [...c.querySelectorAll(".gx-rr")].map(r => r.textContent).join(" | "))`);
ok('its details: the gpu and cpu readings, avg and max', rr.length === 2 && /^gpu: core temp64\.070\.6°C \| hotspot72\.379\.4°C \| mem temp71\.078\.0°C \| power314447W \| usage7799%$/.test(rr[0]) &&
  /^cpu and memory: temp58\.466\.1°C \| power84\.6121\.9W \| usage71100% \| VRAMpeak14\.8GB \| RAMpeak43\.5GB$/.test(rr[1]), rr);
ok('a yellow tick where a reading has its yellow line, the max coloured by the lines it passed', await ev(`(() => { const r = [...document.querySelectorAll("${det} .gx-rd .gx-rr")]; const f = l => r.find(x => x.querySelector(".l").textContent === l);
  return !!f("core temp").querySelector(".gx-bar .y") && !f("mem temp").querySelector(".gx-bar .y") && f("power").querySelector("b").className === "y" && f("core temp").querySelector("b").className === "" && !!f("usage"); })()`));
ok('bars end at the red line (power: 447 of 600 W)', await ev(`(() => { const r = [...document.querySelectorAll("${det} .gx-rd .gx-rr")].find(x => x.querySelector(".l").textContent === "power"), m = r.querySelector(".gx-bar .m"); return Math.abs(parseFloat(m.style.left) + parseFloat(m.style.width) - 74.5) < 0.2; })()`),
  await ev(`[...document.querySelectorAll("${det} .gx-rd .gx-rr")].find(x => x.querySelector(".l").textContent === "power").querySelector(".gx-bar").innerHTML`));
ok('VRAM against the card\'s memory (used + free)', await ev(`(() => { const r = [...document.querySelectorAll("${det} .gx-rd .gx-rr")].find(x => x.querySelector(".l").textContent === "VRAM"); return Math.abs(parseFloat(r.querySelector(".gx-bar .m").style.width) - 46.5) < 0.2; })()`));
ok('other cells with lines under their own heading (a line that warns below is only a tick)', /cells with lines/.test(await T(det + ' .gx-xc')) && await ev(`(() => { const r = document.querySelector("${det} .gx-xc .gx-rr"); return r.querySelector(".l").textContent === "Rear fan" && r.textContent.includes("1,450") && !!r.querySelector(".gx-bar .y") && r.querySelector("b").className === ""; })()`), await T(det + ' .gx-xc'));
ok('the timeline: fps with its 1% low band, a gap while not in front', await ev(`(() => { const s = document.querySelector("${det} .gx-fpsc"); return !!s && s.querySelectorAll("polyline").length === 2 && s.querySelectorAll("polygon").length === 2; })()`), await ev(`document.querySelector("${det} .gx-tl") && document.querySelector("${det} .gx-tl").textContent`));
ok('what limited it, minute by minute, and the split', await ev(`document.querySelectorAll("${det} .gx-strip span").length > 10`) && /cpu-bound 60%gpu-bound 36%capped 4%not in front 23m/.test(await T(det + ' .gx-leg')), await T(det + ' .gx-leg'));
ok('clock ticks from start to end', /^\d\d:\d\d.*\d\d:\d\d$/.test(await T(det + ' .gx-ticks')), await T(det + ' .gx-ticks'));

// ---- a line from 1.0.0 ----
ok('an old line still makes a row (no bottleneck: "--", no warnings: none)', /^Old Game\d\d:\d\d to \d\d:\d\d1h 00m12090--none$/.test(await row(1)), await row(1));
await ev('[...document.querySelectorAll("#glist .gx-sess")][1].querySelector(".gx-row").click()'); await p.sleep(400);
ok('click opens it: its readings by name, the rest as cells, no timeline', await ev('[...document.querySelectorAll("#glist .gx-sess")].every(s => s.classList.contains("open"))') &&
  await ev(`(() => { const d = [...document.querySelectorAll("#glist .gx-sess")][1].querySelector(".gx-det"); const r = [...d.querySelectorAll(".gx-rr")].map(x => x.textContent); return r[0] === "core temp60.070.0°C" && r[1] === "Temperature 950.061.0°C" && !d.querySelector(".gx-tl") && !d.querySelector(".gx-rr .y"); })()`),
  await ev('[...document.querySelectorAll("#glist .gx-sess")][1].querySelector(".gx-det").textContent'));
await ev('[...document.querySelectorAll("#glist .gx-sess")][0].querySelector(".gx-row").click()'); await p.sleep(400);
ok('click again shuts it', await ev('!document.querySelector("#glist .gx-sess").classList.contains("open")'));
ok('a session that recorded nothing says so', await ev(`(() => { renderGames(JSON.stringify({ game: 'Bare', start: ${now - 7200}, end: ${now - 3600}, from: ${now - 7200}, secs: 3600, front: 3600, fps: null, low: null, items: [], warns: 0 })); return document.querySelector("#glist .gx-sess.open .gx-nil").textContent === "no readings were recorded for this session" && document.querySelector("#glist .gx-row").textContent.includes("----"); })()`));

// ---- the card: 840 px (like the dashboard), and a thin scrollbar when it is taller than the window ----
ok('the popup is 840 px wide and its card shows a thin scrollbar', await ev('(() => { const c = document.querySelector("#gmodal .mcard"), s = getComputedStyle(c); return c.getBoundingClientRect().width === Math.min(840, innerWidth * 0.94) && s.scrollbarWidth === "thin" && s.scrollbarColor.startsWith("rgb(52, 52, 52)") && s.overflowY === "auto"; })()'),
  await ev('(() => { const c = document.querySelector("#gmodal .mcard"), s = getComputedStyle(c); return c.getBoundingClientRect().width + " " + s.scrollbarWidth + " " + s.scrollbarColor; })()'));
await ev('$("gmodal").classList.remove("open")'); await p.sleep(300);

// ---- a made-up session: the report gets the lines, what crossed them with its peak, and the timeline ----
await host({ t: 'fakeGame', game: 'Bench Game', front: true });
ok('a made-up game runs in front', await until('feed.game === "Bench Game" && feed.front', 8000), await ev('[feed.game, feed.front, feed.gameSince, nowTs]'));
const g0 = Date.now();   // the host's clock, not the page's last tick: a busy or covered window can get its ticks late
await p.sleep(3000);
await host({ t: 'fakePin', key: cpuKey, v: 70 }); await p.sleep(3000);
await host({ t: 'fakePin', key: cpuKey, v: 91.5 }); await p.sleep(3000);
await host({ t: 'fakePin', key: cpuKey, v: 40 });
while (Date.now() - g0 < 126000) await p.sleep(500);   // past two minute marks: a timeline of three
ok('it still runs two minutes on', await ev('feed.game === "Bench Game"'), await ev('[feed.game, feed.gameSince, nowTs]'));
await host({ t: 'fakeGame', game: null });
const gl = () => text(join(data, 'games.log')).trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).find(x => x && x.game === 'Bench Game');
let t0 = Date.now(); while (!gl() && Date.now() - t0 < 6000) await p.sleep(250);
const g = gl() || {};
const item = n => (g.items || []).find(it => it[0] === n);
ok('the session is logged', !!gl(), text(join(data, 'games.log')).slice(-300));
ok('its main readings, found by their HWiNFO names, marked as main', ['CPU temp', 'GPU temp', 'GPU hotspot', 'GPU memory', 'CPU power', 'GPU power', 'GPU usage', 'CPU usage', 'VRAM', 'RAM'].every(n => item(n) && item(n).length === 9 && item(n)[6] === 1),
  (g.items || []).map(it => it[0] + ':' + it.length + ':' + it[6]).join(', '));
ok('a cell\'s lines go with its reading (CPU temp: yellow 60, red 90)', item('CPU temp') && item('CPU temp')[4] === 60 && item('CPU temp')[5] === 90 && item('CPU temp')[3] === 91.5, JSON.stringify(item('CPU temp')));
ok('RAM carries its scale (used + free), in MB like HWiNFO', item('RAM') && item('RAM')[1] === 'MB' && item('RAM')[7] > item('RAM')[3], JSON.stringify(item('RAM')));
ok('a gated cell that is not a main reading goes by the cell\'s name, with its lines and "below"', !!item('Fan check') && item('Fan check')[4] === 100 && item('Fan check')[6] === 0 && item('Fan check')[8] === 1, JSON.stringify(item('Fan check')));
ok('what crossed a line: name and worst value', g.warns >= 2 && Array.isArray(g.wl) && g.wl.length === 1 && g.wl[0][0] === 'Hot CPU' && g.wl[0][1] === 91.5 && g.wl[0][2] === '\u00b0C', JSON.stringify({ warns: g.warns, wl: g.wl }));
ok('a timeline per minute: fps, 1% low, what limited it', Array.isArray(g.tf) && g.tf.length >= 3 && g.tf.length === g.tl.length && g.tf.length === g.tb.length && g.tf.every(v => v > 0) && g.tl.every((v, i) => v > 0 && v < g.tf[i]) && /^[gcf]+$/.test(g.tb),
  JSON.stringify({ tf: g.tf, tl: g.tl, tb: g.tb }));
await click('#gamesBtn');
await until('[...document.querySelectorAll("#glist .gx-gn")].some(x => x.textContent === "Bench Game")', 5000);
ok('the popup shows it on top, open, with its warning and the timeline', await ev('(() => { const s = document.querySelector("#glist .gx-sess"); return s.classList.contains("open") && s.querySelector(".gx-gn").textContent === "Bench Game" && /2 warningsHot CPU 91\\.5 °C/.test(s.querySelector(".gx-st").textContent) && !!s.querySelector(".gx-fpsc polyline") && !!s.querySelector(".gx-strip span"); })()'),
  await ev('document.querySelector("#glist .gx-sess").textContent.slice(0, 300)'));
ok('its cpu temp row shows the yellow tick and a red max', await ev('(() => { const r = [...document.querySelectorAll("#glist .gx-sess.open .gx-rd .gx-rr")].find(x => x.querySelector(".l").textContent === "temp"); return !!r && !!r.querySelector(".gx-bar .y") && r.querySelector("b").className === "r"; })()'));
await ev('$("gmodal").classList.remove("open")');
ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
