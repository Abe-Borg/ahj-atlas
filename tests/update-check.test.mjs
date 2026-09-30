import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createUpdateChecker, compareVersions, checksumFor, INSTALLER_ARGS } from '../desktop/update-check.mjs';
import { createApp } from '../server.mjs';
import { FakeProvider } from './fixtures.mjs';

function workspace(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-update-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return dir;
}
function release(version,{installer=true,checksum=true,draft=false,prerelease=false}={}){
  return {tag_name:`v${version}`,draft,prerelease,assets:[
    ...(installer?[{name:`AHJ-Atlas-${version}-Windows-x64-Setup.exe`,state:'uploaded'}]:[]),
    ...(checksum?[{name:'SHA256SUMS.txt',state:'uploaded'}]:[]),
  ]};
}
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});

test('published installer versions compare numerically and daily checks persist across restarts',async t=>{
  assert.equal(compareVersions('1.10.0','1.9.9'),1);
  assert.equal(compareVersions('1.5.2','1.5.2'),0);
  assert.equal(compareVersions('1.4.9','1.5.0'),-1);
  const dataDir=workspace(t);let time=Date.parse('2026-09-28T12:00:00Z'),calls=0;
  const fetchImpl=async()=>{calls++;return response(200,release('1.10.0'));};
  let checker=createUpdateChecker({dataDir,currentVersion:'1.5.2',fetchImpl,now:()=>time});
  const first=await checker.check();
  assert.equal(first.updateAvailable,true);
  assert.equal(first.releaseUrl,'https://github.com/Abe-Borg/ahj-atlas/releases/tag/v1.10.0');
  checker=createUpdateChecker({dataDir,currentVersion:'1.5.2',fetchImpl,now:()=>time});
  assert.equal((await checker.check()).updateAvailable,true);
  assert.equal(calls,1);
  time+=24*60*60*1000;
  await checker.check();
  assert.equal(calls,2);
  await checker.check({force:true});
  assert.equal(calls,3);
});

test('unpublished, incomplete, and failed checks never announce an update',async t=>{
  const dataDir=workspace(t);let payload=release('2.0.0',{draft:true}),calls=0;
  const checker=createUpdateChecker({dataDir,currentVersion:'1.5.2',fetchImpl:async()=>{calls++;return response(200,payload);}});
  let result=await checker.check();
  assert.equal(result.updateAvailable,false);
  assert.match(result.error,/Could not check/);
  payload=release('2.0.0',{checksum:false});
  result=await checker.check({force:true});
  assert.equal(result.updateAvailable,false);
  payload=release('1.5.1');
  result=await checker.check({force:true});
  assert.equal(result.error,null);
  assert.equal(result.updateAvailable,false);
  assert.equal(calls,3);
});

test('missing published release is distinct from a network error',async t=>{
  const dataDir=workspace(t);
  const missing=createUpdateChecker({dataDir,currentVersion:'1.5.2',fetchImpl:async()=>response(404)});
  const status=await missing.check();
  assert.equal(status.error,null);
  assert.equal(status.latestVersion,null);
  assert.ok(status.checkedAt);
});

test('cached release links are reconstructed from valid versions',t=>{
  const dataDir=workspace(t);
  writeFileSync(path.join(dataDir,'update-check.json'),JSON.stringify({currentVersion:'1.5.2',latestVersion:'1.5.3',releaseUrl:'javascript:alert(1)',updateAvailable:true,lastAttemptAt:'2026-09-28T12:00:00Z'}));
  const checker=createUpdateChecker({dataDir,currentVersion:'1.5.2'});
  assert.equal(checker.status().releaseUrl,'https://github.com/Abe-Borg/ahj-atlas/releases/tag/v1.5.3');
});

test('update API respects the app token and shares the same checker for automatic and manual checks',async t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'ahj-update-http-test-'));let calls=0;
  const checker=createUpdateChecker({dataDir,currentVersion:'1.5.2',fetchImpl:async()=>{calls++;return response(200,release('1.5.3'));}});
  const app=await createApp({dataDir,port:0,provider:new FakeProvider(),worker:false,updateChecker:checker});
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const bootstrap=await(await fetch(app.url+'/api/bootstrap')).json();
  assert.equal(bootstrap.updatesEnabled,true);
  const get=await(await fetch(app.url+'/api/updates')).json();
  assert.equal(get.updateAvailable,true);
  assert.equal(calls,1);
  await fetch(app.url+'/api/updates');
  assert.equal(calls,1);
  const denied=await fetch(app.url+'/api/updates',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(denied.status,403);
  const checked=await fetch(app.url+'/api/updates',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':bootstrap.token},body:'{}'});
  assert.equal(checked.status,200);
  assert.equal(calls,2);
});

// A fake GitHub: release metadata, the checksum file and a chunked installer download.
function github({version='1.7.0',bytes=Buffer.from('synthetic installer '.repeat(5000)),checksum,digest,size=bytes.length,installerStatus=200}={}){
  const name=`AHJ-Atlas-${version}-Windows-x64-Setup.exe`,sha=createHash('sha256').update(bytes).digest('hex'),urls=[];
  const fetchImpl=async url=>{
    urls.push(url);
    if(url.startsWith('https://api.github.com/'))return response(200,{tag_name:`v${version}`,draft:false,prerelease:false,assets:[
      {name,state:'uploaded',size,...(digest===false?{}:{digest:`sha256:${digest||sha}`})},{name:'SHA256SUMS.txt',state:'uploaded',size:100}]});
    if(url===`https://github.com/Abe-Borg/ahj-atlas/releases/download/v${version}/SHA256SUMS.txt`)return {ok:true,status:200,text:async()=>`${checksum||sha}  ${name}\n`};
    if(url===`https://github.com/Abe-Borg/ahj-atlas/releases/download/v${version}/${name}`)return {ok:installerStatus===200,status:installerStatus,url:'https://release-assets.githubusercontent.com/synthetic',
      body:(async function*(){for(let i=0;i<bytes.length;i+=4096)yield new Uint8Array(bytes.subarray(i,i+4096));})()};
    throw new Error('Unexpected URL '+url);
  };
  return {fetchImpl,name,sha,urls};
}
function updater(t,options={}){
  const dir=workspace(t),dataDir=path.join(dir,'data'),downloadDir=path.join(dir,'updates'),launches=[],remote=github(options);mkdirSync(dataDir);
  const make=(currentVersion='1.6.0',extra={})=>createUpdateChecker({dataDir,downloadDir,currentVersion,fetchImpl:remote.fetchImpl,launchInstaller:(file,args)=>launches.push({file,args}),...extra});
  return {dataDir,downloadDir,launches,remote,make};
}
const finished=async checker=>{await checker.settled();return checker.status();};

test('release checksum lines are matched to the exact installer name',()=>{
  const hash='a'.repeat(64);
  assert.equal(checksumFor(`${hash}  AHJ-Atlas-1.7.0-Windows-x64-Setup.exe\n`,'AHJ-Atlas-1.7.0-Windows-x64-Setup.exe'),hash);
  assert.throws(()=>checksumFor(`${hash}  AHJ-Atlas-1.6.9-Windows-x64-Setup.exe\n`,'AHJ-Atlas-1.7.0-Windows-x64-Setup.exe'),/does not list/);
  assert.throws(()=>checksumFor('x'.repeat(70000),'a'),/invalid/);
});

test('a verified download installs silently after restart and the next version reports the outcome',async t=>{
  const u=updater(t);
  let checker=u.make();
  assert.equal((await checker.check()).canInstall,true);
  const started=await checker.download();
  assert.equal(started.download.state,'downloading');
  const done=await finished(checker);
  assert.equal(done.download.state,'ready');assert.equal(done.download.version,'1.7.0');
  const saved=path.join(u.downloadDir,u.remote.name);
  assert.equal(createHash('sha256').update(readFileSync(saved)).digest('hex'),u.remote.sha);
  assert.deepEqual(readdirSync(u.downloadDir),[u.remote.name]);
  // A restart keeps the verified download instead of fetching it again.
  checker=u.make();assert.equal(checker.status().download.state,'ready');
  const installing=await checker.install();
  assert.equal(installing.installing,true);
  assert.deepEqual(u.launches,[{file:saved,args:INSTALLER_ARGS}]);
  assert.deepEqual(INSTALLER_ARGS,['--updated','/S','--force-run']);
  assert.equal(JSON.parse(readFileSync(path.join(u.dataDir,'update-check.json'),'utf8')).installing.toVersion,'1.7.0');
  // The installed version reports success once and removes the used installer.
  checker=u.make('1.7.0');
  assert.deepEqual(checker.status().notice,{type:'updated',version:'1.7.0'});
  assert.deepEqual(readdirSync(u.downloadDir),[]);
  assert.equal(u.make('1.7.0').status().notice,null);
});

test('an install that did not finish is reported and can be retried from the saved download',async t=>{
  const u=updater(t);let checker=u.make();
  await checker.check();await checker.download();await finished(checker);await checker.install();
  checker=u.make();
  assert.deepEqual(checker.status().notice,{type:'failed',version:'1.7.0'});
  assert.equal(checker.status().download.state,'ready');
  await checker.install();assert.equal(u.launches.length,2);
});

test('checksum, digest, size and tampering failures never reach the installer',async t=>{
  for(const [options,message] of [[{checksum:'b'.repeat(64),digest:false},/did not match its published SHA-256/],[{digest:'c'.repeat(64)},/asset digest disagree/],[{size:10},/larger than its published size/],[{installerStatus:404},/HTTP 404 for the installer/]]){
    const u=updater(t,options),checker=u.make();
    await checker.check();await checker.download();const status=await finished(checker);
    assert.equal(status.download.state,'failed');assert.match(status.download.error,message);
    assert.deepEqual(existsSync(u.downloadDir)?readdirSync(u.downloadDir):[],[]);
    await assert.rejects(checker.install(),/Download the update/);assert.deepEqual(u.launches,[]);
  }
  const u=updater(t),checker=u.make();
  await checker.check();await checker.download();await finished(checker);
  writeFileSync(path.join(u.downloadDir,u.remote.name),'replaced on disk');
  await assert.rejects(checker.install(),/changed or was removed/);
  assert.deepEqual(u.launches,[]);assert.equal(checker.status().download.state,'failed');
});

test('without an installer launcher the checker only links to the release',async t=>{
  const dataDir=workspace(t),remote=github();
  const checker=createUpdateChecker({dataDir,currentVersion:'1.6.0',fetchImpl:remote.fetchImpl});
  const status=await checker.check();
  assert.equal(status.updateAvailable,true);assert.equal(status.canInstall,false);
  await assert.rejects(checker.download(),/installed Windows app/);
  assert.equal(remote.urls.length,1);
});

test('install is refused while research is running and otherwise hands the installer to the shell',async t=>{
  // Windows cannot remove an open database: close the app before deleting its folder.
  const u=updater(t),checker=u.make(),dataDir=mkdtempSync(path.join(os.tmpdir(),'ahj-update-install-test-'));
  const app=await createApp({dataDir,port:0,provider:new FakeProvider(),worker:false,updateChecker:checker});
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const {token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const post=(route,headers={'X-App-Token':token})=>fetch(app.url+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'});
  assert.equal((await post('/api/updates/download',{})).status,403);
  assert.equal((await(await post('/api/updates/download')).json()).download.state,'downloading');
  await checker.settled();
  app.services.engine.running.add('project:codes');
  const busy=await post('/api/updates/install');
  assert.equal(busy.status,409);assert.match((await busy.json()).error,/still running/);assert.deepEqual(u.launches,[]);
  app.services.engine.running.clear();
  // Work that starts while the installer is being re-hashed also blocks the hand-off.
  let checks=0;Object.defineProperty(app.services.chat.running,'size',{configurable:true,get:()=>checks++?1:0});
  const late=await post('/api/updates/install');
  assert.equal(late.status,409);assert.equal(checks,2);assert.deepEqual(u.launches,[]);assert.equal(checker.status().installing,false);
  delete app.services.chat.running.size;
  const installed=await post('/api/updates/install');
  assert.equal(installed.status,200);assert.equal(u.launches.length,1);
});
