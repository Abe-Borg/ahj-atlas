import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { LIMITS } from '../lib/config.mjs';
import { remainingSearches,researchPayload } from '../lib/prompts.mjs';
import { createApp } from '../server.mjs';
import { input,FakeProvider,fakeTools } from './fixtures.mjs';

const marker='SYNTHETIC_ATTEMPT_CONVERSATION';
const largeText=marker+'x'.repeat(128*1024);
const payload={model:'saved-model',messages:[{role:'user',content:largeText}],tools:[{name:'web_search',max_uses:4}],diagnostics:{previous_message_id:null}};
const response={id:'msg_saved',stop_reason:'end_turn',content:[{type:'text',text:largeText}]};
function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'atlas-attempt-queries-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return store;
}
function insert(store,projectId,{stageId='jurisdiction',state='settled',searchCap=4,usage=null,actual=1000,request=payload,reply=response,batchId=null,nextPoll=0}={}){
  const id=randomUUID(),time=new Date().toISOString();
  store.db.prepare('INSERT INTO attempts(id,project_id,stage_id,mode,model_key,state,reserve,actual,payload,response,usage,created,updated,search_cap,batch_id,next_poll) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,stageId,'batch','research',state,5000,actual,JSON.stringify(request),JSON.stringify(reply),JSON.stringify(usage),time,time,searchCap,batchId,nextPoll);
  return id;
}
function watchDecodes(t){
  const decoded=[],parse=JSON.parse;
  t.mock.method(JSON,'parse',(value,...args)=>{
    if(typeof value==='string'&&value.includes(marker))decoded.push(value);
    return parse(value,...args);
  });
  return decoded;
}
function guardMetadataQueries(t,store){
  const prepare=store.db.prepare;
  t.mock.method(store.db,'prepare',sql=>{
    const columns=sql.match(/\bSELECT\s+(.+?)\s+FROM\s+attempts\b/is)?.[1];
    if(columns&&/(^\s*\*|\b(payload|response)\b)/.test(columns))assert.match(sql,/\bWHERE\s+id\s*=\s*\?/i,'Large columns must be fetched by request ID.');
    return prepare.call(store.db,sql);
  });
}
async function settle(engine){
  for(let i=0;i<100;i++){
    if(!engine.running.size&&!engine.polling.size&&!engine.applying.size)return;
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error('Engine did not settle.');
}

test('summaries, usage totals and reservations never decode stored conversations',t=>{
  const s=fixture(t),p=s.create(input);
  for(let i=0;i<12;i++)insert(s,p.id,{stageId:i%2?'chat':'jurisdiction'});
  insert(s,p.id,{stageId:'jurisdiction',usage:{server_tool_use:{web_search_requests:3,web_fetch_requests:2}}});
  const pending=insert(s,p.id,{stageId:'verification',state:'unknown',usage:{server_tool_use:{web_search_requests:1,web_fetch_requests:1}}});
  insert(s,p.id,{stageId:'chat',state:'pending',searchCap:20,usage:{server_tool_use:{web_search_requests:20,web_fetch_requests:20}}});
  s.beginTool(pending,'read','read_source');
  const expected=s.attempts(p.id).map(({payload,response,...a})=>a),decoded=watchDecodes(t);
  guardMetadataQueries(t,s);
  t.mock.method(s,'attempts',()=>assert.fail('A metadata read decoded project history.'));
  assert.deepEqual(s.attemptSummaries(p.id),expected);
  assert.deepEqual(s.attemptSummary(pending),expected.find(a=>a.id===pending));
  assert.equal(s.attemptSummary('missing'),null);
  assert.ok(s.attemptSummaries(p.id,{researchOnly:true}).every(a=>a.stage_id!=='chat'));
  assert.equal(s.attemptSummaries(p.id,{stageId:'verification'}).length,1);
  const current=s.project(p.id);
  assert.equal(current.searches,4);assert.equal(current.reads,4);
  assert.equal(current.cost,.015);assert.equal(current.reserved,.01);
  assert.equal(s.reservedSearches(p.id),4);
  assert.deepEqual(s.stageUsage(p.id,'verification'),{searches:1,reads:2,reservedSearches:4});
  assert.equal(remainingSearches(s,current,'verification'),LIMITS.verificationSearches-5);
  // This runs the budget check under BEGIN IMMEDIATE with the large history present.
  const a=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:{tools:[{name:'web_search',max_uses:2}]},reserve:10});
  assert.equal(a.search_cap,2);assert.equal(s.reservedSearches(p.id),6);
  assert.equal(decoded.length,0);
});

test('an attempt lookup and a stage continuation decode only the selected request',t=>{
  const s=fixture(t),p=s.create(input),other=s.create({...input,name:'Other project'});
  for(let i=0;i<16;i++)insert(s,p.id,{stageId:i%2?'chat':'jurisdiction'});
  const target=insert(s,p.id,{stageId:'jurisdiction'});insert(s,other.id,{stageId:'jurisdiction'});
  const decoded=watchDecodes(t);
  t.mock.method(s,'attempts',()=>assert.fail('A direct read decoded project history.'));
  const a=s.attempt(target);
  assert.deepEqual(a.payload,payload);assert.deepEqual(a.response,response);
  assert.equal(decoded.length,2);assert.equal(s.attempt('missing'),null);
  decoded.length=0;
  assert.deepEqual(s.latestAttemptPayload(p.id,'jurisdiction'),payload);
  assert.equal(decoded.length,1);
  assert.equal(s.latestAttemptPayload(p.id,'review'),null);
  assert.equal(s.previousMessageId(p.id,'jurisdiction'),'msg_saved');
  s.updateStage(p.id,'jurisdiction',{messages:payload.messages});
  decoded.length=0;
  const next=researchPayload(s,s.project(p.id),s.stage(p.id,'jurisdiction'));
  assert.equal(next.model,'saved-model');assert.deepEqual(next.tools,payload.tools);
  // One stage history and one original payload, without sibling requests or responses.
  assert.equal(decoded.length,2);
});

test('ticks decode no history for finished projects and stop rewriting canceled projects',async t=>{
  const s=fixture(t),engine=new Engine(s,new FakeProvider(),()=>null,{autoStart:false,tools:fakeTools(s)});
  t.after(()=>engine.close());
  for(const status of ['complete','canceled','attention']){
    const p=s.create({...input,name:status});
    for(let i=0;i<12;i++)insert(s,p.id,{stageId:i%2?'chat':'jurisdiction'});
    if(status==='attention')insert(s,p.id,{state:'unknown'});
    s.updateProject(p.id,{status,cancel_requested:status!=='complete'});
  }
  const canceling=s.create({...input,name:'Canceling'});
  insert(s,canceling.id,{state:'pending',batchId:'msgbatch_pending',nextPoll:Date.now()+60000});
  s.updateProject(canceling.id,{status:'canceling',cancel_requested:true});
  const decoded=watchDecodes(t),changes=s.db.prepare('SELECT total_changes() n').get().n;
  guardMetadataQueries(t,s);
  t.mock.method(s,'attempts',()=>assert.fail('A tick decoded project history.'));
  t.mock.method(s,'attempt',()=>assert.fail('An idle tick loaded a full request.'));
  t.mock.method(s,'list',()=>assert.fail('A tick loaded reports and project totals.'));
  for(let i=0;i<3;i++)await engine.tick();
  assert.equal(decoded.length,0);
  assert.equal(s.db.prepare('SELECT total_changes() n').get().n,changes);
  // Cancellation still transitions once the last pending request settles.
  for(const a of s.attemptSummaries(canceling.id))s.updateAttempt(a.id,{state:'settled',applied:1});
  await engine.tick();assert.equal(s.project(canceling.id).status,'canceled');
  const after=s.db.prepare('SELECT total_changes() n').get().n;
  await engine.tick();assert.equal(s.db.prepare('SELECT total_changes() n').get().n,after);
});

test('terminal projects still apply received research, with decoding deferred until a worker is free',async t=>{
  const s=fixture(t),engine=new Engine(s,new FakeProvider(),()=>null,{autoStart:false,tools:fakeTools(s)});
  t.after(()=>engine.close());
  const p=s.create(input);
  for(let i=0;i<12;i++)insert(s,p.id,{stageId:i%2?'chat':'jurisdiction'});
  const id=insert(s,p.id,{state:'received'});insert(s,p.id,{stageId:'chat',state:'received'});
  s.updateProject(p.id,{status:'canceled',cancel_requested:true});
  const applied=[],decoded=watchDecodes(t);
  t.mock.method(engine,'apply',async a=>{applied.push(a);s.updateAttempt(a.id,{state:'settled',applied:1});});
  engine.running.add('busy-1');engine.running.add('busy-2');
  await engine.tick();assert.equal(decoded.length,0);assert.equal(applied.length,0);
  engine.running.clear();await engine.tick();await settle(engine);
  assert.equal(applied.length,1);assert.equal(applied[0].id,id);
  assert.deepEqual(applied[0].payload,payload);assert.deepEqual(applied[0].response,response);
  assert.equal(decoded.length,2);assert.equal(s.project(p.id).status,'canceled');
});

test('legacy search caps are backfilled once without changing requests, charges or reservations',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'atlas-search-cap-upgrade-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let s=new Store(dir);t.after(()=>s.close());
  const p=s.create(input);
  for(const state of ['dispatching','pending','unknown','received','settled','errored'])insert(s,p.id,{stageId:'verification',state});
  insert(s,p.id,{stageId:'chat',state:'unknown'});
  insert(s,p.id,{stageId:'contacts',state:'pending',request:{messages:payload.messages},searchCap:0});
  const before=s.db.prepare('SELECT id,payload,response,actual,reserve,created,updated FROM attempts ORDER BY rowid').all();
  s.db.exec('ALTER TABLE attempts DROP COLUMN search_cap');s.close();
  const decoded=watchDecodes(t);s=new Store(dir);
  assert.equal(decoded.length,0);
  assert.deepEqual(s.db.prepare('SELECT id,payload,response,actual,reserve,created,updated FROM attempts ORDER BY rowid').all(),before);
  assert.equal(s.reservedSearches(p.id),12);assert.equal(s.stageUsage(p.id,'verification').reservedSearches,12);
  assert.throws(()=>s.reserve(p.id,'verification',{mode:'batch',modelKey:'review',payload:{tools:[{name:'web_search',max_uses:4}]},reserve:1}),/SEARCH_BUDGET/);
  const rows=s.db.prepare('SELECT id,search_cap FROM attempts ORDER BY rowid').all();
  s.close();s=new Store(dir);
  assert.deepEqual(s.db.prepare('SELECT id,search_cap FROM attempts ORDER BY rowid').all(),rows);
  assert.equal(s.reservedSearches(p.id),12);
});

test('project GET returns attempt metadata without decoding large research or chat requests',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'atlas-attempt-http-'));
  const app=await createApp({dataDir:dir,port:0,worker:false,provider:new FakeProvider()});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const s=app.store,p=s.create(input);
  for(let i=0;i<24;i++)insert(s,p.id,{stageId:i%2?'chat':'jurisdiction'});
  s.updateProject(p.id,{status:'complete'});
  const expected=s.attemptSummaries(p.id),decoded=watchDecodes(t);
  guardMetadataQueries(t,s);
  t.mock.method(s,'attempts',()=>assert.fail('Project GET decoded project history.'));
  const result=await fetch(app.url+'/api/projects/'+p.id);
  assert.equal(result.status,200);
  const detail=await result.json();
  assert.deepEqual(detail.attempts,expected);assert.equal(detail.project.cost,.024);
  assert.equal(decoded.length,0);assert.ok(!JSON.stringify(detail).includes(marker));
});
