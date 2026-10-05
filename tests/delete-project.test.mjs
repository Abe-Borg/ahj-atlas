import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { chatPayload } from '../lib/chat.mjs';
import { input,FakeProvider } from './fixtures.mjs';

async function setup(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-delete-test-'));
  const app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-delete-test-')));rmSync(dir,{recursive:true,force:true});});
  const {token}=await(await fetch(app.url+'/api/bootstrap')).json();
  return {...app,remove:id=>fetch(app.url+'/api/projects/'+id,{method:'DELETE',headers:{'Content-Type':'application/json','X-App-Token':token}})};
}
const reservation={mode:'realtime',modelKey:'research',payload:{},reserve:100000};

test('deletion removes all project records, preserves other projects and keeps charges in spending totals',async t=>{
  const app=await setup(t),s=app.store,p=s.create(input),other=s.create({...input,name:'Keep me'});
  const turn=s.createChatTurn(p.id,{clientId:'first',message:'Test'});
  const a=s.reserve(p.id,'chat',{...reservation,chatTurnId:turn.id});
  s.updateAttempt(a.id,{state:'settled',actual:900000,applied:1});
  s.updateChatTurn(p.id,turn.id,{status:'complete',answer:'Saved answer'});
  s.saveTool(a.id,'tool-1','read_project',{text:'Saved tool output'});
  s.source(p.id,{url:'https://example.com',title:'Saved source',text:'Evidence',readFull:true});
  chatPayload(s,turn);assert.ok(s.chatEvidence(p.id));
  s.saveLinks(p.id,[{url:'https://example.com'}]);
  s.db.prepare('INSERT INTO question_responses(project_id,id,gap,status,answer,updated) VALUES(?,?,?,?,?,?)').run(p.id,'q1','{}','answered','Answer',new Date().toISOString());
  s.diagnostic('test',{projectId:p.id});
  assert.equal((await app.remove(p.id)).status,200);
  assert.equal(s.project(p.id),null);
  assert.deepEqual(s.list().map(p=>p.id),[other.id]);
  for(const table of ['attempts','chat_turns','chat_evidence','question_responses','known_links','events','sources','stages','diagnostics'])
    assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?`).get(p.id).n,0,table);
  assert.equal(s.tool(a.id,'tool-1'),null);
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await fetch(app.url+'/api/projects/'+p.id)).status,404);
  assert.equal((await app.remove(p.id)).status,404);
  // The deleted project's charge stays in today's and all-time estimated spending.
  assert.deepEqual(s.spending(),{today:.9,total:.9,pending:0});
  s.db.prepare("UPDATE deleted_project_charges SET charged_at='2000-01-01T00:00:00.000Z'").run();
  assert.deepEqual(s.spending(),{today:0,total:.9,pending:0});
  assert.ok(s.reserve(other.id,'jurisdiction',{...reservation,reserve:200000}));
});

test('deletion rejects outstanding research, chat and work before a request is reserved',async t=>{
  const app=await setup(t),s=app.store,p=s.create(input),a=s.reserve(p.id,'jurisdiction',reservation);
  for(const state of ['dispatching','pending','received','unknown']){
    s.updateAttempt(a.id,{state});assert.equal((await app.remove(p.id)).status,409,state);assert.ok(s.project(p.id));
  }
  s.updateAttempt(a.id,{state:'settled',applied:1});
  const key=p.id+':jurisdiction';app.services.engine.running.add(key);
  try{assert.equal((await app.remove(p.id)).status,409);}finally{app.services.engine.running.delete(key);}
  const turn=s.createChatTurn(p.id,{clientId:'active',message:'Test'});
  assert.equal((await app.remove(p.id)).status,409);
  s.updateChatTurn(p.id,turn.id,{status:'stopped'});
  assert.equal((await app.remove(p.id)).status,200);
});

test('delete requires authentication and rolls back incomplete removal',async t=>{
  const app=await setup(t),s=app.store,p=s.create(input);
  assert.equal((await fetch(app.url+'/api/projects/'+p.id,{method:'DELETE',headers:{'Content-Type':'application/json'}})).status,403);
  const a=s.reserve(p.id,'jurisdiction',reservation);s.updateAttempt(a.id,{state:'settled',actual:100000,applied:1});
  s.db.exec("CREATE TRIGGER prevent_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'Test failure'); END;");
  assert.equal((await app.remove(p.id)).status,409);
  assert.ok(s.project(p.id));assert.ok(s.attempt(a.id));assert.equal(s.stages(p.id).length,5);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM deleted_project_charges').get().n,0);
  s.db.exec('DROP TRIGGER prevent_delete');
  assert.equal((await app.remove(p.id)).status,200);
});
