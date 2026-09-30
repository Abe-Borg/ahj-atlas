import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDesktop } from '../desktop/lifecycle.mjs';
import { navigationDecision, secureWindowNavigation } from '../desktop/navigation.mjs';
import { desktopPaths } from '../desktop/paths.mjs';
import { Store } from '../lib/store.mjs';
import { input } from './fixtures.mjs';

class FakeApp extends EventEmitter{
  constructor(lock=true){super();this.lock=lock;this.quits=0;}
  requestSingleInstanceLock(){return this.lock;}
  whenReady(){return Promise.resolve();}
  quit(){this.quits++;const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};this.emit('before-quit',event);return !event.defaultPrevented;}
}
class FakeWindow extends EventEmitter{
  constructor(options){super();this.options=options;this.actions=[];this.minimized=false;
    this.webContents=new EventEmitter();this.webContents.session=new EventEmitter();this.webContents.session.setPermissionRequestHandler=handler=>{this.permissionHandler=handler;};
    this.webContents.setWindowOpenHandler=handler=>{this.openHandler=handler;};
    this.webContents.closeDevTools=()=>this.actions.push('closeDevTools');}
  async loadURL(url){this.url=url;}
  isDestroyed(){return false;}
  isMinimized(){return this.minimized;}
  restore(){this.actions.push('restore');this.minimized=false;}
  show(){this.actions.push('show');}
  focus(){this.actions.push('focus');}
  getNormalBounds(){return {x:30,y:40,width:1400,height:900};}
}
const backend=(close=async()=>{})=>({url:'http://127.0.0.1:54321',close});
const preventable=()=>({defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}});

test('bootstrap uses an ephemeral port, sandboxed renderer and returned loopback URL',async()=>{
  const app=new FakeApp(),calls=[];
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,dataDir:'synthetic-desktop-dir',
    createBackend:async options=>{calls.push(options);return backend();}});
  assert.equal(desktop.primary,true);
  assert.deepEqual(calls,[{dataDir:'synthetic-desktop-dir',port:0,provider:undefined}]);
  assert.equal(desktop.window.url,'http://127.0.0.1:54321');
  assert.deepEqual(desktop.window.options.webPreferences,{nodeIntegration:false,contextIsolation:true,sandbox:true,devTools:true});
  assert.equal(desktop.window.options.webPreferences.preload,undefined);
  assert.deepEqual(desktop.window.actions,['show']);
});

test('second launch exits; second-instance restores and focuses primary',async()=>{
  const secondary=new FakeApp(false);
  const rejected=await startDesktop({app:secondary,BrowserWindow:FakeWindow,dataDir:'unused',createBackend:()=>{throw Error('must not start');}});
  assert.equal(rejected.primary,false);assert.equal(secondary.quits,1);
  const primary=new FakeApp();
  const desktop=await startDesktop({app:primary,BrowserWindow:FakeWindow,dataDir:'synthetic',createBackend:async()=>backend()});
  desktop.window.minimized=true;primary.emit('second-instance');
  assert.deepEqual(desktop.window.actions,['show','restore','show','focus']);
});

test('preflight finishes before backend construction, and quit awaits backend close',async()=>{
  const app=new FakeApp(),order=[];let resolveClose;
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,resolvePaths:()=>({dataDir:'production-data',credentialDir:'vault',migrationEnabled:true}),
    preflight:async()=>{order.push('preflight');return {decision:'fresh'};},
    createBackend:async options=>{order.push('backend');assert.deepEqual(options,{dataDir:'production-data',port:0,provider:undefined,vaultDir:'vault'});
      return backend(()=>new Promise(resolve=>{resolveClose=resolve;}));}});
  assert.deepEqual(order,['preflight','backend']);
  assert.equal(app.quit(),false);
  await Promise.resolve();await Promise.resolve();
  assert.equal(app.quits,1);
  resolveClose();await desktop.closed();
  assert.equal(app.quits,2);
  assert.equal(app.quit(),true);
});

test('normal close releases the backend before exiting the packaged process',async()=>{
  const app=new FakeApp(),exits=[];app.exit=code=>exits.push(code);
  let finishClose;
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,dataDir:'synthetic',
    createBackend:async()=>backend(()=>new Promise(resolve=>{finishClose=resolve;}))});
  const event=preventable();desktop.window.emit('close',event);
  assert.equal(event.defaultPrevented,true);
  await Promise.resolve();await Promise.resolve();
  assert.deepEqual(exits,[]);
  finishClose();await desktop.closed();
  assert.deepEqual(exits,[0]);
});

test('an update installer starts only after the backend has closed, and its failure still exits',async()=>{
  for(const fail of [false,true]){
    const app=new FakeApp(),order=[],errors=[];app.exit=code=>order.push('exit:'+code);let finishClose;
    const desktop=await startDesktop({app,BrowserWindow:FakeWindow,dataDir:'synthetic',onError:error=>errors.push(error.message),
      beforeExit:()=>{order.push('installer');if(fail)throw new Error('spawn failed');},
      createBackend:async()=>backend(()=>new Promise(resolve=>{finishClose=()=>{order.push('backend closed');resolve();};}))});
    assert.equal(app.quit(),false);
    await Promise.resolve();assert.deepEqual(order,[]);
    finishClose();await desktop.closed();
    assert.deepEqual(order,['backend closed','installer','exit:0']);assert.deepEqual(errors,fail?['spawn failed']:[]);
  }
});

test('backend startup failure shows an error and leaves no window',async()=>{
  const app=new FakeApp(),errors=[];
  await assert.rejects(startDesktop({app,BrowserWindow:FakeWindow,dataDir:'synthetic',onError:()=>{},
    dialog:{showErrorBox:(title,message)=>errors.push({title,message})},createBackend:async()=>{throw new Error('backend failed');}}),/backend failed/);
  assert.equal(app.quits,1);assert.match(errors[0].message,/backend failed/);
});

test('canceling the first-run migration exits before Store construction',async()=>{
  const app=new FakeApp();let started=false;
  const result=await startDesktop({app,BrowserWindow:FakeWindow,resolvePaths:()=>({dataDir:'unused',migrationEnabled:true}),
    preflight:async()=>({decision:'cancel'}),createBackend:async()=>{started=true;return backend();}});
  assert.equal(result.canceled,true);assert.equal(started,false);assert.equal(app.quits,1);
});

test('packaged window disables developer tools and session ending closes the backend',async()=>{
  const app=new FakeApp();let closes=0;
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,
    resolvePaths:()=>({packaged:true,dataDir:'production-data',migrationEnabled:false}),
    createBackend:async()=>backend(async()=>{closes++;})});
  assert.equal(desktop.window.options.webPreferences.devTools,false);
  desktop.window.webContents.emit('devtools-opened');
  assert.ok(desktop.window.actions.includes('closeDevTools'));
  desktop.window.emit('session-end');
  await desktop.closed();assert.equal(closes,1);assert.ok(app.quits>=1);
});

test('load failure closes an already-started backend',async()=>{
  const app=new FakeApp();let closes=0;
  class FailedWindow extends FakeWindow{async loadURL(){throw new Error('load failed');}}
  await assert.rejects(startDesktop({app,BrowserWindow:FailedWindow,dataDir:'synthetic',onError:()=>{},
    createBackend:async()=>backend(async()=>{closes++;})}),/load failed/);
  assert.equal(closes,1);assert.equal(app.quits,1);
});

test('active work requires accurate close confirmation; renderer failure drains backend',async()=>{
  const app=new FakeApp(),messages=[];let closed=0;
  const dialog={showMessageBox:async(_window,options)=>{messages.push(options);return {response:1};},showErrorBox:()=>{}};
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,dataDir:'synthetic',dialog,onError:()=>{},
    createBackend:async()=>({...backend(async()=>{closed++;}),services:{engine:{running:new Set(['job'])}}})});
  const event=preventable();desktop.window.emit('close',event);assert.equal(event.defaultPrevented,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(messages[0].detail,/waits for locally active requests/);
  await desktop.closed();assert.equal(closed,1);
  desktop.window.webContents.emit('render-process-gone');
  assert.ok(app.quits>=2);
});

test('dispatching and pending batch attempts require close confirmation between polls',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-desktop-pending-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),project=store.create({...input,mode:'batch'});
  const attempt=store.reserve(project.id,'discovery',{mode:'batch',modelKey:'test',payload:{},reserve:1000});
  const app=new FakeApp(),messages=[];
  const dialog={showMessageBox:async(_window,options)=>{messages.push(options);return {response:0};}};
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,dataDir:dir,dialog,
    createBackend:async()=>({...backend(async()=>store.close()),store,services:{engine:{running:new Set(),polling:new Set(),applying:new Set()},chat:{running:new Map()}}})});
  for(const state of ['dispatching','pending']){
    store.updateAttempt(attempt.id,{state});
    const event=preventable();desktop.window.emit('close',event);
    assert.equal(event.defaultPrevented,true,state);
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(messages.length,2);
  assert.match(messages[1].detail,/submitted batch may continue/);
  store.updateAttempt(attempt.id,{state:'settled'});
  const settled=preventable();desktop.window.emit('close',settled);
  assert.equal(settled.defaultPrevented,true);
  await desktop.closed();assert.ok(app.quits>=1);
});

test('production paths preserve the existing local DPAPI directory and isolate development',()=>{
  const app={isPackaged:true,getPath:name=>name==='userData'?'C:\\Users\\u\\AppData\\Local\\AHJ Atlas':'C:\\Users\\u\\AppData\\Roaming'};
  const prod=desktopPaths({app,env:{LOCALAPPDATA:'C:\\Users\\u\\AppData\\Local',ATLAS_DESKTOP_DATA_DIR:'ignored'}});
  assert.equal(prod.dataDir,path.join('C:\\Users\\u\\AppData\\Local\\AHJ Atlas','data'));
  assert.equal(prod.credentialDir,path.join('C:\\Users\\u\\AppData\\Local','AHJ Atlas'));
  assert.equal(prod.userData,prod.credentialDir);
  assert.equal(prod.migrationEnabled,true);
  const dev=desktopPaths({app:{...app,isPackaged:false},env:{ATLAS_DESKTOP_DATA_DIR:'C:\\disposable'},tempDir:'C:\\Temp'});
  assert.equal(dev.migrationEnabled,false);
  assert.match(dev.credentialDir,/fake-localappdata/);
});

test('navigation stays on the runtime origin and rejects unsafe protocols and local targets',async()=>{
  const origin='http://127.0.0.1:54321';
  assert.equal(navigationDecision(origin+'/help',origin),'internal');
  for(const target of ['http://127.0.0.1:54322/','file:///C:/secret','javascript:alert(1)','data:text/html,Hi','https://localhost/','not a url'])
    assert.equal(navigationDecision(target,origin),'deny',target);
  assert.equal(navigationDecision('https://example.com/help',origin),'external');
  const window=new FakeWindow({}),opened=[];
  secureWindowNavigation({window,appUrl:origin,shell:{openExternal:async url=>opened.push(url)},validate:async()=>{}});
  const blocked=preventable();window.webContents.emit('will-navigate',blocked,'file:///C:/secret');assert.equal(blocked.defaultPrevented,true);
  const internal=preventable();window.webContents.emit('will-navigate',internal,origin+'/help');assert.equal(internal.defaultPrevented,false);
  const external=preventable();window.webContents.emit('will-navigate',external,'https://example.com/help');assert.equal(external.defaultPrevented,true);
  const redirect=preventable();window.webContents.emit('will-redirect',redirect,'https://example.com/redirect');assert.equal(redirect.defaultPrevented,true);
  assert.deepEqual(window.openHandler({url:'https://example.com/new'}),{action:'deny'});
  assert.deepEqual(window.openHandler({url:origin+'/help'}),{action:'deny'});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(opened,['https://example.com/help','https://example.com/new']);
  assert.equal(window.url,origin+'/help');
  assert.deepEqual(window.openHandler({url:'javascript:alert(1)'}),{action:'deny'});
  let permission;window.permissionHandler(null,'camera',answer=>{permission=answer;});assert.equal(permission,false);
});
