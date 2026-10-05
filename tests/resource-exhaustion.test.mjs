import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Engine,roundLimitFor} from '../lib/engine.mjs';
import {LIMITS,MODELS} from '../lib/config.mjs';
import {Anthropic,providerError,validateCapabilities} from '../lib/provider.mjs';
import {ResearchTools,oversizedDocument,captureSearchSources} from '../lib/research-tools.mjs';
import {addDocument} from '../lib/documents.mjs';
import {input,FakeProvider,fakeTools} from './fixtures.mjs';

const usage={input_tokens:100,output_tokens:100,server_tool_use:{web_search_requests:0}};
const stages=['jurisdiction','contacts','codes','verification','review'];
function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-exhausted-')),store=new Store(dir),provider=new FakeProvider(),engine=new Engine(store,provider,()=>true,{autoStart:false,tools:fakeTools(store)}),project=store.create(input);
  t.after(async()=>{await engine.close();store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-exhausted-')));rmSync(dir,{recursive:true,force:true});});
  return {store,provider,engine,project,dir};
}
const ready=(store,projectId,stageId)=>{for(const id of stages){if(id===stageId)break;store.updateStage(projectId,id,{status:'complete',output:'Saved stage.'});}};
const rows=(store,projectId,resource,stageId)=>store.diagnostics(projectId).filter(d=>d.event==='resource.exhausted'&&d.details.resource===resource&&(!stageId||d.stage_id===stageId));
const textOnly=()=>({id:'msg_text',stop_reason:'end_turn',usage,content:[{type:'text',text:'Next I will keep looking.'}]});
const readCall=(extra)=>({id:'msg_read',stop_reason:'tool_use',usage,content:[{type:'tool_use',id:'tool_read',name:'read_source',input:{url:'https://city.example.gov/code',...extra}}]});

test('a spent round budget stops each stage with an identifiable row',async t=>{
  const {store:s,engine:e,project:p}=fixture(t);
  for(const stageId of stages){
    ready(s,p.id,stageId);
    s.updateStage(p.id,stageId,{status:'queued',rounds:roundLimitFor(stageId)});
    s.updateProject(p.id,{status:'queued'});
    await e.dispatch(p.id,stageId);
    const row=rows(s,p.id,'rounds',stageId).find(d=>d.details.outcome==='stopped');
    assert.ok(row,stageId);
    assert.equal(row.details.limit,roundLimitFor(stageId));
    assert.equal(row.details.used,roundLimitFor(stageId));
    assert.equal(s.stage(p.id,stageId).status,'partial');
    assert.ok(s.diagnostics(p.id).some(d=>d.event==='stage.changed'&&d.stage_id===stageId&&d.details.to==='partial'));
  }
});

test('active time stops the four real-time research stages and leaves the final report running',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  for(const stageId of ['jurisdiction','contacts','codes','verification']){
    ready(s,p.id,stageId);
    s.updateProject(p.id,{status:'queued',active_ms:LIMITS.activeMs,mode:'realtime'});
    s.updateStage(p.id,stageId,{status:'queued'});
    await e.dispatch(p.id,stageId);
    const row=rows(s,p.id,'active_time',stageId)[0];
    assert.equal(row.details.outcome,'stopped');
    assert.equal(row.details.scope,'project');
    assert.equal(row.details.limit,LIMITS.activeMs);
    assert.equal(row.details.used,LIMITS.activeMs);
    assert.equal(s.stage(p.id,stageId).status,'partial');
  }
  ready(s,p.id,'review');
  s.updateProject(p.id,{status:'queued',active_ms:LIMITS.activeMs});
  s.updateStage(p.id,'review',{status:'queued'});
  await e.dispatch(p.id,'review');
  assert.equal(rows(s,p.id,'active_time','review').length,0);
  assert.equal(provider.calls.length,1);
});

test('an input ceiling stops each stage, including a non-finite count',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  provider.count=async()=>LIMITS.input+1;
  for(const stageId of stages){
    ready(s,p.id,stageId);
    s.updateProject(p.id,{status:'queued'});
    s.updateStage(p.id,stageId,{status:'queued',rounds:0});
    await e.dispatch(p.id,stageId);
    const row=rows(s,p.id,'input_tokens',stageId).find(d=>d.details.outcome==='stopped');
    assert.ok(row,stageId);
    assert.equal(row.details.limit,LIMITS.input);
    assert.equal(row.details.used,LIMITS.input+1);
    assert.equal(row.details.characterBudget,stageId==='review'?LIMITS.reviewEvidence/3:30000);
    assert.equal(s.stage(p.id,stageId).status,'partial');
    assert.ok(s.diagnostics(p.id).some(d=>d.event==='context.rebuilt'&&d.stage_id===stageId));
  }
  const q=s.create(input);
  provider.count=async()=>Number.NaN;
  await e.dispatch(q.id,'contacts');
  ready(s,q.id,'contacts');
  s.updateProject(q.id,{status:'queued'});
  s.updateStage(q.id,'contacts',{status:'queued'});
  await e.dispatch(q.id,'contacts');
  const missing=rows(s,q.id,'input_tokens','contacts').find(d=>d.details.outcome==='stopped');
  assert.equal(missing.details.used,null);
  assert.equal(missing.details.limit,LIMITS.input);
  assert.equal(missing.details.characterBudget,100000);
  assert.ok(!s.diagnostics(q.id).some(d=>d.event==='context.rebuilt'));
});

test('the last allowed request is completion-only, and a fifth checkpoint restart is too',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  for(const stageId of ['jurisdiction','review']){
    ready(s,p.id,stageId);
    s.updateProject(p.id,{status:'queued'});
    s.updateStage(p.id,stageId,{status:'queued',rounds:roundLimitFor(stageId)-1});
    await e.dispatch(p.id,stageId);
    const row=rows(s,p.id,'rounds',stageId).find(d=>d.details.outcome==='degraded');
    assert.equal(row.details.used,roundLimitFor(stageId)-1);
    assert.equal(row.details.limit,roundLimitFor(stageId));
    assert.equal(row.attempt_id,s.attempts(p.id).filter(a=>a.stage_id===stageId).at(-1).id);
  }
  provider.count=async payload=>payload.messages.length>1?LIMITS.input+1:5000;
  provider.response=()=>({id:'msg_done',stop_reason:'tool_use',usage,content:[{type:'tool_use',id:'finish',name:'finish_research',input:{brief:'Saved source S1 establishes the synthetic adoption for this fixture.',coverage:{jurisdiction:'supported',contacts:'unresolved',codes:'unresolved',process:'unresolved'}}}]});
  const r=s.create(input);
  await e.dispatch(r.id,'jurisdiction');
  s.updateStage(r.id,'jurisdiction',{context_resets:LIMITS.contextResets,status:'queued'});
  s.updateProject(r.id,{status:'queued'});
  await e.dispatch(r.id,'jurisdiction');
  const restart=rows(s,r.id,'checkpoint_restarts','jurisdiction').find(d=>d.details.outcome==='degraded');
  assert.equal(restart.details.limit,LIMITS.contextResets);
  assert.equal(restart.details.used,LIMITS.contextResets+1);
  assert.ok(s.diagnostics(r.id).some(d=>d.event==='context.checkpoint'));
});

test('a shrunken evidence package that still sends records the input degrade',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  await e.dispatch(p.id,'jurisdiction');
  provider.count=async payload=>payload.messages.length>1?LIMITS.checkpointInput:5000;
  s.updateStage(p.id,'jurisdiction',{status:'queued'});
  s.updateProject(p.id,{status:'queued'});
  await e.dispatch(p.id,'jurisdiction');
  const row=rows(s,p.id,'input_tokens','jurisdiction').find(d=>d.details.outcome==='degraded');
  assert.equal(row.details.limit,LIMITS.checkpointInput);
  assert.equal(row.details.used,LIMITS.checkpointInput);
  assert.equal(row.details.usedAfter,5000);
  assert.equal(row.details.characterBudget,80000);
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='context.rebuilt'&&d.stage_id==='jurisdiction'));
});

test('output truncation grants one recovery and the next cutoff stops the stage',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  provider.response=()=>({stop_reason:'max_tokens',usage:{input_tokens:100,output_tokens:LIMITS.output},content:[{type:'text',text:'Partial findings.'}]});
  await e.dispatch(p.id,'jurisdiction');
  const granted=rows(s,p.id,'output_recoveries','jurisdiction')[0];
  assert.equal(granted.details.outcome,'degraded');
  assert.equal(granted.details.used,1);
  assert.equal(granted.details.limit,1);
  assert.deepEqual(granted.details.output_tokens,{used:LIMITS.output,limit:LIMITS.output});
  assert.equal(granted.attempt_id,s.attempts(p.id)[0].id);
  await e.dispatch(p.id,'jurisdiction');
  const stopped=rows(s,p.id,'output_tokens','jurisdiction').find(d=>d.details.outcome==='stopped');
  assert.equal(stopped.details.used,LIMITS.output);
  assert.equal(stopped.details.limit,LIMITS.output);
  assert.equal(s.stage(p.id,'jurisdiction').status,'partial');
  ready(s,p.id,'review');
  s.updateStage(p.id,'review',{status:'queued',recoveries:1});
  s.updateProject(p.id,{status:'queued'});
  provider.response=()=>({stop_reason:'max_tokens',usage:{input_tokens:100,output_tokens:1200},content:[{type:'text',text:'Partial report.'}]});
  await e.dispatch(p.id,'review');
  const review=rows(s,p.id,'output_tokens','review').find(d=>d.details.outcome==='stopped');
  assert.equal(review.details.used,1200);
  assert.equal(review.details.limit,LIMITS.reviewOutput);
});

test('two coverage follow-ups stop the stage',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  provider.response=textOnly;
  for(const stageId of ['jurisdiction','codes','verification']){
    ready(s,p.id,stageId);
    s.updateProject(p.id,{status:'queued'});
    s.updateStage(p.id,stageId,{status:'queued',rounds:0,continuations:0,messages:[]});
    for(let n=0;n<3;n++)await e.dispatch(p.id,stageId);
    const row=rows(s,p.id,'continuations',stageId).find(d=>d.details.outcome==='stopped');
    assert.equal(row.details.used,2);
    assert.equal(row.details.limit,2);
    assert.equal(s.stage(p.id,stageId).continuations,2);
    assert.equal(s.stage(p.id,stageId).status,'partial');
  }
});

test('a rejected completion on the last request records the round budget',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  s.updateStage(p.id,'codes',{rounds:LIMITS.rounds-1});
  provider.response=()=>({id:'msg_bad',stop_reason:'tool_use',usage,content:[{type:'tool_use',id:'finish',name:'finish_research',input:{brief:'Too short.',coverage:{jurisdiction:'supported',contacts:'supported',codes:'supported',process:'supported'}}}]});
  await e.dispatch(p.id,'codes');
  const row=rows(s,p.id,'rounds','codes').find(d=>d.details.outcome==='stopped');
  assert.equal(row.details.used,LIMITS.rounds);
  assert.equal(row.details.limit,LIMITS.rounds);
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='tool.failed'&&d.stage_id==='codes'));
});

test('search reserve records which cap, how many are used, and how many are reserved',async t=>{
  const {store:s,engine:e,project:p}=fixture(t);
  const settled=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:{tools:[{name:'web_search',max_uses:0}]},reserve:1});
  s.updateAttempt(settled.id,{state:'settled',applied:1,usage:{server_tool_use:{web_search_requests:76}}});
  const held=s.reserve(p.id,'contacts',{mode:'realtime',modelKey:'research',payload:{tools:[{name:'web_search',max_uses:3}]},reserve:1});
  assert.equal(s.attempt(held.id).state,'dispatching');
  const real=s.reserve.bind(s);
  s.reserve=(id,stage,req)=>real(id,stage,{...req,payload:{...req.payload,tools:[...(req.payload.tools||[]).filter(tool=>tool.name!=='web_search'),{name:'web_search',max_uses:4}]}});
  await e.dispatch(p.id,'jurisdiction');
  const projectCap=rows(s,p.id,'searches','jurisdiction').find(d=>d.details.outcome==='stopped');
  assert.equal(projectCap.details.scope,'project');
  assert.equal(projectCap.details.limit,LIMITS.searches);
  assert.equal(projectCap.details.used,76);
  assert.equal(projectCap.details.reserved,3);
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='search.request_blocked'&&d.stage_id==='jurisdiction'));
  const q=s.create(input);
  ready(s,q.id,'verification');
  const stageSpend=s.reserve(q.id,'verification',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
  s.updateAttempt(stageSpend.id,{state:'settled',applied:1,usage:{server_tool_use:{web_search_requests:14}}});
  s.updateProject(q.id,{status:'queued'});
  await e.dispatch(q.id,'verification');
  const stageCap=rows(s,q.id,'searches','verification').find(d=>d.details.outcome==='stopped');
  assert.equal(stageCap.details.scope,'stage');
  assert.equal(stageCap.details.limit,LIMITS.verificationSearches);
  assert.equal(stageCap.details.used,14);
  assert.equal(stageCap.details.reserved,0);
});

test('omitted or lowered search and fetch allowances degrade the next request',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  const spent=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(spent.id,{state:'settled',applied:1,usage:{server_tool_use:{web_search_requests:LIMITS.searches}}});
  ready(s,p.id,'contacts');
  s.updateStage(p.id,'contacts',{status:'queued'});
  s.updateProject(p.id,{status:'queued'});
  await e.dispatch(p.id,'contacts');
  const omitted=rows(s,p.id,'searches','contacts').find(d=>d.details.outcome==='degraded');
  assert.equal(omitted.details.scope,'request');
  assert.equal(omitted.details.pool,'project');
  assert.equal(omitted.details.limit,LIMITS.searches);
  assert.equal(omitted.details.used,LIMITS.searches);
  assert.equal(omitted.details.reserved,0);
  assert.ok(!provider.calls.at(-1).tools.some(tool=>tool.name==='web_search'));
  const lowered=s.create(input);
  const partial=s.reserve(lowered.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(partial.id,{state:'settled',applied:1,usage:{server_tool_use:{web_search_requests:78}}});
  ready(s,lowered.id,'codes');
  s.updateStage(lowered.id,'codes',{status:'queued'});
  s.updateProject(lowered.id,{status:'queued'});
  await e.dispatch(lowered.id,'codes');
  const reduced=rows(s,lowered.id,'searches','codes').find(d=>d.details.outcome==='degraded');
  assert.equal(reduced.details.pool,'project');
  assert.equal(reduced.details.used,78);
  assert.equal(provider.calls.at(-1).tools.find(tool=>tool.name==='web_search').max_uses,2);
  const fetched=s.create(input);
  const reads=s.reserve(fetched.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(reads.id,{state:'settled',applied:1,usage:{server_tool_use:{web_fetch_requests:LIMITS.reads}}});
  s.updateProject(fetched.id,{status:'queued'});
  await e.dispatch(fetched.id,'jurisdiction');
  const fetchRow=rows(s,fetched.id,'fetches','jurisdiction').find(d=>d.details.outcome==='degraded');
  assert.equal(fetchRow.details.scope,'request');
  assert.equal(fetchRow.details.pool,'project');
  assert.equal(fetchRow.details.limit,LIMITS.reads);
  assert.equal(fetchRow.details.used,LIMITS.reads);
  assert.ok(!provider.calls.at(-1).tools.some(tool=>tool.name==='web_fetch'));
  const check=s.create(input);
  ready(s,check.id,'verification');
  const stageReads=s.reserve(check.id,'verification',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
  s.updateAttempt(stageReads.id,{state:'settled',applied:1,usage:{server_tool_use:{web_search_requests:14,web_fetch_requests:18}}});
  s.updateProject(check.id,{status:'queued'});
  await e.dispatch(check.id,'verification');
  const stageSearch=rows(s,check.id,'searches','verification').find(d=>d.details.outcome==='degraded');
  const stageFetch=rows(s,check.id,'fetches','verification').find(d=>d.details.outcome==='degraded');
  assert.equal(stageSearch.details.pool,'stage');
  assert.equal(stageSearch.details.limit,LIMITS.verificationSearches);
  assert.equal(stageSearch.details.used,14);
  assert.equal(stageFetch.details.pool,'stage');
  assert.equal(stageFetch.details.limit,LIMITS.verificationReads);
  assert.equal(stageFetch.details.used,18);
});

test('provider search and fetch denials name the request allowance',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  const reader=new ResearchTools(s);
  e.tools=Object.assign(fakeTools(s),{captureFetches:(...args)=>reader.captureFetches(...args)});
  provider.response=()=>({id:'msg_denied',stop_reason:'tool_use',usage,content:[
    {type:'web_search_tool_result',tool_use_id:'srv',content:{type:'web_search_tool_result_error',error_code:'max_uses_exceeded'}},
    {type:'web_fetch_tool_result',tool_use_id:'fetch',content:{type:'web_fetch_tool_result_error',error_code:'max_uses_exceeded'}},
    {type:'tool_use',id:'finish',name:'finish_research',input:{brief:'Saved source S1 establishes the synthetic adoption for this fixture.',coverage:{jurisdiction:'supported',contacts:'unresolved',codes:'unresolved',process:'unresolved'}}},
  ]});
  await e.dispatch(p.id,'jurisdiction');
  const search=rows(s,p.id,'searches','jurisdiction').find(d=>d.details.outcome==='refused');
  const fetch=rows(s,p.id,'fetches','jurisdiction').find(d=>d.details.outcome==='refused');
  assert.equal(search.details.scope,'request');
  assert.equal(search.details.limit,LIMITS.searchesPerRequest);
  assert.equal(search.details.used,LIMITS.searchesPerRequest);
  assert.equal(fetch.details.scope,'request');
  assert.equal(fetch.details.limit,LIMITS.fetchesPerRequest);
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='search.failed'));
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='fetch.failed'));
  captureSearchSources(s,p.id,{content:[{type:'web_search_tool_result',content:{type:'web_search_tool_result_error',error_code:'max_uses_exceeded'}}]},{stageId:'chat',attemptId:'chat-attempt',maxUses:4});
  assert.equal(rows(s,p.id,'searches','chat').length,0);
});

test('project and evidence-check read caps refuse the call and leave the stage open',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  const spent=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(spent.id,{state:'settled',applied:1,usage:{server_tool_use:{web_fetch_requests:LIMITS.reads}}});
  provider.response=()=>readCall();
  await e.dispatch(p.id,'jurisdiction');
  const projectCap=rows(s,p.id,'reads','jurisdiction').find(d=>d.details.outcome==='refused'&&d.details.scope==='project');
  assert.equal(projectCap.details.limit,LIMITS.reads);
  assert.equal(projectCap.details.used,LIMITS.reads);
  assert.equal(projectCap.details.tool,'read_source');
  assert.equal(s.stage(p.id,'jurisdiction').status,'queued');
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='tool.failed'&&d.details.tool==='read_source'));
  const check=s.create(input);
  ready(s,check.id,'verification');
  const stageSpend=s.reserve(check.id,'verification',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
  s.updateAttempt(stageSpend.id,{state:'settled',applied:1,usage:{server_tool_use:{web_fetch_requests:LIMITS.verificationReads}}});
  s.updateProject(check.id,{status:'queued'});
  await e.dispatch(check.id,'verification');
  const stageCap=rows(s,check.id,'reads','verification').find(d=>d.details.scope==='stage');
  assert.equal(stageCap.details.outcome,'refused');
  assert.equal(stageCap.details.limit,LIMITS.verificationReads);
  assert.equal(stageCap.details.used,LIMITS.verificationReads);
  assert.equal(stageCap.details.tool,'read_source');
  const located=s.create(input);
  const again=s.reserve(located.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(again.id,{state:'settled',applied:1,usage:{server_tool_use:{web_fetch_requests:LIMITS.reads}}});
  e.tools=new ResearchTools(s,{fetchImpl:async()=>{throw new Error('should not fetch');}});
  provider.response=()=>({id:'msg_geo',stop_reason:'tool_use',usage,content:[{type:'tool_use',id:'geo',name:'locate_address',input:{}}]});
  s.updateProject(located.id,{status:'queued'});
  await e.dispatch(located.id,'jurisdiction');
  const geo=rows(s,located.id,'reads','jurisdiction').find(d=>d.details.tool==='locate_address');
  assert.equal(geo.details.scope,'project');
  assert.equal(geo.details.outcome,'refused');
  assert.equal(geo.details.limit,LIMITS.reads);
});

test('a document over 50 MB is refused with the byte cap',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  e.tools=new ResearchTools(s,{fetchImpl:async()=>{throw oversizedDocument(LIMITS.documentBytes+8);}});
  provider.response=()=>readCall();
  await e.dispatch(p.id,'jurisdiction');
  const row=rows(s,p.id,'document_bytes','jurisdiction')[0];
  assert.equal(row.details.outcome,'refused');
  assert.equal(row.details.limit,LIMITS.documentBytes);
  assert.equal(row.details.used,LIMITS.documentBytes+8);
  assert.equal(row.details.tool,'read_source');
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='tool.failed'));
  const header=oversizedDocument(LIMITS.documentBytes+1),stream=oversizedDocument(LIMITS.documentBytes+2,LIMITS.documentBytes,true);
  assert.match(header.message,/50 MB reading limit/);
  assert.equal(stream.message,'Source exceeds the document size limit.');
  assert.equal(header.exhausted.used,LIMITS.documentBytes+1);
  await assert.rejects(addDocument(s,e.tools,p.id,{name:'huge.bin',buffer:Buffer.allocUnsafe(LIMITS.documentBytes+1)}),/50 MB or less/);
  const upload=s.diagnostics(p.id).find(d=>d.event==='resource.exhausted'&&d.details.resource==='document_bytes'&&d.stage_id==null);
  assert.equal(upload.details.used,LIMITS.documentBytes+1);
  assert.equal(upload.details.outcome,'refused');
});

test('clipped packages, briefs, checkpoints, reads, links, and saved text are recorded only when something is dropped',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  s.source(p.id,{url:'https://example.com/long',title:'Long ordinance',text:'Adoption clause. '.repeat(10000),readFull:true});
  ready(s,p.id,'contacts');
  s.updateStage(p.id,'jurisdiction',{output:'x'.repeat(25000),status:'complete'});
  s.updateStage(p.id,'contacts',{status:'queued'});
  s.updateProject(p.id,{status:'queued'});
  await e.dispatch(p.id,'contacts');
  const jurisdiction=rows(s,p.id,'stage_brief_characters','contacts').find(d=>d.details.field==='jurisdiction');
  assert.equal(jurisdiction.details.limit,20000);
  assert.equal(jurisdiction.details.used,25000);
  assert.equal(jurisdiction.details.outcome,'clipped');
  ready(s,p.id,'verification');
  s.updateStage(p.id,'codes',{status:'complete',output:'z'.repeat(90000)});
  s.updateProject(p.id,{status:'queued'});
  s.updateStage(p.id,'verification',{status:'queued',checkpoint:{brief:'y'.repeat(30000),claims:[],questions:[],sources:[],observations:[]}});
  await e.dispatch(p.id,'verification');
  const evidence=rows(s,p.id,'evidence_characters','verification')[0];
  assert.equal(evidence.details.outcome,'clipped');
  assert.equal(evidence.details.limit,100000);
  assert.ok(evidence.details.used>evidence.details.limit);
  assert.ok(evidence.details.excerpted>=1);
  const brief=rows(s,p.id,'stage_brief_characters','verification').find(d=>d.details.field==='stage_brief'&&d.details.sourceStage==='codes');
  assert.equal(brief.details.limit,LIMITS.stageBriefChars);
  assert.ok(brief.details.used>LIMITS.stageBriefChars);
  const checkpoint=rows(s,p.id,'stage_brief_characters').find(d=>d.details.field==='checkpoint'&&d.details.limit===24000);
  assert.ok(checkpoint);
  assert.ok(checkpoint.details.used>24000);
  const html='<title>City</title><p>Permit records.</p>'+Array.from({length:80},(_,n)=>`<a href="/doc/${n}">Adoption document ${n}</a>`).join('');
  e.tools=new ResearchTools(s,{fetchImpl:async url=>({url,buffer:Buffer.from(html),type:'text/html',modified:''})});
  provider.response=()=>readCall({length:90000});
  const readProject=s.create(input);
  await e.dispatch(readProject.id,'jurisdiction');
  const length=rows(s,readProject.id,'read_characters','jurisdiction')[0];
  const links=rows(s,readProject.id,'page_links','jurisdiction').find(d=>d.details.limit===LIMITS.pageLinks);
  assert.equal(length.details.outcome,'clipped');
  assert.equal(length.details.limit,LIMITS.pageChars);
  assert.equal(length.details.used,90000);
  assert.equal(links.details.used,80);
  assert.equal(links.details.outcome,'clipped');
  e.tools.pdf=async()=>({numPages:20,getPage:async()=>({getTextContent:async()=>({items:[{str:'Page text',hasEOL:true}]})}),loadingTask:{destroy:async()=>{}}});
  e.tools.fetch=async url=>({url,buffer:Buffer.from('%PDF-fake'),type:'application/pdf',modified:''});
  provider.response=()=>readCall({pageCount:12});
  const pdfProject=s.create(input);
  await e.dispatch(pdfProject.id,'jurisdiction');
  const pages=rows(s,pdfProject.id,'pdf_pages','jurisdiction')[0];
  assert.equal(pages.details.limit,8);
  assert.equal(pages.details.used,12);
  assert.equal(pages.details.outcome,'clipped');
  const saved=s.source(p.id,{url:'https://example.com/register',title:'Register',text:'q'.repeat(180001),readFull:true},{stageId:'codes'});
  assert.equal(saved.text.length,180000);
  const register=rows(s,p.id,'saved_source_characters','codes')[0];
  assert.equal(register.details.limit,180000);
  assert.equal(register.details.used,180001);
  assert.equal(register.details.outcome,'clipped');
  s.source(p.id,{url:'https://example.com/chat-page',title:'Chat',text:'q'.repeat(180001),readFull:true},{stageId:'chat'});
  assert.equal(rows(s,p.id,'saved_source_characters','chat').length,0);
  const uploaded=await addDocument(s,new ResearchTools(s),p.id,{name:'notes.txt',type:'text/plain',buffer:Buffer.from('n'.repeat(LIMITS.uploadChars+25))});
  assert.equal(uploaded.text.length,LIMITS.uploadChars);
  const uploadClip=s.diagnostics(p.id).find(d=>d.event==='resource.exhausted'&&d.details.resource==='saved_source_characters'&&d.details.limit===LIMITS.uploadChars);
  assert.equal(uploadClip.details.used,LIMITS.uploadChars+25);
  assert.equal(uploadClip.details.outcome,'clipped');
});

test('a fetched page clipped by the provider or the source register is recorded',async t=>{
  const {store:s,project:p}=fixture(t),reader=new ResearchTools(s);
  await reader.captureFetches(p.id,{content:[{type:'web_fetch_tool_result',content:{type:'web_fetch_result',url:'https://example.com/clipped',truncated:true,content:{type:'document',title:'Clipped',source:{type:'text',media_type:'text/plain',data:'Short page.'}}}}]},{stageId:'codes',attemptId:'attempt-fetch'});
  const providerClip=rows(s,p.id,'fetch_content_tokens','codes').find(d=>d.details.limit===LIMITS.fetchContentTokens);
  assert.equal(providerClip.details.outcome,'clipped');
  assert.equal(providerClip.attempt_id,'attempt-fetch');
  await reader.captureFetches(p.id,{content:[{type:'web_fetch_tool_result',content:{type:'web_fetch_result',url:'https://example.com/long-fetch',content:{type:'document',title:'Long',source:{type:'text',media_type:'text/plain',data:'f'.repeat(180001)}}}}]},{stageId:'contacts'});
  const register=rows(s,p.id,'fetch_content_tokens','contacts')[0];
  assert.equal(register.details.limit,180000);
  assert.equal(register.details.used,180001);
  assert.equal(register.details.outcome,'clipped');
  await reader.captureFetches(p.id,{content:[{type:'web_fetch_tool_result',content:{type:'web_fetch_result',url:'https://example.com/chat-fetch',truncated:true,content:{type:'document',title:'Chat',source:{type:'text',media_type:'text/plain',data:'chat'}}}}]},{stageId:'chat'});
  assert.equal(rows(s,p.id,'fetch_content_tokens','chat').length,0);
});

test('provider output ceiling, spend, stream deadline, and batch retention stop the stage',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  provider.preflight=async(mode,_context,requirements)=>{validateCapabilities([{id:MODELS.research.id,max_tokens:1000},{id:MODELS.review.id,max_tokens:128000}],{mode,...requirements});};
  await e.dispatch(p.id,'jurisdiction');
  const ceiling=rows(s,p.id,'provider_output_ceiling','jurisdiction')[0];
  assert.equal(ceiling.details.outcome,'stopped');
  assert.equal(ceiling.details.limit,LIMITS.output);
  assert.equal(ceiling.details.used,1000);
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='request.preflight_failed'));
  assert.equal(s.stage(p.id,'jurisdiction').status,'queued');
  const spent=s.create(input);
  provider.preflight=async()=>{};
  provider.message=async()=>{throw providerError({error:{type:'invalid_request_error',message:'You have reached your specified workspace API usage limits.'}},{status:400});};
  s.updateProject(spent.id,{status:'queued'});
  await e.dispatch(spent.id,'jurisdiction');
  const spend=rows(s,spent.id,'provider_spend','jurisdiction')[0];
  assert.equal(spend.details.outcome,'stopped');
  assert.equal(spend.attempt_id,s.attempts(spent.id)[0].id);
  assert.ok(!Object.hasOwn(spend.details,'used'));
  assert.ok(s.diagnostics(spent.id).some(d=>d.event==='request.failed'&&d.details.error.code==='spend_limit'));
  const batch=s.create({...input,mode:'batch'});
  const attempt=s.reserve(batch.id,'codes',{mode:'batch',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(attempt.id,{state:'pending',batch_id:'msgbatch_fixture'});
  s.db.prepare('UPDATE attempts SET created=? WHERE id=?').run('2020-01-01T00:00:00.000Z',attempt.id);
  await e.pollBatch('msgbatch_fixture',batch.id);
  const retention=rows(s,batch.id,'batch_retention','codes')[0];
  assert.equal(retention.details.outcome,'stopped');
  assert.equal(retention.details.limit,LIMITS.batchRetentionMs);
  assert.ok(retention.details.used>LIMITS.batchRetentionMs);
  assert.equal(retention.attempt_id,attempt.id);
  const blocked=s.create({...input,mode:'batch'});
  const pending=s.reserve(blocked.id,'contacts',{mode:'batch',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(pending.id,{state:'pending',batch_id:'msgbatch_spend'});
  provider.poll=async()=>{throw providerError({error:{type:'invalid_request_error',message:'monthly spend cap reached'}},{status:400});};
  await e.pollBatch('msgbatch_spend',blocked.id);
  assert.equal(rows(s,blocked.id,'provider_spend','contacts')[0].details.outcome,'stopped');
  const imported=s.create({...input,mode:'batch'});
  const errored=s.reserve(imported.id,'codes',{mode:'batch',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(errored.id,{state:'pending',batch_id:'msgbatch_import'});
  await e.importBatch(imported.id,'msgbatch_import',[{custom_id:errored.id,result:{type:'errored',error:{type:'error',error:{type:'invalid_request_error',message:'You have reached your specified API usage limits'}}}}]);
  assert.equal(rows(s,imported.id,'provider_spend','codes')[0].details.outcome,'stopped');
  assert.ok(s.diagnostics(imported.id).some(d=>d.event==='batch.result_failed'));
});

test('a started stream that hits the deadline records elapsed time and an estimate before retrying',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-exhausted-stream-')),store=new Store(dir);
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const fetchImpl=async(url,options)=>{
    const pathName=new URL(url).pathname;
    if(pathName==='/v1/models')return json({data:[{id:MODELS.research.id,max_tokens:128000},{id:MODELS.review.id,max_tokens:128000}],has_more:false});
    if(pathName.endsWith('/count_tokens'))return json({input_tokens:100});
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_deadline","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      options.signal.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});
    }}),{headers:{'content-type':'text/event-stream'}});
  };
  const provider=new Anthropic(()=>'sk-ant-test',{fetchImpl,streamDeadlineMs:60}),engine=new Engine(store,provider,()=>'sk-ant-test',{autoStart:false,tools:fakeTools(store)}),project=store.create(input);
  t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
  await engine.dispatch(project.id,'jurisdiction');
  const row=rows(store,project.id,'stream_deadline','jurisdiction')[0];
  assert.equal(row.details.outcome,'stopped');
  assert.equal(row.details.limit,60);
  assert.ok(row.details.used>=0&&row.details.used<5000);
  const attempt=store.attemptSummaries(project.id)[0];
  assert.equal(row.attempt_id,attempt.id);
  assert.equal(attempt.state,'errored');assert.equal(attempt.estimated,1);assert.equal(attempt.actual,attempt.reserve);
  assert.deepEqual(attempt.usage,{input_tokens:1,output_tokens:0});assert.ok(attempt.next_poll>Date.now());
  assert.equal(store.project(project.id).reserved,0);assert.equal(store.project(project.id).status,'waiting');
  assert.equal(store.stage(project.id,'jurisdiction').status,'queued');
  const failed=store.diagnostics(project.id).find(d=>d.event==='request.failed');assert.ok(failed);
  assert.equal(store.project(project.id).active_ms,failed.details.durationMs);assert.ok(failed.details.durationMs>=row.details.used);
});
