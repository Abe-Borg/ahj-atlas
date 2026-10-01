import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { researchPayload,reviewPayload,validateReport } from '../lib/prompts.mjs';
import { fireProfile } from '../lib/fire-protection.mjs';
import { exportData,excelReport,pdfReport } from '../lib/exports.mjs';
import { CLOSURE_REASON, questionContext, questionId } from '../lib/questions.mjs';
import { evidenceText, input,report,FakeProvider } from './fixtures.mjs';

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
  assert.equal((await post('resume',{mode:'batch'})).status,200);
  let p=s.project(id);assert.equal(p.questionUpdatesPending,false);assert.equal(p.input.questionResponses.length,2);assert.equal(p.mode,'batch');
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
test('JSON, Excel and PDF exports preserve saved answers, dismissal state and the reason',async t=>{
  const {app,id}=await setup(t),s=app.store,[one,two]=s.project(id).questions;
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'Sprinkler retrofit only.',reason:'The owner confirmed the scope.'});s.saveQuestion(id,{questionId:two.id,status:'dismissed',reason:'Not needed for this phase.'});
  const data=exportData(s,id);assert.equal(data.questions[0].answer,'Sprinkler retrofit only.');assert.equal(data.questions[0].reason,'The owner confirmed the scope.');assert.equal(data.questions[1].status,'dismissed');assert.equal(data.questions[1].reason,'Not needed for this phase.');assert.equal(data.questionUpdatesPending,true);
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));const ws=book.getWorksheet('Questions to resolve');assert.equal(ws.getCell('E2').value,'answered');assert.equal(ws.getCell('F2').value,'Sprinkler retrofit only.');assert.equal(ws.getCell('G2').value,'The owner confirmed the scope.');assert.equal(ws.getCell('E3').value,'dismissed');assert.equal(ws.getCell('G3').value,'Not needed for this phase.');
  const pdf=await pdfReport(data),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true}).promise;
  let text='';for(let i=1;i<=doc.numPages;i++)text+=(await(await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');await doc.loadingTask.destroy();
  assert.match(text,/Sprinkler retrofit only/);assert.match(text,/Status: dismissed/);assert.match(text,/Reason: The owner confirmed the scope/);assert.match(text,/Reason: Not needed for this phase/);assert.match(text,/not independently verified evidence/);
  assert.match(s.events(id).find(e=>e.message.startsWith('Question answered:')).message,/What systems are proposed\?/);
  assert.match(s.events(id).find(e=>e.message.startsWith('Question answered:')).message,/The owner confirmed the scope/);
  assert.match(s.events(id).find(e=>e.message.startsWith('Question dismissed:')).message,/Not needed for this phase/);
});
test('a replacement report closes omitted open questions and keeps answered ones',async t=>{
  const {app,id}=await setup(t),s=app.store,engine=app.services.engine,[one,two]=s.project(id).questions;
  s.saveQuestion(id,{questionId:two.id,status:'answered',answer:'October 2026.'});
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'Sprinklers.'});
  s.saveQuestion(id,{questionId:one.id,status:'open'});
  const kept={question:'What systems changed after design review?',why:'Scope changed.',contact:'Project team',nextStep:'Confirm the systems.'};
  const save=(gaps)=>{
    const attempt=s.reserve(id,'review',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
    engine.saveReport(s.project(id),s.attempt(attempt.id),{...report(),researchHealth:{},gaps},'{}');
  };
  save([kept]);
  let questions=s.project(id).questions,closed=questions.find(q=>q.id===one.id);
  assert.equal(closed.status,'closed');assert.equal(closed.reason,CLOSURE_REASON);assert.equal(closed.question,one.question);
  assert.equal(questions.find(q=>q.id===two.id).status,'answered');assert.equal(questions.find(q=>q.id===two.id).answer,'October 2026.');
  assert.equal(questions.find(q=>q.question===kept.question).status,'open');
  assert.equal(questions.filter(q=>q.id===one.id).length,1);
  assert.ok(!questionContext(s.project(id).questionResponses).some(q=>q.status==='closed'));
  const closedEvent=s.events(id).filter(e=>e.message.includes(CLOSURE_REASON)&&e.message.includes(one.question));
  assert.equal(closedEvent.length,1);assert.match(closedEvent[0].message,/^Question closed: “What systems are proposed\?”/);
  // The same question text stays closed. A reworded question is a different open item.
  save([gaps[0],kept]);
  questions=s.project(id).questions;
  assert.equal(questions.find(q=>q.id===one.id).status,'closed');
  assert.equal(questions.filter(q=>q.status==='open').map(q=>q.question).join('|'),kept.question);
  assert.equal(s.events(id).filter(e=>e.message.includes(CLOSURE_REASON)&&e.message.includes(one.question)).length,1);
  save([]);
  questions=s.project(id).questions;
  assert.equal(questions.find(q=>q.question===kept.question).status,'closed');
  assert.equal(questions.find(q=>q.id===two.id).status,'answered');
  assert.equal(s.events(id).filter(e=>e.message.includes(CLOSURE_REASON)&&e.message.includes(kept.question)).length,1);
  const data=exportData(s,id);assert.ok(data.questions.some(q=>q.question===one.question&&q.status==='closed'&&q.reason===CLOSURE_REASON));
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));const ws=book.getWorksheet('Questions to resolve');
  const rows=[];ws.eachRow((row,n)=>{if(n>1)rows.push(row.values.slice(1));});
  assert.ok(rows.some(row=>row[0]===one.question&&row[4]==='closed'&&row[6]===CLOSURE_REASON));
  const pdf=await pdfReport(data),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true}).promise;
  let text='';for(let i=1;i<=doc.numPages;i++)text+=(await(await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');await doc.loadingTask.destroy();
  assert.match(text,/Status: closed/);assert.match(text,new RegExp(CLOSURE_REASON.replace(/[.]/g,'\\.')));
});
test('a report save keeps question updates made while the review was still applying',async t=>{
  const {app,id}=await setup(t),s=app.store,engine=app.services.engine;
  const extra={question:'Who is the fire marshal?',why:'Contact',contact:'AHJ',nextStep:'Ask.'};
  s.updateProject(id,{report:{...report(),gaps:[...gaps,extra]}});
  const [one,two,three]=s.project(id).questions;
  s.saveQuestion(id,{questionId:two.id,status:'answered',answer:'October 2026.'});
  const stale=s.project(id);
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'Sprinklers only.',reason:'Confirmed during review.'});
  s.saveQuestion(id,{questionId:three.id,status:'dismissed',reason:'Not this phase.'});
  s.saveQuestion(id,{questionId:two.id,status:'open'});
  const attempt=s.reserve(id,'review',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
  engine.saveReport(stale,s.attempt(attempt.id),{...report(),researchHealth:{},gaps:[]},'{}');
  const questions=s.project(id).questions,answered=questions.find(q=>q.id===one.id),dismissed=questions.find(q=>q.id===three.id),reopened=questions.find(q=>q.id===two.id);
  assert.equal(answered.status,'answered');assert.equal(answered.answer,'Sprinklers only.');assert.equal(answered.reason,'Confirmed during review.');
  assert.equal(dismissed.status,'dismissed');assert.equal(dismissed.reason,'Not this phase.');
  assert.equal(reopened.status,'closed');assert.equal(reopened.reason,CLOSURE_REASON);
  assert.equal(s.events(id).filter(e=>e.message.startsWith('Question closed:')&&e.message.includes(one.question)).length,0);
  assert.equal(s.events(id).filter(e=>e.message.startsWith('Question closed:')&&e.message.includes(three.question)).length,0);
  assert.equal(s.events(id).filter(e=>e.message.startsWith('Question closed:')&&e.message.includes(two.question)).length,1);
  s.closeQuestions(id,[{id:one.id,question:one.question,reason:CLOSURE_REASON,answer:'replaced'}]);
  assert.equal(s.project(id).questions.find(q=>q.id===one.id).status,'answered');assert.equal(s.project(id).questions.find(q=>q.id===one.id).answer,'Sprinklers only.');
  assert.equal(s.events(id).filter(e=>e.message.startsWith('Question closed:')&&e.message.includes(one.question)).length,0);
});
test('closing a question the last round still lists as open does not offer another research round',async t=>{
  const {app,id}=await setup(t),s=app.store,engine=app.services.engine,[one,two]=s.project(id).questions;
  s.saveQuestion(id,{questionId:one.id,status:'answered',answer:'Sprinklers.'});
  s.saveQuestion(id,{questionId:one.id,status:'open'});
  const snapshot=questionContext(s.project(id).questionResponses);
  s.updateProject(id,{input:{...s.project(id).input,questionResponses:snapshot}});
  assert.equal(s.project(id).questionUpdatesPending,false);
  const attempt=s.reserve(id,'review',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
  engine.saveReport(s.project(id),s.attempt(attempt.id),{...report(),researchHealth:{},gaps:[gaps[1]]},'{}');
  const closed=s.project(id);
  assert.equal(closed.questions.find(q=>q.id===one.id).status,'closed');
  assert.equal(closed.input.questionResponses.some(q=>q.id===one.id&&q.status==='open'),true);
  assert.equal(closed.questionUpdatesPending,false);
  s.saveQuestion(id,{questionId:two.id,status:'answered',answer:'October 2026.'});
  assert.equal(s.project(id).questionUpdatesPending,true);
});
test('a saved answer keeps the same confirm question from returning, and the report save closes it',async t=>{
  const {app,id}=await setup(t),s=app.store,engine=app.services.engine;
  const confirm='Confirm NFPA 13: applicability and adopted edition.',other='Confirm NFPA 72: applicability and adopted edition.';
  s.updateProject(id,{report:{...report(),gaps:[...gaps,{question:confirm,why:'Edition',contact:'AHJ',nextStep:'Confirm.'},{question:other,why:'Edition',contact:'AHJ',nextStep:'Confirm.'}]}});
  const systems=s.project(id).questions.find(q=>q.question===gaps[0].question);
  s.saveQuestion(id,{questionId:systems.id,status:'answered',answer:'The project uses NFPA 13, 2019 edition.'});
  const reviewed=validateReport({...report()},[{id:'S1',url:'https://example.com/adoption',text:evidenceText,read_full:true}],[],[],s.project(id).input,s.project(id).questionResponses);
  assert.ok(!reviewed.gaps.some(g=>g.question===confirm));assert.ok(reviewed.gaps.some(g=>g.question===other));
  const attempt=s.reserve(id,'review',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
  engine.saveReport(s.project(id),s.attempt(attempt.id),reviewed,'{}');
  const questions=s.project(id).questions;
  assert.equal(questions.find(q=>q.question===confirm).status,'closed');assert.equal(questions.find(q=>q.question===confirm).reason,CLOSURE_REASON);
  assert.equal(questions.find(q=>q.question===other).status,'open');
  assert.equal(questions.find(q=>q.id===systems.id).status,'answered');
  assert.ok(s.events(id).some(e=>e.message.includes(confirm)&&e.message.includes(CLOSURE_REASON)));
});
test('confirm questions honor saved answers and closures and do not treat a rewording as the same question',()=>{
  const source={id:'S1',url:'https://example.com/adoption',text:evidenceText,read_full:true};
  const base=report();base.jurisdiction.status='unverified';base.codes[0].status='unverified';
  const jurisdiction='Confirm the governing jurisdiction.',code='Confirm Fixture Building Code and its applicable edition.';
  const added=validateReport(structuredClone(base),[source]);
  assert.ok(added.gaps.some(g=>g.question===jurisdiction));assert.ok(added.gaps.some(g=>g.question===code));
  const answered=[{id:questionId('Which authority governs this site?'),question:'Which authority governs this site?',status:'answered',answer:'Example District is the jurisdiction.'}];
  const honored=validateReport(structuredClone(base),[source],[],[],input,answered);
  assert.ok(!honored.gaps.some(g=>g.question===jurisdiction));assert.ok(honored.gaps.some(g=>g.question===code));
  const closed=[{id:questionId(code),question:code,status:'closed',answer:'',reason:CLOSURE_REASON}];
  const kept=validateReport(structuredClone(base),[source],[],[],input,closed);
  assert.ok(!kept.gaps.some(g=>g.question===code));assert.ok(kept.gaps.some(g=>g.question===jurisdiction));
  const reworded=[{id:questionId('Is the fixture code adopted?'),question:'Is the fixture code adopted?',status:'answered',answer:'Yes, for this office.'}];
  const separate=validateReport(structuredClone(base),[source],[],[],input,reworded);
  assert.ok(separate.gaps.some(g=>g.question===code));assert.ok(separate.gaps.some(g=>g.question===jurisdiction));
  const reopened=[{id:questionId(jurisdiction),question:jurisdiction,status:'open',answer:'',reason:''}];
  assert.ok(validateReport(structuredClone(base),[source],[],[],input,reopened).gaps.some(g=>g.question===jurisdiction));
});
test('an older question table gains a reason and can record a closure',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-questions-migrate-'));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-questions-migrate-')));rmSync(dir,{recursive:true,force:true});});
  const file=path.join(dir,'atlas.sqlite'),db=new DatabaseSync(file);
  db.exec(`CREATE TABLE question_responses(project_id TEXT NOT NULL, id TEXT NOT NULL, gap TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','answered','dismissed')), answer TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL, PRIMARY KEY(project_id,id));
    INSERT INTO question_responses VALUES('legacy','q1','{"question":"Legacy question?"}', 'answered','Kept','2000-01-01T00:00:00.000Z');`);
  db.close();
  const store=new Store(dir);
  try{
    const saved=store.db.prepare('SELECT status,reason,answer FROM question_responses WHERE id=?').get('q1');
    assert.equal(saved.status,'answered');assert.equal(saved.answer,'Kept');assert.equal(saved.reason,'');
    assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='question_responses'").get().sql,/'closed'/);
    store.db.exec('PRAGMA foreign_keys=OFF');
    store.db.prepare("INSERT INTO question_responses(project_id,id,gap,status,answer,reason,updated) VALUES('legacy','q2','{\"question\":\"Dropped?\"}','closed','',?,?)").run(CLOSURE_REASON,new Date().toISOString());
    assert.equal(store.db.prepare('SELECT reason FROM question_responses WHERE id=?').get('q2').reason,CLOSURE_REASON);
  }finally{store.close();}
});
