import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { startDesktop } from './lifecycle.mjs';
import { desktopPaths, PRODUCT_NAME } from './paths.mjs';
import { VERSION } from '../lib/config.mjs';
import { createUpdateChecker } from './update-check.mjs';

app.setName(PRODUCT_NAME);
const packagedSmokeProfile=app.isPackaged&&process.argv.includes('--fake-provider')&&process.env.ATLAS_DESKTOP_SMOKE_PROFILE
  ?path.resolve(process.env.ATLAS_DESKTOP_SMOKE_PROFILE):null;
const userData=packagedSmokeProfile||(app.isPackaged?path.join(process.env.LOCALAPPDATA||app.getPath('appData'),PRODUCT_NAME)
  :process.env.ATLAS_DESKTOP_PROFILE_DIR?path.resolve(process.env.ATLAS_DESKTOP_PROFILE_DIR)
    :path.join(os.tmpdir(),'AHJ Atlas Desktop Dev'));
mkdirSync(userData,{recursive:true});
app.setPath('userData',userData);

async function checkRuntime(){
  if(app.getVersion()!==VERSION)throw new Error('Desktop and backend version metadata differ.');
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('Electron must embed Node.js 24 or newer.');
  const db=new DatabaseSync(':memory:');
  try{db.exec('CREATE TABLE probe (value INTEGER); INSERT INTO probe VALUES (24)');
    if(db.prepare('SELECT value FROM probe').get().value!==24)throw new Error('node:sqlite failed its read/write probe.');}
  finally{db.close();}
  const {createCanvas}=await import('@napi-rs/canvas');
  if(!createCanvas(1,1).getContext('2d'))throw new Error('@napi-rs/canvas failed its native load probe.');
}

// A verified update installer runs only after the workspace has closed, so it
// never replaces files the app is still using.
let pendingInstaller=null;
const launchInstaller=app.isPackaged&&process.platform==='win32'&&!packagedSmokeProfile?(file,args)=>{
  pendingInstaller={file,args};
  setTimeout(()=>app.quit(),250);
}:null;

let provider;
if((!app.isPackaged||packagedSmokeProfile)&&process.argv.includes('--fake-provider')){
  const {FakeProvider,chatResponse}=await import('../tests/fixtures.mjs');
  provider=new class extends FakeProvider{
    async message(payload,options){
      if(options?.context?.stageId==='chat')return {data:chatResponse('Synthetic desktop chat reply. No paid model request was made.'),requestId:'req_desktop_fake_chat'};
      return super.message(payload,options);
    }
  }();
}

// Electron signals readiness after this module returns; do not top-level await.
void startDesktop({app,BrowserWindow,dialog,screen,shell,provider,
  downloadDir:provider&&process.env.ATLAS_DESKTOP_DOWNLOAD_DIR?path.resolve(process.env.ATLAS_DESKTOP_DOWNLOAD_DIR):null,
  diagnostics:process.argv.includes('--desktop-diagnostics'),
  migrationChoice:provider&&process.argv.includes('--migration-smoke')&&process.env.ATLAS_DESKTOP_LEGACY_DIR?'import':null,
  onError:error=>console.error('AHJ Atlas desktop:',String(error?.message||error).replace(/sk-ant-[\w-]+/g,'[redacted]')),
  beforeExit:()=>{if(pendingInstaller)spawn(pendingInstaller.file,pendingInstaller.args,{detached:true,stdio:'ignore'}).unref();},
  resolvePaths:()=>desktopPaths({app}),
  createBackend:async options=>{
    await checkRuntime();
    const backend=await createApp({...options,updateChecker:app.isPackaged?createUpdateChecker({dataDir:options.dataDir,currentVersion:VERSION,
      downloadDir:launchInstaller?path.join(userData,'updates'):null,launchInstaller}):null});
    try{
      if(provider){
        const {fakeTools,input,report,evidenceText}=await import('../tests/fixtures.mjs');
        const {validateReport}=await import('../lib/prompts.mjs');
        backend.services.engine.tools=fakeTools(backend.store);backend.services.engine.pollMs=10;
        if(!backend.store.list().length){
          const project=backend.store.create({...input,name:'Electron synthetic report'});
          backend.store.source(project.id,{url:'https://example.com/adoption',title:'Synthetic adoption record',text:evidenceText,readFull:true});
          for(const stage of backend.store.stages(project.id))backend.store.updateStage(project.id,stage.id,{status:'complete',output:'Synthetic fixture findings.'});
          backend.store.updateProject(project.id,{status:'complete',report:validateReport(report(),backend.store.sources(project.id))});
        }
      }
      if(process.argv.includes('--browser-smoke')&&(!app.isPackaged||process.env.ATLAS_DESKTOP_TEST_READER==='1')){
        const project=backend.store.list()[0];
        if(!project)throw new Error('Create a synthetic project before running the browser reader smoke.');
        const {ResearchTools}=await import('../lib/research-tools.mjs');
        const smokeUrl=process.env.ATLAS_DESKTOP_TEST_READER_URL||'https://example.com';
        const result=JSON.parse((await new ResearchTools(backend.store).render(project.id,{url:smokeUrl})).text);
        console.log(`AHJ Atlas desktop browser reader: ${result.title}; ${result.text.length} rendered characters`);
      }
      console.log(`AHJ Atlas desktop ready at ${backend.url}`);
      return backend;
    }catch(error){await backend.close();throw error;}
  }}).catch(()=>{process.exitCode=1;});
