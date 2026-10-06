import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, FETCH_HISTORY_CHARS } from './config.mjs';
import { recordExhausted } from './diagnostics.mjs';
import { selectPassages } from './evidence.mjs';
import { isUnitedStates, countryName, regionIn, countrySuffix, isPostalPart, STATES, PROVINCES, PROVINCE_TIMEZONES } from '../public/location.js';

export function isPublicIP(address){
  if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===192&&b===0)||(a===198&&(b===18||b===19)));}
  if(net.isIP(address)===6){const v=address.toLowerCase();if(v.startsWith('::ffff:')){const tail=v.slice(7);if(net.isIP(tail)===4)return isPublicIP(tail);return false;}return /^2[0-9a-f]{3}:|^3[0-9a-f]{3}:/.test(v)&&!v.startsWith('2001:db8:');}
  return false;
}
export async function validatePublicUrl(value){
  let url;try{url=new URL(value);}catch{throw new Error('Use a complete public website URL.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port)))throw new Error('Only public HTTP/HTTPS websites on standard ports are available.');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(host==='localhost'||host.endsWith('.local')||host.endsWith('.localhost')||!host.includes('.')&&!net.isIP(host))throw new Error('Local and private network addresses are blocked.');
  const answers=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await dns.lookup(host,{all:true});
  if(!answers.length||answers.some(a=>!isPublicIP(a.address)))throw new Error('Local and private network addresses are blocked.');
  return {url,answers};
}
// The 50 MB document cap refuses the URL. Smaller fetch limits (a browser subrequest, a geocode) do not.
export function oversizedDocument(used,maxBytes=LIMITS.documentBytes,stream=false){
  const error=new Error(stream?'Source exceeds the document size limit.':`Document exceeds the ${Math.round(maxBytes/1048576)} MB reading limit. Read a smaller document or a specific public page.`);
  if(maxBytes===LIMITS.documentBytes)error.exhausted={resource:'document_bytes',limit:maxBytes,used:Number(used),outcome:'refused'};
  return error;
}
export async function fetchPublic(value,{maxBytes=LIMITS.documentBytes,redirects=0}={}){
  if(redirects>5)throw new Error('This website redirected too many times.');
  const {url,answers}=await validatePublicUrl(value),resolved=answers[0];
  const result=await new Promise((resolve,reject)=>{
    const transport=url.protocol==='https:'?https:http;
    const req=transport.get(url,{headers:{'User-Agent':'AHJAtlas/1.0 (public jurisdiction research)','Accept':'text/html,application/pdf,application/json,text/plain;q=0.9','Accept-Encoding':'identity'},lookup:(hostname,options,callback)=>options.all?callback(null,[resolved]):callback(null,resolved.address,resolved.family)},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();resolve({redirect:new URL(res.headers.location,url).href});return;}
      // The failed URL is named so web_fetch, which opens only URLs already in the conversation, can retry it.
      if(res.statusCode<200||res.statusCode>=300){res.resume();reject(new Error(`Source returned HTTP ${res.statusCode} for ${url.href}.`));return;}
      if(Number(res.headers['content-length']||0)>maxBytes){res.destroy();reject(oversizedDocument(Number(res.headers['content-length']),maxBytes));return;}
      let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy(oversizedDocument(size,maxBytes,true));return;}chunks.push(chunk);});
      res.on('end',()=>resolve({url:url.href,buffer:Buffer.concat(chunks),type:String(res.headers['content-type']||''),modified:String(res.headers['last-modified']||'')}));res.on('error',reject);
    });
    req.setTimeout(25000,()=>req.destroy(new Error('The source did not respond within 25 seconds.')));req.on('error',reject);
  });
  return result.redirect?fetchPublic(result.redirect,{maxBytes,redirects:redirects+1}):result;
}
function entities(text){return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x[\da-f]+|#\d+);/gi,s=>{const map={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '};if(map[s.toLowerCase()])return map[s.toLowerCase()];const n=s[2]?.toLowerCase()==='x'?parseInt(s.slice(3,-1),16):parseInt(s.slice(2,-1),10);return Number.isFinite(n)&&n<=0x10ffff?String.fromCodePoint(n):s;});}
// The links a read shows the model, most relevant first.
const markDropped=(selected,total)=>{if(total>selected.length)Object.defineProperty(selected,'dropped',{value:total});return selected;};
export function sourceLinks(links,limit=LIMITS.pageLinks){
  const score=l=>/adopt|ordinance|\bNFPA\b|\bSPS\s*\d|plan.review|permit|building|fire|contact|staff|inspection|amendment|reference|code|delegat/i.test(l.title)?2:0;
  const ranked=[...new Map(links.map(l=>[l.url,l])).values()].filter(l=>l.title&&!/^(home|help|feedback|show tree|hide tree|senate|assembly|committees|session|preferences|documents|feeds|options|skip navigation)$/i.test(l.title)).sort((a,b)=>score(b)-score(a));
  return markDropped(ranked.slice(0,limit),ranked.length);
}
// Every distinct link on a page, bounded, so chat may open any of them.
export const pageLinks=links=>{const all=[...new Map(links.map(l=>[l.url,l])).values()];return markDropped(all.slice(0,LIMITS.savedLinks),all.length);};
export function htmlText(html,url){
  const title=entities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||new URL(url).hostname).replace(/<[^>]*>/g,'').trim();
  const page=html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi,' ').replace(/<!--[\s\S]*?-->/g,'');
  // Links come from the whole page: city and county sites often link their permit, fire
  // prevention and code pages only from menus and footers. The text leaves those out.
  const links=[];for(const match of page.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    try{const target=new URL(entities(match[1]),url);if(['http:','https:'].includes(target.protocol))links.push({title:entities(match[2].replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim().slice(0,160),url:target.href});}catch{}
  }
  const clean=page.replace(/<(nav|footer)[\s\S]*?<\/\1>/gi,' ');
  // Adjacent table cells are joined with " | ", so adoption tables and fee schedules keep their columns.
  const text=entities(clean.replace(/<\/t[dh]\s*>\s*(?=<t[dh][\s>])/gi,' | ').replace(/<(?:br|\/p|\/div|\/h\d|\/li|\/tr|\/section)[^>]*>/gi,'\n').replace(/<[^>]*>/g,' ')).replace(/[\t ]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
  return {title,text,links:sourceLinks(links),allLinks:pageLinks(links)};
}
export function browserPath(){return [process.env.ATLAS_BROWSER,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean).find(existsSync)||null;}
// Countries, states and provinces are shared with the browser form.
export { isUnitedStates };
// Localizes web search to the city and state or province read from a project's address.
// A US project always sends its country. A Canadian project sends its city, province and
// the province's time zone but no country code: the search API rejects country codes it
// does not support, and Canada's has not been confirmed. Other countries get no location.
const LOCALES={'United States':{regions:STATES,country:'US'},Canada:{regions:PROVINCES,timezones:PROVINCE_TIMEZONES}};
export function searchLocation(input={}){
  const name=isUnitedStates(input.country||'United States')?'United States':countryName(input.country),locale=LOCALES[name];
  if(!locale)return null;
  // A part naming the project's own country is not the address ("…, USA"; "…, ON, CA").
  const parts=String(input.address||'').split(',').map(s=>s.trim()).filter(s=>s&&countryName(s)!==name);
  // "… IL 62701 United States": a country after the state without a comma.
  const suffix=parts.length?countrySuffix(parts.at(-1)):null;
  if(suffix?.country===name){if(suffix.rest)parts[parts.length-1]=suffix.rest;else parts.pop();}
  for(let i=parts.length-1;i>=0;i--){
    // A street line ending in a direction or a street type ("Main St NE", "Oak Ct") is not
    // a state; it counts only when it is the whole address or a ZIP or postal code follows it.
    if(parts.length>1&&/^\d/.test(parts[i])&&!isPostalPart(parts[i+1]))continue;
    const found=regionIn(parts[i],locale.regions);if(!found)continue;
    // A city has no digits; a remainder with a street number is not one.
    const city=[found.rest,parts[i-1]||''].find(c=>c&&/^[\p{L}][\p{L} .'’-]{1,60}$/u.test(c))||'';
    return {type:'approximate',...(city?{city}:{}),region:found.region,...(locale.country?{country:locale.country}:{timezone:locale.timezones[found.region]})};
  }
  return locale.country?{type:'approximate',country:locale.country}:null;
}
// Anthropic's server-side web tools, shared by research and chat. The basic versions run
// only as direct calls, without code execution, and are eligible for zero data retention.
export function searchTool(maxUses,input){const location=searchLocation(input);return {type:'web_search_20250305',name:'web_search',max_uses:maxUses,allowed_callers:['direct'],...(location?{user_location:location}:{})};}
// A fallback reader for pages the local reader cannot open: it runs on Anthropic's servers
// and opens only URLs already in the conversation. Pages it returns join the register.
export const fetchTool=maxUses=>({type:'web_fetch_20250910',name:'web_fetch',max_uses:maxUses,max_content_tokens:LIMITS.fetchContentTokens});
// Inspect the wire content, independently of extraction or provider token counts. PDFs
// have no max_content_tokens cap; even an unreadable PDF must not ride along indefinitely.
export function fetchedHistory(messages){
  let pdfs=0,characters=0;
  for(const message of messages||[])if(message.role==='assistant')for(const block of message.content||[]){
    if(block.type!=='web_fetch_tool_result'||block.content?.type!=='web_fetch_result')continue;
    const source=block.content.content?.source;
    if(source?.type==='base64'&&source.media_type==='application/pdf')pdfs++;
    else if(source?.type==='text'&&typeof source.data==='string')characters+=source.data.length;
  }
  return {pdfs,characters,exhausted:pdfs>0||characters>=FETCH_HISTORY_CHARS};
}
// Search results and web citations are discovery leads: they join the source
// register without retrieved text. Research and chat share this capture.
export function captureSearchSources(store,projectId,message,context={}){
  for(const block of message?.content||[]){
    if(block.type==='web_search_tool_result'){
      if(Array.isArray(block.content))for(const source of block.content)if(source.url)store.source(projectId,{url:source.url,title:source.title||'',readFull:false});
      if(block.content?.type?.includes('error')){store.event(projectId,'warning',`A search could not finish (${block.content.error_code||'tool error'}).`);store.diagnostic('search.failed',{level:'warning',projectId,...context,errorCode:block.content.error_code||'tool_error'});if(block.content.error_code==='max_uses_exceeded')recordExhausted(store,{projectId,stageId:context.stageId,attemptId:context.attemptId,resource:'searches',scope:'request',limit:context.maxUses,used:context.maxUses,outcome:'refused'});}
    }
    for(const c of block.citations||[]){const url=c.url||c.source;if(url)store.source(projectId,{url,title:c.title||'',text:c.cited_text||'',readFull:false});}
  }
}
export class ResearchTools{
  // pageChars is the most text one read returns: research's LIMITS.pageChars, or chat's larger lookups.
  constructor(store,{fetchImpl=fetchPublic,pageChars=LIMITS.pageChars}={}){this.store=store;this.cache=new Map();this.pending=new Map();this.fetch=fetchImpl;this.pageChars=pageChars;}
  async document(url){
    const key=String(url),cached=this.cache.get(key);
    if(cached&&Date.now()-cached.time<300000)return cached.result;
    if(this.pending.has(key))return this.pending.get(key);
    const request=Promise.resolve().then(()=>this.fetch(key)).then(result=>{
      this.cache.set(key,{time:Date.now(),result});
      while(this.cache.size>12)this.cache.delete(this.cache.keys().next().value);
      return result;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,request);return request;
  }
  async pdf(buffer){const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');return getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:true,disableFontFace:true}).promise;}
  // All text of a PDF with page labels, up to maxChars. Pages without text get no label, so
  // a scanned PDF with no text layer yields no text at all.
  async pdfText(buffer,maxChars=180000){
    const pdf=await this.pdf(buffer);let text='';
    try{for(let n=1;n<=pdf.numPages&&text.length<maxChars;n++){const content=await (await pdf.getPage(n)).getTextContent(),body=content.items.map(x=>x.str+(x.hasEOL?'\n':' ')).join('');if(body.trim())text+=`\n[PDF page ${n}]\n`+body;}}
    finally{await pdf.loadingTask.destroy();}
    const full=text.trim();
    return {text:full.slice(0,maxChars),used:full.length};
  }
  // Saves each page a response fetched through Anthropic's web_fetch as retrieved text in
  // the register, so later research, chat and the report can quote and cite it.
  async captureFetches(projectId,message,{label='Research',...context}={}){
    for(const block of message?.content||[]){
      if(block?.type!=='web_fetch_tool_result')continue;
      const result=block.content||{};
      if(result.type!=='web_fetch_result'){const code=String(result.error_code||'tool_error').slice(0,40);this.store.event(projectId,'warning',`${label}: a page fetch through Anthropic could not finish (${code}).`);this.store.diagnostic('fetch.failed',{level:'warning',projectId,...context,errorCode:code});if(code==='max_uses_exceeded')recordExhausted(this.store,{projectId,stageId:context.stageId,attemptId:context.attemptId,resource:'fetches',scope:'request',limit:context.maxUses,used:context.maxUses,outcome:'refused'});continue;}
      const doc=result.content||{},src=doc.source||{};let text='',used=0;
      try{
        if(src.type==='text'&&typeof src.data==='string'){text=src.data;used=src.data.length;}
        else if(src.type==='base64'&&src.media_type==='application/pdf'&&typeof src.data==='string'){const extracted=await this.pdfText(Buffer.from(src.data,'base64'));text=extracted.text;used=extracted.used;}
      }catch(e){this.store.diagnostic('fetch.extract_failed',{level:'warning',projectId,...context,error:{message:String(e?.message||e).slice(0,200)}});}
      const providerTruncated=result.truncated===true||doc.truncated===true||result.content?.truncated===true;
      const registerLimit=180000;
      if(providerTruncated)recordExhausted(this.store,{projectId,stageId:context.stageId,attemptId:context.attemptId,resource:'fetch_content_tokens',limit:LIMITS.fetchContentTokens,used:Number.isFinite(Number(result.content_token_count))?Number(result.content_token_count):null,outcome:'clipped'});
      else if(used>registerLimit)recordExhausted(this.store,{projectId,stageId:context.stageId,attemptId:context.attemptId,resource:'fetch_content_tokens',limit:registerLimit,used,outcome:'clipped'});
      text=text.slice(0,registerLimit);
      const source=this.store.source(projectId,{url:String(result.url||''),title:String(doc.title||'').slice(0,300),text,readFull:Boolean(text.trim()),kind:'web-fetch'});
      if(source)this.store.event(projectId,'source',`${label}: fetched a public ${src.media_type==='application/pdf'?'PDF':'page'} through Anthropic's web fetch (${source.id}).`);
    }
  }
  // Text of a document the user adds to the project: PDF, HTML or plain text.
  async documentText(buffer,{name='',type=''}={}){
    const unsupported='Add a PDF, HTML or plain-text document. Save other formats, such as Word, as PDF first.';
    const clipped=used=>used>LIMITS.uploadChars?{clipped:{resource:'saved_source_characters',limit:LIMITS.uploadChars,used,outcome:'clipped'}}:{};
    if(/\bpdf\b/i.test(type)||buffer.subarray(0,5).toString()==='%PDF-'){const extracted=await this.pdfText(buffer,LIMITS.uploadChars);return {text:extracted.text,format:'PDF',...clipped(extracted.used)};}
    // Word, Excel and other zipped or binary files are refused rather than read as garbled text.
    if(buffer.subarray(0,4).toString('latin1')==='PK\u0003\u0004'||buffer.subarray(0,4096).includes(0))throw new Error(unsupported);
    if(/^(?:text\/html|application\/xhtml\+xml)\b/i.test(type)||/\.x?html?$/i.test(name)){const raw=htmlText(buffer.toString('utf8'),'https://upload.invalid/').text;return {text:raw.slice(0,LIMITS.uploadChars),format:'HTML',...clipped(raw.length)};}
    if(/^(?:text\/|application\/json\b)/i.test(type)||/\.(?:txt|text|md|markdown|csv|json)$/i.test(name)){const raw=buffer.toString('utf8').replace(/\r\n?/g,'\n');return {text:raw.slice(0,LIMITS.uploadChars),format:'text',...clipped(raw.length)};}
    throw new Error(unsupported);
  }
  async read(projectId,input,context){const prepared=await this.prepareRead(input);return {...this.commitRead(projectId,prepared,context),clips:prepared.clips};}
  async prepareRead(input){
    const requestedLength=Object.hasOwn(input,'length')?Number(input.length):null;
    const offset=Math.max(0,Math.min(1000000,Number(input.offset)||0)),page=Math.max(1,Math.min(500,Number(input.page)||1));
    const length=Math.max(500,Math.min(this.pageChars,requestedLength||LIMITS.readChars)),query=String(input.query||'').trim().slice(0,160);
    const pageCount=Math.max(1,Math.min(8,Number(input.pageCount)||1));
    const clips=[];
    if(requestedLength>this.pageChars)clips.push({resource:'read_characters',limit:this.pageChars,used:requestedLength,outcome:'clipped'});
    if(Number(input.page)>500)clips.push({resource:'pdf_pages',limit:500,used:Number(input.page),outcome:'clipped'});
    if(!query&&Number(input.pageCount)>8)clips.push({resource:'pdf_pages',limit:8,used:Number(input.pageCount),outcome:'clipped'});
    const result=await this.document(String(input.url));let title,text,links=[],allLinks=[],kind='web',extra='';
    if(result.type.includes('pdf')||result.buffer.subarray(0,5).toString()==='%PDF-'){
      const pdf=await this.pdf(result.buffer);try{
        if(page>pdf.numPages)throw new Error(`This PDF has ${pdf.numPages} pages.`);
        title=new URL(result.url).pathname.split('/').at(-1)||'PDF document';kind='pdf';text='';
        let last=page-1,hits=0;const through=Math.min(pdf.numPages,page+(query?79:pageCount-1));
        for(let n=page;n<=through;n++){
          const pg=await pdf.getPage(n),content=await pg.getTextContent(),body=content.items.map(x=>x.str+(x.hasEOL?'\n':' ')).join('');last=n;
          if(query){const found=selectPassages(body,{query,limit:Math.min(2400,length)});if(found.text){text+=`\n[PDF page ${n}]\n`+found.text;hits++;}if(hits>=5||text.length>=length)break;}
          else{text+=`\n[PDF page ${n}]\n`+body;if(text.length>this.pageChars*2)break;}
        }
        if(query&&pdf.numPages>page+79)clips.push({resource:'pdf_pages',limit:80,used:pdf.numPages-page+1,outcome:'clipped'});
        extra=`${query?'Searched':'Read'} PDF pages ${page}–${last} of ${pdf.numPages}. ${query?'Query matches are excerpts; no match in this range does not establish absence elsewhere.':'Offsets apply only to this page range.'} If text is empty or garbled, inspect a relevant page visually.`;
      }finally{await pdf.loadingTask.destroy();}
    }else if(/html|text|json|xml/.test(result.type)||!result.type){({title,text,links,allLinks}=htmlText(result.buffer.toString('utf8'),result.url));if(links.dropped)clips.push({resource:'page_links',limit:LIMITS.pageLinks,used:links.dropped,outcome:'clipped'});if(allLinks.dropped)clips.push({resource:'page_links',limit:LIMITS.savedLinks,used:allLinks.dropped,outcome:'clipped'});}
    else throw new Error('This source is not a supported web page, text document, or PDF.');
    if(query&&kind!=='pdf'){text=selectPassages(text,{query,limit:length}).text;extra='Exact-text search of this webpage. Matches are excerpts; no match is not proof the requirement is absent.';}
    const fullLength=text.length;const excerpt=text.slice(offset,offset+length);
    return {source:{url:result.url,title,text:excerpt,readFull:true,kind,documentDate:result.modified},allLinks,clips,details:{url:result.url,title,note:extra,offset,totalCharacters:fullLength,truncated:offset+excerpt.length<fullLength,nextOffset:offset+excerpt.length<fullLength?offset+excerpt.length:null,text:excerpt,links}};
  }
  commitRead(projectId,prepared,context){
    const source=this.store.source(projectId,prepared.source,context);this.store.saveLinks(projectId,prepared.allLinks?.length?prepared.allLinks:prepared.details.links);
    return {text:JSON.stringify({sourceId:source.id,retrieved:source.retrieved,...prepared.details})};
  }
  async saved(projectId,input){
    // A page fetched through web_fetch has no ID in the conversation, so its URL also finds it.
    const key=String(input.sourceId).trim(),address=(()=>{try{const u=new URL(key);u.hash='';return u.href;}catch{return '';}})();
    const source=this.store.sources(projectId).find(s=>s.id===key||(address&&s.url===address));
    if(!source)throw new Error('Choose a sourceId from the saved source register, or the exact URL of a page already read or fetched.');
    const requestedLength=Object.hasOwn(input,'length')?Number(input.length):null,length=Math.max(500,Math.min(this.pageChars,requestedLength||LIMITS.readChars)),offset=Math.max(0,Number(input.offset)||0),query=String(input.query||'').trim().slice(0,160);
    const found=query?selectPassages(source.text,{query,limit:length}):{text:source.text.slice(offset,offset+length),spans:[{start:offset,end:Math.min(source.text.length,offset+length)}]};
    const clips=requestedLength>this.pageChars?[{resource:'read_characters',limit:this.pageChars,used:requestedLength,outcome:'clipped'}]:[];
    return {clips,text:JSON.stringify({sourceId:source.id,url:source.url,title:source.title,readFull:source.read_full,totalCharacters:source.text.length,spans:found.spans,text:found.text,nextOffset:!query&&offset+length<source.text.length?offset+length:null,note:!source.read_full?'Discovery only: the document has not been read.':query&&!found.text?'No exact match in saved excerpts. Unread document sections may still contain it.':'Saved excerpts only; these offsets refer to saved source text.'})};
  }
  async inspectPdf(projectId,input){
    const page=Math.max(1,Math.min(500,Number(input.page)||1)),result=await fetchPublic(String(input.url));
    const clips=Number(input.page)>500?[{resource:'pdf_pages',limit:500,used:Number(input.page),outcome:'clipped'}]:[];
    if(!result.type.includes('pdf')&&result.buffer.subarray(0,5).toString()!=='%PDF-')throw new Error('The requested source is not a PDF.');
    const pdf=await this.pdf(result.buffer);try{
      if(page>pdf.numPages)throw new Error(`This PDF has ${pdf.numPages} pages.`);
      const pg=await pdf.getPage(page),base=pg.getViewport({scale:1}),viewport=pg.getViewport({scale:Math.min(2,1500/Math.max(base.width,base.height))});
      const {createCanvas}=await import('@napi-rs/canvas');const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await pg.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const source=this.store.source(projectId,{url:result.url,title:new URL(result.url).pathname.split('/').at(-1),text:`[PDF page ${page} inspected visually. No machine-readable quotation verified.]`,readFull:false,kind:'pdf-visual'});
      return {clips,text:`Source ${source.id}; ${result.url}; PDF page ${page}. Visually extracted claims must be marked inferred/needs confirmation unless the exact quote is independently available as readable text.`,image:canvas.toBuffer('image/png').toString('base64')};
    }finally{await pdf.loadingTask.destroy();}
  }
  async render(projectId,input,context){
    const target=await validatePublicUrl(String(input.url)),executable=browserPath();if(!executable)throw new Error('No supported browser is installed. Try read_source or record an access gap.');
    const {default:puppeteer}=await import('puppeteer-core');const profile=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-'));
    let browser;
    try{
      browser=await puppeteer.launch({executablePath:executable,headless:true,userDataDir:profile,args:['--disable-background-networking','--disable-extensions','--disable-sync','--no-first-run','--disable-default-apps','--disable-features=ServiceWorker'],timeout:20000});
      const page=await browser.newPage();await page.setViewport({width:1280,height:900});await page.setBypassServiceWorker(true);await page.setRequestInterception(true);
      await page.evaluateOnNewDocument(()=>{for(const name of ['WebSocket','WebTransport','RTCPeerConnection','Worker','SharedWorker'])Object.defineProperty(globalThis,name,{value:class{constructor(){throw new Error('Disabled in the read-only research browser.');}},writable:false,configurable:false});window.open=()=>null;});
      // Serve downloaded resources through the same DNS-pinned public fetch path.
      let requests=0;
      page.on('request',async request=>{try{if(request.url().startsWith('data:'))return request.continue();if(++requests>80||!['GET','HEAD'].includes(request.method())||['media','font','websocket'].includes(request.resourceType())||(request.resourceType()==='document'&&request.frame()!==page.mainFrame()))return request.abort();const resource=await fetchPublic(request.url(),{maxBytes:5*1024*1024});await request.respond({status:200,contentType:resource.type,headers:{'Content-Security-Policy':"worker-src 'none'; frame-src 'none'; object-src 'none'"},body:resource.buffer});}catch{try{await request.abort();}catch{}}});
      await page.goto(target.url.href,{waitUntil:'domcontentloaded',timeout:30000});
      await page.waitForNetworkIdle({idleTime:600,timeout:7000}).catch(()=>{});
      const captured=await page.evaluate(limit=>{const links=[...document.querySelectorAll('a[href]')].map(a=>({title:(a.innerText||'').trim().slice(0,120),url:a.href})).filter(a=>a.title&&/^https?:/.test(a.url));return {title:document.title,text:document.body?.innerText||'',links:links.slice(0,limit),linkCount:links.length};},LIMITS.savedLinks);
      // The browser separates rendered table cells with tabs; " | " keeps the columns readable.
      captured.text=captured.text.replace(/[ \t]*\t[ \t]*/g,' | ');
      const requestedLength=Object.hasOwn(input,'length')?Number(input.length):null,offset=Math.max(0,Number(input.offset)||0),length=Math.max(500,Math.min(this.pageChars,requestedLength||LIMITS.readChars)),text=captured.text.slice(offset,offset+length);
      const allLinks=pageLinks(captured.links);captured.links=sourceLinks(captured.links);
      const clips=[];
      if(requestedLength>this.pageChars)clips.push({resource:'read_characters',limit:this.pageChars,used:requestedLength,outcome:'clipped'});
      if(captured.links.dropped)clips.push({resource:'page_links',limit:LIMITS.pageLinks,used:captured.links.dropped,outcome:'clipped'});
      if(captured.linkCount>LIMITS.savedLinks)clips.push({resource:'page_links',limit:LIMITS.savedLinks,used:captured.linkCount,outcome:'clipped'});
      const source=this.store.source(projectId,{url:target.url.href,title:captured.title,text,readFull:true,kind:'browser'},context);
      this.store.saveLinks(projectId,allLinks);
      return {clips,text:JSON.stringify({sourceId:source.id,url:target.url.href,title:captured.title,text,offset,totalCharacters:captured.text.length,truncated:offset+text.length<captured.text.length,links:captured.links})};
    }finally{await browser?.close().catch(()=>{});if(path.resolve(profile).startsWith(path.join(os.tmpdir(),'ahj-atlas-')))await rm(profile,{recursive:true,force:true}).catch(()=>{});}
  }
  async locate(projectId,input){
    const p=this.store.project(projectId);if(!isUnitedStates(p.input.country))return {text:'The optional Census address tool covers the United States. Use official jurisdiction maps and agency sources for this country.'};
    // Read at call time so a corrected address is geocoded, not the one entered at creation.
    const url='https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?'+new URLSearchParams({address:p.address,benchmark:'Public_AR_Current',vintage:'Current_Current',format:'json'});
    const result=await this.fetch(url,{maxBytes:2000000}),data=JSON.parse(result.buffer.toString());
    const matches=(data.result?.addressMatches||[]).slice(0,3).map(m=>({matchedAddress:m.matchedAddress,coordinates:m.coordinates,geographies:Object.fromEntries(Object.entries(m.geographies||{}).filter(([k])=>/Counties|States|Places|County Subdivisions/.test(k)))}));
    const text=JSON.stringify({matches,note:'Geographic evidence only. Confirm department and fire-district authority separately; a mailing city or Census boundary does not establish regulatory authority.'});
    const source=this.store.source(projectId,{url,title:'US Census address geographies',text,readFull:true,kind:'geography'});return {text:JSON.stringify({sourceId:source.id,...JSON.parse(text)})};
  }
  async run(projectId,name,input,context={}){
    if(name==='read_saved_source')return this.saved(projectId,input);
    const p=this.store.project(projectId);
    if(p.reads>=LIMITS.reads){recordExhausted(this.store,{projectId,stageId:context.stageId,attemptId:context.attemptId,resource:'reads',scope:'project',limit:LIMITS.reads,used:p.reads,outcome:'refused',tool:name});throw new Error('The project document-reading limit has been reached.');}
    if(name==='read_source')return this.read(projectId,input,context);
    if(name==='render_page')return this.render(projectId,input,context);
    if(name==='inspect_pdf')return this.inspectPdf(projectId,input);
    if(name==='locate_address')return this.locate(projectId,input);
    throw new Error('This tool is not permitted.');
  }
}
const object=properties=>({type:'object',properties,additionalProperties:false});
// maxChars is the largest length a read accepts, as the ResearchTools instance enforces it.
export const toolDefs=(maxChars=LIMITS.pageChars)=>{const max=maxChars.toLocaleString('en-US');return [
  {name:'read_source',description:`Read public HTML or PDF text. Default 8,000 characters and ONE PDF page; length permits up to ${max}, pageCount up to 8. Use query to search for an exact municipality, standard or phrase; PDF search scans up to 80 pages starting at page and returns matching excerpts with page labels. Offset applies within the requested page range. Reuse saved sources where possible. Max download ${Math.round(LIMITS.documentBytes/1048576)} MB.`,input_schema:{...object({url:{type:'string'},offset:{type:'integer'},page:{type:'integer'},pageCount:{type:'integer'},length:{type:'integer'},query:{type:'string'}}),required:['url']}},
  {name:'read_saved_source',description:`Find an exact word/phrase (query) or read an offset in already retrieved source text, without network access. Use a sourceId from the source register, or the exact URL of a page already read or fetched. Default 8,000 characters; length max ${max}. No match does not establish absence in unread document sections.`,input_schema:{...object({sourceId:{type:'string'},query:{type:'string'},offset:{type:'integer'},length:{type:'integer'}}),required:['sourceId']}},
  {name:'render_page',description:`Read a public JavaScript-rendered webpage when read_source fails. No logins or submissions. Default 8,000 text characters; length max ${max}, offset for later text.`,input_schema:{...object({url:{type:'string'},offset:{type:'integer'},length:{type:'integer'}}),required:['url']}},
  {name:'inspect_pdf',description:'Visually inspect one page of a scanned PDF when text extraction fails. Returns a page image. Mark visually read claims as needing confirmation. Limit this expensive fallback to relevant pages.',input_schema:{...object({url:{type:'string'},page:{type:'integer'}}),required:['url','page']}},
  {name:'locate_address',description:'Look up the user-provided US project address in official Census geographies. Does not establish regulatory or fire district authority; verify separately.',input_schema:object({})},
];};
export const TOOL_DEFS=toolDefs();
