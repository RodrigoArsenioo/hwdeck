// The bins (11-02): Sessions and Warning history each pick rows (Select) and move them to their bin, the log's .bak, or
// bring them back from it (the Bin icon), exactly the lines they were, in time order; undo and redo take a move back
// and forth. What can't be picked: the session in progress, a warning still going on, and in the bin a row older than
// the days you keep (back in the log the next trim would set it aside again, and it wouldn't show: the host holds it
// back too). Picks follow the list (a game or a cell picked meanwhile drops the others). The warnings' bin keeps two
// crossings of one cell apart though their end stayed in the log (an app's exit), one that starts at red after it too,
// and draws 300 rows at a time. Its logs and bins are written here (any folder; run-all starts it on a fresh one):
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9238
//   HWDeck.exe --fake 300 --data test\data-bins --no-starter
// then: node test/e2e-bins.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9238);
const data = process.argv[3] || 'test/data-bins';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const text = f => existsSync(join(data, f)) ? readFileSync(join(data, f), 'utf8') : '';
const lines = f => text(f).split(/\r?\n/).filter(l => l.trim());
const untilFile = async (test, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (test()) return true; await p.sleep(200); } return false; };
const click = async sel => { const c = await p.center(sel); if (!c) throw new Error('nothing at ' + sel); await p.click(c.x, c.y); await p.sleep(350); };
// a row by its name (the n-th of that name) in a list, clicked near its left end (its box when picking)
const row = (list, name, n = 0) => `[...document.querySelectorAll('${list} .gx-sess')].filter(s => s.querySelector('.gx-gn').textContent.startsWith(${JSON.stringify(name)}))[${n}]`;
const pickRow = async (list, name, n = 0) => { const c = await p.centerOf(row(list, name, n)); if (!c) throw new Error('no row ' + name); await p.click(c.x - c.w / 2 + 24, c.y); await p.sleep(250); };
const names = list => E(`[...document.querySelectorAll('${list} .gx-sess .gx-gn')].map(x => x.textContent)`);
const bar = id => E(`$(${JSON.stringify(id)}).textContent`);
const toastTxt = () => E('$("toastTxt").textContent');
// a bin row's Delete for good button (11-03), clicked
const purgeOf = (list, name, n = 0) => row(list, name, n) + ".querySelector('.gx-purge')";
const clickPurge = async (list, name, n = 0) => { const c = await p.centerOf(purgeOf(list, name, n)); if (!c) throw new Error('no Delete for good on ' + name); await p.click(c.x, c.y); await p.sleep(350); };
const untilNot = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!(await fn())) return true; await p.sleep(200); } return false; };

ok('the readings come', await until('feed.got && READ.length > 100', 10000));

// ---- the logs: sessions 40 and 35 days old and of today; warnings: one 40 days old, today a pump, a cell twice with
// an app exit after the first, and one still going on ----
const now = Math.floor(Date.now() / 1000), H = 3600, D = 86400;
const sess = (game, start, len = 600) => JSON.stringify({ game, start, end: start + len, from: start, secs: len, front: len, items: [], warns: 0 });
const G = { oldA: sess('Old A', now - 40 * D), oldB: sess('Old B', now - 35 * D), a1: sess('Game A', now - 5 * H), a2: sess('Game A', now - 4 * H), b1: sess('Game B', now - 3 * H) };
writeFileSync(join(data, 'games.log'), [G.oldA, G.oldB, G.a1, G.a2, G.b1].join('\r\n') + '\r\n');
for (const f of ['games.log.bak', 'alerts.log.bak', 'games.log.restored', 'alerts.log.restored']) rmSync(join(data, f), { force: true });   // (a run before left its own)
const p2 = n => String(n).padStart(2, '0');
const at = ms => { const d = new Date(ms), o = -d.getTimezoneOffset(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + (o < 0 ? '-' : '+') + p2(Math.abs(o) / 60 | 0) + ':' + p2(Math.abs(o) % 60); };
const M = m => at(Date.now() - m * 60000);
const A = {
  old1: at(Date.now() - 40 * D * 1000) + '  YELLOW  Old: 1 (over its line)', old2: at(Date.now() - 40 * D * 1000 + 30000) + '  OK      Old: back to normal (peak 1)',
  p1: M(50) + '  YELLOW  Pump: 950 RPM (under its line)', p2: M(49) + '  OK      Pump: back to normal (peak 900 RPM)',
  v1: M(45) + '  YELLOW  VRM: 90 °C (over its line)', v2: M(30) + '  RED     VRM: 101 °C (over its line)', v3: M(29) + '  OK      VRM: back to normal (peak 103 °C)',
  c1: M(40) + '  YELLOW  CPU: 85 °C (over its line)', exit: M(39) + '  MARK    app exit', start: M(38) + '  MARK    app start',
  c2: M(20) + '  YELLOW  CPU: 86 °C (over its line)', c3: M(19) + '  OK      CPU: back to normal (peak 88 °C)',
  g1: M(5) + '  YELLOW  GPU: 80 °C (over its line)',
};
writeFileSync(join(data, 'alerts.log'), [A.old1, A.old2, A.p1, A.p2, A.v1, A.c1, A.exit, A.start, A.v2, A.v3, A.c2, A.c3, A.g1].join('\r\n') + '\r\n');
// (Keep, 30 days each: what is older goes to the bins, as from Settings)
await E(`send({ t: 'keep', games: 30, warns: 30 })`);
ok('Keep 30 days: the old sessions and the old warning go to the bins', await until('feed.gameDays === 30 && feed.warnDays === 30', 5000) && await untilFile(() => !/Old A|Old B/.test(text('games.log')) && /Old A/.test(text('games.log.bak')) && /Old B/.test(text('games.log.bak')) && !/Old: 1/.test(text('alerts.log')) && /Old: 1/.test(text('alerts.log.bak'))), text('games.log.bak').length + ' / ' + text('alerts.log.bak').length);

// ---- Sessions ----
await click('#gamesBtn');
ok('Sessions: the three of today', await until('document.querySelectorAll("#glist .gx-sess").length === 3', 5000), JSON.stringify(await names('#glist')));
await click('#gbinBtn');
ok('the bin: the two old ones, too old to bring back, each saying why', await until('document.querySelectorAll("#glist .gx-sess").length === 2', 5000) && await E('[...document.querySelectorAll("#glist .gx-sess")].every(s => s.classList.contains("nopk") && /Older than the 30 days you keep/.test(s.dataset.tip || ""))'), JSON.stringify(await names('#glist')));
ok('its bar: 2 sessions, 2 older than the days you keep, no Pick all, Restore off', /The bin: 2 sessions, 2 older than the days you keep/.test(await bar('gbar')) && await E('!document.querySelector("#gbar [data-pk=all]") && $("gbar").querySelector("[data-pk=restore]").disabled'), await bar('gbar'));
const oc = await p.centerOf(row('#glist', 'Old A') + ".querySelector('.gx-gm')");
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: oc.x, y: oc.y }); await p.sleep(900);
ok('hovering one shows why, in the app\'s tip', await E('document.querySelector(".tip").classList.contains("show") && /Older than the 30 days you keep/.test(document.querySelector(".tip").textContent)'), await E('document.querySelector(".tip").textContent'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await p.sleep(300);
await pickRow('#glist', 'Old A');
ok('a click on one picks nothing', await E('!document.querySelector("#glist .gx-sess.pk") && PK.g.pick.size === 0'));
await E(`send({ t: 'log:move', log: 'games', to: 'log', lines: [${JSON.stringify(G.oldA)}] })`); await p.sleep(800);
ok('asked anyway, the host keeps it in the bin and says why', !/Old A/.test(text('games.log')) && /Old A/.test(text('games.log.bak')) && /older than the days you keep stayed in the bin/.test(await toastTxt()), await toastTxt());
await click('#gbar [data-pk="back"]');
ok('Back: the log again', await until('document.querySelectorAll("#glist .gx-sess").length === 3 && !PK.g.mode', 4000));

await click('#gselBtn');
await pickRow('#glist', 'Game A', 0); await pickRow('#glist', 'Game A', 1);
ok('Select: two picked, the bar says so', /2 picked/.test(await bar('gbar')) && await E('document.querySelectorAll("#glist .gx-sess.pk").length === 2'), await bar('gbar'));
await click('#gsum .gx-srow'); await click('#gsum .gx-gr[data-game="Game B"]');
ok('a game picked in the summary meanwhile: the picks it hides go, the bar follows', await E('[...document.querySelectorAll("#glist .gx-sess .gx-gn")].every(x => x.textContent === "Game B")') && await E('PK.g.pick.size === 0 && $("gbar").querySelector("[data-pk=del]").disabled') && !/picked/.test(await bar('gbar')), await bar('gbar'));
await click('#gsum .gx-srow');
await pickRow('#glist', 'Game A', 0); await pickRow('#glist', 'Game A', 1);
await click('#gbar [data-pk="del"]');
ok('Move to the bin: out of the log, into the bin, exactly their lines', await untilFile(() => !text('games.log').includes(G.a1) && !text('games.log').includes(G.a2) && lines('games.log.bak').includes(G.a1) && lines('games.log.bak').includes(G.a2)) && lines('games.log').includes(G.b1), text('games.log'));
ok('the list and a toast follow, select mode left', await until('document.querySelectorAll("#glist .gx-sess").length === 1 && !PK.g.mode', 4000) && /2 sessions moved to the bin/.test(await toastTxt()), await toastTxt());
ok('its toast offers Undo', await E('!$("toastUndo").hidden'));
await click('#toastUndo');
ok('the toast\'s Undo: back in the log, in time order', await untilFile(() => { const l = lines('games.log'); return l.length === 3 && l[0] === G.a1 && l[1] === G.a2 && l[2] === G.b1; }) && !text('games.log.bak').includes(G.a1), lines('games.log').length + '');
await p.key('y', 'KeyY', 89, 2);
ok('Ctrl+Y: in the bin again', await untilFile(() => !text('games.log').includes(G.a1) && text('games.log.bak').includes(G.a1)));
await p.key('z', 'KeyZ', 90, 2);
ok('Ctrl+Z: back in the log again', await untilFile(() => text('games.log').includes(G.a1) && !text('games.log.bak').includes(G.a1)));
await p.key('y', 'KeyY', 89, 2);
ok('(Ctrl+Y: in the bin, for what follows)', await untilFile(() => !text('games.log').includes(G.a1) && text('games.log.bak').includes(G.a1)));
await click('#gbinBtn');
ok('the bin: the two moved ones and the two old ones', await until('document.querySelectorAll("#glist .gx-sess").length === 4', 5000), JSON.stringify(await names('#glist')));
await click('#gbar [data-pk="all"]');
ok('Pick all picks the two that can come back', /2 picked/.test(await bar('gbar')) && await E('document.querySelectorAll("#glist .gx-sess.pk").length === 2 && [...document.querySelectorAll("#glist .gx-sess.pk .gx-gn")].every(x => x.textContent === "Game A")'), await bar('gbar'));
await click('#gbar [data-pk="restore"]');
ok('Restore: back in the log in time order, the old ones still in the bin', await untilFile(() => { const l = lines('games.log'); return l.length === 3 && l[0] === G.a1 && l[2] === G.b1; }) && /Old A/.test(text('games.log.bak')) && !text('games.log.bak').includes(G.a1), text('games.log'));
ok('the bin list follows: the old two', await until('document.querySelectorAll("#glist .gx-sess").length === 2', 4000));

// ---- Delete for good (11-03, his "a button in each row to delete permanently, like it was before"): on every bin row,
// the old ones too; it asks first, picks nothing, takes exactly that line out of the bin, has no undo ----
ok('every bin row has its Delete for good, the old ones at full strength', await E('(() => { const s = [...document.querySelectorAll("#glist .gx-sess")]; return s.length === 2 && s.every(x => !!x.querySelector(".gx-row > .gx-purge") && getComputedStyle(x).opacity === "1"); })()'));
ok('it sits right of the last column, which lines up with its title', await E('(() => { const r = document.querySelector("#glist .gx-sess .gx-row"), st = r.querySelector(".gx-st").getBoundingClientRect(), b = r.querySelector(".gx-purge").getBoundingClientRect(), h = document.querySelector("#glist .gx-cols").lastElementChild.getBoundingClientRect(); return b.left >= st.right && b.right <= r.getBoundingClientRect().right && Math.abs(h.right - st.right) < 1.5; })()'),
  await E('(() => { const r = document.querySelector("#glist .gx-sess .gx-row"); return [r.querySelector(".gx-st").getBoundingClientRect().right, r.querySelector(".gx-purge").getBoundingClientRect().left, document.querySelector("#glist .gx-cols").lastElementChild.getBoundingClientRect().right]; })()'));
const pc = await p.centerOf(purgeOf('#glist', 'Old A'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pc.x, y: pc.y }); await p.sleep(900);
ok('hovering it says what it does', await E('document.querySelector(".tip").classList.contains("show") && document.querySelector(".tip").textContent === "Delete for good"'), await E('document.querySelector(".tip").textContent'));
await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await p.sleep(300);
const gb0 = text('games.log.bak'), gl0 = text('games.log');
await clickPurge('#glist', 'Old A');
ok('it asks first, naming the session', await E('$("cmodal").classList.contains("open") && $("ctitle").textContent === "Delete this session for good?" && /^Old A, \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d to \\d\\d:\\d\\d\\. It leaves the bin and can.t be brought back\\.$/.test($("cdesc").textContent) && $("cyes").textContent === "Delete for good"'), await E('$("ctitle").textContent + " / " + $("cdesc").textContent'));
ok('and picks nothing', await E('PK.g.pick.size === 0 && !document.querySelector("#glist .gx-sess.pk")'));
await click('#cno');
ok('No: nothing deleted', text('games.log.bak') === gb0 && await E('!$("cmodal").classList.contains("open") && document.querySelectorAll("#glist .gx-sess").length === 2'));
await clickPurge('#glist', 'Old A'); await click('#cyes');
ok('Yes: exactly its line leaves the bin, the log untouched', await untilFile(() => !text('games.log.bak').includes(G.oldA)) && text('games.log.bak').includes(G.oldB) && text('games.log') === gl0, text('games.log.bak'));
ok('the bin list follows, a toast says so, with no Undo', await until('document.querySelectorAll("#glist .gx-sess").length === 1', 4000) && /^1 session deleted for good$/.test(await toastTxt()) && await E('$("toastUndo").hidden'), await toastTxt());
await E(`send({ t: 'log:purge', log: 'games', lines: ['not a line the bin has'] })`); await p.sleep(700);
ok('a line the bin no longer has: nothing deleted, it says so', /Nothing deleted: it changed since/.test(await toastTxt()) && text('games.log.bak').includes(G.oldB), await toastTxt());
await E(`send({ t: 'log:purge', log: 'nope', lines: [${JSON.stringify(G.oldB)}] }); send({ t: 'log:purge', log: 'games' })`); await p.sleep(700);
ok('a log it doesn\'t know, or no lines: nothing happens', text('games.log.bak').includes(G.oldB) && await E('document.querySelectorAll("#glist .gx-sess").length === 1'));
// a session moved to the bin and then deleted for good: the move's undo step goes with it (nothing left to bring back)
await click('#gbar [data-pk="back"]');
await click('#gselBtn'); await pickRow('#glist', 'Game B'); await click('#gbar [data-pk="del"]');
ok('(Game B moved to the bin)', await untilFile(() => text('games.log.bak').includes(G.b1) && !text('games.log').includes(G.b1)));
const moveStep = () => E(`[...undoStack, ...redoStack].some(s => s.startsWith('{"host":') && JSON.stringify(JSON.parse(s).host.lines) === ${JSON.stringify(JSON.stringify([G.b1]))})`);
ok('(its undo step is there)', await moveStep());
await click('#gbinBtn');
ok('(the bin: Game B and Old B)', await until('document.querySelectorAll("#glist .gx-sess").length === 2', 5000), JSON.stringify(await names('#glist')));
await clickPurge('#glist', 'Game B'); await click('#cyes');
ok('deleted for good: in neither file', await untilFile(() => !text('games.log.bak').includes(G.b1)) && !text('games.log').includes(G.b1), text('games.log.bak'));
ok('the move\'s undo step went with it', await untilNot(moveStep), await E('undoStack.length'));
ok('the other steps stay (the Restore before it)', await E(`undoStack.some(s => s.startsWith('{"host":') && JSON.parse(s).host.lines.includes(${JSON.stringify(G.a1)}))`));
await click('#gbar [data-pk="back"]');
await E('$("gmodal").classList.remove("open")'); await p.sleep(400);

// ---- Warning history ----
await click('#logBtn');
ok('Warning history: GPU going on, CPU twice, VRM (yellow, the app\'s exit, then red: one row), the pump', await until('document.querySelectorAll("#wlist .gx-sess").length === 5', 5000) && await E(row('#wlist', 'VRM') + ".querySelector('.wx-x').textContent === '2x'"), JSON.stringify(await names('#wlist')));
await click('#wselBtn');
ok('Select: the warning still going on can\'t be picked', await E(`${row('#wlist', 'GPU')}.classList.contains('nopk')`));
await pickRow('#wlist', 'GPU');
ok('a click on it picks nothing', await E('PK.w.pick.size === 0'));
await pickRow('#wlist', 'Pump');
await click('#wsum .gx-srow');
ok('the summary opened: each cell\'s part, CPU twice, VRM once and red', await until('!!document.querySelector("#wsum .gx-gr[data-cell=CPU]")', 3000) && await E('(() => { const r = c => [...document.querySelector("#wsum .gx-gr[data-cell=" + c + "]").querySelectorAll(".gx-r")].map(x => x.textContent); return r("CPU")[0] === "2" && r("VRM")[0] === "2" && r("VRM")[1] === "1"; })()'), await E('[...document.querySelectorAll("#wsum .gx-gr")].map(r => r.textContent).join(" | ")'));
await click('#wsum .gx-gr[data-cell="CPU"]');
ok('a cell picked there: only its rows, and the pick it hides goes', await until('[...document.querySelectorAll("#wlist .gx-sess .gx-gn")].every(x => x.textContent === "CPU") && document.querySelectorAll("#wlist .gx-sess").length === 2', 3000) && await E('PK.w.pick.size === 0'), await bar('wbar'));
await click('#wsum .gx-srow');
ok('shut again: all the rows', await until('document.querySelectorAll("#wlist .gx-sess").length === 5', 3000));
await pickRow('#wlist', 'CPU', 0); await pickRow('#wlist', 'CPU', 1); await pickRow('#wlist', 'VRM');
await click('#wbar [data-pk="del"]');
ok('the two CPU rows and VRM to the bin: their lines, the marks stay', await untilFile(() => !/CPU|VRM/.test(text('alerts.log')) && text('alerts.log').includes(A.exit) && text('alerts.log').includes(A.start) && [A.c1, A.c2, A.c3, A.v1, A.v2, A.v3].every(l => lines('alerts.log.bak').includes(l))), text('alerts.log'));
ok('a toast: 4 warnings (their yellow and red lines)', /4 warnings moved to the bin/.test(await toastTxt()), await toastTxt());
await click('#wbinBtn');
ok('the bin shows them as the log did: the two CPU crossings apart, VRM one row of 2, the old one beside them', await until('document.querySelectorAll("#wlist .gx-sess").length === 4', 5000) && JSON.stringify((await names('#wlist')).sort()) === '["CPU","CPU","Old","VRM"]' && await E(row('#wlist', 'VRM') + ".querySelector('.wx-x').textContent === '2x' && " + row('#wlist', 'VRM') + ".querySelector('.wx-lv').classList.contains('r')"), JSON.stringify(await names('#wlist')));
ok('its bar: 4 rows, 1 older than the days you keep', /The bin: 4 rows, 1 older than the days you keep/.test(await bar('wbar')), await bar('wbar'));
await click('#wbar [data-pk="all"]'); await click('#wbar [data-pk="restore"]');
ok('its toast counts crossings as the rows do', /4 warnings back from the bin/.test(await toastTxt()), await toastTxt());
ok('Restore: the CPU and VRM lines back around the marks, in time order', await untilFile(() => { const l = lines('alerts.log'); return l.indexOf(A.c1) >= 0 && l.indexOf(A.c1) < l.indexOf(A.exit) && l.indexOf(A.v1) < l.indexOf(A.exit) && l.indexOf(A.v2) > l.indexOf(A.start) && l.indexOf(A.c2) > l.indexOf(A.start) && l.indexOf(A.c3) > l.indexOf(A.c2); }) && /Old: 1/.test(text('alerts.log.bak')), text('alerts.log'));
await p.key('z', 'KeyZ', 90, 2);
ok('Ctrl+Z takes the Restore back: in the bin again', await untilFile(() => !/CPU|VRM/.test(text('alerts.log')) && lines('alerts.log.bak').includes(A.v2)), text('alerts.log'));
await p.key('y', 'KeyY', 89, 2);
ok('Ctrl+Y: back in the log', await untilFile(() => text('alerts.log').includes(A.v2) && text('alerts.log').includes(A.c1)), text('alerts.log'));
// a crossing a mark ended (the app's exit), set aside with its mark (Keep and Clear move whole stretches of the log): it
// comes back with the mark, ended where it was, not running on to a later one (11-02: his real bin had 251 such marks)
const L1 = M(300) + '  YELLOW  Lag: 1 (over its line)', LX = M(299) + '  MARK    app exit', L2 = M(200) + '  YELLOW  Lag: 2 (over its line)', L3 = M(199) + '  OK      Lag: back to normal (peak 2)';
writeFileSync(join(data, 'alerts.log.bak'), text('alerts.log.bak') + [L1, LX, L2, L3].join('\r\n') + '\r\n');
await click('#wbar [data-pk="back"]');
await click('#wbinBtn');
ok('the bin: the two Lag crossings apart, the first ended by its mark', await until('[...document.querySelectorAll("#wlist .gx-sess .gx-gn")].filter(x => x.textContent === "Lag").length === 2', 5000), JSON.stringify(await names('#wlist')));
await pickRow('#wlist', 'Lag', 0); await pickRow('#wlist', 'Lag', 1);
await click('#wbar [data-pk="restore"]');
ok('restored with its mark: all four lines in the log, none left in the bin', await untilFile(() => [L1, LX, L2, L3].every(l => lines('alerts.log').includes(l)) && ![L1, LX, L2, L3].some(l => lines('alerts.log.bak').includes(l))), text('alerts.log.bak').slice(-300));
await click('#wbar [data-pk="back"]');
ok('in the list: the first Lag crossing lasted its minute, not to a later mark', await until('[...document.querySelectorAll("#wlist .gx-sess")].filter(s => s.querySelector(".gx-gn").textContent === "Lag").some(s => s.querySelectorAll(".gx-num")[1].textContent === "1m")', 5000), await E('[...document.querySelectorAll("#wlist .gx-sess")].filter(s => s.querySelector(".gx-gn").textContent === "Lag").map(s => s.textContent).join(" | ")'));
// ---- Delete for good in the warnings' bin: two crossings one mark of the bin ended (the mark stays until the second goes),
// a row that went yellow then red (all its lines go), the old row ----
const F1 = M(400) + '  YELLOW  Foo: 1 (over its line)', B1 = M(399.5) + '  YELLOW  Bar: 1 (over its line)', FX = M(399) + '  MARK    app exit',
  Z1 = M(390) + '  YELLOW  Zed: 1 (over its line)', Z2 = M(389.5) + '  RED     Zed: 2 (over its line)', Z3 = M(389) + '  OK      Zed: back to normal (peak 2)';
writeFileSync(join(data, 'alerts.log.bak'), text('alerts.log.bak') + [F1, B1, FX, Z1, Z2, Z3].join('\r\n') + '\r\n');
const al0 = text('alerts.log');
ok('(no Delete for good outside the bin)', await E('!document.querySelector("#wlist .gx-purge")'));
await click('#wbinBtn');
ok('the bin: Foo, Bar, Zed and the old one, each with its button', await until('["Foo", "Bar", "Zed", "Old"].every(n => [...document.querySelectorAll("#wlist .gx-sess .gx-gn")].some(x => x.textContent === n))', 5000) && await E('[...document.querySelectorAll("#wlist .gx-sess")].every(s => !!s.querySelector(".gx-purge"))'), JSON.stringify(await names('#wlist')));
const barLasted = () => E(row('#wlist', 'Bar') + ".querySelectorAll('.gx-num')[1].textContent");
const bl0 = await barLasted();
await clickPurge('#wlist', 'Zed');
ok('a warning row asks too, naming it and how many times', await E('$("ctitle").textContent === "Delete this row for good?" && /^Zed, \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\. It leaves/.test($("cdesc").textContent)'), await E('$("cdesc").textContent'));
ok('and picks nothing', await E('PK.w.pick.size === 0'));
await click('#cyes');
ok('Zed (yellow, then red, then back): all three of its lines go', await untilFile(() => ![Z1, Z2, Z3].some(l => lines('alerts.log.bak').includes(l))) && [F1, B1, FX].every(l => lines('alerts.log.bak').includes(l)), text('alerts.log.bak'));
ok('its toast counts it as one warning', /^1 warning deleted for good$/.test(await toastTxt()), await toastTxt());
await clickPurge('#wlist', 'Foo'); await click('#cyes');
ok('Foo: its line goes, the mark that ended it stays for Bar', await untilFile(() => !lines('alerts.log.bak').includes(F1)) && lines('alerts.log.bak').includes(FX) && lines('alerts.log.bak').includes(B1), text('alerts.log.bak'));
ok('Bar still ends at that mark, as long as before', await until(`!${row('#wlist', 'Foo')} && !!${row('#wlist', 'Bar')}`, 4000) && await barLasted() === bl0 && bl0 !== '--', bl0 + ' / ' + await barLasted());
await clickPurge('#wlist', 'Bar'); await click('#cyes');
ok('Bar: its line and now the mark too', await untilFile(() => !lines('alerts.log.bak').includes(B1) && !lines('alerts.log.bak').includes(FX)), text('alerts.log.bak'));
await clickPurge('#wlist', 'Old'); await click('#cyes');
ok('the old row (too old to bring back) can still go', await untilFile(() => !/Old: 1/.test(text('alerts.log.bak'))));
ok('the bin is empty, its file gone, the log untouched', await until('/The bin is empty/.test($("wlist").textContent)', 4000) && !existsSync(join(data, 'alerts.log.bak')) && text('alerts.log') === al0, await E('$("wlist").textContent'));
await click('#wbar [data-pk="back"]');
await click('#wbinBtn'); await p.sleep(600);
// a big bin: 700 rows, drawn 300 at a time
await click('#wbar [data-pk="back"]');
const big = []; for (let i = 0; i < 700; i++) big.push(M(600 - i * 0.5) + '  YELLOW  Cell ' + i + ': 1 (over its line)', M(600 - i * 0.5 - 0.1) + '  OK      Cell ' + i + ': back to normal (peak 1)');
writeFileSync(join(data, 'alerts.log.bak'), big.join('\r\n') + '\r\n');
await click('#wbinBtn');
ok('a bin of 700 rows: 300 drawn and a button for the rest', await until('document.querySelectorAll("#wlist .gx-sess").length === 300 && !!$("wbMore") && /Show 400 older rows/.test($("wbMore").textContent)', 6000), await E('[document.querySelectorAll("#wlist .gx-sess").length, $("wbMore") && $("wbMore").textContent]'));
await E('(() => { const c = $("wlist").closest(".mcard"); c.scrollTop = c.scrollHeight; return 1; })()'); await p.sleep(200);   // (scrolled to the end, as you would: halfway, the bar at the bottom sits over it)
await click('#wbMore');
ok('the button draws 300 more', await until('document.querySelectorAll("#wlist .gx-sess").length === 600', 4000), await E('(() => { const b = $("wbMore"); if (!b) return "no button, rows " + document.querySelectorAll("#wlist .gx-sess").length; const r = b.getBoundingClientRect(), e = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return "rows " + document.querySelectorAll("#wlist .gx-sess").length + ", at its centre: " + (e ? e.tagName + "." + e.className + "#" + e.id : "nothing"); })()'));
await click('#wbar [data-pk="all"]');
ok('Pick all picks the whole bin, drawn or not, and turns to Pick none', await E('PK.w.pick.size === 700 && $("wbar").querySelector("[data-pk=all]").textContent === "Pick none"') && /700 picked/.test(await bar('wbar')), await bar('wbar'));
await p.key('Escape', 'Escape', 27); await p.sleep(500);
ok('Escape shuts the popup with the bin on show', await E('!$("wmodal").classList.contains("open")'));
await click('#logBtn');
ok('opened again: the log, not the bin; nothing picked, no bar', await until('!PK.w.mode && PK.w.pick.size === 0 && $("wbar").hidden && document.querySelectorAll("#wlist .gx-sess").length === 7', 5000), await E('[PK.w.mode, document.querySelectorAll("#wlist .gx-sess").length]'));
await E('$("wmodal").classList.remove("open")'); await p.sleep(300);

// ---- the editing strip: its undo, its redo, quick save ----
await E('(() => { loadStarter(); setEdit(true); return 1; })()'); await p.sleep(900);
const name0 = await E('S.L.cats[0].name');
await E("mutate(() => { S.L.cats[0].name = 'Renamed'; })"); await p.sleep(200);
ok('a change: the strip\'s undo on, its redo off', await E('!$("undoE").disabled && $("redoE").disabled'));
await click('#undoE');
ok('its undo takes the change back, its redo on', await E('S.L.cats[0].name') === name0 && await E('!$("redoE").disabled'));
await click('#redoE');
ok('its redo brings it again', await E('S.L.cats[0].name === "Renamed"'));
await click('#qsaveBtn');
ok('quick save, no slot yet: into the first free one, nothing unsaved', await until('S.active === 0 && !!S.slots[0] && !isDirty()', 3000) && await untilFile(() => existsSync(join(data, 'slots', 'slot1.json'))), await E('[S.active, isDirty()]'));
await E('setEdit(false)'); await p.sleep(300);

ok('no page errors', errs.length === 0, errs.join(' | '));
p.close();
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
