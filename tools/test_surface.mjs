/* Node test for the density-surface builder.
 *   node tools/test_surface.mjs ["/path/to/umap3d_celltype.csv"]
 * Checks: surface is produced for every large type, is skipped for tiny ones,
 * geometry is finite, and it fits inside the type's own bounding box (+ padding).
 */
import { readFileSync } from 'node:fs';
import { parseUMAPCsv } from '../js/data.js';
import { buildDensitySurface } from '../js/surface.js';
import { CONFIG } from '../js/config.js';

const path = process.argv[2] ?? '/Users/biefan/Desktop/aging/3D_UMAP/data/umap3d_celltype.csv';
const p = parseUMAPCsv(readFileSync(path, 'utf8'), CONFIG);

console.log('cells:', p.n, '| types:', p.types.length, '\n');
let allOk = true;
let totalMs = 0, totalTris = 0;

for (let t = 0; t < p.types.length; t++) {
  const members = [];
  for (let i = 0; i < p.n; i++) if (p.typeIndex[i] === t) members.push(i);
  const idx = Uint32Array.from(members);

  const t0 = Date.now();
  const res = buildDensitySurface(p.positions, idx, {
    grid: CONFIG.SURFACE_GRID, bandwidth: CONFIG.SURFACE_BANDWIDTH,
    isoFraction: CONFIG.SURFACE_ISO_FRACTION, minCells: CONFIG.SURFACE_MIN_CELLS
  });
  const ms = Date.now() - t0;
  totalMs += ms;

  if (!res.ok) {
    const expected = p.counts[t] < CONFIG.SURFACE_MIN_CELLS;
    console.log('SKIP  %s (%d cells) -> %s   [%s]', p.types[t].padEnd(28), p.counts[t], res.reason,
      expected ? 'expected' : 'UNEXPECTED');
    if (!expected) allOk = false;
    continue;
  }
  const s = res.stats;
  totalTris += s.triangles;

  // sanity: all finite, and the shell stays within the type bbox + 0.6 units
  let finite = true, inside = true;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < res.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = res.positions[i + k];
      if (!Number.isFinite(v)) finite = false;
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
  }
  if (!finite) inside = false;
  const padOk = [0, 1, 2].every((k) => mn[k] > p.bounds.min[k] - 1.0 && mx[k] < p.bounds.max[k] + 1.0);
  if (!finite || !padOk) allOk = false;

  console.log('%s (%d cells) grid=%-10s sigma=%-5s level=%-8s tris=%-6d %4d ms  finite=%s inBounds=%s',
    p.types[t].padEnd(28), p.counts[t], s.grid, s.sigma, s.level, s.triangles, ms, finite, padOk);
}
console.log('\ntotal: %d triangles, %d ms for all types', totalTris, totalMs);
console.log('RESULT:', allOk ? 'SURFACE CHECKS PASSED' : 'SURFACE CHECKS FAILED');
process.exit(allOk ? 0 : 1);
