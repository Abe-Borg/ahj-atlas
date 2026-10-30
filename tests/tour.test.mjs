// The guided tour's contract (lib/tour.mjs, public/tour.js, public/capabilities.js):
//
// - the practice project is built through the app's own checks, says it is fictional, and its
//   recorded chat quotes only what its sources say;
// - it lives apart from the workspace: never listed, never counted, never sent to a model, and
//   every change to it is refused before anything is read, saved or sent;
// - every end-user capability is carried by a control in the page (data-capability) AND taught by
//   a tour step, so a new control fails here until the tour covers it, and every step points at an
//   anchor (data-tour) the page really has;
// - the limits a step quotes come from the trust facts, never typed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, projectDetail } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { Tour, TOUR_REFUSAL, PRACTICE_INPUT, OWNER_DOCUMENT, buildPracticeProject } from '../lib/tour.mjs';
import { ProjectChat } from '../lib/chat.mjs';
import { CAPABILITIES } from '../public/capabilities.js';
import { TOUR, TOUR_VERSION, TOUR_COMPLETION_VERSION, PRACTICE_FORM, TOUR_HOLD, TOUR_FORM_HOLD, TOUR_NAV_HOLD, TOUR_RECORDED, chapterIndex, stepShow } from '../public/tour.js';
import { MENU_COMMANDS } from '../desktop/menu.mjs';
import { input, FakeProvider } from './fixtures.mjs';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>readFileSync(path.join(root,file),'utf8');
const pageFiles=['public/index.html',...readdirSync(path.join(root,'public')).filter(name=>name.endsWith('.js')).map(name=>'public/'+name)];
const steps=TOUR.flatMap((chapter,c)=>chapter.steps.map((step,i)=>({chapter,step,c,i})));

async function practice(){
  const store=new Store(':memory:'),id=await buildPracticeProject(store);
  return {store,id,detail:projectDetail(store,new ProjectChat(store,null,()=>'',{}),id)};
}

test('the practice project is built through the app’s own checks and says it is fictional',async()=>{
  const {store,id,detail}=await practice();
  try{
    const {project:p,sources,notes,chat}=detail,r=p.report;
    assert.equal(p.name,PRACTICE_INPUT.name);assert.equal(p.status,'complete');assert.equal(p.cost,0);
    assert.deepEqual(sources.map(s=>[s.id,s.kind,s.read_full]),[['S1','web',true],['S2','web',true],['S3','web',true],['S4','web',true],['S5','web',false],['S6','upload',true]]);
    for(const s of sources.filter(s=>s.read_full))assert.match(s.text,/^FICTIONAL EXAMPLE FOR THE AHJ ATLAS GUIDED TOUR\./,s.id);
    for(const s of sources)assert.ok(s.url.startsWith('https://www.example.com/')||s.url.startsWith('upload:'),s.url);
    assert.equal(sources.find(s=>s.id==='S6').title,OWNER_DOCUMENT.name);
    // validateReport decided these statuses, not the bundle.
    assert.equal(r.jurisdiction.status,'verified');
    const row=name=>r.fireStandards.find(x=>x.name.startsWith(name+' '));
    assert.deepEqual([row('NFPA 13').edition,row('NFPA 13').status,row('NFPA 13').applicabilityStatus],['2025','verified','applicable']);
    assert.deepEqual([row('NFPA 75').status,row('NFPA 75').applicabilityStatus],['unverified','conditional']);
    assert.match(row('NFPA 75').notes,/Adoption evidence check/);
    assert.equal(row('NFPA 1').applicabilityStatus,'not_applicable');
    assert.equal(row('NFPA 855').applicabilityStatus,'conditional');
    assert.equal(r.authorities.find(a=>a.name==='Example State Fire Marshal').status,'inferred');
    assert.equal(r.requirements.find(q=>q.title==='Pre-submittal meeting').status,'conflicting');
    for(const item of [r.jurisdiction,...r.authorities,...r.contacts,...r.codes,...r.requirements,...r.fireStandards])
      for(const e of item.evidence)assert.ok(e.supported,`${item.name||item.title||'jurisdiction'}: ${e.quote}`);
    const counts=Object.groupBy(p.questions,q=>q.status);
    assert.equal(counts.open.length,5);assert.equal(counts.answered.length,1);assert.equal(counts.dismissed.length,1);
    assert.equal(p.questionUpdatesPending,false);
    assert.equal(notes.length,1);assert.match(notes[0].text,/NFPA 13, 2025 edition/);
    assert.deepEqual(chat.turns.map(t=>[t.status,t.proposals.map(x=>`${x.action}:${x.status}`)]),[['complete',['report_note:applied']],['complete',['answer_question:proposed']]]);
    // The recorded replies quote only what their sources say.
    for(const t of chat.turns)for(const part of t.answerParts)for(const c of part.citations){
      const source=sources.find(s=>s.id===c.sourceId);assert.ok(source.text.includes(c.quote),c.quote);assert.equal(c.title,source.title);
    }
    assert.ok(detail.events.some(e=>/No research or chat request was made, and nothing was spent/.test(e.message)));
  }finally{store.close();}
});

test('the page’s practice values are the server’s',()=>{
  assert.deepEqual(PRACTICE_FORM,PRACTICE_INPUT);
});

test('Store(":memory:") writes nothing to disk',async()=>{
  const before=readdirSync(process.cwd());const {store}=await practice();store.close();
  assert.deepEqual(readdirSync(process.cwd()),before);
  assert.equal(readdirSync(process.cwd()).includes(':memory:'),false);
});

async function server(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-tour-test-')),provider=new FakeProvider();
  const app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const {token}=await (await fetch(app.url+'/api/bootstrap')).json();
  const call=(url,method='GET',body,headers={})=>fetch(app.url+url,{method,headers:{'X-App-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body)});
  return {app,provider,call,json:async(...args)=>(await call(...args)).json()};
}

test('the practice project lives apart from the workspace, and every change to it is refused',async t=>{
  const {app,provider,call,json}=await server(t);
  const own=app.store.create({...input,name:'My own project'});
  assert.deepEqual(await json('/api/tour'),{active:false,projectId:null,finished:0});
  const started=await json('/api/tour/start','POST',{});
  assert.equal(started.active,true);assert.match(started.projectId,/^[a-f0-9-]{36}$/);
  assert.deepEqual(await json('/api/tour/start','POST',{}),started,'a second start picks up the same tour');
  const id=started.projectId;
  // Not in this workspace: not listed, not stored, not counted.
  assert.deepEqual((await json('/api/projects')).map(p=>p.id),[own.id]);
  assert.equal(app.store.project(id),null);
  assert.deepEqual(app.store.spending(),{today:0,total:0,pending:0});
  assert.equal((await json('/api/workspace')).projects,1,'a workspace export holds only the user’s own project');
  // Read as any project is.
  const detail=await json('/api/projects/'+id);
  assert.equal(detail.project.name,PRACTICE_INPUT.name);assert.equal(detail.sources.length,6);assert.equal(detail.screening.fire,true);
  assert.equal((await json(`/api/projects/${id}/chat`)).turns.length,2);
  for(const [format,type,extension] of [['pdf','application/pdf','pdf'],['xlsx','spreadsheetml','xlsx'],['xlsx-essentials','spreadsheetml','xlsx'],['json','application/json','json']]){
    const response=await call(`/api/projects/${id}/export?format=${format}`);assert.equal(response.status,200,format);
    assert.ok(response.headers.get('content-type').includes(type));assert.match(response.headers.get('content-disposition'),new RegExp(`\\.${extension}"`));
    assert.ok((await response.arrayBuffer()).byteLength>500);
  }
  assert.equal((await call(`/api/projects/${id}/images/0123456789abcdef`)).status,404);
  // Every change is refused before its body is read; a missing token is still refused first.
  const refusals=[
    [`/api/projects/${id}/resume`,'POST',{mode:'realtime'}],[`/api/projects/${id}/cancel`,'POST',{}],[`/api/projects/${id}/reconcile`,'POST',{batchId:'msgbatch_x'}],
    [`/api/projects/${id}/resolve-charge`,'POST',{}],[`/api/projects/${id}/questions`,'POST',{questionId:detail.project.questions[0].id,status:'dismissed'}],
    [`/api/projects/${id}/rename`,'POST',{name:'Renamed'}],[`/api/projects/${id}/chat`,'POST',{message:'Hello',clientId:'c1'}],
    [`/api/projects/${id}/chat/stop`,'POST',{}],[`/api/projects/${id}/chat/apply`,'POST',{turnId:detail.chat.turns[1].id,proposalId:detail.chat.turns[1].proposals[0].id}],
    [`/api/projects/${id}`,'DELETE',{}],[`/api/projects/${id}/notes/${detail.notes[0].id}`,'DELETE',{}],[`/api/projects/${id}/images/0123456789abcdef`,'DELETE',{}],
  ];
  for(const [url,method,body] of refusals){
    const response=await call(url,method,body);assert.equal(response.status,409,`${method} ${url}`);assert.equal((await response.json()).error,TOUR_REFUSAL);
  }
  for(const kind of ['documents','images']){
    const response=await call(`/api/projects/${id}/${kind}`,'POST',Buffer.from('Fire Marshal letter'),{'Content-Type':'text/plain','X-File-Name':'letter.txt'});
    assert.equal(response.status,409,kind);assert.equal((await response.json()).error,TOUR_REFUSAL);
  }
  assert.equal((await fetch(`${app.url}/api/projects/${id}/rename`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const after=await json('/api/projects/'+id);
  assert.equal(after.project.name,PRACTICE_INPUT.name);assert.deepEqual(after.project.questions,detail.project.questions);
  assert.deepEqual(after.notes,detail.notes);assert.equal(after.sources.length,6);assert.deepEqual(after.chat.turns.map(t=>t.proposals),detail.chat.turns.map(t=>t.proposals));
  assert.equal(provider.calls.length,0,'no model request was made');
  // Ending discards it; ending someone else's tour does not.
  assert.equal((await json('/api/tour/end','POST',{projectId:'not-this-tour'})).active,true);
  assert.deepEqual(await json('/api/tour/end','POST',{projectId:id}),{active:false,projectId:null});
  assert.equal((await call('/api/projects/'+id)).status,404);
  assert.deepEqual((await json('/api/projects')).map(p=>p.id),[own.id]);
});

test('finishing the tour is remembered in the workspace settings',async t=>{
  const {call,json}=await server(t);
  assert.equal((await call('/api/tour/finished','POST',{version:0})).status,400);
  assert.equal((await call('/api/tour/finished','POST',{version:'1'})).status,400);
  assert.deepEqual(await json('/api/tour/finished','POST',{version:TOUR_COMPLETION_VERSION}),{finished:TOUR_COMPLETION_VERSION});
  assert.equal((await json('/api/bootstrap')).settings.tourFinished,TOUR_COMPLETION_VERSION);
  assert.equal((await json('/api/tour')).finished,TOUR_COMPLETION_VERSION);
});

test('Tour.start builds one practice project at a time and end() discards it',async()=>{
  const tour=new Tour();
  const [a,b]=await Promise.all([tour.start(),tour.start()]);
  assert.equal(a.projectId,b.projectId);assert.ok(tour.owns(a.projectId));assert.equal(tour.owns('other'),false);
  const store=tour.state.store;tour.end(a.projectId);
  assert.equal(tour.owns(a.projectId),false);assert.throws(()=>store.list());
});

function pageAttributes(name){
  const found=new Map();
  for(const file of pageFiles)for(const match of read(file).matchAll(new RegExp(`${name}="([^"$]+)"`,'g')))found.set(match[1],[...(found.get(match[1])||[]),file]);
  return found;
}

test('every capability is carried by a control and taught by a step, and nothing else is named',()=>{
  assert.equal(new Set(CAPABILITIES).size,CAPABILITIES.length,'no capability is listed twice');
  const carried=pageAttributes('data-capability'),taught=new Set(steps.flatMap(({step})=>step.capabilities));
  for(const id of carried.keys())assert.ok(CAPABILITIES.includes(id),`${id} (in ${carried.get(id)}) is not in public/capabilities.js`);
  for(const id of CAPABILITIES){
    assert.ok(carried.has(id),`no control in the page carries data-capability="${id}"`);
    assert.ok(taught.has(id),`no tour step teaches ${id}`);
  }
  for(const id of taught)assert.ok(CAPABILITIES.includes(id),`a step teaches ${id}, which is not in public/capabilities.js`);
  // The page never computes a capability: each is a literal attribute.
  for(const file of pageFiles)assert.doesNotMatch(read(file),/data-capability="\$\{/,file);
});

test('every step points at an anchor the page has, and each chapter shows a page state',()=>{
  const anchors=pageAttributes('data-tour');
  assert.equal(new Set(steps.map(({step})=>`${step.id}`)).size,steps.length,'step ids are unique');
  assert.equal(new Set(TOUR.map(c=>c.id)).size,TOUR.length,'chapter ids are unique');
  for(const {chapter,step,c,i} of steps){
    if(step.anchor)assert.ok(anchors.has(step.anchor),`${chapter.id}/${step.id}: no element has data-tour="${step.anchor}"`);
    if(step.open)assert.ok(anchors.has(step.open),`${chapter.id}/${step.id}: no element has data-tour="${step.open}"`);
    const show=stepShow(c,i);assert.ok(['project','form'].includes(show.view),step.id);
    if(show.view==='project')assert.ok(['overview','contacts','codes','sources','activity'].includes(show.tab),step.id);
    assert.ok(step.title&&step.body.length<=720,`${step.id}: a short title and body`);
  }
  assert.equal(steps[0].step.anchor,null,'the welcome stands in the middle of the window');
  assert.equal(steps.at(-1).step.continueLabel,'Finish and return to my projects');
  assert.equal(chapterIndex('chat'),TOUR.findIndex(c=>c.id==='chat'));assert.equal(chapterIndex('nope'),-1);
  assert.ok(Number.isInteger(TOUR_VERSION)&&TOUR_VERSION>=1&&Number.isInteger(TOUR_COMPLETION_VERSION)&&TOUR_COMPLETION_VERSION>=1);
  // The user guide's chapter links name real chapters.
  for(const match of read('public/help.html').matchAll(/href="\/#tour=([a-z-]+)"/g))assert.ok(chapterIndex(match[1])>=0,match[1]);
  assert.ok(read('public/help.html').includes('href="/#tour"'));
});

test('the limits a step quotes come from the trust facts, never typed',()=>{
  const source=read('public/tour.js'),manifest=source.slice(source.indexOf('export const TOUR=['),source.indexOf('export const chapterIndex'));
  assert.ok(manifest.length>2000);
  // Digits outside ${…} are the practice project's own designations: NFPA 13 and 855, its 2025 edition, sources S1 and S6.
  const typed=[...manifest.replace(/\$\{[^}]*\}/g,'').replace(/^\s*(?:\{id|step\().*?,'/gm,'').matchAll(/[\w.]*\d[\w.]*/g)].map(m=>m[0]);
  assert.deepEqual([...new Set(typed)].sort(),['13','2025','855','S1','S6']);
});

test('the held controls say why with one wording each, and the server’s refusal says what to do',()=>{
  const app=read('public/app.js');
  for(const [name,text] of [['TOUR_HOLD',TOUR_HOLD],['TOUR_FORM_HOLD',TOUR_FORM_HOLD],['TOUR_NAV_HOLD',TOUR_NAV_HOLD],['TOUR_RECORDED',TOUR_RECORDED]]){
    assert.ok(app.includes(name),`public/app.js uses ${name}`);assert.ok(text.length<240);
  }
  assert.match(TOUR_REFUSAL,/End the tour/);assert.match(TOUR_HOLD,/recording/);
});

test('every desktop menu command has a page action',()=>{
  const app=read('public/app.js'),block=app.slice(app.indexOf('const menuCommands={'),app.indexOf("window.addEventListener('atlas-menu'"));
  for(const command of MENU_COMMANDS)assert.ok(block.includes(`'${command}':`)||block.includes(`\n  ${command}:`)||new RegExp(`[{,\\s]${command}:`).test(block),`public/app.js has no action for ${command}`);
});
