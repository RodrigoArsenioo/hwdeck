// Redraw flashes (his recording 11-09: a cell's Lines switched Yellow <-> Yellow + Red, "the animation is bugging, and
// cells flash"). Every safe control in Settings, the edit panel (the view, a cell, a category) and the popups is clicked;
// after each click every fade (colour, fill, border, shadow, outline, opacity) on an element that was NOT there before the
// click is a flash (drawn one way, then switched), unless it is one of the intended ones: a pill's glide, the labels
// crossing over with it, a switch, a theme tile's ring, the Look preview's cross-fade, Save fading in. Also: a pick has
// one highlight (the pill), no coloured edge under Yellow / Yellow + Red, and no graph colour the canvas refuses.
// On a fresh folder, Starter loaded:
//   node test/e2e-flash.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9246);
const p = await connect(port), ev = p.evaluate, sleep = p.sleep;
const errs = await p.errors();
const { ok, done } = checks();
const until = async (expr, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const J = async expr => JSON.parse(await ev('JSON.stringify(' + expr + ')'));

await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1423, height: 809, deviceScaleFactor: 1, mobile: false });   // (his window)
ok('the readings come', await until('READ.length > 100 && feed.got', 10000));
await ev(`(() => { loadStarter(); setEdit(false); if (S.motion !== 'full') { S.motion = 'full'; applyMotion(); } return 1; })()`); await sleep(800);
ok('(Starter loaded, Animations Full)', await ev(`document.querySelectorAll('.tile[data-cid]').length > 10 && S.motion === 'full'`));

// the graph colour blend: a weight a little outside 0 to 1 (a frame stamped before its start) still makes a colour
ok('a graph colour from a blend just outside 0 to 1 is still a colour (#rrggbb, each channel 0 to 255)', await ev(`['#000000', '#ffffff', '#101e1e', '#fe0101'].every(a => ['#000000', '#ffffff', '#ff8000'].every(b => [-0.06, -0.001, 1.001, 1.06].every(w => /^#[0-9a-f]{6}$/.test(mixHex(a, b, w))))) && mixHex('#000000', '#ffffff', -0.05) === '#000000' && mixHex('#000000', '#ffffff', 1.05) === '#ffffff'`));

// helpers in the page: mark what exists, list the controls, click one, collect the fades on new elements
await ev(`(() => {
  window.__sw = {};
  const SKIP = /start a session|remove|delete|reset|clear|restart|quit|exit|uninstall|\\bdone\\b|close|export|import|check now|update|install|forget|log ?out|sign|open graphs|send|wake|power|sleep|shut|kill|end session|stop/i;
  __sw.desc = e => { const s = e.closest('[id]'); return (s ? '#' + s.id + ' ' : '') + e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + (e.dataset && (e.dataset.v || e.dataset.k || e.dataset.lk || e.dataset.lay) ? '[' + [e.dataset.lk, e.dataset.lay, e.dataset.k, e.dataset.v].filter(Boolean).join(' ') + ']' : '') + (e.textContent && e.children.length < 3 ? ' "' + e.textContent.trim().slice(0, 24) + '"' : ''); };
  __sw.mark = root => { __sw.old = new WeakSet(); for (const e of root.querySelectorAll('*')) __sw.old.add(e); __sw.old.add(root); };
  __sw.controls = root => [...root.querySelectorAll('.seg > button, .tog2, button.chip, .lk-chip, .lk-t[data-lk], .lk-g button, .rng button, button[data-lay], .gx-per button, .lk-acc, .lk-hx, .gxh-b')]
    .filter(b => b.getClientRects().length && !b.disabled && !SKIP.test(b.textContent + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || '')) && !b.classList.contains('mclose') && !b.closest('#sMotion'));   // (Animations: Off would stop every fade, the rest blind)
  // the intended ones: named, the rest are flashes
  __sw.tag = (t, prop, kf) => t.classList.contains('ind') ? 'pill glide'
    : prop === 'waapi' && t.matches('.seg > button') && kf.some(k => 'color' in k) ? 'labels cross over'
    : t.closest('.tog2') ? 'switch' : t.closest('[data-lk]') ? 'pick ring' : t.closest('#lkPv') ? 'preview cross-fade' : t.closest('.lk-save') ? 'Save fades in'
    : prop === 'waapi' && t.matches('.lk-pop, .lk-fl') ? 'a colour chip\\'s tones unfold' : '';
  __sw.fades = root => { const out = [];
    for (const a of document.getAnimations()) { const t = a.effect && a.effect.target; if (!t || !root.contains(t) || __sw.old.has(t)) continue;
      const prop = a.transitionProperty || (a.animationName ? 'anim:' + a.animationName : 'waapi');
      if (!/color|background|border|shadow|outline|opacity|fill|stroke|anim:|waapi/.test(prop)) continue;
      let kf = []; try { kf = a.effect.getKeyframes(); } catch (e) { }
      const k = prop.startsWith('anim:') || prop === 'waapi' ? '' : prop.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      const from = kf.length && k ? String(kf[0][k]) : '', to = kf.length && k ? String(kf[kf.length - 1][k]) : '';
      if (k && from === to) continue;
      out.push({ el: __sw.desc(t), prop, from, to, tag: __sw.tag(t, prop, kf) }); }
    return out; };
  return 1;
})()`);
const flashes = [], counts = {};
const sweep = async (label, rootSel, prep, max = 60) => {
  await ev(`(() => { if (S.motion !== 'full') { S.motion = 'full'; applyMotion(); } return 1; })()`);
  if (prep) { await ev(prep); await sleep(700); }
  const n = await ev(`(() => { const r = document.querySelector(${JSON.stringify(rootSel)}); return r ? __sw.controls(r).length : 0; })()`).catch(() => 0);
  let clicked = 0;
  for (let i = 0; i < Math.min(n, max); i++) {
    const got = await ev(`(() => { const root = document.querySelector(${JSON.stringify(rootSel)}); if (!root) return null; const cs = __sw.controls(root); const b = cs[${i}]; if (!b) return null;
      const d = __sw.desc(b); __sw.mark(root); b.click(); const f0 = __sw.fades(root);
      return new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => { const f1 = __sw.fades(root), k = x => x.el + x.prop; const seen = new Set(f0.map(k)); r({ d, f: f0.concat(f1.filter(x => !seen.has(k(x)))) }); })), 50)); })()`).catch(e => ({ d: 'error ' + e.message.slice(0, 80), f: [] }));
    if (!got) break; clicked++;
    for (const f of got.f) if (!f.tag) flashes.push(label + ' / ' + got.d + ': ' + f.el + ' ' + f.prop + ' ' + f.from + ' -> ' + f.to);
    await sleep(260);
  }
  counts[label] = clicked;
  return clicked;
};
const shut = async () => { await ev(`(document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')), 1)`); await sleep(400); };

// one highlight on a pick: in Settings (Graph) and in the edit panel (a cell's Lines, his recording)
await ev(`$('setBtn').click(), 1`); await sleep(900);
const oneLit = sel => J(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return null; const b = [...s.querySelectorAll(':scope > button')].find(x => !x.classList.contains('on')); if (!b) return null; b.click();
  const s2 = document.querySelector(${JSON.stringify(sel)}), on = s2.querySelector(':scope > button.on'), ind = s2.querySelector(':scope > .ind');
  return { bg: getComputedStyle(on).backgroundColor, sh: getComputedStyle(on).boxShadow, fades: on.getAnimations().filter(a => a.transitionProperty === 'background-color').length, ind: !!ind && ind.offsetWidth > 0 }; })()`);
const segSel = await ev(`(() => { const s = [...document.querySelectorAll('#setbody .seg.pill')].find(x => x.id && x.id !== 'sMotion' && x.querySelectorAll(':scope > button').length >= 2 && x.getClientRects().length); return s ? '#' + s.id : ''; })()`);
const g1 = segSel && await oneLit(segSel);
ok('Settings: a pick has one highlight, the pill (the picked button no fill of its own, none fading)', !!g1 && g1.ind && g1.fades === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(g1.bg), [segSel, g1]);
await shut();
await ev(`(() => { setEdit(true); const t = [...document.querySelectorAll('.tile[data-cid]')].find(x => /temperature|hotspot/i.test(x.textContent)) || document.querySelector('.tile[data-cid]'); t.click(); return 1; })()`); await sleep(700);
const hasMode = await ev(`!!document.querySelector('#iMode button[data-v="y"]')`);
ok('(the edit panel has a cell\'s Lines: Yellow, Yellow + Red)', hasMode);
const lit = [];
for (const v of ['y', 'yr', 'y', 'yr']) {
  lit.push(await J(`(() => { document.querySelector('#iMode button[data-v="${v}"]').click(); const on = document.querySelector('#iMode > button.on'), ind = document.querySelector('#iMode > .ind');
    return { v: on && on.dataset.v, bg: getComputedStyle(on).backgroundColor, sh: getComputedStyle(on).boxShadow, fades: on.getAnimations().filter(a => a.transitionProperty === 'background-color').length, ind: !!ind && ind.offsetWidth > 0 }; })()`));
  await sleep(350);
}
ok('a cell\'s Lines, Yellow <-> Yellow + Red: picked each time, one highlight (the pill), no fill fading under it', lit.every((x, i) => x.v === ['y', 'yr', 'y', 'yr'][i] && x.ind && x.fades === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(x.bg)), lit);
ok('no coloured edge under the picked Yellow / Yellow + Red', lit.every(x => x.sh === 'none'), lit.map(x => x.sh));
// the labels cross over only when the pick changes; the panel drawn again mid-cross (another control, a message): the
// cross carries on where it was, nothing lights or dims twice
const colA = `(v => { const b = document.querySelector('#iMode > button[data-v="' + v + '"]'); return b ? b.getAnimations().filter(a => !a.transitionProperty && a.effect.getKeyframes().some(k => 'color' in k)).map(a => Math.round(a.currentTime)) : null; })`;
await sleep(500);
const x0 = await J(`(() => { document.querySelector('#iMode button[data-v="y"]').click(); return { y: ${colA}('y'), yr: ${colA}('yr') }; })()`);
ok('a new pick: its label lights and the last one dims, together (one cross each)', x0.y && x0.yr && x0.y.length === 1 && x0.yr.length === 1, x0);
await sleep(120);
const x1 = await J(`(() => { renderInsp(); return { y: ${colA}('y'), yr: ${colA}('yr'), on: document.querySelector('#iMode > button.on').dataset.v }; })()`);
ok('drawn again mid-cross with the same pick: the cross carries on (not started again)', x1.on === 'y' && x1.y.length === 1 && x1.yr.length === 1 && x1.y[0] >= 90 && x1.yr[0] >= 90, x1);
await sleep(450);
const x2 = await J(`(() => { renderInsp(); return { y: ${colA}('y'), yr: ${colA}('yr'), all: [...document.querySelectorAll('#iMode > button')].reduce((n, b) => n + b.getAnimations().length, 0) }; })()`);
ok('drawn again with the same pick, after: nothing fades at all', x2.all === 0, x2);
await ev(`(setEdit(false), 1)`); await sleep(500);

// the sweep
await shut();
await sweep('Settings', '#setbody', `($('setBtn').click(), 1)`, 200);
await shut();
await sweep('Edit: view', '#insp', `(setEdit(true), 1)`);
await sweep('Edit: cell', '#insp', `(() => { const t = [...document.querySelectorAll('.tile[data-cid]')].find(x => /hotspot/i.test(x.textContent)) || document.querySelector('.tile[data-cid]'); t.click(); return 1; })()`);
await sweep('Edit: category', '#insp', `(() => { const h = document.querySelector('.cat .ch, .cathead, .ch'); if (h) h.click(); return 1; })()`);
await ev(`(setEdit(false), 1)`); await sleep(500);
await sweep('Cell popup', '#modal', `(() => { const t = [...document.querySelectorAll('.tile[data-cid]')].find(x => /temperature/i.test(x.textContent)) || document.querySelector('.tile[data-cid]'); t.click(); return 1; })()`, 40);
await shut();
for (const [label, id, btn] of [['Sessions', '#gmodal', 'gamesBtn'], ['Warning history', '#wmodal', 'logBtn']]) {
  const there = await ev(`(() => { const b = document.getElementById(${JSON.stringify(btn)}); if (!b) return false; b.click(); return true; })()`);
  if (there) { await sleep(800); await sweep(label, id, null, 40); }
  await shut();
}
ok('the sweep reached every place (Settings, the edit panel\'s view, cell and category, a cell\'s popup)', counts['Settings'] >= 60 && counts['Edit: view'] >= 5 && counts['Edit: cell'] >= 5 && counts['Edit: category'] >= 1 && counts['Cell popup'] >= 3, counts);
ok('no flash: nothing freshly drawn fades from one look to another, apart from the intended ones', flashes.length === 0, flashes.slice(0, 25));
ok('no page errors (a graph colour the canvas refused, among others)', errs.length === 0, errs.slice(0, 5));
console.log('clicked', JSON.stringify(counts));
p.close();
const all = done(); console.log(all ? 'ALL PASS' : 'SOME FAILED');
process.exit(all ? 0 : 1);
