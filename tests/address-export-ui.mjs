// Browser regression for Export addresses, run by npm run test:ui. Temporary projects; no paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { input,FakeProvider } from './fixtures.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-address-export-ui-')),downloads=path.join(dir,'downloads');mkdirSync(downloads);
let app,browser;
const count=page=>page.$eval('#address-count',e=>e.textContent);
const visible=page=>page.$$eval('#address-projects label:not([hidden]) strong',rows=>rows.map(r=>r.textContent));
async function downloaded(){for(let n=0;n<200;n++){const file=readdirSync(downloads).find(f=>f.endsWith('.csv'));if(file)return path.join(downloads,file);await new Promise(r=>setTimeout(r,25));}assert.fail('The CSV was not downloaded.');}
try{
  app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});app.services.engine.tick=async()=>{};
  // The sidebar lists newest first: Dallas, Montréal, Phoenix.
  const phoenix=app.store.create({...input,name:'Phoenix <b>PHX-10</b>',address:'4000 Example Pkwy, Phoenix, AZ 85043',siteDescription:'APN 300-12-345'});
  const montreal=app.store.create({...input,name:'Montréal campus',address:'1000 Rue Example, Montréal, QC H3B 1A1',country:'Canada',discipline:'Mechanical'});
  const dallas=app.store.create({...input,name:'Dallas DFW-3',address:'1 Example Rd, Dallas, TX 75201'});
  // Give fixtures distinct creation times so their order does not depend on clock resolution.
  for(const [project,created] of [[phoenix,'2026-01-01T00:00:00.000Z'],[montreal,'2026-01-01T00:00:01.000Z'],[dallas,'2026-01-01T00:00:02.000Z']]) app.store.db.prepare('UPDATE projects SET created=? WHERE id=?').run(created,project.id);
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const cdp=await browser.target().createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:1440,height:1000});await page.goto(app.url);await page.waitForSelector('#project-form');

  console.log('Open with every project chosen');
  assert.equal(await page.$eval('#export-addresses',e=>e.hidden),false);
  await page.locator('#export-addresses').click();await page.waitForSelector('#addresses-dialog[open]');
  assert.deepEqual(await visible(page),['Dallas DFW-3','Montréal campus','Phoenix <b>PHX-10</b>']);
  assert.equal(await page.$('#address-projects b'),null);
  assert.equal(await count(page),'3 of 3 selected');
  assert.deepEqual(await page.$eval('#addresses-submit',e=>[e.textContent,e.disabled]),['Export 3 addresses',false]);
  assert.match(await page.$eval('#address-projects',e=>e.textContent),/1000 Rue Example, Montréal, QC H3B 1A1.*Mechanical · Canada/);

  console.log('Filter hides rows and keeps their choice');
  await page.type('#address-filter','montr');await page.keyboard.press('Enter');
  // Export rereads the project list before it downloads, so give a stray submit time to land.
  await new Promise(r=>setTimeout(r,500));
  assert.equal(await page.$eval('#addresses-dialog',e=>e.open),true);assert.deepEqual(readdirSync(downloads),[]);
  assert.deepEqual(await visible(page),['Montréal campus']);
  assert.equal(await count(page),'3 of 3 selected (2 hidden by the filter)');
  assert.deepEqual(await page.$$eval('.address-select-bar button',b=>b.map(x=>x.textContent)),['Select shown','Clear shown']);
  await page.locator('#address-clear').click();
  assert.equal(await count(page),'2 of 3 selected (2 hidden by the filter)');
  await page.$eval('#address-filter',e=>{e.value='no such project';e.dispatchEvent(new Event('input'));});
  assert.equal(await page.$eval('#address-none',e=>e.hidden),false);
  await page.$eval('#address-filter',e=>{e.value='';e.dispatchEvent(new Event('input'));});
  assert.equal(await page.$eval('#address-none',e=>e.hidden),true);
  assert.equal((await visible(page)).length,3);

  console.log('Clear all, then pick two');
  await page.locator('#address-clear').click();
  assert.equal(await count(page),'0 of 3 selected');assert.equal(await page.$eval('#addresses-submit',e=>e.disabled),true);
  await page.click(`#address-projects input[value="${phoenix.id}"]`);await page.click(`#address-projects input[value="${montreal.id}"]`);
  assert.deepEqual(await page.$eval('#addresses-submit',e=>[e.textContent,e.disabled]),['Export 2 addresses',false]);

  console.log('Export the chosen projects as CSV');
  await page.locator('#addresses-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#addresses-dialog').open&&document.querySelector('#toast').textContent==='Exporting 2 project addresses.');
  const file=await downloaded();
  assert.match(path.basename(file),/^AHJ Atlas project addresses \d{4}-\d{2}-\d{2}\.csv$/);
  assert.deepEqual(readFileSync(file,'utf8').replace(/^﻿/,'').split('\r\n'),['Project,Address,Country,Parcel / site description,Discipline',
    'Montréal campus,"1000 Rue Example, Montréal, QC H3B 1A1",Canada,,Mechanical',
    'Phoenix <b>PHX-10</b>,"4000 Example Pkwy, Phoenix, AZ 85043",United States,APN 300-12-345,Fire protection','']);

  console.log('A project deleted while the list is open is removed and nothing is exported');
  await page.locator('#export-addresses').click();await page.waitForSelector('#addresses-dialog[open]');
  assert.equal(await page.$eval('[name=format][value=csv]',e=>e.checked),true);
  await page.click('[name=format][value=xlsx]');
  app.store.deleteProject(dallas.id);
  await page.locator('#addresses-submit').click();
  await page.waitForFunction(()=>document.querySelector('#addresses-error').textContent.includes('deleted'));
  assert.equal(await page.$eval('#addresses-dialog',e=>e.open),true);
  assert.equal(await page.$(`#address-projects input[value="${dallas.id}"]`),null);
  assert.equal(await count(page),'2 of 2 selected');
  assert.equal(readdirSync(downloads).length,1);

  console.log('Mobile layout');
  await page.setViewport({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.$eval('#addresses-dialog',e=>e.scrollWidth<=e.clientWidth),true);
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/address-export-mobile.png'});
  await page.locator('#addresses-dialog .dialog-actions [data-close]').click();
  assert.equal(await page.$eval('#export-addresses',e=>e.getBoundingClientRect().width>0),true);

  console.log('Hidden when there are no projects');
  for(const p of app.store.list())app.store.deleteProject(p.id);
  await page.reload();await page.waitForSelector('#project-form');
  assert.equal(await page.$eval('#export-addresses',e=>e.hidden),true);
  assert.deepEqual(errors,[]);
  console.log('Export addresses browser checks passed: default selection, escaped names, filter (Enter does not export), select and clear, CSV download in sidebar order, deleted project, mobile layout and empty workspace.');
}finally{
  await browser?.close();await app?.close();
  assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-address-export-ui-')));rmSync(dir,{recursive:true,force:true});
}
