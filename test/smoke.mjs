// A quick look at everything: builds a sample layout on made-up data (--fake), then screenshots each view, the cell
// popup, the hover preview and the other popups into test/out, and lists any page errors.
//   node test/smoke.mjs [port]
import { connect } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
const port = Number(process.argv[2] || 9230);
mkdirSync('test/out', { recursive: true });
const p = await connect(port);
const errs = await p.errors();
await p.cmd('Page.reload'); await p.sleep(2500);
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
await until('READ.length > 0');
// a layout: per sensor kind a category, gates on temperatures, a fan on a curve, a predicted fan
await E(`(() => {
  const by = t => READ.filter(r => r.t === t);
  addKeys(by('temp').slice(0, 5).map(r => r.key), null, null, 'Temperatures');
  addKeys(by('power').slice(0, 3).map(r => r.key).concat(by('usage').slice(0, 2).map(r => r.key)), null, null, 'Power and load');
  addKeys(by('fan').slice(0, 3).map(r => r.key), null, null, 'Fans');
  addKeys(READ.filter(r => r.unit === 'FPS').slice(0, 2).map(r => r.key).concat(by('clock').slice(0, 2).map(r => r.key)), null, null, 'Frames and clocks');
  const t = S.L.cats[0].cells; S.L.cells[t[0]].gates = { mode: 'yr', dir: 'above', y: 55, r: 70, hold: 1 }; S.L.cells[t[1]].gates = { mode: 'y', dir: 'above', y: 200, r: NaN, hold: 1 };
  const f = S.L.cats[2].cells[0]; S.L.cells[f].curve = { src: READ.find(r => r.t === 'temp').key, pts: [[30, 600], [50, 900], [70, 1300], [85, 1800]], tol: 12, hold: 2 };
  sel = null; afterChange(); return S.L.cats.length;
})()`);
await p.sleep(400); await E('$("addPred").click()'); await p.sleep(3500);
for (const v of ['tiles', 'overview', 'grid']) { await E(`showScreen('${v}')`); await p.sleep(900); await p.shot('test/out/edit-' + v + '.png'); }
await E('setEdit(false)');
for (const v of ['tiles', 'overview', 'grid']) { await E(`showScreen('${v}')`); await p.sleep(1200); await p.shot('test/out/live-' + v + '.png'); }
await E(`showScreen('tiles')`); await p.sleep(1000);
const c = await p.centerOf('document.querySelectorAll("#view .dc")[2]');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await p.sleep(900); await p.shot('test/out/hover.png');
await E('openDetail(S.L.cats[2].cells[0])'); await p.sleep(1200); await p.shot('test/out/popup-fan.png');
await E('closeDetail(); openDetail(S.L.cats[0].cells[0])'); await p.sleep(900);
await E(`document.querySelector('#mrng button[data-r="1h"]').click()`); await p.sleep(1500); await p.shot('test/out/popup-1h.png');
await E('closeDetail(); $("savesBtn").click()'); await p.sleep(700); await p.shot('test/out/saves.png');
await E('$("smodal").classList.remove("open"); $("logBtn").click()'); await p.sleep(1200); await p.shot('test/out/warnings.png');
await E('$("wmodal").classList.remove("open"); $("gamesBtn").click()'); await p.sleep(900); await p.shot('test/out/games.png');
await E('$("gmodal").classList.remove("open"); $("setBtn").click()'); await p.sleep(700); await p.shot('test/out/settings.png');
await E('$("setmodal").classList.remove("open")');
console.log('fit font', await E('document.documentElement.style.fontSize'), 'cells', await E('E.size'), 'warnings drawn', await E('document.querySelectorAll("#view .tile.yellow, #view .tile.red").length'));
console.log(errs.length ? 'PAGE ERRORS:\n' + errs.join('\n---\n') : 'no page errors');
p.close();
