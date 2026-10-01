import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { safeDownloadName } from '../lib/download-filename.mjs';

function exportRequest(url,appUrl){
  try{
    const target=new URL(url),home=new URL(appUrl);
    if(target.origin!==home.origin||target.protocol!=='http:'||target.username||target.password)return null;
    if(/^\/api\/projects\/[a-f0-9-]+\/export$/.test(target.pathname)){
      if([...target.searchParams.keys()].some(key=>key!=='format'))return null;
      const format=target.searchParams.get('format')||'pdf';
      return {pdf:{extension:'pdf',label:'PDF report'},xlsx:{extension:'xlsx',label:'Excel workbook'},'xlsx-essentials':{extension:'xlsx',label:'Excel essentials'},json:{extension:'json',label:'JSON data'}}[format]||null;
    }
    if(target.pathname==='/api/diagnostics/download'){
      if([...target.searchParams.keys()].some(key=>key!=='project'))return null;
      return {extension:'json',label:'JSON data'};
    }
  }catch{}
  return null;
}

export function exportDownload(url,appUrl){
  const request=exportRequest(url,appUrl);
  return request?request.extension:null;
}

export function downloadFilename(value,extension){
  const filename=path.win32.basename(String(value||''));
  if(filename!==value)return null;
  if(!filename.toLowerCase().endsWith(`.${extension}`))return null;
  const stem=filename.slice(0,-extension.length-1);
  if(!stem||safeDownloadName(stem,120)!==stem)return null;
  return filename;
}

export function handleDesktopDownloads({window,appUrl,dialog,downloadsDir,tempDir=os.tmpdir(),onError=()=>{}}){
  const contents=window.webContents,origin=new URL(appUrl).origin;
  const notice=async(message,type='info')=>{
    if(window.isDestroyed())return;
    await dialog.showMessageBox(window,{type,title:'AHJ Atlas export',message,buttons:['OK'],noLink:true});
    if(!window.isDestroyed())window.focus();
  };
  const handler=(_event,item,source)=>{
    const request=exportRequest(item.getURL(),appUrl);
    const format=request?request.extension:null;
    const chain=item.getURLChain();
    const filename=format?downloadFilename(item.getFilename(),format):null;
    if(source!==contents||item.getInitiatorOrigin()!==origin||!filename
      ||!chain.length||chain.some(url=>!exportDownload(url,appUrl))){
      item.cancel();return;
    }
    let staging;
    try{
      staging=mkdtempSync(path.join(tempDir,'ahj-atlas-export-'));
      item.setSavePath(path.join(staging,filename));
    }catch(error){
      item.cancel();onError(error);
      if(staging)void rm(staging,{recursive:true,force:true}).catch(onError);
      void notice('The export could not be prepared. Try again.','error').catch(onError);
      return;
    }
    item.once('done',(_done,state)=>{
      void (async()=>{
        try{
          if(state==='cancelled')return await notice('Export canceled.');
          if(state!=='completed')return await notice('The export could not be downloaded. Try again.','error');
          if(window.isDestroyed())return;
          const selection=await dialog.showSaveDialog(window,{title:'Save AHJ Atlas export',
            defaultPath:path.join(downloadsDir,filename),filters:[{name:request.label,extensions:[format]}],
            properties:['showOverwriteConfirmation']});
          if(selection.canceled||!selection.filePath)return await notice('Export canceled.');
          if(path.extname(selection.filePath).toLowerCase()!==`.${format}`)
            return await notice(`Choose a .${format} filename and export again.`,'error');
          try{
            await copyFile(path.join(staging,filename),selection.filePath,constants.COPYFILE_EXCL);
            return await notice(`${filename} was saved.`);
          }catch(error){
            if(error.code!=='EEXIST')throw error;
            return await notice('That file already exists. Choose a different name and export again.');
          }
        }catch(error){onError(error);await notice('The export could not be saved. Try again.','error').catch(onError);}
        finally{await rm(staging,{recursive:true,force:true}).catch(onError);}
      })();
    });
  };
  contents.session.on('will-download',handler);
  return ()=>contents.session.off('will-download',handler);
}
