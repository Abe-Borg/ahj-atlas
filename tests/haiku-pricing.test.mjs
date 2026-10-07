import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { MODELS, PRICE_DATE, pricingSnapshot, promptTokens, costMicros, hasAmbiguousPricing, reserveMicros, chatReserveMicros, interruptedCostEstimate } from '../lib/config.mjs';
import { input, FakeProvider } from './fixtures.mjs';

function fixture(t) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'atlas-haiku-pricing-'));
  let store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},reopen(){store.close();store=new Store(dir);return store;}};
}
function replaceEconomyRates(run) {
  const original=structuredClone(MODELS.economy);
  try {
    Object.assign(MODELS.economy,{input:99,output:99,cacheRead:99});
    Object.assign(MODELS.economy.longContext,{input:99,output:99,cacheRead:99});
    return run();
  } finally {Object.assign(MODELS.economy,original);}
}

test('Haiku charges the whole request at the higher tier only above 100,000 prompt tokens',()=>{
  assert.equal(costMicros({input_tokens:100000,output_tokens:2000},'economy'),11000);
  assert.equal(costMicros({input_tokens:100001,output_tokens:2000},'economy'),55001);
  assert.equal(costMicros({input_tokens:60000,cache_read_input_tokens:40000,output_tokens:1000},'economy'),6900);
  assert.equal(costMicros({input_tokens:60000,cache_read_input_tokens:40001,output_tokens:1000},'economy'),34501);
});

test('cache creation counts toward the Haiku threshold and keeps each TTL multiplier',()=>{
  const usage={input_tokens:60000,output_tokens:2000,cache_creation_input_tokens:40000,cache_creation:{ephemeral_5m_input_tokens:30000,ephemeral_1h_input_tokens:10000}};
  assert.equal(promptTokens(usage),100000);
  assert.equal(costMicros(usage,'economy'),12750);
  const longer={...usage,cache_creation_input_tokens:40001,cache_creation:{ephemeral_5m_input_tokens:30000,ephemeral_1h_input_tokens:10001}};
  assert.equal(promptTokens(longer),100001);
  assert.equal(costMicros(longer,'economy'),63751);
  // The TTL breakdown also identifies the total when the aggregate creation counter is absent.
  const ttlOnly={input_tokens:60000,output_tokens:1000,cache_creation:{ephemeral_5m_input_tokens:20000,ephemeral_1h_input_tokens:30000}};
  assert.equal(promptTokens(ttlOnly),110000);
  assert.equal(costMicros(ttlOnly,'economy'),75000);
});

function iteratedUsage() {
  return {
    input_tokens:120001,output_tokens:2000,cache_read_input_tokens:80000,cache_creation_input_tokens:0,
    server_tool_use:{web_search_requests:3,web_fetch_requests:1},
    iterations:[
      {type:'message',model:'claude-haiku-5-5',input_tokens:60000,output_tokens:1000,cache_read_input_tokens:40000,cache_creation_input_tokens:0,server_tool_use:{web_search_requests:1}},
      {type:'message',model:'claude-haiku-5-5',input_tokens:60001,output_tokens:1000,cache_read_input_tokens:40000,cache_creation_input_tokens:0,server_tool_use:{web_search_requests:2}},
    ],
  };
}
test('complete native-tool iteration usage prices each prompt separately and charges search once',()=>{
  const usage=iteratedUsage(),rate=pricingSnapshot('economy',undefined,{inputTokens:60000});
  assert.equal(costMicros(usage,'economy','realtime',rate),71401);
  assert.equal(costMicros(usage,'economy','batch',rate),50701);
  assert.equal(hasAmbiguousPricing(usage,'economy',rate),false);
  usage.iterations[0].model=null;
  assert.equal(costMicros(usage,'economy','realtime',rate),71401);
});

test('unusable native-tool iteration breakdowns keep a conservative estimate',()=>{
  const rate=pricingSnapshot('economy',undefined,{inputTokens:60000});
  const cases={
    missing:usage=>{delete usage.iterations;},
    incomplete:usage=>{usage.iterations.pop();},
    mixedModel:usage=>{usage.iterations[1].model='claude-sonnet-5-5';},
    otherIteration:usage=>{usage.iterations.push({type:'compaction'});},
    mismatchedOutput:usage=>{usage.iterations[1].output_tokens=999;},
  };
  for(const [name,change] of Object.entries(cases)) {
    const usage=iteratedUsage();change(usage);
    assert.equal(costMicros(usage,'economy','realtime',rate),99001,name);
    assert.equal(hasAmbiguousPricing(usage,'economy',rate),true,name);
  }
  const invalidWithoutToolCount=iteratedUsage();delete invalidWithoutToolCount.server_tool_use;invalidWithoutToolCount.iterations.pop();
  assert.equal(hasAmbiguousPricing(invalidWithoutToolCount,'economy',rate),true);
  // An originally counted long prompt has an unambiguous long-context tier.
  assert.equal(hasAmbiguousPricing(iteratedUsage(),'economy',pricingSnapshot('economy',undefined,{inputTokens:150000})),false);
  assert.equal(hasAmbiguousPricing({input_tokens:100001,output_tokens:1000},'economy',rate),false);
});

test('iteration cache TTL totals must reconcile before they can lower the tier',()=>{
  const usage={input_tokens:100000,output_tokens:1000,cache_creation_input_tokens:20000,cache_creation:{ephemeral_5m_input_tokens:20000,ephemeral_1h_input_tokens:0},server_tool_use:{web_search_requests:1},iterations:[
    {type:'message',input_tokens:50000,output_tokens:500,cache_creation_input_tokens:10000,cache_creation:{ephemeral_5m_input_tokens:10000,ephemeral_1h_input_tokens:0}},
    {type:'message',input_tokens:50000,output_tokens:500,cache_creation_input_tokens:10000,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:10000}},
  ]};
  const rate=pricingSnapshot('economy',undefined,{inputTokens:60000});
  assert.equal(costMicros(usage,'economy','realtime',rate),75000);
  assert.equal(hasAmbiguousPricing(usage,'economy',rate),true);
  usage.cache_creation={ephemeral_5m_input_tokens:10000,ephemeral_1h_input_tokens:10000};
  assert.equal(costMicros(usage,'economy','realtime',rate),23750);
  assert.equal(hasAmbiguousPricing(usage,'economy',rate),false);
});

test('pending estimates account for search growth across the tier and undiscounted search fees',()=>{
  assert.equal(reserveMicros(80000,'economy','realtime',1000,1,'5m'),62500);
  assert.equal(reserveMicros(80001,'economy','realtime',1000,1,'5m'),152502);
  assert.equal(reserveMicros(80001,'economy','batch',1000,1,'5m'),96251);
  assert.equal(reserveMicros(80000,'economy','realtime',1000,1,'1h'),74500);
  assert.equal(chatReserveMicros(80000,'economy',1000,1),66500);
  assert.equal(chatReserveMicros(80001,'economy',1000,1),172502);
  assert.equal(costMicros({input_tokens:10000,output_tokens:1000,server_tool_use:{web_search_requests:2}},'economy','batch'),20750);
});

test('rate snapshots preserve model, price date, counted prompt and both tiers independently',()=>{
  const rate=pricingSnapshot('economy',undefined,{inputTokens:80001});
  assert.equal(rate.modelId,'claude-haiku-5-5');assert.equal(rate.priceDate,PRICE_DATE);assert.equal(rate.promptTokens,80001);
  assert.deepEqual(rate.longContext,{threshold:100000,input:.5,output:2.5,cacheRead:.05});
  replaceEconomyRates(()=>{
    assert.equal(costMicros({input_tokens:10000,output_tokens:1000,cache_read_input_tokens:20000},'economy','realtime',rate),1700);
    assert.equal(costMicros({input_tokens:100001,output_tokens:2000},'economy','realtime',rate),55001);
    assert.equal(reserveMicros(80001,'economy','realtime',1000,1,'5m',rate),152502);
    assert.equal(chatReserveMicros(80001,'economy',1000,1,rate),172502);
  });
});

test('pending requests keep their saved prices after reopen and a configuration price change',t=>{
  const fixtureStore=fixture(t),s=fixtureStore.store,p=s.create(input);
  const payload={model:'claude-haiku-5-5',messages:[{role:'user',content:'Synthetic pricing fixture.'}]};
  const rate=pricingSnapshot('economy',payload.model,{inputTokens:80001});
  const attempt=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'economy',payload,reserve:152502,pricing:rate});
  s.updateAttempt(attempt.id,{state:'pending'});
  const reopened=fixtureStore.reopen();
  assert.deepEqual(reopened.attemptSummary(attempt.id).pricing,rate);
  assert.deepEqual(reopened.attemptSummaries(p.id)[0].pricing,rate);
  assert.deepEqual(reopened.attempt(attempt.id).payload,payload);
  const engine=new Engine(reopened,new FakeProvider(),()=>null,{autoStart:false});t.after(()=>engine.close());
  replaceEconomyRates(()=>{
    engine.record(reopened.attempt(attempt.id),{id:'msg_pricing_fixture',content:[],usage:{input_tokens:10000,output_tokens:1000,cache_read_input_tokens:20000}});
    assert.equal(reopened.attempt(attempt.id).actual,1700);
    assert.equal(reopened.attempt(attempt.id).state,'received');
    assert.deepEqual(reopened.attempt(attempt.id).pricing,rate);
  });
  reopened.updateAttempt(attempt.id,{state:'settled',applied:1});
  assert.equal(reopened.project(p.id).cost,.0017);assert.equal(reopened.project(p.id).reserved,0);
});

test('default Store reservations also save their rate card outside the provider payload',t=>{
  const {store:s}=fixture(t),p=s.create(input),payload={model:'claude-haiku-5-5',messages:[]};
  const attempt=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'economy',payload,reserve:1000});
  assert.equal(attempt.pricing.modelId,'claude-haiku-5-5');assert.equal(attempt.pricing.input,.1);
  assert.deepEqual(attempt.payload,payload);assert.equal(Object.hasOwn(attempt.payload,'pricing'),false);
});

test('legacy migration preserves the previous app rate card even for today\'s pending Sonnet request',t=>{
  const fixtureStore=fixture(t),s=fixtureStore.store,p=s.create(input),rows=[];
  for(const [model,date,state,actual] of [
    ['claude-sonnet-5-5','2026-10-06T12:00:00.000Z','pending',0],
    ['claude-sonnet-5-5','2026-10-06T12:00:01.000Z','settled',12345],
    ['claude-sonnet-5-5','2026-10-07T12:00:00.000Z','pending',0],
    ['claude-sonnet-5','2026-10-07T12:00:01.000Z','pending',0],
  ]) {
    const payload={model,messages:[{role:'assistant',content:[{type:'redacted_thinking',data:'synthetic-saved-signature'}]}]};
    const attempt=s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload,reserve:654321});
    s.updateAttempt(attempt.id,{state,actual,applied:state==='settled'?1:0});
    s.db.prepare('UPDATE attempts SET created=? WHERE id=?').run(date,attempt.id);
    rows.push(s.db.prepare('SELECT id,state,reserve,actual,payload,created,charged_at,applied FROM attempts WHERE id=?').get(attempt.id));
  }
  s.db.exec('ALTER TABLE attempts DROP COLUMN pricing');
  const reopened=fixtureStore.reopen();
  assert.deepEqual(reopened.db.prepare('SELECT id,state,reserve,actual,payload,created,charged_at,applied FROM attempts ORDER BY rowid').all(),rows);
  const attempts=rows.map(row=>reopened.attempt(row.id));
  // A missing column identifies the old app, whose embedded card was still September 28.
  // Requests created on the release day also used that card until this upgrade.
  assert.deepEqual(attempts.map(a=>a.pricing.cacheRead),[.2,.2,.2,.2]);
  assert.deepEqual(attempts.map(a=>a.pricing.priceDate),Array(4).fill('2026-09-28'));
  assert.deepEqual(attempts.map(a=>a.pricing.modelId),['claude-sonnet-5-5','claude-sonnet-5-5','claude-sonnet-5-5','claude-sonnet-5']);
  const engine=new Engine(reopened,new FakeProvider(),()=>null,{autoStart:false});t.after(()=>engine.close());
  const response={id:'msg_old_batch_fixture',content:[],usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:100000}};
  engine.record(attempts[0],response);
  assert.equal(reopened.attempt(attempts[0].id).actual,10000);
  assert.equal(reopened.attempt(attempts[1].id).actual,12345);
  engine.record(attempts[2],{...response,id:'msg_same_day_old_batch_fixture'});
  assert.equal(reopened.attempt(attempts[2].id).actual,10000);
  const persisted=attempts.map(a=>reopened.attempt(a.id).pricing);
  fixtureStore.reopen();
  assert.deepEqual(rows.map(row=>fixtureStore.store.attempt(row.id).pricing),persisted);
});

test('Sonnet cache-read change applies by model and request price date',()=>{
  assert.equal(costMicros({cache_read_input_tokens:100000},'research'),10000);
  assert.equal(costMicros({cache_read_input_tokens:100000},'research','realtime',pricingSnapshot('research','claude-sonnet-5-5',{priceDate:'2026-10-06'})),20000);
  assert.equal(costMicros({cache_read_input_tokens:100000},'research','realtime',pricingSnapshot('research','claude-sonnet-5',{priceDate:PRICE_DATE})),20000);
});

test('interrupted estimates preserve the counted prompt tier when partial cache counters are absent',()=>{
  const attempt={mode:'realtime',model_key:'economy',reserve:80000,pricing:pricingSnapshot('economy',undefined,{inputTokens:150000})};
  const error={partialUsage:{input_tokens:1000},streamedCharacters:400};
  assert.deepEqual(interruptedCostEstimate(attempt,error),{actual:750,usage:{input_tokens:1000,output_tokens:100},estimated:1});
  const short={...attempt,pricing:pricingSnapshot('economy',undefined,{inputTokens:100000})};
  assert.equal(interruptedCostEstimate(short,error).actual,150);
  assert.equal(interruptedCostEstimate(short,{partialUsage:{input_tokens:100001,output_tokens:100}}).actual,50251);
  replaceEconomyRates(()=>assert.equal(interruptedCostEstimate(attempt,error).actual,750));
  assert.equal(interruptedCostEstimate(attempt,{partialUsage:{output_tokens:100},streamedCharacters:400}).actual,attempt.reserve);
  assert.equal(interruptedCostEstimate({...attempt,mode:'batch'},error),null);
  assert.equal(interruptedCostEstimate(attempt,{}),null);
});
