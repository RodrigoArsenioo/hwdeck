// The bottleneck: HW Deck's own reading (sensor "HW Deck"), on made-up data with a made-up game (the --fake test
// hooks fakeGame and fakePin). Its call for gpu / cpu / capped / no game, its bar and split in the hover and the popup,
// the three views, its settings, and the game report counting the calls only while the game is in front. Start it on
// an EMPTY data folder:
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9236
//   HWDeck.exe --fake 300 --data test\data-bn
// then: node test/e2e-bneck.mjs [port] [dataDir]   (it quits the app itself at the end, to check the saved history)
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9236);
const data = process.argv[3] || 'test/data-bn';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const text = f => existsSync(f) ? readFileSync(f, 'utf8') : '';
const host = m => ev(`send(${JSON.stringify(m)})`);
const pin = (key, v) => host({ t: 'fakePin', key, v });
const game = (name, front) => host({ t: 'fakeGame', game: name, front });
const ts = () => ev('nowTs');

ok('catalog arrives, HWiNFO\'s 300 and two of its own (the bottleneck, the game time)', await until('READ.length === 302 && feed.got'), await ev('READ.length'));
ok('the bottleneck is a reading of the "HW Deck" sensor, right after HWiNFO\'s', await ev('(() => { const r = BYKEY.get(BNECK); return !!r && SENS[r.s].name === "HW Deck" && r.label === "Bottleneck" && r.idx === 300; })()'));
ok('the status dot counts only HWiNFO\'s readings', /Demo data: 300 made-up/.test(await ev('$("dot").title')), await ev('$("dot").title'));
const gpuKey = await ev('(READ.find(r => r.label === "GPU Core Load" && /^dGPU/.test(SENS[r.s].name)) || {}).key');
const cpuKey = await ev('(READ.find(r => r.label === "Max CPU/Thread Usage" && /^CPU/.test(SENS[r.s].name)) || {}).key');
ok('made-up data has the readings it goes by (GPU Core Load, Max CPU/Thread Usage)', !!gpuKey && !!cpuKey, gpuKey + ', ' + cpuKey);
await game(null);   // whatever runs on this PC: from here on the test says what plays

// ---- Storage: found by search, added like any other reading ----
let c = await p.center('#q'); await p.click(c.x, c.y); await p.type('bottleneck');
ok('a search finds it in Storage, under HW Deck', await until('!!document.querySelector(\'#vspace .vrow.r[data-key="hwdeck.0/bneck"]\') && [...document.querySelectorAll("#vspace .vrow.g .gn")].some(g => g.textContent === "HW Deck")', 3000));
c = await p.center('#vspace .vrow.r[data-key="hwdeck.0/bneck"] .add'); await p.click(c.x, c.y); await p.sleep(300);
ok('+ adds it as a cell', await ev('S.L.cats.length === 1 && S.L.cats[0].name === "HW Deck" && S.L.cells[S.L.cats[0].cells[0]].key === BNECK'), await ev('S.L.cats.map(c => c.name)'));
const cid = await ev('S.L.cats[0].cells[0]');
await ev('(() => { $("q").value = ""; query = ""; renderStorage(); return 1; })()');
const cell = `document.querySelector('#view .dc[data-cid="${cid}"]')`;
const shown = () => ev(`(() => { const el = ${cell}; return el ? (el.querySelector('.v').textContent + ' ' + el.querySelector('.u').textContent).trim() : null; })()`);
const cap = () => ev(`(() => { const el = ${cell}; return el ? el.querySelector('.tc, .hc, .lbl i, .ginfo').textContent : null; })()`);
const untilShown = async (want, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await shown() === want) return true; await p.sleep(200); } return false; };

const CALLS = ['GPU bound', 'CPU bound', 'FPS capped'];
const untilCall = async ms => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (CALLS.includes(await shown())) return true; await p.sleep(200); } return false; };
ok('no game: the call of right now all the same, and it says no game runs', await untilCall(9000) && await cap() === 'no game running', await shown() + ' / ' + await cap());
ok('but nothing of it goes into the history (the reading has no value with no game)', await ev('BYKEY.get(BNECK).v == null && [1, 2, 3].includes(feed.bnl)'), await ev('[BYKEY.get(BNECK).v, feed.bnl]'));

// ---- the calls ----
await pin(gpuKey, 99); await pin(cpuKey, 50);
const a0 = await ts();
await game('Bench Game', true);
ok('a game in front with the GPU at 99%: GPU bound', await untilShown('GPU bound'), await shown());
ok('the page knows the game runs in front', await ev('feed.game === "Bench Game" && feed.front'));
await p.sleep(2000);
await pin(gpuKey, 50); await pin(cpuKey, 95);
const a1 = await ts();
ok('the GPU at 50% with a thread at 95%: CPU bound (the most common call of the last 5 s)', await untilShown('CPU bound'), await shown());
await p.sleep(2000);
await pin(cpuKey, 40);
ok('the GPU at 50%, the thread at 40%: FPS capped', await untilShown('FPS capped'), await shown());
await pin(gpuKey, 90);
await p.sleep(4000);
ok('the GPU between 85 and 95% keeps the previous call', await shown() === 'FPS capped', await shown());
ok('its caption is the split of the last 15 min', /^gpu \d+%, cpu \d+%, capped \d+%$/.test(await cap()), await cap());
ok('the tile has a bar of the calls in three colours instead of a graph', await ev(`(() => { const el = ${cell}; const k = [...el.querySelectorAll('.strip span')].map(s => s.className); return !el.querySelector('canvas') && ['b-gpu', 'b-cpu', 'b-cap'].every(x => k.includes(x)); })()`),
  await ev(`[...${cell}.querySelectorAll('.strip span')].map(s => s.className + ' ' + s.style.left + ' ' + s.style.width).join(' | ')`));
ok('the host sends the call as a number (3 = capped)', await ev('BYKEY.get(BNECK).v === 3'), await ev('BYKEY.get(BNECK).v'));

// ---- the hover preview and the popup: the bar large and the split ----
await ev('setEdit(false)'); await p.sleep(400);
c = await p.center(`#view .dc[data-cid="${cid}"]`);
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await p.sleep(900);
ok('the hover preview shows the bar and the split, no graph', await ev('HP.shown && hprev.querySelector("canvas").hidden && !hprev.querySelector(".pstrip").hidden && hprev.querySelectorAll(".pstrip .strip span").length >= 3 && /gpu\\d+%.*cpu\\d+%.*capped\\d+%/.test(hprev.querySelector(".ps").textContent)'),
  await ev('hprev.querySelector(".ps").textContent + " / " + hprev.querySelector(".pv").textContent'));
ok('and the call in words', await ev('hprev.querySelector(".pv").textContent === "FPScapped"'), await ev('hprev.querySelector(".pv").textContent'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300 }); await p.sleep(250);
c = await p.center(`#view .dc[data-cid="${cid}"]`); await p.click(c.x, c.y); await p.sleep(600);
ok('the popup shows the bar of the last 15 min and the split instead of a graph, the range tabs above it', await ev('modal.classList.contains("open") && !$("mgraphsec").hidden && $("mgraph").hidden && $("mstats").hidden && !!$("mrng").offsetWidth && $("mextra").querySelectorAll(".bnp .bnc rect").length >= 3 && /gpu\\d+%.*cpu\\d+%.*capped\\d+%/.test($("mextra").querySelector(".mstats").textContent)'),
  await ev('$("mextra").textContent'));
// over an hour and more: the host's history, a column per minute (10 minutes over 7 days), each split into the calls
const rangeOk = async (r, n) => {
  c = await p.center(`#mrng button[data-r="${r}"]`); await p.click(c.x, c.y);
  const got = await until(`histReady() && Array.isArray(bigHist.sg) && bigHist.sg.length === ${n} && bigHist.sc.length === ${n} && bigHist.sf.length === ${n} && !document.querySelector('.bnp.loading')`, 5000);
  await p.sleep(300);
  return got && await ev(`(() => { const H = bigHist, last = [H.sg, H.sc, H.sf].map(a => a.slice(-3).reduce((x, y) => x + (y || 0), 0));
    return H.sg.every((x, i) => (x || 0) + (H.sc[i] || 0) + (H.sf[i] || 0) <= 1.0001) && last.every(x => x > 0) && document.querySelectorAll('.bnp .bnc rect').length >= 3 &&
      /gpu\\d+%cpu\\d+%capped\\d+%game time\\d+[ms]/.test($('mextra').querySelector('.mstats').textContent); })()`);
};
ok('1 h: a column per minute, each call\'s share of it, the split and the game time', await rangeOk('1h', 60), await ev('$("mextra").querySelector(".mstats").textContent + " | " + JSON.stringify(bigHist && [bigHist.range, bigHist.sg && bigHist.sg.slice(-3), bigHist.sc && bigHist.sc.slice(-3), bigHist.sf && bigHist.sf.slice(-3)])'));
ok('its game time is no more than the game has run (a minute counts for the part of it with a game, not of the seconds seen)', await ev(`bnSum(BNP.B).secs <= nowTs - ${a0} + 3 && bnSum(BNP.B).secs >= 5`), await ev(`[bnSum(BNP.B).secs, nowTs - ${a0}]`));
const bb = await ev('(() => { const b = document.querySelector(".bnp .bnc").getBoundingClientRect(); return { x: b.right - b.width / 120, y: b.top + b.height / 2 }; })()');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bb.x, y: bb.y }); await p.sleep(300);
ok('hovering a minute reads out its split and how long a game ran in it', await ev('document.querySelector(".bnp .bnw").classList.contains("hv") && /^\\d\\d:\\d\\d(gpu|cpu|capped) \\d+%.*a game for \\d+ s$/.test(document.querySelector(".bnp .btip").textContent)'), await ev('document.querySelector(".bnp .btip").textContent'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await p.sleep(200);
for (const [r, n] of [['6h', 360], ['12h', 720], ['24h', 1440], ['7d', 1008]]) ok(r + ': the same from the host\'s history (' + n + ' columns)', await rangeOk(r, n), await ev('$("mextra").querySelector(".mstats").textContent'));
c = await p.center('#mrng button[data-r="15m"]'); await p.click(c.x, c.y); await p.sleep(400);
ok('back to 15 min: the seconds again', await ev('$("mextra").querySelectorAll(".bnp .bnc rect").length >= 3 && !/game time/.test($("mextra").querySelector(".mstats").textContent)'));
ok('its title says the call', await ev('$("mval").textContent.trim() === "FPS capped" && /most common call of the last 5 seconds/.test($("mdesc").textContent)'), await ev('$("mval").textContent'));
const desc = await ev('$("mdesc").textContent');
ok('it says which readings it goes by, found by their names', /goes by GPU Core Load \(dGPU\) and Max CPU\/Thread Usage \(CPU[^)]*\)\.$/.test(desc), desc.split('. ').pop());
await ev('closeDetail()');

// ---- the other views ----
await ev('showScreen("overview")'); await p.sleep(700);
ok('Overview: the call, its split and its bar', await shown() === 'FPS capped' && /^gpu \d+%/.test(await cap()) && await ev(`${cell}.querySelectorAll('.strip span').length >= 3`), await shown() + ' / ' + await cap());
await ev('showScreen("grid")'); await p.sleep(700);
ok('Grid: the call, the bar across min / max / average, its split under info', await shown() === 'FPS capped' && /^gpu \d+%/.test(await cap()) && await ev(`${cell}.querySelectorAll('td.gstrip .strip span').length >= 3 && !${cell}.querySelector('td.gn')`), await shown() + ' / ' + await cap());
await ev('showScreen("tiles")'); await p.sleep(500);

// ---- its settings: no decimals, no lines, no fan curve ----
await ev(`(() => { setEdit(true); selectCell(${JSON.stringify(cid)}); return 1; })()`); await p.sleep(300);
ok('its settings have no lines, decimals or fan curve, only the bar', await ev('!$("iMode") && !$("iDec") && !$("iCurveOn") && !!$("iGraph") && !!$("iName")'));
await ev('setEdit(false)');

// ---- in the background the call goes on, the report doesn't count it ----
await game('Bench Game', false);
await p.sleep(1500);
const b0 = await ts();
await pin(gpuKey, 99);
ok('in the background the cell still makes its call', await untilShown('GPU bound'), await shown());
ok('and the page knows it is in the background', await ev('feed.game === "Bench Game" && !feed.front'));
await p.sleep(7000);
await pin(gpuKey, 50);
await p.sleep(1500);
const b1 = await ts();
await game('Bench Game', true);
await until('feed.front', 5000);
// a session needs a minute to be logged
await until('nowTs - feed.gameSince >= 66', 70000);
await game(null);
ok('the game ends: the call goes on (FPS capped), no game running, nothing more in the history', await until('BYKEY.get(BNECK).v == null', 5000) && await untilShown('FPS capped', 5000) && await cap() === 'no game running', await shown() + ' / ' + await cap());
ok('on a PC whose HWiNFO shares neither reading it says so', await ev(`(() => { const k = feed.bnIn; feed.bnIn = [null, null, 0]; const s = evalCell(${JSON.stringify(cid)}, S.L.cells[${JSON.stringify(cid)}], true, true).sub, d = bnFrom(); feed.bnIn = k; return s === 'needs GPU usage and CPU thread usage' && /shares no GPU core load/.test(d); })()`));

const gl = () => text(join(data, 'games.log')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).find(x => x.game === 'Bench Game');
let t0 = Date.now(); while (!gl() && Date.now() - t0 < 5000) await p.sleep(250);
const g = gl();
ok('the session is logged with g, c and f', !!g && [g.g, g.c, g.f].every(Number.isFinite), g ? JSON.stringify({ secs: g.secs, front: g.front, g: g.g, c: g.c, f: g.f }) : 'no line');
if (g) {
  ok('every second in front has a call, none in the background', g.g + g.c + g.f <= g.front && g.g + g.c + g.f >= g.front - 2 && g.secs - g.front >= b1 - b0 - 2, `secs ${g.secs}, front ${g.front}, calls ${g.g + g.c + g.f}, background ${b1 - b0} s`);
  ok('gpu-bound counts only its time in front (not the background time at 99%)', Math.abs(g.g - (a1 - a0)) <= 2, `g ${g.g}, gpu-bound in front ${a1 - a0} s, in the background ${b1 - b0} s`);
  ok('cpu-bound and capped add up to the rest', g.c >= 2 && g.f >= 20, `c ${g.c}, f ${g.f}`);
  ok('a call per minute (- with none in front) for the timeline', typeof g.tb === 'string' && g.tb.length >= 2 && /^[gcf-]+$/.test(g.tb) && /[gcf]/.test(g.tb) && g.tf.length === g.tb.length, JSON.stringify({ tb: g.tb, tf: g.tf }));
  ok('and each minute\'s seconds per call, in front only', Array.isArray(g.tc) && g.tc.length === g.tb.length && g.tc.every((x, i) => x === null ? g.tb[i] === '-' : x.length === 3) &&
    [0, 1, 2].every(k => g.tc.reduce((a, x) => a + (x ? x[k] : 0), 0) === [g.g, g.c, g.f][k]), JSON.stringify({ tc: g.tc, tb: g.tb }));
}

// ---- the game log: what limited a session in its row and its timeline; lines from before it still show ----
const oldAt = Math.floor(Date.now() / 1000) - 2 * 86400;   // older than the calls, still inside the days kept
const old = JSON.stringify({ game: 'Old Game', start: oldAt, end: oldAt + 3600, from: oldAt, secs: 3600, front: 3600, fps: 120, low: 90, items: [['GPU temp', '°C', 60, 70]], warns: 0 });
await ev(`renderGames(${JSON.stringify(old + '\r\n' + text(join(data, 'games.log')))})`);
const lim = await ev('[...document.querySelectorAll("#glist .gx-sess")].map(s => (gxFill(s), s)).map(s => [s.querySelector(".gx-gn").textContent, s.querySelectorAll(".gx-row .gx-nbar span").length, s.querySelector(".gx-row .gx-nbar + .gx-sub, .gx-row .gx-c:nth-child(6) .gx-sub").textContent, !!s.querySelector(".gx-bnc rect"), s.querySelector(".gx-det").textContent])');
ok('a session shows what limited it (row and timeline); one from before (no g, c, f) still shows, without it', lim.length === 2 && lim[0][0] === 'Bench Game' && lim[0][1] >= 2 && /^(gpu-bound|cpu-bound|capped) \d+%$/.test(lim[0][2]) && lim[0][3] && /gpu-bound \d+%cpu-bound \d+%capped \d+%/.test(lim[0][4]) &&
  lim[1][0] === 'Old Game' && lim[1][1] === 0 && lim[1][2] === '--' && !lim[1][3] && /GPU60\.070\.0/.test(lim[1][4]), JSON.stringify(lim.map(x => x.slice(0, 4))));
ok('no warning lines for it', !/Bottleneck/.test(text(join(data, 'alerts.log'))));

// ---- history: the host keeps its seconds, a reloaded page gets them back ----
await p.cmd('Page.reload'); await p.sleep(3000);
ok('after a reload the bar comes back from the host\'s history', await until('series(BNECK, HLEN).filter(x => x >= 1 && x <= 3).length >= 50 && document.querySelectorAll(".dc .strip span").length >= 3', 5000), await ev('series(BNECK, HLEN).filter(x => x >= 1).length'));
ok('no page errors', errs.length === 0, errs.join(' | '));
p.evaluate(`send({ t: 'exit' })`).catch(() => {});
t0 = Date.now(); let gone = false;
while (!gone && Date.now() - t0 < 10000) { await p.sleep(300); try { await fetch(`http://127.0.0.1:${port}/json`); } catch (e) { gone = true; } }
ok('saved in hist.bin at exit, with each call\'s share for the long ranges', gone && ['hwdeck.0/bneck', 'hwdeck.0/bneck.g', 'hwdeck.0/bneck.c', 'hwdeck.0/bneck.f'].every(k => readFileSync(join(data, 'hist.bin')).includes(Buffer.from(k))), gone ? 'exited' : 'still running');
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
