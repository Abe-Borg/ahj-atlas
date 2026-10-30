import { backup, DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream, readdirSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from './store.mjs';
import { VERSION } from './config.mjs';
import { WORKSPACE_EXTENSION } from './download-filename.mjs';

// A workspace file is a gzip-compressed SQLite snapshot of every project, taken with SQLite's
// online backup so research and chat can keep running while it is written. Importing stages the
// file in its own folder, upgrades it with the normal Store migrations, and then copies only the
// projects the user chose into this workspace. See docs/workspace-transfer-2026-10-30.md.
export const WORKSPACE_FORMAT=1;
const DATABASE='atlas.sqlite',STAGE='transfer-';
const GZIP=Buffer.from([0x1f,0x8b]),SQLITE=Buffer.from('SQLite format 3\0','latin1');
const NOT_WORKSPACE=`This file is not an AHJ Atlas workspace export. Choose a .${WORKSPACE_EXTENSION} file made with Export workspace.`;
const DAMAGED='This workspace file is incomplete or damaged. Ask for a new export and import that file.';
const failure=(message,httpStatus=400)=>Object.assign(new Error(message),{httpStatus});
const mb=bytes=>`${Math.round(bytes/1048576).toLocaleString('en-US')} MB`;
// The tables holding one project's rows, in the order an import fills them so every foreign key
// already has its row. ?1 is the project ID. Event IDs are renumbered; every other row keeps its key.
const PROJECT_TABLES=[
  ['projects','id=?1','rowid'],['stages','project_id=?1','rowid'],['chat_turns','project_id=?1','rowid'],
  ['attempts','project_id=?1','rowid'],['tool_runs','attempt_id IN (SELECT id FROM incoming.attempts WHERE project_id=?1)','rowid'],
  ['sources','project_id=?1','rowid'],['events','project_id=?1','id'],['known_links','project_id=?1','rowid'],
  ['question_responses','project_id=?1','rowid'],['chat_evidence','project_id=?1','rowid'],['chat_images','project_id=?1','rowid'],
  ['report_notes','project_id=?1','rowid'],
];
// Statuses the research worker leaves alone. Any other would let it send paid requests with the
// importer's key (saving a key requeues needs_key), so an imported project in one waits instead.
const SETTLED=new Set(['complete','partial','canceled','attention','failed']);
export const IMPORTED_PAUSED='Imported from another AHJ Atlas workspace before its research finished. Choose Continue research to resume it with your API key; saved work is reused.';
const PROJECT_ID=/^[a-f0-9-]{1,64}$/;
// A file to import may be up to 2 GB as uploaded and 8 GB once decompressed.
export const WORKSPACE_LIMITS={bytes:2*1024**3,databaseBytes:8*1024**3};
const newer=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;};

// Work tied to the exporter's Anthropic account: a request in flight or awaiting its result, a
// submitted batch, an uncertain charge, or a chat reply still running. Such a project moves only
// once it settles, since another account cannot finish, poll, or reconcile it.
export function heldWork(db,id){
  const attempts=db.prepare("SELECT state FROM attempts WHERE project_id=? AND (state IN ('dispatching','pending','unknown') OR state='received' AND applied=0)").all(id);
  if(attempts.some(a=>a.state==='unknown'))return 'uncertain';
  if(attempts.length)return 'research';
  if(db.prepare("SELECT 1 FROM chat_turns WHERE project_id=? AND status='running' LIMIT 1").get(id))return 'chat';
  return null;
}

// When a project last changed, and a fingerprint of what it holds. Import notes (kind 'transfer')
// are left out, so a project imported unchanged still matches the file it came from.
function projectState(db,id){
  const counts=db.prepare(`SELECT (SELECT updated FROM projects WHERE id=?1) project,
    (SELECT COUNT(*)||'/'||COALESCE(MAX(time),'') FROM events WHERE project_id=?1 AND kind!='transfer') events,
    (SELECT COUNT(*)||'/'||COALESCE(MAX(updated),'') FROM chat_turns WHERE project_id=?1) chat,
    (SELECT COUNT(*)||'/'||COALESCE(MAX(updated),'') FROM attempts WHERE project_id=?1) attempts,
    (SELECT COUNT(*)||'/'||COALESCE(MAX(retrieved),'') FROM sources WHERE project_id=?1) sources,
    (SELECT COUNT(*)||'/'||COALESCE(MAX(created),'') FROM report_notes WHERE project_id=?1) notes,
    (SELECT COUNT(*)||'/'||COALESCE(MAX(updated),'') FROM question_responses WHERE project_id=?1) answers,
    (SELECT COUNT(*) FROM chat_images WHERE project_id=?1) images`).get(id);
  const last=db.prepare(`SELECT MAX(t) t FROM (SELECT updated t FROM projects WHERE id=?1
    UNION ALL SELECT MAX(time) FROM events WHERE project_id=?1 AND kind!='transfer' UNION ALL SELECT MAX(updated) FROM chat_turns WHERE project_id=?1
    UNION ALL SELECT MAX(created) FROM report_notes WHERE project_id=?1 UNION ALL SELECT MAX(updated) FROM question_responses WHERE project_id=?1)`).get(id).t;
  return {lastActivity:last||'',fingerprint:JSON.stringify(Object.values(counts))};
}

// Writes every project to one file in its own staging folder. Diagnostics, the anonymous charges
// of deleted projects and settings describe this computer, not the projects, and stay behind.
// The API key is never in the database. The caller removes dir once the file is sent.
export async function exportWorkspace(store,{date=new Date()}={}){
  const dir=await mkdtemp(path.join(store.dir,STAGE));
  try{
    const snapshot=path.join(dir,DATABASE),file=path.join(dir,`workspace.${WORKSPACE_EXTENSION}`);
    await backup(store.db,snapshot);
    const db=new DatabaseSync(snapshot);let projects;
    try{
      db.exec(`PRAGMA journal_mode=DELETE; DELETE FROM diagnostics; DELETE FROM deleted_project_charges; UPDATE settings SET data='{}';
        CREATE TABLE workspace_export(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
      projects=db.prepare('SELECT COUNT(*) n FROM projects').get().n;
      db.prepare('INSERT INTO workspace_export VALUES(1,?)').run(JSON.stringify({application:'AHJ Atlas',format:WORKSPACE_FORMAT,version:VERSION,exported:date.toISOString(),projects}));
      // Rewritten so the removed rows leave no readable free pages in the file.
      db.exec('VACUUM');
    }finally{db.close();}
    await pipeline(createReadStream(snapshot),createGzip(),createWriteStream(file));
    await rm(snapshot);
    return {dir,file,bytes:(await stat(file)).size,projects};
  }catch(error){await rm(dir,{recursive:true,force:true});throw error;}
}

// Saves an upload to file. Past the limit the rest is read and dropped, so the refusal reaches the browser.
async function receive(stream,file,limit){
  let size=0;
  await pipeline(stream,new Transform({transform(chunk,_encoding,done){size+=chunk.length;done(null,size>limit?undefined:chunk);}}),createWriteStream(file));
  if(size>limit)throw failure(`Import a workspace file of ${mb(limit)} or less.`,413);
  if(!size)throw failure('Choose a workspace file to import.');
}
function head(file,length){const fd=openSync(file,'r');try{const buffer=Buffer.alloc(length);return buffer.subarray(0,readSync(fd,buffer,0,length,0));}finally{closeSync(fd);}}
function limited(limit){
  let size=0;
  return new Transform({transform(chunk,_encoding,done){size+=chunk.length;done(size>limit?failure(`This workspace holds more than ${mb(limit)} of data, more than this computer can import at once.`,413):null,chunk);}});
}
// Read before the normal Store opens the file: the format note, the version that wrote it, no
// triggers or views (AHJ Atlas makes none) and an intact database.
function inspect(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    let manifest;
    try{
      db.exec('PRAGMA trusted_schema=OFF');
      const objects=db.prepare('SELECT type,name FROM sqlite_master').all();
      if(objects.some(o=>o.type==='trigger'||o.type==='view'))throw new Error('unexpected schema');
      if(!['settings','projects','workspace_export'].every(name=>objects.some(o=>o.type==='table'&&o.name===name)))throw new Error('missing tables');
      manifest=JSON.parse(db.prepare('SELECT data FROM workspace_export WHERE id=1').get()?.data||'null');
    }catch{throw failure(NOT_WORKSPACE);}
    if(manifest?.application!=='AHJ Atlas'||manifest.format!==WORKSPACE_FORMAT||!/^\d+\.\d+\.\d+$/.test(manifest.version||''))throw failure(NOT_WORKSPACE);
    if(newer(manifest.version,VERSION))throw failure(`This file was exported by AHJ Atlas ${manifest.version}. Update AHJ Atlas to ${manifest.version} or later, then import it.`);
    let intact=false;try{intact=db.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok';}catch{}
    if(!intact)throw failure(DAMAGED);
    return {version:manifest.version,exported:/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(manifest.exported)?manifest.exported:''};
  }finally{db.close();}
}

// Saves, checks and upgrades an uploaded workspace file, and describes each project in it next
// to this workspace's copy, if any. Nothing in this workspace changes here.
export async function stageImport(store,stream,{limit=WORKSPACE_LIMITS.bytes,databaseLimit=WORKSPACE_LIMITS.databaseBytes}={}){
  const dir=await mkdtemp(path.join(store.dir,STAGE));
  try{
    const upload=path.join(dir,'upload'),file=path.join(dir,DATABASE);
    await receive(stream,upload,limit);
    if(!head(upload,2).equals(GZIP))throw failure(NOT_WORKSPACE);
    try{await pipeline(createReadStream(upload),createGunzip(),limited(databaseLimit),createWriteStream(file));}
    catch(error){throw error.httpStatus?error:failure(DAMAGED);}
    await rm(upload);
    if(!head(file,16).equals(SQLITE))throw failure(NOT_WORKSPACE);
    const manifest=inspect(file);
    let staged;
    try{staged=new Store(dir);}catch{throw failure(DAMAGED);}
    try{
      if(staged.db.prepare('PRAGMA foreign_key_check').all().length)throw failure(DAMAGED);
      const projects=staged.list().map(p=>{
        const state=projectState(staged.db,p.id),mine=store.db.prepare('SELECT name FROM projects WHERE id=?').get(p.id);
        const local=mine?projectState(store.db,p.id):null;
        return {id:p.id,name:p.name,address:p.address,discipline:p.discipline,country:p.input?.country||'United States',status:p.status,
          report:Boolean(p.report),sources:p.sourceCount,chats:staged.db.prepare('SELECT COUNT(*) n FROM chat_turns WHERE project_id=?').get(p.id).n,cost:p.cost,
          lastActivity:state.lastActivity,held:PROJECT_ID.test(p.id)?heldWork(staged.db,p.id):'invalid',
          local:mine?{name:mine.name,lastActivity:local.lastActivity,same:local.fingerprint===state.fingerprint}:null};
      });
      return {id:randomUUID(),dir,file,...manifest,projects};
    }finally{staged.close();}
  }catch(error){await rm(dir,{recursive:true,force:true});throw error;}
}

// Copies the chosen projects from a staged file in one transaction. A replaced project's own rows
// are removed first; charges recorded only in that copy stay in this workspace's spending totals,
// each with its request ID so the charge is not counted twice if that request is imported later.
export function applyImport(store,staged,{add=[],replace=[]}){
  const db=store.db,day=staged.exported.slice(0,10),from=`an AHJ Atlas workspace file${day?` exported ${day}`:''} (version ${staged.version})`;
  db.prepare('ATTACH DATABASE ? AS incoming').run(staged.file);
  try{
    const columns=(schema,table)=>db.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map(c=>c.name);
    const copies=PROJECT_TABLES.map(([table,where,order])=>{
      const theirs=new Set(columns('incoming',table)),shared=columns('main',table).filter(c=>theirs.has(c)&&!(table==='events'&&c==='id')).map(c=>`"${c}"`).join(',');
      return db.prepare(`INSERT INTO main.${table}(${shared}) SELECT ${shared} FROM incoming.${table} WHERE ${where} ORDER BY ${order}`);
    });
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const id of replace){
        db.prepare('INSERT INTO deleted_project_charges(charged_at,actual,attempt_id) SELECT charged_at,actual,id FROM main.attempts WHERE project_id=?1 AND actual>0 AND id NOT IN (SELECT id FROM incoming.attempts WHERE project_id=?1)').run(id);
        store.removeProjectRows(id);
      }
      for(const id of [...add,...replace]){
        for(const copy of copies)copy.run(id);
        // A request kept as an anonymous charge when this project was deleted or replaced here is
        // back as a saved request, which spending already counts.
        db.prepare('DELETE FROM main.deleted_project_charges WHERE attempt_id IN (SELECT id FROM incoming.attempts WHERE project_id=?1)').run(id);
        const p=db.prepare('SELECT status,cancel_requested FROM projects WHERE id=?').get(id);
        // The project's own updated time is kept, so it still matches the file it came from.
        if(!SETTLED.has(p.status)){
          if(p.cancel_requested)db.prepare("UPDATE projects SET status='canceled' WHERE id=?").run(id);
          else db.prepare("UPDATE projects SET status='attention',note=? WHERE id=?").run(IMPORTED_PAUSED,id);
        }
        store.event(id,'transfer',replace.includes(id)?`Replaced this workspace’s copy with the one in ${from}.`:`Imported from ${from}.`);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.exec('DETACH DATABASE incoming');}
  store.diagnostic('workspace.imported',{added:add.length,replaced:replace.length,version:staged.version});
  return {added:add.length,replaced:replace.length};
}

// One staged import at a time, kept until it is applied, discarded, replaced by another upload, or
// the app closes. Staging folders left by an interrupted export or import are removed at startup.
export function workspaceTransfer(store,{isBusy=()=>false,limits}={}){
  for(const name of readdirSync(store.dir))if(name.startsWith(STAGE))rmSync(path.join(store.dir,name),{recursive:true,force:true});
  let pending=null;
  const discard=async(id=pending?.id)=>{const staged=pending;if(!staged||staged.id!==id)return false;pending=null;await rm(staged.dir,{recursive:true,force:true});return true;};
  const view=({id,version,exported,projects})=>({id,version,exported,projects});
  const unique=value=>{if(value!=null&&!Array.isArray(value))throw failure('Choose the projects to import again.');return [...new Set((value||[]).map(String))];};
  const held={uncertain:'it has a request with an uncertain charge',research:'its research requests were still running',chat:'a chat reply was still running',invalid:'its project ID is not one AHJ Atlas makes'};
  return {
    summary(){
      const projects=store.db.prepare('SELECT id,name FROM projects ORDER BY created DESC').all();
      return {projects:projects.length,held:projects.map(p=>({id:p.id,name:p.name,held:heldWork(store.db,p.id)})).filter(p=>p.held)};
    },
    export:options=>exportWorkspace(store,options),
    async stage(stream){
      const staged=await stageImport(store,stream,limits),previous=pending;pending=staged;
      if(previous)await rm(previous.dir,{recursive:true,force:true});
      return view(staged);
    },
    async apply(id,body){
      const staged=pending;if(!staged||staged.id!==id)throw failure('This import is no longer available. Choose the workspace file again.',404);
      const add=unique(body?.add),replace=unique(body?.replace);
      if(!add.length&&!replace.length)throw failure('Choose at least one project to import.');
      for(const projectId of [...add,...replace]){
        const row=staged.projects.find(p=>p.id===projectId);
        if(!row||add.includes(projectId)&&replace.includes(projectId))throw failure('Choose the projects to import again.');
        if(row.held)throw failure(`“${row.name}” cannot be imported because ${held[row.held]} when the file was exported. Ask for a new export once it finishes.`);
        const mine=store.db.prepare('SELECT name FROM projects WHERE id=?').get(projectId);
        if(add.includes(projectId)&&mine||replace.includes(projectId)&&!mine)throw failure(`“${row.name}” changed in your workspace since you chose the file. Choose the file again to review it.`,409);
        if(replace.includes(projectId)&&(isBusy(projectId)||heldWork(store.db,projectId)))throw failure(`Your copy of “${mine.name}” has research, a chat reply, or an uncertain charge in progress. Let it finish or resolve it in Activity before replacing it.`,409);
      }
      const result=applyImport(store,staged,{add,replace});
      await discard(id);
      return result;
    },
    discard,
    close:()=>discard(),
  };
}
