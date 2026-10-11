// Drives a running HWDeck.exe over the WebView2 debug port (start it with the environment variable
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>). Node 22+ (global WebSocket).
import { writeFileSync } from 'node:fs';

export async function connect(port = 9230) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('hwdeck.example'));
  if (!page) throw new Error('no HW Deck page on port ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0; const wait = new Map(), listeners = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else if (m.method) for (const f of listeners) f(m); };
  const cmd = (method, params = {}) => new Promise(ok => { const i = ++id; wait.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const mouse = (type, x, y, buttons = 0, clickCount = 1) => cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return {
    cmd, evaluate, sleep,
    on(f) { listeners.push(f); },
    // page errors from here on (call once, before reloading the page if errors at start-up matter)
    async errors() { const list = []; listeners.push(m => { if (m.method === 'Runtime.exceptionThrown') list.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); }); await cmd('Runtime.enable'); return list; },
    // the center of the first element matching a selector, in CSS pixels
    async center(sel) { return evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`); },
    // the same for an element picked by a page expression, e.g. [...document.querySelectorAll('.x')][3]
    async centerOf(expr) { return evaluate(`(() => { const e = (${expr}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`); },
    async click(x, y) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); },
    async dblclick(x, y) { await mouse('mousePressed', x, y, 1, 1); await mouse('mouseReleased', x, y, 0, 1); await mouse('mousePressed', x, y, 1, 2); await mouse('mouseReleased', x, y, 0, 2); },
    // a real pointer drag in small steps, so the page sees pointerdown, moves past its 5 px threshold, pointerup
    async drag(a, b, steps = 12) {
      await mouse('mouseMoved', a.x, a.y); await mouse('mousePressed', a.x, a.y, 1);
      for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, 1); await sleep(16); }
      await sleep(60); await mouse('mouseReleased', b.x, b.y, 0);
    },
    async type(text) { await cmd('Input.insertText', { text }); },
    async key(key, code, keyCode, modifiers = 0) {
      await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    async shot(path) { const r = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.result.data, 'base64')); },
    close() { ws.close(); }
  };
}

// a tiny check list: every check prints PASS or FAIL with what it saw
export function checks() {
  const results = [];
  const ok = (name, cond, seen) => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (seen !== undefined ? '  (' + (typeof seen === 'string' ? seen : JSON.stringify(seen)) + ')' : '')); };
  const done = () => { const f = results.filter(r => !r.pass); console.log(`\n${results.length - f.length}/${results.length} passed`); return f.length === 0; };
  return { ok, done };
}
