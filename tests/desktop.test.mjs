import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startDesktop } from '../desktop/lifecycle.mjs';

class FakeApp extends EventEmitter{
  constructor(lock=true){super();this.lock=lock;this.quits=0;}
  requestSingleInstanceLock(){return this.lock;}
  whenReady(){return Promise.resolve();}
  quit(){this.quits++;const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};this.emit('before-quit',event);return !event.defaultPrevented;}
}
class FakeWindow extends EventEmitter{
  static instances=[];
  constructor(options){super();this.options=options;this.actions=[];this.minimized=false;FakeWindow.instances.push(this);}
  async loadURL(url){this.url=url;}
  isDestroyed(){return false;}
  isMinimized(){return this.minimized;}
  restore(){this.actions.push('restore');this.minimized=false;}
  show(){this.actions.push('show');}
  focus(){this.actions.push('focus');}
}

test('bootstrap uses an ephemeral port, sandboxed renderer and returned loopback URL',async()=>{
  const app=new FakeApp(),calls=[];
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,dataDir:'synthetic-desktop-dir',
    createBackend:async options=>{calls.push(options);return {url:'http://127.0.0.1:54321',close:async()=>{}};}});
  assert.equal(desktop.primary,true);
  assert.deepEqual(calls,[{dataDir:'synthetic-desktop-dir',port:0,provider:undefined}]);
  assert.equal(desktop.window.url,'http://127.0.0.1:54321');
  assert.deepEqual(desktop.window.options.webPreferences,{nodeIntegration:false,contextIsolation:true,sandbox:true});
  assert.equal(desktop.window.options.webPreferences.preload,undefined);
});

test('second launch exits; second-instance event restores and focuses primary window',async()=>{
  const secondary=new FakeApp(false);
  const rejected=await startDesktop({app:secondary,BrowserWindow:FakeWindow,dataDir:'unused',createBackend:()=>{throw Error('must not start');}});
  assert.equal(rejected.primary,false);assert.equal(secondary.quits,1);
  const primary=new FakeApp();
  const desktop=await startDesktop({app:primary,BrowserWindow:FakeWindow,dataDir:'synthetic',createBackend:async()=>({url:'http://127.0.0.1:12345',close:async()=>{}})});
  desktop.window.minimized=true;primary.emit('second-instance');
  assert.deepEqual(desktop.window.actions,['restore','show','focus']);
});

test('quit awaits backend close before releasing Electron to exit',async()=>{
  const app=new FakeApp();let resolveClose,closed=false;
  const backend={url:'http://127.0.0.1:12345',close:()=>new Promise(resolve=>{resolveClose=()=>{closed=true;resolve();};})};
  const desktop=await startDesktop({app,BrowserWindow:FakeWindow,dataDir:'synthetic',createBackend:async()=>backend});
  assert.equal(app.quit(),false);
  assert.equal(app.quits,1);
  await Promise.resolve();
  assert.equal(closed,false);
  resolveClose();await desktop.closed();
  assert.equal(closed,true);assert.equal(app.quits,2);
  assert.equal(app.quit(),true);
});

test('startup failure closes an already-started backend',async()=>{
  const app=new FakeApp();let closes=0;
  class FailedWindow extends FakeWindow{async loadURL(){throw new Error('load failed');}}
  await assert.rejects(startDesktop({app,BrowserWindow:FailedWindow,dataDir:'synthetic',onError:()=>{},createBackend:async()=>({url:'http://127.0.0.1:12345',close:async()=>{closes++;}})}),/load failed/);
  assert.equal(closes,1);assert.equal(app.quits,1);
});
