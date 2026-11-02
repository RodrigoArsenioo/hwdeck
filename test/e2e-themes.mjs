// The look (Settings > Look, 11-02): the cards' surface (Standard, OLED: true black with the cards as lines only, Soft)
// and the colour (Mono, Accent, Spectrum), switched live, saved, kept after a reload. Accent's colour is yours (a
// swatch or any colour); Spectrum gives each category its part's colour (a mix stays grey) or yours (kept with the
// layout, undone like any change, Auto takes it back), on its name, icons and graphs, in all three views; a warning
// still shows through every look. Also: Tab walks nothing, no focus rings, and every hover text is the page's own tip
// (no title left for Windows to show). The colours: a fold (Colours) with a chip per colour that opens 24 tones, a hex
// field and the full picker, Auto for a category; palettes under Spectrum; Settings goes see-through after a pick only
// while the fold is open. On Starter's layout (loaded here), a fresh folder:
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
const look = () => ev('document.documentElement.dataset.cards + "/" + document.documentElement.dataset.tint');
// Spectrum's colours, by Starter's categories: the game, the GPU, the CPU, memory, drives, fans
const WANT = ['#a99bdc', '#74c69d', '#7fa6e8', '#4fb8ad', '#8fa0c8', '#6cc8d8'];
const ccs = () => ev('S.L.cats.map(c => { const e = document.querySelector("#view .dcat[data-cat=\\"" + c.id + "\\"]"); return e ? e.style.getPropertyValue("--cc") : "?"; }).join()');
const ccOf = i => ev(`(() => { const c = S.L.cats[${i}], e = c && document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); return e ? e.style.getPropertyValue('--cc') : '?'; })()`);
const graphsIn = `S.L.cats.map((c, i) => [...document.querySelectorAll('#view .dcat[data-cat="' + c.id + '"] canvas')].map(cv => graphs.get(cv)).filter(G => G && G.col).map(G => G.col))`;
const graphsOf = (i, col) => until(`(${graphsIn})[${i}].length === 0 || (${graphsIn})[${i}].some(x => x === ${JSON.stringify(col)})`, 4000);
// a colour's chip in Colours (the accent's: 'acc', a category's: its id), its colour, and its tones opened
const chip = k => 'document.querySelector(' + JSON.stringify('#setbody .lk-chip[data-k="' + k + '"]') + ')';
const chipC = k => ev('(() => { const c = ' + chip(k) + '; return c ? c.style.getPropertyValue("--c") : null; })()');
const openChip = async k => { await clickAt(chip(k)); return until('!!document.querySelector("#setbody .lk-pop")', 2000); };
const tonesIn = 'document.querySelectorAll("#setbody .lk-pop .lk-g button")';
const ccList = 'S.L.cats.map(c => { const e = document.querySelector(\'#view .dcat[data-cat="\' + c.id + \'"]\'); return e ? e.style.getPropertyValue("--cc") : "?"; }).join()';
const clickAt = async expr => { const c = await p.centerOf(expr); if (!c) return false; await p.click(c.x, c.y); await p.sleep(350); return true; };

ok('the readings come', await until('READ.length > 300 && feed.got', 10000), await ev('READ.length'));
await ev('(() => { loadStarter(); setEdit(false); return 1; })()'); await p.sleep(800);
ok('(Starter loaded: six categories, in view mode)', await ev('S.L.cats.length === 6 && !S.edit'), await ev('S.L.cats.map(c => c.name).join()'));
ok('a new view: Standard cards, Mono, nothing saved for it', await look() === 'standard/none' && await css('#view .tile', 'backgroundColor') === 'rgb(21, 21, 21)' && !!state() && state().look === undefined);
const r0 = parseFloat(await css('#view .tile', 'borderTopLeftRadius'));

// ---- Settings: Look, its rows ----
await click('#setBtn');
ok('Settings has Look: Cards (Standard, OLED, Soft) and Colour (Mono, Accent, Spectrum), the ones on marked', await ev('[...document.querySelectorAll("#sCards button")].map(b => b.textContent).join() === "Standard,OLED,Soft" && [...document.querySelectorAll("#sTint button")].map(b => b.textContent).join() === "Mono,Accent,Spectrum" && $("sCards").querySelector(".on").dataset.v === "standard" && $("sTint").querySelector(".on").dataset.v === "none"'));
ok('Mono: no colour to pick', await ev('!document.querySelector("#setbody .lk-head")'));
ok('Mono: a switch that is on is light on dark, no blue', await css('#sClock', 'backgroundColor') === 'rgb(208, 208, 208)' && await css('#sClock', 'backgroundColor', '::after') === 'rgb(22, 22, 22)', await css('#sClock', 'backgroundColor') + ' ' + await css('#sClock', 'backgroundColor', '::after'));

// ---- the cards ----
await pick('sCards', 'oled');
ok('OLED: true black, the cards drawn as lines only, at once', await look() === 'oled/none' && await css('body', 'backgroundColor') === 'rgb(0, 0, 0)' && await css('#view .tile', 'backgroundColor') === 'rgba(0, 0, 0, 0)' && await css('#view .tile', 'borderTopColor') === 'rgb(38, 38, 38)', await css('#view .tile', 'backgroundColor'));
await p.key('z', 'KeyZ', 90, 2); await p.sleep(300);
ok('Ctrl+Z with Settings open: Standard again, its button marked', await look() === 'standard/none' && await ev('$("sCards").querySelector(".on").dataset.v === "standard"'), await look());
await p.key('y', 'KeyY', 89, 2); await p.sleep(300);
ok('Ctrl+Y: OLED again', await look() === 'oled/none' && await ev('$("sCards").querySelector(".on").dataset.v === "oled"'), await look());
ok('OLED: its text says what it is, the button marked', await ev('/true black/i.test($("sCards").closest(".setrow").textContent) && $("sCards").querySelector(".on").dataset.v === "oled"'));
await p.sleep(700);
ok('saved with the view', !!state() && state().look && state().look.cards === 'oled' && state().look.tint === 'none', JSON.stringify(state() && state().look));
ok('a look saved as Outline (the first afternoon) opens as OLED', await ev('cleanLook({ cards: "outline", tint: "accent" }).cards === "oled" && cleanLook({ cards: "nope" }).cards === "standard" && cleanLook({ acc: "red" }).acc === ACC0'));
await pick('sCards', 'soft');
ok('Soft: no line, a lighter card, a shadow, rounder', await look() === 'soft/none' && await css('#view .tile', 'borderTopColor') === 'rgba(0, 0, 0, 0)' && await css('#view .tile', 'backgroundColor') === 'rgb(26, 26, 26)' && await css('#view .tile', 'boxShadow') !== 'none' && parseFloat(await css('#view .tile', 'borderTopLeftRadius')) > r0, r0 + ' ' + await css('#view .tile', 'borderTopLeftRadius'));
// a warning shows through every look (the yellow and red borders beat a look's line)
const warnBorders = await ev(`(() => { const t = document.querySelector('#view .tile'), out = {}; t.style.transition = 'none';
  for (const k of ['standard', 'oled', 'soft']) { document.documentElement.dataset.cards = k; t.classList.add('yellow'); out[k] = getComputedStyle(t).borderTopColor; t.classList.remove('yellow'); t.classList.add('red'); out[k] += ' ' + getComputedStyle(t).borderTopColor; t.classList.remove('red'); }
  document.documentElement.dataset.cards = S.look.cards; t.style.transition = ''; return JSON.stringify(out); })()`);
ok('a yellow or red tile keeps its border in every look', Object.values(JSON.parse(warnBorders)).every(v => v === 'rgb(92, 79, 29) rgb(107, 32, 32)'), warnBorders);

// ---- Accent: one colour, yours ----
await pick('sCards', 'standard');
await pick('sTint', 'accent');
ok('Accent: the view tabs\' pill and the picked buttons in its colour (blue to start), the cards as they were', await look() === 'standard/accent' && await css('#tabind', 'backgroundColor') === await asColour('color-mix(in srgb, #7fa6e8 22%, transparent)') && await css('#sTint .ind', 'backgroundColor') === await asColour('color-mix(in srgb, #7fa6e8 22%, transparent)') && await css('#view .tile', 'backgroundColor') === 'rgb(21, 21, 21)', await css('#tabind', 'backgroundColor'));
ok('Accent: the switches in it too', await css('#sClock', 'backgroundColor', '::after') === rgb('#7fa6e8'), await css('#sClock', 'backgroundColor', '::after'));
ok('Accent: no category colours', (await ccs()).replace(/,/g, '') === '');
ok('Accent: its colour in Colours, folded, Blue to start, no palettes, no Auto', await ev('!!document.querySelector("#setbody .lk-head") && !document.querySelector("#setbody .lk-head.open") && !document.querySelector("#setbody .lk-pres") && !document.querySelector("#setbody .lk-auto")') && await chipC('acc') === '#7fa6e8', await chipC('acc'));
await click('#setbody .lk-head');
ok('Colours opens', await until('!!document.querySelector("#setbody .lk-head.open") && !!document.querySelector("#setbody .lk-body.open")', 2000));
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
ok('a hex typed with the keys, without # and in capitals, then Enter: taken, Blue again', await ev('S.look.acc === "#7fa6e8"') && await chipC('acc') === '#7fa6e8', await ev('S.look.acc'));
await ev('undo(); 1'); await p.sleep(400);
ok('undo: the colour before, on its chip', await ev('S.look.acc === "#55aa77"') && await chipC('acc') === '#55aa77', await ev('S.look.acc'));
await clickAt('document.querySelector("#setbody .lk-hex")'); await p.key('a', 'KeyA', 65, 2); await p.type('12'); await clickAt(tonesIn + '[3]');
const t3 = await ev(tonesIn + '[3] && ' + tonesIn + '[3].dataset.c');
ok('half a hex typed, then a tone clicked: the tone is taken', await until('S.look.acc === ' + JSON.stringify(t3 || '?'), 2000) || await ev('TONES.flat()[3] === S.look.acc'), await ev('S.look.acc'));
await ev('(() => { const i = document.querySelector("#setbody .lk-hex"); i.value = "#7fa6e8"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(300);
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
ok('Spectrum: the pills and switches in the accent', await css('#tabind', 'backgroundColor') === await asColour('color-mix(in srgb, #7fa6e8 22%, transparent)') && await css('#sClock', 'backgroundColor', '::after') === rgb('#7fa6e8'), await css('#tabind', 'backgroundColor'));
const ids = await ev('S.L.cats.map(c => c.id)');
const chipCs = async () => { const o = []; for (const k of ids) o.push(await chipC(k)); return o; };
ok('Colours lists the palettes, Muted on, and a chip per category in its colour, auto', await ev('document.querySelectorAll("#setbody .lk-pres button").length === Object.keys(PALETTES).length && document.querySelector("#setbody .lk-pres button.on").dataset.k === "muted" && document.querySelectorAll("#setbody .lk-chip").length === 7 && [...document.querySelectorAll("#setbody .lk-tag")].slice(1).every(t => t.textContent === "auto")') && JSON.stringify(await chipCs()) === JSON.stringify(WANT), JSON.stringify(await chipCs()));
await openChip(ids[1]);
const rose = await ev(tonesIn + '[7].dataset.c');
await clickAt(tonesIn + '[7]');
ok('the GPU\'s colour picked: its name, its graphs, its chip says yours, kept with the layout', await until('S.L.cats[1].col === ' + JSON.stringify(rose), 2000) && await ccOf(1) === rose && await graphsOf(1, rose) && await chipC(ids[1]) === rose && await ev('[...document.querySelectorAll("#setbody .lk-tag")][2].textContent === "yours"'), await ev('JSON.stringify(S.L.cats.map(c => c.col || ""))'));
await p.sleep(700);
ok('saved with the view', !!state() && state().L.cats[1].col === rose, JSON.stringify(state() && state().L.cats.map(c => c.col || '')));
await ev('undo(); 1'); await p.sleep(500);
ok('undone like any change: its part\'s colour again', await ev('!S.L.cats[1].col') && await ccOf(1) === WANT[1]);
await openChip(ids[2]);
await ev('(() => { const i = document.querySelector("#setbody .lk-any input"); i.value = "#123456"; i.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()'); await p.sleep(400);
ok('any colour for the CPU: taken, on its chip', await ev('S.L.cats[2].col === "#123456"') && await ccOf(2) === '#123456' && await chipC(ids[2]) === '#123456');
await clickAt('document.querySelector("#setbody .lk-pop .lk-auto")');
ok('Auto: its part\'s colour back', await ev('!S.L.cats[2].col') && await ccOf(2) === WANT[2]);
// a palette: each category's part colour from it, and its accent; undo brings the last one back
const FIRE = ['#ff7a5c', '#ff9f43', '#ffc15e', '#f6d06f', '#e8735a', '#ff5d73'];
const u0 = await ev('undoStack.length');
await click('#setbody .lk-pres button[data-k="muted"]');
ok('the palette in use, nothing of yours on it: no undo step', await ev('undoStack.length') === u0, u0 + ' / ' + await ev('undoStack.length'));
const fb = await p.center('#setbody .lk-pres button[data-k="fire"]');
await click('#setbody .lk-pres button[data-k="fire"]');
ok('a palette (Fire): each category its part\'s colour from it, the accent its own', await until(JSON.stringify(FIRE.join()) + ' === ' + ccList, 3000) && await ev('S.look.pal === "fire" && S.look.acc === "#ff9f43"'), await ccs());
// (the pointer held still after a pick: Settings goes see-through so the view shows; folded, it doesn't)
await p.sleep(1000);
ok('resting after a pick, Colours open: Settings goes see-through', await ev('$("setmodal").classList.contains("peek")'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fb.x + 30, y: fb.y }); await p.sleep(250);
ok('a move ends it', await ev('!$("setmodal").classList.contains("peek")'));
await p.sleep(1000);
ok('resting again within its 10 seconds: see-through again', await ev('$("setmodal").classList.contains("peek")'));
await click('#setbody .lk-head');
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fb.x + 10, y: fb.y + 10 }); await p.sleep(1000);
ok('Colours folded: not see-through, even resting again', await ev('!$("setmodal").classList.contains("peek") && !document.querySelector("#setbody .lk-head.open")'));
await ev('undo(); 1'); await p.sleep(500);
ok('undo: Muted and Blue again', await ev('S.look.pal === "muted" && S.look.acc === "#7fa6e8"') && await until(JSON.stringify(WANT.join()) + ' === ' + ccList, 3000), await ccs());

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
await ev('(() => { S.look = { cards: "oled", tint: "spectrum", acc: ACC0, pal: "muted" }; applyLook(); S.L.cats[0].col = "#c79ad6"; afterChange(); return 1; })()'); await p.sleep(800);
const WANT2 = ['#c79ad6'].concat(WANT.slice(1));
ok('after a reload: OLED and Spectrum, the colours back on, the one picked kept', await reload() && await look() === 'oled/spectrum' && await until(`${JSON.stringify(WANT2)}.join() === S.L.cats.map(c => { const e = document.querySelector('#view .dcat[data-cat="' + c.id + '"]'); return e ? e.style.getPropertyValue('--cc') : '?'; }).join()`, 4000), await ccs());
await ev('(() => { delete S.L.cats[0].col; afterChange(); return 1; })()'); await p.sleep(400);

// ---- back to Mono and Standard: as before, nothing left behind ----
await click('#setBtn');
await pick('sTint', 'none');
await pick('sCards', 'standard');
ok('Mono again: no category colours, the names grey', await look() === 'standard/none' && (await ccs()).replace(/,/g, '') === '' && await ev('getComputedStyle(document.querySelector("#view .blk h2")).color === "rgb(116, 116, 116)"'));
ok('Mono again: the graphs grey', await until(`${graphsIn}.flat().every(x => !${JSON.stringify(WANT)}.includes(x))`, 4000), await ev(`JSON.stringify(${graphsIn})`));
ok('Standard again: the cards as they were', await css('#view .tile', 'backgroundColor') === 'rgb(21, 21, 21)' && await css('body', 'backgroundColor') === 'rgb(13, 13, 13)');
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

ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
