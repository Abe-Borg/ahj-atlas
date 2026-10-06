import os from 'node:os';
import v8 from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Allowance exhaustion (rounds, searches, tokens, time) is recorded by recordExhausted.
// This module answers the other half of "was research starved?": did the computer
// hold the app back. A sample is starved when the event loop stalled, the process
// was paused (sleep, hibernation, throttling), every core was busy, the heap neared
// V8's ceiling, or system memory ran out. Fractions are of the whole; delays are ms.
export const RESOURCE_MONITOR={intervalMs:5000,historySamples:720,recoverSamples:6,loopDelayMs:500,pausedMs:10000,systemCpu:.95,heapFraction:.85,systemMemoryFree:.05};
export const STARVATION_SIGNALS=['event_loop','process_paused','system_cpu','heap','system_memory'];
const round=(value,places=3)=>Number.isFinite(value)?Number(value.toFixed(places)):null;
const iso=ms=>Number.isFinite(ms)?new Date(ms).toISOString():null;
// system_memory is starved when free memory is low, so its worst value is the minimum.
const worse=(signal,a,b)=>a===null||a===undefined?b:signal==='system_memory'?Math.min(a,b):Math.max(a,b);
// Busy share of all cores between two os.cpus() readings. Core counts can differ
// if a reading failed; that interval then has no system CPU figure.
export function busyFraction(previous,current){
  if(!Array.isArray(previous)||!Array.isArray(current)||!current.length||previous.length!==current.length)return null;
  let busy=0,total=0;
  for(let i=0;i<current.length;i++){
    const a=previous[i]?.times||{},b=current[i]?.times||{};
    for(const key of ['user','nice','sys','irq','idle']){const delta=Math.max(0,(Number(b[key])||0)-(Number(a[key])||0));total+=delta;if(key!=='idle')busy+=delta;}
  }
  return total>0?busy/total:null;
}
export class ResourceMonitor{
  constructor(store,{settings={},clock=Date.now,host=os,proc=process,heapLimit=()=>v8.getHeapStatistics().heap_size_limit,histogram=monitorEventLoopDelay({resolution:20})}={}){
    this.store=store;this.settings={...RESOURCE_MONITOR,...settings};this.clock=clock;this.host=host;this.proc=proc;this.heapLimit=heapLimit;this.histogram=histogram;
    this.timer=null;this.startedAt=null;this.previous=null;this.samples=[];this.latest=null;this.count=0;this.active=new Map();
    this.peaks={loopDelayMs:0,lateMs:0,systemCpu:0,processCpu:0,heapFraction:0,rssBytes:0,systemMemoryFree:null};
    this.starved=Object.fromEntries(STARVATION_SIGNALS.map(signal=>[signal,{episodes:0,samples:0,starvedMs:0,peak:null,lastAt:null}]));
  }
  start(){
    if(this.timer)return this;
    this.startedAt=this.clock();this.histogram.enable();this.previous=this.reading();
    this.timer=setInterval(()=>{try{this.sample();}catch(e){this.store.diagnostic('resource.sample_failed',{level:'warning',message:String(e?.message||e).slice(0,300)});}},this.settings.intervalMs);
    this.timer.unref?.();return this;
  }
  stop(){if(this.timer){clearInterval(this.timer);this.timer=null;}this.histogram.disable();}
  // Numbers only: no process names, file paths, user names or CPU model strings.
  reading(){
    const memory=this.proc.memoryUsage(),cpu=this.proc.cpuUsage();
    let cpus=[];try{cpus=(this.host.cpus()||[]).map(c=>({times:{...c.times}}));}catch{}
    return {at:this.clock(),cpuMicros:(cpu.user||0)+(cpu.system||0),cpus,rss:memory.rss,heapUsed:memory.heapUsed,heapLimit:Number(this.heapLimit())||0,free:this.host.freemem(),total:this.host.totalmem()};
  }
  loopDelayMs(){return this.histogram.count>0?Math.round(this.histogram.max/1e6):0;}
  metrics(previous,current,loopDelayMs){
    const intervalMs=previous?current.at-previous.at:null;
    const processCpu=previous&&intervalMs>0?(current.cpuMicros-previous.cpuMicros)/1000/intervalMs:null;
    return {
      intervalMs,lateMs:intervalMs===null?null:Math.max(0,intervalMs-this.settings.intervalMs),loopDelayMs,
      // Share of one core used by this process: 1 is a full core, 2 is two cores.
      processCpu:round(processCpu),systemCpu:round(busyFraction(previous?.cpus,current.cpus)),cores:current.cpus.length,
      rssBytes:current.rss,heapUsedBytes:current.heapUsed,heapLimitBytes:current.heapLimit,heapFraction:round(current.heapLimit>0?current.heapUsed/current.heapLimit:null),
      systemFreeBytes:current.free,systemTotalBytes:current.total,systemMemoryFree:round(current.total>0?current.free/current.total:null),
    };
  }
  evaluate(m){
    const S=this.settings,checks=[
      ['event_loop',m.loopDelayMs,S.loopDelayMs,(v,l)=>v>=l],
      ['process_paused',m.lateMs,S.pausedMs,(v,l)=>v>=l],
      ['system_cpu',m.systemCpu,S.systemCpu,(v,l)=>v>=l],
      ['heap',m.heapFraction,S.heapFraction,(v,l)=>v>=l],
      ['system_memory',m.systemMemoryFree,S.systemMemoryFree,(v,l)=>v<=l],
    ];
    return checks.filter(([,value,limit,test])=>Number.isFinite(value)&&test(value,limit)).map(([signal,value,limit])=>({signal,value,limit}));
  }
  // The first call only primes the deltas and returns null.
  sample(){
    const current=this.reading(),loopDelayMs=this.loopDelayMs();this.histogram.reset();
    const previous=this.previous;this.previous=current;
    if(!previous)return null;
    const m=this.metrics(previous,current,loopDelayMs),signals=this.evaluate(m);
    const sample={from:previous.at,at:current.at,...m,starved:signals.map(s=>s.signal)};
    this.samples.push(sample);if(this.samples.length>this.settings.historySamples)this.samples.splice(0,this.samples.length-this.settings.historySamples);
    this.latest=sample;this.count++;
    for(const key of ['loopDelayMs','lateMs','systemCpu','processCpu','heapFraction','rssBytes'])if(Number.isFinite(m[key]))this.peaks[key]=Math.max(this.peaks[key],m[key]);
    if(Number.isFinite(m.systemMemoryFree))this.peaks.systemMemoryFree=worse('system_memory',this.peaks.systemMemoryFree,m.systemMemoryFree);
    this.episodes(signals,sample,m);
    return sample;
  }
  // One warning row when a signal's episode starts, one info row when it has been
  // clear for recoverSamples samples, so a long episode cannot flood the journal.
  episodes(signals,sample,m){
    const seen=new Set();
    for(const {signal,value,limit} of signals){
      seen.add(signal);const stat=this.starved[signal];stat.samples++;stat.lastAt=sample.at;stat.peak=worse(signal,stat.peak,value);
      const open=this.active.get(signal);
      if(open){open.samples++;open.lastAt=sample.at;open.peak=worse(signal,open.peak,value);open.clear=0;continue;}
      this.active.set(signal,{from:sample.from,lastAt:sample.at,samples:1,peak:value,limit,clear:0});stat.episodes++;
      this.store.diagnostic('resource.starved',{level:'warning',signal,value,limit,...m});
    }
    for(const [signal,open] of this.active){
      if(seen.has(signal)||++open.clear<this.settings.recoverSamples)continue;
      this.active.delete(signal);const starvedMs=open.lastAt-open.from;this.starved[signal].starvedMs+=starvedMs;
      this.store.diagnostic('resource.recovered',{signal,starvedMs,samples:open.samples,peak:open.peak,limit:open.limit});
    }
  }
  // Current readings without recording a sample; delta figures need a prior reading.
  peek(){const current=this.reading();return {at:iso(current.at),...this.metrics(this.previous,current,this.loopDelayMs()),starved:this.evaluate(this.metrics(this.previous,current,this.loopDelayMs())).map(s=>s.signal)};}
  // The samples overlapping a timed operation, reduced to their worst values.
  window(sinceMs,untilMs=this.clock()){
    const rows=this.samples.filter(s=>s.from<=untilMs&&s.at>=sinceMs);
    if(!rows.length)return {samples:0};
    const starved={};for(const s of rows)for(const signal of s.starved)starved[signal]=(starved[signal]||0)+1;
    const pick=(key,fn)=>{const values=rows.map(s=>s[key]).filter(Number.isFinite);return values.length?fn(...values):null;};
    return {samples:rows.length,starved,loopDelayMs:pick('loopDelayMs',Math.max),lateMs:pick('lateMs',Math.max),systemCpu:pick('systemCpu',Math.max),processCpu:pick('processCpu',Math.max),heapFraction:pick('heapFraction',Math.max),systemMemoryFree:pick('systemMemoryFree',Math.min)};
  }
  summary(){
    const {from,at,...current}=this.latest||{};
    return {
      running:Boolean(this.timer),startedAt:iso(this.startedAt),settings:this.settings,samples:this.count,lastSampleAt:iso(at),
      current:this.latest?{at:iso(at),...current}:this.peek(),peaks:this.peaks,
      starved:Object.fromEntries(Object.entries(this.starved).map(([signal,stat])=>[signal,{...stat,lastAt:iso(stat.lastAt),active:this.active.has(signal)}])),
      active:[...this.active.keys()],
    };
  }
}
// Reads saved diagnostic rows back into one answer: how often the host starved the
// app, how much work ran while it was starved, how often Anthropic throttled a
// request, and which allowances were spent. Throttling is counted once per request
// even though the provider and the engine each record the failure.
export function starvationSummary(rows=[]){
  const host={episodes:{},recoveries:{},starvedMs:{},timedRows:0,timedRowsStarved:0,starvedSamplesDuringWork:{}};
  const provider={rateLimited:0,overloaded:0,retryAfterMs:0},throttled=new Set(),allowances={};
  for(const row of rows){
    const d=row.details||{};
    if(row.event==='resource.starved'&&d.signal)host.episodes[d.signal]=(host.episodes[d.signal]||0)+1;
    else if(row.event==='resource.recovered'&&d.signal){host.recoveries[d.signal]=(host.recoveries[d.signal]||0)+1;host.starvedMs[d.signal]=(host.starvedMs[d.signal]||0)+(Number(d.starvedMs)||0);}
    else if(row.event==='resource.exhausted'&&d.resource){const outcomes=allowances[d.resource]||(allowances[d.resource]={});const outcome=String(d.outcome||'unknown');outcomes[outcome]=(outcomes[outcome]||0)+1;}
    if(d.resources&&typeof d.resources==='object'){
      host.timedRows++;const signals=Object.entries(d.resources.starved||{});
      if(signals.length){host.timedRowsStarved++;for(const [signal,count] of signals)host.starvedSamplesDuringWork[signal]=(host.starvedSamplesDuringWork[signal]||0)+(Number(count)||0);}
    }
    const error=d.error;
    if(error&&typeof error==='object'){
      const status=Number(error.status),type=String(error.type||''),limited=status===429||type==='rate_limit_error',overloaded=status===529||type==='overloaded_error';
      if(limited||overloaded){const key=row.attempt_id||error.requestId||`row:${row.id}`;if(!throttled.has(key)){throttled.add(key);if(limited)provider.rateLimited++;else provider.overloaded++;provider.retryAfterMs+=Number(error.retryAfterMs)||0;}}
    }
  }
  return {host,provider:{...provider,throttledRequests:throttled.size},allowances};
}
