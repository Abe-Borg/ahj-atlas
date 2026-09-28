export async function startDesktop({app,BrowserWindow,createBackend,dataDir,provider,onError=console.error}){
  if(!app.requestSingleInstanceLock()){
    app.quit();
    return {primary:false};
  }

  let window=null,backend=null,closing=null,allowQuit=false;
  const focusWindow=()=>{
    if(!window||window.isDestroyed())return;
    if(window.isMinimized())window.restore();
    window.show();
    window.focus();
  };
  app.on('second-instance',focusWindow);
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(allowQuit||!backend)return;
    event.preventDefault();
    if(!closing)closing=Promise.resolve().then(()=>backend.close()).catch(onError).finally(()=>{
      backend=null;
      allowQuit=true;
      app.quit();
    });
  });

  try{
    await app.whenReady();
    backend=await createBackend({dataDir,port:0,provider});
    window=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:650,
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.on('closed',()=>{window=null;});
    await window.loadURL(backend.url);
    return {primary:true,url:backend.url,window,backend,focusWindow,closed:()=>closing};
  }catch(error){
    onError(error);
    if(backend)await backend.close().catch(onError);
    allowQuit=true;
    app.quit();
    throw error;
  }
}
