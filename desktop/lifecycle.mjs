import { preflightWorkspace } from './migration.mjs';
import { secureWindowNavigation } from './navigation.mjs';
import { restoredBounds, saveWindowBounds } from './window-state.mjs';

function activeWork(backend){
  const services=backend?.services;
  return Boolean(services?.engine?.running?.size||services?.engine?.polling?.size
    ||services?.engine?.applying?.size||services?.chat?.running?.size
    ||backend?.store?.hasPendingRequests?.());
}

export async function startDesktop({app,BrowserWindow,createBackend,resolvePaths,dataDir,provider,
  dialog,screen,shell,preflight=preflightWorkspace,onError=console.error,diagnostics=false,migrationChoice=null}){
  if(!app.requestSingleInstanceLock()){
    app.quit();
    return {primary:false};
  }

  let window=null,backend=null,closing=null,allowQuit=false,allowWindowClose=false,confirming=false,pendingFocus=false;
  const focusWindow=()=>{
    if(!window||window.isDestroyed()){pendingFocus=true;return;}
    if(window.isMinimized())window.restore();
    window.show();
    window.focus();
  };
  const closeBackend=()=>{
    if(!closing)closing=Promise.resolve().then(()=>backend?.close()).catch(onError).finally(()=>{backend=null;});
    return closing;
  };
  app.on('second-instance',focusWindow);
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(allowQuit||!backend)return;
    event.preventDefault();
    void closeBackend().finally(()=>{
      allowQuit=true;
      allowWindowClose=true;
      app.quit();
    });
  });

  try{
    await app.whenReady();
    const paths=resolvePaths?resolvePaths():{dataDir,migrationEnabled:false};
    const migration=await preflight({paths,prompt:async({hinted})=>{
      if(migrationChoice)return migrationChoice;
      if(!dialog)throw new Error('A migration choice is required before opening this workspace.');
      const {response}=await dialog.showMessageBox({type:'question',title:'AHJ Atlas workspace',
        message:hinted?'Import the existing AHJ Atlas workspace?':'Do you have an AHJ Atlas source workspace to import?',
        detail:'Importing preserves the original data folder as a backup. Start fresh if you have no previous workspace.',
        buttons:['Import existing workspace','Start fresh','Quit'],defaultId:hinted?0:1,cancelId:2,noLink:true});
      return ['import','fresh','cancel'][response];
    },selectDirectory:async()=>{
      const result=await dialog.showOpenDialog({title:'Choose the AHJ Atlas source folder or data folder',properties:['openDirectory']});
      return result.canceled?null:result.filePaths[0];
    }});
    if(migration.decision==='cancel'){
      allowQuit=true;
      app.quit();
      return {primary:true,canceled:true};
    }
    const options={dataDir:paths.dataDir,port:0,provider};
    if(paths.credentialDir)options.vaultDir=paths.credentialDir;
    backend=await createBackend(options);
    const bounds=restoredBounds(paths.userData,screen);
    window=new BrowserWindow({...bounds,minWidth:900,minHeight:650,
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,devTools:diagnostics||!paths.packaged}});
    if(shell)secureWindowNavigation({window,appUrl:backend.url,shell,onError});
    if(paths.packaged&&!diagnostics)window.webContents.on('devtools-opened',()=>window.webContents.closeDevTools());
    window.on('close',event=>{
      if(paths.userData)saveWindowBounds(paths.userData,window);
      if(allowWindowClose||!activeWork(backend)||!dialog)return;
      event.preventDefault();
      if(confirming)return;
      confirming=true;
      void dialog.showMessageBox(window,{type:'warning',title:'Finish current work before closing?',
        message:'A research or chat request is still active.',
        detail:'AHJ Atlas waits for locally active requests to finish and save their outcome. A submitted batch may continue at the provider after the app exits; reopen the app to check it.',
        buttons:['Keep open','Close AHJ Atlas'],defaultId:0,cancelId:0,noLink:true}).then(({response})=>{
        if(response===1){allowWindowClose=true;app.quit();}
      }).catch(onError).finally(()=>{confirming=false;});
    });
    window.on('closed',()=>{window=null;app.quit();});
    for(const event of ['query-session-end','session-end'])window.on(event,()=>{
      void closeBackend().finally(()=>{allowQuit=true;allowWindowClose=true;app.quit();});
    });
    window.webContents.on('render-process-gone',()=>{
      onError(new Error('The desktop window stopped unexpectedly. Reopen AHJ Atlas to continue saved work.'));
      app.quit();
    });
    await window.loadURL(backend.url);
    window.show();
    if(pendingFocus)focusWindow();
    return {primary:true,url:backend.url,window,backend,paths,migration,focusWindow,closed:()=>closing};
  }catch(error){
    onError(error);
    dialog?.showErrorBox('AHJ Atlas could not start',String(error?.message||'The local service failed to start.').replace(/sk-ant-[\w-]+/g,'[redacted]'));
    if(backend)await closeBackend();
    allowQuit=true;
    allowWindowClose=true;
    app.quit();
    throw error;
  }
}
