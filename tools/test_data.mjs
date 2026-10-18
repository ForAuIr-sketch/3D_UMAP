/* Node test for the data layer: verifies column detection, parsing and the
 * per-type counts against the values measured independently in R.
 *   node tools/test_data.mjs ["/path/to/umap3d_multifeature.csv"]
 */
import { readFileSync } from 'node:fs';
import { parseUMAPCsv, computeLabelAnchors, computePointDensity } from '../js/data.js';
import { CONFIG } from '../js/config.js';

const path = process.argv[2] ?? '/Users/biefan/Desktop/aging/3D_UMAP/data/umap3d_multifeature.csv';
const text = readFileSync(path, 'utf8');
console.log('file           :', path);
console.log('bytes          :', text.length);

const t0 = Date.now();
const p = parseUMAPCsv(text, CONFIG);
const t1 = Date.now();

console.log('headers        :', p.headers.join(' | '));
console.log('detected cols  : x=%s(%d) y=%s(%d) z=%s(%d) group=%s(%d)',
  p.columnNames.x, p.columns.x, p.columnNames.y, p.columns.y,
  p.columnNames.z, p.columns.z, p.columnNames.group, p.columns.group);
console.log('cells          :', p.n, '| skipped rows:', p.skipped);
console.log('parse time     :', (t1 - t0), 'ms');
console.log('bounds min     :', p.bounds.min.map((v) => v.toFixed(3)).join(', '));
console.log('bounds max     :', p.bounds.max.map((v) => v.toFixed(3)).join(', '));
console.log('center         :', p.bounds.center.map((v) => v.toFixed(3)).join(', '));
console.log('radius         :', p.bounds.radius.toFixed(3));
console.log('cell types     :', p.types.length);
p.types.forEach((t, i) => console.log('   %s  %d', t.padEnd(28), p.counts[i]));

// --- expected values (measured independently with R) ---
const expected = {
  n: 68646,
  'Keratinocytes': 31892,
  'Fibroblasts': 16391,
  'Vascular Endothelial cells': 7181,
  'Pericytes': 4308,
  'Myeloids': 3968,
  'T cells': 2481,
  'Mast cells': 1247,
  'Lymphatic Endothelial cells': 1178
};
let ok = p.n === expected.n;
console.log('\ncheck total cells =', expected.n, ok ? 'OK' : `FAIL (${p.n})`);
for (let i = 0; i < p.types.length; i++) {
  const e = expected[p.types[i]];
  const good = e === p.counts[i];
  if (!good) ok = false;
  console.log('check %s = %s', p.types[i].padEnd(28), good ? 'OK' : `FAIL (${p.counts[i]})`);
}
// every point must stay inside the measured bounding box (no jitter / no move)
let inside = true;
for (let i = 0; i < p.n; i++) {
  for (let k = 0; k < 3; k++) {
    const v = p.positions[i * 3 + k];
    if (v < p.bounds.min[k] - 1e-6 || v > p.bounds.max[k] + 1e-6) inside = false;
  }
}
console.log('check all points inside bbox:', inside ? 'OK' : 'FAIL');

const anchors = computeLabelAnchors(p);
console.log('\nlabel anchors (median snapped to a real cell):');
anchors.forEach((a, i) => console.log('   %s  [%s]', p.types[i].padEnd(28),
  a ? a.map((v) => v.toFixed(2)).join(', ') : 'none'));

const t2 = Date.now();
const dens = computePointDensity(p, CONFIG.DENSITY_GRID);
console.log('\ndensity estimate:', (Date.now() - t2), 'ms | range',
  Math.min(...dens.slice(0, 2000)).toFixed(3), '-', Math.max(...dens).toFixed(3));

console.log('\nRESULT:', ok && inside ? 'ALL DATA CHECKS PASSED' : 'CHECKS FAILED');
process.exit(ok && inside ? 0 : 1);
