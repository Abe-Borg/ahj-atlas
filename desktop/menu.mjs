// The desktop window's menu bar, in place of Electron's default File, Edit, View and Window menus.
// Every item does something in AHJ Atlas: a page action runs exactly what its button in the page
// runs (sent as an `atlas-menu` event naming one command from MENU_COMMANDS; public/app.js answers
// it), and a window action (zoom, full screen, reload) uses Electron's own role. Editing shortcuts
// such as Ctrl+C and Ctrl+V keep working in text fields on Windows without an Edit menu.
export const MENU_COMMANDS=Object.freeze(['new-research','export-addresses','settings','tab:overview','tab:contacts','tab:codes','tab:sources','tab:activity','chat','tour','guide','trust','diagnostics','updates','about']);

export function menuTemplate({run,closeWindow,updates=false,platform=process.platform}){
  const item=(label,command,accelerator)=>({label,...(accelerator?{accelerator}:{}),click:()=>run(command)});
  const separator={type:'separator'};
  return [
    // macOS needs its application and Edit menus for Cmd+Q and the clipboard shortcuts.
    ...(platform==='darwin'?[{role:'appMenu'},{role:'editMenu'}]:[]),
    {label:'&File',submenu:[
      item('New research','new-research','CmdOrCtrl+N'),
      item('Export addresses…','export-addresses'),
      separator,
      item('API and spending…','settings','CmdOrCtrl+,'),
      separator,
      {label:'Exit',click:closeWindow},
    ]},
    {label:'&View',submenu:[
      item('Overview','tab:overview','CmdOrCtrl+1'),
      item('Contacts','tab:contacts','CmdOrCtrl+2'),
      item('Codes and standards','tab:codes','CmdOrCtrl+3'),
      item('Sources','tab:sources','CmdOrCtrl+4'),
      item('Activity','tab:activity','CmdOrCtrl+5'),
      separator,
      item('Chat with Atlas','chat','CmdOrCtrl+J'),
      separator,
      {role:'zoomIn'},{role:'zoomOut'},{role:'resetZoom',label:'Actual size'},
      separator,
      {role:'togglefullscreen'},
      {role:'reload',label:'Reload page'},
    ]},
    {label:'&Help',submenu:[
      item('Take the guided tour','tour'),
      item('User guide','guide','F1'),
      item('Why trust it?','trust'),
      separator,
      item('Diagnostics…','diagnostics'),
      ...(updates?[item('Check for updates…','updates')]:[]),
      separator,
      item('About AHJ Atlas','about'),
    ]},
  ];
}

// Sends a menu command to the page. A command runs in the workspace page, so from the user guide
// (another page of the app) the workspace is opened first. Only the listed commands are sent.
export function menuRunner({window,appUrl,onError=()=>{}}){
  return async command=>{
    if(!MENU_COMMANDS.includes(command)||window.isDestroyed())return;
    try{
      const contents=window.webContents;
      let page='/';try{page=new URL(contents.getURL()).pathname;}catch{}
      if(page!=='/'&&command!=='guide')await window.loadURL(appUrl);
      await contents.executeJavaScript(`dispatchEvent(new CustomEvent('atlas-menu',{detail:${JSON.stringify(command)}}))`,true);
    }catch(error){onError(error);}
  };
}

export function installMenu({Menu,window,appUrl,updates=false,platform=process.platform,onError}){
  const template=menuTemplate({run:menuRunner({window,appUrl,onError}),closeWindow:()=>{if(!window.isDestroyed())window.close();},updates,platform});
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return template;
}
