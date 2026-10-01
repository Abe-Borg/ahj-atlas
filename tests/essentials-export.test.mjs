import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createApp } from '../server.mjs';
import { exportData,excelReport,pdfReport } from '../lib/exports.mjs';
import { projectExportFilename } from '../lib/download-filename.mjs';
import { CLOSURE_REASON } from '../lib/questions.mjs';
import { evidenceText,input,nfpaReport,FakeProvider } from './fixtures.mjs';

const excerptMarker='EXCERPT-MARKER-'+'z'.repeat(20000);
const jurisdictionBrief='BRIEF-MARKER jurisdiction findings that leave the essentials workbook once a report exists.';
const reviewBrief='BRIEF-MARKER review findings that leave the essentials workbook once a report exists.';
const codesBrief='BRIEF-MARKER codes findings kept when research has no report yet.';
const gaps=[
  {question:'What systems are proposed?',why:'Project scope determines applicability.',contact:'Project team',nextStep:'Confirm the systems.'},
  {question:'What is the expected permit date?',why:'Effective dates may affect the report.',contact:'Owner',nextStep:'Confirm the schedule.'},
  {question:'Which edition applies to the addition?',why:'The addition may follow a different edition.',contact:'Building official',nextStep:'Confirm the edition.'},
];
const findingHeaders={
  Codes:['Code / standard','Edition','Authority','Adoption type','Adoption instrument','Effective date','Local amendments','Applicability','Status','Notes','Evidence'],
  'NFPA standards':['NFPA standard','Edition','Applicability finding','Scope / basis','Authority','Adoption type','Adoption instrument','Effective date','Local amendments','Evidence status','Notes','Adoption source ID','Edition source ID','Evidence'],
  Contacts:['Name','Title','Organization','Responsibility','Email','Phone','Address','Website','Status','Notes','Evidence'],
  Authorities:['Organization','Responsibility','Website','Phone','Email','Address','Status','Evidence'],
  'Submission requirements':['Requirement','Authority','Details','Website','Status','Evidence'],
  'Questions to resolve':['Question','Why it matters','Contact','Next step','Status','User-provided answer','Reason','Updated'],
  Notes:['Title','Note','Origin','Saved'],
  'Research briefs':['Stage','Status','Findings','Limitations'],
};
const sourceHeaders=['Source ID','Title','URL','Retrieved','Reading method','Read as evidence','Document date'];
const always=['Project','Codes','Contacts','Authorities','Submission requirements','Questions to resolve','Sources'];

function grid(ws){
  const rows=[];
  ws.eachRow(row=>{
    const values=[];
    for(let column=1;column<=ws.columnCount;column++)values.push(row.getCell(column).value??'');
    rows.push(values);
  });
  return rows;
}
function fields(ws){return grid(ws).slice(1);}
function names(book){return book.worksheets.map(sheet=>sheet.name);}
function contains(book,needle){return book.worksheets.some(sheet=>grid(sheet).some(row=>row.some(value=>String(value).includes(needle))));}
async function workbook(buffer){const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);return book;}
function filename(disposition){return decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/)[1]);}

async function setup(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-essentials-'));
  const app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-essentials-')));rmSync(dir,{recursive:true,force:true});});
  return app;
}

async function reportedProject(app){
  const store=app.store,project=store.create({...input,siteDescription:'APN 0123-456-789'});
  store.updateProject(project.id,{input:{...store.project(project.id).input,previousAddresses:[input.address]}});
  store.source(project.id,{url:'https://example.com/adoption',title:'Synthetic adoption record',text:evidenceText+excerptMarker,readFull:true,documentDate:'2022-01-01'});
  store.source(project.id,{url:'https://example.com/dead-end',title:'Uncited discovery',text:'This discovery text is not stored.',readFull:false,kind:'census',documentDate:'2019-06-01'});
  store.addNote(project.id,{title:'Sprinkler note',text:'Keep the chat conclusion with the report.'});
  store.updateStage(project.id,'jurisdiction',{status:'complete',output:jurisdictionBrief,note:'Jurisdiction brief limitation.'});
  store.updateProject(project.id,{report:{...nfpaReport(),gaps},status:'complete'});
  const [answered,dismissed]=store.project(project.id).questions;
  store.saveQuestion(project.id,{questionId:answered.id,status:'answered',answer:'Sprinkler retrofit only.',reason:'The owner confirmed the scope.'});
  store.saveQuestion(project.id,{questionId:dismissed.id,status:'dismissed',reason:'Not needed for this phase.'});
  const attempt=store.reserve(project.id,'review',{mode:'realtime',modelKey:'review',payload:{},reserve:1});
  app.services.engine.saveReport(store.project(project.id),store.attempt(attempt.id),{...nfpaReport(),researchHealth:{},gaps:gaps.slice(0,2)},reviewBrief);
  return project.id;
}

test('essentials keeps the finding sheets and drops the research log once a report exists',async t=>{
  const app=await setup(t),id=await reportedProject(app),data=exportData(app.store,id);
  const full=await workbook(await excelReport(data)),same=await workbook(await excelReport(data,{essentials:false})),slim=await workbook(await excelReport(data,{essentials:true}));
  assert.deepEqual(names(full),['Project','Codes','NFPA standards','Contacts','Authorities','Submission requirements','Questions to resolve','Notes','Sources','Research briefs']);
  assert.deepEqual(names(slim),['Project','Codes','NFPA standards','Contacts','Authorities','Submission requirements','Questions to resolve','Notes','Sources']);
  for(const name of names(full))assert.deepEqual(grid(same.getWorksheet(name)),grid(full.getWorksheet(name)),name);

  const fullProject=fields(full.getWorksheet('Project')),slimProject=fields(slim.getWorksheet('Project'));
  assert.deepEqual(fullProject.map(row=>row[0]),['Project','Address','Parcel / site description','Previous addresses','Discipline','Status','Mode','Research date','Estimated API cost','Estimated pending cost','Summary','Jurisdiction','Jurisdiction status','Jurisdiction evidence','Limitations']);
  assert.deepEqual(slimProject.map(row=>row[0]),fullProject.map(row=>row[0]).filter(field=>!['Mode','Estimated API cost','Estimated pending cost'].includes(field)));
  assert.equal(fullProject.find(row=>row[0]==='Mode')[1],'realtime');
  assert.equal(fullProject.find(row=>row[0]==='Estimated API cost')[1],`$${data.project.estimatedApiCost.toFixed(4)}`);
  assert.equal(fullProject.find(row=>row[0]==='Estimated pending cost')[1],`$${data.project.estimatedPendingCost.toFixed(4)}`);
  for(const [field,value] of slimProject)assert.equal(fullProject.find(row=>row[0]===field)[1],value,field);
  assert.equal(slimProject.find(row=>row[0]==='Parcel / site description')[1],'APN 0123-456-789');
  assert.equal(slimProject.find(row=>row[0]==='Previous addresses')[1],input.address);
  assert.match(slimProject.find(row=>row[0]==='Jurisdiction evidence')[1],/https:\/\/example.com\/adoption/);

  for(const [name,headers] of Object.entries(findingHeaders)){
    if(name==='Research briefs')continue;
    assert.deepEqual(grid(slim.getWorksheet(name))[0],headers,name);
    assert.deepEqual(grid(slim.getWorksheet(name)),grid(full.getWorksheet(name)),name);
  }
  const questions=fields(slim.getWorksheet('Questions to resolve'));
  assert.deepEqual(questions.map(row=>row[4]),['answered','dismissed','closed']);
  assert.equal(questions.find(row=>row[4]==='answered')[5],'Sprinkler retrofit only.');
  assert.equal(questions.find(row=>row[4]==='answered')[6],'The owner confirmed the scope.');
  assert.equal(questions.find(row=>row[4]==='dismissed')[6],'Not needed for this phase.');
  assert.equal(questions.find(row=>row[4]==='closed')[6],CLOSURE_REASON);
  assert.match(fields(slim.getWorksheet('Codes')).at(-1).at(-1),/Fixture Building Code, 2021 edition/);
  assert.equal(fields(slim.getWorksheet('NFPA standards'))[0][11],'S1');
  assert.equal(fields(slim.getWorksheet('NFPA standards'))[0][12],'S1');
  assert.equal(fields(slim.getWorksheet('Notes'))[0][2],'Saved from project chat by the user; not re-verified by research');

  assert.deepEqual(grid(full.getWorksheet('Sources'))[0],[...sourceHeaders,'Excerpt']);
  assert.deepEqual(grid(slim.getWorksheet('Sources'))[0],sourceHeaders);
  const fullSources=fields(full.getWorksheet('Sources')),slimSources=fields(slim.getWorksheet('Sources'));
  assert.equal(slimSources.length,2);
  assert.deepEqual(slimSources,fullSources.map(row=>row.slice(0,-1)));
  assert.equal(slimSources[1][4],'census');
  assert.equal(slimSources[1][5],'Discovery / visual only');
  assert.equal(slimSources[1][6],'2019-06-01');
  assert.ok(fullSources[0].at(-1).includes('EXCERPT-MARKER-'));
  assert.equal(fullSources[0].at(-1).length,16000);
  assert.equal(contains(slim,'EXCERPT-MARKER-'),false);
  assert.deepEqual(grid(full.getWorksheet('Research briefs'))[0],findingHeaders['Research briefs']);
  assert.equal(full.getWorksheet('Research briefs').rowCount,6);
  assert.equal(contains(full,jurisdictionBrief),true);
  assert.equal(contains(full,reviewBrief),true);
  assert.equal(contains(slim,jurisdictionBrief),false);
  assert.equal(contains(slim,reviewBrief),false);
  assert.equal(slim.getWorksheet('Research briefs'),undefined);
});

test('essentials keeps research briefs and empty finding sheets when no report exists',async t=>{
  const app=await setup(t),store=app.store,project=store.create({...input,name:'Incomplete essentials'});
  store.updateStage(project.id,'codes',{status:'partial',output:codesBrief,note:'Edition not confirmed.'});
  store.source(project.id,{url:'https://example.com/partial',title:'Partial source',text:excerptMarker,readFull:true});
  const data=exportData(store,project.id);
  assert.equal(data.report,null);
  const full=await workbook(await excelReport(data)),slim=await workbook(await excelReport(data,{essentials:true}));
  assert.deepEqual(names(full),[...always,'Research briefs']);
  assert.deepEqual(names(slim),[...always,'Research briefs']);
  assert.equal(full.getWorksheet('NFPA standards'),undefined);
  assert.equal(slim.getWorksheet('NFPA standards'),undefined);
  assert.equal(full.getWorksheet('Notes'),undefined);
  assert.equal(slim.getWorksheet('Notes'),undefined);
  for(const name of ['Codes','Contacts','Authorities','Submission requirements','Questions to resolve']){
    assert.deepEqual(grid(slim.getWorksheet(name)),[findingHeaders[name]]);
    assert.deepEqual(grid(slim.getWorksheet(name)),grid(full.getWorksheet(name)));
  }
  assert.deepEqual(grid(slim.getWorksheet('Research briefs')),grid(full.getWorksheet('Research briefs')));
  assert.deepEqual(grid(slim.getWorksheet('Research briefs'))[0],findingHeaders['Research briefs']);
  const codes=fields(slim.getWorksheet('Research briefs')).find(row=>row[0]==='codes');
  assert.deepEqual(codes,['codes','partial',codesBrief,'Edition not confirmed.']);
  assert.deepEqual(fields(slim.getWorksheet('Project')).map(row=>row[0]),['Project','Address','Discipline','Status','Research date','Summary','Jurisdiction','Jurisdiction status','Jurisdiction evidence','Limitations']);
  assert.equal(fields(slim.getWorksheet('Project')).find(row=>row[0]==='Summary')[1],'Research is incomplete.');
  assert.equal(fields(full.getWorksheet('Project')).some(row=>row[0]==='Mode'),true);
  assert.deepEqual(grid(slim.getWorksheet('Sources'))[0],sourceHeaders);
  assert.equal(contains(slim,'EXCERPT-MARKER-'),false);
  assert.equal(contains(full,'EXCERPT-MARKER-'),true);
  assert.equal(contains(slim,codesBrief),true);
});

test('the export menu downloads essentials beside the unchanged full workbook, PDF and JSON',async t=>{
  const app=await setup(t),id=await reportedProject(app);
  const menu=await(await fetch(app.url+'/app.js')).text();
  assert.match(menu,/\['pdf','PDF report'\],\['xlsx','Excel workbook'\],\['xlsx-essentials','Excel essentials'\],\['json','Research data \(JSON\)'\]/);
  assert.match(await(await fetch(app.url+'/help')).text(),/Download a PDF, Excel workbook, Excel essentials, or JSON research record/);
  const essentials=await fetch(`${app.url}/api/projects/${id}/export?format=xlsx-essentials`);
  const workbookResponse=await fetch(`${app.url}/api/projects/${id}/export?format=xlsx`);
  const pdf=await fetch(`${app.url}/api/projects/${id}/export?format=pdf`);
  const json=await fetch(`${app.url}/api/projects/${id}/export?format=json`);
  const rejected=await fetch(`${app.url}/api/projects/${id}/export?format=workbook`);
  assert.equal(essentials.status,200);assert.equal(workbookResponse.status,200);assert.equal(pdf.status,200);assert.equal(json.status,200);assert.equal(rejected.status,400);
  assert.equal(essentials.headers.get('content-type'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(workbookResponse.headers.get('content-type'),essentials.headers.get('content-type'));
  assert.equal(filename(essentials.headers.get('content-disposition')),projectExportFilename(input.name,'xlsx',{essentials:true}));
  assert.equal(filename(workbookResponse.headers.get('content-disposition')),projectExportFilename(input.name,'xlsx'));
  assert.match(filename(workbookResponse.headers.get('content-disposition')),/ - AHJ research\.xlsx$/);
  assert.doesNotMatch(filename(workbookResponse.headers.get('content-disposition')),/essentials/);
  const slim=await workbook(Buffer.from(await essentials.arrayBuffer())),full=await workbook(Buffer.from(await workbookResponse.arrayBuffer()));
  assert.equal(slim.getWorksheet('Research briefs'),undefined);
  assert.equal(fields(full.getWorksheet('Project')).some(row=>row[0]==='Estimated API cost'),true);
  assert.equal(grid(full.getWorksheet('Sources'))[0].at(-1),'Excerpt');
  assert.equal(pdf.headers.get('content-type'),'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  const record=await json.json();
  assert.ok(record.sources[0].excerpt.includes('EXCERPT-MARKER-'));
  assert.equal(record.stageBriefs.find(stage=>stage.stage==='jurisdiction').findings,jurisdictionBrief);
  assert.equal(record.report.codes[0].name,'Fixture Building Code');
  const direct=await pdfReport(exportData(app.store,id));
  assert.equal(direct.subarray(0,5).toString(),'%PDF-');
});
