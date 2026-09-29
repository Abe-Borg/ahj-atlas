// Selection keeps exact substrings and offsets: excerpts are evidence, never summaries.
const escape=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const stop=new Set('united states street avenue road drive lane boulevard suite north south east west county city village town building existing project renovation alteration center hyperscale'.split(' '));
export function projectTerms(input={}){
  return [...new Set((String(input.address||'').match(/[\p{L}][\p{L}'-]{3,}/gu)||[]).filter(s=>!stop.has(s.toLowerCase())))].slice(0,16);
}
// Unicode word edges: ASCII \b misses "Bogotá" and all non-Latin text. Scripts written
// without spaces (Han, kana, Thai, Lao, Khmer, Myanmar) have no word edges, so a term
// end in those scripts needs no boundary.
const unspaced='\\p{scx=Han}\\p{scx=Hira}\\p{scx=Kana}\\p{scx=Thai}\\p{scx=Laoo}\\p{scx=Khmr}\\p{scx=Mymr}',word='[\\p{L}\\p{M}\\p{N}_]';
const startsUnspaced=new RegExp(`^[${unspaced}]`,'u'),endsUnspaced=new RegExp(`[${unspaced}]$`,'u');
const termPattern=term=>new RegExp((startsUnspaced.test(term)?'':`(?<!${word})`)+escape(term)+(endsUnspaced.test(term)?'':`(?!${word})`),'giu');
export function selectPassages(text,{limit=8000,input={},findings='',query='',title=''}={}){
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
  matches(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d{3}[-. ]){2}\d{4}\b|delegat\w*|amendment|permit|submittal/gi,8,180,750);
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
  selected.sort((a,b)=>a.start-b.start);
  return {text:selected.map(s=>text.slice(s.start,s.end)).join(separator),spans:selected};
}

export function allocateEvidence(sources,budget){
  // Redistribute unused shares; discovery-only sources never consume a text allowance.
  const caps=sources.map(s=>Math.min(32000,(s.text||'').length)),out=caps.map(()=>0);
  let left=Math.max(0,Math.floor(budget)),active=caps.map((_,i)=>i).filter(i=>caps[i]);
  while(left>0&&active.length){
    const share=Math.max(1,Math.floor(left/active.length));
    for(const i of active){const amount=Math.min(share,caps[i]-out[i],left);out[i]+=amount;left-=amount;}
    active=active.filter(i=>out[i]<caps[i]);
  }
  return out;
}

export function checkpointFromMessages(stage,messages,sources){
  const checkpoint=structuredClone(stage.checkpoint||{brief:'',claims:[],questions:[],sources:[],observations:[]});
  checkpoint.sources??=[];checkpoint.observations??=[];checkpoint.lookups??=[];
  for(const message of messages||[])for(const block of Array.isArray(message.content)?message.content:[]){
    if(message.role==='assistant'&&block.type==='text'&&block.text?.trim())checkpoint.observations.push(block.text.slice(0,2500));
    if(block.type==='tool_result'){
      const value=typeof block.content==='string'?block.content:(block.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
      if(block.is_error){checkpoint.observations.push('Retrieval/check error: '+value.slice(0,500));continue;}
      try{const data=JSON.parse(value);if(data.sourceId&&sources.some(s=>s.id===data.sourceId)){checkpoint.sources.push(data.sourceId);if(data.readFull&&data.text)checkpoint.lookups.push({sourceId:data.sourceId,text:data.text.slice(0,2400)});}}catch{}
    }
    if(block.type==='web_search_tool_result'&&block.content?.error_code)checkpoint.observations.push('Search error: '+block.content.error_code);
  }
  checkpoint.sources=[...new Set(checkpoint.sources)].slice(-100);
  checkpoint.observations=[...new Set(checkpoint.observations)].slice(-6);
  checkpoint.lookups=[...new Map(checkpoint.lookups.map(x=>[x.sourceId+':'+x.text,x])).values()].slice(-5);
  return checkpoint;
}
export function checkpointText(stage){
  const c=stage.checkpoint;if(!c)return '';
  return ['Working checkpoint; claims require source verification.',c.brief||'',...(c.questions||[]).map(q=>'Unresolved: '+q),...(c.claims||[]).map(x=>`${x.claim} [${x.sourceId}, ${x.pageOrSection||'passage'}]: “${x.quote}”`),...(c.lookups||[]).map(x=>`Saved lookup ${x.sourceId}: ${x.text}`),c.sources?.length?'Retrieved source IDs: '+c.sources.join(', '):'',...(c.observations||[])].filter(Boolean).join('\n').slice(0,24000);
}
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
