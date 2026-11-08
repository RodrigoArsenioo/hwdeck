// A session line games.log refused at the last quit (games.log.pending) while games.log already holds a longer line of
// the same session, games.log held by another program while HW Deck starts (11-07 audit, round 2's fix 8: only the
// lines of a pending session's start are parsed). Once games.log is free the pending line is judged against it and
// dropped, not added beside it. run-all.ps1 seeds the folder, holds games.log for the start and lets go:
//   node test/e2e-pending.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9243), data = process.argv[3] || 'test/data-pend', START = 1762500000;
const { ok, done } = checks();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = () => readFileSync(join(data, 'games.log'), 'utf8').split(/\r?\n/).filter(l => l.includes('"start":' + START + ','));
let p = null;
for (let i = 0; i < 60 && !p; i++) { try { p = await connect(port); } catch (e) { await sleep(500); } }
ok('the copy is up', !!p);
const t0 = Date.now();
while (Date.now() - t0 < 60000 && existsSync(join(data, 'games.log.pending'))) await sleep(500);
ok('games.log free again: the pending line was judged, games.log.pending gone', !existsSync(join(data, 'games.log.pending')), Math.round((Date.now() - t0) / 1000) + ' s');
const ls = lines();
ok('one line of that session in games.log, the longer one it had', ls.length === 1 && ls[0].includes('"end":' + (START + 3600) + ','), ls);
if (p) { await p.evaluate('send({ t: "exit" })').catch(() => {}); p.close(); }
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
process.exit(0);
