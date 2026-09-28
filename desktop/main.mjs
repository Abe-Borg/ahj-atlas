import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { app, BrowserWindow } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { startDesktop } from './lifecycle.mjs';

// This is a development shell. Production paths and migration belong to Session 2.
app.setName('AHJ Atlas Desktop Dev');
const userData=path.join(os.tmpdir(),'AHJ Atlas Desktop Dev');
mkdirSync(userData,{recursive:true});
app.setPath('userData',userData);

async function checkRuntime(){
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('Electron must embed Node.js 24 or newer.');
  const db=new DatabaseSync(':memory:');
  try{db.exec('CREATE TABLE probe (value INTEGER); INSERT INTO probe VALUES (24)');
    if(db.prepare('SELECT value FROM probe').get().value!==24)throw new Error('node:sqlite failed its read/write probe.');}
  finally{db.close();}
  const {createCanvas}=await import('@napi-rs/canvas');
  if(!createCanvas(1,1).getContext('2d'))throw new Error('@napi-rs/canvas failed its native load probe.');
  console.log(`AHJ Atlas desktop compatibility: Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform} ${process.arch}; node:sqlite and @napi-rs/canvas OK`);
}

let provider;
if(process.argv.includes('--fake-provider')){
  // Keep the KeyVault constructor away from a real remembered credential.
  process.env.LOCALAPPDATA=path.join(userData,'fake-localappdata');
  mkdirSync(process.env.LOCALAPPDATA,{recursive:true});
  const {FakeProvider,chatResponse}=await import('../tests/fixtures.mjs');
  provider=new class extends FakeProvider{
    async message(payload,options){
      if(options?.context?.stageId==='chat')return {data:chatResponse('Synthetic desktop chat reply. No paid model request was made.'),requestId:'req_desktop_fake_chat'};
      return super.message(payload,options);
    }
  }();
}

const dataDir=process.env.ATLAS_DESKTOP_DATA_DIR||path.join(app.getPath('userData'),'session-1-data');
// Do not top-level await app.whenReady(): Electron signals readiness after this module returns.
void startDesktop({app,BrowserWindow,dataDir,provider,createBackend:async options=>{
  await checkRuntime();
  const backend=await createApp(options);
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
      if(process.argv.includes('--browser-smoke')){
        const {ResearchTools}=await import('../lib/research-tools.mjs');
        const result=JSON.parse((await new ResearchTools(backend.store).render(backend.store.list()[0].id,{url:'https://example.com'})).text);
        console.log(`AHJ Atlas desktop browser reader: ${result.title}; ${result.text.length} rendered characters`);
      }
    }
    console.log(`AHJ Atlas desktop listening at ${backend.url}; development data: ${dataDir}`);
    return backend;
  }catch(error){await backend.close();throw error;}
}}).catch(()=>{process.exitCode=1;});
