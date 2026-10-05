import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Anthropic, ProviderError } from '../lib/provider.mjs';
import { Engine } from '../lib/engine.mjs';
import { ProjectChat } from '../lib/chat.mjs';
import { Store } from '../lib/store.mjs';
import { costMicros, LIMITS } from '../lib/config.mjs';
import { diagnosticReport } from '../lib/diagnostics.mjs';
import { input, fakeTools } from './fixtures.mjs';

const partialUsage={input_tokens:100,output_tokens:0,cache_read_input_tokens:300,cache_creation_input_tokens:200,cache_creation:{ephemeral_5m_input_tokens:50,ephemeral_1h_input_tokens:150},server_tool_use:{web_search_requests:2}};
const start={type:'message_start',message:{id:'msg_partial',type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[],stop_reason:null,stop_sequence:null,usage:partialUsage}};
const text='Partial answer.';
const output=[{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}];
const dropped=[start,...output];
const complete=[...dropped,{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:16}},{type:'message_stop'}];
function stream(events){return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream','request-id':'req_partial'}});}
function fakeStreamProvider(events=dropped){
  let calls=0;
  const provider=new Anthropic(()=>'fake-unit-key',{fetchImpl:async url=>{
    assert.equal(new URL(url).pathname,'/v1/messages');calls++;
    const next=typeof events==='function'?events(calls):events;
    if(next instanceof Error)throw next;
    return next instanceof Response?next:stream(next);
  }});
  // Free preflight/counting are synthetic too; no endpoint can escape this fake fetch.
  provider.preflight=async()=>[];provider.count=async()=>1500;
  return {provider,calls:()=>calls};
}
function fixture(t,events){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-stream-failure-')),store=new Store(dir),fake=fakeStreamProvider(events);
  const tools=fakeTools(store),engine=new Engine(store,fake.provider,()=>true,{tools,autoStart:false});
  t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,engine,tools,...fake};
}
async function tick(engine){
  await engine.tick();
  for(let i=0;i<200;i++){
    if(!engine.running.size&&!engine.polling.size&&!engine.applying.size)return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Engine did not settle.');
}

test('a dropped started stream records partial billing and retries only after backoff',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const {store:s,engine:e,tools,calls}=fixture(t,n=>{clock+=1000;return n===1?dropped:complete;}),p=s.create(input);
  await tick(e);
  const attempt=s.attemptSummaries(p.id)[0],expected=costMicros({...partialUsage,output_tokens:4},'research');
  assert.equal(attempt.state,'errored');assert.equal(attempt.estimated,1);assert.equal(attempt.applied,1);
  assert.equal(attempt.actual,expected);assert.equal(attempt.request_id,'req_partial');assert.ok(attempt.charged_at);
  assert.deepEqual(attempt.usage,{...partialUsage,output_tokens:4});assert.equal(attempt.next_poll,clock+30000);
  assert.deepEqual(s.spending(),{today:expected/1e6,total:expected/1e6,pending:0});
  assert.equal(s.project(p.id).status,'waiting');assert.equal(s.project(p.id).reserved,0);
  assert.equal(s.project(p.id).active_ms,1000);
  assert.equal(s.stage(p.id,'jurisdiction').status,'queued');assert.deepEqual(s.stage(p.id,'jurisdiction').messages,[]);
  assert.match(s.events(p.id)[0].message,/Estimated cost: .*recorded automatically/);
  assert.equal(diagnosticReport(s).projects[0].attempts[0].estimated,true);assert.equal(tools.calls,0);
  await tick(e);assert.equal(calls(),1);
  clock+=29999;await tick(e);assert.equal(calls(),1);
  clock++;await tick(e);assert.equal(calls(),2);
  const success=s.attemptSummaries(p.id)[1];assert.equal(success.state,'settled');assert.equal(success.estimated,0);
  assert.equal(success.actual,costMicros({...partialUsage,output_tokens:16},'research'));assert.equal(s.project(p.id).reserved,0);
  assert.equal(s.project(p.id).active_ms,2000);
});

test('long failed streams consume active time and prevent a third research request',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const duration=30*60*1000;
  const {store:s,engine:e,calls}=fixture(t,()=>{clock+=duration;return dropped;}),p=s.create(input);
  await tick(e);
  assert.equal(s.project(p.id).active_ms,duration);assert.equal(s.attemptSummaries(p.id)[0].next_poll,clock+30000);
  await tick(e);assert.equal(calls(),1);assert.equal(s.project(p.id).active_ms,duration);
  clock+=30000;await tick(e);
  assert.equal(calls(),2);assert.equal(s.project(p.id).active_ms,2*duration);
  assert.equal(s.attemptSummaries(p.id)[1].next_poll,clock+60000);
  clock+=60000;await tick(e);
  assert.equal(calls(),2);assert.equal(s.attemptSummaries(p.id).length,2);assert.equal(s.project(p.id).reserved,0);
  assert.equal(s.stage(p.id,'jurisdiction').status,'partial');assert.match(s.stage(p.id,'jurisdiction').note,/active research time allowance/);
  const exhausted=s.diagnostics(p.id).find(d=>d.event==='resource.exhausted'&&d.details.resource==='active_time');
  assert.equal(exhausted.details.limit,LIMITS.activeMs);assert.equal(exhausted.details.used,2*duration);
  assert.equal(exhausted.details.outcome,'stopped');
});

test('a third consecutive started-stream failure blocks the stage with all costs estimated',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const {store:s,engine:e,calls}=fixture(t,dropped),p=s.create(input);
  await tick(e);assert.equal(s.attemptSummaries(p.id)[0].next_poll,clock+30000);
  clock+=30000;await tick(e);assert.equal(s.attemptSummaries(p.id)[1].next_poll,clock+60000);
  clock+=60000;await tick(e);
  assert.equal(calls(),3);assert.equal(s.stage(p.id,'jurisdiction').status,'blocked');assert.equal(s.project(p.id).status,'attention');
  assert.ok(s.attemptSummaries(p.id).every(a=>a.state==='errored'&&a.estimated===1&&a.actual>0));
  assert.equal(s.project(p.id).reserved,0);clock+=600000;await tick(e);assert.equal(calls(),3);
});

test('a drop before message_start retains the unknown charge and never retries',async t=>{
  for(const [name,events] of [['transport',new TypeError('fetch failed')],['empty stream',[]]])await t.test(name,async t=>{
    const {store:s,engine:e,calls}=fixture(t,events),p=s.create(input);
    await tick(e);await tick(e);
    const attempt=s.attemptSummaries(p.id)[0];
    assert.equal(calls(),1);assert.equal(attempt.state,'unknown');assert.equal(attempt.estimated,0);assert.equal(attempt.actual,0);
    assert.equal(s.project(p.id).reserved,attempt.reserve/1e6);assert.equal(s.project(p.id).status,'attention');
    assert.equal(s.stage(p.id,'jurisdiction').status,'blocked');await assert.rejects(e.resume(p.id,{}),/outstanding/);
  });
});

test('a transport drop retains already streamed characters and partial usage',async()=>{
  let drop;
  const body=new ReadableStream({start(controller){
    drop=()=>controller.error(new TypeError('synthetic network drop'));
    controller.enqueue(new TextEncoder().encode(dropped.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')));
  }});
  const {provider,calls}=fakeStreamProvider(new Response(body,{headers:{'content-type':'text/event-stream','request-id':'req_dropped'}}));
  await assert.rejects(provider.message({model:'claude-sonnet-5-5',max_tokens:60000,messages:[{role:'user',content:'Synthetic test.'}]},{onEvent:event=>{if(event.type==='content_block_delta')drop();}}),error=>{
    assert.equal(error.streamedCharacters,text.length);assert.deepEqual(error.partialUsage,partialUsage);
    assert.equal(error.requestId,'req_dropped');assert.equal(error.ambiguous,false);assert.equal(error.retryable,true);return true;
  });assert.equal(calls(),1);
});

test('a reported output count is retained when it exceeds the character estimate',async t=>{
  const events=[...dropped,{type:'message_delta',delta:{stop_reason:null},usage:{output_tokens:40}}];
  const {store:s,engine:e}=fixture(t,events),p=s.create(input);await tick(e);
  const attempt=s.attemptSummaries(p.id)[0];assert.equal(attempt.usage.output_tokens,40);
  assert.equal(attempt.actual,costMicros({...partialUsage,output_tokens:40},'research'));assert.equal(attempt.estimated,1);
});

test('a started stream without output falls back to its reservation',async t=>{
  const {store:s,engine:e}=fixture(t,[start]),p=s.create(input);await tick(e);
  const attempt=s.attemptSummaries(p.id)[0];assert.equal(attempt.actual,attempt.reserve);assert.equal(attempt.estimated,1);
  assert.deepEqual(attempt.usage,partialUsage);assert.equal(s.project(p.id).reserved,0);assert.equal(s.project(p.id).status,'waiting');
});

test('the estimated marker migrates existing attempts and persists after restart',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-stream-migration-'));let s=new Store(dir);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const p=s.create(input),old=s.reserve(p.id,'contacts',{mode:'realtime',modelKey:'research',payload:{},reserve:1000});
  s.updateAttempt(old.id,{state:'settled',actual:500,applied:1});
  s.db.exec('ALTER TABLE attempts DROP COLUMN estimated');s.close();s=new Store(dir);
  assert.equal(s.attemptSummary(old.id).estimated,0);assert.equal(s.attemptSummary(old.id).actual,500);
  const {provider}=fakeStreamProvider(dropped),engine=new Engine(s,provider,()=>true,{tools:fakeTools(s),autoStart:false});
  try{await tick(engine);}finally{await engine.close();}
  const failed=s.attemptSummaries(p.id).find(a=>a.state==='errored');assert.ok(failed);
  s.close();s=new Store(dir);
  assert.deepEqual(s.attemptSummary(failed.id),failed);assert.equal(s.project(p.id).reserved,0);
});

test('partial message_delta usage and generated thinking/tool JSON survive a lost stream',async()=>{
  const thinking='Thinking update.',json='{"url":"https://example.com/"',signature='opaque-signature';
  const events=[start,{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking}},
    {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature}},{type:'content_block_stop',index:0},
    {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool_partial',name:'read_source',input:{}}},
    {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:json}},
    {type:'message_delta',delta:{stop_reason:null},usage:{output_tokens:40,server_tool_use:{web_search_requests:3}}}];
  const {provider,calls}=fakeStreamProvider(events);
  await assert.rejects(provider.message({model:'claude-sonnet-5-5',max_tokens:60000,messages:[{role:'user',content:'Synthetic test.'}]}),error=>{
    assert.equal(error.streamedCharacters,thinking.length+json.length);assert.equal(error.partialUsage.output_tokens,40);
    assert.equal(error.partialUsage.input_tokens,100);assert.equal(error.partialUsage.cache_creation.ephemeral_1h_input_tokens,150);
    assert.equal(error.partialUsage.server_tool_use.web_search_requests,3);assert.equal(error.ambiguous,false);return true;
  });assert.equal(calls(),1);
});

test('chat settles a started failed stream, clears its draft, and permits a new reply',async t=>{
  for(const [mode,modelKey] of [['standard','research'],['opus','review']])await t.test(mode,async t=>{
    const {store:s,engine:e,provider,calls}=fixture(t,n=>n===1?dropped:complete),p=s.create(input);
    s.updateProject(p.id,{status:'complete'});
    const chat=new ProjectChat(s,provider,()=>true,e);t.after(()=>chat.close());
    chat.start(p.id,{clientId:randomUUID(),message:'Synthetic question.',mode});await chat.running.get(p.id).promise;
    const attempt=s.attemptSummaries(p.id)[0],turn=chat.view(p.id).turns[0];
    assert.equal(attempt.state,'errored');assert.equal(attempt.estimated,1);assert.equal(attempt.actual,costMicros({...partialUsage,output_tokens:4},modelKey));
    assert.equal(turn.status,'failed');assert.equal(turn.draft,'');assert.equal(turn.answer,'');assert.equal(turn.reserved,0);
    assert.equal(turn.cost,attempt.actual/1e6);assert.match(turn.note,/Estimated cost: .*recorded automatically.*Send a new message/);
    assert.match(s.events(p.id)[0].message,/Project chat: .*Estimated cost/);assert.equal(s.project(p.id).status,'complete');assert.equal(calls(),1);
    chat.start(p.id,{clientId:randomUUID(),message:'Try again.',mode});await chat.running.get(p.id).promise;
    assert.equal(chat.view(p.id).turns[1].status,'complete');assert.equal(calls(),2);assert.equal(s.project(p.id).reserved,0);
  });
});

test('batch ambiguity is unchanged even if an error carries partial stream usage',async t=>{
  const {store:s,engine:e,provider}=fixture(t),p=s.create({...input,mode:'batch'});
  provider.batch=async()=>{throw Object.assign(new ProviderError('Uncertain batch',{ambiguous:true}),{partialUsage,streamedCharacters:100});};
  await tick(e);const attempt=s.attemptSummaries(p.id)[0];
  assert.equal(attempt.state,'unknown');assert.equal(attempt.estimated,0);assert.equal(attempt.actual,0);
  assert.ok(s.project(p.id).reserved>0);assert.equal(s.project(p.id).status,'attention');
});
