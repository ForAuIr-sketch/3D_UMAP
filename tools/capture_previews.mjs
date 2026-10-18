/* Deterministic preview capture through the Chrome DevTools Protocol.
 *
 *   node tools/capture_previews.mjs [--url=http://127.0.0.1:8000] [--out=DIR] [--scale=2]
 *
 * Why not `chrome --screenshot`: that flag captures the page as soon as the load
 * event fires, which is before the 8.6 MB CSV has been parsed and the WebGL scene
 * has drawn. Here we connect to the DevTools WebSocket, wait until the app itself
 * reports `window.__APP_READY && window.__APP_SURFACES_READY`, let the renderer
 * settle for a moment, and only then call Page.captureScreenshot.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const BASE = argv.url ?? 'http://127.0.0.1:8000';
const OUT = argv.out ?? resolve(ROOT, 'previews');
const SCALE = Number(argv.scale ?? 2);
const W = Number(argv.width ?? 1600);
const H = Number(argv.height ?? 1000);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PRESETS = ['subtle', 'balanced', 'strong', 'reference-like'];

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`DevTools port ${port} did not open`);
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(new Error('websocket error ' + (e.message ?? '')));
  });
}

function makeClient(ws) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => {
      if (pending.has(myId)) { pending.delete(myId); rej(new Error(method + ' timed out')); }
    }, 120000);
  });
  return { send };
}

async function captureOne(preset, index) {
  const port = 9400 + index;
  const url = `${BASE}/?preset=${preset}&figure=1&legend=1&labels=0`;
  const child = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/chrome-cdp-${preset}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--mute-audio',
    `--window-size=${W},${H}`,
    'about:blank'
  ], { stdio: 'ignore' });
  try {
    await waitForPort(port);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = await connect(page.webSocketDebuggerUrl);
    const cdp = makeClient(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send('Page.navigate', { url });

    const t0 = Date.now();
    let info = null;
    let lastDiag = null;
    while (Date.now() - t0 < 150000) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          ready: !!window.__APP_READY,
          surfaces: !!window.__APP_SURFACES_READY,
          info: window.__APP_INFO || null,
          href: location.href,
          state: document.readyState,
          legendRows: document.querySelectorAll('#legend .legend-item').length,
          loadingHidden: !!document.getElementById('loading')?.classList.contains('hidden'),
          fatal: (document.querySelector('#loading .fatal')||{}).textContent || null,
          canvases: document.querySelectorAll('canvas').length
        })`,
        returnByValue: true
      });
      try { info = JSON.parse(r.result.value); } catch { info = null; }
      if (info && info.ready && info.surfaces) break;
      lastDiag = info;
      await sleep(500);
    }
    if (!info || !info.ready) {
      console.error('diagnostics:', JSON.stringify(lastDiag, null, 1));
      throw new Error('app never became ready');
    }
    await sleep(2000);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = resolve(OUT, `preview_${preset.replace(/-/g, '_')}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`${preset.padEnd(15)} -> ${file}  (${W * SCALE}x${H * SCALE})  info=${JSON.stringify(info.info)}`);
    ws.close();
  } finally {
    child.kill('SIGKILL');
  }
}

for (let i = 0; i < PRESETS.length; i++) {
  await captureOne(PRESETS[i], i);
}
console.log('all previews written to', OUT);
