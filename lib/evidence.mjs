// Selection keeps exact substrings and offsets: excerpts are evidence, never summaries.
const escape=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const stop=new Set('united states street avenue road drive lane boulevard suite north south east west county city village town building existing project renovation alteration center hyperscale'.split(' '));
// Generic parcel/site wording that would match unrelated passages, including the words of
// a Canadian or PLSS legal land description and Quebec's cadastre.
const siteStop=new Set('parcel parcels tract site near adjacent between corner intersection highway route acre acres number assessor unassigned address located approximately feet miles plan block roll legal land description section township range meridian quarter cadastre numéro'.split(' '));
export function projectTerms(input={}){
  // Combining marks stay in the term: decomposed accents and Devanagari, Thai or Khmer vowel signs.
  const words=value=>String(value||'').match(/[\p{L}][\p{L}\p{M}'-]{3,}/gu)||[],site=String(input.siteDescription||'');
  // Parcel identifiers (APNs, PIDs, lot/tract numbers, legal land descriptions such as
  // SW-12-24-1-W5M) contain digits and are matched whole.
  const identifiers=site.match(/(?<![\p{L}\d-])(?=[\p{L}\d-]*\d)[\p{L}\d][\p{L}\d-]{4,}[\p{L}\d](?![\p{L}\d-])/gu)||[];
  return [...new Set([...words(input.address).filter(s=>!stop.has(s.toLowerCase())),...words(site).filter(s=>!stop.has(s.toLowerCase())&&!siteStop.has(s.toLowerCase())),...identifiers])].slice(0,16);
}
// Unicode word edges: ASCII \b misses "Bogotá" and all non-Latin text. Scripts written
// without spaces (Han, kana, Thai, Lao, Khmer, Myanmar) have no word edges, so a term
// end in those scripts needs no boundary. Source text keeps its offsets, so both
// composed and decomposed spellings of the term are matched instead of normalizing it.
const unspaced='\\p{scx=Han}\\p{scx=Hira}\\p{scx=Kana}\\p{scx=Thai}\\p{scx=Laoo}\\p{scx=Khmr}\\p{scx=Mymr}',word='[\\p{L}\\p{M}\\p{N}_]';
const startsUnspaced=new RegExp(`^[${unspaced}]`,'u'),endsUnspaced=new RegExp(`[${unspaced}]$`,'u');
const termPattern=term=>new RegExp((startsUnspaced.test(term)?'':`(?<!${word})`)+'(?:'+[...new Set([term.normalize('NFC'),term.normalize('NFD')])].map(escape).join('|')+')'+(endsUnspaced.test(term)?'':`(?!${word})`),'giu');
export function selectPassages(text,{limit=8000,input={},findings='',query='',title='',fill=false}={}){
  text=String(text||'');limit=Math.max(0,Math.floor(limit));
  if(!limit||!text)return {text:'',spans:[]};
  if(text.length<=limit&&!query)return {text,spans:[{start:0,end:text.length}]};
  const candidates=[];
  const add=(at,score,before=220,after=850)=>candidates.push({start:Math.max(0,at-before),end:Math.min(text.length,at+after),score});
  const matches=(pattern,score,before,after)=>{let count=0;for(const m of text.matchAll(pattern)){add(m.index,score,before,after);if(++count>=200)break;}};
  if(query)matches(new RegExp(escape(query),'gi'),100,250,900);
  for(const m of findings.matchAll(/[“"]([^”"\n]{20,800})[”"]/g)){const at=text.indexOf(m[1]);if(at>=0)add(at,80,120,m[1].length+180);}
  for(const term of projectTerms(input))matches(termPattern(term),40,250,850);
  // Actual adoption clauses outrank navigation links mentioning "adoption".
  matches(/incorporated\s+by\s+reference|(?:adopt\w*|effective)[^\n]{0,100}\b(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b[^\n]{0,100}(?:adopt|incorporat)/gi,30,200,1100);
  matches(/(?:provisions|requirements).{0,80}(?:apply|applicab)/gi,35,180,1100);
  matches(/\bNFPA\s*[-–]?\s*\d+[A-Z]?/gi,20,180,900);
  matches(/change\s+of\s+occupancy/gi,12,180,900);
  matches(/[\w.+-]{1,64}@[\w.-]{1,253}\.[a-z]{2,}|\b(?:\d{3}[-. ]){2}\d{4}\b|delegat\w*|amendment|permit|submittal/gi,8,180,750);
  const section=title.match(/\b(?:SPS|Section|Sec\.)\s+\d+(?:\.\d+)+/i)?.[0];
  if(section)matches(new RegExp(escape(section),'gi'),12,100,1300);
  if(!query){add(0,1,0,800);add(Math.max(0,text.length-600),0,0,600);}
  if(query&&!candidates.some(c=>c.score===100))return {text:'',spans:[]};
  const selected=[];let used=0;const separator='\n[Excerpt boundary]\n';
  for(const c of candidates.sort((a,b)=>b.score-a.score||a.start-b.start)){
    if(query&&c.score!==100)continue;
    if(selected.some(s=>c.start<s.end&&c.end>s.start))continue;
    const room=limit-used-(selected.length?separator.length:0);if(room<120)break;
    const end=Math.min(c.end,c.start+room);selected.push({start:c.start,end});used+=end-c.start+(selected.length>1?separator.length:0);
  }
  // fill: after the relevant passages, the rest of the allowance carries the document's
  // other text in order, so a large allowance carries more of a long source instead of
  // stopping at the matched passages. Touching spans are then joined.
  if(fill&&!query){
    const gaps=[];let cursor=0;
    for(const s of [...selected].sort((a,b)=>a.start-b.start)){if(s.start>cursor)gaps.push([cursor,s.start]);cursor=Math.max(cursor,s.end);}
    if(cursor<text.length)gaps.push([cursor,text.length]);
    for(const [start,gapEnd] of gaps){const room=limit-used-(selected.length?separator.length:0);if(room<120)break;const end=Math.min(gapEnd,start+room);selected.push({start,end});used+=end-start+(selected.length>1?separator.length:0);}
  }
  selected.sort((a,b)=>a.start-b.start);
  const spans=fill?selected.reduce((out,s)=>{const last=out.at(-1);if(last&&s.start<=last.end)last.end=Math.max(last.end,s.end);else out.push({...s});return out;},[]):selected;
  return {text:spans.map(s=>text.slice(s.start,s.end)).join(separator),spans};
}

export function allocateEvidence(sources,budget,perSource=32000){
  // Redistribute unused shares; discovery-only sources never consume a text allowance.
  const caps=sources.map(s=>Math.min(perSource,(s.text||'').length)),out=caps.map(()=>0);
  let left=Math.max(0,Math.floor(budget)),active=caps.map((_,i)=>i).filter(i=>caps[i]);
  while(left>0&&active.length){
    const share=Math.max(1,Math.floor(left/active.length));
    for(const i of active){const amount=Math.min(share,caps[i]-out[i],left);out[i]+=amount;left-=amount;}
    active=active.filter(i=>out[i]<caps[i]);
  }
  return out;
}

// Under display:'updates' a non-empty thinking block is a progress note written
// for the user; reasoning blocks stay empty. A response cut off mid-step can end
// with a fixed placeholder note instead of real progress.
const INTERRUPTED_UPDATE='This part of the response was interrupted before it finished.';
export function progressUpdates(content){
  return (Array.isArray(content)?content:[]).filter(b=>b?.type==='thinking'&&typeof b.thinking==='string').map(b=>b.thinking.trim()).filter(text=>text&&text!==INTERRUPTED_UPDATE);
}
export function checkpointFromMessages(stage,messages,sources){
  const checkpoint=structuredClone(stage.checkpoint||{brief:'',claims:[],questions:[],sources:[],observations:[]});
  checkpoint.sources??=[];checkpoint.observations??=[];checkpoint.lookups??=[];
  for(const message of messages||[])for(const block of Array.isArray(message.content)?message.content:[]){
    if(message.role==='assistant'&&block.type==='text'&&block.text?.trim())checkpoint.observations.push(block.text.slice(0,2500));
    if(message.role==='assistant')for(const note of progressUpdates([block]))checkpoint.observations.push(note.slice(0,2500));
    if(block.type==='tool_result'){
      const value=typeof block.content==='string'?block.content:(block.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
      if(block.is_error){checkpoint.observations.push('Retrieval/check error: '+value.slice(0,500));continue;}
      try{const data=JSON.parse(value);if(data.sourceId&&sources.some(s=>s.id===data.sourceId)){checkpoint.sources.push(data.sourceId);if(data.readFull&&data.text)checkpoint.lookups.push({sourceId:data.sourceId,text:data.text.slice(0,2400)});}}catch{}
    }
    if(block.type==='web_search_tool_result'&&block.content?.error_code)checkpoint.observations.push('Search error: '+block.content.error_code);
    if(block.type==='web_fetch_tool_result'&&block.content?.type==='web_fetch_result'){
      const source=sources.find(s=>s.url===block.content.url);if(source)checkpoint.sources.push(source.id);
    }
  }
  checkpoint.sources=[...new Set(checkpoint.sources)].slice(-100);
  checkpoint.observations=[...new Set(checkpoint.observations)].slice(-6);
  checkpoint.lookups=[...new Map(checkpoint.lookups.map(x=>[x.sourceId+':'+x.text,x])).values()].slice(-5);
  return checkpoint;
}
export function checkpointBody(stage){
  const c=stage?.checkpoint;if(!c)return '';
  return ['Working checkpoint; claims require source verification.',c.brief||'',...(c.questions||[]).map(q=>'Unresolved: '+q),...(c.claims||[]).map(x=>`${x.claim} [${x.sourceId}, ${x.pageOrSection||'passage'}]: “${x.quote}”`),...(c.lookups||[]).map(x=>`Saved lookup ${x.sourceId}: ${x.text}`),c.sources?.length?'Retrieved source IDs: '+c.sources.join(', '):'',...(c.observations||[])].filter(Boolean).join('\n');
}
export function checkpointText(stage){return checkpointBody(stage).slice(0,24000);}
export function validateProgress(input,sources){
  if(typeof input?.brief!=='string'||input.brief.trim().length<24||!Array.isArray(input.claims)||!Array.isArray(input.questions))throw new Error('Save a substantive brief, evidence-linked claims, and outstanding questions.');
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
  const claims=input.claims.slice(0,12).map(c=>{
    const source=sources.find(s=>s.id===c.sourceId),quote=String(c.quote||'').slice(0,800);
    if(!source?.read_full||normalize(quote).length<12||!normalize(source.text).includes(normalize(quote)))throw new Error('A progress claim needs an exact quotation from a retrieved source. Keep unsupported assertions in questions.');
    return {claim:String(c.claim||'').slice(0,600),sourceId:source.id,quote,pageOrSection:String(c.pageOrSection||'').slice(0,160)};
  });
  return {brief:input.brief.slice(0,6000),claims,questions:input.questions.slice(0,20).map(q=>String(q).slice(0,500))};
}

export function mergeEvidence(oldText,newText){
  if(!newText||oldText.includes(newText))return oldText;
  if(newText.includes(oldText))return newText;
  // Merge overlapping sequential reads without duplicating the common passage.
  const overlap=(left,right)=>{
    const sample=right+'\u0000'+left.slice(-right.length),prefix=new Uint32Array(sample.length);
    for(let i=1;i<sample.length;i++){let n=prefix[i-1];while(n&&sample[i]!==sample[n])n=prefix[n-1];if(sample[i]===sample[n])n++;prefix[i]=n;}
    return Math.min(right.length,prefix.at(-1)||0);
  };
  const forward=overlap(oldText,newText);if(forward>=80)return oldText+newText.slice(forward);
  const backward=overlap(newText,oldText);if(backward>=80)return newText+oldText.slice(backward);
  return oldText+'\n\n'+newText;
}
