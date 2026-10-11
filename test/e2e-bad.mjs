// A working view that can't be read (run-all.ps1 writes a broken state.json into test\data-bad first): it is kept
// aside, the page starts empty and says where the old file went.
//   node test/e2e-bad.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readdirSync } from 'node:fs';

const port = Number(process.argv[2] || 9233);
const data = process.argv[3] || 'test/data-bad';
const p = await connect(port);
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };

ok('the page starts', await until('feed.got'));
ok('the unreadable file is kept aside', readdirSync(data).some(f => /^state\.json\.bad-\d{8}-\d{6}$/.test(f)), readdirSync(data).join(', '));
ok('the view starts empty', await E('S.L.cats.length === 0'));
ok('and says where the old file is', await until('/couldn.t be read/.test($("toastTxt").textContent)', 3000), await E('$("toastTxt").textContent'));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
