import test from 'node:test';
import assert from 'node:assert/strict';
import { Anthropic, withFallbacks, FALLBACK_BETA, PROGRESS_UPDATES_BETA } from '../lib/provider.mjs';
import { costMicros, hasAmbiguousPricing, interruptedCostEstimate, fallbackModel, modelLabel, pricingSnapshot, MODELS } from '../lib/config.mjs';
import { echoContent, responseText } from '../lib/conversation.mjs';

// Server-side fallback after a refusal, from the shapes Anthropic documents: a fallback content
// block at the handoff, and usage.iterations with one entry per attempt at its own model.
const sonnet=MODELS.research.id,opus48='claude-opus-4-8';
const declined={type:'message',model:sonnet,input_tokens:535,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};
const served={type:'fallback_message',model:opus48,input_tokens:412,output_tokens:264,cache_read_input_tokens:1000,cache_creation_input_tokens:0};
const usage={input_tokens:412,output_tokens:264,cache_read_input_tokens:1000,cache_creation_input_tokens:0,iterations:[declined,served]};
const eventsResponse=events=>new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream','request-id':'req_fixture'}});

test('a request that fell back is priced per attempt at each model’s rates and marked estimated',()=>{
  // Sonnet 5.5's declined attempt at its own rates; Opus 4.8's serving attempt at $5 / $25 / $0.50.
  assert.equal(costMicros(usage,'research'),535*2+412*5+264*25+1000*.5);
  assert.equal(fallbackModel(usage),opus48);assert.equal(hasAmbiguousPricing(usage,'research'),true);
  // Unitemized cache writes of a declined attempt are priced as hour-long writes.
  const writes={...usage,iterations:[{...declined,cache_creation_input_tokens:1000},served]};
  assert.equal(costMicros(writes,'research')-costMicros(usage,'research'),1000*2*2);
  // An unlisted fallback model gets the highest listed rates.
  assert.equal(costMicros({...usage,iterations:[declined,{...served,model:'claude-future-9'}]},'research'),535*2+412*10+264*50+1000*1);
  // Sticky routing sends a later turn straight to the fallback model.
  assert.equal(costMicros({input_tokens:100,output_tokens:10,iterations:[{type:'fallback_message',model:opus48,input_tokens:100,output_tokens:10}]},'research'),100*5+10*25);
  // A fallback model that declined in turn is priced from its own iteration; the serving model from the top-level counts.
  const chain={...usage,iterations:[declined,{type:'fallback_message',model:'claude-opus-5',input_tokens:100,output_tokens:10},served]};
  assert.equal(costMicros(chain,'research')-costMicros(usage,'research'),100*5+10*25);assert.equal(fallbackModel(chain),opus48);
  // Searches that ran before the decline carry over to the fallback and count once.
  const searched={...usage,server_tool_use:{web_search_requests:1},iterations:[{...declined,server_tool_use:{web_search_requests:2}},served]};
  assert.equal(costMicros(searched,'research')-costMicros(usage,'research'),2*10000);
  // A batch fallback cannot happen, but its discount would still apply to tokens only.
  assert.equal(costMicros(usage,'research','batch'),Math.ceil((535*2+412*5+264*25+1000*.5)*.5));
  // Requests that did not fall back are priced as before.
  const plain={input_tokens:412,output_tokens:264};
  assert.equal(costMicros(plain,'research'),412*2+264*10);assert.equal(hasAmbiguousPricing(plain,'research'),false);assert.equal(fallbackModel(plain),'');
  assert.deepEqual(['claude-opus-4-8','claude-sonnet-5','claude-haiku-4-5-20251001',sonnet,'unknown'].map(modelLabel),['Claude Opus 4.8','Claude Sonnet 5','Claude Haiku 4.5','Claude Sonnet 5.5','another Claude model']);
});

test('a stream that failed after a fallback is estimated at the higher of the two models’ rates',()=>{
  const attempt={mode:'realtime',model_key:'research',pricing:pricingSnapshot('research'),reserve:999999};
  const error={partialUsage:{input_tokens:1000,output_tokens:0},streamedCharacters:400};
  assert.equal(interruptedCostEstimate(attempt,error).actual,1000*2+100*10);
  assert.equal(interruptedCostEstimate(attempt,{...error,servedBy:opus48}).actual,1000*5+100*25);
  assert.equal(interruptedCostEstimate(attempt,{...error,servedBy:sonnet}).actual,1000*2+100*10);
});

test('a fallen-back turn is echoed as documented and its text read as one answer',()=>{
  const content=[
    {type:'thinking',thinking:'',signature:'declined-signature'},
    {type:'server_tool_use',id:'srvtoolu_done',name:'web_search',input:{query:'county fire code'}},{type:'web_search_tool_result',tool_use_id:'srvtoolu_done',content:[]},
    {type:'server_tool_use',id:'srvtoolu_open',name:'web_search',input:{query:'unfinished'}},
    {type:'tool_use',id:'declined_call',name:'read_source',input:{url:'https://example.com'}},
    {type:'text',text:'The county adopts '},
    {type:'fallback',from:{model:sonnet},to:{model:opus48}},
    {type:'thinking',thinking:'',signature:'serving-signature'},
    {type:'text',text:'the 2024 IFC.'},
    {type:'tool_use',id:'kept_call',name:'read_source',input:{url:'https://example.com'}},
  ];
  assert.deepEqual(echoContent(content).map(b=>b.id||b.signature||b.type),['srvtoolu_done','web_search_tool_result','text','fallback','serving-signature','text','kept_call']);
  assert.equal(responseText(content),'The county adopts the 2024 IFC.');
  // Turns without a fallback are untouched.
  const plain=[{type:'thinking',thinking:'',signature:'s'},{type:'text',text:'One'},{type:'text',text:'Two'},{type:'tool_use',id:'t'}];
  assert.equal(echoContent(plain),plain);assert.equal(responseText(plain),'One\nTwo');
});

test('real-time requests carry fallbacks and their beta header; token counts do not, and a failed stream names the model it fell back to',async()=>{
  const seen=[];let fail=false;
  const events=[
    {type:'message_start',message:{id:'msg_fallback',type:'message',role:'assistant',model:sonnet,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'The county adopts '}},{type:'content_block_stop',index:0},
    {type:'content_block_start',index:1,content_block:{type:'fallback',from:{model:sonnet},to:{model:opus48}}},{type:'content_block_stop',index:1},
    {type:'content_block_start',index:2,content_block:{type:'text',text:''}},{type:'content_block_delta',index:2,delta:{type:'text_delta',text:'the 2024 IFC.'}},{type:'content_block_stop',index:2},
  ];
  const ending=[{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null,stop_details:null},usage:{input_tokens:412,output_tokens:264,iterations:usage.iterations}},{type:'message_stop'}];
  const c=new Anthropic(()=>'fake-unit-key',{fetchImpl:async(url,options)=>{
    const headers=new Headers(options.headers);seen.push({path:new URL(url).pathname,beta:headers.get('anthropic-beta'),body:JSON.parse(options.body)});
    if(String(url).endsWith('/count_tokens'))return new Response(JSON.stringify({input_tokens:100}),{headers:{'content-type':'application/json'}});
    return eventsResponse(fail?events:[...events,...ending]);
  }});
  const payload=withFallbacks({model:sonnet,max_tokens:1000,thinking:{type:'adaptive',display:'updates'},messages:[{role:'user',content:'Synthetic fallback test.'}]});
  assert.equal(payload.fallbacks,'default');assert.ok(!Object.hasOwn(withFallbacks({model:MODELS.economy.id}),'fallbacks'));
  await c.count(payload);const {data}=await c.message(payload);
  assert.equal(seen[0].beta,PROGRESS_UPDATES_BETA);assert.ok(!Object.hasOwn(seen[0].body,'fallbacks'));
  assert.equal(seen[1].beta,`${PROGRESS_UPDATES_BETA},${FALLBACK_BETA}`);assert.equal(seen[1].body.fallbacks,'default');
  assert.deepEqual(data.content.map(b=>b.type),['text','fallback','text']);assert.equal(responseText(data.content),'The county adopts the 2024 IFC.');
  assert.deepEqual(data.usage.iterations,usage.iterations);assert.equal(fallbackModel(data.usage),opus48);
  fail=true;
  await assert.rejects(c.message(payload),error=>error.servedBy===opus48&&error.partialUsage?.input_tokens===100&&error.retryable===true);
});
