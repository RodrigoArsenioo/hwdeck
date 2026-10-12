// A game's own readings in Grid (1.3): min, average and max of this game session (while the game is in front) instead
// of HWiNFO's since it started (0 and thousands of fps from the desktop). On made-up data with a made-up game.
// Start a fresh copy first (an EMPTY data folder):
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9238
//   HWDeck.exe --fake 300 --data test\data-gs
// then: node test/e2e-gamestats.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9238);
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const game = (name, front) => E(`send(${JSON.stringify({ t: 'fakeGame', game: name, front })})`);

ok('catalog arrives', await until('READ.length > 200 && feed.got'), await E('READ.length'));
await game(null);
const keys = await E(`(() => { const pm = READ.filter(r => isPM(r)).slice(0, 2), o = READ.find(r => r.t === 'temp');
  const L = { v: 1, cats: [{ id: 'g', name: 'Game', cells: ['f0', 'f1', 't'] }], cells: { f0: { key: pm[0].key, graph: true }, f1: { key: pm[1].key, graph: true }, t: { key: o.key, graph: true } } };
  S.L = cleanLayout(L); S.edit = false; app.classList.remove('editing'); showScreen('grid', true); afterChange(); return pm.map(r => r.key); })()`);
ok('made-up data has PresentMon readings', keys.length === 2, JSON.stringify(keys));
await p.sleep(2000);
const row = cid => E(`(() => { const tr = document.querySelector('#view tr.dc[data-cid="${cid}"]'); return { mn: tr.children[2].textContent, mx: tr.children[3].textContent, av: tr.children[4].textContent, title: tr.children[2].title }; })()`);
let a = await row('f0');
ok('no game: the game readings show no min, max, average (HWiNFO\'s mean nothing for them)', a.mn === '' && a.mx === '' && a.av === '' && /game session/.test(a.title), JSON.stringify(a));
const t0 = await row('t');
ok('any other reading keeps HWiNFO\'s own', t0.mn !== '' && t0.mx !== '', JSON.stringify(t0));
await game('Stat Game', true);
ok('a game in front: this session\'s numbers arrive', await until(`feed.gs && Array.isArray(feed.gs[${JSON.stringify(keys[0])}])`, 10000), await E('JSON.stringify(feed.gs)'));
await p.sleep(4000);
const gs = await E(`feed.gs[${JSON.stringify(keys[0])}]`);
a = await row('f0');
const fmt = await E(`(() => { const r = BYKEY.get(${JSON.stringify(keys[0])}), c = S.L.cells.f0, d = decOfCell(c, r); return [fmtV(feed.gs[${JSON.stringify(keys[0])}][0], d, r), fmtV(feed.gs[${JSON.stringify(keys[0])}][2], d, r), fmtV(feed.gs[${JSON.stringify(keys[0])}][1], d, r)]; })()`);
ok('Grid shows this session\'s min, max and average', a.mn === fmt[0] && a.mx === fmt[1] && a.av === fmt[2], JSON.stringify({ a, fmt }));
ok('min <= average <= max, all above 0', gs[0] > 0 && gs[0] <= gs[1] && gs[1] <= gs[2], JSON.stringify(gs));
ok('and says so', /This game session/.test(a.title), a.title);
const rd = await E(`(() => { const r = BYKEY.get(${JSON.stringify(keys[0])}); return [r.mn, r.mx]; })()`);
ok('not HWiNFO\'s own', !(Math.abs(rd[0] - gs[0]) < 1e-9 && Math.abs(rd[1] - gs[2]) < 1e-9), JSON.stringify({ hwinfo: rd, session: gs }));
// in the background nothing is added: the numbers stay as they were
await game('Stat Game', false); await p.sleep(1500);
const bg0 = await E(`JSON.stringify(feed.gs)`); await p.sleep(3000);
ok('in the background: nothing added', await E(`JSON.stringify(feed.gs)`) === bg0);
await game(null);
ok('the game ends: the numbers go', await until('!feed.gs', 45000), await E('JSON.stringify(feed.gs)'));
a = await row('f0');
ok('and Grid is empty there again', a.mn === '' && a.av === '', JSON.stringify(a));
ok('no page errors', errs.length === 0, JSON.stringify(errs));
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
p.close(); process.exit(0);
