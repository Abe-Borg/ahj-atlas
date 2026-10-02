import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {createApp} from '../server.mjs';
import {browserPath} from '../lib/research-tools.mjs';
import {FakeProvider,input} from './fixtures.mjs';

const ADDRESS='500 Draft Street, Example City, Test State 00000';
const NAME='Draft electrical room';

test('a new project shows Not yet specified, keeps that use visible, and restores the draft',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-new-project-form-'));
  const app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  app.services.engine.tick=async()=>{};
  let browser;
  t.after(async()=>{await browser?.close();await app.close();rmSync(dir,{recursive:true,force:true});});
  const existing=app.store.create({...input,name:'Existing synthetic project'});
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true,args:process.platform==='linux'?['--no-sandbox']:[],env:{...process.env,XDG_CONFIG_HOME:path.join(dir,'config')}});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let decision='dismiss';
  const dialogs=[];
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());if(decision==='accept')await dialog.accept();else await dialog.dismiss();});
  await page.setViewport({width:1440,height:1000});
  await page.goto(app.url);
  await page.waitForSelector('#project-form');

  const selectedUse=()=>page.$eval('#selected-building-use',el=>{
    const name=document.querySelector('#name'),extra=document.querySelector('details.extra'),rect=el.getBoundingClientRect(),style=getComputedStyle(el);
    return {
      text:el.querySelector('strong').textContent,
      outside:!el.closest('details'),
      shown:rect.height>0&&style.display!=='none'&&style.visibility!=='hidden',
      afterName:Boolean(name&&(name.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)),
      beforeOptional:Boolean(extra&&(el.compareDocumentPosition(extra)&Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });

  assert.equal(await page.$eval('#occupancy',e=>e.value),'');
  assert.equal(await page.$eval('#occupancy option:checked',e=>e.textContent),'Not yet specified');
  assert.equal(await page.$eval('details.extra',e=>e.open),false);
  assert.ok((await page.$$eval('#occupancy option',o=>o.map(x=>x.textContent))).includes('Hyperscale data center'));
  let visible=await selectedUse();
  assert.equal(visible.text,'Not yet specified');
  assert.equal(visible.outside,true);
  assert.equal(visible.shown,true);
  assert.equal(visible.afterName,true);
  assert.equal(visible.beforeOptional,true);
  assert.equal(await page.$eval('#occupancy',e=>Boolean(e.closest('details.extra'))),true);

  await page.select('#discipline','Electrical');
  assert.equal(await page.$eval('#occupancy',e=>e.value),'');
  assert.equal((await selectedUse()).text,'Not yet specified');

  await page.click('details.extra>summary');
  await page.select('#occupancy','Hyperscale data center');
  assert.equal((await selectedUse()).text,'Hyperscale data center');
  await page.click('details.extra>summary');
  assert.equal(await page.$eval('details.extra',e=>e.open),false);
  visible=await selectedUse();
  assert.equal(visible.shown,true);
  assert.equal(visible.text,'Hyperscale data center');

  await page.type('#address',ADDRESS);
  await page.type('#name',NAME);
  await page.click('details.extra>summary');
  await page.select('#scope','New construction');
  await page.select('#occupancy','Office');
  await page.$eval('#permit-date',el=>{el.value='2026-11-02';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.$eval('#country',el=>{el.value='Canada';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.type('#site-description','APN 42');
  await page.type('#notes','Two generators');
  await page.click('input[name=mode][value=batch]');
  await page.click('details.extra>summary');
  assert.equal((await selectedUse()).text,'Office');
  assert.equal(await page.$eval('details.extra',e=>e.open),false);
  assert.deepEqual(dialogs,[]);

  await page.click(`[data-project="${existing.id}"]`);
  await page.waitForSelector('#project-name');
  assert.equal(await page.$('#project-form'),null);
  assert.deepEqual(dialogs,[]);
  await page.click('#new-project');
  await page.waitForSelector('#project-form');
  assert.deepEqual(dialogs,[]);
  assert.equal(await page.$eval('#address',e=>e.value),ADDRESS);
  assert.equal(await page.$eval('#name',e=>e.value),NAME);
  assert.equal(await page.$eval('#discipline',e=>e.value),'Electrical');
  assert.equal(await page.$eval('#occupancy',e=>e.value),'Office');
  assert.equal(await page.$eval('#scope',e=>e.value),'New construction');
  assert.equal(await page.$eval('#permit-date',e=>e.value),'2026-11-02');
  assert.equal(await page.$eval('#country',e=>e.value),'Canada');
  assert.equal(await page.$eval('#site-description',e=>e.value),'APN 42');
  assert.equal(await page.$eval('#notes',e=>e.value),'Two generators');
  assert.equal(await page.$eval('input[name=mode]:checked',e=>e.value),'batch');
  assert.equal(await page.$eval('details.extra',e=>e.open),false);
  visible=await selectedUse();
  assert.equal(visible.text,'Office');
  assert.equal(visible.shown,true);

  await page.click('details.extra>summary');
  await page.select('#occupancy','Other');
  await page.waitForSelector('#custom-occupancy:not([disabled])');
  await page.type('#custom-occupancy','Cold storage');
  assert.equal((await selectedUse()).text,'Cold storage');
  await page.click(`[data-project="${existing.id}"]`);
  await page.waitForSelector('#project-name');
  await page.click('#new-project');
  await page.waitForFunction(()=>document.querySelector('#custom-occupancy')?.value==='Cold storage');
  assert.equal(await page.$eval('#occupancy',e=>e.value),'Other');
  assert.equal(await page.$eval('#address',e=>e.value),ADDRESS);
  assert.equal(await page.$eval('details.extra',e=>e.open),true);
  assert.equal((await selectedUse()).text,'Cold storage');
  assert.deepEqual(dialogs,[]);

  decision='dismiss';
  const seen=dialogs.length;
  await page.click('#new-project');
  for(let i=0;i<40&&dialogs.length===seen;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(dialogs.length,seen+1);
  assert.match(dialogs.at(-1),/Discard this new project draft/);
  assert.equal(await page.$eval('#address',e=>e.value),ADDRESS);
  assert.equal(await page.$eval('#name',e=>e.value),NAME);
  assert.equal(await page.$eval('#custom-occupancy',e=>e.value),'Cold storage');

  decision='accept';
  await page.click('#new-project');
  await page.waitForFunction(()=>document.querySelector('#address')?.value===''&&document.querySelector('#occupancy')?.value==='');
  assert.match(dialogs.at(-1),/Discard this new project draft/);
  assert.equal((await selectedUse()).text,'Not yet specified');
  assert.equal(await page.$eval('#name',e=>e.value),'');
  assert.equal(await page.$eval('details.extra',e=>e.open),false);

  const before=dialogs.length;
  await page.type('#address','100 Blank Use Road, Example City, Test State 00000');
  await page.type('#name','Blank use electrical');
  await page.select('#discipline','Electrical');
  assert.equal(await page.$eval('#occupancy',e=>e.value),'');
  await page.click('#start-research');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-project] strong')].some(el=>el.textContent==='Blank use electrical'),{timeout:15000});
  const created=app.store.list().find(p=>p.name==='Blank use electrical');
  assert.equal(created.discipline,'Electrical');
  assert.equal(created.input.occupancy,'');
  assert.equal(dialogs.length,before);
  await page.click('#new-project');
  await page.waitForSelector('#project-form');
  assert.equal(dialogs.length,before);
  assert.equal(await page.$eval('#address',e=>e.value),'');
  assert.equal(await page.$eval('#name',e=>e.value),'');
  assert.equal((await selectedUse()).text,'Not yet specified');

  await page.type('#address','999 Reload Lane, Example City, Test State 00000');
  await page.reload();
  await page.waitForSelector('#project-form');
  assert.equal(await page.$eval('#address',e=>e.value),'');
  assert.deepEqual(errors,[]);
});
