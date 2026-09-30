// Optional real-browser regression, with fake responses and no paid API calls.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { input,report,ChatProvider,chatResponse } from './fixtures.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-chat-ui-')),releases=[];
// Later phases replace the held replies with their own behavior.
let custom=null;
const provider=new ChatProvider((payload,n,options)=>custom?custom(payload,n,options):new Promise(resolve=>releases.push(()=>{
  const source=payload.messages[0].content.find(b=>b.type==='search_result');
  resolve(chatResponse('',{content:[{type:'text',text:`**${n===2?'BRAVO':'ALPHA'} reply**\nThe saved source describes this project [S1].\n<img src=x onerror="window.injected=true">`,citations:[{type:'search_result_location',source:source.source,title:source.title,cited_text:source.content[0].text,search_result_index:0,start_block_index:0,end_block_index:1}]}]}));
})));
let app,browser,page,phase='setup';
try{
  app=await createApp({dataDir:dir,port:0,provider,worker:false});
  const create=name=>{const p=app.store.create({...input,name});app.store.updateProject(p.id,{status:'complete',report:{...report(),summary:name+' synthetic report.'}});for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete'});app.store.source(p.id,{url:'https://example.com/'+name,title:name+' source',text:name+' evidence from the saved record. <img src=x onerror="window.injected=true">',readFull:true});return p;};
  const a=create('ALPHA project'),b=create('BRAVO project');
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});page=await browser.newPage();await page.setViewport({width:1440,height:1100});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  phase='required name';await page.goto(app.url);await page.waitForSelector('#name');assert.equal(await page.$eval('#name',e=>e.required),true);assert.ok(!/optional/.test(await page.$eval('label[for=name]',e=>e.textContent)));assert.equal(await page.$eval('#name',e=>e.checkValidity()),false);
  const click=selector=>page.locator(selector).click();
  phase='project drafts';await click(`[data-project="${a.id}"]`);await click('[data-tab=chat]');await page.waitForSelector('#chat-message');await page.type('#chat-message','ALPHA unsent message');
  await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading h2')?.textContent.includes('BRAVO'));assert.equal(await page.$eval('#chat-message',e=>e.value),'');await page.type('#chat-message','BRAVO independent message');
  await click(`[data-project="${a.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading h2')?.textContent.includes('ALPHA'));assert.equal(await page.$eval('#chat-message',e=>e.value),'ALPHA unsent message');
  phase='concurrent isolated replies';await click('#chat-form button[type=submit]');await page.waitForSelector('#chat-stop');assert.equal(await page.$eval('#chat-message',e=>e.disabled),true);
  await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading h2')?.textContent.includes('BRAVO'));assert.equal(await page.$eval('#chat-message',e=>e.value),'BRAVO independent message');assert.ok(!(await page.$eval('#report-content',e=>e.innerText)).includes('ALPHA'));await click('#chat-form button[type=submit]');await page.waitForSelector('#chat-stop');
  while(releases.length<2)await new Promise(r=>setTimeout(r,5));assert.equal(provider.calls.length,2);assert.ok(!JSON.stringify(provider.calls[0].payload).includes('BRAVO'));assert.ok(!JSON.stringify(provider.calls[1].payload).includes('ALPHA'));
  releases[1]();await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('BRAVO reply'),{timeout:10000});assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);assert.equal(await page.$('#chat-history img'),null);
  await click(`[data-project="${a.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading h2')?.textContent.includes('ALPHA'));assert.ok(!(await page.$eval('#chat-history',e=>e.innerText)).includes('BRAVO'));releases[0]();await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('ALPHA reply'),{timeout:10000});
  phase='citations and reload';await click('#chat-history .chat-citation summary');assert.match(await page.$eval('#chat-history .chat-citation blockquote',e=>e.textContent),/ALPHA project evidence/);assert.equal(await page.$('#chat-history .chat-citation img'),null);assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);
  await click('#chat-history .chat-citation [data-source=S1]');await page.waitForSelector('#source-S1');assert.match(await page.$eval('#source-S1',e=>e.textContent),/ALPHA project source/);await click('[data-tab=chat]');await page.reload();await click('[data-tab=chat]');assert.match(await page.$eval('#chat-history',e=>e.textContent),/ALPHA reply/);await click('#chat-history .chat-citation summary');assert.match(await page.$eval('#chat-history .chat-citation blockquote',e=>e.textContent),/ALPHA project evidence/);
  phase='reply depth';assert.deepEqual(await page.$$eval('#chat-mode option',o=>o.map(x=>x.value)),['standard','deep','opus']);assert.match(await page.$eval('#chat-mode-help',e=>e.textContent),/Sonnet 5\.5 · High reasoning/);await page.select('#chat-mode','opus');assert.match(await page.$eval('#chat-mode-help',e=>e.textContent),/Opus 5\.5 · Extra-high reasoning/);
  phase='stop reply';await page.type('#chat-message','A second ALPHA question');await click('#chat-form button[type=submit]');await page.waitForSelector('#chat-stop');while(releases.length<3)await new Promise(r=>setTimeout(r,5));await click('#chat-stop');await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Stopping after the current request'));releases[2]();await page.waitForFunction(()=>!document.querySelector('#chat-stop'),{timeout:10000});assert.equal(app.services.chat.view(a.id).turns.at(-1).status,'stopped');assert.equal(provider.calls[2].payload.model,'claude-opus-5-5');assert.match(await page.$eval('#chat-history',e=>e.textContent),/Opus · Claude Opus 5\.5/);assert.equal(await page.$eval('#chat-mode',e=>e.value),'opus');
  phase='late project response';await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading h2')?.textContent.includes('BRAVO'));
  await page.setRequestInterception(true);let held=null,holdA=true;
  page.on('request',req=>{if(holdA&&req.url()===app.url+'/api/projects/'+a.id){holdA=false;held=req;}else req.continue();});
  await click(`[data-project="${a.id}"]`);while(!held)await new Promise(r=>setTimeout(r,5));await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading h2')?.textContent.includes('BRAVO'));await held.continue();await new Promise(r=>setTimeout(r,300));assert.match(await page.$eval('.chat-heading h2',e=>e.textContent),/BRAVO/);assert.ok(!(await page.$eval('#chat-history',e=>e.textContent)).includes('ALPHA'));
  phase='estimated costs without budgets';assert.doesNotMatch(await page.$eval('#main',e=>e.innerText),/budget|allowance/i);assert.match(await page.$eval('.chat-send-row',e=>e.textContent),/estimated for this project · \$[\d.]+ from chat/);
  await click('#settings-top');await page.waitForFunction(()=>document.querySelector('#spending-summary')?.textContent.includes('TODAY'));assert.doesNotMatch(await page.$eval('#settings-dialog',e=>e.innerText),/budget|allowance/i);await click('[data-close=settings-dialog]');
  phase='markdown and live draft';let finishLive=null;
  const table='| Standard | Edition | Adopting instrument | Effective date | Local amendments | Notes |\n|---|---|---|---|---|---|\n| NFPA 13 | 2022 | Ordinance 2024-15 adopting the International Fire Code by reference | January 1, 2025 | Section 903.2 amended for high-piled storage | Applies to new construction and alterations |';
  custom=(payload,n,{onEvent})=>new Promise(resolve=>{
    finishLive=()=>resolve(chatResponse(`### Adopted editions\n\n- NFPA 13: 2022\n- NFPA 72: 2019\n\n${table}\n`));
    onEvent({type:'message_start',message:{}});onEvent({type:'content_block_start',index:0,content_block:{type:'text',text:''}});onEvent({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'**Streaming BRAVO'}});
    setTimeout(()=>onEvent({type:'content_block_delta',index:0,delta:{type:'text_delta',text:' draft**'}}),1100);
  });
  await page.type('#chat-message','Compare the adopted editions.');await click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-chat-draft] strong')?.textContent==='Streaming BRAVO draft',{timeout:10000});
  assert.equal(await page.$eval('[data-chat-step]',e=>e.textContent),'Writing the answer…');assert.ok(await page.$('#chat-stop'));
  finishLive();await page.waitForFunction(()=>document.querySelector('#chat-history .chat-table table'),{timeout:10000});
  assert.equal(await page.$('[data-chat-draft]'),null);assert.equal(await page.$$eval('#chat-history h5',h=>h.at(-1)?.textContent),'Adopted editions');
  assert.equal(await page.$$eval('#chat-history .chat-table th',th=>th.length),6);assert.ok(await page.$$eval('#chat-history li',li=>li.some(l=>l.textContent==='NFPA 72: 2019')));
  phase='declined reply and retry';let retried=null;
  custom=()=>chatResponse('Partial text',{stop_reason:'refusal',stop_details:{type:'refusal',category:'general_harms'}});
  await page.type('#chat-message','A question Claude declines.');await click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Declined by Claude'),{timeout:10000});
  assert.match(await page.$$eval('.chat-declined',e=>e.at(-1).textContent),/usage-policy safeguard \(general_harms\)/);assert.ok(!(await page.$eval('#chat-history',e=>e.textContent)).includes('Partial text'));
  assert.equal(await page.$eval('[data-chat-retry]',e=>e.textContent),'Try again with Opus');
  custom=payload=>{retried=payload;return chatResponse('Opus answer after the decline.');};
  await click('[data-chat-retry]');await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Opus answer after the decline.'),{timeout:10000});
  assert.equal(retried.model,'claude-opus-5-5');assert.match(retried.messages.at(-1).content.at(-1).text,/A question Claude declines\./);custom=null;
  // Once the message has been sent to the other model, the declined reply no longer offers it.
  assert.equal(await page.$('[data-chat-retry]'),null);await page.reload();await click('[data-tab=chat]');await page.waitForSelector('#chat-history');assert.equal(await page.$('[data-chat-retry]'),null);
  phase='desktop/mobile layout';await click('#chat-limits>summary');await page.type('#chat-message','Which missing details should I confirm with the owner?');await click('#chat-history .chat-citation summary');assert.equal(await page.$eval('#chat-history .chat-citation',e=>e.open),true);
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/project-chat-desktop.png',fullPage:true});await page.setViewport({width:390,height:844});await page.screenshot({path:'test-results/project-chat-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);console.log('Chat browser checks passed: required name, siloed drafts/history/replies, simultaneous project chats, source links, escaped content, reload, reply depth, stop, stale-response protection, estimated costs without budgets, Markdown tables and lists, live draft and step, declined reply with retry on the other model, and desktop/mobile layout. No paid API calls.');
}catch(e){console.error('Failed during: '+phase);if(page){console.error(await page.evaluate(()=>document.body.innerText).catch(()=>''));await page.screenshot({path:'test-results/project-chat-failure.png',fullPage:true}).catch(()=>{});}throw e;}
finally{for(const release of releases)release();await browser?.close();await app?.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-chat-ui-')));rmSync(dir,{recursive:true,force:true});}
