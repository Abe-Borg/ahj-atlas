import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Anthropic, providerError, validateCapabilities } from '../lib/provider.mjs';
import { costMicros } from '../lib/config.mjs';
import { CHAT_TOOLS } from '../lib/chat.mjs';
import { Store } from '../lib/store.mjs';
import { createServices } from '../lib/services.mjs';

const payload={model:'claude-opus-5-5',max_tokens:100000,messages:[{role:'user',content:'Synthetic contract test.'}]};
const initial={type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:payload.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0,cache_creation_input_tokens:200,cache_read_input_tokens:300,cache_creation:{ephemeral_5m_input_tokens:50,ephemeral_1h_input_tokens:150},server_tool_use:{web_search_requests:0}}}};
const ending=[{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null,stop_details:{test_detail:'retained'}},usage:{input_tokens:500,output_tokens:40,cache_read_input_tokens:300,cache_creation_input_tokens:200,cache_creation:{ephemeral_5m_input_tokens:50,ephemeral_1h_input_tokens:150},server_tool_use:{web_search_requests:2}}},{type:'message_stop'}];
function eventsResponse(events){return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream','request-id':'req_fixture'}});}
function client(fetchImpl,options={}){return new Anthropic(()=>'fake-unit-key',{fetchImpl,...options});}

test('chat sends compatible strict tool schemas to both token counting and generation',async()=>{
  const paths=[];
  const c=client(async(url,options)=>{
    paths.push(new URL(url).pathname);
    const sent=JSON.parse(options.body);
    assert.equal(sent.tools.length,3);
    for(const tool of sent.tools){
      assert.equal(tool.strict,true);
      assert.equal(tool.input_schema.additionalProperties,false);
      assert.deepEqual(tool.input_schema.required,Object.keys(tool.input_schema.properties));
      // Anthropic strict schemas reject numeric constraints; enforce them in the app.
      for(const rule of Object.values(tool.input_schema.properties))if(rule.type==='integer'){
        const unsupported=['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf'].filter(key=>Object.hasOwn(rule,key));
        if(unsupported.length)return new Response(JSON.stringify({error:{type:'invalid_request_error',message:`For 'integer' type, properties ${unsupported.join(', ')} are not supported`}}),{status:400});
      }
    }
    return url.endsWith('/count_tokens')?new Response(JSON.stringify({input_tokens:1000}),{headers:{'content-type':'application/json'}}):eventsResponse([initial,...ending]);
  });
  const chatRequest={...payload,model:'claude-sonnet-5-5',max_tokens:8000,tools:CHAT_TOOLS};
  assert.equal(await c.count(chatRequest),1000);
  assert.equal((await c.message(chatRequest)).data.stop_reason,'end_turn');
  assert.deepEqual(paths,['/v1/messages/count_tokens','/v1/messages']);
});

test('SDK stream preserves opaque blocks, partial tool JSON, citations, and cumulative billing',async()=>{
  let sent,calls=0;
  const events=[initial,
    {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
    {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'opaque-signature'}},{type:'content_block_stop',index:0},
    {type:'content_block_start',index:1,content_block:{type:'server_tool_use',id:'srvtoolu_1',name:'web_search',input:{}}},
    {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"query":"synthetic"}'}},{type:'content_block_stop',index:1},
    {type:'content_block_start',index:2,content_block:{type:'web_search_tool_result',tool_use_id:'srvtoolu_1',content:[{type:'web_search_result',url:'https://example.com/',title:'Fixture',encrypted_content:'opaque-search'}]}},{type:'content_block_stop',index:2},
    {type:'content_block_start',index:3,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:3,delta:{type:'text_delta',text:'Synthetic answer.'}},
    {type:'content_block_delta',index:3,delta:{type:'citations_delta',citation:{type:'web_search_result_location',url:'https://example.com/',title:'Fixture',cited_text:'Test',encrypted_index:'opaque-index'}}},{type:'content_block_stop',index:3},...ending];
  const result=await client(async(url,options)=>{calls++;sent=JSON.parse(options.body);return eventsResponse(events);}).message(payload);
  assert.equal(calls,1);assert.equal(sent.stream,true);assert.equal(sent.max_tokens,100000);assert.equal(result.requestId,'req_fixture');
  assert.equal(result.data.content[0].signature,'opaque-signature');assert.equal(result.data.content[1].input.query,'synthetic');assert.equal(result.data.content[2].content[0].encrypted_content,'opaque-search');assert.equal(result.data.content[3].citations[0].encrypted_index,'opaque-index');
  assert.equal(result.data.usage.input_tokens,500);assert.equal(result.data.usage.output_tokens,40);assert.equal(result.data.usage.cache_creation.ephemeral_1h_input_tokens,150);assert.equal(result.data.stop_details.test_detail,'retained');
  assert.equal(costMicros(result.data.usage,'review'),24310);
});
test('lost streams and errors after generation remain uncertain and are never retried',async()=>{
  for(const tail of [[],[{type:'error',error:{type:'overloaded_error',message:'Overloaded'}}]]){
    let calls=0;const c=client(async()=>{calls++;return eventsResponse([initial,...tail]);});
    await assert.rejects(c.message(payload),e=>e.ambiguous===true&&e.retryable===false);assert.equal(calls,1);
  }
});

test('cache comparison metadata reaches generation and survives streaming without entering token counts',async()=>{
  const sent=[],diagnostics={cache_miss_reason:{type:'messages_changed',cache_missed_input_tokens:450}};
  const c=client(async(url,options)=>{
    sent.push({url,body:JSON.parse(options.body)});
    if(String(url).endsWith('/count_tokens'))return new Response(JSON.stringify({input_tokens:100}),{headers:{'content-type':'application/json'}});
    return eventsResponse([{...initial,message:{...initial.message,diagnostics}},...ending]);
  });
  const request={...payload,cache_control:{type:'ephemeral',ttl:'5m'},diagnostics:{previous_message_id:'msg_previous'}};
  assert.equal(await c.count(request),100);assert.ok(!Object.hasOwn(sent[0].body,'diagnostics'));
  const result=await c.message(request);assert.deepEqual(sent[1].body.diagnostics,request.diagnostics);assert.deepEqual(result.data.diagnostics,diagnostics);assert.equal(result.data.usage.cache_read_input_tokens,300);
});

test('streamed native saved-source citations retain their location and exact cited text',async()=>{
  const citation={type:'search_result_location',source:'ahj-source:project:S1:hash',title:'Saved source',search_result_index:0,start_block_index:0,end_block_index:1,cited_text:'Exact saved evidence.'};
  const events=[initial,{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Supported finding.'}},{type:'content_block_delta',index:0,delta:{type:'citations_delta',citation}},{type:'content_block_stop',index:0},...ending];
  const result=await client(async()=>eventsResponse(events)).message(payload);assert.deepEqual(result.data.content[0].citations,[citation]);
});
test('explicit overload is retryable without SDK hidden retries',async()=>{
  let calls=0;const c=client(async()=>{calls++;return new Response(JSON.stringify({error:{type:'overloaded_error',message:'Try later'}}),{status:529,headers:{'retry-after':'240','request-id':'req_overload'}});});
  await assert.rejects(c.message(payload),e=>e.retryable&&!e.ambiguous&&e.retryAfterMs===240000&&e.requestId==='req_overload');assert.equal(calls,1);
});
test('confirmed validation and conflict responses do not retain uncertain charges',async()=>{
  for(const status of [409,422])await assert.rejects(client(async()=>new Response(JSON.stringify({error:{type:'invalid_request_error',message:'Invalid fixture request'}}),{status})).message(payload),e=>e.status===status&&!e.ambiguous&&!e.retryable);
});
test('spending caps stop retries and errors redact credentials',()=>{
  const tier=providerError({error:{type:'rate_limit_error',message:'Monthly cap',details:{error_code:'enforced_spend_limit_reached'}}},{status:429});assert.equal(tier.retryable,false);assert.equal(tier.code,'spend_limit');
  const configured=providerError({error:{type:'invalid_request_error',message:'You have reached your specified workspace API usage limits. sk-ant-secret-example'}},{status:400});assert.equal(configured.code,'spend_limit');assert.ok(!configured.message.includes('sk-ant-'));
  const rate=providerError({error:{type:'rate_limit_error',message:'Too many requests'}},{status:429,headers:new Headers({'retry-after':'300'})});assert.equal(rate.retryAfterMs,300000);assert.equal(rate.retryable,true);
});
test('REST distinguishes overload rejection from gateway uncertainty',async()=>{
  for(const [status,type,ambiguous] of [[529,'overloaded_error',false],[500,'api_error',false],[504,'timeout_error',true]]){
    const c=client(async()=>new Response(JSON.stringify({error:{type,message:'Fixture'}}),{status}));
    await assert.rejects(c.batch([]),e=>e.ambiguous===ambiguous);
  }
});
test('key checks explain network denial without exposing transport data or implying a charge',async()=>{
  const denied=Object.assign(new Error('sensitive request sk-ant-do-not-log'),{code:'EACCES'});
  const error=new TypeError('fetch failed',{cause:new AggregateError([denied])});
  let calls=0;const c=client(async()=>{calls++;throw error;});
  await assert.rejects(c.check(),e=>e.code==='network_access_denied'&&!e.ambiguous&&!e.retryable&&e.message.includes('Start AHJ Atlas.cmd')&&e.message.includes('No paid research request')&&!e.message.includes('sk-ant-')&&!e.message.includes('sensitive request'));
  assert.equal(calls,1);
  await assert.rejects(c.batch([]),e=>e.ambiguous&&e.code==='network_access_denied'&&!e.message.includes('No paid research'));
});
test('key checks distinguish DNS, timeout, certificate and interrupted connections',async()=>{
  for(const [code,expected] of [['ENOTFOUND','network_dns'],['ETIMEDOUT','network_timeout'],['UNABLE_TO_VERIFY_LEAF_SIGNATURE','network_certificate'],['ECONNRESET','network_disconnected'],['unknown-secret-value','network_error']]){
    const cause=Object.assign(new Error('private transport detail'),{code});
    await assert.rejects(client(async()=>{throw new TypeError('fetch failed',{cause});}).check(),e=>e.code===expected&&!e.ambiguous&&e.message.includes('No paid research request')&&!e.message.includes('private transport detail')&&!e.message.includes('unknown-secret-value'));
  }
});
test('whole-stream deadline still applies after response headers',async()=>{
  const c=client(async(url,options)=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(initial)}\n\n`));options.signal.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});}}),{headers:{'content-type':'text/event-stream'}}),{streamDeadlineMs:40});
  const keepAlive=setTimeout(()=>{},500);try{await assert.rejects(c.message(payload),e=>e.ambiguous);}finally{clearTimeout(keepAlive);}
});
test('model checks retain capabilities and follow model pagination',async()=>{
  const urls=[],models=[{id:'claude-sonnet-5-5',max_tokens:128000,capabilities:{batch:{supported:true}}},{id:'claude-opus-5-5',max_tokens:128000,capabilities:{structured_outputs:{supported:true}}}];
  const c=client(async url=>{urls.push(url);return new Response(JSON.stringify(urls.length===1?{data:[models[0]],has_more:true,last_id:models[0].id}:{data:[models[1]],has_more:false}),{headers:{'content-type':'application/json'}});});
  assert.equal((await c.preflight('batch')).length,2);assert.ok(urls[1].includes('after_id=claude-sonnet-5-5'));await c.preflight('realtime');assert.equal(urls.length,2);
  assert.throws(()=>validateCapabilities([{...models[0],max_tokens:1000},models[1]]),/output tokens/);
  assert.throws(()=>validateCapabilities([{...models[0],capabilities:{batch:{supported:false}}},models[1]],{mode:'batch'}),/batch/);
  const legacy=[{...models[0],id:'claude-sonnet-5'}];
  assert.throws(()=>validateCapabilities(legacy,{modelKeys:['research']}),/Claude Sonnet 5\.5 is unavailable/);
  assert.deepEqual(validateCapabilities(legacy,{modelKeys:['research'],modelIds:{research:'claude-sonnet-5'},outputLimits:{research:60000}}),legacy);
  assert.throws(()=>validateCapabilities([{...legacy[0],max_tokens:1000}],{modelKeys:['research'],modelIds:{research:'claude-sonnet-5'},outputLimits:{research:60000}}),/claude-sonnet-5 allows 1,000 output tokens/);
});
test('key connection accepts old-model-only access',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-legacy-key-')),store=new Store(dir);
  const vault={key:'',persisted:false,set(value){this.key=value;}};
  const services=await createServices({store,vault,worker:false});
  const previousFetch=globalThis.fetch;
  try{
    globalThis.fetch=async url=>{
      assert.match(String(url),/^https:\/\/api\.anthropic\.com\/v1\/models\?/);
      return new Response(JSON.stringify({data:[{id:'claude-sonnet-5',max_tokens:128000},{id:'claude-opus-5-5',max_tokens:128000}],has_more:false}),{headers:{'content-type':'application/json'}});
    };
    let result;
    await services.route({req:{method:'POST'},res:{},url:new URL('http://localhost/api/settings'),body:{key:'sk-ant-fixture-key-0000'},send:(_res,status,body)=>{result={status,body};}});
    assert.deepEqual(result,{status:200,body:{saved:true}});
    assert.equal(vault.key,'sk-ant-fixture-key-0000');
    assert.equal(services.connection().keyStatus,'connected');
  }finally{
    globalThis.fetch=previousFetch;
    await services.close();store.close();
    assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-legacy-key-')));rmSync(dir,{recursive:true,force:true});
  }
});
test('provider reports whether Anthropic accepted the key, ignoring outages',async()=>{
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  let reply='ok';const seen=[];
  const c=client(async url=>reply==='ok'?(String(url).includes('/v1/models')?json({data:[],has_more:false}):eventsResponse([initial,...ending])):reply==='rejected'?json({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}},401):json({error:{type:'overloaded_error',message:'Try later'}},529),{onKeyStatus:(...args)=>seen.push(args)});
  await c.check();await c.message(payload);
  reply='overloaded';
  await assert.rejects(c.check(),e=>e.status===529);await assert.rejects(c.message(payload),e=>e.status===529);
  reply='rejected';
  await assert.rejects(c.check(),e=>e.status===401);await assert.rejects(c.message(payload),e=>e.status===401);
  assert.deepEqual(seen.map(([key,status])=>[key,status]),[['fake-unit-key','connected'],['fake-unit-key','connected'],['fake-unit-key','invalid'],['fake-unit-key','invalid']]);
  assert.match(seen[2][2],/API key was not accepted/);
  // Each report carries when its request started so callers can order outcomes.
  assert.ok(seen.every(args=>Number.isFinite(args[3])));
  assert.ok(seen[0][3]<=seen[1][3]&&seen[1][3]<=seen[2][3]&&seen[2][3]<=seen[3][3]);
});
test('connection status verifies a remembered key and follows later rejections',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-key-status-')),store=new Store(dir),previousFetch=globalThis.fetch;
  const vault={key:'sk-ant-remembered-key-0000',persisted:true,set(value){this.key=value;},clear(){this.key='';this.persisted=false;}};
  let reply='rejected',release=null;
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  globalThis.fetch=async()=>{
    const mode=reply;
    // A held request is authorized now and answers successfully once released.
    if(mode==='held')await new Promise(resolve=>{release=resolve;});
    if(mode==='offline')throw new TypeError('fetch failed',{cause:Object.assign(new Error('lookup failed'),{code:'ENOTFOUND'})});
    if(mode==='rejected')return json({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}},401);
    if(mode==='forbidden')return json({type:'error',error:{type:'permission_error',message:'Missing models permission'}},403);
    if(mode==='overloaded')return json({type:'error',error:{type:'overloaded_error',message:'Overloaded'}},529);
    return json({data:[],has_more:false});
  };
  let services;
  const route=async(pathname,method,body={})=>{let result;await services.route({req:{method,headers:{}},res:{},url:new URL('http://localhost'+pathname),body,send:(_res,status,value)=>{result={status,body:value};}});return result;};
  const status=()=>services.connection().keyStatus;
  try{
    services=await createServices({store,vault,worker:false});
    assert.equal(status(),'checking');
    const checked=await route('/api/connection/check','POST');
    assert.equal(checked.status,200);assert.equal(checked.body.keyStatus,'invalid');assert.equal(checked.body.keyConfigured,true);
    assert.match(checked.body.keyMessage,/API key was not accepted/);assert.doesNotMatch(JSON.stringify(checked.body),/sk-ant-/);
    // New projects wait for a working key instead of spending a preflight on a rejected one.
    assert.equal((await route('/api/projects','POST',{name:'Rejected key',address:'1 Main St, Springfield, IL',discipline:'Mechanical',mode:'realtime'})).body.status,'needs_key');
    // Anthropic answered and refused: that is a rejection, not an outage.
    reply='forbidden';await services.verifyKey();
    assert.equal(status(),'invalid');assert.match(services.connection().keyMessage,/does not have permission/);
    // Transport failures and temporary server answers leave the key unverified.
    reply='overloaded';await services.verifyKey();
    assert.equal(status(),'unavailable');assert.match(services.connection().keyMessage,/temporarily overloaded/);
    reply='offline';await services.verifyKey();
    assert.equal(status(),'unavailable');assert.match(services.connection().keyMessage,/api\.anthropic\.com/);
    reply='ok';await services.verifyKey();
    assert.deepEqual([status(),services.connection().keyMessage],['connected','']);
    // A stream authorized before a revocation cannot clear a newer rejection when it finishes.
    reply='held';const older=services.engine.provider.check();await new Promise(resolve=>setImmediate(resolve));
    reply='rejected';await assert.rejects(services.engine.provider.check(),e=>e.status===401);
    assert.equal(status(),'invalid');
    release();await older;
    assert.equal(status(),'invalid');
    // A request started after the rejection may reconnect it.
    reply='ok';await services.engine.provider.check();assert.equal(status(),'connected');
    // Any later 401 from real work disconnects the key again.
    reply='rejected';await assert.rejects(services.engine.provider.check(),e=>e.status===401);
    assert.equal((await route('/api/connection','GET')).body.keyStatus,'invalid');
    // A check that finishes after the key was replaced cannot mark the new key.
    reply='held';const stale=services.verifyKey();await new Promise(resolve=>setImmediate(resolve));
    vault.key='sk-ant-replacement-key-0000';release();await stale;
    assert.equal(status(),'checking');
    assert.equal((await route('/api/connection','DELETE')).status,200);
    assert.deepEqual([status(),services.connection().keyConfigured],['missing',false]);
    const changes=store.diagnostics().filter(e=>e.event==='connection.changed').map(e=>e.details.status).reverse();
    assert.deepEqual(changes,['invalid','unavailable','connected','invalid','connected','invalid']);
    assert.doesNotMatch(JSON.stringify(store.diagnostics()),/sk-ant-(remembered|replacement)/);
  }finally{
    globalThis.fetch=previousFetch;
    await services?.close();store.close();
    assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-key-status-')));rmSync(dir,{recursive:true,force:true});
  }
});
