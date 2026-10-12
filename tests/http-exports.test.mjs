import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { createApp } from '../server.mjs';
import { validateReport } from '../lib/prompts.mjs';
import { pdfReport,excelReport,exportData } from '../lib/exports.mjs';
import { report,evidenceText,input,FakeProvider } from './fixtures.mjs';

async function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-http-')),app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-test-http-')));rmSync(dir,{recursive:true,force:true});});return {app,dir};}
test('local HTTP access requires token, correct origin and JSON; paths remain private',async t=>{
  const {app}=await setup(t),b=await(await fetch(app.url+'/api/bootstrap')).json();
  assert.ok(b.token);assert.equal((await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
  assert.equal((await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':b.token,Origin:'https://evil.example'},body:JSON.stringify(input)})).status,403);
  assert.equal((await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'text/plain','X-App-Token':b.token},body:'{}'})).status,415);
  assert.equal((await fetch(app.url+'/data/atlas.sqlite')).status,404);
  assert.equal((await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':b.token},body:JSON.stringify({...input,notes:'x'.repeat(300000)})})).status,413);
  const result=await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':b.token},body:JSON.stringify(input)});assert.equal(result.status,201);
  const p=await result.json(),detail=await(await fetch(app.url+'/api/projects/'+p.id)).json();assert.equal(detail.project.name,input.name);assert.ok(!JSON.stringify(detail).includes('x-api-key'));
});
test('the About dialog and plain-text license are served locally without exposing other root files',async t=>{
  const {app}=await setup(t),license=await fetch(app.url+'/license');
  assert.equal(license.status,200);assert.equal(license.headers.get('content-type'),'text/plain; charset=utf-8');
  const text=await license.text();assert.match(text,/^AHJ Atlas Software License/);assert.match(text,/Copyright \(c\) 2026 Abraham Borg\. All rights reserved\./);
  const page=await(await fetch(app.url+'/')).text();
  for(const expected of ['id="about-dialog"','id="open-about"','Copyright © 2026 Abraham Borg.','href="https://github.com/Abe-Borg"','href="https://www.linkedin.com/in/abrahamborg/"'])assert.ok(page.includes(expected),expected);
  for(const hidden of ['/LICENSE','/package.json','/server.mjs'])assert.equal((await fetch(app.url+hidden)).status,404);
});
test('second app instance cannot recover or corrupt the first instance’s live jobs',async t=>{
  const {app,dir}=await setup(t),p=app.store.create(input),a=app.store.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:{},reserve:1000});
  await assert.rejects(createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false}),/already using/);assert.equal(app.store.attempt(a.id).state,'dispatching');
});
test('PDF and Excel exports are real documents with sources, gaps, literal cells and no credentials',async t=>{
  const {app}=await setup(t),p=app.store.create(input);app.store.source(p.id,{url:'https://example.com/adoption',title:'Synthetic record',text:evidenceText,readFull:true});const r=validateReport(report(),app.store.sources(p.id));r.contacts[0].name='=HYPERLINK("https://evil.example")';app.store.updateProject(p.id,{report:r,status:'complete'});
  const data=exportData(app.store,p.id),xlsx=await excelReport(data),pdf=await pdfReport(data);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.equal(xlsx.subarray(0,2).toString(),'PK');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(xlsx);assert.equal(wb.worksheets.length,8);assert.equal(wb.getWorksheet('Contacts').getCell('A2').type,ExcelJS.ValueType.String);assert.equal(wb.getWorksheet('Codes').getCell('B2').value,'2021');assert.equal(wb.getWorksheet('Sources').getCell('C2').value,'https://example.com/adoption');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const document=await getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true}).promise;assert.ok(document.numPages>0);let all='';for(let i=1;i<=document.numPages;i++){const pg=await document.getPage(i);all+=(await pg.getTextContent()).items.map(v=>v.str).join(' ');}assert.ok(all.includes('Fixture Building Code'));assert.ok(all.includes('Source register'));await document.loadingTask.destroy();
  const response=await fetch(`${app.url}/api/projects/${p.id}/export?format=xlsx`);assert.equal(response.status,200);assert.ok(response.headers.get('content-disposition').includes('.xlsx'));
});
// Filename rules are covered in desktop-downloads.test.mjs; this checks the export response uses them.
test('export responses carry the cleaned Unicode attachment name',async t=>{
  const {app}=await setup(t);
  const project=app.store.create({...input,name:'Café 東京 : site*?'});
  const response=await fetch(`${app.url}/api/projects/${project.id}/export?format=json`);
  assert.equal(response.status,200);
  const encoded=response.headers.get('content-disposition').match(/filename\*=UTF-8''([^;]+)/)?.[1];
  assert.equal(decodeURIComponent(encoded),'Café 東京 site - AHJ research.json');
});

async function pdfText(buffer){
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:true}).promise;
  let all='';for(let i=1;i<=doc.numPages;i++)all+=(await(await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ')+'\n';await doc.loadingTask.destroy();return all;
}
test('a source keeps its retrieval date when a search only finds it again, and moves when its text is read',async t=>{
  const {app}=await setup(t),s=app.store,p=s.create(input),url='https://example.com/adoption',old='2020-01-01T00:00:00.000Z';
  s.source(p.id,{url,title:'Adoption record',text:evidenceText,readFull:true});
  s.db.prepare('UPDATE sources SET retrieved=? WHERE project_id=?').run(old,p.id);
  // The outside review's case: a discovery-only search hit used to stamp old text with a new date.
  s.source(p.id,{url,title:'Adoption record (search title)',readFull:false});
  let saved=s.sources(p.id)[0];
  assert.equal(saved.retrieved,old);assert.equal(saved.text,evidenceText);assert.equal(saved.read_full,true);assert.equal(saved.title,'Adoption record (search title)');
  s.source(p.id,{url,text:evidenceText,readFull:true});
  saved=s.sources(p.id)[0];assert.ok(saved.retrieved>old);
  // A lead keeps the date it was first found until its text is read.
  s.source(p.id,{url:'https://example.com/lead',title:'Lead',readFull:false});
  s.db.prepare("UPDATE sources SET retrieved=? WHERE url='https://example.com/lead'").run(old);
  s.source(p.id,{url:'https://example.com/lead',title:'Lead again',readFull:false});
  assert.equal(s.sources(p.id).find(x=>x.url==='https://example.com/lead').retrieved,old);
});
test('PDF and Excel keep each finding’s evidence status, flag unmatched quotations, and label report, export and source dates',async t=>{
  const {app}=await setup(t),s=app.store,p=s.create(input);
  s.source(p.id,{url:'https://example.com/adoption',title:'Synthetic record',text:evidenceText,readFull:true});
  s.source(p.id,{url:'https://example.com/lead',title:'Search lead',readFull:false});
  const draft=report();
  draft.contacts[0].status='conflicting';draft.requirements[0].status='unverified';
  draft.authorities[0].evidence=[{sourceId:'S1',quote:'This sentence does not appear in the retrieved source text.',pageOrSection:'Fixture'}];
  const validated=validateReport(draft,s.sources(p.id));
  assert.equal(validated.authorities[0].status,'unverified');assert.equal(validated.authorities[0].evidence[0].supported,false);
  s.updateProject(p.id,{report:validated});
  const data=exportData(s,p.id),text=await pdfText(await pdfReport(data));
  assert.match(text,/Source-supported means a quoted passage was matched to retrieved source text/);
  const section=(from,to)=>text.slice(text.indexOf(from),text.indexOf(to,text.indexOf(from)));
  assert.match(section('Authorities','Contacts'),/Example District\s+Evidence status: Unconfirmed/);
  assert.match(section('Authorities','Contacts'),/S1 · Fixture · Supporting passage needs confirmation — This sentence does not appear/);
  assert.match(section('Contacts','Codes and standards'),/Evidence status: Conflicting/);
  assert.match(section('Submission requirements','Questions to resolve'),/Confirm actual authority\s+Evidence status: Unconfirmed/);
  assert.match(section('Codes and standards','Submission requirements'),/Evidence status: Source-supported · direct · Example District/);
  assert.ok(!/Supporting passage needs confirmation/.test(section('Contacts','Codes and standards')));
  assert.match(text,/Report generated .+ · Exported /);
  assert.match(section('Source register','Research limitations'),/S1 · Synthetic record\s+Retrieved .+Read as evidence[\s\S]*S2 · Search lead\s+Discovered .+Discovery \/ visual only/);
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));
  const rows=[];book.getWorksheet('Project').eachRow((row,n)=>{if(n>1)rows.push([row.getCell(1).value,row.getCell(2).value]);});
  assert.equal(rows.find(r=>r[0]==='Report generated')[1],validated.generatedAt);
  assert.equal(rows.find(r=>r[0]==='Exported')[1],data.exportedAt);
  assert.ok(!rows.some(r=>r[0]==='Research date'));
  assert.match(book.getWorksheet('Authorities').getCell('H2').value,/Supporting passage needs confirmation/);
  assert.ok(!/Supporting passage needs confirmation/.test(book.getWorksheet('Contacts').getCell('K2').value));
  const sources=book.getWorksheet('Sources');
  assert.equal(sources.getCell('E1').value,'Date type');assert.equal(sources.getCell('E2').value,'Retrieved');assert.equal(sources.getCell('E3').value,'Discovered');
});
