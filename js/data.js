/* ==========================================================================
 * data.js — CSV parsing + column detection + per-type statistics.
 *
 * This module has NO Three.js dependency on purpose: it can be unit-tested in
 * Node (see tools/test_data.mjs) so the data path is verified without a browser.
 *
 * The original CSV is only read, never written.
 * Only the three UMAP coordinates and the CellMajortype column are used.
 * ========================================================================== */

/** Split one CSV line into fields, honouring double quotes. */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Keep the requested annotation consistent when loading older CSV versions. */
export function normalizeCellTypeLabel(value) {
  const text = String(value ?? '');
  return /^mast\s+cells?$/i.test(text.trim()) ? 'Melanocytes' : text;
}

/** Normalise a header name for fuzzy matching. */
function norm(s) {
  return String(s).trim().toLowerCase().replace(/[\s._-]+/g, '');
}

/**
 * Find the column that matches any candidate name (exact first, then fuzzy).
 * Returns -1 when nothing matches.
 */
export function findColumn(headers, candidates) {
  const normHeaders = headers.map(norm);
  for (const cand of candidates) {
    const c = norm(cand);
    const i = normHeaders.indexOf(c);
    if (i !== -1) return i;
  }
  for (const cand of candidates) {
    const c = norm(cand);
    const i = normHeaders.findIndex((h) => h.includes(c) || c.includes(h));
    if (i !== -1 && normHeaders[i].length > 0) return i;
  }
  return -1;
}

/**
 * Parse the UMAP CSV.
 * @param {string} text raw file content
 * @param {object} cfg  CONFIG (COLUMN_CANDIDATES / COLUMNS_TO_IGNORE)
 * @returns {{
 *   headers:string[],
 *   columns:{x:number,y:number,z:number,group:number},
 *   columnNames:{x:string,y:string,z:string,group:string},
 *   types:string[],
 *   counts:number[],
 *   positions:Float32Array,
 *   typeIndex:Uint16Array,
 *   groups:string[],
 *   rows:Object[],
 *   n:number,
 *   skipped:number,
 *   bounds:{min:number[],max:number[],center:number[],radius:number}
 * }}
 */
export function parseUMAPCsv(text, cfg) {
  const lines = text.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  if (first >= lines.length) throw new Error('CSV is empty');

  const headers = splitCsvLine(lines[first]).map((h) => h.trim().replace(/^"|"$/g, ''));
  const ignore = (cfg?.COLUMNS_TO_IGNORE ?? []).map(norm);

  const cand = cfg?.COLUMN_CANDIDATES ?? {};
  let ix = findColumn(headers, cand.x ?? ['UMAP3D_1', 'UMAP_1']);
  let iy = findColumn(headers, cand.y ?? ['UMAP3D_2', 'UMAP_2']);
  let iz = findColumn(headers, cand.z ?? ['UMAP3D_3', 'UMAP_3']);
  let ig = findColumn(headers, cand.group ?? ['CellMajortype']);

  // Fallback: if a column is missing, use the first three numeric-looking
  // columns that are not explicitly ignored.
  if (ix === -1 || iy === -1 || iz === -1) {
    const numeric = [];
    const probe = lines[first + 1] ? splitCsvLine(lines[first + 1]) : [];
    for (let c = 0; c < headers.length; c++) {
      if (ignore.includes(norm(headers[c]))) continue;
      if (probe[c] !== undefined && probe[c] !== '' && Number.isFinite(Number(probe[c]))) numeric.push(c);
    }
    if (ix === -1) ix = numeric[0];
    if (iy === -1) iy = numeric[1];
    if (iz === -1) iz = numeric[2];
  }
  if (ig === -1) {
    // last non-numeric column is the safest guess for a label column
    for (let c = headers.length - 1; c >= 0; c--) {
      if (c === ix || c === iy || c === iz) continue;
      if (ignore.includes(norm(headers[c]))) continue;
      ig = c; break;
    }
  }
  if (ix < 0 || iy < 0 || iz < 0 || ig < 0) {
    throw new Error('Could not identify UMAP coordinate / grouping columns. Headers: ' + headers.join(', '));
  }

  const xs = [], ys = [], zs = [], groups = [];
  const rows = [];
  let skipped = 0;
  for (let l = first + 1; l < lines.length; l++) {
    const raw = lines[l];
    if (!raw || raw.trim() === '') continue;
    const f = splitCsvLine(raw).map(normalizeCellTypeLabel);
    const x = Number(f[ix]), y = Number(f[iy]), z = Number(f[iz]);
 const g = f[ig];

if (
  !Number.isFinite(x) ||
  !Number.isFinite(y) ||
  !Number.isFinite(z) ||
  g === undefined ||
  g === ''
) {
  skipped++;
  continue;
}

xs.push(x);
ys.push(y);
zs.push(z);
groups.push(String(g).trim());

// 保留该 cell 的全部 CSV 字段。
// 后续 ECM_AUC、SenCID_score、BMP1 和 ECM genes
// 都从这里读取，不改变原始 UMAP 坐标。
const row = {};
for (let c = 0; c < headers.length; c++) {
  row[headers[c]] = f[c] ?? '';
}
rows.push(row);
  }

  const n = xs.length;
  if (n === 0) throw new Error('No usable rows found in the CSV');

  // type order = descending cell count (stable colour assignment)
  const countMap = new Map();
  for (const g of groups) countMap.set(g, (countMap.get(g) ?? 0) + 1);
  const types = [...countMap.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const counts = types.map((t) => countMap.get(t));
  const typeIndexOf = new Map(types.map((t, i) => [t, i]));

  const positions = new Float32Array(n * 3);
  const typeIndex = new Uint16Array(n);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], z = zs[i];
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    typeIndex[i] = typeIndexOf.get(groups[i]);
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  const center = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  let radius = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - center[0];
    const dy = positions[i * 3 + 1] - center[1];
    const dz = positions[i * 3 + 2] - center[2];
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r > radius) radius = r;
  }

return {
  headers,

  columns: {
    x: ix,
    y: iy,
    z: iz,
    group: ig
  },

  columnNames: {
    x: headers[ix],
    y: headers[iy],
    z: headers[iz],
    group: headers[ig]
  },

  types,
  counts,
  positions,
  typeIndex,
  groups,

  // 新增：
  // 与 positions / typeIndex 完全相同的 cell 顺序
  rows,

  n,
  skipped,

  bounds: {
    min,
    max,
    center,
    radius
  }
};
}

/**
 * Robust label anchor per cell type: coordinate-wise median, then snapped to
 * the closest real cell of that type (so the label always sits inside the
 * cloud). No cell is moved; this only picks a position for the text.
 */
export function computeLabelAnchors(parsed) {
  const { positions, typeIndex, types, n } = parsed;
  const out = [];
  for (let t = 0; t < types.length; t++) {
    const idx = [];
    for (let i = 0; i < n; i++) if (typeIndex[i] === t) idx.push(i);
    if (!idx.length) { out.push(null); continue; }
    const med = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const vals = idx.map((i) => positions[i * 3 + k]).sort((a, b) => a - b);
      med[k] = vals[Math.floor(vals.length / 2)];
    }
    let best = idx[0], bestD = Infinity;
    for (const i of idx) {
      const dx = positions[i * 3] - med[0];
      const dy = positions[i * 3 + 1] - med[1];
      const dz = positions[i * 3 + 2] - med[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    out.push([positions[best * 3], positions[best * 3 + 1], positions[best * 3 + 2]]);
  }
  return out;
}

/**
 * Per-point local density (points inside the 3x3x3 neighbourhood of a coarse
 * grid). Used only to brighten dense regions slightly — coordinates of the
 * cells themselves are never changed.
 */
export function computePointDensity(parsed, grid = 64) {
  const { positions, n, bounds } = parsed;
  const size = [0, 1, 2].map((k) => Math.max(1e-6, bounds.max[k] - bounds.min[k]));
  const g = [0, 1, 2].map((k) => Math.max(1, Math.round(grid * (size[k] / Math.max(...size)))));
  const cells = new Uint32Array(g[0] * g[1] * g[2]);
  const cellOf = new Int32Array(n);
  const cellIndex = (a, b, c) => a + g[0] * (b + g[1] * c);
  for (let i = 0; i < n; i++) {
    const a = Math.min(g[0] - 1, Math.floor(((positions[i * 3] - bounds.min[0]) / size[0]) * g[0]));
    const b = Math.min(g[1] - 1, Math.floor(((positions[i * 3 + 1] - bounds.min[1]) / size[1]) * g[1]));
    const c = Math.min(g[2] - 1, Math.floor(((positions[i * 3 + 2] - bounds.min[2]) / size[2]) * g[2]));
    const ci = cellIndex(a, b, c);
    cellOf[i] = ci;
    cells[ci]++;
  }
  const density = new Float32Array(n);
  let maxLocal = 1;
  for (let i = 0; i < n; i++) {
    const ci = cellOf[i];
    const a = ci % g[0];
    const b = Math.floor(ci / g[0]) % g[1];
    const c = Math.floor(ci / (g[0] * g[1]));
    let sum = 0;
    for (let da = -1; da <= 1; da++) {
      const aa = a + da; if (aa < 0 || aa >= g[0]) continue;
      for (let db = -1; db <= 1; db++) {
        const bb = b + db; if (bb < 0 || bb >= g[1]) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc; if (cc < 0 || cc >= g[2]) continue;
          sum += cells[cellIndex(aa, bb, cc)];
        }
      }
    }
    density[i] = sum;
    if (sum > maxLocal) maxLocal = sum;
  }
  for (let i = 0; i < n; i++) density[i] = Math.sqrt(density[i] / maxLocal); // 0..1
  return density;
}
