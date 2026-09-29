import { isFireProtection, completionBrief } from './fire-protection.mjs';
import { MODELS, LIMITS, STAGE_DEFS, costMicros, reserveMicros, reviewAllowance } from './config.mjs';
import { researchPayload, reviewPayload, validateReport, validCompletion, completionError, remainingSearches } from './prompts.mjs';
import { checkpointFromMessages, checkpointText, validateProgress } from './evidence.mjs';
import { ResearchTools } from './research-tools.mjs';
import { providerError, sanitize } from './provider.mjs';
import { decodeReport } from './report-format.mjs';
import { errorDetails, requestSummary, responseSummary } from './diagnostics.mjs';
import { questionContext } from './questions.mjs';
import { normalizeCompletion } from './model-values.mjs';

const terminal=new Set(['complete','partial','canceled','attention','budget','failed','needs_key']);
const parallelReads=2;
export class Engine{
  constructor(store,provider,getKey,{tools=new ResearchTools(store),pollMs=60000,autoStart=true}={}){
    this.store=store;this.provider=provider;this.getKey=getKey;this.tools=tools;this.pollMs=pollMs;this.running=new Set();this.polling=new Set();this.applying=new Set();this.closed=false;
    store.recover();if(autoStart)this.timer=setInterval(()=>this.tick().catch(e=>this.store.diagnostic('worker.tick_failed',{level:'error',error:errorDetails(e)})),1000);
  }
  start(){return this.tick();}
  async tick(){
    if(this.closed)return;
    const projects=this.store.list();
    for(const p of projects){
      const attempts=this.store.attempts(p.id).filter(a=>a.stage_id!=='chat');
      for(const a of attempts.filter(a=>a.state==='received'&&!a.applied)){
        const key=`apply:${a.id}`;if(!this.running.has(key)&&!this.applying.has(a.id)&&!this.running.has(`${p.id}:${a.stage_id}`)&&this.running.size<2){this.running.add(key);this.apply(a).catch(e=>this.fail(p.id,a.stage_id,e.message)).finally(()=>this.running.delete(key));}
      }
      const batches=[...new Set(attempts.filter(a=>a.state==='pending'&&a.batch_id&&a.next_poll<=Date.now()).map(a=>a.batch_id))];
      if(this.getKey())for(const id of batches)if(!this.polling.has(id)){this.polling.add(id);this.pollBatch(id,p.id).finally(()=>this.polling.delete(id));}
      if(p.cancel_requested){if(!attempts.some(a=>['dispatching','pending'].includes(a.state)))this.store.updateProject(p.id,{status:attempts.some(a=>a.state==='unknown')?'attention':'canceled'});continue;}
      if(terminal.has(p.status))continue;
      if(!this.getKey()){this.store.updateProject(p.id,{status:'needs_key',note:'Reconnect your Claude API key to continue. Saved work will be reused.'});continue;}
      if(attempts.some(a=>a.state==='unknown')){this.store.updateProject(p.id,{status:'attention',note:'A previous request has an uncertain outcome. Reconcile it before continuing.'});continue;}
      if(p.status==='waiting'&&attempts.some(a=>a.next_poll>Date.now()))continue;
      const stages=this.store.stages(p.id);
      for(const stage of stages){
        if(this.running.size>=2)break;
        const key=`${p.id}:${stage.id}`;
        if(this.running.has(key)||!['queued','preparing'].includes(stage.status))continue;
        if(attempts.some(a=>a.stage_id===stage.id&&a.state==='errored'&&a.next_poll>Date.now()))continue;
        if(attempts.some(a=>a.stage_id===stage.id&&['dispatching','pending','received','unknown'].includes(a.state)&&!a.applied))continue;
        if(stage.id!=='jurisdiction'&&!['complete','partial'].includes(stages[0].status))continue;
        if(stage.id==='verification'&&!stages.filter(s=>['jurisdiction','contacts','codes'].includes(s.id)).every(s=>['complete','partial'].includes(s.status)))continue;
        if(stage.id==='review'&&!stages.filter(s=>s.id!=='review').every(s=>['complete','partial'].includes(s.status)))continue;
        this.running.add(key);this.dispatch(p.id,stage.id).catch(e=>this.fail(p.id,stage.id,e.message)).finally(()=>this.running.delete(key));
      }
    }
  }
  fail(projectId,stageId,message){
    const p=this.store.project(projectId);if(!p)return;
    this.store.updateStage(projectId,stageId,{status:'blocked',note:message});
    this.store.updateProject(projectId,{status:'attention',note:message});this.store.event(projectId,'warning',message);this.store.diagnostic('stage.blocked',{level:'error',projectId,stageId,message});
  }
  async dispatch(projectId,stageId){
    let p=this.store.project(projectId),stage=this.store.stage(projectId,stageId);const def=STAGE_DEFS.find(s=>s.id===stageId);
    if(p.cancel_requested)return;
    const roundLimit=stageId==='verification'?LIMITS.verificationRounds:stageId==='review'?LIMITS.reviewRounds:LIMITS.rounds;
    if(stage.rounds>=roundLimit){this.markPartial(projectId,stageId,'The bounded research round limit was reached. Saved progress and evidence are retained.');return;}
    if(p.mode==='realtime'&&p.active_ms>=LIMITS.activeMs&&stageId!=='review'){this.markPartial(projectId,stageId,'The active research time allowance was reached.');return;}
    this.store.updateStage(projectId,stageId,{status:'preparing'});
    let finishOnly=stage.rounds===roundLimit-1,fresh=false;
    const lastAssistant=stage.messages.filter(m=>m.role==='assistant').at(-1);
    const deniedSearch=lastAssistant?.content?.some?.(b=>b.type==='web_search_tool_result'&&b.content?.error_code==='max_uses_exceeded');
    const oldSearchCap=this.store.attempts(p.id).filter(a=>a.stage_id===stageId).at(-1)?.payload?.tools?.find(t=>t.name==='web_search')?.max_uses||0;
    const searchesLeft=remainingSearches(this.store,p,stageId);
    if(stage.messages.length&&(finishOnly||(stageId!=='review'&&(deniedSearch&&searchesLeft>0||oldSearchCap>searchesLeft)))){
      stage=this.freshContext(p,stage,finishOnly?'completion':deniedSearch?'search_limit':'search_allocation');fresh=true;
      if(stage.context_resets>LIMITS.contextResets)finishOnly=true;
    }
    const build=(characterBudget)=>stageId==='review'?reviewPayload(this.store,p,{fresh,finishOnly,...(characterBudget?{characterBudget}:{})}):researchPayload(this.store,p,stage,{fresh,finishOnly,...(characterBudget?{characterBudget}:{})});
    let payload=build();
    const preflight=body=>this.provider.preflight?.(p.mode,{projectId,stageId},{modelKeys:def.model==='research'&&body.model===MODELS.research.id?['research','review']:[def.model],modelIds:{[def.model]:body.model},outputLimits:{[def.model]:body.max_tokens}});
    let inputTokens;
    try{
      await preflight(payload);
      inputTokens=await this.provider.count(payload,{projectId,stageId});
      if(Number.isFinite(inputTokens)&&inputTokens>=LIMITS.checkpointInput){
        const previousInput=inputTokens;
        if(stage.messages.length){stage=this.freshContext(p,stage,'input_context');fresh=true;}
        if(stageId!=='review'&&stage.context_resets>LIMITS.contextResets)finishOnly=true;
        payload=build(80000);await preflight(payload);
        inputTokens=await this.provider.count(payload,{projectId,stageId});
        if(inputTokens>LIMITS.input){payload=build(30000);await preflight(payload);inputTokens=await this.provider.count(payload,{projectId,stageId});}
        this.store.diagnostic('context.rebuilt',{projectId,stageId,previousInputTokens:previousInput,inputTokens,finishOnly});
      }
    }catch(e){
      this.store.diagnostic('request.preflight_failed',{level:'error',projectId,stageId,error:errorDetails(e),request:requestSummary(payload)});
      this.store.updateStage(projectId,stageId,{status:'queued'});
      this.store.updateProject(projectId,{status:e.status===401?'needs_key':'attention',note:e.message});this.store.event(projectId,'warning',e.message);return;
    }
    if(!Number.isFinite(inputTokens)||inputTokens>LIMITS.input){this.markPartial(projectId,stageId,'The evidence package reached its input limit. Narrow the project or resolve the remaining questions with the AHJ.');return;}
    this.store.diagnostic('request.preflight_complete',{projectId,stageId,inputTokens,request:requestSummary(payload)});
    p=this.store.project(projectId);if(p.cancel_requested||terminal.has(p.status)){this.store.updateStage(projectId,stageId,{status:'queued'});return;}
    const searchCap=payload.tools?.find(t=>t.name==='web_search')?.max_uses||0;
    const reserve=reserveMicros(inputTokens,def.model,p.mode,payload.max_tokens,searchCap,payload.cache_control?.ttl);
    let attempt;
    try{attempt=this.store.reserve(projectId,stageId,{mode:p.mode,modelKey:def.model,payload,reserve,finalBuffer:stageId==='review'?0:reviewAllowance(p.mode)});}
    catch(e){
      this.store.diagnostic('budget.request_blocked',{level:'warning',projectId,stageId,reason:e.message,reserveMicrodollars:reserve,finalHoldMicrodollars:stageId==='review'?0:reviewAllowance(p.mode)});
      if(['PROJECT_BUDGET','DAILY_BUDGET'].includes(e.message)){
        if(stageId==='verification'){this.markPartial(projectId,stageId,'The next Opus evidence check would use the allowance reserved for the final report. Preparing the report with remaining questions identified.');return;}
        const note=e.message==='PROJECT_BUDGET'?`The next request needs an allowance of $${(reserve/1e6).toFixed(2)}${stageId==='review'?'':` plus $${(reviewAllowance(p.mode)/1e6).toFixed(2)} reserved for the final report`}. Increase the project budget or finish with saved evidence. The larger output ceilings are included in this allowance; actual use may be lower.`:'The daily spending allowance is reserved or spent. Increase the daily allowance or resume another day.';
        this.store.updateStage(projectId,stageId,{status:'queued',note});this.store.updateProject(projectId,{status:'budget',note});this.store.event(projectId,'warning',note);return;
      }if(e.message==='SEARCH_BUDGET'){this.markPartial(projectId,stageId,'The remaining search allowance is spent or reserved by other requests. Saved evidence will be retained.');return;}throw e;
    }
    this.store.updateStage(projectId,stageId,{status:'running',rounds:stage.rounds+1,note:''});
    this.store.updateProject(projectId,{status:p.mode==='batch'?'waiting_batch':'researching',note:''});
    this.store.event(projectId,'info',`${def.label}: ${p.mode==='batch'?'submitting a batch request':'research request started'} (${def.effort} effort).`);
    const started=Date.now();
    const context={projectId,stageId,attemptId:attempt.id};
    this.store.diagnostic('request.dispatch',{...context,mode:p.mode,inputTokens,reserveMicrodollars:reserve,request:requestSummary(payload)});
    try{
      if(p.mode==='batch'){
        const {data,requestId}=await this.provider.batch([attempt],context);
        if(!data?.id)throw Object.assign(new Error('Batch submission did not return an identifier. Its outcome is uncertain.'),{ambiguous:true});
        this.store.updateAttempt(attempt.id,{state:'pending',batch_id:data.id,request_id:requestId,next_poll:Date.now()+this.pollMs});
        this.store.updateStage(projectId,stageId,{status:'waiting_batch'});
        this.store.event(projectId,'info',`${def.label}: batch accepted. Waiting for Anthropic to finish this stage.`);
      }else{
        const {data,requestId}=await this.provider.message(payload,{context,onProgress:()=>{
          const latest=this.store.project(projectId);if(latest&&!latest.cancel_requested)this.store.updateProject(projectId,{note:`${def.label}: Claude is responding. The app is receiving the response as it is generated.`});
        }});
        this.record(attempt,data,requestId);
        const latest=this.store.project(projectId);this.store.updateProject(projectId,{active_ms:latest.active_ms+(Date.now()-started)});
        await this.apply(this.store.attempt(attempt.id));
      }
    }catch(e){
      this.store.diagnostic('request.failed',{...context,level:'error',durationMs:Date.now()-started,error:errorDetails(e)});
      const current=this.store.attempt(attempt.id);if(current.state==='received'){this.fail(projectId,stageId,e.message);return;}
      this.store.updateAttempt(attempt.id,{state:e.ambiguous?'unknown':'errored',request_id:e.requestId||null,applied:1});
      const note=e.ambiguous?'Anthropic did not confirm the request outcome. The cost reservation is retained. Do not resubmit until the original request is reconciled.':e.message;
      const tries=this.store.attempts(projectId).filter(a=>a.stage_id===stageId&&a.state==='errored').length;
      if(!e.ambiguous&&e.retryable&&tries<=2){this.store.updateAttempt(attempt.id,{next_poll:Date.now()+Math.max(e.retryAfterMs||0,30000*2**(tries-1))});this.store.updateStage(projectId,stageId,{status:'queued',note});this.store.updateProject(projectId,{status:'waiting',note:'Waiting before a bounded retry. '+note});}
      else{this.store.updateStage(projectId,stageId,{status:'blocked',note});this.store.updateProject(projectId,{status:e.status===401?'needs_key':'attention',note});}
      this.store.event(projectId,'warning',note);
    }
  }
  record(attempt,message,requestId){
    const current=this.store.attempt(attempt.id);if(current.state==='received'||current.state==='settled')return;
    this.store.diagnostic('request.received',{projectId:attempt.project_id,stageId:attempt.stage_id,attemptId:attempt.id,requestId:requestId||null,response:responseSummary(message)});
    if(!message?.usage||!Number.isFinite(message.usage.input_tokens)||!Number.isFinite(message.usage.output_tokens)){
      this.store.updateAttempt(attempt.id,{state:'unknown',response:message,request_id:requestId||message?.id||null,applied:1});
      this.fail(attempt.project_id,attempt.stage_id,'The response did not include a usable cost record. Its reservation is retained until the charge is reconciled.');return;
    }
    this.store.updateAttempt(attempt.id,{state:'received',response:message,usage:message.usage||{},actual:costMicros(message.usage,attempt.model_key,attempt.mode),request_id:requestId||message.id||null,applied:0});
  }
  captureSources(projectId,message,context={}){
    for(const block of message.content||[]){
      if(block.type==='web_search_tool_result'){
        if(Array.isArray(block.content))for(const source of block.content)if(source.url)this.store.source(projectId,{url:source.url,title:source.title||'',readFull:false});
        if(block.content?.type?.includes('error')){this.store.event(projectId,'warning',`A search could not finish (${block.content.error_code||'tool error'}).`);this.store.diagnostic('search.failed',{level:'warning',projectId,...context,errorCode:block.content.error_code||'tool_error'});}
      }
      for(const c of block.citations||[]){const url=c.url||c.source;if(url)this.store.source(projectId,{url,title:c.title||'',text:c.cited_text||'',readFull:false});}
    }
  }
  async apply(attempt){
    if(this.applying.has(attempt.id))return;
    this.applying.add(attempt.id);const started=Date.now();
    try{return await this.applyOnce(attempt);}finally{const p=this.store.project(attempt.project_id);if(p)this.store.updateProject(p.id,{active_ms:p.active_ms+Date.now()-started});this.applying.delete(attempt.id);}
  }
  async readGroup(attempt,stage,calls){
    calls=[...new Map(calls.map(call=>[call.id,call])).values()];
    const projectId=attempt.project_id;
    // Admission is synchronous: each started tool reserves one read before
    // another stage can inspect the counters. Persistence remains call-ordered.
    const work=calls.map(call=>{
      if(this.store.tool(attempt.id,call.id)?.result)return {call};
      try{
        const p=this.store.project(projectId),existing=this.store.tool(attempt.id,call.id);
        if(p.cancel_requested||this.closed)throw new Error('Research was canceled.');
        if(!attempt.payload.tools?.some(t=>t.name===call.name))throw new Error('This tool is not available in the current research step.');
        if(!existing&&p.reads>=LIMITS.reads)throw new Error('The project source-reading limit was reached.');
        if(!existing&&stage.id==='verification'&&this.store.stageUsage(projectId,stage.id).reads>=LIMITS.verificationReads)throw new Error('The Opus evidence-check reading allowance is exhausted. Finish with unresolved questions.');
        this.store.beginTool(attempt.id,call.id,call.name);
        const started=Date.now();this.store.diagnostic('tool.started',{projectId,stageId:stage.id,attemptId:attempt.id,tool:call.name,toolId:call.id});
        return {call,started,promise:Promise.resolve().then(()=>this.tools.prepareRead(call.input||{}))};
      }catch(error){return {call,error};}
    });
    const prepared=await Promise.allSettled(work.map(w=>w.promise));
    for(let i=0;i<work.length;i++){
      const {call,started}=work[i];if(this.store.tool(attempt.id,call.id)?.result)continue;
      let saved;
      try{
        const error=work[i].error||(prepared[i].status==='rejected'?prepared[i].reason:null);if(error)throw error;
        // Finish saving reads already started if cancellation arrived in flight.
        const result=this.tools.commitRead(projectId,prepared[i].value);
        saved={type:'tool_result',tool_use_id:call.id,content:[{type:'text',text:result.text}]};
        this.store.diagnostic('tool.completed',{projectId,stageId:stage.id,attemptId:attempt.id,tool:call.name,toolId:call.id,durationMs:Date.now()-started,resultCharacters:result.text.length,hasImage:false});
        this.store.event(projectId,'source',`${STAGE_DEFS.find(s=>s.id===stage.id).label}: read a public source.`);
      }catch(error){
        saved={type:'tool_result',tool_use_id:call.id,is_error:true,content:error.message};
        this.store.diagnostic('tool.failed',{level:'warning',projectId,stageId:stage.id,attemptId:attempt.id,tool:call.name,toolId:call.id,error:errorDetails(error)});
        this.store.event(projectId,'warning',`Source access gap: ${String(error.message).slice(0,200)}`);
      }
      this.store.saveTool(attempt.id,call.id,call.name,saved);
    }
  }
  async applyOnce(attempt){
    if(attempt.applied||attempt.state!=='received')return;
    const p=this.store.project(attempt.project_id),stage=this.store.stage(p.id,attempt.stage_id),message=attempt.response;
    this.captureSources(p.id,message,{stageId:stage.id,attemptId:attempt.id});
    const content=message?.content||[],text=content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    if(p.cancel_requested){
      this.store.updateStage(p.id,stage.id,{status:'partial',output:stage.output+'\n'+text,note:'Canceled after the in-flight request returned.'});this.store.updateAttempt(attempt.id,{state:'settled',applied:1});this.store.event(p.id,'info','An in-flight response was saved after cancellation; no further research was started.');return;
    }
    if(message.stop_reason==='max_tokens'){
      this.store.db.exec('BEGIN IMMEDIATE');try{
      this.store.updateAttempt(attempt.id,{state:'settled',applied:1});
      if(stage.recoveries<1){
        this.store.updateStage(p.id,stage.id,{status:'queued',messages:[],recoveries:stage.recoveries+1,output:(stage.output+'\n'+text).slice(-60000),note:'The output limit was reached. One compact recovery is queued, subject to the remaining budget.'});
        this.store.event(p.id,'warning','A response reached its output ceiling. Its cost was recorded; one budget-checked recovery will reuse saved evidence without executing incomplete tool calls.');
      }else this.markPartial(p.id,stage.id,'The response reached its output ceiling again. Saved evidence is retained; narrow the scope or explicitly continue.');
      this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
      return;
    }
    if(stage.id==='review'&&message.stop_reason!=='tool_use'){
      if(message.stop_reason!=='end_turn'){this.store.updateAttempt(attempt.id,{state:'settled',applied:1});this.fail(p.id,stage.id,`The final review was incomplete (${message.stop_reason||'unknown stop'}). Saved evidence remains available.`);return;}
      let report;try{const parsed=JSON.parse(text);report=validateReport(attempt.payload.output_config?.format?.schema?.properties?.items?decodeReport(parsed):parsed,this.store.sources(p.id),this.store.stages(p.id),this.store.knownLinks(p.id),p.input);}catch(e){this.store.diagnostic('report.validation_failed',{level:'error',projectId:p.id,stageId:stage.id,attemptId:attempt.id,error:errorDetails(e)});this.store.updateAttempt(attempt.id,{state:'settled',applied:1});this.fail(p.id,stage.id,'The review did not return a valid, evidence-linked report. Saved research is available; resume to retry only the review.');return;}
      if(report.fireProtection)this.store.diagnostic('report.fire_protection_coverage',{projectId:p.id,stageId:stage.id,attemptId:attempt.id,profileVersion:report.fireProtection.profileVersion,targets:report.fireProtection.targets.length,findings:report.fireStandards.length,unresolved:report.fireProtection.unresolved});
      const incomplete=report.gaps.length>0||this.store.stages(p.id).some(s=>s.id!=='review'&&s.status==='partial');
      this.store.db.exec('BEGIN IMMEDIATE');try{this.store.updateProject(p.id,{report,status:incomplete?'partial':'complete',note:incomplete?'Research finished with questions to confirm. See the report for details.':''});this.store.updateStage(p.id,stage.id,{status:'complete',output:text,note:''});this.store.updateAttempt(attempt.id,{state:'settled',applied:1});this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
      this.store.event(p.id,'success',`Report ready. ${report.codes.length+(report.fireStandards?.length||0)} code/standard entries, ${report.contacts.length} contacts, ${report.gaps.length} questions to resolve.`);return;
    }
    const messages=[...attempt.payload.messages,{role:'assistant',content}];
    let status='queued',note='',output=stage.output,continuations=stage.continuations,checkpoint=stage.checkpoint;
    if(message.stop_reason==='tool_use'){
      const calls=content.filter(c=>c.type==='tool_use');if(!calls.length){status='partial';note='The provider requested tools without a complete tool call.';}
      const results=[];
      for(let index=0;index<calls.length;index++){
        const call=calls[index];
        if(call.name==='read_source'&&this.tools.prepareRead&&this.tools.commitRead&&!this.store.tool(attempt.id,call.id)?.result){
          const group=[];
          for(let next=index;next<calls.length&&group.length<parallelReads&&calls[next].name==='read_source';next++)group.push(calls[next]);
          await this.readGroup(attempt,stage,group);
        }
        let saved=this.store.tool(attempt.id,call.id)?.result;
        if(!saved){
          try{
            if(this.store.project(p.id).cancel_requested)throw new Error('Research was canceled.');
            if(!attempt.payload.tools?.some(t=>t.name===call.name))throw new Error('This tool is not available in the current research step.');
            if(call.name==='finish_research'){
              if(calls.length!==1||!validCompletion(call.input,stage.id,attempt.payload.tools?.find(t=>t.name==='finish_research')?.input_schema?.properties?.standards?p.input:undefined))throw new Error(calls.length!==1?'Call finish_research by itself.':completionError(call.input,stage.id,attempt.payload.tools?.find(t=>t.name==='finish_research')?.input_schema?.properties?.standards?p.input:undefined));
              saved={type:'tool_result',tool_use_id:call.id,content:'Investigation recorded.'};
              status='complete';output=completionBrief(call.input).slice(0,240000);note='Coverage: '+Object.entries(normalizeCompletion(call.input).coverage).map(([k,v])=>k+' '+v).join('; ');
            }else if(call.name==='save_progress'){
              checkpoint={...checkpoint,...validateProgress(call.input,this.store.sources(p.id))};
              saved={type:'tool_result',tool_use_id:call.id,content:'Working progress saved. Continue the outstanding research or finish_research.'};
            }else{
            const isRead=['read_source','render_page','inspect_pdf'].includes(call.name);
            if(isRead&&this.store.project(p.id).reads>=LIMITS.reads)throw new Error('The project source-reading limit was reached.');
            if(isRead&&stage.id==='verification'&&this.store.stageUsage(p.id,stage.id).reads>=LIMITS.verificationReads)throw new Error('The Opus evidence-check reading allowance is exhausted. Finish with unresolved questions.');
            this.store.beginTool(attempt.id,call.id,call.name);
            const toolStarted=Date.now();this.store.diagnostic('tool.started',{projectId:p.id,stageId:stage.id,attemptId:attempt.id,tool:call.name,toolId:call.id});
            const result=await this.tools.run(p.id,call.name,call.input||{});
            this.store.diagnostic('tool.completed',{projectId:p.id,stageId:stage.id,attemptId:attempt.id,tool:call.name,toolId:call.id,durationMs:Date.now()-toolStarted,resultCharacters:result.text?.length||0,hasImage:Boolean(result.image)});
            saved={type:'tool_result',tool_use_id:call.id,content:[{type:'text',text:result.text},...(result.image?[{type:'image',source:{type:'base64',media_type:'image/png',data:result.image}}]:[])]};
            this.store.event(p.id,'source',`${STAGE_DEFS.find(s=>s.id===stage.id).label}: ${call.name==='locate_address'?'checked address geographies':call.name==='inspect_pdf'?'inspected a PDF page':'read a public source'}.`);
            }
          }catch(e){this.store.diagnostic('tool.failed',{level:'warning',projectId:p.id,stageId:stage.id,attemptId:attempt.id,tool:call.name,toolId:call.id,error:errorDetails(e)});saved={type:'tool_result',tool_use_id:call.id,is_error:true,content:e.message};this.store.event(p.id,'warning',`${call.name==='finish_research'?'Coverage check':'Source access gap'}: ${String(e.message).slice(0,200)}`);}
          this.store.saveTool(attempt.id,call.id,call.name,saved);
        }
        if(call.name==='save_progress'&&!saved.is_error)checkpoint={...checkpoint,...validateProgress(call.input,this.store.sources(p.id))};
        if(call.name==='finish_research'&&!saved.is_error&&validCompletion(call.input,stage.id,attempt.payload.tools?.find(t=>t.name==='finish_research')?.input_schema?.properties?.standards?p.input:undefined)&&calls.length===1){status='complete';output=completionBrief(call.input).slice(0,240000);note='Coverage: '+Object.entries(normalizeCompletion(call.input).coverage).map(([k,v])=>k+' '+v).join('; ');}
        results.push(saved);
      }
      if(results.length)messages.push({role:'user',content:results});
    }else if(message.stop_reason==='pause_turn'){
      note='Continuing a paused provider research turn.';
    }else if(message.stop_reason==='end_turn'){
      output=(stage.output+'\n'+text).trim();
      if(attempt.payload.tools?.some(t=>t.name==='finish_research')){
        if(stage.continuations<LIMITS.continuations){
          messages.push({role:'user',content:'Your investigation has not supplied its completion checklist. Continue any outstanding assigned work within the stated limits. If blocked, document the gap and next step. Then call finish_research by itself with a concise source-linked brief and the coverage statuses.'});
          continuations++;note='Checking outstanding coverage before completing this stage.';
        }else{status='partial';note='The investigation ended without the required coverage checklist after two follow-ups. Review the saved findings and unresolved coverage.';}
      }else{status=text.trim()?'complete':'partial';if(status==='partial')note='This stage returned no findings.';}
    }else{
      status='partial';output=stage.output+'\n'+text;note=message.stop_reason==='refusal'?`Claude declined this request${message.stop_details?' ('+sanitize(JSON.stringify(message.stop_details))+')':''}. Saved evidence is retained; review the scope before continuing.`:`The stage stopped before completion (${message.stop_reason||'unknown reason'}).`;
    }
    this.store.db.exec('BEGIN IMMEDIATE');try{
      checkpoint=checkpointFromMessages({...stage,checkpoint},messages,this.store.sources(p.id));
      this.store.updateStage(p.id,stage.id,{status,messages,output,note,continuations,checkpoint});this.store.updateAttempt(attempt.id,{state:'settled',applied:1});
      if(!terminal.has(this.store.project(p.id).status))this.store.updateProject(p.id,{status:p.mode==='batch'?'waiting_batch':'researching',note:''});
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    if(status==='complete')this.store.event(p.id,'success',`${STAGE_DEFS.find(s=>s.id===stage.id).label} evidence brief completed.`);
    if(status==='partial')this.store.event(p.id,'warning',note);
  }
  markPartial(projectId,stageId,note){
    const stage=this.store.stage(projectId,stageId),checkpoint=checkpointFromMessages(stage,stage.messages,this.store.sources(projectId));
    this.store.updateStage(projectId,stageId,{status:'partial',note,checkpoint,output:stage.output||checkpointText({...stage,checkpoint})});
    if(stageId==='review')this.store.updateProject(projectId,{status:'attention',note});
    this.store.event(projectId,'warning',note);
  }
  freshContext(project,stage,reason){
    const checkpoint=checkpointFromMessages(stage,stage.messages,this.store.sources(project.id));
    this.store.updateStage(project.id,stage.id,{messages:[],checkpoint,context_resets:(stage.context_resets||0)+1});
    this.store.diagnostic('context.checkpoint',{projectId:project.id,stageId:stage.id,reason,previousMessages:stage.messages.length,savedSources:checkpoint.sources.length});
    this.store.event(project.id,'info',`${STAGE_DEFS.find(s=>s.id===stage.id).label}: continuing from saved findings and targeted evidence (${reason==='input_context'?'research history became large':reason==='completion'?'preparing the completion brief':'search allowance updated'}).`);
    return this.store.stage(project.id,stage.id);
  }
  async pollBatch(batchId,projectId){
    const attempts=this.store.attempts(projectId).filter(a=>a.batch_id===batchId&&a.state==='pending');if(!attempts.length)return;
    const context={projectId,batchId,stageId:attempts[0].stage_id,attemptId:attempts[0].id};
    if(attempts.some(a=>Date.now()-Date.parse(a.created)>LIMITS.batchRetentionMs)){
      for(const a of attempts)this.store.updateAttempt(a.id,{state:'unknown'});
      this.fail(projectId,attempts[0].stage_id,'The batch is beyond Anthropic’s 29-day result-retention window. Automatic polling stopped; confirm the outcome and charge in Anthropic Console.');return;
    }
    for(const a of attempts)this.store.updateAttempt(a.id,{next_poll:Date.now()+this.pollMs});
    try{
      if(this.store.project(projectId).cancel_requested&&attempts.some(a=>!a.cancel_sent)){
        try{await this.provider.cancel(batchId,context);for(const a of attempts)this.store.updateAttempt(a.id,{cancel_sent:1});this.store.event(projectId,'info','Batch cancellation requested. Completed requests may still be billed.');}
        catch(e){
          if([400,403,404,409,410,422].includes(e.status))for(const a of attempts)this.store.updateAttempt(a.id,{cancel_sent:1});
          this.store.event(projectId,'warning','Cancellation was not confirmed. Checking the original batch for results. '+sanitize(e.message));
        }
      }
      const {data}=await this.provider.poll(batchId,context);if(data.processing_status!=='ended')return;
      const result=await this.provider.results(batchId,context);await this.importBatch(projectId,batchId,result.data);
    }catch(e){
      this.store.diagnostic('batch.retrieval_failed',{...context,level:'error',error:errorDetails(e)});
      if(e.status===401)this.store.updateProject(projectId,{status:'needs_key',note:e.message});
      else if([400,402,403,404,410].includes(e.status)||e.code==='spend_limit'){
        for(const a of attempts)this.store.updateAttempt(a.id,{state:'unknown'});
        this.fail(projectId,attempts[0].stage_id,'Batch retrieval needs attention. '+e.message+' Its cost allowance remains reserved until reconciled.');
      }else for(const a of attempts)this.store.updateAttempt(a.id,{next_poll:Date.now()+Math.max(e.retryAfterMs||0,this.pollMs*2)});
    }
  }
  async importBatch(projectId,batchId,results){
    const attempts=this.store.attempts(projectId).filter(a=>a.batch_id===batchId&&a.state==='pending');
    for(const a of attempts){
      const row=results.find(r=>r.custom_id===a.id);
      if(!row){this.store.updateAttempt(a.id,{state:'unknown'});this.fail(projectId,a.stage_id,'A finished batch did not include the expected request. Its reservation remains until reconciled.');continue;}
      if(row.result?.type==='succeeded'&&row.result.message){this.record(a,row.result.message);await this.apply(this.store.attempt(a.id));}
      else if(['errored','canceled','expired'].includes(row.result?.type)){
        this.store.updateAttempt(a.id,{state:row.result.type,applied:1});
        const error=row.result.type==='errored'?providerError(row.result.error):null;
        this.store.diagnostic('batch.result_failed',{level:'error',projectId,stageId:a.stage_id,attemptId:a.id,batchId,resultType:row.result.type,error:error?errorDetails(error):null});
        const note=`Batch request ${row.result.type}.${error?' '+error.message:''} Completed requests and saved sources have been preserved.`;
        const tries=this.store.attempts(projectId).filter(t=>t.stage_id===a.stage_id&&t.state==='errored').length;
        const retry=error?.retryable&&tries<=2&&!this.store.project(projectId).cancel_requested;
        if(retry)this.store.updateAttempt(a.id,{next_poll:Date.now()+Math.max(error.retryAfterMs||0,30000*2**(tries-1))});
        this.store.updateStage(projectId,a.stage_id,{status:retry?'queued':'blocked',note});
        if(!this.store.project(projectId).cancel_requested)this.store.updateProject(projectId,{status:retry?'waiting':'attention',note});
        this.store.event(projectId,'warning',note);
      }else{this.store.updateAttempt(a.id,{state:'unknown'});this.fail(projectId,a.stage_id,'The batch returned an unrecognized result. Review its outcome before continuing.');}
    }
  }
  async cancel(id){
    this.store.diagnostic('project.cancel_requested',{projectId:id});
    this.store.updateProject(id,{cancel_requested:1,status:'canceling',final_hold:0,note:'No new work will be scheduled. Any in-flight requests will be reconciled.'});
    for(const a of this.store.attempts(id).filter(a=>a.state==='pending'))this.store.updateAttempt(a.id,{next_poll:0});
    this.store.event(id,'info','Research canceled. Waiting for any in-flight results.');await this.tick();
  }
  async resume(id,{budget,mode,clarification,finishPartial=false,focus}={}){
    const p=this.store.project(id);if(!p)throw new Error('Project not found.');
    if(this.running.size&&[...this.running].some(k=>k.startsWith(id+':')))throw new Error('Wait for the current request to finish before changing this project.');
    const unsettled=this.store.attempts(id).filter(a=>['dispatching','pending','unknown','received'].includes(a.state));
    if(unsettled.length)throw new Error('Reconcile or wait for the outstanding request before restarting this project.');
    const nextBudget=Number(budget??p.budget);if(!Number.isFinite(nextBudget)||nextBudget<Math.max(1,p.cost+p.reserved)||nextBudget>100)throw new Error('The budget must cover recorded and reserved costs and be at most $100.');
    if(mode&&!['batch','realtime'].includes(mode))throw new Error('Choose a valid processing mode.');
    if(focus&&focus!=='fire_protection')throw new Error('Choose a supported research focus.');
    if(focus&&(!isFireProtection(p.input)||finishPartial||String(clarification||'').trim()))throw new Error('A focused NFPA update requires a fire protection project and no simultaneous scope change.');
    if(focus&&this.store.stages(id).some(s=>['jurisdiction','contacts'].includes(s.id)&&s.status!=='complete'))throw new Error('Complete the initial jurisdiction and contact research before a focused NFPA update.');
    clarification=String(clarification??'').trim().slice(0,4000);
    const input={...p.input,questionResponses:questionContext(p.questionResponses)};
    const contextChanged=Boolean(clarification)||p.questionUpdatesPending;
    if(clarification)input.notes=((input.notes||'')+'\nUser clarification: '+String(clarification).slice(0,4000)).trim();
    for(const stage of this.store.stages(id)){
      const checkpoint=checkpointFromMessages(stage,stage.messages,this.store.sources(id));
      if(focus){if(['codes','verification','review'].includes(stage.id))this.store.updateStage(id,stage.id,{status:'queued',messages:[],checkpoint,rounds:0,continuations:0,recoveries:0,context_resets:0,note:''});continue;}
      if(finishPartial&&stage.id!=='review'&&stage.status!=='complete')this.markPartial(id,stage.id,'User chose to finish a report with the evidence collected so far.');
      else if(stage.id==='review'||stage.status!=='complete'||contextChanged){
        const restart=stage.status==='partial'||stage.status==='blocked'||contextChanged;
        this.store.updateStage(id,stage.id,{status:'queued',note:'',checkpoint,...(restart?{messages:[],rounds:0,continuations:0,recoveries:0,context_resets:0}:{}),...(stage.id==='review'?{messages:[],rounds:0,recoveries:0,context_resets:0}:{} )});
      }
    }
    this.store.updateProject(id,{status:'queued',budget:nextBudget,mode:mode||p.mode,cancel_requested:0,active_ms:0,input,note:''});
    this.store.diagnostic('project.resumed',{projectId:id,budget:nextBudget,mode:mode||p.mode,scopeChanged:contextChanged,finishPartial,focus:focus||null});
    this.store.event(id,'info',focus?'Focused NFPA research started. Saved jurisdiction, contacts, sources and costs are retained.':finishPartial?'Preparing a partial report from saved evidence.':'Research resumed. Completed work and recorded spending have been retained.');await this.tick();
  }
  async reconcile(id,batchId){
    if(!/^msgbatch_[a-zA-Z0-9]+$/.test(batchId))throw new Error('Enter the batch ID shown in your Anthropic Console.');
    const unknown=this.store.attempts(id).filter(a=>a.state==='unknown'&&a.mode==='batch');if(!unknown.length)throw new Error('There is no uncertain batch submission to reconcile.');
    const {data}=await this.provider.poll(batchId,{projectId:id,batchId});if(data.processing_status!=='ended')throw new Error('Wait until this batch finishes. Its result identifiers are needed to prove it belongs to this project.');
    const results=await this.provider.results(batchId,{projectId:id,batchId});
    const matches=unknown.filter(a=>results.data.some(r=>r.custom_id===a.id));if(!matches.length)throw new Error('This batch does not contain the project request identifiers. No project state was changed.');
    for(const a of matches)this.store.updateAttempt(a.id,{batch_id:batchId,state:'pending',applied:0});
    await this.importBatch(id,batchId,results.data);this.store.event(id,'info','The original batch was reconciled by its exact request identifier.');
  }
  async close(){this.closed=true;clearInterval(this.timer);while(this.running.size||this.polling.size||this.applying.size)await new Promise(r=>setTimeout(r,25));await this.tools.close?.();}
}
