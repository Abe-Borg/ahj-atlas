import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { input } from './fixtures.mjs';
import { destinationState, importLegacyWorkspace, preflightWorkspace } from '../desktop/migration.mjs';
import { restoredBounds, saveWindowBounds } from '../desktop/window-state.mjs';

function fixture(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'ahj-desktop-migration-'));
  t.after(()=>{assert.ok(path.basename(root).startsWith('ahj-desktop-migration-'));rmSync(root,{recursive:true,force:true});});
  const sourceDir=path.join(root,'source','data'),userData=path.join(root,'profile'),dataDir=path.join(userData,'data');
  mkdirSync(sourceDir,{recursive:true});mkdirSync(userData,{recursive:true});
  return {root,sourceDir,userData,dataDir,paths:{userData,dataDir,legacyHint:sourceDir,migrationEnabled:true}};
}
function digest(file){return createHash('sha256').update(readFileSync(file)).digest('hex');}

test('first launch snapshots committed WAL rows before Store construction and later launch skips the prompt',async t=>{
  const f=fixture(t),source=new Store(f.sourceDir),project=source.create(input);
  source.event(project.id,'info','Committed WAL-only event');
  const original=path.join(f.sourceDir,'atlas.sqlite'),wal=original+'-wal';
  assert.ok(existsSync(wal)&&statSync(wal).size>0);
  const before={db:digest(original),wal:digest(wal)};
  mkdirSync(f.dataDir);writeFileSync(path.join(f.dataDir,'atlas.sqlite'),'');
  assert.equal(destinationState(f.dataDir),'empty');
  let prompts=0;
  const first=await preflightWorkspace({paths:f.paths,prompt:async()=>{prompts++;return 'import';},selectDirectory:async()=>{throw Error('hint should be used');}});
  assert.equal(first.decision,'imported');assert.equal(prompts,1);
  const dest=new Store(f.dataDir);
  assert.equal(dest.project(project.id).name,project.name);
  assert.ok(dest.events(project.id).some(event=>event.message==='Committed WAL-only event'));
  dest.close();
  assert.deepEqual({db:digest(original),wal:digest(wal)},before);
  const second=await preflightWorkspace({paths:f.paths,prompt:async()=>{throw Error('must not prompt');},selectDirectory:async()=>{throw Error('must not pick');}});
  assert.equal(second.decision,'existing');
  source.close();
});

test('fresh decision is recorded once and an empty file does not suppress the first prompt',async t=>{
  const f=fixture(t);mkdirSync(f.dataDir);writeFileSync(path.join(f.dataDir,'atlas.sqlite'),'');
  let prompts=0;
  const first=await preflightWorkspace({paths:f.paths,prompt:async()=>{prompts++;return 'fresh';},selectDirectory:async()=>null});
  assert.equal(first.decision,'fresh');assert.equal(prompts,1);
  const second=await preflightWorkspace({paths:f.paths,prompt:async()=>{throw Error('must not prompt');},selectDirectory:async()=>null});
  assert.equal(second.decision,'fresh');
  const store=new Store(f.dataDir);store.create(input);store.close();
  assert.equal(destinationState(f.dataDir),'initialized');
});

test('a destination WAL is never mistaken for an empty workspace',t=>{
  const f=fixture(t);mkdirSync(f.dataDir);writeFileSync(path.join(f.dataDir,'atlas.sqlite'),'');
  writeFileSync(path.join(f.dataDir,'atlas.sqlite-wal'),'possible committed data');
  assert.throws(()=>destinationState(f.dataDir),/journal files/);
});

test('active legacy lock is refused without changing either workspace',async t=>{
  const f=fixture(t),source=new Store(f.sourceDir);source.create(input);
  const original=path.join(f.sourceDir,'atlas.sqlite'),before=digest(original);
  writeFileSync(path.join(f.sourceDir,'instance.lock'),String(process.pid));
  await assert.rejects(importLegacyWorkspace(f),/source workspace is open/i);
  assert.equal(digest(original),before);
  assert.equal(destinationState(f.dataDir),'empty');
  source.close();
});

test('failed validation never promotes a staged database',async t=>{
  const f=fixture(t),source=new Store(f.sourceDir),project=source.create(input);
  source.db.exec('PRAGMA foreign_keys=OFF');
  source.db.prepare("INSERT INTO stages(project_id,id,ordinal) VALUES(?,?,?)").run('missing-project','invalid',99);
  await assert.rejects(importLegacyWorkspace(f),/foreign-key validation/);
  assert.equal(destinationState(f.dataDir),'empty');
  assert.equal(source.project(project.id).name,project.name);
  source.close();
});

test('a failed Store startup releases the destination instance lock',async t=>{
  const f=fixture(t);mkdirSync(f.dataDir);writeFileSync(path.join(f.dataDir,'atlas.sqlite'),'not a SQLite database');
  await assert.rejects(createApp({dataDir:f.dataDir,port:0,worker:false}),/database|disk image/i);
  assert.equal(existsSync(path.join(f.dataDir,'instance.lock')),false);
});

test('off-screen saved bounds are centered on a current display',t=>{
  const f=fixture(t),screen={getAllDisplays:()=>[{workArea:{x:0,y:0,width:1920,height:1080}}],getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}})};
  const window={isDestroyed:()=>false,isMinimized:()=>false,getNormalBounds:()=>({x:9000,y:9000,width:1400,height:900})};
  saveWindowBounds(f.userData,window);
  assert.deepEqual(restoredBounds(f.userData,screen),{x:260,y:90,width:1400,height:900});
});
