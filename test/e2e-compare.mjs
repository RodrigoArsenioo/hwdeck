// Compare two game sessions (his 11-09 "it should use the select feature somehow, just not share the same thing", and
// "copy the select style exactly with rounded squares"): Compare is a mode of its own beside Pick, Pick's squares on the
// rows, A then B, a click again lets one go, a third takes B's place, its own bar (A, swap, B, Cancel, Compare); the
// comparison as picked; Back and Escape come back to the mode with A and B kept; Cancel, Escape and closing leave it;
// Pick and Compare exclude each other. Real pointer events. On a folder with sessions of a few games (test/seed-range.mjs):
//   node test/e2e-compare.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9242);
const p = await connect(port), ev = p.evaluate, sleep = p.sleep;
const errs = await p.errors();
const { ok, done } = checks();
const mouse = (type, x, y, extra = {}) => p.cmd('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none', clickCount: 1 }, extra));
const click = async (x, y) => { await mouse('mouseMoved', x, y); await sleep(120); await mouse('mousePressed', x, y, { button: 'left', buttons: 1 }); await sleep(40); await mouse('mouseReleased', x, y, { button: 'left', buttons: 0 }); await sleep(450); };
const at = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); if (!r.width) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const tap = async sel => { const c = await at(sel); if (c) await click(c.x, c.y); return !!c; };
const key = async (k, code, kc) => { await p.key(k, code || k, kc || { Escape: 27 }[k] || 0); await sleep(450); };
const row = i => `#glist .gx-sess[data-g="${i}"] .gx-row .gx-gm`;   // (a click on the session's name)
const st = () => ev(`(() => { const b = $('gcbar'), g = $('gbar'), l = $('glist'), s = sel => [...document.querySelectorAll(sel)].map(e => +e.dataset.g);
  return { mode: PK.g.mode, a: CQ.a, b: CQ.b, list: l.classList.contains('picking') && l.classList.contains('cqmode'), bar: !b.hidden && !b._out, pbar: !g.hidden && !g._out, on: $('gcmpBtn').classList.contains('on'), sel: $('gselBtn').classList.contains('on'),
    ra: s('#glist .gx-sess.cqa'), rb: s('#glist .gx-sess.cqb'), go: !!b.querySelector('[data-pk="cmpgo"]:not(:disabled)'), slots: [...b.querySelectorAll('.cq-s')].map(e => (e.classList.contains('full') ? 'full ' : '') + e.textContent), cmp: gmodal.classList.contains('cmp') }; })()`);

await ev(`(closeDetail(), document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')), S.motion = 'full', applyMotion(), 1)`); await sleep(300);
await ev(`$('gamesBtn').click(), 1`);
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#glist .gx-sess')`)); i++) await sleep(250);
await sleep(600);
ok('Compare is a header button of its own, right before Pick', await ev(`(() => { const c = $('gcmpBtn'); return !!c && c.classList.contains('gxh-b') && c.nextElementSibling === $('gselBtn'); })()`));
ok('the old Compare is gone: none on the rows, none in an open session', await ev(`(() => { const r = document.querySelector('#glist .gx-sess:not(.live) .gx-row'); r.click(); return !document.querySelector('#glist .gx-cq, #glist .gx-cqd'); })()`));
await ev(`(() => { const r = document.querySelector('#glist .gx-sess.open .gx-row'); if (r) r.click(); return 1; })()`); await sleep(400);
const ids = await ev(`gxSs.map((x, i) => [x, i]).filter(([x]) => !x.live && x._raw).slice(0, 3).map(([, i]) => i)`);
ok('there are three sessions to pick from', ids.length === 3, ids);
const k = await ev(`[${ids.join(',')}].map(i => gxKey(gxSs[i]))`);
// in
await tap('#gcmpBtn');
let s = await st();
ok('a click turns Compare on: its button on, Pick\'s squares on the rows, its own bar, not Pick\'s', s.mode === 'cmp' && s.on && !s.sel && s.list && s.bar && !s.pbar, s);
ok('the bar: "Compare", A and B empty, Compare greyed', await ev(`$('gcbar').querySelector('.gb-n').textContent === 'Compare'`) && s.slots.length === 2 && /pick a session/.test(s.slots[0]) && /then another/.test(s.slots[1]) && !s.go, s);
const sq = await ev(`(() => { const c = getComputedStyle(document.querySelector('#glist .gx-sess:not(.live):not(.nopk) .gx-row'), '::before'); return { w: c.width, h: c.height, r: c.borderRadius, b: c.borderTopWidth }; })()`);
ok('the rows\' squares are Pick\'s: 15 px, corners 4 px', sq.w === '15px' && sq.h === '15px' && sq.r === '4px', sq);
// (11-09: a row right under the bar, brought into view as a focus or a key does, stops above the bar: the first click
// of this test once landed on the bar)
const ub = await ev(`(() => { const card = $('glist').closest('.mcard'), st0 = card.scrollTop, bt = $('gcbar').getBoundingClientRect().top, rows = [...document.querySelectorAll('#glist .gx-sess:not(.live) .gx-row')], e = rows.find(r => r.getBoundingClientRect().top > bt) || rows[rows.length - 1];
  card.style.scrollBehavior = 'auto'; card.scrollTop += e.getBoundingClientRect().top - bt - 4;   // (its top 4 px under the bar's)
  const under = e.getBoundingClientRect().top > $('gcbar').getBoundingClientRect().top; e.scrollIntoView({ block: 'nearest' });
  const r = e.getBoundingClientRect(), b = $('gcbar').getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const res = { under, rb: Math.round(r.bottom), bt: Math.round(b.top), hit: !!t && e.contains(t) }; card.scrollTop = st0; card.style.scrollBehavior = ''; return res; })()`);
ok('a row under the bar, brought into view, stops above it and takes the click', ub.under && ub.rb <= ub.bt && ub.hit, ub);
// A, B
await tap(row(ids[0]));
s = await st();
ok('the first click is A: its row filled with "A", its slot in the bar, Compare still greyed', s.a === k[0] && !s.b && s.ra.length === 1 && s.ra[0] === ids[0] && /full A/.test(s.slots[0]) && !s.go, s);
ok('A\'s square is Pick\'s picked square with the letter', await ev(`(() => { const c = getComputedStyle(document.querySelector('#glist .gx-sess.cqa .gx-row'), '::before'); return c.content === '"A"' && c.width === '15px' && c.borderTopLeftRadius === '4px' && c.backgroundColor === 'rgb(230, 230, 230)'; })()`));
await tap(row(ids[1]));
s = await st();
ok('the next is B, and Compare lights up', s.a === k[0] && s.b === k[1] && s.rb[0] === ids[1] && /full B/.test(s.slots[1]) && s.go, s);
await tap(row(ids[0]));
s = await st();
ok('a click on A again lets it go, B stays', !s.a && s.b === k[1] && !s.ra.length && !s.go, s);
await tap(row(ids[0]));
s = await st();
ok('the empty A takes the next click', s.a === k[0] && s.b === k[1], s);
await tap(row(ids[2]));
s = await st();
ok('with both set, another session takes B\'s place', s.a === k[0] && s.b === k[2] && s.rb.length === 1 && s.rb[0] === ids[2], s);
const lv = await ev(`(() => { const e = document.querySelector('#glist .gx-sess.live'); return e ? +e.dataset.g : -1; })()`);
if (lv >= 0) { await tap(row(lv)); s = await st(); ok('the session in progress can\'t be picked', s.a === k[0] && s.b === k[2], s); }
// the keyboard: Space on a focused row
await ev(`document.querySelector('${row(ids[1])}').closest('.gx-row').focus(), 1`);
await key(' ', 'Space', 32);
s = await st();
ok('Space on a focused row picks it as Enter would (B\'s place)', s.b === k[1], s);
// swap
await tap('#gcbar .cq-sw');
s = await st();
ok('the swap in the bar trades A and B, rows and slots', s.a === k[1] && s.b === k[0] && s.ra[0] === ids[1] && s.rb[0] === ids[0], s);
// the comparison, as picked
await tap('#gcbar [data-pk="cmpgo"]'); await sleep(300);
const v = await ev(`({ cmp: gmodal.classList.contains('cmp'), a: gxCmp && gxKey(gxCmp.a), b: gxCmp && gxKey(gxCmp.b), chips: [...document.querySelectorAll('#glist .gx-chip')].map(e => e.dataset.side + ':' + e.textContent), bar: !$('gcbar').hidden && !$('gcbar')._out, on: $('gcmpBtn').classList.contains('on') })`);
ok('Compare opens the comparison of A and B as picked (not by date)', v.cmp && v.a === k[1] && v.b === k[0] && v.chips.length === 2 && v.chips[0].startsWith('a:A') && v.chips[1].startsWith('b:B'), v);
ok('the bar goes, the Compare button stays on', !v.bar && v.on, v);
await tap('#glist .gx-swap'); await sleep(300);
ok('the comparison\'s swap trades them', await ev(`gxKey(gxCmp.a) === ${JSON.stringify(k[0])} && gxKey(gxCmp.b) === ${JSON.stringify(k[1])} && gxCmp.cq === true`));
await tap('#glist .gx-cmpb'); await sleep(300);
s = await st();
ok('Back: the list in Compare again, A and B as they were last (swapped there)', !s.cmp && s.mode === 'cmp' && s.a === k[0] && s.b === k[1] && s.ra[0] === ids[0] && s.rb[0] === ids[1] && s.bar && s.go, s);
// Escape: from the comparison back to the mode, then out
await tap('#gcbar [data-pk="cmpgo"]'); await sleep(300);
await key('Escape');
s = await st();
ok('Escape in the comparison comes back to Compare, A and B kept', !s.cmp && s.mode === 'cmp' && s.a === k[0] && s.b === k[1], s);
await key('Escape'); await sleep(200);
s = await st();
ok('Escape again leaves Compare, Sessions stay open', s.mode === null && !s.on && !s.list && !s.bar && !s.ra.length && !s.rb.length && await ev(`gmodal.classList.contains('open')`), s);
// Cancel
await tap('#gcmpBtn'); await tap(row(ids[0]));
s = await st();
ok('in again: A and B start empty, then A', s.mode === 'cmp' && s.a === k[0] && !s.b, s);
await tap('#gcbar [data-pk="back"]'); await sleep(200);
s = await st();
ok('Cancel leaves Compare: no squares, no bar, the button off', s.mode === null && !s.list && !s.bar && !s.on && !s.ra.length && await ev(`!document.querySelector('#glist .gx-sess[aria-checked], #glist .gx-sess.cqa, #glist .gx-sess.cqb')`), s);
// Pick and Compare exclude each other
await tap('#gcmpBtn'); await tap(row(ids[0]));
await tap('#gselBtn'); await sleep(200);
s = await st();
ok('Pick while in Compare: Pick on, Compare off, Pick\'s bar, not Compare\'s', s.mode === 'sel' && s.sel && !s.on && s.pbar && !s.bar && !s.ra.length && await ev(`!$('glist').classList.contains('cqmode')`), s);
await ev(`(() => { [...document.querySelectorAll('#glist .gx-sess:not(.live):not(.nopk)')].slice(0, 2).forEach(e => pkToggle('g', e)); return 1; })()`); await sleep(300);
ok('two picked in Pick: no Compare in Pick\'s bar', await ev(`PK.g.pick.size === 2 && !$('gbar').querySelector('[data-pk="cmp"], [data-pk="cmpgo"]')`));
await tap('#gcmpBtn'); await sleep(200);
s = await st();
ok('Compare while in Pick: Compare on, Pick off, its own bar, nothing carried over', s.mode === 'cmp' && s.on && !s.sel && s.bar && !s.pbar && !s.a && !s.b && await ev(`PK.g.pick.size === 0 && !document.querySelector('#glist .gx-sess.pk')`), s);
// closing Sessions leaves it
await tap(row(ids[0]));
await tap('.mclose[data-close="gmodal"]'); await sleep(500);   // (its own X, a real click: 11-09 review)
ok('the X shuts Sessions', !(await ev(`gmodal.classList.contains('open')`)));
await ev(`$('gamesBtn').click(), 1`);
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#glist .gx-sess')`)); i++) await sleep(250);
await sleep(500);
s = await st();
ok('Sessions closed and opened again: out of Compare', s.mode === null && !s.on && !s.bar && !s.list && !s.ra.length, s);
// motion off: the same, at once
await ev(`(S.motion = 'off', applyMotion(), 1)`); await sleep(200);
await tap('#gcmpBtn'); await tap(row(ids[0])); await tap(row(ids[1]));
await tap('#gcbar .cq-sw');
ok('motion off: the bar is there at once and the swap runs no animation', await ev(`!$('gcbar').hidden && $('gcbar').getAnimations({ subtree: true }).length === 0 && CQ.a === ${JSON.stringify(k[1])}`));
await tap('#gcbar [data-pk="back"]');
ok('motion off: Cancel hides the bar at once', await ev(`$('gcbar').hidden && PK.g.mode === null`));
await ev(`(S.motion = 'full', applyMotion(), 1)`);
ok('no page errors', errs.length === 0, errs);
{ const all = done(); console.log(all ? 'ALL PASS' : 'SOME FAILED'); p.close(); process.exit(all ? 0 : 1); }
