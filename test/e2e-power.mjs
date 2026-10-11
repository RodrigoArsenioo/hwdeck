// Checks for sleep and the end of a Windows session, on a data folder run-all.ps1 prepares (test\data-p): one cell
// always past its yellow line. Windows' messages are sent to this copy's own window (its pid from its app.log).
//   node test/e2e-power.mjs [port] [dataDir]
import { connect, checks } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const port = Number(process.argv[2] || 9235);
const data = process.argv[3] || 'test/data-p';
const p = await connect(port);
const errs = await p.errors();
const { ok, done } = checks();
const E = x => p.evaluate(x);
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(expr)) return true; await p.sleep(150); } return false; };
const text = f => existsSync(f) ? readFileSync(f, 'utf8') : '';
const lines = () => text(join(data, 'alerts.log')).split(/\r?\n/).filter(Boolean);
const untilLog = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f(lines())) return true; await p.sleep(250); } return false; };
const pids = () => [...text(join(data, 'app.log')).matchAll(/  start \S+ \(pid (\d+)/g)].map(m => Number(m[1]));
const alive = id => { try { process.kill(id, 0); return true; } catch (e) { return false; } };
const ps = s => { try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + s, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return 'failed'; } };
const pid = pids().pop();
// window messages to this copy, in order, the way Windows sends them: [message, wParam]
const win = (...msgs) => ps(`Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);'
$h = (Get-Process -Id ${pid}).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { 'no window'; exit }
${msgs.map(([m, w]) => `[void][U.W]::SendMessage($h, ${m}, [IntPtr]${w}, [IntPtr]::Zero)`).join('\n')}
'sent'`);
const WM_QUERYENDSESSION = 0x11, WM_ENDSESSION = 0x16, WM_POWERBROADCAST = 0x218, PBT_APMSUSPEND = 4, PBT_APMRESUMEAUTOMATIC = 0x12;
const since = n => lines().slice(n);

ok('catalog arrives', await until('READ.length === 301 && feed.got'));
ok('the cell past its line is logged', await untilLog(ls => ls.some(l => /YELLOW\s+Hot: /.test(l))), lines().slice(-2).join(' | '));
ok('this copy has a window to send to', pid > 0 && alive(pid) && win([0, 0]) === 'sent', String(pid));

// ---- a shutdown another app cancels: HW Deck goes on as it was ----
let n = lines().length;
win([WM_QUERYENDSESSION, 0], [WM_ENDSESSION, 0]);
await p.sleep(3000);
ok('a cancelled shutdown writes no exit mark and its open warning goes on (no new episode)', since(n).length === 0, since(n).join(' | '));
ok('the history was saved when Windows asked', existsSync(join(data, 'hist.bin')));

// ---- sleep: open warnings end when the PC goes to sleep, none until the wake ----
n = lines().length;
win([WM_POWERBROADCAST, PBT_APMSUSPEND]);
ok('going to sleep ends open warnings with a mark', await untilLog(ls => ls.slice(n).some(l => /MARK\s+PC going to sleep$/.test(l)), 3000), since(n).join(' | '));
await p.sleep(3000);
ok('no warnings while asleep (just the peak of the open one, then the mark)', since(n).filter(l => !/\sPEAK\s/.test(l)).length === 1, since(n).join(' | '));
n = lines().length;
win([WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC]);
ok('they come back after the wake', await untilLog(ls => ls.slice(n).some(l => /YELLOW\s+Hot: /.test(l)), 5000), since(n).join(' | '));
await E(`renderWarnings(${JSON.stringify(text(join(data, 'alerts.log')))})`);
ok('the warning log says the episode ended with the sleep', await E('$("wlist").textContent.includes("PC went to sleep")'), await E('$("wlist").textContent'));
ok('no page errors', errs.length === 0, errs.join(' | '));

// ---- signing out: Windows asks, the WebView2 browser goes first, then the session ends ----
n = lines().length;
win([WM_QUERYENDSESSION, 0]);
const kids = ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='msedgewebview2.exe'").ProcessId`).split(/\s+/).map(Number).filter(x => x > 0);
ok("this copy's WebView2 browser is found", kids.length > 0, kids.join(','));
for (const k of kids) { try { process.kill(k); } catch (e) { } }
p.close();   // the page is gone with it
const t0 = Date.now(); while (Date.now() - t0 < 6000 && !/webview process failed: BrowserProcessExited/.test(text(join(data, 'app.log')))) await p.sleep(250);
await p.sleep(3000);
ok('the browser ending with the session starts no new copy', /webview process failed: BrowserProcessExited/.test(text(join(data, 'app.log'))) && pids().pop() === pid && alive(pid), 'starts: ' + pids().join(', '));
win([WM_ENDSESSION, 1]);
ok('the end of the session writes the exit mark', await untilLog(ls => ls.slice(n).some(l => /MARK\s+app exit$/.test(l)), 3000), since(n).join(' | '));
await p.sleep(3000);
ok('nothing is logged after it', /MARK\s+app exit$/.test(lines().pop()) && since(n).filter(l => !/\sPEAK\s/.test(l)).length === 1, since(n).join(' | '));
console.log(done() ? 'ALL PASS' : 'SOME FAILED');
