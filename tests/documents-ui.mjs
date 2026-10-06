// Browser regression for adding a document, using a temporary project and no paid API calls.
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.mjs';
import { browserPath } from '../lib/research-tools.mjs';
import { input,FakeProvider } from './fixtures.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-documents-ui-'));
let app,browser;
try{
  app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  const p=app.store.create({...input,name:'Documents project'});
  const letter='Fire <Marshal> letter.txt',word=path.join(dir,'notes.docx');
  writeFileSync(word,Buffer.from('PK\u0003\u0004word'));
  browser=await puppeteer.launch({executablePath:browserPath(),headless:true,pipe:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:1440,height:1000});await page.goto(app.url+'/#project='+p.id);
  await page.locator('[data-tab=sources]').click();await page.waitForSelector('#document-upload');
  // Submitting without a file explains what to do and sends nothing.
  await page.locator('#document-upload button[type=submit]').click();
  assert.equal(await page.$eval('#document-error',e=>e.textContent),'Choose a document to add.');
  // An unsupported file is refused with the server's explanation.
  await(await page.$('#document-file')).uploadFile(word);await page.locator('#document-upload button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#document-error')?.textContent.includes('Save other formats'));
  // A text file joins the register and appears as your document, with its name escaped.
  // Windows cannot store this name on disk, so the file is built in the page.
  await page.$eval('#document-file',(e,name)=>{const files=new DataTransfer();files.items.add(new File(['The county enforces the 2024 International Fire Code with local amendments.'],name,{type:'text/plain'}));e.files=files.files;},letter);
  await page.locator('#document-upload button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('.source-card')?.textContent.includes('your document'),{timeout:10000});
  const card=await page.$eval('.source-card',e=>({text:e.textContent,html:e.innerHTML}));
  assert.match(card.text,/Fire <Marshal> letter\.txt/);assert.ok(!card.html.includes('<marshal>'));assert.match(card.text,/Added by you to this project/);assert.match(card.text,/Read as evidence/);
  const source=app.store.sources(p.id).find(s=>s.kind==='upload');assert.equal(source.title,'Fire <Marshal> letter.txt');
  await page.setViewport({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/documents-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Document browser checks passed: empty submission, refused Word file, added text document, escaped name, source card and mobile layout. No paid API calls.');
}finally{
  await browser?.close();await app?.close();
  assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-documents-ui-')));rmSync(dir,{recursive:true,force:true});
}
