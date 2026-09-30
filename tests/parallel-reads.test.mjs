import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { ResearchTools,TOOL_DEFS } from '../lib/research-tools.mjs';
import { LIMITS } from '../lib/config.mjs';
import { input,FakeProvider } from './fixtures.mjs';

const read=(id,url)=>({type:'tool_use',id,name:'read_source',input:{url:'https://example.com/'+url}});
const document=url=>({url,type:'text/html',modified:'',buffer:Buffer.from('<title>'+url+'</title><p>Exact saved evidence for '+url+'</p>')});
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}throw new Error('Work did not reach the expected boundary.');}
function fixture(t,fetchImpl){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-parallel-')),s=new Store(dir),tools=new ResearchTools(s,{fetchImpl}),engine=new Engine(s,new FakeProvider(),()=>true,{autoStart:false,tools}),p=s.create(input);
  t.after(async()=>{await engine.close();s.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-parallel-')));rmSync(dir,{recursive:true,force:true});});
  function attempt(calls,stage='codes'){
    const a=s.reserve(p.id,stage,{mode:'realtime',modelKey:'research',reserve:1,payload:{tools:TOOL_DEFS,messages:[{role:'user',content:'Synthetic parallel reads'}]}});
    s.updateAttempt(a.id,{state:'received',response:{stop_reason:'tool_use',content:[{type:'redacted_thinking',data:'opaque-signature'},...calls]}});return s.attempt(a.id);
  }
  return {s,tools,engine,p,attempt};
}

test('source reads overlap in bounded pairs, commit in order and retain failed siblings',async t=>{
  const pending=new Map();let active=0,maximum=0;
  const {s,engine,p,attempt}=fixture(t,url=>new Promise((resolve,reject)=>{active++;maximum=Math.max(maximum,active);pending.set(url.split('/').at(-1),{ok:()=>{active--;resolve(document(url));},fail:()=>{active--;reject(new Error('Synthetic access gap'));}});}));
  const a=attempt([read('a','a'),read('b','b'),read('c','c'),read('d','d')]),work=engine.apply(a);
  await until(()=>pending.size===2);assert.equal(s.project(p.id).reads,2);
  pending.get('b').ok();await new Promise(r=>setImmediate(r));assert.equal(s.sources(p.id).length,0);
  pending.get('a').ok();await until(()=>pending.size===4);assert.deepEqual(s.sources(p.id).map(x=>[x.id,x.url.split('/').at(-1)]),[['S1','a'],['S2','b']]);
  pending.get('d').ok();pending.get('c').fail();await work;
  assert.equal(maximum,2);assert.equal(s.project(p.id).reads,4);assert.equal(s.sources(p.id).length,3);
  const messages=s.stage(p.id,'codes').messages;assert.equal(messages[1].content[0].data,'opaque-signature');
  assert.deepEqual(messages[2].content.map(x=>x.tool_use_id),['a','b','c','d']);assert.equal(messages[2].content[2].is_error,true);assert.ok(!messages[2].content[3].is_error);
  await engine.apply(s.attempt(a.id));assert.equal(pending.size,4);
});

test('simultaneous stages cannot overspend the final project read slot',async t=>{
  const seen=[];let release;
  const {s,engine,p,attempt}=fixture(t,url=>{seen.push(url);return new Promise(r=>{release=()=>r(document(url));});});
  const prior=attempt([]);for(let i=0;i<99;i++)s.beginTool(prior.id,'prior'+i,'read_source');s.updateAttempt(prior.id,{state:'settled',applied:1});
  const a=attempt([read('one','one'),read('two','two')]),b=attempt([read('three','three')],'contacts');
  const work=Promise.all([engine.apply(a),engine.apply(b)]);await until(()=>seen.length===1);assert.equal(s.project(p.id).reads,100);release();await work;
  assert.equal(seen.length,1);assert.equal(s.project(p.id).reads,100);assert.equal(s.sources(p.id).length,1);
  assert.ok(s.tool(a.id,'two').result.is_error);assert.ok(s.tool(b.id,'three').result.is_error);
});

test('verification reserves its last read and cancellation stops subsequent pairs',async t=>{
  const seen=[];
  const first=fixture(t,async url=>{seen.push(url);return document(url);});
  const old=first.attempt([],'verification');for(let i=0;i<LIMITS.verificationReads-1;i++)first.s.beginTool(old.id,'old'+i,'read_source');first.s.updateAttempt(old.id,{state:'settled',applied:1});
  await first.engine.apply(first.attempt([read('a','a'),read('b','b')],'verification'));
  assert.equal(seen.length,1);assert.equal(first.s.stageUsage(first.p.id,'verification').reads,LIMITS.verificationReads);
  const releases=[],second=fixture(t,url=>new Promise(r=>releases.push(()=>r(document(url)))));
  const a=second.attempt([read('a','a'),read('b','b'),read('c','c')]),work=second.engine.apply(a);
  await until(()=>releases.length===2);second.s.updateProject(second.p.id,{cancel_requested:true,status:'canceled'});releases.forEach(r=>r());await work;
  assert.equal(releases.length,2);assert.equal(second.s.project(second.p.id).reads,2);assert.equal(second.s.sources(second.p.id).length,2);assert.ok(second.s.tool(a.id,'c').result.is_error);
});

test('duplicate document fetches share in-flight work and failed downloads can be retried',async t=>{
  let count=0,release;
  const {tools}=fixture(t,url=>{count++;return new Promise(r=>{release=()=>r(document(url));});});
  const one=tools.prepareRead({url:'https://example.com/shared'}),two=tools.prepareRead({url:'https://example.com/shared',offset:5});
  await until(()=>Boolean(release));assert.equal(count,1);release();const results=await Promise.all([one,two]);assert.notEqual(results[0].details.text,results[1].details.text);
  let failed=0;tools.fetch=async url=>{if(!failed++)throw new Error('Synthetic failure');return document(url);};
  await assert.rejects(tools.document('https://example.com/retry'));await tools.document('https://example.com/retry');assert.equal(failed,2);
});

test('progress updates remain barriers between source reads',async t=>{
  let current;
  const {s,engine,p,attempt}=fixture(t,async url=>{
    if(url.endsWith('/second'))assert.equal(s.tool(current.id,'progress').result.is_error,undefined);
    return document(url);
  });
  const quote='Exact saved evidence for https://example.com/first';
  current=attempt([read('first','first'),{type:'tool_use',id:'progress',name:'save_progress',input:{brief:'The first saved source was read before this progress update.',claims:[{claim:'Synthetic source read.',sourceId:'S1',quote,pageOrSection:'Test'}],questions:[]}},read('second','second')]);
  current.payload.tools.push({name:'save_progress'});await engine.apply(current);
  assert.equal(s.stage(p.id,'codes').checkpoint.claims[0].sourceId,'S1');assert.equal(s.sources(p.id).length,2);
});
