/* ==========================================================================
 * main.js — 3D UMAP viewer (CellMajortype only)
 *
 * Pipeline:  CSV -> data.js (parse + stats) -> BufferGeometry/Points
 *            -> ShaderMaterial (soft sprites) -> EffectComposer + UnrealBloom
 *            -> optional per-type density shells (surface.js)
 *
 * Only the three UMAP coordinates and CellMajortype are used.
 * BMP1 / BMP1_display / any other column is never read.
 * ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CONFIG, PRESETS, DEFAULT_PRESET, WHITE_VARIANTS, colorForIndex } from './config.js';
import { parseUMAPCsv, computeLabelAnchors, computePointDensity } from './data.js';
import { buildDensitySurface } from './surface.js';
import {
  pointsVertexShader, pointsFragmentShader,
  surfaceVertexShader, surfaceFragmentShader,
  whitePointsVertexShader, whitePointsFragmentShader,
  whiteSurfaceVertexShader, whiteSurfaceFragmentShader
} from './shaders.js';

/* ------------------------------------------------------------------ state -- */
const state = {
  renderer: null, scene: null, camera: null, controls: null,
  composer: null, bloomPass: null, renderPass: null,
  points: null, pointsMaterial: null,
  surfaceGroup: null, surfaces: new Map(),   // typeIndex -> Mesh
  parsed: null, centered: null, labels: [], labelEls: [],
  focusType: -1, refDistance: 1,
  bgColor: new THREE.Color(CONFIG.BACKGROUND_COLOR),
  exportTransparent: CONFIG.EXPORT_TRANSPARENT,
  includeLabelsInExport: true,
  clock: null, fps: 0, frames: 0, lastFpsTime: 0
  ,
  preset: DEFAULT_PRESET,
  showLegend: true,
  figureMode: false,
  bgMode: 'dark',           // 'dark' | 'black' | 'white'
  whiteVariant: 'balanced', // which white-background candidate is active
  userBloomStrength: CONFIG.BLOOM_STRENGTH,   // the slider value, kept in every mode
  typeColors: [],           // final (muted + boosted) colour per cell type

  /* ---- colour-by state (points only; surfaces/labels keep type colors) --- */
  colorBy: CONFIG.COLOR_BY,          // 'cellType' | 'ecmAuc' | 'senCidScore' | 'senCidBinary' | 'gene'
  selectedGeneField: null,           // exact CSV header of the selected gene
  selectedGeneName: CONFIG.GENE_FIELD,
  featureCache: new Map(),           // field -> { values, min, max, q02, q98, invalidCount }
  colormapCache: null,               // { white: bool, stops: THREE.Color[] }
  lastColorInfo: null                // what the points are currently coloured by
};

const dom = {};   // filled in init()

/* ============================================================== bootstrap == */
init().catch((err) => {
  console.error(err);
  showFatal(err);
});

async function init() {
  cacheDom();
  applyUrlParams();
  createRenderer();
  createScene();
  createCameraAndControls();
  createComposer();

  setStatus('loading CSV …');
  const text = await loadText(CONFIG.DATA_PATH);
  state.parsed = parseUMAPCsv(text, CONFIG);
  logInfo(`parsed ${state.parsed.n} cells, ${state.parsed.types.length} CellMajortype groups`);
  logInfo(`columns -> x:${state.parsed.columnNames.x} y:${state.parsed.columnNames.y} ` +
          `z:${state.parsed.columnNames.z} group:${state.parsed.columnNames.group}`);

  centerPositions();
  createPointCloud();
  createLabels();
  buildLegend();
  buildControlPanel();
  // apply the requested colour-by mode (URL / config) before the first frame
  if (state.colorBy === 'gene') {
    if (state.pendingGene) applyGeneSearch(state.pendingGene);
    else if (state.selectedGeneName) applyGeneSearch(state.selectedGeneName);
  }
  applyColorBy(state.colorBy, { silent: true });
  frameCamera();

  dom.loading.classList.add('hidden');
  setStatus(`${state.parsed.n.toLocaleString()} cells · ${state.parsed.types.length} cell types`);
  applyPreset(state.preset, { silent: true });   // make sure uniforms/UI agree
  applyBackgroundMode(state.bgMode);             // dark = unchanged default look
  applyLabelSize(CONFIG.LABEL_SIZE);
  applyFigureMode(state.figureMode, { silent: true });
  toggleLegend(state.showLegend);
  showHint();
  animate();

  if (CONFIG.SURFACE_SHOW) buildAllSurfaces();   // progressive, does not block the view
}

function cacheDom() {
  const $ = (id) => document.getElementById(id);
  dom.container = $('viewport');
  dom.loading = $('loading');
  dom.loadingText = $('loading-text');
  dom.status = $('status');
  dom.legend = $('legend');
  dom.panel = $('panel');
  dom.panelBody = $('panel-body');
  dom.labels = $('labels');
  dom.hud = $('hud');
  dom.log = $('log');
  dom.hint = $('hint');
  dom.presetSelect = $('preset-select');
  dom.figureBtn = $('figure-mode');
  dom.legendBtn = $('toggle-legend');
}

/* ---------------------------------------------------------- URL parameters --
 * Handy for reproducible captures, e.g.
 *   index.html?preset=strong&figure=1&legend=1&labels=0
 * -------------------------------------------------------------------------*/
function applyUrlParams() {
  const q = new URLSearchParams(location.search);
  const p = q.get('preset');
  if (p && PRESETS[p]) state.preset = p;
  const bgm = q.get('bg');                 // dark | black | white  (background MODE)
  if (bgm && ['dark', 'black', 'white'].includes(bgm)) state.bgMode = bgm;
  const wv = q.get('whitevariant');        // soft | balanced | strong
  if (wv && WHITE_VARIANTS[wv]) state.whiteVariant = wv;
  const ps = Number(q.get('pointsize'));
  if (Number.isFinite(ps) && ps > 0) CONFIG.POINT_SIZE = ps;
  if (q.get('figure') === '1') state.figureMode = true;
  if (q.get('legend') === '0') state.showLegend = false;
  if (q.get('labels') === '1') CONFIG.SHOW_LABELS = true;
  if (q.get('labels') === '0') CONFIG.SHOW_LABELS = false;
  const labelfont = Number(q.get('labelfont'));
  if (Number.isFinite(labelfont) && labelfont > 0) CONFIG.LABEL_SIZE = labelfont;
  // an explicit labels=… in the URL wins over the Figure-Mode default (labels off)
  if (q.get('labels') !== null) state.labelsExplicit = true;
  const bghex = q.get('bgcolor');           // optional dark-colour override, e.g. ?bgcolor=0A0E1C
  if (bghex && /^[0-9a-fA-F]{6}$/.test(bghex)) CONFIG.BACKGROUND_COLOR = '#' + bghex;
  const cb = q.get('colorby');              // cellType | ecmAuc | senCidScore | senCidBinary | gene
  if (cb && ['cellType', 'ecmAuc', 'senCidScore', 'senCidBinary', 'gene'].includes(cb)) state.colorBy = cb;
  const gene = q.get('gene');               // gene name for ?colorby=gene
  if (gene) { state.pendingGene = gene; state.selectedGeneName = gene; }
}

/* --------------------------------------------------------------- colours ----
 * The palette hue order never changes; COLOR_SATURATION only mutes it, and the
 * small-cluster boost keeps the sparse types from disappearing under bloom.
 * -------------------------------------------------------------------------*/
function mutedColor(hex, satFactor) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s * satFactor, hsl.l);
  return c;
}

function buildTypeColors() {
  const { counts } = state.parsed;
  state.typeColors = counts.map((n, k) => {
    const c = mutedColor(colorForIndex(k), CONFIG.COLOR_SATURATION);
    const boost = n < CONFIG.SMALL_CLUSTER_MAX ? CONFIG.SMALL_CLUSTER_BOOST : 1.0;
    return c.multiplyScalar(boost);
  });
}

/* ------------------- WHITE BACKGROUND: ink colours -------------------------
 * The white page needs "translucent coloured ink", so the CellMajortype hue is
 * pushed to a darker, slightly more saturated colour in HSL space (never an RGB
 * multiply, which would produce muddy colours, and never a mix towards white).
 * The hue itself is untouched, so every cluster keeps its identity.
 * -------------------------------------------------------------------------*/
function whiteInkColor(k, darken = 0) {
  // Work explicitly in sRGB: the lightness below is meant the way it looks on
  // screen (0.62 = a mid-tone ink), not as a linear-light value, which would
  // come out as a washed-out pastel.
  const src = new THREE.Color(colorForIndex(k));        // palette hue, untouched
  const hsl = {};
  src.getHSL(hsl, THREE.SRGBColorSpace);
  const sat = Math.min(1, hsl.s * CONFIG.WHITE_POINT_SATURATION);
  const lig = Math.max(0.05, CONFIG.WHITE_POINT_LIGHTNESS * (1 - darken));
  src.setHSL(hsl.h, sat, lig, THREE.SRGBColorSpace);
  return src;
}

function whiteInkColors(darken = 0) {
  return state.parsed.types.map((t, k) => whiteInkColor(k, darken));
}

/** Rewrite the per-cell colour attribute.
 *  The colours come from exactly one place - computeColorArray(), which
 *  dispatches on state.colorBy - so switching background, white style or preset
 *  can never silently fall back to CellMajortype colours.
 *  Only aColor is written: positions, geometry and surfaces are untouched. */
function refreshPointColors() {
  if (!state.points) return;
  const white = state.bgMode === 'white';
  // keep the CellMajortype colours (used by surfaces, labels, legend) in sync
  if (white) {
    state.typeColors = whiteInkColors();
  } else {
    buildTypeColors();
  }
  // ---- point colours for the current colorBy ------------------------------
  const { colors, field, kind } = computeColorArray();
  const attr = state.points.geometry.getAttribute('aColor');
  attr.array.set(colors);
  attr.needsUpdate = true;
  state.lastColorInfo = { colorBy: state.colorBy, field, kind, white };
  // ---- surfaces keep the CellMajortype colours (decoupled) ----------------
  const surfaceColors = white ? whiteInkColors(CONFIG.WHITE_SURFACE_RIM_DARKEN) : state.typeColors;
  state.surfaces.forEach((mesh, k) => {
    mesh.material.uniforms.uColor.value.copy(surfaceColors[k]);
  });
  updateLegendForColorBy();
}

/* ======================= COLOR BY: features and genes =====================
 * Point colour is fully decoupled from the surfaces / labels / legend, which
 * always stay CellMajortype-coloured.
 *
 * Continuous features (ECM_AUC, SenCID_score, any gene):
 *   value -> clip to [q02, q98] -> normalise to 0..1 -> sample the colormap.
 * Cells with value 0 (or an invalid value) are kept, drawn with the low end of
 * the colormap; nothing is filtered, moved or resized.
 * ======================================================================== */

/** Headers that can be used as a gene: every CSV column except the annotations. */
function geneColumns() {
  const skip = new Set(CONFIG.GENE_EXCLUDE_FIELDS.map((h) => String(h).trim().toLowerCase()));
  return state.parsed.headers.filter((h) => !skip.has(String(h).trim().toLowerCase()));
}

/** Case-insensitive lookup of an exact CSV header. */
function findCsvColumn(name) {
  if (name === null || name === undefined) return null;
  const target = String(name).trim().toLowerCase();
  if (!target) return null;
  const hit = state.parsed.headers.find((h) => String(h).trim().toLowerCase() === target);
  return hit ?? null;
}

/** Read one numeric column for every cell (computed once, then cached). */
function featureValues(field) {
  if (state.featureCache.has(field)) return state.featureCache.get(field);
  const n = state.parsed.n;
  const rows = state.parsed.rows;
  const values = new Float32Array(n);
  const valid = [];
  let invalidCount = 0;
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const raw = row ? row[field] : undefined;
    const v = (raw === '' || raw === null || raw === undefined) ? NaN : Number(raw);
    if (Number.isFinite(v)) {
      values[i] = v;
      valid.push(v);
    } else {
      values[i] = 0;          // '' / null / undefined / NaN / Infinity -> 0
      invalidCount++;
    }
  }
  valid.sort((a, b) => a - b);
  const pick = (p) => (valid.length
    ? valid[Math.min(valid.length - 1, Math.max(0, Math.round(p * (valid.length - 1))))]
    : 0);
  const stats = {
    field,
    values,
    n: valid.length,
    min: valid.length ? valid[0] : 0,
    max: valid.length ? valid[valid.length - 1] : 0,
    q02: pick(CONFIG.OUTLIER_PERCENTILES[0]),
    q98: pick(CONFIG.OUTLIER_PERCENTILES[1]),
    invalidCount,
    zeroCount: (() => { let z = 0; for (let i = 0; i < n; i++) if (values[i] === 0) z++; return z; })()
  };
  state.featureCache.set(field, stats);
  return stats;
}

/** Colormap stops as THREE.Color (working/linear space), adapted per background. */
function colormapStops() {
  const white = state.bgMode === 'white';
  if (state.colormapCache && state.colormapCache.white === white) return state.colormapCache.stops;
  const stops = CONFIG.COLORMAP.map((hex) => {
    const c = new THREE.Color(hex);
    if (!white) return c;                       // dark / black: the plain colormap
    const hsl = {};
    c.getHSL(hsl, THREE.SRGBColorSpace);
    c.setHSL(hsl.h,
             Math.min(1, hsl.s * CONFIG.COLORMAP_WHITE_SATURATION_SCALE),
             Math.min(CONFIG.COLORMAP_WHITE_MAX_LIGHTNESS,
                      hsl.l * CONFIG.COLORMAP_WHITE_LIGHTNESS_SCALE),
             THREE.SRGBColorSpace);
    return c;
  });
  state.colormapCache = { white, stops };
  return stops;
}

const _cmTmp = new THREE.Color();
/** Sample the colormap at t (0..1) into _cmTmp - no allocation per cell. */
function sampleColormapInto(t, stops) {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  _cmTmp.setRGB(a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f);
}
/** Same colormap as a CSS gradient (for the legend bar). */
function colormapCss() {
  return 'linear-gradient(90deg, ' + colormapStops()
    .map((c) => '#' + c.clone().getHexString(THREE.SRGBColorSpace)).join(', ') + ')';
}

/** Continuous feature -> per-cell RGB (identical code path for every gene). */
function featureColorArray(stats) {
  const n = state.parsed.n;
  const out = new Float32Array(n * 3);
  const stops = colormapStops();
  const span = stats.q98 - stats.q02;
  for (let i = 0; i < n; i++) {
    let t = 0;
    if (span > 1e-12) {
      const v = Math.min(stats.q98, Math.max(stats.q02, stats.values[i]));
      t = (v - stats.q02) / span;
    } else if (stats.values[i] > stats.q02) {
      t = 1;
    }
    sampleColormapInto(t, stops);
    out[i * 3] = _cmTmp.r; out[i * 3 + 1] = _cmTmp.g; out[i * 3 + 2] = _cmTmp.b;
  }
  return out;
}

/** CellMajortype -> per-cell RGB (the original behaviour). */
function typeColorArray() {
  const n = state.parsed.n, typeIndex = state.parsed.typeIndex;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = state.typeColors[typeIndex[i]];
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  return out;
}

/** The single dispatch used by refreshPointColors(). */
function computeColorArray() {
  const by = state.colorBy;
  if (by === 'ecmAuc' || by === 'senCidScore') {
    const field = CONFIG.FEATURE_FIELDS[by];
    return { colors: featureColorArray(featureValues(field)), field, kind: 'continuous' };
  }
  if (by === 'senCidBinary') {
    const field = CONFIG.FEATURE_FIELDS.senCidBinary;
    return { colors: featureColorArray(featureValues(field)), field, kind: 'binary' };
  }
  if (by === 'gene' && state.selectedGeneField) {
    const field = state.selectedGeneField;
    return { colors: featureColorArray(featureValues(field)), field, kind: 'continuous' };
  }
  return { colors: typeColorArray(), field: null, kind: 'cellType' };
}

/** Switch the colour-by mode (points only). */
function applyColorBy(mode, { silent = false } = {}) {
  const allowed = ['cellType', 'ecmAuc', 'senCidScore', 'senCidBinary', 'gene'];
  state.colorBy = allowed.includes(mode) ? mode : 'cellType';
  document.body.classList.toggle('color-by-gene', state.colorBy === 'gene');
  const sel = document.getElementById('colorby-select');
  if (sel) sel.value = state.colorBy;
  refreshPointColors();
  if (!silent) {
    const info = state.lastColorInfo;
    setStatus(info && info.field ? `color by: ${info.field}` : 'color by: CellMajortype');
  }
}

/** Gene search: case-insensitive lookup in the CSV header, no whitelist. */
function applyGeneSearch(rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) {
    setGeneStatus('Enter a gene name.', 'warn');
    return false;
  }
  const header = findCsvColumn(name);
  const isGene = header && geneColumns().some((h) => h === header);
  if (!isGene) {
    setGeneStatus(`Gene "${name}" was not found in the dataset.`, 'error');
    return false;
  }
  state.selectedGeneField = header;
  state.selectedGeneName = header;
  setGeneStatus(`Gene expression: ${header}`, 'ok');
  if (state.colorBy === 'gene') refreshPointColors();
  logInfo(`gene search: ${name} -> ${header} (${featureValues(header).zeroCount} cells with 0)`);
  return true;
}

function setGeneStatus(text, kind = '') {
  const el = document.getElementById('gene-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'gene-status' + (kind ? ' ' + kind : '');
}

/* =============================================================== renderer == */
function createRenderer() {
  const renderer = new THREE.WebGLRenderer({
    antialias: CONFIG.ANTIALIAS,
    alpha: true,                       // needed for the optional transparent export
    preserveDrawingBuffer: true,       // makes the PNG export reliable
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.MAX_PIXEL_RATIO));
  renderer.setSize(dom.container.clientWidth, dom.container.clientHeight);
  renderer.setClearColor(state.bgColor, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // applied by OutputPass
  renderer.toneMappingExposure = 1.0;
  dom.container.appendChild(renderer.domElement);
  state.renderer = renderer;

  window.addEventListener('resize', onResize);
}

function createScene() {
  const scene = new THREE.Scene();
  scene.background = state.bgColor.clone();
  if (CONFIG.FOG_ENABLED) scene.fog = new THREE.FogExp2(state.bgColor.clone(), CONFIG.FOG_DENSITY);
  state.scene = scene;
}

function createCameraAndControls() {
  const { clientWidth: w, clientHeight: h } = dom.container;
  const camera = new THREE.PerspectiveCamera(CONFIG.CAMERA_FOV, w / h, 0.1, 5000);
  camera.position.set(0, 0, 60);
  state.camera = camera;

  const controls = new OrbitControls(camera, state.renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.85;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  controls.autoRotate = CONFIG.AUTO_ROTATE;
  controls.autoRotateSpeed = CONFIG.AUTO_ROTATE_SPEED;
  state.controls = controls;
}

function createComposer() {
  const { clientWidth: w, clientHeight: h } = dom.container;
  const pr = state.renderer.getPixelRatio();
  const composer = new EffectComposer(state.renderer);
  composer.setSize(w * pr, h * pr);

  const renderPass = new RenderPass(state.scene, state.camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w * pr, h * pr),
    CONFIG.BLOOM_STRENGTH, CONFIG.BLOOM_RADIUS, CONFIG.BLOOM_THRESHOLD
  );
  /* The final bloom composite is additive. Its default blend function
   * (SrcAlpha, One) is applied to the alpha channel as well, which drives the
   * canvas alpha to 1 wherever the fullscreen quad is drawn. That is invisible
   * in the normal opaque mode, but it would destroy the alpha of the
   * transparent canvas used by the Black/White backgrounds (and by the
   * transparent PNG export).
   * The RGB factors below are exactly the additive ones, so the glow is
   * unchanged; only the alpha factors are switched to "keep destination". */
  const bloomBlend = bloom.blendMaterial ?? bloom.materialCopy;   // r160 calls it blendMaterial
  if (bloomBlend) {
    bloomBlend.blending = THREE.CustomBlending;
    bloomBlend.blendEquation = THREE.AddEquation;
    bloomBlend.blendSrc = THREE.SrcAlphaFactor;
    bloomBlend.blendDst = THREE.OneFactor;
    bloomBlend.blendEquationAlpha = THREE.AddEquation;
    bloomBlend.blendSrcAlpha = THREE.ZeroFactor;
    bloomBlend.blendDstAlpha = THREE.OneFactor;
  }
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  state.composer = composer;
  state.bloomPass = bloom;
  state.renderPass = renderPass;
}

/* ================================================================== data == */
async function loadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.text();
}

/** Translate the cloud so its bounding-box centre sits at the origin.
 *  This is one global translation for every cell, so all relative positions
 *  (i.e. the UMAP structure) are preserved exactly. The source CSV is untouched;
 *  only the in-memory copy is shifted. */
function centerPositions() {
  const src = state.parsed.positions;
  const c = state.parsed.bounds.center.slice();
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i] - c[0];
    out[i + 1] = src[i + 1] - c[1];
    out[i + 2] = src[i + 2] - c[2];
  }
  state.parsed.positions = out;
  state.parsed.bounds = {
    min: state.parsed.bounds.min.map((v, k) => v - c[k]),
    max: state.parsed.bounds.max.map((v, k) => v - c[k]),
    center: [0, 0, 0],
    radius: state.parsed.bounds.radius
  };
}

/* ============================================================ point cloud == */
function createPointCloud() {
  const { positions, typeIndex, n, types } = state.parsed;
  const density = computePointDensity(state.parsed, CONFIG.DENSITY_GRID);

  const colors = new Float32Array(n * 3);
  buildTypeColors();
  for (let i = 0; i < n; i++) {
    const c = state.typeColors[typeIndex[i]];
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aType', new THREE.BufferAttribute(Float32Array.from(typeIndex), 1));
  geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('aDensity', new THREE.BufferAttribute(density, 1));
  geom.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPointSize:    { value: CONFIG.POINT_SIZE },
      uPixelRatio:   { value: state.renderer.getPixelRatio() },
      uRefDistance:  { value: 60 },
      uOpacity:      { value: CONFIG.POINT_OPACITY },
      uFocus:        { value: -1 },
      uDim:          { value: CONFIG.DIMMED_OPACITY },
      uDensityBoost: { value: CONFIG.DENSITY_BOOST }
    },
    vertexShader: pointsVertexShader,
    fragmentShader: pointsFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,   // glow when cells pile up …
    depthWrite: false,                  // … but points must not occlude each other
    depthTest: true
  });

  /* White-background material: a separate ShaderMaterial, so the dark/black
   * rendering path (shader source, blending, bloom) stays exactly as it was. */
  const whiteMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPointSize:    { value: CONFIG.POINT_SIZE },
      uPixelRatio:   { value: state.renderer.getPixelRatio() },
      uRefDistance:  { value: 60 },
      uOpacity:      { value: CONFIG.POINT_OPACITY * CONFIG.WHITE_POINT_OPACITY_MULTIPLIER },
      uFocus:        { value: -1 },
      uDim:          { value: CONFIG.DIMMED_OPACITY },
      uDensityAlpha: { value: CONFIG.WHITE_DENSITY_ALPHA },
      uHalo:         { value: CONFIG.WHITE_HALO_STRENGTH }
    },
    vertexShader: whitePointsVertexShader,
    fragmentShader: whitePointsFragmentShader,
    transparent: true,
    blending: THREE.NormalBlending,   // ink on paper: no additive accumulation
    depthWrite: false,
    depthTest: true
  });

  const points = new THREE.Points(geom, material);
  points.frustumCulled = false;
  state.scene.add(points);
  state.points = points;
  state.pointsMaterial = material;
  state.whitePointsMaterial = whiteMaterial;
  state.pointTypes = types;
  logInfo(`point cloud: ${n} points, 1 draw call, ${types.length} colours`);
}

function frameCamera() {
  const r = state.parsed.bounds.radius || 1;
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(CONFIG.CAMERA_FOV / 2))) * CONFIG.CAMERA_PADDING;
  state.refDistance = dist;
  state.camera.position.set(0.62, 0.44, 1).normalize().multiplyScalar(dist);
  state.camera.near = Math.max(0.1, dist * 0.01);
  state.camera.far = dist * 12;
  state.camera.updateProjectionMatrix();
  state.controls.target.set(0, 0, 0);
  state.controls.update();
  syncPointMaterials();
}

/* =============================================================== surfaces == */
function buildAllSurfaces() {
  const { typeIndex, types, counts } = state.parsed;
  const members = types.map(() => []);
  for (let i = 0; i < state.parsed.n; i++) members[typeIndex[i]].push(i);

  const group = new THREE.Group();
  group.name = 'density-surfaces';
  state.scene.add(group);
  state.surfaceGroup = group;

  const jobs = types.map((t, k) => ({ k, indices: Uint32Array.from(members[k]) }));
  let i = 0;
  const step = () => {
    const t0 = performance.now();
    while (i < jobs.length && performance.now() - t0 < CONFIG.SURFACE_UPDATE_CHUNK_MS) {
      const job = jobs[i++];
      const typeName = types[job.k];
      if (job.indices.length < CONFIG.SURFACE_MIN_CELLS) {
        logInfo(`surface skipped for ${typeName}: only ${job.indices.length} cells (< ${CONFIG.SURFACE_MIN_CELLS})`);
        continue;
      }
      const res = buildDensitySurface(state.parsed.positions, job.indices, {
        grid: CONFIG.SURFACE_GRID,
        bandwidth: CONFIG.SURFACE_BANDWIDTH,
        isoFraction: CONFIG.SURFACE_ISO_FRACTION,
        minCells: CONFIG.SURFACE_MIN_CELLS
      });
      if (!res.ok) {
        logInfo(`surface skipped for ${typeName}: ${res.reason}`);
        continue;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(res.positions, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(res.normals, 3));
      geom.computeBoundingSphere();

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor:    { value: state.typeColors[job.k].clone() },
          uOpacity:  { value: CONFIG.SURFACE_OPACITY },
          uRimPower: { value: CONFIG.SURFACE_FRESNEL_POWER },
          uGlow:     { value: CONFIG.SURFACE_GLOW_STRENGTH },
          uInterior: { value: CONFIG.SURFACE_INTERIOR },
          uFocus:    { value: -1 },
          uType:     { value: job.k },
          uDim:      { value: CONFIG.DIMMED_OPACITY }
        },
        vertexShader: surfaceVertexShader,
        fragmentShader: surfaceFragmentShader,
        transparent: true,
        blending: THREE.AdditiveBlending,  // a soft halo, never an opaque wall
        depthWrite: false,
        side: THREE.DoubleSide
      });
      /* White-background counterpart: a thin coloured contour in the cluster's
       * own (darkened) colour, interior ~0, no white highlight. */
      const whiteMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor:    { value: whiteInkColor(job.k, CONFIG.WHITE_SURFACE_RIM_DARKEN) },
          uOpacity:  { value: CONFIG.WHITE_SURFACE_OPACITY },
          uRimPower: { value: CONFIG.SURFACE_FRESNEL_POWER },
          uInterior: { value: 0.0 },
          uType:     { value: job.k },
          uFocus:    { value: -1 },
          uDim:      { value: CONFIG.DIMMED_OPACITY }
        },
        vertexShader: whiteSurfaceVertexShader,
        fragmentShader: whiteSurfaceFragmentShader,
        transparent: true,
        blending: THREE.NormalBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geom, state.bgMode === 'white' ? whiteMat : mat);
      mesh.userData.darkMaterial = mat;
      mesh.userData.whiteMaterial = whiteMat;
      mesh.renderOrder = 2;                // draw after the points
      mesh.visible = CONFIG.SURFACE_SHOW;
      mesh.frustumCulled = false;
      group.add(mesh);
      state.surfaces.set(job.k, mesh);
      logInfo(`surface ${typeName}: ${res.stats.vertices} verts / ${res.stats.triangles} tris ` +
              `(grid ${res.stats.grid}, sigma ${res.stats.sigma}, level ${res.stats.level})`);
    }
    if (i < jobs.length) requestAnimationFrame(step);
    else {
      setStatus(`${state.parsed.n.toLocaleString()} cells · ${state.parsed.types.length} cell types · ` +
                `${state.surfaces.size} surfaces`);
      window.__APP_SURFACES_READY = true;     // handshake for automated captures
      if (window.__APP_INFO) window.__APP_INFO.surfaces = state.surfaces.size;
    }
  };
  requestAnimationFrame(step);
}

/* ================================================================= labels == */
function createLabels() {
  const anchors = computeLabelAnchors(state.parsed);
  // anchors are already in the centred coordinate system used for rendering
  state.labels = anchors.map((a) => (a ? new THREE.Vector3(a[0], a[1], a[2]) : null));

  dom.labels.innerHTML = '';
  state.labelEls = state.parsed.types.map((t, k) => {
    const el = document.createElement('div');
    el.className = 'cell-label';
    el.innerHTML = `<span class="dot" style="background:${colorForIndex(k)}"></span>${t}`;
    dom.labels.appendChild(el);
    return el;
  });
  updateLabelVisibility();
}

function updateLabelVisibility() {
  state.labelEls.forEach((el) => { el.style.display = CONFIG.SHOW_LABELS ? 'flex' : 'none'; });
}

function updateLabels() {
  if (!CONFIG.SHOW_LABELS) return;
  const w = dom.container.clientWidth, h = dom.container.clientHeight;
  const v = new THREE.Vector3();
  for (let k = 0; k < state.labelEls.length; k++) {
    const anchor = state.labels[k];
    const el = state.labelEls[k];
    if (!anchor) { el.style.display = 'none'; continue; }
    v.copy(anchor).project(state.camera);
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    const visible = v.z < 1 && x > -80 && x < w + 80 && y > -40 && y < h + 40;
    el.style.display = visible ? 'flex' : 'none';
    el.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px)`;
    el.style.opacity = (state.focusType === -1 || state.focusType === k) ? '1' : '0.25';
  }
}

/* ================================================================= legend ==
 * The legend follows the colour-by mode:
 *   cellType      -> the 8 CellMajortype swatches (as before)
 *   continuous    -> a colour bar for the active feature
 *   SenCID_binary -> two swatches (0 / 1)
 * The CellMajortype list stays visible as reference (labels + surfaces keep
 * those colours), clearly marked so it is not mistaken for the feature scale.
 * ==========================================================================*/
function buildLegend() {
  const { types, counts } = state.parsed;
  dom.legend.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'legend-title';
  title.id = 'legend-title';
  title.textContent = 'Cell type';
  dom.legend.appendChild(title);

  const bar = document.createElement('div');
  bar.className = 'colorbar';
  bar.id = 'colorbar';
  bar.innerHTML = `<div class="colorbar-bar" id="colorbar-bar"></div>
                   <div class="colorbar-labels"><span id="colorbar-low">Low</span>
                   <span id="colorbar-high">High</span></div>
                   <div class="colorbar-note" id="colorbar-note"></div>`;
  dom.legend.appendChild(bar);

  const sub = document.createElement('div');
  sub.className = 'legend-subtitle';
  sub.id = 'legend-subtitle';
  sub.textContent = 'CellMajortype (labels & surfaces)';
  dom.legend.appendChild(sub);

  types.forEach((t, k) => {
    const row = document.createElement('button');
    row.className = 'legend-item';
    row.type = 'button';
    row.dataset.type = String(k);
    row.innerHTML = `<span class="swatch" style="background:${colorForIndex(k)}"></span>` +
                    `<span class="name">${t}</span><span class="count">${counts[k].toLocaleString()}</span>`;
    row.addEventListener('click', () => toggleFocus(k));
    dom.legend.appendChild(row);
  });

  const hint = document.createElement('div');
  hint.className = 'legend-hint';
  hint.textContent = 'click a cell type to highlight it · click again to reset';
  dom.legend.appendChild(hint);
}

/** Update the legend for the active colour-by mode (called from refreshPointColors). */
function updateLegendForColorBy() {
  const bar = document.getElementById('colorbar');
  const title = document.getElementById('legend-title');
  const sub = document.getElementById('legend-subtitle');
  if (!bar || !title || !sub) return;

  const info = state.lastColorInfo || { kind: 'cellType', field: null };
  const fmt = (v) => {
    if (!Number.isFinite(v)) return '0';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 100) return v.toFixed(0);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(3);
    return v.toExponential(1);
  };

  if (info.kind === 'cellType' || !info.field) {
    bar.classList.remove('visible');
    title.textContent = 'Cell type';
    sub.style.display = 'none';
    return;
  }

  const stats = featureValues(info.field);
  bar.classList.add('visible');
  sub.style.display = 'block';
  sub.textContent = 'CellMajortype (labels & surfaces)';
  title.textContent = state.colorBy === 'gene'
    ? `${info.field} expression`
    : `${info.field}`;

  const barEl = document.getElementById('colorbar-bar');
  const low = document.getElementById('colorbar-low');
  const high = document.getElementById('colorbar-high');
  const note = document.getElementById('colorbar-note');
  barEl.style.background = colormapCss();

  if (info.kind === 'binary') {
    barEl.style.background = colormapCss();
    low.textContent = '0';
    high.textContent = '1';
    note.textContent = `binary · ${stats.zeroCount.toLocaleString()} cells = 0`;
  } else {
    low.textContent = fmt(stats.q02);
    high.textContent = fmt(stats.q98);
    const zeroPct = stats.n ? (100 * stats.zeroCount / stats.n) : 0;
    note.textContent = `${stats.zeroCount.toLocaleString()} cells = 0 (${zeroPct.toFixed(1)}%) · ` +
                       `clip ${fmt(stats.q02)} … ${fmt(stats.q98)}`;
  }
}

function toggleFocus(k) {
  state.focusType = (state.focusType === k) ? -1 : k;
  syncPointMaterials();
  state.surfaces.forEach((mesh) => {
    mesh.userData.darkMaterial.uniforms.uFocus.value = state.focusType;
    mesh.userData.whiteMaterial.uniforms.uFocus.value = state.focusType;
  });
  [...dom.legend.querySelectorAll('.legend-item')].forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.type) === state.focusType);
  });
}

/* ================================================================== panel == */
function buildControlPanel() {
  const controls = [
    { id: 'point-size', label: 'Point size', min: 0.5, max: 8, step: 0.1, value: CONFIG.POINT_SIZE,
      onInput: (v) => { state.pointsMaterial.uniforms.uPointSize.value = v; } },
    { id: 'point-opacity', label: 'Point opacity', min: 0.05, max: 1, step: 0.01, value: CONFIG.POINT_OPACITY,
      onInput: (v) => updatePointOpacity(v) },
    { id: 'label-size', label: 'Label size', unit: 'px',
      min: CONFIG.LABEL_SIZE_RANGE[0], max: CONFIG.LABEL_SIZE_RANGE[1], step: 1, value: CONFIG.LABEL_SIZE,
      onInput: (v) => applyLabelSize(v) },
    { id: 'bloom-strength', label: 'Bloom strength', min: 0, max: 1.6, step: 0.01, value: CONFIG.BLOOM_STRENGTH,
      onInput: (v) => { state.userBloomStrength = v;
                        state.bloomPass.strength = state.bgMode === 'white' ? 0 : v; } },
    { id: 'bloom-radius', label: 'Bloom radius', min: 0, max: 1.5, step: 0.01, value: CONFIG.BLOOM_RADIUS,
      onInput: (v) => { state.bloomPass.radius = v; } },
    { id: 'bloom-threshold', label: 'Bloom threshold', min: 0, max: 1, step: 0.01, value: CONFIG.BLOOM_THRESHOLD,
      onInput: (v) => { state.bloomPass.threshold = v; } },
    { id: 'surface-opacity', label: 'Surface opacity', min: 0, max: 0.6, step: 0.005, value: CONFIG.SURFACE_OPACITY,
      onInput: (v) => { state.surfaces.forEach((m) => { m.material.uniforms.uOpacity.value = v; }); } },
    { id: 'background-brightness', label: 'Background brightness', min: 0.3, max: 2, step: 0.01,
      value: CONFIG.BACKGROUND_BRIGHTNESS, onInput: (v) => setBackgroundBrightness(v) }
  ];
  const backgroundRow = () => {
    const row = document.createElement('label');
    row.className = 'control control-select';
    row.innerHTML = `<span class="control-label">Background</span>
      <select id="background-select">
        <option value="dark">Dark</option>
        <option value="black">Black</option>
        <option value="white">White</option>
      </select>`;
    dom.panelBody.appendChild(row);
    const sel = row.querySelector('select');
    sel.value = state.bgMode;
    sel.addEventListener('change', (e) => applyBackgroundMode(e.target.value));
  };
  const whiteVariantRow = () => {
    const row = document.createElement('label');
    row.className = 'control control-select only-white';
    row.innerHTML = `<span class="control-label">White style</span>
      <select id="white-variant">
        ${Object.entries(WHITE_VARIANTS).map(([k, v]) =>
          `<option value="${k}"${k === state.whiteVariant ? ' selected' : ''}>${v.label}</option>`).join('')}
      </select>`;
    dom.panelBody.appendChild(row);
    row.querySelector('select').addEventListener('change', (e) => applyWhiteVariant(e.target.value));
  };
  const toggles = [
    { id: 'show-surfaces', label: 'Show surfaces', value: CONFIG.SURFACE_SHOW,
      onChange: (v) => { state.surfaces.forEach((m) => { m.visible = v; }); if (v && state.surfaces.size === 0) buildAllSurfaces(); } },
    { id: 'show-labels', label: 'Show labels', value: CONFIG.SHOW_LABELS,
      onChange: (v) => { CONFIG.SHOW_LABELS = v; updateLabelVisibility(); } },
    { id: 'export-transparent', label: 'Transparent PNG (bloom off)', value: CONFIG.EXPORT_TRANSPARENT,
      onChange: (v) => { state.exportTransparent = v; } },
    { id: 'export-labels', label: 'Include labels in PNG', value: true,
      onChange: (v) => { state.includeLabelsInExport = v; } }
  ];

  dom.panelBody.innerHTML = '';

  /* --- Color by (points only) + Gene search -------------------------------- */
  const colorByRow = document.createElement('label');
  colorByRow.className = 'control control-select';
  colorByRow.innerHTML = `<span class="control-label">Color by</span>
    <select id="colorby-select">
      <option value="cellType">Cell type</option>
      <option value="ecmAuc">ECM_AUC</option>
      <option value="senCidScore">SenCID_score</option>
      <option value="senCidBinary">SenCID_binary</option>
      <option value="gene">Gene expression</option>
    </select>`;
  dom.panelBody.appendChild(colorByRow);
  const colorBySel = colorByRow.querySelector('select');
  colorBySel.value = state.colorBy;
  colorBySel.addEventListener('change', (e) => applyColorBy(e.target.value));

  const geneRow = document.createElement('div');
  geneRow.className = 'control control-gene only-gene';
  geneRow.innerHTML = `<span class="control-label">Gene</span>
    <div class="gene-row">
      <input id="gene-input" type="text" list="gene-list" spellcheck="false" autocomplete="off"
             placeholder="e.g. BMP1" value="${state.selectedGeneName || ''}">
      <button type="button" id="gene-apply">Apply</button>
    </div>
    <div class="gene-status" id="gene-status"></div>
    <datalist id="gene-list">${geneColumns().map((g) => `<option value="${g}"></option>`).join('')}</datalist>`;
  dom.panelBody.appendChild(geneRow);
  const geneInput = geneRow.querySelector('#gene-input');
  geneRow.querySelector('#gene-apply').addEventListener('click', () => {
    if (applyGeneSearch(geneInput.value)) applyColorBy('gene');
  });
  geneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (applyGeneSearch(geneInput.value)) applyColorBy('gene');
    }
  });


  /* --- visual preset + presentation actions --------------------------------- */
  const presetRow = document.createElement('label');
  presetRow.className = 'control control-select';
  presetRow.innerHTML = `<span class="control-label">Visual preset</span>
    <select id="preset-select">
      ${Object.entries(PRESETS).map(([k, v]) =>
        `<option value="${k}"${k === state.preset ? ' selected' : ''}>${v.label}</option>`).join('')}
    </select>`;
  dom.panelBody.appendChild(presetRow);
  dom.presetSelect = presetRow.querySelector('select');
  dom.presetSelect.addEventListener('change', (e) => applyPreset(e.target.value));

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.innerHTML = `
    <button type="button" id="reset-view">Reset view</button>
    <button type="button" id="toggle-legend">Hide legend</button>
    ${CONFIG.EXPORT_SCALES.map((s) => `<button type="button" id="export-${s}x">Export ${s}× PNG</button>`).join('')}
    <button type="button" id="figure-mode-panel">Figure Mode</button>`;
  dom.panelBody.appendChild(actions);

  const addSlider = (c) => {
    const row = document.createElement('label');
    row.className = 'control';
    row.innerHTML = `<span class="control-label">${c.label}</span>
                     <input type="range" id="${c.id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}">
                     <span class="control-value" id="${c.id}-value">${(+c.value).toFixed(c.unit === 'px' ? 1 : 2)}${c.unit ? ' ' + c.unit : ''}</span>`;
    dom.panelBody.appendChild(row);
    const input = row.querySelector('input');
    const out = row.querySelector('.control-value');
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      out.textContent = (c.unit === 'px' ? Math.round(v) + ' px' : v.toFixed(2));
      c.onInput(v);
    });
  };

  // order requested for the panel:
  //   point size / opacity  ->  label size  ->  bloom  ->  surface opacity
  //   ->  background (+ brightness)  ->  toggles
  ['point-size', 'point-opacity', 'label-size', 'bloom-strength', 'bloom-radius',
   'bloom-threshold', 'surface-opacity'].forEach((id) => addSlider(controls.find((c) => c.id === id)));
  backgroundRow();
  whiteVariantRow();
  addSlider(controls.find((c) => c.id === 'background-brightness'));

  toggles.forEach((t) => {
    const row = document.createElement('label');
    row.className = 'control control-toggle';
    row.innerHTML = `<input type="checkbox" id="${t.id}" ${t.value ? 'checked' : ''}>
                     <span class="control-label">${t.label}</span>`;
    dom.panelBody.appendChild(row);
    row.querySelector('input').addEventListener('change', (e) => t.onChange(e.target.checked));
  });

  document.getElementById('reset-view').addEventListener('click', resetCamera);
  document.getElementById('toggle-legend').addEventListener('click', () => toggleLegend());
  document.getElementById('figure-mode-panel').addEventListener('click', () => applyFigureMode(!state.figureMode));
  CONFIG.EXPORT_SCALES.forEach((s) => {
    document.getElementById(`export-${s}x`).addEventListener('click', () => exportPNG(s));
  });

  /* --- floating quick bar (stays reachable in figure mode) ------------------ */
  const quick = document.createElement('div');
  quick.id = 'quickbar';
  quick.innerHTML = `
    <button type="button" id="figure-mode">Figure Mode</button>
    <button type="button" id="quick-toggle-legend">Hide legend</button>
    <button type="button" id="quick-reset">Reset view</button>
    <button type="button" id="quick-export-2">Export 2×</button>
    <button type="button" id="quick-export-4">Export 4×</button>`;
  document.body.appendChild(quick);
  dom.figureBtn = document.getElementById('figure-mode');
  dom.legendBtn = document.getElementById('quick-toggle-legend');
  dom.figureBtn.addEventListener('click', () => applyFigureMode(!state.figureMode));
  dom.legendBtn.addEventListener('click', () => toggleLegend());
  document.getElementById('quick-reset').addEventListener('click', resetCamera);
  CONFIG.EXPORT_SCALES.forEach((s) => {
    document.getElementById(`quick-export-${s}`).addEventListener('click', () => exportPNG(s));
  });
}

/* ------------------------------------------------------------- background --
 * dark  : exactly the original behaviour (colour x brightness, opaque canvas)
 * black : #000000 and white : #FFFFFF are drawn by the *page* (CSS) and by the
 *         PNG encoder underneath a TRANSPARENT WebGL canvas. That keeps the two
 *         colours exact (no tone mapping applied to them) and leaves the bloom
 *         pipeline untouched, because bloom then only ever sees the points.
 * -------------------------------------------------------------------------*/
function isOpaqueBackground() {
  return state.bgMode === 'dark' && !state.exportTransparent;
}

function setBackgroundBrightness(mult) {
  const mode = state.bgMode;
  const c = new THREE.Color(CONFIG.BACKGROUND_COLOR).multiplyScalar(mult);
  // the WebGL clear colour: only the dark mode paints a background in GL
  state.bgColor.copy(c);
  const opaque = isOpaqueBackground();
  state.renderer.setClearColor(c, opaque ? 1 : 0);
  state.scene.background = opaque ? c.clone() : null;
  if (state.scene.fog) {
    // fog fades distant points towards the visible background colour
    state.scene.fog.color.set(
      mode === 'white' ? CONFIG.BACKGROUND_WHITE :
      mode === 'black' ? CONFIG.BACKGROUND_BLACK : CONFIG.BACKGROUND_COLOR
    );
    if (mode === 'dark') state.scene.fog.color.multiplyScalar(mult);
  }
  // The page background shows through the transparent canvas in black/white
  // mode. In dark mode the canvas is opaque, and the stylesheet background is
  // left completely untouched so the original look is preserved byte for byte.
  const cssBg = mode === 'white' ? CONFIG.BACKGROUND_WHITE
              : mode === 'black' ? CONFIG.BACKGROUND_BLACK : '';
  document.documentElement.style.background = cssBg;
  document.body.style.background = cssBg;
  if (dom.container) dom.container.style.background = cssBg;
}

/** Public: switch background mode (live, no reload). */
function applyBackgroundMode(mode) {
  state.bgMode = ['dark', 'black', 'white'].includes(mode) ? mode : 'dark';
  document.body.classList.toggle('bg-white', state.bgMode === 'white');
  document.body.classList.toggle('bg-black', state.bgMode === 'black');

  // presets must never override an explicit black/white choice, and the
  // brightness slider only makes sense for the dark background
  const bright = document.getElementById('background-brightness');
  if (bright) {
    bright.disabled = state.bgMode !== 'dark';
    bright.closest('.control')?.classList.toggle('control-disabled', state.bgMode !== 'dark');
  }
  const sel = document.getElementById('background-select');
  if (sel) sel.value = state.bgMode;

  setBackgroundBrightness(CONFIG.BACKGROUND_BRIGHTNESS);
  applyLabelSize(CONFIG.LABEL_SIZE);      // label colours depend on the mode
  applyBackgroundBlending();              // white needs a different blend mode
  if (dom.legend) dom.legend.classList.toggle('light', state.bgMode === 'white');
  setStatus(`background: ${state.bgMode}`);
}

/* --------------------- background: material switching ----------------------
 * Dark / Black : the original additive material + UnrealBloom (untouched).
 * White        : a dedicated "ink on paper" material (own shader, normal
 *                blending, density -> deeper colour) and no bloom, because a
 *                white page has no room for a white glow. The user's bloom
 *                slider value is remembered and restored when leaving White.
 * -------------------------------------------------------------------------*/
function applyBackgroundBlending() {
  const white = state.bgMode === 'white';
  if (state.points) {
    state.points.material = white ? state.whitePointsMaterial : state.pointsMaterial;
  }
  state.surfaces.forEach((mesh) => {
    mesh.material = white ? mesh.userData.whiteMaterial : mesh.userData.darkMaterial;
  });
  if (state.bloomPass) {
    state.bloomPass.strength = white ? 0 : state.userBloomStrength;
  }
  applyWhiteVariant(state.whiteVariant, { silent: true, keepColors: false });
  syncPointMaterials();
}

/** Copy the shared uniforms (size, distance, focus, dim) to both materials. */
function syncPointMaterials() {
  const list = [state.pointsMaterial, state.whitePointsMaterial].filter(Boolean);
  if (!list.length) return;
  const pr = state.renderer ? state.renderer.getPixelRatio() : 1;
  list.forEach((m) => {
    m.uniforms.uPointSize.value = CONFIG.POINT_SIZE;
    m.uniforms.uPixelRatio.value = pr;
    m.uniforms.uRefDistance.value = state.refDistance || 60;
    m.uniforms.uFocus.value = state.focusType;
    m.uniforms.uDim.value = CONFIG.DIMMED_OPACITY;
  });
  if (state.pointsMaterial) state.pointsMaterial.uniforms.uOpacity.value = CONFIG.POINT_OPACITY;
  if (state.whitePointsMaterial) {
    state.whitePointsMaterial.uniforms.uOpacity.value =
      CONFIG.POINT_OPACITY * CONFIG.WHITE_POINT_OPACITY_MULTIPLIER;
    state.whitePointsMaterial.uniforms.uDensityAlpha.value = CONFIG.WHITE_DENSITY_ALPHA;
    state.whitePointsMaterial.uniforms.uHalo.value = CONFIG.WHITE_HALO_STRENGTH;
  }
}

/** The opacity slider keeps its meaning in every mode. */
function updatePointOpacity(v) {
  CONFIG.POINT_OPACITY = v;
  syncPointMaterials();
}

/** Switch between the three white-background candidates (Soft / Balanced / Strong). */
function applyWhiteVariant(name, { silent = false } = {}) {
  const key = WHITE_VARIANTS[name] ? name : 'balanced';
  state.whiteVariant = key;
  const v = WHITE_VARIANTS[key];
  Object.entries(v).forEach(([k, val]) => { if (k !== 'label') CONFIG[k] = val; });
  const sel = document.getElementById('white-variant');
  if (sel) sel.value = key;
  refreshPointColors();
  syncPointMaterials();
  state.surfaces.forEach((mesh) => {
    const wm = mesh.userData.whiteMaterial;
    if (wm) wm.uniforms.uOpacity.value = CONFIG.WHITE_SURFACE_OPACITY;
  });
  if (!silent) setStatus(`white background: ${v.label}`);
}

/* ------------------------------------------------------------- label size --
 * Only the font-size (and the padding/dot scale derived from it) is touched.
 * Anchors, positions and the label objects themselves are never rebuilt.
 * -------------------------------------------------------------------------*/
function applyLabelSize(px) {
  CONFIG.LABEL_SIZE = Math.min(Math.max(Number(px) || 0, CONFIG.LABEL_SIZE_RANGE[0]),
                               CONFIG.LABEL_SIZE_RANGE[1]);
  const style = document.documentElement.style;
  style.setProperty('--label-size', CONFIG.LABEL_SIZE + 'px');
  // per-label border colour = its CellMajortype colour (only visible on white)
  state.labelEls.forEach((el, k) => {
    el.style.borderColor = '#' + state.typeColors[k].getHexString();
  });
  const out = document.getElementById('label-size-value');
  if (out) out.textContent = `${CONFIG.LABEL_SIZE} px`;
  const input = document.getElementById('label-size');
  if (input) input.value = String(CONFIG.LABEL_SIZE);
}

function resetCamera() {
  frameCamera();
}

/* ================================================================= presets ==
 * A preset only writes visual parameters; nothing about the data changes.
 * ==========================================================================*/
function applyPreset(name, { silent = false } = {}) {
  const key = PRESETS[name] ? name : DEFAULT_PRESET;
  const p = PRESETS[key];
  state.preset = key;
  Object.entries(p).forEach(([k, v]) => { if (k !== 'label') CONFIG[k] = v; });

  if (state.pointsMaterial) {
    state.pointsMaterial.uniforms.uPointSize.value = CONFIG.POINT_SIZE;
    updatePointOpacity(CONFIG.POINT_OPACITY);
  }
  if (state.bloomPass) {
    state.userBloomStrength = CONFIG.BLOOM_STRENGTH;      // remembered for white mode
    state.bloomPass.strength = state.bgMode === 'white' ? 0 : CONFIG.BLOOM_STRENGTH;
    state.bloomPass.radius = CONFIG.BLOOM_RADIUS;
    state.bloomPass.threshold = CONFIG.BLOOM_THRESHOLD;
  }
  state.surfaces.forEach((mesh) => {
    const u = mesh.material.uniforms;
    u.uOpacity.value = CONFIG.SURFACE_OPACITY;
    u.uRimPower.value = CONFIG.SURFACE_FRESNEL_POWER;
    u.uGlow.value = CONFIG.SURFACE_GLOW_STRENGTH;
    u.uInterior.value = CONFIG.SURFACE_INTERIOR;
  });
  setBackgroundBrightness(CONFIG.BACKGROUND_BRIGHTNESS);
  refreshPointColors();
  syncPanelToConfig();
  if (dom.presetSelect) dom.presetSelect.value = key;
  if (!silent) setStatus(`visual preset: ${p.label}`);
  logInfo(`preset ${p.label}: size=${p.POINT_SIZE} opacity=${p.POINT_OPACITY} ` +
          `bloom=${p.BLOOM_STRENGTH}/${p.BLOOM_RADIUS}/${p.BLOOM_THRESHOLD} ` +
          `surface=${p.SURFACE_OPACITY} fresnel=${p.SURFACE_FRESNEL_POWER} glow=${p.SURFACE_GLOW_STRENGTH}`);
}

/** Keep the sliders in sync after a preset changed the values. */
function syncPanelToConfig() {
  if (!dom.panelBody) return;
  ['point-size', 'point-opacity', 'bloom-strength', 'bloom-radius', 'bloom-threshold',
   'surface-opacity', 'background-brightness'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const map = {
      'point-size': CONFIG.POINT_SIZE, 'point-opacity': CONFIG.POINT_OPACITY,
      'bloom-strength': CONFIG.BLOOM_STRENGTH, 'bloom-radius': CONFIG.BLOOM_RADIUS,
      'bloom-threshold': CONFIG.BLOOM_THRESHOLD, 'surface-opacity': CONFIG.SURFACE_OPACITY,
      'background-brightness': CONFIG.BACKGROUND_BRIGHTNESS
    };
    const v = map[id];
    if (v === undefined) return;
    el.value = String(v);
    const out = document.getElementById(id + '-value');
    if (out) out.textContent = (+v).toFixed(2);
  });
  const chk = document.getElementById('show-surfaces');
  if (chk) chk.checked = CONFIG.SURFACE_SHOW;
}

/* ============================================================ figure mode ==
 * A clean presentation view: no panel, no status bar, no hint, no labels,
 * legend kept, current camera angle untouched.
 * ==========================================================================*/
function applyFigureMode(on, { silent = false } = {}) {
  state.figureMode = !!on;
  document.body.classList.toggle('figure-mode', state.figureMode);
  if (dom.figureBtn) {
    dom.figureBtn.textContent = state.figureMode ? 'Exit Figure Mode' : 'Figure Mode';
    dom.figureBtn.classList.toggle('active', state.figureMode);
  }
  if (state.figureMode) {
    state.labelsBeforeFigureMode = CONFIG.SHOW_LABELS;
    if (!state.labelsExplicit) CONFIG.SHOW_LABELS = false;   // default: clean view
  } else if (typeof state.labelsBeforeFigureMode === 'boolean') {
    CONFIG.SHOW_LABELS = state.labelsBeforeFigureMode;
  }
  updateLabelVisibility();
  onResize();                                   // viewport geometry changed
  if (!silent) setStatus(state.figureMode ? 'figure mode on' : 'figure mode off');
}

function toggleLegend(force) {
  state.showLegend = (typeof force === 'boolean') ? force : !state.showLegend;
  document.body.classList.toggle('no-legend', !state.showLegend);
  if (dom.legendBtn) dom.legendBtn.textContent = state.showLegend ? 'Hide legend' : 'Show legend';
  onResize();
}

function showHint() {
  if (!dom.hint) return;
  dom.hint.classList.add('visible');
  setTimeout(() => dom.hint.classList.remove('visible'), 6000);
}

// expose the exporter for automated checks / power users (identical to the button)
window.__APP_EXPORT_PNG = (scale) => exportPNG(scale);
// lightweight state probe (used by the automated verification scripts)
window.__APP_DEBUG = () => {
  // defensive: this hook may be called before init() has finished
  const pts = state.points;
  const sum = (attr, step) => {
    if (!attr) return null;
    const a = attr.array;
    let h = 0;
    for (let i = 0; i < a.length; i += step) h = (h * 31 + Math.round(a[i] * 1e5)) % 2147483647;
    return h;
  };
  const info = state.lastColorInfo;
  const featureStats = (() => {
    if (!info || !info.field) return null;
    const st = featureValues(info.field);
    return { field: st.field, q02: st.q02, q98: st.q98, min: st.min, max: st.max,
             invalidCount: st.invalidCount, zeroCount: st.zeroCount,
             cacheSize: state.featureCache.size };
  })();
  const firstSurface = [...state.surfaces.values()][0];
  const legendTitle = document.getElementById('legend-title');
  const colorbar = document.getElementById('colorbar');
  return {
    bgMode: state.bgMode,
    colorBy: state.colorBy,
    selectedGene: state.selectedGeneField,
    lastColorInfo: info,
    featureStats,
    positionChecksum: sum(pts && pts.geometry.getAttribute('position'), 97),
    colorChecksum: sum(pts && pts.geometry.getAttribute('aColor'), 97),
    firstColors: pts ? Array.from(pts.geometry.getAttribute('aColor').array.slice(0, 6)).map((v) => +v.toFixed(5)) : null,
    surfaceColorSample: firstSurface ? '#' + firstSurface.material.uniforms.uColor.value.getHexString() : null,
    surfaceCount: state.surfaces.size,
    labelAnchors: state.labels.slice(0, 2).map((v) => v ? v.toArray().map((x) => +x.toFixed(4)) : null),
    cameraPosition: state.camera ? state.camera.position.toArray().map((x) => +x.toFixed(4)) : null,
    legend: { title: legendTitle ? legendTitle.textContent : null,
              colorbarVisible: !!(colorbar && colorbar.classList.contains('visible')) },
    geneStatus: (() => { const el = document.getElementById('gene-status'); return el ? el.textContent : null; })()
  };
};

/* ================================================================ animate == */
function animate() {
  requestAnimationFrame(animate);
  state.controls.update();
  state.composer.render();
  updateLabels();
  updateHud();
  // small handshake for automated captures / smoke tests
  if (!window.__APP_READY) {
    window.__APP_READY = true;
    window.__APP_INFO = {
      cells: state.parsed.n, types: state.parsed.types.length,
      preset: state.preset, surfaces: state.surfaces.size,
      labelsVisible: CONFIG.SHOW_LABELS, figureMode: state.figureMode
    };
  }
}

function updateHud() {
  state.frames++;
  const now = performance.now();
  const dt = now - state.lastFpsTime;
  if (state.frames === 1 || dt > 500) {
    state.fps = dt > 1 ? Math.round((state.frames * 1000) / dt) : 0;
    state.frames = 0;
    state.lastFpsTime = now;
    dom.hud.textContent = `${state.fps > 0 ? state.fps + ' fps' : 'rendering'} · ` +
                          `${state.parsed ? state.parsed.n.toLocaleString() : 0} points · ` +
                          `${state.surfaces.size} surfaces`;
  }
}

/* ================================================================== export == */
async function exportPNG(scale) {
  const w = dom.container.clientWidth, h = dom.container.clientHeight;
  const prevPR = state.renderer.getPixelRatio();
  const prevBloom = state.bloomPass.strength;
  const prevAspect = state.camera.aspect;
  const prevClearAlpha = state.renderer.getClearAlpha();
  const gl = state.renderer.getContext();
  const gpuMax = Math.min(
    state.renderer.capabilities.maxTextureSize || 4096,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096
  );
  /* Software rasterisers (SwiftShader / llvmpipe, used when a browser falls back
   * to CPU rendering) cannot hold the framebuffers of a very large export and
   * would fail mid-render. Detect them and cap the bitmap size up front, so no
   * failed allocation (and no GPU warning) is ever produced. Hardware GPUs are
   * left untouched and render the full requested scale. */
  const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = dbgInfo ? String(gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL)) : '';
  const isSoftware = /swiftshader|llvmpipe|softpipe|software/i.test(rendererName);
  const maxMegapixels = isSoftware ? CONFIG.EXPORT_MAX_MP_SOFTWARE : CONFIG.EXPORT_MAX_MP_HARDWARE;
  let requestedScale = scale;
  if ((w * h * requestedScale * requestedScale) / 1e6 > maxMegapixels) {
    requestedScale = Math.max(1, Math.floor(Math.sqrt((maxMegapixels * 1e6) / (w * h)) * 100) / 100);
    logInfo(`export: ${isSoftware ? 'software renderer' : 'renderer'} limited to ${maxMegapixels} MP -> ` +
            `${scale}x becomes ${requestedScale}x`);
  }

  setStatus(`rendering ${scale}x export ...`);
  dom.panel.classList.add('exporting');
  dom.legend.classList.add('exporting');

  // transparent export switches bloom off (a bloom on a transparent buffer
  // produces halos that cannot be composited correctly) - documented in README
  if (state.exportTransparent) {
    state.bloomPass.strength = 0;
    state.renderer.setClearAlpha(0);
    state.scene.background = null;
  } else if (state.bgMode !== 'dark') {
    // black / white: keep the transparent GL canvas and paint the exact colour
    // into the exported bitmap below (no tone mapping touches it)
    state.renderer.setClearAlpha(0);
    state.scene.background = null;
  }

  /* Some renderers (software rasterisers, older GPUs) cannot allocate the
   * framebuffers of a large export and silently return an empty image. So we
   * render, look at the result, and halve the scale until real content appears.
   * On a normal GPU the first attempt succeeds and nothing changes. */
  const attemptScales = [requestedScale, requestedScale / 2, requestedScale / 4].filter((v) => v >= 1);
  let out = null, ctx = null, pr = requestedScale, content = false;
  const attempts = [];
  for (const s of attemptScales) {
    pr = s;
    state.renderer.setPixelRatio(pr);
    state.renderer.setSize(w, h, false);
    state.composer.setSize(w * pr, h * pr);
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
    syncPointMaterials();
    drainGlErrors(gl);                  // clear any stale error before the frame
    state.composer.render();
    const glErrors = drainGlErrors(gl); // allocation failures show up here

    out = document.createElement('canvas');
    out.width = Math.round(w * pr);
    out.height = Math.round(h * pr);
    ctx = out.getContext('2d', { willReadFrequently: true });
    if (!state.exportTransparent) {
      if (state.bgMode === 'white') { ctx.fillStyle = CONFIG.BACKGROUND_WHITE; ctx.fillRect(0, 0, out.width, out.height); }
      else if (state.bgMode === 'black') { ctx.fillStyle = CONFIG.BACKGROUND_BLACK; ctx.fillRect(0, 0, out.width, out.height); }
    }
    ctx.drawImage(state.renderer.domElement, 0, 0, out.width, out.height);
    content = glErrors.length === 0 && canvasHasContent(ctx, out.width, out.height);
    attempts.push({ scale: s, width: out.width, height: out.height, content,
                    glErrors: glErrors.length });
    if (content) break;
    logInfo(`export: ${s}x produced an empty frame (renderer limit) -> retrying`);
  }
  if (pr !== scale) logInfo(`export: used ${pr}x instead of ${scale}x`);
  if (!content) logInfo('export: warning - the exported frame looks empty');

  if (state.includeLabelsInExport && CONFIG.SHOW_LABELS) drawLabelsToCanvas(ctx, w, h, pr);

  const url = out.toDataURL('image/png');
  // diagnostics for automated checks (corner colours prove the real background)
  const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
  window.__APP_LAST_EXPORT = {
    scale, effectiveScale: pr, gpuMax, width: out.width, height: out.height,
    scaleReduced: pr !== scale, softwareRenderer: isSoftware, maxMegapixels, attempts, hasContent: content,
    backgroundMode: state.bgMode, transparent: state.exportTransparent,
    labelSize: CONFIG.LABEL_SIZE, labelsShown: CONFIG.SHOW_LABELS,
    bloom: state.bloomPass.strength,
    corners: [px(2, 2), px(out.width - 3, 2), px(2, out.height - 3), px(out.width - 3, out.height - 3)],
    bytes: url.length
  };
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `umap3d_cellmajortype_${scale}x_${stamp}.png`;
  a.click();

  // restore everything exactly as it was
  state.renderer.setPixelRatio(prevPR);
  state.renderer.setSize(w, h, false);
  state.composer.setSize(w * prevPR, h * prevPR);
  state.camera.aspect = prevAspect;
  state.camera.updateProjectionMatrix();
  syncPointMaterials();
  state.bloomPass.strength = prevBloom;
  state.renderer.setClearAlpha(prevClearAlpha);
  if (!state.exportTransparent && state.bgMode === 'dark') state.scene.background = state.bgColor.clone();
  dom.panel.classList.remove('exporting');
  dom.legend.classList.remove('exporting');
  setStatus(`exported ${pr}x (${out.width}x${out.height})`);
}

/** Does the rendered bitmap actually contain the scene (and not just the background)? */
function drainGlErrors(gl) {
  const errs = [];
  for (let i = 0; i < 16; i++) {
    const e = gl.getError();
    if (e === gl.NO_ERROR) break;
    errs.push(e);
  }
  return errs;
}

function canvasHasContent(ctx, w, h) {
  const bands = 3;
  let sampled = 0, differing = 0;
  for (let b = 0; b < bands; b++) {
    const y = Math.floor((h / (bands + 1)) * (b + 1));
    const stripH = Math.max(1, Math.min(60, Math.floor(h / 20)));
    const data = ctx.getImageData(0, y, w, stripH).data;
    for (let i = 0; i < data.length; i += 4 * 7) {     // stride over the strip
      sampled++;
      const r = data[i], g = data[i + 1], bl = data[i + 2], a = data[i + 3];
      if (state.exportTransparent) {
        if (a > 8) differing++;
      } else if (state.bgMode === 'white') {
        if (Math.min(r, g, bl) < 246) differing++;
      } else if (state.bgMode === 'black') {
        if (Math.max(r, g, bl) > 8) differing++;
      } else {
        const bg = state.bgColor, ref = [bg.r * 255, bg.g * 255, bg.b * 255];
        if (Math.abs(r - ref[0]) + Math.abs(g - ref[1]) + Math.abs(bl - ref[2]) > 12) differing++;
      }
    }
  }
  return sampled > 0 && differing / sampled > 0.002;
}

function drawLabelsToCanvas(ctx, cssW, cssH, scale) {
  const v = new THREE.Vector3();
  const fontPx = CONFIG.LABEL_SIZE * scale;      // exactly what the user picked
  const light = state.bgMode === 'white';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
  for (let k = 0; k < state.labelEls.length; k++) {
    const anchor = state.labels[k];
    if (!anchor) continue;
    if (state.focusType !== -1 && state.focusType !== k) continue;
    v.copy(anchor).project(state.camera);
    if (v.z >= 1) continue;
    const x = (v.x * 0.5 + 0.5) * cssW * scale;
    const y = (-v.y * 0.5 + 0.5) * cssH * scale;
    const text = state.parsed.types[k];
    const pad = 0.7 * fontPx;
    const wpx = ctx.measureText(text).width + pad * 2;
    const boxH = fontPx * 1.7;
    ctx.fillStyle = light ? 'rgba(255,255,255,0.78)' : 'rgba(9,13,25,0.55)';
    ctx.fillRect(x - wpx / 2, y - boxH / 2, wpx, boxH);
    ctx.strokeStyle = '#' + state.typeColors[k].getHexString();
    ctx.lineWidth = Math.max(1, fontPx * 0.08);
    ctx.strokeRect(x - wpx / 2, y - boxH / 2, wpx, boxH);
    ctx.fillStyle = light ? 'rgba(17,24,39,0.95)' : 'rgba(255,255,255,0.92)';
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
  }
}

/* =================================================================== misc == */
function onResize() {
  const w = dom.container.clientWidth, h = dom.container.clientHeight;
  const pr = state.renderer.getPixelRatio();
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(w, h);
  state.composer.setSize(w * pr, h * pr);
  if (state.bloomPass) state.bloomPass.setSize(w * pr, h * pr);
}

function setStatus(msg) {
  if (dom.status) dom.status.textContent = msg;
  if (dom.loadingText && dom.loading && !dom.loading.classList.contains('hidden')) {
    dom.loadingText.textContent = msg;
  }
}

function logInfo(msg) {
  if (dom.log) {
    const line = document.createElement('div');
    line.textContent = msg;
    dom.log.appendChild(line);
    dom.log.scrollTop = dom.log.scrollHeight;
  }
  console.log('[3D-UMAP]', msg);
}

function showFatal(err) {
  if (dom.loading) {
    dom.loading.classList.remove('hidden');
    dom.loading.innerHTML = `<div class="fatal"><strong>Could not start</strong><br>${err.message}<br>
      <small>Serve the folder over HTTP (python3 -m http.server 8000) - opening index.html
      directly with file:// blocks CSV loading.</small></div>`;
  }
}
