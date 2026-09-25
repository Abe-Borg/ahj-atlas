import { mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { exportData,pdfReport } from '../lib/exports.mjs';
import { Store } from '../lib/store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','test-results');mkdirSync(root,{recursive:true});
const store=new Store(path.join(root,'ui-workspace')),p=store.list().find(p=>p.report?.fireProtection);if(!p)throw new Error('No synthetic NFPA report available.');const pdf=await pdfReport(exportData(store,p.id));store.close();writeFileSync(path.join(root,'synthetic-report.pdf'),pdf);
const task=getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true}),doc=await task.promise;
const pages=[];for(let i=1;i<=doc.numPages;i++){const pg=await doc.getPage(i),viewport=pg.getViewport({scale:1.25}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await pg.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const filename=path.join(root,`report-page-${i}.png`);writeFileSync(filename,canvas.toBuffer('image/png'));pages.push(filename);}
await task.destroy();console.log(JSON.stringify({pdf:path.join(root,'synthetic-report.pdf'),pages}));
