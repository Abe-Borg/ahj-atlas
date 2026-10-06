import { fireProfile } from './lib/fire-protection.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { VERSION, MODELS, LIMITS } from './lib/config.mjs';
import { addDocument, uploadLimitMb } from './lib/documents.mjs';
import { createServices } from './lib/services.mjs';
import { errorDetails } from './lib/diagnostics.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
function acquireDataLock(dir){
  mkdirSync(dir,{recursive:true});const file=path.join(dir,'instance.lock');
  for(let attempt=0;attempt<2;attempt++){
    try{const fd=openSync(file,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);return ()=>{try{if(readFileSync(file,'utf8')===String(process.pid))unlinkSync(file);}catch{}};}
    catch(e){if(e.code!=='EEXIST')throw e;let running=true;try{const pid=Number(readFileSync(file,'utf8'));if(!Number.isInteger(pid)||pid<1)running=false;else process.kill(pid,0);}catch(err){if(err.code==='ESRCH')running=false;}
      if(running)throw new Error('AHJ Atlas is already using this project database. Open the running app instead.');
      unlinkSync(file);
    }
  }throw new Error('Unable to claim the local workspace.');
}
export async function createApp({dataDir=path.join(ROOT,'data'),port=4318,provider:injectedProvider,worker=true,vaultDir,updateChecker=null}={}){
  const releaseLock=acquireDataLock(dataDir);
  let store;
  try{store=new Store(dataDir);}catch(error){releaseLock();throw error;}
  const token=randomBytes(32).toString('hex');
  let services=null;
  const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    const started=Date.now(),localRequestId=randomUUID();let endpoint='';
    res.setHeader('X-Request-Id',localRequestId);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try{
      if(!services)return send(res,503,{error:'The local workspace is starting. Reload in a moment.'});
      const actualPort=server.address()?.port||port;
      if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(req.headers.host))return send(res,403,{error:'This app accepts local requests only.'});
      const origin=req.headers.origin;
      if(origin && ![`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`].includes(origin))return send(res,403,{error:'Cross-origin requests are not allowed.'});
      const url=new URL(req.url,`http://127.0.0.1:${actualPort}`);
      endpoint=url.pathname;
      if(endpoint.startsWith('/api/')&&!endpoint.startsWith('/api/diagnostics'))res.once('finish',()=>{if(req.method==='POST'||req.method==='DELETE'||res.statusCode>=400||endpoint.endsWith('/export'))store.diagnostic('http.completed',{level:res.statusCode>=400?'warning':'info',localRequestId,method:req.method,endpoint,status:res.statusCode,durationMs:Date.now()-started});});
      let body={};
      if(req.method!=='GET'&&req.method!=='HEAD'){
        const supplied=String(req.headers['x-app-token']||'');
        if(supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))return send(res,403,{error:'Reload the app before trying again.'});
        // A document the user adds arrives as the raw file, named by X-File-Name.
        const upload=req.method==='POST'&&url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/documents$/);
        if(upload){
          const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>LIMITS.documentBytes){send(res,413,{error:`Add a document of ${uploadLimitMb} MB or less.`});return;}chunks.push(chunk);}
          let name='';try{name=decodeURIComponent(String(req.headers['x-file-name']||''));}catch{}
          const source=await addDocument(store,services.chat.tools,upload[1],{name,type:String(req.headers['content-type']||''),buffer:Buffer.concat(chunks)});
          return send(res,201,{source:{id:source.id,title:source.title,kind:source.kind,characters:source.text.length}});
        }
        if(!req.headers['content-type']?.startsWith('application/json'))return send(res,415,{error:'JSON requests are required.'});
        let raw='',size=0;for await(const chunk of req){size+=chunk.length;if(size>262144){send(res,413,{error:'Request is too large.'});return;}raw+=chunk;}
        try{body=raw?JSON.parse(raw):{};}catch{return send(res,400,{error:'The request is not valid JSON.'});}
      }
      if(url.pathname==='/api/bootstrap'&&req.method==='GET')return send(res,200,{application:'AHJ Atlas',token,version:VERSION,updatesEnabled:Boolean(updateChecker),settings:store.settings(),spending:store.spending(),models:MODELS,...services.connection()});
      if(url.pathname==='/api/updates'&&updateChecker){
        if(req.method==='GET')return send(res,200,await updateChecker.check());
        if(req.method==='POST')return send(res,200,await updateChecker.check({force:true}));
      }
      if(url.pathname==='/api/updates/download'&&updateChecker&&req.method==='POST')return send(res,200,await updateChecker.download());
      if(url.pathname==='/api/updates/install'&&updateChecker&&req.method==='POST'){
        // Installing closes the app; in-flight research or chat would lose its response.
        // Check again after the installer is re-hashed, just before the app starts closing.
        const busy=()=>Boolean(services.engine.running.size||services.engine.applying.size||services.chat.running.size);
        const refused={error:'Research or a chat reply is still running. Let it finish, or stop it, before installing the update.'};
        if(busy())return send(res,409,refused);
        let started=false;const status=await updateChecker.install({beforeLaunch:()=>(started=!busy())});
        return started?send(res,200,status):send(res,409,refused);
      }
      if(url.pathname==='/api/shutdown'&&req.method==='POST'){send(res,200,{stopping:true});setTimeout(()=>closeApp().catch(()=>{}),20);return;}
      if(url.pathname==='/api/projects'&&req.method==='GET')return send(res,200,store.list().map(({report,input,...p})=>({...p,input,reportSummary:report?.summary||''})));
      if(services && await services.route({req,res,url,body,send}))return;
      if(url.pathname==='/api/projects'&&req.method==='POST'){const project=store.create(body);return send(res,201,project);}
      const match=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)$/);
      if(match&&req.method==='GET'){const project=store.project(match[1]);if(!project)return send(res,404,{error:'Project not found.'});return send(res,200,{project,chat:services.chat.view(project.id),notes:store.notes(project.id),fireProfile:fireProfile(project.input),stages:store.stages(project.id).map(({messages,...s})=>s),sources:store.sources(project.id).map(s=>({...s,text:s.text.slice(0,20000)})),events:store.events(project.id),attempts:store.attemptSummaries(project.id)});}
      if(url.pathname.startsWith('/api/'))return send(res,404,{error:'This action is unavailable.'});
      if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed.'});
      const files={'/':'public/index.html','/app.js':'public/app.js','/markdown.js':'public/markdown.js','/latest-refresh.js':'public/latest-refresh.js','/location.js':'public/location.js','/trust.js':'public/trust.js','/trust-facts.js':'public/trust-facts.js','/trust.css':'public/trust.css','/styles.css':'public/styles.css','/favicon.svg':'public/favicon.svg','/help':'public/help.html','/license':'LICENSE'};
      const filename=files[url.pathname];if(!filename)return send(res,404,{error:'Page not found.'});
      const file=await readFile(path.join(ROOT,filename));
      res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript; charset=utf-8':filename.endsWith('.css')?'text/css; charset=utf-8':filename.endsWith('.svg')?'image/svg+xml':filename.endsWith('.html')?'text/html; charset=utf-8':'text/plain; charset=utf-8'});res.end(req.method==='HEAD'?undefined:file);
    }catch(e){store.diagnostic('http.failed',{level:'error',localRequestId,method:req.method,endpoint,error:errorDetails(e)});send(res,400,{error:services?.safeError(e)||e.message||'The request could not be completed.',requestId:localRequestId});}
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});services=await createServices({store,provider:injectedProvider,worker,vaultDir});}
  catch(e){await new Promise(r=>server.close(()=>r()));store.close();releaseLock();throw e;}
  store.diagnostic('application.started',{version:VERSION});
  let closing=false;const closeApp=async()=>{if(closing)return;closing=true;store.diagnostic('application.stopping');await services?.close();await new Promise(r=>server.close(r));store.close();releaseLock();};
  return {server,store,services,url:`http://127.0.0.1:${server.address().port}`,close:closeApp};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp({dataDir:process.env.ATLAS_DATA_DIR||path.join(ROOT,'data'),port:Number(process.env.ATLAS_PORT||4318)});
  console.log(`AHJ Atlas is running at ${app.url}`);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{app.close().finally(()=>process.exit());});
}
