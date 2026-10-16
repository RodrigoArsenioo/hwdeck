// A build with extras (test\ext: extras-test.cs + extras.js, built by run-all.ps1 into test\out\ext): its own name and
// no update check, its readings after HWiNFO's and the bottleneck, a reading of its own kind drawn by extras.js in
// every view, "x.*" messages both ways, a click on its own control that doesn't open the popup (and does nothing in
// edit mode), its history, and its stop hook at exit. Start it on an EMPTY data folder:
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9236
//   test\out\ext\HWDeck.exe --fake 300 --data test\data-ext
// then: node test/e2e-ext.mjs [port] [dataDir]   (it quits the app itself at the end)
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9236);
const data = process.argv[3] || 'test/data-ext';
const p = await connect(port);
const errs = await p.errors();
await p.cmd('Page.reload');   // errors while extras.js loads count too
await p.sleep(2500);
const { ok, done } = checks();
const ev = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };

ok('catalog arrives: HWiNFO\'s 300, the bottleneck, the game time, then its own 2', await until('READ.length === 304 && feed.got'), await ev('READ.length'));
ok('its readings come last, under their own group', await ev('(() => { const a = BYKEY.get("x.test/count"), b = BYKEY.get("x.test/switch"); return !!a && !!b && SENS[a.s].name === "Test extras" && a.idx === 302 && b.idx === 303 && SENS[BYKEY.get(BNECK).s].name === "HW Deck"; })()'));
ok('the switch has its kind, the counter none', await ev('BYKEY.get("x.test/switch").kind === "xtest" && BYKEY.get("x.test/count").kind === null'));
ok('extras.js is in, its name is the title', await until('window.xLoaded === true && EXT.loaded && !!EXT.kinds.xtest && document.title === "HW Deck Ext Test"', 4000), await ev('document.title'));
await ev('(() => { $("setBtn").click(); return 1; })()'); await p.sleep(400);
ok('no update check: no Updates row in Settings', await ev('!!document.querySelector("#setmodal.open") && !/Updates/.test($("setmodal").textContent)'));
await ev('(() => { $("setmodal").classList.remove("open"); return 1; })()');

// ---- its readings as cells, in view mode ----
await ev('(() => { addKeys(["x.test/count", "x.test/switch"], null, null, "Mine"); setEdit(false); showScreen("tiles"); return 1; })()');
await p.sleep(1500);
const sw = 'S.L.cats[0].cells.find(id => S.L.cells[id].key === "x.test/switch")', cnt = 'S.L.cats[0].cells.find(id => S.L.cells[id].key === "x.test/count")';
const swEl = `document.querySelector('#view .dc[data-cid="' + ${sw} + '"]')`, cntEl = `document.querySelector('#view .dc[data-cid="' + ${cnt} + '"]')`;
ok('the switch tile says Off, with its own body in place of a graph', await until(`${swEl} && ${swEl}.querySelector(".v").textContent.replace(/\\s/g, "") === "Off" && !!${swEl}.querySelector(".xb .xflip[data-where=tile]") && !${swEl}.querySelector("canvas")`, 4000),
  await ev(`${swEl} ? ${swEl}.querySelector(".v").textContent + " | " + ${swEl}.innerHTML.slice(0, 120) : "none"`));
ok('its caption comes from extras.js', await ev(`${swEl}.querySelector(".tc").textContent === "a test switch"`), await ev(`${swEl}.querySelector(".tc").textContent`));
const c0 = Number(await ev(`BYKEY.get("x.test/count").v`));
await p.sleep(2200);
const c1 = Number(await ev(`BYKEY.get("x.test/count").v`));
ok('the counter counts, once a second, with a graph like any reading', c1 >= c0 + 1 && await ev(`!!${cntEl}.querySelector("canvas")`), c0 + ' then ' + c1);
// ---- its always-on line and its judged rule: the line steps aside while a cell's lines watch the counter the same
// way, the judged rule always stays ----
const alog = () => existsSync(join(data, 'alerts.log')) ? readFileSync(join(data, 'alerts.log'), 'utf8') : '';
const untilLog = async (re, from, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(alog().slice(from))) return true; await p.sleep(300); } return false; };
ok('a build\'s always-on line and its judged rule both log', await untilLog(/YELLOW +Test always: /, 0) && await untilLog(/YELLOW +Test own: .*\(always\)/, 0), alog().split('\n').slice(-4).join(' | '));
let mark = alog().length;
await ev(`(() => { mutate(() => { S.L.cells[${cnt}].gates = { mode: 'y', dir: 'above', y: 1e9, r: NaN, hold: 0 }; }); return 1; })()`);
ok('lines on the counter\'s cell: the always-on line steps aside (its episode ends)', await untilLog(/OK +Test always: back to normal \(line removed/, mark), alog().slice(mark).split('\n').join(' | '));
await p.sleep(2500);
ok('the judged rule stays', !/Test own/.test(alog().slice(mark)) && /YELLOW +Test own: /.test(alog()));
mark = alog().length;
await ev(`(() => { mutate(() => { S.L.cells[${cnt}].gates = { mode: 'y', dir: 'below', y: -1, r: NaN, hold: 0 }; }); return 1; })()`);
ok('lines that watch the other way don\'t count: the always-on line comes back', await untilLog(/YELLOW +Test always: /, mark), alog().slice(mark).split('\n').join(' | '));
await ev(`(() => { mutate(() => { delete S.L.cells[${cnt}].gates; }); return 1; })()`); await p.sleep(300);
ok('once extras.js is in, its tiles are measured with their bodies (drawn afresh: the same heights)', await ev(`EXT.ready === true && (() => { const h = () => [...document.querySelectorAll('#view .tile')].map(t => Math.round(t.getBoundingClientRect().height)).join(); const a = h(); packMemo.clear(); renderView(false); return a === h(); })()`));

// ---- its control: a real click, in view mode it acts and the popup stays shut ----
let c = await p.centerOf(`${swEl}.querySelector(".xflip")`); await p.click(c.x, c.y);
ok('the host answers the click with x.state', await until('window.xLast && window.xLast.on === true', 3000), await ev('JSON.stringify(window.xLast || null)'));
ok('the click didn\'t open the popup', await ev('!modalCid && !$("modal").classList.contains("open")'));
ok('the value follows: On, and its update hook marks the button', await until(`${swEl}.querySelector(".v").textContent.replace(/\\s/g, "") === "On" && ${swEl}.querySelector(".xflip").classList.contains("on")`, 3000));
c = await p.centerOf(`${swEl}.querySelector(".tn")`); await p.click(c.x, c.y); await p.sleep(500);
ok('a click elsewhere on the tile still opens the popup', await ev('!!modalCid'));
ok('the popup has its description and its own section, kept up to date', await until('$("mdesc").textContent === "A pretend switch from the test build." && document.querySelector("#mextra > .xd .xdet") && document.querySelector("#mextra > .xd .xdet").textContent === "detail on"', 3000),
  await ev('$("mdesc").textContent + " | " + $("mextra").textContent'));
c = await p.centerOf('document.querySelector("#mextra .xflip")'); await p.click(c.x, c.y);
ok('its control in the popup works, the popup stays open and follows', await until('window.xLast.on === false && document.querySelector("#mextra .xdet").textContent === "detail off" && !!modalCid', 3000), await ev('$("mextra").textContent'));
await ev('closeDetail()');
c = await p.centerOf(`${swEl}.querySelector(".xflip")`); await p.click(c.x, c.y);
ok('back on from the tile', await until('window.xLast.on === true && BYKEY.get("x.test/switch").v === 1', 3000));

// ---- edit mode: the same click selects the cell, nothing is sent ----
await ev('(() => { setEdit(true); return 1; })()'); await p.sleep(1200);
c = await p.centerOf(`${swEl}.querySelector(".xflip")`); await p.click(c.x, c.y); await p.sleep(800);
ok('in edit mode the click selects the cell and flips nothing', await ev(`sel === ${sw} && window.xLast.on === true && BYKEY.get("x.test/switch").v === 1`), await ev(`JSON.stringify([sel === ${sw}, window.xLast.on, BYKEY.get("x.test/switch").v])`));
await ev('(() => { sel = null; renderInsp(); setEdit(false); return 1; })()'); await p.sleep(800);

// ---- the other views draw its body too ----
for (const [vn, where] of [['overview', 'row'], ['grid', 'grid']]) {
  await ev(`showScreen("${vn}")`); await p.sleep(1200);
  ok(vn + ': its body is there (' + where + ')', await ev(`!!document.querySelector('#view .dc[data-cid="' + ${sw} + '"] .xb .xflip[data-where=${where}]')`), await ev(`[...document.querySelectorAll("#view .xb .xflip")].map(b => b.dataset.where)`));
}
await ev('(() => { S.L.views = S.L.views || {}; S.L.views.overview = { rows: [{ cols: [{ stack: [S.L.cats[0].id] }] }], cat: { [S.L.cats[0].id]: { style: "list" } } }; S.L = cleanLayout(S.L); afterChange(); showScreen("overview", true); return 1; })()');
await p.sleep(1200);
ok('overview as a list: the body sits in its row', await ev(`!!document.querySelector('#view .row.dc[data-cid="' + ${sw} + '"] .xb .xflip[data-where=row]')`));
await ev('showScreen("tiles")');

// ---- history: its readings are kept like any other ----
ok('the host keeps a history for its readings', await until('series("x.test/count", HLEN).filter(x => x > 0).length >= 3', 6000), await ev('series("x.test/count", HLEN).filter(x => x > 0).length'));
ok('no page errors', errs.length === 0, errs.join(' | '));

// ---- the stop hook runs at exit ----
p.evaluate(`send({ t: 'exit' })`).catch(() => {});
const t0 = Date.now(); let gone = false;
while (!gone && Date.now() - t0 < 10000) { await p.sleep(300); try { await fetch(`http://127.0.0.1:${port}/json`); } catch (e) { gone = true; } }
const stopped = existsSync(join(data, 'ext-stop.txt')) ? readFileSync(join(data, 'ext-stop.txt'), 'utf8') : '';
ok('its stop hook wrote its file at exit (the second hook ran too)', gone && /^stopped after [1-9]\d* s$/.test(stopped), stopped || (gone ? 'no file' : 'still running'));
ok('its readings are in hist.bin', gone && readFileSync(join(data, 'hist.bin')).includes(Buffer.from('x.test/count')));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
