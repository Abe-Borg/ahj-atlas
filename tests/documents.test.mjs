import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
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
// A Word file as Word writes one: a letterhead in the header, a tab stop, a tracked deletion, a
// tracked move, a field code, a table and a drawing whose text also has a fallback copy.
const W='xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const docx=()=>{const zip=new JSZip();
  zip.file('word/document.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>`+
    '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Sprinklers follow NFPA 13 &amp; the 2024 IFC </w:t></w:r><w:del><w:r><w:delText>2021 IFC</w:delText></w:r></w:del><w:r><w:tab/><w:t>Section 903.2</w:t><w:br/><w:t>Second line</w:t></w:r></w:p>'+
    '<w:p><w:pPr><w:rPr><w:moveFrom w:id="1" w:author="Reviewer" w:date="2026-10-30T00:00:00Z"/></w:rPr></w:pPr><w:moveFrom w:id="2" w:author="Reviewer" w:date="2026-10-30T00:00:00Z"><w:r><w:t xml:space="preserve">Moved clause </w:t></w:r></w:moveFrom><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "https://example.com"</w:instrText></w:r><w:r><w:t>Fee schedule</w:t></w:r></w:p>'+
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Permit</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$250</w:t></w:r></w:p><w:p><w:r><w:t>per riser</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'+
    '<w:p><w:moveTo w:id="3" w:author="Reviewer" w:date="2026-10-30T00:00:00Z"><w:r><w:t>Moved clause</w:t></w:r></w:moveTo></w:p>'+
    '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent><w:p><w:r><w:t>Callout text</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>Callout text</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>'+
    '</w:body></w:document>');
  for(const n of [1,2])zip.file(`word/header${n}.xml`,`<w:hdr ${W}><w:p><w:r><w:t>Village of Hartland Fire Department</w:t></w:r></w:p></w:hdr>`);
  return zip.generateAsync({type:'nodebuffer'});};
const xlsx=async()=>{const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Fees'),hidden=book.addWorksheet('Lookup');
  sheet.addRow(['Item','Amount','Due']);sheet.addRow(['Sprinkler permit',250,new Date(Date.UTC(2026,9,30))]);sheet.addRow([]);sheet.addRow(['Total',{formula:'B2',result:250},{richText:[{text:'per '},{text:'riser'}]}]);
  sheet.mergeCells('A6:C6');sheet.getCell('A6').value='Merged note';hidden.state='hidden';hidden.addRow(['Hidden rate']);
  // Number formats carry meaning: a percentage, a unit, a currency and negatives in parentheses.
  for(const [row,cells] of [[7,[['Surcharge'],[0.05,'0%'],[52.345,'0.0 "psi"']]],[8,[['Credit'],[-1500,'#,##0;(#,##0)'],[1234.5,'"$"#,##0.00']]]])cells.forEach(([value,numFmt],i)=>{const cell=sheet.getCell(row,i+1);cell.value=value;if(numFmt)cell.numFmt=numFmt;});
  return Buffer.from(await book.xlsx.writeBuffer());};

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

test('PDF, Word, Excel and CSV documents are read as text, and unreadable or unsupported files are refused',async t=>{
  const {app,p,upload,tools}=await setup(t),s=app.store,text=title=>s.sources(p.id).find(x=>x.title===title)?.text;
  const created=await upload(await pdf('Delegated plan review: the county reviews commercial sprinkler plans.'),{name:'Delegation.pdf',type:'application/pdf'});assert.equal(created.status,201);
  const pdfSource=s.sources(p.id).find(x=>x.title==='Delegation.pdf');assert.match(pdfSource.text,/\[PDF page 1\]/);assert.match(pdfSource.text,/reviews commercial sprinkler plans/);
  // A scanned PDF has no text layer: it is refused rather than saved as page labels.
  const scanned=await upload(await pdf(''),{name:'Scanned letter.pdf',type:'application/pdf'});assert.equal(scanned.status,400);assert.match((await scanned.json()).error,/text recognition \(OCR\)/);assert.ok(!s.sources(p.id).some(x=>x.title==='Scanned letter.pdf'));
  // Word keeps the letterhead once, the body's text, tabs, line breaks and table cells, and leaves out
  // tab stops, the deleted text, a moved passage's old place, the field code and the drawing text's fallback copy.
  assert.equal((await upload(await docx(),{name:'Plan review.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})).status,201);
  assert.equal(text('Plan review.docx'),'Village of Hartland Fire Department\n\nSprinklers follow NFPA 13 & the 2024 IFC \tSection 903.2\nSecond line\nFee schedule\nPermit | $250 per riser\nMoved clause\nCallout text');
  // Excel keeps each sheet's rows, formula results, rich text, dates and number formats, a merged range once, and labels a hidden sheet.
  assert.equal((await upload(await xlsx(),{name:'Fees.xlsx',type:''})).status,201);
  assert.equal(text('Fees.xlsx'),'Sheet: Fees\nItem | Amount | Due\nSprinkler permit | 250 | 2026-10-30\nTotal | 250 | per riser\nMerged note\nSurcharge | 5% | 52.3 psi\nCredit | (1,500) | $1,234.50\n\nSheet: Lookup (hidden)\nHidden rate');
  // Excel's CSV UTF-8 starts with a byte-order mark, and Windows may label the file as an Excel type.
  assert.equal((await upload('﻿Fee,Amount\r\nPermit,250\r\n',{name:'fees.csv',type:'application/vnd.ms-excel'})).status,201);assert.equal(text('fees.csv'),'Fee,Amount\nPermit,250\n');
  assert.ok(s.events(p.id).some(e=>/Added your document “Plan review\.docx” as S\d+ \(Word\)/.test(e.message)));assert.ok(s.events(p.id).some(e=>/“Fees\.xlsx” as S\d+ \(Excel\)/.test(e.message)));
  const unsupported=/Add a PDF, Word \(\.docx\), Excel \(\.xlsx\), CSV or plain-text \(\.txt\) document/;
  const ole=Buffer.concat([Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]),Buffer.alloc(504)]);
  for(const [body,options,pattern] of [
    ['<html><body>Permit $250</body></html>',{name:'fees.html',type:'text/html'},unsupported],['{"fee":250}',{name:'fees.json',type:'application/json'},unsupported],
    ['# Fees',{name:'fees.md',type:'text/markdown'},unsupported],['Fees',{name:'fees.text',type:'text/plain'},unsupported],[Buffer.from('PK\u0003\u0004'),{name:'drawings.zip',type:'application/zip'},unsupported],
    [Buffer.from('PK\u0003\u0004'),{name:'letter.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},/This Word file could not be read/],[Buffer.from('PK\u0003\u0004'),{name:'fees.xlsx',type:''},/This Excel file could not be read/],
    [ole,{name:'letter.doc',type:'application/msword'},/older Word \(\.doc\) or Excel \(\.xls\) format/],[ole,{name:'fees.xls',type:''},/Save the file as \.docx, \.xlsx or PDF/],[ole,{name:'locked.xlsx',type:''},/password-protected/],
    ['',{},/Choose a document/],['   ',{},/No text could be read/]]){
    const response=await upload(body,options);assert.equal(response.status,400,options.name);assert.match((await response.json()).error,pattern);
  }
  assert.equal((await upload('text',{auth:false})).status,403);
  assert.equal((await upload('text',{id:'00000000-0000-0000-0000-000000000000'})).status,400);
  await assert.rejects(addDocument(s,tools,p.id,{name:'big.txt',type:'text/plain',buffer:Buffer.alloc(LIMITS.documentBytes+1,97)}),/50 MB or less/);
  assert.equal(documentName('..\\..\\evil\u0007name.pdf'),'evilname.pdf');assert.equal(documentName(''),'Document');
});
