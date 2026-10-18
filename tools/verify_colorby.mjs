/* Verify Color by / Gene expression: colour switching, gene search, cache,
 * colour bar, and that NOTHING except the point colours changes.
 * Start the page over HTTP first (python3 -m http.server 8000).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8000';
const OUT = '/private/tmp/3dumap_new';
const PORT = 9701, W = 1400, H = 900, STAMP = Date.now();
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('ws')); });
}
function client(ws, sink) {
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (sink) {
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
        sink.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? '').join(' ').slice(0, 120));
      if (m.method === 'Runtime.exceptionThrown') sink.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? '').split('\n')[0]);
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level))
        sink.push('log.' + m.params.entry.level + ': ' + String(m.params.entry.text).slice(0, 120));
    }
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  return { send: (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error(method + ' timeout')); } }, 180000);
  }) };
}

const DBG = `JSON.stringify({
  ready: !!window.__APP_READY, surfacesReady: !!window.__APP_SURFACES_READY,
  info: window.__APP_INFO || null, debug: window.__APP_DEBUG ? window.__APP_DEBUG() : null,
  ui: { preset: (document.getElementById('preset-select') || {}).value || null,
        background: (document.getElementById('background-select') || {}).value || null }
})`;

async function main() {
  const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-cb-${STAMP}`,
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return undefined;          // page not ready yet / threw
      return r.result.value;
    };
    const readState = async () => {
      const raw = await ev(DBG);
      if (typeof raw !== 'string') return { ready: false, surfacesReady: false, info: null, debug: null };
      return JSON.parse(raw);
    };
    const waitReady = async () => {
      for (let i = 0; i < 240; i++) {
        const st = await readState();
        if (st.ready && st.surfacesReady) return st;
        await sleep(500);
      }
      throw new Error('app not ready');
    };

    await cdp.send('Page.navigate', { url: `${BASE}/?v=${STAMP}` });
    const st0 = await waitReady();
    await sleep(2500);
    console.log('app:', JSON.stringify(st0.info));

    const record = async (label) => {
      const s = await readState();
      const d = s.debug;
      const row = {
        label, colorBy: d.colorBy, gene: d.selectedGene, kind: d.lastColorInfo?.kind ?? null,
        field: d.lastColorInfo?.field ?? null,
        colorChecksum: d.colorChecksum, positionChecksum: d.positionChecksum,
        surfaceColor: d.surfaceColorSample, surfaceCount: d.surfaceCount,
        labelAnchors: JSON.stringify(d.labelAnchors), camera: JSON.stringify(d.cameraPosition),
        legendTitle: d.legend.title, colorbar: d.legend.colorbarVisible, geneStatus: d.geneStatus,
        stats: d.featureStats ? { q02: +d.featureStats.q02.toFixed(4), q98: +d.featureStats.q98.toFixed(4),
                                  zeros: d.featureStats.zeroCount, invalid: d.featureStats.invalidCount,
                                  cache: d.featureStats.cacheSize } : null,
        bgMode: s.ui ? s.ui.background : d.bgMode,
        preset: s.ui ? s.ui.preset : null
      };
      results.push(row);
      console.log(`${label.padEnd(32)} colorBy=${String(row.colorBy).padEnd(12)} field=${String(row.field).padEnd(12)} ` +
                  `kind=${String(row.kind).padEnd(10)} c#=${String(row.colorChecksum).padEnd(11)} legend="${row.legendTitle}" bar=${row.colorbar}`);
      return row;
    };

    const setColorBy = async (mode) => {
      await ev(`(() => { const s = document.getElementById('colorby-select');
                          s.value = '${mode}'; s.dispatchEvent(new Event('change')); return s.value; })()`);
      await sleep(800);
    };
    const searchGene = async (name) => {
      await ev(`(() => { const i = document.getElementById('gene-input');
                          i.value = ${JSON.stringify(name)};
                          i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                          return i.value; })()`);
      await sleep(1000);
    };
    const setBg = async (mode) => {
      await ev(`(() => { const s = document.getElementById('background-select');
                          s.value = '${mode}'; s.dispatchEvent(new Event('change')); })()`);
      await sleep(1600);
    };
    const setPreset = async (p) => {
      await ev(`(() => { const s = document.getElementById('preset-select');
                          s.value = '${p}'; s.dispatchEvent(new Event('change')); })()`);
      await sleep(1300);
    };

    await record('baseline (Cell type)');
    await setColorBy('ecmAuc');       await record('colorBy = ECM_AUC');
    await setColorBy('senCidScore');  await record('colorBy = SenCID_score');
    await setColorBy('senCidBinary'); await record('colorBy = SenCID_binary');
    await setColorBy('gene');         await record('colorBy = gene (no gene)');

    await searchGene('BMP1');   const bmp1a = await record('gene = BMP1 (1st)');
    await searchGene('COL1A1'); const col = await record('gene = COL1A1');
    await searchGene('FN1');    const fn1 = await record('gene = FN1');
    await searchGene('BMP1');   const bmp1b = await record('gene = BMP1 (2nd, cached)');
    await searchGene('bmp1');   const bmp1c = await record('gene = bmp1 (lowercase)');
    await searchGene('SPARC');  await record('gene = SPARC');
    await searchGene('NOTAGENE123'); const missing = await record('gene = NOTAGENE123');

    await searchGene('BMP1');
    await setBg('white');  const white = await record('BMP1 + White background');
    await setBg('dark');   const backDark = await record('back to Dark');
    await setPreset('strong'); const preset = await record('BMP1 + preset Strong');

    await setColorBy('cellType');
    await setBg('white');
    const whiteCellType = await record('Cell type + White (reference)');

    // ---------- visual evidence: four colour modes, same camera ----------
    await setBg('dark');
    const shots = [
      { file: 'colorby_celltype.png', setup: async () => { await setColorBy('cellType'); } },
      { file: 'colorby_ecmauc.png',   setup: async () => { await setColorBy('ecmAuc'); } },
      { file: 'colorby_bmp1.png',     setup: async () => { await setColorBy('gene'); await searchGene('BMP1'); } },
      { file: 'colorby_col1a1.png',   setup: async () => { await setColorBy('gene'); await searchGene('COL1A1'); } }
    ];
    const { writeFileSync } = await import('node:fs');
    for (const sh of shots) {
      await sh.setup();
      await sleep(1200);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(`${OUT}/${sh.file}`, Buffer.from(shot.data, 'base64'));
      console.log('  screenshot written:', sh.file);
    }

    const uniq = (k) => [...new Set(results.map((r) => r[k]))];
    const inv = {
      positionChecksum: uniq('positionChecksum'),
      labelAnchors: uniq('labelAnchors'),
      camera: uniq('camera'),
      surfaceColor: uniq('surfaceColor'),
      surfaceCount: uniq('surfaceCount'),
      colorChecksums: uniq('colorChecksum')
    };
    console.log('\n=== invariants (each must be length 1 except the colour sums) ===');
    console.log('  positionChecksum length :', inv.positionChecksum.length, inv.positionChecksum);
    console.log('  labelAnchors length     :', inv.labelAnchors.length);
    console.log('  camera length           :', inv.camera.length, inv.camera);
    const surfaceGroups = {};
    results.forEach((r) => { const k = r.bgMode + '/' + r.preset; (surfaceGroups[k] = surfaceGroups[k] || new Set()).add(r.surfaceColor); });
    console.log('  surfaceColor by (bg/preset):',
      Object.entries(surfaceGroups).map(([k, v]) => `${k}=${[...v].join(',')}`).join('  |  '));
    console.log('  surfaceCount length     :', inv.surfaceCount.length, inv.surfaceCount);
    console.log('  distinct colour sums    :', inv.colorChecksums.length);

    console.log('\n=== checks ===');
    const check = (name, ok, extra = '') => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
    check('BMP1 twice identical (cache)', bmp1a.colorChecksum === bmp1b.colorChecksum && bmp1a.colorChecksum === bmp1c.colorChecksum);
    check('BMP1 vs COL1A1 differ', bmp1a.colorChecksum !== col.colorChecksum);
    check('COL1A1 vs FN1 differ', col.colorChecksum !== fn1.colorChecksum);
    check('missing-gene message', missing.geneStatus === 'Gene "NOTAGENE123" was not found in the dataset.', `-> ${JSON.stringify(missing.geneStatus)}`);
    check('gene colouring kept after missing gene', missing.colorBy === 'gene');
    check('gene colouring survived White', white.colorBy === 'gene' && white.colorChecksum !== whiteCellType.colorChecksum);
    check('gene colouring survived preset', preset.colorBy === 'gene');
    check('Dark restored the BMP1 colours', backDark.colorChecksum === bmp1a.colorChecksum);
    check('legend title = "<gene> expression"', white.legendTitle === 'BMP1 expression', `-> ${white.legendTitle}`);
    check('colour bar on for continuous/binary', results.filter((r) => r.kind !== 'cellType').every((r) => r.colorbar === true));
    check('colour bar off for Cell type', results.filter((r) => r.kind === 'cellType').every((r) => r.colorbar === false));
    check('positions never changed', inv.positionChecksum.length === 1);
    check('label anchors never changed', inv.labelAnchors.length === 1);
    check('camera never changed', inv.camera.length === 1);
    check('surface colour independent of Color by',
      Object.values(surfaceGroups).every((set) => set.size === 1));
    check('surface count never changed', inv.surfaceCount.length === 1 && inv.surfaceCount[0] === 8);
    const pageIssues = logs.filter((l) => !/GPU stall/.test(l));
    check('no page console errors/warnings', pageIssues.length === 0, pageIssues.length ? JSON.stringify(pageIssues.slice(0, 4)) : '');

    writeFileSync(`${OUT}/colorby-verification.json`, JSON.stringify({ results, inv, logs }, null, 1));
  } finally { child.kill('SIGKILL'); }
}
await main();
