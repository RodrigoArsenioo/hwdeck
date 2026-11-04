// Sessions from before 2.0.1, their bottleneck re-estimated once at the start (2.1, Games.ReestimateFiles): the data
// folder gets old session lines first (seed), then the app starts on it and this checks the files and the popup.
//   node test/e2e-reest.mjs seed test\data-re
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9237
//   HWDeck.exe --fake 300 --data test\data-re
// then: node test/e2e-reest.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const RULE = 1793739000;   // 2.0.1 out (Games.PaceRuleSince)
// a session line as Games.Line writes it: per minute [gpu, cpu, capped] seconds and the average fps
function sess(game, start, mins, fps, extra = {}) {
  const tc = mins, tf = fps, tl = fps.map(v => v === null ? null : Math.round(v / 2));
  const sum = k => tc.reduce((a, m) => a + (m ? m[k] : 0), 0), front = sum(0) + sum(1) + sum(2);
  const tb = tc.map(m => !m ? '-' : m[1] >= m[0] && m[1] >= m[2] ? 'c' : m[0] >= m[2] ? 'g' : 'f').join('');
  return JSON.stringify(Object.assign({ game, start, end: start + tc.length * 60, from: start, secs: tc.length * 60, front, fps: 250, low: 120,
    items: [['GPU temp', '°C', 61.125, 70.25, null, null, 1, null, 0, 'e0002000.0/01000000', 0]], warns: 0,
    g: sum(0), c: sum(1), f: sum(2), wl: [], tf, tl, tb, tc, p: 3 }, extra));
}
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const old = RULE - 2 * 86400;
const L = {
  uncapped: sess('Old Uncapped', old, range(40, () => [0, 10, 50]), range(40, i => 250 + (i * 37) % 200)),
  capped: sess('Old Capped', old + 4 * 3600, range(40, () => [0, 4, 56]), range(40, i => 236 + i % 3)),
  fresh: sess('Since 2.0.1', RULE + 3 * 3600, range(20, () => [0, 0, 60]), range(20, i => 300 + i * 9)),   // (fixed times: the seed and the checks build the same lines)
  // played on 2.0.0 after 2.0.1 came out, before this folder first ran 2.0.1 (its app.log, seeded below): the old call
  late: sess('Late On 2.0.0', RULE + 600, range(20, () => [0, 10, 50]), range(20, i => 260 + (i * 31) % 180)),
  ancient: JSON.stringify({ game: 'From 1.0.0', start: old - 86400, end: old - 86400 + 1800, secs: 1800, fps: 144, low: 90, items: [] }),
  binned: sess('Old In The Bin', old + 8 * 3600, range(30, () => [5, 15, 40]), range(30, i => 300 + (i * 23) % 150)),
};
const seedLog = [L.uncapped, L.late, L.capped, L.fresh, L.ancient].join('\r\n') + '\r\n', seedBin = L.binned + '\r\n';
const START201 = RULE + 2 * 3600;   // (this folder's first start of 2.0.1, in its app.log)
const stamp = u => new Date(u * 1000).toISOString().replace('T', ' ').slice(0, 19) + '+00:00';

if (process.argv[2] === 'seed') {
  const dir = process.argv[3]; mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'games.log'), seedLog); writeFileSync(join(dir, 'games.log.bak'), seedBin);
  writeFileSync(join(dir, 'app.log'), stamp(RULE - 86400) + '  start 2.0.0 (pid 1, data ' + dir + ')\r\n' + stamp(START201) + '  start 2.0.1 (pid 2, data ' + dir + ')\r\n');
  console.log('seeded ' + dir); process.exit(0);
}

const port = Number(process.argv[2] || 9237);
const data = process.argv[3] || 'test/data-re';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const text = f => existsSync(f) ? readFileSync(f, 'utf8') : '';
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(500); };
const lines = f => text(f).split(/\r?\n/).filter(Boolean);
const byGame = (f, g) => lines(f).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).find(x => x && x.game === g);

ok('catalog arrives', await until('READ.length > 200 && feed.got'));
await ev(`send({ t: 'fakeGame', game: null })`);

// ---- the files ----
const log = join(data, 'games.log'), bin = join(data, 'games.log.bak'), app = text(join(data, 'app.log'));
ok('app.log says what it did, for the log and the bin', /games\.log: 2 sessions from before 2\.0\.1 re-estimated \(3000 s that read capped are CPU bound now\); as it was: games\.log\.before-2\.1/.test(app) && /games\.log\.bak: 1 session from before 2\.0\.1 re-estimated \(1200 s/.test(app), app.split('\n').filter(l => /re-estimated|not re-estimated/.test(l)).join(' | '));
ok('a copy of each as it was, beside it', text(log + '.before-2.1') === seedLog && text(bin + '.before-2.1') === seedBin);
const u = byGame(log, 'Old Uncapped') || {};
ok('the old uncapped session: its capped seconds CPU bound, marked', u.f === 0 && u.c === 2400 && u.g === 0 && u.est === 2000 && u.tb === 'c'.repeat(40), JSON.stringify({ g: u.g, c: u.c, f: u.f, est: u.est }));
ok('the old capped one (fps held at 236 to 238), the one since 2.0.1 and the one from 1.0.0: as they were', lines(log)[2] === L.capped && lines(log)[3] === L.fresh && lines(log)[4] === L.ancient);
const lt = byGame(log, 'Late On 2.0.0') || {};
ok('played on 2.0.0 after 2.0.1 came out, before this folder ran 2.0.1: re-estimated too', lt.est === 1000 && lt.f === 0, JSON.stringify({ c: lt.c, f: lt.f, est: lt.est }));
const st = JSON.parse(text(join(data, 'settings.json')).replace(/^\uFEFF/, '') || '{}');
ok('settings: done, and the cutoff it went by (the folder\'s first 2.0.1 start)', st.estDone === true && st.estBefore === START201, JSON.stringify({ estDone: st.estDone, estBefore: st.estBefore, want: START201 }));
const b = byGame(bin, 'Old In The Bin') || {};
ok('the bin\'s old session too', b.est === 1200 && b.f === 0 && b.c === 1650 && b.g === 150, JSON.stringify({ g: b.g, c: b.c, f: b.f, est: b.est }));

// ---- the note: once, with how many changed (here 2 in the log and 1 in the bin); its X and it's gone for good ----
ok('the note shows: game sessions updated, how many, why', await until('$("estNotice").classList.contains("show")', 6000) && await ev('$("estNotice").querySelector("b").textContent') === 'Game sessions updated' &&
  /^HW Deck worked out the bottleneck of 3 game sessions from before 2\.0\.1 again\. Back then a GPU that wasn't busy read as "FPS capped"\. Now only minutes whose fps held steady stay capped, and the rest count as CPU bound\.$/.test(await ev('$("estTxt").textContent')), await ev('$("estTxt").textContent'));
ok('settings keep the count until then', JSON.parse(text(join(data, 'settings.json')).replace(/^\uFEFF/, '') || '{}').estNote === 3);
await click('#estClose');
ok('its X: gone', await until('!$("estNotice").classList.contains("show")', 3000));
let t0 = Date.now(); while (Date.now() - t0 < 4000 && JSON.parse(text(join(data, 'settings.json')).replace(/^\uFEFF/, '') || '{}').estNote !== undefined) await p.sleep(200);
ok('and the host forgets it', JSON.parse(text(join(data, 'settings.json')).replace(/^\uFEFF/, '') || '{}').estNote === undefined);
await ev('location.reload()'); await p.sleep(2500);
ok('the page again (a reload): no note', await until('feed.got', 8000) && await ev('!$("estNotice").classList.contains("show") && feed.estNote === 0'));

// ---- the sessions: their new numbers, no note on them ----
await click('#gamesBtn');
ok('the sessions list shows', await until('$("gmodal").classList.contains("open") && document.querySelectorAll("#glist .gx-sess").length >= 4', 6000));
const row = g => `[...document.querySelectorAll('#glist .gx-sess')].find(s => s.querySelector('.gx-gn') && s.querySelector('.gx-gn').textContent === ${JSON.stringify(g)})`;
const lb = g => ev(`(() => { const s = ${row(g)}; if (!s) return null; const c = s.querySelector('.gx-lb'); return [c.textContent, c.dataset.tip || '']; })()`);
const ru = await lb('Old Uncapped'), rc = await lb('Old Capped');
ok('the re-estimated one: cpu-bound 100%, no hover of its own', !!ru && /cpu-bound 100%/.test(ru[0]) && ru[1] === '', JSON.stringify(ru));
ok('the capped one: capped', !!rc && /capped 9\d%/.test(rc[0]), JSON.stringify(rc));
await ev(`${row('Old Uncapped')}.querySelector('.gx-row').click()`); await p.sleep(700);
ok('opened: limited by, cpu 100%, no note in it', await ev(`(() => { const s = ${row('Old Uncapped')}; const w = s.querySelector('.gx-s5 .w2'); return !!w && w.querySelector('em').textContent === 'limited by' && /cpu 100%/.test(w.textContent); })()`));
await click('#gbinBtn');
ok('the bin: its old session re-estimated too', await until(`(() => { const s = ${row('Old In The Bin')}; return !!s && /cpu-bound/.test(s.querySelector('.gx-lb').textContent); })()`, 6000));
await ev('$("gmodal").classList.remove("open")');

ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
