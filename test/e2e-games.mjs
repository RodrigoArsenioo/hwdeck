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

ok('catalog arrives', await until('READ.length === 302 && feed.got'));
await host({ t: 'fakeGame', game: null });   // whatever runs on this PC: from here on the test says what plays
const cpuKey = 'f0000501.0/01000000';
await host({ t: 'fakePin', key: cpuKey, v: 40 });   // under its lines until the made-up session below

// ---- lines on disk: one of this version's, one from 1.0.0 (no lines, bottleneck or timeline) ----
const now = Math.floor(Date.now() / 1000), d0 = new Date(); d0.setHours(0, 0, 0, 0);
const at = (daysAgo, h, m) => Math.floor(d0.getTime() / 1000) - daysAgo * 86400 + h * 3600 + m * 60;
const s1 = Math.min(at(1, 18, 51), now - 3 * 3600), mins = 88;
// (the first 10 minutes only have the call that held most of each, like a session from before 1.3.0 picked up after an update)
const tf = [], tl = [], tc = []; let tb = '';
for (let m = 0; m < mins; m++) {
  const away = m >= 33 && m < 56, c = m % 9 < 5 ? 40 : 15, f = m % 9 === 8 ? 30 : 5, g = 60 - c - f;
  tf.push(away ? null : 150 + Math.round(30 * Math.sin(m / 4))); tl.push(away ? null : 70 + (m % 5));
  tb += away ? '-' : c >= g && c >= f ? 'c' : g >= f ? 'g' : 'f'; tc.push(away || m < 10 ? null : [g, c, f]);
}
const full = { game: 'Marvel Rivals', start: s1, end: s1 + mins * 60, from: s1, secs: mins * 60, front: 65 * 60, fps: 161, low: 72,
  items: [['GPU temp', '\u00b0C', 64, 70.6, 80, 88, 1, null, 0], ['GPU hotspot', '\u00b0C', 72.3, 79.4, 90, null, 1, null, 0], ['GPU memory', '\u00b0C', 71, 78, null, null, 1, null, 0],
    ['GPU power', 'W', 314, 447, 400, 600, 1, null, 0], ['GPU usage', '%', 77, 99, null, null, 1, null, 0], ['CPU temp', '\u00b0C', 58.4, 66.1, 85, 95, 1, null, 0],
    ['CPU power', 'W', 84.6, 121.9, null, null, 1, null, 0], ['CPU usage', '%', 71, 100, null, null, 1, null, 0], ['VRAM', 'MB', 12000, 15155, null, null, 1, 32607, 0],
    ['RAM', 'MB', 40000, 44544, null, null, 1, 65459, 0], ['Rear fan', 'RPM', 1200, 1450, 500, null, 0, null, 1]],
  warns: 1, g: 1400, c: 2340, f: 160, wl: [['GPU power', 583, 'W']], tf, tl, tb, tc };
const old = { game: 'Old Game', start: s1 - 86400, end: s1 - 86400 + 3600, from: s1 - 86400, secs: 3600, front: 3600, fps: 120, low: 90,
  items: [['GPU temp', '\u00b0C', 60, 70], ['Temperature 9', '\u00b0C', 50, 61]], warns: 0 };
writeFileSync(join(data, 'games.log'), JSON.stringify(old) + '\r\n' + JSON.stringify(full) + '\r\n' + 'not json\r\n');

await click('#gamesBtn');
ok('the popup gets the host\'s log: a table of sessions, newest first', await until('document.querySelectorAll("#glist .gx-sess").length === 2', 5000) &&
  await ev('[...document.querySelectorAll("#glist .gx-gn")].map(x => x.textContent).join() === "Marvel Rivals,Old Game"'), await ev('$("glist").textContent.slice(0, 120)'));
ok('the table has its columns (session, length, fps, 1% low, limited by, warnings)', await ev('[...document.querySelectorAll("#glist .gx-cols span")].map(x => x.textContent.trim()).filter(Boolean).join() === "session,length,fps,1% low,limited by,warnings"'));
ok('the summary: sessions, time played, most played, a 7 day strip', /last 7 days\s*2\s*sessions/.test(await T('#gsum')) && /most playedMarvel Rivals/.test(await T('#gsum')) && await ev('document.querySelectorAll("#gsum .gx-wd").length === 7'), await T('#gsum'));
const row = i => ev(`[...document.querySelectorAll("#glist .gx-sess")][${i}].querySelector(".gx-row").textContent`);
ok('a row, one line: name, times, length, fps, 1% low, what limited it, warnings', /^Marvel Rivals\d\d:\d\d to \d\d:\d\d1h 05m16172cpu-bound 60%1 warning$/.test(await row(0)), await row(0));
ok('its time in front and the warnings in the row\'s hints', await ev('(() => { const r = document.querySelector("#glist .gx-row"); return r.querySelector(".gx-num").title === "23m not in front" && r.querySelector(".gx-wv").title === "GPU power 583 W"; })()'));
ok('every session stays shut when the popup opens', await ev('[...document.querySelectorAll("#glist .gx-sess")].every(s => !s.classList.contains("open"))'));
await ev('document.querySelector("#glist .gx-row").click()'); await p.sleep(400);
ok('a click opens the newest', await ev('(() => { const s = [...document.querySelectorAll("#glist .gx-sess")]; return s[0].classList.contains("open") && !s[1].classList.contains("open"); })()'));
const det = '#glist .gx-sess.open .gx-det';
const grp = () => ev(`[...document.querySelectorAll("${det} .gx-grp")].map(c => c.querySelector(".gx-ch").firstChild.textContent + ": " + [...c.querySelectorAll(".gx-rw")].map(r => r.textContent).join(" | "))`);
const rr = await grp();
ok('its readings in the three default categories, avg and max', rr.length === 3 && rr[0] === 'Temperatures: GPU64.070.6°C | GPU hotspot72.379.4°C | GPU memory71.078.0°C | CPU58.466.1°C' &&
  rr[1] === 'Power and load: GPU power314447W | GPU usage7799% | CPU power84.6121.9W | CPU usage71100%' && rr[2] === 'Memory: VRAMof 3214.8GB | RAMof 6443.5GB', rr);
ok('a summary on top: fps and 1% low, played (in front, 11-07) and the time not in front, the hottest, the split, the warnings', /^average fps1611% low 72played1h 05m23m not in fronthottest79\.4°CGPU hotspotlimited bygpu 36%cpu 60%capped 4%warnings1GPU power 583 W$/.test(await T(det + ' .gx-s5')), await T(det + ' .gx-s5'));
const rw = l => `[...document.querySelectorAll("${det} .gx-rw")].find(x => x.querySelector(".n").textContent === ${JSON.stringify(l)})`;
// (11-02, his ask: no bar under a reading, its average and max only; a max past a line still takes its colour)
ok('a reading\'s row: its name, average and max, no bar', await ev(`(() => { const r = [...document.querySelectorAll("${det} .gx-rw")]; return r.length > 0 && !document.querySelector("${det} .gx-mb") && r.every(x => !!x.querySelector(".n") && !!x.querySelector(".a") && !!x.querySelector(".m")); })()`));
ok('the max coloured by the lines it passed', await ev(`(() => { const f = l => [...document.querySelectorAll("${det} .gx-rw")].find(x => x.querySelector(".n").textContent === l);
  return f("GPU power").querySelector("span.m").className === "m y" && f("GPU").querySelector("span.m").className === "m"; })()`));
ok('a line that warns below doesn\'t colour the max (a fan)', await ev(`(() => { const d = document.createElement('div'); d.innerHTML = gxItemRow({ n: 'Rear fan', u: 'RPM', a: 1200, m: 1450, y: 500, r: null, hi: null, below: true }, 'Rear fan', null); return d.querySelector('span.m').className === 'm'; })()`));
ok('no key for bars that aren\'t there', await ev(`!document.querySelector("${det} .gx-key")`));
ok('the timeline: fps and its 1% low as lines, the band between, a gap while not in front', await ev(`(() => { const s = document.querySelector("${det} .gx-fpsc"); return !!s && s.querySelectorAll("polyline.fp").length === 2 && s.querySelectorAll("polyline.lo").length === 2 && s.querySelectorAll("polygon").length === 2; })()`), await ev(`document.querySelector("${det} .gx-tl") && document.querySelector("${det} .gx-tl").textContent`));
ok('the fps chart is tall, with round numbers along its side', await ev(`(() => { const s = document.querySelector("${det} .gx-fpsc"), y = [...document.querySelectorAll("${det} .gx-yax span")].map(x => +x.textContent); return s.getBoundingClientRect().height >= 130 && y.length >= 3 && y.length <= 7 && y.every((v, i) => !i || v > y[i - 1]) && y[0] <= 70 && y[y.length - 1] >= 180; })()`),
  await ev(`[...document.querySelectorAll("${det} .gx-yax span")].map(x => x.textContent)`));
ok('what limited it, minute by minute, as a graph, and the split', await ev(`(document.querySelector("${det} .gx-bnc path.bl").getAttribute("d").match(/H/g) || []).length > 60`) && /^fps1% lowgpu-bound 36%cpu-bound 60%capped 4%not in front 23m$/.test(await T(det + ' .gx-leg')), await T(det + ' .gx-leg'));
// each minute's main call as a level (11-04, his "for EVERY bar in the app replace with a graph"): the line's height
// over a minute (6 GPU, 20 CPU, 34 capped on its 40 high box); minute 12: 15 s gpu-bound, 40 s cpu-bound, 5 s capped
const lvAt = m => ev(`(() => { const d = document.querySelector("${det} .gx-bnc path.bl").getAttribute("d"); let x = 0, y = 0, out = ''; for (const [, c, a, b] of d.matchAll(/([MHV])([\\d.]+)(?: ([\\d.]+))?/g)) { if (c === 'M') { x = +a; y = +b; } else if (c === 'V') y = +a; else { const x2 = +a; if (x <= ${m * 10} && x2 >= ${(m + 1) * 10}) out = String(y); x = x2; } } return out; })()`);
ok('each minute shows its main call as a level (minute 12: cpu-bound)', await lvAt(12) === '20', await lvAt(12));
ok('a minute with only its main call (an older session) shows that call', await lvAt(3) === '20', await lvAt(3));
ok('minutes not in front stay empty (a gap in the line)', await lvAt(40) === '', await lvAt(40));
ok('the levels are named on the right (GPU, CPU, capped) and the line is not yellow or red', await ev(`[...document.querySelectorAll("${det} .gx-bny span")].map(x => x.textContent).join() === 'GPU,CPU,capped' && !/230, 200, 74|229, 72, 77/.test(getComputedStyle(document.querySelector("${det} .gx-bnc path.bl")).stroke)`),
  await ev(`[...document.querySelectorAll("${det} .gx-bny span")].map(x => x.textContent).join() + ' ' + getComputedStyle(document.querySelector("${det} .gx-bnc path.bl")).stroke`));
// the hover read-out: the minute under the pointer
const hoverAt = async (m, chart) => { const r = await ev(`(() => { const e = document.querySelector("${det} ${chart}"); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.left + (${m} + 0.5) / ${mins} * b.width, y: b.top + b.height / 2 }; })()`);
  await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }); await p.sleep(250); return T(det + ' .gx-tip'); };
const hhmm = u => { const d = new Date(u * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
let tip = await hoverAt(12, '.gx-fpsc');
ok('hovering a minute reads it out: time, fps, 1% low, the split', tip === hhmm(s1 + 12 * 60) + 'fps 1541% low 72gpu-bound 25%cpu-bound 67%capped 8%' && await ev(`document.querySelector("${det} .gx-hz").classList.contains("hv")`), tip);
ok('a guide runs through both charts at that minute, a dot on each line', await ev(`(() => { const g = [...document.querySelectorAll("${det} .gx-gd")].map(x => x.getBoundingClientRect().left), d = document.querySelector("${det} .gx-dot.fp").getBoundingClientRect(); return g.length === 2 && Math.abs(g[0] - g[1]) < 1 && Math.abs(d.left + d.width / 2 - g[0]) < 2 && getComputedStyle(document.querySelector("${det} .gx-gd")).opacity === "1"; })()`));
tip = await hoverAt(3, '.gx-bnc');
ok('over an older minute it says which call held most of it', tip === hhmm(s1 + 3 * 60) + 'fps 1701% low 73mostly cpu-bound', tip);
tip = await hoverAt(40, '.gx-bnc');
ok('over a gap: not in front', tip === hhmm(s1 + 40 * 60) + 'not in front, or HW Deck was closed', tip);
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await p.sleep(250);
ok('the read-out goes when the pointer leaves', await ev(`!document.querySelector("${det} .gx-hz").classList.contains("hv")`));
ok('clock ticks from start to end', /^\d\d:\d\d.*\d\d:\d\d$/.test(await T(det + ' .gx-ticks')), await T(det + ' .gx-ticks'));

// ---- a line from 1.0.0 ----
ok('an old line still makes a row (no bottleneck: "--", no warnings: none)', /^Old Game\d\d:\d\d to \d\d:\d\d1h 00m12090--none$/.test(await row(1)), await row(1));
await ev('[...document.querySelectorAll("#glist .gx-sess")][1].querySelector(".gx-row").click()'); await p.sleep(400);
ok('click opens it: its reading found by name, what it didn\'t record as --, no timeline', await ev('[...document.querySelectorAll("#glist .gx-sess")].every(s => s.classList.contains("open"))') &&
  await ev(`(() => { const d = [...document.querySelectorAll("#glist .gx-sess")][1].querySelector(".gx-det"); const r = [...d.querySelectorAll(".gx-rw")].map(x => x.textContent); return r.join("|") === "GPU60.070.0°C|GPU hotspot--|GPU memory--|CPU--" && !d.querySelector(".gx-tl") && !d.querySelector(".gx-rw .m.y"); })()`),
  await ev('[...document.querySelectorAll("#glist .gx-sess")][1].querySelector(".gx-det").textContent'));
await ev('[...document.querySelectorAll("#glist .gx-sess")][0].querySelector(".gx-row").click()'); await p.sleep(400);
ok('click again shuts it', await ev('!document.querySelector("#glist .gx-sess").classList.contains("open")'));
ok('a session that recorded nothing says so', await ev(`(() => { renderGames(JSON.stringify({ game: 'Bare', start: ${now - 7200}, end: ${now - 3600}, from: ${now - 7200}, secs: 3600, front: 3600, fps: null, low: null, items: [], warns: 0 })); document.querySelector('#glist .gx-row').click(); return document.querySelector("#glist .gx-sess.open .gx-nil").textContent === "No readings were recorded for this session." && document.querySelector("#glist .gx-row").textContent.includes("----"); })()`));
ok('a session of your own under 2 minutes says when its chart starts', await ev(`(() => { renderGames(JSON.stringify({ game: 'Quick', custom: 1, start: ${now - 600}, end: ${now - 570}, from: ${now - 600}, secs: 30, front: 0, fps: 150, low: 100, items: [['GPU temp', '°C', 50, 55, null, null, 1, null, 0]], warns: 0, g: 30, c: 0, f: 0, tf: [150], tl: [100], tb: 'g', tc: [[30, 0, 0]] })); document.querySelector('#glist .gx-row').click(); const d = document.querySelector('#glist .gx-sess.open'); return /^Quick/.test(d.querySelector('.gx-gm').textContent) && /30s/.test(d.querySelector('.gx-row').textContent) && /chart starts once a session has run for 2 minutes/.test(d.querySelector('.gx-tln').textContent) && !!d.querySelector('.gx-in .gx-acts .gx-nm'); })()`));

// ---- the card: 1000 px (room for three categories side by side), and a thin scrollbar when it is taller than the window ----
ok('the popup is 1000 px wide and its card shows a thin scrollbar (drawn since 11-09: its arrows clear of the corners, the thin one\'s width)', await ev('(() => { const c = document.querySelector("#gmodal .mcard"), s = getComputedStyle(c), r = [...document.styleSheets].flatMap(ss => [...ss.cssRules]).find(x => x.selectorText === ".mcard::-webkit-scrollbar"); return Math.abs(c.getBoundingClientRect().width - Math.min(1000, innerWidth * 0.94)) < 1 && s.scrollbarWidth === "auto" && !!r && r.style.width === "10.25px" && s.overflowY === "auto"; })()'),
  await ev('(() => { const c = document.querySelector("#gmodal .mcard"), s = getComputedStyle(c); return c.getBoundingClientRect().width + " " + s.scrollbarWidth + " " + s.scrollbarColor; })()'));

// ---- Customize: categories and their readings, like the main layout's; kept in the layout ----
await ev(`renderGames(${JSON.stringify(JSON.stringify(full))}); document.querySelector('#glist .gx-row').click()`); await p.sleep(300);
await click('#gcustom');
ok('Customize lists the categories in order, with what each holds', await ev('[...document.querySelectorAll("#gcz .gz-s")].map(s => (s.querySelector(".nm") || s.querySelector(".gz-name")).textContent || s.querySelector(".gz-name").value).join() === "Summary,Over time,Temperatures,Power and load,Memory"'),
  await ev('[...document.querySelectorAll("#gcz .gz-s")].map(s => s.textContent + (s.querySelector("input") ? s.querySelector("input").value : "")).join(" | ")'));
const typeQ = async q => { await ev(`(() => { const i = $("gzQ"); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`); await p.sleep(200); };
ok('the readings to add are Storage\'s list: a search, the type chips, grouped by sensor, with values', await ev('!!$("gzQ") && document.querySelectorAll("#gcz .chips .chip").length >= 5 && gzRows.filter(r => r.g).length >= 3 && !!document.querySelector("#gcz .gz-list .vrow.g") && document.querySelectorAll("#gcz .gz-list .vrow.r").length >= 5'),
  await ev('[document.querySelectorAll("#gcz .chips .chip").length, document.querySelectorAll("#gcz .gz-list .vrow.g").length, document.querySelectorAll("#gcz .gz-list .vrow.r").length]'));
ok('what is already in the category has a tick, the rest a +', await ev('(() => { const keys = gxLayout().secs.find(x => x.id === "temps").cells.map(c => c.key).filter(Boolean); return [...document.querySelectorAll("#gcz .gz-list .vrow.r")].every(r => !!r.querySelector(keys.includes(r.dataset.key) ? ".inv" : ".add")); })()'));
ok('the rows in sight get their values', await until('[...document.querySelectorAll("#gcz .gz-list .vrow.r .val")].some(v => /\\d/.test(v.textContent))', 4000));
await typeQ('voltage');
const vkey = await ev('document.querySelector("#gcz .gz-list .vrow.r") && document.querySelector("#gcz .gz-list .vrow.r").dataset.key');
ok('the search filters the list (sensor, label, unit)', !!vkey && await ev('[...document.querySelectorAll("#gcz .gz-list .vrow.r")].every(r => BYKEY.get(r.dataset.key).hay.includes("voltage"))'), vkey);
await click('#gcz .gz-list .vrow.r .add');
ok('+ puts it in the category: kept in the layout by its key, shown as -- in a session that didn\'t record it', await ev(`S.L.games.secs.find(x => x.id === "temps").cells.slice(-1)[0].key === ${JSON.stringify(vkey)}`) &&
  (await grp())[0].endsWith('--'), (await grp())[0]);
ok('and its row in the list gets the tick', await ev(`!!document.querySelector('#gcz .gz-list .vrow.r[data-key="${vkey}"] .inv')`));
await typeQ('');
await click('#gcz .chips .chip[data-t="fan"]');
ok('a chip shows one type only', await ev('GZ.t === "fan" && [...document.querySelectorAll("#gcz .gz-list .vrow.r")].every(r => BYKEY.get(r.dataset.key).t === "fan")'));
await click('#gcz .chips .chip[data-t="all"]');
const g1 = await ev('document.querySelector("#gcz .gz-list .vrow.g").dataset.sk');
await click('#gcz .gz-list .vrow.g');
ok('a sensor folds up by its row', await ev(`GZ.shut.has(${JSON.stringify(g1)}) && document.querySelector("#gcz .gz-list .vrow.g").classList.contains("collapsed") && document.querySelector("#gcz .gz-list .vrow.g").nextElementSibling.classList.contains("g")`));
await click('#gcz .gz-list .vrow.g');
for (let i = 0; i < 3; i++) { await typeQ('temperature'); await click('#gcz .gz-list .vrow.r .add:not([disabled])'); }   // (4 by default + the voltage + 3 = 8)
ok('a category takes 8 readings at most: the + go grey', await ev('S.L.games.secs.find(x => x.id === "temps").cells.length === 8 && !document.querySelector("#gcz .gz-list .vrow.r .add:not([disabled])") && /8 readings at most/.test($("gcz").textContent)'), await ev('S.L.games.secs.find(x => x.id === "temps").cells.length'));
await typeQ('voltage');
await click(`#gcz .gz-list .vrow.r[data-key="${vkey}"] .inv`);
ok('the tick takes it out again', await ev(`S.L.games.secs.find(x => x.id === "temps").cells.length === 7 && !S.L.games.secs.find(x => x.id === "temps").cells.some(c => c.key === ${JSON.stringify(vkey)})`));
await click(`#gcz .gz-list .vrow.r[data-key="${vkey}"] .add`);
await typeQ('');
await ev('(() => { const i = document.querySelector("#gcz .gz-s.on .gz-name"); i.value = "Heat"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(200);
ok('a category takes a new name', (await grp())[0].startsWith('Heat: '), (await grp())[0].slice(0, 30));
await ev('[...document.querySelectorAll("#gcz .gz-s")].find(s => /Over time/.test(s.textContent)).querySelector("[data-gz=hide]").click()'); await p.sleep(200);
ok('a category can be hidden (Over time: no chart)', !(await ev(`!!document.querySelector("${det} .gx-fpsc")`)) && await ev('S.L.games.secs.find(x => x.id === "time").hide === true'));
// drag Memory (5th) above Summary (1st) by its grip
const gr = await ev('(() => { const r = [...document.querySelectorAll("#gcz .gz-s")], a = r[4].querySelector(".grip").getBoundingClientRect(), b = r[0].getBoundingClientRect(); return { x: a.left + 4, y: a.top + a.height / 2, ty: b.top + 3 }; })()');
await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: gr.x, y: gr.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 8; i++) { await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gr.x, y: gr.y + (gr.ty - gr.y) * i / 8, button: 'left', buttons: 1 }); await p.sleep(20); }
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gr.x, y: gr.ty, button: 'left', buttons: 0, clickCount: 1 }); await p.sleep(300);
ok('a category is moved by dragging its grip (Memory to the top)', await ev('S.L.games.secs.map(x => x.id).join() === "memory,summary,time,temps,power"') && (await grp())[0].startsWith('Memory: '), await ev('S.L.games.secs.map(x => x.id).join()'));
await click('#gcz [data-gz=addsec]');
ok('+ New category adds one, selected, its name ready to type', await ev('S.L.games.secs.length === 6 && document.activeElement && document.activeElement.classList.contains("gz-name") && document.activeElement.value === "New category"'));
ok('the setup is saved with the layout and read back on a load', await ev('JSON.stringify(cleanLayout(JSON.parse(JSON.stringify(S.L))).games) === JSON.stringify(S.L.games)'));
await ev('undo()'); await p.sleep(200);
ok('undo takes a step back', await ev('S.L.games.secs.length === 5'));
await click('#gcz [data-gz=reset]');
ok('Reset brings the default back', await ev('!S.L.games') && (await grp())[0].startsWith('Temperatures: GPU64.0'), (await grp())[0]);
await click('#gcz [data-gz=done]');
ok('Done closes Customize', await ev('$("gcz").hidden'));
// for the made-up session below: a reading no cell has, tracked by the setup
await ev(`(() => { mutate(() => { S.L.games = JSON.parse(JSON.stringify(gxLayout())); S.L.games.secs.find(x => x.id === 'temps').cells.push({ key: ${JSON.stringify(vkey)} }); }); return 1; })()`); await p.sleep(800);
await ev('$("gmodal").classList.remove("open")'); await p.sleep(300);

// ---- a session of your own: Start, a name, Stop; it runs beside the game below ----
await click('#gamesBtn'); await p.sleep(300);
await click('#grec');
ok('Start session asks first (a click by mistake would record until Stop), nothing records yet', await ev('$("cmodal").classList.contains("open") && /Start a session/.test($("ctitle").textContent) && /Session 1/.test($("cdesc").textContent) && $("cyes").textContent === "Start recording" && !(feed.rec || []).length'), await ev('$("ctitle").textContent'));
await click('#cno'); await p.sleep(300);
ok('Cancel: nothing records', await ev('!$("cmodal").classList.contains("open") && !(feed.rec || []).length && $("grun").hidden'));
await click('#grec'); await click('#cyes');
ok('Start session records one: on top with its name, its time, Stop', await until('feed.rec.length === 1 && !$("grun").hidden && document.querySelector("#grun .gx-rn").value === "Session 1" && /^0:0\\d$/.test(document.querySelector("#grun .gx-rt").textContent)', 5000),
  await ev('[JSON.stringify(feed.rec), $("grun").textContent]'));
const own = await ev('feed.rec[0][0]');
ok('while it records: a REC badge, its name to rename (a pencil), since when, a large clock, Stop', await ev('(() => { const r = document.querySelector("#grun .gx-rec"); return /REC/.test(r.querySelector(".gx-recb").textContent) && !!r.querySelector(".gx-rnw svg") && /^since \\d\\d:\\d\\d$/.test(r.querySelector(".gx-rs").textContent) && parseFloat(getComputedStyle(r.querySelector(".gx-rt")).fontSize) >= 18 && /Stop/.test(r.querySelector("[data-rec=stop]").textContent); })()'), await ev('$("grun").innerHTML.slice(0, 300)'));
ok('the title bar dot says something records', await ev('$("gameDot").classList.contains("on") && /recording Session 1/.test($("gamesBtn").title)'), await ev('$("gamesBtn").title'));
await ev('(() => { const i = document.querySelector("#grun .gx-rn"); i.value = "Bench run"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()');
ok('its name can be changed while it runs', await until('feed.rec[0][1] === "Bench run"', 4000), await ev('JSON.stringify(feed.rec)'));
await p.sleep(2200); await click('#grec'); await click('#cyes');   // (a second Start within 2 s is a double click: nothing)
ok('a second one runs beside it', await until('feed.rec.length === 2 && document.querySelectorAll("#grun .gx-rec").length === 2 && feed.rec[1][1] === "Session 1"', 5000), await ev('JSON.stringify(feed.rec)'));
await ev('document.querySelectorAll("#grun [data-rec=stop]")[1].click()');
ok('one stopped under 10 seconds is not kept', await until('feed.rec.length === 1 && document.querySelectorAll("#grun .gx-rec").length === 1', 5000) && await until('/Under 10 seconds/.test($("toastTxt").textContent)', 3000) && !/Session 1/.test(text(join(data, 'games.log'))),
  await ev('$("toastTxt").textContent'));
await ev('$("gmodal").classList.remove("open")'); await p.sleep(300);

// ---- a made-up session: the report gets the lines, what crossed them with its peak, and the timeline ----
await host({ t: 'fakeGame', game: 'Bench Game', front: true });
ok('a made-up game runs in front', await until('feed.game === "Bench Game" && feed.front', 8000), await ev('[feed.game, feed.front, feed.gameSince, nowTs]'));
// ---- Game time (1.4.7): HW Deck's own reading, minutes of the game so far; lines on its cell turn it like any cell ----
const gtOf = c => `(() => { const e = evalCell(${c}); return { txt: e.txt, sub: e.sub, col: e.col, lvl: e.lvl }; })()`;
{
  const gr = await ev('(() => { const r = BYKEY.get(GTIME); return r ? [r.idx, r.unit, SENS[r.s].name, r.label] : null; })()');
  ok('Game time is a reading of HW Deck\'s, in minutes, right after the bottleneck', !!gr && gr[0] === 301 && gr[1] === 'min' && gr[2] === 'HW Deck' && gr[3] === 'Game time', JSON.stringify(gr));
  await ev(`(() => { addKeys([GTIME], null, null, 'Game time check'); window.__gt = Object.keys(S.L.cells).filter(i => S.L.cells[i].key === GTIME).pop(); return 1; })()`);
  ok('in the game: a length and the game\'s name', await until(`(() => { const e = evalCell(__gt, S.L.cells[__gt], true, true); return /^\\d+m$/.test(e.txt) && e.sub === "Bench Game" && e.col === "white"; })()`, 6000), await ev(gtOf('__gt, S.L.cells[__gt], true, true')));
  const gl0 = `'gtline', { key: GTIME, gates: { mode: 'y', dir: 'above', y: 0, hold: 0 } }, false, true`;
  ok('its lines turn the cell: yellow past 0 min, the caption in hours and minutes', await ev(`(() => { const e = evalCell(${gl0}); return e.lvl === 1 && e.col === 'yellow' && e.sub === 'over yellow 0m' && /^\\d+m$/.test(e.txt); })()`), await ev(gtOf(gl0)));
}
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
ok('its line says its bottleneck rule (bv 2: the pace of the frames, since 2.0.1)', g.bv === 2, JSON.stringify(g.bv));
// the same game again within Same game again (30 minutes unless set): its session goes on (one line in the end, the break kept apart: not play), and
// the sessions popup shows it while it runs (Now playing, updated every 5 s)
{
  const first = gl();
  await host({ t: 'fakeGame', game: 'Bench Game', front: true });
  ok('the same game again soon after: its session goes on (the same start)', await until(`feed.game === "Bench Game" && feed.gameSince === ${first.start}`, 8000), await ev('[feed.game, feed.gameSince]'));
  let t1 = Date.now(); while (gl() && Date.now() - t1 < 6000) await p.sleep(250);
  ok('its line comes out of the log while it goes on', !gl(), text(join(data, 'games.log')).slice(-200));
  await ev('$("gamesBtn").click()');
  ok('the sessions popup shows it on top: now playing, to now, 1 break', await until(`(() => { const r = document.querySelector('#glist .gx-sess'); return !!r && r.classList.contains('live') && /now playing/.test(r.textContent) && /to now/.test(r.textContent) && /1 break/.test(r.textContent); })()`, 12000),
    await ev(`(document.querySelector('#glist .gx-sess') || {}).textContent`));
  // (11-02 bug: the per-game table's class was its name's too, which pushed the name down and cut it off on the left)
  ok('its name sits in line, whole, beside its now playing', await ev(`(() => { const r = document.querySelector('#glist .gx-sess.live'), g = r.querySelector('.gx-gn'), t = r.querySelector('.gx-gn .gx-gt'), n = r.querySelector('.gx-now'), cs = getComputedStyle(t), a = t.getBoundingClientRect(), b = g.getBoundingClientRect(), c = n.getBoundingClientRect();
    return cs.marginTop === '0px' && cs.borderTopStyle === 'none' && a.left >= b.left - 0.5 && Math.abs((a.top + a.bottom) / 2 - (c.top + c.bottom) / 2) < 3 && c.left >= a.right; })()`));
  const s1 = await ev('gxNow ? gxNow.secs : -1'); await p.sleep(5600);
  ok('and it goes on live (its seconds count on, no Delete on it)', await ev(`!!gxNow && gxNow.secs > ${s1} && !document.querySelector('#glist .gx-sess.live .gx-del')`), await ev('[gxNow && gxNow.secs, ' + s1 + ']'));
  await ev('$("gselBtn").click()'); await p.sleep(300);
  ok('Select: the session in progress can\'t be picked', await ev("document.querySelector('#glist .gx-sess.live').classList.contains('nopk')"));
  await p.sleep(5600);
  ok('nor after its live redraw, and Pick all leaves it out', await ev("document.querySelector('#glist .gx-sess.live').classList.contains('nopk')") && await ev("(() => { $('gbar').querySelector('[data-pk=all]').click(); return PK.g.pick.size === gxSs.filter(x => !x.live && x._raw).length && !document.querySelector('#glist .gx-sess.live.pk'); })()"), await ev('[PK.g.pick.size, gxSs.length]'));
  await ev('pkMode("g", null)');
  await ev('$("gmodal").classList.remove("open")'); await p.sleep(400);
  await host({ t: 'fakeGame', game: null });
  t1 = Date.now(); while (!gl() && Date.now() - t1 < 6000) await p.sleep(250);
  const m = gl() || {}, gap = Array.isArray(m.gaps) && m.gaps[0] ? m.gaps[0][1] - m.gaps[0][0] : -1;
  ok('ended again: one line from the first start to the new end, its break kept apart', m.start === first.start && m.end > first.end && Array.isArray(m.gaps) && m.gaps.length === 1 && m.gaps[0][0] >= first.end - 1 && gap >= 0 && m.secs > first.secs,
    JSON.stringify([first.start, first.end, first.secs, m.start, m.end, m.gaps, m.secs]));
  ok('only one line for it in the log', text(join(data, 'games.log')).trim().split('\n').filter(l => /"game":"Bench Game"/.test(l)).length === 1);
}
// Settings, Same game again: 30 minutes unless set; set to 0, a game started again after it closed is a new session
{
  await ev('$("setBtn").click()');
  ok('Settings: Same game again, 30 minutes unless set', await until('!!$("sGameMerge") && $("sGameMerge").value === "30"', 6000), await ev('$("sGameMerge") && $("sGameMerge").value'));
  await ev('(() => { const i = $("sGameMerge"); i.value = "0"; i.dispatchEvent(new Event("change", { bubbles: true })); })()');
  let t1 = Date.now(); while (!/"gameMerge":0\b/.test(text(join(data, 'settings.json'))) && Date.now() - t1 < 6000) await p.sleep(250);
  ok('set to 0: kept in settings.json, and Settings shows it', /"gameMerge":0\b/.test(text(join(data, 'settings.json'))) && await until('feed.gameMerge === 0 && $("sGameMerge").value === "0"', 4000), text(join(data, 'settings.json')).slice(0, 300));
  await ev('setmodal.classList.remove("open")'); await p.sleep(300);
  const last = gl() || {};
  await host({ t: 'fakeGame', game: 'Bench Game', front: true });
  ok('with 0, the same game started again is a new session (its own start)', await until(`feed.game === "Bench Game" && feed.gameSince > ${last.end || 0} && !feed.gameGap`, 8000), await ev('[feed.game, feed.gameSince, feed.gameGap]') + ' last ' + JSON.stringify([last.start, last.end]));
  ok('and the last one stays in the log as it was', !!gl() && gl().start === last.start && gl().end === last.end);
  await host({ t: 'fakeGame', game: null }); await p.sleep(7000);
}
await host({ t: 'fakeGame', game: 'Background App', front: false }); await p.sleep(4500);
ok('an app that only runs in the background (an overlay, a tool from Steam) starts no session', await ev('feed.game === null'), await ev('feed.game'));
await host({ t: 'fakeGame', game: null });
// (2.1: no game, Game time shows the last session, the one that ended last, in a softer grey; with none, --)
const lastLine = () => text(join(data, 'games.log')).trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(x => x && x.game && !x.custom).sort((a, b) => a.end - b.end).pop();
const LL = lastLine();
const gtIdle = `(() => { const e = evalCell(__gt, S.L.cells[__gt], true, true); return { txt: e.txt, tsub: e.tsub, sub: e.sub, tag: e.tag, col: e.col }; })()`;
ok('no game: the page has the last session from the host (the one that ended last, as games.log has it)', !!LL && await until(`!!feed.lg && feed.lg.end === ${LL ? LL.end : -1} && feed.lg.game === ${JSON.stringify(LL ? LL.game : '')}`, 8000), await ev('JSON.stringify(feed.lg && [feed.lg.game, feed.lg.end])') + ' / log ' + JSON.stringify(LL && [LL.game, LL.end]));
ok('no game: Game time shows its length in the softer grey, what it was and when it ended, the 24 h in the corner (2.1)', await until(`(() => { const e = ${gtIdle}; return e.txt === durTxt(${LL ? (typeof LL.front === 'number' ? Math.min(LL.front, LL.secs) : LL.secs) : 0}) && e.col === 'past' && e.tsub.startsWith(${JSON.stringify((LL ? LL.game : '') + ', ended ')}) && /( ago| just now)$/.test(e.tsub) && (e.tag === 'last session' ? e.sub === e.tsub : / in 24 h$/.test(e.tag) && e.sub === e.tsub + ', ' + e.tag); })()`, 8000), await ev(`JSON.stringify(${gtIdle})`));
ok('no game: its graph is the last 24 h, Yes a minute a session ran, drawn 0 to 1 in steps, Yes / No in the hover (2.1.1)', await ev(`(() => {
  const e = evalCell(__gt, S.L.cells[__gt], true, true), m0 = Math.floor(nowTs / 60) - 1440, mid = Math.floor((${LL ? LL.start + LL.end : 0}) / 2 / 60) - m0, st = pastState(e.past || [], S.L.cells[__gt]);
  return Array.isArray(e.past) && e.past.length === 1440 && e.pspan === 86400 && e.yn === true && e.past.every(v => v === 0 || v === 1) && mid >= 0 && mid < 1440 && e.past[mid] === 1 &&
    e.past.some(v => v === 0) && !!st && st.lo === 0 && st.hi === 1 && st.step === true && evalCell(__gt, S.L.cells[__gt], true, true).past === e.past; })()`),
  await ev(`(() => { const e = evalCell(__gt, S.L.cells[__gt], true, true); return JSON.stringify({ n: e.past && e.past.length, yes: e.past && e.past.filter(v => v === 1).length, first: e.past && e.past.indexOf(1), span: e.pspan, yn: e.yn, day: feed.lg && feed.lg.day }); })()`));
ok('no game: in a narrow tile, when it ended, without the name (2.1.1: "Deadlock, 1h 04m ago" was cut)', await ev(`/^ended (just now|.+ ago)$/.test(evalCell(__gt, S.L.cells[__gt], true, true).tsubS)`), await ev(`evalCell(__gt, S.L.cells[__gt], true, true).tsubS`));
ok('no game and no session: Game time shows -- in grey', await ev(`(() => { const k = feed.lg; feed.lg = null; const e = evalCell(__gt, S.L.cells[__gt], true, true); feed.lg = k; return e.txt === '--' && e.col === 'grey' && e.sub === 'no game running'; })()`), await ev(gtOf('__gt, S.L.cells[__gt], true, true')));
await ev(`(() => { const id = __gt; mutate(() => { for (const c of S.L.cats) c.cells = c.cells.filter(x => x !== id); S.L.cats = S.L.cats.filter(c => c.cells.length || c.name !== 'Game time check'); delete S.L.cells[id]; }); return 1; })()`);
ok('its main readings, found by their HWiNFO names, marked as main', ['CPU temp', 'GPU temp', 'GPU hotspot', 'GPU memory', 'CPU power', 'GPU power', 'GPU usage', 'CPU usage', 'VRAM', 'RAM'].every(n => item(n) && item(n).length === 11 && item(n)[6] === 1 && typeof item(n)[9] === 'string' && item(n)[10] === 0),
  (g.items || []).map(it => it[0] + ':' + it.length + ':' + it[6]).join(', '));
ok('a cell\'s lines go with its reading (CPU temp: yellow 60, red 90)', item('CPU temp') && item('CPU temp')[4] === 60 && item('CPU temp')[5] === 90 && item('CPU temp')[3] === 91.5, JSON.stringify(item('CPU temp')));
ok('RAM carries its scale (used + free), in MB like HWiNFO', item('RAM') && item('RAM')[1] === 'MB' && item('RAM')[7] > item('RAM')[3], JSON.stringify(item('RAM')));
ok('a gated cell that is not a main reading goes by the cell\'s name, with its lines and "below"', !!item('Fan check') && item('Fan check')[4] === 100 && item('Fan check')[6] === 0 && item('Fan check')[8] === 1, JSON.stringify(item('Fan check')));
ok('a reading the report setup tracks (no cell has it) is recorded too, by its key', (g.items || []).some(it => it[9] === vkey && it[6] === 0 && it[2] > 0), JSON.stringify((g.items || []).find(it => it[9] === vkey)));
ok('what crossed a line: name and worst value', g.warns >= 2 && Array.isArray(g.wl) && g.wl.length === 1 && g.wl[0][0] === 'Hot CPU' && g.wl[0][1] === 91.5 && g.wl[0][2] === '\u00b0C', JSON.stringify({ warns: g.warns, wl: g.wl }));
ok('a timeline per minute: fps, 1% low, what limited it', Array.isArray(g.tf) && g.tf.length >= 3 && g.tf.length === g.tl.length && g.tf.length === g.tb.length && g.tf.every(v => v > 0) && g.tl.every((v, i) => v > 0 && v < g.tf[i]) && /^[gcf]+$/.test(g.tb),
  JSON.stringify({ tf: g.tf, tl: g.tl, tb: g.tb }));
ok('and each minute\'s seconds per call, the most of them the call it shows', Array.isArray(g.tc) && g.tc.length === g.tb.length && g.tc.every((x, i) => Array.isArray(x) && x.length === 3 && x[0] + x[1] + x[2] > 0 && x[0] + x[1] + x[2] <= 61 &&
  'gcf'[x[1] >= x[0] && x[1] >= x[2] ? 1 : x[0] >= x[2] ? 0 : 2] === g.tb[i]) && g.tc.reduce((a, x) => a + x[0], 0) === g.g && g.tc.reduce((a, x) => a + x[1], 0) === g.c && g.tc.reduce((a, x) => a + x[2], 0) === g.f,
  JSON.stringify({ tc: g.tc, tb: g.tb, g: g.g, c: g.c, f: g.f }));
// your own session ran all along: stopped now, it is logged too, with the game's fps for the time the game was in front
await click('#gamesBtn'); await p.sleep(300);
await ev('document.querySelector("#grun [data-rec=stop]").click()');
const ol = () => text(join(data, 'games.log')).trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).find(x => x && x.custom === 1 && x.game === 'Bench run');
t0 = Date.now(); while (!ol() && Date.now() - t0 < 6000) await p.sleep(250);
const o = ol() || {};
ok('Stop logs your own session: marked as yours, under its name, from Start to Stop', o.custom === 1 && o.start === own && o.end - o.start >= 125 && o.secs >= 120, JSON.stringify({ c: o.custom, s: o.start, e: o.end, secs: o.secs }));
ok('it counts every second like a game in front: the fps of what is in front, the call of the moment, its timeline', o.front >= 100 && o.front < o.secs && o.fps > 0 && o.g + o.c + o.f >= o.secs - 5 && (o.items || []).some(it => it[0] === 'CPU temp' && it[3] === 91.5) &&
  Array.isArray(o.tf) && o.tf.length >= 3 && o.tf.every(v => v > 0) && /^[gcf]+$/.test(o.tb), JSON.stringify({ secs: o.secs, front: o.front, fps: o.fps, g: o.g, c: o.c, f: o.f, tf: o.tf, tb: o.tb }));
ok('and the game\'s warning while it ran', o.warns >= 1 && (o.wl || []).some(w => w[0] === 'Hot CPU'), JSON.stringify({ warns: o.warns, wl: o.wl }));
ok('nothing records any more', await until('feed.rec.length === 0 && $("grun").hidden', 8000));
await until('[...document.querySelectorAll("#glist .gx-gn")].some(x => x.textContent === "Bench Game")', 5000);
await ev('(() => { const s = document.querySelector("#glist .gx-sess"); if (!s.classList.contains("open")) s.querySelector(".gx-row").click(); return 1; })()'); await p.sleep(400);
ok('the popup shows it on top, opened, with its warning and the timeline', await ev('(() => { const s = document.querySelector("#glist .gx-sess"); return s.classList.contains("open") && s.querySelector(".gx-gn").textContent === "Bench Game" && /^2 warnings$/.test(s.querySelector(".gx-st").textContent) && /Hot CPU 91\\.5 °C/.test(s.querySelector(".gx-st .gx-wv").title) && !!s.querySelector(".gx-fpsc polyline") && !!s.querySelector(".gx-bnc path.bl"); })()'),
  await ev('document.querySelector("#glist .gx-sess").textContent.slice(0, 300)'));
ok('its CPU row: past its red line, a red max', await ev('(() => { const r = [...document.querySelectorAll("#glist .gx-sess.open .gx-rw")].find(x => x.querySelector(".n").textContent === "CPU"); return !!r && r.querySelector("span.m").className === "m r"; })()'));
ok('and the tracked reading has its row, with a value', await ev('(() => { const r = [...document.querySelectorAll("#glist .gx-sess.open .gx-grp")][0].querySelectorAll(".gx-rw"); const last = r[r.length - 1]; return !last.classList.contains("nil") && /\\d/.test(last.querySelector("span.m").textContent); })()'),
  await ev('[...document.querySelectorAll("#glist .gx-sess.open .gx-grp")][0].textContent'));
const sess = n => `[...document.querySelectorAll("#glist .gx-sess")].find(s => s.querySelector(".gx-gn").textContent === ${JSON.stringify(n)})`;
ok('yours is in the list like a game\'s (no tag, no words after its times)', await until(`!!${sess('Bench run')}`, 4000) && await ev(`${sess('Bench run')}.classList.contains('cust') && /^Bench run\\d\\d:\\d\\d to \\d\\d:\\d\\d$/.test(${sess('Bench run')}.querySelector('.gx-gm').textContent) && getComputedStyle(${sess('Bench run')}.querySelector('.gx-gn'), '::after').content === 'none'`),
  await ev(`${sess('Bench run')} && ${sess('Bench run')}.querySelector('.gx-row').textContent`));
ok('the week\'s numbers are games\' only (3: Marvel Rivals, Old Game, Bench Game; yours not)', /last 7 days\s*3\s*sessions/.test(await T('#gsum')), await T('#gsum'));
await ev(`(() => { const s = ${sess('Bench run')}; if (!s.classList.contains('open')) s.querySelector('.gx-row').click(); return 1; })()`); await p.sleep(400);
ok('its summary: how long it ran, from when to when, its fps and what limited it', /^length\d+m\d\d:\d\d to \d\d:\d\d$/.test(await ev(`${sess('Bench run')}.querySelector('.gx-s5 > div:nth-child(2)').textContent`)) &&
  /^average fps\d+/.test(await ev(`${sess('Bench run')}.querySelector('.gx-s5 > div:nth-child(1)').textContent`)) && /gpu \d+%/.test(await ev(`${sess('Bench run')}.querySelector('.gx-s5').textContent`)),
  await ev(`${sess('Bench run')}.querySelector('.gx-s5').textContent`));
ok('and the same charts as a game\'s: fps and what limited it, minute by minute', await ev(`!!${sess('Bench run')}.querySelector('.gx-fpsc polyline') && (${sess('Bench run')}.querySelector('.gx-bnc path.bl').getAttribute('d').match(/H/g) || []).length >= 2`));
ok('its name and Delete sit inside the details, clear of the card\'s edges', await ev(`(() => { const s = ${sess('Bench run')}, a = s.querySelector('.gx-in .gx-acts'), c = s.getBoundingClientRect(); if (!a) return false; const n = a.querySelector('.gx-nmf').getBoundingClientRect(), d = a.querySelector('.gx-del').getBoundingClientRect(); return n.left - c.left >= 30 && c.right - d.right >= 10; })()`));
await ev(`(() => { const i = ${sess('Bench run')}.querySelector('.gx-nm'); i.value = 'Renamed run'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
ok('a session of yours takes a new name, in the log too', await until(`!!${sess('Renamed run')}`, 5000) && !!text(join(data, 'games.log')).match(/"game":"Renamed run"[^\n]*"custom":1/), text(join(data, 'games.log')).slice(-200));
ok('a game session has no name field, only Delete', await ev(`!${sess('Bench Game')}.querySelector('.gx-nm') && !!${sess('Bench Game')}.querySelector('.gx-del')`));
await ev(`(() => { const s = ${sess('Renamed run')}; if (!s.classList.contains('open')) s.querySelector('.gx-row').click(); s.querySelector('.gx-del').click(); return 1; })()`); await p.sleep(300);
ok('Delete asks first', await ev('cmodal.classList.contains("open") && /Delete this session/.test($("ctitle").textContent)'), await ev('$("ctitle").textContent'));
await click('#cyes');
ok('one session deleted: out of the list and the log, kept in games.log.bak', await until(`!${sess('Renamed run')}`, 5000) && !/Renamed run/.test(text(join(data, 'games.log'))) && /Renamed run/.test(text(join(data, 'games.log.bak'))) && /Bench Game/.test(text(join(data, 'games.log'))),
  text(join(data, 'games.log')).slice(0, 200));
// ---- how long the logs keep what they have (Settings, forever unless changed) ----
ok('the host says how long the logs keep (forever by default)', await ev('feed.gameDays === 0 && feed.warnDays === 0'), await ev('[feed.gameDays, feed.warnDays]'));
await ev('$("gmodal").classList.remove("open")');
await click('#setBtn');
ok('Settings shows forever on both, with no days fields', await ev('!$("sGameDays") && !$("sWarnDays") && [...document.querySelectorAll(".setkeep .seg button.on")].every(b => b.dataset.v === "forever")'));
await ev('$("setmodal").classList.remove("open")');
await host({ t: 'keep', games: 30, warns: 30 }); await until('feed.gameDays === 30 && feed.warnDays === 30', 3000);
await click('#setBtn');
ok('Settings has the days for sessions and warnings', await ev('+$("sGameDays").value === 30 && +$("sWarnDays").value === 30'));
// Enter after a smaller number: the question opens and stays (the same Enter used to press its Cancel)
await ev('(() => { const i = $("sWarnDays"); i.focus(); i.select(); return 1; })()'); await p.type('7');
await p.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await p.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await p.sleep(400);
ok('Enter after a smaller number asks, and the question stays open', await ev('cmodal.classList.contains("open") && /Keep warnings 7 days/.test($("ctitle").textContent)'), await ev('[cmodal.className, $("ctitle").textContent, $("sWarnDays").value]'));
await click('#cno');
ok('Cancel leaves the days as they were', await ev('feed.warnDays === 30 && $("sWarnDays").value === "30"'));
const setDays = (id, v) => ev(`(() => { const i = $("${id}"); i.value = "${v}"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
ok('the days are typed, not a spinner a wheel could run down', await ev('$("sGameDays").type === "text" && $("sWarnDays").type === "text"'));
await setDays('sGameDays', 1); await p.sleep(450);   // (the question settles before its button is clicked)
ok('fewer days asks first, and nothing changes until you say yes', await ev('cmodal.classList.contains("open") && /Keep sessions 1 day/.test($("ctitle").textContent) && feed.gameDays === 30 && $("sGameDays").value === "30"'), await ev('$("ctitle").textContent'));
await click('#cyes');
await setDays('sWarnDays', 14); await p.sleep(450);
await click('#cyes');
ok('sessions older than that go at once (Old Game, a day back), kept in games.log.bak', await until('feed.gameDays === 1 && feed.warnDays === 14', 4000) && await (async () => { let t1 = Date.now(); while (/Old Game/.test(text(join(data, 'games.log'))) && Date.now() - t1 < 4000) await p.sleep(200); return !/Old Game/.test(text(join(data, 'games.log'))) && /Bench Game/.test(text(join(data, 'games.log'))) && /Old Game/.test(text(join(data, 'games.log.bak'))); })(),
  text(join(data, 'games.log')).slice(0, 120));
ok('the days are kept in the host\'s settings', /"gameDays":1/.test(text(join(data, 'settings.json'))) && /"warnDays":14/.test(text(join(data, 'settings.json'))), text(join(data, 'settings.json')));
await ev('$("setmodal").classList.remove("open")');
await click('#logBtn');
ok('the warning history says the days it shows', await until('$("wdays").textContent === "14"', 4000), await ev('$("wdays").textContent'));
await ev('$("wmodal").classList.remove("open")');
// ---- Keep: days or forever. Forever goes at once (nothing is deleted) and the days field goes; days again asks first ----
const ancient = { game: 'Ancient Game', start: now - 400 * 86400, end: now - 400 * 86400 + 1800, from: now - 400 * 86400, secs: 1800, front: 1800, fps: 90, low: 60, items: [], warns: 0 };
writeFileSync(join(data, 'games.log'), text(join(data, 'games.log')) + JSON.stringify(ancient) + '\r\n');
await click('#setBtn');
ok('each Keep row has its days and a days / forever switch, days on', await ev('!!$("sGameDays") && document.querySelectorAll(".setkeep .seg").length === 2 && [...document.querySelectorAll(".setkeep .seg button.on")].every(b => b.dataset.v === "days")'));
await click('.setkeep .seg[data-keep="gameDays"] button[data-v="forever"]'); await p.sleep(600);
ok('forever keeps sessions without a question, and its days field goes', await ev('feed.gameDays === 0 && !cmodal.classList.contains("open") && !$("sGameDays") && document.querySelector(".setkeep .seg[data-keep=gameDays] button.on").dataset.v === "forever"'), await ev('[feed.gameDays, cmodal.className, !!$("sGameDays")]'));
await p.sleep(800);
ok('kept in the host\'s settings as forever (and 3650 days for an older version), a 400-day-old session stays in the log', /"gameForever":true/.test(text(join(data, 'settings.json'))) && /"gameDays":3650[,}]/.test(text(join(data, 'settings.json'))) && /Ancient Game/.test(text(join(data, 'games.log'))), text(join(data, 'settings.json')));
await click('.setkeep .seg[data-keep="gameDays"] button[data-v="days"]'); await p.sleep(450);
ok('days from forever asks nothing yet: an empty days field, in focus, still forever', await ev('!cmodal.classList.contains("open") && feed.gameDays === 0 && $("sGameDays") && $("sGameDays").value === "" && document.activeElement === $("sGameDays") && document.querySelector(".setkeep .seg[data-keep=gameDays] button.on").dataset.v === "days"'), await ev('[cmodal.className, feed.gameDays, !!$("sGameDays")]'));
await click('.setkeep .seg[data-keep="gameDays"] button[data-v="forever"]'); await p.sleep(300);
ok('forever again before a number: back as it was, nothing sent', await ev('feed.gameDays === 0 && !$("sGameDays") && !cmodal.classList.contains("open")') && /"gameForever":true/.test(text(join(data, 'settings.json'))));
await click('.setkeep .seg[data-keep="gameDays"] button[data-v="days"]'); await p.sleep(300);
await ev('$("sGameDays").blur(); 1'); await p.sleep(400);
ok('the days field left empty: forever again', await ev('feed.gameDays === 0 && !$("sGameDays") && document.querySelector(".setkeep .seg[data-keep=gameDays] button.on").dataset.v === "forever"'));
await click('.setkeep .seg[data-keep="gameDays"] button[data-v="days"]'); await p.sleep(300);
await setDays('sGameDays', 30); await p.sleep(450);
ok('a number typed: now it asks, at that many days (older ones would go)', await ev('cmodal.classList.contains("open") && /Keep sessions 30 days/.test($("ctitle").textContent) && feed.gameDays === 0'), await ev('$("ctitle").textContent'));
await click('#cno'); await p.sleep(300);
ok('Cancel: still forever, nothing deleted', await ev('feed.gameDays === 0 && !$("sGameDays")') && /Ancient Game/.test(text(join(data, 'games.log'))));
await click('.setkeep .seg[data-keep="gameDays"] button[data-v="days"]'); await p.sleep(300);
await setDays('sGameDays', 30); await p.sleep(450);
await click('#cyes');
ok('then the old one goes, kept in games.log.bak, and forever is off', await until('feed.gameDays === 30', 3000) && await (async () => { let t1 = Date.now(); while (/Ancient Game/.test(text(join(data, 'games.log'))) && Date.now() - t1 < 4000) await p.sleep(200); return !/Ancient Game/.test(text(join(data, 'games.log'))) && /Ancient Game/.test(text(join(data, 'games.log.bak'))); })() &&
  !/"gameForever"/.test(text(join(data, 'settings.json'))) && /"gameDays":30[,}]/.test(text(join(data, 'settings.json'))), text(join(data, 'settings.json')));
ok('and the days field is back, at 30', await ev('$("sGameDays") && $("sGameDays").value === "30"'));
await setDays('sGameDays', '0.4'); await p.sleep(300);
ok('a number that isn\'t whole days changes nothing', await ev('feed.gameDays === 30 && !cmodal.classList.contains("open") && $("sGameDays").value === "30"'));
await setDays('sWarnDays', 0); await p.sleep(600);
ok('0 typed in the days is forever too: the field goes', await ev('feed.warnDays === 0 && !$("sWarnDays") && document.querySelector(".setkeep .seg[data-keep=warnDays] button.on").dataset.v === "forever"'));
await ev('$("setmodal").classList.remove("open")');
await click('#logBtn');
const wtxt = () => ev('document.querySelector("#wmodal .mdesc").innerText');   // (shown text only)
ok('the warning history says it goes back to its first day', await until('!$("wall").hidden && $("wlast").hidden', 4000) && /curve, since \d{1,2} [a-z]{3}( \d{4})?\./.test(await wtxt()) && !/in the last/.test(await wtxt()), await wtxt());
await ev('$("wmodal").classList.remove("open")');
await host({ t: 'keep', games: 30, warns: 30 });
await ev('$("gmodal").classList.remove("open")');
// ---- a session over midnight: whole under the day it started in the list; the week strip splits it at midnight ----
const md = new Date(); md.setHours(0, 0, 0, 0); md.setDate(md.getDate() - 1); const M = Math.floor(md.getTime() / 1000);   // (yesterday's midnight)
const night = { game: 'Night Game', start: M - 3600, end: M + 5400, from: M - 3600, secs: 8400, front: 8400, fps: 140, low: 90, items: [], warns: 0, gaps: [[M + 1800, M + 2400]] };   // 23:00 to 01:30, a 10 minute break
writeFileSync(join(data, 'games.log'), JSON.stringify(night) + '\r\n');
await click('#gamesBtn');
await until('[...document.querySelectorAll("#glist .gx-gn")].some(x => x.textContent === "Night Game")', 5000);
const dk = back => ev(`(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ${back}); return localDay(d); })()`);
const k1 = await dk(1), k2 = await dk(2);
const heads = await ev('[...document.querySelectorAll("#glist .gx-day")].map(h => h.dataset.day + " " + h.querySelector(".gx-tot").textContent)');
ok('the list: one header, the day it started, with the whole session (2h 30m less a 10m break), no row for the day after', JSON.stringify(heads) === JSON.stringify([k2 + ' 1 session, ' + await ev('durS(8400)')]) && await ev('document.querySelectorAll("#glist .gx-sess").length === 1'), JSON.stringify(heads));
const wd = await ev('[...document.querySelectorAll("#gsum .gx-wd")].map(s => s.title)');
ok('the summary bar has no hover text of its own (no More, no Less: 11-02), its days\' hours are the page\'s tips', await ev('(() => { const r = document.querySelector("#gsum .gx-srow"); return !r.hasAttribute("data-tip") && !r.hasAttribute("title") && !document.querySelector("#gsum [title]") && [...document.querySelectorAll("#gsum .gx-wd")].every(s => s.hasAttribute("data-tip")); })()'));
ok('the week strip splits it too: 1h two days back, 1h 20m yesterday, nothing today', wd[4] === await ev('durTxt(3600)') && wd[5] === await ev('durTxt(4800)') && wd[6] === 'nothing', JSON.stringify(wd));
ok('and the week\'s played is the whole of it', new RegExp('played' + await ev('durTxt(8400)')).test(await T('#gsum')), await T('#gsum'));
await ev('$("gmodal").classList.remove("open")');
// ---- the summary bar opens: periods as far as Keep sessions goes, a game picked, the chart and its read-out ----
const mkS = (game, daysAgo, h) => { const s = at(daysAgo, 20, 0); return { game, start: s, end: s + h * 3600, from: s, secs: h * 3600, front: h * 3600, fps: 200, low: 100, items: [], warns: 0 }; };
writeFileSync(join(data, 'games.log'), [mkS('Alpha', 1, 2), mkS('Beta', 2, 1), mkS('Alpha', 3, 3), mkS('Gamma', 10, 1)].map(x => JSON.stringify(x)).join('\r\n') + '\r\n');
await host({ t: 'keep', games: 0, warns: 30 }); await until('feed.gameDays === 0', 3000);
await click('#gamesBtn'); await until('[...document.querySelectorAll("#glist .gx-gn")].some(x => x.textContent === "Gamma")', 5000);
ok('the summary bar starts shut: its row with its chevron, nothing under it', await ev('!!document.querySelector("#gsum .gx-srow > .gx-chev") && !GX.open && !document.querySelector("#gsum .gx-sum.open")'));
const row0 = await ev('document.querySelector("#gsum .gx-srow").innerHTML');
await click('#gsum .gx-srow');
ok('a click on its row opens what is under it, the row as it was (like a session)', await ev('GX.open && !!document.querySelector("#gsum .gx-sum.open")') && await ev('document.querySelector("#gsum .gx-srow").innerHTML') === row0);
ok('kept forever: 7, 30, 90 days and All, the periods on the left, the game list on the right (11-07)', await ev('[...document.querySelectorAll("#gsum .gx-per button")].map(b => b.textContent).join() === "7 days,30 days,90 days,All"') &&
  await ev('(() => { const h = document.querySelector("#gsum .gx-xh").getBoundingClientRect(), d = document.querySelector("#gsum .gx-dd").getBoundingClientRect(), s = document.querySelector("#gsum .gx-per").getBoundingClientRect(); return Math.abs(s.left - h.left) < 1 && Math.abs(h.right - d.right) < 1; })()'), await ev('[...document.querySelectorAll("#gsum .gx-per button")].map(b => b.textContent).join()'));
ok('no title or totals that the row already says', await ev('!document.querySelector("#gsum .gx-xt") && !document.querySelector("#gsum .gx-sdin .gx-sumtxt")'));
await ev('document.querySelector("#gsum .gx-per button[data-p=\\"30\\"]").click(); 1');
ok('a later period slides in from the right, like Tiles to Overview', await ev('document.querySelector("#gsum .gx-xb").getAnimations().some(a => /translateX\\(3%\\)/.test(JSON.stringify(a.effect.getKeyframes())))'));
await p.sleep(450);
ok('the period\'s pill glides under the one picked, exactly on it (11-07)', await ev('(() => { const i = document.querySelector("#gsum .gx-per .ind"), b = document.querySelector("#gsum .gx-per button.on"); const q = i.getBoundingClientRect(), r = b.getBoundingClientRect(); return b.dataset.p === "30" && Math.abs(q.left - r.left) < 0.3 && Math.abs(q.width - r.width) < 0.3; })()'), await ev('(() => { const q = document.querySelector("#gsum .gx-per .ind").getBoundingClientRect(), r = document.querySelector("#gsum .gx-per button.on").getBoundingClientRect(); return [q.left - r.left, q.width - r.width]; })()'));
await ev('document.querySelector("#gsum .gx-per button[data-p=\\"90\\"]").focus(); 1');
await p.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await p.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await p.sleep(300);
ok('picked from the keyboard: 90 days, and the focus stays on it', await ev('GX.period === 90 && document.activeElement.matches("#gsum .gx-per button[data-p=\\"90\\"]")'), await ev('[GX.period, document.activeElement.className, document.activeElement.textContent]'));
await ev('document.querySelector("#gsum .gx-per button[data-p=\\"30\\"]").click(); 1'); await p.sleep(450);
ok('30 days: a point a day on the line, centred in its box', await ev('document.querySelector("#gsum .gx-lcp polyline").getAttribute("points").split(" ").length === 30') &&
  await ev('(() => { const b = document.querySelector("#gsum .gx-sum").getBoundingClientRect(), q = document.querySelector("#gsum .gx-lcp").getBoundingClientRect(); return Math.abs((q.left - b.left) - (b.right - q.right)) < 2; })()'));
ok('each game\'s part of it, most played first', await ev('[...document.querySelectorAll("#gsum .gx-gr .gx-gnm")].map(x => x.textContent).join() === "Alpha,Beta,Gamma"'));
await click('#gsum .gx-dd');
ok('the game list has every game in the log', await ev('[...document.querySelectorAll("#gsum .gx-menu button")].map(b => b.dataset.game).join() === ",Alpha,Beta,Gamma"'));
// (it sits on the right: it opens under its button to the left, all of it inside the bar and none of it cut off, 11-07)
ok('the game list opens under its button, to the left, whole', await ev(`(() => { const m = document.querySelector('#gsum .gx-menu').getBoundingClientRect(), d = document.querySelector('#gsum .gx-dd').getBoundingClientRect(), b = document.querySelector('#gsum .gx-sum').getBoundingClientRect();
  const seen = [...document.querySelectorAll('#gsum .gx-menu button')].every(x => { const r = x.getBoundingClientRect(), e = document.elementFromPoint(r.left + 8, r.top + r.height / 2); return e && x.contains(e); });
  return Math.abs(m.right - d.right) < 2 && m.top >= d.bottom && m.left >= b.left && m.right <= b.right && seen; })()`), await ev(`JSON.stringify([document.querySelector('#gsum .gx-menu').getBoundingClientRect(), document.querySelector('#gsum .gx-dd').getBoundingClientRect(), document.querySelector('#gsum .gx-sum').getBoundingClientRect()])`));
await click('#gsum .gx-menu button[data-game="Beta"]');
ok('a game picked: the list shows only its sessions', await ev('document.querySelectorAll("#glist .gx-sess").length === 1 && document.querySelector("#glist .gx-gn").textContent === "Beta" && GX.game === "Beta"'));
const lp = await p.center('#gsum .gx-lcp'); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lp.x + lp.w / 2 - 2, y: lp.y }); await p.sleep(250);
ok('the pointer on the chart reads that day out (today: nothing played)', await ev('document.querySelector("#gsum .gx-lcp").classList.contains("hv") && /nothing played$/.test(document.querySelector("#gsum .gx-tip").textContent)'), await ev('document.querySelector("#gsum .gx-tip").textContent'));
await click('#gsum .gx-lc');
ok('a click in what opened leaves it open (only its row shuts it, like a session)', await ev('GX.open'));
await click('#gsum .gx-srow');
ok('shut again: all games in the list', await ev('!GX.open && GX.game === null && document.querySelectorAll("#glist .gx-sess").length === 4'));
await host({ t: 'keep', games: 8, warns: 30 }); await until('feed.gameDays === 8', 3000); await p.sleep(400);
await click('#gsum .gx-srow');
ok('Keep sessions 8 days: 7 days and 8 days', await ev('[...document.querySelectorAll("#gsum .gx-per button")].map(b => b.textContent).join() === "7 days,8 days"'), await ev('[...document.querySelectorAll("#gsum .gx-per button")].map(b => b.textContent).join()'));
await host({ t: 'keep', games: 5, warns: 30 }); await until('feed.gameDays === 5', 3000); await ev('gxSum(gxAll); 1'); await p.sleep(300);
ok('5 days: no switch, the game list alone on the right, the chart a point a day', await ev('(() => { const h = document.querySelector("#gsum .gx-xh").getBoundingClientRect(), d = document.querySelector("#gsum .gx-dd").getBoundingClientRect(); return !document.querySelector("#gsum .gx-per") && Math.abs(h.right - d.right) < 1 && document.querySelector("#gsum .gx-lcp polyline").getAttribute("points").split(" ").length === 5; })()'), await ev('[!!document.querySelector("#gsum .gx-per"), (document.querySelector("#gsum .gx-lcp polyline") || { getAttribute: () => "" }).getAttribute("points").split(" ").length]'));
await ev('gxSet({ open: false }); 1'); await p.sleep(450);   // (shut for real: opened in the same instant, nothing would slide)
// ---- quick clicks on the bar, one after another: each one opens or shuts it (a word picked by a double click used to
// hold it); text dragged over still holds it ----
const sumAt = await p.center('#gsum .gx-srow'), top0 = await ev('$("gsum").getBoundingClientRect().top');
const slides = () => ev('(() => { const b = document.querySelector("#gsum .gx-sdet"); return b.getAnimations().some(a => a.transitionProperty === "grid-template-rows"); })()');
await ev('gxSet({ open: true }); 1');
ok('opening slides it to its new height, like a session\'s details', await slides());
await p.sleep(450);
ok('opening the bar leaves it where it was (Sessions grows downward, a short list too)', Math.abs(await ev('$("gsum").getBoundingClientRect().top') - top0) < 1, top0 + ' vs ' + await ev('$("gsum").getBoundingClientRect().top'));
await ev('gxSet({ open: false }); 1');
ok('and shutting slides it back', await slides());
await ev(`(() => { S.motion = 'off'; applyMotion(); gxSet({ open: true }); return 1; })()`);
ok('Animations off: it opens at once', !(await slides()));
await ev(`(() => { gxSet({ open: false }); S.motion = undefined; applyMotion(); return 1; })()`); await p.sleep(450);
for (let n = 1; n <= 4; n++) { await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: sumAt.x - sumAt.w / 2 + 60, y: sumAt.y, button: 'left', clickCount: n }); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sumAt.x - sumAt.w / 2 + 60, y: sumAt.y, button: 'left', clickCount: n }); await p.sleep(60); }
ok('four quick clicks: open, shut, open, shut', await ev('!GX.open && getSelection().isCollapsed'), await ev('[GX.open, String(getSelection())]'));
for (let n = 1; n <= 3; n++) { await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: sumAt.x - sumAt.w / 2 + 60, y: sumAt.y, button: 'left', clickCount: n }); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sumAt.x - sumAt.w / 2 + 60, y: sumAt.y, button: 'left', clickCount: n }); await p.sleep(60); }
ok('three: open', await ev('GX.open'));
await ev('gxSet({ open: false }); 1');
ok('the page has no cards view or switch any more', await ev('!$("gview") && !document.querySelector("#glist .gx-card") && !$("glist").classList.contains("cards")'));
await host({ t: 'keep', games: 30, warns: 30 });
await ev('$("gmodal").classList.remove("open")');
ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
