// Second half of the end-to-end check: run after e2e.mjs, once HW Deck was closed and started again on the same
// data folder. Checks what survived the restart and how a layout from another PC (slot 3) is handled.
//   node test/e2e-restart.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9230);
const data = process.argv[3] || 'test/data1';
mkdirSync('test/out', { recursive: true });
const p = await connect(port);
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(250); };

ok('catalog arrives', await until('READ.length === 301 && feed.got'));
ok('the working layout came back', await E('S.L.cats.length === 3 && S.active === 0 && S.screen === "tiles"'), await E('S.L.cats.map(c => c.name)'));
ok('slot names came back', await E('S.slots[0] && S.slots[0].name === "Gaming" && !!S.slots[1] && S.slots[2] && S.slots[2].name === "Other PC" && !S.slots[3]'), await E('S.slots.map(s => s && s.name)'));
ok('gates and curves came back', await E('Object.values(S.L.cells).some(c => c.gates && c.gates.mode === "yr") && Object.values(S.L.cells).some(c => c.curve && !c.pred) && Object.values(S.L.cells).some(c => c.pred)'));
ok('the long history was saved on exit (hist.bin)', existsSync(join(data, 'hist.bin')));
// the seconds from before the restart are back in the graphs (not just the few since this start)
ok('the 15 min graphs keep the minutes from before the restart', await until('(() => { const c = Object.values(S.L.cells).find(c => c.key && BYKEY.has(c.key)); return c && series(c.key, 900).filter(isFinite).length > 20; })()', 4000),
   await E('(() => { const c = Object.values(S.L.cells).find(c => c.key && BYKEY.has(c.key)); return c ? series(c.key, 900).filter(isFinite).length + " seconds" : "no cell"; })()'));
ok('the warning log marks the restart', /MARK\s+app start[\s\S]*MARK\s+app start/.test(require_text(join(data, 'alerts.log'))));
// the host keeps 15 min at 1 s for every reading, so a cell added now arrives with its past (since the app started)
await p.sleep(4000);
const fresh = await E('READ.find(r => !inView().has(r.key) && r.t === "temp").key');
await E(`addKeys([${JSON.stringify(fresh)}], S.L.cats[0].id, null)`);
ok('a cell added now gets its past from the host straight away', await until(`series(${JSON.stringify(fresh)}, 900).filter(isFinite).length >= 8`, 2500),
   await E(`series(${JSON.stringify(fresh)}, 900).filter(isFinite).length`) + ' points');

// slot 3: one cell with an unknown key but a known sensor name + label, one with nothing to go on
await click('#savesBtn');
await click('#slist .srow2[data-slot="2"] [data-a="load"]');
if (await E('$("cmodal").classList.contains("open")')) await click('#cyes');
ok('slot 3 loads', await E('S.active === 2 && S.L.cats[0].name === "Imported"'));
ok('a cell from another PC finds its reading by sensor name and label', await E('BYKEY.has(S.L.cells.m1.key) && S.L.cells.m1.key !== "deadbeef.0/01000000"'), await E('S.L.cells.m1.key'));
ok('a cell with no match shows as missing with Re-link', await E('!!document.querySelector(`#view .dc[data-cid="m2"].missing .rl`)'));
await click('#view .dc[data-cid="m2"] .rl');
ok('Re-link filters Storage to the label', await E('!$("relinkBar").hidden && $("q").value === "VRM"'));
await E('(() => { const e = $("q"); e.value = ""; e.dispatchEvent(new Event("input")); })()'); await p.sleep(150);
await click('#vspace .vrow.r .add.link');
ok('picking a reading re-links the cell', await E('BYKEY.has(S.L.cells.m2.key) && !document.querySelector("#view .dc.missing")'), await E('S.L.cells.m2.key'));
await p.shot('test/out/restart.png');
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');

function require_text(f) { try { return readFileSync(f, 'utf8'); } catch (e) { return ''; } }
