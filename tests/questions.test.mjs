import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { researchPayload,reviewPayload } from '../lib/prompts.mjs';
import { fireProfile } from '../lib/fire-protection.mjs';
import { exportData,excelReport,pdfReport } from '../lib/exports.mjs';
import { input,report,FakeProvider } from './fixtures.mjs';

const gaps=[
  {question:'What systems are proposed?',why:'Project scope determines applicability.',contact:'Project team',nextStep:'Confirm the systems.'},
  {question:'What is the expected permit date?',why:'Effective dates may affect the report.',contact:'Owner',nextStep:'Confirm the schedule.'},
];
async function setup(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-questions-')),provider=new FakeProvider(),app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-questions-')));rmSync(dir,{recursive:true,force:true});});
  const p=app.store.create(input);app.store.updateProject(p.id,{report:{...report(),gaps},status:'complete'});
  for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete',output:'Saved findings.',rounds:3,messages:[{role:'user',content:'Original context'}]});
  const {token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(command,body,auth=true)=>fetch(`${app.url}/api/projects/${p.id}/${command}`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-App-Token':token}:{})},body:JSON.stringify(body)});
  return {app,provider,post,id:p.id,dir};
}
test('answers, dismissals and reopen persist without research, spending or report changes',async t=>{
  const {app,provider,post,id,dir}=await setup(t),s=app.store,before=s.project(id),stages=s.stages(id),[one,two]=before.questions;
  assert.equal((await post('questions',{questionId:one.id,status:'answered',answer:'Sprinklers and a fire pump.'},false)).status,403);
  const response=await post('questions',{questionId:one.id,status:'answered',answer:'  Sprinklers and a fire pump.  '});assert.equal(response.status,200);
  let p=await response.json();assert.equal(p.questions[0].answer,'Sprinklers and a fire pump.');assert.equal(p.questions[0].status,'answered');assert.equal(p.questionUpdatesPending,true);
  assert.equal((await post('questions',{questionId:two.id,status:'dismissed'})).status,200);
  const reopened=new Store(dir);try{p=reopened.project(id);assert.deepEqual(p.questions.map(q=>q.status),['answered','dismissed']);}finally{reopened.close();}
  assert.equal(provider.calls.length,0);assert.equal(provider.batches.size,0);assert.equal(s.attempts(id).length,0);
  assert.deepEqual(p.report,before.report);assert.deepEqual(p.input,before.input);assert.deepEqual(s.stages(id),stages);assert.equal(p.status,before.status);assert.equal(p.cost,before.cost);
  await post('questions',{questionId:one.id,status:'answered',answer:'Sprinklers only.'});assert.equal(s.project(id).questions[0].answer,'Sprinklers only.');
  await post('questions',{questionId:one.id,status:'open'});assert.equal(s.project(id).questions[0].status,'open');assert.equal(s.project(id).questions[0].answer,'Sprinklers only.');
});
test('question mutations validate project membership, statuses and answer bounds',async t=>{
  const {app,post,id}=await setup(t),questionId=app.store.project(id).questions[0].id;
  for(const body of [{questionId,status:'answered',answer:'  '},{questionId,status:'answered',answer:'x'.repeat(4001)},{questionId,status:'answered',answer:42},{questionId,status:'verified'},{questionId:'unknown',status:'dismissed'},null])assert.equal((await post('questions',body)).status,400);
  const other=app.store.create({...input,name:'Another project'});assert.throws(()=>app.store.saveQuestion(other.id,{questionId,status:'dismissed'}),/not in the saved project/);
  assert.deepEqual(app.store.project(id).questionResponses,[]);
});
test('responses survive regenerated and reordered reports without hiding distinct questions',async t=>{
  const {app,id}=await setup(t),s=app.store,[one,two]=s.project(id).questions;
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'Sprinklers.'});s.saveQuestion(id,{questionId:two.id,status:'dismissed'});
  s.updateProject(id,{report:{...report(),gaps:[{...gaps[1],question:'  WHAT is the expected permit date?  '},{...gaps[0],question:'What systems changed after design review?'}]}});
  const questions=s.project(id).questions;assert.equal(questions[0].id,two.id);assert.equal(questions[0].status,'dismissed');assert.equal(questions[1].status,'open');assert.equal(questions[2].id,one.id);assert.equal(questions[2].answer,'Sprinklers.');
  s.saveQuestion(id,{questionId:one.id,status:'open'});assert.equal(s.project(id).questions[2].status,'open');
});
test('only explicit continuation snapshots responses and reopens research with the latest context',async t=>{
  const {app,post,id}=await setup(t),s=app.store,e=app.services.engine,[one,two]=s.project(id).questions;e.tick=async()=>{};
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'Battery storage and sprinklers.'});s.saveQuestion(id,{questionId:two.id,status:'dismissed'});
  assert.ok(!JSON.stringify(reviewPayload(s,s.project(id))).includes('Battery storage and sprinklers.'));
  assert.equal((await post('resume',{budget:8,mode:'batch'})).status,200);
  let p=s.project(id);assert.equal(p.questionUpdatesPending,false);assert.equal(p.input.questionResponses.length,2);assert.equal(p.mode,'batch');assert.equal(p.budget,8);
  assert.ok(fireProfile(p.input).some(t=>t.standard==='NFPA 855'));
  assert.ok(!fireProfile({...input,questionResponses:[{status:'dismissed',answer:'Battery storage'}]}).some(t=>t.standard==='NFPA 855'));
  assert.ok(s.stages(id).every(s=>s.status==='queued'&&s.rounds===0&&s.messages.length===0));
  for(const stage of ['jurisdiction','contacts','codes','verification'])assert.match(researchPayload(s,p,s.stage(id,stage)).messages[0].content,/Battery storage and sprinklers/);
  assert.match(reviewPayload(s,p).messages[0].content[0].text,/Battery storage and sprinklers/);assert.match(reviewPayload(s,p).system,/not independently verified source evidence/);
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'No batteries; sprinkler retrofit only.'});
  p=s.project(id);assert.equal(p.questionUpdatesPending,true);assert.match(JSON.stringify(p.input),/Battery storage and sprinklers/);assert.ok(!JSON.stringify(reviewPayload(s,p)).includes('No batteries; sprinkler retrofit only.'));
  const a=s.reserve(id,'jurisdiction',{mode:'batch',modelKey:'research',payload:{},reserve:10});
  assert.equal((await post('resume',{})).status,400);assert.equal(s.project(id).questionUpdatesPending,true);s.updateAttempt(a.id,{state:'settled',applied:1});
  await post('resume',{});assert.match(JSON.stringify(s.project(id).input),/No batteries; sprinkler retrofit only/);
  for(const stage of s.stages(id))s.updateStage(id,stage.id,{status:'complete'});
  await post('resume',{});assert.ok(s.stages(id).filter(s=>s.id!=='review').every(s=>s.status==='complete'));
  s.saveQuestion(id,{questionId:one.id,status:'open'});await post('resume',{});assert.equal(s.project(id).input.questionResponses.find(q=>q.id===one.id).answer,'');
});
test('JSON, Excel and PDF exports preserve saved answers and dismissal state',async t=>{
  const {app,id}=await setup(t),s=app.store,[one,two]=s.project(id).questions;
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'Sprinkler retrofit only.'});s.saveQuestion(id,{questionId:two.id,status:'dismissed'});
  const data=exportData(s,id);assert.equal(data.questions[0].answer,'Sprinkler retrofit only.');assert.equal(data.questions[1].status,'dismissed');assert.equal(data.questionUpdatesPending,true);
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));const ws=book.getWorksheet('Questions to resolve');assert.equal(ws.getCell('E2').value,'answered');assert.equal(ws.getCell('F2').value,'Sprinkler retrofit only.');assert.equal(ws.getCell('E3').value,'dismissed');
  const pdf=await pdfReport(data),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true}).promise;
  let text='';for(let i=1;i<=doc.numPages;i++)text+=(await(await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');await doc.loadingTask.destroy();
  assert.match(text,/Sprinkler retrofit only/);assert.match(text,/Status: dismissed/);assert.match(text,/not independently verified evidence/);
});
