// Optional local-browser regression: node tests/questions-ui.mjs. No paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { FakeProvider,input,report } from './fixtures.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-questions-ui-')),provider=new FakeProvider();
let app,browser,page,phase="setup";
try {
  app=await createApp({dataDir:dir,port:0,provider,worker:false});app.services.engine.tick=async()=>{};
  const p=app.store.create({...input,name:'Example project · question cards'}),r=report();
  r.gaps=[{question:'Which fire protection systems are proposed?',why:'The proposed systems help determine which standards need further research.',contact:'Project design team',nextStep:'Add the systems and any known equipment details.'},{question:'What is the expected permit date?',why:'The permit date can affect which adopted editions apply.',contact:'Project owner',nextStep:'Confirm the planned submission date.'}];
  app.store.updateProject(p.id,{status:'complete',report:r});for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete'});
  phase="launch browser";console.log(phase);
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true});phase="open page";page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1440,height:1080});
  phase="new project labels";console.log(phase);await page.goto(app.url);await page.waitForSelector('#project-form');await page.click('details.extra>summary');
  for(const id of ['scope','occupancy','permit-date','country','notes'])assert.match(await page.$eval(`label[for="${id}"]`,e=>e.textContent),/optional/);
  assert.match(await page.$eval('details.extra>summary',e=>e.textContent),/optional/);
  phase="question forms";console.log(phase);await page.click(`[data-project="${p.id}"]`);await page.waitForSelector('[data-question-form]');
  const [one,two]=app.store.project(p.id).questions,answer=`#answer-${one.id}`;
  await page.type(answer,'Wet-pipe sprinklers and one electric fire pump.');
  // Polling must preserve an unfinished answer and its focus/caret.
  app.store.updateProject(p.id,{note:'Synthetic progress update.'});
  await page.waitForFunction(()=>document.querySelector('.notice')?.textContent.includes('Synthetic progress update.'),{timeout:10000});
  assert.equal(await page.$eval(answer,e=>e.value),'Wet-pipe sprinklers and one electric fire pump.');assert.equal(await page.evaluate(()=>document.activeElement.id),`answer-${one.id}`);
  // A rejected save leaves the user's text in place and displays the error.
  phase="save and retry";console.log(phase);await page.setRequestInterception(true);let rejectSave=true;
  page.on('request',req=>{if(rejectSave&&req.url().endsWith('/questions')&&req.method()==='POST'){rejectSave=false;req.respond({status:400,contentType:'application/json',body:JSON.stringify({error:'Synthetic save failure. Please retry.'})});}else req.continue();});
  await page.click(`[data-question="${one.id}"] button[type=submit]`);await page.waitForFunction(()=>document.querySelector('[data-question-error]')?.textContent.includes('Synthetic save failure'));
  assert.equal(await page.$eval(answer,e=>e.value),'Wet-pipe sprinklers and one electric fire pump.');
  await page.click(`[data-question="${one.id}"] button[type=submit]`);await page.waitForSelector('#saved-questions');assert.equal(app.store.project(p.id).questions[0].status,'answered');
  await page.click(`[data-question="${two.id}"] [data-question-action=dismissed]`);await page.waitForFunction(()=>document.querySelector('#project-questions .empty-state h3')?.textContent==='No open questions');
  phase="reload and edit";console.log(phase);await page.reload();await page.waitForSelector('#saved-questions');await page.click('#saved-questions>summary');
  assert.match(await page.$eval('#saved-questions',e=>e.textContent),/Wet-pipe sprinklers and one electric fire pump/);
  await page.click(`#edit-${one.id}>summary`);await page.$eval(answer,e=>{e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));});await page.type(answer,'Wet-pipe sprinklers only.');
  await page.click(`[data-question="${one.id}"] button[type=submit]`);await page.waitForFunction(()=>document.querySelector('.question-answer')?.textContent==='Wet-pipe sprinklers only.');
  await page.click(`[data-question="${two.id}"] [data-question-action=open]`);await page.waitForSelector(`#answer-${two.id}`);
  await page.type(`#answer-${two.id}`,'October 2026 — awaiting owner confirmation.');
  phase="screenshots";console.log(phase);mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/question-cards-desktop.png',fullPage:true});
  await page.setViewport({width:390,height:844});await page.screenshot({path:'test-results/question-cards-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  phase="research handoff";console.log(phase);await page.click('#research-answers');await page.waitForSelector('#action-dialog[open]');assert.match(await page.$eval('#action-content',e=>e.textContent),/saved answers and dismissals/i);
  await page.click('#action-submit');await page.waitForFunction(()=>!document.querySelector('#action-dialog').open);
  assert.equal(app.store.project(p.id).input.questionResponses.find(q=>q.id===one.id).answer,'Wet-pipe sprinklers only.');assert.ok(app.store.stages(p.id).every(s=>s.status==='queued'));
  assert.equal(provider.calls.length,0);assert.equal(provider.batches.size,0);assert.deepEqual(errors,[]);
  console.log('Browser checks passed: optional labels, save failure/retry, answer/edit/dismiss/reopen, reload persistence, polling draft protection, research handoff, desktop/mobile layout. No provider calls.');
} catch(e) {
  console.error("Failed during: "+phase);if(page){console.error(await page.evaluate(()=>document.body.innerText).catch(()=>"Page unavailable"));await page.screenshot({path:"test-results/question-cards-failure.png",fullPage:true}).catch(()=>{});}throw e;
} finally {
  await browser?.close();await app?.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-questions-ui-')));rmSync(dir,{recursive:true,force:true});
}
