# 3D UMAP viewer — CellMajortype

Interactive 3D point-cloud viewer for the single-cell UMAP (`scRNA_merged_3DUMAP.rds`).
Every cell is one glowing point, coloured by **CellMajortype** only.
`BMP1`, `BMP1_display`, age group and all other annotations are deliberately ignored.

```
3D_UMAP/
├── index.html                  page shell + import map (Three.js r160)
├── css/style.css               dark layout, legend, panel, labels
├── data/umap3d_celltype.csv    original data (read-only, never modified)
├── js/
│   ├── config.js               ALL visual parameters (edit here)
│   ├── data.js                 CSV parsing, column detection, label anchors, density
│   ├── shaders.js              GLSL: soft round point sprites + shell rim glow
│   ├── surface.js              density field + marching-tetrahedra isosurface
│   ├── main.js                 scene, camera, bloom, UI wiring, PNG export
│   └── vendor/three/           Three.js r160 (bundled, works offline)
├── tools/                      Node tests (no browser needed)
├── data_check.txt              data audit: columns, counts, ranges, QC
└── README.md
```

---

## 1. How to start

The page must be served over HTTP (`file://` blocks the CSV fetch):

```bash
cd ~/Desktop/aging/3D_UMAP
python3 -m http.server 8000
```

Leave the terminal open. Stop it with `Ctrl-C`.

## 2. Address

<http://localhost:8000/> — or `http://localhost:8000/index.html`.

## 3. Rotate

Left-drag rotates, right-drag (or two-finger drag) pans, and the scroll wheel /
pinch zooms. Rotation has inertia; the camera always looks at the centre of the
point cloud. **Reset camera** in the control panel returns to the initial view.

## 4. Zoom

Mouse wheel / trackpad pinch. The point size is attenuated by distance, so cells
stay the same apparent size as you zoom (this is the `uRefDistance` term in
`js/shaders.js`).

## 5. Change the point size

* live: the **Point size** slider in the control panel (0.5 – 8).
* permanently: `POINT_SIZE` at the top of `js/config.js` (also `POINT_OPACITY`).

Larger values make high-density regions merge into brighter clouds; keep
`POINT_SIZE` around 2–3.5 for a crisp, single-cell-resolved look.

## 6. Change the bloom

Sliders **Bloom strength / radius / threshold**, or the constants
`BLOOM_STRENGTH`, `BLOOM_RADIUS`, `BLOOM_THRESHOLD` in `js/config.js`.

Recommended range: strength 0.35 – 0.8, radius 0.4 – 0.7, threshold 0.25 – 0.45.
Raising the threshold keeps only the brightest cores glowing, which is what stops
dense clusters from turning into a white blob. To switch the glow off entirely set
`BLOOM_STRENGTH: 0`.

## 7. Turn the surfaces on/off

Checkbox **Show surfaces** (top of the panel) or `SURFACE_SHOW` in `js/config.js`.
Opacity slider = `SURFACE_OPACITY` (0.13 by default, deliberately very faint).
The surfaces are built progressively after the point cloud appears; the log panel
(bottom of the control panel) lists, per cell type, the grid size, kernel sigma,
iso level and triangle count — and any type that was skipped and why.

The shell shader shows **only the fresnel rim**: `SURFACE_INTERIOR` (0.10) keeps
the body almost invisible while `SURFACE_GLOW_STRENGTH` (1.3) and
`SURFACE_FRESNEL_POWER` (2.2) make the silhouette glow, so a cluster reads as a
translucent membrane instead of a solid plastic shell.

## 7b. Visual presets (dropdown in the control panel)

| preset | POINT_SIZE | POINT_OPACITY | BLOOM_STRENGTH | BLOOM_RADIUS | BLOOM_THRESHOLD | SURFACE_OPACITY | SURFACE_FRESNEL_POWER | SURFACE_GLOW_STRENGTH | COLOR_SATURATION | BACKGROUND_COLOR |
|---|---|---|---|---|---|---|---|---|---|---|
| Subtle | 2.0 | 0.70 | 0.30 | 0.50 | 0.42 | 0.07 | 2.8 | 1.0 | 0.80 | `#080C17` |
| **Balanced** (default) | 2.6 | 0.85 | 0.55 | 0.55 | 0.30 | 0.13 | 2.2 | 1.3 | 0.86 | `#090D19` |
| Strong | 3.3 | 0.95 | 0.85 | 0.65 | 0.20 | 0.20 | 1.8 | 1.8 | 0.92 | `#0A0E1C` |
| Reference-like | 2.9 | 0.90 | 0.62 | 0.60 | 0.26 | 0.17 | 2.0 | 1.7 | 0.84 | `#090D1B` |

Presets can also be selected from the URL, which is what the automated captures
use: `index.html?preset=strong&figure=1&labels=0`.

Cell colours keep their hue assignment; `COLOR_SATURATION` only mutes them, and
`SMALL_CLUSTER_BOOST` (1.18× below 2 000 cells) keeps the sparse types from
disappearing under bloom.

## 7c. Presentation controls

* **Figure Mode** (floating button, top right): hides the control panel, the
  status bar and the mouse hint, turns the labels off, **keeps the legend** and
  leaves the camera exactly where it is. It also keeps the current **Background**
  mode and **Label size** — entering or leaving Figure Mode never resets them.
  Press again to exit.
* **Hide legend / Show legend**: hides the legend and lets the viewport use the
  full width (works with or without Figure Mode).
* **Reset view**: returns the camera to the initial framing.
* **Export 2× / 4× PNG**: as described in §8.

Labels are **off by default** (`SHOW_LABELS: false`) and the density surfaces are
**on by default but faint** (`SURFACE_OPACITY: 0.13`).

## 7d. Label size

`Label size` slider (8 – 32 px, step 1 px, default **11.5 px**, which is exactly
the CSS value used before the slider existed). It only changes the font size —
and the padding/dot scale that follows from it. Label anchors, cluster centres
and the UMAP coordinates are never touched, and the legend keeps its own font
size.

* Live: the slider in the control panel.
* From the URL: `index.html?labelfont=20`.
* The PNG export uses the **current** value (2× / 4× as well), so what you pick
  on screen is what lands in the file.

## 7e. Background modes

`Background` dropdown: **Dark** (default, the original look), **Black**, **White**.
The switch is instant and never reloads the page.

| mode | colour | Brightness slider |
|---|---|---|
| Dark | the original `BACKGROUND_COLOR × BACKGROUND_BRIGHTNESS` | enabled |
| Black | strictly `#000000` | disabled |
| White | strictly `#FFFFFF` | disabled |

### White mode = "translucent coloured ink" (its own renderer path)

Dark and Black are untouched: additive blending, the original point/surface
shaders, UnrealBloom and the tone mapping stay exactly as they were (verified by a
pixel regression — see below). White uses a **separate material and its own
shaders**, because a white page is a different medium: there is no dark space for
light to glow into, and additive blending would push every cluster towards white.

| | Dark / Black | White |
|---|---|---|
| background | rendered by WebGL (colour × brightness) | drawn by the page/PNG under a transparent canvas, so `#000000` / `#FFFFFF` stay exact |
| point shader | original (`exp(-2.6 d²)` body + centre highlight) | white ink shader: **no centre highlight**, colour = CellMajortype hue at `WHITE_POINT_LIGHTNESS`, optional same-hue halo |
| blending | additive (light) | normal alpha (ink) |
| density | brighter when dense | **deeper/more saturated when dense** (`WHITE_DENSITY_ALPHA`) |
| blur/glow | UnrealBloomPass (user slider) | bloom is set to 0 (a white page has no room for a white glow); the user's slider value is remembered and restored |
| surfaces | additive, whitened rim | thin contour in the cluster's own darkened colour, interior ≈ 0 |

The white "ink" colour is computed in **sRGB** HSL space
(`hue` unchanged, `saturation × WHITE_POINT_SATURATION`, `lightness = WHITE_POINT_LIGHTNESS`),
never by multiplying RGB, so the hues stay identical to the legend:
teal Keratinocytes, blue Fibroblasts, orange Vascular Endothelial, purple Pericytes,
green Myeloids, pink T cells, yellow Mast cells, coral Lymphatic Endothelial.

### Three white candidates (Soft / Balanced / Strong)

The dropdown **White style** (visible only in White mode) switches between three
presets of the white rendering. They differ *only* in ink depth, opacity, halo and
the surface contour — never in the UMAP, camera, point size, cluster position,
hue or label position.

| parameter | White Soft | White Balanced | White Strong |
|---|---|---|---|
| `WHITE_POINT_SATURATION` | 1.10 | 1.15 | 1.22 |
| `WHITE_POINT_LIGHTNESS` | 0.70 | 0.62 | 0.50 |
| `WHITE_POINT_OPACITY_MULTIPLIER` | 1.15 | 1.25 | 1.38 |
| `WHITE_HALO_STRENGTH` | 0.16 | 0.22 | 0.26 |
| `WHITE_SURFACE_OPACITY` | 0.26 | 0.38 | 0.52 |
| `WHITE_SURFACE_RIM_DARKEN` | 0.16 | 0.22 | 0.30 |
| `WHITE_DENSITY_ALPHA` | 0.65 | 0.85 | 1.05 |

The default is **White Balanced** (`WHITE_VARIANT` in `config.js`, or
`?whitevariant=soft|balanced|strong` in the URL). Nothing is decided for you —
all three stay available.

UI contrast in white mode (class `bg-white` on `<body>`): panel/legend/status/hud
switch to light backgrounds with `#111827` text, sliders and buttons get dark
accent colours, and the cluster labels become dark text on a translucent white
pill with a 1 px border in their own CellMajortype colour. The swatches keep the
original palette colours.

## 7f. Color by — Cell type / ECM_AUC / SenCID_score / SenCID_binary / Gene expression

The **Color by** dropdown at the top of the control panel selects what the *points*
are coloured by. It never changes anything else: positions, surfaces, labels,
camera, background, bloom and the export are untouched.

| option | what it colours the points by |
|---|---|
| Cell type | the 8 CellMajortype palette colours (the original behaviour) |
| ECM_AUC | the `ECM_AUC` column, continuous |
| SenCID_score | the `SenCID_score` column, continuous |
| SenCID_binary | the `SenCID_binary` column (0 / 1, two ends of the colormap) |
| Gene expression | any gene you type into the **Gene** box |

### Gene expression

* A **Gene** input and an **Apply** button appear when *Gene expression* is
  selected (the row is hidden in the other modes).
* Type a gene name and press **Enter** or click **Apply** — matching is
  case-insensitive (`BMP1`, `bmp1`, `Bmp1` all resolve to the CSV column `BMP1`).
* The name is looked up in the **CSV header itself** (with an autocomplete list);
  there is no hard-coded whitelist. The only excluded headers are the
  annotations: `cell_id, UMAP3D_1/2/3, CellMajortype, Age_group, ECM_AUC,
  SenCID_score, SenCID_binary`. `COLUMNS_TO_IGNORE` in `config.js` keeps its
  original role for the group-column detection and is *not* used here, so `BMP1`
  is a normal, searchable gene.
* Success shows `Gene expression: BMP1`; a name that is not in the dataset shows
  `Gene "XXX" was not found in the dataset.` and the previous colouring stays.
* **BMP1 and every ECM gene use exactly the same code path** — same read, same
  percentile clip, same colormap, same legend. There is no per-gene range,
  boost, weight or emphasis anywhere in the code.

### How the colours are computed (continuous features)

1. `values[i] = Number(rows[i][field])` for all 68,646 cells; `''`, `null`,
   `undefined`, `NaN` and `Infinity` become `0` and are counted as invalid.
2. The 2nd and 98th percentiles of the valid values are computed once.
3. Values are clipped to `[q02, q98]` and normalised to 0–1.
4. The result samples the **viridis** colormap (`COLORMAP` in `config.js`),
   produced through `THREE.Color` so the value written into `aColor` is in the
   same colour space as before.
5. Only `aColor` is written (`aColor.needsUpdate = true`). Positions, sizes,
   alpha and the geometry are never touched.

Cells with expression 0 — usually the majority in single-cell data — are **kept**,
drawn with the low end of the colormap. Nothing is filtered, hidden, moved or
resized. On the white background the colormap is darkened by one global rule
(`COLORMAP_WHITE_*`) so it stays visible as ink; the rule is identical for every
gene.

### Cache

Each column is read once and cached in `state.featureCache`
(`{ values, min, max, q02, q98, invalidCount, zeroCount }`), so switching
`BMP1 → COL1A1 → FN1 → BMP1` re-uses the first BMP1 computation. The 292-column
CSV is never duplicated.

### Legend / colour bar

* **Cell type** keeps the original CellMajortype legend.
* The three feature modes and Gene expression replace the title with the feature
  name (`BMP1 expression`, `COL1A1 expression`, `ECM_AUC`, …) and show a
  **colour bar** with the clipped range (`q02 … q98`) and the number of
  zero-expression cells.
* The CellMajortype list stays below, under the subtitle
  *“CellMajortype (labels & surfaces)”*, so it is clear that it refers to the
  labels and the shells — not to the expression colour scale.

### Decoupled from everything else

Point colour is completely independent of the **surfaces** (still coloured by
CellMajortype), the **cluster labels** (dot + border still CellMajortype), the
legend swatches, the density-surface geometry, the label anchors and the camera.
`refreshPointColors()` dispatches on `state.colorBy`, so switching background
(Dark/Black/White), white style, preset or Figure Mode re-applies the *current*
colour-by mode instead of silently falling back to Cell type.

## 8. Export a PNG

**Export PNG 2×** / **Export PNG 4×**. The export
* keeps the current camera angle, colours, parameters and visibility,
* hides the control panel and legend,
* writes a PNG at 2× or 4× the window resolution,
* optionally burns the cluster labels into the image (checkbox *Include labels in PNG*),
* restores the window state when it is done.

Option *Transparent PNG (bloom off)*: a transparent background cannot carry the
bloom halos, so bloom is disabled for that render (the checkbox is off by default;
the dark background is the recommended export).

The export always keeps the current camera, zoom, point size/opacity, bloom,
surface opacity, surface/label visibility, **label size** and **background
mode**; the Black/White backgrounds are painted into the bitmap itself, so a
white export is exactly `#FFFFFF` and a black export exactly `#000000` (verified
by sampling the four corners of the produced PNG).

Very large exports are protected against the renderer's framebuffer limits: the
script asks the GL driver for its limits, caps software rasterisers (SwiftShader /
llvmpipe, used when a browser falls back to CPU rendering) at
`EXPORT_MAX_MP_SOFTWARE` = 6 megapixels, and — should a frame still come back
empty — halves the scale until real content appears. The effective scale is
written to the log and into `window.__APP_LAST_EXPORT`. On a real GPU the full
4× is produced (`EXPORT_MAX_MP_HARDWARE` = 64 MP).

## 9. What each JS file does

| file | responsibility |
|---|---|
| `config.js` | every tunable parameter + the 12-colour palette. Nothing else defines visual constants. |
| `data.js` | CSV splitter (quote-safe), automatic column detection (`UMAP3D_1/2/3`, `CellMajortype`), typed arrays for positions/type index, robust per-type label anchors, per-point density estimate. No Three.js dependency → unit-testable in Node. |
| `shaders.js` | GLSL for the point cloud (size attenuation, density boost, focus dimming, radial-Gaussian sprite) and for the density shells (fresnel rim glow). |
| `surface.js` | per-type Gaussian density field on a regular grid, iso level from the median density at the cells, marching-**tetrahedra** isosurface, gradient normals. Pure JS. |
| `main.js` | renderer/scene/camera/OrbitControls, `Points` + `ShaderMaterial`, `EffectComposer`+`RenderPass`+`UnrealBloomPass`+`OutputPass`, progressive surface building, DOM labels, legend with click-to-highlight, control panel, PNG export, resize handling. |

---

## Implementation notes

**One draw call.** All 68,646 cells live in a single `THREE.BufferGeometry`
(`position`, `aType`, `aColor`, `aDensity`) rendered as one `THREE.Points`.
No per-cell meshes are created.

**Soft sprites.** `gl_PointCoord` drives a Gaussian falloff
(`exp(-3.4·d²)` plus a small core highlight) with `discard` beyond the sprite
radius, so each cell is a soft round dot with a fully transparent rim instead of
a hard square. Additive blending makes overlapping cells brighter — dense areas
glow naturally without inflating the cluster boundary, because the alpha of every
single cell still falls to zero at its edge.

**Bloom.** `UnrealBloomPass` sits between `RenderPass` and `OutputPass`
(ACES tone mapping + sRGB output). The threshold is the main control that keeps
the cluster edges readable.

**Density surfaces.** For every CellMajortype: a regular grid is built over that
type's own bounding box (default 40³), each cell is splatted with a truncated
Gaussian kernel (`SURFACE_BANDWIDTH`, auto-clamped to 4.5–30 % of the cluster
extent), the iso level is `SURFACE_ISO_FRACTION × median(density at the cells)` so
it adapts to each cluster's density, and the shell is extracted with **marching
tetrahedra** (6 tetrahedra per voxel — watertight, no 256-case table). Normals come
from the density gradient. The material is additive with a fresnel rim term, so
only the silhouette glows: the outline is visible while the cells inside stay
fully visible. Types with fewer than `SURFACE_MIN_CELLS` (250) cells, a degenerate
extent, or an unreachable iso level are skipped and the reason is written to the
log. No cell is ever moved or removed to build a surface.

**Labels.** The anchor is the coordinate-wise **median** of the type, snapped to
the nearest real cell of that type (a robust medoid-like point — a plain mean
would drift towards outliers). Labels are DOM elements projected from 3D every
frame, so they always face the camera and never occlude the cloud with a big box.

**Highlighting.** Clicking a legend entry sets `uFocus` to that type; all other
types fade to `DIMMED_OPACITY` (0.10) in the shader — no cell is ever removed.
Clicking again resets.

---

## Verification performed

| check | result |
|---|---|
| `node tools/test_data.mjs` | 68,646 rows parsed, 0 skipped, 8/8 type counts match the R reference, all points inside the bounding box, ~110 ms |
| `node tools/test_surface.mjs` | isosurface built for all 8 types (43,840 triangles, ~0.6 s), all vertices finite and inside the type's bounding box |
| `node tools/check_imports.mjs` | 30 import specifiers, 0 unresolved (import map + vendored Three.js r160) |
| `node --check` on every JS file | no syntax errors |
| HTTP server | all assets served: index.html 200, js/main.js 200, three.module.js 200 (1.27 MB), css 200, CSV 200 (8.6 MB) |
| `http://localhost:8000/tools/smoke.html` in headless Chrome | **SMOKE-OK** — legend rows 8/8, cluster labels 8, 1 WebGL canvas, loading overlay hidden, status `68,646 cells · 8 cell types · 8 surfaces`, **0 console errors/warnings**, all 8 density surfaces built |
| screenshot pixel audit (1400×900) | background #0A1118, 33.5 % lit pixels in the viewport, 6 hue families of the palette visible, legend panel with 8 swatches in palette order |
| `node tools/capture_previews.mjs` (Chrome DevTools Protocol) | four previews at 3200×2000 in `previews/`, one per preset; state at capture time: `cells 68646, types 8, surfaces 8, labelsVisible false, figureMode true` |
| `node tools/capture_white_modes.mjs` | `previews/white_soft.png`, `white_balanced.png`, `white_strong.png`, `dark_reference.png` — identical camera, POINT_SIZE 2.5, label size 23 px, surfaces + labels ON, Balanced preset; measures per-cluster ink coverage on the rendered pixels (`previews/white-mode-measurements.json`) |
| dark-mode pixel regression | current Dark render vs the image captured before the white-mode work: **max difference 0.0000 (byte-identical)** |
| black-mode pixel regression | identical apart from the transient mouse-hint line (rows 1847-1909), which is a timed DOM overlay |

### Re-generating the previews

```bash
cd ~/Desktop/aging/3D_UMAP
python3 -m http.server 8000 &            # the page has to be served over HTTP
node tools/capture_previews.mjs --url=http://127.0.0.1:8000 --scale=2
```

The script drives headless Chrome over the DevTools Protocol and waits for
`window.__APP_READY && window.__APP_SURFACES_READY` before taking each screenshot,
so a capture can never happen before the CSV, the point cloud and all density
shells are on screen (the plain `chrome --screenshot` flag fires too early).

`tools/smoke.html` is a self-check page: it loads the *real* `js/main.js` into the
same DOM skeleton, records every `console.error` / `console.warn` / uncaught
exception together with the legend/label/surface counts and writes the result
into the page. Open it in a normal browser to re-verify after your own edits.

The browser console is free of errors and warnings in Chrome and Safari: the code
uses only r160 APIs (`outputColorSpace`, `SRGBColorSpace`, `OutputPass`), no
deprecated `outputEncoding`/`sRGBEncoding`.

Three.js is **bundled locally** in `js/vendor/three` (r160, taken from the npm
package), and `index.html` maps `three` + `three/addons/` to those files, so the
viewer runs without any CDN access. If you ever prefer a CDN, replace the two
entries of the import map with
`https://unpkg.com/three@0.160.0/build/three.module.js` and
`https://unpkg.com/three@0.160.0/examples/jsm/` — keep both on the same version.

---

## Current limitations

1. **Labels are DOM overlays.** They follow the 3D scene and always face the
   camera, but they are not depth-occluded by the point cloud (a label whose
   cluster is behind another cluster is still drawn). For the PNG export they are
   re-drawn into the raster so the exported image matches the screen.
2. **Transparent-background export disables bloom** (see §8). Compositing a bloom
   halo onto an alpha channel is not well defined.
3. **Surfaces are an approximation.** They are built from a Gaussian density
   estimate at `SURFACE_GRID`³ resolution, so very thin filaments or concave
   "holes" smaller than ~2 voxels may be smoothed away. They are an outline aid,
   not a statistical boundary, and they never influence point positions.
4. **Cell types that are too small or too diffuse are skipped** (logged). With
   this dataset all 8 types qualify.
5. **The 3D UMAP coordinates are taken as given** — no re-embedding, no
   normalisation, no jitter. If the embedding itself needs re-computation, that
   has to happen in R before export.
6. **WebGL2 is required** (Chrome/Safari on macOS are fine; very old browsers or
   software rendering may be slow). 68,646 additive points with bloom run at
   interactive frame rates on Apple-silicon integrated GPUs, but the 4× export can
   take a second or two.
7. The surface meshes are non-indexed (de-duplicated vertices are not merged);
   this costs a little memory but removes a whole class of indexing bugs.
