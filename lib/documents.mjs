import { createHash } from 'node:crypto';
import { LIMITS } from './config.mjs';
import { recordExhausted } from './diagnostics.mjs';

export const uploadLimitMb=Math.round(LIMITS.documentBytes/1048576);
// Only the file's own name is kept: no folder path and no control characters.
export const documentName=value=>String(value||'').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g,'').replace(/\s+/g,' ').trim().slice(0,200)||'Document';
// A document the user adds joins the source register as retrieved text of kind 'upload',
// addressed by its content, so adding the same file again updates the same source.
export async function addDocument(store,tools,projectId,{name,type='',buffer}){
  if(!store.project(projectId))throw new Error('Project not found.');
  if(!buffer?.length)throw new Error('Choose a document to add.');
  if(buffer.length>LIMITS.documentBytes){recordExhausted(store,{projectId,resource:'document_bytes',limit:LIMITS.documentBytes,used:buffer.length,outcome:'refused'});throw new Error(`Add a document of ${uploadLimitMb} MB or less.`);}
  const title=documentName(name),{text,format,clipped}=await tools.documentText(buffer,{name:title,type:String(type)});
  if(clipped)recordExhausted(store,{projectId,...clipped});
  if(!text.trim())throw new Error('No text could be read from this document. A scanned PDF needs text recognition (OCR) before it can be added.');
  const hash=createHash('sha256').update(buffer).digest('hex').slice(0,16);
  const source=store.source(projectId,{url:`upload:${hash}/${encodeURIComponent(title)}`,title,text,readFull:true,kind:'upload',limit:LIMITS.uploadChars});
  store.event(projectId,'source',`Added your document “${title}” as ${source.id} (${format}). Chat can use it now; continue research to include it in the report.`);
  store.diagnostic('source.uploaded',{projectId,format,bytes:buffer.length,characters:source.text.length});
  return source;
}
