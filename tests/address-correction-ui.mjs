// Optional local-browser regression: node tests/address-correction-ui.mjs. No paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { input,report,FakeProvider } from './fixtures.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-address-ui-')),corrected='200 Corrected Road, Revised Township, Test State 00001';
let app,browser;
try{
  app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});app.services.engine.tick=async()=>{};
  const s=app.store,p=s.create({...input,name:'Address <correction> project'});
  const finish=()=>{s.updateProject(p.id,{status:'complete',report:report()});for(const stage of s.stages(p.id))s.updateStage(p.id,stage.id,{status:'complete'});};finish();
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  console.log('New project form');await page.setViewport({width:1440,height:1000});await page.goto(app.url);await page.waitForSelector('#project-form');
  await page.click('details.extra>summary');
  assert.match(await page.$eval('label[for="site-description"]',e=>e.textContent),/optional/);
  assert.equal(await page.$eval('#site-description',e=>e.maxLength),500);
  console.log('Open correction dialog');await page.goto(app.url+'/#project='+p.id);await page.reload();await page.locator('#resume-research').click();await page.waitForSelector('#action-dialog[open]');
  assert.equal(await page.$eval('#resume-address',e=>e.value),input.address);assert.equal(await page.$eval('#resume-site',e=>e.value),'');
  console.log('Server validation');await page.$eval('#resume-address',e=>{e.value='Too few';});await page.locator('#action-submit').click();
  await page.waitForFunction(()=>document.querySelector('#action-error').textContent.includes('complete project address'));
  assert.equal(s.project(p.id).address,input.address);
  console.log('Submit correction');await page.$eval('#resume-address',e=>{e.value='';});await page.type('#resume-address',corrected);await page.type('#resume-site','APN 0123-456-789');
  await page.locator('#action-submit').click();await page.waitForFunction(()=>!document.querySelector('#action-dialog').open);
  await page.waitForFunction(text=>document.querySelector('.intro p')?.textContent===text,{},corrected);
  assert.match(await page.$eval('.intro',e=>e.textContent),/Parcel \/ site: APN 0123-456-789/);
  const saved=s.project(p.id);assert.equal(saved.address,corrected);assert.equal(saved.input.siteDescription,'APN 0123-456-789');
  assert.ok(s.stages(p.id).every(stage=>stage.status==='queued'));
  await page.locator('[data-tab="activity"]').click();await page.waitForFunction(()=>document.querySelector('.activity')?.textContent.includes('Project address changed from'));
  console.log('Mobile dialog');finish();await page.reload();await page.waitForSelector('#resume-research');await page.setViewport({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#resume-research').click();await page.waitForSelector('#action-dialog[open]');
  assert.equal(await page.$eval('#resume-address',e=>e.value),corrected);assert.equal(await page.$eval('#resume-site',e=>e.value),'APN 0123-456-789');
  assert.equal(await page.$eval('#action-dialog',e=>e.scrollWidth<=e.clientWidth),true);
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/address-correction-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Address correction browser checks passed: optional site field, prefilled dialog, server validation, correction, header, Activity and mobile layout.');
}finally{
  await browser?.close();await app?.close();
  assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-address-ui-')));rmSync(dir,{recursive:true,force:true});
}
