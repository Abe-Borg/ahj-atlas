import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readdirSync,rmSync,writeFileSync,existsSync } from 'node:fs';
import { gunzipSync,gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { VERSION } from '../lib/config.mjs';
import { validateReport } from '../lib/prompts.mjs';
import { workspaceExportFilename } from '../lib/download-filename.mjs';
import { IMPORTED_PAUSED, stageImport } from '../lib/workspace-transfer.mjs';
import { input,report,evidenceText,FakeProvider } from './fixtures.mjs';

const prefix=path.join(os.tmpdir(),'ahj-workspace-transfer-test-');
async function setup(t,dir=mkdtempSync(prefix)){
  const app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  t.after(async()=>{await app.close().catch(()=>{});assert.ok(path.resolve(dir).startsWith(prefix));rmSync(dir,{recursive:true,force:true});});
  const {token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(url,body,headers={})=>fetch(app.url+url,{method:'POST',headers:{'X-App-Token':token,...headers},body});
  return {...app,dir,token,
    exported:async()=>{const r=await fetch(app.url+'/api/workspace/export',{headers:{'sec-fetch-site':'same-origin'}});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());},
    upload:file=>post('/api/workspace/import',file,{'Content-Type':'application/octet-stream'}),
    apply:(id,body)=>post(`/api/workspace/import/${id}`,JSON.stringify(body),{'Content-Type':'application/json'}),
    discard:id=>fetch(`${app.url}/api/workspace/import/${id}`,{method:'DELETE',headers:{'X-App-Token':token,'Content-Type':'application/json'}}),
  };
}
async function until(check){for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for the condition.');}
const staging=dir=>readdirSync(dir).filter(n=>n.startsWith('transfer-'));
const reservation={mode:'realtime',modelKey:'research',payload:{model:'claude-sonnet-5-5',messages:[]},reserve:100000};
// A finished project with every kind of saved record: report, source, stages, chat with a charged
// request and a tool run, an image, a note, an answer, links, chat evidence and a diagnostic.
function finished(s,name='Finished campus'){
  const p=s.create({...input,name});
  s.source(p.id,{url:'https://example.com/adoption',title:'Synthetic adoption record',text:evidenceText,readFull:true});
  for(const stage of s.stages(p.id))s.updateStage(p.id,stage.id,{status:'complete',output:'Synthetic findings.',messages:[{role:'user',content:'Saved conversation'}]});
  s.updateProject(p.id,{status:'complete',report:validateReport(report(),s.sources(p.id))});
  const turn=s.createChatTurn(p.id,{clientId:'first',message:'Which code applies?',images:[{id:'0123456789abcdef',name:'site.png'}]});
  const a=s.reserve(p.id,'chat',{...reservation,chatTurnId:turn.id});
  s.updateAttempt(a.id,{state:'settled',actual:900000,applied:1,usage:{input_tokens:10,output_tokens:5}});
  s.saveTool(a.id,'tool-1','read_project',{text:'Saved tool output'});
  s.updateChatTurn(p.id,turn.id,{status:'complete',answer:'The Fixture Building Code [S1].'});
  s.addChatImage(p.id,{id:'0123456789abcdef',name:'site.png',mediaType:'image/png',width:2,height:1,bytes:Buffer.from([137,80,78,71,1,2,3])});
  s.addNote(p.id,{title:'Permit note',text:'Submit through the portal.',turnId:turn.id});
  s.saveLinks(p.id,[{url:'https://example.com/forms'}]);
  s.saveChatEvidence(p.id,{opening:'Saved evidence'});
  s.db.prepare('INSERT INTO question_responses(project_id,id,gap,status,answer,updated) VALUES(?,?,?,?,?,?)').run(p.id,'q1','{"question":"Who reviews?"}','answered','The district',new Date().toISOString());
  s.diagnostic('test.private',{projectId:p.id,detail:'this computer only'});
  return s.project(p.id);
}
// Every saved row of a project, as an import should reproduce it. Event IDs are renumbered on import
// and the import note is the importer's own.
function records(s,id){
  const all=(sql,...args)=>s.db.prepare(sql).all(...args).map(r=>({...r}));
  return {
    project:all('SELECT * FROM projects WHERE id=?',id),stages:all('SELECT * FROM stages WHERE project_id=? ORDER BY rowid',id),
    attempts:all('SELECT * FROM attempts WHERE project_id=? ORDER BY rowid',id),tools:all('SELECT t.* FROM tool_runs t JOIN attempts a ON a.id=t.attempt_id WHERE a.project_id=? ORDER BY t.rowid',id),
    sources:all('SELECT * FROM sources WHERE project_id=? ORDER BY rowid',id),events:all("SELECT project_id,time,kind,message FROM events WHERE project_id=? AND kind!='transfer' ORDER BY id",id),
    links:all('SELECT * FROM known_links WHERE project_id=?',id),answers:all('SELECT * FROM question_responses WHERE project_id=?',id),
    chat:all('SELECT * FROM chat_turns WHERE project_id=? ORDER BY rowid',id),evidence:all('SELECT * FROM chat_evidence WHERE project_id=?',id),
    images:all('SELECT * FROM chat_images WHERE project_id=?',id),notes:all('SELECT * FROM report_notes WHERE project_id=?',id),
  };
}

test('the workspace file is a compressed snapshot of every project without diagnostics, settings or deleted-project charges',async t=>{
  const app=await setup(t),s=app.store,p=finished(s);
  const gone=s.create({...input,name:'Deleted earlier'});const a=s.reserve(gone.id,'chat',{...reservation,chatTurnId:s.createChatTurn(gone.id,{clientId:'x',message:'x'}).id});
  s.updateAttempt(a.id,{state:'settled',actual:500000,applied:1});s.db.prepare("UPDATE chat_turns SET status='complete' WHERE project_id=?").run(gone.id);s.deleteProject(gone.id);
  const response=await fetch(app.url+'/api/workspace/export',{headers:{'sec-fetch-site':'same-origin'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/gzip');
  assert.equal(decodeURIComponent(response.headers.get('content-disposition').match(/filename\*=UTF-8''([^;]+)/)[1]),workspaceExportFilename());
  assert.match(workspaceExportFilename(new Date(2026,9,30)),/^AHJ Atlas workspace 2026-10-30\.ahjatlas$/);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(Number(response.headers.get('content-length')),bytes.length);
  const database=gunzipSync(bytes);assert.equal(database.subarray(0,16).toString('latin1'),'SQLite format 3\0');
  const file=path.join(app.dir,'inspect.sqlite');writeFileSync(file,database);
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const manifest=JSON.parse(db.prepare('SELECT data FROM workspace_export').get().data);
    assert.deepEqual({...manifest,exported:typeof manifest.exported},{application:'AHJ Atlas',format:1,version:VERSION,exported:'string',projects:1});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM diagnostics').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM deleted_project_charges').get().n,0);
    assert.equal(db.prepare('SELECT data FROM settings').get().data,'{}');
    assert.equal(db.prepare('SELECT name FROM projects').get().name,p.name);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')").get(),undefined);
  }finally{db.close();}
  assert.ok(!database.includes(Buffer.from('this computer only')),'diagnostic text left in free pages');
  // The staging folder is removed once the file is sent.
  await until(()=>!staging(app.dir).length);
  // Only a click in the app's own page may start it.
  assert.equal((await fetch(app.url+'/api/workspace/export')).status,403);
  assert.equal((await fetch(app.url+'/api/workspace/export',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
});

test('importing into another workspace reproduces each project and pauses research that had not finished',async t=>{
  const from=await setup(t),s=from.store,done=finished(s);
  const paused=s.create({...input,name:'Between requests'});s.updateProject(paused.id,{status:'researching'});s.updateStage(paused.id,'jurisdiction',{status:'running',messages:[{role:'user',content:'Saved'}]});
  const waiting=s.create({...input,name:'Waiting for a key'});s.updateProject(waiting.id,{status:'needs_key',note:'Connect your Claude API key to start.'});
  const canceling=s.create({...input,name:'Canceling'});s.updateProject(canceling.id,{status:'canceling',cancel_requested:1});
  const batch=s.create({...input,name:'Batch queued',mode:'batch'});const b=s.reserve(batch.id,'jurisdiction',{...reservation,mode:'batch'});s.updateAttempt(b.id,{state:'pending',batch_id:'msgbatch_test1'});s.updateProject(batch.id,{status:'waiting_batch'});
  const uncertain=s.create({...input,name:'Uncertain charge'});const u=s.reserve(uncertain.id,'jurisdiction',reservation);s.updateAttempt(u.id,{state:'unknown'});s.updateProject(uncertain.id,{status:'attention'});
  const replying=s.create({...input,name:'Chat replying'});s.createChatTurn(replying.id,{clientId:'live',message:'Still answering'});
  const summary=await(await fetch(from.url+'/api/workspace')).json();
  assert.equal(summary.projects,7);
  assert.deepEqual(Object.fromEntries(summary.held.map(h=>[h.name,h.held])),{'Chat replying':'chat','Uncertain charge':'uncertain','Batch queued':'research'});
  const file=await from.exported();

  const to=await setup(t),mine=to.store.create({...input,name:'Already here'});
  const preview=await to.upload(file);assert.equal(preview.status,201);
  const staged=await preview.json();
  assert.equal(staged.version,VERSION);assert.match(staged.exported,/^\d{4}-\d{2}-\d{2}T/);
  const row=name=>staged.projects.find(p=>p.name===name);
  assert.deepEqual(staged.projects.map(p=>p.name).sort(),['Batch queued','Between requests','Canceling','Chat replying','Finished campus','Uncertain charge','Waiting for a key']);
  assert.deepEqual({held:row('Finished campus').held,local:row('Finished campus').local,report:row('Finished campus').report,sources:row('Finished campus').sources,chats:row('Finished campus').chats,cost:row('Finished campus').cost},{held:null,local:null,report:true,sources:1,chats:1,cost:0.9});
  assert.deepEqual(['Batch queued','Uncertain charge','Chat replying'].map(n=>row(n).held),['research','uncertain','chat']);
  // Nothing changes until the user chooses.
  assert.deepEqual(to.store.list().map(p=>p.name),['Already here']);

  const refused=await to.apply(staged.id,{add:[batch.id]});assert.equal(refused.status,400);
  assert.match((await refused.json()).error,/“Batch queued” cannot be imported because its research requests were still running/);
  const importable=staged.projects.filter(p=>!p.held).map(p=>p.id);
  const applied=await to.apply(staged.id,{add:importable});assert.equal(applied.status,200);
  assert.deepEqual(await applied.json(),{added:4,replaced:0});
  assert.deepEqual(to.store.list().map(p=>p.name).sort(),['Already here','Between requests','Canceling','Finished campus','Waiting for a key']);
  assert.equal(to.store.project(mine.id).name,'Already here');

  assert.deepEqual(records(to.store,done.id),records(s,done.id));
  const copy=to.store.project(done.id);
  assert.equal(copy.status,'complete');assert.equal(copy.cost,0.9);assert.equal(copy.report.summary,done.report.summary);
  assert.deepEqual(Buffer.from(to.store.chatImage(done.id,'0123456789abcdef').bytes),Buffer.from([137,80,78,71,1,2,3]));
  assert.equal(to.services.chat.view(done.id).turns[0].answer,'The Fixture Building Code [S1].');
  assert.match(to.store.events(done.id)[0].message,new RegExp(`^Imported from an AHJ Atlas workspace file exported \\d{4}-\\d{2}-\\d{2} \\(version ${VERSION.replaceAll('.','\\.')}\\)\\.$`));
  assert.equal(to.store.diagnostics(done.id).some(d=>d.event==='test.private'),false);
  // Research that could still send requests waits for an explicit Continue research.
  for(const id of [paused.id,waiting.id]){const p=to.store.project(id);assert.deepEqual([p.status,p.note],['attention',IMPORTED_PAUSED]);}
  assert.equal(to.store.stage(paused.id,'jurisdiction').status,'running');
  assert.equal(to.store.project(canceling.id).status,'canceled');
  // The staged copy is gone, and the same import cannot be applied twice.
  assert.deepEqual(staging(to.dir),[]);
  assert.equal((await to.apply(staged.id,{add:importable})).status,404);

  // Choosing the same file again shows each imported project as up to date.
  const again=await(await to.upload(file)).json();
  assert.deepEqual(again.projects.filter(p=>!p.held).map(p=>p.local?.same),[true,true,true,true]);
  const twice=await to.apply(again.id,{add:[done.id]});assert.equal(twice.status,409);assert.match((await twice.json()).error,/changed in your workspace/);
  assert.equal((await(await to.discard(again.id)).json()).discarded,true);
  assert.deepEqual(staging(to.dir),[]);
});

test('replacing a project takes the file’s copy and keeps charges made only in the replaced copy',async t=>{
  const from=await setup(t),s=from.store,p=finished(s);
  const to=await setup(t);
  const first=await(await to.upload(await from.exported())).json();
  assert.equal((await to.apply(first.id,{add:[p.id]})).status,200);
  // The importer chats on their copy; the original author adds a note and renames.
  const turn=to.store.createChatTurn(p.id,{clientId:'mine',message:'My question'});
  const mine=to.store.reserve(p.id,'chat',{...reservation,chatTurnId:turn.id});
  to.store.updateAttempt(mine.id,{state:'settled',actual:300000,applied:1});to.store.updateChatTurn(p.id,turn.id,{status:'complete',answer:'My answer'});
  assert.equal(to.store.spending().total,1.2);
  s.addNote(p.id,{title:'Second note',text:'Added after the first export.'});s.renameProject(p.id,'Finished campus, phase 2');

  const second=await(await to.upload(await from.exported())).json(),row=second.projects[0];
  assert.deepEqual([row.name,row.local.name,row.local.same],['Finished campus, phase 2','Finished campus',false]);
  // Adding a project that is already here is refused; replacing it is the choice.
  assert.equal((await to.apply(second.id,{add:[p.id]})).status,409);
  const replaced=await to.apply(second.id,{replace:[p.id]});assert.equal(replaced.status,200);assert.deepEqual(await replaced.json(),{added:0,replaced:1});
  const copy=to.store.project(p.id);
  assert.equal(copy.name,'Finished campus, phase 2');
  assert.deepEqual(to.store.notes(p.id).map(n=>n.title),['Permit note','Second note']);
  assert.deepEqual(to.store.chatTurns(p.id).map(t=>t.user_text),['Which code applies?']);
  assert.deepEqual(records(to.store,p.id),records(s,p.id));
  assert.match(to.store.events(p.id)[0].message,/^Replaced this workspace’s copy with the one in an AHJ Atlas workspace file/);
  // The importer's own $0.30 chat stays in their spending total; the shared $0.90 is not counted twice.
  assert.equal(to.store.spending().total,1.2);assert.equal(copy.cost,0.9);
});

test('a project with work running here cannot be replaced',async t=>{
  const from=await setup(t),p=finished(from.store),to=await setup(t);
  const first=await(await to.upload(await from.exported())).json();await to.apply(first.id,{add:[p.id]});
  from.store.addNote(p.id,{title:'Later',text:'Later note'});
  const turn=to.store.createChatTurn(p.id,{clientId:'running',message:'Still answering'});
  const staged=await(await to.upload(await from.exported())).json();
  const refused=await to.apply(staged.id,{replace:[p.id]});assert.equal(refused.status,409);
  assert.match((await refused.json()).error,/Your copy of “Finished campus” has research, a chat reply, or an uncertain charge in progress/);
  to.store.updateChatTurn(p.id,turn.id,{status:'complete',answer:'Done'});
  to.services.engine.running.add(`${p.id}:jurisdiction`);
  assert.equal((await to.apply(staged.id,{replace:[p.id]})).status,409);
  to.services.engine.running.clear();
  assert.equal((await to.apply(staged.id,{replace:[p.id]})).status,200);
  assert.deepEqual(to.store.notes(p.id).map(n=>n.title),['Permit note','Later']);
});

test('files that are not workspace exports, are damaged, come from a newer version or are too large are refused',async t=>{
  const app=await setup(t),source=await setup(t);finished(source.store);const good=await source.exported();
  const expect=async(body,status,pattern)=>{const r=await app.upload(body);assert.equal(r.status,status);assert.match((await r.json()).error,pattern);};
  await expect(Buffer.from('Project,Address\r\n'),400,/not an AHJ Atlas workspace export/);
  await expect(gzipSync(Buffer.from('not a database')),400,/not an AHJ Atlas workspace export/);
  await expect(good.subarray(0,good.length>>1),400,/incomplete or damaged/);
  await expect(Buffer.alloc(0),400,/Choose a workspace file/);
  // A plain workspace database without the export note is not an export.
  const plain=path.join(app.dir,'plain');mkdirSync(plain);const store=new (await import('../lib/store.mjs')).Store(plain);store.close();
  await expect(gzipSync((await import('node:fs')).readFileSync(path.join(plain,'atlas.sqlite'))),400,/not an AHJ Atlas workspace export/);
  const edit=async change=>{
    const file=path.join(app.dir,'edited.sqlite');writeFileSync(file,gunzipSync(good));
    const db=new DatabaseSync(file);try{change(db);db.exec('PRAGMA journal_mode=DELETE');}finally{db.close();}
    return gzipSync((await import('node:fs')).readFileSync(file));
  };
  const [major,minor,patch]=VERSION.split('.').map(Number);
  await expect(await edit(db=>db.prepare("UPDATE workspace_export SET data=json_set(data,'$.version',?)").run(`${major}.${minor+1}.${patch}`)),400,new RegExp(`exported by AHJ Atlas ${major}\\.${minor+1}\\.${patch}\\. Update AHJ Atlas`));
  await expect(await edit(db=>db.exec("CREATE TRIGGER sneaky AFTER UPDATE ON projects BEGIN DELETE FROM sources; END")),400,/not an AHJ Atlas workspace export/);
  await expect(await edit(db=>db.exec("CREATE VIEW lookout AS SELECT * FROM projects")),400,/not an AHJ Atlas workspace export/);
  // Size limits apply to the upload and to the decompressed database.
  await assert.rejects(stageImport(app.store,[good],{limit:10}),e=>e.httpStatus===413&&/Import a workspace file of 0 MB or less/.test(e.message));
  await assert.rejects(stageImport(app.store,[good],{databaseLimit:1024}),e=>e.httpStatus===413&&/more than 0 MB of data/.test(e.message));
  assert.deepEqual(staging(app.dir),[]);
  // Uploading needs the app's mutation token.
  assert.equal((await fetch(app.url+'/api/workspace/import',{method:'POST',body:good})).status,403);
  assert.equal((await app.apply('00000000-0000-0000-0000-000000000000',{add:['x']})).status,404);
});

test('a newer upload replaces the staged one, and closing or restarting the app removes staging folders',async t=>{
  const source=await setup(t);finished(source.store);const file=await source.exported();
  const dir=mkdtempSync(prefix);const app=await setup(t,dir);
  const first=await(await app.upload(file)).json(),second=await(await app.upload(file)).json();
  assert.notEqual(first.id,second.id);
  assert.equal(staging(dir).length,1);
  assert.equal((await app.apply(first.id,{add:[first.projects[0].id]})).status,404);
  await app.close();
  assert.deepEqual(staging(dir),[]);
  // A folder left by a crash is removed when the workspace next opens.
  mkdirSync(path.join(dir,'transfer-left-behind'));writeFileSync(path.join(dir,'transfer-left-behind','atlas.sqlite'),'partial');
  const reopened=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  try{assert.equal(existsSync(path.join(dir,'transfer-left-behind')),false);}finally{await reopened.close();}
});
