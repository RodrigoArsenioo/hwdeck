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
  ok('on the demo layout, in view mode, on Overview', await E('S.L.cats.map(c => c.name).join() === "GPU,CPU,Fans,Game,Storage,Memory,Board" && !S.edit && S.screen === "overview" && document.querySelectorAll("#view .dc").length >= 25'),
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
  ok('the game in progress on top, now playing, open as the newest', await until('!feed.game || (() => { const r = document.querySelector("#glist .gx-sess"); return !!r && r.classList.contains("live") && r.classList.contains("open") && /now playing/.test(r.textContent) && /to now/.test(r.textContent); })()', 4000),
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
