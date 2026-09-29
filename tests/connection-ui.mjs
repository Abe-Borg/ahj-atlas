// Browser regression for the sidebar connection button. Uses a stubbed Anthropic
// Models API, so no key or paid request is needed.
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { browserPath } from '../lib/research-tools.mjs';
const realFetch=globalThis.fetch;let reply='rejected';
globalThis.fetch=async(url,options)=>{
  if(!String(url).startsWith('https://api.anthropic.com'))return realFetch(url,options);
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  return reply==='rejected'?json({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}},401):json({data:[],has_more:false});
};
const { createApp }=await import('../server.mjs');
const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-conn-ui-'));let app,browser;
const state=async page=>page.evaluate(()=>({label:document.querySelector('#connection-label').textContent,title:document.querySelector('#open-settings').title,cls:document.querySelector('.connection-light').className}));
try{
  app=await createApp({dataDir:dir,port:0,worker:false,vaultDir:path.join(dir,'vault')});
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1280,height:800});
  await page.goto(app.url);await page.waitForSelector('#name');
  let s=await state(page);console.log('no key:',s);assert.equal(s.label,'Claude disconnected');assert.match(s.cls,/\boff\b/);
  // A remembered key that Anthropic rejects.
  app.services.vault.key='sk-ant-revoked-key-000000';
  await page.reload();await page.waitForFunction(()=>document.querySelector('#connection-label').textContent==='Claude disconnected');
  s=await state(page);console.log('bad key:',s);assert.match(s.title,/not accepted/);assert.match(s.cls,/\boff\b/);
  await page.locator('#open-settings').click();await page.waitForSelector('#settings-dialog[open]');
  const note=await page.$eval('#connection-note',e=>({hidden:e.hidden,text:e.textContent,cls:e.className}));console.log('dialog note:',note,await page.$eval('#api-key',e=>e.placeholder));
  assert.equal(note.hidden,false);assert.match(note.text,/not accepted/);
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/connection-rejected-key.png'});
  await page.locator('#settings-dialog [data-close]').click();
  // Connect a valid key through the dialog.
  reply='ok';await page.locator('#open-settings').click();await page.waitForSelector('#settings-dialog[open]');
  await page.type('#api-key','sk-ant-valid-key-0000000000');await page.locator('#save-settings').click();
  await page.waitForFunction(()=>document.querySelector('#connection-label').textContent==='Claude connected');
  s=await state(page);console.log('valid key:',s);assert.match(s.cls,/\bon\b/);
  // Key revoked mid-session: the next real request's 401 flips the button within the 5 s poll.
  reply='rejected';await assert.rejects(app.services.engine.provider.check());
  await page.waitForFunction(()=>document.querySelector('#connection-label').textContent==='Claude disconnected',{timeout:8000});
  s=await state(page);console.log('revoked:',s);
  assert.deepEqual(errors,[]);console.log('UI connection check passed');
}finally{await browser?.close();await app?.close();rmSync(dir,{recursive:true,force:true});}
