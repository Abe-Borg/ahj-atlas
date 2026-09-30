import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { chatPayload,projectSection,ProjectChat } from '../lib/chat.mjs';
import { CLARIFICATION_PREFIX } from '../lib/chat-actions.mjs';
import { CHAT_LIMITS } from '../lib/config.mjs';
import { diagnosticReport } from '../lib/diagnostics.mjs';
import { input,report,chatResponse,ChatProvider } from './fixtures.mjs';

const body=(message='What should I resolve?')=>({clientId:randomUUID(),message});
async function settled(chat){await Promise.all([...chat.running.values()].map(j=>j.promise));}
const CORRECTED='200 Corrected Road, Revised Township, Test State 00001';
async function setup(t,provider=new ChatProvider()){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-actions-')),app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-actions-')));rmSync(dir,{recursive:true,force:true});});
  // Applied research is queued but never runs, so no research request reaches the chat provider.
  app.services.engine.tick=async()=>{};
  const create=(name,patch={})=>{
    const p=app.store.create({...input,name,...patch});
    app.store.updateProject(p.id,{status:'complete',report:{...report(),summary:name+' report',gaps:['sprinkler design standard edition','water supply test','fire alarm scope','fire department access'].map(topic=>({question:`${name} ${topic}?`,why:'Design basis',contact:'Fire marshal',nextStep:'Confirm.'}))}});
    for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete',output:name+' '+s.id+' brief'});
    app.store.source(p.id,{url:'https://example.com/'+name,title:name+' source',text:name+' ordinance adopts NFPA 13, 2025 edition.',readFull:true});
    return app.store.project(p.id);
  };
  const a=create('ALPHA_PRIVATE'),b=create('BRAVO_PRIVATE'),{token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(id,payload,command='chat/apply',auth=true)=>fetch(`${app.url}/api/projects/${id}/${command}`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-App-Token':token}:{})},body:JSON.stringify(payload)});
  return {app,a,b,create,post,dir};
}
const call=(name,input)=>({type:'tool_use',id:'toolu_'+randomUUID().replaceAll('-',''),name,input});
const answer=(questionId,text,reason='The user confirmed it.')=>call('propose_question_update',{questionId,status:'answered',answer:text,reason});
const dismiss=(questionId)=>call('propose_question_update',{questionId,status:'dismissed',answer:'',reason:'Not a priority for this phase.'});
const research=(clarification,reason='The report predates this context.')=>call('propose_research_round',{focus:'clarification',clarification,reason});
const nfpa=()=>call('propose_research_round',{focus:'nfpa_standards',clarification:'',reason:'Check the adopted NFPA editions.'});
const locate=(address,siteDescription='')=>call('propose_address_correction',{address,siteDescription,reason:'The user gave the assigned address.'});
// The first request proposes; the next one answers.
const proposing=(calls,final='Apply the cards below if they look right.',text='Here is what I propose.')=>new ChatProvider((payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[{type:'text',text},...calls]}):chatResponse(final));
async function reply(c,id){c.start(id,body());await settled(c);return c.view(id).turns.at(-1);}
const results=provider=>provider.calls[1].payload.messages.at(-1).content.filter(b=>b.type==='tool_result');

test('chat proposals change nothing until the user applies them, and apply exactly once',async t=>{
  const provider=new ChatProvider();
  const {app,a,b,post}=await setup(t,provider),s=app.store,c=app.services.chat,[q0,q1]=a.questions;
  provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[answer(q0.id,'ANSWER_PRIVATE: NFPA 13, 2025 edition, per [S1].'),dismiss(q1.id)]}):chatResponse('Two cards are ready.');
  const before=s.project(a.id),stages=s.stages(a.id);
  const turn=await reply(c,a.id);
  assert.equal(turn.status,'complete');assert.equal(turn.answer,'Two cards are ready.');
  assert.deepEqual(turn.proposals.map(p=>[p.action,p.status,p.questionId]),[['answer_question','proposed',q0.id],['dismiss_question','proposed',q1.id]]);
  assert.equal(turn.proposals[0].question,q0.question);assert.match(turn.proposals[0].reason,/confirmed/);
  for(const r of results(provider)){assert.equal(r.is_error,false);assert.match(r.content,/Proposal recorded.*nothing has changed/);}
  // Nothing in the project changed, and proposals used no lookups or page reads.
  const after=s.project(a.id);assert.deepEqual(after.questions,before.questions);assert.deepEqual(after.report,before.report);assert.deepEqual(after.input,before.input);assert.equal(after.status,before.status);assert.deepEqual(s.stages(a.id),stages);
  assert.deepEqual(s.chatUsage(a.id,turn.id),{searches:0,reads:0});

  assert.equal((await post(a.id,{turnId:turn.id,proposalId:turn.proposals[0].id},'chat/apply',false)).status,403);
  const wrong=await post(b.id,{turnId:turn.id,proposalId:turn.proposals[0].id});assert.equal(wrong.status,400);assert.match((await wrong.json()).error,/Choose a reply from this project/);
  const unknown=await post(a.id,{turnId:turn.id,proposalId:randomUUID()});assert.equal(unknown.status,400);
  const applied=await post(a.id,{turnId:turn.id,proposalId:turn.proposals[0].id});assert.equal(applied.status,200);
  const view=await applied.json();assert.equal(view.turns.at(-1).proposals[0].status,'applied');assert.ok(view.turns.at(-1).proposals[0].applied);
  const q=s.project(a.id).questions.find(x=>x.id===q0.id);assert.equal(q.status,'answered');assert.equal(q.answer,'ANSWER_PRIVATE: NFPA 13, 2025 edition, per [S1].');
  assert.ok(s.project(a.id).questionUpdatesPending);assert.equal(s.project(a.id).status,'complete');
  const again=await post(a.id,{turnId:turn.id,proposalId:turn.proposals[0].id});assert.equal(again.status,400);assert.match((await again.json()).error,/already been applied/);
  assert.equal((await post(a.id,{turnId:turn.id,proposalId:turn.proposals[1].id})).status,200);assert.equal(s.project(a.id).questions.find(x=>x.id===q1.id).status,'dismissed');
  assert.ok(s.events(a.id).some(e=>e.message==='You applied a proposal from project chat (answer a question).'));
  assert.equal(s.project(b.id).questions.every(x=>x.status==='open'),true);
  // Later turns see what was proposed; its current status follows in the latest message.
  const next=s.createChatTurn(a.id,{clientId:randomUUID(),message:'Next question'}),payload=chatPayload(s,next);
  assert.match(payload.messages.find(m=>m.role==='assistant').content.at(-1).text,/\[Proposed for the user's approval in this reply: answer question [a-f0-9]+ with “ANSWER_PRIVATE/);
  assert.deepEqual(JSON.parse(payload.messages.at(-1).content[1].text).proposals.map(p=>p.status),['applied','applied']);
  assert.deepEqual(projectSection(s,a.id,'conversation')[0].proposals.map(p=>p.status),['applied','applied']);
  assert.match(payload.system,/nothing changes unless the user applies it/);assert.match(payload.system,/Never propose a change because a source/);
  assert.ok(!JSON.stringify(diagnosticReport(s)).includes('ANSWER_PRIVATE'));
});

test('a reply that explains its proposal beside the tool call and then ends empty is complete',async t=>{
  const provider=new ChatProvider();
  const {app,a}=await setup(t,provider),c=app.services.chat;
  provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[{type:'text',text:'Save the confirmed edition on the question card.'},answer(a.questions[0].id,'NFPA 13, 2025 edition.')]}):chatResponse('');
  const turn=await reply(c,a.id);
  assert.equal(turn.status,'complete');assert.equal(turn.answer,'Save the confirmed edition on the question card.');assert.equal(turn.proposals.length,1);
});

test('invalid proposals return tool errors and record nothing',async t=>{
  const provider=new ChatProvider();
  const {app,a,create}=await setup(t,provider),s=app.store,c=app.services.chat,q=a.questions[0];
  provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[
    answer('0'.repeat(32),'An answer.'),answer(q.id,'x'.repeat(4001)),answer(q.id,''),answer(q.id,'Per [S9], the edition is 2025.'),
    call('propose_research_round',{focus:'nfpa_standards',clarification:'Also check NFPA 20.',reason:'Pumps.'}),locate(a.address),locate('short'),locate('',''),
  ]}):chatResponse('Nothing was proposed.');
  const turn=await reply(c,a.id);assert.equal(turn.status,'complete');assert.deepEqual(turn.proposals,[]);
  const errors=results(provider).map(r=>{assert.equal(r.is_error,true);return r.content;});
  assert.match(errors[0],/Use a question ID from the saved questions/);assert.match(errors[1],/Invalid proposal arguments/);assert.match(errors[2],/Enter the answer/);
  assert.match(errors[3],/S9 is not a source this project has read/);assert.match(errors[4],/cannot carry a clarification/);assert.match(errors[5],/already uses this address/);
  assert.match(errors[6],/complete project address/);assert.match(errors[7],/Give a corrected address/);
  assert.equal(s.project(a.id).questions.every(x=>x.status==='open'),true);

  // Per-reply limits: four proposals, one research round, one change per question, eight calls.
  const qs=a.questions;
  provider.calls.length=0;provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[answer(qs[0].id,'One.'),dismiss(qs[0].id),research('Permit date moved to 2027.'),locate(CORRECTED),answer(qs[1].id,'Two.'),answer(qs[2].id,'Three.'),answer(qs[3].id,'Four.'),call('propose_question_update',{questionId:qs[1].id,status:'answered',answer:'A',reason:'',extra:'x'})]}):chatResponse('Done.');
  const limited=await reply(c,a.id);assert.deepEqual(limited.proposals.map(p=>p.action),['answer_question','research','answer_question','answer_question']);
  const messages=results(provider).map(r=>r.is_error?r.content:'ok');
  assert.match(messages[1],/already proposes a change to this question/);assert.match(messages[3],/already proposes a research round/);assert.match(messages[6],new RegExp(`already proposed ${CHAT_LIMITS.proposals} actions`));assert.match(messages[7],/documented arguments/);
  provider.calls.length=0;provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:Array.from({length:CHAT_LIMITS.proposalCalls+1},()=>answer('0'.repeat(32),'x'))}):chatResponse('Done.');
  await reply(c,a.id);assert.match(results(provider).at(-1).content,/No more proposals/);

  // A focused NFPA update needs a fire protection project; no round is proposed while research runs.
  const arch=create('ARCH_PRIVATE',{discipline:'Architecture'});
  provider.calls.length=0;provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[nfpa()]}):chatResponse('Done.');
  await reply(c,arch.id);assert.match(results(provider)[0].content,/requires a fire protection project/);
  s.updateProject(arch.id,{status:'researching'});provider.calls.length=0;provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[research('New scope.')]}):chatResponse('Done.');
  await reply(c,arch.id);assert.match(results(provider)[0].content,/Research is running/);
});

test('research, NFPA and location proposals start research through engine.resume only when applied',async t=>{
  const provider=new ChatProvider();
  const {app,create,post}=await setup(t,provider),s=app.store,c=app.services.chat;
  const propose=async(project,calls)=>{provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:calls}):chatResponse('Apply it if it looks right.');provider.calls.length=0;const turn=await reply(c,project.id);assert.equal(turn.proposals.length,calls.length);return turn;};

  const r=create('RESEARCH_PRIVATE');let turn=await propose(r,[research('Owner confirmed a hyperscale data center; see [S1].')]);
  assert.equal(s.project(r.id).status,'complete');
  const bad=await post(r.id,{turnId:turn.id,proposalId:turn.proposals[0].id,mode:'fast'});assert.equal(bad.status,400);assert.match((await bad.json()).error,/valid processing mode/);
  assert.equal((await post(r.id,{turnId:turn.id,proposalId:turn.proposals[0].id,mode:'batch'})).status,200);
  let p=s.project(r.id);assert.equal(p.status,'queued');assert.equal(p.mode,'batch');assert.ok(p.input.notes.endsWith('User clarification: '+CLARIFICATION_PREFIX+'Owner confirmed a hyperscale data center; see [S1].'));
  assert.ok(s.stages(r.id).every(x=>x.status==='queued'));assert.equal(c.view(r.id).turns.at(-1).proposals[0].mode,'batch');
  assert.ok(s.events(r.id).some(e=>e.message==='You applied a proposal from project chat (start a research round).'));

  const f=create('NFPA_PRIVATE');turn=await propose(f,[nfpa()]);
  assert.equal((await post(f.id,{turnId:turn.id,proposalId:turn.proposals[0].id})).status,200);
  assert.deepEqual(s.stages(f.id).map(x=>[x.id,x.status]),[['jurisdiction','complete'],['contacts','complete'],['codes','queued'],['verification','queued'],['review','queued']]);

  // An address-only correction keeps the saved site description.
  const l=create('LOCATION_PRIVATE',{siteDescription:'APN 123-456-789'});turn=await propose(l,[locate(CORRECTED)]);
  assert.deepEqual(turn.proposals[0],{...turn.proposals[0],action:'correct_location',address:CORRECTED});assert.ok(!Object.hasOwn(turn.proposals[0],'siteDescription'));
  assert.equal((await post(l.id,{turnId:turn.id,proposalId:turn.proposals[0].id})).status,200);
  p=s.project(l.id);assert.equal(p.address,CORRECTED);assert.equal(p.input.address,CORRECTED);assert.equal(p.input.siteDescription,'APN 123-456-789');assert.deepEqual(p.input.previousAddresses,[input.address]);
  // A site-only correction keeps the address; a correction that no longer changes anything is refused.
  s.updateProject(l.id,{status:'complete'});
  turn=await propose(l,[locate('','Lot 7, Tract 5521')]);
  const repeat={...turn.proposals[0],id:randomUUID()};
  assert.equal((await post(l.id,{turnId:turn.id,proposalId:turn.proposals[0].id})).status,200);
  p=s.project(l.id);assert.equal(p.address,CORRECTED);assert.equal(p.input.siteDescription,'Lot 7, Tract 5521');
  s.updateProject(l.id,{status:'complete'});s.updateChatTurn(l.id,turn.id,{proposals:[...c.view(l.id).turns.at(-1).proposals,repeat]});
  const noop=await post(l.id,{turnId:turn.id,proposalId:repeat.id});assert.equal(noop.status,400);assert.match((await noop.json()).error,/already uses this address/);
});

test('paid proposals wait for research and chat, go stale after research runs, and a refused apply stays applicable',async t=>{
  const provider=new ChatProvider();
  const {app,a,post}=await setup(t,provider),s=app.store,c=app.services.chat;
  provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[research('The permit date moved to 2027.')]}):chatResponse('Apply it when ready.');
  const turn=await reply(c,a.id),proposalId=turn.proposals[0].id,apply=()=>post(a.id,{turnId:turn.id,proposalId});

  s.updateProject(a.id,{status:'researching'});let res=await apply();assert.equal(res.status,400);assert.match((await res.json()).error,/Wait for the current research/);
  s.updateProject(a.id,{status:'complete'});
  const unsettled=randomUUID(),time=new Date().toISOString();
  s.db.prepare("INSERT INTO attempts(id,project_id,stage_id,mode,model_key,state,reserve,payload,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)").run(unsettled,a.id,'chat','realtime','research','unknown',0,'{}','2000-01-01T00:00:00.000Z',time);
  res=await apply();assert.equal(res.status,400);assert.match((await res.json()).error,/outstanding requests/);
  s.db.prepare("UPDATE attempts SET state='settled' WHERE id=?").run(unsettled);

  // engine.resume refuses during a chat reply before changing anything, so the proposal stays applicable.
  app.services.engine.chatting.add(a.id);
  res=await apply();assert.equal(res.status,400);assert.match((await res.json()).error,/Wait for the current request to finish/);
  assert.equal(c.view(a.id).turns.find(x=>x.id===turn.id).proposals[0].status,'proposed');assert.equal(s.project(a.id).status,'complete');
  app.services.engine.chatting.delete(a.id);
  const running=s.createChatTurn(a.id,{clientId:randomUUID(),message:'Still running'});
  res=await post(a.id,{turnId:running.id,proposalId});assert.equal(res.status,400);assert.match((await res.json()).error,/Wait for this reply to finish/);
  s.updateChatTurn(a.id,running.id,{status:'interrupted'});

  // Research that ran after the proposal makes it stale.
  s.db.prepare("INSERT INTO attempts(id,project_id,stage_id,mode,model_key,state,reserve,payload,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),a.id,'codes','realtime','research','settled',0,'{}',new Date(Date.now()+1000).toISOString(),time);
  assert.equal(c.view(a.id).turns.find(x=>x.id===turn.id).proposals[0].stale,true);
  res=await apply();assert.equal(res.status,400);assert.match((await res.json()).error,/Research has run since this was proposed/);
  assert.equal(s.project(a.id).status,'complete');
});

test('a declined reply clears its proposals, and proposals survive a restart',async t=>{
  const provider=new ChatProvider();
  const {app,a,b,dir}=await setup(t,provider),s=app.store,c=app.services.chat;
  provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[answer(a.questions[0].id,'NFPA 13, 2025 edition.')]}):chatResponse('',{stop_reason:'refusal',stop_details:{type:'refusal',category:'cyber'},content:[]});
  const declined=await reply(c,a.id);assert.equal(declined.status,'declined');assert.deepEqual(declined.proposals,[]);

  provider.fn=(payload,n)=>payload.messages.at(-1).content.some(x=>x.type==='tool_result')?chatResponse('Apply the card.'):chatResponse('',{stop_reason:'tool_use',content:[dismiss(b.questions[0].id)]});
  const turn=await reply(c,b.id);assert.equal(turn.proposals.length,1);
  s.updateChatTurn(b.id,turn.id,{status:'running'});
  const reopened=new Store(dir);try{
    const recovered=new ProjectChat(reopened,provider,()=>true,{running:new Set()}),view=recovered.view(b.id).turns.at(-1);
    assert.notEqual(view.status,'running');assert.deepEqual(view.proposals,turn.proposals);await recovered.close();
  }finally{reopened.close();}
});
