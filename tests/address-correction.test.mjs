import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { researchPayload, reviewPayload } from '../lib/prompts.mjs';
import { projectTerms, selectPassages } from '../lib/evidence.mjs';
import { ResearchTools } from '../lib/research-tools.mjs';
import { projectSection } from '../lib/chat.mjs';
import { exportData, excelReport, pdfReport } from '../lib/exports.mjs';
import { diagnosticReport } from '../lib/diagnostics.mjs';
import { input, report, FakeProvider, fakeTools, ChatProvider, chatResponse } from './fixtures.mjs';

const corrected='200 Corrected Road, Revised Township, Test State 00001';
function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-address-')),store=new Store(dir);t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-address-')));rmSync(dir,{recursive:true,force:true});});return store;}
function engine(t,s){const e=new Engine(s,new FakeProvider(),()=>true,{tools:fakeTools(s),autoStart:false});e.tick=async()=>{};t.after(()=>e.close());return e;}
function complete(s,id){for(const stage of s.stages(id))s.updateStage(id,stage.id,{status:'complete',output:'Brief for the previous address.',rounds:3,messages:[{role:'user',content:'Original context'}]});}
const addressEvents=(s,id)=>s.events(id).filter(e=>e.message.startsWith('Project address changed'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(e){for(let i=0;i<150;i++){await wait(5);if(!e.running.size&&!e.polling.size&&!e.applying.size)return;}throw new Error('Engine did not settle');}
async function pdfText(buffer){
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:true}).promise;
  let text='';for(let i=1;i<=doc.numPages;i++)text+=(await(await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');await doc.loadingTask.destroy();return text;
}

test('an address correction updates the saved address, reopens jurisdiction and dependent stages, and records both addresses',async t=>{
  const s=setup(t),p=s.create(input),e=engine(t,s);complete(s,p.id);
  await e.resume(p.id,{address:`  ${corrected}  `});
  const next=s.project(p.id);
  assert.equal(next.address,corrected);assert.equal(next.input.address,corrected);
  assert.equal(s.db.prepare('SELECT address FROM projects WHERE id=?').get(p.id).address,corrected);
  assert.deepEqual(next.input.previousAddresses,[input.address]);
  assert.ok(s.stages(p.id).every(stage=>stage.status==='queued'&&stage.rounds===0&&stage.messages.length===0));
  const [event]=addressEvents(s,p.id);assert.ok(event.message.includes(input.address)&&event.message.includes(corrected));
  // Downloaded diagnostics record only that the location changed; addresses stay in project Activity.
  const resumed=s.diagnostics(p.id).find(d=>d.event==='project.resumed');
  assert.equal(resumed.details.addressChanged,true);assert.equal(resumed.details.scopeChanged,true);
  const diagnostics=JSON.stringify(diagnosticReport(s,{projectId:p.id}));
  for(const value of ['Corrected Road','100 Test Avenue'])assert.ok(!diagnostics.includes(value),value);
  assert.match(diagnostics,/Project location changed\. Addresses and parcel details are omitted from diagnostics\./);
  const jurisdiction=researchPayload(s,next,s.stage(p.id,'jurisdiction')).messages[0].content;
  assert.ok(jurisdiction.includes(corrected));assert.match(jurisdiction,/corrected the project address\. projectInputs\.address is the current location/);
  assert.match(reviewPayload(s,next).messages[0].content[0].text,/evidence_package\.project\.address is the current location/);
});

test('locate_address, passage ranking, chat context and exports use the corrected address',async t=>{
  const s=setup(t),p=s.create(input),e=engine(t,s),urls=[];
  await e.resume(p.id,{address:corrected});
  const tools=new ResearchTools(s,{fetchImpl:async url=>{urls.push(url);return {url,type:'application/json',buffer:Buffer.from(JSON.stringify({result:{addressMatches:[]}}))};}});
  await tools.locate(p.id,{});
  assert.equal(new URL(urls[0]).searchParams.get('address'),corrected);
  const terms=projectTerms(s.project(p.id).input);
  assert.ok(terms.includes('Corrected')&&terms.includes('Revised'));assert.ok(!terms.includes('Example')&&!terms.includes('District'));
  const filler=n=>'lorem ipsum dolor sit amet '.repeat(n),text=filler(120)+'The Revised Township building department reviews plans. '+filler(120)+'The Example District fire marshal reviews plans. '+filler(120);
  const selected=selectPassages(text,{limit:1100,input:s.project(p.id).input}).text;
  assert.ok(selected.includes('Revised Township'));assert.ok(!selected.includes('Example District'));
  assert.ok(selectPassages(text,{limit:1100,input}).text.includes('Example District'));
  const context=projectSection(s,p.id,'context');assert.equal(context.address,corrected);assert.deepEqual(context.input.previousAddresses,[input.address]);
  const data=exportData(s,p.id);assert.equal(data.project.address,corrected);
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));const sheet=book.getWorksheet('Project');
  assert.equal(sheet.getCell('A3').value,'Address');assert.equal(sheet.getCell('B3').value,corrected);assert.equal(sheet.getCell('A4').value,'Previous addresses');assert.equal(sheet.getCell('B4').value,input.address);assert.equal(sheet.getCell('A5').value,'Discipline');
  const text2=await pdfText(await pdfReport(data));assert.ok(text2.includes('Revised Township'));assert.match(text2,/Address corrected\. Previously/);
});

test('invalid corrections and simultaneous NFPA or partial-report requests leave the project unchanged',async t=>{
  const s=setup(t),p=s.create(input),e=engine(t,s);complete(s,p.id);
  const before={project:s.project(p.id),stages:s.stages(p.id),events:s.events(p.id)};
  for(const address of ['','   ','Too few','x'.repeat(501)])await assert.rejects(e.resume(p.id,{address}),/complete project address/);
  await assert.rejects(e.resume(p.id,{address:corrected,focus:'fire_protection'}),/no simultaneous scope change/);
  await assert.rejects(e.resume(p.id,{siteDescription:'APN 0123-456-789',focus:'fire_protection'}),/no simultaneous scope change/);
  await assert.rejects(e.resume(p.id,{address:corrected,finishPartial:true}),/partial report would describe the previous location/);
  await assert.rejects(e.resume(p.id,{address:corrected,budget:.5}),/budget must cover/);
  const after=s.project(p.id);
  assert.equal(after.address,input.address);assert.deepEqual(after.input,before.project.input);assert.equal(after.budget,before.project.budget);
  assert.deepEqual(s.stages(p.id),before.stages);assert.deepEqual(s.events(p.id),before.events);
});

test('active research and outstanding requests block an address correction without changing the project',async t=>{
  const s=setup(t),p=s.create(input),e=engine(t,s);complete(s,p.id);
  for(const key of [`${p.id}:jurisdiction`,`${p.id}:chat`]){
    e.running.add(key);await assert.rejects(e.resume(p.id,{address:corrected}),/Wait for the current request/);e.running.delete(key);
  }
  const a=s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload:{},reserve:1000});
  await assert.rejects(e.resume(p.id,{address:corrected}),/outstanding request/);
  assert.equal(s.project(p.id).address,input.address);assert.equal(addressEvents(s,p.id).length,0);assert.equal(s.project(p.id).reserved,.001);
  s.updateAttempt(a.id,{state:'settled',actual:1000,applied:1});
  await e.resume(p.id,{address:corrected});
  assert.equal(s.project(p.id).address,corrected);assert.equal(s.project(p.id).cost,.001);assert.equal(s.project(p.id).reserved,0);
});

test('repeating the saved address or site description is not a context change',async t=>{
  const s=setup(t),p=s.create(input),e=engine(t,s);complete(s,p.id);
  await e.resume(p.id,{address:`  ${input.address}\n`,siteDescription:'   '});
  assert.ok(s.stages(p.id).filter(stage=>stage.id!=='review').every(stage=>stage.status==='complete'&&stage.rounds===3));
  assert.equal(s.project(p.id).input.previousAddresses,undefined);assert.equal(addressEvents(s,p.id).length,0);
  await e.resume(p.id,{address:corrected});complete(s,p.id);
  await e.resume(p.id,{address:corrected});
  assert.ok(s.stages(p.id).filter(stage=>stage.id!=='review').every(stage=>stage.status==='complete'));
  assert.equal(addressEvents(s,p.id).length,1);assert.deepEqual(s.project(p.id).input.previousAddresses,[input.address]);
  // Returning to an earlier address keeps a de-duplicated history without the current address.
  await e.resume(p.id,{address:input.address});
  assert.deepEqual(s.project(p.id).input.previousAddresses,[corrected]);assert.equal(s.project(p.id).address,input.address);
});

test('a parcel or site description is saved, correctable, and used for prompts and passage ranking',async t=>{
  const s=setup(t),e=engine(t,s),p=s.create({...input,siteDescription:'  APN 0123-456-789, Riverbend parcel near Route 9  '});
  assert.equal(p.input.siteDescription,'APN 0123-456-789, Riverbend parcel near Route 9');
  const terms=projectTerms(p.input);
  assert.ok(terms.includes('0123-456-789')&&terms.includes('Riverbend'));for(const generic of ['parcel','near','Route'])assert.ok(!terms.includes(generic),generic);
  assert.ok(!projectTerms({...input,siteDescription:'Lot 12, ZIP 00000, 2026 plat'}).some(term=>/\d/.test(term)));
  const content=researchPayload(s,p,s.stage(p.id,'jurisdiction')).messages[0].content;
  assert.ok(content.includes('APN 0123-456-789'));assert.match(content,/projectInputs\.siteDescription is a user-provided parcel number/);
  assert.doesNotMatch(researchPayload(s,s.create(input),s.stage(p.id,'jurisdiction')).messages[0].content,/siteDescription is a user-provided|corrected the project address/);
  complete(s,p.id);await e.resume(p.id,{siteDescription:'Lot 7, Riverbend Tract'});
  assert.equal(s.project(p.id).input.siteDescription,'Lot 7, Riverbend Tract');assert.equal(s.project(p.id).address,input.address);assert.equal(s.project(p.id).input.previousAddresses,undefined);
  assert.ok(s.stages(p.id).every(stage=>stage.status==='queued'));
  assert.ok(s.events(p.id).some(ev=>ev.message.includes('APN 0123-456-789')&&ev.message.includes('Lot 7, Riverbend Tract')));
  assert.ok(!JSON.stringify(diagnosticReport(s)).includes('Riverbend'));
  complete(s,p.id);await e.resume(p.id,{siteDescription:''});
  assert.equal(s.project(p.id).input.siteDescription,'');assert.ok(s.events(p.id).some(ev=>ev.message.includes('removed')));
  await e.resume(p.id,{siteDescription:'y'.repeat(600)});assert.equal(s.project(p.id).input.siteDescription.length,500);
});

async function appSetup(t,provider=new FakeProvider()){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-address-http-')),app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-address-http-')));rmSync(dir,{recursive:true,force:true});});
  const p=app.store.create(input);app.store.updateProject(p.id,{report:report(),status:'complete'});complete(app.store,p.id);
  const {token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(command,body)=>fetch(`${app.url}/api/projects/${p.id}/${command}`,{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify(body)});
  return {app,provider,post,id:p.id};
}

test('the resume endpoint corrects the address and fake-provider research runs for the new location',async t=>{
  const {app,provider,post,id}=await appSetup(t),s=app.store,e=app.services.engine;e.tools=fakeTools(s);
  const rejected=await post('resume',{budget:8,mode:'realtime',clarification:'',address:'short'});
  assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/complete project address/);
  assert.equal(s.project(id).address,input.address);assert.equal(provider.calls.length,0);
  const response=await post('resume',{budget:8,mode:'realtime',clarification:'',address:corrected,siteDescription:'APN 555-12-345'});
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.address,corrected);assert.equal(body.input.siteDescription,'APN 555-12-345');
  let p;for(let i=0;i<40&&s.stage(id,'review').status!=='complete';i++){await e.tick();await settle(e);p=s.project(id);if(['attention','budget','failed'].includes(p.status))throw new Error(p.note);}
  assert.equal(s.stage(id,'review').status,'complete');assert.ok(p.report);assert.equal(p.budget,8);
  const first=provider.calls.find(c=>typeof c.messages[0].content==='string'&&c.messages[0].content.includes('Stage: Jurisdiction'));
  assert.ok(first.messages[0].content.includes(corrected));assert.ok(first.messages[0].content.includes('APN 555-12-345'));assert.match(first.messages[0].content,/corrected the project address/);
  const data=exportData(s,id);assert.equal(data.project.address,corrected);assert.equal(data.project.context.siteDescription,'APN 555-12-345');
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));const sheet=book.getWorksheet('Project');
  assert.equal(sheet.getCell('B3').value,corrected);assert.equal(sheet.getCell('A4').value,'Parcel / site description');assert.equal(sheet.getCell('B4').value,'APN 555-12-345');assert.equal(sheet.getCell('A5').value,'Previous addresses');
  const text=await pdfText(await pdfReport(data));assert.ok(text.includes('Revised Township'));assert.match(text,/Parcel \/ site: APN 555-12-345/);
});

test('an active chat reply blocks an address correction until it finishes',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const provider=new ChatProvider(async()=>{await gate;return chatResponse('Saved answer.');});
  const {app,post,id}=await appSetup(t,provider),s=app.store,chat=app.services.chat;app.services.engine.tick=async()=>{};
  chat.start(id,{message:'Which authority applies?',clientId:randomUUID()});
  for(let i=0;i<100&&!provider.calls.length;i++)await wait(5);
  const blocked=await post('resume',{address:corrected});
  assert.equal(blocked.status,400);assert.match((await blocked.json()).error,/Wait for the current request/);
  assert.equal(s.project(id).address,input.address);assert.equal(addressEvents(s,id).length,0);
  release();for(let i=0;i<200&&chat.running.size;i++)await wait(5);
  assert.equal(s.chatTurns(id)[0].status,'complete');
  assert.equal((await post('resume',{address:corrected})).status,200);assert.equal(s.project(id).address,corrected);
});
