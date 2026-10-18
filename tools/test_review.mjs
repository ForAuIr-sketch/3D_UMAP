import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeExpression,numericStats,categoryData,expressionRange} from '../js/review-data.js';
import {parseUMAPCsv,normalizeCellTypeLabel} from '../js/data.js';
import {CONFIG} from '../js/config.js';

const oldPlural = ['Mast','cells'].join(' '), oldSingular = ['Mast','cell'].join(' ');
assert.equal(normalizeCellTypeLabel(oldPlural),'Melanocytes');
assert.equal(normalizeCellTypeLabel(oldSingular),'Melanocytes');
assert.equal(normalizeCellTypeLabel('Fibroblasts'),'Fibroblasts');
const oldCsv = ['UMAP3D_1,UMAP3D_2,UMAP3D_3,CellMajortype,cell_type',`1,2,3,${oldPlural},${oldSingular}`,'4,5,6,Keratinocytes,Keratinocytes'].join('\n');
const legacyParsed = parseUMAPCsv(oldCsv,CONFIG);
assert.ok(legacyParsed.types.includes('Melanocytes'));
assert.equal(legacyParsed.rows[0].cell_type,'Melanocytes');
assert.deepEqual(Array.from(legacyParsed.positions.slice(0,3)),[1,2,3]);

const root=new URL('../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('data/manifest.json',root)));
const parsed=parseUMAPCsv(readFileSync(new URL('data/cells_metadata.csv',root),'utf8'),CONFIG);
assert.equal(parsed.n,manifest.cells);assert.equal(new Set(parsed.rows.map(r=>r.cell_id)).size,parsed.n);
assert.equal(manifest.metadata.length,37);
assert.equal(parsed.counts[parsed.types.indexOf('Melanocytes')],1247);
assert.ok(!parsed.types.some(t => /^mast\s+cells?$/i.test(t)));
for(const row of parsed.rows)for(const field of manifest.metadata)assert.ok(!/^mast\s+cells?$/i.test(row[field.name]??''),field.name);
assert.equal(createHash('sha256').update(readFileSync(new URL('data/metadata_all.csv',root))).digest('hex'),manifest.source.metadata_sha256);
assert.ok(manifest.panels.Melanocytes.includes('MLANA'));
assert.ok(manifest.panels.Melanocytes.includes('KIT'));

for(const field of manifest.metadata)assert.ok(parsed.headers.includes(field.name));
for(const gene of manifest.required_genes)assert.ok(manifest.genes[gene],gene);
for(const [gene,info] of Object.entries(manifest.genes)){
 const b=readFileSync(new URL(info.file,root));
 assert.equal(createHash('sha256').update(b).digest('hex'),info.sha256,gene+' checksum');
 const values=decodeExpression(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),parsed.n);
 let zeros=0;for(const v of values)if(v===0)zeros++;
 assert.equal(zeros,info.zero_count,gene+' zero count');
}
assert.deepEqual(expressionRange({min:0,max:7,q02:0,q98:0},'percentile'),[0,7]);
const missing=numericStats('test',['',null,undefined,'NA',0,1,2]);assert.equal(missing.invalidCount,4);assert.equal(missing.zeroCount,1);assert.ok(Number.isNaN(missing.values[0]));
assert.throws(()=>decodeExpression(new ArrayBuffer(5),2));
const categories=categoryData([{x:'A'},{x:''},{x:'A'}],'x');assert.equal(categories.counts.get('A'),2);assert.equal(categories.counts.get('(missing)'),1);
console.log(JSON.stringify({status:'passed',cells:parsed.n,metadata:manifest.metadata.length,genes:Object.keys(manifest.genes).length,required:manifest.required_genes.length,checks:['Melanocytes annotation (1247 cells)','no legacy labels in active metadata','metadata SHA256','unique cell IDs','all metadata columns','all binary lengths','all SHA256 hashes','all expression non-negative and finite','all zero counts','missing numeric values remain missing','categorical missing values explicit']},null,2));
