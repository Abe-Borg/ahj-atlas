const INVALID=/[<>:"/\\|?*\x00-\x1f\x7f]/g;

export function safeDownloadName(value,maxLength=80){
  const name=[...String(value||'').normalize('NFC').replace(INVALID,'').replace(/\s+/g,' ').trim().replace(/[. ]+$/g,'')]
    .slice(0,maxLength).join('').replace(/[. ]+$/g,'');
  const deviceName=name.split('.')[0].trimEnd();
  return name&&!/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(deviceName)?name:'Project';
}

export function projectExportFilename(projectName,extension,{essentials=false}={}){
  if(!['pdf','xlsx','json'].includes(extension))throw new Error('Unsupported export format.');
  return `${safeDownloadName(projectName)} - AHJ research${essentials?' essentials':''}.${extension}`;
}

const localDay=date=>[date.getFullYear(),date.getMonth()+1,date.getDate()].map(n=>String(n).padStart(2,'0')).join('-');

// Dated so a later export of a different selection is easy to tell apart.
export function addressExportFilename(extension,date=new Date()){
  if(!['csv','xlsx'].includes(extension))throw new Error('Unsupported export format.');
  return `AHJ Atlas project addresses ${localDay(date)}.${extension}`;
}

// A whole-workspace file for a teammate to import, dated like the address export.
export const WORKSPACE_EXTENSION='ahjatlas';
export function workspaceExportFilename(date=new Date()){
  return `AHJ Atlas workspace ${localDay(date)}.${WORKSPACE_EXTENSION}`;
}

export function attachmentDisposition(filename){
  const fallback=filename.replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_');
  const encoded=encodeURIComponent(filename).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
