/* ==========================================================================
 * config.js — every tunable visual parameter lives here.
 *
 * The values below are the defaults that the "Balanced" preset applies; the UI
 * dropdown can switch between four presets at runtime (see PRESETS at the end).
 * Nothing here affects the data: no coordinate, no cell membership, no
 * CellMajortype, no density-surface algorithm.
 *
 *   POINT_*    the cell sprites
 *   BLOOM_*    the post-processing glow
 *   SURFACE_*  the per-cell-type density shells (visual layer only)
 * ========================================================================== */

export const CONFIG = {
  /* -------------------------------- DATA ---------------------------------
   * The CSV is only read. Column names are detected automatically; the lists
   * below are just the preferred candidates, and COLUMNS_TO_IGNORE guarantees
   * that BMP1 is never touched.
   * ---------------------------------------------------------------------- */
  DATA_PATH: 'data/cells_metadata.csv?v=20261019-melanocytes-r3',
  COLUMN_CANDIDATES: {
    x: ['UMAP3D_1', 'UMAP_1', 'UMAP1', 'umap_1', 'x', 'X'],
    y: ['UMAP3D_2', 'UMAP_2', 'UMAP2', 'umap_2', 'y', 'Y'],
    z: ['UMAP3D_3', 'UMAP_3', 'UMAP3', 'umap_3', 'z', 'Z'],
    group: ['CellMajortype', 'CellMajorType', 'cellmajortype', 'CellType']
  },
  COLUMNS_TO_IGNORE: ['BMP1', 'BMP1_display'],

  /* ------------------------------ POINTS --------------------------------- */
  POINT_SIZE:        2.6,      // sprite size in px at the reference camera distance
  POINT_OPACITY:     0.85,     // global sprite opacity (0-1)

  /* ------------------------------- BLOOM --------------------------------- */
  BLOOM_STRENGTH:    0.55,     // UnrealBloomPass strength (stay below ~0.9)
  BLOOM_RADIUS:      0.55,     // UnrealBloomPass radius
  BLOOM_THRESHOLD:   0.30,     // luminance threshold; higher = only bright cores glow

  /* ----------------------------- BACKGROUND ------------------------------ */
  BACKGROUND_COLOR: '#090D19', // dark blue-black (reference image background)
  BACKGROUND_BRIGHTNESS: 1.0,  // 0.4 - 2.0 multiplier on the background colour
  FOG_ENABLED:           true, // subtle depth cue
  FOG_DENSITY:           0.012,

  /* ------------------------------ SURFACES ------------------------------- */
  SURFACE_SHOW:        true,   // density shells on by default …
  SURFACE_OPACITY:     0.13,   // … but very faint
  SURFACE_INTERIOR:    0.10,   // how much of the shell BODY is visible (keep low)
  SURFACE_FRESNEL_POWER: 2.2,  // higher = thinner, sharper fresnel edge
  SURFACE_GLOW_STRENGTH: 1.3,  // rim brightness relative to the shell body
  SURFACE_GRID:        40,     // density grid resolution per axis (algorithm)
  SURFACE_BANDWIDTH:   0.42,   // Gaussian kernel sigma, auto-clamped per type (algorithm)
  SURFACE_ISO_FRACTION: 0.32,  // iso level = fraction * median density at the cells (algorithm)
  SURFACE_MIN_CELLS:   250,    // skip cell types with fewer cells than this
  SURFACE_UPDATE_CHUNK_MS: 24, // time budget per frame while the shells are built

  /* ----------------------------- COLOR BY --------------------------------
   * 'cellType' | 'ecmAuc' | 'senCidScore' | 'senCidBinary' | 'gene'
   *
   * 'gene' looks the name up in the CSV header itself (no whitelist). Every
   * gene - BMP1 included - goes through exactly the same code path: read the
   * column, percentile-clip, normalise, sample the colormap. There is no
   * per-gene colour range, boost, weight or emphasis anywhere.
   * ---------------------------------------------------------------------- */
  COLOR_BY: 'cellType',
  GENE_FIELD: 'BMP1',            // value pre-filled in the Gene search box
  FEATURE_FIELDS: { ecmAuc: 'ECM_AUC', senCidScore: 'SenCID_score', senCidBinary: 'SenCID_binary' },
  // headers that are annotations, not genes (used by the gene search only;
  // COLUMNS_TO_IGNORE above keeps its original role for group detection)
  GENE_EXCLUDE_FIELDS: ['cell_id', 'UMAP3D_1', 'UMAP3D_2', 'UMAP3D_3', 'CellMajortype',
                        'Age_group', 'ECM_AUC', 'SenCID_score', 'SenCID_binary'],
  OUTLIER_PERCENTILES: [0.02, 0.98],   // clip range for continuous features
  COLORMAP: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],  // viridis
  // the colormap is darkened a little on the white background (global rule,
  // applies to every feature equally, so BMP1 gets no special treatment)
  COLORMAP_WHITE_LIGHTNESS_SCALE: 0.78,
  COLORMAP_WHITE_MAX_LIGHTNESS: 0.62,
  COLORMAP_WHITE_SATURATION_SCALE: 1.10,

  /* -------------------------------- COLOUR ------------------------------- */
  COLOR_SATURATION:    0.86,   // 1.0 = palette as defined, lower = more muted
  SMALL_CLUSTER_BOOST: 1.18,   // brightness compensation so small clusters survive bloom
  SMALL_CLUSTER_MAX:   2000,   // cell count below which that boost applies

  /* ------------------------- WHITE BACKGROUND ONLY -----------------------
   * These are used only when Background = White. Dark and Black never read
   * them, so their look cannot change.
   *   WHITE_POINT_SATURATION        HSL saturation multiplier on the CellMajortype hue
   *   WHITE_POINT_LIGHTNESS         HSL lightness of the "ink" colour (lower = deeper)
   *   WHITE_POINT_OPACITY_MULTIPLIER multiplies POINT_OPACITY for the white sprites
   *   WHITE_HALO_STRENGTH           same-hue soft halo, 0 = no halo
   *   WHITE_SURFACE_OPACITY         opacity of the thin coloured contour
   *   WHITE_SURFACE_RIM_DARKEN      how much the contour colour is darkened (0-1)
   *   WHITE_DENSITY_ALPHA           extra opacity per unit of local density
   * ---------------------------------------------------------------------- */
  WHITE_POINT_SATURATION: 1.15,
  WHITE_POINT_LIGHTNESS:  0.62,
  WHITE_POINT_OPACITY_MULTIPLIER: 1.25,
  WHITE_HALO_STRENGTH:    0.22,
  WHITE_SURFACE_OPACITY:  0.38,
  WHITE_SURFACE_RIM_DARKEN: 0.22,
  WHITE_DENSITY_ALPHA:    0.85,
  WHITE_VARIANT: 'balanced',   // 'soft' | 'balanced' | 'strong'

  /* -------------------------------- LABELS ------------------------------- */
  SHOW_LABELS:  false,         // off by default -> clean figure
  LABEL_MODE:   'medoid',      // robust anchor: median snapped to a real cell
  LABEL_SIZE:   11.5,          // px — same value the stylesheet used before this slider existed
  LABEL_SIZE_RANGE: [8, 32],   // px, step 1

  /* ----------------------------- BACKGROUND ------------------------------
   * 'dark'  : the original look (BACKGROUND_COLOR x BACKGROUND_BRIGHTNESS)
   * 'black' : strictly #000000, brightness slider disabled
   * 'white' : strictly #FFFFFF, brightness slider disabled
   * The black/white backgrounds are composited by the browser (and by the PNG
   * encoder) underneath a transparent WebGL canvas, so the colour stays exact
   * and the bloom pipeline keeps working on the points only.
   * ---------------------------------------------------------------------- */
  BACKGROUND_MODE: 'dark',
  BACKGROUND_BLACK: '#000000',
  BACKGROUND_WHITE: '#FFFFFF',

  /* -------------------------------- CAMERA ------------------------------- */
  CAMERA_FOV:      45,
  CAMERA_PADDING:  1.35,
  AUTO_ROTATE:     false,
  AUTO_ROTATE_SPEED: 0.35,

  /* ------------------------------- FOCUSING ------------------------------ */
  DIMMED_OPACITY:   0.10,      // opacity of the non-selected types after a legend click

  /* --------------------------- DENSITY BRIGHTNESS ------------------------ */
  DENSITY_BOOST:    0.55,      // 0 = off; brightens/enlarges cells in dense regions
  DENSITY_GRID:     64,

  /* -------------------------------- EXPORT ------------------------------- */
  EXPORT_SCALES:    [2, 4],
  // Safety caps for the exported bitmap size. Hardware GPUs handle 4x easily;
  // CPU rasterisers cannot allocate the framebuffers, so they get a lower cap
  // (and the export reports the effective scale instead of failing).
  EXPORT_MAX_MP_HARDWARE: 64,
  EXPORT_MAX_MP_SOFTWARE: 6,
  EXPORT_TRANSPARENT: false,   // transparent PNG is offered but disables bloom

  /* -------------------------------- RENDER ------------------------------- */
  MAX_PIXEL_RATIO:  2.0,
  ANTIALIAS:        true
};

/* ------------------------------- PALETTE ---------------------------------
 * Fixed hue order (assigned to the cell types by descending cell count), so a
 * given CellMajortype always keeps its colour. COLOR_SATURATION is applied on
 * top of these values; the hue assignment itself never changes.
 * ------------------------------------------------------------------------ */
export const PALETTE = [
  '#4FD8C8', // teal
  '#7FB2FF', // blue
  '#FFB35C', // amber
  '#C08CFF', // violet
  '#7CE07C', // green
  '#FF7BAE', // pink
  '#FFE066', // yellow
  '#FF8A65', // coral
  '#9AE6FF', // light cyan
  '#B8C4D9', // grey-blue
  '#E0A6FF', // light violet
  '#8FE3B0'  // mint
];

export function colorForIndex(i) {
  return PALETTE[i % PALETTE.length];
}

/* --------------------------- VISUAL PRESETS -------------------------------
 * Four candidate looks. "balanced" is the default. A preset only writes visual
 * parameters — it never touches the data or the density-surface algorithm.
 *
 *   POINT_SIZE            sprite size in px at the reference distance
 *   POINT_OPACITY         0-1
 *   BLOOM_STRENGTH        0-1.6
 *   BLOOM_RADIUS          0-1.5
 *   BLOOM_THRESHOLD       0-1 (higher = only bright cores glow)
 *   SURFACE_OPACITY       0-0.6 overall shell opacity
 *   SURFACE_FRESNEL_POWER higher = thinner edge rim
 *   SURFACE_GLOW_STRENGTH rim brightness multiplier
 * ------------------------------------------------------------------------ */
export const PRESETS = {
  subtle: {
    label: 'Subtle',
    POINT_SIZE: 2.0, POINT_OPACITY: 0.70,
    BLOOM_STRENGTH: 0.30, BLOOM_RADIUS: 0.50, BLOOM_THRESHOLD: 0.42,
    SURFACE_OPACITY: 0.07, SURFACE_FRESNEL_POWER: 2.8, SURFACE_GLOW_STRENGTH: 1.0,
    COLOR_SATURATION: 0.80, BACKGROUND_COLOR: '#080C17'
  },
  balanced: {
    label: 'Balanced',
    POINT_SIZE: 2.6, POINT_OPACITY: 0.85,
    BLOOM_STRENGTH: 0.55, BLOOM_RADIUS: 0.55, BLOOM_THRESHOLD: 0.30,
    SURFACE_OPACITY: 0.13, SURFACE_FRESNEL_POWER: 2.2, SURFACE_GLOW_STRENGTH: 1.3,
    COLOR_SATURATION: 0.86, BACKGROUND_COLOR: '#090D19'
  },
  strong: {
    label: 'Strong',
    POINT_SIZE: 3.3, POINT_OPACITY: 0.95,
    BLOOM_STRENGTH: 0.85, BLOOM_RADIUS: 0.65, BLOOM_THRESHOLD: 0.20,
    SURFACE_OPACITY: 0.20, SURFACE_FRESNEL_POWER: 1.8, SURFACE_GLOW_STRENGTH: 1.8,
    COLOR_SATURATION: 0.92, BACKGROUND_COLOR: '#0A0E1C'
  },
  'reference-like': {
    label: 'Reference-like',
    POINT_SIZE: 2.9, POINT_OPACITY: 0.90,
    BLOOM_STRENGTH: 0.62, BLOOM_RADIUS: 0.60, BLOOM_THRESHOLD: 0.26,
    SURFACE_OPACITY: 0.17, SURFACE_FRESNEL_POWER: 2.0, SURFACE_GLOW_STRENGTH: 1.7,
    COLOR_SATURATION: 0.84, BACKGROUND_COLOR: '#090D1B'
  }
};

export const DEFAULT_PRESET = 'balanced';

/* ---------------------- WHITE BACKGROUND CANDIDATES ----------------------
 * Three flavours of the white-background rendering. They only change the ink
 * depth, opacity, halo and the surface contour - never the UMAP, the camera,
 * the point size, the cluster positions, the hues or the label positions.
 *   soft     : very light and airy
 *   balanced : light but every cluster is clearly visible
 *   strong   : deeper colours, better for printing
 * ----------------------------------------------------------------------- */
export const WHITE_VARIANTS = {
  soft: {
    label: 'White Soft',
    WHITE_POINT_SATURATION: 1.10,
    WHITE_POINT_LIGHTNESS: 0.70,
    WHITE_POINT_OPACITY_MULTIPLIER: 1.15,
    WHITE_HALO_STRENGTH: 0.16,
    WHITE_SURFACE_OPACITY: 0.26,
    WHITE_SURFACE_RIM_DARKEN: 0.16,
    WHITE_DENSITY_ALPHA: 0.65
  },
  balanced: {
    label: 'White Balanced',
    WHITE_POINT_SATURATION: 1.15,
    WHITE_POINT_LIGHTNESS: 0.62,
    WHITE_POINT_OPACITY_MULTIPLIER: 1.25,
    WHITE_HALO_STRENGTH: 0.22,
    WHITE_SURFACE_OPACITY: 0.38,
    WHITE_SURFACE_RIM_DARKEN: 0.22,
    WHITE_DENSITY_ALPHA: 0.85
  },
  strong: {
    label: 'White Strong',
    WHITE_POINT_SATURATION: 1.22,
    WHITE_POINT_LIGHTNESS: 0.50,
    WHITE_POINT_OPACITY_MULTIPLIER: 1.38,
    WHITE_HALO_STRENGTH: 0.26,
    WHITE_SURFACE_OPACITY: 0.52,
    WHITE_SURFACE_RIM_DARKEN: 0.30,
    WHITE_DENSITY_ALPHA: 1.05
  }
};
