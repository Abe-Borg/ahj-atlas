// Real-browser regression run by npm run test:ui, with fake responses and no paid API calls.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createCanvas } from '@napi-rs/canvas';
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
  const a=create('ALPHA project'),b=create('BRAVO project'),cp=create('CHARLIE project');
  app.store.updateProject(cp.id,{report:{...report(),summary:'CHARLIE project synthetic report.',gaps:[{question:'Which NFPA 13 edition does the fire marshal enforce?',why:'Design basis',contact:'Fire marshal',nextStep:'Confirm the edition.'}]}});
  // Disposable, synthetic test page only. Some CI containers cannot provide the Chromium sandbox;
  // this does not change production launch flags in ResearchTools.render or Electron's sandbox.
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true,args:process.platform==='linux'?['--no-sandbox']:[]});page=await browser.newPage();await page.setViewport({width:1440,height:1100});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  phase='required name';await page.goto(app.url);await page.waitForSelector('#name');assert.equal(await page.$eval('#name',e=>e.required),true);assert.ok(!/optional/.test(await page.$eval('label[for=name]',e=>e.textContent)));assert.equal(await page.$eval('#name',e=>e.checkValidity()),false);
  const click=selector=>page.locator(selector).click();
  phase='project drafts';await click(`[data-project="${a.id}"]`);await click('#open-chat');await page.waitForSelector('#chat-message');await page.type('#chat-message','ALPHA unsent message');
  await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('BRAVO'));assert.equal(await page.$eval('#chat-message',e=>e.value),'');await page.type('#chat-message','BRAVO independent message');
  await click(`[data-project="${a.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('ALPHA'));assert.equal(await page.$eval('#chat-message',e=>e.value),'ALPHA unsent message');
  phase='concurrent isolated replies';await click('#chat-form button[type=submit]');await page.waitForSelector('#chat-stop');assert.equal(await page.$eval('#chat-message',e=>e.disabled),true);
  await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('BRAVO'));assert.equal(await page.$eval('#chat-message',e=>e.value),'BRAVO independent message');assert.ok(!(await page.$eval('#chat-dock',e=>e.innerText)).includes('ALPHA'));await click('#chat-form button[type=submit]');await page.waitForSelector('#chat-stop');
  while(releases.length<2)await new Promise(r=>setTimeout(r,5));assert.equal(provider.calls.length,2);assert.ok(!JSON.stringify(provider.calls[0].payload).includes('BRAVO'));assert.ok(!JSON.stringify(provider.calls[1].payload).includes('ALPHA'));
  releases[1]();await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('BRAVO reply'),{timeout:10000});assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);assert.equal(await page.$('#chat-history .chat-prose img'),null);
  await click(`[data-project="${a.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('ALPHA'));assert.ok(!(await page.$eval('#chat-history',e=>e.innerText)).includes('BRAVO'));releases[0]();await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('ALPHA reply'),{timeout:10000});
  phase='citations and reload';await click('#chat-history .chat-citation summary');assert.match(await page.$eval('#chat-history .chat-citation blockquote',e=>e.textContent),/ALPHA project evidence/);assert.equal(await page.$('#chat-history .chat-citation img'),null);assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);
  await click('#chat-history .chat-citation [data-source=S1]');await page.waitForSelector('#source-S1');assert.match(await page.$eval('#source-S1',e=>e.textContent),/ALPHA project source/);await click('#open-chat');await page.reload();await click('#open-chat');assert.match(await page.$eval('#chat-history',e=>e.textContent),/ALPHA reply/);await click('#chat-history .chat-citation summary');assert.match(await page.$eval('#chat-history .chat-citation blockquote',e=>e.textContent),/ALPHA project evidence/);
  phase='reply depth';assert.deepEqual(await page.$$eval('#chat-mode option',o=>o.map(x=>x.value)),['standard','economy','opus']);assert.deepEqual(await page.$$eval('#chat-mode option',o=>o.map(x=>x.textContent)),['Standard — Claude Sonnet 5.5, high reasoning','Economy — Claude Haiku 5.5, medium reasoning','Premium — Claude Opus 5.5, high reasoning']);assert.match(await page.$eval('#chat-mode-help',e=>e.textContent),/Sonnet 5\.5 · High reasoning/);await page.select('#chat-mode','opus');assert.match(await page.$eval('#chat-mode-help',e=>e.textContent),/Opus 5\.5 · High reasoning/);
  phase='stop reply';await page.type('#chat-message','A second ALPHA question');await click('#chat-form button[type=submit]');await page.waitForSelector('#chat-stop');while(releases.length<3)await new Promise(r=>setTimeout(r,5));await click('#chat-stop');await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Stopping after the current request'));releases[2]();await page.waitForFunction(()=>!document.querySelector('#chat-stop'),{timeout:10000});assert.equal(app.services.chat.view(a.id).turns.at(-1).status,'stopped');assert.equal(provider.calls[2].payload.model,'claude-opus-5-5');assert.match(await page.$eval('#chat-history',e=>e.textContent),/Premium · Claude Opus 5\.5/);assert.equal(await page.$eval('#chat-mode',e=>e.value),'opus');
  phase='late project response';await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('BRAVO'));
  await page.setRequestInterception(true);let held=null,holdA=true;
  page.on('request',req=>{if(holdA&&req.url()===app.url+'/api/projects/'+a.id){holdA=false;held=req;}else req.continue();});
  await click(`[data-project="${a.id}"]`);while(!held)await new Promise(r=>setTimeout(r,5));
  // While the project loads, the panel shows that and the previous project's composer is gone.
  assert.equal(await page.$('#chat-dock #chat-form'),null);assert.match(await page.$eval('#chat-dock',e=>e.textContent),/Opening project/);
  await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('BRAVO'));await held.continue();await new Promise(r=>setTimeout(r,300));assert.match(await page.$eval('.chat-heading-project',e=>e.textContent),/BRAVO/);assert.ok(!(await page.$eval('#chat-history',e=>e.textContent)).includes('ALPHA'));
  phase='estimated costs without budgets';assert.doesNotMatch(await page.$eval('#main',e=>e.innerText)+await page.$eval('#chat-dock',e=>e.innerText),/budget|allowance/i);assert.match(await page.$eval('.chat-send-row',e=>e.textContent),/estimated for this project · \$[\d.]+ from chat/);
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
  assert.equal(await page.$eval('[data-chat-retry]',e=>e.textContent),'Try again with Premium');
  custom=payload=>{retried=payload;return chatResponse('Opus answer after the decline.');};
  await click('[data-chat-retry]');await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Opus answer after the decline.'),{timeout:10000});
  assert.equal(retried.model,'claude-opus-5-5');assert.match(retried.messages.at(-1).content.at(-1).text,/A question Claude declines\./);custom=null;
  // Once the message has been sent to the other model, the declined reply no longer offers it.
  assert.equal(await page.$('[data-chat-retry]'),null);await page.reload();await click('#open-chat');await page.waitForSelector('#chat-history');assert.equal(await page.$('[data-chat-retry]'),null);
  phase='economy reply and refusal retry';
  await page.select('#chat-mode','economy');assert.match(await page.$eval('#chat-mode-help',e=>e.textContent),/Haiku 5\.5 · Medium reasoning/);
  assert.match(await page.$eval('#chat-limits',e=>e.textContent),/input\/output cost \$0\.10\/\$0\.50.*100,000 tokens.*\$0\.50\/\$2\.50/);
  assert.doesNotMatch(await page.$eval('#chat-limits',e=>e.textContent),/Both depths/);
  let economyPayload=null;
  custom=payload=>{economyPayload=payload;return chatResponse('Economy summary of the saved project.');};
  await page.type('#chat-message','Summarize the saved project using Economy.');await click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Economy summary of the saved project.'),{timeout:10000});
  assert.equal(economyPayload.model,'claude-haiku-5-5');assert.equal(economyPayload.output_config.effort,'medium');assert.deepEqual(economyPayload.thinking,{type:'adaptive',display:'omitted'});
  assert.ok(economyPayload.tools.some(t=>t.name==='read_saved_source'));assert.ok(economyPayload.tools.some(t=>t.name==='web_search'));assert.ok(economyPayload.tools.some(t=>t.name==='propose_question_update'));
  assert.match(await page.$eval('#chat-history',e=>e.textContent),/Economy · Claude Haiku 5\.5/);
  await page.reload();await click('#open-chat');await page.waitForSelector('#chat-mode');
  assert.match(await page.$eval('#chat-history',e=>e.textContent),/Economy · Claude Haiku 5\.5/);assert.equal(await page.$eval('#chat-mode',e=>e.value),'standard');
  await page.select('#chat-mode','economy');custom=()=>chatResponse('',{stop_reason:'refusal',stop_details:{type:'refusal',category:'general_harms'}});
  await page.type('#chat-message','An Economy question Claude declines.');await click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-chat-retry]')?.textContent==='Try again with Standard',{timeout:10000});
  custom=payload=>{retried=payload;return chatResponse('Standard answer after the Economy decline.');};
  await click('[data-chat-retry]');await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Standard answer after the Economy decline.'),{timeout:10000});
  assert.equal(retried.model,'claude-sonnet-5-5');assert.equal(retried.output_config.effort,'high');assert.equal(await page.$('[data-chat-retry]'),null);custom=null;
  phase='proposal cards';
  const questionId=app.store.project(cp.id).questions[0].id;
  custom=payload=>payload.messages.at(-1).content.some(x=>x.type==='tool_result')?chatResponse('Two cards are ready for your approval.'):chatResponse('',{stop_reason:'tool_use',content:[
    {type:'tool_use',id:'toolu_answer',name:'propose_question_update',input:{questionId,status:'answered',answer:'NFPA 13, 2025 edition <img src=x onerror="window.injected=true">',reason:'You confirmed the edition with the fire marshal.'}},
    {type:'tool_use',id:'toolu_round',name:'propose_research_round',input:{focus:'clarification',clarification:'Owner confirmed a hyperscale data center.',reason:'The saved report predates this context.'}}]});
  await click(`[data-project="${cp.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('CHARLIE'));
  await page.type('#chat-message','I confirmed NFPA 13, 2025 edition with the fire marshal.');await click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelectorAll('.chat-proposal').length===2,{timeout:10000});
  assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);assert.equal(await page.$('.chat-proposal img'),null);assert.match(await page.$eval('.chat-proposal .chat-proposal-text',e=>e.textContent),/<img src=x/);
  assert.deepEqual(await page.$$eval('.chat-proposal h3',h=>h.map(x=>x.textContent)),['Answer a question','Start a research round']);
  assert.deepEqual(await page.$$eval('[data-proposal-apply]',b=>b.map(x=>x.textContent)),['Apply','Apply and start research']);assert.deepEqual(await page.$$eval('[data-proposal-mode] option',o=>o.map(x=>x.value)),['realtime','batch']);
  assert.equal(app.store.project(cp.id).questions[0].status,'open');assert.equal(app.store.project(cp.id).status,'complete');
  await click('[data-proposal-apply]');await page.waitForFunction(()=>document.querySelector('.chat-proposal .status-pill.green')?.textContent.startsWith('Applied'),{timeout:10000});
  let saved=app.store.project(cp.id).questions[0];assert.equal(saved.status,'answered');assert.match(saved.answer,/^NFPA 13, 2025 edition/);
  // A running reply holds the paid card; research cannot be changed while chat answers.
  let finishHeld=null;custom=()=>new Promise(resolve=>{finishHeld=()=>resolve(chatResponse('Held reply finished.'));});
  await page.type('#chat-message','Anything else to confirm?');await click('#chat-form button[type=submit]');await page.waitForSelector('#chat-stop');
  await page.waitForFunction(()=>document.querySelector('[data-proposal-apply]')?.disabled===true);assert.match(await page.$eval('.chat-proposal-actions .field-help',e=>e.textContent),/current reply finishes/);
  while(!finishHeld)await new Promise(r=>setTimeout(r,5));finishHeld();await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Held reply finished.'),{timeout:10000});
  await page.waitForFunction(()=>document.querySelector('[data-proposal-apply]')?.disabled===false,{timeout:10000});
  app.services.engine.tick=async()=>{};await page.select('[data-proposal-mode]','batch');await click('[data-proposal-apply]');
  await page.waitForFunction(()=>document.querySelectorAll('.chat-proposal .status-pill.green').length===2,{timeout:10000});
  saved=app.store.project(cp.id);assert.equal(saved.status,'queued');assert.equal(saved.mode,'batch');assert.match(saved.input.notes,/User clarification: Proposed in project chat and approved by the user: Owner confirmed a hyperscale data center\./);
  await page.setViewport({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.setViewport({width:1440,height:1100});
  await page.reload();await click('#open-chat');await page.waitForSelector('.chat-proposal');assert.equal(await page.$$eval('.chat-proposal .status-pill.green',e=>e.length),2);assert.equal(await page.$('[data-proposal-apply]'),null);custom=null;
  phase='report note';
  custom=payload=>payload.messages.at(-1).content.some(x=>x.type==='tool_result')?chatResponse('A note card is ready.'):chatResponse('',{stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_note',name:'propose_report_note',input:{title:'Sprinkler <b>edition</b>',note:'The county enforces **NFPA 13, 2025 edition** [S1]. <img src=x onerror="window.injected=true">',reason:'You asked to keep this finding.'}}]});
  await page.type('#chat-message','Save the sprinkler edition finding to the report.');await click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>[...document.querySelectorAll('.chat-proposal h3')].some(h=>h.textContent==='Save a note to the report'),{timeout:10000});
  assert.equal(app.store.notes(cp.id).length,0);assert.deepEqual(await page.$$eval('[data-proposal-apply]',b=>b.map(x=>x.textContent)),['Apply']);
  await click('[data-proposal-apply]');await page.waitForFunction(()=>document.querySelectorAll('.chat-proposal .status-pill.green').length===3,{timeout:10000});
  assert.deepEqual(app.store.notes(cp.id).map(n=>n.title),['Sprinkler <b>edition</b>']);
  // The note appears on Overview, escaped, with its citation linked to the saved source.
  await click('[data-tab=overview]');await page.waitForSelector('#report-notes');
  assert.equal(await page.$eval('#report-notes h3',e=>e.textContent),'Sprinkler <b>edition</b>');assert.equal(await page.$('#report-notes h3 b'),null);assert.equal(await page.$('#report-notes img'),null);
  assert.equal(await page.$eval('#report-notes strong',e=>e.textContent),'NFPA 13, 2025 edition');assert.ok(await page.$('#report-notes [data-source="S1"]'));assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);
  page.once('dialog',dialog=>dialog.accept());await click('[data-delete-note]');await page.waitForFunction(()=>!document.querySelector('#report-notes'),{timeout:10000});
  assert.deepEqual(app.store.notes(cp.id),[]);custom=null;await click('#open-chat');await page.waitForSelector('.chat-heading');
  phase='ask atlas';
  await page.select('#chat-mode','opus');
  let asked=null;
  custom=payload=>{
    asked??=payload;
    if(payload.messages.at(-1).content.some(x=>x.type==='tool_result'))return chatResponse('The saved source supports NFPA 13, 2022. Apply the card to save it.');
    return chatResponse('',{stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_ask_atlas',name:'propose_question_update',input:{questionId,status:'answered',answer:'NFPA 13, 2022 edition, cited from the saved source [S1].',reason:'Ask Atlas found the edition in the saved source.'}}]});
  };
  // The panel is minimized while working on Overview; Ask Atlas opens it again with the reply.
  await click('#chat-minimize');await click('[data-tab=overview]');await page.waitForSelector('#saved-questions');await page.click('#saved-questions>summary');
  assert.equal(await page.$eval(`[data-question="${questionId}"] [data-ask-atlas]`,e=>e.textContent),'Ask Atlas');assert.equal(await page.$eval('#chat-dock',e=>e.hidden),true);
  assert.equal(await page.$eval('#open-chat',e=>e.textContent.trim()),'Chat with Atlas');assert.doesNotMatch(await page.$eval('.tabs',e=>e.textContent),/Chat with Atlas/);
  assert.equal(/Chat with AI/.test(await page.$eval('#main',e=>e.textContent)),false);
  const beforeAsk=app.store.project(cp.id).questions.find(q=>q.id===questionId).answer;
  await click(`[data-question="${questionId}"] [data-ask-atlas]`);
  await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Resolve this specific question'),{timeout:10000});assert.equal(await page.$eval('#chat-dock',e=>e.hidden),false);
  await page.waitForFunction(()=>document.querySelector('[data-proposal-apply]')?.textContent==='Apply',{timeout:10000});
  assert.equal(await page.$$eval('.chat-user-text',(els,id)=>els.some(e=>e.textContent.includes('do the legwork yourself')&&e.textContent.includes(id)&&!e.textContent.includes('Which NFPA 13 edition does the fire marshal enforce?')),questionId),true);
  assert.equal(app.store.project(cp.id).questions.find(q=>q.id===questionId).answer,beforeAsk);
  assert.equal(asked.model,'claude-opus-5-5');assert.equal(asked.max_tokens,128000);assert.equal(asked.output_config.effort,'high');
  assert.ok(asked.tools.some(t=>t.name==='web_search'&&t.max_uses===4));assert.ok(asked.tools.some(t=>t.name==='propose_question_update'));
  assert.match(asked.system,/You are the project AI assistant/);
  await click('[data-proposal-apply]');
  await page.waitForFunction(()=>document.querySelectorAll('.chat-proposal .status-pill.green').length===4,{timeout:10000});
  assert.match(app.store.project(cp.id).questions.find(q=>q.id===questionId).answer,/NFPA 13, 2022 edition/);
  // Applying a note from an Ask Atlas reply saves the note and leaves the asked question open.
  phase='ask atlas note leaves the question open';
  custom=payload=>payload.messages.at(-1).content.some(x=>x.type==='tool_result')?chatResponse('A note card is ready.'):chatResponse('',{stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_ask_note',name:'propose_report_note',input:{title:'Enforced NFPA 13 edition',note:'The fire marshal enforces NFPA 13, 2022 edition [S1].',reason:'The saved source settles the question.'}}]});
  await click('#chat-minimize');await click('[data-tab=overview]');await page.waitForSelector('#saved-questions');await page.$eval('#saved-questions',d=>{d.open=true;});
  await click(`[data-question="${questionId}"] [data-question-action="open"]`);
  await page.waitForSelector(`#project-questions>[data-question="${questionId}"]`,{timeout:10000});
  await click(`#project-questions>[data-question="${questionId}"] [data-ask-atlas]`);
  await page.waitForSelector('[data-proposal-apply]',{timeout:10000});
  assert.match(await page.$eval('[data-proposal-apply]',b=>b.closest('.chat-proposal').textContent),/This leaves the question you asked Atlas about open\. Answer or dismiss it on its card when it is settled\./);
  await click('[data-proposal-apply]');
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Note saved to the report.'),{timeout:10000});
  assert.equal(await page.$eval('#toast',e=>e.textContent),'Note saved to the report. It is on Overview.');
  const kept=app.store.project(cp.id).questions.find(q=>q.id===questionId);
  assert.equal(kept.status,'open');assert.equal(kept.reason,'');assert.deepEqual(app.store.notes(cp.id).map(n=>n.title),['Enforced NFPA 13 edition']);
  // The applied card no longer shows the hint, and the question stays on Overview.
  assert.ok(!/This leaves the question you asked Atlas about open/.test(await page.$eval('.chat-proposal .status-pill.green',e=>e.closest('.chat-proposal').textContent)));
  await click('[data-tab=overview]');await page.waitForSelector('#project-questions');
  assert.ok(await page.$(`#project-questions>[data-question="${questionId}"]`));
  assert.equal(await page.$eval('#project-questions .finding-top .status-pill',e=>e.getAttribute('aria-label')),'1 open questions');
  await click('#open-chat');await page.waitForSelector('.chat-heading');
  custom=null;
  await click(`[data-project="${b.id}"]`);await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('BRAVO'));
  phase='attach documents';
  // Each added document refreshes the project last; its Sources count shows the page has settled.
  const settledSources=n=>page.waitForFunction(n=>document.querySelector('[data-tab=sources] .tab-count')?.textContent===String(n),{timeout:10000},n);
  const pick=(selector,name,text,type='text/plain')=>page.$eval(selector,(e,name,text,type)=>{const files=new DataTransfer();files.items.add(new File([text],name,{type}));e.files=files.files;e.dispatchEvent(new Event('change',{bubbles:true}));},name,text,type);
  assert.equal(await page.$eval('#chat-attach-button',e=>e.textContent),'Attach document');assert.match(await page.$eval('#chat-limits',e=>e.textContent),/Removing it here keeps it in Sources/);
  // An unsupported file is refused with the server's explanation and attaches nothing.
  await pick('#chat-file','notes.docx','PK\u0003\u0004word','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await page.waitForFunction(()=>document.querySelector('#chat-error')?.textContent.includes('Save other formats'),{timeout:10000});assert.equal(await page.$('.chat-attachments'),null);
  // A chosen file joins Sources and is listed on the unsent message, its name escaped.
  await pick('#chat-file','AHJ <letter>.txt','The county enforces the 2024 International Fire Code with local amendments.');
  await page.waitForFunction(()=>document.querySelector('.chat-attachments li')?.textContent.includes('AHJ <letter>.txt'),{timeout:10000});
  await settledSources(2);const letterSource=app.store.sources(b.id).find(x=>x.title==='AHJ <letter>.txt');assert.equal(letterSource.kind,'upload');assert.equal(await page.$('.chat-attachments letter'),null);assert.equal(await page.$eval('#chat-error',e=>e.textContent),'');
  // A file dropped on the composer is attached the same way; removing it keeps it in Sources.
  await page.$eval('#chat-form',form=>{const files=new DataTransfer();files.items.add(new File(['Owner criteria: in-rack sprinklers are required.'],'Owner criteria.txt',{type:'text/plain'}));form.dispatchEvent(new DragEvent('drop',{dataTransfer:files,bubbles:true,cancelable:true}));});
  await page.waitForFunction(()=>document.querySelectorAll('.chat-attachments li').length===2,{timeout:10000});
  await settledSources(3);const criteria=app.store.sources(b.id).find(x=>x.title==='Owner criteria.txt');
  // Attach document opens the file chooser and keeps keyboard focus through the upload.
  const reviewFile=path.join(dir,'Plan review comments.txt');writeFileSync(reviewFile,'Plan review: hydraulic calculations must use the 2025 edition of NFPA 13.');
  const [chooser]=await Promise.all([page.waitForFileChooser(),click('#chat-attach-button')]);assert.equal(chooser.isMultiple(),true);await chooser.accept([reviewFile]);
  await page.waitForFunction(()=>document.querySelectorAll('.chat-attachments li').length===3,{timeout:10000});await settledSources(4);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'chat-attach-button');
  const review=app.store.sources(b.id).find(x=>x.title==='Plan review comments.txt');
  await click(`[data-chat-detach="${criteria.id}"]`);await page.waitForFunction(()=>document.querySelectorAll('.chat-attachments li').length===2);
  assert.ok(app.store.sources(b.id).some(x=>x.id===criteria.id));assert.equal(await page.evaluate(()=>document.activeElement?.id),'chat-attach-button');
  let attachedPayload=null;custom=payload=>{attachedPayload=payload;return chatResponse('The attached letter confirms local amendments.');};
  await page.type('#chat-message','What does the letter I attached say?');await click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('The attached letter confirms local amendments.'),{timeout:10000});
  const latestText=attachedPayload.messages.at(-1).content.at(-1).text;
  const sentAttachments=[{sourceId:letterSource.id,title:'AHJ <letter>.txt'},{sourceId:review.id,title:'Plan review comments.txt'}];
  assert.match(latestText,/^Latest user message:\nWhat does the letter I attached say\?\n\nDocuments I attached to this message/);assert.ok(latestText.endsWith(JSON.stringify(sentAttachments)));assert.ok(!latestText.includes(criteria.id+'"'));
  assert.deepEqual(app.store.chatTurns(b.id).at(-1).attachments,sentAttachments);
  // Sending clears the composer's list; the sent message shows its document, which opens in Sources.
  assert.equal(await page.$('.chat-attachments'),null);
  assert.deepEqual(await page.$$eval('.chat-turn-attachments button',b=>b.map(x=>x.textContent)),sentAttachments.map(a=>`${a.sourceId} · ${a.title}`));
  await page.reload();await click('#open-chat');await page.waitForSelector('.chat-turn-attachments');
  await click(`.chat-turn-attachments [data-source="${letterSource.id}"]`);await page.waitForSelector(`#source-${letterSource.id}`);assert.match(await page.$eval(`#source-${letterSource.id}`,e=>e.textContent),/your document/);
  await click('#open-chat');await page.waitForSelector('#chat-message');custom=null;
  phase='attach images';
  const png=(w,h)=>{const c=createCanvas(w,h),x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,w,h);x.fillStyle='#123456';x.fillRect(0,0,Math.round(w/3),Math.round(h/3));return c.toBuffer('image/png').toString('base64');};
  const pickImage=(selector,name,b64,type)=>page.$eval(selector,(e,name,b64,type)=>{const bytes=Uint8Array.from(atob(b64),ch=>ch.charCodeAt(0));const files=new DataTransfer();files.items.add(new File([bytes],name,{type}));e.files=files.files;e.dispatchEvent(new Event('change',{bubbles:true}));},name,b64,type);
  assert.equal(await page.$eval('#chat-attach-image-button',e=>e.textContent.trim()),'Attach image');
  // A text file chosen as an image is refused by its bytes, and nothing is attached.
  await pickImage('#chat-image-file','letter.txt',Buffer.from('Just text').toString('base64'),'image/png');
  await page.waitForFunction(()=>document.querySelector('#chat-error')?.textContent.includes('PNG, JPEG, GIF or WebP'),{timeout:10000});assert.equal(await page.$('.chat-attachment-image'),null);
  // A screenshot pasted into the message box is scaled, attached and shown from the app's own copy.
  await page.$eval('#chat-message',(e,b64)=>{const bytes=Uint8Array.from(atob(b64),ch=>ch.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'Plan review <photo>.png',{type:'image/png'}));e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},png(3000,1500));
  await page.waitForFunction(()=>document.querySelectorAll('.chat-attachment-image').length===1,{timeout:10000});
  const pasted=app.store.chatImages(b.id)[0];assert.equal(pasted.name,'Plan review <photo>.png');assert.ok(pasted.width<=1568&&pasted.width*pasted.height<=1150000+pasted.width+pasted.height);
  await page.waitForFunction(()=>document.querySelector('.chat-attachment-image img')?.naturalWidth>0,{timeout:10000});
  assert.equal(await page.$eval('.chat-attachment-image img',e=>e.naturalWidth),pasted.width);assert.equal(await page.$eval('#chat-error',e=>e.textContent),'');assert.equal(await page.$('.chat-attachment-image photo'),null);
  // Choosing images attaches them the same way; removing one before sending removes it from the project.
  await pickImage('#chat-image-file','IMG_0002.png',png(640,480),'image/png');
  await page.waitForFunction(()=>document.querySelectorAll('.chat-attachment-image').length===2,{timeout:10000});
  const second=app.store.chatImages(b.id).find(i=>i.name==='IMG_0002.png');assert.equal(second.width,640);
  await click(`[data-chat-detach-image="${second.id}"]`);await page.waitForFunction(()=>document.querySelectorAll('.chat-attachment-image').length===1);
  for(const until=Date.now()+10000;app.store.chatImages(b.id).some(i=>i.id===second.id)&&Date.now()<until;)await new Promise(r=>setTimeout(r,20));
  assert.ok(!app.store.chatImages(b.id).some(i=>i.id===second.id));assert.equal(await page.evaluate(()=>document.activeElement?.id),'chat-attach-image-button');
  // Enter sends. The image goes just before the message text, and the text names it.
  let imagePayload=null;custom=payload=>{imagePayload=payload;return chatResponse('The photo shows the 2025 edition cited in the comment.');};
  await page.type('#chat-message','What edition does this plan review photo cite?');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('The photo shows the 2025 edition'),{timeout:10000});
  const latest=imagePayload.messages.at(-1).content;assert.equal(latest.at(-2).type,'image');assert.equal(latest.at(-2).source.media_type,'image/png');assert.equal(latest.at(-2).source.data,app.store.chatImage(b.id,pasted.id).bytes.toString('base64'));
  assert.match(latest.at(-1).text,/^Latest user message:\nWhat edition does this plan review photo cite\?\n\nImages I attached to this message/);assert.ok(latest.at(-1).text.endsWith(JSON.stringify([{name:'Plan review <photo>.png',width:pasted.width,height:pasted.height}])));
  assert.deepEqual(app.store.chatTurns(b.id).at(-1).images.map(i=>i.id),[pasted.id]);assert.equal(await page.$eval('#chat-message',e=>e.value),'');
  // Sending clears the composer; the sent message shows the image, which opens full size, and it survives a reload.
  assert.equal(await page.$('.chat-attachment-image'),null);assert.equal(await page.$$eval('.chat-turn-images img',i=>i.length),1);assert.equal(await page.$('#chat-history .chat-prose img'),null);
  await click('.chat-turn-images button');await page.waitForFunction(()=>document.querySelector('#image-dialog')?.open===true);assert.equal(await page.$eval('#image-dialog-caption',e=>e.textContent),'Plan review <photo>.png');assert.equal(await page.$eval('#image-dialog-img',e=>e.getAttribute('src')),`/api/projects/${b.id}/images/${pasted.id}`);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#image-dialog')?.open===false);
  await page.reload();await page.waitForSelector('.chat-turn-images img');assert.equal(await page.$eval('.chat-turn-images img',e=>e.getAttribute('src')),`/api/projects/${b.id}/images/${pasted.id}`);assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);custom=null;
  phase='chat panel';
  // The panel stays open while you read other tabs, minimizes to a launcher that reopens it,
  // expands and restores, can be dragged, keeps its place after a reload, and Escape minimizes it.
  await click('[data-tab=sources]');await page.waitForSelector('#source-S1');assert.equal(await page.$eval('#chat-dock',e=>e.hidden),false);assert.equal(await page.$('#main #chat-form'),null);
  await click('#chat-minimize');assert.equal(await page.$eval('#chat-dock',e=>e.hidden),true);assert.equal(await page.$eval('#chat-launcher',e=>e.hidden),false);assert.equal(await page.evaluate(()=>document.activeElement?.id),'chat-launcher');
  await click('#chat-launcher');assert.equal(await page.$eval('#chat-dock',e=>e.hidden),false);assert.equal(await page.evaluate(()=>document.activeElement?.id),'chat-message');assert.equal(await page.$eval('#chat-launcher',e=>e.hidden),true);
  await click('#chat-expand');assert.equal(await page.$eval('#chat-dock',e=>e.classList.contains('expanded')),true);assert.equal(await page.$eval('#chat-expand',e=>e.getAttribute('aria-pressed')),'true');
  await click('#chat-expand');assert.equal(await page.$eval('#chat-dock',e=>e.classList.contains('expanded')),false);
  const before=await page.$eval('#chat-dock',e=>e.getBoundingClientRect().left),box=await (await page.$('#chat-dock-head')).boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2-200,box.y+box.height/2-100,{steps:5});await page.mouse.up();
  const after=await page.$eval('#chat-dock',e=>e.getBoundingClientRect().left);assert.ok(after<before-150,`dragged from ${before} to ${after}`);
  await page.reload();await page.waitForSelector('#chat-dock:not([hidden]) #chat-message');assert.ok(Math.abs(await page.$eval('#chat-dock',e=>e.getBoundingClientRect().left)-after)<2);
  await page.focus('#chat-message');await page.keyboard.press('Escape');assert.equal(await page.$eval('#chat-dock',e=>e.hidden),true);await click('#chat-launcher');await page.waitForSelector('#chat-message');
  // A starter question fills the message box without sending.
  await click('#chat-minimize');await click(`[data-project="${a.id}"]`);await page.waitForFunction(()=>document.querySelector('#open-chat'));
  await click(`[data-project="${b.id}"]`);await click('#open-chat');await page.waitForFunction(()=>document.querySelector('.chat-heading-project')?.textContent.includes('BRAVO'));
  phase='desktop/mobile layout';await click('#chat-limits>summary');await page.type('#chat-message','Which missing details should I confirm with the owner?');await click('#chat-history .chat-citation summary');assert.equal(await page.$eval('#chat-history .chat-citation',e=>e.open),true);
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/project-chat-desktop.png',fullPage:true});await page.setViewport({width:390,height:844});await page.screenshot({path:'test-results/project-chat-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);console.log('Chat browser checks passed: required name, siloed drafts/history/replies, simultaneous project chats, source links, escaped content, reload, three reply depths including Economy payload and history reload, Economy decline retry on Standard, stop, stale-response protection, estimated costs without budgets, Markdown tables and lists, live draft and step, declined reply with retry on the other model, proposal cards applied only on Apply, a report note saved, shown on Overview and removed, Ask Atlas on a question card using the selected reply depth and Apply, a note applied from Ask Atlas leaving the asked question open, documents attached by choosing or dropping files (refused, removed and sent) and shown on the sent message, images pasted or chosen (refused, scaled, removed, sent before the message text, shown and opened full size), the floating panel (open across tabs, minimized, expanded, dragged, remembered, Escape), Chat with Atlas button, and desktop/mobile layout. No paid API calls.');
}catch(e){console.error('Failed during: '+phase);if(page){console.error(await page.evaluate(()=>document.body.innerText).catch(()=>''));await page.screenshot({path:'test-results/project-chat-failure.png',fullPage:true}).catch(()=>{});}throw e;}
finally{for(const release of releases)release();await browser?.close();await app?.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-chat-ui-')));rmSync(dir,{recursive:true,force:true});}
