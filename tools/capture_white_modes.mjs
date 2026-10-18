/* Capture the three White-background candidates plus the Dark reference with an
 * identical camera, and measure per-cluster visibility on the rendered canvas.
 *
 *   node tools/capture_white_modes.mjs [--url=http://127.0.0.1:8000]
 *
 * Fixed for every image: POINT_SIZE = 2.5, Label size = 23 px, Balanced preset,
 * surfaces ON, labels ON, Figure Mode ON (so the panel cannot cover a cluster).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const BASE = argv.url ?? 'http://127.0.0.1:8000';
const OUT = argv.out ?? resolve(ROOT, 'previews');
const W = Number(argv.width ?? 1600), H = Number(argv.height ?? 1000), SCALE = Number(argv.scale ?? 2);
const PORT = 9610, STAMP = Date.now();
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* In-page measurement: sample the WebGL canvas around every cluster label.
 * The label pill itself is skipped by offsetting below the anchor. */
const MEASURE = (bgFill) => `(() => {
  const gl = document.querySelector('#viewport canvas');
  const t = document.createElement('canvas');
  const sx = gl.width / gl.clientWidth, sy = gl.height / gl.clientHeight;
  t.width = Math.round(gl.clientWidth); t.height = Math.round(gl.clientHeight);
  const x = t.getContext('2d', { willReadFrequently: true });
  if ('${bgFill}') { x.fillStyle = '${bgFill}'; x.fillRect(0, 0, t.width, t.height); }
  x.drawImage(gl, 0, 0, t.width, t.height);
  const labels = [...document.querySelectorAll('#labels .cell-label')].map(el => {
    const r = el.getBoundingClientRect();
    const host = document.getElementById('viewport').getBoundingClientRect();
    return { text: el.textContent.trim(),
             cx: r.left + r.width / 2 - host.left, cy: r.top + r.height / 2 - host.top,
             w: r.width, h: r.height };
  });
  const patch = 80;                      // half size of the sampled square
  const perCluster = labels.map(l => {
    const px0 = Math.max(0, Math.round(l.cx - patch));
    const py0 = Math.max(0, Math.round(l.cy - patch));
    const w = Math.min(2 * patch, t.width - px0), h = Math.min(2 * patch, t.height - py0);
    if (w <= 2 || h <= 2) return { text: l.text, empty: true };
    const d = x.getImageData(px0, py0, w, h).data;
    // mask out the label pill itself so only the point cloud is measured
    const lx0 = l.cx - l.w / 2 - 3 - px0, lx1 = l.cx + l.w / 2 + 3 - px0;
    const ly0 = l.cy - l.h / 2 - 3 - py0, ly1 = l.cy + l.h / 2 + 3 - py0;
    let n = 0, tinted = 0, sum = 0, minv = 255, sum2 = 0, strong = 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        if (xx >= lx0 && xx <= lx1 && yy >= ly0 && yy <= ly1) continue;   // label pill
        const i = (yy * w + xx) * 4;
        const r = d[i], g = d[i+1], b = d[i+2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        n++;
        sum += mx; sum2 += mx * mx;
        if (mn < minv) minv = mn;
        if (sat > 0.04 || mn < 240) tinted++;
        if (sat > 0.18 && mn < 200) strong++;
      }
    }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    return { text: l.text, n, tintedFraction: +(tinted / n).toFixed(4),
             strongInkFraction: +(strong / n).toFixed(4),
             minChannel: minv, meanBrightness: +mean.toFixed(1), granularitySD: +sd.toFixed(1) };
  });
  // whole-viewport statistics
  const full = x.getImageData(0, 0, t.width, t.height).data;
  let n = 0, tintedAll = 0, white = 0, satSum = 0;
  for (let i = 0; i < full.length; i += 4 * 5) {
    const r = full[i], g = full[i+1], b = full[i+2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    n++;
    if (sat > 0.04) { tintedAll++; satSum += sat; }
    if (mn > 246) white++;
  }
  return JSON.stringify({ perCluster, global: { sampled: n,
    tintedFraction: +(tintedAll / n).toFixed(4),
    nearWhiteFraction: +(white / n).toFixed(4),
    meanSaturationOfTinted: tintedAll ? +(satSum / tintedAll).toFixed(3) : 0 } });
})()`;

function connect(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('ws')); });
}
function client(ws, sink) {
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (sink) {
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
        sink.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? '').join(' ').slice(0, 110));
      if (m.method === 'Runtime.exceptionThrown') sink.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? '').split('\n')[0]);
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level))
        sink.push('log.' + m.params.entry.level + ': ' + String(m.params.entry.text).slice(0, 110));
    }
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  return { send: (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error(method + ' timeout')); } }, 120000);
  }) };
}

async function main() {
  const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-white-${STAMP}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  const results = [];
  try {
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) ver = await r.json(); } catch {}
      if (!ver) await sleep(300);
    }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const ws = await connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    const logs = [];
    const cdp = client(ws, logs);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });

    const shots = [
      { file: 'white_soft.png', bg: 'white', variant: 'soft' },
      { file: 'white_balanced.png', bg: 'white', variant: 'balanced' },
      { file: 'white_strong.png', bg: 'white', variant: 'strong' },
      { file: 'dark_reference.png', bg: 'dark', variant: 'balanced' }
    ];
    for (const s of shots) {
      logs.length = 0;
      const url = `${BASE}/?bg=${s.bg}&whitevariant=${s.variant}&pointsize=2.5&labelfont=23&labels=1&figure=1&preset=balanced&v=${STAMP}`;
      await cdp.send('Page.navigate', { url });
      let ready = false;
      for (let i = 0; i < 200; i++) {
        const r = await cdp.send('Runtime.evaluate', { expression: '!!(window.__APP_READY&&window.__APP_SURFACES_READY)', returnByValue: true });
        if (r.result.value === true) { ready = true; break; }
        await sleep(500);
      }
      if (!ready) throw new Error(`${s.file}: app not ready`);
      await sleep(2500);
      const fill = s.bg === 'white' ? '#FFFFFF' : (s.bg === 'black' ? '#000000' : '');
      const m = JSON.parse((await cdp.send('Runtime.evaluate', { expression: MEASURE(fill), returnByValue: true })).result.value);
      const info = JSON.parse((await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__APP_INFO)', returnByValue: true })).result.value);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(resolve(OUT, s.file), Buffer.from(shot.data, 'base64'));
      results.push({ ...s, info, measures: m, consoleIssues: [...logs] });
      console.log(`\n=== ${s.file} (bg=${s.bg}, white variant=${s.variant}) ===`);
      console.log(`  app: ${JSON.stringify(info)}`);
      console.log(`  global: ${JSON.stringify(m.global)}`);
      console.log('  per cluster (tinted% / strong-ink% / granularity SD / min channel):');
      m.perCluster.forEach((c) => console.log(`    ${String(c.text).padEnd(28)} tinted=${(c.tintedFraction*100).toFixed(1)}%  strongInk=${(c.strongInkFraction*100).toFixed(1)}%  SD=${c.granularitySD}  minCh=${c.minChannel}`));
      console.log('  console issues:', logs.length ? JSON.stringify(logs.slice(0, 3)) : 'none');
    }
    writeFileSync(resolve(OUT, 'white-mode-measurements.json'), JSON.stringify(results, null, 1));
  } finally { child.kill('SIGKILL'); }
}
await main();
