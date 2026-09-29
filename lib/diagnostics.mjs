import { createHash } from 'node:crypto';
import { VERSION, MODELS, LIMITS, PRICE_DATE } from './config.mjs';

export const DIAGNOSTIC_LIMIT=5000;
export function cacheDiagnostics(store,projectId,stageId){
  const previous=store.attempts(projectId).filter(a=>a.stage_id===stageId&&a.payload?.diagnostics&&a.response?.id).at(-1);
  return {previous_message_id:previous?.response.id??null};
}
function cacheDiagnosticSummary(message){
  if(!Object.hasOwn(message,'diagnostics'))return {state:'not_returned'};
  if(message.diagnostics===null)return {state:'no_divergence_or_no_comparison'};
  const reason=message.diagnostics?.cache_miss_reason;
  if(reason===null)return {state:'pending'};
  const reasons=['model_changed','system_changed','tools_changed','messages_changed','previous_message_not_found','unavailable'];
  if(!reasons.includes(reason?.type))return {state:'unrecognized'};
  return {state:'reported',reason:reason.type,...(Number.isSafeInteger(reason.cache_missed_input_tokens)&&reason.cache_missed_input_tokens>=0?{estimatedMissedInputTokens:reason.cache_missed_input_tokens}:{})};
}
export function redactText(value){
  return String(value??'')
    .replace(/sk-ant-[\w-]+/gi,'[redacted key]')
    .replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [redacted]')
    .replace(/((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi,'$1[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi,raw=>{try{const u=new URL(raw);u.username='';u.password='';u.search='';u.hash='';return u.href;}catch{return '[URL]';}})
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+/gi,'[user folder]')
    .slice(0,6000);
}
export function cleanDetails(value,depth=0){
  if(depth>8)return '[depth limit]';
  if(typeof value==='string')return redactText(value);
  if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  if(Array.isArray(value))return value.slice(0,100).map(v=>cleanDetails(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,80).map(([k,v])=>[k,/^(api.?key|authorization|password|secret|token|headers|body|prompt|messages|input|content|signature|encrypted_content|stack)$/i.test(k)?'[excluded]':cleanDetails(v,depth+1)]));
  return null;
}
export function errorDetails(error){
  return cleanDetails({message:error?.message||'Unknown error',name:error?.name||'Error',status:error?.status||0,type:error?.type||'',code:error?.code||'',requestId:error?.requestId||error?.requestID||null,ambiguous:Boolean(error?.ambiguous),retryable:Boolean(error?.retryable),retryAfterMs:error?.retryAfterMs||0,causeCode:error?.cause?.code||'',location:String(error?.stack||'').split('\n').slice(1,5).map(redactText)});
}
export function schemaSummary(schema){
  const text=JSON.stringify(schema||{}),stats={bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),objects:0,optionalProperties:0,unions:0,maxDepth:0};
  function walk(s,depth){if(!s||typeof s!=='object')return;stats.maxDepth=Math.max(stats.maxDepth,depth);if(s.type==='object'){stats.objects++;stats.optionalProperties+=Object.keys(s.properties||{}).filter(k=>!s.required?.includes(k)).length;}if(s.anyOf||Array.isArray(s.type))stats.unions++;for(const v of Object.values(s))if(v&&typeof v==='object'){if(Array.isArray(v))v.forEach(x=>walk(x,depth+1));else walk(v,depth+1);}}
  walk(schema,0);return stats;
}
export function requestSummary(p={}){
  return {model:p.model||'',maxOutputTokens:p.max_tokens||0,effort:p.output_config?.effort||'',thinking:p.thinking?.type||'',cacheTTL:p.cache_control?.ttl||'',cacheDiagnosticsEnabled:Boolean(p.diagnostics),previousMessageId:p.diagnostics?.previous_message_id||null,messageCount:p.messages?.length||0,tools:(p.tools||[]).map(t=>({name:t.name,type:t.type||'custom',strict:Boolean(t.strict),maxUses:t.max_uses??null,...(t.input_schema?{schema:schemaSummary(t.input_schema)}:{})})),...(p.output_config?.format?.schema?{reportSchema:schemaSummary(p.output_config.format.schema)}:{})};
}
export function responseSummary(message={}){
  const blockCounts={};for(const b of message.content||[])blockCounts[b.type]=(blockCounts[b.type]||0)+1;
  return {messageId:message.id||null,stopReason:message.stop_reason||null,blockCounts,toolNames:(message.content||[]).filter(b=>b.type==='tool_use'||b.type==='server_tool_use').map(b=>b.name),usage:cleanDetails(message.usage||{}),cacheDiagnostics:cacheDiagnosticSummary(message)};
}
export function diagnosticReport(store,{projectId=null,connection={}}={}){
  const projects=projectId?[store.project(projectId)].filter(Boolean):store.list();
  if(projectId&&!projects.length)throw new Error('Project not found.');
  const traceRows=store.diagnostics(projectId);
  return {
    format:'ahj-atlas-diagnostics',formatVersion:1,generatedAt:new Date().toISOString(),
    privacy:'API keys, request headers, prompts, research text, project inputs, and model thinking are excluded. Error messages may contain source details; review this file before sharing. Nothing is uploaded automatically.',
    application:{version:VERSION,node:process.version,platform:process.platform,architecture:process.arch,uptimeSeconds:Math.round(process.uptime()),models:MODELS,limits:LIMITS,priceDate:PRICE_DATE,connection:{keyConfigured:Boolean(connection.keyConfigured),keyStatus:String(connection.keyStatus||''),persisted:Boolean(connection.persisted),browserAvailable:Boolean(connection.browserAvailable)}},
    retention:{maximumEvents:DIAGNOSTIC_LIMIT,returnedEvents:traceRows.length,oldestReturnedAt:traceRows.at(-1)?.time||null,note:'Detailed tracing starts with version 1.2.0. Older requests are summarized from existing records; historical timing and full errors cannot be reconstructed.'},
    projects:projects.map(p=>({id:p.id,status:p.status,mode:p.mode,created:p.created,updated:p.updated,note:redactText(p.note),budget:p.budget,cost:p.cost,reserved:p.reserved,finalAllowance:p.finalAllowance,searches:p.searches,reads:p.reads,sourceCount:p.sourceCount,hasReport:Boolean(p.report),stages:store.stages(p.id).map(s=>({id:s.id,status:s.status,rounds:s.rounds,continuations:s.continuations,recoveries:s.recoveries,contextResets:s.context_resets||0,hasCheckpoint:Boolean(s.checkpoint?.brief||s.checkpoint?.sources?.length),savedMessages:s.messages.length,hasBrief:Boolean(s.output),note:redactText(s.note)})),attempts:store.attempts(p.id).map(a=>({id:a.id,stage:a.stage_id,mode:a.mode,state:a.state,created:a.created,updated:a.updated,requestId:a.request_id,batchId:a.batch_id,nextPoll:a.next_poll,applied:Boolean(a.applied),reservedMicrodollars:a.reserve,actualMicrodollars:a.actual,request:requestSummary(a.payload),response:a.response?responseSummary(a.response):null,usage:cleanDetails(a.usage)})),activity:store.events(p.id).map(e=>({...e,message:redactText(e.message)}))})),
    events:traceRows,
  };
}
