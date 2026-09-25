import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),url='http://127.0.0.1:4318';
async function running(){try{const r=await fetch(url+'/api/bootstrap',{signal:AbortSignal.timeout(1500)});const data=await r.json();return data.application==='AHJ Atlas';}catch{return false;}}
function openBrowser(){if(process.argv.includes('--no-open'))return;if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,stdio:'ignore',windowsHide:true}).unref();else spawn(process.platform==='darwin'?'open':'xdg-open',[url],{detached:true,stdio:'ignore'}).unref();}
if(Number(process.versions.node.split('.')[0])<24){console.error('AHJ Atlas needs Node.js 24 or newer. Install it from https://nodejs.org, then open this launcher again.');process.exitCode=1;}
else if(await running()){openBrowser();}
else if(!existsSync(path.join(root,'node_modules','pdfkit'))){console.error('The application libraries are missing. Open this folder in a terminal and run npm install, then open the launcher again.');process.exitCode=1;}
else{
  mkdirSync(path.join(root,'data'),{recursive:true});const log=openSync(path.join(root,'data','server.log'),'a');
  const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,detached:true,stdio:['ignore',log,log],windowsHide:true});child.unref();
  let ready=false;for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,500));if(await running()){ready=true;break;}}
  if(ready)openBrowser();else{console.error('The app could not start. Check data/server.log, or make sure port 4318 is available.');process.exitCode=1;}
}
