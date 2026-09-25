import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { chatPayload,projectSection,ProjectChat } from '../lib/chat.mjs';
import { CHAT_LIMITS,MODELS } from '../lib/config.mjs';
import { ProviderError,validateCapabilities } from '../lib/provider.mjs';
import { diagnosticReport } from '../lib/diagnostics.mjs';
import { input,report,chatResponse,ChatProvider } from './fixtures.mjs';

async function setup(t,provider=new ChatProvider()){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-chat-')),app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-chat-')));rmSync(dir,{recursive:true,force:true});});
  const create=(name)=>{const p=app.store.create({...input,name,budget:10});app.store.updateProject(p.id,{status:'complete',report:{...report(),summary:name+' report',gaps:[{question:name+' scope?',why:'Scope',contact:'Owner',nextStep:'Confirm.'}]}});for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete',output:name+' '+s.id+' brief'});app.store.source(p.id,{url:'https://example.com/'+name,title:name+' source',text:name+' exact source evidence and supporting record.',readFull:true});return p;};
  const a=create('ALPHA_PRIVATE'),b=create('BRAVO_PRIVATE'),{token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(id,body,command='chat',auth=true)=>fetch(`${app.url}/api/projects/${id}/${command}`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-App-Token':token}:{})},body:JSON.stringify(body)});
  return {app,provider,a,b,post,dir};
}
const body=(message='Explain the findings.',patch={})=>({clientId:randomUUID(),message,allowance:1,...patch});
async function settled(chat){await Promise.all([...chat.running.values()].map(j=>j.promise));}

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

test('chat reuses the evidence prefix while refreshing answers, spending, context and history',async t=>{
  const {app,provider,a,b}=await setup(t),s=app.store,c=app.services.chat;
  c.start(a.id,body('First question'));await settled(c);const first=provider.calls[0].payload;
  const q=s.project(a.id).questions[0];s.saveQuestion(a.id,{questionId:q.id,status:'answered',answer:'UPDATED_SCOPE'});
  s.updateProject(a.id,{budget:11,note:'CURRENT_NOTE'});
  c.start(a.id,body('Second question'));await settled(c);const next=provider.calls[1].payload;
  assert.deepEqual(next.messages[0].content[0],first.messages[0].content[0]);
  assert.equal(next.messages[0].content[0].cache_control.ttl,'5m');
  assert.ok(!first.messages[0].content[0].text.includes('captured'));
  const current=JSON.parse(next.messages[0].content.at(-3).text.split('\n').slice(1).join('\n'));
  assert.match(current.questions.text,/UPDATED_SCOPE/);assert.equal(JSON.parse(current.context.text).budget,11);assert.ok(JSON.parse(current.context.text).cost>0);assert.match(current.context.text,/CURRENT_NOTE/);
  assert.match(next.messages[0].content.at(-2).text,/First question/);assert.match(next.messages[0].content.at(-1).text,/Second question/);
  assert.equal(first.diagnostics.previous_message_id,null);assert.equal(next.diagnostics.previous_message_id,'msg_chat');
  s.updateProject(a.id,{report:{...s.project(a.id).report,summary:'REVISED_EVIDENCE'}});
  c.start(a.id,body('Third question'));await settled(c);assert.notEqual(provider.calls[2].payload.messages[0].content[0].text,first.messages[0].content[0].text);
  c.start(b.id,body());await settled(c);assert.equal(provider.calls[3].payload.diagnostics.previous_message_id,null);assert.ok(!JSON.stringify(provider.calls[3].payload).includes(a.id));
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
test('project chat uses Sonnet 5 high and includes only that project’s latest context and history',async t=>{
  const {app,provider,a,b}=await setup(t),s=app.store,c=app.services.chat;
  const q=s.project(a.id).questions[0];s.saveQuestion(a.id,{questionId:q.id,status:'answered',answer:'ALPHA_SCOPE_UPDATE'});
  const before=s.project(a.id),stages=s.stages(a.id);
  c.start(a.id,body('ALPHA_CHAT_SECRET'));await settled(c);c.start(b.id,body('BRAVO_CHAT_SECRET'));await settled(c);c.start(a.id,body('Continue this project.'));await settled(c);
  assert.equal(provider.calls.length,3);
  for(const [index,expected,excluded] of [[0,'ALPHA_PRIVATE','BRAVO_PRIVATE'],[1,'BRAVO_PRIVATE','ALPHA_PRIVATE'],[2,'ALPHA_CHAT_SECRET','BRAVO_CHAT_SECRET']]){
    const {payload,options}=provider.calls[index],text=JSON.stringify(payload);assert.match(text,new RegExp(expected));assert.ok(!text.includes(excluded));assert.equal(payload.model,'claude-sonnet-5');assert.equal(payload.output_config.effort,'high');assert.equal(payload.max_tokens,CHAT_LIMITS.output);assert.equal(payload.thinking.type,'adaptive');assert.ok(options.deadlineMs<=CHAT_LIMITS.activeMs);
  }
  assert.match(JSON.stringify(provider.calls[2].payload),/ALPHA_SCOPE_UPDATE/);
  assert.deepEqual(provider.preflights[0][2],{modelKeys:['research'],outputLimits:{research:8000}});
  assert.deepEqual(s.project(a.id).report,before.report);assert.deepEqual(s.project(a.id).input,before.input);assert.equal(s.project(a.id).status,before.status);assert.deepEqual(s.stages(a.id),stages);assert.ok(s.project(a.id).cost>0);
  assert.equal(c.view(a.id).turns.length,2);assert.equal(c.view(b.id).turns.length,1);
  assert.ok(!JSON.stringify(diagnosticReport(s)).includes('ALPHA_CHAT_SECRET'));
  validateCapabilities([{id:MODELS.research.id,max_tokens:8000}],{modelKeys:['research'],outputLimits:{research:8000}});
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
  assert.equal(c.view(a.id).turns[0].status,'complete');assert.equal(s.attempts(a.id).length,2);assert.ok(s.attempts(a.id).every(a=>a.mode==='realtime'&&a.stage_id==='chat'&&a.state==='settled'));
  await app.services.engine.tick();assert.equal(provider.calls.length,2);assert.equal(s.project(a.id).status,'canceled');assert.equal(s.stage(a.id,'review').status,'complete');
});
test('saved-project chat remains available after the research search allowance is exhausted',async t=>{
  const {app,a,provider}=await setup(t),s=app.store;
  const previous=s.reserve(a.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:100});s.updateAttempt(previous.id,{state:'settled',actual:100,applied:1,usage:{server_tool_use:{web_search_requests:41}}});
  app.services.chat.start(a.id,body());await settled(app.services.chat);assert.equal(app.services.chat.view(a.id).turns[0].status,'complete');assert.equal(provider.calls.length,1);assert.equal(s.project(a.id).searches,41);
});
test('duplicate sends and concurrent project replies are isolated and share the two-task ceiling',async t=>{
  const releases=[];const provider=new ChatProvider(()=>new Promise(resolve=>releases.push(()=>resolve(chatResponse()))));
  const {app,a,b}=await setup(t,provider),c=app.services.chat,request=body('Only once');
  c.start(a.id,request);c.start(a.id,request);assert.throws(()=>c.start(a.id,body('Another A message')),/current reply/);
  c.start(b.id,{...request,message:'Only B'});assert.equal(c.running.size,2);assert.equal(app.services.engine.running.size,2);
  const third=app.store.create({...input,name:'CHARLIE'});assert.throws(()=>c.start(third.id,body()),/Two tasks/);
  while(releases.length<2)await new Promise(r=>setTimeout(r,1));
  releases.forEach(r=>r());await settled(c);assert.equal(provider.calls.length,2);assert.equal(c.view(a.id).turns.length,1);assert.equal(c.view(b.id).turns.length,1);
  c.start(a.id,request);assert.equal(provider.calls.length,2);assert.throws(()=>c.start(a.id,{...request,message:'changed'}),/already been used/);
});
test('chat budgets protect project/daily allowances and the final-report hold',async t=>{
  for(const limit of ['project','daily','reply'])await t.test(limit,async t=>{
    const provider=new ChatProvider(()=>chatResponse('',{stop_reason:'tool_use',content:[{type:'tool_use',id:'read',name:'read_project',input:{section:'report',offset:0,length:1000}}],usage:{input_tokens:1000,output_tokens:22000}}));
    const {app,a}=await setup(t,provider),s=app.store,c=app.services.chat;
    if(limit==='project')s.updateProject(a.id,{budget:5,final_hold:4950000});
    if(limit==='daily'){s.setSettings({dailyBudget:1});s.updateProject(a.id,{final_hold:950000});}
    const hold=s.project(a.id).final_hold;c.start(a.id,body('Review.',{allowance:.25}));await settled(c);
    assert.equal(c.view(a.id).turns[0].status,'limited');assert.equal(s.project(a.id).final_hold,hold);assert.equal(s.project(a.id).status,'complete');assert.equal(provider.calls.length,limit==='reply'?1:0);
    assert.match(c.view(a.id).turns[0].note,new RegExp(limit==='reply'?'reply’s allowance':limit==='project'?'project allowance':'daily allowance'));
  });
});
test('stopping a reply records completed charges and does not execute subsequent tools',async t=>{
  let release;const provider=new ChatProvider(()=>new Promise(resolve=>release=()=>resolve(chatResponse('Partial explanation.',{stop_reason:'tool_use',content:[{type:'text',text:'Partial explanation.'},{type:'tool_use',id:'not_run',name:'read_project',input:{section:'report',offset:0,length:1000}}]}))));
  const {app,a,b,post}=await setup(t,provider),c=app.services.chat;c.start(a.id,body());const turn=c.view(a.id).active;
  while(!release)await new Promise(r=>setTimeout(r,1));
  assert.equal((await post(b.id,{turnId:turn},'chat/stop')).status,400);assert.equal((await post(a.id,{turnId:turn},'chat/stop')).status,200);
  release();await settled(c);assert.equal(c.view(a.id).turns[0].status,'stopped');assert.ok(c.view(a.id).turns[0].cost>0);assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM tool_runs').get().n,0);assert.equal(provider.calls.length,1);
});
test('unknown or unusable charges stay reserved without changing research or retrying',async t=>{
  for(const kind of ['ambiguous','usage'])await t.test(kind,async t=>{
    const provider=new ChatProvider(()=>{if(kind==='ambiguous')throw new ProviderError('Lost stream',{ambiguous:true});return chatResponse('No billing',{usage:null});});
    const {app,a,post}=await setup(t,provider),s=app.store,c=app.services.chat;c.start(a.id,body());await settled(c);
    assert.equal(c.view(a.id).turns[0].status,'attention');assert.ok(s.project(a.id).reserved>0);assert.equal(s.project(a.id).status,'complete');assert.throws(()=>c.start(a.id,body()),/uncertain charge/);assert.equal(provider.calls.length,1);
    const attempt=s.attempts(a.id)[0];assert.equal((await post(a.id,{attemptId:attempt.id,actualCost:.02,note:'Synthetic confirmed charge',confirmed:true},'resolve-charge')).status,200);assert.equal(s.project(a.id).reserved,0);assert.equal(s.project(a.id).status,'complete');assert.equal(c.view(a.id).turns[0].status,'interrupted');
  });
});
test('input, output, lookup and request limits stop additional paid requests',async t=>{
  for(const kind of ['input','output','tools','rounds'])await t.test(kind,async t=>{
    const provider=new ChatProvider(()=>kind==='output'?chatResponse('Truncated',{stop_reason:'max_tokens'}):chatResponse('',{stop_reason:'tool_use',content:Array.from({length:kind==='tools'?9:1},(_,i)=>({type:'tool_use',id:'tool_'+i,name:'read_project',input:{section:'report',offset:0,length:500}}))}));
    if(kind==='input')provider.counted=60001;
    const {app,a}=await setup(t,provider),c=app.services.chat;c.start(a.id,body());await settled(c);
    assert.equal(c.view(a.id).turns[0].status,'limited');assert.equal(provider.calls.length,kind==='input'?0:kind==='rounds'?4:1);
    assert.ok(app.store.db.prepare('SELECT COUNT(*) n FROM tool_runs').get().n<=8);
  });
});
test('history remains persisted, paginated and retrievable within a single project',async t=>{
  const {app,a,b,dir}=await setup(t),s=app.store,c=app.services.chat;
  for(let n=0;n<40;n++){const turn=s.createChatTurn(a.id,{clientId:randomUUID(),message:'ALPHA old message '+n,allowance:1});s.updateChatTurn(a.id,turn.id,{status:'complete',answer:'x'.repeat(4000)});}
  const first=c.view(a.id);assert.equal(first.turns.length,30);assert.equal(first.hasEarlier,true);const older=c.view(a.id,{before:first.turns[0].id});assert.equal(older.turns.length,10);assert.equal(older.hasEarlier,false);assert.throws(()=>c.view(b.id,{before:first.turns[0].id}),/this project/);
  const current=s.createChatTurn(a.id,{clientId:randomUUID(),message:'My newest question',allowance:1}),payload=chatPayload(s,current);assert.match(JSON.stringify(payload),/olderTurnsOmitted/);assert.ok(JSON.stringify(payload).length<130000);
  assert.match(JSON.stringify(projectSection(s,a.id,'conversation')),/ALPHA old message 0/);assert.ok(!JSON.stringify(projectSection(s,b.id,'conversation')).includes('ALPHA'));
  s.updateChatTurn(a.id,current.id,{status:'complete'});const reopened=new Store(dir);try{assert.equal(reopened.chatTurns(a.id).length,41);assert.equal(reopened.chatTurns(b.id).length,0);}finally{reopened.close();}
});
test('restart interrupts chat without resubmission and preserves uncertain reservations',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-chat-restart-'));let app;const provider=new ChatProvider();
  t.after(async()=>{await app?.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-chat-restart-')));rmSync(dir,{recursive:true,force:true});});
  const s=new Store(dir),p=s.create(input);s.updateProject(p.id,{status:'complete'});const turn=s.createChatTurn(p.id,{clientId:randomUUID(),message:'Interrupted',allowance:1});s.reserve(p.id,'chat',{mode:'realtime',modelKey:'research',payload:{},reserve:100000,chatTurnId:turn.id});s.close();
  app=await createApp({dataDir:dir,port:0,provider,worker:false});await app.services.engine.tick();assert.equal(provider.calls.length,0);assert.equal(app.services.chat.view(p.id).turns[0].status,'attention');assert.equal(app.store.project(p.id).status,'complete');assert.equal(app.store.project(p.id).reserved,.1);
});
test('chat HTTP mutations require authorization and validate message and allowance bounds',async t=>{
  const {app,a,post}=await setup(t);
  assert.equal((await post(a.id,body(),'chat',false)).status,403);
  for(const value of [null,body(''),body('x'.repeat(6001)),body('Hi',{clientId:'bad'}),body('Hi',{allowance:20}),body('Hi',{projectBudget:101})])assert.equal((await post(a.id,value)).status,400);
  assert.equal(app.store.chatTurns(a.id).length,0);
});
