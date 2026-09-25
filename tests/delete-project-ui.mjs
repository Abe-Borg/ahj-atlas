// Browser regression using temporary projects and no paid API calls.
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { input,FakeProvider } from './fixtures.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-delete-ui-'));
let app,browser;
try{
  app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  const p=app.store.create({...input,name:'Delete <this> project'}),other=app.store.create({...input,name:'Keep this project'});
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  console.log('Browser ready');await page.setViewport({width:1440,height:1000});await page.goto(app.url+'/#project='+p.id);
  console.log('Open delete dialog');await page.locator('#delete-project').click();await page.waitForSelector('#action-dialog[open]');
  assert.match(await page.$eval('#action-content',e=>e.textContent),/Delete <this> project/);
  assert.equal(await page.$eval('#action-content',e=>e.querySelector('this')),null);
  await page.locator('#action-dialog .dialog-actions [data-close]').click();
  console.log('Project retained');assert.ok(app.store.project(p.id));
  const attempt=app.store.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:{},reserve:100000});
  console.log('Open delete dialog');await page.locator('#delete-project').click();console.log('Submit deletion');await page.locator('#action-submit').click();
  await page.waitForFunction(()=>document.querySelector('#action-error').textContent.includes('outstanding'));
  console.log('Project retained');assert.ok(app.store.project(p.id));
  app.store.updateAttempt(attempt.id,{state:'settled',applied:1});
  console.log('Submit deletion');await page.locator('#action-submit').click();await page.waitForSelector('#name');
  assert.equal(app.store.project(p.id),null);assert.ok(app.store.project(other.id));
  assert.equal(await page.$(`[data-project="${p.id}"]`),null);
  await page.reload();await page.waitForSelector('#name');
  assert.equal(await page.$eval('#project-count',e=>e.textContent),'1');
  await page.locator(`[data-project="${other.id}"]`).click();await page.waitForSelector('#delete-project');
  await page.setViewport({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  console.log('Open delete dialog');await page.locator('#delete-project').click();
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/delete-project-mobile.png',fullPage:true});
  console.log('Submit deletion');await page.locator('#action-submit').click();await page.waitForSelector('#name');
  assert.equal(await page.$eval('#project-count',e=>e.textContent),'0');
  assert.deepEqual(errors,[]);
  console.log('Delete browser checks passed: confirmation, cancel, escaped name, blocked active request, deletion, reload, last project, and mobile layout.');
}finally{
  await browser?.close();await app?.close();
  assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-delete-ui-')));rmSync(dir,{recursive:true,force:true});
}
