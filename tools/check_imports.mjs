/* Static import check: every ES-module import must resolve to a real file,
 * using the import map declared in index.html (no browser needed).
 *   node tools/check_imports.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!mapMatch) { console.error('no import map found in index.html'); process.exit(1); }
const importMap = JSON.parse(mapMatch[1]).imports;
console.log('import map:', importMap);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return resolve(dirname(fromFile), spec);
  }
  for (const [key, target] of Object.entries(importMap)) {
    if (spec === key) return resolve(root, target);
    if (key.endsWith('/') && spec.startsWith(key)) {
      return resolve(root, target + spec.slice(key.length));
    }
  }
  return null;   // e.g. a bare built-in module
}

const files = walk(join(root, 'js'));
let problems = 0, checked = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const specs = [...src.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const spec of specs) {
    const target = resolveSpecifier(spec, file);
    checked++;
    if (!target) { console.log('  ?  %s -> %s (unresolved)', relative(root, file), spec); problems++; continue; }
    const ok = existsSync(target);
    if (!ok) problems++;
    console.log('  %s %s -> %s', ok ? 'OK ' : 'MISSING', relative(root, file), spec);
  }
}
console.log(`\n${checked} import specifiers checked, ${problems} unresolved`);
console.log('RESULT:', problems === 0 ? 'ALL IMPORTS RESOLVE' : 'BROKEN IMPORTS');
process.exit(problems === 0 ? 0 : 1);
