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
  assert.equal((await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':b.token},body:JSON.stringify({...input,notes:'x'.repeat(40000)})})).status,413);
  const result=await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':b.token},body:JSON.stringify(input)});assert.equal(result.status,201);
  const p=await result.json(),detail=await(await fetch(app.url+'/api/projects/'+p.id)).json();assert.equal(detail.project.name,input.name);assert.ok(!JSON.stringify(detail).includes('x-api-key'));
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
test('export attachment names survive Unicode, invalid Windows characters, and long project names',async t=>{
  const {app}=await setup(t);
  for(const name of ['Café 東京 project','Reserved : <> / \\ ? * name','Long '+ 'x'.repeat(95)]){
    const project=app.store.create({...input,name});
    const response=await fetch(`${app.url}/api/projects/${project.id}/export?format=json`);
    assert.equal(response.status,200);
    const disposition=response.headers.get('content-disposition');
    const encoded=disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    assert.ok(encoded);
    const filename=decodeURIComponent(encoded);
    assert.match(filename,/ - AHJ research\.json$/);
    assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(filename));
    assert.ok(filename.length<150);
    if(name.startsWith('Café'))assert.ok(filename.startsWith('Café 東京'));
  }
});
