// The browser demo (scripts\build-demo.ps1 builds it into dist\demo): served here on http://127.0.0.1:8767 (HWDECK_DEMO_PORT: another) and opened in a
// headless Edge (debug port 9260). The page runs on demo.js instead of the app: made-up readings, the demo layout,
// history and game reports, saving only in its tab, the PC-only things saying "in the app", nothing fetched from
// anywhere but its own server.
//   powershell -File scripts\build-demo.ps1; node test/e2e-demo.mjs
import { connect, checks } from './cdp.mjs';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(process.cwd(), 'dist', 'demo'), PORT = Number(process.env.HWDECK_DEMO_PORT) || 8767, DBG = 9260, URL0 = `http://127.0.0.1:${PORT}/`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer(async (req, res) => {
  const f = join(root, req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').split('?')[0]);
  try { const b = await readFile(f); res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream' }); res.end(b); } catch (e) { res.writeHead(404); res.end(); }
}).listen(PORT, '127.0.0.1');
const prof = await mkdtemp(join(tmpdir(), 'hwdeck-demo-'));
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + prof, '--window-size=1600,1000', '--no-first-run', '--disable-extensions', URL0], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { ok, done } = checks();
try {
  let p = null;
  for (let i = 0; i < 40 && !p; i++) { await sleep(250); try { p = await connect(DBG, '127.0.0.1:' + PORT); } catch (e) { } }
  if (!p) throw new Error('headless Edge did not open the demo');
  const E = x => p.evaluate(x);
  const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr).catch(() => false)) return true; await sleep(150); } return false; };
  const urls = [];
  p.on(m => { if (m.method === 'Network.requestWillBeSent') urls.push(m.params.request.url); });
  await p.cmd('Network.enable');
  await p.cmd('Page.reload'); await sleep(300);
  const errs = await p.errors();

  ok('the demo opens: readings arrive from demo.js, the page runs as in the app', await until('feed.got && READ.length > 40 && feed.fake === true', 10000), await E('READ.length').catch(() => 'none'));
  ok('on the demo layout, in view mode, on Overview', await E('S.L.cats.map(c => c.name).join() === "GPU,CPU,Fans,Game,Storage,Network,Memory,Board" && !S.edit && S.screen === "overview" && document.querySelectorAll("#view .dc").length >= 25'),
    await E('S.L.cats.map(c => c.name).join() + " " + S.edit + " " + S.screen'));
  ok('real-looking names, the HW Deck bottleneck among them', await E('["CPU (Tctl/Tdie)", "GPU Hot Spot Temperature", "Drive Temperature", "Framerate (1% low)", "Bottleneck"].every(l => READ.some(r => r.label === l)) && SENS.some(s => /RTX 4080/.test(s.name))'));
  const v0 = await E('BYKEY.get(S.L.cells.g4.key).v'); await sleep(2500);
  ok('the numbers move', (await E('BYKEY.get(S.L.cells.g4.key).v')) !== v0);
  ok('the graphs come with their last 15 minutes', await E('series(S.L.cells.g1.key, HLEN).filter(isFinite).length > 850'), await E('series(S.L.cells.g1.key, HLEN).filter(isFinite).length'));
  ok('a game runs, with its fps and what limits it', await until('feed.game !== null || BYKEY.get("hwdeck.0/bneck").v === null', 3000) && await E('typeof feed.game === "string" ? BYKEY.get("hwdeck.0/bneck").v >= 1 && BYKEY.get(S.L.cells.p1.key).v > 80 : true'),
    await E('[feed.game, BYKEY.get("hwdeck.0/bneck").v]'));
  ok('the window buttons and Restart HWiNFO are gone (no window, no HWiNFO here)', await E('["wmin", "wmax", "wclose", "rstBtn"].every(id => getComputedStyle($(id)).display === "none")'));
  ok('a bar says what this is, with the download link', await E('/HW Deck demo/.test($("demobar").textContent) && document.querySelector("#demobar a.dl").href === "https://github.com/RodrigoArsenioo/hwdeck/releases/latest"'));

  // ---- the popups: history, the bottleneck's ranges, game sessions, warnings ----
  await E('openDetail("g1")'); await sleep(300);
  await E('document.querySelector(\'#mrng button[data-r="7d"]\').click()');
  ok('7 days of history for a reading', await until('bigHist && bigHist.range === "7d" && bigHist.avg.length === 1008 && bigHist.avg.filter(x => x !== null).length > 900', 3000));
  await E('closeDetail(); openDetail("p3")'); await sleep(300);
  await E('document.querySelector(\'#mrng button[data-r="1h"]\').click()');
  ok('the bottleneck over an hour: each call\'s share and the game time', await until('/gpu\\d+%cpu\\d+%capped\\d+%game time\\d+m/.test($("mextra").querySelector(".mstats").textContent)', 3000), await E('$("mextra").textContent'));
  await E('closeDetail(); $("gamesBtn").click()');
  ok('game sessions from the last days, one with a warning', await until('document.querySelectorAll("#glist .gx-sess").length >= 3 && /1 warning/.test($("glist").textContent)', 3000), await E('document.querySelectorAll("#glist .gx-sess").length'));
  await E('$("gbinBtn").click()');
  ok('the bin: empty in the demo, and Back brings the sessions again', await until('/The bin is empty/.test($("glist").textContent)', 3000) && await E('(() => { document.querySelector("#gbar [data-pk=back]").click(); return 1; })()') && await until('document.querySelectorAll("#glist .gx-sess").length >= 3', 3000), await E('$("glist").textContent.slice(0, 80)'));
  ok('the game in progress on top, now playing, shut like the rest until clicked', await until('!feed.game || (() => { const r = document.querySelector("#glist .gx-sess"); return !!r && r.classList.contains("live") && !r.classList.contains("open") && /now playing/.test(r.textContent) && /to now/.test(r.textContent); })()', 4000),
    await E('[feed.game, (document.querySelector("#glist .gx-sess") || {}).className, ((document.querySelector("#glist .gx-sess") || {}).textContent || "").slice(0, 120)]'));
  ok('runs of the same game close together listed as one session, their breaks kept apart', await E('[...document.querySelectorAll("#glist .gx-sess:not(.live)")].some(r => /\\d+ breaks?/.test(r.textContent))'));
  await E('$("gmodal").classList.remove("open"); $("logBtn").click()');
  ok('the warning history has its lines', await until('/CPU temperature/.test($("wlist").textContent)', 3000));
  await E('$("wmodal").classList.remove("open")');

  // ---- PC-only things: a note, nothing done ----
  await E('send({ t: "restartHwinfo" })'); await sleep(200);
  ok('things that need the PC say they work in the app', /Works in the app/.test(await E('$("toast").textContent')), await E('$("toast").textContent'));

  // ---- saving: only in this tab ----
  await E('setEdit(true)'); await sleep(300);
  await E('mutate(() => { S.L.cats[0].name = "Mine"; })'); await sleep(800);
  ok('an edit is kept in this tab only (sessionStorage), nothing in the page\'s local storage but its fit sizes', await E('(sessionStorage.getItem("hwdeck-demo:state") || "").includes("Mine") && Object.keys(localStorage).every(k => k === "hwdeck.fit")'),
    await E('JSON.stringify(Object.keys(localStorage))'));
  await p.cmd('Page.reload'); await until('feed.got && S.L.cats.length > 0', 8000);
  ok('a reload in the same tab keeps it', await E('S.L.cats[0].name === "Mine"'));
  const tab = await (await fetch(`http://127.0.0.1:${DBG}/json/new?${URL0}`, { method: 'PUT' })).json();
  let q = null; for (let i = 0; i < 20 && !q; i++) { await sleep(250); q = await connect(DBG, tab.id).catch(() => null); }
  let fresh = null; for (let i = 0; q && i < 40 && !fresh; i++) { fresh = await q.evaluate('feed.got && S.L.cats[0] ? S.L.cats[0].name : null').catch(() => null); if (!fresh) await sleep(200); }
  ok('a new tab starts from the demo layout again', fresh === 'GPU', fresh);
  if (q) q.close(); await fetch(`http://127.0.0.1:${DBG}/json/close/${tab.id}`).catch(() => { });
  await E('document.getElementById("demoReset").click()'); await sleep(300); await until('feed.got && S.L.cats.length > 0', 8000);
  ok('Reset demo brings the demo layout back', await E('S.L.cats[0].name === "GPU" && !S.edit && !sessionStorage.getItem("hwdeck-demo:state")'));

  // round 2's fix 6 (11-07 audit): Saves, Settings, Sessions and Warning history take the focus, Escape gives it back
  await E('(setEdit(false), 1)').catch(() => {}); await sleep(300);
  for (const [btn, mod] of [['savesBtn', 'smodal'], ['setBtn', 'setmodal'], ['gamesBtn', 'gmodal'], ['logBtn', 'wmodal']]) {
    await E(`($('${btn}').focus(), $('${btn}').click(), 1)`); await sleep(600);
    const inside = await E(`$('${mod}').classList.contains('open') && $('${mod}').contains(document.activeElement)`);
    await p.key('Escape', 'Escape', 27); await sleep(600);
    const back = await E(`[$('${mod}').classList.contains('open'), document.activeElement && document.activeElement.id]`);
    ok(btn + ': its popup takes the focus, Escape closes it and gives the focus back', inside && !back[0] && back[1] === btn, [inside, back]);
  }
  // the popup's grow (2.4.5 the morph, his pick 11-09; since 11-10 without the cell's copy on top): a cell's popup grows
  // out of the cell and goes back into it. Turned around mid-way (closed while it grows, another cell or the same one
  // clicked while it closes, what opened it gone) it leaves no piece behind, a press on its box reaches the card, and
  // it opens clean after (the fresh review's findings, 11-09)
  {
    const click = async (x, y) => { await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); };
    await E(`(() => { document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); S.motion = 'full'; if (typeof applyMotion === 'function') applyMotion(); window.__prev = showPrev; showPrev = function () {};
      const b = [...document.querySelectorAll('nav#screens button')].find(b => b.textContent.trim() === 'Tiles'); if (b) b.click(); return 1; })()`);
    await sleep(1500);
    const tiles = JSON.parse(await E(`JSON.stringify([...document.querySelectorAll('#view .tile')].filter(t => { const b = t.getBoundingClientRect(); return b.top > 60 && b.bottom < innerHeight - 40 && t.querySelector('canvas'); }).slice(0, 6).map(t => { const b = t.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2), t.dataset.cid || '']; }))`));
    const A = tiles[0] || [0, 0, ''], B = tiles[tiles.length - 1] || A;
    const state = async () => JSON.parse(await E(`JSON.stringify((() => { const m = document.getElementById('modal'), c = m.querySelector(':scope > .mcard'); return { open: m.classList.contains('open'), zout: m.classList.contains('zout'), inert: !!m.inert, pieces: document.querySelectorAll('.pm-shell, .pm-ghost').length, pm: !!m._pm, src: m._src ? (m._src.dataset.cid || m._src.className) : null, anims: m.getAnimations({ subtree: true }).length, tf: getComputedStyle(c).transform, op: getComputedStyle(c).opacity, kid: c.firstElementChild ? getComputedStyle(c.firstElementChild).opacity : null, vis: getComputedStyle(m).visibility }; })())`));
    const settle = async () => { await sleep(900); return state(); };
    const closeBtn = () => E(`(() => { const b = document.querySelector('#modal .mclose'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const closeAll = async () => { await E(`(() => { document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); return 1; })()`); await sleep(900); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); };
    const clean = s => s.pieces === 0 && !s.pm && s.anims === 0;
    ok('popup morph: two tiles to click', tiles.length >= 2 && A[2] !== B[2], JSON.stringify(tiles));
    await click(A[0], A[1]); let s = await settle();
    ok('popup morph: open, the card as the page draws it, no pieces left', s.open && clean(s) && s.tf === 'none' && s.op === '1' && s.kid === '1' && s.src === A[2], JSON.stringify(s));
    let x = await closeBtn(); await click(x[0], x[1]); s = await settle();
    ok('popup morph: closed, hidden, no pieces left', !s.open && !s.zout && !s.inert && clean(s) && s.vis === 'hidden', JSON.stringify(s));
    // (11-10, his "i can almost see the small cell in the big pop up window": no picture of the cell rides on the box any
    // more. The box is empty while it grows, the content comes in at the end, and on the way home it goes first)
    await click(A[0], A[1]); await sleep(40);
    const emp = JSON.parse(await E(`JSON.stringify((() => { const m = document.getElementById('modal'), c = m.querySelector(':scope > .mcard'), as = m.getAnimations({ subtree: true });
      const at = t => { for (const a of as) { a.pause(); a.currentTime = t; } return [+getComputedStyle(c.firstElementChild).opacity, +getComputedStyle(c).opacity, document.querySelectorAll('.pm-shell').length, document.querySelectorAll('.pm-ghost').length, +(c.getBoundingClientRect().width / c.offsetWidth).toFixed(2)]; };
      const r = [at(PM_IN * 0.25), at(PM_IN * 0.95)]; for (const a of as) a.finish(); return r; })())`));
    ok('popup grow: a quarter of the way out the box is there and empty (no content, no picture of the cell), the content is in at the end', emp[0][0] === 0 && emp[0][1] === 1 && emp[0][2] === 1 && emp[0][3] === 0 && emp[0][4] > 0.3 && emp[1][0] > 0.99, JSON.stringify(emp));
    s = await settle(); let x0 = await closeBtn(); await click(x0[0], x0[1]); await sleep(40);
    const out = JSON.parse(await E(`JSON.stringify((() => { const m = document.getElementById('modal'), c = m.querySelector(':scope > .mcard'), as = m.getAnimations({ subtree: true });
      const at = t => { for (const a of as) { a.pause(); a.currentTime = t; } return [+getComputedStyle(c.firstElementChild).opacity, +getComputedStyle(c).opacity, +(c.getBoundingClientRect().width / c.offsetWidth).toFixed(2)]; };
      const r = [at(PM_OUT * 0.35), at(PM_OUT * 0.7)]; for (const a of as) a.finish(); return r; })())`));
    ok('popup grow: on the way home the content is gone a third of the way in, while the box is still over half its size; the box itself stays until it has landed', out[0][0] === 0 && out[0][1] === 1 && out[0][2] > 0.5 && out[1][1] === 1, JSON.stringify(out));
    await settle();
    await click(A[0], A[1]); await sleep(110);
    const hit = await E(`(() => { const g = document.querySelector('.pm-shell'); if (!g) return 'no box'; const r = g.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height, 60) / 2); return e && e.closest('.pm-shell') ? 'the box' : e && e.closest('#modal > .mcard') ? 'the card' : e ? e.tagName : 'nothing'; })()`);
    await p.key('Escape', 'Escape', 27); await sleep(60); const mid = await state(); s = await settle();
    ok('popup morph: while it grows a press on its box reaches the card, and Escape closes it from there', hit === 'the card' && !mid.open && !s.open && clean(s) && s.vis === 'hidden', hit + ' ' + JSON.stringify(s));
    await click(A[0], A[1]); await settle(); x = await closeBtn(); await click(x[0], x[1]); await sleep(90);
    await click(B[0], B[1]); await sleep(60); const midB = await state(); s = await settle();
    ok('popup morph: another cell clicked while the popup closes: it opens from that cell', s.open && s.src === B[2] && midB.src === B[2] && clean(s) && s.tf === 'none' && s.kid === '1', midB.src + ' ' + JSON.stringify(s));
    await closeAll();
    await click(A[0], A[1]); await settle(); x = await closeBtn(); await click(x[0], x[1]); await sleep(90);
    await click(A[0], A[1]); s = await settle();
    ok('popup morph: the same cell clicked again while its popup closes: open again, clean', s.open && s.src === A[2] && clean(s) && s.tf === 'none' && s.kid === '1' && s.op === '1', JSON.stringify(s));
    await closeAll();
    await click(A[0], A[1]); await sleep(100);
    await E(`(() => { const m = document.getElementById('modal'); m._src = document.createElement('div'); m._srcKey = null; return 1; })()`);
    await p.key('Escape', 'Escape', 27); await sleep(50);
    const at = JSON.parse(await E(`JSON.stringify((() => { const r = document.querySelector('#modal > .mcard').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), innerWidth, innerHeight]; })())`));
    s = await settle();
    ok('popup morph: what opened it gone while it grows, then Escape: it fades where it is, clean after', !s.open && clean(s) && s.vis === 'hidden' && at[0] > -50 && at[1] > -50 && at[0] < at[2] && at[1] < at[3], JSON.stringify(at) + ' ' + JSON.stringify(s));
    for (let i = 0; i < 6; i++) { await click(A[0], A[1]); await sleep(70); await p.key('Escape', 'Escape', 27); await sleep(70); }
    s = await settle();
    ok('popup morph: six quick opens and closes: hidden, no pieces left', !s.open && !s.zout && !s.inert && clean(s), JSON.stringify(s));
    await click(A[0], A[1]); s = await settle();
    ok('popup morph: and it opens clean after', s.open && clean(s) && s.tf === 'none' && s.kid === '1', JSON.stringify(s));
    await closeAll();
    await E(`(() => { if (window.__prev) showPrev = window.__prev; return 1; })()`);
  }
  // (2.4.8) the internet: its cell under Fans in Overview, its speed test on with made-up results, Test now plays a
  // made-up test of about 15 s (nothing is sent: the check above covers every request)
  {
    await E(`(() => { showScreen('overview'); return 1; })()`); await sleep(1500);
    const cid = await E(`Object.keys(S.L.cells).find(id => S.L.cells[id].key === NETD) || ''`);
    ok('internet: the demo has the Internet cell, in Overview, download and upload', !!cid && await E(`(() => { const e = document.querySelector('#view .dc[data-cid="${cid}"]'); return !!e && (e.innerText.match(/Mbit.s/g) || []).length >= 2; })()`), cid);
    await E(`(() => { openDetail(${JSON.stringify(cid)}); return 1; })()`); await sleep(1500);
    const P = () => E(`JSON.stringify((() => { const x = document.querySelector('#mextra .xn-st'), b = x && x.querySelector('[data-net]'); return { st: !!x, btn: b && b.textContent.trim(), boxes: x ? [...x.querySelectorAll('.xn-box3 b')].map(e => e.textContent) : [], rows: [...document.querySelectorAll('#mextra .xn-tests .wrow')].map(e => [...e.children].map(c => c.textContent.trim()).join('|')) }; })())`).then(JSON.parse);
    let q = await P();
    ok('internet: its popup shows the speed test on, made-up results and the list', q.st && q.btn === 'Test now' && q.boxes[0] === '9ms' && q.boxes[1] === '938Mbit/s' && q.rows.length >= 3, JSON.stringify(q));
    await E(`(() => { document.querySelector('#mextra [data-net="test"]').click(); return 1; })()`);
    await sleep(3000); q = await P();
    ok('internet: Test now plays a made-up test', q.btn === 'Testing' && /running/.test(q.rows[0] || ''), JSON.stringify(q));
    await sleep(14500); q = await P();
    ok('internet: and ends with a new result on top', q.btn === 'Test now' && /^today \d\d:\d\d\|Frankfurt\|8ms\|\d+Mbit\/s\|\d+Mbit\/s$/.test(q.rows[0] || ''), JSON.stringify(q));
    await E(`(() => { document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); return 1; })()`); await sleep(900);
  }
  ok('nothing fetched from anywhere but its own server', urls.length > 0 && urls.every(u => u.startsWith(URL0) || u.startsWith('data:') || u.startsWith('blob:')), urls.filter(u => !u.startsWith(URL0)).join(' '));
  ok('no page errors', errs.length === 0, errs.join(' | '));
} catch (e) { ok('the run gets to its end', false, e.message); }
finally {
  // the throwaway Edge profile goes, after a failure too. Edge's helper processes hold its files for a moment after the kill
  // (EPERM on Windows), so rm retries for up to ~11 s; it has to finish before process.exit
  try { edge.kill(); } catch (e) { }
  server.close();
  await sleep(800);
  await rm(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(e => console.log('the Edge profile stays in ' + prof + ': ' + e.message));
}
console.log(done() ? 'ALL PASS' : 'SOME FAILED'); process.exit(0);
