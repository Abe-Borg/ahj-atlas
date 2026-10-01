import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { VERSION } from '../lib/config.mjs';
import packageInfo from '../package.json' with { type: 'json' };
import { attachmentDisposition, projectExportFilename, safeDownloadName } from '../lib/download-filename.mjs';
import { downloadFilename, exportDownload, handleDesktopDownloads } from '../desktop/downloads.mjs';
import { PRODUCT_NAME } from '../desktop/paths.mjs';

const origin='http://127.0.0.1:54321';
const exportUrl=`${origin}/api/projects/123e4567-e89b-12d3-a456-426614174000/export?format=pdf`;

test('one package version drives the API and Electron metadata',()=>{
  assert.equal(VERSION,packageInfo.version);
  assert.equal(packageInfo.productName,PRODUCT_NAME);
});

test('attachment filenames retain Unicode and spaces, and reject Windows special names',()=>{
  const name=projectExportFilename('  Café 東京 : site*?  ','pdf');
  assert.equal(name,'Café 東京 site - AHJ research.pdf');
  assert.equal(safeDownloadName('CON'),'Project');
  assert.equal(safeDownloadName('LPT2'),'Project');
  for(const name of ['CON.txt','con .backup','LPT1.report','COM¹.notes']){
    assert.equal(safeDownloadName(name),'Project',name);
    assert.equal(projectExportFilename(name,'pdf'),'Project - AHJ research.pdf',name);
  }
  assert.equal(safeDownloadName('A<B>C'),'ABC');
  assert.ok(projectExportFilename('📐'.repeat(300),'xlsx').length<240);
  const header=attachmentDisposition(name);
  assert.match(header,/filename\*=UTF-8''Caf%C3%A9%20%E6%9D%B1%E4%BA%AC/);
  assert.match(attachmentDisposition("O'Brien.pdf"),/filename\*=UTF-8''O%27Brien\.pdf/);
  assert.ok(!/[\r\n]/.test(header));
  assert.equal(downloadFilename(name,'pdf'),name);
  for(const value of ['CON.pdf','a?.pdf','a/b.pdf','a\\b.pdf','a.pdf.exe','x'.repeat(150)+'.pdf'])
    assert.equal(downloadFilename(value,'pdf'),null,value);
});

test('only expected attachment endpoints on the exact loopback origin are accepted',()=>{
  assert.equal(exportDownload(exportUrl,origin),'pdf');
  assert.equal(exportDownload(`${origin}/api/diagnostics/download?project=a`,origin),'json');
  assert.equal(exportDownload(`${origin}/api/projects/123e4567-e89b-12d3-a456-426614174000/export?format=xlsx-essentials`,origin),'xlsx');
  assert.equal(exportDownload(`${origin}/api/projects/123e4567-e89b-12d3-a456-426614174000/export?format=xlsx`,origin),'xlsx');
  for(const value of ['file:///C:/report.pdf','https://example.com/report.pdf',
    'http://127.0.0.1:54322/api/diagnostics/download',`${origin}/api/projects/x/export?format=pdf`,
    `${origin}/api/projects/123e4567-e89b-12d3-a456-426614174000/export?format=exe`,
    `${origin}/api/projects/123e4567-e89b-12d3-a456-426614174000/export?format=xlsx-essentials&next=1`,
    `${origin}/api/diagnostics/download?next=file:///C:/secret`])
    assert.equal(exportDownload(value,origin),null,value);
});

function fixture(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-download-test-'));
  t.after(()=>{assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(),'ahj-atlas-download-test-')));rmSync(root,{recursive:true,force:true});});
  const downloadsDir=path.join(root,'Downloads');mkdirSync(downloadsDir);
  const session=new EventEmitter(),contents={session},window={webContents:contents,isDestroyed:()=>false,focusCount:0,focus(){this.focusCount++;}};
  const notices=[],selections=[],saveOptions=[],dialog={
    showMessageBox:async(_window,options)=>{notices.push(options);return {response:0};},
    showSaveDialog:async(_window,options)=>{saveOptions.push(options);return selections.shift()||{canceled:true,filePath:''};}};
  const dispose=handleDesktopDownloads({window,appUrl:origin,dialog,downloadsDir,tempDir:root});
  return {root,downloadsDir,session,contents,window,notices,selections,saveOptions,dispose};
}
function item({url=exportUrl,filename='Café 東京 site - AHJ research.pdf',initiator=origin,chain=[exportUrl]}={}){
  return Object.assign(new EventEmitter(),{getURL:()=>url,getFilename:()=>filename,getInitiatorOrigin:()=>initiator,
    getURLChain:()=>chain,canceled:false,savePath:null,cancel(){this.canceled=true;},setSavePath(value){this.savePath=value;}});
}

async function until(check){for(let n=0;n<100;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for export result.');}

test('essentials Excel saves as an xlsx beside the full workbook',async t=>{
  const {downloadsDir,session,contents,selections,saveOptions,dispose}=fixture(t);
  const url=`${origin}/api/projects/123e4567-e89b-12d3-a456-426614174000/export?format=xlsx-essentials`;
  const filename='Café 東京 site - AHJ research essentials.xlsx';
  const download=item({url,filename,chain:[url]});
  const destination=path.join(downloadsDir,'Saved essentials.xlsx');
  selections.push({canceled:false,filePath:destination});
  session.emit('will-download',{},download,contents);
  assert.equal(download.canceled,false);
  writeFileSync(download.savePath,'synthetic essentials workbook');
  download.emit('done',{},'completed');
  await until(()=>existsSync(destination));
  assert.deepEqual(saveOptions[0].filters,[{name:'Excel essentials',extensions:['xlsx']}]);
  assert.equal(saveOptions[0].defaultPath,path.join(downloadsDir,filename));
  assert.equal(readFileSync(destination,'utf8'),'synthetic essentials workbook');
  dispose();
});

test('native Save dialog keeps server filename and an exclusive final copy',async t=>{
  const {root,downloadsDir,session,contents,window,notices,selections,saveOptions,dispose}=fixture(t),download=item();
  const destination=path.join(downloadsDir,'Saved export.pdf');selections.push({canceled:false,filePath:destination});
  session.emit('will-download',{},download,contents);
  assert.equal(download.canceled,false);
  assert.ok(download.savePath.startsWith(root));writeFileSync(download.savePath,'synthetic PDF bytes');
  download.emit('done',{},'completed');await until(()=>existsSync(destination)&&notices.length>0);
  assert.deepEqual(saveOptions[0],{title:'Save AHJ Atlas export',
    defaultPath:path.join(downloadsDir,'Café 東京 site - AHJ research.pdf'),filters:[{name:'PDF report',extensions:['pdf']}],properties:['showOverwriteConfirmation']});
  assert.equal(readFileSync(destination,'utf8'),'synthetic PDF bytes');
  assert.match(notices[0].message,/was saved/);assert.equal(window.focusCount,1);
  assert.ok(!JSON.stringify(notices).includes(root));
  await until(()=>readdirSync(root).every(name=>!name.startsWith('ahj-atlas-export-')));
  dispose();assert.equal(session.listenerCount('will-download'),0);
});

test('a collision keeps the previous file and requires a new export',async t=>{
  const {downloadsDir,session,contents,selections,notices,dispose}=fixture(t),download=item();
  const existing=path.join(downloadsDir,'existing.pdf'),replacement=path.join(downloadsDir,'new.pdf');
  writeFileSync(existing,'original');selections.push({canceled:false,filePath:existing});
  session.emit('will-download',{},download,contents);writeFileSync(download.savePath,'new content');download.emit('done',{},'completed');
  await until(()=>notices.length===1);
  assert.equal(readFileSync(existing,'utf8'),'original');assert.equal(existsSync(replacement),false);
  assert.match(notices[0].message,/already exists/);dispose();
});

test('Save dialog cancellation and changed extensions do not create a destination',async t=>{
  const {downloadsDir,session,contents,selections,notices,dispose}=fixture(t);
  selections.push({canceled:true,filePath:''},{canceled:false,filePath:path.join(downloadsDir,'report.exe')});
  for(let index=0;index<2;index++){
    const download=item();session.emit('will-download',{},download,contents);
    writeFileSync(download.savePath,'synthetic');download.emit('done',{},'completed');
    await until(()=>notices.length===index+1);
  }
  assert.match(notices[0].message,/canceled/);assert.match(notices[1].message,/\.pdf filename/);
  assert.equal(existsSync(path.join(downloadsDir,'report.exe')),false);
  dispose();
});

test('cancelled and interrupted exports are announced; unrelated downloads are denied',async t=>{
  const {session,contents,notices,dispose}=fixture(t);
  for(const state of ['cancelled','interrupted']){
    const download=item();session.emit('will-download',{},download,contents);download.emit('done',{},state);
  }
  await until(()=>notices.length===2);
  assert.match(notices[0].message,/canceled/);assert.match(notices[1].message,/could not be downloaded/);
  for(const options of [{initiator:'https://example.com'},
    {chain:[exportUrl,'https://example.com/file.pdf']},{filename:'file:///C:/secret.pdf'}]){
    const download=item(options);session.emit('will-download',{},download,contents);assert.equal(download.canceled,true);
  }
  const foreign=item();session.emit('will-download',{},foreign,{});assert.equal(foreign.canceled,true);
  dispose();
});
