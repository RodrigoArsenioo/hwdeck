// The 12V-2x6 connector: HW Deck's own reading for a GPU that reports its pins (made-up ones here: start with
// HWDECK_FAKEPINS=1). In Storage under HW Deck, a cell that starts with its lines, the pins as bars and in its popup,
// yellow and red from its most loaded pin, yellow for a pin carrying 1.5x its share for 3 s, both in the warning
// history. Start it on an EMPTY data folder:
//   set HWDECK_FAKEPINS=1 & set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9233
//   HWDeck.exe --fake 300 --data test\data-12v
// then: node test/e2e-12v.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9233);
const data = process.argv[3] || 'test/data-12v';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const log = () => existsSync(join(data, 'alerts.log')) ? readFileSync(join(data, 'alerts.log'), 'utf8') : '';

ok('catalog arrives with the connector: 300 made up, the bottleneck, the connector, the game time', await until('READ.length === 303 && feed.got'), await ev('READ.length'));
ok('it is HW Deck\'s own, after the bottleneck, with six pins and their powers', await ev('(() => { const r = BYKEY.get(CONN); return !!r && SENS[r.s].name === "HW Deck" && r.label === "12V-2x6 connector" && r.unit === "A" && r.kind === "12v" && feed.c12keys && feed.c12keys[0].length === 6 && feed.c12keys[1].length === 6; })()'),
  await ev('JSON.stringify(feed.c12keys)'));
const pins = await ev('feed.c12keys[0]');
const pin = async vals => { for (let i = 0; i < 6; i++) await ev(`send({ t: 'fakePin', key: ${JSON.stringify(pins[i])}, v: ${vals[i]} })`); };
await pin([3, 3, 3, 3, 3, 3]);
await ev('(() => { addKeys([CONN], null, null, "Power"); setEdit(false); showScreen("tiles"); return 1; })()');
await p.sleep(1500);
const cid = await ev('S.L.cats[0].cells[0]');
const el = `document.querySelector('#view .dc[data-cid="${cid}"]')`;
ok('a new connector cell starts with its lines, 9.2 and 9.5 A', await ev(`(() => { const g = S.L.cells["${cid}"].gates; return g.mode === "yr" && g.y === 9.2 && g.r === 9.5; })()`));
ok('its tile: six pin bars, no graph', await until(`${el} && ${el}.querySelectorAll(".xb .xpins b").length === 6 && !${el}.querySelector("canvas")`, 4000));
ok('the value is the most loaded pin', await until(`Math.abs(BYKEY.get(CONN).v - 3) < 0.01`, 4000), await ev('BYKEY.get(CONN).v'));

await pin([3, 3, 9.3, 3, 3, 3]);
ok('a pin at 9.3 A: yellow, the caption names it', await until(`(() => { const e = evalCell("${cid}", S.L.cells["${cid}"], true, true); return e.lvl === 1 && e.sub === "pin 3 at 9.3 A"; })()`, 5000),
  await ev(`JSON.stringify(evalCell("${cid}", S.L.cells["${cid}"], true, true))`));
await pin([3, 3, 9.6, 3, 3, 3]);
ok('at 9.6 A: red', await until(`evalCell("${cid}", S.L.cells["${cid}"], true, true).lvl === 2`, 5000));
await pin([3, 3, 3, 3, 3, 3]); await p.sleep(4500);
ok('even again: back to normal', await ev(`evalCell("${cid}", S.L.cells["${cid}"], true, true).lvl === 0`));

const before = log().length;   // (what the uneven pins log from here on)
await pin([6, 3, 3, 3, 3, 3]);   // 21 A in all, pin 1 at 1.7x its share
await p.sleep(1500);
ok('a pin over 1.5x its share: not yet (it has to last 3 s)', await ev(`evalCell("${cid}", S.L.cells["${cid}"], true, true).lvl === 0`));
ok('after 3 s: yellow, "pin 1 carrying 1.7x its share"', await until(`(() => { const e = evalCell("${cid}", S.L.cells["${cid}"], true, true); return e.lvl === 1 && e.sub === "pin 1 carrying 1.7x its share"; })()`, 5000),
  await ev(`evalCell("${cid}", S.L.cells["${cid}"], true, true).sub`));
ok('the warning history has it, with the pin', await until('true', 10) && await (async () => { for (let i = 0; i < 20; i++) { if (/YELLOW +12V-2x6 connector pins: \d.*\(pin 1 carrying 1\.7x its share\)/.test(log())) return true; await p.sleep(300); } return false; })(),
  log().split('\n').filter(l => /12V/.test(l)).slice(-3).join(' | '));
await pin([2, 2, 2, 2, 2, 2]);   // 12 A in all: too little to judge
await p.sleep(4500);
const after = log().slice(before);
ok('under 15 A in all, a spread means nothing: normal, the history says OK', await ev(`evalCell("${cid}", S.L.cells["${cid}"], true, true).lvl === 0`) && /OK +12V-2x6 connector pins: back to normal/.test(after),
  after.split('\n').filter(l => /12V/.test(l)).join(' | '));
ok('the uneven pins logged once', (after.match(/YELLOW +12V-2x6 connector pins:/g) || []).length === 1);

// (a click on the pins' bars opens it too: they are only drawn, not a control)
{
  const at = await p.center(`#view .dc[data-cid="${cid}"] .xpins`);
  if (at) { await p.click(at.x, at.y); await p.sleep(900); }
  ok('a click on the pins opens the cell', !!at && await until(`modalCid === "${cid}"`, 3000), JSON.stringify(at) + ' ' + await ev('modalCid'));
  await ev('closeDetail()'); await p.sleep(400);
}
await ev(`openDetail("${cid}")`); await p.sleep(1200);
ok('its popup: the six pins, amps and watts', await until('document.querySelectorAll("#mextra .mpin").length === 6 && /A/.test(document.querySelector("#mextra .mpin .num").textContent)', 3000));
await ev('closeDetail()');
await ev(`showScreen("grid")`); await p.sleep(1500);
ok('Grid: the pins in its row', await ev(`!!document.querySelector('#view .dc[data-cid="${cid}"] .xpins')`));
// its lines set to None: the pins still turn it yellow, and the warning history still has it
await ev(`mutate(() => { S.L.cells["${cid}"].gates.mode = 'none'; })`); await p.sleep(1500);
const before2 = log().length;
await pin([6, 3, 3, 3, 3, 3]); await p.sleep(5000);
const after2 = log().slice(before2);
ok('no lines: uneven pins still turn it yellow and are in the warning history', await ev(`evalCell("${cid}", S.L.cells["${cid}"], true, true).lvl === 1`) && /YELLOW +12V-2x6 connector pins: /.test(after2),
  after2.split('\n').filter(l => /12V/.test(l)).join(' | '));
await pin([3, 3, 3, 3, 3, 3]);
ok('no page errors', errs.length === 0, errs.join(' | '));
for (const k of pins) await ev(`send({ t: 'fakePin', key: ${JSON.stringify(k)}, v: null })`);
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
