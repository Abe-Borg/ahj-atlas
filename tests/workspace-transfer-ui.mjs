// Browser regression for Export workspace and Import workspace, run by npm run test:ui. Two
// temporary workspaces stand in for two teammates; no paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { validateReport } from '../lib/prompts.mjs';
import { input,report,evidenceText,FakeProvider } from './fixtures.mjs';

const root=mkdtempSync(path.join(os.tmpdir(),'ahj-workspace-ui-')),downloads=path.join(root,'downloads');mkdirSync(downloads);
const staging=dir=>readdirSync(dir).filter(n=>n.startsWith('transfer-'));
let mine,theirs,browser;
async function until(check,message){for(let n=0;n<400;n++){if(await check())return;await new Promise(r=>setTimeout(r,25));}assert.fail(message);}
const rows=page=>page.$$eval('#workspace-projects label',labels=>labels.map(l=>({name:l.querySelector('strong').textContent,checked:l.querySelector('input').checked,disabled:l.querySelector('input').disabled,state:l.querySelector('.transfer-state').textContent})));
try{
  // The author's workspace: a finished project, one waiting on a batch, and one between requests.
  mine=await createApp({dataDir:path.join(root,'mine'),port:0,provider:new FakeProvider(),worker:false});mine.services.engine.tick=async()=>{};
  const s=mine.store,done=s.create({...input,name:'Phoenix <b>PHX-10</b>',address:'4000 Example Pkwy, Phoenix, AZ 85043'});
  s.source(done.id,{url:'https://example.com/adoption',title:'Synthetic adoption record',text:evidenceText,readFull:true});
  for(const stage of s.stages(done.id))s.updateStage(done.id,stage.id,{status:'complete',output:'Synthetic findings.'});
  s.updateProject(done.id,{status:'complete',report:validateReport(report(),s.sources(done.id))});
  const batch=s.create({...input,name:'Dallas batch',mode:'batch'});const b=s.reserve(batch.id,'jurisdiction',{mode:'batch',modelKey:'research',payload:{},reserve:1000});
  s.updateAttempt(b.id,{state:'pending',batch_id:'msgbatch_ui'});s.updateProject(batch.id,{status:'waiting_batch'});
  const running=s.create({...input,name:'Montréal campus',address:'1000 Rue Example, Montréal, QC H3B 1A1',country:'Canada'});s.updateProject(running.id,{status:'researching'});
  // The teammate's workspace starts empty.
  theirs=await createApp({dataDir:path.join(root,'theirs'),port:0,provider:new FakeProvider(),worker:false});theirs.services.engine.tick=async()=>{};

  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const cdp=await browser.target().createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const errors=[],page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  const confirms=[];page.on('dialog',d=>{confirms.push(d.message());void d.accept();});
  await page.setViewport({width:1440,height:1000});

  console.log('Export the whole workspace');
  await page.goto(mine.url);await page.waitForSelector('#project-form');
  assert.equal(await page.$eval('#export-workspace',e=>e.hidden),false);
  await page.locator('#export-workspace').click();await page.waitForSelector('#workspace-export-dialog[open]');
  await page.waitForFunction(()=>document.querySelector('#workspace-export-count').textContent==='3 projects will be saved.');
  assert.match(await page.$eval('#workspace-export-held',e=>e.hidden?'':e.textContent),/Still running:.*Dallas batch/);
  assert.doesNotMatch(await page.$eval('#workspace-export-held',e=>e.textContent),/Montréal|Phoenix/);
  await page.locator('#workspace-export-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#workspace-export-dialog').open&&/Preparing the workspace file/.test(document.querySelector('#toast').textContent));
  await until(()=>readdirSync(downloads).some(f=>f.endsWith('.ahjatlas')),'The workspace file was not downloaded.');
  const name=readdirSync(downloads).find(f=>f.endsWith('.ahjatlas'));assert.match(name,/^AHJ Atlas workspace \d{4}-\d{2}-\d{2}\.ahjatlas$/);
  const file=path.join(downloads,name);
  await until(()=>!staging(mine.store.dir).length,'The export staging folder was not removed.');

  console.log('An empty workspace can import but has nothing to export');
  await page.goto(theirs.url);await page.waitForSelector('#project-form');
  assert.deepEqual(await page.$eval('#export-workspace',e=>e.hidden),true);assert.equal(await page.$eval('#import-workspace',e=>e.hidden),false);
  await page.locator('#import-workspace').click();await page.waitForSelector('#workspace-import-dialog[open]');
  assert.deepEqual(await page.$eval('#workspace-import-submit',e=>[e.textContent,e.disabled]),['Import',true]);

  console.log('A file that is not a workspace export is refused');
  const bad=path.join(root,'addresses.ahjatlas');writeFileSync(bad,'Project,Address\r\n');
  await (await page.$('#workspace-file')).uploadFile(bad);
  await page.waitForFunction(()=>/not an AHJ Atlas workspace export/.test(document.querySelector('#workspace-import-error').textContent));
  assert.equal(await page.$eval('#workspace-preview',e=>e.hidden),true);

  console.log('Preview the file: new, held and paused projects');
  await (await page.$('#workspace-file')).uploadFile(file);
  await page.waitForFunction(()=>!document.querySelector('#workspace-preview').hidden);
  assert.equal(await page.$eval('#workspace-import-error',e=>e.textContent),'');
  assert.match(await page.$eval('#workspace-source',e=>e.textContent),/^Exported .+ from AHJ Atlas \d+\.\d+\.\d+ · 3 projects$/);
  assert.equal(await page.$eval('#workspace-file-name',e=>e.textContent),name);
  const listed=await rows(page);
  assert.deepEqual(listed.map(r=>[r.name,r.checked,r.disabled]),[['Montréal campus',true,false],['Dallas batch',false,true],['Phoenix <b>PHX-10</b>',true,false]]);
  assert.equal(await page.$('#workspace-projects b'),null);
  assert.match(listed[1].state,/^Cannot be imported: its research requests were still running/);
  assert.equal(listed[0].state,'New to your workspace.');
  assert.equal(await page.$eval('#workspace-count',e=>e.textContent),'2 new · 2 of 3 can be imported');
  assert.deepEqual(await page.$eval('#workspace-import-submit',e=>[e.textContent,e.disabled]),['Import 2 projects',false]);
  assert.equal(await page.$eval('#workspace-choose',e=>e.textContent),'Choose a different file');

  console.log('Closing the dialog discards the staged file');
  assert.equal(staging(theirs.store.dir).length,1);
  await page.locator('#workspace-import-dialog [data-close]').click();
  await until(()=>!staging(theirs.store.dir).length,'The staged import was not discarded.');
  assert.equal(theirs.store.list().length,0);

  console.log('Import the new projects');
  await page.locator('#import-workspace').click();await page.waitForSelector('#workspace-import-dialog[open]');
  assert.equal(await page.$eval('#workspace-preview',e=>e.hidden),true);
  await (await page.$('#workspace-file')).uploadFile(file);await page.waitForFunction(()=>!document.querySelector('#workspace-preview').hidden);
  await page.locator('#workspace-import-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#workspace-import-dialog').open&&document.querySelector('#toast').textContent==='Imported 2 projects.');
  assert.deepEqual(confirms,[]);
  await page.waitForFunction(()=>document.querySelectorAll('#project-list .project-nav').length===2);
  assert.deepEqual(await page.$$eval('#project-list .project-nav strong',e=>e.map(x=>x.textContent)),['Montréal campus','Phoenix <b>PHX-10</b>']);
  assert.match(await page.$eval('#project-list',e=>e.textContent),/Needs attention/);
  assert.equal(await page.$eval('#export-workspace',e=>e.hidden),false);
  assert.equal(theirs.store.project(done.id).status,'complete');assert.equal(theirs.store.project(running.id).status,'attention');

  console.log('Choosing the same file again shows them up to date; a changed project can replace your copy');
  s.addNote(done.id,{title:'Later note',text:'Added after the first export.'});
  const later=await fetch(mine.url+'/api/workspace/export',{headers:{'sec-fetch-site':'same-origin'}});const second=path.join(root,'second.ahjatlas');writeFileSync(second,Buffer.from(await later.arrayBuffer()));
  await page.locator('#import-workspace').click();await page.waitForSelector('#workspace-import-dialog[open]');
  await (await page.$('#workspace-file')).uploadFile(second);await page.waitForFunction(()=>!document.querySelector('#workspace-preview').hidden);
  const again=await rows(page);
  assert.deepEqual(again.map(r=>[r.name,r.checked,r.disabled]),[['Montréal campus',false,true],['Dallas batch',false,true],['Phoenix <b>PHX-10</b>',false,false]]);
  assert.equal(again[0].state,'Already in your workspace and up to date.');
  assert.equal(again[2].state,'In your workspace. Check to replace your copy with this one.');
  assert.deepEqual(await page.$eval('#workspace-import-submit',e=>[e.textContent,e.disabled]),['Import',true]);
  await page.click(`#workspace-projects input[value="${done.id}"]`);
  assert.equal(await page.$eval('#workspace-count',e=>e.textContent),'0 new, 1 to replace · 1 of 3 can be imported');
  await page.locator('#workspace-import-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#workspace-import-dialog').open&&document.querySelector('#toast').textContent==='Replaced 1 project.');
  assert.equal(confirms.length,1);assert.match(confirms[0],/^Replace 1 of your projects with the copy in this file\?/);
  assert.deepEqual(theirs.store.notes(done.id).map(n=>n.title),['Later note']);

  console.log('Mobile layout');
  await page.setViewport({width:390,height:844});await page.goto(theirs.url);await page.waitForSelector('#project-form');
  await page.locator('#import-workspace').click();await page.waitForSelector('#workspace-import-dialog[open]');
  await (await page.$('#workspace-file')).uploadFile(second);await page.waitForFunction(()=>!document.querySelector('#workspace-preview').hidden);
  const fit=await page.$eval('#workspace-import-dialog',e=>{const r=e.getBoundingClientRect();return {left:r.left>=0,right:r.right<=innerWidth,scroll:e.scrollWidth<=e.clientWidth+1};});
  assert.deepEqual(fit,{left:true,right:true,scroll:true});
  await page.locator('#workspace-import-dialog [data-close]').click();
  await until(()=>!staging(theirs.store.dir).length,'The staged import was not discarded.');

  assert.deepEqual(errors,[]);
  console.log('Workspace transfer browser checks passed: export dialog and download, held notice, refused file, preview states, escaped names, discard on close, import, up-to-date and replace on a second file, and mobile layout.');
}finally{
  await browser?.close();await mine?.close();await theirs?.close();
  assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(),'ahj-workspace-ui-')));rmSync(root,{recursive:true,force:true});
}
