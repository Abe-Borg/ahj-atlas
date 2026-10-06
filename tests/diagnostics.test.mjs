import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {Anthropic} from '../lib/provider.mjs';
import {createApp} from '../server.mjs';
import {diagnosticReport,DIAGNOSTIC_LIMIT,redactText,responseSummary} from '../lib/diagnostics.mjs';
import {REPORT_SCHEMA} from '../lib/prompts.mjs';
import {REPORT_WIRE_SCHEMA,encodeReport,decodeReport} from '../lib/report-format.mjs';
import {input,report,nfpaReport,evidenceText,FakeProvider,fakeTools} from './fixtures.mjs';

function clean(dir){assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-diagnostics-')));rmSync(dir,{recursive:true,force:true});}
function temp(){return mkdtempSync(path.join(os.tmpdir(),'ahj-diagnostics-'));}
function storeFixture(t){const dir=temp(t),store=new Store(dir);t.after(()=>{store.close();clean(dir);});return store;}

test('compact report preserves every report field and evidence while shrinking the grammar',()=>{
  const original=report();original.gaps=[{question:'Confirm boundary',why:'Unresolved',contact:'Agency',nextStep:'Ask the official office'}];
  assert.deepEqual(decodeReport(encodeReport(original)),original);
  assert.ok(JSON.stringify(REPORT_WIRE_SCHEMA).length<JSON.stringify(REPORT_SCHEMA).length/3);
});
test('compact report rejects empty, duplicate, shifted and invalid rows',()=>{
  const cases=[[w=>w.items.find(r=>r.section==='codes').fields.pop(),/codes row had missing or incorrectly ordered fields \(9 of 10\)/],[w=>w.items.push(w.items.find(r=>r.section==='jurisdiction')),/repeated its jurisdiction row/],[w=>w.items.push(w.items.find(r=>r.section==='coverage')),/repeated its coverage row/],[w=>w.items.find(r=>r.section==='codes').fields[9]='wrong-status',/codes row had an invalid evidence status/],[w=>w.items[0].evidence=[{sourceId:'S1'}],/jurisdiction row had invalid evidence/],[w=>w.items[0].section='__proto__',/unknown section/],[w=>w.items=[],/no rows/]];
  for(const [mutate,message] of cases){const wire=encodeReport(report());mutate(wire);assert.throws(()=>decodeReport(wire),message);}
});
test('compact report leaves an omitted single-row section for validation to rebuild, and lists those rows first',()=>{
  const wire=encodeReport(report());assert.deepEqual(wire.items.slice(0,2).map(r=>r.section),['jurisdiction','coverage']);
  for(const section of ['jurisdiction','coverage']){const partial=structuredClone(wire);partial.items=partial.items.filter(r=>r.section!==section);const decoded=decodeReport(partial);assert.ok(!Object.hasOwn(decoded,section));assert.equal(decoded.codes[0].edition,'2021');}
});

test('report enum capitalization is normalized without changing identifiers, prose or the response',()=>{
  const original=nfpaReport(),wire=encodeReport(original);
  for(const row of wire.items){
    row.section=row.section.toUpperCase();
    if(row.section==='JURISDICTION')row.fields[2]='VERIFIED';
    if(['CODES','FIRESTANDARDS'].includes(row.section)){row.fields[3]='DiReCt';row.fields[9]='VeRiFiEd';}
    if(row.section==='FIRESTANDARDS')row.fields[10]='APPLICABLE';
  }
  const before=structuredClone(wire);assert.deepEqual(decodeReport(wire),original);assert.deepEqual(wire,before);
  for(const mutate of [w=>w.items[0].section='Jurisdictions',w=>w.items.push({...w.items[0],section:'jurisdiction'}),w=>w.items.find(r=>r.section==='CODES').fields[3]='Directly',w=>w.items.find(r=>r.section==='CODES').fields[9]='Verified-ish']){
    const invalid=structuredClone(wire);mutate(invalid);assert.throws(()=>decodeReport(invalid));
  }
});

test('cache diagnostics expose allowlisted reasons separately from actual usage',()=>{
  const base={id:'msg_fixture',usage:{cache_read_input_tokens:123}};
  assert.equal(responseSummary(base).cacheDiagnostics.state,'not_returned');
  assert.equal(responseSummary({...base,diagnostics:null}).cacheDiagnostics.state,'no_divergence_or_no_comparison');
  assert.equal(responseSummary({...base,diagnostics:{cache_miss_reason:null}}).cacheDiagnostics.state,'pending');
  for(const reason of ['model_changed','system_changed','tools_changed','messages_changed','previous_message_not_found','unavailable']){
    const summary=responseSummary({...base,diagnostics:{raw:'PRIVATE',cache_miss_reason:{type:reason,cache_missed_input_tokens:456,prompt:'PRIVATE',detail:'PRIVATE'}}});
    assert.deepEqual(summary.cacheDiagnostics,{state:'reported',reason,estimatedMissedInputTokens:456});assert.equal(summary.usage.cache_read_input_tokens,123);assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
  }
  const unknown=responseSummary({...base,diagnostics:{cache_miss_reason:{type:'PRIVATE',cache_missed_input_tokens:'PRIVATE'}}});assert.deepEqual(unknown.cacheDiagnostics,{state:'unrecognized'});
});
test('a failed legacy report can resume with compact grammar without repeating completed research',async t=>{
  const s=storeFixture(t),p=s.create(input),provider=new FakeProvider(),engine=new Engine(s,provider,()=>true,{autoStart:false,tools:fakeTools(s)});t.after(()=>engine.close());
  s.source(p.id,{url:'https://example.com/adoption',title:'Fixture',text:evidenceText,readFull:true});
  for(const stage of s.stages(p.id))s.updateStage(p.id,stage.id,{status:stage.id==='review'?'blocked':'complete',output:'Saved research'});
  s.updateProject(p.id,{status:'attention',note:'The compiled grammar is too large.'});
  const old=s.reserve(p.id,'review',{mode:'realtime',modelKey:'review',payload:{model:'claude-opus-5-5',output_config:{format:{schema:REPORT_SCHEMA}}},reserve:100000});s.updateAttempt(old.id,{state:'errored',applied:1,request_id:'req_legacy'});
  await engine.resume(p.id,{});for(let i=0;i<100&&engine.running.size;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(provider.calls.length,1);assert.ok(provider.calls[0].output_config.format.schema.properties.items);assert.equal(s.project(p.id).status,'partial');assert.equal(s.project(p.id).report.codes[0].edition,'2021');assert.equal(s.attempt(old.id).request_id,'req_legacy');
});
test('diagnostic exports omit keys, raw prompts, project inputs, documents and thinking',t=>{
  const s=storeFixture(t),p=s.create({...input,address:'PRIVATE ADDRESS SENTINEL'}),key='sk-ant-private-test-key';
  const a=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:{model:'claude-sonnet-5',max_tokens:60000,messages:[{role:'user',content:'PRIVATE PROMPT SENTINEL '+key}],system:'PRIVATE SYSTEM SENTINEL',tools:[]},reserve:1000});
  s.updateAttempt(a.id,{state:'settled',response:{id:'msg_fixture',content:[{type:'thinking',thinking:'PRIVATE THINKING SENTINEL',signature:'PRIVATE SIGNATURE SENTINEL'},{type:'text',text:'PRIVATE RESPONSE SENTINEL'}],usage:{input_tokens:40,output_tokens:20}},request_id:'req_fixture'});
  s.source(p.id,{url:'https://example.com/',text:'PRIVATE DOCUMENT SENTINEL',readFull:true});
  s.event(p.id,'progress','Codes & standards: PRIVATE PROGRESS SENTINEL');
  s.diagnostic('test.failure',{projectId:p.id,level:'error',headers:{'x-api-key':key},messages:['PRIVATE LOG SENTINEL'],message:'Failure '+key+' Bearer credential-secret at https://user:pass@example.com/?token=other-secret',requestId:'req_fixture'});
  const exported=JSON.stringify(diagnosticReport(s,{projectId:p.id}));
  for(const secret of [key,'credential-secret','user:pass','other-secret','PRIVATE ADDRESS','PRIVATE PROMPT','PRIVATE SYSTEM','PRIVATE THINKING','PRIVATE SIGNATURE','PRIVATE RESPONSE','PRIVATE DOCUMENT','PRIVATE LOG','PRIVATE PROGRESS'])assert.ok(!exported.includes(secret),secret);
  assert.ok(exported.includes('Research progress note. Its text is omitted'));
  assert.ok(exported.includes('req_fixture'));assert.ok(exported.includes('maxOutputTokens'));assert.ok(exported.includes('input_tokens'));
  assert.ok(!redactText('C:\\Users\\PrivatePerson\\app\\server.mjs').includes('PrivatePerson'));
});
test('diagnostics persist, scope projects and keep a bounded event history',t=>{
  const dir=temp(t);let s=new Store(dir);const p=s.create(input),q=s.create(input);
  s.db.exec('BEGIN');const insert=s.db.prepare('INSERT INTO diagnostics(time,level,event,project_id,details) VALUES(?,?,?,?,?)');
  for(let i=0;i<DIAGNOSTIC_LIMIT+3;i++)insert.run(new Date().toISOString(),'info','fixture',q.id,'{}');s.db.exec('COMMIT');
  s.diagnostic('selected.project',{projectId:p.id});s.diagnostic('application.event');
  assert.equal(s.diagnostics().length,DIAGNOSTIC_LIMIT);s.close();s=new Store(dir);t.after(()=>{s.close();clean(dir);});
  assert.deepEqual(s.diagnostics(p.id).map(e=>e.event),['application.event','selected.project']);
});
test('grammar rejections retain request IDs, model settings, timing and safe error details',async()=>{
  const events=[],client=new Anthropic(()=>'sk-ant-do-not-record',{onDiagnostic:(event,details)=>events.push({event,...details}),fetchImpl:async()=>new Response(JSON.stringify({error:{type:'invalid_request_error',message:'The compiled grammar is too large, which would cause performance issues.'}}),{status:400,headers:{'request-id':'req_grammar'}})});
  await assert.rejects(client.message({model:'claude-opus-5-5',max_tokens:100000,output_config:{format:{type:'json_schema',schema:REPORT_WIRE_SCHEMA}},messages:[{role:'user',content:'PRIVATE PROMPT'}]},{context:{projectId:'project_fixture',stageId:'review',attemptId:'attempt_fixture'}}),e=>e.code==='schema_complexity'&&!e.ambiguous);
  const failed=events.find(e=>e.event==='stream.failed');assert.equal(failed.error.requestId,'req_grammar');assert.equal(failed.stageId,'review');assert.ok(failed.durationMs>=0);assert.ok(events[0].request.reportSchema.sha256);assert.ok(!JSON.stringify(events).includes('PRIVATE PROMPT'));assert.ok(!JSON.stringify(events).includes('sk-ant-'));
});
test('diagnostic endpoints require local mutation authorization and record browser failures safely',async t=>{
  const dir=temp(),app=await createApp({dataDir:dir,port:0,worker:false,provider:new FakeProvider()});t.after(async()=>{await app.close();clean(dir);});
  const state=await(await fetch(app.url+'/api/bootstrap')).json(),headers={'content-type':'application/json','x-app-token':state.token};
  assert.equal((await fetch(app.url+'/api/diagnostics',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(app.url+'/api/diagnostics')).status,404);
  assert.equal((await fetch(app.url+'/api/diagnostics/download')).status,403);
  assert.equal((await fetch(app.url+'/api/diagnostics/download',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  await fetch(app.url+'/api/diagnostics/client',{method:'POST',headers,body:JSON.stringify({message:'Browser failure sk-ant-private-key',location:'https://example.com/?key=secret'})});
  const result=await(await fetch(app.url+'/api/diagnostics',{method:'POST',headers,body:'{}'})).json();
  assert.equal(result.format,'ahj-atlas-diagnostics');assert.ok(result.events.some(e=>e.event==='browser.error'));assert.ok(Number.isFinite(result.application.resources.current.rssBytes));assert.deepEqual(Object.keys(result.starvation),['host','provider','allowances']);assert.ok(!JSON.stringify(result).includes('sk-ant-'));assert.ok(!JSON.stringify(result).includes(state.token));
  const download=await fetch(app.url+'/api/diagnostics/download',{headers:{'sec-fetch-site':'same-origin'}});assert.equal(download.status,200);assert.ok(download.headers.get('content-disposition').includes('attachment'));assert.equal((await download.json()).format,'ahj-atlas-diagnostics');
});
