/** Data contract for review viewer: aligned cell IDs, explicit gene catalogue,
 * little-endian Float32 expression; missing metadata is not expression zero. */
export function decodeExpression(buffer, cellCount) {
  if (buffer.byteLength !== cellCount * 4) throw new Error('Gene data length does not match cell count');
  const view = new DataView(buffer), values = new Float32Array(cellCount);
  for (let i=0;i<cellCount;i++) {
    values[i]=view.getFloat32(i*4,true);
    if (!Number.isFinite(values[i]) || values[i]<0) throw new Error('Invalid RNA expression');
  }
  return values;
}
export function numericStats(field, input) {
  const values=Float32Array.from(input, v => v === '' || v === null || v === undefined ? NaN : Number(v));
  const valid=Array.from(values).filter(Number.isFinite).sort((a,b)=>a-b);
  const q=p=>valid.length?valid[Math.round(p*(valid.length-1))]:0;
  return {field, values, n:valid.length, min:valid[0]??0, max:valid.at(-1)??0,
    q02:q(.02),q98:q(.98),invalidCount:values.length-valid.length,
    zeroCount:valid.filter(v=>v===0).length};
}
export function categoryData(rows,field) {
  const values=rows.map(row=>row[field] === '' || row[field] === undefined ? '(missing)' : String(row[field]));
  const counts=new Map();for(const value of values)counts.set(value,(counts.get(value)??0)+1);
  const labels=Array.from(counts.keys()).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  return {values, labels, counts};
}

export function expressionRange(stats,mode) {
  if(mode==='full' || stats.q98-stats.q02<=1e-12)return [stats.min,stats.max];
  return [stats.q02,stats.q98];
}
