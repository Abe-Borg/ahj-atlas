// Live check of the Anthropic API paths changed for SDK 1.x (API version 2026-10-21), the
// dynamic-filtering web tools (_20260209) and server-side refusal fallback. Unit tests cover
// these against documented shapes; only real requests show that the API accepts the app's
// exact request shapes and returns what the app reads. The requests go through the app's own
// provider and request builders and are billed to your Anthropic account. Nothing is saved to
// your projects: the research request is built from a synthetic project in a temporary folder.
//
//   PowerShell:   $env:ANTHROPIC_API_KEY="sk-ant-..."; npm run live-check -- --yes
//   Options:      --batch  also submit a one-request Message Batch and wait for its result
//                 --ab     also answer one AHJ question with the basic and the dynamic-filtering
//                          web tools, and compare their tokens, searches and cost
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Anthropic, withFallbacks, API_VERSION, FALLBACK_BETA } from '../lib/provider.mjs';
import { MODELS, costMicros, usd, fallbackModel, modelLabel } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { researchPayload } from '../lib/prompts.mjs';
import { captureSearchSources, searchTool, fetchTool } from '../lib/research-tools.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sdkVersion=JSON.parse(readFileSync(path.join(root,'node_modules','@anthropic-ai','sdk','package.json'),'utf8')).version;
const args=new Set(process.argv.slice(2)),key=String(process.env.ANTHROPIC_API_KEY||'').trim();
const project={name:'Live check · synthetic project',address:'1 Harrison Street SE, Leesburg, VA 20175',discipline:'Fire protection',country:'United States',scope:'New construction',occupancy:'Data center',permitDate:'2026-11-01',mode:'realtime'};

if(!args.has('--yes')){
  console.log(`AHJ Atlas live check (Anthropic SDK ${sdkVersion}, API version ${API_VERSION}).
It sends real requests billed to the key in ANTHROPIC_API_KEY:
  - model list, an invalid key and an unknown model (free)
  - one research request built exactly as the app builds it (Sonnet 5.5, dynamic-filtering web tools, fallbacks)
  - one small web search request (Sonnet 5.5, dynamic filtering, fallbacks)
  - one small structured-output request (Opus 5.5, fallbacks)
Expected cost: about $0.05 to $0.40. --batch adds under $0.01; --ab adds about $0.10 to $0.60.
Run again with --yes to send them.`);
  process.exit(0);
}
if(!key){console.error('Set ANTHROPIC_API_KEY first. PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."');process.exit(1);}

const provider=new Anthropic(()=>key),results=[];let spent=0;
async function check(name,fn){
  try{const detail=await fn();results.push({name,status:'PASS'});console.log(`PASS  ${name}\n      ${detail}`);}
  catch(error){results.push({name,status:error.pending?'WAIT':'FAIL'});console.log(`${error.pending?'WAIT':'FAIL'}  ${name}\n      ${error.message}${error.status?` (HTTP ${error.status})`:''}${error.requestId?` request ${error.requestId}`:''}`);}
}
const fail=message=>{throw new Error(message);};
const summary=content=>Object.entries((content||[]).reduce((n,b)=>({...n,[b.type]:(n[b.type]||0)+1}),{})).map(([type,count])=>`${type}×${count}`).join(', ');
const served=message=>fallbackModel(message.usage)?`${modelLabel(fallbackModel(message.usage))} through server-side fallback`:modelLabel(message.model);
const charge=(message,modelKey,mode='realtime')=>{const cost=costMicros(message.usage,modelKey,mode);spent+=cost;return cost;};
// Continues a paused server-side turn, as the app does, up to twice.
async function complete(payload,modelKey,onEvent){
  let body=payload,{data}=await provider.message(body,{onEvent}),cost=charge(data,modelKey);
  for(let n=0;n<2&&data.stop_reason==='pause_turn';n++){body={...body,messages:[...body.messages,{role:'assistant',content:data.content}]};({data}=await provider.message(body,{onEvent}));cost+=charge(data,modelKey);}
  return {data,cost};
}
const usageLine=(u={})=>`input ${(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0)} tokens (${u.cache_read_input_tokens||0} cached), output ${u.output_tokens||0}, searches ${u.server_tool_use?.web_search_requests||0}, fetches ${u.server_tool_use?.web_fetch_requests||0}`;
const fromCode=content=>(content||[]).filter(b=>b.caller&&b.caller.type!=='direct').length;

console.log(`AHJ Atlas live check: Anthropic SDK ${sdkVersion}, API version ${API_VERSION}, fallback beta ${FALLBACK_BETA}\n`);

await check('Models list and capabilities',async()=>{
  const models=await provider.check();await provider.preflight('realtime',{},{modelKeys:['research','review']});
  const fallbacks=[MODELS.research.id,MODELS.review.id].map(id=>`${id} allowed_fallback_models ${JSON.stringify(models.find(m=>m.id===id)?.allowed_fallback_models??'not listed')}`);
  return `${models.length} models readable; ${fallbacks.join('; ')}`;
});

await check('Error paths (free)',async()=>{
  const invalid=await new Anthropic(()=>'sk-ant-live-check-invalid').check().then(()=>null,e=>e);
  if(invalid?.status!==401)fail(`An invalid key returned ${invalid?.status??'success'}, not 401.`);
  const missing=await provider.message({model:'claude-live-check-missing',max_tokens:16,messages:[{role:'user',content:'Hello'}]}).then(()=>null,e=>e);
  if(!missing||missing.ambiguous||missing.partialUsage||![400,404].includes(missing.status))fail(`An unknown model returned ${missing?`status ${missing.status}, ambiguous ${missing.ambiguous}`:'success'}, not a clean rejection.`);
  return `invalid key: 401 "${invalid.message.slice(0,80)}"; unknown model: ${missing.status} rejected before generation, no charge recorded`;
});

await check('Research request as the app builds it (Sonnet 5.5, dynamic filtering, fallbacks)',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-live-check-'));let store;
  try{
    store=new Store(dir);const p=store.create(project);
    const payload=withFallbacks(researchPayload(store,store.project(p.id),store.stage(p.id,'jurisdiction')));
    const tools=payload.tools.filter(t=>!t.input_schema).map(t=>`${t.type} ${JSON.stringify(t.allowed_callers)}`).join(', ');
    const {data,cost}=await complete(payload,'research');
    if(data.stop_reason==='refusal')fail(`Declined (${JSON.stringify(data.stop_details)}); served by ${served(data)}.`);
    return `accepted with ${tools} and fallbacks "${payload.fallbacks}"; stop ${data.stop_reason}; served by ${served(data)}; blocks ${summary(data.content)}; ${fromCode(data.content)} calls made from code; ${usageLine(data.usage)}; about $${usd(cost).toFixed(4)}`;
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

await check('Web search through dynamic filtering (Sonnet 5.5, fallbacks)',async()=>{
  const payload=withFallbacks({model:MODELS.research.id,max_tokens:8000,thinking:{type:'adaptive',display:'updates'},output_config:{effort:'low'},
    system:'You research building and fire codes. Use web search for current facts.',
    tools:[searchTool(2,project),fetchTool(1)],messages:[{role:'user',content:'Search the web for the NFPA 13 standard page on nfpa.org and reply with its title and URL in one sentence.'}]});
  const {data,cost}=await complete(payload,'research'),captured=[];
  captureSearchSources({source:(id,source)=>captured.push(source.url),event(){},diagnostic(){}},'live-check',data,{});
  if(!data.usage?.server_tool_use?.web_search_requests)fail(`No search ran (stop ${data.stop_reason}; blocks ${summary(data.content)}).`);
  if(!captured.length)fail(`Searches ran but no result URL reached source capture (blocks ${summary(data.content)}).`);
  return `stop ${data.stop_reason}; served by ${served(data)}; blocks ${summary(data.content)}; ${fromCode(data.content)} calls made from code; ${captured.length} result URLs captured as leads; ${usageLine(data.usage)}; about $${usd(cost).toFixed(4)}`;
});

await check('Structured output (Opus 5.5, fallbacks)',async()=>{
  const payload=withFallbacks({model:MODELS.review.id,max_tokens:4000,thinking:{type:'adaptive',display:'omitted'},output_config:{effort:'low',format:{type:'json_schema',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}},
    messages:[{role:'user',content:'Set ok to true.'}]});
  const {data,cost}=await complete(payload,'review'),text=data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  if(JSON.parse(text).ok!==true)fail(`Unexpected output: ${text.slice(0,200)}`);
  return `valid JSON; served by ${served(data)}; ${usageLine(data.usage)}; about $${usd(cost).toFixed(4)}`;
});

if(args.has('--batch'))await check('Message Batch (no fallbacks)',async()=>{
  const request={id:'live_check_batch',payload:{model:MODELS.research.id,max_tokens:1000,output_config:{effort:'low'},messages:[{role:'user',content:'Reply with the single word ready.'}]}};
  const {data}=await provider.batch([request]),started=Date.now();
  if(!data?.id)fail('The batch was not accepted.');
  console.log(`      batch ${data.id} submitted; waiting up to 30 minutes`);
  for(;;){
    const {data:status}=await provider.poll(data.id);
    if(status.processing_status==='ended')break;
    if(Date.now()-started>30*60000)throw Object.assign(new Error(`Batch ${data.id} is still ${status.processing_status}. Check it in Anthropic Console.`),{pending:true});
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
  const row=(await provider.results(data.id)).data.find(r=>r.custom_id===request.id);
  if(row?.result?.type!=='succeeded')fail(`Batch result ${row?.result?.type||'missing'}: ${JSON.stringify(row?.result?.error||{}).slice(0,200)}`);
  const cost=charge(row.result.message,'research','batch');
  return `succeeded in ${Math.round((Date.now()-started)/1000)} s; stop ${row.result.message.stop_reason}; ${usageLine(row.result.message.usage)}; about $${usd(cost).toFixed(4)}`;
});

if(args.has('--ab'))await check('A/B: basic and dynamic-filtering web tools on one AHJ question',async()=>{
  const question='Which edition of NFPA 13 does Loudoun County, Virginia enforce for new commercial buildings? Search current official sources, then answer in two sentences with the source URL.';
  const basic=[{...searchTool(4,project),type:'web_search_20250305',allowed_callers:['direct']},(({allowed_callers,...tool})=>({...tool,type:'web_fetch_20250910'}))(fetchTool(2))];
  const lines=[];
  for(const [label,tools] of [['basic (_20250305/_20250910)',basic],['dynamic filtering (_20260209)',[searchTool(4,project),fetchTool(2)]]]){
    const {data,cost}=await complete(withFallbacks({model:MODELS.research.id,max_tokens:16000,thinking:{type:'adaptive',display:'omitted'},output_config:{effort:'medium'},system:'You research building and fire codes for engineers. Use current official sources.',tools,messages:[{role:'user',content:question}]}),'research');
    const answer=data.content.filter(b=>b.type==='text').map(b=>b.text).join('').replace(/\s+/g,' ').trim();
    lines.push(`${label}: ${usageLine(data.usage)}; about $${usd(cost).toFixed(4)}; stop ${data.stop_reason}\n        answer: ${answer.slice(0,300)}`);
  }
  return lines.join('\n      ');
});

const failed=results.filter(r=>r.status==='FAIL').length;
console.log(`\n${results.length-failed} of ${results.length} checks passed${failed?`, ${failed} failed`:''}. Estimated cost of this run: $${usd(spent).toFixed(4)} (Anthropic Console is authoritative).`);
process.exit(failed?1:0);
