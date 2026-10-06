import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ResourceMonitor,RESOURCE_MONITOR,STARVATION_SIGNALS,busyFraction,starvationSummary} from '../lib/resources.mjs';
import {diagnosticReport} from '../lib/diagnostics.mjs';
import {createApp} from '../server.mjs';
import {input,FakeProvider} from './fixtures.mjs';

function temp(){return mkdtempSync(path.join(os.tmpdir(),'ahj-resources-'));}
function clean(dir){assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-resources-')));rmSync(dir,{recursive:true,force:true});}
function storeFixture(t){const dir=temp(),store=new Store(dir);t.after(()=>{store.close();clean(dir);});return store;}
// A fake computer: the test moves the clock, the core counters and every reading.
function fakeHost(){
  const state={now:1_000_000,busy:0,idle:0,procMicros:0,rss:200e6,heapUsed:100e6,heapLimit:1000e6,free:8e9,total:16e9,loopMax:0,loopCount:0,enabled:false};
  const histogram={enable(){state.enabled=true;},disable(){state.enabled=false;},reset(){state.loopMax=0;state.loopCount=0;},get max(){return state.loopMax;},get count(){return state.loopCount;}};
  const host={cpus:()=>Array.from({length:4},()=>({model:'PRIVATE CPU MODEL',times:{user:state.busy,nice:0,sys:0,irq:0,idle:state.idle}})),freemem:()=>state.free,totalmem:()=>state.total};
  const proc={cpuUsage:()=>({user:state.procMicros,system:0}),memoryUsage:()=>({rss:state.rss,heapUsed:state.heapUsed,heapTotal:state.heapUsed})};
  // One interval: ms pass, every core is busy for the given share, the app used procMs of CPU time.
  const advance=({ms=5000,busy=.1,loopMs=0,procMs=100}={})=>{state.now+=ms;state.busy+=ms*busy;state.idle+=ms*(1-busy);state.procMicros+=procMs*1000;if(loopMs){state.loopMax=loopMs*1e6;state.loopCount=1;}};
  return {state,histogram,host,proc,advance};
}
function monitor(store,settings={}){
  const fake=fakeHost();
  return {m:new ResourceMonitor(store,{settings,clock:()=>fake.state.now,host:fake.host,proc:fake.proc,heapLimit:()=>fake.state.heapLimit,histogram:fake.histogram}),...fake};
}
const rows=(store,event)=>store.diagnostics().filter(d=>d.event===event).reverse();

test('quiet samples record no rows, and the first sample only primes the readings',t=>{
  const store=storeFixture(t),{m,advance}=monitor(store);
  assert.equal(m.sample(),null);
  for(let i=0;i<5;i++){advance();const s=m.sample();assert.equal(s.intervalMs,5000);assert.equal(s.lateMs,0);assert.deepEqual(s.starved,[]);assert.equal(s.systemCpu,0.1);assert.equal(s.processCpu,0.02);assert.equal(s.cores,4);assert.equal(s.heapFraction,0.1);}
  assert.equal(store.diagnostics().length,0);
  const summary=m.summary();
  assert.equal(summary.samples,5);assert.equal(summary.running,false);assert.deepEqual(summary.active,[]);assert.equal(summary.current.systemCpu,0.1);assert.equal(summary.peaks.systemCpu,0.1);assert.equal(summary.peaks.systemMemoryFree,0.5);
  assert.deepEqual(summary.settings,RESOURCE_MONITOR);assert.deepEqual(summary.starved.event_loop,{episodes:0,samples:0,starvedMs:0,peak:null,lastAt:null,active:false});
  assert.ok(!JSON.stringify(summary).includes('PRIVATE CPU MODEL'));
  assert.equal(busyFraction([{times:{user:0,idle:0}}],[{times:{user:3,idle:1}}]),0.75);assert.equal(busyFraction([],[]),null);assert.equal(busyFraction([{times:{}}],[{times:{}},{times:{}}]),null);
});

test('each signal opens one bounded episode with its threshold and closes after the recovery samples',t=>{
  const store=storeFixture(t),{m,state,advance}=monitor(store);m.sample();
  for(let i=0;i<3;i++){advance({loopMs:800+i*100});m.sample();}
  const starved=rows(store,'resource.starved');assert.equal(starved.length,1);
  assert.equal(starved[0].level,'warning');assert.equal(starved[0].details.signal,'event_loop');assert.equal(starved[0].details.value,800);assert.equal(starved[0].details.limit,RESOURCE_MONITOR.loopDelayMs);assert.equal(starved[0].details.intervalMs,5000);assert.equal(starved[0].details.rssBytes,200e6);
  assert.deepEqual(m.summary().active,['event_loop']);
  for(let i=0;i<RESOURCE_MONITOR.recoverSamples-1;i++){advance();m.sample();}
  assert.equal(rows(store,'resource.recovered').length,0);assert.deepEqual(m.summary().active,['event_loop']);
  advance();m.sample();
  const recovered=rows(store,'resource.recovered');assert.equal(recovered.length,1);
  assert.deepEqual(recovered[0].details,{signal:'event_loop',starvedMs:15000,samples:3,peak:1000,limit:500});assert.equal(recovered[0].level,'info');
  const stat=m.summary().starved.event_loop;assert.deepEqual(stat,{episodes:1,samples:3,starvedMs:15000,peak:1000,lastAt:new Date(1_015_000).toISOString(),active:false});
  // A flicker inside the recovery window extends the same episode instead of opening another.
  advance({loopMs:600});m.sample();advance();m.sample();advance({loopMs:700});m.sample();
  assert.equal(rows(store,'resource.starved').length,2);assert.equal(m.summary().starved.event_loop.episodes,2);
  for(let i=0;i<RESOURCE_MONITOR.recoverSamples;i++){advance();m.sample();}
  assert.equal(rows(store,'resource.recovered').length,2);assert.equal(rows(store,'resource.recovered')[1].details.samples,2);
  // The other four signals from one bad interval: a 30-second gap with busy cores, a full heap and no free memory.
  advance({ms:30000,busy:.99});state.heapUsed=900e6;state.free=.4e9;m.sample();
  const signals=rows(store,'resource.starved').slice(2).map(r=>[r.details.signal,r.details.value,r.details.limit]);
  assert.deepEqual(signals,[['process_paused',25000,RESOURCE_MONITOR.pausedMs],['system_cpu',0.99,RESOURCE_MONITOR.systemCpu],['heap',0.9,RESOURCE_MONITOR.heapFraction],['system_memory',0.025,RESOURCE_MONITOR.systemMemoryFree]]);
  assert.deepEqual(m.summary().active,['process_paused','system_cpu','heap','system_memory']);assert.equal(m.summary().peaks.lateMs,25000);assert.equal(m.summary().peaks.systemMemoryFree,0.025);
  assert.deepEqual(STARVATION_SIGNALS,['event_loop','process_paused','system_cpu','heap','system_memory']);
});

test('a window reduces the samples that overlapped an operation to their worst values',t=>{
  const store=storeFixture(t),{m,advance}=monitor(store);m.sample();
  advance();m.sample();
  advance({loopMs:900,busy:.5});m.sample();
  advance({busy:.2});m.sample();
  assert.deepEqual(m.window(1_006_000,1_012_000),{samples:2,starved:{event_loop:1},loopDelayMs:900,lateMs:0,systemCpu:0.5,processCpu:0.02,heapFraction:0.1,systemMemoryFree:0.5});
  assert.deepEqual(m.window(1_000_000,1_004_000).starved,{});
  assert.deepEqual(m.window(1_020_000),{samples:0});
  assert.deepEqual(m.window(900_000,999_000),{samples:0});
  const bounded=monitor(store,{historySamples:2});bounded.m.sample();for(let i=0;i<5;i++){bounded.advance();bounded.m.sample();}
  assert.equal(bounded.m.samples.length,2);assert.equal(bounded.m.summary().samples,5);
  // A synchronous stall holds the timer back; the window takes the overdue sample so the stall is its own.
  const stalled=monitor(store);stalled.m.start();t.after(()=>stalled.m.stop());
  stalled.advance();stalled.m.sample();
  stalled.advance({ms:9000,loopMs:8500});
  assert.deepEqual(stalled.m.window(stalled.state.now-8000),{samples:1,starved:{event_loop:1},loopDelayMs:8500,lateMs:4000,systemCpu:0.1,processCpu:0.011,heapFraction:0.1,systemMemoryFree:0.5});
  assert.equal(stalled.m.summary().samples,2);assert.deepEqual(stalled.m.summary().active,['event_loop']);
  stalled.advance({ms:1000});assert.deepEqual(stalled.m.window(stalled.state.now-500),{samples:0});assert.equal(stalled.m.summary().samples,2);
});

test('timed diagnostic rows carry the host window; untimed rows and recovery rows do not',t=>{
  const store=storeFixture(t);
  store.resources={window:since=>({samples:1,starved:{event_loop:1},loopDelayMs:2000,since})};
  store.diagnostic('tool.completed',{durationMs:4000,tool:'read_source'});
  store.diagnostic('request.dispatch',{inputTokens:10});
  store.diagnostic('resource.recovered',{signal:'event_loop',starvedMs:5000});
  store.diagnostic('stream.completed',{durationMs:1000,resources:{samples:9}});
  const byEvent=Object.fromEntries(store.diagnostics().map(r=>[r.event,r.details]));
  assert.deepEqual(byEvent['tool.completed'].resources.starved,{event_loop:1});assert.ok(Math.abs(Date.now()-4000-byEvent['tool.completed'].resources.since)<2000);
  assert.ok(!Object.hasOwn(byEvent['request.dispatch'],'resources'));assert.ok(!Object.hasOwn(byEvent['resource.recovered'],'resources'));
  assert.deepEqual(byEvent['stream.completed'].resources,{samples:9});
});

test('the starvation summary counts host episodes, starved work, throttled requests once per provider request and spent allowances',()=>{
  const summary=starvationSummary([
    {id:1,event:'resource.starved',details:{signal:'event_loop',value:900}},
    {id:2,event:'resource.recovered',details:{signal:'event_loop',starvedMs:15000}},
    {id:3,event:'resource.starved',details:{signal:'system_cpu'}},
    {id:4,event:'resource.starved',details:{signal:'event_loop'}},
    {id:5,event:'stream.completed',attempt_id:'a1',details:{durationMs:9000,resources:{samples:2,starved:{event_loop:2}}}},
    {id:6,event:'tool.completed',attempt_id:'a1',details:{durationMs:900,resources:{samples:0}}},
    {id:7,event:'stream.failed',attempt_id:'a2',details:{durationMs:10,error:{status:429,type:'rate_limit_error',retryAfterMs:7000,requestId:'req_2'}}},
    {id:8,event:'request.failed',attempt_id:'a2',details:{durationMs:12,error:{status:429,type:'rate_limit_error',retryAfterMs:7000,requestId:'req_2'}}},
    {id:9,event:'api.failed',attempt_id:null,details:{durationMs:5,error:{status:529,type:'overloaded_error',requestId:'req_9'}}},
    {id:16,event:'api.failed',attempt_id:'a5',details:{error:{status:429,type:'rate_limit_error',retryAfterMs:1000,requestId:'req_poll_1'}}},
    {id:17,event:'api.failed',attempt_id:'a5',details:{error:{status:529,type:'overloaded_error',requestId:'req_poll_2'}}},
    {id:10,event:'batch.result_failed',attempt_id:'a3',details:{error:{status:0,type:'rate_limit_error'}}},
    {id:11,event:'request.failed',attempt_id:'a4',details:{error:{status:500,type:'api_error'}}},
    {id:12,event:'resource.exhausted',details:{resource:'rounds',outcome:'stopped'}},
    {id:13,event:'resource.exhausted',details:{resource:'rounds',outcome:'degraded'}},
    {id:14,event:'resource.exhausted',details:{resource:'searches',outcome:'refused'}},
    {id:15,event:'resource.exhausted',details:{resource:'pdf_pages'}},
  ]);
  assert.deepEqual(summary,{host:{episodes:{event_loop:2,system_cpu:1},recoveries:{event_loop:1},starvedMs:{event_loop:15000},timedRows:2,timedRowsStarved:1,starvedSamplesDuringWork:{event_loop:2}},provider:{rateLimited:3,overloaded:2,retryAfterMs:8000,throttledRequests:5},allowances:{rounds:{stopped:1,degraded:1},searches:{refused:1},pdf_pages:{unknown:1}}});
  assert.deepEqual(starvationSummary([]),{host:{episodes:{},recoveries:{},starvedMs:{},timedRows:0,timedRowsStarved:0,starvedSamplesDuringWork:{}},provider:{rateLimited:0,overloaded:0,retryAfterMs:0,throttledRequests:0},allowances:{}});
});

test('diagnostic reports carry the host summary, per-project and workspace starvation, and numbers only',t=>{
  const store=storeFixture(t),p=store.create(input),q=store.create(input),{m,advance}=monitor(store);
  store.resources=m;m.sample();advance({loopMs:1200});m.sample();
  store.diagnostic('request.failed',{projectId:p.id,stageId:'codes',attemptId:'attempt_p',level:'error',durationMs:50,error:{status:429,type:'rate_limit_error',retryAfterMs:3000,requestId:'req_p'}});
  store.diagnostic('stream.completed',{projectId:q.id,stageId:'codes',attemptId:'attempt_q',durationMs:50,resources:{samples:3,starved:{event_loop:3}}});
  const report=diagnosticReport(store,{projectId:p.id,resources:m});
  assert.equal(report.application.resources.samples,1);assert.deepEqual(report.application.resources.active,['event_loop']);assert.deepEqual(report.application.resources.settings,RESOURCE_MONITOR);
  assert.equal(report.starvation.host.episodes.event_loop,1);assert.equal(report.starvation.provider.rateLimited,1);assert.equal(report.starvation.provider.retryAfterMs,3000);
  const project=report.projects.find(x=>x.id===p.id);assert.equal(project.starvation.provider.throttledRequests,1);assert.equal(project.starvation.host.timedRows,1);assert.equal(project.starvation.host.timedRowsStarved,0);assert.deepEqual(project.starvation.host.episodes,{});
  assert.ok(!report.projects.some(x=>x.id===q.id));assert.ok(report.privacy.includes('Host resource samples are numbers only.'));
  const whole=diagnosticReport(store,{resources:m});
  assert.equal(whole.projects.find(x=>x.id===q.id).starvation.host.timedRowsStarved,1);assert.equal(whole.starvation.host.timedRowsStarved,1);assert.equal(whole.starvation.provider.throttledRequests,1);
  assert.equal(diagnosticReport(store,{}).application.resources,null);
  for(const value of Object.values(report.application.resources.current))assert.ok(value===null||typeof value==='number'||Array.isArray(value)||typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value),String(value));
  assert.ok(!JSON.stringify(whole).includes('PRIVATE'));
});

test('the real monitor samples this process and stops cleanly',async t=>{
  const store=storeFixture(t),m=new ResourceMonitor(store,{settings:{intervalMs:20}});
  m.start();assert.ok(m.summary().running);assert.ok(m.start()===m);await new Promise(r=>setTimeout(r,120));
  const sample=m.sample();m.stop();
  assert.ok(sample&&sample.intervalMs>0);assert.ok(sample.rssBytes>0);assert.ok(sample.heapFraction>0&&sample.heapFraction<1);assert.ok(sample.systemMemoryFree>=0&&sample.systemMemoryFree<=1);assert.ok(sample.cores>=1);assert.ok(sample.processCpu>=0);assert.ok(sample.loopDelayMs>=0);assert.ok(sample.heapLimitBytes>sample.heapUsedBytes);
  assert.equal(m.summary().running,false);assert.ok(m.summary().samples>=1);
  const peek=m.peek();assert.ok(/^\d{4}-/.test(peek.at));assert.ok(Array.isArray(peek.starved));assert.ok(peek.rssBytes>0);
  for(const row of store.diagnostics())assert.ok(['resource.starved','resource.recovered'].includes(row.event),row.event);
});

test('the app samples with its worker, serves the host summary from the diagnostics route and stops with the app',async t=>{
  const dir=temp(),app=await createApp({dataDir:dir,port:0,worker:true,provider:new FakeProvider()});t.after(async()=>{await app.close();clean(dir);});
  assert.ok(app.services.resources.summary().running);assert.equal(app.store.resources,app.services.resources);
  const state=await(await fetch(app.url+'/api/bootstrap')).json(),headers={'content-type':'application/json','x-app-token':state.token};
  const result=await(await fetch(app.url+'/api/diagnostics',{method:'POST',headers,body:'{}'})).json();
  assert.deepEqual(result.application.resources.settings,RESOURCE_MONITOR);assert.ok(result.application.resources.running);assert.ok(result.application.resources.current.rssBytes>0);assert.ok(result.starvation.host);assert.deepEqual(result.starvation.provider,{rateLimited:0,overloaded:0,retryAfterMs:0,throttledRequests:0});
  await fetch(app.url+'/api/connection/check',{method:'POST',headers,body:'{}'});
  const timed=app.store.diagnostics().find(d=>d.event==='http.completed');assert.ok(timed);assert.ok(Number.isInteger(timed.details.resources.samples));
  await app.close();assert.equal(app.services.resources.summary().running,false);
  const quiet=await createApp({dataDir:temp(),port:0,worker:false,provider:new FakeProvider()});t.after(async()=>{await quiet.close();clean(quiet.store.dir);});
  assert.equal(quiet.services.resources.summary().running,false);assert.ok((await(await fetch(quiet.url+'/api/diagnostics',{method:'POST',headers:{'content-type':'application/json','x-app-token':(await(await fetch(quiet.url+'/api/bootstrap')).json()).token},body:'{}'})).json()).application.resources.current.rssBytes>0);
});
