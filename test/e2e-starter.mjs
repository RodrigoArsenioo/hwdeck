// Starter: a first layout HW Deck builds from this PC's sensors. A new user (an EMPTY data folder) gets it as soon as
// the readings come, in view mode; someone who already has a layout gets a note that stays until it is dismissed (a
// reload doesn't drop it), Starter in Saves to load, and the empty view's button. Then Starter on made-up PCs: one like
// his (Ryzen + RTX, DDR5, two drives, fans, the 12V-2x6 pins), Intel + Radeon with an iGPU left over, a laptop with only
// its iGPU, and no HWiNFO. Start it WITHOUT --no-starter, on an EMPTY data folder, with the made-up pins:
//   set HWDECK_FAKEPINS=1 & set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9241
//   HWDeck.exe --fake 300 --data test\data-st
// then: node test/e2e-starter.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9241);
const data = process.argv[3] || 'test/data-st';
let p = await connect(port);
let errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const state = () => { try { return JSON.parse(readFileSync(join(data, 'state.json'), 'utf8').replace(/^ï»¿/, '')); } catch (e) { return null; } };
const click = async sel => { const c = await p.center(sel); if (!c) return false; await p.click(c.x, c.y); await p.sleep(350); return true; };
// the layout as "category: cell, cell" lines (a cell's own name, else HWiNFO's label)
const shape = L => ev(`(() => { const L = ${L}; return L ? L.cats.map(c => c.name + ': ' + c.cells.map(id => { const x = L.cells[id], r = BYKEY.get(x.key); return x.name || (r ? r.label : '?'); }).join(', ')) : null; })()`);
const reload = async () => {
  await ev('location.reload(); 1').catch(() => {});
  p.close(); await new Promise(r => setTimeout(r, 1500));
  p = await connect(port); errs = await p.errors();
  return until('feed.got && READ.length > 0 && !!S.L', 10000);
};

// ---- a new user: Starter is built at once, in view mode, no note ----
ok('the readings come (made-up, with the pins)', await until('READ.length > 300 && feed.got', 10000), await ev('READ.length'));
ok('a new user gets Starter at once, not an empty view', await until('S.L.cats.length > 0', 5000) && await ev('!document.querySelector("#view.empty")'));
const first = await shape('S.L');
ok('Starter in his order: the game, the GPU, the CPU, memory, drives, fans, by name', JSON.stringify(first.map(x => x.split(':')[0])) === JSON.stringify(['Game', 'Fake GeForce RTX 5090', 'Fake Ryzen 9 9950X', 'Memory', 'Drives', 'Fans']), JSON.stringify(first));
ok('the GPU: its temperature, hot spot, memory, usage, power, VRAM and the 12V-2x6 pins', /^Fake GeForce RTX 5090: GPU temperature, GPU hot spot, GPU memory, GPU usage, GPU power, VRAM used, 12V-2x6 pins$/.test(first[1]), first[1]);
ok('the CPU: its temperature, usage, power and busiest core', /^Fake Ryzen 9 9950X: CPU temperature, CPU usage, CPU power, Busiest core$/.test(first[2]), first[2]);
ok('memory: RAM used, its sticks (up to 4); drives: the drive once (by its letter)', /^Memory: RAM used, RAM stick 1(, RAM stick [234])*$/.test(first[3]) && first[4] === 'Drives: Drive C:', first[3] + ' / ' + first[4]);
ok('the game: fps, 1% low, what limits it, the time', /^Game: FPS, 1% low FPS, Bottleneck, Game time$/.test(first[0]), first[0]);
ok('the connector starts with its lines, nothing else has lines', await ev('Object.values(S.L.cells).filter(c => c.gates && c.gates.mode !== "none").map(c => c.key).join() === CONN'));
ok('in view mode, no note', await ev('!S.edit && !$("notice").classList.contains("show")'));
await p.sleep(600);
ok('remembered: Starter seen, saved with the view', !!state() && state().starter === true && state().L.cats.length === 6, JSON.stringify(state() && { starter: state().starter, cats: state().L.cats.length }));
ok('no note after a reload either', await reload() && await ev('!$("notice").classList.contains("show") && S.L.cats.length === 6'));

// ---- someone with a layout of their own, updated: a note that stays until it is dismissed ----
await ev('(() => { S.L = emptyLayout(); addKeys([READ[0].key, READ[1].key], null, null, "Mine"); S.starterSeen = false; saveState(); return 1; })()');
await p.sleep(800);
ok('(their own view saved, Starter not seen)', !!state() && state().starter !== true && state().L.cats.length === 1);
ok('after the update: their view stays, and a note says Starter is there', await reload() && await until('$("notice").classList.contains("show")', 4000) && await ev('S.L.cats.length === 1 && S.L.cats[0].name === "Mine"'), await ev('$("notice").textContent'));
ok('the note: what Starter is, where it is, a button to see it and one to dismiss', await ev('/Starter/.test($("notice").textContent) && /Saves/.test($("notice").textContent) && !!$("noticeShow") && !!$("noticeClose")'), await ev('$("notice").textContent'));
await p.sleep(9000);
ok('it doesn\'t go by itself (9 s, longer than any toast)', await ev('$("notice").classList.contains("show")'));
ok('nor with a reload', await reload() && await until('$("notice").classList.contains("show")', 4000));
// (their view emptied while the note is up: not a new user, never Starter over it, here or after a restart)
await ev('(() => { snap(); S.L = emptyLayout(); S.active = null; afterChange(); starterCheck(); return 1; })()'); await p.sleep(600);
ok('their view emptied while the note is up: no Starter built over it, the note stays', await ev('S.L.cats.length === 0 && $("notice").classList.contains("show")'));
ok('nor after a reload (the note showed once: that is kept)', await reload() && await p.sleep(1500) === undefined && await ev('S.L.cats.length === 0 && $("notice").classList.contains("show")') && state().starterNoted === true, JSON.stringify(state() && state().starterNoted));
await ev('(() => { addKeys([READ[0].key, READ[1].key], null, null, "Mine"); return 1; })()'); await p.sleep(600);
await click('#noticeClose'); await p.sleep(600);
ok('dismissed: gone, and remembered', await ev('!$("notice").classList.contains("show") && S.starterSeen === true') && state().starter === true, JSON.stringify(state() && state().starter));
ok('a reload after: no note', await reload() && await p.sleep(1500) === undefined && await ev('!$("notice").classList.contains("show")'));
ok('their view never changed', await ev('S.L.cats.length === 1 && S.L.cats[0].name === "Mine"'));
// "Show it": Saves opens on Starter
await ev('(() => { S.starterSeen = false; starterCheck(); return 1; })()');
ok('(the note again)', await until('$("notice").classList.contains("show")', 2000));
await click('#noticeShow');
ok('"Show it" opens Saves, Starter marked, the note gone for good', await ev('smodal.classList.contains("open") && !!document.querySelector("#sstart .srow2.starter.hl") && !$("notice").classList.contains("show") && S.starterSeen === true'));

// ---- Starter in Saves: above the five slots, built from this PC, loaded like a slot ----
ok('Saves: Starter above the five slots, with what it has', await ev('document.querySelectorAll("#slist .srow2").length === 5 && /cells/.test(document.querySelector("#sstart .sm").textContent) && /this PC/.test(document.querySelector("#sstart .sm").textContent)'), await ev('document.querySelector("#sstart").textContent'));
await click('#sstart [data-a="starter"]');
ok('the view not in a slot: loading asks first', await ev('cmodal.classList.contains("open") && /Starter/.test($("ctitle").textContent)'), await ev('$("ctitle").textContent'));
await click('#cyes'); await p.sleep(300);
ok('loaded: Starter in the view, no slot linked, Saves shut, an Undo', await ev('S.L.cats.length === 6 && S.active === null && !smodal.classList.contains("open") && !$("toastUndo").hidden'), await ev('[S.L.cats.length, S.active]'));
await click('#toastUndo');
ok('Undo: their own view back', await ev('S.L.cats.length === 1 && S.L.cats[0].name === "Mine"'));
// (loading Starter yourself while its note is up: the note has done its job)
await ev('(() => { S.starterSeen = false; starterCheck(); return 1; })()');
await ev('(() => { renderSaves(); smodal.classList.add("open"); return 1; })()'); await p.sleep(300);
await click('#sstart [data-a="starter"]'); await click('#cyes'); await p.sleep(400);
ok('loading Starter from Saves dismisses its note, for good', await ev('S.L.cats.length === 6 && !$("notice").classList.contains("show") && S.starterSeen === true'));
await click('#toastUndo');
// the empty view: a button builds it
await ev('(() => { snap(); S.L = emptyLayout(); S.active = null; afterChange(); return 1; })()');
ok('an empty view offers Starter (it doesn\'t build it by itself again)', await until('!!document.querySelector("#view.empty #starterBtn")', 2000) && await ev('S.L.cats.length === 0'));
await click('#starterBtn');
ok('one click: Starter', await ev('S.L.cats.length === 6'));

// ---- Starter on other PCs (made-up catalogs, as HWiNFO names things) ----
const T = { temp: 1, fan: 3, current: 4, power: 5, clock: 6, usage: 7, other: 8 };
const feedCat = (sensors, readings, zero) => ev(`(() => { onHost({ t: 'catalog', ver: ${Date.now() % 100000}, sensors: ${JSON.stringify(sensors)}, readings: ${JSON.stringify(readings)}, zero: ${JSON.stringify(zero || [])} }); return READ.length; })()`);
const R = (s, t, key, label, unit, kind) => [s, T[t], key, label, unit || '', kind || null];
const hw = (n, conn) => [R(n, 'other', 'hwdeck.0/bneck', 'Bottleneck')].concat(conn ? [R(n, 'current', 'hwdeck.0/12v', '12V-2x6 connector', 'A', '12v')] : []).concat([R(n, 'other', 'hwdeck.0/gtime', 'Game time', 'min')]);
// like his: Ryzen 7 9800X3D + RTX 5090, two DDR5 sticks, two drives, board fans (one never spins), GPU fans, PresentMon
await feedCat(
  [['f0000501.0', 'CPU [#0]: AMD Ryzen 7 9800X3D'], ['f0000501.1', 'CPU [#0]: AMD Ryzen 7 9800X3D: Enhanced'], ['e0002000.0', 'GPU [#0]: NVIDIA GeForce RTX 5090'],
   ['f3000005.0', 'DDR5 DIMM [#0] (BANK 0/Controller0-ChannelA-DIMM1)'], ['f3000005.1', 'DDR5 DIMM [#2] (BANK 0/Controller1-ChannelA-DIMM1)'], ['f0000006.0', 'System: ASUS ROG STRIX X870E-E'],
   ['f7067010.0', 'ASUS ROG STRIX X870E-E (Nuvoton NCT6799D)'], ['f0000100.0', 'S.M.A.R.T.: Samsung SSD 990 PRO 2TB (S7KHNJ0X) [D:]'], ['f0000100.1', 'S.M.A.R.T.: KINGSTON SFYRD2000G (50026B76) [C:]'],
   ['f0000ff0.0', 'PresentMon'], ['hwdeck.0', 'HW Deck']],
  [R(0, 'usage', 'f0000501.0/07000000', 'Total CPU Usage', '%'), R(0, 'usage', 'f0000501.0/07000001', 'Max CPU/Thread Usage', '%'), R(0, 'clock', 'f0000501.0/06000000', 'Core 0 Clock (perf #1/1)', 'MHz'),
   R(1, 'temp', 'f0000501.1/01000000', 'CPU (Tctl/Tdie)', '°C'), R(1, 'temp', 'f0000501.1/01000001', 'CPU Die (average)', '°C'), R(1, 'power', 'f0000501.1/05000000', 'CPU Package Power', 'W'),
   R(2, 'temp', 'e0002000.0/01000000', 'GPU Temperature', '°C'), R(2, 'temp', 'e0002000.0/01000001', 'GPU Memory Junction Temperature', '°C'), R(2, 'temp', 'e0002000.0/01000002', 'GPU Hot Spot Temperature', '°C'),
   R(2, 'fan', 'e0002000.0/03000000', 'GPU Fan1', 'RPM'), R(2, 'fan', 'e0002000.0/03000001', 'GPU Fan2', 'RPM'), R(2, 'power', 'e0002000.0/05000000', 'GPU Power', 'W'),
   R(2, 'usage', 'e0002000.0/07000000', 'GPU Core Load', '%'), R(2, 'other', 'e0002000.0/08000000', 'GPU Memory Allocated', 'MB'),
   R(3, 'temp', 'f3000005.0/01000000', 'SPD Hub Temperature', '°C'), R(4, 'temp', 'f3000005.1/01000000', 'SPD Hub Temperature', '°C'),
   R(5, 'other', 'f0000006.0/08000000', 'Physical Memory Used', 'MB'), R(5, 'usage', 'f0000006.0/07000000', 'Physical Memory Load', '%'),
   R(6, 'fan', 'f7067010.0/03000000', 'CPU', 'RPM'), R(6, 'fan', 'f7067010.0/03000001', 'Chassis1', 'RPM'), R(6, 'fan', 'f7067010.0/03000002', 'Chassis2', 'RPM'), R(6, 'fan', 'f7067010.0/03000003', 'AIO Pump', 'RPM'),
   R(7, 'temp', 'f0000100.0/01000000', 'Drive Temperature', '°C'), R(7, 'temp', 'f0000100.0/01000001', 'Drive Temperature 2', '°C'), R(8, 'temp', 'f0000100.1/01000000', 'Drive Temperature', '°C'),
   R(9, 'other', 'f0000ff0.0/08000000', 'Framerate', 'FPS'), R(9, 'other', 'f0000ff0.0/08000001', 'Framerate (1% low)', 'FPS')].concat(hw(10, true)),
  ['f7067010.0/03000002']);
const his = await shape('starterLayout()');
ok('like his PC: game, RTX 5090, Ryzen 7 9800X3D, memory, drives, fans', JSON.stringify(his.map(x => x.split(':')[0])) === JSON.stringify(['Game', 'GeForce RTX 5090', 'Ryzen 7 9800X3D', 'Memory', 'Drives', 'Fans']), JSON.stringify(his));
ok('its GPU: hot spot found among the temperatures, the pins last', his[1] === 'GeForce RTX 5090: GPU temperature, GPU hot spot, GPU memory, GPU usage, GPU power, VRAM used, 12V-2x6 pins', his[1]);
ok('its CPU: Tctl/Tdie before the die average', his[2] === 'Ryzen 7 9800X3D: CPU temperature, CPU usage, CPU power, Busiest core' && await ev('(() => { const L = starterLayout(); return BYKEY.get(L.cells[L.cats[2].cells[0]].key).label; })() === "CPU (Tctl/Tdie)"'), his[2]);
ok('memory: RAM used and its load, both sticks; drives: the system drive first', his[3] === 'Memory: RAM used, RAM usage, RAM stick 1, RAM stick 2' && his[4] === 'Drives: Drive C:, Drive D:', his[3] + ' / ' + his[4]);
ok('fans: the GPU\'s, then the pump and the CPU fan first; one that never spins left out', his[5] === 'Fans: GPU fan 1, GPU fan 2, AIO Pump, CPU fan, Chassis1 fan', his[5]);
// Intel + Radeon, the CPU's own graphics left over (it must not be the GPU), no fans, no PresentMon
await feedCat(
  [['f0000501.0', 'CPU [#0]: Intel Core i7-14700K: Enhanced'], ['e0002000.0', 'GPU [#0]: AMD Radeon RX 7900 XTX'], ['e0002000.1', 'GPU [#1]: Intel UHD Graphics 770'],
   ['f0000006.0', 'System: MSI PRO Z790-A'], ['f0000100.0', 'S.M.A.R.T.: WD_BLACK SN850X 1000GB (23123A800123)'], ['hwdeck.0', 'HW Deck'], ['f0000100.1', 'S.M.A.R.T.: WD_BLACK SN850X 1000GB (23123A800456)']],
  [R(0, 'temp', 'f0000501.0/01000000', 'Core Max', '°C'), R(0, 'temp', 'f0000501.0/01000001', 'CPU Package', '°C'), R(0, 'power', 'f0000501.0/05000000', 'CPU Package Power', 'W'), R(0, 'usage', 'f0000501.0/07000000', 'Total CPU Usage', '%'),
   R(1, 'temp', 'e0002000.0/01000000', 'GPU Temperature', '°C'), R(1, 'temp', 'e0002000.0/01000001', 'GPU Hot Spot Temperature', '°C'), R(1, 'power', 'e0002000.0/05000000', 'Total Board Power (TBP)', 'W'),
   R(1, 'usage', 'e0002000.0/07000000', 'GPU Utilization', '%'), R(1, 'other', 'e0002000.0/08000000', 'GPU Memory Usage', 'MB'),
   R(2, 'usage', 'e0002000.1/07000000', 'GPU D3D Usage', '%'), R(2, 'other', 'e0002000.1/08000000', 'GPU D3D Memory Dedicated', 'MB'),
   R(3, 'other', 'f0000006.0/08000000', 'Physical Memory Used', 'MB'), R(4, 'temp', 'f0000100.0/01000000', 'Drive Temperature', '°C'), R(6, 'temp', 'f0000100.1/01000000', 'Drive Temperature', '°C')].concat(hw(5, false)));
const intel = await shape('starterLayout()');
ok('Intel + Radeon: the Radeon is the GPU, the UHD left out; Package before Core Max', JSON.stringify(intel) === JSON.stringify(['Game: Bottleneck, Game time', 'Radeon RX 7900 XTX: GPU temperature, GPU hot spot, GPU usage, GPU power, VRAM used', 'Core i7-14700K: CPU temperature, CPU usage, CPU power', 'Memory: RAM used', 'Drives: Drive WD_BLACK SN850X 1000GB, Drive WD_BLACK SN850X 1000GB #2']) &&
  await ev('(() => { const L = starterLayout(); return BYKEY.get(L.cells[L.cats[2].cells[0]].key).label; })() === "CPU Package"'), JSON.stringify(intel));
// a laptop: only the CPU's own graphics
await feedCat(
  [['f0000501.0', 'CPU [#0]: Intel Core Ultra 7 155H: Enhanced'], ['e0002000.0', 'GPU [#0]: Intel Arc Graphics'], ['f0000006.0', 'System: ASUS Zenbook 14'], ['hwdeck.0', 'HW Deck']],
  [R(0, 'temp', 'f0000501.0/01000000', 'CPU Package', '°C'), R(0, 'usage', 'f0000501.0/07000000', 'Total CPU Usage', '%'), R(1, 'usage', 'e0002000.0/07000000', 'GPU D3D Usage', '%'), R(2, 'other', 'f0000006.0/08000000', 'Physical Memory Used', 'MB')].concat(hw(3, false)));
const lap = await shape('starterLayout()');
ok('a laptop: its own graphics are the GPU there, only what it has, no empty category', JSON.stringify(lap) === JSON.stringify(['Game: Bottleneck, Game time', 'Arc Graphics: GPU usage', 'Core Ultra 7 155H: CPU temperature, CPU usage', 'Memory: RAM used']), JSON.stringify(lap));
// no HWiNFO: nothing to build
await feedCat([], []);
ok('no readings: no Starter (null), and Saves says it waits for HWiNFO', await ev('starterLayout() === null') && await ev('(() => { renderSaves(); return /HWiNFO/.test(document.querySelector("#sstart").textContent) && document.querySelector("#sstart [data-a=starter]").disabled; })()'), await ev('document.querySelector("#sstart").textContent'));
// a view that couldn't be read (set aside by the host): not a new user, so the note and no Starter over the empty view
await ev(`(() => { onHost({ t: 'state', state: null, slots: [], held: [], stateBad: true, fake: true, version: feed.version, dataDir: feed.dataDir }); return 1; })()`); await p.sleep(400);
ok('a view set aside as unreadable: no Starter built in its place, the note instead', await ev('S.L.cats.length === 0 && $("notice").classList.contains("show")'));
ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
