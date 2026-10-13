// HW Deck in a browser: a stand-in for the app around the real page (deck.js, deck.css and index.html, unchanged).
// The page talks to its host through window.chrome.webview; this file, loaded just before deck.js, is that host: it
// answers the page's messages and feeds it made-up readings of a gaming PC, a game running now and then. Values are
// worked out from the time alone, so the 15 minutes of seconds, the history up to 7 days and the game reports all
// agree. Nothing leaves the tab: a layout is kept in this tab's sessionStorage, nothing else is stored or sent.
(() => {
  'use strict';
  const RELEASES = 'https://github.com/RodrigoArsenioo/hwdeck/releases/latest';
  const VERSION = '1.4.3';
  const T0 = Math.floor(Date.now() / 1000);
  const nowS = () => Math.floor(Date.now() / 1000);
  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

  // ---- noise from (seed, time): the same moment always gives the same value ----
  const hash = (a, b) => {
    let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (seed, t, period) => { const x = t / period, k = Math.floor(x), f = x - k, a = hash(seed, k), b = hash(seed, k + 1); return a + (b - a) * f * f * (3 - 2 * f); };
  const jit = (seed, t) => hash(seed, t) * 2 - 1;
  const interp = (pts, x) => { if (x <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [a, b] = [pts[i - 1], pts[i]]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); } return pts[pts.length - 1][1]; };

  // ---- when a game runs: in the last two hours 6 minutes in every 9 (one started just before the page opened), before
  // that most evenings, in blocks of 44 minutes ----
  const GAMES = ['Cyberpunk 2077', 'Baldur\'s Gate 3', 'Counter-Strike 2', 'Forza Horizon 5', 'Elden Ring'];
  const CYCLE = 540, PLAY = 360, RECENT = T0 - 7200, FIRST = T0 - 140;
  const tzOff = -new Date().getTimezoneOffset() * 60;
  function eveningOf(day) {   // the evening of a local day: when play starts (hours) and how long, or null
    if (hash(91, day) < 0.25) return null;
    return { from: 19 + Math.floor(hash(92, day) * 4) * 0.5, len: 1.4 + hash(93, day) * 2.4 };
  }
  function gameAt(t) {
    if (t >= RECENT) {
      const k = Math.floor((t - FIRST) / CYCLE), s = FIRST + k * CYCLE;
      return t - s < PLAY ? { start: s, k: 100000 + k, name: GAMES[0] } : null;
    }
    const day = Math.floor((t + tzOff) / 86400), ev = eveningOf(day); if (!ev) return null;
    const into = (t + tzOff) - day * 86400 - ev.from * 3600; if (into < 0 || into > ev.len * 3600) return null;
    const blk = Math.floor(into / 3000), off = into - blk * 3000; if (off >= 2640) return null;
    return { start: t - off, k: day * 10 + blk, name: GAMES[1 + Math.floor(hash(94, day) * 4)] };
  }

  // ---- the PC each second: loads, frame rate, what limits it ----
  const memo = new Map();
  function core(t) {
    let c = memo.get(t); if (c) return c;
    if (memo.size > 30000) memo.clear();
    const g = gameAt(t), sm = smooth(5, t, 7), sm2 = smooth(6, t, 11);
    let gpu, thr, cpu, fps = null, low = null, call = null;
    if (g) {
      const ph = hash(77, Math.floor((t - g.start) / 45) + g.k * 977), kind = ph < 0.66 ? 1 : ph < 0.86 ? 2 : 3;
      if (kind === 1) { gpu = 95.6 + 3.4 * sm; thr = 56 + 18 * sm2; cpu = 25 + 8 * sm2; fps = 156 + 26 * sm2 + 4 * jit(7, t); low = fps * (0.66 + 0.08 * sm); }
      else if (kind === 2) { gpu = 70 + 10 * sm; thr = 86 + 10 * sm2; cpu = 34 + 8 * sm2; fps = 116 + 18 * sm + 3 * jit(7, t); low = fps * (0.57 + 0.08 * sm2); }
      else { gpu = 55 + 12 * sm; thr = 44 + 14 * sm2; cpu = 17 + 6 * sm; fps = 143.6 + 0.5 * jit(7, t); low = fps * (0.9 + 0.04 * sm); }
      call = gpu >= 85 ? 1 : thr >= 80 ? 2 : 3;
    } else {
      const b = smooth(8, t, 23), burst = b > 0.82 ? (b - 0.82) * 260 : 0;   // a browser tab, an update
      gpu = 3 + 5 * smooth(9, t, 17) + burst * 0.25; thr = 9 + 16 * smooth(10, t, 13) + burst; cpu = 3 + 5 * smooth(11, t, 19) + burst * 0.4;
    }
    c = { g, gpu: clamp(gpu), thr: clamp(thr), cpu: clamp(cpu), fps, low, call, eff: 0.55 * clamp(cpu) + 0.45 * clamp(thr) };
    memo.set(t, c); return c;
  }
  const lag = (t, f) => { let s = 0; for (let j = 0; j < 7; j++) s += f(core(t - j * 15)); return s / 7; };   // over the last 1.5 min: heat
  const cpuT = t => 41 + 0.42 * lag(t, c => c.eff) + 0.35 * jit(21, t);
  const gpuT = t => 33 + 0.38 * lag(t, c => c.gpu) + 0.25 * jit(22, t);

  // ---- the sensors and readings, named and keyed like HWiNFO's (key: sensor id / type << 24 | index) ----
  const SENSORS = [
    ['f0000501.0', 'CPU [#0]: AMD Ryzen 7 9800X3D: Enhanced'], ['e0002000.0', 'GPU [#0]: NVIDIA GeForce RTX 4080 SUPER'],
    ['f7067010.0', 'ASUS ROG STRIX B650E-F GAMING WIFI (Nuvoton NCT6799D)'], ['f0000100.0', 'S.M.A.R.T.: Samsung SSD 990 PRO 2TB [C:]'],
    ['f0000101.0', 'S.M.A.R.T.: WD_BLACK SN850X 2TB [D:]'], ['f3000005.0', 'DDR5 DIMM [#0]: Kingston FURY Beast 32GB'],
    ['f3000007.0', 'DDR5 DIMM [#2]: Kingston FURY Beast 32GB'], ['f0000003.0', 'System'], ['f0000ff0.0', 'PresentMon'], ['hwdeck.0', 'HW Deck']];
  const FANS = { cpu: [[40, 750], [55, 950], [70, 1350], [85, 1900]], front: [[35, 700], [55, 900], [70, 1250], [80, 1600]], top: [[40, 650], [60, 800], [75, 1100]],
    gpu: [[35, 1000], [60, 1250], [75, 1700]], bottom: [[35, 600], [60, 900], [75, 1300]] };
  const VRAM = 16376, RAM = 63850;
  const vram = t => { const c = core(t); return c.g ? 9400 + 900 * smooth(30, t, 60) : 1900 + 300 * smooth(30, t, 90); };
  const ram = t => { const c = core(t); return c.g ? 23800 + 900 * smooth(31, t, 70) : 15200 + 700 * smooth(31, t, 120); };
  const io = (seed, t) => { const b = smooth(seed, t, 9); return b > 0.8 ? (b - 0.8) * 5 * (300 + 2400 * hash(seed, Math.floor(t / 9))) : 0.4 * hash(seed + 1, t); };
  const R = [];   // [sensor, type, label, unit, value(t)]
  const add = (s, type, label, unit, f) => R.push({ s, type, label, unit, f });
  // CPU
  add(0, 1, 'CPU (Tctl/Tdie)', '°C', cpuT);
  add(0, 1, 'CPU Die (average)', '°C', t => cpuT(t) - 2.6);
  add(0, 5, 'CPU Package Power', 'W', t => 31 + 1.05 * core(t).eff + jit(23, t));
  add(0, 5, 'CPU Core Power (SVI3 TFN)', 'W', t => 13 + 0.95 * core(t).eff + 0.6 * jit(24, t));
  add(0, 5, 'CPU SoC Power (SVI3 TFN)', 'W', t => 12.6 + 0.6 * smooth(25, t, 11));
  add(0, 6, 'Core Clocks (avg)', 'MHz', t => core(t).g ? 5150 + 50 * smooth(26, t, 5) : 3600 + 1500 * smooth(26, t, 7));
  add(0, 7, 'Total CPU Usage', '%', t => core(t).cpu);
  add(0, 7, 'Max CPU/Thread Usage', '%', t => core(t).thr);
  add(0, 2, 'CPU Core Voltage (SVI3 TFN)', 'V', t => 1.02 + 0.0025 * core(t).eff + 0.004 * jit(27, t));
  // GPU
  add(1, 1, 'GPU Temperature', '°C', gpuT);
  add(1, 1, 'GPU Hot Spot Temperature', '°C', t => gpuT(t) + 9 + 0.04 * core(t).gpu);
  add(1, 1, 'GPU Memory Junction Temperature', '°C', t => gpuT(t) + 10 + 0.03 * core(t).gpu);
  add(1, 5, 'GPU Power', 'W', t => 18 + 3 * core(t).gpu + 10 * smooth(28, t, 5));
  add(1, 6, 'GPU Clock', 'MHz', t => core(t).gpu > 20 ? 2700 + 60 * smooth(29, t, 6) : 210 + 120 * smooth(29, t, 9));
  add(1, 6, 'GPU Memory Clock', 'MHz', t => core(t).g ? 1438 : 101);
  add(1, 7, 'GPU Core Load', '%', t => core(t).gpu);
  add(1, 8, 'GPU Memory Allocated', 'MB', vram);
  add(1, 8, 'GPU Memory Available', 'MB', t => VRAM - vram(t));
  add(1, 3, 'GPU Fan1', 'RPM', t => interp(FANS.gpu, gpuT(t)) * (1 + 0.01 * jit(32, t)));
  add(1, 3, 'GPU Fan2', 'RPM', t => interp(FANS.gpu, gpuT(t)) * (1.02 + 0.01 * jit(33, t)));
  add(1, 2, 'GPU Core Voltage', 'V', t => core(t).gpu > 20 ? 0.98 + 0.05 * smooth(34, t, 6) : 0.89);
  // motherboard
  add(2, 1, 'Motherboard', '°C', t => 33 + 0.05 * lag(t, c => c.eff) + smooth(35, t, 60));
  add(2, 1, 'Chipset', '°C', t => 49 + 3 * smooth(36, t, 80) + 0.03 * core(t).eff);
  add(2, 1, 'VRM MOS', '°C', t => 38 + 0.2 * lag(t, c => c.eff));
  add(2, 3, 'CPU Fan', 'RPM', t => interp(FANS.cpu, cpuT(t)) * (1 + 0.012 * jit(37, t)));
  add(2, 3, 'Chassis Fan 1', 'RPM', t => interp(FANS.front, gpuT(t)) * (1 + 0.01 * jit(38, t)));
  add(2, 3, 'Chassis Fan 2', 'RPM', t => interp(FANS.top, cpuT(t)) * (1 + 0.01 * jit(39, t)));
  add(2, 3, 'AIO Pump', 'RPM', t => 2580 + 25 * jit(40, t));
  add(2, 2, '+12V', 'V', t => 12.096 + 0.012 * jit(41, t));
  add(2, 2, '+5V', 'V', t => 5.04 + 0.006 * jit(42, t));
  add(2, 2, '+3.3V', 'V', t => 3.344 + 0.004 * jit(43, t));
  // drives, memory, the system
  for (const [s, base, seed] of [[3, 39, 50], [4, 35, 60]]) {
    add(s, 1, 'Drive Temperature', '°C', t => base + 4 * smooth(seed, t, 300) + 0.03 * core(t).eff + 0.3 * smooth(seed + 9, t, 20));
    add(s, 1, 'Drive Temperature 2', '°C', t => base + 9 + 4 * smooth(seed, t, 300) + 0.04 * core(t).eff);
    add(s, 8, 'Read Rate', 'MB/s', t => io(seed + 2, t));
    add(s, 8, 'Write Rate', 'MB/s', t => io(seed + 4, t) * 0.6);
    add(s, 7, 'Total Activity', '%', t => clamp((io(seed + 2, t) + io(seed + 4, t)) / 40));
  }
  add(5, 1, 'SPD Hub Temperature', '°C', t => 41 + 0.06 * lag(t, c => c.eff) + smooth(70, t, 120));
  add(6, 1, 'SPD Hub Temperature', '°C', t => 39.5 + 0.06 * lag(t, c => c.eff) + smooth(71, t, 120));
  add(7, 8, 'Physical Memory Used', 'MB', ram);
  add(7, 8, 'Physical Memory Available', 'MB', t => RAM - ram(t));
  add(7, 7, 'Physical Memory Load', '%', t => ram(t) / RAM * 100);
  // the game, by PresentMon; on the desktop it follows whatever is in front
  add(8, 8, 'Framerate', 'FPS', t => core(t).fps != null ? core(t).fps : 60 + 0.2 * jit(72, t));
  add(8, 8, 'Framerate (1% low)', 'FPS', t => core(t).low != null ? core(t).low : 58 + 0.5 * jit(73, t));
  add(8, 8, 'Frame Time', 'ms', t => 1000 / (core(t).fps != null ? core(t).fps : 60));
  // HW Deck's own: the bottleneck, 1 gpu, 2 cpu, 3 capped (none: no game)
  add(9, 8, 'Bottleneck', '', t => core(t).call);
  const per = {};
  R.forEach(r => {
    const sk = SENSORS[r.s][0];
    if (sk === 'hwdeck.0') r.key = 'hwdeck.0/bneck';
    else { const j = per[r.s + ':' + r.type] = (per[r.s + ':' + r.type] || 0); per[r.s + ':' + r.type]++; r.key = sk + '/' + ((r.type << 24) | j).toString(16).padStart(8, '0'); }
  });
  const K = {}; for (const r of R) K[SENSORS[r.s][0] + '|' + r.label] = r.key;
  const key = (s, label) => K[SENSORS[s][0] + '|' + label];
  const BYKEY = new Map(R.map((r, i) => [r.key, Object.assign(r, { i })]));
  const val = (r, t) => { const v = r.f(t); return v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000; };
  const PM = new Set(R.filter(r => r.s === 8).map(r => r.key));

  // ---- the layout it opens on ----
  const cell = (s, label, name, more) => Object.assign({ key: key(s, label), name, graph: true }, more || {});
  const yr = (y, r, dir) => ({ gates: { mode: r == null ? 'y' : 'yr', dir: dir || 'above', y, r: r == null ? NaN : r, hold: 3 } });
  const curve = (s, label, pts, extra) => ({ curve: Object.assign({ src: key(s, label), pts, tol: 15, hold: 10 }, extra || {}) });
  const DEMO = {
    v: 1,
    cats: [
      { id: 'gpu', name: 'GPU', collapsed: false, cells: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'] },
      { id: 'cpu', name: 'CPU', collapsed: false, cells: ['c1', 'c2', 'c3', 'c4', 'c5'] },
      { id: 'fans', name: 'Fans', collapsed: false, cells: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'] },
      { id: 'game', name: 'Game', collapsed: false, cells: ['p1', 'p2', 'p3', 'p4'] },
      { id: 'storage', name: 'Storage', collapsed: false, cells: ['s1', 's2'] },
      { id: 'memory', name: 'Memory', collapsed: false, cells: ['m1', 'm2', 'm3'] },
      { id: 'board', name: 'Board', collapsed: false, cells: ['b1', 'b2', 'b3'] }],
    cells: {
      g1: cell(1, 'GPU Temperature', 'Temperature', yr(80, 88)), g2: cell(1, 'GPU Hot Spot Temperature', 'Hot spot', yr(92, 100)),
      g3: cell(1, 'GPU Memory Junction Temperature', 'Memory', yr(95, 105)), g4: cell(1, 'GPU Power', 'Board power'),
      g5: cell(1, 'GPU Core Load', 'Usage'), g6: cell(1, 'GPU Memory Allocated', 'VRAM used'), g7: cell(1, 'GPU Clock', 'Core clock'),
      c1: cell(0, 'CPU (Tctl/Tdie)', 'Temperature', yr(85, 95)), c2: cell(0, 'CPU Package Power', 'Package power'), c3: cell(0, 'Total CPU Usage', 'Usage'),
      c4: cell(0, 'Core Clocks (avg)', 'Clock'), c5: cell(0, 'CPU SoC Power (SVI3 TFN)', 'SoC power'),
      f1: cell(2, 'CPU Fan', 'CPU fan', curve(0, 'CPU (Tctl/Tdie)', FANS.cpu)), f2: cell(2, 'Chassis Fan 1', 'Front', curve(1, 'GPU Temperature', FANS.front)),
      f3: cell(2, 'Chassis Fan 2', 'Top', curve(0, 'CPU (Tctl/Tdie)', FANS.top)), f4: cell(1, 'GPU Fan1', 'GPU fans'),
      f5: cell(2, 'AIO Pump', 'Pump', yr(1500, 800, 'below')),
      f6: { pred: true, name: 'Bottom fans', graph: true, curve: { src: key(1, 'GPU Temperature'), pts: FANS.bottom, tol: 15, hold: 10 } },
      p1: cell(8, 'Framerate', 'FPS', yr(60, 30, 'below')), p2: cell(8, 'Framerate (1% low)', '1% low'), p3: { key: 'hwdeck.0/bneck', name: 'Bottleneck', graph: true },
      p4: cell(8, 'Frame Time', 'Frame time'),
      s1: cell(3, 'Drive Temperature', 'Samsung 990 PRO', yr(65, 70)), s2: cell(4, 'Drive Temperature', 'WD SN850X', yr(65, 70)),
      m1: cell(5, 'SPD Hub Temperature', 'DIMM 1'), m2: cell(6, 'SPD Hub Temperature', 'DIMM 2'), m3: cell(7, 'Physical Memory Used', 'RAM used'),
      b1: cell(2, 'Motherboard', 'Motherboard'), b2: cell(2, 'Chipset', 'Chipset'), b3: cell(2, 'VRM MOS', 'VRM')
    },
    views: { overview: { rows: [{ cols: [{ stack: ['gpu'] }, { stack: ['cpu'] }] }, { cols: [{ stack: ['fans'] }, { stack: ['game', 'storage'] }, { stack: ['memory', 'board'] }] }] } }
  };
  const DEMO_STATE = { v: 1, L: DEMO, active: 0, edit: false, screen: 'overview', pins: [false, false], clock: true };

  // ---- this tab's storage: the only place anything is kept ----
  const SK = 'hwdeck-demo:';
  const load = k => { try { const s = sessionStorage.getItem(SK + k); return s ? JSON.parse(s) : undefined; } catch (e) { return undefined; } };
  const keep = (k, v) => { try { sessionStorage.setItem(SK + k, JSON.stringify(v)); } catch (e) { /* no storage: it lasts until the tab reloads */ } };
  const resetDemo = () => { try { for (const k of Object.keys(sessionStorage)) if (k.startsWith(SK)) sessionStorage.removeItem(k); } catch (e) { } location.reload(); };

  // ---- the warning log and the game reports the popups open on ----
  const p2 = n => ('0' + n).slice(-2);
  const stamp = u => { const d = new Date(u * 1000), o = -d.getTimezoneOffset(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + (o >= 0 ? '+' : '-') + p2(Math.floor(Math.abs(o) / 60)) + ':' + p2(Math.abs(o) % 60); };
  const sessions = (() => {   // the evening blocks of the last 5 days, newest last
    const out = [], today = Math.floor((T0 + tzOff) / 86400);
    for (let day = today - 5; day < today; day++) {
      const ev = eveningOf(day); if (!ev) continue;
      const t0 = day * 86400 - tzOff + ev.from * 3600;
      for (let b = 0; b * 3000 < ev.len * 3600 && out.length < 8; b++) { const s = Math.round(t0 + b * 3000), e = Math.round(Math.min(s + 2640, t0 + ev.len * 3600)); if (e - s >= 600) out.push({ start: s, end: e, name: gameAt(s + 5) ? gameAt(s + 5).name : GAMES[1] }); }
    }
    return out.slice(-6);
  })();
  // the one warning of a game session: 20 minutes into the newest long one (its report says so too)
  const hot = sessions.slice().reverse().find(s => s.end - s.start >= 1800), HOT_AT = hot ? hot.start + 1210 : T0 - 86400;
  const alertsLog = (() => {
    const L = [], at = HOT_AT;
    L.push(stamp(at) + '  YELLOW  CPU temperature: 85.6 °C', stamp(at + 9) + '  OK      CPU temperature: back to normal (peak 86.1 °C)');
    L.push(stamp(T0 - 3 * 86400 + 4000) + '  YELLOW  Pump: 1420 RPM', stamp(T0 - 3 * 86400 + 4007) + '  OK      Pump: back to normal (peak 1380 RPM)');
    return L.join('\r\n');
  })();
  function report(s) {
    const mins = Math.ceil((s.end - s.start) / 60), tf = [], tl = [], tc = []; let tb = '', g = 0, c = 0, f = 0, fs = 0, fn = 0, ls = 0, fr = 0;
    const acc = {};   // name: [sum, n, max]
    const want = [['GPU temp', '°C', t => gpuT(t), 80, 88, 1], ['GPU hotspot', '°C', t => val(BYKEY.get(key(1, 'GPU Hot Spot Temperature')), t), 92, 100, 1],
      ['GPU memory', '°C', t => val(BYKEY.get(key(1, 'GPU Memory Junction Temperature')), t), 95, 105, 1], ['GPU power', 'W', t => val(BYKEY.get(key(1, 'GPU Power')), t), null, null, 1],
      ['GPU usage', '%', t => core(t).gpu, null, null, 1], ['CPU temp', '°C', cpuT, 85, 95, 1], ['CPU power', 'W', t => val(BYKEY.get(key(0, 'CPU Package Power')), t), null, null, 1],
      ['CPU usage', '%', t => core(t).cpu, null, null, 1], ['VRAM', 'MB', vram, null, null, 1, VRAM], ['RAM', 'MB', ram, null, null, 1, RAM],
      ['Samsung 990 PRO', '°C', t => val(BYKEY.get(key(3, 'Drive Temperature')), t), 65, 70, 0], ['WD SN850X', '°C', t => val(BYKEY.get(key(4, 'Drive Temperature')), t), 65, 70, 0]];
    for (let m = 0; m < mins; m++) {
      let mg = 0, mc = 0, mf = 0, ff = 0, fl = 0, n = 0, nf = 0;
      for (let q = 0; q < 60; q += 10) {
        const t = s.start + m * 60 + q; if (t >= s.end) break;
        const k = core(t); n++;
        const call = k.call || (s.custom ? (k.gpu >= 95 ? 1 : k.thr >= 80 ? 2 : 3) : null);   // (yours: the call of the moment, game or not)
        if (call === 1) mg += 10; else if (call === 2) mc += 10; else if (call === 3) mf += 10;
        if (k.fps != null) { ff += k.fps; fl += k.low; nf++; }
        if (k.g) fr += 10;
        for (const w of want) { const v = w[2](t), a = acc[w[0]] || (acc[w[0]] = [0, 0, -1e9]); a[0] += v; a[1]++; a[2] = Math.max(a[2], v); }
      }
      if (!n) break;
      g += mg; c += mc; f += mf; fs += ff; ls += fl; fn += nf;
      tf.push(nf ? Math.round(ff / nf) : null); tl.push(nf ? Math.round(fl / nf) : null); tc.push(mg + mc + mf ? [mg, mc, mf] : null);
      tb += mg + mc + mf === 0 ? '-' : mc >= mg && mc >= mf ? 'c' : mg >= mf ? 'g' : 'f';
    }
    // the readings the session details were set up with (Customize), by key
    const st = load('state') || DEMO_STATE, gs = st && st.L && st.L.games && Array.isArray(st.L.games.secs) ? st.L.games.secs : [];
    const tk = [...new Set(gs.flatMap(x => Array.isArray(x.cells) ? x.cells.map(c => c && c.key).filter(k => typeof k === 'string' && BYKEY.has(k)) : []))], ta = {};
    for (let t = s.start; t < s.end; t += 60) for (const k of tk) { const v = val(BYKEY.get(k), t); if (v == null) continue; const a = ta[k] || (ta[k] = [0, 0, -1e9]); a[0] += v; a[1]++; a[2] = Math.max(a[2], v); }
    const warn = s === hot;
    const items = want.map(w => { const a = acc[w[0]]; return [w[0], w[1], Math.round(a[0] / a[1] * 10) / 10, warn && w[0] === 'CPU temp' ? 86.1 : Math.round(a[2] * 10) / 10, w[3], w[4], w[5], w[6] || null, 0]; })
      .concat(tk.filter(k => ta[k]).map(k => { const r = BYKEY.get(k), a = ta[k]; return [r.label, r.unit, Math.round(a[0] / a[1] * 10) / 10, Math.round(a[2] * 10) / 10, null, null, 0, null, 0, k]; }));
    const out = { game: s.name, start: s.start, end: s.end, from: s.start, secs: s.end - s.start, front: s.custom ? fr : s.end - s.start, fps: fn ? Math.round(fs / fn) : null, low: fn ? Math.round(ls / fn) : null, items,
      warns: warn ? 1 : 0, wl: warn ? [['CPU temperature', 86.1, '°C']] : [], g, c, f, tf, tl, tb, tc };
    if (s.custom) out.custom = 1;
    return out;
  }
  // the sessions: the made-up evenings, the ones you recorded here (own), less the ones you deleted and the older than you keep
  const days = k => load(k) || 30, sid = x => x.start + '|' + x.end + '|' + x.name;
  const gamesLog = () => {
    const gone = new Set(load('gone') || []), cut = nowS() - days('gameDays') * 86400;
    const all = (load('gamesCleared') ? [] : sessions).concat(load('own') || []).filter(s => !gone.has(sid(s)) && s.end >= cut).sort((a, b) => a.start - b.start);
    return all.map(s => JSON.stringify(report(s))).join('\r\n');
  };
  const settingsMsg = () => ({ t: 'settings', autostart: false, hwinfo: 'Made-up readings in this demo', updates: false, latest: null, gameDays: days('gameDays'), warnDays: days('warnDays') });

  // ---- the long history a popup asks for: 1 h to 24 h as minutes, 7 days as 10-minute blocks ----
  function hist(k, range) {
    const week = range === '7d', step = week ? 600 : 60, n = week ? 1008 : range === '1h' ? 60 : range === '6h' ? 360 : range === '12h' ? 720 : 1440;
    const end = Math.floor(nowS() / step) * step, r = BYKEY.get(k), q = week ? 12 : 4, avg = [], max = [], sg = [], sc = [], sf = [];
    for (let i = 0; i < n; i++) {
      const b = end - (n - 1 - i) * step; let s = 0, m = -1e9, c = 0, cg = 0, cc = 0, cf = 0;
      for (let j = 0; j < q; j++) {
        const t = b + Math.floor((j + 0.5) * step / q); if (t > nowS()) break;
        const v = r ? val(r, t) : null; if (v != null) { s += v; c++; m = Math.max(m, v); }
        const call = core(t).call; if (call === 1) cg++; else if (call === 2) cc++; else if (call === 3) cf++;
      }
      const seen = Math.max(1, j0(b, step, q));
      avg.push(c ? Math.round(s / c * 1000) / 1000 : null); max.push(c ? m : null);
      sg.push(cg / seen); sc.push(cc / seen); sf.push(cf / seen);
    }
    const h = { t: 'hist', key: k, range: week ? '7d' : range, step, span: n * step, avg, max, end };
    if (k === 'hwdeck.0/bneck') Object.assign(h, { sg, sc, sf });
    return h;
  }
  const j0 = (b, step, q) => { let n = 0; for (let j = 0; j < q; j++) if (b + Math.floor((j + 0.5) * step / q) <= nowS()) n++; return n; };   // (the samples of the block so far)

  // ---- the host: what the app answers, here ----
  const listeners = [];
  const post = m => setTimeout(() => { for (const f of listeners) f({ data: m }); }, 0);
  const toast = text => post({ t: 'toast', text, ms: 4000 });
  const IN_APP = 'Works in the app: download HW Deck from the link below';
  let subs = new Set(), timer = 0;
  const since = new Map();   // HWiNFO's own min / max / average, since the page opened (seeded with the hour before)
  function mma(r, t, v) {
    let a = since.get(r.key);
    if (!a) { a = [Infinity, -Infinity, 0, 0]; for (let x = t - 3600; x < t; x += 30) { const w = val(r, x); if (w != null) { a[0] = Math.min(a[0], w); a[1] = Math.max(a[1], w); a[2] += w; a[3]++; } } since.set(r.key, a); }
    if (v != null) { a[0] = Math.min(a[0], v); a[1] = Math.max(a[1], v); a[2] += v; a[3]++; }
    return a[3] ? [a[0], a[1], Math.round(a[2] / a[3] * 1000) / 1000] : [null, null, null];
  }
  let sess = null;   // this game session's numbers of the game's own readings: min, sum, n, max
  function tick() {
    const t = nowS(), c = core(t), i = [], v = [], mn = [], mx = [], av = [];
    if (c.g && (!sess || sess.start !== c.g.start)) sess = { start: c.g.start, pm: {} };
    if (!c.g) sess = null;
    for (const r of R) {
      const x = val(r, t), s = mma(r, t, x);
      i.push(r.i); v.push(x); mn.push(s[0]); mx.push(s[1]); av.push(s[2]);
      if (sess && PM.has(r.key) && x != null) { const a = sess.pm[r.key] || (sess.pm[r.key] = [x, 0, 0, x]); a[0] = Math.min(a[0], x); a[1] += x; a[2]++; a[3] = Math.max(a[3], x); }
    }
    const m = { t: 'tick', ver: 1, status: 'ok', age: 0, ts: t, i, v, mn, mx, av, game: c.g ? c.g.name : null, front: !!c.g, gameSince: c.g ? c.g.start : 0, pm: !!c.g, bnl: c.call || (c.gpu >= 95 ? 1 : c.thr >= 80 ? 2 : 3), rec: load('rec') || [] };
    if (sess) { m.gs = {}; for (const k in sess.pm) { const a = sess.pm[k]; m.gs[k] = [a[0], Math.round(a[1] / a[2] * 100) / 100, a[3]]; } }
    post(m);
  }
  function sparks(keys) {
    const t = nowS(), out = {};
    for (const k of keys) { const r = BYKEY.get(k); if (!r) continue; const a = new Array(900); for (let j = 0; j < 900; j++) a[j] = val(r, t - 899 + j); out[k] = a; }
    post({ t: 'spark', ts: t, keys: out });
  }
  function onPage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ready': {
        const st = load('state') || DEMO_STATE, slots = [0, 1, 2, 3, 4].map(i => { const s = load('slots/slot' + (i + 1)); return s !== undefined ? s : i === 0 ? { v: 1, name: 'Demo layout', layout: DEMO } : null; });
        post({ t: 'state', state: st, slots, fake: true, dataDir: 'Nothing is saved in the demo (only in this tab)', version: VERSION, pc: 'GAMING-PC', nonClient: false, ext: false, brand: 'HW Deck', updatable: false });
        post(settingsMsg());
        post({ t: 'catalog', ver: 1, sensors: SENSORS, readings: R.map(r => [r.s, r.type, r.key, r.label, r.unit, null]), bneck: [key(1, 'GPU Core Load'), key(0, 'Max CPU/Thread Usage'), 0], c12: null });
        clearInterval(timer); setTimeout(() => { tick(); timer = setInterval(tick, 1000); }, 1000 - Date.now() % 1000);
        tick();
        break;
      }
      case 'sub': {
        const now = new Set([...(m.cells || []), ...(m.rows || [])]), fresh = (m.cells || []).filter(k => !subs.has(k));
        subs = now; if (fresh.length) sparks(fresh);
        break;
      }
      case 'save': if (typeof m.file === 'string' && /^(state|slots\/slot[1-5])$/.test(m.file)) keep(m.file, m.data); break;
      case 'hist': if (typeof m.key === 'string') post(hist(m.key, m.range)); break;
      case 'alerts': post({ t: 'alerts', log: load('alertsCleared') ? '' : alertsLog }); break;
      case 'alerts:clear': keep('alertsCleared', true); post({ t: 'alerts', log: '' }); break;
      case 'games': post({ t: 'games', log: gamesLog() }); break;
      case 'games:clear': keep('gamesCleared', true); keep('own', []); post({ t: 'games', log: '' }); break;
      case 'rec': {   // your own sessions, recorded from the made-up readings
        const rec = load('rec') || [], at = rec.findIndex(x => x[0] === m.start), t = nowS();
        if (m.act === 'start' && rec.length < 8 && !rec.some(x => x[0] === t)) rec.push([t, String(m.name || 'Session').slice(0, 60)]);
        if (m.act === 'name' && at >= 0 && m.name) rec[at][1] = String(m.name).slice(0, 60);
        if (m.act === 'stop' && at >= 0) {
          const [st, name] = rec.splice(at, 1)[0];
          if (t - st < 10) toast('Under 10 seconds, so it wasn\'t kept'); else keep('own', (load('own') || []).concat([{ start: st, end: t, name, custom: 1 }]));
          post({ t: 'games', log: gamesLog() });
        }
        keep('rec', rec); tick();
        break;
      }
      case 'gedit': {
        const k = m.start + '|' + m.end + '|' + m.game, own = load('own') || [], i = own.findIndex(s => sid(s) === k);
        if (m.act === 'del') { if (i >= 0) own.splice(i, 1); else keep('gone', (load('gone') || []).concat([k])); }
        if (m.act === 'name' && i >= 0 && m.name) own[i].name = String(m.name).slice(0, 60);
        keep('own', own); post({ t: 'games', log: gamesLog() });
        break;
      }
      case 'keep': {
        const d = x => Math.max(1, Math.min(3650, Math.round(+x) || 30));
        if (m.games != null) keep('gameDays', d(m.games)); if (m.warns != null) keep('warnDays', d(m.warns));
        post(settingsMsg()); post({ t: 'games', log: gamesLog() });
        break;
      }
      case 'openRelease': window.open(RELEASES, '_blank', 'noopener'); break;
      case 'export': {
        // (the app's file: { hwdeck: 1, slot }, named like the app names it, so it imports there too)
        const a = document.createElement('a'), b = new Blob([JSON.stringify({ hwdeck: 1, slot: m.data }, null, 2)], { type: 'application/json' });
        a.href = URL.createObjectURL(b); a.download = String(m.name || 'layout').replace(/[^\w .-]+/g, '_') + '.hwdeck.json'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        break;
      }
      case 'import': {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
        inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return; f.text().then(txt => { let d = null; try { d = JSON.parse(txt); } catch (e) { } post({ t: 'imported', slot: m.slot, data: d && typeof d === 'object' && d.slot !== undefined ? d.slot : d }); }); };
        inp.click();
        break;
      }
      case 'autostart': toast(IN_APP); post(settingsMsg()); break;
      case 'updates': case 'openData': case 'restartHwinfo': toast(IN_APP); break;
      default: break;   // win, drag: there is no window to move here
    }
  }
  window.chrome = window.chrome || {};
  window.chrome.webview = { postMessage: m => onPage(m), addEventListener: (type, f) => { if (type === 'message') listeners.push(f); }, removeEventListener: () => { } };

  // ---- around the page: the window buttons go, a bar at the bottom says what this is ----
  const css = document.createElement('style');
  css.textContent = '#wmin, #wmax, #wclose, .winbtns, #rstBtn { display: none !important; }\n' +   // (no window, no HWiNFO to restart)
    '@media (max-width: 520px) { .tbar { gap: 2px !important; padding-left: 10px !important; } .tbar .name { display: none !important; } #screens button { padding-left: 8px !important; padding-right: 8px !important; } }\n' +
    'body[style*="resize"] { cursor: auto !important; }\n' +   // (the page's window edges mean nothing here)
    'html.demo .app { height: calc(100% - 38px); }\n' +
    '#demobar { position: fixed; left: 0; right: 0; bottom: 0; height: 38px; display: flex; align-items: center; gap: 16px; padding: 0 16px; background: #121212; border-top: 1px solid #242424;' +
    ' color: #8c8c8c; font: 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; z-index: 40; box-sizing: border-box; }\n' +
    '#demobar b { color: #e0e0e0; font-weight: 600; }\n#demobar .sp { flex: 1; }\n' +
    '#demobar a { color: #a0a0a0; text-decoration: none; white-space: nowrap; } #demobar a:hover { color: #fff; }\n' +
    '#demobar a.dl { color: #0d0d0d; background: #e6e6e6; border-radius: 7px; padding: 5px 12px; font-weight: 600; } #demobar a.dl:hover { background: #fff; color: #000; }\n' +
    '#demobar > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }';
  document.head.appendChild(css);
  document.documentElement.classList.add('demo');
  const bar = document.createElement('div'); bar.id = 'demobar';
  bar.innerHTML = '<span><b>HW Deck demo</b></span><span class="sp"></span>' +
    '<a href="#" id="demoReset">Reset demo</a><a class="dl" href="' + RELEASES + '" target="_blank" rel="noopener">Download HW Deck</a>';
  document.body.appendChild(bar);
  bar.querySelector('#demoReset').addEventListener('click', e => { e.preventDefault(); resetDemo(); });
})();
