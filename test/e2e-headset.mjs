// The headset (11-13, from HW Dashboard): HW Deck's own readings for a SteelSeries Arctis Nova Pro Wireless base
// station and a LIGHTSPEED mouse, only once found; the Headset cell; in its popup the base station's screen (its page
// built from rows of pieces, the start up / shut down animations, the switch, off to start).
// A --fake copy has no devices: with HWDECK_FAKEHS=1 it makes up a found headset and mouse (nothing is sent anywhere).
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9243
//   (set HWDECK_FAKEHS=1)  HWDeck.exe --fake 300 --data test\data-hs --no-starter
// then: node test/e2e-headset.mjs [port] [dataDir] [none]   ("none": the copy runs without the made-up headset)
// (11-15: the Headset editor's own checks are the release checks' since its 11-14 revamp; this keeps the readings,
// the cell, its popup, Customize at Headset, Screen's pick, a restart and a copy without a headset)
// Run a second time on the same data folder (the copy started again), it checks what must survive a restart: the saved
// page under its name, the page still from it.
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9243);
const data = process.argv[3] || 'test/data-hs';
const none = process.argv[4] === 'none' || /hs0$/.test(data);   // (the runner passes no 4th argument: its data folder says which)
const again = !none && existsSync(join(data, 'e2e-hs.ran'));   // (the first run left its mark: the copy started again)
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x), J = async x => JSON.parse(await ev(`JSON.stringify(${x})`));
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(400); };

ok('catalog arrives', await until('feed.got && READ.length > 100', 15000), await ev('READ.length'));
if (none) {
  await p.sleep(2500);
  ok('no headset: none of its readings in the list, nothing about it in the tick', await ev('!BYKEY.has(HSK_HEAD) && !BYKEY.has(HSK_SPARE) && !BYKEY.has(HSK_MOUSE) && !feed.hs'), await J('[BYKEY.has(HSK_HEAD), feed.hs]'));
  await ev('(() => { $("setBtn").onclick(); return 1; })()'); await p.sleep(800);
  ok('no headset: Settings has no Headset section, and no Look section any more', await ev(`!!document.querySelector('#setbody .setsec') && !document.querySelector('#setbody .hs-sec, #setbody #hsxAt, #setbody #lkThL')`));
  await ev('(() => { document.querySelector("#setmodal .mclose").click(); return 1; })()'); await p.sleep(700); await ev('(() => { $("czBtn").click(); return 1; })()');
  await until(`setmodal.classList.contains('open')`, 3000); await p.sleep(600);
  ok('no headset: the Customize button opens Look alone, titled "Look", no tabs; the rows at the left, the picture over the tiles at the right', await ev(`setmodal.classList.contains('open') && setmodal.classList.contains('cz') && $('settitle').textContent === 'Look' && !document.querySelector('#czTabs button') && !!document.querySelector('#setbody .cz-l .cz-rows') && !!document.querySelector('#setbody .cz-r #lkPv') && !!document.querySelector('#setbody .cz-r #lkThL')`), await J(`({ title: $('settitle').textContent, open: setmodal.classList.contains('open'), tabs: document.querySelectorAll('#czTabs button').length, pvIn: ($('lkPv') || { parentNode: null }).closest ? $('lkPv').closest('.cz-l, .cz-r').className : null })`));
  ok('no page errors', errs.length === 0, errs);
  console.log(done() ? 'ALL PASS' : 'SOME FAILED');
} else if (again) {
  // ---- after a restart of the copy: found again, its readings, Customize at Headset ----
  ok('found again', await until('BYKEY.has(HSK_HEAD) && !!feed.hs', 8000));
  ok('after a restart: its readings still there', await until('BYKEY.get(HSK_HEAD).v === 62 && BYKEY.get(HSK_SPARE).v === 100', 6000) || await ev('BYKEY.has(HSK_HEAD) && BYKEY.has(HSK_SPARE)'));
  await ev('(() => { S.motion = "off"; applyMotion(); hsOpenSettings(); return 1; })()');
  ok('after a restart: Customize opens at Headset with its picture', await until(`setmodal.classList.contains('cz') && CZ.tab() === 'hs' && !!document.querySelector('#setbody .cz-hs .hsx .hs-pv canvas')`, 8000), await ev('CZ.tab()'));
  ok('no page errors', errs.length === 0, errs);
  console.log(done() ? 'ALL PASS' : 'SOME FAILED');
} else {
  ok('found: its two readings under HW Deck, no mouse (HW Dashboard only, his 11-13)', await until('BYKEY.has(HSK_HEAD) && BYKEY.has(HSK_SPARE)', 8000) && await ev('!BYKEY.has(HSK_MOUSE)'), await ev('READ.length'));
  const rd = await J(`[HSK_HEAD, HSK_SPARE].map(k => { const r = BYKEY.get(k); return [r.label, r.unit, r.kind || null, SENS[r.s].name]; })`);
  ok('"Headset battery" (kind headset), "Spare headset battery", %, sensor "HW Deck"', JSON.stringify(rd) === JSON.stringify([['Headset battery', '%', 'headset', 'HW Deck'], ['Spare headset battery', '%', null, 'HW Deck']]), rd);
  ok('its part: none (no game colour under Spectrum)', await ev('partOf({ key: HSK_HEAD }) === null && partOf({ key: HSK_SPARE }) === null'));
  ok('the tick says found, the screen off', await until('!!feed.hs && feed.hs.there === true && feed.hs.on === false', 5000), await ev('JSON.stringify(feed.hs)'));

  // the cell
  await ev('(() => { addKeys([HSK_HEAD], null, null, "Other"); setEdit(false); showScreen("tiles"); S.motion = "off"; applyMotion(); return 1; })()');
  await p.sleep(2500);
  const cid = await ev(`Object.keys(S.L.cells).find(id => S.L.cells[id].key === HSK_HEAD)`);
  const el = `document.querySelector('#view .tile[data-cid="${cid}"]')`;
  ok('the made-up values once its cell is there: 62, 100 (the spare streams with the headset)', await until('BYKEY.get(HSK_HEAD).v === 62 && BYKEY.get(HSK_SPARE).v === 100', 6000), await J('[HSK_HEAD, HSK_SPARE].map(k => BYKEY.get(k).v)'));
  ok('its cell: named Headset, 62 %, "spare 100%" under it', await until(`/^Headset 62 ?% spare 100%$/.test(${el}.innerText.replace(/\\s+/g, ' ').trim())`, 6000), await ev(`${el}.innerText.replace(/\\s+/g, ' ').trim()`));

  // its popup: a way to Settings, where the base station's screen is (his 11-13 "move it to the settings")
  await ev(`(() => { openDetail(${JSON.stringify(cid)}); return 1; })()`);
  ok('its popup: an "Open in Settings" button, no editor', await until(`!!document.querySelector('#mextra .hs-go [data-hs-open]') && !document.querySelector('#setbody .hsx')`, 6000), await ev(`(document.querySelector('#mextra') || {}).innerHTML.slice(0, 200)`));
  await click('#mextra [data-hs-open]');
  ok('Customize opens at Headset: the screen part arrives (page, picture, start up and shut down), the tabs say Look and Headset', await until(`!!document.querySelector('#setmodal.open.cz #setbody .cz-hs .hsx .hs-pv canvas') && document.querySelectorAll('#setbody .hsx [data-hsx="anim"]').length === 18`, 8000) &&
    await ev(`[...document.querySelectorAll('#czTabs button')].map(b => b.textContent + (b.classList.contains('on') ? '*' : '')).join(',') === 'Look,Headset*' && $('settitle').textContent === 'Customize'`), await ev(`[...document.querySelectorAll('#czTabs button')].map(b => b.textContent).join(',')`));
  // Screen: a --fake copy has no base station, the pick is kept in memory only
  await click('#setbody .hsx #hsg-screen [data-hsv="base"]');
  await p.sleep(2600);
  ok('Original picked: the feed says so, not Custom', await ev('feed.hs.base === true && feed.hs.on === false'));
  try { writeFileSync(join(data, 'e2e-hs.ran'), '1'); } catch { }
  ok('no page errors', errs.length === 0, errs);
  console.log(done() ? 'ALL PASS' : 'SOME FAILED');
}
p.close(); process.exit(0);
