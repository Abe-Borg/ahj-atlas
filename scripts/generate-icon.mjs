// Rasterize the project's vector favicon at each native Windows icon size.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadImage, createCanvas } from '@napi-rs/canvas';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source=await readFile(path.join(root,'public','favicon.svg'),'utf8');
const sizes=[16,24,32,48,64,128,256];
const images=[];
for(const size of sizes){
  const svg=source.replace('<svg ',`<svg width="${size}" height="${size}" `);
  const image=await loadImage(Buffer.from(svg));
  const canvas=createCanvas(size,size);
  canvas.getContext('2d').drawImage(image,0,0);
  images.push(canvas.toBuffer('image/png'));
}
const header=Buffer.alloc(6+16*sizes.length);
header.writeUInt16LE(1,2);
header.writeUInt16LE(sizes.length,4);
let offset=header.length;
for(let i=0;i<sizes.length;i++){
  const entry=6+16*i;
  header.writeUInt8(sizes[i]===256?0:sizes[i],entry);
  header.writeUInt8(sizes[i]===256?0:sizes[i],entry+1);
  header.writeUInt16LE(1,entry+4);
  header.writeUInt16LE(32,entry+6);
  header.writeUInt32LE(images[i].length,entry+8);
  header.writeUInt32LE(offset,entry+12);
  offset+=images[i].length;
}
const output=path.join(root,'build','icon.ico');
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,Buffer.concat([header,...images]));
await writeFile(path.join(root,'build','icon-preview.png'),images.at(-1));
console.log(`Generated ${output} with ${sizes.join(', ')} px images.`);
