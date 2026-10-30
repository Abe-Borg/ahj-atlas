// The guided tour (after Spec Surgeon's frontend/src/lib/tour.ts, useTour.ts and TourOverlay.tsx).
//
// The tour walks the window on the practice project the server builds in memory (lib/tour.mjs):
// Sampleton, a fictional data center. It is a fixed track the user only watches: each step points
// at a real control (`anchor`, a data-tour value in the page), names the capabilities it teaches
// (public/capabilities.js) and says in a few sentences what the control does. Nothing is pretended:
// a step whose control is not on screen keeps its words in the middle of the window and says so; the
// practice project's chat is a recording and says so; every change to the practice project is
// refused by the server, and the controls that would create a project or send a message are held
// in the page. The user's own projects are set aside untouched and come back when the tour ends.
import { FACTS as F } from './trust-facts.js';

/** Bump whenever chapter or step order changes: a saved place keeps numeric indexes, and a bump discards it. */
export const TOUR_VERSION=1;
/** The version a finished tour is recorded as (settings tourFinished); bump to invite everyone again. */
export const TOUR_COMPLETION_VERSION=1;
const PROGRESS_KEY='ahj-atlas.tour-progress';

export const TOUR_HOLD='Held during the tour: this conversation is a recording, and nothing here is sent to Claude.';
export const TOUR_FORM_HOLD='Held during the tour: Start research would create a project and start paid research. End the tour, then choose New research to start your own.';
export const TOUR_NAV_HOLD='Your projects are set aside during the tour. End the tour to open one.';
export const TOUR_RECORDED='This conversation is a recording bundled with the guided tour’s practice project. Nothing in it was sent to Claude, and nothing you do here sends anything. Its cards and source passages are real records of the practice project.';
/** The values the new-project form shows during the tour: the practice project's own (lib/tour.mjs PRACTICE_INPUT; the tests pin the two). */
export const PRACTICE_FORM={
  name:'Practice project · Sampleton data center',
  address:'4100 Practice Parkway, Sampleton, Example State 00000',
  country:'United States',discipline:'Fire protection',scope:'New construction',occupancy:'Hyperscale data center',
  permitDate:'2027-03-01',siteDescription:'Lot 7, Sampleton Technology Park (fictional)',
  notes:'Fictional practice project. About 300,000 square feet on two stories: double-interlock preaction sprinklers in the data halls, wet-pipe sprinklers in support spaces, a diesel fire pump, lithium-ion UPS batteries and diesel standby generators with belly tanks.',
  mode:'realtime',
};

const mb=bytes=>Math.round(bytes/1048576);
const percent=factor=>Math.round(factor*100);
const project=(tab='overview',chat=false)=>({view:'project',tab,chat});
const step=(id,anchor,capabilities,title,body,more={})=>({id,anchor,capabilities,title,body,placement:'bottom',...more});

export const TOUR=[
  {id:'workspace',title:'Your practice workspace',show:project(),steps:[
    step('welcome',null,['tour.controls'],'A practice project, not your work',
      'The tour walks the window on Sampleton, a fictional data center project bundled with the app. It is held in memory only: it is not in your projects, your spending or your exports, and it is gone when the tour ends. Nothing in it was researched, nothing here is sent to Claude, and nothing is spent. Your own projects are set aside untouched and come back as you left them. The tour is a fixed track: Continue moves on, Back goes back, End returns your workspace at once, and Escape asks before ending. Drag this card by its title if it covers something.'),
    step('projects','project-list',['sidebar.projects'],'Your projects',
      'Every project you create is listed here, newest first, with its discipline and research status, and keeps its own report, sources, questions and chat. While the tour runs the practice project sits at the top and your own projects are held: end the tour to open one.',{placement:'right'}),
    step('new-research','new-project',['sidebar.new-research'],'New research',
      'Opens the form for a new project. A half-filled form is kept while you look at other projects, and choosing New research again asks before clearing it. The next chapter walks the form.',{placement:'right'}),
    step('export-addresses','export-addresses',['sidebar.export-addresses'],'Export addresses',
      'Writes the name, address, country, parcel or site description and discipline of the projects you check into one CSV or Excel file, for mapping or a mail merge. It lists your own projects, never the practice one, and holds nothing from the reports. It appears once you have a project.',{placement:'right'}),
    step('share','import-workspace',['sidebar.export-workspace','sidebar.import-workspace'],'Share a workspace with your team',
      'Export workspace saves every project in one file for a teammate: reports, sources, the documents you added, chats, notes, answers, Activity and recorded costs, never your API key. Import workspace shows what a file holds and adds or replaces only the projects you check, without sending anything to Claude. The practice project is never in an export. Export workspace appears once you have a project.',{placement:'right'}),
    step('connection','connection',['sidebar.connection','top.settings','settings.key','settings.remember','settings.spending','settings.forget','settings.updates','settings.diagnostics'],'Your API key and spending',
      'Research and chat run on your own Anthropic API key. This button says whether Anthropic accepted it, and it and API & spending in the top bar open the same dialog: enter the key, choose Remember securely on this Windows account, see estimated spending today and across all projects, Disconnect & forget key, check for app updates and open Diagnostics. The app sets no spending limit of its own; a hard cap belongs in your Anthropic Console.',{placement:'right'}),
    step('help','footer',['footer.about','footer.trust','footer.guide','update.banner'],'Help, trust and updates',
      'About shows the version and the license. Why trust it? explains what runs for each action, where your data goes, and what the evidence checks can and cannot prove. User guide opens the full guide, which can also start this tour at any chapter. In the desktop app the menu bar has File, View and Help menus with the same actions and their shortcuts. When a newer release is published, a banner above the workspace offers it.',{placement:'top'}),
  ]},
  {id:'form',title:'Start a project',show:{view:'form'},steps:[
    step('address','form-address',['form.address','form.country'],'Address and country',
      'Enter the complete address. Country sits beside it and follows the address until you choose one; the form warns when a postal code, a state with its ZIP code or a trailing country name disagrees. AHJ Atlas researches projects in the United States and Canada. The values here are the practice project’s.'),
    step('discipline','form-discipline',['form.discipline','form.name'],'Discipline and name',
      'Your discipline decides what is screened: fire protection screens each NFPA standard on its own, and the other disciplines their referenced-standards checklists. Other — enter your discipline takes your own specialty. The name is how the project appears in the sidebar and the exports; you can rename it later.'),
    step('context','form-context',['form.context'],'Project context',
      'Optional details: scope of work, building use (Hyperscale data center by default, or your own), expected permit date, a parcel number or site description for a site with no street address, and notes such as the proposed systems. Building use and notes can add standards to the screening.',{open:'form-context'}),
    step('mode','form-mode',['form.mode'],'Research now or later',
      `Research now starts at once and shows progress as each stage finishes. Research later uses Anthropic’s Message Batches at ${percent(1-F.batchFactor)}% lower model token prices; each batch can take up to a day, so a report with dependent stages can take longer. Both run the same evidence checks, and search fees are the same.`,{placement:'top'}),
    step('start','form-start',['form.start'],'Start research',
      'Creates the project and starts paid research: the jurisdiction first, then contacts and codes, an Opus evidence check and an Opus final report. Estimated costs appear on the project as each request finishes. During the tour this button is held, so nothing is created.',{placement:'top'}),
  ]},
  {id:'report',title:'Read the report',show:project(),steps:[
    step('header','project-header',['project.rename'],'The project header',
      'The project’s name, address, parcel or site description, discipline, country, processing mode and status. Edit the name and choose Save name at any time; renaming never stops or restarts research. In the tour, saving is refused like every other change to the practice project.'),
    step('stages','stages',[],'Progress at a glance',
      'Above, the counts of authorities, code and standard findings and sources, and the estimated cost to date. Here, the five stages: Jurisdiction, Contacts & process, Codes & standards, the Opus evidence check and the Final report. A tick means that stage’s brief is complete.'),
    step('evidence','jurisdiction',['report.evidence'],'Findings and their evidence',
      'Every finding has a status. Source-supported means a quoted passage was matched to the retrieved text; Conditional depends on an assumption; Conflicting means sources disagree; Unconfirmed is not established. Each quotation names its source: choose S1 to open it in Sources. A matched quotation is evidence to inspect, not a compliance determination.',{placement:'right'}),
    step('questions','questions',['questions.answer','questions.dismiss','questions.ask-atlas','questions.reopen','questions.research-answers'],'Questions to resolve',
      'What research could not settle becomes a question. Save answer keeps what you know, Dismiss sets one aside, and Ask Atlas sends it to Chat with Atlas. Answered and dismissed questions stay below, where you can edit or reopen them. Saving starts nothing: Research with saved answers starts a new round that uses them.',{placement:'left'}),
    step('notes','notes',['notes.remove'],'Notes from chat',
      'A note is a conclusion from chat you chose to keep. It stays when research rebuilds the report, appears in the exports, and is labelled as not re-verified by research. Remove takes it off the report; the conversation keeps it.',{placement:'right'}),
    step('tabs','tabs',['report.tabs'],'The report’s tabs',
      'Overview, Contacts, Codes & standards, Sources and Activity. The counts show open questions, contacts, findings and sources. The next chapter opens each one.'),
  ]},
  {id:'evidence',title:'Contacts, codes and sources',show:project('contacts'),steps:[
    step('contacts','contacts',[],'Contacts',
      'A person is named only when a fully read source lists them, and an email address or phone number has to appear in the source the finding cites, or it is removed. Unpublished names are never guessed. Sampleton’s two reviewers are fictional.'),
    step('screening','codes-screening',['codes.research-standards'],'Standards screening',
      'For fire protection, each NFPA standard is checked on its own for its adopted edition, adoption instrument, amendments and relevance to the project; a screened standard is not automatically a requirement. Research NFPA standards runs a focused, paid update of this checklist and rebuilds the report; other disciplines get Research referenced standards.',{show:project('codes')}),
    step('table','codes-table',[],'Editions and applicability',
      'Each row gives the edition and effective date, how it was adopted, its evidence status, and whether it applies, depends on the project scope, or does not apply and why. View amendments & sources shows the local amendments and the quotations. Here NFPA 13 is the 2025 edition through a local amendment, and NFPA 855 depends on the batteries.',{show:project('codes'),placement:'top'}),
    step('add-document','source-upload',['sources.add-document'],'Documents you have',
      `Add a document you have: a Fire Marshal’s letter, an emailed amendment, owner or insurer criteria. PDF, Word, Excel, CSV or plain text up to ${mb(F.research.documentBytes)} MB, read on this computer and saved as your document. Chat can quote it at once; Continue research brings it into the report.`,{show:project('sources')}),
    step('register','source-register',[],'The source register',
      'Every source the research used or found. Read as evidence means its text was retrieved and quotations are checked against it; Discovered is a search lead that was never read. S6 is a document the user added, the practice owner’s standard. Inspect retrieved excerpt shows the saved text.',{show:project('sources'),placement:'top'}),
    step('activity','spending-record',['activity.resolve-charge','project.reconcile'],'Activity and spending',
      'Activity lists what happened to the project. The spending record estimates its cost from recorded token usage at list prices; your Anthropic invoice is authoritative. The practice project cost nothing. When a request’s outcome is uncertain, Resolve uncertain charge and Reconcile original batch appear here and in the project notice to settle it.',{show:project('activity'),placement:'left'}),
  ]},
  {id:'continue',title:'Keep the research moving',show:project(),steps:[
    step('resume','resume',['project.resume'],'Continue or extend',
      `Continue research, or Review or extend report once research is complete, opens a dialog: add context, correct the address, country or site description, and choose Research now or later. New context or a corrected location starts a new round with the full ${F.research.searches} searches and ${F.research.reads} source reads. In the tour the dialog opens and its button is refused.`),
    step('actions','project-actions',['project.stop','project.finish-partial','project.connect'],'While research runs',
      'Stop research appears here while research runs: it starts no new requests, though one already running can finish and be billed. If research pauses unfinished, Finish with saved evidence writes a clearly labelled partial report. A project waiting for an API key shows Connect Claude. The practice project is finished, so none of them is on screen.'),
    step('export','export-menu',['project.export'],'Export',
      'PDF report, Excel workbook, Excel essentials or the research data as JSON, made on this computer, even for partial research. These work in the tour: try one to see the practice project as a PDF. In the desktop app you choose where to save it.'),
    step('delete','delete-project',['project.delete'],'Delete project',
      'Removes the project’s report, sources, answers and chat for good, after you confirm. Recorded charges stay in your spending totals, and active research or chat has to finish first. The practice project cannot be deleted; it goes when the tour ends.'),
  ]},
  {id:'chat',title:'Chat with Atlas',show:project('overview',true),steps:[
    step('panel','chat-panel',['project.chat','chat.launcher','chat.panel'],'The chat panel',
      'Chat with Atlas in the project header, or the launcher at the bottom right, opens this panel. Drag it by its header, resize it from its corner, expand it over the workspace or minimize it back to the launcher; Escape minimizes it. It stays open while you move between tabs and projects, and each project keeps its own conversation.',{placement:'left'}),
    step('reply','chat-reply',['chat.citations','chat.copy'],'A reply and its evidence',
      'This conversation is a recording, and its note says so. A reply answers from the project’s records first and goes to the web only when they do not settle the question. [S1] Supporting passage opens the quoted text; a [Web] Search lead is a snippet, not evidence. Copy answer copies the text, and Copy table pastes into Excel as cells.',{placement:'left'}),
    step('proposal','chat-proposal',['chat.proposal'],'Changes wait for you',
      'Chat never changes the project on its own. It proposes answers, dismissals, notes, a research round or a location correction as cards, and nothing changes until you choose Apply. The earlier card was applied and became the note on Overview; this one waits. A research card starts a paid round and asks for a processing mode.',{placement:'left'}),
    step('composer','chat-composer',['chat.composer','chat.depth','chat.attach-document','chat.attach-image','chat.starters','chat.stop','chat.retry','chat.earlier'],'Asking a question',
      `Enter sends and Shift+Enter starts a new line. Reply depth: Standard (${F.models.research.label}) for most questions, Premium (${F.models.review.label}) for the hardest. Attach up to ${F.chat.attachments} documents and ${F.chat.images} images, or paste a screenshot. An empty conversation offers starter questions; Stop reply ends a running reply, a declined reply offers a retry, and Show earlier messages loads older ones. All held during the tour.`,{placement:'left'}),
    step('limits','chat-limits',['chat.limits'],'What a reply may do',
      `Each reply can make up to ${F.chat.searches} web searches and ${F.chat.webReads} page reads and shows its estimated cost; there is no spending limit. Pages a reply reads join the project’s Sources. The project’s evidence is cached, so follow-up questions soon after cost less. Open this to read the rest.`,{placement:'left'}),
  ]},
  {id:'finish',title:'Finish',show:project(),steps:[
    step('finish','tour-button',['tour.start','tour.finish'],'That is the window',
      'Guided tour in the top bar starts this tour again at any time, and so do Help → Take the guided tour in the desktop menu and the User guide, which can start at any chapter. Finish returns your projects exactly as you left them and discards the practice project.',{continueLabel:'Finish and return to my projects'}),
  ]},
];

export const chapterIndex=id=>TOUR.findIndex(chapter=>chapter.id===id);
/** Each step's page state: the chapter's, unless the step names its own. */
export const stepShow=(chapter,index)=>TOUR[chapter].steps[index].show||TOUR[chapter].show;
export const anchorSelector=step=>`[data-tour="${step.anchor}"]`;

function loadProgress(){
  try{
    const value=JSON.parse(localStorage.getItem(PROGRESS_KEY)||'null');
    if(!value||value.version!==TOUR_VERSION||typeof value.projectId!=='string'||!Number.isInteger(value.chapter)||!Number.isInteger(value.step)||!TOUR[value.chapter]?.steps[value.step]){localStorage.removeItem(PROGRESS_KEY);return null;}
    return value;
  }catch{return null;}
}
function saveProgress(value){try{localStorage.setItem(PROGRESS_KEY,JSON.stringify(value));}catch{}}
function clearProgress(){try{localStorage.removeItem(PROGRESS_KEY);}catch{}}

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(value,low,high)=>Math.min(Math.max(value,low),Math.max(low,high));
function placeCard(rect,placement,width,height){
  const margin=12,vw=window.innerWidth,vh=window.innerHeight;
  const fits={top:rect.top-height-margin>=8,bottom:rect.top+rect.height+margin+height<=vh-8,left:rect.left-width-margin>=8,right:rect.left+rect.width+margin+width<=vw-8};
  let side=placement||'bottom';
  if(!fits[side]){const opposite={top:'bottom',bottom:'top',left:'right',right:'left'}[side];side=fits[opposite]?opposite:fits.bottom?'bottom':fits.top?'top':fits.right?'right':'left';}
  const vertical=side==='top'||side==='bottom';
  const top=vertical?(side==='top'?rect.top-height-margin:rect.top+rect.height+margin):rect.top+rect.height/2-height/2;
  const left=vertical?rect.left+rect.width/2-width/2:side==='left'?rect.left-width-margin:rect.left+rect.width+margin;
  return {top:clamp(top,8,vh-height-8),left:clamp(left,8,vw-width-8)};
}
// The scrolling ancestors that clip a control (the chat panel's history, a wide table).
function clippers(target){
  const found=[];
  for(let node=target.parentElement;node&&node!==document.body;node=node.parentElement){const {overflowX,overflowY}=getComputedStyle(node);if(/auto|scroll|hidden|clip/.test(overflowX+overflowY))found.push(node);}
  return found;
}
// The part of a control that is on screen: its box cut by those ancestors and the window, or null.
function visibleBox(target){
  const box=target.getBoundingClientRect();let {top,left}=box,right=box.right,bottom=box.bottom;
  for(const node of clippers(target)){const r=node.getBoundingClientRect();top=Math.max(top,r.top);left=Math.max(left,r.left);right=Math.min(right,r.right);bottom=Math.min(bottom,r.bottom);}
  top=Math.max(top,0);left=Math.max(left,0);right=Math.min(right,window.innerWidth);bottom=Math.min(bottom,window.innerHeight);
  return right-left>2&&bottom-top>2?{top,left,width:right-left,height:bottom-top}:null;
}

// host: what the tour needs from the window (public/app.js):
//   api(url,options), toast(text), snapshot() → the user's view, restore(snapshot),
//   show(projectId,{view,tab,chat}) → the step's page state, changed() → re-render for the tour's start or end,
//   finished() → the finished tour version, setFinished(version).
export function createTour(host){
  let phase='idle',chapter=0,index=0,projectId=null,snapshot=null,run=0,error='';
  let anchorCleanup=()=>{},offset={dx:0,dy:0},position=null,anchorRect=null;
  const layer=document.createElement('div');layer.className='tour-layer';layer.hidden=true;
  layer.innerHTML='<div class="tour-cutout" aria-hidden="true"></div><section class="tour-card" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" data-capability="tour.controls"></section>';
  const cutout=layer.firstChild,card=layer.lastChild;
  const confirm=document.createElement('dialog');confirm.id='tour-end-dialog';confirm.setAttribute('aria-labelledby','tour-end-title');
  confirm.innerHTML='<h2 id="tour-end-title">End the guided tour?</h2><p class="muted">Your projects come back exactly as you left them, and the practice project is discarded. Guided tour in the top bar starts it again at any time.</p><div class="dialog-actions"><button type="button" class="button secondary" data-tour-stay>Continue the tour</button><button type="button" class="button primary" data-tour-end data-capability="tour.finish">End the tour</button></div>';
  document.body.append(layer,confirm);
  confirm.querySelector('[data-tour-stay]').addEventListener('click',()=>confirm.close());
  confirm.querySelector('[data-tour-end]').addEventListener('click',()=>{confirm.close();void end();});

  const active=()=>phase!=='idle';
  const persist=()=>{if(projectId)saveProgress({version:TOUR_VERSION,projectId,chapter,step:index,snapshot});};
  const button=(attrs,label,primary=false)=>`<button type="button" class="button ${primary?'primary':'secondary'}" ${attrs}>${label}</button>`;
  const endButton='<button type="button" class="text-button tour-end" data-action="ask-end" data-capability="tour.finish" title="End the tour and return to your projects exactly as you left them">End</button>';

  function hideSpotlight(){anchorCleanup();anchorCleanup=()=>{};anchorRect=null;cutout.hidden=true;layer.classList.add('tour-dim');}
  function placeCentered(){position=null;card.classList.add('tour-centered');card.style.top='';card.style.left='';}
  function positionCard(){
    if(!anchorRect){placeCentered();return;}
    card.classList.remove('tour-centered');
    position=placeCard(anchorRect,card.dataset.placement,card.offsetWidth,card.offsetHeight);
    const vh=window.innerHeight,vw=window.innerWidth;
    offset={dx:clamp(position.left+offset.dx,8,vw-card.offsetWidth-8)-position.left,dy:clamp(position.top+offset.dy,8,vh-card.offsetHeight-8)-position.top};
    card.style.top=position.top+offset.dy+'px';card.style.left=position.left+offset.dx+'px';
  }
  function spotlight(target,selector){
    let observer=null;
    const measure=()=>{
      // The page re-renders often; a replaced control is found again by its anchor.
      if(!target.isConnected){const next=document.querySelector(selector);if(next){observer?.unobserve(target);target=next;observer?.observe(target);}}
      // A control that leaves the screen (the chat panel minimized, say) leaves the card in the middle.
      const box=target.isConnected?visibleBox(target):null;
      if(!box){anchorRect=null;cutout.hidden=true;layer.classList.add('tour-dim');placeCentered();return;}
      anchorRect=box;
      cutout.hidden=false;layer.classList.remove('tour-dim');Object.assign(cutout.style,{top:box.top-6+'px',left:box.left-6+'px',width:box.width+12+'px',height:box.height+12+'px'});
      positionCard();
    };
    let frame=0;const remeasure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(remeasure);observer?.observe(target);observer?.observe(card);
    // Re-renders replace the control without resizing anything the observer watches.
    const mutations=new MutationObserver(()=>{if(!target.isConnected)remeasure();});mutations.observe(document.body,{childList:true,subtree:true});
    window.addEventListener('resize',remeasure);window.addEventListener('scroll',remeasure,true);
    anchorCleanup=()=>{cancelAnimationFrame(frame);observer?.disconnect();mutations.disconnect();window.removeEventListener('resize',remeasure);window.removeEventListener('scroll',remeasure,true);};
    measure();
  }
  // The control a step points at, waited for while the page renders. A step with no anchor, or whose
  // control is not on screen, keeps its words in the middle of the window, never beside a pretend control.
  async function resolveAnchor(current,ticket){
    if(!current.anchor)return {target:null,missing:false};
    for(let attempt=0;attempt<14;attempt++){
      const target=document.querySelector(anchorSelector(current));
      if(target&&target.getClientRects().length)return {target,missing:false};
      await new Promise(resolve=>setTimeout(resolve,150));if(ticket!==run)return null;
    }
    return {target:null,missing:true};
  }
  function renderCard(html,placement='bottom'){card.dataset.placement=placement;card.innerHTML=html;layer.hidden=false;}

  async function showStep(nextChapter,nextIndex,{restoreFocus=true}={}){
    const ticket=++run;phase='touring';chapter=nextChapter;index=nextIndex;offset={dx:0,dy:0};persist();
    const section=TOUR[chapter],current=section.steps[index],atFirst=chapter===0&&index===0;
    hideSpotlight();
    renderCard(`<div class="tour-card-head" data-drag-handle title="Drag to move"><p class="tour-kicker">Chapter ${chapter+1}/${TOUR.length} · ${esc(section.title)} · ${index+1}/${section.steps.length}</p><h2 id="tour-title">${esc(current.title)}</h2></div><div class="tour-card-body" id="tour-body"><p class="field-help">Opening…</p></div>`,current.placement);
    placeCentered();
    try{await host.show(projectId,stepShow(chapter,index));}catch(e){if(ticket===run)fail(e);return;}
    if(ticket!==run)return;
    if(current.open)document.querySelector(`[data-tour="${current.open}"]`)?.setAttribute('open','');
    const found=await resolveAnchor(current,ticket);if(!found||ticket!==run)return;
    const missing=found.missing?'<p class="tour-missing">This control is not on screen in the practice project’s current state, so its explanation stands here instead of beside a pretend control. You can continue.</p>':'';
    renderCard(`<div class="tour-card-head" data-drag-handle title="Drag to move"><p class="tour-kicker">Chapter ${chapter+1}/${TOUR.length} · ${esc(section.title)} · ${index+1}/${section.steps.length}</p><h2 id="tour-title">${esc(current.title)}</h2></div><button type="button" class="icon-button tour-close" data-action="ask-end" aria-label="End the tour">×</button><div class="tour-card-body" id="tour-body"><p>${esc(current.body)}</p>${missing}</div><div class="tour-actions">${atFirst?'':button('data-action="back"','‹ Back')}${button('data-action="next"',esc(current.continueLabel||'Continue'),true)}<span class="tour-spacer"></span>${endButton}</div>`,found.missing?'left':current.placement);
    // A control taller than the space it scrolls in is shown from its top.
    const room=found.target&&(clippers(found.target).find(node=>node.scrollHeight>node.clientHeight)?.clientHeight||innerHeight);
    found.target?.scrollIntoView({block:found.target?.offsetHeight>room*.7?'start':'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    if(found.target)spotlight(found.target,anchorSelector(current));else placeCentered();
    if(restoreFocus)card.querySelector('[data-action="next"]')?.focus({preventScroll:true});
  }
  function showBreak(next){
    const ticket=++run;phase='break';hideSpotlight();chapter=next;index=0;persist();
    const done=TOUR[next-1];
    renderCard(`<div class="tour-card-head"><p class="tour-kicker">Chapter ${next} of ${TOUR.length} done</p><h2 id="tour-title">${esc(done.title)}</h2></div><div class="tour-progress" aria-hidden="true">${TOUR.map((_,i)=>`<span class="${i<next?'done':''}"></span>`).join('')}</div><div class="tour-card-body" id="tour-body"><p>Next: <strong>${esc(TOUR[next].title)}</strong>. The step cards sit beside the real controls, so you can look around as you go.</p></div><div class="tour-actions">${button('data-action="chapter"','Continue',true)}<span class="tour-spacer"></span>${endButton}</div>`);
    placeCentered();if(ticket===run)card.querySelector('[data-action="chapter"]')?.focus({preventScroll:true});
  }
  function showPreparing(label){
    ++run;phase='preparing';hideSpotlight();
    renderCard(`<div class="tour-card-head"><p class="tour-kicker">Guided tour</p><h2 id="tour-title">One moment</h2></div><div class="tour-card-body" id="tour-body"><p>${esc(label)}</p><div class="tour-bar"><span></span></div><p class="field-help">The practice project is built in memory from bundled fictional records through the app’s own checks. No AI is called and nothing of yours is touched.</p></div>`);
    placeCentered();
  }
  function fail(e){
    ++run;phase='failed';error=String(e?.message||e||'The tour could not continue.');hideSpotlight();
    renderCard(`<div class="tour-card-head"><p class="tour-kicker">Guided tour</p><h2 id="tour-title">The tour needs attention</h2></div><div class="tour-card-body" id="tour-body"><p class="inline-error">${esc(error)}</p></div><div class="tour-actions">${button('data-action="retry"','Retry',true)}<span class="tour-spacer"></span><button type="button" class="text-button tour-end" data-action="end-now">End the tour</button></div>`);
    placeCentered();
  }

  async function start(startChapter=0){
    if(active()){if(startChapter)void showStep(startChapter,0);return;}
    snapshot=host.snapshot();showPreparing('Setting your projects aside and opening the practice project…');
    try{
      const status=await host.api('/api/tour/start',{method:'POST',body:{}});
      projectId=status.projectId;host.changed();
      await showStep(startChapter,0);
    }catch(e){fail(e);}
  }
  // A reload while the practice project is up picks the tour back up at its step.
  async function resume(){
    const saved=loadProgress();let status;
    try{status=await host.api('/api/tour');}catch{return false;}
    if(saved&&status.active&&status.projectId===saved.projectId){
      projectId=saved.projectId;snapshot=saved.snapshot||null;phase='preparing';host.changed();
      await showStep(saved.chapter,saved.step);return true;
    }
    clearProgress();
    if(status.active)host.api('/api/tour/end',{method:'POST',body:{projectId:status.projectId}}).catch(()=>{});
    return false;
  }
  async function end({finished=false}={}){
    if(!active())return;
    const ending=projectId,view=snapshot;++run;hideSpotlight();layer.hidden=true;if(confirm.open)confirm.close();
    phase='idle';projectId=null;snapshot=null;clearProgress();
    try{
      if(finished)await host.api('/api/tour/finished',{method:'POST',body:{version:TOUR_COMPLETION_VERSION}}).then(r=>host.setFinished(r.finished)).catch(()=>{});
      await host.api('/api/tour/end',{method:'POST',body:{projectId:ending}}).catch(()=>{});
    }finally{host.changed();await host.restore(view,ending);}
  }
  function requestEnd(){if(active()&&!confirm.open)confirm.showModal();}
  function advance(){
    const section=TOUR[chapter];
    if(index<section.steps.length-1)return void showStep(chapter,index+1);
    if(chapter<TOUR.length-1)return showBreak(chapter+1);
    void end({finished:true});
  }
  function back(){
    if(index>0)return void showStep(chapter,index-1);
    if(chapter>0)void showStep(chapter-1,TOUR[chapter-1].steps.length-1);
  }

  card.addEventListener('click',event=>{
    const action=event.target.closest('[data-action]')?.dataset.action;
    if(action==='next')advance();else if(action==='back')back();else if(action==='chapter')void showStep(chapter,0);
    else if(action==='ask-end')requestEnd();else if(action==='end-now')void end();
    else if(action==='retry'){if(projectId)void showStep(chapter,index);else{phase='idle';void start(chapter);}}
  });
  // Dragging the card by its title; the offset resets with every step.
  card.addEventListener('pointerdown',event=>{
    if(event.button!==0||!event.target.closest('[data-drag-handle]')||!position)return;
    const startX=event.clientX,startY=event.clientY,base={...offset};
    try{card.setPointerCapture(event.pointerId);}catch{}
    const move=e=>{offset={dx:base.dx+e.clientX-startX,dy:base.dy+e.clientY-startY};positionCard();};
    const stop=()=>{card.removeEventListener('pointermove',move);card.removeEventListener('pointerup',stop);card.removeEventListener('pointercancel',stop);};
    card.addEventListener('pointermove',move);card.addEventListener('pointerup',stop);card.addEventListener('pointercancel',stop);
  });
  // Escape asks before ending, as End does. A dialog of the window, or the chat panel, owns it first.
  window.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||event.defaultPrevented||!['touring','break','failed'].includes(phase))return;
    if(document.querySelector('dialog[open]'))return;
    event.preventDefault();requestEnd();
  });

  return {
    start,resume,end,requestEnd,
    active,
    practiceId:()=>projectId,
    owns:id=>Boolean(projectId)&&id===projectId,
    /** The tour's place, for the window's own controls (and the tests). */
    place:()=>({phase,chapter,step:index}),
  };
}
