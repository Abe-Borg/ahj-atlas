import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdateChecker, compareVersions } from '../desktop/update-check.mjs';
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
