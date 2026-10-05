import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Engine,roundLimitFor} from '../lib/engine.mjs';
import {LIMITS,FETCH_HISTORY_CHARS} from '../lib/config.mjs';
import {ProviderError} from '../lib/provider.mjs';
import {input,FakeProvider,fakeTools} from './fixtures.mjs';

const usage={input_tokens:100,output_tokens:100,server_tool_use:{web_search_requests:0}};
const response=(content,stop_reason='tool_use')=>({id:'msg_wrap_up',stop_reason,usage,content});
const finished=()=>response([{type:'tool_use',id:'finish',name:'finish_research',input:{brief:'S1 establishes the synthetic jurisdiction. Other assigned findings remain unresolved; confirm them with the responsible office.',coverage:{jurisdiction:'supported',contacts:'unresolved',codes:'unresolved',process:'unresolved'}}}]);
function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-completion-')),store=new Store(dir),provider=new FakeProvider(),tools=fakeTools(store),engine=new Engine(store,provider,()=>true,{autoStart:false,tools}),project=store.create({...input,discipline:'Architecture'});
  t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,provider,engine,project,tools};
}
async function nearingLimit(t,stageId='jurisdiction'){
  const f=fixture(t);await f.engine.dispatch(f.project.id,stageId);
  f.store.updateStage(f.project.id,stageId,{rounds:roundLimitFor(stageId)-2});
  return f;
}
function unchangedPrefix(payload,original,messages){
  for(const key of ['model','system','tools','thinking','output_config','cache_control'])assert.deepEqual(payload[key],original[key],key);
  assert.deepEqual(payload.messages.slice(0,messages.length),messages);
  assert.equal(payload.messages.length,messages.length+1);
  assert.equal(payload.messages.at(-1).role,'system');
  assert.match(payload.messages.at(-1).content,/Call finish_research now, by itself/);
  assert.ok(!payload.tool_choice);
}

for(const stageId of ['jurisdiction','contacts','codes','verification'])test(`${stageId} wraps up with the unchanged live prefix and completes there`,async t=>{
  const {store:s,provider,engine:e,project:p}=await nearingLimit(t,stageId);
  const original=structuredClone(provider.calls[0]),before=s.stage(p.id,stageId),first=s.attempts(p.id)[0];
  const history=structuredClone(before.messages);
  provider.response=finished;await e.dispatch(p.id,stageId);
  const payload=provider.calls.at(-1),stage=s.stage(p.id,stageId);
  unchangedPrefix(payload,original,history);
  assert.equal(history.at(-1).content[0].type,'tool_result');
  assert.match(JSON.stringify(payload.messages),/opaque-test-signature|opaque-test-source/);
  assert.equal(stage.status,'complete');assert.equal(stage.rounds,roundLimitFor(stageId)-1);
  assert.equal(stage.context_resets,before.context_resets);assert.equal(s.project(p.id).reserved,0);
  assert.deepEqual(s.attempt(first.id).response,first.response);
  assert.match(stage.output,/synthetic jurisdiction/);assert.equal(provider.calls.length,2);
});

test('wrap-up keeps a legacy model prefix and tool-only evidence that a reconstruction cannot supply',async t=>{
  const f=fixture(t),{store:s,provider,engine:e,project:p,tools}=f;
  const run=tools.run.bind(tools);tools.run=async(...args)=>({...await run(...args),text:'DECISIVE PASSAGE: this exception applies only after July 1.'});
  await e.dispatch(p.id,'jurisdiction');
  const first=s.attempts(p.id)[0],original={...first.payload,model:'claude-sonnet-5',system:[{type:'text',text:'Legacy system instructions',cache_control:{type:'ephemeral',ttl:'1h'}}]};
  s.db.prepare('UPDATE attempts SET payload=? WHERE id=?').run(JSON.stringify(original),first.id);
  s.updateStage(p.id,'jurisdiction',{rounds:LIMITS.rounds-2});const history=s.stage(p.id,'jurisdiction').messages;
  provider.response=finished;await e.dispatch(p.id,'jurisdiction');
  unchangedPrefix(provider.calls.at(-1),original,history);
  assert.match(JSON.stringify(provider.calls.at(-1).messages),/DECISIVE PASSAGE/);
  assert.ok(!s.sources(p.id)[0].text.includes('DECISIVE PASSAGE'));
});

for(const [name,nonFinish] of [
  ['text after exhausted follow-ups',()=>response([{type:'text',text:'The live evidence leaves an open question.'}],'end_turn')],
  ['another source read',()=>response([{type:'tool_use',id:'another_read',name:'read_source',input:{url:'https://example.com/adoption'}}])],
  ['save_progress',()=>response([{type:'tool_use',id:'progress',name:'save_progress',input:{brief:'A working brief with an unresolved contact.',claims:[],questions:['Confirm the assigned office.']}}])],
  ['a paused search',()=>response([{type:'server_tool_use',id:'pending_search',name:'web_search',input:{query:'authority'}}],'pause_turn')],
  ['a rejected finish',()=>response([{type:'tool_use',id:'bad_finish',name:'finish_research',input:{brief:'Too short',coverage:{}}}])],
  ['a truncated response after an earlier recovery',()=>response([{type:'text',text:'An incomplete working brief.'}],'max_tokens')],
])test(`wrap-up returning ${name} queues the finish-only fallback within the limit`,async t=>{
  const {store:s,provider,engine:e,project:p}=await nearingLimit(t);
  s.updateStage(p.id,'jurisdiction',{continuations:LIMITS.continuations,recoveries:1});
  provider.response=nonFinish;await e.dispatch(p.id,'jurisdiction');
  assert.equal(s.stage(p.id,'jurisdiction').status,'queued');assert.equal(s.stage(p.id,'jurisdiction').rounds,LIMITS.rounds-1);
  provider.response=finished;await e.dispatch(p.id,'jurisdiction');
  const payload=provider.calls.at(-1),stage=s.stage(p.id,'jurisdiction');
  assert.deepEqual(payload.tools.map(t=>t.name),['finish_research']);assert.equal(payload.messages.length,1);
  assert.match(payload.messages[0].content,/reserved completion request/);assert.match(payload.messages[0].content,/S1/);
  assert.ok(!JSON.stringify(payload).includes('opaque-test-signature'));assert.ok(!payload.tool_choice);
  assert.equal(stage.status,'complete');assert.equal(stage.rounds,LIMITS.rounds);assert.equal(provider.calls.length,3);
});

test('a non-finishing fallback cannot dispatch beyond the round limit',async t=>{
  const {store:s,provider,engine:e,project:p}=await nearingLimit(t);
  provider.response=()=>response([{type:'text',text:'An unresolved evidence question remains.'}],'end_turn');
  await e.dispatch(p.id,'jurisdiction');await e.dispatch(p.id,'jurisdiction');await e.dispatch(p.id,'jurisdiction');
  assert.equal(provider.calls.length,3);assert.equal(s.stage(p.id,'jurisdiction').rounds,LIMITS.rounds);
  assert.equal(s.stage(p.id,'jurisdiction').status,'partial');assert.ok(s.stage(p.id,'jurisdiction').checkpoint.sources.includes('S1'));
});

test('the evidence-check fallback completes inside its shorter six-round limit',async t=>{
  const {store:s,provider,engine:e,project:p}=await nearingLimit(t,'verification');
  provider.response=()=>response([{type:'text',text:'An evidence discrepancy remains unresolved.'}],'end_turn');
  await e.dispatch(p.id,'verification');assert.equal(s.stage(p.id,'verification').rounds,5);
  provider.response=finished;await e.dispatch(p.id,'verification');
  assert.deepEqual(provider.calls.at(-1).tools.map(t=>t.name),['finish_research']);
  assert.equal(s.stage(p.id,'verification').status,'complete');assert.equal(s.stage(p.id,'verification').rounds,6);
});

test('a rejected system-role note is inlined after tool results at the free count',async t=>{
  const {store:s,provider,engine:e,project:p}=await nearingLimit(t);
  const before=s.stage(p.id,'jurisdiction').messages,original=provider.calls[0],counts=[];
  provider.count=async payload=>{counts.push(structuredClone(payload));if(payload.messages.some(m=>m.role==='system'))throw new ProviderError("role 'system' is not supported on this model",{status:400});return 1500;};
  provider.response=finished;await e.dispatch(p.id,'jurisdiction');
  assert.equal(counts.length,2);unchangedPrefix(counts[0],original,before);
  const payload=provider.calls.at(-1),last=payload.messages.at(-1);
  assert.deepEqual(payload.messages.slice(0,-1),before.slice(0,-1));assert.equal(last.role,'user');
  assert.deepEqual(last.content.slice(0,-1),before.at(-1).content);assert.match(last.content.at(-1).text,/<system-reminder>.*finish_research/);
  assert.deepEqual(payload.system,original.system);assert.deepEqual(payload.tools,original.tools);
  assert.deepEqual(s.attempts(p.id).at(-1).payload,payload);assert.equal(provider.calls.length,2);
  assert.equal(s.stage(p.id,'jurisdiction').status,'complete');
});

for(const stop of ['tool_use','pause_turn'])test(`a ${stop} waiting on a server tool continues unchanged before fallback`,async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  const blocks=[{type:'redacted_thinking',data:'waiting-signature'},{type:'server_tool_use',id:'waiting',name:'web_search',input:{query:'authority'}},...(stop==='tool_use'?[{type:'tool_use',id:'read',name:'read_source',input:{url:'https://example.com/adoption'}}]:[])];
  provider.response=()=>response(blocks,stop);await e.dispatch(p.id,'jurisdiction');
  s.updateStage(p.id,'jurisdiction',{rounds:LIMITS.rounds-2});const before=s.stage(p.id,'jurisdiction').messages;
  provider.response=finished;await e.dispatch(p.id,'jurisdiction');
  const payload=provider.calls.at(-1);assert.deepEqual(payload.messages,before);assert.ok(!payload.tool_choice);
  assert.deepEqual(payload.tools,provider.calls[0].tools);assert.equal(s.stage(p.id,'jurisdiction').context_resets,0);
  assert.equal(s.stage(p.id,'jurisdiction').status,'complete');
});

test('pause_turn with completed server results also continues without a wrap-up note',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);
  provider.response=()=>response([{type:'server_tool_use',id:'done',name:'web_search',input:{query:'authority'}},{type:'web_search_tool_result',tool_use_id:'done',content:[]}],'pause_turn');
  await e.dispatch(p.id,'jurisdiction');s.updateStage(p.id,'jurisdiction',{rounds:LIMITS.rounds-2});
  const before=s.stage(p.id,'jurisdiction').messages;provider.response=finished;await e.dispatch(p.id,'jurisdiction');
  assert.deepEqual(provider.calls.at(-1).messages,before);assert.equal(s.stage(p.id,'jurisdiction').status,'complete');
});

for(const reason of ['input_context','search_allocation','fetched_content'])test(`${reason} during wrap-up retains fresh-context completion`,async t=>{
  const {store:s,provider,engine:e,project:p}=await nearingLimit(t);
  if(reason==='input_context')provider.count=async payload=>payload.messages.length>1?LIMITS.checkpointInput:1500;
  if(reason==='search_allocation'){
    const other=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:1});
    s.updateAttempt(other.id,{state:'settled',usage:{server_tool_use:{web_search_requests:LIMITS.searches-2}},applied:1});
  }
  if(reason==='fetched_content'){
    const messages=s.stage(p.id,'jurisdiction').messages;
    messages[1].content.push({type:'web_fetch_tool_result',tool_use_id:'large',content:{type:'web_fetch_result',url:'https://example.com/large',content:{type:'document',source:{type:'text',media_type:'text/plain',data:'x'.repeat(FETCH_HISTORY_CHARS+1)}}}});
    s.updateStage(p.id,'jurisdiction',{messages});
  }
  provider.response=finished;await e.dispatch(p.id,'jurisdiction');
  const payload=provider.calls.at(-1);assert.deepEqual(payload.tools.map(t=>t.name),['finish_research']);assert.equal(payload.messages.length,1);
  assert.equal(s.stage(p.id,'jurisdiction').status,'complete');assert.equal(s.stage(p.id,'jurisdiction').context_resets,1);
  assert.ok(s.diagnostics(p.id).some(d=>d.event==='context.checkpoint'&&d.details.reason===reason));
});

test('batch wrap-up preserves the prefix and completion applies when polled',async t=>{
  const {store:s,provider,engine:e,project:p}=fixture(t);s.updateProject(p.id,{mode:'batch'});
  await e.dispatch(p.id,'jurisdiction');const first=s.attempts(p.id)[0];await e.pollBatch(first.batch_id,p.id);
  s.updateStage(p.id,'jurisdiction',{rounds:LIMITS.rounds-2});const before=s.stage(p.id,'jurisdiction').messages;
  provider.response=finished;await e.dispatch(p.id,'jurisdiction');const wrap=s.attempts(p.id).at(-1);
  unchangedPrefix(wrap.payload,first.payload,before);assert.equal(s.stage(p.id,'jurisdiction').status,'waiting_batch');
  await e.pollBatch(wrap.batch_id,p.id);assert.equal(s.stage(p.id,'jurisdiction').status,'complete');
  assert.equal(s.stage(p.id,'jurisdiction').rounds,LIMITS.rounds-1);assert.equal(s.project(p.id).reserved,0);
});
