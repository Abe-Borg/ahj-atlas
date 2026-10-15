import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { createApp } from '../server.mjs';
import { addressCsv,addressRows } from '../lib/exports.mjs';
import { addressExportFilename } from '../lib/download-filename.mjs';
import { input,FakeProvider } from './fixtures.mjs';

async function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-addresses-')),app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-test-addresses-')));rmSync(dir,{recursive:true,force:true});});return app;}
const exportUrl=(app,format,ids)=>`${app.url}/api/addresses/export?format=${format}&projects=${ids.join(',')}`;

test('CSV cells keep commas, quotes, line breaks and formula-like text literal, with a BOM and CRLF rows',()=>{
  const rows=addressRows([
    {name:'=HYPERLINK("https://evil.example")',address:'1 Main St, Phoenix, AZ 85001',discipline:'Fire protection',input:{country:'United States',siteDescription:'APN 123-45-678\nParcel B'}},
    {name:'+Plus',address:'-2 Dash Rd',discipline:'@Mechanical',input:{}},
  ]);
  assert.deepEqual(rows[1],['+Plus','-2 Dash Rd','United States','','@Mechanical']);
  const csv=addressCsv(rows);
  assert.ok(csv.startsWith('﻿Project,Address,Country,Parcel / site description,Discipline\r\n'));
  assert.equal(csv,'﻿Project,Address,Country,Parcel / site description,Discipline\r\n'
    +'"\'=HYPERLINK(""https://evil.example"")","1 Main St, Phoenix, AZ 85001",United States,"APN 123-45-678\nParcel B",Fire protection\r\n'
    +"'+Plus,'-2 Dash Rd,United States,,'@Mechanical\r\n");
});

test('the address filename is dated and limited to CSV and Excel',()=>{
  assert.equal(addressExportFilename('csv',new Date(2026,0,5)),'AHJ Atlas project addresses 2026-01-05.csv');
  assert.equal(addressExportFilename('xlsx',new Date(2026,9,15)),'AHJ Atlas project addresses 2026-10-15.xlsx');
  assert.throws(()=>addressExportFilename('pdf'),/Unsupported/);
});

test('the export lists only the chosen projects, in the order given, as CSV or an Excel workbook',async t=>{
  const app=await setup(t),s=app.store;
  const phoenix=s.create({...input,name:'PHX-10 "Bldg A", phase 2',address:'4000 Example Pkwy, Phoenix, AZ 85043',siteDescription:'APN 300-12-345'});
  const montreal=s.create({...input,name:'Montréal campus',address:'1000 Rue Example, Montréal, QC H3B 1A1',country:'Canada',discipline:'Mechanical'});
  const skipped=s.create({...input,name:'Not chosen',address:'9 Unchosen Way, Example District, Test State 00000'});

  const csv=await fetch(exportUrl(app,'csv',[montreal.id,phoenix.id]));
  assert.equal(csv.status,200);assert.equal(csv.headers.get('content-type'),'text/csv; charset=utf-8');
  assert.match(decodeURIComponent(csv.headers.get('content-disposition').match(/filename\*=UTF-8''([^;]+)/)[1]),/^AHJ Atlas project addresses \d{4}-\d{2}-\d{2}\.csv$/);
  const bytes=Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);
  const lines=bytes.subarray(3).toString('utf8').split('\r\n');
  assert.deepEqual(lines,['Project,Address,Country,Parcel / site description,Discipline',
    'Montréal campus,"1000 Rue Example, Montréal, QC H3B 1A1",Canada,,Mechanical',
    '"PHX-10 ""Bldg A"", phase 2","4000 Example Pkwy, Phoenix, AZ 85043",United States,APN 300-12-345,Fire protection',
    '']);
  assert.ok(!bytes.toString('utf8').includes(skipped.address));

  const xlsx=await fetch(exportUrl(app,'xlsx',[phoenix.id,montreal.id]));
  assert.equal(xlsx.status,200);assert.equal(xlsx.headers.get('content-type'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(xlsx.headers.get('content-disposition').includes('.xlsx'));
  const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
  assert.deepEqual(book.worksheets.map(w=>w.name),['Addresses']);
  const sheet=book.getWorksheet('Addresses');
  assert.deepEqual(sheet.getRow(1).values.slice(1),['Project','Address','Country','Parcel / site description','Discipline']);
  assert.deepEqual(sheet.getRow(2).values.slice(1),['PHX-10 "Bldg A", phase 2','4000 Example Pkwy, Phoenix, AZ 85043','United States','APN 300-12-345','Fire protection']);
  assert.deepEqual(sheet.getRow(3).values.slice(1,4),['Montréal campus','1000 Rue Example, Montréal, QC H3B 1A1','Canada']);
  assert.equal(sheet.rowCount,3);
});

test('a formula-like project name stays text in the workbook',async t=>{
  const app=await setup(t),p=app.store.create({...input,name:'=HYPERLINK("https://evil.example")'});
  const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await(await fetch(exportUrl(app,'xlsx',[p.id]))).arrayBuffer()));
  const cell=book.getWorksheet('Addresses').getCell('A2');
  assert.equal(cell.type,ExcelJS.ValueType.String);assert.equal(cell.value,'=HYPERLINK("https://evil.example")');
});

test('an empty selection, an unknown format and a deleted project are refused',async t=>{
  const app=await setup(t),p=app.store.create(input),gone=app.store.create({...input,name:'Deleted later'});
  app.store.deleteProject(gone.id);
  const missing=await fetch(exportUrl(app,'csv',[p.id,gone.id]));
  assert.equal(missing.status,404);assert.match((await missing.json()).error,/no longer exists/);
  const empty=await fetch(`${app.url}/api/addresses/export?format=csv&projects=`);
  assert.equal(empty.status,400);assert.match((await empty.json()).error,/at least one project/);
  const format=await fetch(exportUrl(app,'pdf',[p.id]));
  assert.equal(format.status,400);assert.match((await format.json()).error,/CSV or Excel/);
});

test('a link naming more than a thousand projects is accepted, and a repeated ID is exported once',async t=>{
  const app=await setup(t),p=app.store.create(input),ids=Array(1200).fill(p.id);
  const url=exportUrl(app,'csv',ids);assert.ok(url.length>40000);
  const response=await fetch(url);assert.equal(response.status,200);
  assert.equal((await response.text()).split('\r\n').filter(Boolean).length,2);
});
