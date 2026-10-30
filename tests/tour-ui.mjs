// Browser regression run by npm run test:ui: the guided tour over the practice project, with a fake
// provider and no paid calls. It walks every step, checks each one points at a real control, and
// checks that the user's own project, draft and chat panel come back exactly as they were.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { TOUR_REFUSAL } from '../lib/tour.mjs';
import { TOUR, TOUR_COMPLETION_VERSION, TOUR_HOLD, TOUR_FORM_HOLD } from '../public/tour.js';
import { FakeProvider,input,report } from './fixtures.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-tour-ui-')),provider=new FakeProvider();
let app,browser,page,phase='setup';
const total=TOUR.reduce((n,chapter)=>n+chapter.steps.length,0);
const card=()=>page.evaluate(()=>{
  const c=document.querySelector('.tour-card'),layer=document.querySelector('.tour-layer');
  return {hidden:layer.hidden,kicker:c?.querySelector('.tour-kicker')?.textContent||'',title:c?.querySelector('h2')?.textContent||'',missing:Boolean(c?.querySelector('.tour-missing')),
    spotlight:!document.querySelector('.tour-cutout').hidden,next:Boolean(c?.querySelector('[data-action="next"]')),chapter:Boolean(c?.querySelector('[data-action="chapter"]')),
    inView:(()=>{const r=c.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()};
});
// A step is settled once its buttons are up and the page has stopped scrolling to its control.
const settled=async()=>{
  await page.waitForFunction(()=>{const c=document.querySelector('.tour-card');return document.querySelector('.tour-layer').hidden||c?.querySelector('[data-action="next"],[data-action="chapter"],[data-action="retry"]');},{timeout:10000});
  let last='';for(let n=0;n<40;n++){await new Promise(r=>setTimeout(r,100));const now=await page.evaluate(()=>[scrollY,...[...document.querySelectorAll('.chat-history,.tabs')].map(e=>e.scrollTop+':'+e.scrollLeft),document.querySelector('.tour-cutout').style.top].join());if(now===last)break;last=now;}
};
const press=async action=>{await page.click(`.tour-card [data-action="${action}"]`);await settled();};
const tourStatus=async()=>(await fetch(app.url+'/api/tour')).json();
try{
  mkdirSync('test-results',{recursive:true});
  app=await createApp({dataDir:dir,port:0,provider,worker:false});
  const own=app.store.create({...input,name:'My own project'});app.store.updateProject(own.id,{status:'complete',report:report()});
  for(const s of app.store.stages(own.id))app.store.updateStage(own.id,s.id,{status:'complete'});
  // Disposable, synthetic test page only. Some CI containers cannot provide the Chromium sandbox;
  // this does not change production launch flags in ResearchTools.render or Electron's sandbox.
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true,args:process.platform==='linux'?['--no-sandbox']:[]});
  page=await browser.newPage();await page.setViewport({width:1440,height:1000});
  const errors=[],dialogs=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());void d.dismiss();});

  phase='the button invites a first tour';
  await page.goto(app.url);await page.waitForSelector('#project-form');
  assert.equal(await page.$eval('#start-tour',b=>b.classList.contains('tour-new')),true);
  // The user's own draft and chat panel, to be found again after the tour.
  await page.type('#address','12 Draft Street, Springfield, IL 62701');await page.type('#name','My unsent draft');
  await page.evaluate(()=>localStorage.setItem('ahj-atlas.chat-dock',JSON.stringify({open:false,expanded:false,x:40,y:60,w:500,h:600})));

  phase='start';
  await page.click('#start-tour');await settled();
  let info=await card();
  assert.match(info.kicker,new RegExp(`^Chapter 1/${TOUR.length}`));assert.equal(info.title,'A practice project, not your work');assert.equal(info.spotlight,false);
  const practiceId=(await tourStatus()).projectId;assert.ok(practiceId);
  assert.match(await page.$eval('#breadcrumb',e=>e.textContent),/GUIDED TOUR/);
  assert.match(await page.$eval('#main',e=>e.textContent),/Practice project for the guided tour/);
  assert.equal(await page.$eval(`[data-project="${own.id}"]`,b=>b.disabled),true,'the user’s own projects are held');
  assert.equal(await page.$eval('#start-tour',b=>b.disabled),true);

  phase='escape asks before ending';
  await page.keyboard.press('Escape');await page.waitForSelector('#tour-end-dialog[open]');
  await page.click('#tour-end-dialog [data-tour-stay]');assert.equal(await page.$('#tour-end-dialog[open]'),null);
  assert.equal((await card()).title,'A practice project, not your work');

  phase='walk every step';
  const seen=[];
  for(let n=0;n<200;n++){
    info=await card();if(info.hidden)break;
    if(info.chapter){await press('chapter');continue;}
    seen.push(info.title);
    assert.equal(info.missing,false,`${info.kicker}: its control is on screen`);assert.equal(info.inView,true,`${info.kicker}: the card is in the window`);
    if(info.title!=='A practice project, not your work')assert.equal(info.spotlight,true,`${info.kicker}: the control is lit`);
    if(info.title==='Address and country'){
      phase='New research during the tour leaves the user’s draft alone';
      await page.click('#new-project');await page.waitForSelector('#project-form');
      assert.deepEqual(dialogs,[],'no prompt to discard the user’s draft');assert.match(await page.$eval('#address',e=>e.value),/Practice Parkway/);
      phase='walk every step';
    }
    if(info.title==='Start research'){
      assert.equal(await page.$eval('#start-research',b=>b.disabled),true);assert.match(await page.$eval('.form-bottom',e=>e.textContent),new RegExp(TOUR_FORM_HOLD.slice(0,40)));
      assert.equal(await page.$eval('#address',e=>e.value),'4100 Practice Parkway, Sampleton, Example State 00000');
    }
    if(info.title==='The project header'){
      phase='a change to the practice project is refused';
      await page.click('#project-name',{clickCount:3});await page.type('#project-name','Renamed in the tour');await page.click('#save-project-name');
      await page.waitForFunction(text=>document.querySelector('#rename-error')?.textContent===text,{},TOUR_REFUSAL);
      await page.waitForFunction(()=>!document.querySelector('.tour-cutout').hidden,{timeout:3000});
      assert.equal((await card()).spotlight,true,'the re-rendered header is found again');
      phase='walk every step';
    }
    if(info.title==='Questions to resolve'){
      phase='Ask Atlas on the practice project is held';
      await page.click('[data-tour="questions"] [data-ask-atlas]');
      await page.waitForFunction(text=>document.querySelector('#chat-error')?.textContent===text,{},TOUR_HOLD);
      assert.equal(await page.$('#settings-dialog[open]'),null);
      phase='walk every step';
    }
    if(info.title==='Export'){
      phase='exports work';
      const href=await page.$eval('[data-tour="export-menu"] a',a=>a.getAttribute('href'));
      const response=await fetch(app.url+href);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');
    }
    if(info.title==='Changes wait for you'){
      phase='the recording and its held composer';
      assert.equal(await page.$eval('#chat-message',e=>e.disabled),true);assert.equal(await page.$eval('#chat-message',e=>e.placeholder),TOUR_HOLD);
      assert.match(await page.$eval('#chat-history',e=>e.textContent),/This conversation is a recording/);
      await page.click('[data-tour="chat-proposal"] [data-proposal-apply]');
      await page.waitForFunction(text=>document.querySelector('[data-tour="chat-proposal"] .inline-error')?.textContent===text,{},TOUR_REFUSAL);
      phase='walk every step';
    }
    if(info.title==='Questions to resolve'){
      await page.waitForSelector('#chat-dock:not([hidden])');
      phase='back';await press('back');assert.equal((await card()).title,'Findings and their evidence');await press('next');
      phase='walk every step';
    }
    await press('next');
  }
  assert.equal(seen.length,total,`every step was shown (${seen.length} of ${total})`);
  assert.equal(provider.calls.length,0,'no model request was made');

  phase='finishing returns the workspace';
  assert.equal(await page.$('.tour-layer:not([hidden])'),null);
  await page.waitForSelector('#project-form');
  assert.equal(await page.$eval('#address',e=>e.value),'12 Draft Street, Springfield, IL 62701','the user’s draft is back');
  assert.equal(await page.$eval('#name',e=>e.value),'My unsent draft');
  assert.equal(await page.$(`[data-project="${practiceId}"]`),null);assert.equal(await page.$eval(`[data-project="${own.id}"]`,b=>b.disabled),false);
  assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('ahj-atlas.chat-dock'))),{open:false,expanded:false,x:40,y:60,w:500,h:600},'the chat panel’s place was left alone');
  assert.deepEqual(await tourStatus(),{active:false,projectId:null,finished:TOUR_COMPLETION_VERSION});
  assert.equal(await page.$eval('#start-tour',b=>b.classList.contains('tour-new')),false);
  assert.equal((await fetch(app.url+'/api/projects/'+practiceId)).status,404);
  assert.deepEqual((await (await fetch(app.url+'/api/projects')).json()).map(p=>p.id),[own.id]);

  phase='a user guide link starts at a chapter';
  await page.click(`[data-project="${own.id}"]`);await page.waitForSelector('#rename-form');
  await page.goto(app.url+'/help');await Promise.all([page.waitForNavigation(),page.click('a[href="/#tour=chat"]')]);
  await page.waitForSelector('.tour-layer');await settled();
  assert.match((await card()).kicker,/Chat with Atlas · 1\//);await press('next');
  phase='a reload picks the tour up at its step';
  await page.reload();await settled();
  assert.match((await card()).kicker,/Chat with Atlas · 2\//);assert.equal((await card()).title,'A reply and its evidence');
  phase='End returns the workspace';
  await page.keyboard.press('Escape');await page.waitForSelector('#tour-end-dialog[open]');await page.click('#tour-end-dialog [data-tour-end]');
  await page.waitForFunction(()=>document.querySelector('.tour-layer').hidden&&!document.querySelector('#tour-end-dialog[open]'));
  assert.equal((await tourStatus()).active,false);

  // The guide opened a fresh page, so the workspace it returns to is the new-project form.
  await page.waitForSelector('#project-form');

  phase='ending on the practice form keeps the user’s draft';
  await page.type('#address','34 Second Draft Road, Springfield, IL 62701');await page.type('#name','Second unsent draft');
  await page.click('#start-tour');await settled();
  while(!(await card()).chapter)await press('next');
  await press('chapter');assert.equal((await card()).title,'Address and country');
  assert.match(await page.$eval('#address',e=>e.value),/Practice Parkway/);
  await page.click('.tour-card [data-action="ask-end"]');await page.click('#tour-end-dialog [data-tour-end]');
  await page.waitForFunction(()=>document.querySelector('.tour-layer').hidden);
  await page.waitForFunction(()=>document.querySelector('#address')?.value==='34 Second Draft Road, Springfield, IL 62701');
  assert.equal(await page.$eval('#name',e=>e.value),'Second unsent draft');
  phase='a narrow window';
  await page.click(`[data-project="${own.id}"]`);await page.waitForSelector('#rename-form');
  await page.setViewport({width:390,height:844});await page.click('#start-tour');await settled();
  for(let n=0;n<4;n++){assert.equal((await card()).inView,true);await press('next');}
  await page.screenshot({path:'test-results/tour-narrow.png'});
  await page.click('.tour-card [data-action="ask-end"]');await page.click('#tour-end-dialog [data-tour-end]');
  await page.waitForFunction(()=>document.querySelector('.tour-layer').hidden);
  await page.waitForFunction(()=>document.querySelector('#project-name')?.value==='My own project');
  assert.match(await page.$eval('#breadcrumb',e=>e.textContent),/WORKSPACE/);

  assert.equal(provider.calls.length,0);assert.deepEqual(errors,[]);
  console.log(`Browser checks passed: the guided tour's ${total} steps each on a real control, held controls and refusals, exports, Escape, reload and Back, chapter links, the narrow layout, and the user's draft, project and chat panel returned with no paid calls.`);
}catch(e){
  console.error('Failed during: '+phase);if(page){await page.screenshot({path:'test-results/tour-failure.png',fullPage:true}).catch(()=>{});}throw e;
}finally{
  await browser?.close();await app?.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-tour-ui-')));rmSync(dir,{recursive:true,force:true});
}
