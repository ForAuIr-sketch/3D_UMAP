/* ==========================================================================
 * surface.js — per-cell-type density field + isosurface ("soft outline").
 *
 * Algorithm (documented in README.md):
 *   1. for one CellMajortype, build a regular 3D grid over its own bounding box
 *   2. splat every cell of that type into the grid with a truncated Gaussian
 *      kernel  ->  a smooth density field that follows the real point cloud
 *   3. choose the iso level from the density sampled at the actual cell
 *      positions (median * SURFACE_ISO_FRACTION) so it adapts per type
 *   4. extract the surface with marching TETRAHEDRA (6 tetrahedra per voxel).
 *      Chosen over marching cubes because it needs no 256-case tables, is
 *      numerically simpler and is guaranteed watertight; the meshes are a
 *      little denser, which does not matter for a translucent shell.
 *   5. normals come from the density gradient -> smooth shading
 *
 * Cell coordinates are only READ. Nothing is moved, added or removed.
 * Types that are too small / too degenerate for a stable surface are skipped
 * and the reason is returned for logging.
 * ========================================================================== */

/**
 * @param {Float32Array} positions  xyz triplets of ALL cells
 * @param {Uint32Array|Int32Array} memberIndices  indices of the cells of one type
 * @param {object} opts {grid, bandwidth, isoFraction, minCells}
 * @returns {{ok:boolean, reason?:string, positions?:Float32Array, normals?:Float32Array,
 *            indices?:Uint32Array, level?:number, stats?:object}}
 */
export function buildDensitySurface(positions, memberIndices, opts) {
  const { grid = 40, bandwidth = 0.42, isoFraction = 0.32, minCells = 250 } = opts ?? {};
  const n = memberIndices.length;
  if (n < minCells) return { ok: false, reason: `only ${n} cells (< SURFACE_MIN_CELLS=${minCells})` };

  /* ---------------------------------------------------------- 1. extents -- */
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = memberIndices[i] * 3;
    for (let k = 0; k < 3; k++) {
      const v = positions[p + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const extent = [0, 1, 2].map((k) => max[k] - min[k]);
  const maxExtent = Math.max(...extent);
  if (!(maxExtent > 1e-6)) return { ok: false, reason: 'degenerate extent (all cells coincide)' };

  // bandwidth: clamp the user value to something sensible for this cluster
  const sigma = Math.min(Math.max(bandwidth, 0.045 * maxExtent), 0.30 * maxExtent);
  const pad = 2.6 * sigma;

  /* ------------------------------------------------------------- 2. grid -- */
  // equal voxel size on every axis, resolution driven by SURFACE_GRID
  const voxel = (maxExtent + 2 * pad) / Math.max(8, grid);
  const dims = [0, 1, 2].map((k) => Math.max(8, Math.min(Math.round((extent[k] + 2 * pad) / voxel), 96)));
  const origin = [0, 1, 2].map((k) => min[k] - pad);
  const total = dims[0] * dims[1] * dims[2];
  const field = new Float32Array(total);
  const idx3 = (a, b, c) => a + dims[0] * (b + dims[1] * c);

  // pre-compute the 1D kernel lookups for speed
  const radiusVox = Math.max(1, Math.ceil(2.5 * sigma / voxel));
  const kernel = new Float32Array(2 * radiusVox + 1);
  let kernelSum = 0;
  for (let d = -radiusVox; d <= radiusVox; d++) {
    const g = Math.exp(-0.5 * (d * voxel / sigma) ** 2);
    kernel[d + radiusVox] = g;
    kernelSum += g;
  }

  for (let i = 0; i < n; i++) {
    const p = memberIndices[i] * 3;
    const cx = (positions[p] - origin[0]) / voxel;
    const cy = (positions[p + 1] - origin[1]) / voxel;
    const cz = (positions[p + 2] - origin[2]) / voxel;
    const bx = Math.round(cx), by = Math.round(cy), bz = Math.round(cz);
    for (let dz = -radiusVox; dz <= radiusVox; dz++) {
      const gz = bz + dz; if (gz < 0 || gz >= dims[2]) continue;
      const wz = kernel[dz + radiusVox];
      for (let dy = -radiusVox; dy <= radiusVox; dy++) {
        const gy = by + dy; if (gy < 0 || gy >= dims[1]) continue;
        const wyz = wz * kernel[dy + radiusVox];
        for (let dx = -radiusVox; dx <= radiusVox; dx++) {
          const gx = bx + dx; if (gx < 0 || gx >= dims[0]) continue;
          field[idx3(gx, gy, gz)] += wyz * kernel[dx + radiusVox];
        }
      }
    }
  }

  /* -------------------------------------------------------- 3. iso level -- */
  const sampleAt = (x, y, z) => {   // trilinear sample of the field
    const fx = (x - origin[0]) / voxel, fy = (y - origin[1]) / voxel, fz = (z - origin[2]) / voxel;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    if (x0 < 0 || y0 < 0 || z0 < 0 || x0 + 1 >= dims[0] || y0 + 1 >= dims[1] || z0 + 1 >= dims[2]) return 0;
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const c000 = field[idx3(x0, y0, z0)], c100 = field[idx3(x0 + 1, y0, z0)];
    const c010 = field[idx3(x0, y0 + 1, z0)], c110 = field[idx3(x0 + 1, y0 + 1, z0)];
    const c001 = field[idx3(x0, y0, z0 + 1)], c101 = field[idx3(x0 + 1, y0, z0 + 1)];
    const c011 = field[idx3(x0, y0 + 1, z0 + 1)], c111 = field[idx3(x0 + 1, y0 + 1, z0 + 1)];
    const c00 = c000 * (1 - tx) + c100 * tx, c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx, c11 = c011 * (1 - tx) + c111 * tx;
    const c0 = c00 * (1 - ty) + c10 * ty, c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  };
  const atCells = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = memberIndices[i] * 3;
    atCells[i] = sampleAt(positions[p], positions[p + 1], positions[p + 2]);
  }
  atCells.sort();
  const medianAtCells = atCells[Math.floor(n / 2)] || 0;
  let maxField = 0;
  for (let i = 0; i < total; i++) if (field[i] > maxField) maxField = field[i];
  const level = Math.max(1e-6, medianAtCells * isoFraction);
  if (level >= maxField) return { ok: false, reason: 'iso level above the field maximum (cluster too diffuse)' };

  /* ------------------------------- 4. marching tetrahedra ----------------- */
  const outPos = [];
  const outNrm = [];
  const corner = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
  ];
  const tets = [
    [0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
    [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]
  ];
  const val = new Float32Array(8);
  const pos = new Array(8);
  const grad = (x, y, z) => {
    const h = voxel;
    return [
      sampleAt(x + h, y, z) - sampleAt(x - h, y, z),
      sampleAt(x, y + h, z) - sampleAt(x, y - h, z),
      sampleAt(x, y, z + h) - sampleAt(x, y, z - h)
    ];
  };
  const pushVertex = (px, py, pz) => {
    outPos.push(px, py, pz);
    const g = grad(px, py, pz);
    const len = Math.hypot(g[0], g[1], g[2]) || 1;
    outNrm.push(-g[0] / len, -g[1] / len, -g[2] / len);   // gradient points to lower density
  };
  const interp = (i, j) => {
    const t = (level - val[i]) / (val[j] - val[i] || 1e-9);
    return [
      pos[i][0] + t * (pos[j][0] - pos[i][0]),
      pos[i][1] + t * (pos[j][1] - pos[i][1]),
      pos[i][2] + t * (pos[j][2] - pos[i][2])
    ];
  };

  for (let z = 0; z < dims[2] - 1; z++) {
    for (let y = 0; y < dims[1] - 1; y++) {
      for (let x = 0; x < dims[0] - 1; x++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const gx = x + corner[c][0], gy = y + corner[c][1], gz = z + corner[c][2];
          val[c] = field[idx3(gx, gy, gz)];
          pos[c] = [origin[0] + gx * voxel, origin[1] + gy * voxel, origin[2] + gz * voxel];
          if (val[c] >= level) inside++;
        }
        if (inside === 0 || inside === 8) continue;   // fully outside / inside this voxel

        for (const tet of tets) {
          const v = [val[tet[0]], val[tet[1]], val[tet[2]], val[tet[3]]];
          const pin = [v[0] >= level, v[1] >= level, v[2] >= level, v[3] >= level];
          const count = pin.filter(Boolean).length;
          if (count === 0 || count === 4) continue;
          const P = (k) => pos[tet[k]];
          if (count === 1) {
            const i = pin.indexOf(true);
            const a = interp(tet[i], tet[(i + 1) % 4]);
            const b = interp(tet[i], tet[(i + 2) % 4]);
            const c = interp(tet[i], tet[(i + 3) % 4]);
            pushVertex(...a); pushVertex(...b); pushVertex(...c);
          } else if (count === 3) {
            const i = pin.indexOf(false);
            const a = interp(tet[i], tet[(i + 1) % 4]);
            const b = interp(tet[i], tet[(i + 3) % 4]);
            const c = interp(tet[i], tet[(i + 2) % 4]);
            pushVertex(...a); pushVertex(...b); pushVertex(...c);
          } else {
            const ins = [], outs = [];
            for (let k = 0; k < 4; k++) (pin[k] ? ins : outs).push(k);
            const a = interp(tet[ins[0]], tet[outs[0]]);
            const b = interp(tet[ins[0]], tet[outs[1]]);
            const c = interp(tet[ins[1]], tet[outs[1]]);
            const d = interp(tet[ins[1]], tet[outs[0]]);
            pushVertex(...a); pushVertex(...b); pushVertex(...c);
            pushVertex(...a); pushVertex(...c); pushVertex(...d);
          }
        }
      }
    }
  }
  if (outPos.length < 27) return { ok: false, reason: 'no isosurface produced at this level' };

  const indexCount = outPos.length / 3;
  return {
    ok: true,
    positions: new Float32Array(outPos),
    normals: new Float32Array(outNrm),
    indices: null,                       // vertices are already de-indexed (simple + robust)
    level,
    stats: {
      cells: n, grid: dims.join('x'), voxel: +voxel.toFixed(3), sigma: +sigma.toFixed(3),
      level: +level.toFixed(5), maxField: +maxField.toFixed(3),
      vertices: indexCount, triangles: indexCount / 3
    }
  };
}
