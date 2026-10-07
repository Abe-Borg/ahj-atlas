import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { ProjectChat,projectSection } from '../lib/chat.mjs';
import { CHAT_LIMITS,MODELS,costMicros } from '../lib/config.mjs';
import { ProviderError,validateCapabilities } from '../lib/provider.mjs';
import { ChatProvider,chatResponse,input,report,evidenceText } from './fixtures.mjs';

function setup(t,provider=new ChatProvider()){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-haiku-chat-')),store=new Store(dir);
  const project=store.create(input);store.updateProject(project.id,{status:'complete',report:report()});
  store.source(project.id,{url:'https://example.com/adoption',title:'Synthetic adoption record',text:evidenceText,readFull:true});
  const chat=new ProjectChat(store,provider,()=>true,{running:new Set()});
  t.after(async()=>{await chat.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,chat,provider,id:project.id};
}
const body=(message='Explain the findings.',mode='economy')=>({clientId:randomUUID(),message,mode});
async function settled(chat){await Promise.all([...chat.running.values()].map(j=>j.promise));}
const opening=payload=>{
  const blocks=payload.messages[0].content,end=blocks.findIndex(b=>b.cache_control)+1;
  assert.ok(end>0);return blocks.slice(0,end).map(({cache_control,...b})=>b);
};
const excerptSize=payload=>opening(payload).filter(b=>b.type==='search_result').reduce((n,b)=>n+b.content.reduce((n,x)=>n+x.text.length,0),0);
const snapshot=payload=>JSON.parse(opening(payload)[0].text.split('\n').slice(1).join('\n'));
const latest=payload=>payload.messages.at(-1).content;

test('Economy dates each new reply while keeping its system unchanged across midnight and signed lookups',async t=>{
  const beforeMidnight=Date.parse('2026-10-07T23:59:59Z');
  t.mock.timers.enable({apis:['Date'],now:beforeMidnight});
  const signed={type:'thinking',thinking:'',signature:'haiku-date-signature'};
  const provider=new ChatProvider((payload,n)=>{
    if(n===1){
      assert.match(payload.system,/The current date is 2026-10-07 \(UTC\)/);
      assert.match(payload.system,/Search current official sources before answering about facts that may have changed/);
      assert.match(payload.system,/country or region in location-dependent search queries/);
      assert.match(payload.system,/Stable explanations and summaries of saved evidence need no new search/);
      assert.match(payload.system,/user approval for changes even after repeated requests/);
      t.mock.timers.setTime(beforeMidnight+2000);
      return chatResponse('',{stop_reason:'tool_use',content:[signed,{type:'tool_use',id:'dated_lookup',name:'read_project',input:{section:'report',offset:0,length:1000}}]});
    }
    if(n===2){
      assert.equal(payload.system,provider.calls[0].payload.system);
      assert.deepEqual(payload.tools,provider.calls[0].payload.tools);
      assert.deepEqual(payload.messages.find(m=>m.role==='assistant').content[0],signed);
      assert.equal(payload.output_config.effort,'medium');
    }else assert.match(payload.system,/The current date is 2026-10-08 \(UTC\)/);
    return chatResponse('Answer from the saved project.');
  });
  const {chat,id}=setup(t,provider);
  chat.start(id,body());await settled(chat);
  chat.start(id,body('A follow-up.'));await settled(chat);
  assert.equal(provider.calls.length,3);
  assert.ok(chat.view(id).turns.every(turn=>turn.status==='complete'));
});

test('Economy runs Haiku with medium effort and preserves signed tool history and native citations',async t=>{
  const first=chatResponse('',{stop_reason:'tool_use',content:[
    {type:'thinking',thinking:'Opaque Haiku internal reasoning.',signature:'haiku-thinking-signature'},
    {type:'tool_use',id:'saved_source',name:'read_saved_source',input:{sourceId:'S1',query:'',offset:0,length:2000}},
    {type:'tool_use',id:'context',name:'read_project',input:{section:'context',offset:0,length:1000}},
  ]});
  let env;
  const provider=new ChatProvider((payload,n,options)=>{
    assert.equal(payload.model,'claude-haiku-5-5');assert.deepEqual(payload.thinking,{type:'adaptive',display:'omitted'});
    assert.equal(payload.output_config.effort,'medium');assert.equal(payload.max_tokens,128000);
    assert.match(payload.system,/Claude Haiku 5\.5 at medium effort/);
    if(n===1){
      options.onEvent({type:'message_start',message:{}});
      options.onEvent({type:'content_block_start',index:0,content_block:first.content[0]});
      options.onEvent({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Do not expose this internal reasoning.'}});
      assert.equal(env.store.chatTurns(env.id)[0].note,'Thinking…');
      return first;
    }
    assert.equal(n,2);assert.deepEqual(payload.messages.slice(0,provider.calls[0].payload.messages.length),provider.calls[0].payload.messages);
    assert.deepEqual(payload.messages.find(m=>m.role==='assistant').content,first.content);
    assert.deepEqual(payload.tools,provider.calls[0].payload.tools);assert.equal(payload.system,provider.calls[0].payload.system);
    const results=payload.messages.at(-1).content;assert.deepEqual(results.slice(0,2).map(b=>b.type),['tool_result','tool_result']);
    assert.equal(results[0].content[0].type,'search_result');assert.ok(results.slice(2).every(b=>b.type==='text'));
    const source=results[0].content[0],index=opening(payload).filter(b=>b.type==='search_result').length;
    return chatResponse('',{content:[{type:'thinking',thinking:'Another hidden block.',signature:'haiku-final-signature'},{type:'text',text:'The district adopts the fixture code.',citations:[{type:'search_result_location',source:source.source,title:source.title,cited_text:source.content[0].text,search_result_index:index,start_block_index:0,end_block_index:1}]}]});
  });
  env=setup(t,provider);env.chat.start(env.id,body());await settled(env.chat);
  const turn=env.chat.view(env.id).turns[0];assert.equal(turn.status,'complete');assert.equal(turn.mode,'economy');assert.equal(turn.modeLabel,'Economy · Claude Haiku 5.5');
  assert.equal(turn.answer,'The district adopts the fixture code.');assert.equal(turn.answerParts[0].citations[0].sourceId,'S1');assert.equal(turn.answerParts[0].citations[0].quote,evidenceText);
  assert.ok(!JSON.stringify(turn).includes('internal reasoning'));assert.equal(provider.calls.length,2);
  assert.deepEqual(provider.preflights[0][2],{modelKeys:['economy'],outputLimits:{economy:128000},efforts:{economy:'medium'}});
  assert.deepEqual(env.store.attempts(env.id).map(a=>a.model_key),['economy','economy']);
});

test('Economy can chat with Haiku-only access and keeps the provider context-window allowance',async t=>{
  const provider=new ChatProvider();provider.counted=800000;
  provider.preflight=async function(mode,context,options){
    this.preflights.push([mode,context,options]);
    return validateCapabilities([{id:MODELS.economy.id,max_tokens:128000,max_input_tokens:1000000,capabilities:{thinking:{supported:true,types:{adaptive:{supported:true}}},effort:{medium:{supported:true}},structured_outputs:{supported:false}}}],options);
  };
  const {chat,id}=setup(t,provider);chat.start(id,body());await settled(chat);
  assert.equal(chat.view(id).turns[0].status,'complete');assert.equal(provider.calls.length,1);assert.equal(provider.calls[0].payload.max_tokens,CHAT_LIMITS.output);
});

test('mode changes rebuild bounded Economy evidence, share Standard/Premium openings and retain full records in project tools',async t=>{
  const provider=new ChatProvider((payload,n)=>chatResponse(n===1?'EARLIER_FULL_ANSWER '+ 'h'.repeat(70000):'A short reply.'));
  const {chat,store,id}=setup(t,provider);
  store.updateProject(id,{report:{...report(),summary:'r'.repeat(100000)+' FULL_REPORT_TAIL'}});
  for(const stage of store.stages(id))store.updateStage(id,stage.id,{output:'s'.repeat(30000)+' FULL_STAGE_TAIL'});
  for(let n=0;n<8;n++)store.source(id,{url:'https://example.com/long-'+n,title:'Long fixture '+n,text:('Source '+n+' fixture passage. ').repeat(4500),readFull:true});
  chat.start(id,body('Start in Standard.','standard'));await settled(chat);const standard=provider.calls[0].payload;
  chat.start(id,body('Continue in Premium.','opus'));await settled(chat);const premium=provider.calls[1].payload;
  assert.deepEqual(opening(premium),opening(standard));assert.ok(JSON.stringify(premium).includes('EARLIER_FULL_ANSWER'));
  chat.start(id,body('Use Economy.'));await settled(chat);const economy=provider.calls[2].payload;
  assert.notDeepEqual(opening(economy),opening(standard));assert.ok(excerptSize(economy)<=CHAT_LIMITS.economy.excerptChars);assert.ok(excerptSize(standard)>CHAT_LIMITS.economy.excerptChars);
  assert.equal(snapshot(economy).report.text.length,40000);assert.equal(snapshot(economy).research.text.length,40000);assert.ok(snapshot(economy).report.nextOffset);
  assert.ok(!JSON.stringify(economy).includes('FULL_REPORT_TAIL'));assert.ok(!JSON.stringify(economy).includes('EARLIER_FULL_ANSWER'));
  const historySummary=latest(economy).find(b=>b.type==='text'&&b.text.startsWith('{"earlierTurnsShown"'));
  assert.equal(JSON.parse(historySummary.text).earlierTurnsShown,1);assert.equal(JSON.parse(historySummary.text).olderTurnsOmitted,1);
  const reportText=JSON.stringify(projectSection(store,id,'report'));
  const reportTail=JSON.parse(await chat.lookup(id,'read_project',{section:'report',offset:reportText.indexOf('FULL_REPORT_TAIL'),length:1000}));assert.match(reportTail.text,/FULL_REPORT_TAIL/);
  const source=store.sources(id).find(s=>s.title==='Long fixture 7');
  const sourceTail=JSON.parse(await chat.lookup(id,'read_saved_source',{sourceId:source.id,query:'',offset:source.text.length-1000,length:1000}));assert.equal(sourceTail.text,source.text.slice(-1000));
  const conversation=JSON.stringify(projectSection(store,id,'conversation'));assert.ok(conversation.includes('EARLIER_FULL_ANSWER'));
  chat.start(id,body('Stay in Economy.'));await settled(chat);assert.deepEqual(opening(provider.calls[3].payload),opening(economy));
  chat.start(id,body('Return to Standard.','standard'));await settled(chat);assert.deepEqual(opening(provider.calls[4].payload),opening(standard));
  assert.ok(JSON.stringify(provider.calls[4].payload).includes('EARLIER_FULL_ANSWER'));
});

test('Economy folds large new source updates into its bounded opening on the next reply',async t=>{
  const {chat,store,provider,id}=setup(t);chat.start(id,body());await settled(chat);const first=opening(provider.calls[0].payload);
  store.source(id,{url:'https://example.com/new',title:'New retrieved source',text:'New source supported fact. '.repeat(2000),readFull:true});
  chat.start(id,body('Read the new source.'));await settled(chat);const next=provider.calls[1].payload;
  assert.notDeepEqual(opening(next),first);assert.ok(opening(next).some(b=>b.title==='S2: New retrieved source'));
  assert.ok(excerptSize(next)<=CHAT_LIMITS.economy.excerptChars);assert.ok(!JSON.stringify(latest(next)).includes('New or updated project sources since'));
});

test('Economy conservatively estimates aggregate long cached usage when native sampling iterations are unavailable',async t=>{
  const usage={input_tokens:1000,output_tokens:400,cache_read_input_tokens:90000,cache_creation_input_tokens:10001,cache_creation:{ephemeral_5m_input_tokens:1,ephemeral_1h_input_tokens:10000},server_tool_use:{web_search_requests:1}};
  const provider=new ChatProvider(()=>chatResponse('A cached finding.',{usage}));provider.counted=95000;
  const {chat,store,id}=setup(t,provider);chat.start(id,body());await settled(chat);
  const attempt=store.attempts(id)[0],turn=chat.view(id).turns[0];assert.equal(turn.status,'complete');assert.equal(attempt.model_key,'economy');assert.equal(attempt.estimated,1);
  // All input categories count toward the 100k threshold; search is billed separately.
  assert.equal(attempt.actual,Math.ceil(1000*.5+400*2.5+90000*.05+1*.5*1.25+10000*.5*2+10000));
  assert.equal(attempt.actual,costMicros(usage,'economy','realtime',attempt.pricing));assert.equal(turn.cost,attempt.actual/1e6);assert.equal(store.project(id).reserved,0);
});

test('Economy prices native server-tool sampling iterations independently without treating their sum as one long prompt',async t=>{
  const iterations=[0,1].map(()=>({type:'message',input_tokens:500,output_tokens:200,cache_read_input_tokens:90000,cache_creation_input_tokens:0}));
  const usage={input_tokens:1000,output_tokens:400,cache_read_input_tokens:180000,cache_creation_input_tokens:0,server_tool_use:{web_search_requests:1},iterations};
  const provider=new ChatProvider(()=>chatResponse('A finding after native search.',{usage}));provider.counted=90500;
  const {chat,store,id}=setup(t,provider);chat.start(id,body());await settled(chat);
  const attempt=store.attempts(id)[0];assert.equal(chat.view(id).turns[0].status,'complete');assert.equal(attempt.estimated,0);
  assert.equal(attempt.actual,1000*.1+400*.5+180000*.01+10000);assert.equal(attempt.actual,costMicros(usage,'economy','realtime',attempt.pricing));
});

test('an interrupted Economy stream records partial usage without losing its reserved pricing tier',async t=>{
  const provider=new ChatProvider(()=>{
    const error=new ProviderError('Synthetic interrupted Haiku stream.',{requestId:'req_haiku_partial',ambiguous:false});
    Object.assign(error,{partialUsage:{input_tokens:1000,output_tokens:0},streamedCharacters:1600});throw error;
  });provider.counted=100001;
  const {chat,store,id}=setup(t,provider);chat.start(id,body());await settled(chat);
  const attempt=store.attempts(id)[0],turn=chat.view(id).turns[0];assert.equal(turn.status,'failed');assert.equal(attempt.state,'errored');assert.equal(attempt.estimated,1);
  assert.equal(attempt.actual,1000*.5+400*2.5);assert.equal(attempt.usage.output_tokens,400);assert.equal(attempt.request_id,'req_haiku_partial');
  assert.match(turn.note,/Estimated cost: \$0\.001500 recorded automatically/);assert.equal(turn.reserved,0);assert.equal(store.project(id).reserved,0);
});
