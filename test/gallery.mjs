// Tile looks: one layout per scene (tiles per row 1 to 8, wide / tall / big / short tiles, the bottleneck, predicted and
// missing cells, yellow and red, hidden titles, Overview cards, lists and bands, three Grid tables; each also in a narrow
// window), every tile, row and band cell measured for what looks broken (a value cut or sticking out, overlaps, content
// taller than its box, a graph squashed to a line, a name cut to nothing), and a screenshot of each in test/out/gallery.
// Start a copy first (HWDeck.exe --fake 300 --data test\data-gal, debug port 9239), then:
//   node test/gallery.mjs [port] [outdir] [scene...]
import { connect } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const [port, out] = [+(process.argv[2] || 9239), process.argv[3] || 'test/out/gallery'];
const only = process.argv.slice(4);
mkdirSync(out, { recursive: true });
const p = await connect(port), errs = await p.errors(), E = x => p.evaluate(x);
for (let i = 0; i < 60 && !(await E('READ.length > 100 && feed.got').catch(() => false)); i++) await p.sleep(250);

// the page side: readings by kind, a layout builder and the measuring pass
await E(`(() => {
  const by = f => READ.filter(f).map(r => r.key);
  window.G = {
    temp: by(r => r.t === 'temp'), fan: by(r => r.t === 'fan'), power: by(r => r.t === 'power'), clock: by(r => r.t === 'clock'),
    usage: by(r => r.t === 'usage'), volt: by(r => r.t === 'volt'), fps: by(r => r.unit === 'FPS'), other: by(r => r.t === 'other' && r.unit !== 'FPS'),
    yn: by(r => r.unit === 'Yes/No'), big: by(r => /MB|MHz/.test(r.unit))
  };
  // a cell spec: [kind, index, extra]; kind 'bneck' = the bottleneck, 'pred' = a predicted fan, 'miss' = a reading not on this PC
  window.mk = (spec) => {
    const L = { v: 1, cats: [], cells: {} };
    for (const c of spec.cats) {
      const ids = c.cells.map((x, i) => {
        const id = c.id + '_' + i, [k, n, extra] = x, e = extra || {};
        let cell;
        if (k === 'bneck') cell = { key: 'hwdeck.0/bneck', graph: true };
        else if (k === 'pred') cell = { pred: true, name: 'Predicted fan', graph: true, curve: { src: G.temp[0], pts: [[30, 500], [60, 1200], [85, 1900]], tol: 15, hold: 10 } };
        else if (k === 'miss') cell = { key: 'gone.0/01000000', match: 'Old PC sensor|Ghost temperature', u: '\\u00b0C', graph: true };
        else cell = { key: (G[k] || G.temp)[n || 0] || G.temp[0], graph: true };
        Object.assign(cell, e);
        L.cells[id] = cell; return id;
      });
      L.cats.push({ id: c.id, name: c.name || c.id, collapsed: !!c.collapsed, cells: ids });
    }
    L.views = spec.views || undefined;
    return cleanLayout(L);
  };
  window.audit = () => {
    const R = el => el.getBoundingClientRect(), out = [];
    const ov = (a, b) => { if (!a || !b) return false; const x = R(a), y = R(b); return x.width > 0 && y.width > 0 && x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1; };
    for (const t of document.querySelectorAll('#view .tile, #view .row, #view .hero, #view .bcell, #view .gt tr.dc')) {
      if (!t.offsetWidth) continue;
      const box = R(t), issues = [], cat = t.closest('.dcat');
      const v = t.querySelector('.tv, .hv, .val, .gval'), n = t.querySelector('.tn, .hero .nm, .lbl .nm, .gname'), c = t.querySelector('.tc, .hc, .lbl i, .ginfo');
      if (v) {
        const r = R(v);
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5) issues.push('value sticks out of the box');
        const vv = v.querySelector('.v'); if (vv && vv.scrollWidth > vv.clientWidth + 1 && vv.clientWidth) issues.push('value cut');
        if (n && ov(v, n) && !n.contains(v) && !v.contains(n)) issues.push('value overlaps the name');
        if (c && ov(v, c) && !c.contains(v) && !v.contains(c)) issues.push('value overlaps the caption');
      }
      if (t.tagName !== 'TR' && t.scrollHeight > t.clientHeight + 2) issues.push('content taller than the box (' + t.scrollHeight + ' > ' + t.clientHeight + ')');
      if (t.tagName !== 'TR' && t.scrollWidth > t.clientWidth + 2) issues.push('content wider than the box');
      for (const ch of t.querySelectorAll('*')) {
        const r = R(ch); if (!r.width || !r.height || ch.closest('.corner') || ch.closest('.odr') || getComputedStyle(ch).visibility === 'hidden') continue;
        if (r.right > box.right + 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.top < box.top - 1) { issues.push('a part sticks out: ' + (typeof ch.className === 'string' ? ch.className || ch.tagName : 'svg')); break; }
      }
      const cv = t.querySelector('canvas'); if (cv && getComputedStyle(cv).display !== 'none' && getComputedStyle(cv).visibility !== 'hidden') { const r = R(cv); if (r.height < 12 || r.width < 30) issues.push('graph squashed ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
      const st = t.querySelector('.strip'); if (st) { const r = R(st); if (r.width < 30) issues.push('strip squashed ' + Math.round(r.width)); }
      const ns = t.querySelector('.tn > span, .nm > span, .gname > span'); if (ns && ns.scrollWidth > ns.clientWidth + 1 && ns.clientWidth < 48) issues.push('name cut to ' + ns.clientWidth + 'px (of ' + ns.scrollWidth + ')');
      const vs = t.querySelector('.v'); if (vs && vs.scrollWidth > vs.clientWidth + 1) issues.push('value text cut');
      if (t.classList.contains('tile') && box.width < 95) issues.push('tile only ' + Math.round(box.width) + 'px wide');
      if (t.classList.contains('tile') && !t.classList.contains('short') && box.height < 70) issues.push('tile only ' + Math.round(box.height) + 'px tall');
      if (issues.length) out.push({ cat: cat && cat.dataset.cat, cell: t.dataset.cid, kind: t.className.split(' ').filter(x => /tile|row|hero|bcell|short|sz-|pred|missing|dc/.test(x)).join('.'), w: Math.round(box.width), h: Math.round(box.height), issues });
    }
    for (const h of document.querySelectorAll('#view .dch')) { if (!h.offsetWidth) continue; if (h.scrollWidth > h.clientWidth + 2) out.push({ cat: h.closest('.dcat').dataset.cat, kind: 'header', issues: ['header content wider than its space'] }); }
    for (const b of document.querySelectorAll('#view .dcat')) { if (!b.offsetWidth) continue; const r = R(b); for (const ch of b.querySelectorAll('.tile, .card .row, .bcell')) { const q = R(ch); if (q.right > r.right + 1 || q.bottom > r.bottom + 1) { out.push({ cat: b.dataset.cat, kind: 'block', issues: ['a cell sticks out of its category (' + ch.dataset.cid + ')'] }); break; } } }
    return out;
  };
  S.motion = 'off'; applyMotion();
})()`);

const L5 = n => Array.from({ length: n }, (_, i) => ['temp', i]);
const SCENES = {
  // tiles per row 1..4 in quarter columns, then 5..8 in a full-width row: narrow tiles with long names and big numbers
  'tiles-per': { vn: 'tiles', w: 1600, h: 1000, spec: { cats: [
    { id: 'p1', name: 'One per row', cells: [['clock', 0], ['bneck'], ['pred']] },
    { id: 'p2', name: 'Two per row', cells: [['clock', 1], ['big', 0], ['bneck'], ['pred']] },
    { id: 'p3', name: 'Three per row', cells: [['clock', 2], ['big', 1], ['volt', 0], ['bneck'], ['pred'], ['miss']] },
    { id: 'p4', name: 'Four per row', cells: [['clock', 3], ['big', 2], ['volt', 1], ['fan', 0], ['bneck'], ['pred'], ['miss'], ['usage', 0]] },
    { id: 'p8', name: 'Eight per row, full width', cells: [['clock', 4], ['big', 3], ['volt', 2], ['fan', 1], ['bneck'], ['pred'], ['miss'], ['fps', 0], ['usage', 1], ['power', 0]] }
  ], views: { tiles: { rows: [{ h: 2, cols: [{ stack: ['p1'] }, { stack: ['p2'] }, { stack: ['p3'] }, { stack: ['p4'] }] }, { h: 1, cols: [{ stack: ['p8'] }] }],
    cat: { p1: { per: 1 }, p2: { per: 2 }, p3: { per: 3 }, p4: { per: 4 }, p8: { per: 8 } } } } } },
  // wide, tall and big tiles with 1, 2, 3, 4 and auto tiles per row, in fill and fit rows
  'tiles-sizes': { vn: 'tiles', w: 1600, h: 1000, spec: { cats: [
    { id: 's1', name: 'Per 1 with a wide', cells: [['temp', 0, {}], ['fan', 0]] },
    { id: 's2', name: 'Per 2 big and wide', cells: [['temp', 1], ['clock', 0], ['fan', 1], ['bneck'], ['usage', 0]] },
    { id: 's3', name: 'Per 3 all sizes', cells: [['temp', 2], ['clock', 1], ['fan', 2], ['bneck'], ['pred'], ['usage', 1], ['power', 0]] },
    { id: 'sa', name: 'Auto per, big in a fit row', cells: [['temp', 3], ['clock', 2], ['fan', 3], ['miss'], ['volt', 0]] }
  ], views: { tiles: { rows: [{ h: 2, cols: [{ stack: ['s1'] }, { stack: ['s2'] }, { w: 2, stack: ['s3'] }] }, { cols: [{ stack: ['sa'] }] }],
    cat: { s1: { per: 1 }, s2: { per: 2 }, s3: { per: 3 } },
    cell: { s1_0: { size: 'wide' }, s2_0: { size: 'big' }, s2_1: { size: 'wide' }, s2_3: { size: 'tall' }, s3_0: { size: 'big' }, s3_2: { size: 'tall' }, s3_3: { size: 'wide' }, s3_4: { size: 'wide' }, sa_0: { size: 'big' }, sa_3: { size: 'wide' } } } } } },
  // short tiles: long names, the bottleneck strip, predicted, missing, in narrow and wide columns, in a tall fill row
  'tiles-short': { vn: 'tiles', w: 1600, h: 1000, spec: { cats: [
    { id: 'h1', name: 'Short, one per row, narrow', cells: [['clock', 0, { name: 'A very long cell name that goes on and on' }], ['bneck'], ['pred'], ['miss'], ['big', 0]] },
    { id: 'h3', name: 'Short, three per row', cells: [['clock', 1], ['bneck'], ['pred'], ['miss'], ['big', 1], ['volt', 0]] },
    { id: 'h6', name: 'Short, six per row', cells: [['clock', 2], ['bneck'], ['pred'], ['miss'], ['big', 2], ['fan', 0], ['usage', 0]] },
    { id: 'hf', name: 'Short in a tall fill row', cells: [['temp', 0], ['fan', 1], ['bneck'], ['power', 0]] }
  ], views: { tiles: { rows: [{ h: 1, cols: [{ w: 3, stack: ['h1'] }, { w: 9, stack: ['h3'] }] }, { cols: [{ stack: ['h6'] }] }, { h: 2, cols: [{ stack: ['hf'] }] }],
    cat: { h1: { per: 1, size: 'short' }, h3: { per: 3, size: 'short' }, h6: { per: 6, size: 'short' }, hf: { per: 4, size: 'short' } } } } } },
  // states: yellow, red, warm, missing, graph hidden, a hidden title, a collapsed category, Yes/No
  'tiles-states': { vn: 'tiles', w: 1600, h: 1000, spec: { cats: [
    { id: 'st', name: 'States', cells: [['temp', 0, { gates: { mode: 'yr', dir: 'above', y: -50, r: -40, hold: 0 } }], ['temp', 1, { gates: { mode: 'y', dir: 'above', y: -50, hold: 0 } }], ['temp', 2, { graph: false }], ['miss'], ['fan', 0, { gates: { mode: 'yr', dir: 'below', y: 99999, r: 99998, hold: 0 } }], ['yn', 0]] },
    { id: 'nt', name: 'Hidden title', cells: [['temp', 3], ['fan', 1], ['usage', 0]] },
    { id: 'co', name: 'Collapsed', collapsed: true, cells: [['temp', 4]] },
    { id: 'ng', name: 'No graphs in a fill row', cells: [['temp', 5, { graph: false }], ['fan', 2, { graph: false }], ['bneck', 0, { graph: false }]] }
  ], views: { tiles: { rows: [{ h: 2, cols: [{ w: 8, stack: ['st'] }, { w: 4, stack: ['nt', 'co'] }] }, { h: 1, cols: [{ stack: ['ng'] }] }], cat: { st: { per: 3 }, nt: { per: 3, title: 'hide' } } } } } },
  // Overview: a one-cell card, long names, a small card, a one-cell list, one-cell and eight-cell bands, narrow cards
  'overview-looks': { vn: 'overview', w: 1600, h: 1000, spec: { cats: [
    { id: 'c1', name: 'One cell card', cells: [['temp', 0]] },
    { id: 'cl', name: 'A category with a really long name for a card header', cells: [['clock', 0, { name: 'A very long cell name that goes on and on' }], ['bneck'], ['pred'], ['miss'], ['big', 0]] },
    { id: 'sm', name: 'Small', cells: [['fps', 0], ['temp', 1], ['bneck']] },
    { id: 'l1', name: 'List one', cells: [['temp', 2]] },
    { id: 'b1', name: 'Band one', cells: [['fan', 0]] },
    { id: 'b8', name: 'Band of eight', cells: [['fan', 1], ['fan', 2], ['clock', 1], ['big', 1], ['bneck'], ['pred'], ['miss'], ['volt', 0]] },
    { id: 'q1', name: 'Quarter card', cells: [['clock', 2], ['big', 2], ['bneck']] },
    { id: 'q2', name: 'Quarter list', cells: [['clock', 3], ['big', 3], ['miss']] }
  ], views: { overview: { rows: [
    { h: 1, cols: [{ stack: ['c1'] }, { stack: ['cl'] }, { stack: ['sm'] }, { stack: ['l1'] }] },
    { cols: [{ stack: ['b1'] }] }, { cols: [{ stack: ['b8'] }] },
    { h: 1, cols: [{ w: 2, stack: ['q1'] }, { w: 2, stack: ['q2'] }, { w: 8, stack: [] }].filter(c => c.stack.length) }],
    cat: { sm: { style: 'small' }, l1: { style: 'list' }, b1: { style: 'band' }, b8: { style: 'band' }, q2: { style: 'list' } } } } } },
  // Grid: three tables, long names, the bottleneck strip, missing
  'grid-three': { vn: 'grid', w: 1600, h: 1000, spec: { cats: [
    { id: 'g1', name: 'Table one', cells: [['clock', 0, { name: 'A very long cell name that goes on and on' }], ['bneck'], ['pred'], ['miss']] },
    { id: 'g2', name: 'Table two', cells: [['big', 0], ['volt', 0], ['fan', 0]] },
    { id: 'g3', name: 'Table three', cells: L5(4) }
  ], views: { grid: { rows: [{ cols: [{ stack: ['g1'] }, { stack: ['g2'] }, { stack: ['g3'] }] }] } } } }
};
// the same scenes in a narrow window too
for (const k of ['tiles-per', 'tiles-sizes', 'tiles-short', 'overview-looks']) SCENES[k + '-narrow'] = Object.assign({}, SCENES[k], { w: 760, h: 900 });
SCENES['tiles-sizes-edit'] = Object.assign({}, SCENES['tiles-sizes'], { edit: true, select: 's3_0' });

const report = {};
for (const [name, sc] of Object.entries(SCENES)) {
  if (only.length && !only.includes(name)) continue;
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: sc.w, height: sc.h, deviceScaleFactor: 1, mobile: false });
  await E(`(() => { S.L = mk(${JSON.stringify(sc.spec)}); sel = null; selCat = null; preview = null; S.edit = ${!!sc.edit}; app.classList.toggle('editing', S.edit); showScreen(${JSON.stringify(sc.vn)}, true); if (${JSON.stringify(sc.select || '')}) selectCell(${JSON.stringify(sc.select || '')}); for (const d of [DR.L, DR.R]) { d.hover = false; d.pinned = false; d.byPick = false; } syncDrawers(); window.dispatchEvent(new Event('resize')); })()`);
  await p.sleep(2600);   // a couple of ticks, the fit after the resize
  report[name] = await E('audit()');
  await p.shot(`${out}/${name}.png`);
}
await p.cmd('Emulation.clearDeviceMetricsOverride');
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
// a name shortened with an ellipsis but still showing 40 px or more is fine; everything else counts
let bad = 0;
for (const [k, v] of Object.entries(report)) {
  const real = v.map(x => ({ ...x, issues: x.issues.filter(i => !/^name cut to (\d+)px/.test(i) || +/^name cut to (\d+)px/.exec(i)[1] < 40) })).filter(x => x.issues.length);
  bad += real.length;
  console.log((real.length ? 'FAIL ' : 'PASS ') + k + (real.length ? ': ' + real.length + ' with issues' : ''));
  for (const x of real) console.log('  ' + [x.cat, x.cell || '', x.kind, x.w ? x.w + 'x' + x.h : ''].join(' ') + ': ' + x.issues.join('; '));
}
if (errs.length) { bad++; console.log('FAIL page errors ' + JSON.stringify(errs)); }
console.log(bad ? 'SOME FAILED' : 'ALL PASS');
p.close(); process.exit(0);
