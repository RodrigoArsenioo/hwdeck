// A data folder for the range selector tests (e2e-range, e2e-range-lists; 2.4.2): the Starter's layout, 120 days of
// hourly history for its cells (hist-h.bin), game sessions over 120 days with their minutes, and warnings over the
// last month that end 6 days ago. Made up, the same every run.   node test/seed-range.mjs <dataDir>
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2]; if (!dir) { console.error('usage: node test/seed-range.mjs <dataDir>'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };
const state = JSON.parse(readFileSync(join(here, 'data-st', 'state.json'), 'utf8'));
writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gameDays: 0, warnDays: 0, updates: false, estDone: true }));
const now = Math.floor(Date.now() / 1000), nowH = Math.floor(now / 3600), DAYS = 120;
// ---- hist-h.bin: magic "HUR1", count, then per key: its name (7-bit length + UTF-8), count, (hour, average, peak)s ----
const str = s => { const b = Buffer.from(s, 'utf8'), l = []; let n = b.length; do { let x = n & 0x7F; n >>= 7; l.push(x | (n ? 0x80 : 0)); } while (n); return Buffer.concat([Buffer.from(l), b]); };
const keys = [...new Set(Object.values(state.L.cells).map(c => c.key).filter(Boolean))];
const parts = [Buffer.alloc(8)]; parts[0].writeInt32LE(0x31525548, 0); parts[0].writeInt32LE(keys.length, 4);
keys.forEach((k, ki) => {
  const lv = 40 + (ki % 7) * 9, rows = [];
  for (let h = nowH - DAYS * 24; h < nowH; h++) {
    const hod = h % 24, day = Math.floor(h / 24);
    if (hod >= 2 && hod < 9) continue;   // (nights off)
    if (day % 11 === 3) continue;          // (a day off now and then)
    const ev = hod >= 18 && day % 3 === 0 ? 1 : 0, a = lv + 4 * Math.sin(hod / 24 * 2 * Math.PI) + 9 * ev + gauss();
    rows.push([h, a, a + Math.abs(gauss()) * 2 + (ev ? 5 : 0)]);
  }
  const b = Buffer.alloc(4 + rows.length * 12); b.writeInt32LE(rows.length, 0);
  rows.forEach(([h, a, m], i) => { b.writeInt32LE(h, 4 + i * 12); b.writeFloatLE(a, 8 + i * 12); b.writeFloatLE(m, 12 + i * 12); });
  parts.push(str(k), b);
});
writeFileSync(join(dir, 'hist-h.bin'), Buffer.concat(parts));
// ---- games.log: an evening session on most days, its minutes (fps, 1% low, the main call) ----
const games = ['Deadlock', 'Marvel Rivals', 'Overwatch 2'], lines = [];
for (let d = DAYS; d >= 1; d--) {
  if (d % 4 === 1) continue;
  const start = Math.floor((now - d * 86400) / 86400) * 86400 + 19 * 3600 + Math.floor(rnd() * 3600), mins = 60 + Math.floor(rnd() * 120), front = mins * 60 - (d % 3 ? 0 : 600);
  const tf = [], tl = []; let tb = '';
  for (let m = 0; m < mins; m++) { const f = Math.round(240 + 40 * Math.sin(m / 9) + gauss() * 10); tf.push(f); tl.push(Math.round(f * 0.45)); tb += m % 17 < 15 ? 'c' : 'g'; }
  lines.push(JSON.stringify({ game: games[d % 3], start, end: start + mins * 60, from: start, secs: mins * 60, front, fps: 240, low: 108, g: 120, c: mins * 60 - 220, f: 100, warns: 0, wl: [], tf, tl, tb }));
}
writeFileSync(join(dir, 'games.log'), lines.join('\n') + '\n');
// ---- alerts.log: a yellow and its end, on some days of the last month, the newest 6 days ago (a test's narrowest
// window after it, which starts at a midnight up to 2 days back, then has none at any hour) ----
const ts = u => new Date(u * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00'), al = [];
for (let d = 30; d >= 6; d--) {
  if (d % 3) continue;
  const u = now - d * 86400 + 3600;
  for (const [name, v, unit] of [['GPU hotspot', 96.2, '°C'], ['CPU temperature', 91.5, '°C']]) {
    al.push(ts(u) + '  YELLOW  ' + name + ': ' + v + ' ' + unit, ts(u + 40) + '  OK      ' + name + ': back to normal (peak ' + v + ' ' + unit + ')');
  }
}
writeFileSync(join(dir, 'alerts.log'), al.join('\r\n') + '\r\n');
console.log('seeded ' + dir + ': ' + keys.length + ' cells x ' + DAYS + ' days of hours, ' + lines.length + ' sessions, ' + al.length / 2 + ' warnings');
