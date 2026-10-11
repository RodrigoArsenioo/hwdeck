// A history file another program held while HW Deck started (run-all.ps1 locks test\data-held\hist.bin until the app
// is up): it couldn't be read, so it is tried again later and nothing is saved over it, not even on exit.
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
const before = readFileSync(join(data, 'hist.bin'));

ok('the page starts', await until('READ.length > 0 && feed.got'));
await p.sleep(2500);   // a few seconds of history that would be saved
p.evaluate(`send({ t: 'exit' })`).catch(() => {});
// gone once the debug port stops answering (the exit save runs before that)
const t0 = Date.now(); let gone = false;
while (!gone && Date.now() - t0 < 10000) { await p.sleep(300); try { await fetch(`http://127.0.0.1:${port}/json`); } catch (e) { gone = true; } }
ok('the app quits', gone);
const after = readFileSync(join(data, 'hist.bin'));
ok('the history file it couldn\'t read is not saved over, not even on exit', Buffer.compare(before, after) === 0, after.length + ' bytes, was ' + before.length);
ok('nor moved aside while it was only held', !readdirSync(data).some(f => f.startsWith('hist.bin.bad-')), readdirSync(data).join(', '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
