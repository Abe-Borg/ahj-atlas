import { Anthropic } from './provider.mjs';
import { Engine } from './engine.mjs';
import { KeyVault } from './key-vault.mjs';
import { MODELS, costMicros } from './config.mjs';
import { browserPath } from './research-tools.mjs';
import { exportData, excelReport, pdfReport } from './exports.mjs';
import { diagnosticReport, redactText } from './diagnostics.mjs';
import { ProjectChat } from './chat.mjs';
import { attachmentDisposition, projectExportFilename } from './download-filename.mjs';

export async function createServices({store,provider,worker=true,vaultDir,vault=new KeyVault({dir:vaultDir})}){
  const onDiagnostic=(event,details)=>store.diagnostic(event,details);
  const safeError=e=>String(e?.message||'The request could not be completed.').replace(/sk-ant-[\w-]+/g,'[redacted]');
  // A stored key is only "connected" once Anthropic accepts it: a remembered key
  // can be revoked between sessions, and any later 401 disconnects it again.
  // Outcomes are ordered by when their request started, so a long stream that was
  // authorized before a revocation cannot turn a newer rejection green again.
  let verified={key:'',status:'',message:'',since:0},checking=null;
  const recordKey=(key,status,message='',startedAt=performance.now())=>{
    if(!key||key!==vault.key||(verified.key===key&&startedAt<verified.since))return;
    const changed=verified.key!==key||verified.status!==status;
    verified={key,status,message:status==='connected'?'':message,since:startedAt};
    if(changed)store.diagnostic('connection.changed',{level:status==='connected'?'info':'warning',status});
  };
  // Anthropic answered but refused (401, 403 or another lasting 4xx): the key cannot be used.
  // Transport failures and temporary 408/429/5xx answers leave the key unverified and are retried.
  const checkFailure=e=>e.status>=400&&e.status<500&&![408,429].includes(e.status)?'invalid':'unavailable';
  const keyStatus=()=>provider?'connected':!vault.key?'missing':verified.key===vault.key?verified.status:'checking';
  const verifyKey=()=>{
    const key=vault.key,startedAt=performance.now();if(provider||!key)return Promise.resolve();
    if(checking?.key===key)return checking.promise;
    const promise=new Anthropic(()=>key,{onDiagnostic}).check().then(()=>recordKey(key,'connected','',startedAt),e=>recordKey(key,checkFailure(e),safeError(e),startedAt)).finally(()=>{if(checking?.promise===promise)checking=null;});
    checking={key,promise};return promise;
  };
  const client=provider||new Anthropic(()=>vault.key,{onDiagnostic,onKeyStatus:recordKey}),engine=new Engine(store,client,()=>provider?'test-transport':vault.key,{autoStart:worker});
  const chat=new ProjectChat(store,client,()=>provider?'test-transport':vault.key,engine);
  const connection=()=>{const status=keyStatus();return {keyConfigured:Boolean(vault.key||provider),keyStatus:status,keyMessage:['invalid','unavailable'].includes(status)?verified.message:'',persisted:vault.persisted,windows:process.platform==='win32',browserAvailable:Boolean(browserPath())};};
  verifyKey().catch(()=>{});
  return {
    engine,vault,chat,
    connection,verifyKey,
    safeError,
    async route({req,res,url,body,send}){
      if(url.pathname==='/api/diagnostics/download'&&req.method==='GET'){
        // An attachment link cannot add the mutation header. Fetch Metadata is
        // browser-controlled and limits this download to a click in our own UI.
        if(req.headers['sec-fetch-site']!=='same-origin'){send(res,403,{error:'Open Diagnostics in the app to download this file.'});return true;}
        const report=diagnosticReport(store,{projectId:url.searchParams.get('project')||null,connection:connection()}),content=Buffer.from(JSON.stringify(report,null,2));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':attachmentDisposition(`AHJ-Atlas-diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}.json`),'Content-Length':content.length});res.end(content);return true;
      }
      if(url.pathname==='/api/diagnostics'&&req.method==='POST'){
        send(res,200,diagnosticReport(store,{projectId:typeof body.projectId==='string'&&body.projectId?body.projectId:null,connection:connection()}));return true;
      }
      if(url.pathname==='/api/diagnostics/client'&&req.method==='POST'){
        store.diagnostic('browser.error',{level:'error',projectId:typeof body.projectId==='string'&&store.project(body.projectId)?body.projectId:null,message:redactText(String(body.message||'Browser error').slice(0,2000)),location:redactText(String(body.location||'').slice(0,300)),line:Number(body.line)||0});
        send(res,200,{recorded:true});return true;
      }
      if(url.pathname==='/api/settings'&&req.method==='POST'){
        const next=String(body.key||'').trim()||vault.key;
        const probeStarted=performance.now();
        if(body.key){
          if(!/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(next))throw new Error('Enter a valid Anthropic API key beginning with sk-ant-.');
          const probe=new Anthropic(()=>next,{onDiagnostic}),models=await probe.check();
          client.models=models;
        }
        store.setSettings(body);if(next)vault.set(next,Boolean(body.remember));
        if(body.key)recordKey(next,'connected','',probeStarted);
        for(const p of store.list().filter(p=>p.status==='needs_key')){
          for(const stage of store.stages(p.id).filter(s=>s.status==='blocked'))store.updateStage(p.id,stage.id,{status:'queued',note:''});
          store.updateProject(p.id,{status:'queued',note:''});
        }
        store.diagnostic('settings.saved',{keyConfigured:Boolean(next),remembered:Boolean(body.remember)});send(res,200,{saved:true});return true;
      }
      if(url.pathname==='/api/connection'&&req.method==='DELETE'){vault.clear();client.models=null;send(res,200,{disconnected:true});return true;}
      if(url.pathname==='/api/connection'&&req.method==='GET'){send(res,200,connection());return true;}
      if(url.pathname==='/api/connection/check'&&req.method==='POST'){await verifyKey();send(res,200,connection());return true;}
      if(url.pathname==='/api/projects'&&req.method==='POST'){
        const p=store.create(body);if(['missing','invalid'].includes(keyStatus()))store.updateProject(p.id,{status:'needs_key',note:'Connect your Claude API key to start.'});
        send(res,201,store.project(p.id));return true;
      }
      const deletion=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)$/);
      if(deletion&&req.method==='DELETE'){
        const id=deletion[1];
        if(!store.project(id)){send(res,404,{error:'Project not found.'});return true;}
        const attempts=store.attempts(id);
        if(chat.running.has(id)||[...engine.running].some(k=>k.startsWith(id+':'))||attempts.some(a=>engine.running.has(`apply:${a.id}`)||engine.applying.has(a.id)||engine.polling.has(a.batch_id))){
          send(res,409,{error:'Stop research and any active chat reply, then wait for the current work to finish before deleting this project.'});return true;
        }
        try{store.deleteProject(id);}catch(e){send(res,409,{error:safeError(e)});return true;}
        send(res,200,{deleted:true});return true;
      }
      // Removing a report note saved from chat. It changes no research and no source.
      const note=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/notes\/([a-f0-9-]+)$/);
      if(note&&req.method==='DELETE'){
        const [,id,noteId]=note;if(!store.project(id)){send(res,404,{error:'Project not found.'});return true;}
        store.deleteNote(id,noteId);store.event(id,'info','You removed a note from the report.');
        send(res,200,{notes:store.notes(id)});return true;
      }
      const chatAction=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/chat(?:\/(stop|apply))?$/);
      if(chatAction){
        const [,id,command]=chatAction;
        if(!store.project(id)){send(res,404,{error:'Project not found.'});return true;}
        if(req.method==='GET'&&!command){send(res,200,chat.view(id,{before:url.searchParams.get('before')||undefined}));return true;}
        if(req.method!=='POST')throw new Error('This chat action requires a project update.');
        // apply is the user's Apply on a proposal card; chat itself never changes the project.
        if(command==='apply'){send(res,200,await chat.apply(id,body));return true;}
        send(res,command?200:202,command?chat.stop(id,body?.turnId):chat.start(id,body));return true;
      }
      const action=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/(cancel|resume|reconcile|resolve-charge|questions|export|rename)$/);
      if(!action)return false;
      const [,id,command]=action,p=store.project(id);if(!p){send(res,404,{error:'Project not found.'});return true;}
      if(command==='export'&&req.method==='GET'){
        const format=url.searchParams.get('format')||'pdf',data=exportData(store,id);let content,type,extension;
        if(format==='json'){content=Buffer.from(JSON.stringify(data,null,2));type='application/json';extension='json';}
        else if(format==='xlsx'){content=await excelReport(data);type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';extension='xlsx';}
        else if(format==='pdf'){content=await pdfReport(data);type='application/pdf';extension='pdf';}
        else throw new Error('Choose PDF, Excel, or JSON.');
        res.writeHead(200,{'Content-Type':type,'Content-Disposition':attachmentDisposition(projectExportFilename(p.name,extension)),'Content-Length':content.length});res.end(content);return true;
      }
      if(req.method!=='POST')throw new Error('This action requires a project update.');
      if(command==='questions')store.saveQuestion(id,body);
      else if(command==='rename')store.renameProject(id,body.name);
      else if(command==='cancel')await engine.cancel(id);
      else if(command==='resume')await engine.resume(id,body);
      else if(command==='reconcile')await engine.reconcile(id,String(body.batchId||'').trim());
      else if(command==='resolve-charge'){
        const a=store.attempt(String(body.attemptId||'')),amount=Number(body.actualCost);
        if(!a||a.project_id!==id||a.state!=='unknown')throw new Error('Choose an unresolved request for this project.');
        if(body.confirmed!==true||!String(body.note||'').trim())throw new Error('Confirm the original request has finished or was canceled, and record how you verified its charge.');
        if(!Number.isFinite(amount)||amount<0||amount>100)throw new Error('Enter the confirmed charge from $0 to $100.');
        store.updateAttempt(a.id,{state:'settled',actual:Math.round(amount*1e6),applied:1,usage:{manuallyReconciled:true}});
        if(a.stage_id==='chat')store.updateChatTurn(id,a.chat_turn_id,{status:'interrupted',note:'The original charge was reconciled. Send a new message to continue.'});
        else{store.updateStage(id,a.stage_id,{status:'blocked',note:'Original request outcome and charge manually confirmed. Resume explicitly to retry this stage.'});store.updateProject(id,{status:'attention',note:'Uncertain charge reconciled. You can now resume research without discarding recorded costs.'});}
        store.event(id,'warning',`User reconciled an uncertain request at $${amount.toFixed(4)}. ${String(body.note).slice(0,1000)}`);
      }
      send(res,200,store.project(id));return true;
    },
    async close(){engine.closed=true;clearInterval(engine.timer);await chat.close();await engine.close();vault.key='';},
  };
}
