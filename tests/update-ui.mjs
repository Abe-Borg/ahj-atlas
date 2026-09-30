// Browser check for the installed-build update notice, manual check, download and install.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { createUpdateChecker } from '../desktop/update-check.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { FakeProvider } from './fixtures.mjs';

const root=mkdtempSync(path.join(os.tmpdir(),'ahj-update-ui-')),dataDir=path.join(root,'data');
mkdirSync(dataDir);
const name='AHJ-Atlas-1.5.3-Windows-x64-Setup.exe',installer=Buffer.from('synthetic installer '.repeat(20000)),sha=createHash('sha256').update(installer).digest('hex');
let app,browser,checks=0,release;
const launches=[],started=new Promise(resolve=>{release=resolve;});
try{
  const checker=createUpdateChecker({dataDir,downloadDir:path.join(root,'updates'),currentVersion:'1.5.2',launchInstaller:(file,args)=>launches.push({file,args}),fetchImpl:async url=>{
    if(url.startsWith('https://api.github.com/')){
      checks++;
      return {ok:true,status:200,json:async()=>({tag_name:'v1.5.3',draft:false,prerelease:false,assets:[
        {name,state:'uploaded',size:installer.length},
        {name:'SHA256SUMS.txt',state:'uploaded'},
      ]})};
    }
    if(url.endsWith('/SHA256SUMS.txt'))return {ok:true,status:200,text:async()=>`${sha}  ${name}\n`};
    // Hold the second half of the installer until the page has shown progress.
    return {ok:true,status:200,url:'https://release-assets.githubusercontent.com/synthetic',body:(async function*(){
      yield new Uint8Array(installer.subarray(0,installer.length/2));await started;yield new Uint8Array(installer.subarray(installer.length/2));
    })()};
  }});
  app=await createApp({dataDir,port:0,provider:new FakeProvider(),worker:false,updateChecker:checker});
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(app.url);
  await page.waitForFunction(()=>!document.querySelector('#update-banner').hidden);
  assert.match(await page.$eval('#update-banner-text',element=>element.textContent),/1\.5\.3 is available/);
  assert.equal(await page.$eval('#update-banner-link',element=>element.href),'https://github.com/Abe-Borg/ahj-atlas/releases/tag/v1.5.3');
  assert.equal(await page.$eval('#update-banner-action',element=>element.textContent),'Download update');
  await page.locator('#settings-top').click();
  await page.waitForSelector('#settings-dialog[open]');
  assert.equal(await page.$eval('#update-release-link',element=>element.hidden),false);
  await page.locator('#check-updates').click();
  await page.waitForFunction(()=>document.querySelector('#check-updates').textContent==='Check for updates'&&!document.querySelector('#check-updates').disabled);
  assert.equal(checks,2);
  await page.locator('#update-action').click();
  await page.waitForFunction(()=>/Downloading AHJ Atlas 1\.5\.3… 50%/.test(document.querySelector('#update-status').textContent));
  assert.equal(await page.$eval('#update-action',element=>element.disabled),true);
  release();
  await page.waitForFunction(()=>document.querySelector('#update-action').textContent==='Restart and install');
  assert.match(await page.$eval('#update-status',element=>element.textContent),/downloaded and verified/);
  await page.locator('#update-action').click();
  await page.waitForFunction(()=>/Installing AHJ Atlas 1\.5\.3/.test(document.querySelector('#update-banner-text').textContent));
  assert.deepEqual(launches.map(launch=>[path.basename(launch.file),launch.args]),[[name,['--updated','/S','--force-run']]]);
  assert.deepEqual(errors,[]);
  console.log('Update UI check passed: notice, manual check, verified download progress, and restart to install.');
}finally{
  release();
  await browser?.close();
  await app?.close();
  rmSync(root,{recursive:true,force:true});
}
