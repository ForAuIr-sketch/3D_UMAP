/* End-to-end verification of the Label-size and Background features.
 *
 *   node tools/verify_ui.mjs [--url=http://127.0.0.1:8000] [--out=DIR]
 *
 * Runs scenarios A-F, records console errors/warnings, checks the app state,
 * triggers the real 2x/4x PNG export and inspects the produced bitmap, and
 * writes the three background comparison images (dark / black / white) with an
 * identical camera.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const BASE = argv.url ?? 'http://127.0.0.1:8000';
const OUT = argv.out ?? resolve(ROOT, 'previews');
const W = Number(argv.width ?? 1600), H = Number(argv.height ?? 1000);
const SCALE = Number(argv.scale ?? 2);
const DL = '/tmp/umap_downloads';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9520;
const STAMP = Date.now();          // cache-buster so a reload always re-fetches the modules

mkdirSync(OUT, { recursive: true });
mkdirSync(DL, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ CDP plumbing -- */
async function waitPort(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('devtools port did not open');
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws error'));
  });
}
function client(ws, sink) {
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (sink && ['error', 'warning', 'assert'].includes(m.params.type)) sink.push(`${m.params.type}: ${text}`);
    }
    if (m.method === 'Runtime.exceptionThrown' && sink) {
      sink.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? '').split('\n')[0]);
    }
    if (m.method === 'Log.entryAdded' && sink && ['error', 'warning'].includes(m.params.entry.level)) {
      sink.push(`log.${m.params.entry.level}: ${m.params.entry.text}`);
    }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error(method + ' timeout')); } }, 180000);
  });
  return { send };
}

/* --------------------------------------------------------------- helpers --- */
const STATE_EXPR = `(() => {
  const labels = [...document.querySelectorAll('#labels .cell-label')].map(el => {
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent.trim(),
      cx: +(r.left + r.width / 2).toFixed(2), cy: +(r.top + r.height / 2).toFixed(2),
      fontSize: getComputedStyle(el).fontSize, color: getComputedStyle(el).color,
      borderColor: getComputedStyle(el).borderTopColor, borderWidth: getComputedStyle(el).borderTopWidth,
      bg: getComputedStyle(el).backgroundColor
    };
  });
  const legend = document.querySelector('#legend .legend-title');
  return JSON.stringify({
    ready: !!window.__APP_READY, surfacesReady: !!window.__APP_SURFACES_READY,
    info: window.__APP_INFO || null,
    bodyClass: document.body.className,
    containerBg: getComputedStyle(document.getElementById('viewport')).backgroundColor,
    labelCount: labels.length, labelsVisible: labels.filter(l => getComputedStyle(document.getElementById('labels')).display !== 'none').length,
    labels: labels.slice(0, 9),
    legendColor: legend ? getComputedStyle(legend).color : null,
    legendRows: document.querySelectorAll('#legend .legend-item').length,
    brightnessDisabled: !!document.getElementById('background-brightness')?.disabled,
    bgSelect: document.getElementById('background-select')?.value ?? null,
    labelSlider: document.getElementById('label-size')?.value ?? null,
    panelVisible: getComputedStyle(document.getElementById('panel')).display !== 'none',
    statusVisible: getComputedStyle(document.getElementById('status')).display !== 'none',
    lastExport: window.__APP_LAST_EXPORT || null
  });
})()`;

/* ---------------------------------------------------------------- scenario -- */
async function main() {
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-verify-${STAMP}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, 'about:blank'
  ], { stdio: 'ignore' });

  const results = [];
  try {
    const ver = await waitPort(PORT);
    const browserWs = await connect(ver.webSocketDebuggerUrl);
    const browser = client(browserWs, null);
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = await connect(page.webSocketDebuggerUrl);
    const logs = [];
    const cdp = client(ws, logs);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });

    const run = async (label, url, afterReady) => {
      logs.length = 0;
      await cdp.send('Page.navigate', { url });
      const t0 = Date.now();
      let st = null;
      while (Date.now() - t0 < 150000) {
        const r = await cdp.send('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
        st = JSON.parse(r.result.value);
        if (st.ready && st.surfacesReady) break;
        await sleep(500);
      }
      if (afterReady) st = await afterReady(cdp, st);
      if (!st.ready) {
        const fatal = await cdp.send('Runtime.evaluate', {
          expression: `(document.querySelector('#loading .fatal')||{}).textContent || 'app not ready'`,
          returnByValue: true
        });
        throw new Error(`${label}: app never became ready -> ${fatal.result.value}`);
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = resolve(OUT, `${label}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const out = { scenario: label, url, consoleIssues: [...logs], state: st, file };
      results.push(out);
      console.log(`\n=== ${label} ===\n  url: ${url}`);
      console.log('  app:', JSON.stringify(st.info));
      console.log('  bg mode:', st.bgSelect, '| body:', st.bodyClass || '(none)', '| viewport bg:', st.containerBg,
                  '| brightness slider disabled:', st.brightnessDisabled);
      console.log('  labels:', st.labelCount, '| font:', st.labels[0]?.fontSize, '| color:', st.labels[0]?.color,
                  '| border:', st.labels[0]?.borderWidth, st.labels[0]?.borderColor, '| label bg:', st.labels[0]?.bg);
      console.log('  label centres:', st.labels.slice(0, 3).map((l) => `${l.text}(${l.cx},${l.cy})`).join(' '));
      console.log('  legend color:', st.legendColor, '| rows:', st.legendRows, '| panel:', st.panelVisible, '| status:', st.statusVisible);
      if (st.lastExport) console.log('  export:', JSON.stringify(st.lastExport));
      console.log('  console issues:', logs.length ? JSON.stringify(logs) : 'none');
      return out;
    };

    // A: dark, default label size, labels on
    await run('A_dark_default_labels', `${BASE}/?bg=dark&labels=1&v=${STAMP}`);
    // B: black, label size 20, labels on
    await run('B_black_label20', `${BASE}/?bg=black&labels=1&labelfont=20&v=${STAMP}`);
    // C: white, label size 20, labels on
    await run('C_white_label20', `${BASE}/?bg=white&labels=1&labelfont=20&v=${STAMP}`);
    // D: white, labels off
    await run('D_white_labels_off', `${BASE}/?bg=white&labels=0&labelfont=20&v=${STAMP}`);
    // E: white + figure mode + labels on, then the real 2x and 4x exports
    await run('E_white_figure_export4x', `${BASE}/?bg=white&labels=1&labelfont=20&figure=1&v=${STAMP}`, async (c) => {
      await c.send('Runtime.evaluate', { expression: 'window.__APP_EXPORT_PNG(2)', awaitPromise: true });
      await sleep(3000);
      const r2 = await c.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__APP_LAST_EXPORT)', returnByValue: true });
      console.log('  2x export:', r2.result.value);
      await c.send('Runtime.evaluate', { expression: 'window.__APP_EXPORT_PNG(4)', awaitPromise: true });
      await sleep(3000);
      const r = await c.send('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
      return JSON.parse(r.result.value);
    });
    // F: black + figure mode, 4x export
    await run('F_black_figure_export4x', `${BASE}/?bg=black&labels=1&labelfont=20&figure=1&v=${STAMP}`, async (c) => {
      await c.send('Runtime.evaluate', { expression: 'window.__APP_EXPORT_PNG(4)', awaitPromise: true });
      await sleep(4000);
      const r = await c.send('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
      return JSON.parse(r.result.value);
    });

    // background comparison images (identical camera, labels on, panel visible)
    for (const mode of ['dark', 'black', 'white']) {
      logs.length = 0;
      await cdp.send('Page.navigate', { url: `${BASE}/?bg=${mode}&labels=1&preset=balanced&v=${STAMP}` });
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 150000) {
        const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({r:!!window.__APP_READY,s:!!window.__APP_SURFACES_READY})', returnByValue: true });
        const st = JSON.parse(r.result.value);
        if (st.r && st.s) { ok = true; break; }
        await sleep(500);
      }
      await sleep(2500);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = resolve(OUT, `background_${mode}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`\nbackground_${mode}.png written (ready=${ok}, console issues=${logs.length})`);
    }

    console.log('\ndownloads seen:', readdirSync(DL).length, readdirSync(DL).slice(0, 6).join(', '));
    const totalIssues = results.reduce((n, r) => n + r.consoleIssues.length, 0);
    console.log('\nTOTAL console errors/warnings across A-F:', totalIssues);
    writeFileSync(resolve(OUT, 'ui_verification.json'), JSON.stringify(results, null, 1));
    process.exitCode = totalIssues === 0 ? 0 : 1;
  } finally {
    child.kill('SIGKILL');
  }
}
await main();
