// Browser check for the installed-build update notice and manual check.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { createUpdateChecker } from '../desktop/update-check.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { FakeProvider } from './fixtures.mjs';

const dataDir=mkdtempSync(path.join(os.tmpdir(),'ahj-update-ui-'));
let app,browser,calls=0;
try{
  const checker=createUpdateChecker({dataDir,currentVersion:'1.5.2',fetchImpl:async()=>{
    calls++;
    return {ok:true,status:200,json:async()=>({tag_name:'v1.5.3',draft:false,prerelease:false,assets:[
      {name:'AHJ-Atlas-1.5.3-Windows-x64-Setup.exe',state:'uploaded'},
      {name:'SHA256SUMS.txt',state:'uploaded'},
    ]})};
  }});
  app=await createApp({dataDir,port:0,provider:new FakeProvider(),worker:false,updateChecker:checker});
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(app.url);
  await page.waitForFunction(()=>!document.querySelector('#update-banner').hidden);
  assert.match(await page.$eval('#update-banner',element=>element.textContent),/1\.5\.3 is available/);
  assert.equal(await page.$eval('#update-banner-link',element=>element.href),'https://github.com/Abe-Borg/ahj-atlas/releases/tag/v1.5.3');
  await page.locator('#settings-top').click();
  await page.waitForSelector('#settings-dialog[open]');
  assert.equal(await page.$eval('#update-release-link',element=>element.hidden),false);
  await page.locator('#check-updates').click();
  await page.waitForFunction(()=>document.querySelector('#check-updates').textContent==='Check for updates'&&!document.querySelector('#check-updates').disabled);
  assert.equal(calls,2);
  assert.deepEqual(errors,[]);
  console.log('Update UI check passed: daily notice, release link, and manual check.');
}finally{
  await browser?.close();
  await app?.close();
  rmSync(dataDir,{recursive:true,force:true});
}
