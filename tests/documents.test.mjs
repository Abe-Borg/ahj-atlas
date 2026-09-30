import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createApp } from '../server.mjs';
import { LIMITS } from '../lib/config.mjs';
import { addDocument, documentName } from '../lib/documents.mjs';
import { evidencePackage } from '../lib/prompts.mjs';
import { initialChatEvidence } from '../lib/chat-citations.mjs';
import { input, ChatProvider } from './fixtures.mjs';

async function setup(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-documents-')),app=await createApp({dataDir:dir,port:0,provider:new ChatProvider(),worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-documents-')));rmSync(dir,{recursive:true,force:true});});
  const p=app.store.create({...input,name:'Documents project'}),{token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const upload=(body,{name='letter.txt',type='text/plain',auth=true,id=p.id}={})=>fetch(`${app.url}/api/projects/${id}/documents`,{method:'POST',headers:{'Content-Type':type,'X-File-Name':encodeURIComponent(name),...(auth?{'X-App-Token':token}:{})},body});
  return {app,p,upload,tools:app.services.chat.tools};
}
const pdf=text=>new Promise(resolve=>{const doc=new PDFDocument(),chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));if(text)doc.text(text);else doc.rect(72,72,200,120).fill('#333');doc.end();});

test('a document you add becomes a retrieved, user-provided source that chat and the report evidence include',async t=>{
  const {app,p,upload}=await setup(t),s=app.store;
  const letter='Fire Marshal letter: the county enforces the 2024 International Fire Code with Ordinance 2026-14 amendments for this site.';
  const response=await upload(letter,{name:'C:\\Users\\me\\Fire Marshal letter.txt'});assert.equal(response.status,201);
  const {source}=await response.json();assert.equal(source.title,'Fire Marshal letter.txt');assert.equal(source.kind,'upload');
  const saved=s.sources(p.id).find(x=>x.id===source.id);assert.equal(saved.read_full,true);assert.equal(saved.text,letter);assert.match(saved.url,/^upload:[0-9a-f]{16}\//);
  assert.ok(s.events(p.id).some(e=>e.kind==='source'&&e.message.startsWith(`Added your document “Fire Marshal letter.txt” as ${source.id}`)));
  // Adding the same file again updates the same source.
  assert.equal((await(await upload(letter,{name:'Fire Marshal letter.txt'})).json()).source.id,source.id);assert.equal(s.sources(p.id).filter(x=>x.kind==='upload').length,1);
  // The report's evidence and chat's first message carry it; the prompts say it is user-provided.
  assert.ok(evidencePackage(s,s.project(p.id)).sources.some(x=>x.id===source.id&&x.kind==='upload'&&x.text.includes('Ordinance 2026-14')));
  assert.ok(initialChatEvidence(s,p.id).some(b=>b.title===`${source.id}: Fire Marshal letter.txt`));
  const detail=await(await fetch(`${app.url}/api/projects/${p.id}`)).json();assert.ok(detail.sources.some(x=>x.id===source.id));
});

test('PDF and HTML documents are read as text, and unreadable or unsupported files are refused',async t=>{
  const {app,p,upload,tools}=await setup(t),s=app.store;
  const created=await upload(await pdf('Delegated plan review: the county reviews commercial sprinkler plans.'),{name:'Delegation.pdf',type:'application/pdf'});assert.equal(created.status,201);
  const pdfSource=s.sources(p.id).find(x=>x.title==='Delegation.pdf');assert.match(pdfSource.text,/\[PDF page 1\]/);assert.match(pdfSource.text,/reviews commercial sprinkler plans/);
  // A scanned PDF has no text layer: it is refused rather than saved as page labels.
  const scanned=await upload(await pdf(''),{name:'Scanned letter.pdf',type:'application/pdf'});assert.equal(scanned.status,400);assert.match((await scanned.json()).error,/text recognition \(OCR\)/);assert.ok(!s.sources(p.id).some(x=>x.title==='Scanned letter.pdf'));
  await upload('<html><body><table><tr><td>Permit</td><td>$250</td></tr></table></body></html>',{name:'fees.html',type:'text/html'});
  assert.match(s.sources(p.id).find(x=>x.title==='fees.html').text,/Permit \| \$250/);
  for(const [body,options,pattern] of [[Buffer.from('PK\u0003\u0004'),{name:'letter.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},/Save other formats, such as Word, as PDF/],['',{},/Choose a document/],['   ',{},/No text could be read/]]){
    const response=await upload(body,options);assert.equal(response.status,400);assert.match((await response.json()).error,pattern);
  }
  assert.equal((await upload('text',{auth:false})).status,403);
  assert.equal((await upload('text',{id:'00000000-0000-0000-0000-000000000000'})).status,400);
  await assert.rejects(addDocument(s,tools,p.id,{name:'big.txt',type:'text/plain',buffer:Buffer.alloc(LIMITS.documentBytes+1,97)}),/50 MB or less/);
  assert.equal(documentName('..\\..\\evil\u0007name.pdf'),'evilname.pdf');assert.equal(documentName(''),'Document');
});
