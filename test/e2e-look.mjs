// The Look page (his round 5, OK 11-09 04:55): the preview of his window on the left, every theme on the right by colour
// as tall as it (Saved first, a dropdown that jumps, never filters), Save beside the dropdown; the accent's box beside
// Mono / Accent / Spectrum; under Spectrum the palette dropdown and a row per category, the colour editor floating over
// them; his own looks saved, renamed, deleted after asking, up to 12. Nothing moves when the editor opens or Save comes.
// Real pointer events where a person would point. On a fresh folder:
//   node test/e2e-look.mjs [port]
import { connect, checks } from './cdp.mjs';

const port = Number(process.argv[2] || 9246);
const p = await connect(port), ev = p.evaluate, sleep = p.sleep;
const errs = await p.errors();
const { ok, done } = checks();
const until = async (expr, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const J = async expr => JSON.parse(await ev('JSON.stringify(' + expr + ')'));
const center = expr => ev(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 22) }; })()`);
const move = (x, y) => p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const tile = id => `document.querySelector('#lkThL [data-lk="theme"][data-k="${id}"]')`;
const intoView = async expr => { await ev(`(() => { const e = ${expr}, l = $('lkThL'); if (!e) return 0; const r = e.getBoundingClientRect(), lr = l.getBoundingClientRect(); l.scrollTop += r.top - lr.top - 40; return 1; })()`); await sleep(250); };
const clickOn = async expr => { const c = await center(expr); if (!c) return false; await p.click(c.x, c.y); await sleep(400); return true; };
const head = () => ev(`document.querySelector('.lk-th-h small').textContent`);
const jumpBtn = () => ev(`$('lkJump').nextElementSibling.textContent`);
const savedN = () => ev(`S.lookSaved.length`);
const rects = sel => J(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(); })`);

ok('the readings come', await until('READ.length > 100 && feed.got', 10000));
await ev(`(() => { loadStarter(); setEdit(false); S.motion = 'full'; applyMotion(); S.lookSaved = []; return 1; })()`); await sleep(800);
await ev(`$('setBtn').click(), 1`); await sleep(1300);

// ---- the theme row ----
const g = await J(`(() => { const pv = $('lkPv').getBoundingClientRect(), l = $('lkThL').getBoundingClientRect(), dd = document.querySelector('.lk-th-h .lk-dd').getBoundingClientRect(), tg = [...document.querySelectorAll('#lkThL .lk-tg')].map(x => x.getBoundingClientRect().right);
  return { pt: pv.top, pb: pv.bottom, lt: l.top, lb: l.bottom, dr: dd.right, gr: Math.max(...tg), dw: dd.width, sb: getComputedStyle($('lkThL')).scrollbarWidth, ar: pv.width / pv.height, win: innerWidth / innerHeight }; })()`);
ok('preview and list: top and bottom flush, the tiles end at the dropdown\'s right edge, the dropdown 300 px, no bar, the preview the window\'s shape', Math.abs(g.pt - g.lt) < 0.2 && Math.abs(g.pb - g.lb) < 0.2 && Math.abs(g.dr - g.gr) < 0.6 && Math.abs(g.dw - 300) < 0.6 && g.sb === 'none' && Math.abs(g.ar - g.win) < 0.02, g);
ok('the preview: his window in his look (Classic), nothing under it', await until(`$('lkPv').querySelectorAll('.lk-pvh').length === 1 && pvKey.includes('"theme":"classic"')`, 3000) && await ev(`!document.querySelector('.lk-th-w + small, .lk-pv + small, .lk-pv figcaption')`));
ok('the preview is a copy of the view in a shadow root: none of its ids reach the page', await ev(`(() => { const h = $('lkPv').querySelector('.lk-pvh'); return !!h && !!h.shadowRoot && !!h.shadowRoot.querySelector('#view .tile') && document.querySelectorAll('#view').length === 1; })()`));
const fams = await J(`[...$('lkThL').querySelectorAll('section')].map(s => s.dataset.f)`);
ok('every theme, by colour, Saved first with its + slot', fams[0] === 'Saved' && fams.length >= 9 && await ev(`document.querySelectorAll('#lkThL [data-lk="theme"]').length === Object.keys(THEME_PRESETS).length && !!document.querySelector('#lkThL section[data-f="Saved"] .lk-add')`), fams);
ok('opened at his theme\'s colour: the dropdown says it, his theme in view and marked', await jumpBtn() === 'Greys' && await ev(`(() => { const t = ${tile('classic')}, l = $('lkThL').getBoundingClientRect(), r = t.getBoundingClientRect(); return t.classList.contains('on') && t.getAttribute('aria-pressed') === 'true' && r.top >= l.top - 1 && r.bottom <= l.bottom + 1; })()`), await jumpBtn());
// the jump: through the dropdown as a person picks it; it scrolls, it does not filter
const jb = await center(`$('lkJump').nextElementSibling`); await p.click(jb.x, jb.y); await sleep(350);
ok('the dropdown: Saved, then each colour', (await J(`[...document.querySelectorAll('.dsel-m button')].map(b => b.textContent)`)).join() === fams.join());
const bl = await center(`[...document.querySelectorAll('.dsel-m button')].find(b => b.textContent === 'Blues')`); await p.click(bl.x, bl.y);
ok('Blues: the list glides there, every theme still in it, the dropdown says Blues', await until(`Math.abs($('lkThL').scrollTop - $('lkThL').querySelector('section[data-f="Blues"]').offsetTop) < 1.5`, 2500) && await jumpBtn() === 'Blues' && await ev(`document.querySelectorAll('#lkThL [data-lk="theme"]').length === Object.keys(THEME_PRESETS).length`), await ev(`$('lkThL').scrollTop`));
await ev(`(() => { const l = $('lkThL'); l.scrollTop = l.querySelector('section[data-f="Greens"]').offsetTop + 30; return 1; })()`); await sleep(400);
ok('scrolled by hand: the dropdown follows the colour at the top', await jumpBtn() === 'Greens', await jumpBtn());
ok('more below: the list\'s bottom edge fades', await ev(`$('lkThL').classList.contains('lk-more') && getComputedStyle($('lkThL')).maskImage !== 'none'`));
await ev(`(() => { const l = $('lkThL'); l.scrollTop = l.scrollHeight; return 1; })()`); await sleep(300);
ok('at the very bottom: no fade', await ev(`!$('lkThL').classList.contains('lk-more')`));
await ev(`(() => { S.motion = 'off'; applyMotion(); const s = $('lkJump'); s.value = 'Pinks'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
ok('animations Off: the jump at once', await ev(`Math.abs($('lkThL').scrollTop - $('lkThL').querySelector('section[data-f="Pinks"]').offsetTop) < 1.5`));
await ev(`(() => { S.motion = 'full'; applyMotion(); return 1; })()`);
// a theme pointed at: the preview shows it, a cross-fade; gone from the list, his own again
await intoView(tile('sunset'));
const su = await center(tile('sunset')); await move(su.x, su.y);
ok('a theme pointed at: the preview shows his window in it, cross-faded', await until(`pvKey.includes('"theme":"sunset"')`, 2000) && await ev(`$('lkPv').querySelectorAll('.lk-pvh').length >= 1`) && await until(`$('lkPv').querySelectorAll('.lk-pvh').length === 1`, 1000));
ok('the preview in Sunset: its background, its categories in its own palette\'s colours', await ev(`(() => { const r = $('lkPv').querySelector('.lk-pvh').shadowRoot.querySelector('.pvr'); return r.dataset.tint === 'spectrum' && r.style.getPropertyValue('--bg') === THEME_PRESETS.sunset.base && [...r.querySelectorAll('.dcat[data-cat]')].some(d => Object.values(PALETTES.t_sunset[1]).includes(d.style.getPropertyValue('--cc'))); })()`));
await move(5, 5);
ok('out of the list: his own look again', await until(`pvKey.includes('"theme":"classic"')`, 2000) && await ev(`S.look.theme === 'classic'`));
// a pick
await intoView(tile('graphite')); await clickOn(tile('graphite'));
ok('a theme clicked: picked, marked, the head says it', await ev(`S.look.theme === 'graphite' && ${tile('graphite')}.classList.contains('on')`) && await head() === 'Graphite', await head());

// ---- Save, your own looks ----
ok('as it comes: no Save', await ev(`!document.querySelector('.lk-save')`));
const before = await rects('.lk-th-h .lk-dd, #lkPv, #lkThL, .lk-colr, #sTint');
await ev(`(() => { $('sTint').querySelector('[data-v="accent"]').click(); return 1; })()`); await sleep(400);
ok('changed: Save beside the dropdown, the head says "changed", nothing moved', await ev(`!!document.querySelector('.lk-th-r > .lk-save + .lk-dd')`) && await head() === 'Graphite, changed' && JSON.stringify(await rects('.lk-th-h .lk-dd, #lkPv, #lkThL, .lk-colr, #sTint')) === JSON.stringify(before), await head());
await clickOn(`document.querySelector('.lk-save')`);
ok('Save: in Saved, as "Graphite", picked, the head says its name, no Save', await savedN() === 1 && await ev(`S.lookSaved[0].name === 'Graphite' && S.look.from === S.lookSaved[0].id && !S.look.changed && !document.querySelector('.lk-save') && document.querySelector('#lkThL .lk-sv').classList.contains('on')`) && await head() === 'Graphite', await head());
// rename: a double-click on its name, Enter keeps, Escape leaves
const nm = `document.querySelector('#lkThL .lk-sv .lk-tn')`;
await intoView(nm);
let c = await center(nm); await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 }); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 2 }); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 2 }); await sleep(300);
ok('a double-click on its name: a field with the name, all of it picked', await ev(`(() => { const i = document.querySelector('#lkThL .lk-rn'); return !!i && document.activeElement === i && i.value === 'Graphite' && i.selectionStart === 0 && i.selectionEnd === 8; })()`));
await p.type('Desk'); await p.key('Enter', 'Enter', 13); await sleep(400);
ok('Enter keeps it: "Desk", in the head too', await ev(`S.lookSaved[0].name === 'Desk'`) && await head() === 'Desk', await head());
c = await center(nm); await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 2 }); await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 2 }); await sleep(300);
await p.type('Nope'); await p.key('Escape', 'Escape', 27); await sleep(400);
ok('Escape leaves it as it was, and Settings stays open', await ev(`S.lookSaved[0].name === 'Desk' && !document.querySelector('#lkThL .lk-rn') && $('setmodal').classList.contains('open')`));
// changed again: Save updates that one, no new one
await ev(`(() => { $('sTint').querySelector('[data-v="spectrum"]').click(); return 1; })()`); await sleep(400);
ok('changed again: "Desk, changed"', await head() === 'Desk, changed');
await clickOn(`document.querySelector('.lk-save')`);
ok('Save: that saved look updated, no second one', await savedN() === 1 && await ev(`S.lookSaved[0].look.tint === 'spectrum' && !S.look.changed`));
await ev('undo(), 1'); await sleep(400);
ok('an undo after Save: the look before it, "Desk, changed", Save there again', await head() === 'Desk, changed' && await ev(`!!document.querySelector('.lk-save')`), await head());
await ev('redo(), 1'); await sleep(400);
ok('redo: as saved, no Save', await head() === 'Desk' && await ev(`!document.querySelector('.lk-save')`), await head());
// the + slot: always a new one, named after the one it came from
await intoView(`document.querySelector('#lkThL .lk-add')`); await clickOn(`document.querySelector('#lkThL .lk-add')`);
ok('the + slot: a new one, "Desk 2", last before the slot', await savedN() === 2 && await ev(`S.lookSaved[1].name === 'Desk 2' && document.querySelector('#lkThL section[data-f="Saved"] .lk-tg').lastElementChild.classList.contains('lk-add')`));
// a saved look picked from another theme
await ev(`pickTheme('oled'), 1`); await sleep(300);
await intoView(`document.querySelector('#lkThL .lk-sv .lk-tb')`); await clickOn(`document.querySelector('#lkThL .lk-sv .lk-tb')`);
ok('a saved look clicked: it comes back (Graphite, Spectrum), marked, the head says its name', await ev(`S.look.theme === 'graphite' && S.look.tint === 'spectrum' && S.look.from === S.lookSaved[0].id && document.querySelector('#lkThL .lk-sv').classList.contains('on')`) && await head() === 'Desk', await head());
// delete: its x, a question, Delete
await intoView(`document.querySelectorAll('#lkThL .lk-sv')[1]`);
const sv1 = await center(`document.querySelectorAll('#lkThL .lk-sv .lk-tb')[1]`); await move(sv1.x, sv1.y); await sleep(250);
ok('its x shows on hover', await ev(`getComputedStyle(document.querySelectorAll('#lkThL .lk-sv .lk-x')[1]).opacity === '1'`));
await clickOn(`document.querySelectorAll('#lkThL .lk-sv .lk-x')[1]`);
ok('the x asks first: "Delete Desk 2?", nothing more', await ev(`cmodal.classList.contains('open') && $('ctitle').textContent === 'Delete Desk 2?' && $('cdesc').textContent === '' && $('cyes').textContent === 'Delete'`) && await savedN() === 2);
await clickOn(`$('cno')`);
ok('Cancel: still there', await savedN() === 2 && await ev(`!cmodal.classList.contains('open')`));
await intoView(`document.querySelectorAll('#lkThL .lk-sv')[1]`); await move((await center(`document.querySelectorAll('#lkThL .lk-sv .lk-tb')[1]`)).x, (await center(`document.querySelectorAll('#lkThL .lk-sv .lk-tb')[1]`)).y); await sleep(250);
await clickOn(`document.querySelectorAll('#lkThL .lk-sv .lk-x')[1]`); await clickOn(`$('cyes')`);
ok('Delete: gone', await savedN() === 1 && await ev(`document.querySelectorAll('#lkThL .lk-sv').length === 1`));
// up to 12, then the + slot goes
await ev(`(() => { for (let i = 0; i < 14; i++) lookSave(true); return 1; })()`); await sleep(300);
ok('up to 12: the + slot goes', await savedN() === 12 && await ev(`!document.querySelector('#lkThL .lk-add')`));
await ev(`(() => { S.lookSaved = S.lookSaved.slice(0, 1); lookApplySaved(S.lookSaved[0].id); renderSettings(); return 1; })()`); await sleep(300);

// ---- the colours ----
await ev(`(() => { const c = $('setmodal').querySelector('.mcard'), r = document.querySelector('.lk-colr'); c.scrollTop += r.getBoundingClientRect().top - c.getBoundingClientRect().top - 40; return 1; })()`); await sleep(300);
const g2 = await J(`(() => { const a = document.querySelector('.lk-acc').getBoundingClientRect(), s = $('sTint').getBoundingClientRect(), i = document.querySelector('.lk-acc i').getBoundingClientRect(); return { h: a.height - s.height, gap: s.left - a.right, w: a.width, il: i.left - a.left, ir: a.right - i.right, it: i.top - a.top, ib: a.bottom - i.bottom }; })()`);
ok('the accent\'s box: as tall as the control, 10 px before it, 30 wide, its swatch in the middle', Math.abs(g2.h) < 0.5 && Math.abs(g2.gap - 10) < 0.6 && Math.abs(g2.w - 30) < 0.6 && Math.abs(g2.il - g2.ir) < 0.6 && Math.abs(g2.it - g2.ib) < 0.6, g2);
const rowsBefore = await rects('.lk-cr, .lk-palh');
await clickOn(`document.querySelector('.lk-acc')`);
ok('the accent\'s editor floats under its row, at the right; nothing under it moves', await ev(`(() => { const f = document.querySelector('.lk-colr > .lk-fl'), r = document.querySelector('.lk-colr').getBoundingClientRect(); if (!f) return false; const fr = f.getBoundingClientRect(); return getComputedStyle(f).position === 'absolute' && Math.abs(fr.right - r.right) < 1.5 && fr.top >= r.bottom; })()`) && JSON.stringify(await rects('.lk-cr, .lk-palh')) === JSON.stringify(rowsBefore));
await p.key('Escape', 'Escape', 27); await sleep(300);
ok('Escape shuts it, Settings stays', await until(`!document.querySelector('.lk-fl')`, 1000) && await ev(`$('setmodal').classList.contains('open')`));
// a category's own colour: Custom, from the palette it was; Save keeps it with the look
const cat1 = await ev(`lkCats()[1].id`);
await clickOn(`document.querySelector('.lk-hx[data-k="${cat1}"]')`);
ok('a category\'s swatch: its editor floats under its row; nothing moves', await ev(`!!document.querySelector('.lk-rows > .lk-fl')`) && JSON.stringify(await rects('.lk-cr, .lk-palh')) === JSON.stringify(rowsBefore));
const tone = await ev(`document.querySelectorAll('.lk-fl .lk-pop .lk-g button')[7].dataset.c`);
await clickOn(`document.querySelectorAll('.lk-fl .lk-pop .lk-g button')[7]`);
ok('a tone picked: Custom, from its palette, the squares its colours, Save comes; nothing moves', await ev(`$('lkPal').value === '__custom' && $('lkPal').nextElementSibling.textContent.startsWith('Custom') && /^Custom, from /.test(document.querySelector('.lk-palh small').textContent) && !!document.querySelector('.lk-save') && lkCats()[1].col === ${JSON.stringify(tone)}`) && JSON.stringify(await rects('.lk-cr, .lk-palh')) === JSON.stringify(rowsBefore), await ev(`document.querySelector('.lk-palh small').textContent`));
await ev(`lkPickSet(null), 1`); await sleep(300);
await ev(`(() => { const c = $('setmodal').querySelector('.mcard'); c.scrollTop = 0; return 1; })()`); await sleep(200);
await clickOn(`document.querySelector('.lk-save')`);
ok('Save: the saved look keeps the category\'s colour', await ev(`S.lookSaved[0].cols[${JSON.stringify(cat1)}] === ${JSON.stringify(tone)} && !document.querySelector('.lk-save')`));
await ev(`(() => { pickTheme('classic'); for (const c of S.L.cats) delete c.col; renderSettings(); return 1; })()`); await sleep(300);
await ev(`lookApplySaved(S.lookSaved[0].id), 1`); await sleep(300);
ok('the saved look picked again: its category\'s colour too', await ev(`lkCats()[1].col === ${JSON.stringify(tone)} && S.look.from === S.lookSaved[0].id`));
// the corners and the outline's strength
await ev(`(() => { lkCells = true; renderSettings(); return 1; })()`); await sleep(400);
await ev(`(() => { const r = $('lkr-rad'); r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); r.value = 11; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return 1; })()`); await sleep(300);
ok('corners dragged to 11: held at the old Normal (10), in px on the cells', await ev(`S.look.rad === 10 && Math.abs(parseFloat(getComputedStyle(document.querySelector('#view .tile')).borderTopLeftRadius) - 10 * parseFloat(getComputedStyle(document.documentElement).fontSize) / 13) < 0.6`), await ev(`[S.look.rad, getComputedStyle(document.querySelector('#view .tile')).borderTopLeftRadius]`));
await ev(`(() => { const r = $('lkr-rad'); r.value = 20; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await sleep(300);
ok('corners 20 px', await ev(`S.look.rad === 20 && $('lkr-rad').nextElementSibling.textContent === '20 px'`));
await ev(`(() => { const r = $('lkr-rad'); r.value = 10; r.dispatchEvent(new Event('input', { bubbles: true })); r.focus(); return 1; })()`); await sleep(200);
await p.key('ArrowRight', 'ArrowRight', 39); await sleep(300);
ok('corners by the keys: a step off a detent stays (11), and is read out', await ev(`S.look.rad === 11 && $('lkr-rad').getAttribute('aria-valuetext') === '11 px'`), await ev('S.look.rad'));
await ev(`(() => { const r = $('lkr-lineA'); r.value = 160; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await sleep(300);
ok('the outline\'s strength: brighter lines', await ev(`S.look.lineA === 160 && lineOf(S.look) !== lineOf(Object.assign({}, S.look, { lineA: 100 }))`));
await ev(`pickTheme('classic'), 1`); await sleep(300);
ok('a theme picked: its own corners and outline again, Classic plain', await ev(`S.look.rad === undefined && S.look.lineA === undefined && lookPlain() === true`), await ev(`JSON.stringify(S.look)`));
await ev(`(() => { const l = $('lkThL'); l.scrollTop = l.querySelector('section[data-f="Pinks"]').offsetTop; return 1; })()`); await sleep(300);
await ev(`(() => { $('setmodal').classList.remove('open'); return 1; })()`); await sleep(700);
await ev(`$('setBtn').click(), 1`); await sleep(1000);
ok('shut and opened again: at his theme\'s colour, his theme in view, not where the list was left', await jumpBtn() === 'Greys' && await ev(`(() => { const t = ${tile('classic')}, l = $('lkThL').getBoundingClientRect(), r = t.getBoundingClientRect(); return r.top >= l.top - 1 && r.bottom <= l.bottom + 1; })()`), await jumpBtn());
ok('no page errors', errs.length === 0, errs);
p.close();
const all = done(); console.log(all ? 'ALL PASS' : 'SOME FAILED');
process.exit(all ? 0 : 1);
