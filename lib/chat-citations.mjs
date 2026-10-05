import { createHash } from 'node:crypto';
import { CHAT_LIMITS, LIMITS } from './config.mjs';
import { selectPassages, allocateEvidence } from './evidence.mjs';

const normalized=value=>String(value||'').replace(/\s+/g,' ').trim();
function reference(projectId,sourceId,content){return `ahj-source:${projectId}:${sourceId}:`+createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0,16);}
function citationChunks(text){
  const chunks=[];let start=0;
  while(start<text.length){
    let end=Math.min(start+600,text.length);
    if(end<text.length){const cut=Math.max(text.lastIndexOf('\n',end),text.lastIndexOf('. ',end));if(cut>start+200)end=cut+1;}
    chunks.push(text.slice(start,end));start=end;
  }
  return chunks;
}
function resultBlock(projectId,source,texts){
  const content=texts.flatMap(citationChunks).filter(text=>text.trim()).map(text=>({type:'text',text}));
  if(!source.read_full||!content.length)return null;
  return {type:'search_result',source:reference(projectId,source.id,content),title:`${source.id}: ${source.title}`.slice(0,500),content,citations:{enabled:true}};
}
// Excerpts from every retrieved source, shared out like the final review's evidence
// package and ranked toward the saved findings. The caller places the cache breakpoint.
export function initialChatEvidence(store,projectId,{characters=CHAT_LIMITS.excerptChars,sources=store.sources(projectId),sourceChars=Math.max(32000,Math.min(LIMITS.reviewSourceChars,Math.round(characters/6)))}={}){
  const p=store.project(projectId);sources=sources.filter(s=>s.read_full&&s.text.trim());
  // As in the final review, a larger budget lets one decisive source contribute more than 32,000 characters.
  const allocations=allocateEvidence(sources,characters,sourceChars),findings=store.stages(projectId).map(s=>s.output).join('\n').slice(0,60000);
  return sources.map((source,i)=>{
    const selected=selectPassages(source.text,{limit:allocations[i],input:p.input,findings,title:source.title,fill:true});
    return resultBlock(projectId,source,selected.spans.map(s=>source.text.slice(s.start,s.end)));
  }).filter(Boolean);
}
export function citedLookup(store,projectId,name,text){
  if(['read_source','render_page'].includes(name))return citedRead(store,projectId,text);
  if(name!=='read_saved_source')return text;
  const data=JSON.parse(text),source=store.sources(projectId).find(s=>s.id===data.sourceId);
  if(!source?.read_full||!data.readFull||!data.text?.trim())return text;
  // Saved lookups carry original offsets. Supply the actual spans as separate
  // citable blocks, keeping paging metadata outside the evidence itself.
  const spans=(data.spans||[]).filter(s=>Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&s.start>=0&&s.end>s.start&&s.end<=source.text.length);
  const texts=spans.map(s=>source.text.slice(s.start,s.end));
  if(texts.join('\n[Excerpt boundary]\n')!==data.text)return text;
  const block=resultBlock(projectId,source,texts);
  if(!block)return text;
  const {text:excerpt,...metadata}=data;
  // The API requires every block inside this tool result to be a search_result.
  // Put non-citable metadata in a sibling user text block after all tool results.
  return {content:[block],metadata};
}
// A public page chat just read joins the source register as retrieved text. The
// passage read is supplied as citable evidence under that saved source's ID.
function citedRead(store,projectId,text){
  let data;try{data=JSON.parse(text);}catch{return text;}
  const source=store.sources(projectId).find(s=>s.id===data.sourceId);
  if(!source?.read_full||typeof data.text!=='string'||!data.text.trim())return text;
  const block=resultBlock(projectId,source,[data.text]);
  if(!block)return text;
  const {text:excerpt,...metadata}=data;
  return {content:[block],metadata};
}
// URLs returned by web searches during this reply, in earlier requests or this response.
function searchedUrls(payload,message){
  const urls=new Set();
  const visit=blocks=>{for(const block of Array.isArray(blocks)?blocks:[])if(block?.type==='web_search_tool_result'&&Array.isArray(block.content))for(const r of block.content)if(typeof r?.url==='string')urls.add(r.url);};
  for(const m of payload.messages||[])if(m.role==='assistant')visit(m.content);
  visit(message.content);
  return urls;
}
const webUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}};
function submittedEvidence(payload){
  const results=[];
  function visit(blocks){for(const block of Array.isArray(blocks)?blocks:[]){if(block.type==='search_result')results.push(block);if(block.type==='tool_result'&&!block.is_error)visit(block.content);}}
  for(const message of payload.messages||[])if(message.role==='user')visit(message.content);
  return results;
}
export function chatAnswer(store,projectId,message,payload){
  const evidence=submittedEvidence(payload),sources=store.sources(projectId),searched=searchedUrls(payload,message);
  const parts=(message.content||[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(block=>({text:block.text,citations:(block.citations||[]).flatMap(c=>{
    // A web search snippet is a lead to a page, never evidence. Keep it only when
    // its URL came back from a search in this reply.
    if(c.type==='web_search_result_location'){
      const url=webUrl(c.url);
      if(!url||!searched.has(c.url)||typeof c.cited_text!=='string'||!c.cited_text.trim())return [];
      return [{kind:'lead',url,title:String(c.title||new URL(url).hostname).slice(0,300),quote:c.cited_text.slice(0,600)}];
    }
    if(c.type!=='search_result_location'||!Number.isSafeInteger(c.search_result_index)||c.search_result_index<0||!Number.isSafeInteger(c.start_block_index)||!Number.isSafeInteger(c.end_block_index)||c.start_block_index<0||c.end_block_index<=c.start_block_index||typeof c.cited_text!=='string'||!c.cited_text.trim())return [];
    // The source includes a digest of the submitted excerpt. Never trust a
    // model-provided URL/title or substitute newer text for the cited passage.
    const supplied=evidence[c.search_result_index];
    if(!supplied||supplied.source!==c.source||!supplied.citations?.enabled||c.end_block_index>supplied.content.length)return [];
    const source=sources.find(s=>s.read_full&&reference(projectId,s.id,supplied.content)===c.source);
    if(!source)return [];
    const texts=supplied.content.slice(c.start_block_index,c.end_block_index).map(b=>b.text);
    if(!['','\n'].some(separator=>normalized(texts.join(separator))===normalized(c.cited_text)))return [];
    return [{sourceId:source.id,title:source.title,quote:c.cited_text}];
  })}));
  // Native citation text blocks are consecutive fragments of one answer.
  return {answer:parts.map(p=>p.text).join(''),answer_parts:parts};
}
