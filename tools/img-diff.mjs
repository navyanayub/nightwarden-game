import sharp from 'sharp';
const [a,b] = process.argv.slice(2);
const A = await sharp(a).raw().toBuffer(); const B = await sharp(b).raw().toBuffer();
let d=0, n=0; for (let i=0;i<A.length;i++){ const x=Math.abs(A[i]-B[i]); d+=x; if(x>8)n++; }
console.log('mean diff', (d/A.length).toFixed(2), 'px>8', n);
