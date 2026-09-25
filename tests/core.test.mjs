import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { costMicros, reserveMicros } from '../lib/config.mjs';
import { validateReport, researchPayload } from '../lib/prompts.mjs';
import { isPublicIP, validatePublicUrl, htmlText } from '../lib/research-tools.mjs';
import { ProviderError } from '../lib/provider.mjs';
import { input, evidenceText, report, FakeProvider, fakeTools } from './fixtures.mjs';

function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-')),store=new Store(dir);t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-test-')));rmSync(dir,{recursive:true,force:true});});return store;}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(engine){for(let i=0;i<150;i++){await wait(5);if(!engine.running.size&&!engine.polling.size&&!engine.applying.size)return;}throw new Error('Engine did not settle');}
async function runToReport(engine,store,id){for(let i=0;i<40;i++){await engine.tick();await settle(engine);const p=store.project(id);if(p.report)return p;if(['attention','budget','failed'].includes(p.status))throw new Error(p.note);}throw new Error('Report did not finish');}

test('cache-aware billing applies batch discount only to tokens',()=>{
  const u={input_tokens:100000,output_tokens:20000,cache_read_input_tokens:100000,cache_creation_input_tokens:999999,cache_creation:{ephemeral_5m_input_tokens:50000,ephemeral_1h_input_tokens:10000},server_tool_use:{web_search_requests:10}};
  assert.equal(costMicros(u,'research','realtime'),685000);assert.equal(costMicros(u,'research','batch'),392500);
  assert.equal(costMicros({cache_read_input_tokens:100000},'review'),20000);
});
test('continuing a completed report only reopens research for a substantive follow-up',async t=>{
  const s=setup(t),p=s.create(input),engine=new Engine(s,new FakeProvider(),()=>null,{autoStart:false});
  engine.tick=async()=>{};
  for(const stage of s.stages(p.id))s.updateStage(p.id,stage.id,{status:'complete'});
  await engine.resume(p.id,{clarification:'   \n  '});
  assert.ok(s.stages(p.id).filter(stage=>stage.id!=='review').every(stage=>stage.status==='complete'));
  assert.equal(s.stages(p.id).find(stage=>stage.id==='review').status,'queued');
  await engine.resume(p.id,{clarification:'Please investigate the unresolved fire district boundary.'});
  assert.ok(s.stages(p.id).every(stage=>stage.status==='queued'));
  assert.match(s.project(p.id).input.notes,/unresolved fire district boundary/);
});
test('atomic allowances include pending reservations and reserve final review',t=>{
  const s=setup(t),p=s.create({...input,budget:1});
  s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:{},reserve:600000});
  assert.throws(()=>s.reserve(p.id,'contacts',{mode:'realtime',modelKey:'research',payload:{},reserve:500000}),/PROJECT_BUDGET/);
  assert.equal(s.project(p.id).reserved,.6);
});
test('global search allocations are reserved across simultaneous stages',t=>{
  const s=setup(t),p=s.create(input),payload={tools:[{name:'web_search',max_uses:25}]};
  s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload,reserve:1000});
  assert.throws(()=>s.reserve(p.id,'codes',{mode:'batch',modelKey:'research',payload,reserve:1000}),/SEARCH_BUDGET/);
});
test('a prior-day batch recorded today counts toward today’s daily allowance',t=>{
  const s=setup(t);s.setSettings({dailyBudget:1});const p=s.create(input),a=s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload:{},reserve:800000});
  s.db.prepare('UPDATE attempts SET created=? WHERE id=?').run('2020-01-01T00:00:00.000Z',a.id);s.updateAttempt(a.id,{state:'settled',actual:800000});
  assert.throws(()=>s.reserve(p.id,'codes',{mode:'batch',modelKey:'research',payload:{},reserve:300000}),/DAILY_BUDGET/);
});
test('search discovery followed by repeated source reading preserves IDs and provenance',t=>{
  const s=setup(t),p=s.create(input),url='https://example.com/adoption';
  const found=s.source(p.id,{url,title:'Search',text:'Unretrieved secret adoption quotation.'});
  const read=s.source(p.id,{url,title:'Read',text:evidenceText,readFull:true});
  const later=s.source(p.id,{url,text:'Another genuine retrieved page.',readFull:true});
  s.source(p.id,{url,text:'This later search snippet must not become evidence.'});
  assert.equal(found.id,read.id);assert.equal(read.id,later.id);assert.equal(s.sources(p.id).length,1);
  assert.ok(!s.sources(p.id)[0].text.includes('secret'));assert.ok(!s.sources(p.id)[0].text.includes('later search snippet'));
  assert.ok(s.sources(p.id)[0].text.includes('Another genuine'));
});
test('validation downgrades fabricated citations, conditional jurisdiction, unknown editions, invented URLs and emails',()=>{
  const r=report(),sources=[{id:'S1',url:'https://example.com/adoption',text:evidenceText,read_full:true}];
  r.jurisdiction.evidence[0].quote='Invented jurisdiction quote';r.contacts[0].email='invented@example.com';r.codes[0].edition='Unknown';r.authorities[0].website='https://example.com/invented-path';
  const out=validateReport(r,sources);
  assert.equal(out.jurisdiction.status,'unverified');assert.equal(out.codes[0].status,'unverified');assert.equal(out.contacts[0].email,'');assert.equal(out.authorities[0].website,'');assert.ok(out.gaps.length>=2);
});
test('unknown code edition cannot yield a complete report without questions',()=>{
  const r=report();r.codes[0].edition='';r.codes[0].status='unverified';const out=validateReport(r,[{id:'S1',url:'https://example.com/adoption',text:evidenceText,read_full:true}]);assert.ok(out.gaps.some(g=>g.question.includes('Fixture Building Code')));
});
test('public URL reader rejects loopback, metadata and private targets before network access',async()=>{
  for(const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','172.16.1.1','192.168.1.2','::1','fc00::1','::ffff:7f00:1'])assert.equal(isPublicIP(ip),false,ip);
  assert.equal(isPublicIP('8.8.8.8'),true);assert.equal(isPublicIP('2606:4700:4700::1111'),true);
  for(const url of ['http://127.0.0.1/admin','file:///etc/passwd','https://user:pass@example.com','http://localhost/','https://example.com:444/'])await assert.rejects(validatePublicUrl(url));
});
test('HTML extraction removes active content while retaining source links',()=>{
  const r=htmlText('<title>Agency &amp; office</title><script>steal()</script><p>Adoption text.</p><a href="/codes">Codes</a>','https://example.com/');assert.equal(r.title,'Agency & office');assert.ok(!r.text.includes('steal'));assert.equal(r.links[0].url,'https://example.com/codes');
});
test('real-time workflow runs through tools and structured review without paid requests',async t=>{
  const s=setup(t),provider=new FakeProvider(),tools=fakeTools(s),e=new Engine(s,provider,()=>true,{tools,autoStart:false}),p=s.create(input);t.after(()=>e.close());
  const result=await runToReport(e,s,p.id);assert.equal(result.status,'partial');assert.equal(result.report.codes[0].edition,'2021');assert.equal(result.report.contacts[0].email,'plans@example.com');assert.equal(result.sourceCount,1);assert.ok(result.cost>0);assert.equal(result.reserved,0);assert.equal(tools.calls,4);
  const continuation=provider.calls.find(c=>c.messages.length>1);assert.equal(continuation.messages[1].content[0].data,'opaque-test-signature');assert.equal(continuation.messages[1].content[1].content[0].encrypted_content,'opaque-test-source');
});
test('batch workflow continues tools through subsequent batches and imports exact IDs once',async t=>{
  const s=setup(t),provider=new FakeProvider(),e=new Engine(s,provider,()=>true,{tools:fakeTools(s),pollMs:0,autoStart:false}),p=s.create({...input,mode:'batch'});t.after(()=>e.close());
  const result=await runToReport(e,s,p.id);assert.equal(result.status,'partial');assert.ok(provider.batches.size>=7);assert.equal(result.reserved,0);
  const first=[...provider.batches.keys()][0],before=result.cost;await e.importBatch(p.id,first,(await provider.results(first)).data);assert.equal(s.project(p.id).cost,before);
});
test('ambiguous submit retains reservation and never auto-resubmits',async t=>{
  const s=setup(t),provider=new FakeProvider();let calls=0;provider.batch=async()=>{calls++;throw new ProviderError('Timeout',{ambiguous:true});};
  const e=new Engine(s,provider,()=>true,{autoStart:false}),p=s.create({...input,mode:'batch'});t.after(()=>e.close());await e.tick();await settle(e);await e.tick();await settle(e);
  assert.equal(calls,1);assert.equal(s.project(p.id).status,'attention');assert.ok(s.project(p.id).reserved>0);await assert.rejects(e.resume(p.id,{}),/outstanding/);
});
test('cancellation imports completed batch charges without running more tools',async t=>{
  const s=setup(t),provider=new FakeProvider();provider.autoEnd=false;const tools=fakeTools(s),e=new Engine(s,provider,()=>true,{tools,pollMs:0,autoStart:false}),p=s.create({...input,mode:'batch'});t.after(()=>e.close());
  await e.tick();await settle(e);await e.cancel(p.id);await settle(e);await e.tick();await settle(e);assert.equal(s.project(p.id).status,'canceled');assert.ok(s.project(p.id).cost>0);assert.equal(s.project(p.id).reserved,0);assert.equal(tools.calls,0);assert.equal(provider.batches.size,1);
});
test('per-attempt application lock prevents duplicate slow tool execution',async t=>{
  const s=setup(t),provider=new FakeProvider(),p=s.create(input),tools=fakeTools(s),run=tools.run.bind(tools);tools.run=async(...args)=>{await wait(50);return run(...args);};
  const e=new Engine(s,provider,()=>true,{tools,autoStart:false});t.after(()=>e.close());const a=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:researchPayload(s,p,s.stage(p.id,'jurisdiction')),reserve:100000});e.record(a,provider.response(a.payload));const received=s.attempt(a.id);await Promise.all([e.apply(received),e.apply(received)]);assert.equal(tools.calls,1);assert.equal(s.stage(p.id,'jurisdiction').messages.length,3);
});
test('missing usage retains unknown cost instead of treating a response as free',t=>{
  const s=setup(t),p=s.create(input),e=new Engine(s,new FakeProvider(),()=>true,{autoStart:false});t.after(()=>e.close());const a=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:{},reserve:100000});e.record(a,{id:'msg_unknown',content:[],stop_reason:'end_turn'});assert.equal(s.attempt(a.id).state,'unknown');assert.equal(s.project(p.id).reserved,.1);
});
test('restart marks unknown dispatch but preserves known pending batch',t=>{
  const s=setup(t),p=s.create(input);const a=s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload:{},reserve:100000}),b=s.reserve(p.id,'contacts',{mode:'batch',modelKey:'research',payload:{},reserve:100000});s.updateAttempt(b.id,{state:'pending',batch_id:'msgbatch_known'});s.recover();assert.equal(s.attempt(a.id).state,'unknown');assert.equal(s.attempt(b.id).state,'pending');assert.equal(s.project(p.id).reserved,.2);
});
test('truncated tool calls are never executed or labeled complete',async t=>{
  const s=setup(t),p=s.create(input),tools=fakeTools(s),provider=new FakeProvider(),e=new Engine(s,provider,()=>true,{tools,autoStart:false});t.after(()=>e.close());
  const payload=researchPayload(s,p,s.stage(p.id,'jurisdiction')),a=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload,reserve:100000});const response=provider.response(payload);response.stop_reason='max_tokens';e.record(a,response);await e.apply(s.attempt(a.id));assert.equal(tools.calls,0);assert.equal(s.stage(p.id,'jurisdiction').status,'queued');assert.equal(s.stage(p.id,'jurisdiction').recoveries,1);
});
