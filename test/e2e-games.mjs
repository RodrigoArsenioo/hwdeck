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
ok('a row: name, times, length and time in front, fps, 1% low, what limited it, warnings', /Marvel Rivals\d\d:\d\d to \d\d:\d\d1h 28m1h 05m in front16172cpu-bound 60%1 warningGPU power 583 W/.test(await row(0)), await row(0));
ok('the newest session opens with the popup, the others stay shut', await ev('(() => { const s = [...document.querySelectorAll("#glist .gx-sess")]; return s[0].classList.contains("open") && !s[1].classList.contains("open"); })()'));
const det = '#glist .gx-sess.open .gx-det';
const grp = () => ev(`[...document.querySelectorAll("${det} .gx-grp")].map(c => c.querySelector(".gx-ch").firstChild.textContent + ": " + [...c.querySelectorAll(".gx-rw")].map(r => r.textContent).join(" | "))`);
const rr = await grp();
ok('its readings in the three default categories, avg and max', rr.length === 3 && rr[0] === 'Temperatures: GPU64.070.6°C | GPU hotspot72.379.4°C | GPU memory71.078.0°C | CPU58.466.1°C' &&
  rr[1] === 'Power and load: GPU power314447W | GPU usage7799% | CPU power84.6121.9W | CPU usage71100%' && rr[2] === 'Memory: VRAMof 3214.8GB | RAMof 6443.5GB', rr);
ok('a summary on top: fps and 1% low, played and in front, the hottest, the split, the warnings', /^average fps1611% low 72played1h 28m1h 05m in fronthottest79\.4°CGPU hotspotlimited bygpu 36%cpu 60%capped 4%warnings1GPU power 583 W$/.test(await T(det + ' .gx-s5')), await T(det + ' .gx-s5'));
const rw = l => `[...document.querySelectorAll("${det} .gx-rw")].find(x => x.querySelector(".n").textContent === ${JSON.stringify(l)})`;
ok('the yellow and the red line as ticks where a reading has them, the max coloured by the lines it passed', await ev(`(() => { const f = l => [...document.querySelectorAll("${det} .gx-rw")].find(x => x.querySelector(".n").textContent === l);
  return !!f("GPU").querySelector(".ty") && !!f("GPU").querySelector(".tr") && !f("GPU memory").querySelector(".t") && f("GPU power").querySelector("span.m").className === "m y" && f("GPU").querySelector("span.m").className === "m"; })()`));
ok('a bar runs a little past its red line, so a max beyond it shows (power: 447 W, red 600)', await ev(`(() => { const r = ${rw('GPU power')}, t = r.querySelector(".tr"), m = r.querySelector(".gx-mb .m"); return Math.abs(parseFloat(t.style.left) - 89.3) < 0.2 && Math.abs(parseFloat(m.style.left) + parseFloat(m.style.width) - 66.5) < 0.2; })()`),
  await ev(`${rw('GPU power')}.querySelector(".gx-mb").innerHTML`));
ok('VRAM against the card\'s memory (used + free)', await ev(`Math.abs(parseFloat(${rw('VRAM')}.querySelector(".gx-mb .m").style.width) - 46.5) < 0.2`));
ok('a line that warns below is only a tick (a fan)', await ev(`(() => { const d = document.createElement('div'); d.innerHTML = gxItemRow({ n: 'Rear fan', u: 'RPM', a: 1200, m: 1450, y: 500, r: null, hi: null, below: true }, 'Rear fan', null); return !!d.querySelector('.ty') && d.querySelector('span.m').className === 'm'; })()`));
ok('a key under the readings: average, max, the yellow and the red line', /averagemaxyellow linered line/.test(await T(det + ' .gx-key')), await T(det + ' .gx-key'));
ok('the timeline: fps and its 1% low as lines, the band between, a gap while not in front', await ev(`(() => { const s = document.querySelector("${det} .gx-fpsc"); return !!s && s.querySelectorAll("polyline.fp").length === 2 && s.querySelectorAll("polyline.lo").length === 2 && s.querySelectorAll("polygon").length === 2; })()`), await ev(`document.querySelector("${det} .gx-tl") && document.querySelector("${det} .gx-tl").textContent`));
ok('the fps chart is tall, with round numbers along its side', await ev(`(() => { const s = document.querySelector("${det} .gx-fpsc"), y = [...document.querySelectorAll("${det} .gx-yax span")].map(x => +x.textContent); return s.getBoundingClientRect().height >= 130 && y.length >= 3 && y.length <= 7 && y.every((v, i) => !i || v > y[i - 1]) && y[0] <= 70 && y[y.length - 1] >= 180; })()`),
  await ev(`[...document.querySelectorAll("${det} .gx-yax span")].map(x => x.textContent)`));
ok('what limited it, minute by minute, and the split', await ev(`document.querySelectorAll("${det} .gx-bnc rect").length > 60`) && /^fps1% lowgpu-bound 36%cpu-bound 60%capped 4%not in front 23m$/.test(await T(det + ' .gx-leg')), await T(det + ' .gx-leg'));
// minute 12: 15 s gpu-bound, 40 s cpu-bound, 5 s capped, stacked in that order from the bottom; minute 3 has only its call
const colOf = m => ev(`[...document.querySelectorAll("${det} .gx-bnc rect")].filter(r => Math.abs(+r.getAttribute("x") - ${m * 10} - 0.8) < 0.01).map(r => r.getAttribute("class") + ":" + (+r.getAttribute("height")).toFixed(1) + "@" + (+r.getAttribute("y")).toFixed(1)).join()`);
ok('each minute shows its share of each call (gpu, cpu, capped from the bottom)', await colOf(12) === 'b-gpu:10.0@30.0,b-cpu:26.7@3.3,b-cap:3.3@0.0', await colOf(12));
ok('a minute with only its main call (an older session) shows that call alone', await colOf(3) === 'b-cpu:40.0@0.0', await colOf(3));
ok('minutes not in front stay empty', await colOf(40) === '', await colOf(40));
ok('the calls have their own colours (not yellow or red), the same in the legend', await ev(`(() => { const f = c => getComputedStyle(document.querySelector("${det} .gx-bnc rect." + c)).fill, b = c => getComputedStyle(document.querySelector("${det} .gx-leg b." + c)).backgroundColor;
  const fs = ['b-gpu', 'b-cpu', 'b-cap'].map(f); return new Set(fs).size === 3 && ['b-gpu', 'b-cpu', 'b-cap'].every(c => f(c) === b(c)) && !fs.some(x => /230, 200, 74|229, 72, 77/.test(x)); })()`),
  await ev(`['b-gpu', 'b-cpu', 'b-cap'].map(c => getComputedStyle(document.querySelector("${det} .gx-bnc rect." + c)).fill)`));
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
ok('over a gap: not in front', tip === hhmm(s1 + 40 * 60) + 'not in front', tip);
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
ok('a session that recorded nothing says so', await ev(`(() => { renderGames(JSON.stringify({ game: 'Bare', start: ${now - 7200}, end: ${now - 3600}, from: ${now - 7200}, secs: 3600, front: 3600, fps: null, low: null, items: [], warns: 0 })); return document.querySelector("#glist .gx-sess.open .gx-nil").textContent === "no readings were recorded for this session" && document.querySelector("#glist .gx-row").textContent.includes("----"); })()`));
ok('a session of your own under 2 minutes says when its chart starts', await ev(`(() => { renderGames(JSON.stringify({ game: 'Quick', custom: 1, start: ${now - 600}, end: ${now - 570}, from: ${now - 600}, secs: 30, front: 0, fps: 150, low: 100, items: [['GPU temp', '°C', 50, 55, null, null, 1, null, 0]], warns: 0, g: 30, c: 0, f: 0, tf: [150], tl: [100], tb: 'g', tc: [[30, 0, 0]] })); const d = document.querySelector('#glist .gx-sess.open'); return /^Quick/.test(d.querySelector('.gx-gm').textContent) && /30s/.test(d.querySelector('.gx-row').textContent) && /chart starts once a session has run for 2 minutes/.test(d.querySelector('.gx-tln').textContent) && !!d.querySelector('.gx-in .gx-acts .gx-nm'); })()`));

// ---- the card: 1000 px (room for three categories side by side), and a thin scrollbar when it is taller than the window ----
ok('the popup is 1000 px wide and its card shows a thin scrollbar', await ev('(() => { const c = document.querySelector("#gmodal .mcard"), s = getComputedStyle(c); return Math.abs(c.getBoundingClientRect().width - Math.min(1000, innerWidth * 0.94)) < 1 && s.scrollbarWidth === "thin" && s.scrollbarColor.startsWith("rgb(52, 52, 52)") && s.overflowY === "auto"; })()'),
  await ev('(() => { const c = document.querySelector("#gmodal .mcard"), s = getComputedStyle(c); return c.getBoundingClientRect().width + " " + s.scrollbarWidth + " " + s.scrollbarColor; })()'));

// ---- Customize: categories and their readings, like the main layout's; kept in the layout ----
await ev(`renderGames(${JSON.stringify(JSON.stringify(full))})`); await p.sleep(300);
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
ok('Start session records one: on top with its name, its time, Stop', await until('feed.rec.length === 1 && !$("grun").hidden && document.querySelector("#grun .gx-rn").value === "Session 1" && /^0:0\\d$/.test(document.querySelector("#grun .gx-rt").textContent)', 5000),
  await ev('[JSON.stringify(feed.rec), $("grun").textContent]'));
const own = await ev('feed.rec[0][0]');
ok('the title bar dot says something records', await ev('$("gameDot").classList.contains("on") && /recording Session 1/.test($("gamesBtn").title)'), await ev('$("gamesBtn").title'));
await ev('(() => { const i = document.querySelector("#grun .gx-rn"); i.value = "Bench run"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()');
ok('its name can be changed while it runs', await until('feed.rec[0][1] === "Bench run"', 4000), await ev('JSON.stringify(feed.rec)'));
await p.sleep(2200); await click('#grec');   // (a second Start within 2 s is a double click: nothing)
ok('a second one runs beside it', await until('feed.rec.length === 2 && document.querySelectorAll("#grun .gx-rec").length === 2 && feed.rec[1][1] === "Session 1"', 5000), await ev('JSON.stringify(feed.rec)'));
await ev('document.querySelectorAll("#grun [data-rec=stop]")[1].click()');
ok('one stopped under 10 seconds is not kept', await until('feed.rec.length === 1 && document.querySelectorAll("#grun .gx-rec").length === 1', 5000) && await until('/Under 10 seconds/.test($("toastTxt").textContent)', 3000) && !/Session 1/.test(text(join(data, 'games.log'))),
  await ev('$("toastTxt").textContent'));
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
ok('its main readings, found by their HWiNFO names, marked as main', ['CPU temp', 'GPU temp', 'GPU hotspot', 'GPU memory', 'CPU power', 'GPU power', 'GPU usage', 'CPU usage', 'VRAM', 'RAM'].every(n => item(n) && item(n).length === 10 && item(n)[6] === 1 && typeof item(n)[9] === 'string'),
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
ok('the popup shows it on top, open, with its warning and the timeline', await ev('(() => { const s = document.querySelector("#glist .gx-sess"); return s.classList.contains("open") && s.querySelector(".gx-gn").textContent === "Bench Game" && /2 warningsHot CPU 91\\.5 °C/.test(s.querySelector(".gx-st").textContent) && !!s.querySelector(".gx-fpsc polyline") && !!s.querySelector(".gx-bnc rect"); })()'),
  await ev('document.querySelector("#glist .gx-sess").textContent.slice(0, 300)'));
ok('its CPU row shows both lines and a red max', await ev('(() => { const r = [...document.querySelectorAll("#glist .gx-sess.open .gx-rw")].find(x => x.querySelector(".n").textContent === "CPU"); return !!r && !!r.querySelector(".ty") && !!r.querySelector(".tr") && r.querySelector("span.m").className === "m r"; })()'));
ok('and the tracked reading has its row, with a value', await ev('(() => { const r = [...document.querySelectorAll("#glist .gx-sess.open .gx-grp")][0].querySelectorAll(".gx-rw"); const last = r[r.length - 1]; return !last.classList.contains("nil") && /\\d/.test(last.querySelector("span.m").textContent); })()'),
  await ev('[...document.querySelectorAll("#glist .gx-sess.open .gx-grp")][0].textContent'));
const sess = n => `[...document.querySelectorAll("#glist .gx-sess")].find(s => s.querySelector(".gx-gn").textContent === ${JSON.stringify(n)})`;
ok('yours is in the list like a game\'s (no tag), started by you', await until(`!!${sess('Bench run')}`, 4000) && await ev(`${sess('Bench run')}.classList.contains('cust') && /^Bench run\\d\\d:\\d\\d to \\d\\d:\\d\\d, started by you/.test(${sess('Bench run')}.querySelector('.gx-gm').textContent) && getComputedStyle(${sess('Bench run')}.querySelector('.gx-gn'), '::after').content === 'none'`),
  await ev(`${sess('Bench run')} && ${sess('Bench run')}.querySelector('.gx-row').textContent`));
ok('the week\'s numbers are games\' only (3: Marvel Rivals, Old Game, Bench Game; yours not)', /last 7 days\s*3\s*sessions/.test(await T('#gsum')), await T('#gsum'));
await ev(`(() => { const s = ${sess('Bench run')}; if (!s.classList.contains('open')) s.querySelector('.gx-row').click(); return 1; })()`); await p.sleep(400);
ok('its summary: how long it ran, from when to when, its fps and what limited it', /^length\d+m\d\d:\d\d to \d\d:\d\d$/.test(await ev(`${sess('Bench run')}.querySelector('.gx-s5 > div:nth-child(2)').textContent`)) &&
  /^average fps\d+/.test(await ev(`${sess('Bench run')}.querySelector('.gx-s5 > div:nth-child(1)').textContent`)) && /gpu \d+%/.test(await ev(`${sess('Bench run')}.querySelector('.gx-s5').textContent`)),
  await ev(`${sess('Bench run')}.querySelector('.gx-s5').textContent`));
ok('and the same charts as a game\'s: fps and what limited it, minute by minute', await ev(`!!${sess('Bench run')}.querySelector('.gx-fpsc polyline') && ${sess('Bench run')}.querySelectorAll('.gx-bnc rect').length >= 2`));
ok('its name and Delete sit inside the details, clear of the card\'s edges', await ev(`(() => { const s = ${sess('Bench run')}, a = s.querySelector('.gx-in .gx-acts'), c = s.getBoundingClientRect(); if (!a) return false; const n = a.querySelector('.gx-nmf').getBoundingClientRect(), d = a.querySelector('.gx-del').getBoundingClientRect(); return n.left - c.left >= 30 && c.right - d.right >= 10; })()`));
await ev(`(() => { const i = ${sess('Bench run')}.querySelector('.gx-nm'); i.value = 'Renamed run'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
ok('a session of yours takes a new name, in the log too', await until(`!!${sess('Renamed run')}`, 5000) && !!text(join(data, 'games.log')).match(/"game":"Renamed run"[^\n]*"custom":1/), text(join(data, 'games.log')).slice(-200));
ok('a game session has no name field, only Delete', await ev(`!${sess('Bench Game')}.querySelector('.gx-nm') && !!${sess('Bench Game')}.querySelector('.gx-del')`));
await ev(`(() => { const s = ${sess('Renamed run')}; if (!s.classList.contains('open')) s.querySelector('.gx-row').click(); s.querySelector('.gx-del').click(); return 1; })()`); await p.sleep(300);
ok('Delete asks first', await ev('cmodal.classList.contains("open") && /Delete this session/.test($("ctitle").textContent)'), await ev('$("ctitle").textContent'));
await click('#cyes');
ok('one session deleted: out of the list and the log, kept in games.log.bak', await until(`!${sess('Renamed run')}`, 5000) && !/Renamed run/.test(text(join(data, 'games.log'))) && /Renamed run/.test(text(join(data, 'games.log.bak'))) && /Bench Game/.test(text(join(data, 'games.log'))),
  text(join(data, 'games.log')).slice(0, 200));
// ---- how long the logs keep what they have (Settings, 30 days unless changed) ----
ok('the host says how many days the logs keep (30 by default)', await ev('feed.gameDays === 30 && feed.warnDays === 30'), await ev('[feed.gameDays, feed.warnDays]'));
await ev('$("gmodal").classList.remove("open")');
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
await host({ t: 'keep', games: 30, warns: 30 });
await ev('$("gmodal").classList.remove("open")');
ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
