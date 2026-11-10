// The look (Settings > Look, 11-02; the themes 11-05): a theme to start from (Classic, OLED: true black with the cells
// as lines only, Soft, and five with colour), the background (a base, a fade on any edge or corner), the cells (fill,
// opacity, outline, corners) and the colour (Mono, Accent, Spectrum; Match from the background), switched live, saved,
// kept after a reload; a look saved before the themes opens as its theme. Accent's colour is yours (a
// swatch or any colour); Spectrum gives each category its part's colour (a mix stays grey) or yours (kept with the
// layout, undone like any change, Auto takes it back), on its name, icons and graphs, in all three views; a warning
// still shows through every look. Also: Tab walks nothing, no focus rings, and every hover text is the page's own tip
// (no title left for Windows to show). The colours (11-09, no fold): a row of chips, the accent's then each category's,
// each opening 24 tones under it, a hex field and the full picker, Auto for a category; under Spectrum the palettes as
// cards above them. On Starter's layout (loaded here), a fresh folder:
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9238
//   HWDeck.exe --fake 300 --data test\data-th --no-starter
// then: node test/e2e-themes.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9238);
const data = process.argv[3] || 'test/data-th';
let p = await connect(port);
let errs = await p.errors();
const { ok, done } = checks();
const ev = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await p.sleep(150); } return false; };
const BOM = String.fromCharCode(0xfeff);
const state = () => { try { const t = readFileSync(join(data, 'state.json'), 'utf8'); return JSON.parse(t.startsWith(BOM) ? t.slice(1) : t); } catch (e) { return null; } };
const click = async sel => { const c = await p.center(sel); if (!c) return false; await p.click(c.x, c.y); await p.sleep(350); return true; };
const reload = async () => {
  await ev('location.reload(); 1').catch(() => {});
  p.close(); await new Promise(r => setTimeout(r, 1500));
  p = await connect(port); errs = await p.errors();
  return until('feed.got && READ.length > 0 && S.L.cats.length > 0', 10000);
};
const css = (sel, prop, pseudo) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e${pseudo ? ', ' + JSON.stringify(pseudo) : ''})[${JSON.stringify(prop)}] : null; })()`);
// (a colour the way the page computes it: color-mix and all)
const asColour = c => ev(`(() => { const d = document.createElement('div'); d.style.backgroundColor = ${JSON.stringify(c)}; document.body.appendChild(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; })()`);
const rgb = h => 'rgb(' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
const pick = async (row, v) => { await click('#' + row + ' button[data-v="' + v + '"]'); await p.sleep(250); };
const look = () => ev('S.look.theme + "/" + document.documentElement.dataset.tint');
const th = k => '#setbody .lk-t[data-lk="theme"][data-k="' + k + '"]';
const thOn = () => ev('(() => { const b = document.querySelector("#setbody .lk-t[data-lk=theme].on"); return b ? b.dataset.k : ""; })()');
const foldsShut = () => ev('(() => { lkBg = lkCells = false; renderSettings(); return 1; })()');
// Spectrum's colours, by Starter's categories: the game, the GPU, the CPU, memory, drives, fans
const WANT = ['#a99bdc', '#74c69d', '#7fa6e8', '#4fb8ad', '#8fa0c8', '#6cc8d8'];
const ccs = () => ev('S.L.cats.map(c => { const e = document.querySelector("#view .dcat[data-cat=\\"" + c.id + "\\"]"); return e ? e.style.getPropertyValue("--cc") : "?"; }).join()');
const ccOf = i => ev(`(() => { const c = S.L.cats[${i}], e = c && document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); return e ? e.style.getPropertyValue('--cc') : '?'; })()`);
const graphsIn = `S.L.cats.map((c, i) => [...document.querySelectorAll('#view .dcat[data-cat="' + c.id + '"] canvas')].map(cv => graphs.get(cv)).filter(G => G && G.col).map(G => G.col))`;
const graphsOf = (i, col) => until(`(${graphsIn})[${i}].length === 0 || (${graphsIn})[${i}].some(x => x === ${JSON.stringify(col)})`, 4000);
// a colour's chip in Colours (the accent's: 'acc', a category's: its id), its colour, and its tones opened
const chip = k => 'document.querySelector(' + JSON.stringify(k === 'acc' ? '#setbody .lk-acc' : ['base', 'cell', 'fade'].includes(k) ? '#setbody .lk-chip[data-k="' + k + '"]' : '#setbody .lk-hx[data-k="' + k + '"]') + ')';   // (11-09: the accent's box, a category's swatch on its row)
const chipC = k => ev('(() => { const c = ' + chip(k) + ', i = c && (c.classList.contains("lk-chip") ? c : c.querySelector("i")); return i ? i.style.getPropertyValue("--c") : null; })()');
const openChip = async k => { await clickAt(chip(k)); return until('!!document.querySelector("#setbody .lk-pop")', 2000); };
const tonesIn = 'document.querySelectorAll("#setbody .lk-pop .lk-g button")';
const ccList = 'S.L.cats.map(c => { const e = document.querySelector(\'#view .dcat[data-cat="\' + c.id + \'"]\'); return e ? e.style.getPropertyValue("--cc") : "?"; }).join()';
const clickAt = async expr => { const c = await p.centerOf(expr); if (!c) return false; await p.click(c.x, c.y); await p.sleep(350); return true; };

ok('the readings come', await until('READ.length > 300 && feed.got', 10000), await ev('READ.length'));
await ev('(() => { loadStarter(); setEdit(false); return 1; })()'); await p.sleep(800);
ok('(Starter loaded: six categories, in view mode)', await ev('S.L.cats.length === 6 && !S.edit'), await ev('S.L.cats.map(c => c.name).join()'));
ok('a new view: Classic, Mono, nothing saved for it', await look() === 'classic/none' && await css('#view .tile', 'backgroundColor') === 'rgb(21, 21, 21)' && !!state() && state().look === undefined);
const r0 = parseFloat(await css('#view .tile', 'borderTopLeftRadius'));

// ---- Settings: Look, its rows ----
await click('#setBtn');
ok('Settings has Look: Theme (every one there is, Classic on), Background and Cells folded, Colour (Mono, Accent, Spectrum), no Cards', await ev('[...document.querySelectorAll("#setbody .lk-t[data-lk=theme] .lk-tn")].map(b => b.textContent).sort().join() === Object.values(THEME_PRESETS).map(x => x.name).sort().join() && !!THEME_PRESETS.classic && !!document.querySelector("#setbody .lk-head[data-f=bg]:not(.open)") && !!document.querySelector("#setbody .lk-head[data-f=cells]:not(.open)") && [...document.querySelectorAll("#sTint button")].map(b => b.textContent).join() === "Mono,Accent,Spectrum" && $("sTint").querySelector(".on").dataset.v === "none" && !document.getElementById("sCards")') && await thOn() === 'classic');
ok('Mono: the accent\'s box folded away (no width, not seen, off for the keys), no palette', await ev('(() => { const a = document.querySelector("#setbody .lk-acc"); return !!a && a.disabled && a.getBoundingClientRect().width < 0.5 && getComputedStyle(a).visibility === "hidden" && a.getAnimations().length === 0 && !document.querySelector("#setbody .lk-rows") && !document.getElementById("lkPal"); })()'));
ok('Mono: a switch that is on is light on dark, no blue', await css('#sClock', 'backgroundColor') === 'rgb(208, 208, 208)' && await css('#sClock', 'backgroundColor', '::after') === 'rgb(22, 22, 22)', await css('#sClock', 'backgroundColor') + ' ' + await css('#sClock', 'backgroundColor', '::after'));

// ---- the themes ----
await click(th('oled'));
ok('OLED: true black, the cells drawn as lines only, at once', await look() === 'oled/none' && await css('body', 'backgroundColor') === 'rgb(0, 0, 0)' && await css('#view .tile', 'backgroundColor') === 'rgba(0, 0, 0, 0)' && await css('#view .tile', 'borderTopColor') === 'rgb(38, 38, 38)', await css('#view .tile', 'backgroundColor') + ' ' + await css('#view .tile', 'borderTopColor'));
await p.key('z', 'KeyZ', 90, 2); await p.sleep(300);
ok('Ctrl+Z with Settings open: Classic again, its card marked', await look() === 'classic/none' && await thOn() === 'classic', await look());
await p.key('y', 'KeyY', 89, 2); await p.sleep(300);
ok('Ctrl+Y: OLED again', await look() === 'oled/none' && await thOn() === 'oled');
ok('OLED: the Theme row says it', await ev('/OLED/.test(document.querySelector("#setbody .th-row small").textContent)'));
await p.sleep(700);
ok('saved with the view', !!state() && state().look && state().look.theme === 'oled' && state().look.tint === 'none', JSON.stringify(state() && state().look));
ok('a look saved before the themes opens as its theme with its colour (Outline as OLED, Soft, Standard as Classic)', await ev('cleanLook({ cards: "outline", tint: "accent" }).theme === "oled" && cleanLook({ cards: "outline", tint: "accent" }).tint === "accent" && cleanLook({ cards: "soft" }).theme === "soft" && cleanLook({ cards: "nope" }).theme === "classic" && cleanLook({ acc: "red" }).acc === ACC0 && (l => l.theme === "classic" && l.base === "#0d0d0d" && l.cell === "#151515" && l.op === 100 && l.acc === "#82664a" && l.pal === "fire" && !l.changed)(cleanLook({ cards: "standard", tint: "none", acc: "#82664a", pal: "fire" }))'));
await click(th('soft'));
ok('Soft: no line, a lighter cell, a shadow, rounder', await look() === 'soft/none' && await css('#view .tile', 'borderTopColor') === 'rgba(0, 0, 0, 0)' && await css('#view .tile', 'backgroundColor') === await ev('(c => "rgb(" + [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)).join(", ") + ")")(THEME_PRESETS.soft.cell)') && await css('#view .tile', 'boxShadow') !== 'none' && parseFloat(await css('#view .tile', 'borderTopLeftRadius')) > r0, r0 + ' ' + await css('#view .tile', 'borderTopLeftRadius'));
// a warning shows through every theme (the yellow and red borders beat a theme's line)
const warnBorders = await ev(`(() => { const t = document.querySelector('#view .tile'), out = {}, was = S.look; t.style.transition = 'none';
  for (const k of Object.keys(THEME_PRESETS)) { S.look = cleanLook({ theme: k }); applyLook(); t.classList.add('yellow'); out[k] = getComputedStyle(t).borderTopColor; t.classList.remove('yellow'); t.classList.add('red'); out[k] += ' ' + getComputedStyle(t).borderTopColor; t.classList.remove('red'); }
  S.look = was; applyLook(); t.style.transition = ''; return JSON.stringify(out); })()`);
ok('a yellow or red tile keeps its border in every theme', Object.values(JSON.parse(warnBorders)).every(v => v === 'rgb(92, 79, 29) rgb(107, 32, 32)'), warnBorders);

// ---- the background and the cells (11-05) ----
await click(th('classic'));
await click('#setbody .lk-head[data-f="bg"]');
ok('Background opens: a small screen with a point on each edge and corner, the base on its chip, no fade yet', await until('!!document.querySelector("#setbody .lk-head[data-f=bg].open")', 2000) && await ev('document.querySelectorAll("#setbody .bg-h").length === 8 && !document.querySelector("#setbody .bg-h.f") && !document.querySelector("#setbody .bg-fh")') && await chipC('base') === '#0d0d0d');
await click('#setbody .bg-h[data-at="b"]');
ok('a point clicked: a fade there, picked, on the view at once, the theme now changed', await ev('S.look.fades.length === 1 && S.look.fades[0].at === "b" && S.look.changed && document.querySelector("#setbody .bg-h[data-at=b]").classList.contains("on") && !!document.querySelector("#setbody .bg-fh")') && /radial-gradient/.test(await css('body', 'backgroundImage')) && await ev('/Classic, changed/.test(document.querySelector("#setbody .th-row small").textContent)'), await css('body', 'backgroundImage'));
const u1 = await ev('undoStack.length');
await ev('(() => { const r = document.querySelector("#setbody .lk-rng[data-k=a]"); r.value = 60; r.dispatchEvent(new Event("input", { bubbles: true })); r.value = 62; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
ok('its strength dragged: taken, one undo step for the whole drag', await ev('S.look.fades[0].a === 62') && await ev('undoStack.length') === u1 + 1, await ev('S.look.fades[0].a'));
await ev('undo(); 1'); await p.sleep(300);
ok('undo: the strength before', await ev('S.look.fades[0].a === 30'));
// (by the keys: a change each press, one undo step once they stop, 11-06)
await p.sleep(200);
const u2 = await ev('undoStack.length');
await ev('(() => { const r = document.querySelector("#setbody .lk-rng[data-k=a]"); for (const v of [31, 32, 33]) { r.value = v; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); } return 1; })()'); await p.sleep(900);
ok('its strength by the keys: one undo step once they stop', await ev('S.look.fades[0].a === 33') && await ev('undoStack.length') === u2 + 1, await ev('[S.look.fades[0].a, undoStack.length]'));
await ev('undo(); 1'); await p.sleep(300);
await openChip('fade');
await clickAt(tonesIn + '[2]');
ok('the fade\'s colour from its chip', await ev('S.look.fades[0].c === TONES.flat()[2]'), await ev('S.look.fades[0].c'));
await click('#setbody .bg-x');
ok('the fade removed: the plain base again', await ev('S.look.fades.length === 0') && !/radial-gradient/.test(await css('body', 'backgroundImage')));
await click('#setbody .lk-head[data-f="cells"]');
ok('Cells opens: the fill on its chip, opacity, outline, corners', await until('!!document.querySelector("#setbody .lk-head[data-f=cells].open")', 2000) && await chipC('cell') === '#151515' && await ev('!!document.querySelector("#setbody .lk-rng[data-k=op]") && !!document.querySelector("#setbody [data-lk=line].on") && !!document.getElementById("lkr-rad")'));
await ev('(() => { const r = document.querySelector("#setbody .lk-rng[data-k=op]"); r.value = 40; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
ok('opacity 40%: the cells see-through', await css('#view .tile', 'backgroundColor') === 'rgba(21, 21, 21, 0.4)', await css('#view .tile', 'backgroundColor'));
await click('#setbody [data-lk="line"]');
ok('outline off: no line', await css('#view .tile', 'borderTopColor') === 'rgba(0, 0, 0, 0)' && await ev('S.look.line === false'));
await ev('(() => { const r = $("lkr-rad"); r.value = 3; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(400);   // (corners: a slider in px since 11-09)
ok('sharp corners', parseFloat(await css('#view .tile', 'borderTopLeftRadius')) < r0, await css('#view .tile', 'borderTopLeftRadius'));
await openChip('cell');
ok('the fill\'s chip: dark tones (greys first), no Auto', await ev(tonesIn + '.length === 24 && ' + tonesIn + '[0].dataset.c === "#000000" && !document.querySelector("#setbody .lk-pop .lk-auto")'));
await clickAt(tonesIn + '[9]');
ok('a dark tone picked: the fill', await ev('S.look.cell === DARK.flat()[9]'), await ev('S.look.cell'));
ok('the same tone again: no undo step (the review 11-05)', await ev('(() => { const u = undoStack.length; pickColour("cell", S.look.cell); return undoStack.length === u; })()'));
ok('the Classic card line as before (#232323), in the tokens', await ev('(() => { const v = lookVars(cleanLook({ theme: "classic" })); return v["--card-line"] === "#232323" && v["--tile-line"] === "#242424" && v["--rule"] === "#222222" && v["--line2"] === "#333333"; })()'));
await click(th('aurora'));
ok('Aurora: its background, see-through cells, Spectrum with its own palette: the categories in its colours', await look() === 'aurora/spectrum' && await ev('S.look.pal === "t_aurora"') && /radial-gradient/.test(await css('body', 'backgroundImage')) && await until(`(() => { const c = S.L.cats.map(c => { const e = document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); return e ? e.style.getPropertyValue('--cc') : ''; }); return c.filter(Boolean).length >= 4 && c.every(x => !x || !${JSON.stringify(WANT)}.includes(x)) && c.filter(Boolean).every(x => Object.values(PALETTES.t_aurora[1]).includes(x)); })()`, 3000), await ccs());
await click(th('classic'));
await foldsShut();
ok('Classic again: as it was', await look() === 'classic/none' && await css('#view .tile', 'backgroundColor') === 'rgb(21, 21, 21)' && await ev('!S.look.changed && S.look.fades.length === 0'));

// ---- Accent: one colour, yours ----
await pick('sTint', 'accent');
ok('Accent: the view tabs\' pill and the picked buttons in its colour (white to start), the cells as they were', await look() === 'classic/accent' && await css('#tabind', 'backgroundColor') === await asColour('color-mix(in srgb, #ffffff 22%, transparent)') && await css('#sTint .ind', 'backgroundColor') === await asColour('color-mix(in srgb, #ffffff 22%, transparent)') && await css('#view .tile', 'backgroundColor') === 'rgb(21, 21, 21)', await css('#tabind', 'backgroundColor'));
ok('Accent: the switches in it too', await css('#sClock', 'backgroundColor', '::after') === rgb('#ffffff'), await css('#sClock', 'backgroundColor', '::after'));
ok('Accent with the white accent: the popups\' graph tones stay apart, the 1% low its own', await ev('(() => { const s = document.documentElement.style, g = ["--gc", "--gc-gpu", "--gc-cpu", "--gc-lo"].map(n => s.getPropertyValue(n)); return g[0] === "#ffffff" && new Set(g).size === 4 && g.every(x => /^#[0-9a-f]{6}$/.test(x)); })()'), await ev('["--gc", "--gc-gpu", "--gc-cpu", "--gc-lo"].map(n => document.documentElement.style.getPropertyValue(n)).join()'));
ok('a saved state on the old blue: Classic and OLED white as they load (Mono, Accent, from before themes), not a saved look\'s, another palette\'s or another theme\'s; 2.4.3\'s OLED on its own palette', await ev('lookUp({ theme: "classic", acc: "#7fa6e8", pal: "muted", changed: true, tint: "accent" }).acc === "#ffffff" && lookUp({ theme: "oled", acc: "#9cb0f4", pal: "t_oled" }).acc === "#ffffff" && lookUp({ cards: "standard", acc: "#7fa6e8" }).acc === "#ffffff" && lookUp({ theme: "classic", acc: "#7fa6e8", pal: "muted", from: "s1" }).acc === "#7fa6e8" && lookUp({ theme: "classic", acc: "#7fa6e8", pal: "fire" }).acc === "#7fa6e8" && lookUp({ theme: "stone", acc: "#7fa6e8", pal: "muted" }).acc === "#7fa6e8" && lookUp({ theme: "oled", acc: "#7fa6e8", pal: "muted", tint: "none" }).pal === "t_oled" && lookUp({ theme: "oled", acc: "#7fa6e8", pal: "muted", tint: "spectrum" }).pal === "muted" && cleanLook({ theme: "classic", acc: "#7fa6e8", pal: "muted" }).acc === "#7fa6e8"'));
ok('Accent: no category colours', (await ccs()).replace(/,/g, '') === '');
ok('Accent: its box beside the control (no fold), White to start, no palette, no Auto', await ev('!document.querySelector("#setbody .lk-head[data-f=col]") && !document.querySelector("#setbody .lk-rows") && !document.querySelector("#setbody .lk-auto")') && await chipC('acc') === '#ffffff', await chipC('acc'));
ok('Accent: its box right before the control, as tall as it, no text on it', await ev('(() => { const a = document.querySelector("#setbody .lk-acc"), s = $("sTint"); return !!a && a.nextElementSibling === s && Math.abs(a.getBoundingClientRect().height - s.getBoundingClientRect().height) < 0.5 && a.textContent === ""; })()'));
ok('its chip opens the tones (24), a hex field and the full picker', await openChip('acc') && await ev(tonesIn + '.length === 24 && !!document.querySelector("#setbody .lk-pop .lk-hex") && !!document.querySelector("#setbody .lk-pop .lk-any input[type=color]")'));
const tone = await ev(tonesIn + '[1].dataset.c');
await clickAt(tonesIn + '[1]');
ok('a tone picked: the pill, the switches, at once, marked on its chip', await css('#tabind', 'backgroundColor') === await asColour('color-mix(in srgb, ' + tone + ' 22%, transparent)') && await css('#sClock', 'backgroundColor', '::after') === rgb(tone) && await chipC('acc') === tone && await ev(tonesIn + '[1].classList.contains("on")'), tone + ' ' + await css('#tabind', 'backgroundColor'));
await p.sleep(700);
ok('saved', !!state() && state().look && state().look.acc === tone, JSON.stringify(state() && state().look));
await ev('(() => { const i = document.querySelector("#setbody .lk-any input"); i.value = "#55aa77"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
ok('any colour (the picker): taken, on its chip', await ev('S.look.acc === "#55aa77"') && await chipC('acc') === '#55aa77');
await ev('(() => { const i = document.querySelector("#setbody .lk-hex"); i.value = "zz12"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
ok('a hex that isn\'t a colour: nothing changes', await ev('S.look.acc === "#55aa77"'));
await clickAt('document.querySelector("#setbody .lk-hex")'); await p.key('a', 'KeyA', 65, 2); await p.type('7FA6E8'); await p.key('Enter', 'Enter', 13); await p.sleep(400);
ok('a hex typed with the keys, without # and in capitals, then Enter: taken', await ev('S.look.acc === "#7fa6e8"') && await chipC('acc') === '#7fa6e8', await ev('S.look.acc'));
await ev('undo(); 1'); await p.sleep(400);
ok('undo: the colour before, on its chip', await ev('S.look.acc === "#55aa77"') && await chipC('acc') === '#55aa77', await ev('S.look.acc'));
await clickAt('document.querySelector("#setbody .lk-hex")'); await p.key('a', 'KeyA', 65, 2); await p.type('12'); await clickAt(tonesIn + '[3]');
const t3 = await ev(tonesIn + '[3] && ' + tonesIn + '[3].dataset.c');
ok('half a hex typed, then a tone clicked: the tone is taken', await until('S.look.acc === ' + JSON.stringify(t3 || '?'), 2000) || await ev('TONES.flat()[3] === S.look.acc'), await ev('S.look.acc'));
await ev('(() => { const i = document.querySelector("#setbody .lk-hex"); i.value = "#ffffff"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
await clickAt('$("sTint").closest(".setrow").firstElementChild');
ok('a click elsewhere shuts the open chip', await until('!document.querySelector("#setbody .lk-pop")', 2000));

// ---- Spectrum: each category its part's colour, or yours ----
await pick('sTint', 'spectrum');
ok('Spectrum: each category its part\'s colour (game, GPU, CPU, memory, drives, fans)', await until(`(${JSON.stringify(WANT)}).join() === S.L.cats.map(c => { const e = document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); return e ? e.style.getPropertyValue('--cc') : '?'; }).join()`, 3000), await ccs());
ok('Spectrum: the names in it', await ev(`S.L.cats.every((c, i) => getComputedStyle(document.querySelector('#view .dcat[data-cat="' + c.id + '"] h2')).color === ${JSON.stringify(WANT.map(rgb))}[i])`));
ok('Spectrum: the tiles\' icons in it', await ev(`S.L.cats.every((c, i) => { const s = document.querySelector('#view .dcat[data-cat="' + c.id + '"] .tn svg'); return !s || getComputedStyle(s).stroke === ${JSON.stringify(WANT.map(rgb))}[i]; })`));
ok('Spectrum: the graphs in it', await until(`${graphsIn}.every((cols, i) => cols.length === 0 || cols.some(x => x === ${JSON.stringify(WANT)}[i]))`, 4000) && await ev(`${graphsIn}.flat().every(x => ${JSON.stringify(WANT)}.includes(x) || !['#7c7c7c', '#8f8f8f'].includes(x))`), await ev(`JSON.stringify(${graphsIn})`));
// (Spectrum beyond the view: a warning's dot, a session's readings and its fps line, in their cells' colours)
const wcell = await ev('(() => { const id = S.L.cats[1].cells.find(c => S.L.cells[c].key && BYKEY.get(S.L.cells[c].key)); return cellName(S.L.cells[id]); })()');
await ev('(() => { const d = new Date(Date.now() - 120000), p2 = n => String(n).padStart(2, "0"), o = -d.getTimezoneOffset(); const st = d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + (o < 0 ? "-" : "+") + p2(Math.abs(o) / 60 | 0) + ":" + p2(Math.abs(o) % 60); $("wmodal").classList.add("open"); renderWarnings(st + "  YELLOW  " + ' + JSON.stringify(wcell) + ' + ": 99 (over its line)"); return 1; })()');
ok('Spectrum in Warning history: the row\'s dot in its cell\'s colour', await ev('document.querySelector("#wlist .gx-sess").style.getPropertyValue("--cc") === ' + JSON.stringify(WANT[1])), await ev('document.querySelector("#wlist .gx-sess").getAttribute("style")'));
await ev('(() => { $("wmodal").classList.remove("open"); const now = Math.floor(Date.now() / 1000), id = S.L.cats[1].cells.find(c => S.L.cells[c].key && BYKEY.get(S.L.cells[c].key)), x = S.L.cells[id], r = BYKEY.get(x.key); const s = { game: "Tint Game", start: now - 7200, end: now - 3600, from: now - 7200, secs: 3600, front: 3600, fps: 200, low: 150, items: [["GPU temp", "\u00b0C", 60, 70, null, null, 1, null, 0, x.key, 0]], warns: 0, tf: Array(60).fill(200), tl: Array(60).fill(150), p: 1 }; $("gmodal").classList.add("open"); renderGames(JSON.stringify(s)); document.querySelector("#glist .gx-sess .gx-row").click(); return 1; })()');
ok('Spectrum in Sessions: a reading\'s dot in its cell\'s colour, the fps line in the game\'s', await until('(() => { const rw = document.querySelector("#glist .gx-rw[style*=\'--cc\']"), tl = document.querySelector("#glist .gx-tl"); return !!rw && rw.style.getPropertyValue("--cc") === ' + JSON.stringify(WANT[1]) + ' && !!tl && tl.style.getPropertyValue("--fc") === ' + JSON.stringify(WANT[0]) + '; })()', 3000), await ev('[document.querySelector("#glist .gx-rw[style*=\'--cc\']") && document.querySelector("#glist .gx-rw[style*=\'--cc\']").getAttribute("style"), document.querySelector("#glist .gx-tl") && document.querySelector("#glist .gx-tl").getAttribute("style")]'));
await ev('$("gmodal").classList.remove("open"); 1'); await p.sleep(300);
ok('Spectrum: the pills and switches in the accent', await css('#tabind', 'backgroundColor') === await asColour('color-mix(in srgb, #ffffff 22%, transparent)') && await css('#sClock', 'backgroundColor', '::after') === rgb('#ffffff'), await css('#tabind', 'backgroundColor'));
const ids = await ev('S.L.cats.map(c => c.id)');
const chipCs = async () => { const o = []; for (const k of ids) o.push(await chipC(k)); return o; };
ok('Spectrum: the palette dropdown (Muted for Classic), then a row per category with cells, in its colour, with its hex', await ev('$("lkPal").value === "muted" && document.querySelectorAll("#setbody .lk-cr").length === S.L.cats.filter(c => c.cells.length).length && [...document.querySelectorAll("#setbody .lk-cr .lk-hx")].every(b => /^#[0-9A-F]{6}$/.test(b.textContent))') && JSON.stringify(await chipCs()) === JSON.stringify(WANT), JSON.stringify(await chipCs()));
ok('the palette dropdown: the theme\'s own first, every theme\'s by colour, the others last, each with its colours as squares', await ev('(() => { const s = $("lkPal"), g = [...s.querySelectorAll("optgroup")].map(x => x.label), f = s.querySelector("option[value=fire]"); return s.options[0].value === "t_classic" && g[g.length - 1] === "Others" && g[0] === "Greys" && !!f && f.dataset.sq.split(",")[1] === PALETTES.fire[1].gpu; })()'));
const rowTops = () => ev('JSON.stringify([...document.querySelectorAll("#setbody .lk-cr")].map(r => Math.round(r.getBoundingClientRect().top)))');
const rows0 = await rowTops();
await openChip(ids[1]); await p.sleep(250);
ok('a category\'s editor floats under its row, at the right, nothing moves', await ev('(() => { const f = document.querySelector("#setbody .lk-fl"), r = document.querySelector("#setbody .lk-cr[data-k=\'' + ids[1] + '\']"), rs = document.querySelector("#setbody .lk-rows"); if (!f || !r) return false; const fr = f.getBoundingClientRect(), rr = r.getBoundingClientRect(), sr = rs.getBoundingClientRect(); return getComputedStyle(f).position === "absolute" && Math.abs(fr.top - (rr.bottom + 4)) < 1.5 && Math.abs(fr.right - sr.right) < 1.5; })()') && await rowTops() === rows0, rows0 + ' ' + await rowTops());
const rose = await ev(tonesIn + '[7].dataset.c');
await clickAt(tonesIn + '[7]');
ok('the GPU\'s colour picked: its name, its graphs, its chip, kept with the layout', await until('S.L.cats[1].col === ' + JSON.stringify(rose), 2000) && await ccOf(1) === rose && await graphsOf(1, rose) && await chipC(ids[1]) === rose, await ev('JSON.stringify(S.L.cats.map(c => c.col || ""))'));
await p.sleep(700);
ok('saved with the view', !!state() && state().L.cats[1].col === rose, JSON.stringify(state() && state().L.cats.map(c => c.col || '')));
await ev('undo(); 1'); await p.sleep(500);
ok('undone like any change: its part\'s colour again', await ev('!S.L.cats[1].col') && await ccOf(1) === WANT[1]);
await p.key('Escape', 'Escape', 27); await p.sleep(300);   // (the open editor floats over the rows under it: shut first, 11-09)
await openChip(ids[2]);
await ev('(() => { const i = document.querySelector("#setbody .lk-any input"); i.value = "#123456"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(400);
ok('any colour for the CPU: taken, on its chip', await ev('S.L.cats[2].col === "#123456"') && await ccOf(2) === '#123456' && await chipC(ids[2]) === '#123456', await ev('JSON.stringify([S.L.cats[2].col, lkPick, ' + JSON.stringify(ids[2]) + ', [...document.querySelectorAll("#setbody .lk-any input")].map(i => i.dataset.k)])') + ' ' + await ccOf(2) + ' ' + await chipC(ids[2]));
await clickAt('document.querySelector("#setbody .lk-pop .lk-auto")');
ok('Auto: its part\'s colour back', await ev('!S.L.cats[2].col') && await ccOf(2) === WANT[2]);
// a palette: each category's part colour from it, and its accent; undo brings the last one back
const FIRE = ['#ff7a5c', '#ff9f43', '#ffc15e', '#f6d06f', '#e8735a', '#ff5d73'];
const u0 = await ev('undoStack.length');
await ev('(() => { const s = $("lkPal"); s.value = "muted"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
ok('the palette in use, nothing of yours on it: no undo step', await ev('undoStack.length') === u0, u0 + ' / ' + await ev('undoStack.length'));
await ev('(() => { const s = $("lkPal"); s.value = "fire"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);   // (the palette dropdown, 11-09)
ok('a palette (Fire): each category its part\'s colour from it, the accent its own', await until(JSON.stringify(FIRE.join()) + ' === ' + ccList, 3000) && await ev('S.look.pal === "fire" && S.look.acc === "#ff9f43"'), await ccs());
// (11-05: Settings stays as it is while the look changes: no see-through, no eye, no moving aside)
await p.sleep(1200);
ok('after a pick, resting: Settings as it was, centred and dimmed', await ev('!$("setmodal").classList.contains("dock") && !$("setmodal").classList.contains("peek") && !document.getElementById("setPeek")') && await css('#setmodal', 'backgroundColor') !== 'rgba(0, 0, 0, 0)' && await css('#setmodal .mcard', 'opacity') === '1', await ev('setmodal.className'));
await ev('undo(); 1'); await p.sleep(500);
ok('undo: Muted and white again', await ev('S.look.pal === "muted" && S.look.acc === "#ffffff"') && await until(JSON.stringify(WANT.join()) + ' === ' + ccList, 3000), await ccs());

// ---- the other views ----
await ev('$("setmodal").classList.remove("open"); 1');
await click('nav#screens button[data-s="overview"]'); await p.sleep(700);
ok('Overview: each card\'s name and icon in its colour', await until(`S.L.cats.every((c, i) => { const e = document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); if (!e) return false; const n = e.querySelector('.ch .cn'); return n && getComputedStyle(n).color === ${JSON.stringify(WANT.map(rgb))}[i]; })`, 3000));
ok('Overview: its graphs too', await until(`${graphsIn}.every((cols, i) => cols.length === 0 || cols.some(x => x === ${JSON.stringify(WANT)}[i]))`, 4000), await ev(`JSON.stringify(${graphsIn})`));
await click('nav#screens button[data-s="grid"]'); await p.sleep(700);
ok('Grid: each category\'s header in its colour', await until(`S.L.cats.every((c, i) => { const h = document.querySelector('#view tbody[data-cat="' + c.id + '"] tr.ghdr td'); return h && getComputedStyle(h).color === ${JSON.stringify(WANT.map(rgb))}[i]; })`, 3000));
await click('nav#screens button[data-s="tiles"]'); await p.sleep(700);

// ---- what a category is: by most of its cells ----
const mixed = await ev(`(() => { const by = re => READ.find(r => re.test(SENS[r.s] ? SENS[r.s].name : '') && r.unit !== 'RPM' && !hidOf(r));
  const g = by(/^dGPU/), g2 = READ.find(r => r !== g && /^dGPU/.test(SENS[r.s] ? SENS[r.s].name : '') && r.unit !== 'RPM' && !hidOf(r)), c = by(/^CPU/), d = by(/^S\\.M\\.A\\.R\\.T/);
  addKeys([g.key, c.key, d.key], null, null, 'Mix'); addKeys([g.key, g2.key, c.key], null, null, 'Mostly GPU'); addKeys([g.key, c.key], null, null, 'Even'); return S.L.cats.map(x => x.name).join(); })()`);
await p.sleep(900);
ok('a mix (a GPU, a CPU and a drive reading) and an even split stay grey; two GPU readings and a CPU one is the GPU\'s', await until(`(() => { const q = n => { const c = S.L.cats.find(x => x.name === n), e = c && document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); return e ? e.style.getPropertyValue('--cc') : '?'; }; return q('Mix') === '' && q('Even') === '' && q('Mostly GPU') === '#74c69d'; })()`, 3000), mixed);
await ev(`(() => { snap(); S.L.cats = S.L.cats.filter(c => !['Mix', 'Mostly GPU', 'Even'].includes(c.name)); afterChange(); return 1; })()`); await p.sleep(600);

// ---- kept after a reload (a category's own colour too) ----
await ev('(() => { S.look = cleanLook({ theme: "oled", tint: "spectrum", acc: ACC0, pal: "muted" }); applyLook(); S.L.cats[0].col = "#c79ad6"; afterChange(); return 1; })()'); await p.sleep(800);
const WANT2 = ['#c79ad6'].concat(WANT.slice(1));
ok('after a reload: OLED and Spectrum, the colours back on, the one picked kept', await reload() && await look() === 'oled/spectrum' && await until(`${JSON.stringify(WANT2)}.join() === S.L.cats.map(c => { const e = document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); return e ? e.style.getPropertyValue('--cc') : '?'; }).join()`, 4000), await ccs());
await ev('(() => { delete S.L.cats[0].col; afterChange(); return 1; })()'); await p.sleep(400);

// ---- back to Mono and Standard: as before, nothing left behind ----
await click('#setBtn');
await pick('sTint', 'none');
await click(th('classic'));
ok('Mono again: no category colours, the names grey', await look() === 'classic/none' && (await ccs()).replace(/,/g, '') === '' && await ev('getComputedStyle(document.querySelector("#view .blk h2")).color === "rgb(116, 116, 116)"'));
ok('Mono again: the graphs grey', await until(`${graphsIn}.flat().every(x => !${JSON.stringify(WANT)}.includes(x))`, 4000), await ev(`JSON.stringify(${graphsIn})`));
ok('Classic again: the cells as they were', await css('#view .tile', 'backgroundColor') === 'rgb(21, 21, 21)' && await css('body', 'backgroundColor') === 'rgb(13, 13, 13)');
await p.sleep(700);
ok('the default saves as nothing', !!state() && state().look === undefined, JSON.stringify(state() && state().look));

// ---- hover texts: the page's own tips, never Windows' (11-02) ----
await click('#gamesBtn'); await p.sleep(800);
ok('no title anywhere for Windows to show (Settings and Sessions open, the view drawn)', await ev('document.querySelectorAll("[title]").length === 0 && document.querySelectorAll("[data-tip]").length > 20'), await ev('[document.querySelectorAll("[title]").length, [...document.querySelectorAll("[title]")].slice(0, 3).map(e => e.outerHTML.slice(0, 80))]'));
ok('a hint is still read and set as .title', await ev('(() => { const b = $("setBtn"), t = b.title; b.title = "x y"; const ok = b.getAttribute("data-tip") === "x y" && !b.hasAttribute("title") && b.title === "x y"; b.title = t; return ok && t.length > 0; })()'));
ok('a title in new html becomes a hint before anything shows it', await ev('(async () => { const d = document.createElement("div"); d.innerHTML = "<span title=\\"hi\\">a</span>"; document.body.appendChild(d); await new Promise(r => setTimeout(r, 0)); const ok = !d.querySelector("[title]") && d.firstChild.dataset.tip === "hi"; d.remove(); return ok; })()'));
await ev('$("gmodal").classList.remove("open"); $("setmodal").classList.remove("open"); 1'); await p.sleep(300);
const sb = await p.center('#setBtn');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sb.x, y: sb.y }); await p.sleep(800);
ok('hovering a button: its hint in the app\'s tip', await ev('$("setBtn").title.length > 0 && document.querySelector(".tip").classList.contains("show") && document.querySelector(".tip").textContent === $("setBtn").title'), await ev('document.querySelector(".tip").textContent'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: sb.y + 300 }); await p.sleep(300);
ok('and gone when the pointer leaves', await ev('!document.querySelector(".tip").classList.contains("show")'));

// ---- Tab walks nothing, no rings (his call 11-02) ----
await click('nav#screens button[data-s="overview"]'); await p.sleep(500);
const before = await ev('document.activeElement ? document.activeElement.outerHTML.slice(0, 60) : ""');
await p.key('Tab', 'Tab', 9); await p.key('Tab', 'Tab', 9);
ok('Tab: the focus stays where it was', await ev('document.activeElement ? document.activeElement.outerHTML.slice(0, 60) : ""') === before, before);
ok('a key after a click: no ring on the button', await ev('(() => { const a = document.activeElement; return !a || a === document.body || getComputedStyle(a).outlineStyle === "none"; })()'));
await click('nav#screens button[data-s="tiles"]'); await p.sleep(400);

// ---- Mono shows the accent nowhere (11-10, his "the accent color should not display when it's on mono (add
// animation)"): its box folds away behind the control and slides back out with Accent or Spectrum; edit mode's colour
// is the plain white there, and the look keeps its accent ----
const accBox = `(() => { const a = document.querySelector('#setbody .lk-acc'), s = $('sTint'); if (!a) return null; const ar = a.getBoundingClientRect(), cs = getComputedStyle(a);
  return { w: +ar.width.toFixed(2), gap: +(s.getBoundingClientRect().left - ar.right).toFixed(2), vis: cs.visibility, dis: a.disabled, moving: a.getAnimations().some(x => x.transitionProperty === 'width'), anims: a.getAnimations().length,
    edit: document.documentElement.style.getPropertyValue('--edit'), acc: S.look.acc, pop: !!document.querySelector('#setbody .lk-fl') }; })()`;
const AJ = async x => JSON.parse(await ev(`JSON.stringify(${x})`));
const tintTo = v => AJ(`(() => { document.querySelector('#sTint button[data-v="${v}"]').click(); return ${accBox}; })()`);
await ev(`(() => { window.__lk0 = JSON.stringify(S.look); window.__mo0 = S.motion; S.motion = 'full'; applyMotion(); S.look = Object.assign({}, S.look, { tint: 'none', acc: '#55aa77', changed: true }); lkPick = null; applyLook(); $('setBtn').click(); return 1; })()`); await p.sleep(900);
const mb0 = await AJ(accBox);
ok('Mono with an accent kept: its box folded away as Settings opens, nothing slides, edit mode in the plain white', !!mb0 && mb0.w < 0.5 && mb0.vis === 'hidden' && mb0.dis && mb0.anims === 0 && mb0.edit === '#ffffff' && mb0.acc === '#55aa77', JSON.stringify(mb0));
const ab0 = await tintTo('accent'); await p.sleep(700); const ab1 = await AJ(accBox);
ok('Mono to Accent: the box slides out from behind the control, then stands 30 px wide, 10 px before it; edit mode in the accent', ab0.moving && ab0.w < 6 && !ab0.dis && ab0.vis === 'visible' && Math.abs(ab1.w - 30) < 0.6 && Math.abs(ab1.gap - 10) < 0.6 && ab1.anims === 0 && ab1.edit === await ev(`editCol('#55aa77')`), JSON.stringify([ab0, ab1]));
await ev(`(() => { document.querySelector('#setbody .lk-acc').click(); return 1; })()`); await p.sleep(500);
const gb0 = await tintTo('none'); await p.sleep(700); const gb1 = await AJ(accBox);
ok('Accent to Mono with its editor open: the editor shuts, the box slides away (off for the keys at once, hidden once folded), the white again, the accent kept', await ev(`lkPick === null`) && gb0.moving && gb0.w > 24 && gb0.dis && gb0.vis === 'visible' && !gb0.pop && gb1.w < 0.5 && gb1.vis === 'hidden' && gb1.anims === 0 && gb0.edit === '#ffffff' && gb1.acc === '#55aa77', JSON.stringify([gb0, gb1]));
// (the review 11-10) drawn again mid-slide, it goes on from where it had got to: the slide is held 60 ms in, so the
// clock plays no part
const hold = `(() => { const a = document.querySelector('#setbody .lk-acc'); for (const x of a.getAnimations()) { x.pause(); x.currentTime = 60; } return a.getBoundingClientRect().width; })()`;
const md = await AJ(`(() => { document.querySelector('#sTint button[data-v="accent"]').click(); const w1 = ${hold}; renderSettings(); const b = document.querySelector('#setbody .lk-acc'), w2 = b.getBoundingClientRect().width, mv2 = b.getAnimations().some(x => x.transitionProperty === 'width'), w2b = ${hold};
  document.querySelector('#sTint button[data-v="none"]').click(); const c = document.querySelector('#setbody .lk-acc'); return { w1, w2, mv2, w2b, w3: c.getBoundingClientRect().width, mv3: c.getAnimations().some(x => x.transitionProperty === 'width'), vis3: getComputedStyle(c).visibility, dis3: c.disabled }; })()`);
await p.sleep(700); const md2 = await AJ(accBox);
ok('drawn again mid-slide (another redraw, then Mono picked again): the box goes on from where it was, no jump to an end', md.w1 > 1 && md.w1 < 29 && Math.abs(md.w2 - md.w1) < 0.5 && md.mv2 && md.w2b > md.w1 && md.w2b < 29.9 && Math.abs(md.w3 - md.w2b) < 0.5 && md.mv3 && md.vis3 === 'visible' && md.dis3 && md2.w < 0.5 && md2.vis === 'hidden' && md2.anims === 0, JSON.stringify(md));
await tintTo('accent'); await p.sleep(500);
await ev(`(() => { document.querySelector('#setbody .lk-acc').focus(); return 1; })()`); await p.key('Shift', 'ShiftLeft', 16);
const fc = await AJ(`(() => { const a = document.querySelector('#setbody .lk-acc'), fv = document.activeElement === a && a.matches(':focus-visible'); undo(); const e = document.activeElement; return { fv, on: !!e && e.matches('#sTint button.on'), at: e ? e.tagName + '.' + e.className : '', tint: S.look.tint }; })()`); await p.sleep(700);
ok('the box in key focus, undo brings Mono: the focus goes to the control beside it, not to the page', fc.tint === 'none' && (!fc.fv || fc.on), JSON.stringify(fc));
const sb0 = await tintTo('spectrum'); await p.sleep(700);
const kb0 = await tintTo('accent');
ok('Mono to Spectrum: it slides out too; Spectrum to Accent: it stays, nothing slides', sb0.moving && !kb0.moving && Math.abs(kb0.w - 30) < 0.6, JSON.stringify([sb0.moving, kb0.moving, kb0.w]));
await ev(`(() => { S.motion = 'off'; applyMotion(); return 1; })()`);
const ob0 = await tintTo('none'), ob1 = await tintTo('accent');
ok('animations Off: gone at once, there at once, nothing slides', ob0.anims === 0 && ob0.w < 0.5 && ob0.vis === 'hidden' && ob1.anims === 0 && Math.abs(ob1.w - 30) < 0.6 && ob1.vis === 'visible', JSON.stringify([ob0, ob1]));
await ev(`(() => { S.look = JSON.parse(window.__lk0); S.motion = window.__mo0; applyMotion(); lkPick = null; applyLook(); saveState(); $('setmodal').classList.remove('open'); return 1; })()`); await p.sleep(400);

ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
