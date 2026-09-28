import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync, rmSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

const DATABASE='atlas.sqlite';
const DECISION='migration-decision.json';

function tables(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name);}
  finally{db.close();}
}

export function destinationState(dataDir){
  const file=path.join(dataDir,DATABASE);
  if(!existsSync(file)||statSync(file).size===0){
    if(existsSync(file+'-wal')||existsSync(file+'-shm'))
      throw new Error('The destination has SQLite journal files. No migration was attempted.');
    return 'empty';
  }
  const names=tables(file);
  if(names.includes('settings')&&names.includes('projects'))return 'initialized';
  throw new Error('The destination contains an unrecognized database. No migration was attempted.');
}

export function legacyDataDir(selected){
  if(!selected)return null;
  for(const dir of [path.resolve(selected),path.join(path.resolve(selected),'data')]){
    const file=path.join(dir,DATABASE);
    if(existsSync(file)){
      const names=tables(file);
      if(names.includes('settings')&&names.includes('projects'))return dir;
    }
  }
  return null;
}

function workspaceLockState(dir){
  const lock=path.join(dir,'instance.lock');
  if(!existsSync(lock))return 'absent';
  const pid=Number(readFileSync(lock,'utf8'));
  if(!Number.isInteger(pid)||pid<1)return 'unknown';
  try{process.kill(pid,0);return 'active';}
  catch(error){return error.code==='ESRCH'?'stale':'unknown';}
}

export function activeWorkspaceLock(dir){
  return ['active','unknown'].includes(workspaceLockState(dir));
}

function claimLegacyLock(dir){
  const file=path.join(dir,'instance.lock');
  for(let attempt=0;attempt<2;attempt++){
    let handle;
    try{
      handle=openSync(file,'wx');writeFileSync(handle,String(process.pid));closeSync(handle);
      return ()=>{try{if(readFileSync(file,'utf8')===String(process.pid))unlinkSync(file);}catch{}};
    }catch(error){
      if(handle!==undefined){closeSync(handle);try{unlinkSync(file);}catch{}}
      if(error.code!=='EEXIST')throw error;
      const state=workspaceLockState(dir);
      if(state==='active')throw new Error('The source workspace is open. Close the source application before importing.');
      if(state==='unknown')throw new Error('The source workspace lock cannot be verified. Resolve it before importing.');
      if(attempt===1)throw new Error('The source workspace lock changed during import. Try again after closing the source application.');
      if(state==='stale')unlinkSync(file);
    }
  }
}

function safeStageRemove(stageDir,userData){
  const relative=path.relative(path.resolve(userData),path.resolve(stageDir));
  if(!/^migration-stage-[a-f0-9-]+$/.test(relative))throw new Error('Unsafe migration staging path.');
  rmSync(stageDir,{recursive:true,force:true});
}

export async function importLegacyWorkspace({sourceDir,dataDir,userData}){
  const source=legacyDataDir(sourceDir);
  if(!source)throw new Error('Select a source AHJ Atlas folder or its data folder containing atlas.sqlite.');
  if(path.resolve(source).toLowerCase()===path.resolve(dataDir).toLowerCase())throw new Error('The source and destination workspaces must differ.');
  if(activeWorkspaceLock(dataDir))throw new Error('The destination workspace is already open.');
  if(destinationState(dataDir)!=='empty')throw new Error('The destination workspace is already initialized. It was not overwritten.');

  const releaseLegacyLock=claimLegacyLock(source);
  const stageDir=path.join(userData,`migration-stage-${randomUUID()}`);
  const stagedFile=path.join(stageDir,DATABASE);
  let sourceDb;
  try{
    mkdirSync(userData,{recursive:true});
    mkdirSync(stageDir);
    sourceDb=new DatabaseSync(path.join(source,DATABASE),{readOnly:true});
    // SQLite's online backup reads one consistent snapshot, including committed
    // transactions still present in the source WAL. Never copy the main file alone.
    await backup(sourceDb,stagedFile);
    const staged=new Store(stageDir);
    try{
      if(staged.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('The imported database failed SQLite integrity validation.');
      if(staged.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('The imported database failed foreign-key validation.');
      staged.list(); // Exercise the normal schema and project decoding path.
      const checkpoint=staged.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if(checkpoint.busy)throw new Error('The staged database could not be checkpointed.');
      if(staged.db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode!=='delete')
        throw new Error('The staged database could not leave WAL mode.');
    }finally{staged.close();}
    if(existsSync(stagedFile+'-wal')&&statSync(stagedFile+'-wal').size>0)
      throw new Error('The staged database still has a write-ahead journal.');
    if(destinationState(dataDir)!=='empty')throw new Error('The destination changed during import. It was not overwritten.');
    mkdirSync(dataDir,{recursive:true});
    const destination=path.join(dataDir,DATABASE);
    if(existsSync(destination))unlinkSync(destination); // Only the zero-byte file accepted above.
    renameSync(stagedFile,destination);
    return {sourceDir:source};
  }finally{
    try{sourceDb?.close();}
    finally{try{safeStageRemove(stageDir,userData);}finally{releaseLegacyLock();}}
  }
}

function readDecision(userData){
  const file=path.join(userData,DECISION);
  if(!existsSync(file))return null;
  const value=JSON.parse(readFileSync(file,'utf8'));
  if(!['imported','fresh'].includes(value.decision))throw new Error('The saved migration decision is invalid.');
  return value.decision;
}

function saveDecision(userData,decision){
  mkdirSync(userData,{recursive:true});
  const file=path.join(userData,DECISION),temp=`${file}.${randomUUID()}.tmp`;
  try{writeFileSync(temp,JSON.stringify({decision,date:new Date().toISOString()}));renameSync(temp,file);}
  finally{if(existsSync(temp))unlinkSync(temp);}
}

export async function preflightWorkspace({paths,prompt,selectDirectory}){
  if(!paths.migrationEnabled)return {decision:'development'};
  if(destinationState(paths.dataDir)==='initialized')return {decision:'existing'};
  const previous=readDecision(paths.userData);
  if(previous)return {decision:previous};
  const hinted=paths.legacyHint?legacyDataDir(paths.legacyHint):null;
  const choice=await prompt({hinted});
  if(choice==='cancel')return {decision:'cancel'};
  if(choice==='fresh'){
    saveDecision(paths.userData,'fresh');
    return {decision:'fresh'};
  }
  if(choice!=='import')throw new Error('Unexpected migration choice.');
  const selected=hinted||await selectDirectory();
  if(!selected)return {decision:'cancel'};
  const result=await importLegacyWorkspace({sourceDir:selected,dataDir:paths.dataDir,userData:paths.userData});
  saveDecision(paths.userData,'imported');
  return {decision:'imported',...result};
}
