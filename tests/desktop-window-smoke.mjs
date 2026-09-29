// Run while `npm run desktop -- --fake-provider --remote-debugging-port=9223`
// is open with a disposable ATLAS_DESKTOP_DATA_DIR. No paid provider requests.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { VERSION } from '../lib/config.mjs';

const port=Number(process.env.ATLAS_DESKTOP_DEBUG_PORT||9223);
const browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`});
try{
  const page=(await browser.pages()).find(p=>/^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()));
  assert.ok(page,'Electron app page is open');
  await page.goto(new URL('/',page.url()).href);
  await page.waitForSelector('#name');
  const renderer=await page.evaluate(async()=>({node:typeof process,require:typeof require,bootstrap:await(await fetch('/api/bootstrap')).json()}));
  assert.equal(renderer.node,'undefined');assert.equal(renderer.require,'undefined');
  assert.equal(renderer.bootstrap.application,'AHJ Atlas');
  assert.equal(renderer.bootstrap.version,VERSION);
  assert.equal(renderer.bootstrap.keyConfigured,true);
  assert.equal(renderer.bootstrap.browserAvailable,true);
  const diagnostics=await page.evaluate(async token=>{
    const response=await fetch('/api/diagnostics',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:'{}'});
    return response.json();
  },renderer.bootstrap.token);
  assert.equal(diagnostics.application.version,VERSION);

  await page.click('#settings-top');
  assert.equal(await page.$eval('#settings-dialog',element=>element.open),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#settings-dialog',element=>element.open),false);
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(()=>Boolean(document.activeElement)));
  await page.click('#open-about');
  assert.equal(await page.$eval('#about-dialog',element=>element.open),true);
  assert.equal(await page.$eval('#about-version',element=>element.textContent),VERSION);
  assert.match(await page.$eval('#about-dialog',element=>element.textContent),/Copyright © 2026 Abraham Borg\./);
  await page.click('#about-terms summary');
  await page.waitForFunction(()=>document.querySelector('#about-license-text')?.textContent.startsWith('AHJ Atlas Software License'));
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#about-dialog',element=>element.open),false);

  const seeded=await page.$$eval('[data-project]',els=>els.map(el=>({id:el.dataset.project,name:el.textContent})).find(p=>p.name.includes('Electron synthetic report')));
  assert.ok(seeded);
  assert.match(seeded.name,/Electron synthetic report/);
  await page.click(`[data-project="${seeded.id}"]`);
  await page.waitForFunction(()=>document.querySelector('#report-content')?.textContent.includes('Synthetic workflow verification'));
  await page.click('[data-tab=codes]');
  assert.match(await page.$eval('#report-content',el=>el.textContent),/Fixture Building Code/);
  await page.click('[data-tab=sources]');
  await page.waitForSelector('#report-content a[href^="https://"]');
  const appPage=page.url();
  await page.click('#report-content a[href^="https://"]');
  assert.equal(page.url(),appPage);

  await page.click('[data-tab=chat]');
  await page.waitForSelector('#chat-message');
  await page.type('#chat-message','Summarize this synthetic fixture.');
  await page.click('#chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('#chat-history')?.textContent.includes('Synthetic desktop chat reply'),{timeout:15000});
  await page.reload();
  await page.waitForSelector(`[data-project="${seeded.id}"]`);
  await page.click(`[data-project="${seeded.id}"]`);
  await page.waitForSelector('[data-tab=chat]');
  await page.click('[data-tab=chat]');
  assert.match(await page.$eval('#chat-history',el=>el.textContent),/Synthetic desktop chat reply/);

  await page.click('#new-project');
  await page.type('#name','Desktop created synthetic project');
  await page.type('#address','100 Test Avenue, Example District, Test State 00000');
  await page.select('#discipline','Fire protection');
  await page.click('#start-research');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-project]')].some(el=>el.textContent.includes('Desktop created synthetic project')),{timeout:15000});
  const created=await page.$eval('[data-project]:first-child',el=>({id:el.dataset.project,name:el.textContent}));
  assert.match(created.name,/Desktop created synthetic project/);
  await page.reload();
  await page.waitForSelector(`[data-project="${created.id}"]`);
  await page.click(`[data-project="${created.id}"]`);
  await page.waitForFunction(()=>document.querySelector('#main')?.textContent.includes('Desktop created synthetic project')&&document.querySelector('#report-content'));

  const exports=await page.evaluate(async id=>{
    const result={};
    for(const format of ['pdf','xlsx','json']){
      const response=await fetch(`/api/projects/${id}/export?format=${format}`);
      const bytes=new Uint8Array(await response.arrayBuffer());
      result[format]={status:response.status,type:response.headers.get('content-type'),length:bytes.length,magic:Array.from(bytes.slice(0,5)),json:format==='json'?JSON.parse(new TextDecoder().decode(bytes)).report?.summary:null};
    }
    return result;
  },seeded.id);
  for(const format of ['pdf','xlsx','json'])assert.equal(exports[format].status,200);
  assert.deepEqual(exports.pdf.magic,[37,80,68,70,45]);
  assert.deepEqual(exports.xlsx.magic.slice(0,2),[80,75]);
  assert.match(exports.json.json,/Synthetic workflow verification/);
  await page.setViewport({width:1000,height:800});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.setViewport({width:390,height:780});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.setViewport({width:1280,height:900});

  await page.click('footer a[href="/help"]');
  await page.waitForFunction(()=>location.pathname==='/help');
  assert.match(await page.$eval('main',element=>element.textContent),/From address to evidence/);
  await page.click('a[href^="https://platform.claude.com"]');
  assert.equal(new URL(page.url()).pathname,'/help');
  await page.evaluate(()=>{const link=document.createElement('a');link.href='file:///C:/Windows/win.ini';link.click();});
  assert.equal(new URL(page.url()).pathname,'/help');
  console.log(JSON.stringify({renderer:'sandboxed',version:VERSION,bootstrap:'passed',diagnostics:'passed',report:'rendered',chat:'sent and reloaded',project:'created and reloaded',keyboardDialog:'passed',about:'version, copyright and license shown',responsive:'1000px and 390px',internalHelp:'same window',externalAndFileNavigation:'app page retained',exports},null,2));
}finally{browser.disconnect();}
