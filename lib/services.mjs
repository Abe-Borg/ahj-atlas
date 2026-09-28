import { Anthropic, validateCapabilities } from './provider.mjs';
import { Engine } from './engine.mjs';
import { KeyVault } from './key-vault.mjs';
import { MODELS, costMicros } from './config.mjs';
import { browserPath } from './research-tools.mjs';
import { exportData, excelReport, pdfReport } from './exports.mjs';
import { diagnosticReport, redactText } from './diagnostics.mjs';
import { ProjectChat } from './chat.mjs';

export async function createServices({store,provider,worker=true,vaultDir,vault=new KeyVault({dir:vaultDir})}){
  const onDiagnostic=(event,details)=>store.diagnostic(event,details);
  const client=provider||new Anthropic(()=>vault.key,{onDiagnostic}),engine=new Engine(store,client,()=>provider?'test-transport':vault.key,{autoStart:worker});
  const chat=new ProjectChat(store,client,()=>provider?'test-transport':vault.key,engine);
  const connection=()=>({keyConfigured:Boolean(vault.key||provider),persisted:vault.persisted,windows:process.platform==='win32',browserAvailable:Boolean(browserPath())});
  const safeError=e=>String(e?.message||'The request could not be completed.').replace(/sk-ant-[\w-]+/g,'[redacted]');
  return {
    engine,vault,chat,
    connection,
    safeError,
    async route({req,res,url,body,send}){
      if(url.pathname==='/api/diagnostics/download'&&req.method==='GET'){
        // An attachment link cannot add the mutation header. Fetch Metadata is
        // browser-controlled and limits this download to a click in our own UI.
        if(req.headers['sec-fetch-site']!=='same-origin'){send(res,403,{error:'Open Diagnostics in the app to download this file.'});return true;}
        const report=diagnosticReport(store,{projectId:url.searchParams.get('project')||null,connection:connection()}),content=Buffer.from(JSON.stringify(report,null,2));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="AHJ-Atlas-diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}.json"`,'Content-Length':content.length});res.end(content);return true;
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
        if(body.key){
          if(!/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(next))throw new Error('Enter a valid Anthropic API key beginning with sk-ant-.');
          const probe=new Anthropic(()=>next,{onDiagnostic}),models=await probe.check();
          validateCapabilities(models);client.models=models;
        }
        store.setSettings(body);if(next)vault.set(next,Boolean(body.remember));
        for(const p of store.list().filter(p=>p.status==='needs_key')){
          for(const stage of store.stages(p.id).filter(s=>s.status==='blocked'))store.updateStage(p.id,stage.id,{status:'queued',note:''});
          store.updateProject(p.id,{status:'queued',note:''});
        }
        store.diagnostic('settings.saved',{keyConfigured:Boolean(next),remembered:Boolean(body.remember)});send(res,200,{saved:true});return true;
      }
      if(url.pathname==='/api/connection'&&req.method==='DELETE'){vault.clear();client.models=null;send(res,200,{disconnected:true});return true;}
      if(url.pathname==='/api/projects'&&req.method==='POST'){
        const p=store.create(body);if(!vault.key&&!provider)store.updateProject(p.id,{status:'needs_key',note:'Connect your Claude API key to start.'});
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
      const chatAction=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/chat(?:\/(stop))?$/);
      if(chatAction){
        const [,id,command]=chatAction;
        if(!store.project(id)){send(res,404,{error:'Project not found.'});return true;}
        if(req.method==='GET'&&!command){send(res,200,chat.view(id,{before:url.searchParams.get('before')||undefined}));return true;}
        if(req.method!=='POST')throw new Error('This chat action requires a project update.');
        send(res,command?200:202,command?chat.stop(id,body?.turnId):chat.start(id,body));return true;
      }
      const action=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/(cancel|resume|reconcile|resolve-charge|questions|export)$/);
      if(!action)return false;
      const [,id,command]=action,p=store.project(id);if(!p){send(res,404,{error:'Project not found.'});return true;}
      if(command==='export'&&req.method==='GET'){
        const format=url.searchParams.get('format')||'pdf',data=exportData(store,id);let content,type,extension;
        if(format==='json'){content=Buffer.from(JSON.stringify(data,null,2));type='application/json';extension='json';}
        else if(format==='xlsx'){content=await excelReport(data);type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';extension='xlsx';}
        else if(format==='pdf'){content=await pdfReport(data);type='application/pdf';extension='pdf';}
        else throw new Error('Choose PDF, Excel, or JSON.');
        const filename=p.name.replace(/[^A-Za-z0-9 _-]/g,'').trim().slice(0,65)||'Project';res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename="${filename} - AHJ research.${extension}"`,'Content-Length':content.length});res.end(content);return true;
      }
      if(req.method!=='POST')throw new Error('This action requires a project update.');
      if(command==='questions')store.saveQuestion(id,body);
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
