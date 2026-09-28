import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DISCIPLINES, STAGE_DEFS, LIMITS, usd } from './config.mjs';
import { cleanDetails, redactText, DIAGNOSTIC_LIMIT } from './diagnostics.mjs';
import { mergeEvidence } from './evidence.mjs';
import { projectQuestions, questionContext } from './questions.mjs';

const now = () => new Date().toISOString();
const encode = JSON.stringify;
const decode = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true }); this.dir = dir;
    this.db = new DatabaseSync(path.join(dir, 'atlas.sqlite'));
    try{
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_project_charges(charged_at TEXT NOT NULL, actual INTEGER NOT NULL);
      INSERT OR IGNORE INTO settings VALUES(1,'{"defaultBudget":5,"dailyBudget":20}');
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, discipline TEXT NOT NULL, input TEXT NOT NULL, mode TEXT NOT NULL, budget INTEGER NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, report TEXT, note TEXT NOT NULL DEFAULT '', active_ms INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS stages(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', messages TEXT NOT NULL DEFAULT '[]', output TEXT NOT NULL DEFAULT '', rounds INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), stage_id TEXT NOT NULL, mode TEXT NOT NULL, model_key TEXT NOT NULL, state TEXT NOT NULL, reserve INTEGER NOT NULL, actual INTEGER NOT NULL DEFAULT 0, usage TEXT, batch_id TEXT, request_id TEXT, payload TEXT NOT NULL, response TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, next_poll INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, cancel_sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', read_full INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'web', retrieved TEXT NOT NULL, document_date TEXT NOT NULL DEFAULT '', UNIQUE(project_id,url));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), time TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_runs(attempt_id TEXT NOT NULL REFERENCES attempts(id), tool_id TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, result TEXT, PRIMARY KEY(attempt_id,tool_id));
      CREATE TABLE IF NOT EXISTS known_links(project_id TEXT NOT NULL REFERENCES projects(id), url TEXT NOT NULL, PRIMARY KEY(project_id,url));
      CREATE TABLE IF NOT EXISTS question_responses(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, gap TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','answered','dismissed')), answer TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS chat_turns(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), client_id TEXT NOT NULL, user_text TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running', note TEXT NOT NULL DEFAULT '', allowance INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(project_id,client_id));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_active ON chat_turns(project_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_turns(project_id,created);
      CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,level TEXT NOT NULL,event TEXT NOT NULL,project_id TEXT,stage_id TEXT,attempt_id TEXT,details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_project ON diagnostics(project_id,id);
      CREATE INDEX IF NOT EXISTS idx_attempts_state ON attempts(state,next_poll);
      CREATE INDEX IF NOT EXISTS idx_attempts_project ON attempts(project_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_created ON attempts(created);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id,id);
      PRAGMA optimize;`);
    if(!this.db.prepare('PRAGMA table_info(attempts)').all().some(c=>c.name==='charged_at'))this.db.exec("ALTER TABLE attempts ADD COLUMN charged_at TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare('PRAGMA table_info(attempts)').all().some(c=>c.name==='chat_turn_id'))this.db.exec('ALTER TABLE attempts ADD COLUMN chat_turn_id TEXT REFERENCES chat_turns(id)');
    if(!this.db.prepare('PRAGMA table_info(chat_turns)').all().some(c=>c.name==='answer_parts'))this.db.exec("ALTER TABLE chat_turns ADD COLUMN answer_parts TEXT NOT NULL DEFAULT '[]'");
    if(!this.db.prepare('PRAGMA table_info(tool_runs)').all().some(c=>c.name==='read_reserved'))this.db.exec('ALTER TABLE tool_runs ADD COLUMN read_reserved INTEGER NOT NULL DEFAULT 1');
    if(!this.db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='final_hold'))this.db.exec('ALTER TABLE projects ADD COLUMN final_hold INTEGER NOT NULL DEFAULT 0');
    for(const column of ['continuations','recoveries'])if(!this.db.prepare('PRAGMA table_info(stages)').all().some(c=>c.name===column))this.db.exec(`ALTER TABLE stages ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if(!this.db.prepare('PRAGMA table_info(stages)').all().some(c=>c.name==='context_resets'))this.db.exec('ALTER TABLE stages ADD COLUMN context_resets INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(stages)').all().some(c=>c.name==='checkpoint'))this.db.exec("ALTER TABLE stages ADD COLUMN checkpoint TEXT NOT NULL DEFAULT '{}'");
    // Preserve historical reports and already-submitted requests. Only research
    // that has not yet reached its final review gets the new stage automatically.
    this.db.exec(`BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO stages(project_id,id,ordinal,status,note)
      SELECT p.id,'verification',3,
        CASE WHEN p.report IS NOT NULL OR p.cancel_requested=1 OR EXISTS(SELECT 1 FROM attempts a WHERE a.project_id=p.id AND a.stage_id='review') THEN 'partial' ELSE 'queued' END,
        CASE WHEN p.report IS NOT NULL OR p.cancel_requested=1 OR EXISTS(SELECT 1 FROM attempts a WHERE a.project_id=p.id AND a.stage_id='review') THEN 'This saved investigation predates the Opus evidence-check stage. Explicitly continue to run it.' ELSE '' END
      FROM projects p;
      UPDATE stages SET ordinal=4 WHERE id='review'; COMMIT;`);
    }catch(error){this.db.close();throw error;}
  }
  settings() { return decode(this.db.prepare('SELECT data FROM settings WHERE id=1').get().data); }
  diagnostic(event,{level='info',projectId=null,stageId=null,attemptId=null,...details}={}){
    this.db.prepare('INSERT INTO diagnostics(time,level,event,project_id,stage_id,attempt_id,details) VALUES(?,?,?,?,?,?,?)').run(now(),level,redactText(event),projectId,stageId,attemptId,encode(cleanDetails(details)));
    this.db.prepare('DELETE FROM diagnostics WHERE id <= (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 1 OFFSET ?)').run(DIAGNOSTIC_LIMIT);
  }
  diagnostics(projectId=null){
    return this.db.prepare(`SELECT * FROM diagnostics ${projectId?'WHERE project_id=? OR project_id IS NULL':''} ORDER BY id DESC LIMIT ?`).all(...(projectId?[projectId]:[]),DIAGNOSTIC_LIMIT).map(({details,...r})=>({...r,details:decode(details,{})}));
  }
  setSettings(value) {
    const current = this.settings();
    for (const [key,max] of [['defaultBudget',100],['dailyBudget',500]]) if (value[key] !== undefined) {
      const n = Number(value[key]); if (!Number.isFinite(n) || n < 1 || n > max) throw new Error(`${key === 'dailyBudget' ? 'Daily allowance' : 'Project budget'} must be between $1 and $${max}.`); current[key] = n;
    }
    this.db.prepare('UPDATE settings SET data=? WHERE id=1').run(encode(current)); return current;
  }
  create(input) {
    const name=typeof input.name==='string'?input.name.trim():'';
    if(!name||name.length>100||/[\x00-\x1f\x7f]/.test(name))throw new Error('Enter a project name using 1–100 characters.');
    const address = String(input.address || '').trim();
    const discipline = String(input.discipline==='Other'?input.customDiscipline||'':input.discipline||'').trim();
    if (address.length < 8 || address.length > 500) throw new Error('Enter a complete project address, including city and state or region.');
    if (discipline.length<2||discipline.length>100||/[\x00-\x1f\x7f]/.test(discipline)) throw new Error('Choose a discipline or enter your own using 2–100 characters.');
    if (!['batch','realtime'].includes(input.mode)) throw new Error('Choose real-time or batch processing.');
    const budget = Number(input.budget ?? this.settings().defaultBudget);
    if (!Number.isFinite(budget) || budget < 1 || budget > 100) throw new Error('Choose a project budget between $1 and $100.');
    const clean = {};
    for (const k of ['name','address','discipline','scope','occupancy','permitDate','notes','country']) clean[k] = String(input[k] || '').trim().slice(0, k==='notes' ? 4000 : 500);
    clean.discipline=discipline;
    clean.country ||= 'United States';
    const id = randomUUID(), time = now();
    this.db.prepare('INSERT INTO projects(id,name,address,discipline,input,mode,budget,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,address,discipline,encode(clean),input.mode,Math.round(budget*1e6),'queued',time,time);
    const stmt = this.db.prepare('INSERT INTO stages(project_id,id,ordinal) VALUES(?,?,?)'); STAGE_DEFS.forEach((s,i)=>stmt.run(id,s.id,i));
    this.event(id,'info',`Project created. ${input.mode==='batch'?'Batch':'Real-time'} research selected with a $${budget.toFixed(2)} spending allowance.`);
    return this.project(id);
  }
  project(id) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); if (!p) return null;
    p.input = decode(p.input,{}); p.report=decode(p.report); p.cancel_requested=Boolean(p.cancel_requested);
    p.questionResponses=this.questionResponses(id);
    p.questions=projectQuestions(p.report,p.questionResponses);
    p.questionUpdatesPending=encode(questionContext(p.questionResponses))!==encode(p.input.questionResponses||[]);
    const totals=this.db.prepare("SELECT COALESCE(SUM(actual),0) actual, COALESCE(SUM(CASE WHEN state IN ('dispatching','pending','unknown') THEN reserve ELSE 0 END),0) reserved FROM attempts WHERE project_id=?").get(id);
    p.cost=usd(totals.actual); p.reserved=usd(totals.reserved); p.budget=usd(p.budget);
    p.finalAllowance=usd(p.final_hold);
    p.sourceCount=this.db.prepare('SELECT COUNT(*) n FROM sources WHERE project_id=?').get(id).n;
    p.searches=this.db.prepare('SELECT usage FROM attempts WHERE project_id=?').all(id).reduce((n,a)=>n+Number(decode(a.usage,{})?.server_tool_use?.web_search_requests||0),0);
    p.reads=this.db.prepare("SELECT COUNT(*) n FROM tool_runs t JOIN attempts a ON a.id=t.attempt_id WHERE a.project_id=? AND t.read_reserved=1 AND t.name IN ('read_source','render_page','inspect_pdf')").get(id).n;
    return p;
  }
  list() { return this.db.prepare('SELECT id FROM projects ORDER BY created DESC').all().map(p=>this.project(p.id)); }
  hasPendingRequests() {
    return Boolean(this.db.prepare("SELECT 1 FROM attempts WHERE state IN ('dispatching','pending') LIMIT 1").get());
  }
  deleteProject(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(!this.project(id))throw new Error('Project not found.');
      if(this.attempts(id).some(a=>['dispatching','pending','received','unknown'].includes(a.state))||this.chatTurns(id).some(t=>t.status==='running'))
        throw new Error('Stop research and any active chat reply, then wait for outstanding requests to finish. Resolve uncertain charges in Activity before deleting this project.');
      // Keep only anonymous charge totals so deleting a project cannot reset spending limits.
      this.db.prepare('INSERT INTO deleted_project_charges(charged_at,actual) SELECT charged_at,actual FROM attempts WHERE project_id=? AND actual>0').run(id);
      this.db.prepare('DELETE FROM tool_runs WHERE attempt_id IN (SELECT id FROM attempts WHERE project_id=?)').run(id);
      for(const table of ['attempts','chat_turns','question_responses','known_links','events','sources','stages','diagnostics'])
        this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  questionResponses(id) {
    return this.db.prepare('SELECT * FROM question_responses WHERE project_id=? ORDER BY id').all(id).map(r=>({...decode(r.gap,{}),id:r.id,status:r.status,answer:r.answer,updated:r.updated}));
  }
  chatTurns(id) {
    return this.db.prepare('SELECT * FROM chat_turns WHERE project_id=? ORDER BY rowid').all(id).map(t=>({...t,answer_parts:decode(t.answer_parts,[]),allowance:usd(t.allowance)}));
  }
  createChatTurn(projectId,{clientId,message,allowance}) {
    const id=randomUUID(),time=now();
    this.db.prepare('INSERT INTO chat_turns(id,project_id,client_id,user_text,allowance,created,updated) VALUES(?,?,?,?,?,?,?)').run(id,projectId,clientId,message,Math.round(allowance*1e6),time,time);
    return this.chatTurns(projectId).find(t=>t.id===id);
  }
  updateChatTurn(projectId,id,patch) {
    const entries=Object.entries(patch).filter(([k])=>['status','answer','answer_parts','note'].includes(k));if(!entries.length)return;
    this.db.prepare(`UPDATE chat_turns SET ${entries.map(([k])=>`${k}=?`).join(',')},updated=? WHERE id=? AND project_id=?`).run(...entries.map(([k,v])=>k==='answer_parts'?encode(v):v),now(),id,projectId);
  }
  saveQuestion(id,body) {
    const p=this.project(id),question=p?.questions.find(q=>q.id===body?.questionId);
    if(!question)throw new Error('This question is not in the saved project. Reload the report and try again.');
    const status=body.status;
    if(!['open','answered','dismissed'].includes(status))throw new Error('Choose answer, dismiss, or reopen.');
    if(status==='answered'&&(typeof body.answer!=='string'||!body.answer.trim()||body.answer.length>4000))throw new Error('Enter an answer between 1 and 4,000 characters.');
    const answer=status==='answered'?body.answer.trim():question.answer;
    if(status===question.status&&answer===question.answer)return p;
    const gap=Object.fromEntries(['question','why','contact','nextStep'].map(k=>[k,question[k]||'']));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO question_responses(project_id,id,gap,status,answer,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET gap=excluded.gap,status=excluded.status,answer=excluded.answer,updated=excluded.updated').run(id,question.id,encode(gap),status,answer,now());
      this.db.prepare('UPDATE projects SET updated=? WHERE id=?').run(now(),id);
      this.event(id,'info',status==='answered'?'Question answered. Saved for the next research round.':status==='dismissed'?'Question dismissed by user.':'Question reopened by user.');
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    return this.project(id);
  }
  updateProject(id, patch) {
    const allowed=['status','note','cancel_requested','report','budget','mode','input','active_ms','final_hold'];
    const entries=Object.entries(patch).filter(([k])=>allowed.includes(k));
    if(!entries.length)return;
    this.db.prepare(`UPDATE projects SET ${entries.map(([k])=>`${k}=?`).join(',')},updated=? WHERE id=?`).run(...entries.map(([k,v])=>['report','input'].includes(k)?encode(v):k==='budget'?Math.round(v*1e6):v),now(),id);
  }
  stages(id) { return this.db.prepare('SELECT * FROM stages WHERE project_id=? ORDER BY ordinal').all(id).map(s=>({...s,messages:decode(s.messages,[]),checkpoint:decode(s.checkpoint,{})})); }
  stage(id,stage) { return this.stages(id).find(s=>s.id===stage); }
  updateStage(id,stage,patch) {
    const previous=Object.hasOwn(patch,'status')?this.db.prepare('SELECT status FROM stages WHERE project_id=? AND id=?').get(id,stage)?.status:null;
    const e=Object.entries(patch).filter(([k])=>['status','messages','output','rounds','note','continuations','recoveries','context_resets','checkpoint'].includes(k)); if(!e.length)return;
    this.db.prepare(`UPDATE stages SET ${e.map(([k])=>`${k}=?`).join(',')} WHERE project_id=? AND id=?`).run(...e.map(([k,v])=>['messages','checkpoint'].includes(k)?encode(v):v),id,stage);
    if(previous&&previous!==patch.status)this.diagnostic('stage.changed',{projectId:id,stageId:stage,from:previous,to:patch.status});
  }
  event(id,kind,message) { this.db.prepare('INSERT INTO events(project_id,time,kind,message) VALUES(?,?,?,?)').run(id,now(),kind,String(message).slice(0,1600)); }
  events(id) { return this.db.prepare('SELECT time,kind,message FROM events WHERE project_id=? ORDER BY id DESC LIMIT 200').all(id); }
  attempts(id) { return this.db.prepare('SELECT * FROM attempts WHERE project_id=? ORDER BY created').all(id).map(a=>({...a,payload:decode(a.payload),response:decode(a.response),usage:decode(a.usage,{})})); }
  attempt(id) { const a=this.db.prepare('SELECT project_id FROM attempts WHERE id=?').get(id); return a ? this.attempts(a.project_id).find(x=>x.id===id):null; }
  updateAttempt(id,patch) {
    if(Object.hasOwn(patch,'actual'))patch={...patch,charged_at:now()};
    const e=Object.entries(patch).filter(([k])=>['state','actual','usage','batch_id','request_id','response','next_poll','applied','cancel_sent','reserve','charged_at'].includes(k));
    this.db.prepare(`UPDATE attempts SET ${e.map(([k])=>`${k}=?`).join(',')},updated=? WHERE id=?`).run(...e.map(([k,v])=>['usage','response'].includes(k)?encode(v):v),now(),id);
  }
  reserve(projectId,stageId,{mode,modelKey,payload,reserve,finalBuffer=0,chatTurnId=null}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p=this.project(projectId);
      if(!p || p.cancel_requested&&stageId!=='chat')throw new Error('Research canceled.');
      if(stageId==='chat'){
        const turn=this.db.prepare('SELECT * FROM chat_turns WHERE id=? AND project_id=? AND status=\'running\'').get(chatTurnId,projectId);
        if(!turn)throw new Error('This chat reply is no longer active.');
        const spent=this.db.prepare("SELECT COALESCE(SUM(actual + CASE WHEN state IN ('dispatching','pending','unknown') THEN reserve ELSE 0 END),0) total FROM attempts WHERE chat_turn_id=?").get(chatTurnId).total;
        if(spent+reserve>turn.allowance)throw new Error('CHAT_BUDGET');
        // Chat shares the ledger but cannot consume or release the final-report hold.
        finalBuffer=p.final_hold;
      }
      const reservedSearches=this.attempts(projectId).filter(a=>['dispatching','pending','unknown'].includes(a.state)).reduce((n,a)=>n+(a.payload.tools?.find(t=>t.name==='web_search')?.max_uses||0),0);
      if(stageId!=='chat'&&p.searches+reservedSearches+(payload.tools?.find(t=>t.name==='web_search')?.max_uses||0)>LIMITS.searches)throw new Error('SEARCH_BUDGET');
      if(stageId==='verification'){
        const work=this.stageUsage(projectId,stageId);
        if(work.searches+work.reservedSearches+(payload.tools?.find(t=>t.name==='web_search')?.max_uses||0)>LIMITS.verificationSearches)throw new Error('SEARCH_BUDGET');
      }
      if(Math.round((p.cost+p.reserved)*1e6)+reserve+finalBuffer>Math.round(p.budget*1e6))throw new Error('PROJECT_BUDGET');
      const start=new Date();start.setHours(0,0,0,0);
      const daily=this.db.prepare("SELECT COALESCE(SUM(CASE WHEN charged_at >= ? THEN actual ELSE 0 END),0) + COALESCE(SUM(CASE WHEN state IN ('dispatching','pending','unknown') THEN reserve ELSE 0 END),0) total FROM attempts").get(start.toISOString()).total;
      const otherFinalHolds=this.db.prepare('SELECT COALESCE(SUM(final_hold),0) n FROM projects WHERE id != ?').get(projectId).n;
      const deletedCharges=this.db.prepare('SELECT COALESCE(SUM(actual),0) total FROM deleted_project_charges WHERE charged_at>=?').get(start.toISOString()).total;
      if(daily+deletedCharges+otherFinalHolds+reserve+finalBuffer>this.settings().dailyBudget*1e6)throw new Error('DAILY_BUDGET');
      const id=randomUUID(),time=now();
      this.db.prepare('INSERT INTO attempts(id,project_id,stage_id,mode,model_key,state,reserve,payload,created,updated,chat_turn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,stageId,mode,modelKey,'dispatching',reserve,encode(payload),time,time,chatTurnId);
      this.db.prepare('UPDATE projects SET final_hold=? WHERE id=?').run(finalBuffer,projectId);
      this.db.exec('COMMIT');return this.attempt(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  source(projectId,{url,title='',text='',readFull=false,kind='web',documentDate=''}) {
    let canonical;try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return null;u.hash='';canonical=u.href;}catch{return null;}
    const old=this.db.prepare('SELECT * FROM sources WHERE project_id=? AND url=?').get(projectId,canonical);
    if(old){
      // Search citations never enter the evidence text, even after another part
      // of this URL has been read. Preserve provenance at the retrieval boundary.
      let combined=old.text;
      if(readFull && text)combined=mergeEvidence(combined,text).slice(-180000);
      this.db.prepare('UPDATE sources SET title=?,text=?,read_full=?,retrieved=?,kind=?,document_date=? WHERE id=?').run(title||old.title,combined,readFull||old.read_full?1:0,now(),kind==='web'||!readFull&&old.read_full?old.kind:kind,documentDate||old.document_date,old.id);
      return this.sources(projectId).find(s=>s.id===old.id.split(':').at(-1));
    }
    const id='S'+(this.db.prepare('SELECT COUNT(*) n FROM sources WHERE project_id=?').get(projectId).n+1);
    const key=projectId+':'+id;
    this.db.prepare('INSERT INTO sources(id,project_id,url,title,text,read_full,kind,retrieved,document_date) VALUES(?,?,?,?,?,?,?,?,?)').run(key,projectId,canonical,title||new URL(canonical).hostname,readFull?text.slice(0,180000):'',readFull?1:0,kind,now(),documentDate);
    return this.sources(projectId).find(s=>s.id===id);
  }
  sources(id) { return this.db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY rowid').all(id).map(s=>({...s,id:s.id.split(':').at(-1),read_full:Boolean(s.read_full)})); }
  saveLinks(id,links){for(const link of links){try{const u=new URL(link.url);u.hash='';if(['http:','https:'].includes(u.protocol))this.db.prepare('INSERT OR IGNORE INTO known_links VALUES(?,?)').run(id,u.href);}catch{}}}
  knownLinks(id){return this.db.prepare('SELECT url FROM known_links WHERE project_id=?').all(id).map(r=>r.url);}
  stageUsage(id,stageId){
    const attempts=this.attempts(id).filter(a=>a.stage_id===stageId);
    return {searches:attempts.reduce((n,a)=>n+Number(a.usage?.server_tool_use?.web_search_requests||0),0),reservedSearches:attempts.filter(a=>['dispatching','pending','unknown'].includes(a.state)).reduce((n,a)=>n+(a.payload.tools?.find(t=>t.name==='web_search')?.max_uses||0),0),reads:this.db.prepare("SELECT COUNT(*) n FROM tool_runs t JOIN attempts a ON a.id=t.attempt_id WHERE a.project_id=? AND a.stage_id=? AND t.read_reserved=1 AND t.name IN ('read_source','render_page','inspect_pdf')").get(id,stageId).n};
  }
  tool(attemptId,toolId) { const t=this.db.prepare('SELECT * FROM tool_runs WHERE attempt_id=? AND tool_id=?').get(attemptId,toolId);return t?{...t,result:decode(t.result)}:null; }
  beginTool(attemptId,toolId,name){this.db.prepare("INSERT OR IGNORE INTO tool_runs(attempt_id,tool_id,name,state,read_reserved) VALUES(?,?,?,'running',1)").run(attemptId,toolId,name);}
  saveTool(attemptId,toolId,name,result) { this.db.prepare("INSERT INTO tool_runs(attempt_id,tool_id,name,state,result,read_reserved) VALUES(?,?,?,'complete',?,0) ON CONFLICT(attempt_id,tool_id) DO UPDATE SET state='complete',result=excluded.result").run(attemptId,toolId,name,encode(result)); }
  recover() {
    for(const a of this.db.prepare("SELECT * FROM attempts WHERE state='dispatching'").all()){
      this.updateAttempt(a.id,{state:'unknown'});
      if(a.stage_id==='chat'){this.event(a.project_id,'warning','An interrupted chat request needs charge reconciliation in Activity. It was not resubmitted.');continue;}
      this.updateProject(a.project_id,{status:'attention',note:'A request was interrupted before its outcome was saved. Its cost reservation is retained to avoid duplicate spending.'});
      this.event(a.project_id,'warning','Interrupted request requires reconciliation. It was not automatically resubmitted.');
    }
    this.db.prepare("UPDATE stages SET status='queued' WHERE status='preparing'").run();
  }
  close(){this.db.close();}
}
