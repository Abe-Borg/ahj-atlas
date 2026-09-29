import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { chatPayload,projectSection,ProjectChat } from '../lib/chat.mjs';
import { CHAT_LIMITS,MODELS,costMicros } from '../lib/config.mjs';
import { ProviderError,validateCapabilities } from '../lib/provider.mjs';
import { diagnosticReport } from '../lib/diagnostics.mjs';
import { input,report,chatResponse,ChatProvider } from './fixtures.mjs';

async function setup(t,provider=new ChatProvider()){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-chat-')),app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-chat-')));rmSync(dir,{recursive:true,force:true});});
  const create=(name)=>{const p=app.store.create({...input,name});app.store.updateProject(p.id,{status:'complete',report:{...report(),summary:name+' report',gaps:[{question:name+' scope?',why:'Scope',contact:'Owner',nextStep:'Confirm.'}]}});for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete',output:name+' '+s.id+' brief'});app.store.source(p.id,{url:'https://example.com/'+name,title:name+' source',text:name+' exact source evidence and supporting record.',readFull:true});return p;};
  const a=create('ALPHA_PRIVATE'),b=create('BRAVO_PRIVATE'),{token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(id,body,command='chat',auth=true)=>fetch(`${app.url}/api/projects/${id}/${command}`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-App-Token':token}:{})},body:JSON.stringify(body)});
  return {app,provider,a,b,post,dir};
}
const body=(message='Explain the findings.',patch={})=>({clientId:randomUUID(),message,...patch});
async function settled(chat){await Promise.all([...chat.running.values()].map(j=>j.promise));}
// Answers with a final reply once the app turns tools off, otherwise asks for one lookup.
const lookupUntilFinal=(patch={})=>payload=>payload.tool_choice?.type==='none'?chatResponse('Final answer from the gathered evidence.'):chatResponse('',{stop_reason:'tool_use',content:[{type:'tool_use',id:'tool_'+randomUUID(),name:'read_project',input:{section:'report',offset:0,length:500}}],...patch});

test('native chat citations persist with their claims and recover from a completed provider response',async t=>{
  const provider=new ChatProvider(payload=>{
    const source=payload.messages[0].content.find(b=>b.type==='search_result');
    return chatResponse('',{content:[{type:'text',text:'The saved passage supports this finding.',citations:[{type:'search_result_location',source:source.source,title:source.title,cited_text:source.content[0].text,search_result_index:0,start_block_index:0,end_block_index:1}]}]});
  });
  const {app,a,dir}=await setup(t,provider),c=app.services.chat,s=app.store;
  c.start(a.id,body());await settled(c);const turn=c.view(a.id).turns[0];assert.equal(turn.status,'complete');assert.equal(turn.answerParts[0].citations[0].sourceId,'S1');assert.match(turn.answerParts[0].citations[0].quote,/ALPHA_PRIVATE/);
  const raw=s.attempts(a.id)[0].response;assert.equal(raw.content[0].citations[0].type,'search_result_location');
  s.updateChatTurn(a.id,turn.id,{status:'running',answer:'',answer_parts:[]});
  const reopened=new Store(dir);try{
    const recovered=new ProjectChat(reopened,provider,()=>true,{running:new Set()});assert.deepEqual(recovered.view(a.id).turns[0].answerParts,turn.answerParts);assert.equal(recovered.view(a.id).turns[0].status,'complete');await recovered.close();
  }finally{reopened.close();}
  assert.equal(provider.calls.length,1);assert.ok(!JSON.stringify(diagnosticReport(s)).includes('ALPHA_PRIVATE'));
});

test('native lookup citations follow all tool results, preserve metadata and keep signed messages intact',async t=>{
  const first=chatResponse('',{stop_reason:'tool_use',content:[{type:'redacted_thinking',data:'opaque-citation-signature'},{type:'tool_use',id:'saved',name:'read_saved_source',input:{sourceId:'S1',query:'',offset:0,length:1000}},{type:'tool_use',id:'context',name:'read_project',input:{section:'context',offset:0,length:1000}}]});
  const provider=new ChatProvider((payload,n)=>{
    if(n===1)return first;
    assert.deepEqual(payload.messages[1].content,first.content);
    const results=payload.messages.at(-1).content;assert.deepEqual(results.slice(0,2).map(b=>b.type),['tool_result','tool_result']);assert.ok(results.slice(2).every(b=>b.type==='text'));
    assert.ok(results[0].content.every(b=>b.type==='search_result'));assert.match(results[2].text,/nextOffset/);
    const source=results[0].content[0],index=payload.messages[0].content.filter(b=>b.type==='search_result').length;
    return chatResponse('',{content:[{type:'text',text:'A finding from the retrieved passage.',citations:[{type:'search_result_location',source:source.source,title:source.title,cited_text:source.content[0].text,search_result_index:index,start_block_index:0,end_block_index:1}]}]});
  });
  const {app,a}=await setup(t,provider);app.services.chat.start(a.id,body());await settled(app.services.chat);
  const turn=app.services.chat.view(a.id).turns[0];assert.equal(turn.status,'complete');assert.equal(turn.answerParts[0].citations[0].sourceId,'S1');assert.match(turn.answerParts[0].citations[0].quote,/ALPHA_PRIVATE/);
});

test('chat caches the evidence and earlier turns for an hour while refreshing context and the latest message',async t=>{
  const {app,provider,a,b}=await setup(t),s=app.store,c=app.services.chat;
  c.start(a.id,body('First question'));await settled(c);const first=provider.calls[0].payload;
  assert.equal(first.cache_control.ttl,'1h');assert.equal(first.messages.length,1);assert.ok(!first.tool_choice);assert.ok(first.messages.every(m=>m.role!=='system'));
  const q=s.project(a.id).questions[0];s.saveQuestion(a.id,{questionId:q.id,status:'answered',answer:'UPDATED_SCOPE'});
  s.updateProject(a.id,{note:'CURRENT_NOTE'});
  c.start(a.id,body('Second question'));await settled(c);const next=provider.calls[1].payload;
  assert.deepEqual(next.messages[0].content[0],first.messages[0].content[0]);
  const breakpoints=m=>m.content.filter(b=>b.cache_control);
  assert.equal(breakpoints(next.messages[0]).length,1);assert.equal(breakpoints(next.messages[0])[0].type,'search_result');assert.equal(breakpoints(next.messages[0])[0].cache_control.ttl,'1h');
  assert.ok(!first.messages[0].content[0].text.includes('captured'));
  // Earlier turns are real conversation: the old question joins the opening turn and the
  // saved answer is an assistant turn ending at its own breakpoint.
  assert.deepEqual(next.messages.map(m=>m.role),['user','assistant','user']);
  assert.equal(next.messages[0].content.at(-1).text,'First question');
  assert.match(next.messages[1].content[0].text,/source-linked answer/);assert.equal(next.messages[1].content[0].cache_control.ttl,'1h');
  const latest=next.messages[2].content,current=JSON.parse(latest[0].text.split('\n').slice(1).join('\n'));
  assert.match(latest[0].text,/captured/);assert.match(current.questions.text,/UPDATED_SCOPE/);assert.ok(JSON.parse(current.context.text).estimatedCost>0);assert.ok(!('budget' in JSON.parse(current.context.text)));assert.match(current.context.text,/CURRENT_NOTE/);
  assert.equal(JSON.parse(latest[1].text).earlierTurnsShown,1);assert.match(latest[2].text,/Second question/);
  assert.equal(first.diagnostics.previous_message_id,null);assert.equal(next.diagnostics.previous_message_id,'msg_chat');
  c.start(a.id,body('Follow-up question'));await settled(c);const third=provider.calls[2].payload;
  // The second request's history prefix is unchanged at the start of the third.
  assert.deepEqual(third.messages.slice(0,2).map(m=>m.content.map(({cache_control,...b})=>b)),next.messages.slice(0,2).map(m=>m.content.map(({cache_control,...b})=>b)));
  s.updateProject(a.id,{report:{...s.project(a.id).report,summary:'REVISED_EVIDENCE'}});
  c.start(a.id,body('Fourth question'));await settled(c);assert.notEqual(provider.calls[3].payload.messages[0].content[0].text,first.messages[0].content[0].text);
  c.start(b.id,body());await settled(c);assert.equal(provider.calls[4].payload.diagnostics.previous_message_id,null);assert.ok(!JSON.stringify(provider.calls[4].payload).includes(a.id));
});

test('chat accepts section capitalization without changing signed inputs or relaxing lookup checks',async t=>{
  const provider=new ChatProvider((payload,n)=>n===1?chatResponse('',{id:'msg_lookup',stop_reason:'tool_use',content:[{type:'redacted_thinking',data:'opaque-signature'},{type:'tool_use',id:'lookup',name:'read_project',input:{section:'RePoRt',offset:0,length:1000}}]}):chatResponse());
  const {app,a}=await setup(t,provider),c=app.services.chat;
  c.start(a.id,body());await settled(c);const next=provider.calls[1].payload;
  assert.equal(next.messages[1].content[1].input.section,'RePoRt');assert.equal(next.messages[1].content[0].data,'opaque-signature');assert.match(next.messages[2].content[0].content,/ALPHA_PRIVATE report/);assert.ok(!next.messages[2].content[0].is_error);
  assert.equal(next.diagnostics.previous_message_id,'msg_lookup');
  for(const section of ['Reports','__PROTO__',null,' report '])await assert.rejects(c.lookup(a.id,'read_project',{section,offset:0,length:1000}),/Invalid lookup arguments/);
  await assert.rejects(c.lookup(a.id,'read_saved_source',{sourceId:'s1',query:'',offset:0,length:1000}));
});

test('project names are required at the database and HTTP boundaries',async t=>{
  const {app}=await setup(t),{token}=await(await fetch(app.url+'/api/bootstrap')).json();
  for(const name of [undefined,'','  ','\t\n','x'.repeat(101),'Unsafe\nname']){
    assert.throws(()=>app.store.create({...input,name}),/project name/);
    const result=await fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify({...input,name})});assert.equal(result.status,400);
  }
  assert.equal(app.store.create({...input,name:'  Design package  '}).name,'Design package');
});
test('project chat defaults to Sonnet 5.5 high and includes only that project’s latest context and history',async t=>{
  const {app,provider,a,b}=await setup(t),s=app.store,c=app.services.chat;
  const q=s.project(a.id).questions[0];s.saveQuestion(a.id,{questionId:q.id,status:'answered',answer:'ALPHA_SCOPE_UPDATE'});
  const before=s.project(a.id),stages=s.stages(a.id);
  c.start(a.id,body('ALPHA_CHAT_SECRET'));await settled(c);c.start(b.id,body('BRAVO_CHAT_SECRET'));await settled(c);c.start(a.id,body('Continue this project.'));await settled(c);
  assert.equal(provider.calls.length,3);
  for(const [index,expected,excluded] of [[0,'ALPHA_PRIVATE','BRAVO_PRIVATE'],[1,'BRAVO_PRIVATE','ALPHA_PRIVATE'],[2,'ALPHA_CHAT_SECRET','BRAVO_CHAT_SECRET']]){
    const {payload,options}=provider.calls[index],text=JSON.stringify(payload);assert.match(text,new RegExp(expected));assert.ok(!text.includes(excluded));assert.equal(payload.model,'claude-sonnet-5-5');assert.equal(payload.output_config.effort,'high');assert.equal(payload.max_tokens,CHAT_LIMITS.output);assert.equal(payload.thinking.type,'adaptive');assert.ok(options.deadlineMs<=CHAT_LIMITS.activeMs);
  }
  assert.match(JSON.stringify(provider.calls[2].payload),/ALPHA_SCOPE_UPDATE/);
  assert.deepEqual(provider.preflights[0][2],{modelKeys:['research'],outputLimits:{research:CHAT_LIMITS.output},efforts:{research:'high'}});
  assert.deepEqual(s.project(a.id).report,before.report);assert.deepEqual(s.project(a.id).input,before.input);assert.equal(s.project(a.id).status,before.status);assert.deepEqual(s.stages(a.id),stages);assert.ok(s.project(a.id).cost>0);
  assert.equal(c.view(a.id).turns.length,2);assert.equal(c.view(b.id).turns.length,1);assert.equal(c.view(a.id).turns[0].modeLabel,'Standard · Claude Sonnet 5.5');
  assert.ok(!JSON.stringify(diagnosticReport(s)).includes('ALPHA_CHAT_SECRET'));
  validateCapabilities([{id:MODELS.research.id,max_tokens:CHAT_LIMITS.output}],{modelKeys:['research'],outputLimits:{research:CHAT_LIMITS.output}});
});
test('Deep and Opus replies use their model and effort, check that capability, and price at that model’s rates',async t=>{
  const {app,provider,a}=await setup(t),s=app.store,c=app.services.chat;
  c.start(a.id,body('Deep question',{mode:'deep'}));await settled(c);c.start(a.id,body('Opus question',{mode:'opus'}));await settled(c);
  const [deep,opus]=provider.calls.map(call=>call.payload);
  assert.equal(deep.model,MODELS.research.id);assert.equal(deep.output_config.effort,'max');assert.match(deep.system,/Claude Sonnet 5\.5 at max effort/);
  assert.equal(opus.model,MODELS.review.id);assert.equal(opus.output_config.effort,'xhigh');assert.match(opus.system,/Claude Opus 5\.5 at xhigh effort/);
  assert.deepEqual(provider.preflights.map(p=>p[2]),[{modelKeys:['research'],outputLimits:{research:CHAT_LIMITS.output},efforts:{research:'max'}},{modelKeys:['review'],outputLimits:{review:CHAT_LIMITS.output},efforts:{review:'xhigh'}}]);
  const deepAttempt=s.attempts(a.id).find(x=>x.model_key==='research'),opusAttempt=s.attempts(a.id).find(x=>x.model_key==='review');assert.equal(deepAttempt.model_key,'research');assert.equal(opusAttempt.model_key,'review');
  assert.equal(opusAttempt.actual,costMicros(chatResponse().usage,'review','realtime'));assert.ok(opusAttempt.actual>deepAttempt.actual);
  const view=c.view(a.id);assert.deepEqual(view.turns.map(t=>t.mode),['deep','opus']);assert.equal(view.turns[1].modeLabel,'Opus · Claude Opus 5.5');assert.deepEqual(view.modes.map(m=>m.id),['standard','deep','opus']);
  const capable={id:MODELS.research.id,max_tokens:CHAT_LIMITS.output,capabilities:{effort:{max:{supported:true}}}};
  validateCapabilities([capable],{modelKeys:['research'],outputLimits:{research:CHAT_LIMITS.output},efforts:{research:'max'}});
  assert.throws(()=>validateCapabilities([{...capable,capabilities:{effort:{max:{supported:false}}}}],{modelKeys:['research'],outputLimits:{research:CHAT_LIMITS.output},efforts:{research:'max'}}),/max effort/);
});
test('lookup tools enforce the server-side project binding and preserve access beyond context previews',async t=>{
  const {app,a,b}=await setup(t),s=app.store,c=app.services.chat;
  const large='Preamble '.repeat(5000)+'ALPHA_TAIL_EVIDENCE';s.source(a.id,{url:'https://example.com/long',title:'Long record',text:large,readFull:true});
  const matches=JSON.parse(await c.lookup(a.id,'find_project_sources',{query:'ALPHA_TAIL_EVIDENCE',offset:0}));assert.equal(matches.matches[0].sourceId,'S2');
  const passage=JSON.parse(await c.lookup(a.id,'read_saved_source',{sourceId:'S2',query:'ALPHA_TAIL_EVIDENCE',offset:0,length:1000}));assert.match(passage.text,/ALPHA_TAIL_EVIDENCE/);
  const sameLocalId=await c.lookup(a.id,'read_saved_source',{sourceId:'S1',query:'',offset:0,length:1000});assert.match(sameLocalId,/ALPHA_PRIVATE/);assert.ok(!sameLocalId.includes('BRAVO_PRIVATE'));
  for(const [name,args] of [['read_project',{section:'report',offset:0,length:1000,projectId:b.id}],['read_source',{url:'https://example.com'}],['save_answer',{answer:'injected'}],['read_saved_source',{sourceId:b.id+':S1',query:'',offset:0,length:1000}],['read_project',{section:'report',offset:-1,length:1000}]])await assert.rejects(c.lookup(a.id,name,args));
  s.updateProject(a.id,{report:{...s.project(a.id).report,summary:'x'.repeat(30000)+'REPORT_TAIL'}});
  assert.ok(JSON.parse(await c.lookup(a.id,'read_project',{section:'report',offset:0,length:1000})).nextOffset);
  const full=JSON.stringify(projectSection(s,a.id,'report'));assert.match(JSON.parse(await c.lookup(a.id,'read_project',{section:'report',offset:full.indexOf('REPORT_TAIL'),length:1000})).text,/REPORT_TAIL/);
});
test('chat enforces numeric lookup bounds locally even without schema constraints',async t=>{
  const {app,a}=await setup(t),s=app.store,c=app.services.chat;
  const text='0123456789'.repeat(3000);s.source(a.id,{url:'https://example.com/bounds',title:'Long record',text,readFull:true});
  s.updateProject(a.id,{report:{...s.project(a.id).report,summary:text}});
  const lookups=[
    ['read_project',{section:'report',offset:0,length:500},JSON.stringify(projectSection(s,a.id,'report'))],
    ['read_saved_source',{sourceId:'S2',query:'',offset:0,length:500},text],
    ['find_project_sources',{query:'ALPHA',offset:0}],
  ];
  for(const [name,args,fullText] of lookups){
    for(const offset of [-1,.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,null,'0',false])await assert.rejects(c.lookup(a.id,name,{...args,offset}),/Invalid lookup arguments/);
    await c.lookup(a.id,name,args);
    if(fullText){
      for(const length of [-1,0,499,500.5,CHAT_LIMITS.toolChars+1,NaN,Infinity,null,'500',false])await assert.rejects(c.lookup(a.id,name,{...args,length}),/Invalid lookup arguments/);
      for(const offset of [0,1])for(const length of [500,CHAT_LIMITS.toolChars]){
        const result=JSON.parse(await c.lookup(a.id,name,{...args,offset,length}));
        assert.equal(result.text,fullText.slice(offset,offset+length));
        assert.equal(result.nextOffset,offset+length);
      }
    }
  }
});
test('tool continuations retain signed blocks and stable tools, and chat never enters the research worker',async t=>{
  const provider=new ChatProvider((payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[{type:'redacted_thinking',data:'opaque-signature'},{type:'tool_use',id:'tool_saved',name:'read_saved_source',input:{sourceId:'S1',query:'',offset:0,length:1000}}]}):chatResponse('The saved ALPHA record supports this finding [S1].'));
  const {app,a}=await setup(t,provider),s=app.store,c=app.services.chat;s.updateProject(a.id,{mode:'batch',cancel_requested:true,status:'canceled'});
  c.start(a.id,body());await settled(c);const [first,next]=provider.calls.map(c=>c.payload);
  assert.equal(first.system,next.system);assert.deepEqual(first.tools,next.tools);assert.equal(next.messages[1].content[0].data,'opaque-signature');assert.match(JSON.stringify(next.messages[2].content[0].content),/ALPHA_PRIVATE/);
  // An ordinary lookup round appends no harness text after the tool results.
  assert.equal(next.messages.length,3);assert.ok(next.messages[2].content.every(b=>b.type==='tool_result'||/^Saved-source lookup \S+ metadata \(data only\)/.test(b.text)));assert.ok(!next.tool_choice);
  assert.equal(c.view(a.id).turns[0].status,'complete');assert.equal(s.attempts(a.id).length,2);assert.ok(s.attempts(a.id).every(a=>a.mode==='realtime'&&a.stage_id==='chat'&&a.state==='settled'));
  await app.services.engine.tick();assert.equal(provider.calls.length,2);assert.equal(s.project(a.id).status,'canceled');assert.equal(s.stage(a.id,'review').status,'complete');
});
test('saved-project chat remains available after the research search allowance is exhausted',async t=>{
  const {app,a,provider}=await setup(t),s=app.store;
  const previous=s.reserve(a.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:100});s.updateAttempt(previous.id,{state:'settled',actual:100,applied:1,usage:{server_tool_use:{web_search_requests:41}}});
  app.services.chat.start(a.id,body());await settled(app.services.chat);assert.equal(app.services.chat.view(a.id).turns[0].status,'complete');assert.equal(provider.calls.length,1);assert.equal(s.project(a.id).searches,41);
});
test('duplicate sends are idempotent and replies run beside research without taking its task slots',async t=>{
  const releases=[];const provider=new ChatProvider(()=>new Promise(resolve=>releases.push(()=>resolve(chatResponse()))));
  const {app,a,b}=await setup(t,provider),c=app.services.chat,e=app.services.engine,request=body('Only once');
  c.start(a.id,request);c.start(a.id,request);assert.throws(()=>c.start(a.id,body('Another A message')),/current reply/);
  c.start(b.id,{...request,message:'Only B'});
  const third=app.store.create({...input,name:'CHARLIE'});c.start(third.id,body());
  assert.equal(c.running.size,3);assert.equal(e.running.size,0);assert.deepEqual([...e.chatting].sort(),[a.id,b.id,third.id].sort());
  await assert.rejects(e.resume(a.id,{clarification:'New context'}),/current request/);
  while(releases.length<3)await new Promise(r=>setTimeout(r,1));
  releases.forEach(r=>r());await settled(c);assert.equal(provider.calls.length,3);assert.equal(e.chatting.size,0);assert.equal(c.view(a.id).turns.length,1);assert.equal(c.view(b.id).turns.length,1);
  c.start(a.id,request);assert.equal(provider.calls.length,3);assert.throws(()=>c.start(a.id,{...request,message:'changed'}),/already been used/);
});
test('chat has no spending limits and records an estimated cost for every request',async t=>{
  const heavy={usage:{input_tokens:300000,output_tokens:60000}};
  const provider=new ChatProvider((payload,n)=>n<3?lookupUntilFinal(heavy)(payload):chatResponse('Complete answer.',heavy));
  const {app,a}=await setup(t,provider),s=app.store,c=app.services.chat;
  // Retired allowance fields from an older client are ignored rather than enforced.
  c.start(a.id,body('Review everything.',{allowance:.25,projectBudget:1}));await settled(c);
  const turn=c.view(a.id).turns[0],perRequest=costMicros(heavy.usage,'research','realtime')/1e6;
  assert.equal(turn.status,'complete');assert.equal(provider.calls.length,3);assert.equal(turn.cost,Number((3*perRequest).toFixed(6)));assert.ok(turn.cost>3);
  assert.equal(s.project(a.id).cost,turn.cost);assert.ok(!Object.hasOwn(s.project(a.id),'budget'));assert.ok(!Object.hasOwn(s.project(a.id),'final_hold'));
  assert.ok(!Object.hasOwn(turn,'allowance'));assert.ok(s.spending().today>=turn.cost);
});
test('stopping a reply records completed charges and does not execute subsequent tools',async t=>{
  let release;const provider=new ChatProvider(()=>new Promise(resolve=>release=()=>resolve(chatResponse('Partial explanation.',{stop_reason:'tool_use',content:[{type:'text',text:'Partial explanation.'},{type:'tool_use',id:'not_run',name:'read_project',input:{section:'report',offset:0,length:1000}}]}))));
  const {app,a,b,post}=await setup(t,provider),c=app.services.chat;c.start(a.id,body());const turn=c.view(a.id).active;
  while(!release)await new Promise(r=>setTimeout(r,1));
  assert.equal((await post(b.id,{turnId:turn},'chat/stop')).status,400);assert.equal((await post(a.id,{turnId:turn},'chat/stop')).status,200);
  release();await settled(c);assert.equal(c.view(a.id).turns[0].status,'stopped');assert.ok(c.view(a.id).turns[0].cost>0);assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM tool_runs').get().n,0);assert.equal(provider.calls.length,1);
});
test('unknown or unusable charges stay pending without blocking chat, changing research or retrying',async t=>{
  for(const kind of ['ambiguous','usage'])await t.test(kind,async t=>{
    let fail=true;const provider=new ChatProvider(()=>{if(!fail)return chatResponse();if(kind==='ambiguous')throw new ProviderError('Lost stream',{ambiguous:true});return chatResponse('No billing',{usage:null});});
    const {app,a,post}=await setup(t,provider),s=app.store,c=app.services.chat;c.start(a.id,body());await settled(c);
    assert.equal(c.view(a.id).turns[0].status,'attention');assert.match(c.view(a.id).turns[0].note,/estimated cost stays pending/);assert.ok(s.project(a.id).reserved>0);assert.equal(s.project(a.id).status,'complete');assert.equal(provider.calls.length,1);
    fail=false;c.start(a.id,body('Another question'));await settled(c);assert.equal(c.view(a.id).turns[1].status,'complete');assert.equal(provider.calls.length,2);assert.ok(s.project(a.id).reserved>0);
    const attempt=s.attempts(a.id)[0];assert.equal((await post(a.id,{attemptId:attempt.id,actualCost:.02,note:'Synthetic confirmed charge',confirmed:true},'resolve-charge')).status,200);assert.equal(s.project(a.id).reserved,0);assert.equal(s.project(a.id).status,'complete');assert.equal(c.view(a.id).turns[0].status,'interrupted');
  });
});
test('replies wrap up with a final answer at the lookup, request and time limits',async t=>{
  for(const kind of ['lookups','requests','time'])await t.test(kind,async t=>{
    let clock=Date.now();if(kind==='time')t.mock.method(Date,'now',()=>clock);
    const provider=new ChatProvider((payload,n)=>{
      if(kind==='time')clock+=6*60*1000;
      if(kind==='lookups'&&n===1)return chatResponse('',{stop_reason:'tool_use',content:Array.from({length:CHAT_LIMITS.toolCalls+1},(_,i)=>({type:'tool_use',id:'tool_'+i,name:'read_project',input:{section:'report',offset:0,length:500}}))});
      return lookupUntilFinal()(payload);
    });
    const {app,a}=await setup(t,provider),c=app.services.chat;c.start(a.id,body());await settled(c);
    const turn=c.view(a.id).turns[0],last=provider.calls.at(-1).payload,runs=app.store.db.prepare('SELECT result FROM tool_runs').all().map(r=>JSON.parse(r.result));
    assert.equal(turn.status,'complete');assert.equal(turn.answer,'Final answer from the gathered evidence.');
    assert.deepEqual(last.tool_choice,{type:'none'});assert.equal(last.messages.at(-1).role,'system');assert.match(last.messages.at(-1).content,/final answer/);
    assert.ok(provider.calls.slice(0,-1).every(call=>!call.payload.tool_choice));
    assert.ok(runs.filter(r=>!r.isError).length<=CHAT_LIMITS.toolCalls);
    if(kind==='lookups'){assert.equal(provider.calls.length,2);assert.equal(runs.length,CHAT_LIMITS.toolCalls+1);assert.match(runs.at(-1).text,/No lookups remain/);assert.equal(runs.at(-1).isError,true);}
    if(kind==='requests'){
      assert.equal(provider.calls.length,CHAT_LIMITS.requests);
      // One advance notice near the end, then the final instruction; no per-lookup countdown.
      const notes=last.messages.filter(m=>m.role==='system');assert.equal(notes.length,2);assert.match(notes[0].content,/nearing its limits/);
      for(const message of last.messages.filter(m=>m.role==='user').slice(1))assert.ok(message.content.every(b=>b.type==='tool_result'));
    }
    if(kind==='time'){assert.equal(provider.calls.length,4);assert.ok(provider.calls.every(call=>call.options.deadlineMs>=CHAT_LIMITS.answerMs));}
  });
});
test('context and output limits stop a reply without further paid requests',async t=>{
  for(const kind of ['input','output'])await t.test(kind,async t=>{
    const provider=new ChatProvider(()=>chatResponse('Truncated',{stop_reason:'max_tokens'}));
    if(kind==='input')provider.counted=CHAT_LIMITS.input+1;
    const {app,a}=await setup(t,provider),c=app.services.chat;c.start(a.id,body());await settled(c);
    const turn=c.view(a.id).turns[0];assert.equal(turn.status,'limited');assert.equal(provider.calls.length,kind==='input'?0:1);
    if(kind==='output')assert.equal(turn.answer,'Truncated');
  });
});
test('a context window reported below the chat input ceiling lowers it for that reply',async t=>{
  const provider=new ChatProvider();provider.preflight=async function(...args){this.preflights.push(args);return [{id:MODELS.research.id,max_input_tokens:200000}];};provider.counted=150000;
  const {app,a}=await setup(t,provider),c=app.services.chat;c.start(a.id,body());await settled(c);
  assert.equal(c.view(a.id).turns[0].status,'limited');assert.equal(provider.calls.length,0);
});
test('history remains persisted, paginated and retrievable within a single project',async t=>{
  const {app,a,b,dir}=await setup(t),s=app.store,c=app.services.chat;
  for(let n=0;n<40;n++){const turn=s.createChatTurn(a.id,{clientId:randomUUID(),message:'ALPHA old message '+n});s.updateChatTurn(a.id,turn.id,{status:'complete',answer:'x'.repeat(8000)});}
  const first=c.view(a.id);assert.equal(first.turns.length,30);assert.equal(first.hasEarlier,true);const older=c.view(a.id,{before:first.turns[0].id});assert.equal(older.turns.length,10);assert.equal(older.hasEarlier,false);assert.throws(()=>c.view(b.id,{before:first.turns[0].id}),/this project/);
  const current=s.createChatTurn(a.id,{clientId:randomUUID(),message:'My newest question'}),payload=chatPayload(s,current),text=JSON.stringify(payload);
  const meta=JSON.parse(payload.messages.at(-1).content[1].text);assert.ok(meta.olderTurnsOmitted>0);assert.equal(meta.earlierTurnsShown+meta.olderTurnsOmitted,40);
  assert.ok(text.length<CHAT_LIMITS.historyChars+40000);assert.match(text,/ALPHA old message 39/);assert.ok(!text.includes('ALPHA old message 0"'));
  assert.match(JSON.stringify(projectSection(s,a.id,'conversation')),/ALPHA old message 0/);assert.ok(!JSON.stringify(projectSection(s,b.id,'conversation')).includes('ALPHA'));
  s.updateChatTurn(a.id,current.id,{status:'complete'});const reopened=new Store(dir);try{assert.equal(reopened.chatTurns(a.id).length,41);assert.equal(reopened.chatTurns(b.id).length,0);}finally{reopened.close();}
});
test('restart interrupts chat without resubmission and preserves uncertain estimates',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-chat-restart-'));let app;const provider=new ChatProvider();
  t.after(async()=>{await app?.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-chat-restart-')));rmSync(dir,{recursive:true,force:true});});
  const s=new Store(dir),p=s.create(input);s.updateProject(p.id,{status:'complete'});const turn=s.createChatTurn(p.id,{clientId:randomUUID(),message:'Interrupted'});s.reserve(p.id,'chat',{mode:'realtime',modelKey:'research',payload:{},reserve:100000,chatTurnId:turn.id});s.close();
  app=await createApp({dataDir:dir,port:0,provider,worker:false});await app.services.engine.tick();assert.equal(provider.calls.length,0);assert.equal(app.services.chat.view(p.id).turns[0].status,'attention');assert.equal(app.store.project(p.id).status,'complete');assert.equal(app.store.project(p.id).reserved,.1);
});
test('chat HTTP mutations require authorization and validate message and reply depth',async t=>{
  const {app,a,post}=await setup(t);
  assert.equal((await post(a.id,body(),'chat',false)).status,403);
  for(const value of [null,body(''),body('x'.repeat(CHAT_LIMITS.messageChars+1)),body('Hi',{clientId:'bad'}),body('Hi',{mode:'turbo'}),body('Hi',{mode:3}),body('Hi',{mode:'__proto__'})])assert.equal((await post(a.id,value)).status,400);
  assert.equal(app.store.chatTurns(a.id).length,0);
  assert.equal((await post(a.id,body('y'.repeat(CHAT_LIMITS.messageChars),{mode:'deep'}))).status,202);await settled(app.services.chat);
  assert.equal(app.store.chatTurns(a.id)[0].mode,'deep');
});
