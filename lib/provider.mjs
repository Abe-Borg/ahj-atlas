import AnthropicSDK from '@anthropic-ai/sdk';
import { MODELS, LIMITS } from './config.mjs';
import { errorDetails, requestSummary, responseSummary } from './diagnostics.mjs';
// Sonnet 5.5 and Opus 5.5 return their between-tool progress notes as thinking
// blocks. display:'updates' fills in only those notes and is a beta value, so
// every request that carries it, including token counts and batches, needs this header.
export const PROGRESS_UPDATES_BETA='thinking-display-updates-2026-08-18';
export const betaHeaders=(...payloads)=>payloads.some(p=>p?.thinking?.display==='updates')?{'anthropic-beta':PROGRESS_UPDATES_BETA}:{};
export const sanitize = value => String(value||'').replace(/sk-ant-[\w-]+/g,'[redacted]').replace(/[\r\n]+/g,' ').slice(0,700);
export class ProviderError extends Error {
  constructor(message,{status=0,ambiguous=false,requestId=null,type='',code='',retryable=false,retryAfterMs=0}={}){super(sanitize(message));Object.assign(this,{status,ambiguous,requestId,type,code,retryable,retryAfterMs});}
}
function connectionError(error,{ambiguous=false,checkingKey=false}={}){
  // Use allowlisted diagnostics only: raw transport errors can contain request data.
  const pending=[error],seen=new Set(),codes=new Set();
  while(pending.length&&seen.size<20){const item=pending.shift();if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);codes.add(item.code);codes.add(item.name);pending.push(item.cause,...(Array.isArray(item.errors)?item.errors.slice(0,10):[]));}
  const has=(...values)=>values.some(value=>codes.has(value));
  let code='network_error',detail='The app could not connect to Anthropic. Check your internet connection and try again.';
  if(has('EACCES','EPERM')){code='network_access_denied';detail='Network access to Anthropic was denied. Close AHJ Atlas and open Start AHJ Atlas.cmd directly from its folder. If this continues, ask your IT team to allow HTTPS access to api.anthropic.com.';}
  else if(has('ENOTFOUND','EAI_AGAIN')){code='network_dns';detail='The app could not find api.anthropic.com. Check your internet or VPN connection and DNS settings, then try again.';}
  else if(has('TimeoutError','AbortError','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT')){code='network_timeout';detail='The connection to Anthropic timed out. Check your internet or VPN connection and try again.';}
  else if(has('UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID')){code='network_certificate';detail='The app could not verify the HTTPS certificate for Anthropic. Ask your IT team to check the trusted certificates used by Node.js on this computer.';}
  else if(has('ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','UND_ERR_SOCKET')){code='network_disconnected';detail='The connection to Anthropic was interrupted or blocked. Check your internet, VPN, or firewall connection and try again.';}
  const context=checkingKey?'The API key could not be checked. No paid research request was sent. ':ambiguous?'The connection ended before Anthropic confirmed the outcome. ':'';
  return new ProviderError(context+detail,{ambiguous,code});
}
export function providerError(body,{status=0,headers,requestId,ambiguous=false}={}){
  const error=body?.error||body||{},type=error.type||'',code=error.details?.error_code||'';
  status ||= ({overloaded_error:529,rate_limit_error:429,api_error:500,timeout_error:504})[type]||0;
  const detail=sanitize(error.message),spend=code==='enforced_spend_limit_reached'||/specified (?:workspace )?API usage limits|spend(?:ing)? limit|monthly spend cap/i.test(detail),grammar=/compiled grammar is too large|schema is too complex for compilation/i.test(detail);
  const retryMs=Number(headers?.get?.('retry-after-ms')),retry=headers?.get?.('retry-after');
  const retryAfterMs=retryMs>0?retryMs:retry?(Number.isFinite(Number(retry))?Math.max(0,Number(retry)*1000):Math.max(0,Date.parse(retry)-Date.now())||0):0;
  const labels={401:'The API key was not accepted. Reconnect Claude.',402:'Check billing and payment details in your Anthropic Console.',403:'This key does not have permission for the requested resource.',404:'The requested model or batch result is unavailable.',429:'Anthropic rate limits were reached.',500:'Anthropic reported a temporary server error.',504:'Anthropic timed out while processing the request.',529:'Anthropic is temporarily overloaded.'};
  const message=spend?'Your Anthropic spending limit has been reached. Check the account or workspace allowance in Anthropic Console.':labels[status]||'Anthropic rejected the request.';
  return new ProviderError(`${message}${detail?' '+detail:''}`,{status,type,code:spend?'spend_limit':grammar?'schema_complexity':code,requestId:requestId||body?.request_id||headers?.get?.('request-id')||null,retryAfterMs,ambiguous,retryable:!ambiguous&&!spend&&[429,500,529].includes(status)});
}
export function validateCapabilities(models,{mode='realtime',modelKeys=Object.keys(MODELS),modelIds={},outputLimits={},efforts={}}={}){
  for(const [key,expected] of Object.entries(MODELS)){
    if(!modelKeys.includes(key))continue;
    const modelId=modelIds[key]??expected.id,label=modelId===expected.id?expected.label:modelId;
    const model=models.find(m=>m.id===modelId);if(!model)throw new ProviderError(`${label} is unavailable to this key. Check model access in Anthropic Console.`);
    // efforts names an additional level a request uses, such as chat's high effort on Opus.
    const effort=efforts[key],c=model.capabilities,checked=key==='research'?['medium','high']:['medium'],needed=[['thinking',c?.thinking?.supported],['adaptive thinking',c?.thinking?.types?.adaptive?.supported],['medium effort',c?.effort?.medium?.supported],...(key==='research'?[['high effort',c?.effort?.high?.supported]]:[['structured reports',c?.structured_outputs?.supported]]),...(effort&&!checked.includes(effort)?[[`${effort} effort`,c?.effort?.[effort]?.supported]]:[]),...(mode==='batch'?[['batch processing',c?.batch?.supported]]:[])];
    for(const [capability,value] of needed)if(value===false)throw new ProviderError(`${label} does not support ${capability} for this key.`);
    const requested=outputLimits[key]??(key==='review'?LIMITS.reviewOutput:LIMITS.output);
    if(model.max_tokens>0&&model.max_tokens<requested)throw new ProviderError(`${label} allows ${model.max_tokens.toLocaleString()} output tokens, below this app's ${requested.toLocaleString()} setting.`);
  }
  return models;
}
export class Anthropic {
  constructor(getKey,{base='https://api.anthropic.com',fetchImpl=fetch,streamDeadlineMs=30*60*1000,onDiagnostic=()=>{},onKeyStatus=()=>{}}={}){this.getKey=getKey;this.base=base;this.fetch=fetchImpl;this.streamDeadlineMs=streamDeadlineMs;this.models=null;this.onDiagnostic=onDiagnostic;this.onKeyStatus=onKeyStatus;}
  async request(endpoint,options={}){
    const start=Date.now(),context=options.context||{},meta={...context,endpoint:endpoint.split('?')[0],method:options.method||'GET'};
    this.onDiagnostic('api.started',{...meta,...(options.body?.model?{request:requestSummary(options.body)}:{})});
    try{const result=await this.requestOnce(endpoint,options);this.onDiagnostic('api.completed',{...meta,durationMs:Date.now()-start,requestId:result.requestId||null,...(result.data?.input_tokens!==undefined?{countedInputTokens:result.data.input_tokens}:{}),...(result.data?.processing_status?{batchStatus:result.data.processing_status}:{})});return result;}
    catch(e){this.onDiagnostic('api.failed',{...meta,level:'error',durationMs:Date.now()-start,error:errorDetails(e)});throw e;}
  }
  async requestOnce(endpoint,{method='GET',body,timeout=180000,jsonl=false,headers={}}={}){
    const key=this.getKey(),startedAt=performance.now();if(!key)throw new ProviderError('Reconnect your Claude API key to continue.',{status:401});
    let response;
    try{response=await this.fetch(this.base+endpoint,{method,headers:{...headers,'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});}
    catch(e){throw connectionError(e,{ambiguous:method==='POST',checkingKey:endpoint.startsWith('/v1/models')});}
    const requestId=response.headers.get('request-id');
    if(!response.ok){let error;try{error=await response.json();}catch{}const knownTransient=[500,529].includes(response.status)&&['api_error','overloaded_error'].includes(error?.error?.type);const failure=providerError(error,{status:response.status,headers:response.headers,requestId,ambiguous:method==='POST'&&response.status>=500&&!knownTransient});if(response.status===401)this.onKeyStatus(key,'invalid',failure.message,startedAt);throw failure;}
    this.onKeyStatus(key,'connected','',startedAt);
    try{return {data:jsonl?(await response.text()).split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s)):await response.json(),requestId};}
    catch{throw new ProviderError('The provider response could not be read completely.',{ambiguous:method==='POST',requestId});}
  }
  async check(context={}){
    const models=[];let after='';
    for(let page=0;page<20;page++){
      const {data}=await this.request('/v1/models?limit=100'+(after?'&after_id='+encodeURIComponent(after):''),{timeout:20000,context});models.push(...(data.data||[]));
      if(!data.has_more){this.models=models;return models;}
      if(!data.last_id||data.last_id===after)throw new ProviderError('Anthropic returned incomplete model availability. Try connecting again.');after=data.last_id;
    }
    throw new ProviderError('The model list could not be read completely. Try connecting again.');
  }
  async preflight(mode,context={},requirements={}){return validateCapabilities(this.models||await this.check(context),{mode,...requirements});}
  async count(payload,context={}){const {model,messages,system,tools,thinking,output_config}=payload;const body={model,messages,system,...(tools?{tools}:{}),...(thinking?{thinking}:{}),...(output_config?{output_config}:{})};const r=await this.request('/v1/messages/count_tokens',{method:'POST',body,timeout:30000,context,headers:betaHeaders(payload)});return Number(r.data.input_tokens);}
  // onEvent receives each raw stream event, so chat can show its draft and current step.
  async message(payload,{onProgress,onEvent,context={},deadlineMs=this.streamDeadlineMs}={}){
    const start=Date.now();let first=false;
    this.onDiagnostic('stream.started',{...context,request:requestSummary(payload)});
    try{const result=await this.messageOnce(payload,{deadlineMs,onEvent,onProgress:()=>{if(!first){first=true;this.onDiagnostic('stream.first_event',{...context,durationMs:Date.now()-start});}onProgress?.();}});this.onDiagnostic('stream.completed',{...context,durationMs:Date.now()-start,requestId:result.requestId||null,response:responseSummary(result.data)});return result;}
    catch(e){this.onDiagnostic('stream.failed',{...context,level:'error',durationMs:Date.now()-start,receivedMessageStart:first,error:errorDetails(e)});throw e;}
  }
  async messageOnce(payload,{onProgress,onEvent,deadlineMs=this.streamDeadlineMs}={}){
    const key=this.getKey(),startedAt=performance.now();if(!key)throw new ProviderError('Reconnect your Claude API key to continue.',{status:401});
    const client=new AnthropicSDK({apiKey:key,baseURL:this.base,fetch:this.fetch,maxRetries:0,logLevel:'off'});
    let started=false,completed=false,usage={},delta={},metadata={},lastProgress=0;
    const stream=client.messages.stream(payload,{timeout:180000,headers:betaHeaders(payload),signal:AbortSignal.timeout(Math.max(1,Math.min(deadlineMs,this.streamDeadlineMs)))});
    stream.on('streamEvent',event=>{
      if(event.type==='message_start'){started=true;usage={...usage,...event.message.usage};if(Object.hasOwn(event.message,'diagnostics'))metadata.diagnostics=event.message.diagnostics;}
      if(event.type==='message_delta'){usage={...usage,...event.usage};delta={...delta,...event.delta};}
      if(event.type==='message_stop')completed=true;
      if(started&&Date.now()-lastProgress>15000){lastProgress=Date.now();onProgress?.();}
      // A display callback must never end the stream whose charge is being recorded.
      if(onEvent)try{onEvent(event);}catch{}
    });
    try{const message=await stream.finalMessage();if(!completed)throw new Error('Incomplete stream');this.onKeyStatus(key,'connected','',startedAt);return {data:{...message,...delta,...metadata,usage:{...message.usage,...usage}},requestId:stream.request_id};}
    catch(e){
      const requestId=stream.request_id||e.requestID,body=e.error||{error:{type:e.type||'',message:''}},inner=body?.error||{};
      const rejection=!started&&((e.status>=400&&e.status<500&&e.status!==408)||['overloaded_error','api_error'].includes(inner.type));
      if(rejection){const failure=providerError(body,{status:e.status,headers:e.headers,requestId});if(e.status===401)this.onKeyStatus(key,'invalid',failure.message,startedAt);throw failure;}
      throw new ProviderError('The response stream ended before a complete result was received. Its estimated cost stays pending until the request is reconciled.',{status:e.status||0,ambiguous:true,requestId});
    }
  }
  batch(attempts,context={}){return this.request('/v1/messages/batches',{method:'POST',body:{requests:attempts.map(a=>({custom_id:a.id,params:a.payload}))},timeout:45000,context,headers:betaHeaders(...attempts.map(a=>a.payload))});}
  poll(id,context={}){return this.request(`/v1/messages/batches/${encodeURIComponent(id)}`,{timeout:30000,context});}
  results(id,context={}){return this.request(`/v1/messages/batches/${encodeURIComponent(id)}/results`,{timeout:60000,jsonl:true,context});}
  cancel(id,context={}){return this.request(`/v1/messages/batches/${encodeURIComponent(id)}/cancel`,{method:'POST',timeout:30000,context});}
}
