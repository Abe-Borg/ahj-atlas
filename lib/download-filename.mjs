const INVALID=/[<>:"/\\|?*\x00-\x1f\x7f]/g;

export function safeDownloadName(value,maxLength=80){
  const name=[...String(value||'').normalize('NFC').replace(INVALID,'').replace(/\s+/g,' ').trim().replace(/[. ]+$/g,'')]
    .slice(0,maxLength).join('').replace(/[. ]+$/g,'');
  return name&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)?name:'Project';
}

export function projectExportFilename(projectName,extension){
  if(!['pdf','xlsx','json'].includes(extension))throw new Error('Unsupported export format.');
  return `${safeDownloadName(projectName)} - AHJ research.${extension}`;
}

export function attachmentDisposition(filename){
  const fallback=filename.replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_');
  const encoded=encodeURIComponent(filename).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
