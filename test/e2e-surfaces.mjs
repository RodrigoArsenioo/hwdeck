// Every surface in every look (his 11-09 "themes are not applying correctly to other windows making them look ugly. THIS
// WAS NOT PROPERLY TESTED", and "if a theme is choosen you need to stick to the theme, cant go for any gray/black things
// anywhere"; his call: surfaces, not text). Sessions, Warning history, Settings, a cell's popup, Saves, a confirm, and
// edit mode with a tile selected (its panel and the title bar), each opened once and walked in EVERY theme there is
// (however many THEME_PRESETS holds), with the popups as View and as Cells (Settings > Look > Popups), plus two themes as
// people change them (Mono, Accent): no background, border or shadow in a plain grey when the look's cells aren't grey
// (a shadow's black is depth; previews of other themes and colour swatches show what they show). Classic as Cells: the
// greys of before, exactly. View: the card is the look's background, fades included. On a folder seeded with sessions
// and warnings (test/seed-range.mjs):
//   node test/e2e-surfaces.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9244);
const p = await connect(port), ev = p.evaluate, sleep = p.sleep;
const errs = await p.errors();
const { ok, done } = checks();

await ev(`(closeDetail(), document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')), S.motion = 'off', applyMotion(), 1)`); await sleep(300);
const themes = await ev(`Object.keys(THEME_PRESETS)`);
const isGrey = await ev(`JSON.stringify(Object.fromEntries(Object.keys(THEME_PRESETS).map(k => { const s = solidOf(cleanLook(Object.assign({ theme: k }, THEME_PRESETS[k]))); const c = [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)); return [k, Math.max(...c) - Math.min(...c) <= 2]; })))   // (grey: its cells' channels within 2 of each other, Smoke's #111112 too, 11-09)`).then(JSON.parse);
ok('Classic, OLED and Soft are grey themes, Sunset and Aurora are not', isGrey.classic && isGrey.oled && isGrey.soft && !isGrey.sunset && !isGrey.aurora, isGrey);

// the walk: every visible element under a root, its background, borders (drawn ones) and shadows; a plain grey up to
// #9a9a9a is a find (11-09 review: #6a6a6a and #8a8a8a borders slipped under the first #606060), unless it is depth (a
// black shadow) or shows a colour on purpose (a preview, a swatch, a call)
const WALK = `(root => { const out = []; if (!root) return ['(nothing to walk)']; const grey = c => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/.exec(c); if (!m) return null; const a = m[4] === undefined ? 1 : +m[4]; return m[1] === m[2] && m[2] === m[3] && a > 0.05 && +m[1] <= 0x9a ? c : null; };
  // (bars that are data, not surfaces: the week's days, a game's share, the range bar's window. His pick D, 11-09: the
  // look's colour under Accent and Spectrum; Mono keeps them grey, as its graphs)
  const mono = S.look.tint === 'none';
  const skip = e => e.closest('.th-pv, .bg-mini, .lk-dots, .lk-prev, .gx-leg, .b-gpu, .b-cpu, .b-cap, .xpins') || (e.style && (e.style.getPropertyValue('--c') || e.style.background || e.style.backgroundColor)) || (mono && e.matches('.gx-wd i, .gx-gbar span, .mbar i'));
  for (const e of [root, ...root.querySelectorAll('*')]) { if (!e.getClientRects().length || skip(e)) continue; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const hit = [];
    const bg = grey(cs.backgroundColor); if (bg) hit.push('bg ' + bg);
    for (const s of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none') { const b = grey(cs['border' + s + 'Color']); if (b) hit.push('border ' + b); }
    if (cs.boxShadow !== 'none') for (const m of cs.boxShadow.matchAll(/rgba?\\([^)]*\\)/g)) { const g = grey(m[0]); if (g && !/^rgba?\\(0, 0, 0/.test(m[0])) hit.push('shadow ' + g); }
    const nm = x => x.id ? '#' + x.id : x.tagName.toLowerCase() + (x.className && typeof x.className === 'string' && x.className.trim() ? '.' + x.className.trim().split(/\\s+/).join('.') : '');
    if (hit.length) out.push((e.id || (typeof e.className === 'string' && e.className.trim()) || !e.parentElement ? '' : nm(e.parentElement) + ' > ') + nm(e) + ' ' + [...new Set(hit)].join(', ')); }
  return out; })`;
const walk = sel => ev(`(${WALK})(document.querySelector(${JSON.stringify(sel)}))`);
const look = (t, pops, tint) => ev(`(() => { pickTheme(${JSON.stringify(t)}); S.look = Object.assign({}, S.look, { pops: ${JSON.stringify(pops)} }, ${JSON.stringify(tint || '')} ? { tint: ${JSON.stringify(tint || '')} } : {}); applyLook(); return S.look.theme; })()`);
const shut = async () => { await ev(`(() => { if (cmodal.classList.contains('open')) closeConfirm(); closeDetail(); if (gxCmp) gxCmpEnd(); if (PK.g.mode) pkMode('g', null); $('app').classList.remove('nocats'); if (S.edit && document.querySelector('.app.editing')) setEdit(false); document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); return 1; })()`); await sleep(300); };
// Sessions open with its list drawn
const sessions = async () => { await ev(`$('gamesBtn').click(), 1`); for (let i = 0; i < 30 && !(await ev(`!!document.querySelector('#glist .gx-sess')`)); i++) await sleep(200); };
// two sessions picked in Compare (A and B) or one in Pick: through the row toggles, as a click does
const pickRows = n => ev(`(() => { const r = [...document.querySelectorAll('#glist .gx-sess:not(.live):not(.nopk)')]; for (let i = 0; i < ${n} && i < r.length; i++) pkToggle('g', r[i]); return 1; })()`);
// the themes as they come, and two as people change them: Sunset in Mono (no accent tokens set), Aurora in Accent. With
// 48 themes (11-09) every one in every window takes a quarter of an hour: two of each family by default (a grey written
// into the CSS shows in any coloured look; the tokens are each look's own sums), every one with SURF_ALL=1
const fams = await ev(`JSON.stringify(Object.fromEntries(Object.keys(THEME_PRESETS).map(k => [k, THEME_PRESETS[k].fam || ''])))`).then(JSON.parse);
const per = {}, pickT = process.env.SURF_ALL ? themes : themes.filter((t, i) => { if (t === 'classic') return true; const f = fams[t] || 'n' + Math.floor(i / 4); per[f] = (per[f] || 0) + 1; return per[f] <= 2; });   // (Classic always: its "as before" checks)
const LOOKS = pickT.map(t => [t, '', t]).concat([['sunset', 'none', 'sunset in Mono'], ['aurora', 'accent', 'aurora in Accent']].filter(x => themes.includes(x[0])));
console.log('looks walked: ' + LOOKS.map(x => x[2]).join(', '));
// each window, opened as a person would, and what to walk in it (it stays open while every look is walked)
const WINDOWS = [
  ['Sessions', async () => { await ev(`$('gamesBtn').click(), 1`); for (let i = 0; i < 30 && !(await ev(`!!document.querySelector('#glist .gx-sess')`)); i++) await sleep(200);
    await ev(`(() => { const r = document.querySelector('#gmodal .gx-srow'); if (r && r.getAttribute('aria-expanded') !== 'true') r.click(); return 1; })()`); await sleep(500); return ['#gmodal .mcard']; }],
  ['Warning history', async () => { await ev(`$('logBtn').click(), 1`); await sleep(700);
    await ev(`(() => { const r = document.querySelector('#wmodal .gx-srow'); if (r && r.getAttribute('aria-expanded') !== 'true') r.click(); return 1; })()`); await sleep(500); return ['#wmodal .mcard']; }],
  ['Settings', async () => { await ev(`$('setBtn').click(), 1`); await sleep(600); return ['#setmodal .mcard']; }],
  ['a cell\'s popup', async () => { await ev(`(openDetail(Object.keys(S.L.cells)[0]), 1)`); await sleep(700); return ['#modal .mcard']; }],
  ['Saves', async () => { await ev(`$('savesBtn').click(), 1`); await sleep(500); return ['#smodal .mcard']; }],
  ['a confirm', async () => { await ev(`(askConfirm('Delete it?', '', 'Delete', () => {}), 1)`); await sleep(400); return ['#cmodal .mcard']; }],
  ['edit mode (the panel and the title bar)', async () => { await ev(`(() => { setEdit(true); const c = document.querySelector('#view .tile[data-cid]'); if (c) selectCell(c.dataset.cid); return 1; })()`); await sleep(800); return ['#insp', '.tbar']; }],
  // (11-09 review: the states the first walk never opened)
  ['Compare (A and B picked, its bar)', async () => { await sessions(); await ev(`$('gcmpBtn').click(), 1`); await sleep(300); await pickRows(2); await sleep(400); return ['#gmodal .mcard']; }],
  ['a comparison', async () => { await sessions(); await ev(`$('gcmpBtn').click(), 1`); await sleep(300); await pickRows(2); await sleep(300);
    await ev(`($('gcbar').querySelector('[data-pk="cmpgo"]').click(), 1)`); for (let i = 0; i < 20 && !(await ev(`gmodal.classList.contains('cmp')`)); i++) await sleep(200); await sleep(400); return ['#gmodal .mcard']; }],
  ['Pick (one picked, its bar)', async () => { await sessions(); await ev(`$('gselBtn').click(), 1`); await sleep(300); await pickRows(1); await sleep(400); return ['#gmodal .mcard']; }],
  ['edit mode (the view and the new category box)', async () => { await ev(`(() => { setEdit(true); $('app').classList.add('nocats'); return 1; })()`); await sleep(800); return ['#view', '#newcat']; }],
];
const CLASSIC = [   // Classic as Cells: the greys of before (deck.css before 11-09)
  ['#gmodal .mcard', 'backgroundColor', 'rgb(21, 21, 21)'], ['#gmodal .gx-sess:not(.open)', 'backgroundColor', 'rgb(23, 23, 23)'], ['#gmodal .gx-sess:not(.open)', 'borderTopColor', 'rgb(31, 31, 31)'],
  ['#gmodal .gx-day', 'backgroundColor', 'rgb(21, 21, 21)'], ['#gmodal .gx-per', 'backgroundColor', 'rgb(21, 21, 21)'], ['#gmodal .gx-per', 'borderTopColor', 'rgb(36, 36, 36)'],
];
const bad = [];   // (one line per window: the looks it fails in, so a new theme that breaks shows by name)
let seenFades = false, walks = 0;
for (const [name, open] of WINDOWS) {
  await shut(); await look('classic', 'view');
  const roots = await open(); await sleep(150);
  const fails = [], seen = new Map();   // (each element and colour once, with the first look it showed in: every one is listed)
  for (const [t, tint, label] of LOOKS) for (const pops of ['view', 'cells']) {
    await look(t, pops, tint); await sleep(90);
    let found = []; for (const r of roots) found = found.concat(await walk(r)); walks++;
    if (!isGrey[t] && found.length) { fails.push(label + '/' + pops); for (const f of found) { const k = f.replace(/rgba?\([^)]*\)/g, 'c'); if (!seen.has(k)) seen.set(k, label + '/' + pops + ': ' + f); } }
    if (label === 'classic' && pops === 'cells' && name === 'Sessions') for (const [sel, prop, want] of CLASSIC) { const got = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e)[${JSON.stringify(prop)}] : null; })()`); ok('Classic as before: ' + sel + ' ' + prop, got === want, got); }
    if (label === 'classic' && pops === 'view' && name === 'Sessions') { const got = await ev(`[getComputedStyle(document.querySelector('#gmodal .mcard')).backgroundColor, getComputedStyle(document.querySelector('#gmodal .gx-sess:not(.open)')).backgroundColor]`); ok('Classic as View: the card is the view\'s #0d0d0d, the sessions the cells\' #151515', got[0] === 'rgb(13, 13, 13)' && got[1] === 'rgb(21, 21, 21)', got); }
    if (pops === 'view' && name === 'Sessions' && !isGrey[t]) { const bi = await ev(`getComputedStyle(document.querySelector('#gmodal .mcard')).backgroundImage`); if (/radial-gradient/.test(bi)) seenFades = true; }
  }
  ok(name + ': no grey surface in any coloured look (' + LOOKS.length + ' looks x 2 popups)', fails.length === 0, fails.length ? fails.length + ' looks: ' + [...seen.values()].slice(0, 12).join(' | ') : []);
  if (fails.length) bad.push(name);
}
await shut();
ok('walked every window in every look', walks === WINDOWS.length * LOOKS.length * 2, walks);
ok('View: the card shows the look\'s fades', seenFades);
const g = await ev(`(() => { pickTheme('sunset'); applyLook(); return [gv('#1e1e1e'), getComputedStyle(document.documentElement).getPropertyValue('--g1e').trim()]; })()`);
ok('a drawn grey and its token are the look\'s too (Sunset: not #1e1e1e)', g[0] !== '#1e1e1e' && g[0] === g[1], g);
const gc = await ev(`(() => { pickTheme('classic'); applyLook(); return [gv('#1e1e1e'), gv('#0f0f0f'), getComputedStyle(document.documentElement).getPropertyValue('--g55').trim(), getComputedStyle(document.documentElement).getPropertyValue('--g8a').trim()]; })()`);
ok('Classic keeps them exactly', gc[0] === '#1e1e1e' && gc[1] === '#0f0f0f' && gc[2] === '#555555' && gc[3] === '#8a8a8a', gc);
const any = await ev(`(() => { const L = cleanLook({ theme: 'classic', base: '#101820', cell: '#203040', op: 70, fades: [{ at: 'tl', c: '#30a0ff', size: 70, a: 30 }], changed: true }); const t = gToks(L); return Object.values(t).every(c => /^#[0-9a-f]{6}$/.test(c)) && t['--g1e'] !== '#1e1e1e' && t['--g15'] === solidOf(L); })()`);
ok('a look of your own (any base, cells and opacity) gets every token, its cells\' colour at #151515\'s place', any);
// (OLED, his pick C 11-09: near-black cells step their greys from a #0d0d0d floor; the view stays black; cells above the
// floor, Classic's and Carbon's, exactly as they were)
const ol = await ev(`(() => { const r = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), o = {};
  pickTheme('oled'); applyLook(); o.oled = [r('--g15'), r('--g17'), r('--g2a'), getComputedStyle(document.body).backgroundColor];
  if (THEME_PRESETS.carbon) { pickTheme('carbon'); applyLook(); o.carbon = r('--g15'); }
  pickTheme('classic'); applyLook(); o.classic = r('--g15'); return JSON.stringify(o); })()`).then(JSON.parse);
ok('OLED: cards #0d0d0d, rows #0f0f0f, lines #232323, the view still black; Classic and Carbon as they were', ol.oled[0] === '#0d0d0d' && ol.oled[1] === '#0f0f0f' && ol.oled[2] === '#232323' && ol.oled[3] === 'rgb(0, 0, 0)' && ol.classic === '#151515' && (ol.carbon === undefined || ol.carbon === '#0e0e0e'), ol);
// (his pick D, 11-09: the popups' graphs in the game's colour under Spectrum, the accent under Accent, none in Mono)
const gcol = await ev(`(() => { const r = () => getComputedStyle(document.documentElement).getPropertyValue('--gc').trim(), o = {};
  pickTheme('sunset'); applyLook(); o.spec = [r(), gameTint() || PALETTES[S.look.pal][1].game];
  S.look = Object.assign({}, S.look, { tint: 'accent' }); applyLook(); o.acc = [r(), S.look.acc];
  S.look = Object.assign({}, S.look, { tint: 'none' }); applyLook(); o.mono = r();
  pickTheme('classic'); applyLook(); return JSON.stringify(o); })()`).then(JSON.parse);
ok('the popups\' graph colour: Spectrum the game\'s, Accent the accent, Mono none', gcol.spec[0] === gcol.spec[1] && gcol.acc[0] === gcol.acc[1] && gcol.mono === '', gcol);
// (a day's band stuck at the top: marked, and the fade under it shows; his "a line where it's NOT supposed to be one")
await shut(); await look('sunset', 'cells'); await sessions(); await sleep(400);
const st = await ev(`(async () => { const c = $('glist').closest('.mcard'), days = [...c.querySelectorAll('.gx-day')]; if (days.length < 3) return { n: days.length };
  c.style.scrollBehavior = 'auto'; const d = days[2]; c.scrollTop += d.getBoundingClientRect().top - c.getBoundingClientRect().top + 60;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); await new Promise(r => setTimeout(r, 250));
  const on = [...c.querySelectorAll('.gx-day.stuck')], ct = c.getBoundingClientRect().top + c.clientTop;
  const res = { n: days.length, stuck: on.length, atTop: on.length === 1 && Math.abs(on[0].getBoundingClientRect().top - ct) < 1.5, fade: on.length ? getComputedStyle(on[0], '::after').opacity : null };
  c.scrollTop = 0; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); res.back = c.querySelectorAll('.gx-day.stuck').length; c.style.scrollBehavior = ''; return res; })()`);
ok('a scrolled list: exactly the band stuck on top is marked, its fade shows; scrolled back, none', st.stuck === 1 && st.atTop && st.fade === '1' && st.back === 0, st);
await shut(); await look('classic', 'cells');
// (11-09: popups as Cells unless View was picked; Warm is gone, a saved Warm opens as Caramel, changed or not)
const dflt = await ev(`JSON.stringify([cleanLook({}).pops, cleanLook({ pops: 'view' }).pops, cleanLook({ pops: 'x' }).pops])`).then(JSON.parse);
ok('popups: Cells by default, View when picked', dflt[0] === 'cells' && dflt[1] === 'view' && dflt[2] === 'cells', dflt);
const wm = await ev(`JSON.stringify([cleanLook({ theme: 'warm', base: '#120e0b', cell: '#1a1612', changed: false, tint: 'accent' }), cleanLook({ theme: 'warm', base: '#123456', cell: '#234567', changed: true })].map(l => [l.theme, l.base, l.cell, l.changed]).concat([[THEME_PRESETS.caramel.base]]))`).then(JSON.parse);
ok('a saved Warm opens as Caramel: as it comes, or with its own colours when changed', wm[0][0] === 'caramel' && wm[0][1] === wm[2][0] && wm[1][0] === 'caramel' && wm[1][1] === '#123456' && wm[1][3] === true, wm);
// (11-09, the final themes: the 13 the swarm cut open as Classic, as do ids no theme has; his own look stays his)
const cut = await ev(`JSON.stringify(['ingot', 'berry-dusk', 'bullion', 'no-such-theme'].map(k => { const l = cleanLook({ theme: k, base: '#201010', cell: '#301818', changed: false, tint: 'spectrum' }); return [l.theme, l.base === THEME_PRESETS.classic.base]; }).concat([[Object.keys(THEME_PRESETS).length, Object.keys(THEME_PRESETS).every(k => !!PALETTES['t_' + k] && (k === 'classic' ? THEME_PRESETS[k].pal === 'muted' : THEME_PRESETS[k].pal === 't_' + k))]]))`).then(JSON.parse);
ok('the final themes: each with its own palette (Classic still Muted); a cut one or an unknown one opens as Classic', cut.slice(0, 4).every(x => x[0] === 'classic' && x[1]) && cut[4][0] >= 100 && cut[4][1] === true, cut);
await look('classic', 'view');
ok('no page errors', errs.length === 0, errs);
p.close();
const all = done(); console.log(all ? 'ALL PASS' : 'SOME FAILED');
process.exit(all ? 0 : 1);
