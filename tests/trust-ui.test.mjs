import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {browserPath} from '../lib/research-tools.mjs';
import {createApp} from '../server.mjs';

test('trust dialogs browser test: wiring, one Escape, focus, rail and themes',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'atlas-trust-ui-'));
  const app=await createApp({dataDir:path.join(dir,'data'),port:0,worker:false,vaultDir:path.join(dir,'vault')});
  let browser;
  t.after(async()=>{await browser?.close();await app.close();rmSync(dir,{recursive:true,force:true});});
  // Disposable, synthetic test page only. Some CI containers cannot provide the
  // Chromium SUID/user-namespace sandbox. This does not change production launch
  // flags in ResearchTools.render or Electron's sandbox:true configuration.
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true,
    args:process.platform==='linux'?['--no-sandbox']:[],env:{...process.env,XDG_CONFIG_HOME:path.join(dir,'config')}});
  const page=await browser.newPage(),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
  page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(app.url+'/')){external.push(request.url());void request.abort();}else void request.continue();});
  await page.setViewport({width:1440,height:1000});await page.goto(app.url+'/help');
  await page.waitForSelector('[data-open-trust]');await page.click('[data-open-trust]');
  assert.equal(await page.$eval('#trust-topic',e=>e.open),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'trust-topic-title');
  assert.equal(await page.$$eval('#trust-topic .trust-points article',els=>els.length),7);
  const words=await page.$eval('#trust-topic',e=>e.textContent.trim().split(/\s+/).length);assert.ok(words<450,`Short topic has ${words} words`);
  await page.click('#trust-show-dossier');
  assert.equal(await page.$eval('#trust-topic',e=>e.open),true);assert.equal(await page.$eval('#trust-dossier',e=>e.open),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'trust-dossier-title');
  assert.equal(await page.$$eval('.trust-runtime',els=>els.length),32);
  assert.ok(await page.$$eval('.trust-runtime',els=>els.every(e=>e.querySelectorAll('dt').length===5)));
  assert.equal(await page.$eval('.trust-contents',e=>getComputedStyle(e).position),'sticky');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Close dossier');
  await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Back to Why trust it?');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Close dossier');
  await page.click('.trust-contents a[href="#trust-tools"]');
  assert.equal(await page.$eval('.trust-contents [aria-current]',e=>e.hash),'#trust-tools');
  await page.$eval('#trust-dossier',e=>{const s=e.querySelector('#trust-money');e.scrollTop+=s.getBoundingClientRect().top-e.getBoundingClientRect().top-24;});
  await page.waitForFunction(()=>document.querySelector('.trust-contents [aria-current]')?.hash==='#trust-money');
  await page.$eval('[data-open-trust]',e=>e.focus());assert.ok(await page.evaluate(()=>document.activeElement.closest('#trust-dossier')!==null));
  await page.$eval('#trust-dossier',e=>e.scrollTop=0);await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#trust-dossier',e=>e.open),false);assert.equal(await page.$eval('#trust-topic',e=>e.open),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'trust-show-dossier');
  await page.keyboard.press('Escape');assert.equal(await page.$eval('#trust-topic',e=>e.open),false);
  assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-open-trust')),true);
  // Close button and bottom Back both return to the still-open first dialog.
  await page.click('[data-open-trust]');await page.click('#trust-show-dossier');
  await page.click('#trust-dossier [aria-label="Close dossier"]');assert.equal(await page.evaluate(()=>document.activeElement.id),'trust-show-dossier');
  await page.click('#trust-show-dossier');await page.$eval('#trust-dossier',e=>e.scrollTop=e.scrollHeight);
  await page.click('#trust-dossier .trust-body > [data-trust-close]');assert.equal(await page.$eval('#trust-topic',e=>e.open),true);
  await page.click('#trust-show-dossier');
  mkdirSync('test-results',{recursive:true});
  for(const theme of ['light','dark']){
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);
    await page.$eval('#trust-dossier',e=>e.scrollTop=0);
    const bg=await page.$eval('#trust-dossier',e=>getComputedStyle(e).backgroundColor);
    assert.equal(bg,theme==='dark'?'rgb(21, 43, 55)':'rgb(255, 255, 255)');
    await page.screenshot({path:`test-results/trust-${theme}.png`});
    await page.setViewport({width:390,height:844});
    const overflow=await page.$eval('#trust-dossier',e=>e.scrollWidth-e.clientWidth);assert.ok(overflow<=1,`${theme} narrow overflow: ${overflow}`);
    assert.equal(await page.$eval('.trust-contents',e=>getComputedStyle(e).position),'static');
    assert.equal(await page.$eval('.trust-flow-narrow',e=>getComputedStyle(e).display),'block');
    assert.equal(await page.$eval('.trust-flow-wide',e=>getComputedStyle(e).display),'none');
    await page.screenshot({path:`test-results/trust-${theme}-narrow.png`});
    await page.setViewport({width:1440,height:1000});
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  await page.goto(app.url+'/help#why-trust');await page.waitForSelector('#trust-topic[open]');
  await page.goto(app.url);await page.waitForSelector('#name');await page.click('[data-open-trust]');await page.click('#trust-show-dossier');
  assert.equal(await page.$eval('#trust-dossier',e=>e.open),true);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
