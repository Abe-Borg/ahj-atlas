import { validatePublicUrl } from '../lib/research-tools.mjs';

export function navigationDecision(target,appUrl){
  try{
    const url=new URL(target),home=new URL(appUrl);
    if(url.username||url.password)return 'deny';
    if(url.protocol==='http:'&&url.origin===home.origin)return 'internal';
    if(!['http:','https:'].includes(url.protocol))return 'deny';
    const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||!host.includes('.')||/^127\.|^10\.|^192\.168\.|^169\.254\./.test(host))return 'deny';
    return 'external';
  }catch{return 'deny';}
}

export function secureWindowNavigation({window,appUrl,shell,validate=validatePublicUrl,onError=()=>{}}){
  const contents=window.webContents;
  const openExternal=async target=>{
    if(navigationDecision(target,appUrl)!=='external')return;
    try{await validate(target);await shell.openExternal(target);}
    catch(error){onError(error);}
  };
  contents.on('will-navigate',(event,target)=>{
    const decision=navigationDecision(target,appUrl);
    if(decision==='internal')return;
    event.preventDefault();
    if(decision==='external')void openExternal(target);
  });
  contents.on('will-redirect',(event,target)=>{
    if(navigationDecision(target,appUrl)!=='internal')event.preventDefault();
  });
  contents.on('will-attach-webview',event=>event.preventDefault());
  contents.setWindowOpenHandler(({url})=>{
    const decision=navigationDecision(url,appUrl);
    if(decision==='internal')void window.loadURL(url).catch(onError);
    if(decision==='external')void openExternal(url);
    return {action:'deny'};
  });
  contents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
}
