import { randomUUID } from 'node:crypto';
import { CHAT_LIMITS as L } from './config.mjs';
import { projectAddress } from './store.mjs';
import { isFireProtection } from './fire-protection.mjs';

// Project chat proposes; only the user's Apply changes the project, through the same
// store.saveQuestion and engine.resume calls as the question cards and research dialog.
// This module must not import chat.mjs: CHAT_TOOLS spreads ACTION_TOOLS at load time.
const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const reason={type:'string',description:'One or two sentences shown on the card: why this change, and what it is based on. Up to 600 characters.'};
export const ACTION_TOOLS=[
  {name:'propose_question_update',description:'Propose saving an answer to one of this project\'s saved questions, or dismissing it. The user sees a card with an Apply button; nothing changes unless they apply it. Use a question ID from the saved questions. The answer (up to 4,000 characters) is saved as the user\'s answer, which research treats as information the user provided; when it comes from a source rather than the user, say so in the answer and cite the source you read as [S1]. Use an empty answer when dismissing.',strict:true,input_schema:schema({questionId:{type:'string'},status:{type:'string',enum:['answered','dismissed']},answer:{type:'string'},reason})},
  {name:'propose_research_round',description:'Propose a paid research round that rebuilds the report. clarification: new project context (up to 3,900 characters) that reopens every research stage; cite the source you read as [S1] when the context comes from one. nfpa_standards: a focused update of the NFPA standards for a fire protection project once jurisdiction and contact research are complete; use an empty clarification. Not available while research is running. The user sees a card with an Apply button; nothing starts unless they apply it.',strict:true,input_schema:schema({focus:{type:'string',enum:['clarification','nfpa_standards']},clarification:{type:'string'},reason})},
  {name:'propose_report_note',description:'Propose saving a finding from this conversation to the report\'s notes, where it appears with the report and in its PDF, Excel and JSON exports and is kept when research rebuilds the report. Use it when the user asks to keep or save a finding, or when your answer settles a point worth keeping. title: a short heading (up to 200 characters). note: the finding as a standalone note (up to 6,000 characters) with its source citations as [S1]; cite only sources whose text was read. The user sees a card with an Apply button; nothing is saved unless they apply it. Applying it is free and starts no research.',strict:true,input_schema:schema({title:{type:'string'},note:{type:'string'},reason})},
  {name:'propose_address_correction',description:'Propose correcting the project address (8 to 500 characters, including city and state or region) or the parcel number (APN) or site description (up to 500 characters). An empty string keeps the saved value. Applying it reopens jurisdiction research and the stages that depend on it, a paid research round. Not available while research is running. The user sees a card with an Apply button; nothing changes unless they apply it.',strict:true,input_schema:schema({address:{type:'string'},siteDescription:{type:'string'},reason})},
];
export const ACTION_TOOL_NAMES=new Set(ACTION_TOOLS.map(t=>t.name));
// These start research through engine.resume, and so cost money.
export const PAID_ACTIONS=new Set(['research','nfpa_research','correct_location']);
const ACTIVE=['queued','researching','waiting_batch','waiting','canceling','needs_key'],UNSETTLED=['dispatching','pending','received','unknown'];
// Research reads the clarification as user-provided context, so it records where it came from.
export const CLARIFICATION_PREFIX='Proposed in project chat and approved by the user: ';
const labels={answer_question:'answer a question',dismiss_question:'dismiss a question',report_note:'save a note to the report',research:'start a research round',nfpa_research:'start focused NFPA research',correct_location:'correct the project location'};
export const actionLabel=action=>labels[action]||'change the project';
const clip=(value,size)=>{const text=String(value??'').replace(/\s+/g,' ').trim();return text.length>size?text.slice(0,size-1)+'…':text;};
// A short, bounded summary for later turns, so proposals cannot crowd out conversation history.
export function describeAction(p){
  if(p.action==='answer_question')return `answer question ${p.questionId} with “${clip(p.answer,220)}”`;
  if(p.action==='dismiss_question')return `dismiss question ${p.questionId}`;
  if(p.action==='report_note')return `save the report note “${clip(p.title,140)}”`;
  if(p.action==='research')return `start a research round with the context “${clip(p.clarification,220)}”`;
  if(p.action==='nfpa_research')return 'start focused NFPA standards research';
  return `correct the project location${p.address?` to the address “${clip(p.address,140)}”`:''}${p.siteDescription?`${p.address?' and':' with'} the site description “${clip(p.siteDescription,100)}”`:''}`;
}
export function researchBusy(store,id,p=store.project(id)){
  return ACTIVE.includes(p.status)||Boolean(store.db.prepare(`SELECT 1 FROM attempts WHERE project_id=? AND state IN (${UNSETTLED.map(()=>'?').join(',')}) LIMIT 1`).get(id,...UNSETTLED));
}
export const lastResearchAt=(store,id)=>store.db.prepare("SELECT MAX(created) m FROM attempts WHERE project_id=? AND stage_id!='chat'").get(id)?.m||'';
// Research that ran after a proposal was made may have changed what it would do, so a
// paid proposal is not applied afterwards.
export const proposalStale=(proposal,lastResearch)=>proposal.status==='proposed'&&PAID_ACTIONS.has(proposal.action)&&Boolean(lastResearch)&&lastResearch>proposal.created;
// An empty proposed field keeps the saved value. engine.resume keeps a value only when
// the field is omitted, so empty fields are never passed to it.
function nextLocation(p,proposal){
  const savedSite=String(p.input.siteDescription||''),address=proposal.address||p.address,site=proposal.siteDescription||savedSite;
  return {address,site,changed:address!==p.address||site!==savedSite};
}
// A cited source must be one this project has read, so an applied answer points to evidence.
function checkCitations(store,id,text){
  const read=new Set(store.db.prepare('SELECT id FROM sources WHERE project_id=? AND read_full=1').all(id).map(s=>s.id.split(':').at(-1)));
  for(const [,inner] of String(text).matchAll(/\[([^\]\n]{1,120})\]/g))for(const [sourceId] of inner.matchAll(/\bS\d+\b/g))
    if(!read.has(sourceId))throw new Error(`${sourceId} is not a source this project has read. Cite only sources whose text was read, or leave the citation out.`);
}
// Checks a proposal against the current project and records it on the turn. Errors
// return to the model as tool errors; nothing is recorded for them.
export function proposeAction(store,id,turnId,name,input){
  const p=store.project(id),turn=store.chatTurns(id).find(t=>t.id===turnId);if(!p||!turn)throw new Error('Project not found.');
  const proposals=turn.proposals,text=value=>String(value??'').trim(),why=text(input.reason);
  if(!why)throw new Error('Give a reason for the card.');
  if(proposals.length>=L.proposals)throw new Error(`This reply has already proposed ${L.proposals} actions. Describe any other change in your answer.`);
  let proposal;
  if(name==='propose_question_update'){
    const question=p.questions.find(q=>q.id===input.questionId);
    if(!question)throw new Error('Use a question ID from the saved questions (read_project questions).');
    if(proposals.some(x=>x.questionId===question.id))throw new Error('This reply already proposes a change to this question.');
    if(input.status==='answered'){
      const answer=text(input.answer);if(!answer)throw new Error('Enter the answer to propose, or propose dismissing the question.');
      if(question.status==='answered'&&question.answer===answer)throw new Error('This answer is already saved.');
      checkCitations(store,id,answer);
      proposal={action:'answer_question',questionId:question.id,question:question.question,answer};
    }else{
      if(question.status==='dismissed')throw new Error('This question is already dismissed.');
      proposal={action:'dismiss_question',questionId:question.id,question:question.question};
    }
  }else if(name==='propose_report_note'){
    // A note is free and changes no research, so it can be proposed while research runs.
    const title=text(input.title),note=text(input.note);
    if(!title||!note)throw new Error('Give the note a title and its text.');
    checkCitations(store,id,note);
    if(store.notes(id).some(n=>n.text===note)||proposals.some(x=>x.action==='report_note'&&x.note===note))throw new Error('This note is already saved or proposed.');
    proposal={action:'report_note',title,note};
  }else{
    if(proposals.some(x=>PAID_ACTIONS.has(x.action)))throw new Error('This reply already proposes a research round. Propose at most one per reply.');
    if(researchBusy(store,id,p))throw new Error('Research is running or a request is outstanding. Describe the change in your answer; it can be proposed after research finishes.');
    if(name==='propose_research_round'){
      const clarification=text(input.clarification);
      if(input.focus==='nfpa_standards'){
        if(clarification)throw new Error('A focused NFPA update cannot carry a clarification. Propose a clarification round instead.');
        if(!isFireProtection(p.input))throw new Error('A focused NFPA update requires a fire protection project.');
        if(store.stages(id).some(s=>['jurisdiction','contacts'].includes(s.id)&&s.status!=='complete'))throw new Error('A focused NFPA update requires completed jurisdiction and contact research.');
        proposal={action:'nfpa_research'};
      }else{
        if(!clarification)throw new Error('Enter the project context for the research round.');
        checkCitations(store,id,clarification);
        proposal={action:'research',clarification};
      }
    }else{
      const address=text(input.address),siteDescription=text(input.siteDescription);
      if(!address&&!siteDescription)throw new Error('Give a corrected address, site description or both.');
      if(address)projectAddress(address);
      proposal={action:'correct_location',...(address?{address}:{}),...(siteDescription?{siteDescription}:{})};
      if(!nextLocation(p,proposal).changed)throw new Error('The project already uses this address and site description.');
    }
  }
  const record={id:randomUUID(),...proposal,reason:why,status:'proposed',created:new Date().toISOString()};
  store.updateChatTurn(id,turnId,{proposals:[...proposals,record]});
  return `Proposal recorded (${actionLabel(record.action)}). The user sees it as a card with an Apply button below your reply; nothing has changed. Tell the user briefly what the card will do${PAID_ACTIONS.has(record.action)?', including that applying it starts a paid research round':''}, and do not say it was applied.`;
}
// Applies a saved proposal exactly as recorded. Nothing here awaits before the proposal
// is marked applied, so a repeated request is refused rather than starting a second round.
export async function applyAction({store,engine},id,body){
  const p=store.project(id);if(!p)throw new Error('Project not found.');
  const turn=store.chatTurns(id).find(t=>t.id===body?.turnId);
  if(!turn)throw new Error('Choose a reply from this project.');
  if(turn.status==='running')throw new Error('Wait for this reply to finish before applying its proposals.');
  const proposal=turn.proposals.find(x=>x.id===body.proposalId);
  if(!proposal)throw new Error('This proposal is not in the saved conversation. Reload the chat and try again.');
  if(proposal.status==='applied')throw new Error('This proposal has already been applied.');
  if(body.mode!=null&&!['batch','realtime'].includes(body.mode))throw new Error('Choose a valid processing mode.');
  const mark=patch=>{const current=store.chatTurns(id).find(t=>t.id===turn.id);store.updateChatTurn(id,turn.id,{proposals:current.proposals.map(x=>x.id===proposal.id?{...x,...patch}:x)});};
  if(proposal.action==='report_note'){
    if(store.notes(id).some(n=>n.text===proposal.note))throw new Error('This note is already saved in the report.');
    store.addNote(id,{title:proposal.title,text:proposal.note,turnId:turn.id,proposalId:proposal.id});
    mark({status:'applied',applied:new Date().toISOString()});
  }else if(!PAID_ACTIONS.has(proposal.action)){
    const question=p.questions.find(q=>q.id===proposal.questionId);
    if(!question)throw new Error('This question is no longer in the saved project.');
    const status=proposal.action==='answer_question'?'answered':'dismissed';
    if(question.status===status&&(status==='dismissed'||question.answer===proposal.answer))throw new Error('This response is already saved.');
    store.saveQuestion(id,{questionId:question.id,status,answer:proposal.answer||''});
    mark({status:'applied',applied:new Date().toISOString()});
  }else{
    if(researchBusy(store,id,p))throw new Error('Wait for the current research and outstanding requests to finish before starting another round.');
    if(proposalStale(proposal,lastResearchAt(store,id)))throw new Error('Research has run since this was proposed. Ask chat again if it still applies.');
    let request;
    if(proposal.action==='research')request={clarification:CLARIFICATION_PREFIX+proposal.clarification};
    else if(proposal.action==='nfpa_research')request={focus:'fire_protection'};
    else{
      if(!nextLocation(p,proposal).changed)throw new Error('The project already uses this address and site description.');
      request={address:proposal.address||undefined,siteDescription:proposal.siteDescription||undefined};
    }
    mark({status:'applied',applied:new Date().toISOString(),mode:body.mode||p.mode});
    try{await engine.resume(id,{...request,mode:body.mode||undefined});}
    catch(e){
      // resume validates before it changes anything; an unchanged project can try again.
      const after=store.project(id);
      if(after&&after.status===p.status&&after.updated===p.updated)mark({status:'proposed',applied:undefined,mode:undefined});
      throw e;
    }
  }
  // Activity and diagnostics name the kind of action only, never its text.
  store.event(id,'info',`You applied a proposal from project chat (${actionLabel(proposal.action)}).`);
  store.diagnostic('chat.proposal_applied',{projectId:id,stageId:'chat',action:proposal.action});
}
