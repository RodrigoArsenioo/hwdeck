// A history file and a settings file another program held while HW Deck started (run-all.ps1 locks
// test\data-held\hist.bin and settings.json until the app is up): the history couldn't be read, so it is tried again
// later and nothing is saved over it, not even on exit; the settings run on defaults that cut nothing and check for
// no updates until the file is free, then it is read (every 5 s): its values are the run's, never reset.
//   node test/e2e-held.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9233);
const data = process.argv[3] || 'test/data-held';
const p = await connect(port);
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const before = readFileSync(join(data, 'hist.bin')), sBefore = readFileSync(join(data, 'settings.json'));

ok('the page starts', await until('READ.length > 0 && feed.got'));
ok('the held settings: nothing cut by days nobody knows, no update check', await until('(feed.gameDays === 0 && feed.warnDays === 0 || feed.gameDays === 365 && feed.warnDays === 365) && feed.updates === false', 4000), await E('JSON.stringify([feed.gameDays, feed.warnDays, feed.updates])'));
ok('once free, the settings file is read: its days and updates off', await until('feed.gameDays === 365 && feed.warnDays === 365 && feed.updates === false', 9000), await E('JSON.stringify([feed.gameDays, feed.warnDays, feed.updates])'));
ok('the 40-day-old session is still there (the file says 365 days)', /Old Game/.test(readFileSync(join(data, 'games.log'), 'utf8')));
ok('it says why in its log', /settings\.json is held by another program/.test(readFileSync(join(data, 'app.log'), 'utf8')));
await p.sleep(2500);   // a few seconds of history that would be saved
p.evaluate(`send({ t: 'exit' })`).catch(() => {});
// gone once the debug port stops answering (the exit save runs before that)
const t0 = Date.now(); let gone = false;
while (!gone && Date.now() - t0 < 10000) { await p.sleep(300); try { await fetch(`http://127.0.0.1:${port}/json`); } catch (e) { gone = true; } }
ok('the app quits', gone);
const after = readFileSync(join(data, 'hist.bin'));
ok('the history file it couldn\'t read is not saved over, not even on exit', Buffer.compare(before, after) === 0, after.length + ' bytes, was ' + before.length);
ok('nor moved aside while it was only held', !readdirSync(data).some(f => f.startsWith('hist.bin.bad-')), readdirSync(data).join(', '));
const sAfter = (() => { try { return JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')); } catch (e) { return {}; } })(), sWas = JSON.parse(sBefore.toString('utf8').replace(/^\uFEFF/, ''));
ok('the held settings file keeps its values, not moved aside', Object.keys(sWas).every(k => JSON.stringify(sAfter[k]) === JSON.stringify(sWas[k])) && !readdirSync(data).some(f => f.startsWith('settings.json.bad-')), readFileSync(join(data, 'settings.json'), 'utf8'));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
