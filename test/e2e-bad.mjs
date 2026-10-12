// A working view that can't be read (run-all.ps1 writes a broken state.json into test\data-bad first): it is kept
// aside, the page starts empty and says where the old file went. And a settings.json that can't be read (with a
// 40-day-old session and warning in the logs): kept aside, the days unknown, nothing cut until each log's days are set.
//   node test/e2e-bad.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9233);
const data = process.argv[3] || 'test/data-bad';
const p = await connect(port);
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const rd = f => existsSync(join(data, f)) ? readFileSync(join(data, f), 'utf8') : '';
const st = () => { try { return JSON.parse(rd('settings.json').replace(/^﻿/, '')); } catch (e) { return null; } };

ok('the page starts', await until('feed.got'));
ok('the unreadable file is kept aside', readdirSync(data).some(f => /^state\.json\.bad-\d{8}-\d{6}$/.test(f)), readdirSync(data).join(', '));
ok('the view starts empty', await E('S.L.cats.length === 0'));
ok('and says where the old file is', await until('/couldn.t be read/.test($("toastTxt").textContent)', 3000), await E('$("toastTxt").textContent'));

// ---- a damaged settings.json ----
ok('a damaged settings.json is kept aside too', readdirSync(data).some(f => /^settings\.json\.bad-\d{8}-\d{6}$/.test(f)), readdirSync(data).join(', '));
ok('the new one says the days are unknown, saved at once', !!st() && st().daysUnknown === true, rd('settings.json'));
ok('nothing cut at start: the 40-day-old session and warning are still there', /Old Game/.test(rd('games.log')) && /Old: 1/.test(rd('alerts.log')));
ok('the page knows no days are set (it shows everything)', await until('feed.gameDays === 0 && feed.warnDays === 0', 3000), await E('JSON.stringify([feed.gameDays, feed.warnDays])'));
// Keep sessions through Settings: any number cuts something now, so it asks first; only that log is cut
await E('(() => { $("setBtn").click(); return 1; })()'); await p.sleep(400);
await E(`(() => { const i = $('sGameDays'); i.value = '30'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await p.sleep(300);
ok('setting Keep sessions asks first', await E('$("cmodal").classList.contains("open") && /games\\.log\\.bak/.test($("cmodal").textContent)'), await E('$("cmodal").textContent'));
await E('(() => { $("cyes").click(); return 1; })()'); await p.sleep(1500);
ok('the sessions are cut at 30 days (kept in games.log.bak), the warnings left whole', !/Old Game/.test(rd('games.log')) && /New Game/.test(rd('games.log')) && /Old Game/.test(rd('games.log.bak')) && /Old: 1/.test(rd('alerts.log')),
  rd('games.log').length + ' / ' + rd('alerts.log').split('\n').length);
ok('the warnings\' days are still unknown', !!st() && st().daysUnknown === true && st().gameDays === 30 && !('warnDays' in st()), rd('settings.json'));
await E(`(() => { const i = $('sWarnDays'); i.value = '30'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await p.sleep(300);
await E('(() => { if ($("cmodal").classList.contains("open")) $("cyes").click(); return 1; })()'); await p.sleep(1500);
ok('Keep warnings set too: the old warning cut (kept in alerts.log.bak), the days known again', !/Old: 1/.test(rd('alerts.log')) && /New: 1/.test(rd('alerts.log')) && /Old: 1/.test(rd('alerts.log.bak')) && !!st() && !('daysUnknown' in st()),
  rd('settings.json'));
await E('(() => { $("setmodal").classList.remove("open"); return 1; })()');
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
