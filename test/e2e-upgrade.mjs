// The update notes across upgrades (2.4.2, his ask 11-07): one data folder run as one version after another (a made-up
// copy can run as any version: HWDECK_RUNVER), one jump at a time and several at once, from installs that never had
// the notes (their app.log only) and from ones that did (settings.json's notesSeen), with the edge cases: a downgrade,
// a damaged settings file, a rotated or odd app.log, the sessions note first. It starts and closes its own copies, one
// at a time:   node test/e2e-upgrade.mjs [port]
import { connect, checks } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = 'C:\\Users\\rodri\\Code\\projects\\hwdeck', exe = join(root, 'HWDeck.exe'), port0 = +process.argv[2] || 9272;
// (a port of its own for each copy: Windows keeps a debug port that just closed busy for a while, and the next copy's
// WebView2 then opens none, every other launch)
let launches = 0;
const { ok, done } = checks();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ALL = ['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.4.1', '2.4.2'];
const TITLE = { '2.0.0': 'New in 2.0', '2.1.0': 'New in 2.1', '2.2.0': 'New in 2.2', '2.3.0': 'New in 2.3', '2.4.0': 'New in 2.4', '2.4.1': 'New in 2.4.1', '2.4.2': 'New in 2.4.2' };
const errs = [];

const dirOf = name => join(root, 'test', 'data-upg-' + name);
function fresh(name) { const d = dirOf(name); if (existsSync(d)) rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; }
const stamp = i => '2026-10-' + String(10 + i).padStart(2, '0') + ' 12:00:00+00:00';
const startLines = vs => vs.map((v, i) => stamp(i) + '  start ' + v + ' (pid ' + (100 + i) + ', data x)\r\n').join('');
const seen = d => { try { return JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')).notesSeen; } catch (e) { return 'unreadable'; } };
const lastStart = d => { const m = [...readFileSync(join(d, 'app.log'), 'utf8').matchAll(/  start (\S+) /g)]; return m.length ? m[m.length - 1][1] : null; };

// one copy, run as ver on the folder d: body(ev) checks it, then a clean exit (settings saved)
async function run(d, ver, body) {
  const port = port0 + (launches++ % 60);
  const env = Object.assign({}, process.env, { HWDECK_NOGAMES: '1', HWDECK_RUNVER: ver,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling` });
  // (the last copy's WebView2 can hold the debug port a moment after it exits: wait till nothing answers on it)
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) }); await sleep(250); } catch (e) { break; } }
  const proc = spawn(exe, ['--fake', '300', '--data', d, '--no-starter'], { cwd: root, env, stdio: 'ignore' });
  let code = null; const gone = new Promise(r => proc.on('exit', c => { code = c; r(); }));
  let p = null, last = '';
  for (let i = 0; i < 240 && !p && code === null; i++) { await sleep(250); try { p = await connect(port); } catch (e) { p = null; last = String(e && e.message || e); } }
  if (!p) {
    let lj = ''; try { lj = JSON.stringify((await (await fetch(`http://127.0.0.1:${port}/json`)).json()).map(t => t.type + ' ' + t.url)); } catch (e) { lj = 'port: ' + e.message; }
    let al = ''; try { al = readFileSync(join(d, 'app.log'), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch (e) { }
    ok(ver + ': the copy started (' + d.split('\\').pop() + ')', false, { exit: code, last, json: lj, app: al });
    if (code === null) proc.kill(); await gone; await sleep(1000); return;
  }
  p.on(m => { if (m.method === 'Runtime.exceptionThrown') errs.push(ver + ': ' + (m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text)); });
  await p.cmd('Runtime.enable');
  const ev = p.evaluate;
  for (let i = 0; i < 80; i++) { if (await ev('typeof feed === "object" && feed.got && "notesSeen" in feed').catch(() => false)) break; await sleep(250); }
  await sleep(500);
  try { await body(ev, p); }
  catch (e) { ok(ver + ': ran its checks', false, String(e && e.message || e)); }
  await ev('send({ t: "exit" }); 1').catch(() => {});
  const t = await Promise.race([gone.then(() => 1), sleep(10000).then(() => 0)]);
  if (!t) { proc.kill(); await gone; }
  await sleep(400);   // (the debug port free again)
}
// what the page shows: the cards due, the top one's title, its counter, Dismiss all, the sheets behind it
const view = ev => ev(`(() => ({ show: $('upn').classList.contains('show'), due: notesDue().map(n => n[0]), t: $('upnT').textContent, c: $('upnC').textContent,
  all: !$('upnA').hidden, n: $('upw').dataset.n, ver: feed.version, s1: getComputedStyle(document.querySelector('#upw .s1')).opacity, s2: getComputedStyle(document.querySelector('#upw .s2')).opacity,
  inWin: (() => { const r = $('upn').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })() }))()`);
const shows = (v, due) => v.show && JSON.stringify(v.due) === JSON.stringify(due) && v.t === TITLE[due[0]] && v.c === (due.length > 1 ? (due.length - 1) + ' more' : '') && v.all === due.length > 1 && v.n === String(Math.min(3, due.length));
const none = v => !v.show && v.due.length === 0;
const x = async ev => { await ev(`$('upnClose').click(); 1`); await sleep(450); };
const all = async ev => { await ev(`$('upnAll').click(); 1`); await sleep(450); };

// ---- a new install: nothing to catch up on, now or after a restart ----
{
  const d = fresh('new');
  await run(d, '2.4.2', async ev => { const v = await view(ev); ok('a new install shows no notes', none(v) && v.ver === '2.4.2', v); });
  ok('it keeps its own version as seen, and app.log its start', seen(d) === '2.4.2' && lastStart(d) === '2.4.2', [seen(d), lastStart(d)]);
  await run(d, '2.4.2', async ev => ok('started again: still none', none(await view(ev)), await view(ev)));
}

// ---- from an install that never had the notes (its app.log only): every card since the oldest version it ran, so the
// updates it went through before there were notes still get theirs (his ask 11-07), and none from before it began ----
for (const [from, due, hist] of [['2.4.1', ['2.4.2']], ['2.4.0', ['2.4.1', '2.4.2']], ['2.3.0', ['2.4.0', '2.4.1', '2.4.2']], ['2.1.2', ['2.2.0', '2.3.0', '2.4.0', '2.4.1', '2.4.2']],
  ['2.0.1', ['2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.4.1', '2.4.2']], ['1.4.0', ALL],
  ['2.3.0', ['2.4.0', '2.4.1', '2.4.2'], ['2.3.0', '2.4.0', '2.4.1']], ['2.0.0', ALL.slice(1), ['2.0.0', '2.0.1', '2.1.0', '2.2.0', '2.4.1']]]) {
  const d = fresh('from-' + from.replace(/\./g, '') + (hist ? '-' + hist.length : '')); writeFileSync(join(d, 'app.log'), startLines(hist || [from]));
  const from0 = from; { const from = hist ? from0 + ', then ' + hist.slice(1).join(', ') : from0;
  await run(d, '2.4.2', async ev => {
    const v = await view(ev);
    ok('from ' + from + ': ' + due.length + (due.length === 1 ? ' card' : ' cards') + ', the oldest on top, ' + Math.min(3, due.length) + ' deep, inside the window', shows(v, due) && v.inWin, v);
    if (due.length >= 3) ok('from ' + from + ': two sheets peek out behind it', v.s1 === '1' && v.s2 === '1', [v.s1, v.s2]);
    if (due.length === 2) ok('from ' + from + ': one sheet behind it', v.s1 === '1' && v.s2 === '0', [v.s1, v.s2]);
    if (due.length === 1) ok('from ' + from + ': no sheet, no Dismiss all', v.s1 === '0' && v.s2 === '0' && !v.all, [v.s1, v.s2, v.all]);
  });
  ok('from ' + from + ': nothing marked seen until a card is put away', seen(d) === from0, seen(d)); }
}

// ---- the deepest stack, one card at a time: every card in order, the counter going down, the last one alone ----
{
  const d = fresh('walk'); writeFileSync(join(d, 'app.log'), startLines(['1.5.11']));
  await run(d, '2.4.2', async ev => {
    const order = [];
    for (let i = 0; i < ALL.length; i++) {
      const v = await view(ev); order.push(v.t);
      if (!shows(v, ALL.slice(i))) { ok('card ' + (i + 1) + ' of the walk as expected', false, v); break; }
      await x(ev);
    }
    ok('X shows the next card each time, from 2.0 to 2.4.2', JSON.stringify(order) === JSON.stringify(ALL.map(v => TITLE[v])), order);
    ok('after the last X: none left', none(await view(ev)), await view(ev));
  });
  ok('the walk saved 2.4.2 as seen', seen(d) === '2.4.2', seen(d));
  await run(d, '2.4.2', async ev => ok('the walk, started again: none', none(await view(ev)), await view(ev)));
}

// ---- part of a stack seen, then closed: the rest comes back after a restart, and Dismiss all puts them away ----
{
  const d = fresh('part'); writeFileSync(join(d, 'app.log'), startLines(['2.3.0']));
  await run(d, '2.4.2', async ev => { await x(ev); const v = await view(ev); ok('one X of three: two left, 2.4.1 on top', shows(v, ['2.4.1', '2.4.2']), v); });
  ok('the one put away is saved as seen', seen(d) === '2.4.0', seen(d));
  await run(d, '2.4.2', async ev => {
    const v = await view(ev); ok('restarted: the two left come back', shows(v, ['2.4.1', '2.4.2']), v);
    await all(ev); ok('Dismiss all: none left', none(await view(ev)), await view(ev));
  });
  ok('Dismiss all saves the newest as seen', seen(d) === '2.4.2', seen(d));
}

// ---- an install with the notes, one update at a time (a future update path): a version with no card shows none, a
// card not put away stays and the next update's goes under it ----
{
  const d = fresh('chain');
  const steps = [['2.0.0', []], ['2.0.1', []], ['2.0.2', []], ['2.1.0', ['2.1.0'], 'x'], ['2.1.1', []], ['2.1.2', []], ['2.2.0', ['2.2.0'], 'x'],
    ['2.3.0', ['2.3.0']], ['2.4.0', ['2.3.0', '2.4.0']], ['2.4.1', ['2.3.0', '2.4.0', '2.4.1'], 'x'], ['2.4.2', ['2.4.0', '2.4.1', '2.4.2'], 'all'], ['2.4.2', []]];
  for (const [ver, due, act] of steps) {
    await run(d, ver, async ev => {
      const v = await view(ev);
      ok('one jump at a time, at ' + ver + ': ' + (due.length ? due.join(', ') : 'none'), due.length ? shows(v, due) : none(v), v);
      if (act === 'x') await x(ev); else if (act === 'all') await all(ev);
    });
  }
  ok('the chain ends with 2.4.2 seen', seen(d) === '2.4.2', seen(d));
  // a downgrade: older than what was seen shows nothing and doesn't move it back; the page can't move it back or past
  // the running version, or to something that isn't a version
  await run(d, '2.4.0', async ev => {
    ok('a downgrade to 2.4.0 shows none', none(await view(ev)), await view(ev));
    await ev(`send({ t: 'notesSeen', v: '2.0.0' }); send({ t: 'notesSeen', v: '9.9.9' }); send({ t: 'notesSeen', v: 'abc' }); send({ t: 'notesSeen', v: 7 }); 1`); await sleep(500);
  });
  ok('a downgrade keeps 2.4.2 as seen, whatever the page sends', seen(d) === '2.4.2', seen(d));
  await run(d, '2.4.2', async ev => ok('back on 2.4.2: still none', none(await view(ev)), await view(ev)));
}

// ---- several jumps at once with the notes: 2.0.0 straight to 2.4.2 ----
{
  const d = fresh('jump');
  await run(d, '2.0.0', async ev => ok('2.0.0 as a new install: none', none(await view(ev)), await view(ev)));
  await run(d, '2.4.2', async ev => ok('2.0.0 to 2.4.2 in one jump: 6 cards from 2.1', shows(await view(ev), ALL.slice(1)), await view(ev)));
  await run(d, '2.2.0', async ev => ok('then back to 2.2.0 before seeing them: only what 2.2.0 knows (2.1, 2.2)', shows(await view(ev), ['2.1.0', '2.2.0']), await view(ev)));
}

// ---- odd app.logs: a version that came back to an older one, junk lines, a rotated log ----
{
  const d = fresh('down'); writeFileSync(join(d, 'app.log'), startLines(['2.4.1', '2.3.0']));
  await run(d, '2.4.2', async ev => ok('app.log that went back to 2.3.0 once: from 2.3.0, the oldest', shows(await view(ev), ['2.4.0', '2.4.1', '2.4.2']), await view(ev)));
  const j = fresh('junk'); writeFileSync(join(j, 'app.log'), startLines(['2.2.0']) + 'garbage line\r\n' + stamp(20) + '  start abc (pid 9)\r\n' + stamp(21) + '  start 2.3 (pid 9)\r\n' + stamp(22) + '  restart 9.9.9 x\r\nstart 9.9.9 at the very start\r\n');
  await run(j, '2.4.2', async ev => ok('junk and broken start lines are skipped: from 2.2.0', shows(await view(ev), ['2.3.0', '2.4.0', '2.4.1', '2.4.2']), await view(ev)));
  const r = fresh('rot'); writeFileSync(join(r, 'app.log'), stamp(1) + '  some line, no start\r\n'); writeFileSync(join(r, 'app.log.old'), startLines(['2.4.0']));
  await run(r, '2.4.2', async ev => ok('a rotated app.log: the start in app.log.old counts', shows(await view(ev), ['2.4.1', '2.4.2']), await view(ev)));
  const b = fresh('both'); writeFileSync(join(b, 'app.log'), startLines(['2.4.1'])); writeFileSync(join(b, 'app.log.old'), startLines(['2.0.0']));
  await run(b, '2.4.2', async ev => ok('app.log.old counts too: from its 2.0.0, the oldest of both', shows(await view(ev), ALL.slice(1)), await view(ev)));
}

// ---- settings.json: damaged, or notesSeen not a version: the app.log decides again ----
{
  const d = fresh('bad'); writeFileSync(join(d, 'app.log'), startLines(['2.4.0'])); writeFileSync(join(d, 'settings.json'), '{ not json');
  await run(d, '2.4.2', async ev => ok('a damaged settings.json: from app.log (2.4.0)', shows(await view(ev), ['2.4.1', '2.4.2']), await view(ev)));
  const n = fresh('num'); writeFileSync(join(n, 'app.log'), startLines(['2.4.1'])); writeFileSync(join(n, 'settings.json'), JSON.stringify({ notesSeen: 5, updates: true }));
  await run(n, '2.4.2', async ev => ok('notesSeen not a string: from app.log (2.4.1)', shows(await view(ev), ['2.4.2']), await view(ev)));
  ok('and it is written as a version now, the other settings kept', seen(n) === '2.4.1' && JSON.parse(readFileSync(join(n, 'settings.json'), 'utf8')).updates === true, readFileSync(join(n, 'settings.json'), 'utf8'));
}

// ---- the sessions note (2.1) and Starter's note come first; the cards after them ----
{
  const d = fresh('est'); writeFileSync(join(d, 'app.log'), startLines(['2.0.1'])); writeFileSync(join(d, 'settings.json'), JSON.stringify({ estDone: true, estNote: 3 }));
  await run(d, '2.4.2', async ev => {
    const v = await view(ev), est = await ev(`$('estNotice').classList.contains('show')`);
    ok('the sessions note is up: the cards wait', est && !v.show, [est, v]);
    await ev(`$('estClose').click(); 1`); await sleep(450);
    ok('its X: the cards come up, all 6', shows(await view(ev), ALL.slice(1)), await view(ev));
    await ev(`$('notice').classList.add('show'); notesCheck(); 1`); await sleep(100);
    ok('Starter\'s note up: the cards step aside', !(await view(ev)).show, await view(ev));
    await ev(`starterSeen(); 1`); await sleep(450);
    ok('Starter\'s X: the cards back, the same one on top', shows(await view(ev), ALL.slice(1)), await view(ev));
    await ev(`renderSettings(); setmodal.classList.add('open'); send({ t: 'getSettings' }); 1`); await sleep(800);
    ok('Settings asked again: the same cards, none doubled', shows(await view(ev), ALL.slice(1)) && await ev(`document.querySelectorAll('#upn').length === 1 && $('upnL').children.length === NOTES[1][2].length`), await view(ev));
    await ev(`setmodal.classList.remove('open'); $('upnClose').click(); $('upnClose').click(); 1`); await sleep(600);
    ok('two quick X: two cards gone, 2.3 on top', shows(await view(ev), ALL.slice(3)), await view(ev));
  });
  ok('the sessions note was put away for good and the two quick X saved', seen(d) === '2.2.0' && (() => { try { return !('estNote' in JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'))); } catch (e) { return false; } })(), readFileSync(join(d, 'settings.json'), 'utf8'));
}

// ---- the card's text: no dashes or arrows, each line a sentence ----
{
  const d = fresh('text'); writeFileSync(join(d, 'app.log'), startLines(['1.0.0']));
  await run(d, '2.4.2', async ev => {
    const t = await ev(`NOTES.map(n => n[2].join(' ')).join(' ')`);
    ok('the notes hold no dashes, arrows or emojis', !/[\u2013\u2014\u2192]|\p{Extended_Pictographic}/u.test(t), t.slice(0, 80));
    ok('every line ends with a full stop', await ev(`NOTES.every(n => n[2].every(l => /\\.$/.test(l)))`));
    ok('every card has a version the stack knows, oldest first', await ev(`NOTES.every((n, i) => i === 0 || verNewer(n[0], NOTES[i - 1][0]))`));
  });
}

ok('no page errors', errs.length === 0, errs.join(' | '));
for (const n of ['new', 'walk', 'part', 'chain', 'jump', 'down', 'junk', 'rot', 'both', 'bad', 'num', 'est', 'text'].concat(['2.4.1', '2.4.0', '2.3.0', '2.1.2', '2.0.1', '1.4.0', '2.3.0-3', '2.0.0-5'].map(f => 'from-' + f.replace(/\./g, ''))))
  try { rmSync(dirOf(n), { recursive: true, force: true }); } catch (e) { }
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
process.exit(0);
