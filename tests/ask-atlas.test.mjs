import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { askAtlasMessage } from '../lib/chat.mjs';
import { CHAT_LIMITS,MODELS } from '../lib/config.mjs';
import { input,report,chatResponse,ChatProvider } from './fixtures.mjs';

const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
async function settled(chat){await Promise.all([...chat.running.values()].map(j=>j.promise));}
async function setup(t,provider=new ChatProvider()){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-ask-atlas-')),app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-ask-atlas-')));rmSync(dir,{recursive:true,force:true});});
  app.services.engine.tick=async()=>{};
  const p=app.store.create(input);
  app.store.updateProject(p.id,{status:'complete',report:{...report(),gaps:[{question:'Which fire protection systems are proposed?',why:'The proposed systems determine which standards to research.',contact:'Project design team',nextStep:'Add the systems and any known equipment details.'}]}});
  for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete',output:'Saved findings.'});
  app.store.source(p.id,{url:'https://example.com/adoption',title:'Adoption record',text:'The district adopts NFPA 13, 2022 edition.',readFull:true});
  const {token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(body,auth=true)=>fetch(`${app.url}/api/projects/${p.id}/chat`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-App-Token':token}:{})},body:JSON.stringify(body)});
  return {app,provider,id:p.id,post,question:app.store.project(p.id).questions[0]};
}
const ask=(questionId,patch={})=>({clientId:randomUUID(),questionId,mode:'standard',...patch});

test('Ask Atlas uses the same chat request as a typed message and does not write the project',async t=>{
  const {app,provider,id,post,question}=await setup(t),c=app.services.chat,s=app.store;
  c.start(id,{clientId:randomUUID(),message:'Explain the saved findings.',mode:'opus'});await settled(c);
  const typed=provider.calls[0].payload;
  const clientId=randomUUID();
  const response=await post(ask(question.id,{mode:'opus',clientId}));
  assert.equal(response.status,202);
  await settled(c);
  const asked=provider.calls[1].payload,turn=c.view(id).turns.at(-1);
  assert.equal(asked.model,typed.model);assert.equal(asked.model,MODELS.review.id);
  assert.equal(asked.max_tokens,typed.max_tokens);assert.equal(asked.max_tokens,CHAT_LIMITS.output);
  assert.deepEqual(asked.tools,typed.tools);assert.equal(asked.system,typed.system);
  assert.deepEqual(asked.thinking,typed.thinking);assert.deepEqual(asked.output_config,typed.output_config);
  assert.deepEqual(asked.cache_control,typed.cache_control);
  assert.equal(turn.user,askAtlasMessage(question));assert.equal(turn.mode,'opus');assert.equal(turn.status,'complete');
  assert.match(turn.user,/Resolve this specific question from information already in the project/);
  assert.match(turn.user,/do the legwork yourself/);assert.match(turn.user,new RegExp(question.question));
  assert.match(turn.user,/Project design team/);assert.match(turn.user,new RegExp(`Question id: ${question.id}`));
  assert.equal(s.project(id).questions[0].status,'open');assert.equal(s.project(id).questions[0].answer,'');
  const again=await post(ask(question.id,{mode:'opus',clientId}));assert.equal(again.status,202);await settled(c);
  assert.equal(provider.calls.length,2);assert.equal(c.view(id).turns.length,2);
});

test('a proposed answer still waits for Apply',async t=>{
  const provider=new ChatProvider();
  const {app,id,question}=await setup(t,provider),c=app.services.chat,s=app.store;
  provider.fn=(payload,n)=>n===1?chatResponse('',{stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_ask',name:'propose_question_update',input:{questionId:question.id,status:'answered',answer:'Wet-pipe sprinklers, from the saved project record.',reason:'The saved report did not state the system.'}}]}):chatResponse('Apply the card to save this answer.');
  c.start(id,ask(question.id));await settled(c);
  const turn=c.view(id).turns.at(-1);
  assert.equal(turn.status,'complete');assert.equal(turn.proposals.length,1);assert.equal(turn.proposals[0].status,'proposed');
  assert.equal(s.project(id).questions[0].status,'open');
  await c.apply(id,{turnId:turn.id,proposalId:turn.proposals[0].id});
  const saved=s.project(id).questions[0];
  assert.equal(saved.status,'answered');assert.equal(saved.answer,'Wet-pipe sprinklers, from the saved project record.');
  assert.match(askAtlasMessage(saved),/Current status: answered/);assert.match(askAtlasMessage(saved),/Wet-pipe sprinklers/);
});

test('Ask Atlas rejects a missing question and a message sent with a question',async t=>{
  const {app,id,post,question}=await setup(t),c=app.services.chat,other=app.store.create({...input,name:'Other project'});
  app.store.updateProject(other.id,{status:'complete',report:{...report(),gaps:[{question:'Unrelated?',why:'Other',contact:'Owner',nextStep:'Ignore.'}]}});
  const foreign=app.store.project(other.id).questions[0].id;
  for(const body of [ask('missing'),ask(foreign),ask(question.id,{message:'Also a typed message'}),{clientId:randomUUID(),questionId:''}]){
    assert.throws(()=>c.start(id,body),/Choose a question|not both|Enter a message/);
    assert.equal((await post(body)).status,400);
  }
  assert.equal(c.view(id).turns.length,0);
});

test('the visible chat name is Chat with Atlas',()=>{
  const files=['public/app.js','public/help.html','public/trust.js','public/index.html','README.md','docs/TRUST_CLAIMS.md'];
  for(const file of files)assert.equal(source(file).includes('Chat with AI'),false,file);
  const app=source('public/app.js');
  assert.match(app,/Chat with Atlas/);assert.match(app,/data-ask-atlas/);assert.match(app,/>Ask Atlas</);
  assert.match(source('public/help.html'),/Ask Atlas/);assert.match(source('public/trust.js'),/Ask Atlas on a question card/);
  assert.match(source('README.md'),/\*\*Ask Atlas\*\*/);
});
