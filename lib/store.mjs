import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DISCIPLINES, STAGE_DEFS, LIMITS, usd, pricingSnapshot } from './config.mjs';
import { cleanDetails, redactText, DIAGNOSTIC_LIMIT, recordExhausted } from './diagnostics.mjs';
import { mergeEvidence } from './evidence.mjs';
import { projectQuestions, questionUpdatesPending } from './questions.mjs';
import { addressCountry, countryName } from '../public/location.js';

// Activity names the question, and the reason when one was recorded. The question is
// the part that yields if the line would otherwise exceed the event limit.
function namedEvent(lead,question,trailing=''){
  const prefix=`${lead} “`,suffix=`”${trailing}`,room=1600-prefix.length-suffix.length;
  return prefix+String(question||'').replace(/\s+/g,' ').trim().slice(0,Math.max(0,room))+suffix;
}

const now = () => new Date().toISOString();
const encode = JSON.stringify;
const decode = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
const attemptSummaryColumns='id,project_id,stage_id,mode,model_key,state,reserve,actual,usage,batch_id,request_id,created,updated,next_poll,applied,cancel_sent,charged_at,chat_turn_id,search_cap,estimated,pricing';
const decodeAttempt = a => a ? {...a,payload:decode(a.payload),response:decode(a.response),usage:decode(a.usage,{}),pricing:decode(a.pricing)} : null;
// Shared by project creation and address correction so both accept the same values.
export function projectAddress(value) {
  const address = String(value || '').trim();
  if (address.length < 8 || address.length > 500) throw new Error('Enter a complete project address, including city and state or province.');
  return address;
}
// Projects are in the United States or Canada. A blank value keeps the original default.
export function projectCountry(value) {
  if (!String(value ?? '').trim()) return 'United States';
  const country = countryName(value);
  if (!country) throw new Error('Choose United States or Canada. AHJ Atlas researches projects in those two countries.');
  return country;
}
// A definite reading of the address (a postal code, a state with its ZIP code, or a
// trailing country name) must agree with the project country.
export function checkCountry(address, country) {
  const found = addressCountry(address);
  if (found?.definite && found.country !== country) throw new Error(`This address appears to be in ${found.country === 'Canada' ? 'Canada' : 'the United States'}. Choose ${found.country} as the country, or correct the address.`);
}
// Shared by project creation and later renaming so both accept the same values.
export function projectName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Enter a project name using 1–100 characters.');
  return name;
}
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true }); this.dir = dir;
    this.db = new DatabaseSync(path.join(dir, 'atlas.sqlite'));
    // Set by services to the host ResourceMonitor; timed diagnostic rows read it.
    this.resources = null;
    try{
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_project_charges(charged_at TEXT NOT NULL, actual INTEGER NOT NULL);
      INSERT OR IGNORE INTO settings VALUES(1,'{}');
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, discipline TEXT NOT NULL, input TEXT NOT NULL, mode TEXT NOT NULL, budget INTEGER NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, report TEXT, note TEXT NOT NULL DEFAULT '', active_ms INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS stages(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', messages TEXT NOT NULL DEFAULT '[]', output TEXT NOT NULL DEFAULT '', rounds INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), stage_id TEXT NOT NULL, mode TEXT NOT NULL, model_key TEXT NOT NULL, state TEXT NOT NULL, reserve INTEGER NOT NULL, actual INTEGER NOT NULL DEFAULT 0, usage TEXT, batch_id TEXT, request_id TEXT, payload TEXT NOT NULL, response TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, next_poll INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, cancel_sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', read_full INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'web', retrieved TEXT NOT NULL, document_date TEXT NOT NULL DEFAULT '', UNIQUE(project_id,url));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), time TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_runs(attempt_id TEXT NOT NULL REFERENCES attempts(id), tool_id TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, result TEXT, PRIMARY KEY(attempt_id,tool_id));
      CREATE TABLE IF NOT EXISTS known_links(project_id TEXT NOT NULL REFERENCES projects(id), url TEXT NOT NULL, PRIMARY KEY(project_id,url));
      CREATE TABLE IF NOT EXISTS question_responses(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, gap TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','answered','dismissed','closed')), answer TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS chat_turns(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), client_id TEXT NOT NULL, user_text TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running', note TEXT NOT NULL DEFAULT '', allowance INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(project_id,client_id));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_active ON chat_turns(project_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_turns(project_id,created);
      CREATE TABLE IF NOT EXISTS chat_evidence(project_id TEXT PRIMARY KEY REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_notes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, text TEXT NOT NULL, turn_id TEXT, proposal_id TEXT, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_report_notes_project ON report_notes(project_id,created);
      CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,level TEXT NOT NULL,event TEXT NOT NULL,project_id TEXT,stage_id TEXT,attempt_id TEXT,details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_project ON diagnostics(project_id,id);
      CREATE INDEX IF NOT EXISTS idx_attempts_state ON attempts(state,next_poll);
      CREATE INDEX IF NOT EXISTS idx_attempts_project ON attempts(project_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_created ON attempts(created);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id,id);
      PRAGMA optimize;`);
    const questionColumns=this.db.prepare('PRAGMA table_info(question_responses)').all();
    const questionSql=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='question_responses'").get()?.sql||'';
    if(!questionColumns.some(c=>c.name==='reason')||!questionSql.includes("'closed'")){
      const reasonSql=questionColumns.some(c=>c.name==='reason')?"COALESCE(reason,'')":"''";
      this.db.exec('PRAGMA foreign_keys=OFF');
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec(`CREATE TABLE question_responses_next(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, gap TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','answered','dismissed','closed')), answer TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL, PRIMARY KEY(project_id,id));
          INSERT INTO question_responses_next(project_id,id,gap,status,answer,reason,updated) SELECT project_id,id,gap,status,answer,${reasonSql},updated FROM question_responses;
          DROP TABLE question_responses;
          ALTER TABLE question_responses_next RENAME TO question_responses;`);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      finally{this.db.exec('PRAGMA foreign_keys=ON');}
    }
    if(!this.db.prepare('PRAGMA table_info(attempts)').all().some(c=>c.name==='charged_at'))this.db.exec("ALTER TABLE attempts ADD COLUMN charged_at TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare('PRAGMA table_info(attempts)').all().some(c=>c.name==='chat_turn_id'))this.db.exec('ALTER TABLE attempts ADD COLUMN chat_turn_id TEXT REFERENCES chat_turns(id)');
    if(!this.db.prepare('PRAGMA table_info(attempts)').all().some(c=>c.name==='estimated'))this.db.exec('ALTER TABLE attempts ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0');
    // Backfill the previous app's embedded rate card without changing payloads,
    // reservations or charges. Even a request queued today by that app used .2
    // for Sonnet cache reads; its creation date cannot identify the applied rates.
    if(!this.db.prepare('PRAGMA table_info(attempts)').all().some(c=>c.name==='pricing')){
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec('ALTER TABLE attempts ADD COLUMN pricing TEXT');
        const rows=this.db.prepare("SELECT id,model_key,json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.model') model_id FROM attempts").all();
        const save=this.db.prepare('UPDATE attempts SET pricing=? WHERE id=?');
        for(const a of rows)save.run(encode(pricingSnapshot(a.model_key,a.model_id||undefined,{priceDate:'2026-09-28'})),a.id);
        this.db.exec('COMMIT');
      }catch(e){this.db.exec('ROLLBACK');throw e;}
    }
    // Keep search reservations independent of the growing conversation. Existing
    // requests are backfilled once; routine budget checks never read their payloads.
    if(!this.db.prepare('PRAGMA table_info(attempts)').all().some(c=>c.name==='search_cap')){
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE attempts ADD COLUMN search_cap INTEGER NOT NULL DEFAULT 0;
        UPDATE attempts SET search_cap=COALESCE((SELECT json_extract(t.value,'$.max_uses') FROM json_each(CASE WHEN json_valid(attempts.payload) THEN attempts.payload ELSE '{}' END,'$.tools') t WHERE json_extract(t.value,'$.name')='web_search' LIMIT 1),0);
        COMMIT;`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_attempts_stage_created ON attempts(project_id,stage_id,created)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_attempts_project_state ON attempts(project_id,state,next_poll)');
    if(!this.db.prepare('PRAGMA table_info(chat_turns)').all().some(c=>c.name==='answer_parts'))this.db.exec("ALTER TABLE chat_turns ADD COLUMN answer_parts TEXT NOT NULL DEFAULT '[]'");
    if(!this.db.prepare('PRAGMA table_info(tool_runs)').all().some(c=>c.name==='read_reserved'))this.db.exec('ALTER TABLE tool_runs ADD COLUMN read_reserved INTEGER NOT NULL DEFAULT 1');
    if(!this.db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='final_hold'))this.db.exec('ALTER TABLE projects ADD COLUMN final_hold INTEGER NOT NULL DEFAULT 0');
    for(const column of ['continuations','recoveries'])if(!this.db.prepare('PRAGMA table_info(stages)').all().some(c=>c.name===column))this.db.exec(`ALTER TABLE stages ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if(!this.db.prepare('PRAGMA table_info(stages)').all().some(c=>c.name==='context_resets'))this.db.exec('ALTER TABLE stages ADD COLUMN context_resets INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(stages)').all().some(c=>c.name==='checkpoint'))this.db.exec("ALTER TABLE stages ADD COLUMN checkpoint TEXT NOT NULL DEFAULT '{}'");
    if(!this.db.prepare('PRAGMA table_info(chat_turns)').all().some(c=>c.name==='mode'))this.db.exec("ALTER TABLE chat_turns ADD COLUMN mode TEXT NOT NULL DEFAULT 'standard'");
    // The streamed text of the request in flight, shown while a reply runs.
    if(!this.db.prepare('PRAGMA table_info(chat_turns)').all().some(c=>c.name==='draft'))this.db.exec("ALTER TABLE chat_turns ADD COLUMN draft TEXT NOT NULL DEFAULT ''");
    // Actions a reply proposed for the user's approval. Only the user's Apply changes the project.
    if(!this.db.prepare('PRAGMA table_info(chat_turns)').all().some(c=>c.name==='proposals'))this.db.exec("ALTER TABLE chat_turns ADD COLUMN proposals TEXT NOT NULL DEFAULT '[]'");
    // Spending limits were removed in favor of cost estimates. Projects that stopped at a
    // former limit wait for an explicit continue instead of resuming spending on upgrade.
    this.db.exec(`BEGIN IMMEDIATE;
      UPDATE projects SET status='attention',note='Research paused at a former spending limit. Spending limits have been removed; choose Continue research to resume.' WHERE status='budget';
      UPDATE projects SET final_hold=0 WHERE final_hold!=0; COMMIT;`);
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
  settings() { const {defaultBudget,dailyBudget,...settings}=decode(this.db.prepare('SELECT data FROM settings WHERE id=1').get().data,{}); return settings; }
  diagnostic(event,{level='info',projectId=null,stageId=null,attemptId=null,...details}={}){
    // A timed row (one with durationMs) carries the host-resource samples that overlapped
    // it, so a slow request or tool call can be told apart from a starved computer.
    if(this.resources&&Number.isFinite(details.durationMs)&&!Object.hasOwn(details,'resources'))details.resources=this.resources.window(Date.now()-details.durationMs);
    this.db.prepare('INSERT INTO diagnostics(time,level,event,project_id,stage_id,attempt_id,details) VALUES(?,?,?,?,?,?,?)').run(now(),level,redactText(event),projectId,stageId,attemptId,encode(cleanDetails(details)));
    this.db.prepare('DELETE FROM diagnostics WHERE id <= (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 1 OFFSET ?)').run(DIAGNOSTIC_LIMIT);
  }
  diagnostics(projectId=null){
    return this.db.prepare(`SELECT * FROM diagnostics ${projectId?'WHERE project_id=? OR project_id IS NULL':''} ORDER BY id DESC LIMIT ?`).all(...(projectId?[projectId]:[]),DIAGNOSTIC_LIMIT).map(({details,...r})=>({...r,details:decode(details,{})}));
  }
  setSettings() {
    // No user-adjustable settings remain; saving drops the retired spending limits.
    const current = this.settings();
    this.db.prepare('UPDATE settings SET data=? WHERE id=1').run(encode(current)); return current;
  }
  // Estimated spending for display only. Deleted projects keep their anonymous charges.
  spending() {
    const start=new Date();start.setHours(0,0,0,0);const since=start.toISOString();
    const live=this.db.prepare("SELECT COALESCE(SUM(actual),0) total, COALESCE(SUM(CASE WHEN charged_at >= ? THEN actual ELSE 0 END),0) today, COALESCE(SUM(CASE WHEN state IN ('dispatching','pending','unknown') THEN reserve ELSE 0 END),0) pending FROM attempts").get(since);
    const deleted=this.db.prepare('SELECT COALESCE(SUM(actual),0) total, COALESCE(SUM(CASE WHEN charged_at >= ? THEN actual ELSE 0 END),0) today FROM deleted_project_charges').get(since);
    return {today:usd(live.today+deleted.today),total:usd(live.total+deleted.total),pending:usd(live.pending)};
  }
  create(input) {
    const name=projectName(input.name);
    const address = projectAddress(input.address);
    const discipline = String(input.discipline==='Other'?input.customDiscipline||'':input.discipline||'').trim();
    if (discipline.length<2||discipline.length>100||/[\x00-\x1f\x7f]/.test(discipline)) throw new Error('Choose a discipline or enter your own using 2–100 characters.');
    if (!['batch','realtime'].includes(input.mode)) throw new Error('Choose real-time or batch processing.');
    const clean = {};
    for (const k of ['name','address','discipline','scope','occupancy','permitDate','notes','country','siteDescription']) clean[k] = String(input[k] || '').trim().slice(0, k==='notes' ? 4000 : 500);
    clean.discipline=discipline;
    if (input.occupancy==='Other') {
      clean.occupancy = String(input.customOccupancy || '').trim();
      if (clean.occupancy.length<2||clean.occupancy.length>100||/[\x00-\x1f\x7f]/.test(clean.occupancy)) throw new Error('Choose a building use or enter your own using 2–100 characters.');
    }
    clean.name=name;
    clean.country = projectCountry(input.country);
    checkCountry(address, clean.country);
    const id = randomUUID(), time = now();
    // The retired budget column stays for older databases; it no longer limits spending.
    this.db.prepare('INSERT INTO projects(id,name,address,discipline,input,mode,budget,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,address,discipline,encode(clean),input.mode,0,'queued',time,time);
    const stmt = this.db.prepare('INSERT INTO stages(project_id,id,ordinal) VALUES(?,?,?)'); STAGE_DEFS.forEach((s,i)=>stmt.run(id,s.id,i));
    this.event(id,'info',`Project created. ${input.mode==='batch'?'Batch':'Real-time'} research selected.`);
    return this.project(id);
  }
  project(id) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); if (!p) return null;
    p.input = decode(p.input,{}); p.report=decode(p.report); p.cancel_requested=Boolean(p.cancel_requested);
    p.questionResponses=this.questionResponses(id);
    p.questions=projectQuestions(p.report,p.questionResponses);
    p.questionUpdatesPending=questionUpdatesPending(p.questionResponses,p.input.questionResponses);
    const totals=this.db.prepare("SELECT COALESCE(SUM(actual),0) actual, COALESCE(SUM(CASE WHEN state IN ('dispatching','pending','unknown') THEN reserve ELSE 0 END),0) reserved FROM attempts WHERE project_id=?").get(id);
    p.cost=usd(totals.actual); p.reserved=usd(totals.reserved);
    delete p.budget; delete p.final_hold;
    p.sourceCount=this.db.prepare('SELECT COUNT(*) n FROM sources WHERE project_id=?').get(id).n;
    // Research's search and read totals. Chat has its own per-reply allowance.
    const research=this.db.prepare("SELECT usage FROM attempts WHERE project_id=? AND stage_id!='chat'").all(id).map(a=>decode(a.usage,{})?.server_tool_use);
    p.searches=research.reduce((n,u)=>n+Number(u?.web_search_requests||0),0);
    // Anthropic's web_fetch runs on the provider, so its pages are counted from usage.
    p.reads=this.db.prepare("SELECT COUNT(*) n FROM tool_runs t JOIN attempts a ON a.id=t.attempt_id WHERE a.project_id=? AND a.stage_id!='chat' AND t.read_reserved=1 AND t.name IN ('read_source','render_page','inspect_pdf')").get(id).n+research.reduce((n,u)=>n+Number(u?.web_fetch_requests||0),0);
    return p;
  }
  list() { return this.db.prepare('SELECT id FROM projects ORDER BY created DESC').all().map(p=>this.project(p.id)); }
  // The scheduler needs neither saved reports nor usage totals for idle projects.
  schedulingProjects() { return this.db.prepare('SELECT id,status,cancel_requested FROM projects ORDER BY created DESC').all(); }
  hasPendingRequests() {
    return Boolean(this.db.prepare("SELECT 1 FROM attempts WHERE state IN ('dispatching','pending') LIMIT 1").get());
  }
  deleteProject(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(!this.project(id))throw new Error('Project not found.');
      if(this.attemptSummaries(id).some(a=>['dispatching','pending','received','unknown'].includes(a.state))||this.chatTurns(id).some(t=>t.status==='running'))
        throw new Error('Stop research and any active chat reply, then wait for outstanding requests to finish. Resolve uncertain charges in Activity before deleting this project.');
      // Keep only anonymous charge totals so deleting a project cannot reset spending limits.
      this.db.prepare('INSERT INTO deleted_project_charges(charged_at,actual) SELECT charged_at,actual FROM attempts WHERE project_id=? AND actual>0').run(id);
      this.db.prepare('DELETE FROM tool_runs WHERE attempt_id IN (SELECT id FROM attempts WHERE project_id=?)').run(id);
      for(const table of ['attempts','chat_turns','chat_evidence','question_responses','report_notes','known_links','events','sources','stages','diagnostics'])
        this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  questionResponses(id) {
    return this.db.prepare('SELECT * FROM question_responses WHERE project_id=? ORDER BY id').all(id).map(r=>({...decode(r.gap,{}),id:r.id,status:r.status,answer:r.answer,reason:r.reason||'',updated:r.updated}));
  }
  chatTurns(id) {
    return this.db.prepare('SELECT * FROM chat_turns WHERE project_id=? ORDER BY rowid').all(id).map(({allowance,...t})=>({...t,answer_parts:decode(t.answer_parts,[]),proposals:decode(t.proposals,[])}));
  }
  // One saved opening per project, shared by reply depths and retained across restarts.
  chatEvidence(id) { return decode(this.db.prepare('SELECT data FROM chat_evidence WHERE project_id=?').get(id)?.data); }
  saveChatEvidence(id,data) {
    this.db.prepare('INSERT INTO chat_evidence(project_id,data) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data').run(id,encode(data));
  }
  createChatTurn(projectId,{clientId,message,mode='standard'}) {
    const id=randomUUID(),time=now();
    // allowance is a retired per-reply spending limit, kept as a column for older databases.
    this.db.prepare('INSERT INTO chat_turns(id,project_id,client_id,user_text,allowance,mode,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id,projectId,clientId,message,0,mode,time,time);
    return this.chatTurns(projectId).find(t=>t.id===id);
  }
  updateChatTurn(projectId,id,patch) {
    const entries=Object.entries(patch).filter(([k])=>['status','answer','answer_parts','note','draft','proposals'].includes(k));if(!entries.length)return;
    this.db.prepare(`UPDATE chat_turns SET ${entries.map(([k])=>`${k}=?`).join(',')},updated=? WHERE id=? AND project_id=?`).run(...entries.map(([k,v])=>['answer_parts','proposals'].includes(k)?encode(v):v),now(),id,projectId);
  }
  saveQuestion(id,body) {
    const p=this.project(id),question=p?.questions.find(q=>q.id===body?.questionId);
    if(!question)throw new Error('This question is not in the saved project. Reload the report and try again.');
    const status=body.status;
    if(!['open','answered','dismissed'].includes(status))throw new Error('Choose answer, dismiss, or reopen.');
    if(status==='answered'&&(typeof body.answer!=='string'||!body.answer.trim()||body.answer.length>4000))throw new Error('Enter an answer between 1 and 4,000 characters.');
    const answer=status==='answered'?body.answer.trim():question.answer;
    let reason=status==='open'?'':(question.reason||'');
    if(status!=='open'&&typeof body.reason==='string'){
      reason=body.reason.trim();
      if(reason.length>600)throw new Error('Enter a reason of 600 characters or fewer.');
    }
    if(status===question.status&&answer===question.answer&&reason===(question.reason||''))return p;
    const gap=Object.fromEntries(['question','why','contact','nextStep'].map(k=>[k,question[k]||'']));
    const trailing=status==='answered'?`. Saved for the next research round.${reason?' '+reason:''}`:status==='dismissed'?`.${reason?' '+reason:''}`:'.';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO question_responses(project_id,id,gap,status,answer,reason,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET gap=excluded.gap,status=excluded.status,answer=excluded.answer,reason=excluded.reason,updated=excluded.updated').run(id,question.id,encode(gap),status,answer,reason,now());
      this.db.prepare('UPDATE projects SET updated=? WHERE id=?').run(now(),id);
      this.event(id,'info',namedEvent(status==='answered'?'Question answered:':status==='dismissed'?'Question dismissed:':'Question reopened:',question.question,trailing));
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    return this.project(id);
  }
  // Rows for open questions a replacement report dropped. Called inside the report save.
  // An answer, dismissal, or reopen that committed first is left alone: the update
  // applies only while the stored row is still open.
  closeQuestions(id,rows){
    if(!rows?.length)return;
    const insert=this.db.prepare("INSERT INTO question_responses(project_id,id,gap,status,answer,reason,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET gap=excluded.gap,status=excluded.status,answer=excluded.answer,reason=excluded.reason,updated=excluded.updated WHERE question_responses.status='open'");
    const time=now();
    for(const row of rows){
      const gap={question:row.question,why:row.why||'',contact:row.contact||'',nextStep:row.nextStep||''};
      const result=insert.run(id,row.id,encode(gap),'closed',row.answer||'',row.reason,time);
      if(!result.changes)continue;
      this.event(id,'info',namedEvent('Question closed:',row.question,` ${row.reason}`));
    }
  }
  // A label change only. It does not alter status, stages, attempts, or the saved report,
  // so research that is running or already finished keeps its recorded work.
  renameProject(id, name) {
    const next=projectName(name),current=this.project(id);
    if(!current)throw new Error('Project not found.');
    if(next===current.name&&current.input?.name===next)return current;
    const input={...current.input,name:next};
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const changed=this.db.prepare('UPDATE projects SET name=?,input=?,updated=? WHERE id=?').run(next,encode(input),now(),id);
      if(!changed.changes)throw new Error('Project not found.');
      this.event(id,'rename',`Project renamed from “${current.name}” to “${next}”.`);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.project(id);
  }
  updateProject(id, patch) {
    const allowed=['status','note','cancel_requested','report','mode','input','active_ms','address'];
    const entries=Object.entries(patch).filter(([k])=>allowed.includes(k));
    if(!entries.length)return;
    this.db.prepare(`UPDATE projects SET ${entries.map(([k])=>`${k}=?`).join(',')},updated=? WHERE id=?`).run(...entries.map(([k,v])=>['report','input'].includes(k)?encode(v):k==='cancel_requested'?Number(Boolean(v)):v),now(),id);
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
  // Full requests are for response application and explicit diagnostics only.
  attempts(id) { return this.db.prepare('SELECT * FROM attempts WHERE project_id=? ORDER BY created,rowid').all(id).map(decodeAttempt); }
  attempt(id) { return decodeAttempt(this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id)); }
  // Settled history cannot affect scheduling. Keep it out of the per-second scan.
  schedulingAttempts(id) {
    return this.db.prepare("SELECT id,project_id,stage_id,state,batch_id,next_poll,applied FROM attempts WHERE project_id=? AND stage_id!='chat' AND state IN ('dispatching','pending','received','unknown','errored') AND (state!='received' OR applied=0) AND (state!='errored' OR next_poll>?) ORDER BY created,rowid").all(id,Date.now());
  }
  attemptSummaries(id,{researchOnly=false,stageId=null}={}) {
    return this.db.prepare(`SELECT ${attemptSummaryColumns} FROM attempts WHERE project_id=?${researchOnly?" AND stage_id!='chat'":''}${stageId?' AND stage_id=?':''} ORDER BY created,rowid`).all(id,...(stageId?[stageId]:[])).map(a=>({...a,usage:decode(a.usage,{}),pricing:decode(a.pricing)}));
  }
  attemptSummary(id) {
    const a=this.db.prepare(`SELECT ${attemptSummaryColumns} FROM attempts WHERE id=?`).get(id);
    return a ? {...a,usage:decode(a.usage,{}),pricing:decode(a.pricing)} : null;
  }
  latestAttemptPayload(id,stageId,{withTools=false}={}) {
    const a=this.db.prepare(`SELECT payload FROM attempts WHERE project_id=? AND stage_id=?${withTools?" AND json_type(payload,'$.tools')='array'":''} ORDER BY created DESC,rowid DESC LIMIT 1`).get(id,stageId);
    return a ? decode(a.payload) : null;
  }
  latestAttemptStopReason(id,stageId) {
    return this.db.prepare("SELECT json_extract(response,'$.stop_reason') reason FROM attempts WHERE project_id=? AND stage_id=? AND response IS NOT NULL ORDER BY created DESC,rowid DESC LIMIT 1").get(id,stageId)?.reason??null;
  }
  previousMessageId(id,stageId) {
    return this.db.prepare("SELECT json_extract(response,'$.id') id FROM attempts WHERE project_id=? AND stage_id=? AND response IS NOT NULL AND json_extract(payload,'$.diagnostics') IS NOT NULL AND json_extract(response,'$.id') IS NOT NULL ORDER BY created DESC,rowid DESC LIMIT 1").get(id,stageId)?.id??null;
  }
  reservedSearches(id,stageId=null) {
    return this.db.prepare(`SELECT COALESCE(SUM(search_cap),0) n FROM attempts WHERE project_id=? AND stage_id!='chat' AND state IN ('dispatching','pending','unknown')${stageId?' AND stage_id=?':''}`).get(id,...(stageId?[stageId]:[])).n;
  }
  updateAttempt(id,patch) {
    if(Object.hasOwn(patch,'actual'))patch={...patch,charged_at:now()};
    const e=Object.entries(patch).filter(([k])=>['state','actual','usage','batch_id','request_id','response','next_poll','applied','cancel_sent','reserve','charged_at','estimated'].includes(k));
    this.db.prepare(`UPDATE attempts SET ${e.map(([k])=>`${k}=?`).join(',')},updated=? WHERE id=?`).run(...e.map(([k,v])=>['usage','response'].includes(k)?encode(v):v),now(),id);
  }
  // Records a request before it is sent. reserve is an estimated pending cost shown until
  // the actual charge is known; it does not limit spending. Search counts remain limited.
  reserve(projectId,stageId,{mode,modelKey,payload,reserve,chatTurnId=null,pricing=pricingSnapshot(modelKey,payload.model)}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p=this.project(projectId);
      if(!p || p.cancel_requested&&stageId!=='chat')throw new Error('Research canceled.');
      if(stageId==='chat'&&!this.db.prepare('SELECT 1 FROM chat_turns WHERE id=? AND project_id=? AND status=\'running\'').get(chatTurnId,projectId))throw new Error('This chat reply is no longer active.');
      const reservedSearches=stageId==='chat'?0:this.reservedSearches(projectId);
      const requestedSearches=payload.tools?.find(t=>t.name==='web_search')?.max_uses||0;
      const searchBudget=(scope,limit,used,reserved)=>{const error=new Error('SEARCH_BUDGET');error.exhausted={resource:'searches',scope,limit,used,reserved,outcome:'stopped'};return error;};
      if(stageId!=='chat'&&p.searches+reservedSearches+requestedSearches>LIMITS.searches)throw searchBudget('project',LIMITS.searches,p.searches,reservedSearches);
      if(stageId==='verification'){
        const work=this.stageUsage(projectId,stageId);
        if(work.searches+work.reservedSearches+requestedSearches>LIMITS.verificationSearches)throw searchBudget('stage',LIMITS.verificationSearches,work.searches,work.reservedSearches);
      }
      const id=randomUUID(),time=now();
      this.db.prepare('INSERT INTO attempts(id,project_id,stage_id,mode,model_key,state,reserve,payload,created,updated,chat_turn_id,search_cap,pricing) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,stageId,mode,modelKey,'dispatching',reserve,encode(payload),time,time,chatTurnId,requestedSearches,encode(pricing));
      this.db.exec('COMMIT');return this.attempt(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // A document the user adds is addressed as upload:<content hash>/<file name> and keeps
  // more of its text (limit); web sources keep 180,000 characters.
  source(projectId,{url,title='',text='',readFull=false,kind='web',documentDate='',limit=180000},context) {
    let canonical;try{const u=new URL(url);if(!['http:','https:',...(kind==='upload'?['upload:']:[])].includes(u.protocol))return null;u.hash='';canonical=u.href;}catch{return null;}
    const clip=used=>{if(context?.stageId&&used>limit)recordExhausted(this,{projectId,stageId:context.stageId,attemptId:context.attemptId,resource:'saved_source_characters',limit,used,outcome:'clipped'});};
    const old=this.db.prepare('SELECT * FROM sources WHERE project_id=? AND url=?').get(projectId,canonical);
    if(old){
      // Search citations never enter the evidence text, even after another part
      // of this URL has been read. Preserve provenance at the retrieval boundary.
      let combined=old.text;
      if(readFull && text){combined=mergeEvidence(combined,text);clip(combined.length);combined=combined.slice(-limit);}
      this.db.prepare('UPDATE sources SET title=?,text=?,read_full=?,retrieved=?,kind=?,document_date=? WHERE id=?').run(title||old.title,combined,readFull||old.read_full?1:0,now(),kind==='web'||!readFull&&old.read_full?old.kind:kind,documentDate||old.document_date,old.id);
      return this.sources(projectId).find(s=>s.id===old.id.split(':').at(-1));
    }
    const id='S'+(this.db.prepare('SELECT COUNT(*) n FROM sources WHERE project_id=?').get(projectId).n+1);
    const key=projectId+':'+id;
    if(readFull)clip(text.length);
    this.db.prepare('INSERT INTO sources(id,project_id,url,title,text,read_full,kind,retrieved,document_date) VALUES(?,?,?,?,?,?,?,?,?)').run(key,projectId,canonical,title||new URL(canonical).hostname||canonical,readFull?text.slice(0,limit):'',readFull?1:0,kind,now(),documentDate);
    return this.sources(projectId).find(s=>s.id===id);
  }
  sources(id) { return this.db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY rowid').all(id).map(s=>({...s,id:s.id.split(':').at(-1),read_full:Boolean(s.read_full)})); }
  // Notes the user saved to the report from project chat. They are kept apart from the
  // report itself, so a later research round that rebuilds the report keeps them.
  notes(projectId){return this.db.prepare('SELECT id,title,text,turn_id,proposal_id,created FROM report_notes WHERE project_id=? ORDER BY created,rowid').all(projectId);}
  addNote(projectId,{title,text,turnId=null,proposalId=null}){
    if(!this.project(projectId))throw new Error('Project not found.');
    const id=randomUUID();this.db.prepare('INSERT INTO report_notes(id,project_id,title,text,turn_id,proposal_id,created) VALUES(?,?,?,?,?,?,?)').run(id,projectId,title,text,turnId,proposalId,now());
    return this.notes(projectId).find(n=>n.id===id);
  }
  deleteNote(projectId,noteId){
    if(!this.db.prepare('DELETE FROM report_notes WHERE project_id=? AND id=?').run(projectId,String(noteId)).changes)throw new Error('This note is no longer saved. Reload the project.');
  }
  saveLinks(id,links){const insert=this.db.prepare('INSERT OR IGNORE INTO known_links VALUES(?,?)');for(const link of links){try{const u=new URL(link.url);u.hash='';if(['http:','https:'].includes(u.protocol))insert.run(id,u.href);}catch{}}}
  knownLinks(id){return this.db.prepare('SELECT url FROM known_links WHERE project_id=?').all(id).map(r=>r.url);}
  // Whether a canonical URL is already in the source register or among links saved from read pages.
  knownUrl(id,url){return Boolean(this.db.prepare('SELECT 1 FROM sources WHERE project_id=? AND url=? UNION ALL SELECT 1 FROM known_links WHERE project_id=? AND url=? LIMIT 1').get(id,url,id,url));}
  stageUsage(id,stageId){
    const usage=this.db.prepare('SELECT usage FROM attempts WHERE project_id=? AND stage_id=?').all(id,stageId).map(a=>decode(a.usage,{})?.server_tool_use);
    return {searches:usage.reduce((n,u)=>n+Number(u?.web_search_requests||0),0),reservedSearches:this.reservedSearches(id,stageId),reads:this.db.prepare("SELECT COUNT(*) n FROM tool_runs t JOIN attempts a ON a.id=t.attempt_id WHERE a.project_id=? AND a.stage_id=? AND t.read_reserved=1 AND t.name IN ('read_source','render_page','inspect_pdf')").get(id,stageId).n+usage.reduce((n,u)=>n+Number(u?.web_fetch_requests||0),0)};
  }
  // Searches and page reads used by one chat reply, for its own allowance. Pages fetched
  // through Anthropic's web_fetch count as page reads.
  chatUsage(projectId,turnId){
    const usage=this.db.prepare("SELECT usage FROM attempts WHERE project_id=? AND stage_id='chat' AND chat_turn_id=?").all(projectId,turnId).map(a=>decode(a.usage,{})?.server_tool_use);
    const searches=usage.reduce((n,u)=>n+Number(u?.web_search_requests||0),0),fetches=usage.reduce((n,u)=>n+Number(u?.web_fetch_requests||0),0);
    const reads=this.db.prepare("SELECT COUNT(*) n FROM tool_runs t JOIN attempts a ON a.id=t.attempt_id WHERE a.project_id=? AND a.stage_id='chat' AND a.chat_turn_id=? AND t.read_reserved=1 AND t.name IN ('read_source','render_page','inspect_pdf')").get(projectId,turnId).n+fetches;
    return {searches,reads};
  }
  tool(attemptId,toolId) { const t=this.db.prepare('SELECT * FROM tool_runs WHERE attempt_id=? AND tool_id=?').get(attemptId,toolId);return t?{...t,result:decode(t.result)}:null; }
  beginTool(attemptId,toolId,name){this.db.prepare("INSERT OR IGNORE INTO tool_runs(attempt_id,tool_id,name,state,read_reserved) VALUES(?,?,?,'running',1)").run(attemptId,toolId,name);}
  saveTool(attemptId,toolId,name,result) { this.db.prepare("INSERT INTO tool_runs(attempt_id,tool_id,name,state,result,read_reserved) VALUES(?,?,?,'complete',?,0) ON CONFLICT(attempt_id,tool_id) DO UPDATE SET state='complete',result=excluded.result").run(attemptId,toolId,name,encode(result)); }
  recover() {
    for(const a of this.db.prepare("SELECT id,project_id,stage_id FROM attempts WHERE state='dispatching'").all()){
      this.updateAttempt(a.id,{state:'unknown'});
      if(a.stage_id==='chat'){this.event(a.project_id,'warning','An interrupted chat request needs charge reconciliation in Activity. It was not resubmitted.');continue;}
      this.updateProject(a.project_id,{status:'attention',note:'A request was interrupted before its outcome was saved. Its cost reservation is retained to avoid duplicate spending.'});
      this.event(a.project_id,'warning','Interrupted request requires reconciliation. It was not automatically resubmitted.');
    }
    this.db.prepare("UPDATE stages SET status='queued' WHERE status='preparing'").run();
  }
  close(){this.db.close();}
}
